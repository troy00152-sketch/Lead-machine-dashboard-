// netlify/functions/telnyx-voice-webhook.js
// Receives Telnyx Call Control webhooks for the standalone Command
// Center's triple-line dialer and drives the session state machine in
// the 'cc-dialer' Blobs store (owned by cc-dialer-api.js).
//
// Events handled (Telnyx API v2 webhook envelope: {data:{event_type,
// payload}}; payload carries call_control_id + our client_state):
//   call.initiated               -> leg marked ringing
//   call.answered                -> leg answered; for the AGENT leg of a
//                                   pending win, bridge agent <-> winner
//   call.machine.detection.ended -> AMD verdict:
//        'machine'               -> hang the leg up, auto-disposition
//                                   'Machine', queue advances
//        'human' / 'not_sure'    -> FIRST HUMAN ANSWER WINS: the other
//                                   ringing seller legs are hung up
//                                   immediately (still-ringing losers
//                                   return to the queue as pending;
//                                   a human who answers after the win
//                                   gets 'Callback Later'), and the
//                                   agent leg is created — when the
//                                   agent answers, the two legs bridge
//   call.hangup                  -> no-answer/busy/failed legs get the
//                                   'No Answer' auto-disposition; the
//                                   connected winner hanging up moves
//                                   its lead to 'awaiting-disposition'
//                                   (the agent files the real one)
//   call.recording.saved         -> recording metadata into the
//                                   'cc-dialer' store (recordings live
//                                   in the dialer area only)
//
// After every terminal leg event the queue refills to 3 concurrent
// seller legs via cc-dialer-api's dialNextBatch — but never while a
// winner is connected (the agent is talking) or the session is
// paused/stopped.
//
// AMD 'not_sure' is treated as human: hanging up on a real person is
// worse than occasionally bridging a machine the agent can disposition.
//
// Signature verification: identical Ed25519 scheme to
// telnyx-webhook.js ('telnyx-signature-ed25519' + 'telnyx-timestamp',
// signed content "<timestamp>|<raw body>", TELNYX_PUBLIC_KEY base64).
// Until the key is configured we log a warning and still process (the
// store is internal-only; the API that reads it is lm_auth-gated) —
// same pre-launch posture as the messaging webhook.
'use strict';

const crypto = require('crypto');

const voice = require('./telnyx-voice-lib');
const dialer = require('./cc-dialer-api');
const engine = dialer._engine;
const callApi = require('./cc-call-api');
const pushDefault = require('./cc-push');
const voiceTokenDefault = require('./cc-voice-token');

// ---- injectable voice actions (tests) ----
const deps = { voiceLib: null, pushLib: null, voiceToken: null };
function voiceLib() {
  return deps.voiceLib || voice;
}
function pushLib() {
  return deps.pushLib || pushDefault;
}
function voiceTokenLib() {
  return deps.voiceToken || voiceTokenDefault;
}
// Small promise helpers: the webhook must answer Telnyx inside its
// 10s delivery timeout, so the on-demand credential mint and the
// credential-read retry are bounded — a slow mint never stalls the
// webhook past the point where Telnyx retries (and the dedupe in
// handleInboundCall makes a retry harmless).
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function withTimeout(promise, ms) {
  // A rejection (or a late settle after the timeout) must never become
  // an unhandled rejection — map every outcome to a value, null on
  // timeout or failure.
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, value: null }), ms);
  });
  const raced = Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ ok: true, value }),
      () => ({ ok: false, value: null })
    ),
    timeout,
  ]);
  return raced
    .finally(() => { if (timer) clearTimeout(timer); })
    .then((r) => (r.ok ? r.value : null));
}
// Voice side effects are best-effort from the webhook: a failed hangup
// must not 500 the webhook (Telnyx would retry and double-apply state).
// Errors are logged; the leg state we already wrote stands.
async function safeVoice(fn, label) {
  try {
    return await fn();
  } catch (e) {
    console.error('[telnyx-voice-webhook] ' + label + ' failed:', (e && e.message) || e);
    return null;
  }
}

function legFor(session, callControlId) {
  return callControlId ? session.legs[callControlId] || null : null;
}

// AMD verdicts, normalized across standard + premium events (premium
// is what createCall requests since Nov 26, 2026 — see
// telnyx-voice-lib.js). Premium adds human_residence /
// human_business (human), silence (nobody spoke in the analysis
// window — the thread path bridges anyway and lets the agent decide;
// the bulk dialer treats it as a machine), fax_detected (machine),
// and greeting beeps (beep_detected = machine). 'not_sure' is treated
// as human per Telnyx. Returns 'human' | 'machine' | null (unmapped).
function amdVerdict(result) {
  const r = String(result || '').toLowerCase();
  if (r === 'human' || r === 'human_residence' || r === 'human_business' || r === 'not_sure') return 'human';
  if (r === 'machine' || r === 'fax_detected' || r === 'silence' || r === 'beep_detected') return 'machine';
  return null;
}
function isAmdEvent(type) {
  return (
    type === 'call.machine.detection.ended' ||
    type === 'call.machine.greeting.ended' ||
    type === 'call.machine.premium.detection.ended' ||
    type === 'call.machine.premium.greeting.ended'
  );
}

// Hang up every still-live seller leg except the winner. Legs that were
// only ringing go back to 'pending' (never reached — redial later);
// a leg that already answered as a human gets a 'Callback Later'
// auto-disposition (a person picked up; we owe them a call back).
async function hangupLosers(session, winnerCallControlId, event) {
  const v = voiceLib();
  for (const leg of Object.values(session.legs)) {
    if (leg.kind !== 'seller') continue;
    if (leg.callControlId === winnerCallControlId) continue;
    if (leg.state === 'ended') continue;
    const lead = engine.findLead(session, leg.leadKey);
    // A leg that already picked up (AMD verdict just hadn't landed
    // yet) counts as answered — if it was a person, we owe a callback
    // rather than a silent redial.
    const wasAnsweredHuman =
      leg.amdResult === 'human' || leg.state === 'answered-human' || leg.state === 'answered';
    leg.state = 'ended';
    leg.endedAt = Date.now();
    leg.endReason = 'lost-race';
    if (lead && lead.status !== 'done') {
      if (wasAnsweredHuman) {
        lead.status = 'done';
        lead.disposition = 'Callback Later';
        lead.autoDisposition = true;
        session.stats.callbacks += 1;
      } else {
        lead.status = 'pending';
        lead.callControlId = null;
      }
    }
    await safeVoice(() => v.hangup(leg.callControlId), 'hangup loser ' + leg.callControlId);
  }
}

// The winner needs the agent: create the agent (WebRTC) leg. When it
// answers, the call.answered branch below bridges the two legs.
async function summonAgent(session, event) {
  const v = voiceLib();
  if (!session.agentSipUri) {
    session.lastError = 'No agent SIP URI on the session — answered call has nowhere to bridge.';
    return null;
  }
  if (session.agentCallControlId && session.legs[session.agentCallControlId] && session.legs[session.agentCallControlId].state !== 'ended') {
    return session.agentCallControlId; // agent leg already ringing/connected
  }
  const winner = legFor(session, session.winnerCallControlId);
  const created = await safeVoice(
    () =>
      v.createAgentLeg({
        sipUri: session.agentSipUri,
        market: session.market || undefined,
        from: winner ? winner.from || undefined : undefined,
        clientState: { sessionId: session.id, leg: 'agent', winnerCallControlId: session.winnerCallControlId },
      }),
    'create agent leg'
  );
  if (!created || !created.callControlId) {
    session.lastError = 'Could not create the agent leg — the answered seller is on hold.';
    return null;
  }
  session.agentCallControlId = created.callControlId;
  session.legs[created.callControlId] = {
    callControlId: created.callControlId,
    kind: 'agent',
    leadKey: winner ? winner.leadKey : null,
    phone: session.agentSipUri,
    from: created.from || '',
    state: 'initiated',
    amdResult: null,
    startedAt: Date.now(),
    answeredAt: null,
    endedAt: null,
  };
  return created.callControlId;
}

async function declareWinner(session, leg, event) {
  session.winnerCallControlId = leg.callControlId;
  session.status = 'connected';
  const lead = engine.findLead(session, leg.leadKey);
  if (lead) {
    lead.status = 'connected';
    session.connectedLeadKey = lead.key;
  }
  session.stats.connects += 1;
  await hangupLosers(session, leg.callControlId, event);
  await summonAgent(session, event);
}

// A seller leg reached a terminal state without connecting. File the
// auto-disposition (unless one is already filed) and free the slot.
function autoDispositionForHangup(leg, payload) {
  const cause = String((payload && payload.hangup_cause) || '').toLowerCase();
  if (leg.amdResult === 'machine') return 'Machine';
  if (cause === 'normal_clearing' && leg.answeredAt) return null; // talked or machine greeting — agent/AMD owns it
  return 'No Answer'; // no-answer, busy, rejected, failed — all one bucket
}

async function refillAndMaybeComplete(session, event) {
  if (session.status === 'running') {
    await engine.dialNextBatch(session, event);
    const fresh = await engine.loadSession(event);
    if (fresh && fresh.status === 'running' && engine.sessionComplete(fresh)) {
      fresh.status = 'complete';
      fresh.endedAt = Date.now();
      await engine.saveSession(fresh, event);
      return fresh;
    }
    return fresh || session;
  }
  return session;
}

// ---- thread calls (single-call placement from Conversations) ----
// Pairings are owned by cc-call-api.js (exports._thread); client_state
// kinds 'thread-call' (seller leg) / 'thread-call-agent' (agent leg)
// route here. Bridge rule (Nov 26, 2026, Telnyx docs): bridge the
// moment the seller leg answers AND the agent has answered — whichever
// of those two signals lands second triggers the bridge. AMD never
// gates the bridge; its verdict is a parallel label ('possible
// voicemail').
// Inbound pairings (direction 'inbound', created by handleInboundCall
// below): the caller dialed us, so their answer IS the human signal —
// no AMD wait. The agent leg answers first, then we answer the
// inbound leg and bridge.
async function applyThreadCallEvent(evt, event, state) {
  const type = evt && evt.event_type;
  const payload = (evt && evt.payload) || {};
  const callControlId = payload.call_control_id || null;
  const pairings = await callApi._thread.loadPairings(event);
  let found = callApi._thread.findByLeg(pairings, callControlId);
  if (!found && state && state.sellerCallControlId && pairings.calls[state.sellerCallControlId]) {
    found = {
      callId: state.sellerCallControlId,
      rec: pairings.calls[state.sellerCallControlId],
      role: state.kind === 'thread-call-agent' ? 'agent' : 'seller',
    };
  }
  if (!found) {
    // The pairing is not saved yet (the 'start' call is still writing
    // it, or the browser auto-answered the agent leg in <1s). Stash
    // the signal instead of dropping it — a dropped agentAnswered
    // used to deadlock the bridge forever (ringback on, seller
    // unheard). 'start' and the merge below pick the stash up.
    let sellerId = state && state.sellerCallControlId;
    if (!sellerId && state && state.kind === 'thread-call-agent' && state.key) sellerId = state.key; // inbound: key IS the inbound leg id
    if (!sellerId) sellerId = callControlId; // seller-leg events are keyed by their own call_control_id
    const isAgentLeg = (state && state.kind === 'thread-call-agent') || (callControlId && sellerId && callControlId !== sellerId);
    const pending = (await callApi._thread.loadPending(event, sellerId)) || {};
    if (type === 'call.answered') {
      if (isAgentLeg) { pending.agentAnswered = true; pending.agentLeg = callControlId; }
      else pending.sellerAnswered = true;
    } else if (isAmdEvent(type)) {
      // A stashed verdict is a label only now (the bridge no longer
      // waits on AMD) — but keep the stash so the page's 'possible
      // voicemail' tag still lands when the pairing appears.
      const verdict = amdVerdict(payload && payload.result);
      if (verdict === 'human') pending.sellerHuman = true;
      else if (verdict === 'machine') pending.sellerMachine = true;
    }
    await callApi._thread.savePending(event, sellerId, pending);
    return { handled: true, pending: true };
  }
  const rec = found.rec;
  const v = voiceLib();

  async function hangupLeg(legId, label) {
    if (!legId) return;
    await safeVoice(() => v.hangup(legId), label);
  }
  async function hangupBoth() {
    await hangupLeg(rec.sellerLeg, 'hangup thread seller leg');
    await hangupLeg(rec.agentLeg, 'hangup thread agent leg');
    for (const legId of rec.agentLegs || []) await hangupLeg(legId, 'hangup thread agent leg');
  }
  // Bridge rule — the one-fix contract (Nov 26, 2026, corrected
  // against Telnyx's own docs): bridge the moment the seller leg
  // answers AND the agent has answered — whichever of those two
  // signals lands second triggers the bridge. AMD NEVER gates the
  // bridge: Telnyx AMD only reports, and while it analyses (seconds)
  // an unbridged seller hears silence and hangs up while the agent
  // hears ringback — Troy's exact "I answer, wait, nothing, call
  // ended" failure. AMD verdicts arrive mid-conversation and only
  // set the 'possible voicemail' label (amdResult). The bulk dialer
  // session keeps its own human-win / auto-machine disposition.
  // An AMD verdict is also accepted as a seller-answer signal: in
  // Telnyx's event order call.answered always precedes the verdict,
  // so a verdict proves the seller answered even if the answered
  // webhook itself was lost — the bridge must not depend on a single
  // event landing.
  function canBridge() {
    return !!(
      rec.agentAnswered &&
      rec.agentLeg &&
      rec.sellerLeg &&
      (rec.sellerAnswered || rec.sellerHuman || rec.amdResult === 'machine')
    );
  }
  async function maybeBridge() {
    // Never bridge twice: the agent branch, the seller branch and
    // the AMD branch can all fire maybeBridge for the same call, and
    // a second bridge to Telnyx 422s (or worse). The first bridge
    // sets status 'bridged'; everything after it is a no-op.
    if (rec.status === 'bridged') return;
    if (canBridge()) {
      const ok = await safeVoice(() => v.bridge(rec.sellerLeg, rec.agentLeg), 'bridge thread call');
      // Only report 'bridged' when Telnyx accepted the bridge. A
      // failed bridge used to be recorded as bridged anyway, so the
      // page stopped ringing while nobody could hear anybody.
      // bridgedAt/wasBridged feed the thread call-history entry
      // (duration + completed-vs-missed) written when the call ends.
      if (ok !== null) {
        rec.status = 'bridged';
        rec.wasBridged = true;
        rec.bridgedAt = rec.bridgedAt || Date.now();
      } else rec.lastError = 'bridge-failed';
    }
  }
  // The leg that answered is the agent leg: claim it, and hang up any
  // other agent legs (inbound rings every credential at once; the
  // losers must not linger).
  async function claimAgentLeg(legId) {
    rec.agentLeg = legId;
    const others = (rec.agentLegs || []).filter((id) => id && id !== legId);
    rec.agentLegs = [legId];
    for (const other of others) await hangupLeg(other, 'hangup losing agent leg');
  }

  // Merge any signal stashed before the pairing existed. If the merge
  // completes the pair, bridge now instead of waiting for another
  // event that may never come. Inbound: if the agent answered before
  // the pairing existed, the branch that answers the inbound leg
  // never ran — answer it here so the caller's call.answered (and
  // the bridge) can still land.
  await callApi._thread.mergePending(event, found.callId, rec);
  if (rec.direction === 'inbound' && rec.agentAnswered && !rec.sellerAnswered) {
    await safeVoice(() => v.answer(rec.sellerLeg), 'answer inbound leg (pending merge)');
  }
  if (canBridge() && rec.status !== 'bridged' && rec.status !== 'ended' && rec.status !== 'machine') {
    await maybeBridge();
  }

  if (isAmdEvent(type)) {
    // PSTN fallback leg AMD (Layer 2): the verdict tells us whether
    // Troy or his voicemail answered the fallback dial. 'machine'
    // (voicemail) ends the call as missed; 'human' bridges now. This
    // runs BEFORE the inbound-AMD ignore below: the fallback leg is
    // the one leg on an inbound call that DOES run AMD.
    if (found.role === 'agent' && rec.fallbackLeg && rec.fallbackLeg === callControlId) {
      const verdict = amdVerdict(payload.result);
      if (verdict === 'machine') {
        rec.fallbackFailed = true;
        rec.fallbackAwaitingAmd = false;
        rec.amdResult = 'machine';
        await hangupLeg(callControlId, 'hangup fallback leg (voicemail)');
        rec.status = 'ended';
        rec.endedAt = Date.now();
        if (rec.sellerLeg && rec.sellerLeg !== callControlId) {
          await hangupLeg(rec.sellerLeg, 'hangup inbound leg (fallback voicemail)');
        }
      } else if (verdict === 'human') {
        rec.fallbackHuman = true;
        rec.fallbackAwaitingAmd = false;
        rec.agentAnswered = true;
        if (rec.direction === 'inbound' && !rec.sellerAnswered) {
          await safeVoice(() => v.answer(rec.sellerLeg), 'answer inbound leg (fallback human)');
        }
        await maybeBridge();
      }
      // else: unmapped verdict — leave the leg alone; the sweep
      // bridges an answered fallback leg whose AMD never lands.
    } else if (found.role !== 'seller') {
      return { handled: false, reason: 'AMD event for non-seller leg' };
    } else {
      // Inbound calls never run AMD (the caller dialed us) — ignore.
      if (rec.direction === 'inbound') return { handled: true, inboundAmdIgnored: true };
      // AMD is a label only on this path — the bridge already formed on
      // call.answered. A 'machine' verdict (including a premium
      // 'silence' / 'fax' — a live human waiting silently is the classic
      // false positive) only tags the call 'possible voicemail'; the
      // agent hears the greeting and ends the call himself if it really
      // is a machine. (The bulk dialer session still auto-dispositions
      // machines; this is the single-call path, where the agent is
      // listening.)
      const verdict = amdVerdict(payload.result);
      if (verdict === 'machine') {
        rec.amdResult = 'machine';
        await maybeBridge();
      } else if (verdict === 'human') {
        rec.sellerHuman = true;
        await maybeBridge();
      } else {
        return { handled: false, reason: 'unmapped AMD result: ' + String(payload.result || '') };
      }
    }
  } else if (type === 'call.answered') {
    if (found.role === 'agent') {
      // The answering leg is the agent leg (inbound rings several).
      await claimAgentLeg(callControlId);
      const isFallbackLeg = !!(rec.fallbackLeg && rec.fallbackLeg === callControlId);
      if (isFallbackLeg && !rec.fallbackHuman) {
        // PSTN fallback leg answered — but it may be Troy's voicemail,
        // not Troy. Hold the bridge until AMD says human (the verdict
        // lands a few seconds after answer). The seller keeps hearing
        // ringback; agentAnswered stays false so nothing bridges early.
        // If the verdict never lands, the sweep bridges an answered
        // fallback leg past 30s (assume human).
        rec.fallbackAnsweredAt = Date.now();
        rec.fallbackAwaitingAmd = true;
      } else {
        rec.agentAnswered = true;
        // Inbound: the caller is still ringing — answer their leg now;
        // their call.answered lands next and the bridge forms then.
        if (rec.direction === 'inbound' && !rec.sellerAnswered) {
          await safeVoice(() => v.answer(rec.sellerLeg), 'answer inbound leg');
        }
        await maybeBridge();
      }
    } else {
      rec.sellerAnswered = true;
      if (rec.direction === 'inbound') {
        // The caller dialed us — answer IS the human signal (no AMD).
        rec.sellerHuman = true;
        await maybeBridge();
      } else if (rec.status === 'dialing' || rec.status === 'ringing') {
        // Outbound: the seller picked up — tell the page at once so
        // it stops its local ringback, and bridge NOW if the agent
        // already answered (bridge on call.answered, never on AMD —
        // see canBridge). If the agent hasn't answered yet, the agent
        // branch's maybeBridge fires the moment they do.
        rec.status = 'answered';
        await maybeBridge();
      }
    }
  } else if (type === 'call.initiated') {
    // The other end is ringing — the page shows this + plays ringback.
    if (rec.status === 'dialing') rec.status = 'ringing';
  } else if (type === 'call.bridged') {
    rec.status = 'bridged';
    rec.wasBridged = true;
    rec.bridgedAt = rec.bridgedAt || Date.now();
  } else if (type === 'call.hangup') {
    if (found.role === 'agent') {
      // A losing agent leg hanging up (inbound rang several) is not
      // the call ending — prune it and carry on. Only the ACTIVE leg
      // hanging up ends the call (bridged: hang the seller; still
      // setting up with no legs left: hang the seller too). If other
      // agent legs are still ringing, the call can still connect
      // through one of them.
      const wasActive = rec.agentLeg === callControlId;
      rec.agentLegs = (rec.agentLegs || []).filter((id) => id !== callControlId);
      if (wasActive) rec.agentLeg = rec.agentLegs[0] || null;
      // The fallback leg hanging up (timeout, busy, Troy declined)
      // means the PSTN safety net failed — mark it; the ending logic
      // below (or the sweep) closes the call as missed.
      if (rec.fallbackLeg === callControlId) {
        rec.fallbackFailed = true;
        rec.fallbackAwaitingAmd = false;
      }
      if (wasActive && (rec.status === 'bridged' || !rec.agentLeg) && rec.status !== 'ended' && rec.status !== 'machine') {
        // PSTN fallback trigger (Layer 2, event-driven): the last
        // browser leg just died with the call still unanswered. Try
        // the fallback FIRST — if it dials, the call stays 'ringing'
        // on the fallback leg instead of ending as missed. Only when
        // the fallback is unavailable (flag off, already attempted)
        // does the call end here.
        let fallbackDialed = false;
        if (rec.direction === 'inbound' && rec.status === 'ringing' && !rec.agentAnswered) {
          const fb = await tryPstnFallback(pairings, rec, event);
          fallbackDialed = !!(fb && fb.attempted && fb.fallbackLeg);
        }
        if (!fallbackDialed) {
          if (rec.status === 'bridged') rec.wasBridged = true;
          rec.status = 'ended';
          rec.endedAt = Date.now();
          if (rec.sellerLeg && rec.sellerLeg !== callControlId) await hangupLeg(rec.sellerLeg, 'hangup thread seller leg');
        }
      }
    } else if (rec.status !== 'ended' && rec.status !== 'machine') {
      if (rec.status === 'bridged') rec.wasBridged = true;
      rec.status = 'ended';
      rec.endedAt = Date.now();
      const others = Array.from(new Set([rec.agentLeg, ...(rec.agentLegs || [])].filter((id) => id && id !== callControlId)));
      for (const other of others) await hangupLeg(other, 'hangup other thread leg');
    }
  }
  // Anything else: state stands.
  // The call just ended: write the HighLevel-shaped call entry into
  // the conversation thread ("Call completed" / "Missed call" /
  // "Voicemail" + Details dialog). Once per pairing — the flag rides
  // in the saved record, so a redelivered hangup never double-logs.
  if (rec.status === 'ended' && !rec.loggedToThread) {
    try { await callApi._thread.logCallToThread(event, rec); } catch (e) { /* thread logging never fails a webhook */ }
    rec.loggedToThread = true;
  }
  rec.lastEvent = type;
  rec.updatedAt = Date.now();
  await callApi._thread.savePairings(pairings, event);
  return { handled: true, threadCall: true, status: rec.status };
}

// ---- inbound calls (someone dials one of our numbers) ----
// An inbound call.initiated carries no client_state and no pairing.
// We ring the agent's browser (the stored voice credential's SIP URI)
// and record a pairing with direction 'inbound'. When the agent leg
// answers, applyThreadCallEvent answers the inbound leg and bridges.
//
// Nov 26, 2026 inbound fix (Layers F1 / 0 / 1):
//   * Dedupe by event id: a retried/redelivered call.initiated must
//     not re-dial (a second run would ring the agent twice and create
//     a duplicate pairing). Telnyx retries a delivery it thinks
//     failed; the pairing-exists check makes the retry a no-op.
//   * Credential read with one retry + an on-demand mint: the Nov 26
//     10:48-11:00 calls returned 200 in <1s with NO pairing — the
//     store looked empty to the webhook. A missing credential must
//     never silently drop a call again.
//   * Presence gate: dial only URIs whose page is live (fresh
//     heartbeat <30s), fail-open per URI for URIs with no record.
//     NOTE (Nov 26 portal check): a 180 Ringing on an agent leg does
//     NOT prove a WebRTC client is behind the identity — Telnyx's
//     internal generated-credential termination answers 180 itself
//     (private IPs in the Contact header). A 480 means the identity
//     has no registration at all. Presence is the only signal a live
//     client exists.
//   * Save the pairing EVEN with zero legs (status 'ringing',
//     agentLegs [], noAgentUri true) so the call appears in recents
//     and the watchdog flags it (stuck 'ringing' past 60s).
//   * Dial in parallel with timeout_secs 20 + a unique command_id per
//     dial; the webhook must answer Telnyx inside its 10s delivery
//     timeout. Do NOT depend on every leg producing webhook events:
//     the Nov 26 test dialed one URI twice and one of those legs had
//     no call_control_id and no webhook events at all (a SIP-level
//     retry of a failed 480 INVITE) — legs are best-effort, the
//     pairing + sweep are the source of truth.
//   * Web push wake-up after the save (Layer 1): high urgency, ~120s
//     TTL, awaited but bounded by sendToAll's ~3s timeout, fail-soft.
async function handleInboundCall(evt, event) {
  const payload = (evt && evt.payload) || {};
  const callControlId = payload.call_control_id || null;
  if (!callControlId) return { handled: false, reason: 'inbound call without call_control_id' };
  const v = voiceLib();
  const now = Date.now();
  const pairings = await callApi._thread.loadPairings(event);
  if (pairings.calls[callControlId]) {
    return {
      handled: true,
      duplicate: true,
      inbound: true,
      status: pairings.calls[callControlId].status || 'ringing',
    };
  }
  // Ring EVERY known voice credential at once (Nov 26, 2026): the
  // Conversations tab and the Dialer tab each hold their own
  // credential now, and an inbound call must reach whichever tab Troy
  // is looking at — first answer wins, the losers are hung up when
  // the winner answers.
  let uris = [];
  try {
    uris = await callApi.voiceCredentialUris(event);
  } catch (e) { uris = []; }
  if (!uris.length) {
    await sleep(800);
    try {
      uris = await callApi.voiceCredentialUris(event);
    } catch (e) { uris = []; }
  }
  if (!uris.length) {
    // On-demand mint (best-effort, bounded ~3s): mint the
    // 'conversations' credential now instead of dropping the call.
    // Only when the store is empty — never on the hot path.
    try {
      // The mint gate reads the same (injected) voice lib as the
      // dial below — the default import would bypass the test fake
      // and could not be stubbed.
      const cfg = v.voiceConfig ? v.voiceConfig() : { configured: false };
      const vt = voiceTokenLib();
      if (cfg.configured && vt && typeof vt.getOrCreateCredential === 'function') {
        const cred = await withTimeout(
          vt.getOrCreateCredential(event, cfg, 'conversations'),
          3000
        );
        if (cred && cred.sipUri) uris = [String(cred.sipUri)];
      }
    } catch (e) {
      console.error('[telnyx-voice-webhook] on-demand credential mint failed:', (e && e.message) || e);
    }
    if (!uris.length) {
      try {
        uris = await callApi.voiceCredentialUris(event);
      } catch (e) { uris = []; }
    }
  }
  // Presence gate (fail-open per URI — see the header note above).
  let dialUris = uris;
  let skippedStale = [];
  try {
    const presence = await callApi.presence.load(event);
    const fresh = [];
    for (const uri of uris) {
      if (callApi.presence.hasRecord(presence, uri) && !callApi.presence.isFresh(presence, uri, now)) {
        skippedStale.push(uri);
      } else fresh.push(uri);
    }
    dialUris = fresh;
    if (skippedStale.length) {
      console.warn(
        '[telnyx-voice-webhook] inbound ' + callControlId + ': skipped stale-presence URIs: ' + skippedStale.join(',')
      );
    }
  } catch (e) { /* presence read failure = fail open, dial all */ }
  const agentLegs = [];
  const dialResults = await Promise.allSettled(
    dialUris.map((sipUri, i) =>
      safeVoice(
        () =>
          v.createAgentLeg({
            sipUri,
            from: payload.to || undefined,
            timeoutSecs: 20,
            commandId: 'inb-' + String(callControlId).slice(-8) + '-' + i + '-' + now.toString(36),
            clientState: { kind: 'thread-call-agent', key: callControlId, sellerCallControlId: callControlId },
          }),
        'create agent leg for inbound call'
      )
    )
  );
  for (const r of dialResults) {
    if (r.status === 'fulfilled' && r.value && r.value.callControlId) agentLegs.push(r.value.callControlId);
  }
  const rec = {
    key: callControlId,
    phone: payload.from || '',
    to: payload.to || null,
    sellerLeg: callControlId,
    agentLeg: agentLegs[0] || null,
    agentLegs,
    status: 'ringing',
    direction: 'inbound',
    agentAnswered: false,
    sellerHuman: false,
    sellerAnswered: false,
    startedAt: now,
    updatedAt: now,
    hunt: agentLegs.length ? 'hunting' : 'no-agent',
    noAgentUri: agentLegs.length === 0,
  };
  if (skippedStale.length) rec.presenceSkipped = skippedStale;
  pairings.calls[callControlId] = rec;
  // The agent can answer before this save lands — merge any signal
  // stashed while the pairing did not exist yet, and if the agent
  // already answered, answer the inbound leg now (the branch that
  // normally does this never ran for a stashed event).
  await callApi._thread.mergePending(event, callControlId, rec);
  if (rec.agentAnswered && !rec.sellerAnswered) {
    await safeVoice(() => v.answer(rec.sellerLeg), 'answer inbound leg (pending merge)');
  }
  rec.updatedAt = Date.now();
  await callApi._thread.savePairings(pairings, event);
  // Web push wake-up (Layer 1): a notification, NOT a ring — it gets
  // Troy to tap, the tap opens Conversations at ?inbound=<id>, the
  // page (re)connects, and the re-dial flow rings the live client.
  try {
    const push = pushLib();
    if (push && typeof push.notifyInboundCall === 'function') {
      await push.notifyInboundCall({ phone: rec.phone, callId: callControlId, at: now }, event);
    }
  } catch (e) {
    console.error('[telnyx-voice-webhook] inbound push failed:', (e && e.message) || e);
  }
  if (!agentLegs.length) {
    console.error(
      '[telnyx-voice-webhook] INBOUND CALL WITH NO AGENT LEG — caller ' +
        (rec.phone || '?') +
        ' to ' +
        (rec.to || '?') +
        ' call ' +
        callControlId +
        (uris.length ? ' (URIs existed but no leg was created)' : ' (no agent SIP URI in store)') +
        (skippedStale.length ? ' presence-skipped: ' + skippedStale.join(',') : '')
    );
  }
  return { handled: true, inbound: true, status: 'ringing', agentLegs: agentLegs.length, noAgentUri: rec.noAgentUri };
}

// ---- PSTN fallback (Layer 2, Nov 26, 2026) ----
// The GHL-equivalent safety net: when no browser answers an inbound
// call inside the ~20s ring budget, dial Troy's real mobile from the
// business DID and bridge the seller to it. BEHIND A FLAG, DEFAULT
// OFF: INBOUND_PSTN_FALLBACK_ENABLED must be 'true' (or '1') AND
// INBOUND_PSTN_FALLBACK_NUMBER must hold the mobile number. With the
// flag off this whole path is inert — the call ends as a missed call
// instead. The number is env-only on purpose: Troy's personal mobile
// never goes in the repo.
// The fallback leg is a normal Call Control leg with AMD premium: when
// it answers, the bridge WAITS for the AMD verdict (see the agent
// answer + AMD branches in applyThreadCallEvent) so the seller is
// never bridged to Troy's voicemail greeting.
function pstnFallbackConfig() {
  const raw = String(process.env.INBOUND_PSTN_FALLBACK_ENABLED || '').toLowerCase().trim();
  const enabled = raw === 'true' || raw === '1';
  const number = String(process.env.INBOUND_PSTN_FALLBACK_NUMBER || '').trim();
  return { enabled, number };
}
// Dial the fallback leg for an in-memory pairing record. Works on the
// already-loaded pairings object (the webhook's applyThreadCallEvent
// saves it at the end) — the exported attemptPstnFallback wrapper
// below loads + saves for callers that do not hold the record (the
// scheduled sweep). Returns {attempted, fallbackLeg?, reason?}.
// Only fires when no browser leg is still ringing: the fallback is the
// last resort, not a parallel ring. opts.force (sweep only): the ring
// budget is spent, so listed legs are past their 20s timeout even if
// their hangup events never arrived (a leg with no call_control_id
// and no events at all was seen Nov 26) — hang them up best-effort
// and proceed instead of refusing.
async function tryPstnFallback(pairings, rec, event, opts) {
  const cfg = pstnFallbackConfig();
  if (!cfg.enabled) return { attempted: false, reason: 'disabled' };
  if (!cfg.number) return { attempted: false, reason: 'no-number-configured' };
  if (!rec || rec.direction !== 'inbound') return { attempted: false, reason: 'not-inbound' };
  if (rec.status !== 'ringing') return { attempted: false, reason: 'not-ringing' };
  if (rec.agentAnswered) return { attempted: false, reason: 'already-answered' };
  if (rec.fallbackAttempted) return { attempted: false, reason: 'already-attempted' };
  const v = voiceLib();
  if ((rec.agentLegs || []).length) {
    if (!(opts && opts.force)) return { attempted: false, reason: 'agent-legs-still-ringing' };
    for (const legId of Array.from(new Set(rec.agentLegs))) {
      await safeVoice(() => v.hangup(legId), 'hangup presumed-dead agent leg (sweep force)');
    }
    rec.agentLegs = [];
    rec.agentLeg = null;
  }
  if (rec.agentLeg) {
    await safeVoice(() => v.hangup(rec.agentLeg), 'hangup stale agent leg before PSTN fallback');
  }
  let fallback = null;
  try {
    fallback = await v.createCall({
      to: cfg.number,
      from: rec.to || undefined,
      amd: true,
      timeoutSecs: 20,
      clientState: { kind: 'thread-call-agent', key: rec.key, sellerCallControlId: rec.sellerLeg, fallback: true },
    });
  } catch (e) {
    rec.fallbackAttempted = true;
    rec.fallbackFailed = true;
    rec.lastError = 'pstn-fallback-failed: ' + String((e && e.message) || e);
    rec.updatedAt = Date.now();
    return { attempted: true, failed: true, detail: String((e && e.message) || e) };
  }
  if (!fallback || !fallback.callControlId) {
    rec.fallbackAttempted = true;
    rec.fallbackFailed = true;
    rec.updatedAt = Date.now();
    return { attempted: true, failed: true, detail: 'no call_control_id' };
  }
  rec.fallbackAttempted = true;
  rec.fallbackAt = Date.now();
  rec.fallbackLeg = fallback.callControlId;
  rec.agentLegs = [fallback.callControlId];
  rec.agentLeg = fallback.callControlId;
  rec.updatedAt = Date.now();
  return { attempted: true, fallbackLeg: fallback.callControlId };
}
async function attemptPstnFallback(event, callId, opts) {
  const pairings = await callApi._thread.loadPairings(event);
  const rec = pairings.calls[callId];
  if (!rec) return { attempted: false, reason: 'unknown call' };
  const result = await tryPstnFallback(pairings, rec, event, opts);
  await callApi._thread.savePairings(pairings, event);
  return result;
}

// ---- core event application (unit-tested) ----
async function applyCallEvent(evt, event) {
  const type = evt && evt.event_type;
  const payload = (evt && evt.payload) || {};
  const callControlId = payload.call_control_id || null;
  if (!type) return { handled: false, reason: 'no event_type' };

  // Recordings are session-independent (they can land after stop).
  if (type === 'call.recording.saved') {
    const urls = payload.recording_urls || {};
    const url = urls.mp3 || urls.wav || '';
    if (!callControlId || !url) return { handled: false, reason: 'recording without id/url' };
    const session = await engine.loadSession(event);
    let lead = null;
    let leg = null;
    if (session) {
      leg = legFor(session, callControlId);
      if (leg && leg.leadKey) lead = engine.findLead(session, leg.leadKey);
    }
    const rec = {
      id: callControlId,
      callControlId,
      phone: (lead && lead.phone) || payload.to || '',
      name: (lead && lead.name) || '',
      market: (lead && lead.market) || (session && session.market) || '',
      at: Date.parse(payload.recorded_at || '') || Date.now(),
      durationSecs: typeof payload.duration_secs === 'number' ? payload.duration_secs : null,
      url,
      format: urls.mp3 ? 'mp3' : 'wav',
      channels: payload.channels || 'single',
    };
    const r = await engine.addRecording(rec, event);
    return { handled: true, recording: r };
  }

  // Thread calls (Conversations single-call placement) — routed by
  // client_state kind, or by a pairing match when client_state is
  // absent. Everything else falls through to the dialer session logic.
  const threadState = voice.decodeClientState(payload.client_state);
  if (threadState.kind === 'thread-call' || threadState.kind === 'thread-call-agent') {
    return applyThreadCallEvent(evt, event, threadState);
  }
  if (callControlId) {
    const pairings = await callApi._thread.loadPairings(event);
    if (callApi._thread.findByLeg(pairings, callControlId)) {
      return applyThreadCallEvent(evt, event, threadState);
    }
  }

  // Inbound calls: no client_state, no pairing — the caller dialed one
  // of our numbers (direction 'inbound'). Ring the agent's browser.
  if (type === 'call.initiated' && payload.direction === 'inbound') {
    return handleInboundCall(evt, event);
  }

  const session = await engine.loadSession(event);
  if (!session) return { handled: false, reason: 'no active session' };
  const state = voice.decodeClientState(payload.client_state);
  // Correlate by call_control_id first; fall back to client_state ids.
  let leg = legFor(session, callControlId);
  if (!leg && state.leadKey) {
    leg = Object.values(session.legs).find((l) => l.leadKey === state.leadKey && l.state !== 'ended') || null;
  }
  if (!leg && type !== 'call.initiated') {
    return { handled: false, reason: 'unknown leg: ' + callControlId };
  }

  if (type === 'call.initiated') {
    if (leg) leg.state = leg.state === 'ended' ? leg.state : 'ringing';
    await engine.saveSession(session, event);
    return { handled: true };
  }

  if (type === 'call.answered') {
    leg.answeredAt = leg.answeredAt || Date.now();
    if (leg.kind === 'agent') {
      leg.state = 'answered';
      const winnerId = session.winnerCallControlId;
      if (winnerId && winnerId !== leg.callControlId) {
        const v = voiceLib();
        await safeVoice(() => v.bridge(winnerId, leg.callControlId), 'bridge winner<->agent');
        const winnerLeg = legFor(session, winnerId);
        if (winnerLeg) winnerLeg.state = 'bridged';
        leg.state = 'bridged';
      }
      await engine.saveSession(session, event);
      return { handled: true, bridged: !!winnerId };
    }
    // Seller leg answered — AMD verdict decides (detection event). If
    // the call was placed without AMD (amdResult already 'disabled'),
    // the answer itself is the win signal.
    leg.state = 'answered';
    if (leg.amdResult === 'disabled') {
      leg.amdResult = 'human';
      leg.state = 'answered-human';
      await declareWinner(session, leg, event);
    }
    await engine.saveSession(session, event);
    return { handled: true };
  }

  if (isAmdEvent(type)) {
    if (leg.kind !== 'seller') return { handled: false, reason: 'AMD event for non-seller leg' };
    if (leg.state === 'ended') {
      // Stale verdict for a leg we already hung up (race loser) — the
      // state we wrote when it ended stands.
      return { handled: true, duplicate: true };
    }
    // Premium AMD (see telnyx-voice-lib.js): human_residence /
    // human_business are human, 'not_sure' is human per Telnyx,
    // silence/fax/beep are machine.
    const verdict = amdVerdict(payload.result);
    if (verdict === 'machine') {
      leg.amdResult = 'machine';
      leg.state = 'ended';
      leg.endedAt = Date.now();
      leg.endReason = 'machine';
      const lead = engine.findLead(session, leg.leadKey);
      if (lead && lead.status !== 'done') {
        lead.status = 'done';
        lead.disposition = 'Machine';
        lead.autoDisposition = true;
      }
      session.stats.machines += 1;
      const v = voiceLib();
      await safeVoice(() => v.hangup(leg.callControlId), 'hangup machine leg');
      await engine.saveSession(session, event);
      const fresh = await refillAndMaybeComplete(session, event);
      return { handled: true, machine: true, session: fresh && fresh.status };
    }
    if (verdict === 'human') {
      leg.amdResult = 'human';
      leg.state = 'answered-human';
      if (!session.winnerCallControlId) {
        await declareWinner(session, leg, event);
        await engine.saveSession(session, event);
        return { handled: true, winner: leg.callControlId };
      }
      // A human answered but the agent is already on the winner —
      // this leg loses the race as an answered human.
      leg.state = 'ended';
      leg.endedAt = Date.now();
      leg.endReason = 'lost-race';
      const lead = engine.findLead(session, leg.leadKey);
      if (lead && lead.status !== 'done') {
        lead.status = 'done';
        lead.disposition = 'Callback Later';
        lead.autoDisposition = true;
        session.stats.callbacks += 1;
      }
      const v = voiceLib();
      await safeVoice(() => v.hangup(leg.callControlId), 'hangup late human leg');
      await engine.saveSession(session, event);
      return { handled: true, lateHuman: true };
    }
    return { handled: false, reason: 'unmapped AMD result: ' + String(payload.result || '') };
  }

  if (type === 'call.hangup') {
    if (leg.state === 'ended') {
      // Duplicate terminal event (e.g. the hangup we issued for a
      // machine/loser) — state already reflects it.
      return { handled: true, duplicate: true };
    }
    leg.state = 'ended';
    leg.endedAt = Date.now();
    leg.endReason = String(payload.hangup_cause || 'hangup');
    if (typeof payload.duration_secs === 'number') leg.durationSecs = payload.duration_secs;

    if (leg.kind === 'agent') {
      // Agent hung up (or dropped). If the winner is still live, the
      // lead waits for the agent's disposition from the page.
      const lead = session.connectedLeadKey ? engine.findLead(session, session.connectedLeadKey) : null;
      if (lead && lead.status === 'connected') lead.status = 'awaiting-disposition';
      await engine.saveSession(session, event);
      return { handled: true, agentHangup: true };
    }

    const lead = engine.findLead(session, leg.leadKey);
    const isWinner = session.winnerCallControlId === leg.callControlId;
    if (isWinner) {
      // The connected seller hung up: clear the win and free the agent
      // leg, but the session STAYS 'connected' — the lead is waiting on
      // the agent's disposition from the page, and the disposition
      // action is what resumes dialing (cc-dialer-api). No refill here:
      // the agent dispositions one call at a time.
      if (lead && lead.status === 'connected') {
        lead.status = 'awaiting-disposition';
        if (typeof payload.duration_secs === 'number') lead.durationSecs = payload.duration_secs;
      }
      const agentLeg = session.agentCallControlId ? legFor(session, session.agentCallControlId) : null;
      session.winnerCallControlId = null;
      if (agentLeg && agentLeg.state !== 'ended') {
        agentLeg.state = 'ended';
        agentLeg.endedAt = Date.now();
        const v = voiceLib();
        await safeVoice(() => v.hangup(agentLeg.callControlId), 'hangup agent after winner');
      }
      session.agentCallControlId = null;
      await engine.saveSession(session, event);
      return { handled: true, winnerHangup: true, session: session.status };
    }

    // Ordinary leg ending (no answer / busy / failed / our hangup).
    if (lead && lead.status !== 'done') {
      const auto = autoDispositionForHangup(leg, payload);
      if (auto) {
        lead.status = 'done';
        lead.disposition = auto;
        lead.autoDisposition = true;
        if (auto === 'No Answer') session.stats.noAnswers += 1;
        if (auto === 'Machine') session.stats.machines += 1;
      } else {
        lead.status = 'pending';
        lead.callControlId = null;
      }
    }
    await engine.saveSession(session, event);
    const fresh = await refillAndMaybeComplete(session, event);
    return { handled: true, session: fresh && fresh.status };
  }

  if (type === 'call.bridged') {
    if (leg) {
      leg.state = 'bridged';
      await engine.saveSession(session, event);
    }
    return { handled: true };
  }

  return { handled: false, reason: 'unhandled event type: ' + type };
}

// ---- signature verification (Ed25519 — same as telnyx-webhook.js) ----
function verifySignature(rawBody, headers) {
  const pubB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!pubB64) return { configured: false, valid: true }; // see header note
  const sigB64 = headers['telnyx-signature-ed25519'];
  const ts = headers['telnyx-timestamp'];
  if (!sigB64 || !ts) return { configured: true, valid: false };
  try {
    const rawKey = Buffer.from(pubB64, 'base64');
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    const data = Buffer.from(String(ts) + '|' + rawBody, 'utf8');
    const sig = Buffer.from(sigB64, 'base64');
    return { configured: true, valid: crypto.verify(null, data, key, sig) };
  } catch (e) {
    return { configured: true, valid: false, error: String((e && e.message) || e) };
  }
}

exports.handler = async (event) => {
  const respond = (status, obj) => ({
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  try {
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });
    let raw = event.body || '';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');

    const sig = verifySignature(raw, event.headers || {});
    if (!sig.configured) {
      console.warn('[telnyx-voice-webhook] TELNYX_PUBLIC_KEY not set — processing unverified webhook (pre-launch).');
    } else if (!sig.valid) {
      return respond(400, { error: 'Invalid webhook signature' });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return respond(400, { error: 'Bad JSON' });
    }
    const evt = parsed && parsed.data ? parsed.data : parsed;
    const result = await applyCallEvent(evt, event);
    return respond(200, { received: true, ...result });
  } catch (e) {
    console.error('[telnyx-voice-webhook]', e);
    return respond(500, { error: String((e && e.message) || e) });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  applyCallEvent,
  handleInboundCall,
  attemptPstnFallback,
  tryPstnFallback,
  verifySignature,
  setVoiceLib(v) {
    deps.voiceLib = v || null;
  },
  setPushLib(p) {
    deps.pushLib = p || null;
  },
  setVoiceToken(vt) {
    deps.voiceToken = vt || null;
  },
  reset() {
    deps.voiceLib = null;
    deps.pushLib = null;
    deps.voiceToken = null;
  },
};
// The scheduled sweep (cc-inbound-sweep.js) drives the PSTN fallback
// for pairings whose agent-leg hangups never arrived.
exports.attemptPstnFallback = attemptPstnFallback;

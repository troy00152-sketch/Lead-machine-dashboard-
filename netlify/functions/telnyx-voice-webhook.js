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

// ---- injectable voice actions (tests) ----
const deps = { voiceLib: null };
function voiceLib() {
  return deps.voiceLib || voice;
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
// route here. Bridge rule mirrors the dialer: bridge ONLY once the
// seller is a confirmed human AND the agent has answered — whichever
// of those two signals lands second triggers the bridge.
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
  if (!found) return { handled: false, reason: 'thread pairing not found' };
  const rec = found.rec;
  const v = voiceLib();

  async function hangupLeg(legId, label) {
    if (!legId) return;
    await safeVoice(() => v.hangup(legId), label);
  }
  async function hangupBoth() {
    await hangupLeg(rec.sellerLeg, 'hangup thread seller leg');
    await hangupLeg(rec.agentLeg, 'hangup thread agent leg');
  }
  async function maybeBridge() {
    if (rec.sellerHuman && rec.agentAnswered && rec.sellerLeg && rec.agentLeg) {
      await safeVoice(() => v.bridge(rec.sellerLeg, rec.agentLeg), 'bridge thread call');
      rec.status = 'bridged';
    }
  }

  if (type === 'call.machine.detection.ended' || type === 'call.machine.greeting.ended') {
    if (found.role !== 'seller') return { handled: false, reason: 'AMD event for non-seller leg' };
    const result = String(payload.result || '').toLowerCase();
    if (result === 'machine') {
      await hangupBoth();
      rec.status = 'machine';
    } else if (result === 'human' || result === 'not_sure') {
      rec.sellerHuman = true;
      await maybeBridge();
    } else {
      return { handled: false, reason: 'unmapped AMD result: ' + result };
    }
  } else if (type === 'call.answered') {
    if (found.role === 'agent') {
      rec.agentAnswered = true;
      await maybeBridge();
    } else {
      // Seller picked up — no bridge until the AMD verdict lands.
      rec.sellerAnswered = true;
    }
  } else if (type === 'call.hangup') {
    if (rec.status !== 'ended' && rec.status !== 'machine') {
      rec.status = 'ended';
      const other = found.role === 'seller' ? rec.agentLeg : rec.sellerLeg;
      if (other && other !== callControlId) {
        await hangupLeg(other, 'hangup other thread leg');
      }
    }
  }
  // call.initiated / call.bridged / anything else: state stands.
  rec.updatedAt = Date.now();
  await callApi._thread.savePairings(pairings, event);
  return { handled: true, threadCall: true, status: rec.status };
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

  if (type === 'call.machine.detection.ended' || type === 'call.machine.greeting.ended') {
    if (leg.kind !== 'seller') return { handled: false, reason: 'AMD event for non-seller leg' };
    if (leg.state === 'ended') {
      // Stale verdict for a leg we already hung up (race loser) — the
      // state we wrote when it ended stands.
      return { handled: true, duplicate: true };
    }
    const result = String(payload.result || '').toLowerCase();
    if (result === 'machine') {
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
    if (result === 'human' || result === 'not_sure') {
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
    return { handled: false, reason: 'unmapped AMD result: ' + result };
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
  verifySignature,
  setVoiceLib(v) {
    deps.voiceLib = v || null;
  },
  reset() {
    deps.voiceLib = null;
  },
};

// netlify/functions/cc-call-api.js
// Single-call placement from a Conversations thread: call ONE seller
// from the thread screen (not the triple-line dialer). The seller leg
// is placed via Telnyx Call Control with answering-machine detection;
// the agent leg rings the agent's registered WebRTC client (the same
// telephony credential cc-voice-token.js created) and
// telnyx-voice-webhook.js bridges the two legs once the seller answers
// AND the agent has answered (AMD is a parallel 'possible voicemail'
// label, never a bridge gate — Nov 26, 2026, Telnyx research: bridge
// on call.answered).
//
// Pairings live in the 'cc-dialer' Blobs store under 'thread-calls':
//   {calls: {<sellerCallControlId>: {key, phone, sellerLeg, agentLeg,
//     status: 'dialing'|'bridged'|'machine'|'ended', agentAnswered,
//     sellerHuman, sellerAnswered, startedAt, updatedAt}}}
// telnyx-voice-webhook.js drives them via exports._thread.
//
// FAIL CLOSED: voice not configured -> 503 {configured:false};
// no agent voice credential yet -> 503. Nothing ever fakes a call.
// lm_auth-gated, same HMAC as cc-conversations-api.js.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const telnyxLibDefault = require('./telnyx-lib');
const voiceDefault = require('./telnyx-voice-lib');

const DIALER_STORE = 'cc-dialer';
const CONV_STORE = 'cc-conversations';
const THREAD_CALLS_KEY = 'thread-calls';
const CREDENTIAL_KEY = 'voice-credential';
const SIP_DOMAIN = 'sip.telnyx.com';

// ---- call history + dispositions (GoHighLevel shape, Nov 26, 2026) ----
// Finished thread calls land in the conversation thread as a call
// entry ("Call completed" / "Missed call" / "Voicemail") with a
// Details dialog — exactly what HighLevel renders for past calls.
// No duration, no recording, no transcript (HL shows none either).
// Post-call dispositions are HighLevel's six custom dispositions
// (created 2026-10-28): "Voicemail" is a post-call outcome label,
// not a drop action — there is no voicemail-drop button anywhere.
const HL_DISPOSITIONS = ['No Answer', 'Voicemail', 'Follow Up', 'Requested Appointment', 'Not Interested', 'Incorrect Number'];
const DISPOSITIONS_KEY = 'call-dispositions';
const THREAD_INDEX_KEY = 'index';
const MAX_THREAD_MESSAGES = 500;

// ---- injectable dependencies (tests) ----
const deps = {
  dialerStoreFactory: null,
  convStoreFactory: null,
  voiceLib: null,
  telnyxLib: null,
};
function voiceLib() {
  return deps.voiceLib || voiceDefault;
}
function telnyxLib() {
  return deps.telnyxLib || telnyxLibDefault;
}
function makeStore(name, factory, event) {
  if (factory) return factory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(name);
}
function dialerStore(event) {
  return makeStore(DIALER_STORE, deps.dialerStoreFactory, event);
}
function convStore(event) {
  return makeStore(CONV_STORE, deps.convStoreFactory, event);
}

async function readJson(s, key) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

// ---- auth: verify the dashboard lm_auth cookie (same HMAC as gate.ts) ----
const COOKIE_NAME = 'lm_auth';
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
const forbidden = () => json(403, { error: 'Calling access only — thread calls are started from the full dashboard login.' });
const ccAuth = require('./cc-auth');
const push = require('./cc-push');
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false;
  const headers = event.headers || {};
  const cookieHeader = headers.cookie || headers.Cookie || '';
  const cookie = getCookie(cookieHeader, COOKIE_NAME);
  if (!cookie) return false;
  const [expiry, sig] = cookie.split('.');
  if (!expiry || !sig) return false;
  const exp = parseInt(expiry, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(expiry).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- config helpers ----
// The voice lib's config surface is voiceConfig() today; accept a
// voiceConfigured() boolean helper too so either shape works.
function isVoiceConfigured(v) {
  if (typeof v.voiceConfigured === 'function') return !!v.voiceConfigured();
  if (typeof v.voiceConfig === 'function') return !!v.voiceConfig().configured;
  return false;
}
// Caller-ID pick: telnyx-lib's pool picker (pickSender; a
// pickFromNumber alias is accepted when present).
function pickFromNumber(market) {
  const lib = telnyxLib();
  if (typeof lib.pickFromNumber === 'function') return lib.pickFromNumber(market);
  return lib.pickSender(market);
}

// The agent SIP URI comes from the telephony credential record
// cc-voice-token.js cached in the 'cc-dialer' store — exactly the
// record/derivation cc-dialer-api's start flow relies on the page
// having created (sip:<username>@sip.telnyx.com).
async function agentSipUri(event) {
  const s = dialerStore(event);
  const cred = await readJson(s, CREDENTIAL_KEY);
  if (!cred) return null;
  if (cred.sipUri) return String(cred.sipUri);
  const username = cred.username || cred.user_name;
  if (username) return 'sip:' + username + '@' + SIP_DOMAIN;
  return null;
}

// Usernames of every voice credential we have minted (one per browser
// surface since Nov 26, 2026 — see cc-voice-token.js). A page-reported
// agent SIP URI is trusted ONLY when its username is one of these:
// the URI is how the server addresses that page's WebRTC client, and
// an arbitrary SIP URI must never be dialable from here.
const VOICE_CREDENTIAL_KEYS = [
  'voice-credential',
  'voice-credential-conversations',
  'voice-credential-dialer',
  'voice-credential-irish',
];
async function knownVoiceUsernames(event) {
  const s = dialerStore(event);
  const names = new Set();
  for (const key of VOICE_CREDENTIAL_KEYS) {
    try {
      const cred = await readJson(s, key);
      const u = cred && (cred.username || cred.user_name);
      if (u) names.add(String(u));
    } catch (e) { /* a missing record just is not a known username */ }
  }
  return names;
}
// Prefer the SIP URI the calling page reports (its own registered
// client identity — the dialer session flow already works this way
// via session.agentSipUri). Fall back to the stored default
// credential's URI when the page sends none or an unknown one.
async function resolveAgentSipUri(event, reported) {
  if (reported && typeof reported === 'string') {
    const m = /^sip:([A-Za-z0-9._-]+)@sip\.telnyx\.com$/i.exec(reported.trim());
    if (m) {
      const known = await knownVoiceUsernames(event);
      if (known.has(m[1])) return 'sip:' + m[1] + '@' + SIP_DOMAIN;
    }
  }
  return agentSipUri(event);
}

// ---- pairing records (shared with telnyx-voice-webhook.js) ----
async function loadPairings(event) {
  try {
    const s = dialerStore(event);
    const box = await readJson(s, THREAD_CALLS_KEY);
    if (box && box.calls && typeof box.calls === 'object') return box;
    return { calls: {} };
  } catch (e) {
    // Fail soft: the voice webhook probes pairings on every call
    // event; a store hiccup must never break the dialer path.
    return { calls: {} };
  }
}
async function savePairings(obj, event) {
  const s = dialerStore(event);
  await writeJson(s, THREAD_CALLS_KEY, obj);
  return obj;
}

// Pending signals: a webhook event can arrive BEFORE the pairing
// record exists — the browser auto-answers the agent leg within ~1s
// of 'start', and the webhook can deliver call.answered before the
// Blobs write lands. Dropping that event used to lose agentAnswered
// forever, so the bridge never formed and the page rang on while the
// seller was unheard. Signals are stashed here (keyed by the seller
// leg's call_control_id) and merged when the pairing appears.
const PENDING_PREFIX = 'thread-call-pending:';
async function loadPending(event, sellerCallControlId) {
  const s = dialerStore(event);
  return await readJson(s, PENDING_PREFIX + sellerCallControlId);
}
async function savePending(event, sellerCallControlId, marker) {
  const s = dialerStore(event);
  marker.updatedAt = Date.now();
  await writeJson(s, PENDING_PREFIX + sellerCallControlId, marker);
}
async function clearPending(event, sellerCallControlId) {
  const s = dialerStore(event);
  await s.delete(PENDING_PREFIX + sellerCallControlId).catch(() => {});
}
async function mergePending(event, sellerCallControlId, rec) {
  const pending = await loadPending(event, sellerCallControlId);
  if (!pending) return false;
  if (pending.agentAnswered) rec.agentAnswered = true;
  if (pending.sellerHuman) rec.sellerHuman = true;
  if (pending.sellerAnswered) rec.sellerAnswered = true;
  // A stashed 'machine' verdict is a label only now (Nov 26, 2026:
  // the bridge no longer waits on AMD) — it still lands so the page
  // can show 'Connected — possible voicemail'.
  if (pending.sellerMachine) rec.amdResult = 'machine';
  if (pending.agentLeg && !rec.agentLeg) rec.agentLeg = pending.agentLeg;
  if (pending.agentLeg) {
    rec.agentLegs = Array.from(new Set([...(rec.agentLegs || []), pending.agentLeg]));
    if (!rec.agentLeg) rec.agentLeg = pending.agentLeg;
  }
  // Inbound: the caller dialed us, so their answer IS the human
  // signal (same derivation as the webhook's call.answered branch).
  if (rec.direction === 'inbound' && pending.sellerAnswered) rec.sellerHuman = true;
  await clearPending(event, sellerCallControlId);
  return true;
}
function findByLeg(pairings, callControlId) {
  if (!pairings || !pairings.calls || !callControlId) return null;
  for (const [callId, rec] of Object.entries(pairings.calls)) {
    if (!rec) continue;
    if (callId === callControlId || rec.sellerLeg === callControlId) {
      return { callId, rec, role: 'seller' };
    }
    // Inbound rings every known credential at once (Nov 26, 2026) —
    // the pairing can hold several agent legs; any of them is ours.
    if (rec.agentLeg === callControlId || (Array.isArray(rec.agentLegs) && rec.agentLegs.includes(callControlId))) {
      return { callId, rec, role: 'agent' };
    }
  }
  return null;
}

// SIP URIs of every voice credential we have minted (one per browser
// surface + Irish), for inbound ringing: an inbound call must ring
// every surface that could be showing, first answer wins.
async function voiceCredentialUris(event) {
  const s = dialerStore(event);
  const uris = [];
  for (const key of VOICE_CREDENTIAL_KEYS) {
    try {
      const cred = await readJson(s, key);
      if (cred && cred.sipUri) uris.push(String(cred.sipUri));
      else if (cred && (cred.username || cred.user_name)) uris.push('sip:' + (cred.username || cred.user_name) + '@' + SIP_DOMAIN);
    } catch (e) { /* a missing record just is not rung */ }
  }
  return Array.from(new Set(uris));
}

// ---- HTTP handler ----
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) return ccAuth.isIrish(event) ? forbidden() : unauth();

    const params = event.queryStringParameters || {};
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return bad('Bad JSON body.');
      }
    }
    const action = params.action || body.action || '';
    const v = voiceLib();
    const lib = telnyxLib();

    if (action === 'start') {
      if (!isVoiceConfigured(v)) {
        return json(503, { configured: false, error: 'voice not configured' });
      }
      // Ring the SIP URI of the page that placed the call (its own
      // per-surface credential) — never a sibling tab's client.
      const sipUri = await resolveAgentSipUri(event, body.agentSipUri);
      if (!sipUri) {
        return json(503, { configured: false, reason: 'agent voice credential not created yet' });
      }
      const rawPhone = body.phone;
      if (!rawPhone) return bad('Missing phone.');
      let key;
      let phoneE164;
      try {
        phoneE164 = lib.toE164(rawPhone);
        key = lib.phoneKey(rawPhone);
      } catch (e) {
        return bad('Invalid phone number.');
      }
      const market = body.market ? String(body.market).toLowerCase() : undefined;

      // Our caller ID: the number this thread has been texting from,
      // else the market pool pick (fail-soft — createCall re-checks).
      let ourNumber = null;
      try {
        const cs = convStore(event);
        const thread = await readJson(cs, key);
        if (thread && thread.ourNumber) ourNumber = thread.ourNumber;
      } catch (e) { /* thread read is best-effort */ }
      if (!ourNumber) {
        try {
          ourNumber = pickFromNumber(market);
        } catch (e) {
          ourNumber = null;
        }
      }

      // A caller ID chosen in the dialer pod wins over the thread's
      // number and the pool pick — but only if it is one of our own
      // Telnyx numbers (never an arbitrary number).
      if (body.from) {
        try {
          const chosen = lib.toE164(body.from);
          const pools = lib.SENDER_POOLS || {};
          const owned = Object.values(pools).some((list) => (list || []).includes(chosen));
          if (owned) ourNumber = chosen;
        } catch (e) { /* invalid chosen number — keep the fallback */ }
      }

      const seller = await v.createCall({
        to: phoneE164,
        from: ourNumber || undefined,
        market,
        amd: true,
        clientState: { kind: 'thread-call', key },
      });
      if (!seller || !seller.callControlId) {
        return json(502, { error: 'Telnyx did not return a call_control_id for the seller leg.' });
      }
      const sellerCallControlId = seller.callControlId;
      // Save the pairing BEFORE creating the agent leg. The browser
      // auto-answers the agent leg within ~1s, and the webhook can
      // deliver call.answered before a later save completes — a
      // dropped agentAnswered used to deadlock the bridge forever:
      // the page rang on (ringback never stops) while the seller was
      // unheard. The agent leg cannot be answered before it exists,
      // so saving first removes the race entirely.
      const now = Date.now();
      const pairings = await loadPairings(event);
      pairings.calls[sellerCallControlId] = {
        key,
        phone: phoneE164,
        from: ourNumber || null,
        market: market || null,
        sellerLeg: sellerCallControlId,
        agentLeg: null,
        agentSipUri: sipUri,
        status: 'dialing',
        agentAnswered: false,
        sellerHuman: false,
        sellerAnswered: false,
        startedAt: now,
        updatedAt: now,
      };
      await savePairings(pairings, event);
      const failAgentLeg = async (detail) => {
        // No agent leg, no call: hang the seller leg up and mark the
        // pairing ended so the page stops ringing instead of ringing
        // the seller's phone with nobody on our side.
        try { await v.hangup(sellerCallControlId); } catch (_) { /* already gone */ }
        const p2 = await loadPairings(event);
        const r2 = p2.calls[sellerCallControlId];
        if (r2) {
          r2.status = 'ended';
          r2.lastError = 'agent-leg-failed: ' + detail;
          r2.updatedAt = Date.now();
          await savePairings(p2, event);
        }
      };
      let agent = null;
      try {
        agent = await v.createAgentLeg({
          sipUri,
          from: ourNumber || undefined,
          clientState: { kind: 'thread-call-agent', key, sellerCallControlId },
        });
      } catch (e) {
        await failAgentLeg(String((e && e.message) || e));
        return json(502, { error: 'Could not dial the browser agent leg.', detail: String((e && e.message) || e) });
      }
      if (!agent || !agent.callControlId) {
        await failAgentLeg('Telnyx did not return an agent leg.');
        return json(502, { error: 'Could not dial the browser agent leg.', detail: 'Telnyx did not return an agent leg.' });
      }
      // Re-read: a webhook event may already have landed (and been
      // stashed as a pending signal) between the save and this read.
      const fresh = await loadPairings(event);
      const rec = fresh.calls[sellerCallControlId];
      if (rec) {
        rec.agentLeg = agent.callControlId;
        await mergePending(event, sellerCallControlId, rec);
        rec.updatedAt = Date.now();
        await savePairings(fresh, event);
        // If both bridge signals are already true, bridge now instead
        // of waiting for another event that may never come. Bridge on
        // seller answer + agent answer (Nov 26, 2026 — AMD never
        // gates the bridge; an AMD verdict also counts as proof the
        // seller answered, see telnyx-voice-webhook.js).
        if ((rec.sellerAnswered || rec.sellerHuman || rec.amdResult === 'machine') && rec.agentAnswered && rec.agentLeg) {
          try {
            await v.bridge(rec.sellerLeg, rec.agentLeg);
            rec.status = 'bridged';
            rec.wasBridged = true;
            rec.bridgedAt = rec.bridgedAt || Date.now();
          } catch (e) {
            rec.lastError = 'bridge-failed: ' + String((e && e.message) || e);
          }
          rec.updatedAt = Date.now();
          await savePairings(fresh, event);
        }
      }
      return ok({ ok: true, callId: sellerCallControlId, status: 'dialing' });
    }

    if (action === 'hangup') {
      const callId = body.callId || params.callId;
      if (!callId) return bad('Missing callId.');
      const pairings = await loadPairings(event);
      const found = findByLeg(pairings, callId);
      const rec = found ? found.rec : pairings.calls[callId];
      if (!rec) return json(404, { error: 'unknown call' });
      const legs = Array.from(new Set([rec.sellerLeg, rec.agentLeg, ...(rec.agentLegs || [])].filter(Boolean)));
      for (const legId of legs) {
        try {
          await v.hangup(legId);
        } catch (e) { /* leg may already be gone */ }
      }
      // Capture the bridged flag BEFORE overwriting the status —
      // the thread log uses it to tell a completed call from a miss.
      if (rec.status === 'bridged') rec.wasBridged = true;
      rec.status = 'ended';
      rec.endedAt = Date.now();
      rec.updatedAt = Date.now();
      await savePairings(pairings, event);
      // Log the finished call into the thread (HL call-history
      // shape). Fail-soft — thread logging never fails a hangup.
      try {
        if (!rec.loggedToThread) {
          await logCallToThread(event, rec);
          rec.loggedToThread = true;
          await savePairings(pairings, event);
        }
      } catch (e) { /* already guarded inside logCallToThread */ }
      return ok({ ok: true });
    }

    if (action === 'inbound') {
      // Incoming-call banner lookup: the browser just got a WebRTC
      // invite for an agent leg it did not place (a seller called one
      // of our numbers). The SIP leg only carries our own number as
      // caller ID, so the page asks the server which inbound pairing
      // this agent leg belongs to — that carries the real caller phone
      // (+ name from the thread) and the pairing key the page needs to
      // poll the call to Connected. The agent leg's call_control_id
      // rides on the SDK call object (options.telnyxCallControlId).
      // Returns {found:false} while the webhook is still saving the
      // pairing — the page retries for a few seconds.
      const agentLeg = params.agentLeg || body.agentLeg;
      if (!agentLeg) return bad('Missing agentLeg.');
      const pairings = await loadPairings(event);
      const found = findByLeg(pairings, agentLeg);
      if (!found) return ok({ found: false });
      const rec = found.rec;
      let name = '';
      try {
        const cs = convStore(event);
        if (rec.key) {
          const thread = await readJson(cs, rec.key);
          if (thread && thread.name) name = thread.name;
        }
      } catch (e) { /* name is best-effort */ }
      return ok({
        found: true,
        callId: found.callId,
        phone: rec.phone || '',
        name,
        status: rec.status || '',
        direction: rec.direction || '',
      });
    }

    if (action === 'status') {
      const callId = params.callId || body.callId;
      if (!callId) return bad('Missing callId.');
      const pairings = await loadPairings(event);
      const found = findByLeg(pairings, callId);
      const rec = found ? found.rec : pairings.calls[callId];
      if (!rec) return json(404, { error: 'unknown call' });
      return ok(Object.assign({}, rec, { callId: found ? found.callId : callId }));
    }

    if (action === 'recents') {
      // Dialer Recents tab (HighLevel shape): every thread/manual
      // call, newest first, with direction, outcome and the latest
      // post-call disposition for the number.
      const pairings = await loadPairings(event);
      const disps = (await readJson(dialerStore(event), DISPOSITIONS_KEY)) || {};
      const byPhone = (disps && disps.byPhone) || {};
      const lib = telnyxLib();
      const calls = Object.entries(pairings.calls || {}).map(([callId, r], i) => {
        let pkey = '';
        try { pkey = lib.phoneKey(r.phone); } catch (e) { pkey = ''; }
        const wasBridged = !!(r.wasBridged || r.status === 'bridged' || (r.sellerAnswered && r.agentAnswered));
        const callStatus = r.status === 'ended'
          ? (wasBridged ? (r.amdResult === 'machine' ? 'voicemail' : 'completed') : 'missed')
          : r.status;
        const d = (pkey && byPhone[pkey]) || null;
        return {
          callId,
          phone: r.phone || '',
          direction: r.direction || 'outbound',
          status: r.status || '',
          callStatus,
          startedAt: r.startedAt || 0,
          endedAt: r.endedAt || null,
          durationMs: r.bridgedAt && r.endedAt ? Math.max(0, r.endedAt - r.bridgedAt) : null,
          disposition: d ? d.disposition : null,
          dispositionAt: d ? d.at : null,
          _seq: i,
        };
      });
      // Newest first. startedAt ties (two calls in the same
      // millisecond) break by creation order — later-created first —
      // so the order is deterministic, never clock-luck.
      calls.sort((a, b) => (b.startedAt - a.startedAt) || (b._seq - a._seq));
      calls.forEach((c) => { delete c._seq; });
      return ok({ calls: calls.slice(0, 50), count: calls.length });
    }

    if (action === 'disposition') {
      // Post-call disposition — HighLevel's six custom dispositions
      // only. Anything else is rejected (the triple-line session
      // keeps its own nine labels; this is the thread/manual log).
      const rawPhone = body.phone || params.phone;
      const disp = body.disposition || params.disposition;
      if (!rawPhone) return bad('Missing phone.');
      if (!HL_DISPOSITIONS.includes(disp)) return bad('Unknown disposition.');
      const lib = telnyxLib();
      let key;
      let phoneE164;
      try {
        key = lib.phoneKey(rawPhone);
        phoneE164 = lib.toE164(rawPhone);
      } catch (e) { return bad('Invalid phone number.'); }
      const s = dialerStore(event);
      const box = (await readJson(s, DISPOSITIONS_KEY)) || { byPhone: {}, list: [] };
      const entry = { phone: phoneE164, disposition: disp, callId: body.callId || params.callId || null, at: Date.now() };
      box.byPhone = box.byPhone || {};
      box.byPhone[key] = entry;
      box.list = box.list || [];
      box.list.push(entry);
      if (box.list.length > 200) box.list = box.list.slice(-200);
      await writeJson(s, DISPOSITIONS_KEY, box);
      if (disp === 'Requested Appointment') {
        // Phone push: someone asked for an appointment on this call.
        // Bounded (never throws, never past ~3s).
        try {
          await push.notifyAppointment({
            phone: phoneE164, callId: entry.callId, at: entry.at, requested: true,
          }, event);
        } catch (e) {
          console.error('[cc-call-api] push failed:', e);
        }
      }
      return ok({ ok: true, disposition: disp });
    }

    return bad('Unknown action.');
  } catch (e) {
    return json(503, { error: 'Call storage is not ready yet', detail: String((e && e.message) || e) });
  }
};

// ---- call history (GoHighLevel shape) ----
// A finished thread call is written into the conversation thread as
// a call entry, so the thread shows the grey "Call completed" /
// "Missed call" / "Voicemail" bubble with a Details dialog. The
// voice webhook calls this when a pairing ends; the page-initiated
// 'hangup' action calls it too. Returns true when an entry was
// written. Fail-soft throughout: a missing thread (manual dial to a
// number with no conversation) simply skips the thread write — the
// call still shows in Recents.
function callHistoryLabel(status) {
  if (status === 'voicemail') return 'Voicemail';
  if (status === 'missed') return 'Missed call';
  return 'Call completed';
}
async function logCallToThread(event, rec) {
  try {
    if (!rec || !rec.phone) return false;
    const lib = telnyxLib();
    const key = lib.phoneKey(rec.phone);
    const s = convStore(event);
    const thread = await readJson(s, key);
    if (!thread || !Array.isArray(thread.messages)) return false;
    const wasBridged = !!(rec.wasBridged || rec.status === 'bridged');
    const answered = !!(rec.sellerAnswered && rec.agentAnswered);
    let callStatus = 'missed';
    if (wasBridged || answered) callStatus = rec.amdResult === 'machine' ? 'voicemail' : 'completed';
    const durationMs = rec.bridgedAt && rec.endedAt ? Math.max(0, rec.endedAt - rec.bridgedAt) : null;
    const dir = rec.direction === 'inbound' ? 'in' : 'out';
    const label = callHistoryLabel(callStatus);
    const entry = {
      dir,
      kind: 'call',
      callStatus,
      body: label,
      at: Date.now(),
      from: dir === 'in' ? (rec.phone || '') : (rec.from || ''),
      to: dir === 'in' ? (rec.to || '') : (rec.phone || ''),
      durationMs,
    };
    thread.messages.push(entry);
    if (thread.messages.length > MAX_THREAD_MESSAGES) thread.messages = thread.messages.slice(-MAX_THREAD_MESSAGES);
    thread.updatedAt = Date.now();
    await writeJson(s, key, thread);
    const idx = (await readJson(s, THREAD_INDEX_KEY)) || { updatedAt: 0, threads: {} };
    idx.threads[key] = {
      phone: thread.phone,
      name: thread.name || '',
      market: thread.market || '',
      preview: label,
      lastAt: entry.at,
      lastDir: dir,
      unread: thread.unread || 0,
    };
    idx.updatedAt = Date.now();
    await writeJson(s, THREAD_INDEX_KEY, idx);
    return true;
  } catch (e) {
    return false;
  }
}

// Pairing surface shared with telnyx-voice-webhook.js (same
// cross-require pattern as telnyx-webhook -> cc-bot-hook).
exports._thread = { loadPairings, savePairings, findByLeg, loadPending, savePending, clearPending, mergePending, logCallToThread, HL_DISPOSITIONS };

// The voice webhook rings the agent's browser for inbound calls, so it
// needs the same SIP URI derivation as the dialer start flow.
exports.agentSipUri = agentSipUri;
exports.voiceCredentialUris = voiceCredentialUris;

// Test hooks (not part of the deployed surface).
exports._test = {
  setStores(stores) {
    deps.dialerStoreFactory = stores && stores.dialer ? () => stores.dialer : null;
    deps.convStoreFactory = stores && stores.conversations ? () => stores.conversations : null;
  },
  setVoiceLib(v) {
    deps.voiceLib = v || null;
  },
  setTelnyxLib(l) {
    deps.telnyxLib = l || null;
  },
  reset() {
    deps.dialerStoreFactory = null;
    deps.convStoreFactory = null;
    deps.voiceLib = null;
    deps.telnyxLib = null;
  },
  agentSipUri,
  resolveAgentSipUri,
  isVoiceConfigured,
};

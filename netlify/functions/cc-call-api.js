// netlify/functions/cc-call-api.js
// Single-call placement from a Conversations thread: call ONE seller
// from the thread screen (not the triple-line dialer). The seller leg
// is placed via Telnyx Call Control with answering-machine detection;
// the agent leg rings the agent's registered WebRTC client (the same
// telephony credential cc-voice-token.js created) and
// telnyx-voice-webhook.js bridges the two legs once the seller is a
// confirmed human AND the agent has answered.
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
  if (pending.agentLeg && !rec.agentLeg) rec.agentLeg = pending.agentLeg;
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
    if (rec.agentLeg === callControlId) {
      return { callId, rec, role: 'agent' };
    }
  }
  return null;
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
      const sipUri = await agentSipUri(event);
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
        sellerLeg: sellerCallControlId,
        agentLeg: null,
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
        // of waiting for another event that may never come.
        if (rec.sellerHuman && rec.agentAnswered && rec.agentLeg) {
          try {
            await v.bridge(rec.sellerLeg, rec.agentLeg);
            rec.status = 'bridged';
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
      for (const legId of [rec.sellerLeg, rec.agentLeg]) {
        if (!legId) continue;
        try {
          await v.hangup(legId);
        } catch (e) { /* leg may already be gone */ }
      }
      rec.status = 'ended';
      rec.updatedAt = Date.now();
      await savePairings(pairings, event);
      return ok({ ok: true });
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

    return bad('Unknown action.');
  } catch (e) {
    return json(503, { error: 'Call storage is not ready yet', detail: String((e && e.message) || e) });
  }
};

// Pairing surface shared with telnyx-voice-webhook.js (same
// cross-require pattern as telnyx-webhook -> cc-bot-hook).
exports._thread = { loadPairings, savePairings, findByLeg, loadPending, savePending, clearPending, mergePending };

// The voice webhook rings the agent's browser for inbound calls, so it
// needs the same SIP URI derivation as the dialer start flow.
exports.agentSipUri = agentSipUri;

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
  isVoiceConfigured,
};

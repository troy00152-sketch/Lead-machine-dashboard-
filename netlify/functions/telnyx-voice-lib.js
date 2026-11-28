// netlify/functions/telnyx-voice-lib.js
// Shared Telnyx Voice (Call Control API v2) library for the standalone
// Command Center's triple-line dialer — see the Dialer section of
// ~/workspace/standalone-build/BUILD-PLAN.md.
//
// Voice runs on a Telnyx Call Control application (connection). Its id
// lives ONLY in the TELNYX_VOICE_APP_ID env var; the API key is the
// shared TELNYX_API_KEY (server-side Netlify env — never in code, never
// client-side).
//
// FAIL CLOSED: if TELNYX_API_KEY or TELNYX_VOICE_APP_ID is missing, or a
// market has no voice numbers yet, every call action throws a clear
// "not configured" error. Nothing ever fakes a call.
//
// Caller ID pools are the SAME per-market pools as messaging
// (telnyx-lib SENDER_POOLS): Telnyx numbers are voice + SMS on the same
// number, and the purchased sets (5/market, area codes 317/252/816/216/
// 904) will be voice-enabled. Until a pool has numbers, dials for that
// market throw — same fail-closed rule as SMS.
'use strict';

const lib = require('./telnyx-lib');

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

// ---- config (fail closed) ----
function voiceConfig() {
  const apiKey = process.env.TELNYX_API_KEY || '';
  const appId = process.env.TELNYX_VOICE_APP_ID || '';
  const missing = [];
  if (!apiKey) missing.push('TELNYX_API_KEY');
  if (!appId) missing.push('TELNYX_VOICE_APP_ID');
  return { apiKey, appId, missing, configured: missing.length === 0 };
}
function requireConfig() {
  const cfg = voiceConfig();
  if (!cfg.configured) {
    throw new Error(
      'Telnyx voice is not configured — missing env: ' + cfg.missing.join(', ') + '. Refusing to place a call.'
    );
  }
  return cfg;
}

// Where Telnyx should POST Call Control events. Optional env override;
// when unset we omit the param and the webhook URL configured on the
// Call Control application in the Telnyx portal is used.
function webhookUrl() {
  return process.env.TELNYX_VOICE_WEBHOOK_URL || '';
}

// ---- low-level API call ----
// apiCall(path, {method, body, fetchImpl, apiKey}) -> parsed Telnyx
// response `data` object. Throws with Telnyx's detail on !ok.
async function apiCall(pathname, opts) {
  const o = opts || {};
  const cfg = o.apiKey ? { apiKey: o.apiKey } : requireConfig();
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available.');
  const res = await fetchImpl(TELNYX_API_BASE + pathname, {
    method: o.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey,
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  let data = null;
  const text = typeof res.text === 'function' ? await res.text() : '';
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const detail =
      (data && data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].title)) ||
      'HTTP ' + res.status;
    throw new Error('Telnyx voice API failed (' + pathname + '): ' + detail);
  }
  return data && data.data !== undefined ? data.data : data;
}

// client_state carries our correlation ids through every Call Control
// webhook for the leg (Telnyx echoes it back base64-encoded).
function encodeClientState(obj) {
  return Buffer.from(JSON.stringify(obj || {}), 'utf8').toString('base64');
}
function decodeClientState(b64) {
  if (!b64) return {};
  try {
    return JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8')) || {};
  } catch (e) {
    return {};
  }
}

// ---- caller ID ----
// Same pools + round-robin as messaging (telnyx-lib.pickSender throws on
// an empty pool — fail closed until numbers are purchased).
function pickVoiceSender(market, poolOverride) {
  return lib.pickSender(market, poolOverride);
}

// ---- call actions ----
// createCall({to, from, market?, amd?, record?, clientState?, fetchImpl?,
//             apiKey?, appId?, timeoutSecs?}) -> {callControlId, callLegId,
//             callSessionId, raw}
// AMD: answering_machine_detection 'premium' (Nov 26, 2026 —
// Telnyx research: standard 'detect' classifies on greeting length /
// silence thresholds (~3.5s), so a live human who answers and waits
// silently is scored 'machine'; premium uses speech-recognition + ML
// and is materially more accurate. The verdict arrives as a
// call.machine.premium.detection.ended webhook ('human_residence' |
// 'human_business' | 'machine' | 'silence' | 'fax_detected' |
// 'not_sure'; 'not_sure' is treated as human per Telnyx). AMD is a
// PARALLEL label only — the bridge never waits on it (see
// telnyx-voice-webhook.js). timeout_secs 30: the seller's phone rings
// a full 30s before Telnyx times the leg out (GHL's floor is 20s).
// Recording starts at answer ('record-from-answer').
// timeoutSecs overrides the ring budget when a caller passes it (the
// inbound PSTN fallback leg uses 20 so a carrier voicemail that picks
// up late cannot swallow the seller).
async function createCall(opts) {
  const o = opts || {};
  const cfg = requireConfig();
  const appId = o.appId || cfg.appId;
  const to = lib.toE164(o.to);
  const from = o.from ? lib.toE164(o.from) : pickVoiceSender(o.market);
  const body = {
    connection_id: appId,
    to,
    from,
    answering_machine_detection: o.amd === false ? 'disabled' : 'premium',
    timeout_secs: typeof o.timeoutSecs === 'number' && o.timeoutSecs > 0 ? Math.floor(o.timeoutSecs) : 30,
    record: o.record === false ? undefined : 'record-from-answer',
    recording_channels: 'single',
    client_state: encodeClientState(o.clientState || {}),
  };
  const wu = webhookUrl();
  if (wu) body.webhook_url = wu;
  if (body.record === undefined) delete body.record;
  const data = await apiCall('/calls', { body, fetchImpl: o.fetchImpl, apiKey: o.apiKey });
  const d = data || {};
  return {
    callControlId: d.call_control_id || null,
    callLegId: d.call_leg_id || null,
    callSessionId: d.call_session_id || null,
    from,
    to,
    raw: d,
  };
}

// The agent leg: rings the agent's registered WebRTC client (TelnyxRTC
// SDK) at its SIP URI. When the agent answers, the webhook bridges it
// to the winning seller leg.
// timeoutSecs / commandId (Nov 26, 2026, inbound fix): an inbound agent
// leg rings 20s (the caller's ~20s patience budget, not Telnyx's 30s
// default) and carries a unique command_id per dial so a re-dial is a
// distinct leg Telnyx can correlate — never reuse a command_id across
// dials of the same call.
async function createAgentLeg(opts) {
  const o = opts || {};
  const cfg = requireConfig();
  if (!o.sipUri) throw new Error('Agent SIP URI is required to create the agent leg.');
  const from = o.from ? lib.toE164(o.from) : pickVoiceSender(o.market);
  const body = {
    connection_id: o.appId || cfg.appId,
    to: String(o.sipUri),
    from,
    client_state: encodeClientState(o.clientState || {}),
  };
  if (typeof o.timeoutSecs === 'number' && o.timeoutSecs > 0) body.timeout_secs = Math.floor(o.timeoutSecs);
  if (o.commandId) body.command_id = String(o.commandId);
  const wu = webhookUrl();
  if (wu) body.webhook_url = wu;
  const data = await apiCall('/calls', { body, fetchImpl: o.fetchImpl, apiKey: o.apiKey });
  const d = data || {};
  return {
    callControlId: d.call_control_id || null,
    callLegId: d.call_leg_id || null,
    callSessionId: d.call_session_id || null,
    from,
    to: String(o.sipUri),
    raw: d,
  };
}

// ---- Sam (ElevenLabs voice agent) ----
// Sam answers inbound seller calls on the five Carolina numbers
// (Nov 27, 2026). Same shape as createAgentLeg — a top-level
// POST /v2/calls to a SIP URI — but the destination is ElevenLabs'
// SIP trunk, the caller id is the SELLER (verified via `diversion`:
// Telnyx treats `from` as verified when an active inbound call
// matches to=diversion + from=from), and the leg carries digest-auth
// credentials for the ElevenLabs trunk (generated at import time,
// stored in Netlify env — never the Telnyx/ElevenLabs API keys).
//
// The leg is NOT bridged by the dial: on call.answered the webhook
// answers the inbound leg and bridges explicitly — Telnyx's own
// outbound-dialer flow (Dial -> answered -> Bridge command). The
// Nov 26 plan's "plain Dial auto-bridges" claim is wrong, verified
// against the Telnyx API reference (call-commands/dial) + the Node
// SDK types Nov 27: auto-bridging needs link_to + bridge_on_answer,
// and the Bridge command is the documented step after answer.
//
// Fail closed: SAM_SIP_AUTH_USER / SAM_SIP_AUTH_PASS must be set;
// without them the Dial would fail SIP auth and Sam would never
// answer, so refuse instead of dialing a dead leg.
// time_limit_secs 900 matches Sam's HighLevel maxCallDuration (15 min).
function samSipConfig() {
  const user = process.env.SAM_SIP_AUTH_USER || '';
  const pass = process.env.SAM_SIP_AUTH_PASS || '';
  const missing = [];
  if (!user) missing.push('SAM_SIP_AUTH_USER');
  if (!pass) missing.push('SAM_SIP_AUTH_PASS');
  return { user, pass, missing, configured: missing.length === 0 };
}
async function dialSamLeg(opts) {
  const o = opts || {};
  const cfg = requireConfig();
  const sam = samSipConfig();
  if (!sam.configured) {
    throw new Error(
      'Sam SIP auth is not configured — missing env: ' + sam.missing.join(', ') + '. Refusing to dial Sam.'
    );
  }
  if (!o.callControlId) throw new Error('callControlId (the inbound seller leg) is required to dial Sam.');
  if (!o.dialedNumber) throw new Error('dialedNumber (the 252 number the seller called) is required to dial Sam.');
  const dialed = lib.toE164(o.dialedNumber);
  const from = lib.toE164(o.from);
  const body = {
    connection_id: o.appId || cfg.appId,
    to: 'sip:' + dialed + '@sip.rtc.elevenlabs.io:5061;transport=tls;secure=srtp',
    from,
    diversion: dialed,
    custom_headers: [
      { name: 'X-Caller-ID', value: from },
      { name: 'X-Call-ID', value: String(o.callControlId) },
      { name: 'X-Dialed-Number', value: dialed },
    ],
    client_state: encodeClientState(o.clientState || {}),
    // Auto-bridge (Nov 28, 2026 — Halima retest): link the Sam leg
    // to the ringing inbound seller leg and let Telnyx bridge them
    // the moment Sam answers. The webhook event path (answer +
    // explicit Bridge in telnyx-voice-webhook.js) stays as the
    // backstop — it no-ops once the legs are bridged — but the
    // bridge no longer depends on a call.answered webhook landing,
    // a client_state echo, or a Blobs read landing in time. That
    // chain failed twice after the 12:40 PM re-merge deploy (Sam
    // greeted into the void at 1:12 PM, ASR 0.0s, no bridge).
    // bridge_intent is deliberately NOT set: it would overwrite
    // `from` with the linked call's number (same value here, but no
    // reason to take the side effect).
    link_to: String(o.callControlId),
    bridge_on_answer: true,
    sip_transport_protocol: 'TLS',
    media_encryption: 'SRTP',
    preferred_codecs: 'PCMU,PCMA',
    timeout_secs: 30,
    time_limit_secs: 900,
    sip_auth_username: sam.user,
    sip_auth_password: sam.pass,
  };
  if (o.commandId) body.command_id = String(o.commandId);
  const wu = webhookUrl();
  if (wu) body.webhook_url = wu;
  const data = await apiCall('/calls', { body, fetchImpl: o.fetchImpl, apiKey: o.apiKey });
  const d = data || {};
  return {
    callControlId: d.call_control_id || null,
    callLegId: d.call_leg_id || null,
    callSessionId: d.call_session_id || null,
    from,
    to: body.to,
    raw: d,
  };
}

function callAction(callControlId, action, body, opts) {
  if (!callControlId) throw new Error('callControlId is required for action ' + action);
  const o = opts || {};
  return apiCall('/calls/' + encodeURIComponent(callControlId) + '/actions/' + action, {
    body: body || {},
    fetchImpl: o.fetchImpl,
    apiKey: o.apiKey,
  });
}

async function hangup(callControlId, opts) {
  await callAction(callControlId, 'hangup', {}, opts);
  return { hungUp: true, callControlId };
}

// Answer an inbound leg (the caller dialed one of our numbers). The
// webhook answers the inbound leg once the agent leg has answered,
// then bridges the two.
async function answer(callControlId, opts) {
  await callAction(callControlId, 'answer', {}, opts);
  return { answered: true, callControlId };
}

// Bridge the winning seller leg to the answered agent leg. Per Telnyx,
// the bridge action is issued on ONE leg with the other leg's
// call_control_id in the body (REST field name — this lib uses raw
// fetch, NOT Telnyx's Node SDK, whose field is
// call_control_id_to_bridge_with; do not mix them up).
// opts.commandId (Nov 26, 2026, inbound sweep retry): a fresh id per
// retry — Telnyx silently ignores a command that re-uses a command_id
// for the same call_control_id, so a retry must never repeat one.
async function bridge(callControlId, otherCallControlId, opts) {
  if (!otherCallControlId) throw new Error('otherCallControlId is required to bridge.');
  const o = opts || {};
  const body = { call_control_id: otherCallControlId };
  if (o.commandId) body.command_id = String(o.commandId);
  await callAction(callControlId, 'bridge', body, o);
  return { bridged: true, callControlId, otherCallControlId };
}

async function startRecording(callControlId, opts) {
  const o = opts || {};
  await callAction(callControlId, 'record_start', { format: 'mp3', channels: 'single' }, o);
  return { recording: true, callControlId };
}

module.exports = {
  TELNYX_API_BASE,
  voiceConfig,
  requireConfig,
  webhookUrl,
  encodeClientState,
  decodeClientState,
  pickVoiceSender,
  createCall,
  createAgentLeg,
  dialSamLeg,
  samSipConfig,
  hangup,
  answer,
  bridge,
  startRecording,
};

// Test hooks (not part of the deployed surface).
module.exports._test = { apiCall };

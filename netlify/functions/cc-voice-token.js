// netlify/functions/cc-voice-token.js
// Issues the Telnyx WebRTC client token the dialer page (dialer.html)
// uses to register the agent's browser as a TelnyxRTC client — the leg
// answered seller calls bridge to.
//
// How it works: the browser agent is a Telnyx "telephony credential"
// bound to the Call Control application (TELNYX_VOICE_APP_ID). The
// credential is created ONCE via the API and cached in the 'cc-dialer'
// Blobs store ('voice-credential'); each request mints a short-lived
// JWT for it via POST /v2/telephony_credentials/{id}/token. The
// response carries {token, sipUri, username} — the SIP URI is what the
// voice webhook dials when a seller answers (session.agentSipUri).
//
// FAIL CLOSED: without TELNYX_API_KEY + TELNYX_VOICE_APP_ID this
// returns 503 {configured:false, missing:[...]} and the page shows its
// "voice not configured yet" state. No token is ever faked.
//
// lm_auth-gated, same HMAC as gate.ts / cc-dialer-api.js.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const voice = require('./telnyx-voice-lib');
const ccAuth = require('./cc-auth');

const DIALER_STORE = 'cc-dialer';
const CREDENTIAL_KEY = 'voice-credential';
const CREDENTIAL_NAME = 'cc-dialer-agent';
const SIP_DOMAIN = 'sip.telnyx.com';

// ---- injectable dependencies (tests) ----
const deps = { storeFactory: null, fetchImpl: null };
function dialerStore(event) {
  if (deps.storeFactory) return deps.storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(DIALER_STORE);
}
function fetchImpl() {
  return deps.fetchImpl || globalThis.fetch;
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

// ---- auth (same lm_auth HMAC as the other cc functions) ----
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

// ---- Telnyx credential + token ----
// Raw API helper for the credential endpoints: unlike Call Control
// actions, the token endpoint returns the JWT as a bare string in
// `data`, so this parses tolerantly instead of reusing the voice lib's
// apiCall (which expects an object payload shape).
async function telnyxApi(pathname, method, body, apiKey) {
  const f = fetchImpl();
  if (typeof f !== 'function') throw new Error('No fetch implementation available.');
  const res = await f(voice.TELNYX_API_BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = typeof res.text === 'function' ? await res.text() : '';
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const detail =
      (data && data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].title)) ||
      'HTTP ' + res.status;
    throw new Error('Telnyx credential API failed (' + pathname + '): ' + detail);
  }
  return data;
}

async function getOrCreateCredential(event, cfg) {
  const s = dialerStore(event);
  const cached = await readJson(s, CREDENTIAL_KEY);
  if (cached && cached.id && cached.username) return cached;
  const data = await telnyxApi(
    '/telephony_credentials',
    'POST',
    { connection_id: cfg.appId, name: CREDENTIAL_NAME },
    cfg.apiKey
  );
  const d = (data && data.data) || {};
  if (!d.id || !d.user_name && !d.username) {
    throw new Error('Telnyx did not return a usable telephony credential.');
  }
  const username = d.user_name || d.username;
  const cred = {
    id: d.id,
    username,
    sipUri: 'sip:' + username + '@' + SIP_DOMAIN,
    createdAt: Date.now(),
  };
  await writeJson(s, CREDENTIAL_KEY, cred);
  return cred;
}

async function mintToken(cred, cfg) {
  const data = await telnyxApi(
    '/telephony_credentials/' + encodeURIComponent(cred.id) + '/token',
    'POST',
    undefined,
    cfg.apiKey
  );
  // Telnyx returns the JWT as `data` (a string); tolerate a wrapped
  // {token} shape too.
  const token = typeof data === 'string' ? data : data && (data.data || data.token);
  if (!token || typeof token !== 'string') throw new Error('Telnyx did not return a WebRTC token.');
  return token;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    // Full login OR Irish's calling-only login (cc-auth) — the voice
    // token is one of the two functions her tier may reach.
    if (!isAdmin(event) && !ccAuth.isIrish(event)) {
      return json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
    }
    const cfg = voice.voiceConfig();
    if (!cfg.configured) {
      return json(503, {
        configured: false,
        missing: cfg.missing,
        error: 'Telnyx voice is not configured — missing env: ' + cfg.missing.join(', ') + '.',
      });
    }
    const cred = await getOrCreateCredential(event, cfg);
    const token = await mintToken(cred, cfg);
    return json(200, {
      configured: true,
      token,
      sipUri: cred.sipUri,
      username: cred.username,
    });
  } catch (e) {
    return json(503, { error: 'Could not issue a voice token', detail: String((e && e.message) || e) });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  setStoreFactory(fn) {
    deps.storeFactory = fn || null;
  },
  setFetch(fn) {
    deps.fetchImpl = fn || null;
  },
  reset() {
    deps.storeFactory = null;
    deps.fetchImpl = null;
  },
  getOrCreateCredential,
  mintToken,
};

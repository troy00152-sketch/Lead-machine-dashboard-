// netlify/functions/cc-voice-token.js
// Issues the Telnyx WebRTC client token the dialer page (dialer.html)
// uses to register the agent's browser as a TelnyxRTC client — the leg
// answered seller calls bridge to.
//
// How it works: the browser agent is a Telnyx "telephony credential"
// bound to a CREDENTIAL-BASED SIP CONNECTION (created once via
// POST /v2/credential_connections and cached in the 'cc-dialer' Blobs
// store as 'voice-sip-connection'). The credential itself is created
// ONCE per agent via the API and cached in the same store
// ('voice-credential' for the admin, 'voice-credential-irish' for
// Irish — one credential per agent/device; sharing one across
// concurrent devices makes the second registration overwrite the
// first). Each request mints a short-lived JWT for it via
// POST /v2/telephony_credentials/{id}/token. The response carries
// {token, sipUri, username} — the SIP URI is what the voice webhook
// dials when a seller answers (session.agentSipUri).
//
// NOTE (verified Nov 25): the telephony-credentials endpoint does NOT
// accept a Call Control Application id as connection_id — it 422s.
// connection_id MUST be a credential SIP connection id. The Call
// Control app id (TELNYX_VOICE_APP_ID) is only for Call Control dials
// (cc-call-api / cc-dialer-api), never for credentials. The SIP
// connection is created with sip_uri_calling_preference 'internal'
// so the webhook can dial the agent's sip: URI to bridge inbound
// calls to the registered browser client.
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
const CREDENTIAL_KEY_IRISH = 'voice-credential-irish';
const SIP_CONNECTION_KEY = 'voice-sip-connection';
// NOTE: this name MUST differ from the Call Control application
// 'Command Center Voice' — Telnyx requires unique connection names
// across the account, and the app already holds that name (the first
// deploy 422d with "The name you have chosen is already in use").
const SIP_CONNECTION_NAME = 'Command Center SIP';
const SIP_CONNECTION_USER_BASE = 'ccvoice';
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
// Raw API helper for the credential endpoints. Most return JSON, but
// the token endpoint (POST /telephony_credentials/{id}/token) returns
// the JWT as PLAIN TEXT — parsing that as JSON yields null, so callers
// pass raw=true for it and get the text back untouched.
async function telnyxApi(pathname, method, body, apiKey, raw) {
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
  if (raw) {
    if (!res.ok) {
      throw new Error(
        'Telnyx credential API failed (' + pathname + '): ' +
        (text ? 'HTTP ' + res.status + ' body: ' + text.slice(0, 200) : 'HTTP ' + res.status)
      );
    }
    return text;
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const detail =
      (data && data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].title)) ||
      (data && (data.message || data.error)) ||
      // Telnyx 422s sometimes carry no errors[] at all — keep the raw
      // body (truncated) so the next diagnostic shows what Telnyx said.
      (text ? 'HTTP ' + res.status + ' body: ' + text.slice(0, 200) : 'HTTP ' + res.status);
    throw new Error('Telnyx credential API failed (' + pathname + '): ' + detail);
  }
  return data;
}

// ---- SIP credential connection (the ONLY valid connection_id for
// telephony credentials) ----
// Telnyx telephony credentials bind to a credential-based SIP
// connection, NOT to a Call Control application — passing the app id
// 422s with no usable detail. Resolve the connection once and cache
// it in Blobs ('voice-sip-connection'): reuse a connection named
// 'Command Center Voice' if one already exists, else create it via
// POST /v2/credential_connections (same V2 API key). The connection
// password is generated server-side and stored with the record (it is
// never sent to the browser — the browser logs in with JWTs). After
// creation we PATCH sip_uri_calling_preference to 'internal': the
// default 'disabled' blocks SIP-URI calls, and the voice webhook
// bridges inbound calls by dialing the agent's sip: URI.
function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(32);
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[buf[i] % chars.length];
  return out;
}
function randomSuffix(n) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(n || 4);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += chars[buf[i] % chars.length];
  return out;
}
async function listSipConnections(apiKey) {
  try {
    const list = await telnyxApi('/credential_connections?page[number]=1&page[size]=100', 'GET', undefined, apiKey);
    return (list && list.data) || [];
  } catch (e) { return []; }
}
// Best-effort: allow the voice webhook to dial the agent's sip: URI
// (inbound bridging). The token flow works without it.
async function withInternalPreference(id, apiKey) {
  try {
    await telnyxApi(
      '/credential_connections/' + encodeURIComponent(id),
      'PATCH',
      { sip_uri_calling_preference: 'internal' },
      apiKey
    );
    return 'internal';
  } catch (e) {
    return 'unknown';
  }
}
async function getOrCreateSipConnection(event, cfg) {
  const s = dialerStore(event);
  const envId = (process.env.TELNYX_SIP_CONNECTION_ID || '').trim();
  if (envId) return { id: envId, user_name: SIP_CONNECTION_USER_BASE, fromEnv: true };
  const cached = await readJson(s, SIP_CONNECTION_KEY);
  if (cached && cached.id) return cached;
  // Reuse a connection we already made (current name, or the original
  // 'Command Center Voice' name from the first attempt) if one exists.
  const matchName = (c) =>
    c && (c.connection_name === SIP_CONNECTION_NAME || c.connection_name === 'Command Center Voice');
  const existing = (await listSipConnections(cfg.apiKey)).find(matchName);
  if (existing && existing.id) {
    const rec = {
      id: String(existing.id),
      user_name: existing.user_name || SIP_CONNECTION_USER_BASE,
      createdAt: Date.now(),
      sipUriCallingPreference: await withInternalPreference(String(existing.id), cfg.apiKey),
    };
    await writeJson(s, SIP_CONNECTION_KEY, rec);
    return rec;
  }
  // Create under a name that cannot collide with the Call Control app.
  // If Telnyx still reports the name in use, re-list once (it may have
  // appeared) and retry under a suffixed name; the SIP username is
  // freshly suffixed on every attempt so it can never collide either.
  const names = [SIP_CONNECTION_NAME, SIP_CONNECTION_NAME + ' 2'];
  let lastErr = null;
  for (const name of names) {
    try {
      const created = await telnyxApi(
        '/credential_connections',
        'POST',
        { connection_name: name, user_name: SIP_CONNECTION_USER_BASE + randomSuffix(4), password: randomPassword() },
        cfg.apiKey
      );
      const d = (created && created.data) || {};
      if (!d.id) throw new Error('Telnyx did not return a credential connection id.');
      const rec = {
        id: String(d.id),
        user_name: d.user_name || SIP_CONNECTION_USER_BASE,
        connectionName: name,
        createdAt: Date.now(),
        sipUriCallingPreference: await withInternalPreference(String(d.id), cfg.apiKey),
      };
      await writeJson(s, SIP_CONNECTION_KEY, rec);
      return rec;
    } catch (e) {
      lastErr = e;
      if (!/already in use/i.test(String((e && e.message) || e))) throw e;
      const again = (await listSipConnections(cfg.apiKey)).find(matchName);
      if (again && again.id) {
        const rec = {
          id: String(again.id),
          user_name: again.user_name || SIP_CONNECTION_USER_BASE,
          createdAt: Date.now(),
          sipUriCallingPreference: await withInternalPreference(String(again.id), cfg.apiKey),
        };
        await writeJson(s, SIP_CONNECTION_KEY, rec);
        return rec;
      }
      // otherwise fall through to the next candidate name
    }
  }
  throw lastErr || new Error('Could not create a Telnyx credential connection.');
}

async function getOrCreateCredential(event, cfg, who) {
  const s = dialerStore(event);
  const key = who === 'irish' ? CREDENTIAL_KEY_IRISH : CREDENTIAL_KEY;
  const name = who === 'irish' ? CREDENTIAL_NAME + '-irish' : CREDENTIAL_NAME;
  const sipConn = await getOrCreateSipConnection(event, cfg);
  const cached = await readJson(s, key);
  // A cached credential is only reusable when it belongs to the same
  // SIP connection (an old record made against the Call Control app
  // id can never have worked — discard it).
  if (cached && cached.id && cached.username && cached.connectionId === sipConn.id) return cached;
  const data = await telnyxApi(
    '/telephony_credentials',
    'POST',
    { connection_id: sipConn.id, name },
    cfg.apiKey
  );
  const d = (data && data.data) || {};
  // Telnyx returns the SIP identity as `sip_username` (e.g.
  // "gencred…") — NOT `user_name`. The old guard checked the wrong
  // field names and threw on every successful create. (Never dump the
  // raw response into an error: it carries sip_password.)
  const username = d.sip_username || d.user_name || d.username;
  if (!d.id || !username) {
    throw new Error('Telnyx did not return a usable telephony credential.');
  }
  const cred = {
    id: d.id,
    username,
    connectionId: sipConn.id,
    sipUri: 'sip:' + username + '@' + SIP_DOMAIN,
    createdAt: Date.now(),
  };
  await writeJson(s, key, cred);
  return cred;
}

async function mintToken(cred, cfg) {
  // The token endpoint returns the JWT as PLAIN TEXT, not JSON — the
  // old code JSON-parsed it, got null, and threw on every mint. Fetch
  // it raw and validate the shape (three base64url segments) so a
  // stray HTML/error page never reaches the SDK as a token.
  const text = await telnyxApi(
    '/telephony_credentials/' + encodeURIComponent(cred.id) + '/token',
    'POST',
    undefined,
    cfg.apiKey,
    true
  );
  const token = typeof text === 'string' ? text.trim() : '';
  if (!token || token.split('.').length !== 3) throw new Error('Telnyx did not return a WebRTC token.');
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
    // One telephony credential per agent: the admin and Irish must not
    // share one (a second registration overwrites the first).
    const who = isAdmin(event) ? 'admin' : 'irish';
    const cred = await getOrCreateCredential(event, cfg, who);
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

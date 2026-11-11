// netlify/functions/gmail-token.js
// Shared Gmail OAuth refresh-token logic for the dashboard.
// Used by BOTH title-order-email.js (the send path — exchanges the stored
// refresh token for a short-lived access token on every send) and
// gmail-token-watch.js (the daily watcher — same exchange, token discarded).
// One module so the two can never drift apart.
//
// Key facts (verified against Google's published behaviour, Nov 11 2026):
//   * The GCP project "Direct Property Buyers Gmail" is in Testing mode and
//     requests gmail.send (beyond basic profile scopes). Google expires
//     refresh tokens from Testing-mode apps after exactly 7 DAYS.
//     The token first verified working Nov 7, 2026 ~11:34 PM therefore dies
//     ~Nov 14, 2026. No code can renew it once it dies — a human must
//     re-authorize (see ~/workspace/playbook-system/reliability/
//     gmail-token-runbook.md). The permanent fix is publishing the OAuth
//     consent screen to Production in the Google Cloud console, then
//     re-authorizing once; Production tokens live until revoked (or 6
//     months unused, or a password change, or the 100-token per-user limit).
//   * A refresh token that is merely EXPIRED/REVOKED comes back from the
//     token endpoint as HTTP 400 { error: "invalid_grant" }. That is the
//     signal for "re-authorize", and it is distinct from a transient
//     Google outage (5xx / 429) or bad client credentials (invalid_client).
//
// Secrets: this module NEVER logs, returns, or stores any credential value.
// Client id / secret / refresh token arrive as arguments from Netlify env
// vars at runtime (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
// GMAIL_REFRESH_TOKEN). They are never in code, files, logs, or chat.
// Test hooks: pass postJsonImpl to inject a mock token endpoint — the
// regression suite does exactly that and never calls Google live.
'use strict';

const https = require('https');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

// Thresholds for the watcher / health status (days of refresh-token life left).
const TESTING_MODE_REFRESH_TTL_DAYS = 7;
const WARN_DAYS = 3; // <= 3 days left: warn Troy now, re-auth is a human step.
const CRITICAL_DAYS = 1; // <= 1 day left: critical — re-auth today or sends stop.

// ---- minimal https POST (built-ins only, same shape as title-order-email) ----
function defaultPostJson(urlStr, { headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.length > 1_000_000) req.destroy(new Error('Response too large'));
        });
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    req.write(body);
    req.end();
  });
}

// Classify a failed token exchange. Returns { code, reconnect, message }.
// `reconnect` is true ONLY when a human re-authorization can fix it.
// The upstream body is NEVER surfaced: it can carry token error detail.
function classifyRefreshFailure(status, bodyText) {
  let err = '';
  try {
    const parsed = JSON.parse(String(bodyText || ''));
    err = String((parsed && parsed.error) || '');
  } catch (e) {
    err = '';
  }
  if (status === 400 && err === 'invalid_grant') {
    return {
      code: 'invalid_grant',
      reconnect: true,
      message:
        'Gmail authorization failed (refresh token rejected). Reconnect Google to restore sending.',
    };
  }
  if (status === 400 && err === 'invalid_client') {
    return {
      code: 'invalid_client',
      reconnect: true,
      message:
        'Gmail authorization failed (client credentials rejected). Check GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in Netlify, then reconnect Google.',
    };
  }
  if (status === 400 && err === 'invalid_request') {
    return {
      code: 'invalid_request',
      reconnect: true,
      message:
        'Gmail authorization failed (bad token request). Reconnect Google to restore sending.',
    };
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return {
      code: 'upstream_unavailable',
      reconnect: false,
      message: 'Gmail authorization failed (Google is unavailable — try again).',
    };
  }
  if (status !== 200) {
    return {
      code: 'token_exchange_failed',
      reconnect: false,
      message: `Gmail authorization failed (HTTP ${status}). Nothing was sent.`,
    };
  }
  return {
    code: 'unexpected_response',
    reconnect: false,
    message: 'Gmail authorization failed (unexpected token response).',
  };
}

// Exchange the stored refresh token for a short-lived access token.
// Returns the access token string. Throws an Error with .code and
// .reconnect (see classifyRefreshFailure). Returns null when any of the
// three credentials is missing — the caller maps null to "not connected"
// (503), it is NOT an error and must not throw.
// The returned access token is good for ~1 hour (expires_in 3599). The
// caller uses it once and discards it; nothing is persisted.
async function refreshAccessToken({ clientId, clientSecret, refreshToken, postJsonImpl }) {
  if (!clientId || !clientSecret || !refreshToken) return null;
  const post = postJsonImpl || defaultPostJson;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();
  let res;
  try {
    res = await post(TOKEN_URL, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
  } catch (e) {
    const err = new Error('Gmail authorization failed (could not reach Google).');
    err.code = 'network';
    err.reconnect = false;
    throw err;
  }
  if (res.status !== 200) {
    const c = classifyRefreshFailure(res.status, res.text);
    const err = new Error(c.message);
    err.code = c.code;
    err.reconnect = c.reconnect;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    const err = new Error('Gmail authorization failed (unexpected token response).');
    err.code = 'unexpected_response';
    err.reconnect = false;
    throw err;
  }
  if (!parsed.access_token) {
    const err = new Error('Gmail authorization failed (no access token returned).');
    err.code = 'no_access_token';
    err.reconnect = false;
    throw err;
  }
  return parsed.access_token;
}

// Exchange a one-time authorization code for tokens (human re-auth only —
// gmail-reauth.js; NEVER run by an agent, never automated). Returns
// { accessToken, refreshToken, expiresIn } — refreshToken may be null when
// Google returns only an access token (happens if the user already granted
// this client before without prompt=consent; re-run with prompt=consent).
async function exchangeAuthCode({ clientId, clientSecret, code, redirectUri, postJsonImpl }) {
  if (!clientId || !clientSecret || !code || !redirectUri) {
    throw new Error('exchangeAuthCode needs clientId, clientSecret, code and redirectUri.');
  }
  const post = postJsonImpl || defaultPostJson;
  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }).toString();
  let res;
  try {
    res = await post(TOKEN_URL, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
  } catch (e) {
    const err = new Error('Gmail authorization failed (could not reach Google).');
    err.code = 'network';
    err.reconnect = false;
    throw err;
  }
  if (res.status !== 200) {
    const c = classifyRefreshFailure(res.status, res.text);
    const err = new Error(c.message);
    err.code = c.code;
    err.reconnect = c.reconnect;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    const err = new Error('Gmail authorization failed (unexpected token response).');
    err.code = 'unexpected_response';
    err.reconnect = false;
    throw err;
  }
  if (!parsed.access_token) {
    const err = new Error('Gmail authorization failed (no access token returned).');
    err.code = 'no_access_token';
    err.reconnect = false;
    throw err;
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || null,
    expiresIn: parsed.expires_in || null,
  };
}

// Whole days (fractional, 1 decimal) until the refresh token expires.
// Returns null when no expiry date is recorded — the watcher then reports
// 'expiry_unknown' instead of guessing.
function daysUntilExpiry(expiresAtIso, nowMs) {
  if (!expiresAtIso) return null;
  const exp = Date.parse(String(expiresAtIso));
  if (!Number.isFinite(exp)) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.round(((exp - now) / 86400000) * 10) / 10;
}

// Overall token health from the two facts the watcher can know:
// whether a dry-run refresh just succeeded, and the recorded expiry date.
// Status precedence (first match wins):
//   not_connected  — any credential env var missing (nothing configured)
//   refresh_failed — dry-run exchange failed (action depends on .reconnect)
//   ok (production) — mode === 'production': the consent screen is
//     published, so there is NO fixed expiry to warn about. A recorded
//     date, if any, is ignored (it predates the publish). Tokens still
//     end on revoke / 6 months unused / password change — the daily
//     dry-run refresh is what catches those.
//   expired        — expiry date is past
//   critical       — <= 1 day left
//   warn           — <= 3 days left
//   expiry_unknown — refresh works but no expiry date recorded (warn-level:
//                    a Testing-mode token could be silently near death)
//   ok             — refresh works and > 3 days left
// `action` is always a plain-English next step for Troy / the runbook.
function tokenHealthStatus({ expiresAtIso, refreshOk, refreshError, nowMs, mode }) {
  const days = daysUntilExpiry(expiresAtIso, nowMs);
  if (refreshOk === false && refreshError && refreshError.code === 'not_connected') {
    return {
      status: 'not_connected',
      daysUntilExpiry: days,
      action:
        'Gmail is not connected: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN in Netlify, then re-authorize Google (runbook: gmail-token-runbook.md).',
    };
  }
  if (refreshOk === false) {
    const reconnect = !!(refreshError && refreshError.reconnect);
    return {
      status: 'refresh_failed',
      daysUntilExpiry: days,
      action: reconnect
        ? 'The Gmail refresh token was rejected (expired or revoked). Re-authorize Google and paste the new GMAIL_REFRESH_TOKEN into Netlify (runbook: gmail-token-runbook.md). Title-order sends are 503 until then — nothing is sent.'
        : 'Google refused the token exchange for a transient reason. No re-authorization needed yet — the watcher retries tomorrow; if it repeats, check Netlify env vars and Google Cloud status.',
    };
  }
  if (mode === 'production') {
    return {
      status: 'ok',
      daysUntilExpiry: null,
      action:
        'Production mode: refresh tokens do not expire on a fixed schedule (revoke, 6 months unused, or a password change ends them). The daily dry-run refresh is the tripwire — no action needed.',
    };
  }
  if (days !== null && days <= 0) {
    return {
      status: 'expired',
      daysUntilExpiry: days,
      action:
        'The Gmail refresh token is past its recorded expiry date. Re-authorize Google and paste the new GMAIL_REFRESH_TOKEN into Netlify (runbook: gmail-token-runbook.md).',
    };
  }
  if (days !== null && days <= CRITICAL_DAYS) {
    return {
      status: 'critical',
      daysUntilExpiry: days,
      action: `Only ${days} day(s) of Gmail refresh-token life left. Re-authorize Google today and paste the new GMAIL_REFRESH_TOKEN into Netlify, or title-order sends stop working (runbook: gmail-token-runbook.md).`,
    };
  }
  if (days !== null && days <= WARN_DAYS) {
    return {
      status: 'warn',
      daysUntilExpiry: days,
      action: `Gmail refresh token expires in ${days} day(s). Re-authorize Google and paste the new GMAIL_REFRESH_TOKEN into Netlify before it lapses (runbook: gmail-token-runbook.md).`,
    };
  }
  if (days === null) {
    return {
      status: 'expiry_unknown',
      daysUntilExpiry: null,
      action:
        'The Gmail refresh works, but no expiry date is recorded (set GMAIL_REFRESH_TOKEN_EXPIRES_AT in Netlify at re-auth). A Testing-mode token dies after 7 days with no warning — record the date so the watcher can warn.',
    };
  }
  return {
    status: 'ok',
    daysUntilExpiry: days,
    action: 'No action needed. The Gmail refresh token works and has more than 3 days of life left.',
  };
}

module.exports = {
  TOKEN_URL,
  GMAIL_SEND_SCOPE,
  TESTING_MODE_REFRESH_TTL_DAYS,
  WARN_DAYS,
  CRITICAL_DAYS,
  defaultPostJson,
  classifyRefreshFailure,
  refreshAccessToken,
  exchangeAuthCode,
  daysUntilExpiry,
  tokenHealthStatus,
};

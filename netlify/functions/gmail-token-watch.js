// netlify/functions/gmail-token-watch.js
// DAILY WATCHER for the Gmail refresh token that powers the one-click
// title-order send (title-order-email.js).
//
// SCHEDULED FUNCTION — it runs on the cron in netlify.toml
// ([functions."gmail-token-watch"] schedule = "0 14 * * *", daily 14:00 UTC
// = 09:00 EST / 10:00 EDT). Scheduled functions run ONLY on the published
// production deploy, have a 30-second limit, and CANNOT be invoked by URL
// (Netlify returns 404) — so there is no public trigger to guard. Manual
// runs happen from the Netlify UI: Functions > gmail-token-watch > Run now.
// A run takes one HTTPS POST to Google (well inside 30s).
//
// What one run does:
//   1. Reads GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
//      (and the optional GMAIL_REFRESH_TOKEN_EXPIRES_AT, an ISO date Troy
//      sets in Netlify at each re-authorization) from env vars.
//   2. DRY-RUN refresh: exchanges the refresh token for an access token
//      and DISCARDS it. No email is ever sent from here, and no token value
//      is logged, returned, or stored.
//   3. Combines the dry-run result with the recorded expiry date into a
//      status (./gmail-token.js tokenHealthStatus): ok | warn | critical |
//      expired | refresh_failed | not_connected | expiry_unknown.
//   4. Writes the status to the Netlify Blobs store 'reliability', key
//      'gmail-watch/status.json', so health-check.js (and the local
//      health-check script) can report it. A blob failure never fails the
//      run — the status is still logged and returned.
//   5. Logs ONE line: `gmail-token-watch status=<status> daysLeft=<n>
//      refreshOk=<bool>` — no credential material, ever.
//
// FAIL-CLOSED: missing env vars -> status 'not_connected'; a rejected
// refresh token (HTTP 400 invalid_grant = expired/revoked) -> status
// 'refresh_failed' with a re-authorize action. The watcher NEVER claims
// Gmail is fine when it is not, and it never sends anything.
// Alerting: this function writes the status; the alert is the status
// itself — health-check.js surfaces it on the dashboard status endpoint,
// and the local gmail-token-watch-local.js script (cron) reads the same
// state and exits non-zero on warn/critical so the cron run flags it.
// There is no email/SMS alert from here on purpose: the thing that would
// send the alert (Gmail) is the thing being watched.
//
// Env vars (all set by Troy in the Netlify UI — never in code):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (required)
//   GMAIL_REFRESH_TOKEN_EXPIRES_AT (optional ISO date, e.g.
//   2026-11-14T23:34:00-05:00 — set at every re-auth; without it the
//   watcher can only report 'expiry_unknown')
//   GMAIL_REFRESH_TOKEN_MODE (optional: 'production' once the OAuth
//   consent screen is published — then there is no fixed expiry and the
//   watcher reports ok on a working refresh; unset = Testing mode)
'use strict';

const { refreshAccessToken, tokenHealthStatus } = require('./gmail-token.js');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null; // local / test env without node_modules: blob write skipped
}

const STORE_NAME = 'reliability';
const STATUS_KEY = 'gmail-watch/status.json';

function readEnv() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    expiresAt: process.env.GMAIL_REFRESH_TOKEN_EXPIRES_AT || '',
    // 'production' once the OAuth consent screen is published (see the
    // runbook). In that mode there is no fixed expiry date to warn about
    // and the watcher reports ok on a working refresh. Anything else
    // (including unset) is treated as Testing mode.
    mode: (process.env.GMAIL_REFRESH_TOKEN_MODE || '').toLowerCase().trim(),
  };
}

async function storeStatus(statusObj) {
  if (!blobs) return false;
  try {
    const store = blobs.getStore(STORE_NAME);
    await store.setJSON(STATUS_KEY, statusObj);
    return true;
  } catch (e) {
    return false;
  }
}

// Pure core, exported for the fixture regression suite: given env + a
// refresh result, build the status object. No I/O here.
function buildStatus({ env, refreshOk, refreshError, checkedAt, nowMs }) {
  const health = tokenHealthStatus({
    expiresAtIso: env.expiresAt || null,
    refreshOk,
    refreshError: refreshError || null,
    nowMs,
    mode: env.mode || undefined,
  });
  return {
    check: 'gmail-token-watch',
    status: health.status,
    daysUntilExpiry: health.daysUntilExpiry,
    mode: env.mode || 'testing',
    refreshOk: !!refreshOk,
    refreshErrorCode: refreshError ? refreshError.code || null : null,
    expiresAt: env.expiresAt || null,
    action: health.action,
    checkedAt: checkedAt || new Date(nowMs || Date.now()).toISOString(),
  };
}

exports.handler = async (event) => {
  const nowMs = Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const env = readEnv();
  let refreshOk = false;
  let refreshError = null;

  if (!env.clientId || !env.clientSecret || !env.refreshToken) {
    refreshError = { code: 'not_connected', reconnect: true };
  } else {
    try {
      // Dry run only: the access token is discarded, never stored/sent.
      await refreshAccessToken({
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        refreshToken: env.refreshToken,
      });
      refreshOk = true;
    } catch (e) {
      refreshOk = false;
      refreshError = { code: (e && e.code) || 'token_exchange_failed', reconnect: !!(e && e.reconnect) };
    }
  }

  const statusObj = buildStatus({ env, refreshOk, refreshError, checkedAt, nowMs });
  const blobStored = await storeStatus(statusObj);

  // One log line, no credential material.
  console.log(
    `gmail-token-watch status=${statusObj.status} daysLeft=${statusObj.daysUntilExpiry} refreshOk=${statusObj.refreshOk} blobStored=${blobStored}`,
  );

  // Scheduled invocations ignore the body, but a manual Run-now in the
  // Netlify UI shows the log; the status code still says whether Gmail
  // is usable (200) or needs a human (503).
  const httpStatus = statusObj.status === 'ok' ? 200 : 503;
  return {
    statusCode: httpStatus,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...statusObj, blobStored }),
  };
};

exports._test = { buildStatus, readEnv };

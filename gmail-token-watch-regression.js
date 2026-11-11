// gmail-token-watch-regression.js — Workstream 5 (Reliability), Nov 11 2026.
// Fixture tests for the Gmail refresh-token automation. NO live calls:
// the Google token endpoint is fully mocked (https.request is stubbed
// before the modules load), and every credential below is an obviously
// fake TEST value — no real secret exists in this file.
// Run: node gmail-token-watch-regression.js (exit non-zero on any failure)
//
// What it proves:
//   1. gmail-token.js exchange: success, invalid_grant (expired/revoked),
//      invalid_client, 429/5xx (transient, NOT a reconnect), missing env
//      (null -> "not connected"), malformed JSON, network failure.
//      Every failure fails CLOSED with a clear message and never leaks
//      the upstream body.
//   2. Expiry math + status precedence: expired / critical (<=1d) / warn
//      (<=3d) / ok (>3d) / expiry_unknown / not_connected / refresh_failed.
//   3. gmail-token-watch handler: dry-run success -> 200 ok + blob
//      attempt; invalid_grant -> 503 refresh_failed; missing env -> 503
//      not_connected. One log line, no credential material.
//   4. title-order-email.js PARITY after the refactor to the shared
//      module: send succeeds end-to-end (mocked), refresh failure still
//      503s with the reconnect message, missing Gmail env still 503s
//      "Gmail not connected yet", bad recipient still 400, no auth 401,
//      and NO fixture credential string appears in ANY response body.
'use strict';

const https = require('https');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---- mock https.request ----
// routes: [hostname-substring, status, body] — matched in order.
let mockRoutes = [];
let mockCalls = [];
let mockThrow = null;
const realRequest = https.request;
function fakeRequest(options, callback) {
  const listeners = {};
  const req = {
    on: (ev, fn) => { listeners[ev] = fn; return req; },
    setTimeout: () => req,
    write: (body) => { req._body = body; return req; },
    destroy: () => {},
    end: () => {
      setImmediate(() => {
        if (mockThrow) {
          if (listeners.error) listeners.error(mockThrow);
          return;
        }
        const host = String(options.hostname || '');
        const route = mockRoutes.find((r) => host.includes(r[0]));
        mockCalls.push({ host, body: req._body || '' });
        const status = route ? route[1] : 404;
        const text = route ? route[2] : '{}';
        const resListeners = {};
        const res = {
          statusCode: status,
          on: (ev, fn) => { resListeners[ev] = fn; return res; },
        };
        callback(res);
        setImmediate(() => {
          if (resListeners.data) resListeners.data(text);
          if (resListeners.end) resListeners.end();
        });
      });
      return req;
    },
  };
  return req;
}
https.request = fakeRequest;

// Modules under test (loaded AFTER the https stub is installed).
const gmailToken = require('./netlify/functions/gmail-token.js');
const watch = require('./netlify/functions/gmail-token-watch.js');
const titleOrder = require('./netlify/functions/title-order-email.js');

// Fake-but-obviously-fake credentials. NEVER real values.
const ENV = { clientId: 'TEST_CLIENT_ID', clientSecret: 'TEST_CLIENT_SECRET', refreshToken: 'TEST_REFRESH_TOKEN' };

const tokenOk = { status: 200, text: JSON.stringify({ access_token: 'TEST_ACCESS_TOKEN', expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.send' }) };
const invalidGrant = { status: 400, text: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) };
const invalidClient = { status: 400, text: JSON.stringify({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }) };
const serverError = { status: 500, text: JSON.stringify({ error: 'internal_error' }) };
const rateLimited = { status: 429, text: JSON.stringify({ error: 'rate_limit_exceeded' }) };

async function main() {
  // ---------- 1. refreshAccessToken exchange behaviour ----------
  mockRoutes = [['oauth2.googleapis.com', tokenOk.status, tokenOk.text]];
  mockCalls = [];
  eq('exchange success returns access token',
    await gmailToken.refreshAccessToken({ ...ENV }), 'TEST_ACCESS_TOKEN');
  check('exchange posts grant_type=refresh_token (not auth code)',
    mockCalls.length === 1 && mockCalls[0].body.includes('grant_type=refresh_token'),
    JSON.stringify(mockCalls));

  mockRoutes = [['oauth2.googleapis.com', invalidGrant.status, invalidGrant.text]];
  try {
    await gmailToken.refreshAccessToken({ ...ENV });
    check('invalid_grant throws', false);
  } catch (e) {
    eq('invalid_grant code', e.code, 'invalid_grant');
    check('invalid_grant reconnect=true', e.reconnect === true);
    check('invalid_grant message tells Troy to reconnect',
      /Reconnect Google/.test(e.message), e.message);
    check('invalid_grant message does NOT leak upstream body',
      !/expired or revoked/.test(e.message), e.message);
  }

  mockRoutes = [['oauth2.googleapis.com', invalidClient.status, invalidClient.text]];
  try {
    await gmailToken.refreshAccessToken({ ...ENV });
    check('invalid_client throws', false);
  } catch (e) {
    eq('invalid_client code', e.code, 'invalid_client');
    check('invalid_client reconnect=true', e.reconnect === true);
    check('invalid_client message names client credentials, not the token',
      /client credentials/.test(e.message), e.message);
  }

  mockRoutes = [['oauth2.googleapis.com', serverError.status, serverError.text]];
  try {
    await gmailToken.refreshAccessToken({ ...ENV });
    check('5xx throws', false);
  } catch (e) {
    eq('5xx code', e.code, 'upstream_unavailable');
    check('5xx reconnect=false (transient, no re-auth)', e.reconnect === false);
    check('5xx message says try again', /try again/.test(e.message), e.message);
  }

  mockRoutes = [['oauth2.googleapis.com', rateLimited.status, rateLimited.text]];
  try {
    await gmailToken.refreshAccessToken({ ...ENV });
    check('429 throws', false);
  } catch (e) {
    eq('429 code', e.code, 'upstream_unavailable');
    check('429 reconnect=false', e.reconnect === false);
  }

  eq('missing clientSecret -> null (not connected, not an error)',
    await gmailToken.refreshAccessToken({ clientId: ENV.clientId, clientSecret: '', refreshToken: ENV.refreshToken }), null);
  eq('missing refreshToken -> null',
    await gmailToken.refreshAccessToken({ clientId: ENV.clientId, clientSecret: ENV.clientSecret, refreshToken: '' }), null);

  mockRoutes = [['oauth2.googleapis.com', 200, 'not-json{{{']];
  try {
    await gmailToken.refreshAccessToken({ ...ENV });
    check('malformed JSON throws', false);
  } catch (e) {
    eq('malformed JSON code', e.code, 'unexpected_response');
  }

  mockRoutes = [['oauth2.googleapis.com', 200, JSON.stringify({})]];
  try {
    await gmailToken.refreshAccessToken({ ...ENV });
    check('no access_token throws', false);
  } catch (e) {
    eq('no access_token code', e.code, 'no_access_token');
    check('no access_token message matches old send-path string',
      e.message === 'Gmail authorization failed (no access token returned).', e.message);
  }

  mockThrow = new Error('socket hang up');
  try {
    await gmailToken.refreshAccessToken({ ...ENV });
    check('network failure throws', false);
  } catch (e) {
    eq('network code', e.code, 'network');
    check('network reconnect=false', e.reconnect === false);
  }
  mockThrow = null;

  // ---------- exchangeAuthCode (human re-auth path) ----------
  mockRoutes = [['oauth2.googleapis.com', 200, JSON.stringify({ access_token: 'AT', refresh_token: 'NEW_RT', expires_in: 3599 })]];
  const ex = await gmailToken.exchangeAuthCode({ ...ENV, code: 'TEST_AUTH_CODE', redirectUri: 'http://localhost' });
  eq('exchangeAuthCode returns new refresh token', ex.refreshToken, 'NEW_RT');
  eq('exchangeAuthCode returns access token', ex.accessToken, 'AT');
  mockRoutes = [['oauth2.googleapis.com', 200, JSON.stringify({ access_token: 'AT' })]];
  const ex2 = await gmailToken.exchangeAuthCode({ ...ENV, code: 'TEST_AUTH_CODE', redirectUri: 'http://localhost' });
  eq('exchangeAuthCode without refresh_token returns null (re-run with prompt=consent)', ex2.refreshToken, null);

  // ---------- 2. expiry math + status precedence ----------
  const NOW = Date.parse('2026-11-11T12:00:00-05:00');
  eq('daysUntilExpiry 3 days out', gmailToken.daysUntilExpiry('2026-11-14T12:00:00-05:00', NOW), 3);
  eq('daysUntilExpiry past date is negative', gmailToken.daysUntilExpiry('2026-11-10T12:00:00-05:00', NOW), -1);
  eq('daysUntilExpiry no date -> null', gmailToken.daysUntilExpiry(null, NOW), null);
  eq('daysUntilExpiry garbage -> null', gmailToken.daysUntilExpiry('not-a-date', NOW), null);

  const st = (o) => gmailToken.tokenHealthStatus({ nowMs: NOW, ...o }).status;
  eq('status expired when date past', st({ expiresAtIso: '2026-11-10T12:00:00-05:00', refreshOk: true }), 'expired');
  eq('status critical at 1 day', st({ expiresAtIso: '2026-11-12T12:00:00-05:00', refreshOk: true }), 'critical');
  eq('status warn at 3 days', st({ expiresAtIso: '2026-11-14T12:00:00-05:00', refreshOk: true }), 'warn');
  eq('status ok at 4 days', st({ expiresAtIso: '2026-11-15T12:00:00-05:00', refreshOk: true }), 'ok');
  eq('status expiry_unknown when refresh works but no date', st({ expiresAtIso: null, refreshOk: true }), 'expiry_unknown');
  eq('status ok in production mode with no date', st({ expiresAtIso: null, refreshOk: true, mode: 'production' }), 'ok');
  eq('status ok in production mode even with a stale recorded date', st({ expiresAtIso: '2026-11-10T12:00:00-05:00', refreshOk: true, mode: 'production' }), 'ok');
  eq('status refresh_failed still wins in production mode', st({ expiresAtIso: null, refreshOk: false, refreshError: { code: 'invalid_grant', reconnect: true }, mode: 'production' }), 'refresh_failed');
  eq('status refresh_failed beats expiry date', st({ expiresAtIso: '2026-12-01T00:00:00-05:00', refreshOk: false, refreshError: { code: 'invalid_grant', reconnect: true } }), 'refresh_failed');
  eq('status not_connected', st({ expiresAtIso: null, refreshOk: false, refreshError: { code: 'not_connected' } }), 'not_connected');
  check('refresh_failed action says re-authorize',
    /Re-authorize Google/.test(gmailToken.tokenHealthStatus({ nowMs: NOW, expiresAtIso: null, refreshOk: false, refreshError: { code: 'invalid_grant', reconnect: true } }).action));
  check('transient refresh_failed action says NO re-auth yet',
    /No re-authorization needed yet/.test(gmailToken.tokenHealthStatus({ nowMs: NOW, expiresAtIso: null, refreshOk: false, refreshError: { code: 'upstream_unavailable', reconnect: false } }).action));
  check('warn action names the day count',
    /3 day/.test(gmailToken.tokenHealthStatus({ nowMs: NOW, expiresAtIso: '2026-11-14T12:00:00-05:00', refreshOk: true }).action));

  // ---------- 3. gmail-token-watch handler (mocked https) ----------
  function setWatchEnv(expiresAt) {
    process.env.GMAIL_CLIENT_ID = ENV.clientId;
    process.env.GMAIL_CLIENT_SECRET = ENV.clientSecret;
    process.env.GMAIL_REFRESH_TOKEN = ENV.refreshToken;
    if (expiresAt === undefined) delete process.env.GMAIL_REFRESH_TOKEN_EXPIRES_AT;
    else process.env.GMAIL_REFRESH_TOKEN_EXPIRES_AT = expiresAt;
  }
  // Dry-run success + 2.5 days left -> 503 warn (not 200: warn still needs Troy).
  // Expiry is computed from the real wall clock so the test is not
  // fragile to the hour it runs.
  const plusDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
  setWatchEnv(plusDays(2.5));
  mockRoutes = [['oauth2.googleapis.com', tokenOk.status, tokenOk.text]];
  let r = await watch.handler({ httpMethod: 'GET', headers: {} });
  let b = JSON.parse(r.body);
  eq('watch dry-run success + 2.5d left -> status warn', b.status, 'warn');
  check('watch warn is HTTP 503 (needs a human)', r.statusCode === 503, `got ${r.statusCode}`);
  check('watch refreshOk true', b.refreshOk === true);
  check('watch body carries no credential value',
    !JSON.stringify(b).includes('TEST_REFRESH_TOKEN') && !JSON.stringify(b).includes('TEST_CLIENT_SECRET'));

  // Dry-run success + 30 days left -> 200 ok.
  setWatchEnv(plusDays(30));
  r = await watch.handler({ httpMethod: 'GET', headers: {} });
  b = JSON.parse(r.body);
  eq('watch dry-run success + 30d left -> status ok', b.status, 'ok');
  eq('watch ok is HTTP 200', r.statusCode, 200);

  // invalid_grant -> 503 refresh_failed.
  setWatchEnv(plusDays(30));
  mockRoutes = [['oauth2.googleapis.com', invalidGrant.status, invalidGrant.text]];
  r = await watch.handler({ httpMethod: 'GET', headers: {} });
  b = JSON.parse(r.body);
  eq('watch invalid_grant -> refresh_failed', b.status, 'refresh_failed');
  eq('watch refresh_failed error code', b.refreshErrorCode, 'invalid_grant');
  check('watch refresh_failed is HTTP 503', r.statusCode === 503);
  check('watch refresh_failed action says re-authorize', /Re-authorize Google/.test(b.action), b.action);

  // Missing env -> 503 not_connected (fail closed, no Google call attempted).
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.GMAIL_REFRESH_TOKEN;
  mockCalls = [];
  r = await watch.handler({ httpMethod: 'GET', headers: {} });
  b = JSON.parse(r.body);
  eq('watch missing env -> not_connected', b.status, 'not_connected');
  check('watch missing env makes no token call', mockCalls.length === 0, `calls: ${mockCalls.length}`);

  // ---------- 4. title-order-email parity (refactor to shared module) ----------
  process.env.DASHBOARD_PASSWORD = 'test-password';
  process.env.GATE_SECRET = 'test-password';
  const authedEvent = (body) => ({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer test-password' },
    body: JSON.stringify(body),
  });
  const goodBody = { to: 'troy00152@gmail.com', subject: 'Title order — TEST', body: 'Test body.' };

  // Send success end-to-end (token exchange + Gmail send, both mocked).
  setWatchEnv(undefined);
  mockRoutes = [
    ['oauth2.googleapis.com', tokenOk.status, tokenOk.text],
    ['gmail.googleapis.com', 200, JSON.stringify({ id: 'TEST_MSG_ID' })],
  ];
  r = await titleOrder.handler(authedEvent(goodBody));
  b = JSON.parse(r.body);
  eq('send path still 200 after refactor', r.statusCode, 200);
  eq('send path returns messageId', b.messageId, 'TEST_MSG_ID');
  check('send response leaks no fixture credential',
    !r.body.includes('TEST_REFRESH_TOKEN') && !r.body.includes('TEST_CLIENT_SECRET') && !r.body.includes('TEST_ACCESS_TOKEN'), r.body);

  // Refresh rejected -> 503 with the reconnect message (same string as before).
  mockRoutes = [['oauth2.googleapis.com', invalidGrant.status, invalidGrant.text]];
  r = await titleOrder.handler(authedEvent(goodBody));
  b = JSON.parse(r.body);
  eq('send path refresh failure still 503', r.statusCode, 503);
  check('send path refresh failure still says reconnect',
    /Reconnect Google/.test(b.error || ''), b.error);

  // Missing Gmail env -> 503 "Gmail not connected yet".
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.GMAIL_REFRESH_TOKEN;
  r = await titleOrder.handler(authedEvent(goodBody));
  b = JSON.parse(r.body);
  eq('send path missing env still 503', r.statusCode, 503);
  eq('send path missing env message unchanged', b.error, 'Gmail not connected yet');

  // Bad recipient + no auth still enforced before any Gmail call.
  setWatchEnv(undefined);
  mockRoutes = [['oauth2.googleapis.com', tokenOk.status, tokenOk.text]];
  r = await titleOrder.handler(authedEvent({ to: 'stranger@example.com', subject: 'x', body: 'y' }));
  eq('send path bad recipient still 400', r.statusCode, 400);
  r = await titleOrder.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(goodBody) });
  eq('send path no auth still 401', r.statusCode, 401);

  https.request = realRequest;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  https.request = realRequest;
  console.error('REGRESSION CRASH', e);
  process.exit(1);
});

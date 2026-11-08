// netlify/functions/title-order-email.js
// One-click title-order email send from the Closing Tracker (Troy-side only).
// The tracker (a separate origin) calls this with the deal's pre-filled
// subject/body; the function sends it via the Gmail API as
// troy00152@gmail.com. It NEVER sends silently: the tracker always shows
// Troy the full To / Subject / Body preview first, and he confirms.
//
// Auth (admin only — same trust as the dashboard gate):
//   1. the dashboard lm_auth cookie (same HMAC check as buyer-verify.js /
//      deals-api.js), OR
//   2. Authorization: Bearer <dashboard password> — the tracker lives on a
//      different origin so the lm_auth cookie is never sent there; Troy types
//      his dashboard password into the tracker once and it is kept only in
//      that browser's localStorage, sent only to this function over HTTPS.
// No other caller can send: the recipient is restricted to an allowlist
// (the 7 market-default title-company orders emails + troy00152@gmail.com
// as the only test recipient).
//
// Gmail credentials come ONLY from Netlify env vars:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// They do not exist yet. Until Troy completes the one-time Google
// authorization, this returns 503 "Gmail not connected yet" and sends
// nothing. No other email provider (no SendGrid, no SMTP password).
//
// Gmail API calls use Node's built-in https only — no new dependency.
// Credential values are NEVER logged or returned in any response.
'use strict';

const crypto = require('crypto');
const https = require('https');

const COOKIE_NAME = 'lm_auth';

// Recipient allowlist — the market-default title companies' orders emails
// (source of truth: ~/workspace/title-companies/defaults.md) plus Troy
// himself as the only permitted test recipient. Any other To is rejected.
const ALLOWED_RECIPIENTS = new Set([
  'orders@titlecompanyofflorida.com', // Jacksonville — Title Company of Florida
  'contracts@hockerlaw.com',          // Indianapolis — Hocker Title
  'info@ohiorealtitle.com',           // Cleveland — Ohio Real Title Agency
  'orders@mycleartitle.com',          // Kansas City — Clear Title Nationwide
  'order@closedtitle.com',            // Dayton — CLOSED Title
  'orders@innovativeclosingsolutions.com', // Greenville — Innovative Closing Solutions
  'closings@harrymarshlaw.com',       // Charlotte — Harry Marsh Law
  'troy00152@gmail.com',              // test recipient ONLY — never a title company
]);

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
const gmailNotConnected = () =>
  json(503, {
    error: 'Gmail not connected yet',
    detail:
      'One-time setup needed: connect Google in Netlify (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) so the dashboard can send as troy00152@gmail.com. Nothing was sent.',
  });

// ---- admin auth: lm_auth cookie (same HMAC as gate.ts) or Bearer dashboard password ----
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
function cookieValid(event, secret) {
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
function bearerValid(event, secret) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false; // fail closed — gate.ts 503s without it too
  return cookieValid(event, secret) || bearerValid(event, secret);
}

// ---- minimal https JSON client (built-ins only) ----
function postJson(urlStr, { headers = {}, body = '' }) {
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

function base64url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function gmailAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();
  const res = await postJson('https://oauth2.googleapis.com/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (res.status !== 200) {
    // Do not include the upstream body: it can carry token error detail.
    throw new Error(
      'Gmail authorization failed (refresh token rejected). Reconnect Google to restore sending.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    throw new Error('Gmail authorization failed (unexpected token response).');
  }
  if (!parsed.access_token) {
    throw new Error('Gmail authorization failed (no access token returned).');
  }
  return parsed.access_token;
}

async function gmailSend({ to, subject, body }) {
  const accessToken = await gmailAccessToken();
  if (accessToken === null) return { notConnected: true };
  const raw = [
    'From: troy00152@gmail.com',
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');
  const res = await postJson(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ raw: base64url(raw) }),
    },
  );
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'Gmail refused the send (authorization). Reconnect Google to restore sending.',
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Gmail send failed (HTTP ${res.status}). Nothing was sent.`);
  }
  let parsed = {};
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    parsed = {};
  }
  return { messageId: parsed.id || null };
}

function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (event.httpMethod !== 'POST') return bad('POST only.');

    // Admin only — before anything else (do not leak config state).
    if (!isAdmin(event)) return unauth();

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return bad('Bad JSON body.');
      }
    }

    const to = cleanStr(body.to, 200).toLowerCase();
    const subject = cleanStr(body.subject, 200);
    const text = String(body.body == null ? '' : body.body);
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return bad('Enter a valid recipient email.');
    }
    if (!ALLOWED_RECIPIENTS.has(to)) {
      return bad(
        'That recipient is not a default title company. Title orders only go to the market default — or to troy00152@gmail.com for a test.',
      );
    }
    if (!subject) return bad('Subject is required.');
    if (!text.trim()) return bad('Email body is required.');
    if (text.length > 10000) return bad('Email body is too long (max 10,000 characters).');

    const result = await gmailSend({ to, subject, body: text });
    if (result.notConnected) return gmailNotConnected();
    return ok({ ok: true, to, messageId: result.messageId });
  } catch (e) {
    // Never surface credential material; keep the message generic.
    const msg = String((e && e.message) || e);
    const safe = /Gmail|timed out|too large/i.test(msg)
      ? msg
      : 'Title-order send failed. Nothing was sent.';
    return json(503, { error: safe });
  }
};

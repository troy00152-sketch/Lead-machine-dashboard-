// netlify/functions/cc-auth.js
// Two-tier session auth for the standalone Command Center (Nov 16,
// 2026, Troy): the full dashboard login (Troy) and Irish's
// calling-only login. The full multi-user/roles layer for resale is
// explicitly LATER — this is just the two-tier split.
//
//   full  — cookie `lm_auth`  = "<expiry>.<sig>",
//           sig = HMAC-SHA256 hex of "<expiry>" under GATE_SECRET
//           (falling back to DASHBOARD_PASSWORD). The scheme gate.ts
//           has always minted; unchanged.
//   irish — cookie `lm_irish` = "<expiry>.irish.<sig>",
//           sig = HMAC-SHA256 hex of "<expiry>.irish" under the same
//           secret. Minted by gate.ts when the login attempt matches
//           the IRISH_ACCESS_CODE env var (never hardcoded).
//
// Enforcement model: every Command Center function checks the tier
// server-side. Calling functions (cc-dialer-api, cc-voice-token)
// accept either tier; everything else accepts full only and answers
// a valid Irish session with 403 (not 401 — she IS signed in, just
// restricted). gate.ts mirrors the same split for pages/assets.
'use strict';

const crypto = require('crypto');

const FULL_COOKIE = 'lm_auth';
const IRISH_COOKIE = 'lm_irish';

function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function authSecret() {
  return process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD || '';
}

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyCookie(cookie, secret, irish) {
  if (!cookie || !secret) return false;
  const parts = cookie.split('.');
  let expiry;
  let sig;
  if (irish) {
    if (parts.length !== 3 || parts[1] !== 'irish') return false;
    expiry = parts[0];
    sig = parts[2];
  } else {
    if (parts.length !== 2) return false;
    expiry = parts[0];
    sig = parts[1];
  }
  const exp = parseInt(expiry, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = hmacHex(secret, irish ? expiry + '.irish' : expiry);
  return safeEqualHex(sig, expected);
}

// authTier(event) -> 'full' | 'irish' | null
function authTier(event) {
  const secret = authSecret();
  if (!secret) return null;
  const headers = (event && event.headers) || {};
  const cookieHeader = headers.cookie || headers.Cookie || '';
  if (verifyCookie(getCookie(cookieHeader, FULL_COOKIE), secret, false)) return 'full';
  if (verifyCookie(getCookie(cookieHeader, IRISH_COOKIE), secret, true)) return 'irish';
  return null;
}

function isAdmin(event) {
  return authTier(event) === 'full';
}
function isIrish(event) {
  return authTier(event) === 'irish';
}

module.exports = { authTier, isAdmin, isIrish, FULL_COOKIE, IRISH_COOKIE };

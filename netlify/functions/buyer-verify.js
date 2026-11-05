// netlify/functions/buyer-verify.js
// Verified buyer tier — the moat for the #1 system.
// A buyer earns ✅ Verified one of three ways:
//   'deal-offer'  — made an offer in a deal room (set automatically by
//                   deals-api.js when the offer phone matches a master buyer)
//   'confirmed'   — Troy/Bread confirmed the buy box with the buyer directly
//   'pof'         — proof of funds on file
// Views do NOT verify anyone: deal-room links are shared, so a view can't
// be attributed to a specific buyer. Only an offer carries identity.
//
// Data model (Netlify Blobs store 'buyer-verified'):
//   map -> JSON { digits10: {name, how, at, dealId?} }
// The dashboard overlays this live map on the static master-buyers.js
// table — verification changes without a redeploy.
//
// Routing:
//   GET  ?action=list                        verified map (dashboard calls this)
//   POST {action:'set', phone, name, how}    admin only (lm_auth cookie)
//   POST {action:'remove', phone}            admin only
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'buyer-verified';
const MAP_KEY = 'map';
const COOKIE_NAME = 'lm_auth';
const HOWS = new Set(['confirmed', 'pof', 'deal-offer']);

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
function serverError(msg) {
  return json(503, { error: 'Buyer verification is not ready yet', detail: msg });
}

// ---- admin auth: verify the dashboard lm_auth cookie (same HMAC as gate.ts) ----
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

function store(event) {
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
}
async function readMap(s) {
  try {
    const v = await s.get(MAP_KEY, { type: 'json' });
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}
async function writeMap(s, map) {
  await s.set(MAP_KEY, JSON.stringify(map), { contentType: 'application/json' });
}
function digits10(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    const params = event.queryStringParameters || {};
    let body = {};
    if (event.body) {
      try { body = JSON.parse(event.body); } catch (e) { return bad('Bad JSON body.'); }
    }
    const action = params.action || body.action || 'list';

    if (action === 'list') {
      const s = store(event);
      const map = await readMap(s);
      return ok({ verified: map, count: Object.keys(map).length });
    }

    // --- admin-only below ---
    if (!isAdmin(event)) return unauth();
    const s = store(event);

    if (action === 'set') {
      const phone = digits10(body.phone);
      if (phone.length !== 10) return bad('Enter a valid 10-digit phone number.');
      const how = String(body.how || 'confirmed');
      if (!HOWS.has(how)) return bad('Unknown verification type.');
      const map = await readMap(s);
      map[phone] = {
        name: cleanStr(body.name, 100),
        how,
        at: Date.now(),
        dealId: cleanStr(body.dealId, 64) || undefined,
      };
      await writeMap(s, map);
      return ok({ ok: true, phone, how });
    }

    if (action === 'remove') {
      const phone = digits10(body.phone);
      if (phone.length !== 10) return bad('Enter a valid 10-digit phone number.');
      const map = await readMap(s);
      delete map[phone];
      await writeMap(s, map);
      return ok({ ok: true, phone });
    }

    return bad('Unknown action.');
  } catch (e) {
    return serverError(String((e && e.message) || e));
  }
};

// netlify/functions/photo-link.js
// Seller photo walkthrough — admin side: mint a photo link for a
// seller and list recent photo sessions for the gallery
// (photos-admin.html).
//
//   POST (admin, lm_auth cookie) { address, sellerName, phone, contactId? }
//       -> creates an unguessable token (crypto random, 32 base64url
//          chars), writes the manifest stub into the 'seller-photos'
//          Blobs store (shared with photo-upload.js), and returns
//          { ok, token, url } — Troy texts the url to the seller.
//   GET  (admin, lm_auth cookie)
//       -> recent sessions for the gallery: token, address, seller,
//          created, photo count, complete?
//
// Both verbs are admin-only: unauthenticated calls get 401 (same HMAC
// lm_auth check as buyer-verify.js). Nothing here is seller-facing.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'seller-photos';
const COOKIE_NAME = 'lm_auth';
const SITE_BASE = 'https://leadmachineapp.com';
const MAX_SESSIONS = 50;
const MAX_MANIFEST_SCAN = 200;

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
const bad = (msg) => json(400, { ok: false, error: msg });
const unauth = () => json(401, { ok: false, error: 'Not signed in — open the dashboard and sign in first.' });
function serverError(msg) {
  return json(503, { ok: false, error: 'Photo service is not ready yet', detail: msg });
}

// ---- admin auth: verify the dashboard lm_auth cookie (same HMAC as buyer-verify.js / gate.ts) ----
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

// ---- store (test-injectable, same pattern as cc-funnel-api.js) ----
let testStore = null;
function photosStore(event) {
  if (testStore) return testStore;
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
}

function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function mintToken() {
  return crypto.randomBytes(24).toString('base64url'); // 32 chars
}

async function handlePost(event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return bad('Invalid JSON body');
  }
  const address = cleanStr(body.address, 200);
  const sellerName = cleanStr(body.sellerName, 100);
  if (!address) return bad('Property address is required.');
  if (!sellerName) return bad('Seller name is required.');

  const token = mintToken();
  const now = new Date().toISOString();
  const manifest = {
    token,
    address,
    sellerName,
    sellerFirstName: sellerName.split(/\s+/)[0] || '',
    phone: cleanStr(body.phone, 40),
    contactId: cleanStr(body.contactId, 64),
    createdAt: now,
    updatedAt: now,
    complete: false,
    completedAt: null,
    notes: '',
    photos: [],
  };
  const store = photosStore(event);
  await store.set(token + '/manifest.json', JSON.stringify(manifest), {
    contentType: 'application/json',
  });
  return ok({ ok: true, token, url: SITE_BASE + '/photos.html?k=' + token });
}

async function handleGet(event) {
  const store = photosStore(event);
  let listing;
  try {
    listing = await store.list();
  } catch (e) {
    listing = null;
  }
  const keys = ((listing && listing.blobs) || [])
    .map((b) => b && b.key)
    .filter((k) => typeof k === 'string' && k.endsWith('/manifest.json'))
    .slice(0, MAX_MANIFEST_SCAN);
  const sessions = [];
  for (const key of keys) {
    let m = null;
    try {
      m = await store.get(key, { type: 'json' });
    } catch (e) { /* skip unreadable */ }
    if (!m || typeof m !== 'object') continue;
    sessions.push({
      token: m.token,
      address: m.address || '',
      sellerName: m.sellerName || '',
      phone: m.phone || '',
      contactId: m.contactId || '',
      createdAt: m.createdAt || '',
      completedAt: m.completedAt || null,
      complete: !!m.complete,
      photoCount: Array.isArray(m.photos) ? m.photos.length : 0,
      notes: m.notes || '',
    });
  }
  sessions.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return ok({ ok: true, sessions: sessions.slice(0, MAX_SESSIONS) });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) return unauth();
    if (event.httpMethod === 'POST') return await handlePost(event);
    if (event.httpMethod === 'GET') return await handleGet(event);
    return json(405, { ok: false, error: 'Method not allowed' });
  } catch (e) {
    return serverError(String((e && e.message) || e));
  }
};

// Test hooks (not part of the deployed surface) — same pattern as
// cc-funnel-api.js's _test.setStores.
exports._test = {
  setStore(store) {
    testStore = store || null;
  },
  mintToken,
  STORE_NAME,
  SITE_BASE,
};

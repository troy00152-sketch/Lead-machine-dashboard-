// netlify/functions/photo-upload.js
// Seller photo walkthrough — the seller-facing endpoint behind
// photos.html (public link Troy texts a seller: photos.html?k=TOKEN).
//
// POST (public, token-authenticated — the token IS the credential):
//   { action: 'getSession',  token }
//       -> { ok, address, sellerFirstName, complete, stepsWithPhotos,
//            photoCount } so a reopened link resumes where the seller
//            left off.
//   { action: 'uploadPhoto', token, stepId, image /* base64 */ }
//       -> validates the token, sniffs the real image type from the
//          magic bytes (JPEG / PNG / WebP only), caps the decoded size
//          at ~8 MB, stores the bytes in the 'seller-photos' Blobs
//          store under {token}/{stepId}-{index} and updates
//          {token}/manifest.json. Single-photo steps replace in place;
//          multi-photo steps append.
//   { action: 'finish',      token, notes }
//       -> stamps the manifest complete with a timestamp + the
//          seller's optional notes.
//
// GET (admin — lm_auth cookie, same HMAC check as buyer-verify.js):
//   ?action=listPhotos&token=        manifest + photo keys
//   ?action=getPhoto&token=&key=     streams one stored image
// Unauthenticated admin calls are rejected (401). The public POST
// actions never read photos back — a token can only add to its own
// session, exactly like the funnel endpoint writes but never reads.
//
// No sends of any kind. No external calls.
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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8 MB decoded
const MAX_NOTES_CHARS = 2000;

// The 15 guided steps (ids must match photos.html). `multi` steps keep
// every upload; single steps hold exactly one photo (a re-take
// replaces it).
const STEPS = [
  { id: 'front', multi: false },
  { id: 'back', multi: false },
  { id: 'living', multi: false },
  { id: 'kitchen', multi: true },
  { id: 'bedroom1', multi: false },
  { id: 'bedroom2', multi: false },
  { id: 'bedroom3', multi: false },
  { id: 'bathroom1', multi: false },
  { id: 'bathroom2', multi: false },
  { id: 'roof', multi: false },
  { id: 'waterheater', multi: false },
  { id: 'furnace', multi: false },
  { id: 'panel', multi: false },
  { id: 'damage', multi: true },
  { id: 'extra', multi: true },
];
const STEP_BY_ID = {};
for (const s of STEPS) STEP_BY_ID[s.id] = s;

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

function manifestKey(token) {
  return token + '/manifest.json';
}
async function readManifest(store, token) {
  try {
    const v = await store.get(manifestKey(token), { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}
async function writeManifest(store, manifest) {
  await store.set(manifestKey(manifest.token), JSON.stringify(manifest), {
    contentType: 'application/json',
  });
}

// Tokens are minted by photo-link.js (crypto random, base64url). The
// shape check also keeps a token from ever escaping its own prefix.
function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(token);
}

function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Sniff the real type from magic bytes — never trust a client claim.
function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  return null;
}

function stepsWithPhotos(manifest) {
  const counts = {};
  for (const p of Array.isArray(manifest.photos) ? manifest.photos : []) {
    counts[p.stepId] = (counts[p.stepId] || 0) + 1;
  }
  return counts;
}

// ---------------- POST (public, token-authenticated) ----------------
async function handlePost(event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return bad('Invalid JSON body');
  }
  const action = String(body.action || '');
  const token = String(body.token || '');
  if (!validToken(token)) {
    return json(404, { ok: false, error: 'This link is not active.' });
  }
  const store = photosStore(event);
  const manifest = await readManifest(store, token);
  if (!manifest) {
    return json(404, { ok: false, error: 'This link is not active.' });
  }

  if (action === 'getSession') {
    return ok({
      ok: true,
      address: manifest.address || '',
      sellerFirstName: manifest.sellerFirstName || '',
      complete: !!manifest.complete,
      stepsWithPhotos: stepsWithPhotos(manifest),
      photoCount: Array.isArray(manifest.photos) ? manifest.photos.length : 0,
    });
  }

  if (action === 'uploadPhoto') {
    const step = STEP_BY_ID[String(body.stepId || '')];
    if (!step) return bad('Unknown photo step.');
    let b64 = String(body.image || '');
    const comma = b64.indexOf(','); // tolerate a data: URL prefix
    if (b64.startsWith('data:') && comma !== -1) b64 = b64.slice(comma + 1);
    if (!b64) return bad('No photo data received.');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch (e) {
      return bad('Photo data was not valid.');
    }
    if (buf.length === 0) return bad('Photo data was empty.');
    if (buf.length > MAX_IMAGE_BYTES) {
      return bad('That photo is too large — please retake it.');
    }
    const contentType = sniffImageType(buf);
    if (!contentType) {
      return bad('That file is not a photo we can use (JPEG, PNG, or WebP).');
    }

    const now = new Date().toISOString();
    // Per-photo capturedAt: the seller's phone stamps when the shot was
    // taken; trust it when it parses and isn't implausible, else fall
    // back to the upload time (`at` always records the upload itself).
    let capturedAt = now;
    if (typeof body.capturedAt === 'string') {
      const t = Date.parse(body.capturedAt);
      if (Number.isFinite(t) && t <= Date.now() + 24 * 60 * 60 * 1000 && t >= Date.now() - 30 * 24 * 60 * 60 * 1000) {
        capturedAt = new Date(t).toISOString();
      }
    }
    const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
    let key;
    if (step.multi) {
      const index = photos.filter((p) => p.stepId === step.id).length;
      key = token + '/' + step.id + '-' + index;
      await store.set(key, buf, { contentType });
      photos.push({ key, stepId: step.id, contentType, size: buf.length, at: now, capturedAt });
    } else {
      // Single-photo step: replace in place at index 0.
      key = token + '/' + step.id + '-0';
      await store.set(key, buf, { contentType });
      const kept = photos.filter((p) => p.stepId !== step.id);
      // Drop any stray extra blobs for this step from older builds.
      for (const p of photos) {
        if (p.stepId === step.id && p.key !== key) {
          try { await store.delete(p.key); } catch (e) { /* best-effort */ }
        }
      }
      kept.push({ key, stepId: step.id, contentType, size: buf.length, at: now, capturedAt });
      manifest.photos = kept;
    }
    if (step.multi) manifest.photos = photos;
    manifest.updatedAt = now;
    await writeManifest(store, manifest);
    return ok({
      ok: true,
      key,
      stepId: step.id,
      stepCount: manifest.photos.filter((p) => p.stepId === step.id).length,
      photoCount: manifest.photos.length,
    });
  }

  if (action === 'finish') {
    manifest.complete = true;
    manifest.completedAt = new Date().toISOString();
    if (body.notes != null) manifest.notes = cleanStr(body.notes, MAX_NOTES_CHARS);
    manifest.updatedAt = manifest.completedAt;
    await writeManifest(store, manifest);
    return ok({ ok: true, complete: true, photoCount: (manifest.photos || []).length });
  }

  return bad('Unknown action.');
}

// ---------------- GET (admin only) ----------------
async function handleGet(event) {
  if (!isAdmin(event)) return unauth();
  const params = event.queryStringParameters || {};
  const action = String(params.action || '');
  const token = String(params.token || '');
  if (!validToken(token)) return bad('Missing or invalid token.');
  const store = photosStore(event);

  if (action === 'listPhotos') {
    const manifest = await readManifest(store, token);
    if (!manifest) return json(404, { ok: false, error: 'No such photo session.' });
    const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
    return ok({ ok: true, manifest, keys: photos.map((p) => p.key), photos });
  }

  if (action === 'getPhoto') {
    const key = String(params.key || '');
    if (!key.startsWith(token + '/') || key.includes('..')) {
      return bad('Missing or invalid photo key.');
    }
    let data;
    try {
      data = await store.get(key, { type: 'arrayBuffer' });
    } catch (e) {
      data = null;
    }
    if (!data) return json(404, { ok: false, error: 'Photo not found.' });
    const manifest = await readManifest(store, token);
    const entry = ((manifest && manifest.photos) || []).find((p) => p.key === key);
    const buf = Buffer.from(data);
    const contentType = (entry && entry.contentType) || sniffImageType(buf) || 'application/octet-stream';
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, no-store',
        'Content-Length': String(buf.length),
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  }

  return bad('Unknown action.');
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
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
  STEPS,
  STORE_NAME,
  MAX_IMAGE_BYTES,
  sniffImageType,
  validToken,
};

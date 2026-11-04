// netlify/functions/deals-api.js
// "Master API" — buyer deal rooms, native to the command center.
// Zero new vendors: runs on Netlify Blobs (bundled in Troy's Netlify
// Personal plan, draws from his existing 1,000 monthly credits).
//
// Data model (mirrors the Deal Pages artifact):
//   deal:{id}            -> JSON deal {id, roomToken, address, arv,
//                           askingPrice, estRepairs, mao (PRIVATE),
//                           compSummary, photos[], viewCount, createdAt,
//                           updatedAt}
//   deal:{id}:offers     -> JSON array [{buyerName, buyerPhone, amount,
//                           message, submittedAt}]
//   deal:{id}:photo:{pid}-> binary image bytes (content-type in metadata)
//   room:{token}         -> {id}  (unguessable public token -> deal id)
//   deal:index           -> {ids: [...]}  (deal id list for the admin list)
//
// Routing: single function, `action` in the query string (GET) or JSON
// body (POST). Same pattern as the other dashboard functions.
//
//   ADMIN (requires dashboard lm_auth cookie — verified in-function):
//     GET  ?action=list                        list deal summaries
//     POST {action:'create', ...fields}        create deal -> {id, roomToken}
//     GET  ?action=get&id=...                  full deal detail (incl. mao)
//     POST {action:'update', id, ...fields}    update deal fields
//     POST {action:'delete', id}               delete deal + photos + offers
//     GET  ?action=offers&id=...               list offers for a deal
//     POST {action:'uploadPhoto', id, filename, contentType, data(base64), caption}
//     POST {action:'deletePhoto', id, photoId}
//     POST {action:'setCover', id, photoId}
//   PUBLIC (no auth — unguessable room tokens; mao NEVER exposed):
//     GET  ?action=room&token=...              buyer payload, bumps viewCount
//     POST {action:'submitOffer', token, buyerName, buyerPhone, amount, message}
//     GET  ?action=photo&id=...&photoId=...    serve image bytes
//
// The edge password gate (gate.ts) exempts this function path — per-action
// auth below is the enforcement point.
//
// CREDIT NOTES: Blobs only, no Netlify Database (avoids compute-unit burn).
// Photos capped at 5MB; admin page resizes client-side before upload.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  // Installed via package.json. Netlify injects site credentials at runtime;
  // connectLambda(event) hydrates them for v1 (exports.handler) functions.
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'deal-rooms';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const COOKIE_NAME = 'lm_auth';

// ---- tiny in-memory rate limiter (best-effort, per function instance) ----
const buckets = new Map();
function rateOk(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) b = { start: now, count: 0 };
  b.count += 1;
  buckets.set(key, b);
  // keep the map small
  if (buckets.size > 2000) {
    for (const [k, v] of buckets) {
      if (now - v.start > windowMs) buckets.delete(k);
      if (buckets.size <= 1000) break;
    }
  }
  return b.count <= limit;
}
function clientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

// ---- responses ----
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
const notFound = (msg) => json(404, { error: msg || 'Not found' });
const tooMany = () => json(429, { error: 'Too many requests — slow down and try again.' });
function serverError(msg) {
  return json(503, {
    error: 'Deal rooms storage is not ready yet',
    detail: msg,
    setup: 'Deploy with the @netlify/blobs dependency installed (package.json) and redeploy.',
  });
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
  if (!secret) return false; // fail closed — gate.ts 503s without it too
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

// ---- blob store ----
function store(event) {
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) {
    // connectLambda is best-effort; getStore may still work if the
    // runtime injected NETLIFY_BLOBS_CONTEXT ambiently.
  }
  return blobs.getStore(STORE_NAME);
}

async function readJson(s, key, fallback) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

const dealKey = (id) => `deal:${id}`;
const offersKey = (id) => `deal:${id}:offers`;
const photoKey = (id, pid) => `deal:${id}:photo:${pid}`;
const roomKey = (token) => `room:${token}`;

function newId(prefix, bytes) {
  return prefix + crypto.randomBytes(bytes).toString('hex');
}
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function cleanNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function photoUrl(id, pid) {
  return `/.netlify/functions/deals-api?action=photo&id=${encodeURIComponent(id)}&photoId=${encodeURIComponent(pid)}`;
}
function publicDeal(d) {
  // NEVER include mao — this shape is served to buyers.
  return {
    id: d.id,
    address: d.address,
    arv: d.arv,
    askingPrice: d.askingPrice,
    estRepairs: d.estRepairs,
    compSummary: d.compSummary,
    photos: (d.photos || []).map((p) => ({
      id: p.id,
      caption: p.caption || '',
      isCover: !!p.isCover,
      url: photoUrl(d.id, p.id),
    })),
    viewCount: d.viewCount || 0,
  };
}

async function getIndex(s) {
  let idx = await readJson(s, 'deal:index', null);
  if (idx && Array.isArray(idx.ids)) return idx;
  // rebuild from store listing as a fallback
  const ids = [];
  try {
    const { blobs: entries } = await s.list({ prefix: 'deal:' });
    for (const e of entries || []) {
      const m = /^deal:([^:]+)$/.exec(e.key || '');
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
  } catch (e) { /* ignore */ }
  idx = { ids };
  try { await writeJson(s, 'deal:index', idx); } catch (e) { /* ignore */ }
  return idx;
}
async function indexAdd(s, id) {
  const idx = await getIndex(s);
  if (!idx.ids.includes(id)) {
    idx.ids.push(id);
    await writeJson(s, 'deal:index', idx);
  }
}
async function indexRemove(s, id) {
  const idx = await getIndex(s);
  idx.ids = idx.ids.filter((x) => x !== id);
  await writeJson(s, 'deal:index', idx);
}

// ================= ADMIN =================

async function adminList(s) {
  const idx = await getIndex(s);
  const deals = [];
  for (const id of idx.ids) {
    const d = await readJson(s, dealKey(id), null);
    if (!d) continue;
    const offers = await readJson(s, offersKey(id), []);
    deals.push({
      id: d.id,
      address: d.address,
      arv: d.arv,
      askingPrice: d.askingPrice,
      viewCount: d.viewCount || 0,
      offerCount: Array.isArray(offers) ? offers.length : 0,
      photoCount: (d.photos || []).length,
      createdAt: d.createdAt,
    });
  }
  deals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ok({ deals });
}

async function adminCreate(s, body) {
  const address = cleanStr(body.address, 200);
  if (!address) return bad('Address is required.');
  const id = newId('dl_', 12);
  const roomToken = crypto.randomBytes(32).toString('hex'); // 64 chars, unguessable
  const now = Date.now();
  const deal = {
    id,
    roomToken,
    address,
    arv: cleanNum(body.arv),
    askingPrice: cleanNum(body.askingPrice),
    estRepairs: cleanNum(body.estRepairs),
    mao: cleanNum(body.mao), // PRIVATE — never served on public routes
    compSummary: cleanStr(body.compSummary, 2000),
    photos: [],
    viewCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(s, dealKey(id), deal);
  await writeJson(s, roomKey(roomToken), { id });
  await writeJson(s, offersKey(id), []);
  await indexAdd(s, id);
  return ok({ id, roomToken });
}

async function adminGet(s, id) {
  if (!id) return bad('Missing id.');
  const d = await readJson(s, dealKey(id), null);
  if (!d) return notFound('Deal not found.');
  const offers = await readJson(s, offersKey(id), []);
  const full = Object.assign({}, d, {
    photos: (d.photos || []).map((p) =>
      Object.assign({}, p, { url: photoUrl(d.id, p.id) })
    ),
    offerCount: Array.isArray(offers) ? offers.length : 0,
  });
  return ok({ deal: full });
}

async function adminUpdate(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await readJson(s, dealKey(id), null);
  if (!d) return notFound('Deal not found.');
  if (body.address !== undefined) {
    const a = cleanStr(body.address, 200);
    if (!a) return bad('Address cannot be empty.');
    d.address = a;
  }
  for (const f of ['arv', 'askingPrice', 'estRepairs', 'mao']) {
    if (body[f] !== undefined) d[f] = cleanNum(body[f]);
  }
  if (body.compSummary !== undefined) d.compSummary = cleanStr(body.compSummary, 2000);
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true });
}

async function adminDelete(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await readJson(s, dealKey(id), null);
  if (!d) return notFound('Deal not found.');
  for (const p of d.photos || []) {
    try { await s.delete(photoKey(id, p.id)); } catch (e) { /* ignore */ }
  }
  try { await s.delete(dealKey(id)); } catch (e) { /* ignore */ }
  try { await s.delete(offersKey(id)); } catch (e) { /* ignore */ }
  if (d.roomToken) {
    try { await s.delete(roomKey(d.roomToken)); } catch (e) { /* ignore */ }
  }
  await indexRemove(s, id);
  return ok({ ok: true });
}

async function adminOffers(s, id) {
  if (!id) return bad('Missing id.');
  const d = await readJson(s, dealKey(id), null);
  if (!d) return notFound('Deal not found.');
  const offers = await readJson(s, offersKey(id), []);
  return ok({ offers: Array.isArray(offers) ? offers : [] });
}

async function adminUploadPhoto(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await readJson(s, dealKey(id), null);
  if (!d) return notFound('Deal not found.');
  const contentType = cleanStr(body.contentType, 100);
  if (!/^image\//.test(contentType)) return bad('Only image uploads are allowed.');
  const b64 = String(body.data || '');
  if (!b64) return bad('Missing photo data.');
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch (e) {
    return bad('Photo data is not valid base64.');
  }
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) {
    return bad(`Photo must be under ${MAX_PHOTO_BYTES / 1024 / 1024}MB.`);
  }
  const pid = newId('p_', 8);
  await s.set(photoKey(id, pid), buf, { contentType });
  const photos = d.photos || [];
  photos.push({
    id: pid,
    caption: cleanStr(body.caption, 200),
    isCover: photos.length === 0, // first photo becomes the cover
    contentType,
    size: buf.length,
  });
  d.photos = photos;
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ photoId: pid, url: photoUrl(id, pid) });
}

async function adminDeletePhoto(s, body) {
  const id = cleanStr(body.id, 64);
  const photoId = cleanStr(body.photoId, 64);
  if (!id || !photoId) return bad('Missing id or photoId.');
  const d = await readJson(s, dealKey(id), null);
  if (!d) return notFound('Deal not found.');
  const photos = d.photos || [];
  const idx = photos.findIndex((p) => p.id === photoId);
  if (idx < 0) return notFound('Photo not found.');
  const wasCover = !!photos[idx].isCover;
  photos.splice(idx, 1);
  if (wasCover && photos.length) photos[0].isCover = true;
  d.photos = photos;
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  try { await s.delete(photoKey(id, photoId)); } catch (e) { /* ignore */ }
  return ok({ ok: true });
}

async function adminSetCover(s, body) {
  const id = cleanStr(body.id, 64);
  const photoId = cleanStr(body.photoId, 64);
  if (!id || !photoId) return bad('Missing id or photoId.');
  const d = await readJson(s, dealKey(id), null);
  if (!d) return notFound('Deal not found.');
  let found = false;
  for (const p of d.photos || []) {
    p.isCover = p.id === photoId;
    if (p.id === photoId) found = true;
  }
  if (!found) return notFound('Photo not found.');
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true });
}

// ================= PUBLIC =================

async function publicRoom(s, token) {
  const t = cleanStr(token, 128);
  if (!t) return bad('Missing token.');
  const map = await readJson(s, roomKey(t), null);
  if (!map || !map.id) return notFound('This deal room link is not valid.');
  const d = await readJson(s, dealKey(map.id), null);
  if (!d) return notFound('This deal room link is not valid.');
  d.viewCount = (d.viewCount || 0) + 1;
  // best-effort view count — a lost increment here is harmless
  try { await writeJson(s, dealKey(d.id), d); } catch (e) { /* ignore */ }
  return ok({ deal: publicDeal(d) });
}

async function publicSubmitOffer(s, body) {
  const t = cleanStr(body.token, 128);
  if (!t) return bad('Missing token.');
  const map = await readJson(s, roomKey(t), null);
  if (!map || !map.id) return notFound('This deal room link is not valid.');
  const d = await readJson(s, dealKey(map.id), null);
  if (!d) return notFound('This deal room link is not valid.');
  const buyerName = cleanStr(body.buyerName, 100);
  const amount = cleanNum(body.amount);
  if (!buyerName) return bad('Your name is required.');
  if (amount == null || amount <= 0) return bad('Enter your offer amount.');
  const offer = {
    buyerName,
    buyerPhone: cleanStr(body.buyerPhone, 30),
    amount,
    message: cleanStr(body.message, 1000),
    submittedAt: Date.now(),
  };
  const key = offersKey(d.id);
  const offers = await readJson(s, key, []);
  (Array.isArray(offers) ? offers : []).push(offer);
  await writeJson(s, key, Array.isArray(offers) ? offers : [offer]);
  return ok({ ok: true });
}

async function publicPhoto(s, id, photoId) {
  const did = cleanStr(id, 64);
  const pid = cleanStr(photoId, 64);
  if (!did || !pid) return notFound();
  const d = await readJson(s, dealKey(did), null);
  if (!d) return notFound();
  const meta = (d.photos || []).find((p) => p.id === pid);
  if (!meta) return notFound();
  let data;
  try {
    data = await s.get(photoKey(did, pid), { type: 'arrayBuffer' });
  } catch (e) {
    return notFound();
  }
  if (!data) return notFound();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': meta.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: Buffer.from(data).toString('base64'),
    isBase64Encoded: true,
  };
}

// ================= HANDLER =================

const ADMIN_ACTIONS = new Set([
  'list', 'create', 'get', 'update', 'delete', 'offers',
  'uploadPhoto', 'deletePhoto', 'setCover',
]);
const PUBLIC_ACTIONS = new Set(['room', 'submitOffer', 'photo']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  }

  let s;
  try {
    s = store(event);
  } catch (e) {
    return serverError(e.message);
  }

  const qs = event.queryStringParameters || {};
  let action = qs.action || '';
  let body = {};
  if (event.httpMethod === 'POST') {
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return bad('Request body must be JSON.');
    }
    action = body.action || action;
  }
  action = String(action);

  const ip = clientIp(event);

  try {
    // ---- public actions (no auth; unguessable tokens; mao never exposed) ----
    if (action === 'room') {
      if (!rateOk(`room:${ip}`, 60, 10 * 60 * 1000)) return tooMany();
      return await publicRoom(s, qs.token);
    }
    if (action === 'submitOffer') {
      if (!rateOk(`offer:${ip}`, 8, 10 * 60 * 1000)) return tooMany();
      return await publicSubmitOffer(s, body);
    }
    if (action === 'photo') {
      if (!rateOk(`photo:${ip}`, 120, 10 * 60 * 1000)) return tooMany();
      return await publicPhoto(s, qs.id, qs.photoId);
    }

    // ---- admin actions (dashboard cookie required) ----
    if (ADMIN_ACTIONS.has(action)) {
      if (!isAdmin(event)) return unauth();
      switch (action) {
        case 'list': return await adminList(s);
        case 'create': return await adminCreate(s, body);
        case 'get': return await adminGet(s, qs.id);
        case 'update': return await adminUpdate(s, body);
        case 'delete': return await adminDelete(s, body);
        case 'offers': return await adminOffers(s, qs.id);
        case 'uploadPhoto': return await adminUploadPhoto(s, body);
        case 'deletePhoto': return await adminDeletePhoto(s, body);
        case 'setCover': return await adminSetCover(s, body);
        default: return bad('Unknown action.');
      }
    }

    if (PUBLIC_ACTIONS.has(action)) return bad('Use GET for this action.');
    return bad('Unknown action. Pass ?action=... (GET) or {action:...} (POST).');
  } catch (err) {
    console.error('[deals-api]', action, err.message);
    return json(500, { error: 'Deal rooms hit a snag', detail: String(err.message || err).slice(0, 200) });
  }
};

// Offline sanity checks (no network): node -e "const d=require('./deals-api.js'); console.log(typeof d.handler)"

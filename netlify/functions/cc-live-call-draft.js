// netlify/functions/cc-live-call-draft.js
// Server-backed Live Call draft (Nov 27, 2026).
//
// The gap (Nov 27 audit): live-call's "Save draft" was localStorage-only
// — saveDraft() wrote liveCallDraft.v1 on one device/browser, so a draft
// saved on Troy's phone never appeared on his Mac. The draft now lives
// in a Blobs store (one JSON doc, same pattern as cc-tasks-api.js /
// lib-client-status.js) and the page write-throughs every save to the
// server, keeping localStorage as the instant cache + offline fallback.
// On load the page reconciles: the newer of the local/server copies
// wins (see loadDraftFromServer in live-call.js); a server draft for a
// DIFFERENT address never clobbers a deal the URL just filled.
//
// Auth: the dashboard lm_auth HMAC cookie — the SAME check as
// cc-tasks-api.js / client-admin.js / buyer-verify.js. Every action
// requires it.
//
// Actions (?action=):
//   load     GET  -> { ok:true, draft|null, updatedAt }
//   save     POST { draft: { ...[data-draft] fields, __notes:[...] } }
//                  -> { ok:true, draft, updatedAt }
//                  One draft per account: a save overwrites the stored
//                  draft outright (last writer wins — a single in-flight
//                  call has one draft, same as the localStorage key it
//                  replaces). The client only POSTs when the collected
//                  fields actually changed, so autosave does not spam.
//   clear    POST -> { ok:true, draft:null } (a new deal cleared the
//                  local draft; the server copy must go with it or a
//                  later load would resurrect the stale call.)
//
// Draft shape: the page's own collected shape — one key per [data-draft]
// field id (string/boolean/number), __notes as an array of strings, and
// updatedAt (ms). Unknown/oversized values are dropped, never stored.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'cc-live-call-drafts';
const DRAFT_KEY = 'draft';
const MAX_DRAFT_BYTES = 65536;
const MAX_NOTES = 200;
const MAX_STRING = 2000;
const MAX_KEYS = 120;

const COOKIE_NAME = 'lm_auth';
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
// Admin auth: the dashboard lm_auth HMAC cookie — the SAME check as
// cc-tasks-api.js / client-admin.js / buyer-verify.js.
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false;
  const headers = (event && event.headers) || {};
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

let storeFactory = null; // tests only
function openStore(event) {
  if (storeFactory) return storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
}

async function readDraft(s) {
  try {
    const v = await s.get(DRAFT_KEY, { type: 'json' });
    if (v && typeof v === 'object' && v.draft && typeof v.draft === 'object') {
      return { draft: v.draft, updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0 };
    }
  } catch (e) { /* fall through to empty */ }
  return { draft: null, updatedAt: 0 };
}

async function writeDraft(s, draft) {
  const updatedAt = Date.now();
  const stored = { draft: draft, updatedAt: updatedAt };
  await s.set(
    DRAFT_KEY,
    JSON.stringify(stored),
    { contentType: 'application/json' }
  );
  return stored;
}

async function clearDraft(s) {
  if (typeof s.delete === 'function') {
    await s.delete(DRAFT_KEY);
  } else {
    await s.set(DRAFT_KEY, JSON.stringify({ draft: null, updatedAt: Date.now() }), { contentType: 'application/json' });
  }
}

// Keep only the page's own draft shape: scalar [data-draft] fields,
// __notes as strings. Anything else (objects, functions, oversized
// strings, key floods) is dropped, never stored.
function cleanDraft(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = {};
  let keys = 0;
  for (const k of Object.keys(d)) {
    if (k === 'updatedAt') continue; // server-stamped on write
    if (keys >= MAX_KEYS) break;
    const v = d[k];
    if (k === '__notes') {
      if (!Array.isArray(v)) continue;
      out.__notes = v.filter(function (n) { return typeof n === 'string'; }).slice(0, MAX_NOTES).map(function (n) { return n.slice(0, MAX_STRING); });
      keys += 1;
      continue;
    }
    if (typeof v === 'string') { out[k] = v.slice(0, MAX_STRING); keys += 1; }
    else if (typeof v === 'boolean') { out[k] = v; keys += 1; }
    else if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; keys += 1; }
    // objects / null / undefined: dropped — never part of the draft shape.
  }
  if (JSON.stringify(out).length > MAX_DRAFT_BYTES) return null;
  return out;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: JSON_HEADERS, body: '' };
  if (!isAdmin(event)) {
    return json(401, { ok: false, error: 'Not signed in — open the dashboard and sign in first.' });
  }
  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'load';
  let store;
  try {
    store = openStore(event);
  } catch (e) {
    return json(503, { ok: false, error: 'draft store is not ready yet', detail: String((e && e.message) || e) });
  }
  try {
    if (action === 'load') {
      const doc = await readDraft(store);
      return json(200, { ok: true, draft: doc.draft, updatedAt: doc.updatedAt });
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: action + ' requires POST' });
    }
    if (action === 'clear') {
      await clearDraft(store);
      return json(200, { ok: true, draft: null });
    }
    if (action === 'save') {
      let body = {};
      try {
        body = JSON.parse(event.body || '{}');
      } catch (e) {
        return json(400, { ok: false, error: 'invalid JSON body' });
      }
      const draft = cleanDraft(body.draft);
      if (!draft) return json(400, { ok: false, error: 'draft is required (object, under 64KB)' });
      const stored = await writeDraft(store, draft);
      return json(200, { ok: true, draft: stored.draft, updatedAt: stored.updatedAt });
    }
    return json(400, { ok: false, error: 'unknown action: ' + action });
  } catch (e) {
    return json(500, { ok: false, error: 'cc-live-call-draft failed', detail: String((e && e.message) || e).slice(0, 200) });
  }
};

module.exports._test = {
  setStoreFactory(fn) {
    storeFactory = fn || null;
  },
  reset() {
    storeFactory = null;
  },
};

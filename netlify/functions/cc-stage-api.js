// netlify/functions/cc-stage-api.js
// STAGING-ONLY enrollment API for the Phase 3 workflow engine.
//
//   POST {action:'stage', market:'indianapolis', contacts:[{...},...]}
//                                              stage a batch (never send)
//   GET  ?action=staged&market=indianapolis    list staged records
//   GET  ?action=counts                        enrollment counts by
//                                              market/stage (staged is
//                                              its own bucket)
//
// A staged record is SUPPLY, not a queue entry. It can NEVER send:
//   (1) The tick only ever picks stage === 'queued' — index filter
//       (cc-workflow-engine.js tick(): `stage === 'queued'`) AND the
//       index-loss scan filter (scanQueuedRecords: `r.stage ===
//       'queued'`). A 'staged' record is invisible to both.
//   (2) Staged records carry NO trigger tag and NO active-lead tag —
//       only '<market>-staged' + 'code violation'. So even if a stage
//       value were flipped to 'queued' by a bug, the tick's "Is Active
//       lead?" gate ends it 'ended-inactive' before any send.
//   (3) Even a queued Indianapolis record cannot send today: the
//       Telnyx sender pool for indianapolis is EMPTY (telnyx-lib.js
//       SENDER_POOLS.indianapolis = [] — numbers not purchased yet),
//       and sendSms() throws fail-closed on an empty pool, leaving the
//       record 'queued' with lastError and appending nothing.
//
// There is deliberately NO promote/activate action here. Moving a
// staged record to 'queued' is a separate, Troy-gated step (numbers
// purchased + workflow published + a live test send) — it gets its
// own endpoint + approval when that day comes, not smuggled in with
// staging.
//
// Idempotency / dedupe: the record key is the phone key. If a record
// already exists for the phone — ANY stage (queued, sent, ended-*,
// staged) — staging reports 'already-present' and TOUCHES NOTHING.
// A re-run therefore adds zero duplicates and can never overwrite a
// live record or resurrect a sealed/sent one. The in-file dedupe
// (one record per phone) lives in the prep script
// (~/workspace/standalone-build/indianapolis-stage-prep.js).
//
// ALL actions require the dashboard lm_auth cookie (verified
// in-function, same HMAC as gate.ts / cc-enroll-api.js).
'use strict';

const crypto = require('crypto');

const engine = require('./cc-workflow-engine');
const cfg = require('./cc-workflows-config');
const ccAuth = require('./cc-auth');
const lib = require('./telnyx-lib');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const ENROLL_STORE = 'cc-enrollments';
const ENROLL_INDEX_KEY = 'index';
const LIST_CAP = 2000;
let storeFactory = null; // (name) -> store; tests only
function makeStore(event) {
  if (storeFactory) return storeFactory(ENROLL_STORE);
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(ENROLL_STORE);
}
async function readJson(s, key) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    const s = cleanStr(t, 80);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
function lowerTags(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());
}

// Staging tags for a market. Deliberately NOT the trigger tag and NOT
// any active-lead tag (see header — layer 2 of the never-sends proof).
function stagingTagsFor(marketId) {
  return [String(marketId) + '-staged', 'code violation'];
}

// Build the staged record for one contact. Same field shape as the
// engine's fresh enrollment record, except: stage 'staged', path null
// (no send path is assigned until promotion), enrolledAt null (it is
// not enrolled — stagedAt is the staging timestamp), sentAt null.
// Sealed input (dnd / 'dnc' tag) stages sealed, so promotion must
// refuse it later.
function buildStageRecord(c, workflow) {
  const key = lib.phoneKey(c.phone);
  const phone = lib.toE164(c.phone);
  const tags = stagingTagsFor(workflow.id);
  const inputTags = cleanTags(c.tags);
  const sealed = c.dnd === true || lowerTags(inputTags).includes('dnc');
  if (sealed && !tags.includes('dnc')) tags.push('dnc');
  const rec = {
    key,
    phone,
    name: cleanStr(c.name, 200),
    firstName: cleanStr(c.firstName || c.first_name, 100),
    email: cleanStr(c.email, 200),
    address1: cleanStr(c.address1 || c.address, 300),
    city: cleanStr(c.city, 100),
    state: cleanStr(c.state, 40),
    postalCode: cleanStr(c.postalCode || c.zip, 20),
    market: workflow.id,
    tags,
    path: null,
    stage: 'staged',
    stagedAt: Date.now(),
    enrolledAt: null,
    sentAt: null,
    messageId: null,
    lastError: null,
    lastAttemptAt: null,
    source: cleanStr(c.source, 120) || 'cc-stage-api',
    parcelNumber: cleanStr(c.parcelNumber || c.parcel_number, 60),
    phoneType: cleanStr(c.phoneType, 40),
    smsCapable: c.smsCapable !== false,
    alternatePhones: Array.isArray(c.alternatePhones) ? c.alternatePhones : [],
    householdNames: Array.isArray(c.householdNames) ? c.householdNames : [],
    sourceRowIds: Array.isArray(c.sourceRowIds) ? c.sourceRowIds : [],
  };
  if (sealed) rec.dnd = true;
  return rec;
}

const COOKIE_NAME = 'lm_auth';
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) {
      if (ccAuth.isIrish(event)) return json(403, { error: 'Calling access only — staging is not part of the calling login.' });
      return unauth();
    }

    const params = event.queryStringParameters || {};
    let body = null;
    if (event.body) {
      try { body = JSON.parse(event.body); } catch (e) { return bad('Bad JSON body.'); }
    }
    const action = params.action || (body && !Array.isArray(body) && body.action) || (event.httpMethod === 'GET' ? 'counts' : 'stage');

    if (action === 'counts') {
      return ok(await engine.counts(event));
    }

    if (action === 'staged') {
      const market = String(params.market || (body && body.market) || '').trim().toLowerCase();
      if (!market) return bad('Missing market.');
      if (!cfg.getWorkflow(market)) return bad('Unknown market: ' + market);
      const s = makeStore(event);
      const idx = (await readJson(s, ENROLL_INDEX_KEY)) || { enrollments: {} };
      const keys = Object.keys(idx.enrollments || {}).filter(
        (k) => idx.enrollments[k].market === market && idx.enrollments[k].stage === 'staged'
      );
      const records = [];
      for (const k of keys.slice(0, LIST_CAP)) {
        const rec = await readJson(s, k);
        if (rec && rec.stage === 'staged') records.push(rec);
      }
      records.sort((a, b) => (b.stagedAt || 0) - (a.stagedAt || 0));
      return ok({ market, count: records.length, records });
    }

    if (action === 'stage') {
      const market = String((body && body.market) || '').trim().toLowerCase();
      if (!market) return bad('Missing market.');
      const workflow = cfg.getWorkflow(market);
      if (!workflow) return bad('Unknown market: ' + market);
      let contacts = null;
      if (Array.isArray(body)) contacts = body;
      else if (body && Array.isArray(body.contacts)) contacts = body.contacts;
      else if (body && body.contact) contacts = [body.contact];
      else if (body && body.phone) contacts = [body];
      if (!contacts || !contacts.length) return bad('No contacts to stage.');

      const s = makeStore(event);
      const results = [];
      const stagedRecs = [];
      let staged = 0;
      let alreadyPresent = 0;
      let skipped = 0;
      for (const c of contacts) {
        let rec;
        try {
          rec = buildStageRecord(c || {}, workflow);
        } catch (e) {
          skipped += 1;
          results.push({ phone: (c && c.phone) || null, ok: false, reason: 'invalid phone: ' + String((c && c.phone) || '') });
          continue;
        }
        const existing = await readJson(s, rec.key);
        if (existing && typeof existing === 'object') {
          // Dedupe: never touch an existing record, whatever its stage.
          alreadyPresent += 1;
          results.push({ phone: rec.phone, ok: false, reason: 'already-present', stage: String(existing.stage || '') });
          continue;
        }
        await writeJson(s, rec.key, rec);
        stagedRecs.push(rec);
        staged += 1;
        results.push({ phone: rec.phone, ok: true, stage: 'staged' });
      }
      // INDEX REPAIR (same lesson as cc-enroll-api.js, Nov 27): write
      // the index once from the in-memory set of staged keys, so the
      // batch outcome never depends on read freshness.
      try {
        const idx = (await readJson(s, ENROLL_INDEX_KEY)) || { enrollments: {} };
        if (!idx.enrollments || typeof idx.enrollments !== 'object') idx.enrollments = {};
        for (const r of stagedRecs) {
          if (r && r.key) idx.enrollments[r.key] = { market: r.market, stage: r.stage };
        }
        idx.updatedAt = Date.now();
        await writeJson(s, ENROLL_INDEX_KEY, idx);
      } catch (e) { /* records stand; the tick scan only reads queued ones */ }
      return ok({ staged, alreadyPresent, skipped, results });
    }

    return bad('Unknown action.');
  } catch (e) {
    return json(503, { error: 'Staging storage is not ready yet', detail: String((e && e.message) || e) });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  stagingTagsFor,
  buildStageRecord,
  setStoreFactory(fn) {
    storeFactory = fn || null;
  },
};

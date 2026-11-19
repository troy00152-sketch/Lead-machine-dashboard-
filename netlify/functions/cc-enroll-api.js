// netlify/functions/cc-enroll-api.js
// lm_auth-gated enrollment API for the Phase 3 workflow engine — used by
// future list imports to feed the mirrored HL market workflows.
//
//   POST {action:'pricing', phone, pricing:{arv, mao, lao},
//         listingVerified?}                      stamp pricing onto an
//                                                existing enrollment
//   POST {action:'enroll', contact:{...}}        enroll one contact
//   POST {action:'enroll', contacts:[{...},...]} enroll a batch
//   POST [{...}, {...}]                          a bare array also works
//   GET  ?action=counts                          enrollment counts by
//                                                market/stage
//
// Contacts page actions (contacts.html — the HighLevel Contacts
// mirror). The standalone contact book IS the enrollments store:
//   GET  ?action=list                            every enrollment
//                                                record, normalized
//                                                for the Contacts table
//   POST {action:'tag', phone, add:[], remove:[]}  tag writes on the
//                                                record (same store
//                                                the engine reads, so
//                                                workflow triggers
//                                                and guards see them)
//   POST {action:'note', phone, body}           append a note to the
//                                                record's notes[]
//   POST {action:'update', phone, fields:{}}    edit name / email /
//                                                address fields
//   POST {action:'delete', phone}               remove the standalone
//                                                record + its index
//                                                entry (does NOT touch
//                                                HighLevel)
//
// A contact enrolls ONLY when it carries the market's trigger tag (the
// engine enforces this, exactly like HL's "Contact Tag Added" trigger);
// anything else comes back in `results` with ok:false and the reason —
// nothing is silently dropped.
//
// ALL actions require the dashboard lm_auth cookie (verified in-function,
// same HMAC as gate.ts / cc-conversations-api.js).
'use strict';

const crypto = require('crypto');

const engine = require('./cc-workflow-engine');
const ccAuth = require('./cc-auth');
const lib = require('./telnyx-lib');
const ccDnd = require('./cc-dnd');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

// ---- enrollments store plumbing (same pattern as cc-dnd.js) ----
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

// The Contacts-table shape for one enrollment record. DND state is
// derived with cc-dnd's own rules (explicit channels win; a legacy
// seal derives all-three-ON) so the page never disagrees with the
// Conversations DND panel.
function normalizeContact(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    key: String(rec.key || ''),
    phone: String(rec.phone || ''),
    name: String(rec.name || ''),
    firstName: String(rec.firstName || ''),
    email: String(rec.email || ''),
    address1: String(rec.address1 || rec.address || ''),
    city: String(rec.city || ''),
    state: String(rec.state || ''),
    postalCode: String(rec.postalCode || rec.zip || ''),
    tags: Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [],
    market: String(rec.market || ''),
    stage: String(rec.stage || rec.status || ''),
    path: String(rec.path || ''),
    enrolledAt: rec.enrolledAt || rec.createdAt || null,
    updatedAt: rec.updatedAt || null,
    pricing: rec.pricing && typeof rec.pricing === 'object' ? rec.pricing : null,
    notes: Array.isArray(rec.notes) ? rec.notes : [],
    dnd: ccDnd.stateFrom(rec, null),
    source: 'crm',
  };
}

async function loadRecord(s, key) {
  const rec = await readJson(s, key);
  return rec && typeof rec === 'object' ? rec : null;
}

// Every record key: the engine index first, unioned with a store
// listing when the backend offers one (catches records written
// outside saveEnrollment, e.g. cc-dnd stubs).
async function allRecordKeys(s) {
  const keys = new Set();
  const idx = (await readJson(s, ENROLL_INDEX_KEY)) || { enrollments: {} };
  for (const k of Object.keys(idx.enrollments || {})) keys.add(k);
  if (typeof s.list === 'function') {
    try {
      const res = await s.list();
      const blobsList = (res && (res.blobs || res.keys)) || [];
      for (const b of blobsList) {
        const k = typeof b === 'string' ? b : (b && b.key);
        if (k && k !== ENROLL_INDEX_KEY) keys.add(String(k));
      }
    } catch (e) { /* index-only fallback */ }
  }
  keys.delete(ENROLL_INDEX_KEY);
  return [...keys].slice(0, LIST_CAP);
}

function phoneKeyOf(raw) {
  return lib.phoneKey(raw);
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) {
      // Irish's calling-only session is signed in but restricted —
      // 403, not 401 (cc-auth two-tier split).
      if (ccAuth.isIrish(event)) return json(403, { error: 'Calling access only — enrollments are not part of the calling login.' });
      return unauth();
    }

    const params = event.queryStringParameters || {};
    let body = null;
    if (event.body) {
      try { body = JSON.parse(event.body); } catch (e) { return bad('Bad JSON body.'); }
    }
    const action = params.action || (body && !Array.isArray(body) && body.action) || (event.httpMethod === 'GET' ? 'counts' : 'enroll');

    if (action === 'counts') {
      return ok(await engine.counts(event));
    }

    // ---- Contacts page actions (see header) ----
    if (action === 'list') {
      const s = makeStore(event);
      const keys = await allRecordKeys(s);
      const contacts = [];
      for (const k of keys) {
        const rec = await loadRecord(s, k);
        const n = normalizeContact(rec);
        if (n && n.key) contacts.push(n);
      }
      contacts.sort((a, b) => (b.enrolledAt || b.updatedAt || 0) - (a.enrolledAt || a.updatedAt || 0));
      return ok({ contacts, count: contacts.length });
    }

    if (action === 'tag' || action === 'note' || action === 'update' || action === 'delete') {
      const rawPhone = body && body.phone;
      if (!rawPhone) return bad('Missing phone.');
      let key;
      try {
        key = phoneKeyOf(rawPhone);
      } catch (e) {
        return bad('Invalid phone number.');
      }
      const s = makeStore(event);
      const rec = await loadRecord(s, key);
      if (!rec) return bad('Contact not found.');

      if (action === 'tag') {
        const add = cleanTags(body.add);
        const remove = cleanTags(body.remove).map((t) => t.toLowerCase());
        let tags = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
        tags = tags.filter((t) => !remove.includes(t.trim().toLowerCase()));
        for (const t of add) {
          if (!tags.some((x) => x.trim().toLowerCase() === t.toLowerCase())) tags.push(t);
        }
        rec.tags = tags;
        rec.updatedAt = Date.now();
        await writeJson(s, key, rec);
        return ok({ ok: true, key, tags });
      }

      if (action === 'note') {
        const text = cleanStr(body.body, 2000);
        if (!text) return bad('Note body is empty.');
        const notes = Array.isArray(rec.notes) ? rec.notes : [];
        notes.push({ body: text, at: Date.now() });
        rec.notes = notes;
        rec.updatedAt = Date.now();
        await writeJson(s, key, rec);
        return ok({ ok: true, key, notes });
      }

      if (action === 'update') {
        const f = (body && body.fields) || {};
        const editable = {
          name: 200, firstName: 100, email: 200, address1: 300,
          city: 100, state: 40, postalCode: 20,
        };
        for (const [field, max] of Object.entries(editable)) {
          if (f[field] !== undefined) rec[field] = cleanStr(f[field], max);
        }
        rec.updatedAt = Date.now();
        await writeJson(s, key, rec);
        return ok({ ok: true, key, contact: normalizeContact(rec) });
      }

      // delete: standalone record only — HighLevel is never touched.
      await s.delete(key);
      const idx = (await readJson(s, ENROLL_INDEX_KEY)) || { enrollments: {} };
      if (idx.enrollments && idx.enrollments[key]) {
        delete idx.enrollments[key];
        idx.updatedAt = Date.now();
        await writeJson(s, ENROLL_INDEX_KEY, idx);
      }
      return ok({ ok: true, key, deleted: true });
    }

    if (action === 'pricing') {
      const phone = body && body.phone;
      if (!phone) return bad('Missing phone.');
      const r = await engine.stampPricing(
        phone,
        (body && body.pricing) || {},
        event,
        { listingVerified: !!(body && body.listingVerified) }
      );
      if (!r.ok) return bad(r.reason);
      return ok(r);
    }

    if (action === 'enroll') {
      let contacts = null;
      if (Array.isArray(body)) contacts = body;
      else if (body && Array.isArray(body.contacts)) contacts = body.contacts;
      else if (body && body.contact) contacts = [body.contact];
      else if (body && body.phone) contacts = [body]; // single contact as the body itself
      if (!contacts || !contacts.length) return bad('No contacts to enroll.');

      const results = [];
      let enrolled = 0;
      let skipped = 0;
      for (const c of contacts) {
        const r = await engine.enroll(c, event);
        if (r.ok) {
          enrolled += 1;
          results.push({ phone: r.enrollment.phone, ok: true, market: r.enrollment.market, path: r.enrollment.path });
        } else {
          skipped += 1;
          results.push({ phone: (c && c.phone) || null, ok: false, reason: r.reason });
        }
      }
      return ok({ enrolled, skipped, results });
    }

    return bad('Unknown action.');
  } catch (e) {
    return json(503, { error: 'Enrollment storage is not ready yet', detail: String((e && e.message) || e) });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  normalizeContact,
  setStoreFactory(fn) {
    storeFactory = fn || null;
  },
};

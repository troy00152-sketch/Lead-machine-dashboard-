// netlify/functions/cc-appointments.js
// Standalone Command Center: appointments store (mirrors the HL
// Seller Calls calendar surface the bot uses — see hl.js).
//
// Store (Netlify Blobs, store 'cc-appointments'):
//   'index'    -> {ids: []}
//   'appt-<id>' -> appointment record
// Record: {id, calendarId, contactId, phone, name, email, address1,
//          title, startISO, endISO, startMs, endMs, status, source,
//          createdAt}
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}
const push = require('./cc-push');

const STORE_NAME = 'cc-appointments';
const CALENDAR_ID = 'seller-calls';
const INDEX_KEY = 'index';

// ---- injectable dependencies (tests) ----
const deps = { storeFactory: null };

function makeStore(event) {
  if (deps.storeFactory) return deps.storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
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

function recordKey(id) {
  const raw = String(id || '');
  return raw.startsWith('appt-') ? raw : 'appt-' + raw;
}
function bareId(id) {
  const raw = String(id || '');
  return raw.startsWith('appt-') ? raw.slice('appt-'.length) : raw;
}

async function loadIndex(s) {
  const idx = await readJson(s, INDEX_KEY);
  if (idx && Array.isArray(idx.ids)) return idx;
  return { ids: [] };
}
async function saveRecord(s, rec) {
  await writeJson(s, recordKey(rec.id), rec);
  const idx = await loadIndex(s);
  if (!idx.ids.includes(rec.id)) idx.ids.push(rec.id);
  await writeJson(s, INDEX_KEY, idx);
  return rec;
}
async function loadAll(s) {
  const idx = await loadIndex(s);
  const out = [];
  for (const id of idx.ids) {
    const rec = await readJson(s, recordKey(id));
    if (rec) out.push(rec);
  }
  return out;
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

async function createAppointment(rec, event) {
  const r = rec || {};
  const startMs = r.startMs != null ? Number(r.startMs) : toMs(r.startISO || r.startTime);
  const endMs = r.endMs != null ? Number(r.endMs) : toMs(r.endISO || r.endTime);
  const out = {
    id: crypto.randomUUID(),
    calendarId: r.calendarId || CALENDAR_ID,
    contactId: r.contactId || null,
    phone: r.phone || '',
    name: r.name || '',
    email: r.email || '',
    address1: r.address1 || '',
    title: r.title || '',
    startISO: r.startISO || r.startTime || (startMs != null ? new Date(startMs).toISOString() : null),
    endISO: r.endISO || r.endTime || (endMs != null ? new Date(endMs).toISOString() : null),
    startMs,
    endMs,
    status: r.status || 'confirmed',
    source: r.source || '',
    createdAt: r.createdAt != null ? r.createdAt : Date.now(),
  };
  const s = makeStore(event);
  await saveRecord(s, out);
  // Phone push: a booking exists now — tell Troy's phone. Bounded
  // (never throws, never past ~3s); a failed push never fails the booking.
  try {
    await push.notifyAppointment({
      id: out.id, name: out.name, phone: out.phone,
      startMs: out.startMs, startISO: out.startISO, title: out.title,
    }, event);
  } catch (e) {
    console.error('[cc-appointments] push failed:', e);
  }
  return out;
}

async function getAppointment(id, event) {
  if (!id) return null;
  const s = makeStore(event);
  return readJson(s, recordKey(bareId(id)));
}

async function listAppointments(range, event) {
  const { fromMs, toMs } = range || {};
  const from = fromMs != null ? Number(fromMs) : -Infinity;
  const to = toMs != null ? Number(toMs) : Infinity;
  const s = makeStore(event);
  const all = await loadAll(s);
  return all.filter((rec) => {
    const start = rec.startMs != null ? rec.startMs : toMs2(rec);
    const end = rec.endMs != null ? rec.endMs : toMs2End(rec);
    if (start == null || end == null) return false;
    return start < to && from < end;
  });
  function toMs2(rec) { return toMs(rec.startISO || rec.startTime); }
  function toMs2End(rec) { return toMs(rec.endISO || rec.endTime); }
}

async function cancelAppointment(id, event) {
  const s = makeStore(event);
  const rec = await readJson(s, recordKey(bareId(id)));
  if (!rec) return null;
  rec.status = 'cancelled';
  await writeJson(s, recordKey(rec.id), rec);
  return rec;
}

async function forContact(contactId, event) {
  const s = makeStore(event);
  const all = await loadAll(s);
  return all.filter((rec) => rec.contactId != null && String(rec.contactId) === String(contactId));
}

module.exports = {
  CALENDAR_ID,
  createAppointment,
  getAppointment,
  listAppointments,
  cancelAppointment,
  forContact,
};

// Test hooks (not part of the deployed surface).
module.exports._test = {
  setStoreFactory(fn) {
    deps.storeFactory = fn || null;
  },
  setStores(stores) {
    deps.storeFactory = stores && stores.appointments ? () => stores.appointments : null;
  },
  reset() {
    deps.storeFactory = null;
  },
};

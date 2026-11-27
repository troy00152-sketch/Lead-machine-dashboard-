// netlify/functions/cc-appointments.js
// Standalone Command Center: appointments store (mirrors the HL
// Seller Calls calendar surface the bot uses — see hl.js).
//
// Store (Netlify Blobs, store 'cc-appointments'):
//   'index'    -> {ids: []}
//   'appt-<id>' -> appointment record
// Record: {id, calendarId, contactId, phone, name, email, address1,
//          title, startISO, endISO, startMs, endMs, status, source,
//          createdAt,
//          hlEventId, hlContactId, hlSync, hlError}
//   hlEventId — the HighLevel event id for this booking (see below).
//   hlSync — 'ok' | 'failed' | 'skipped-no-config' (HL write outcome).
//   hlError — the HL failure message when hlSync is 'failed'.
//
// HIGHLEVEL SYNC (Nov 27, 2026 — Troy: a booking must actually land
// on the calendar): every create ALSO creates the event on the
// HighLevel Seller Calls calendar, every cancel ALSO cancels it there,
// and every list ALSO reads HL — so a Sam/Amber/manual booking shows
// on the HL calendar AND the Command Center calendar AND the Booked
// Today panel (which reads HL), and HL-native bookings block slots
// and show on the CC page. Before this fix the Command Center wrote
// Blobs ONLY (verified live Nov 27: the HL calendar was empty Nov
// 27–Dec 4 while the CC store held bookings) — the live text bot
// (custom-bot hl.js) writes HL directly; the CC twin + Sam did not.
// Same env vars as the live bot: HL_API_TOKEN (required — without it
// the HL half is skipped loudly and the Blobs booking still lands),
// HL_LOCATION_ID / HL_CALENDAR_ID (fall back to Troy's legacy ids),
// HL_USER_ID (optional assignee; HL auto-assigns when unset —
// verified live Nov 27). CC_HL_SYNC=0 disables the HL half entirely.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}
const push = require('./cc-push');
const libClient = require('./lib-client');

const STORE_NAME = 'cc-appointments';
const CALENDAR_ID = 'seller-calls';
const INDEX_KEY = 'index';
const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_VERSION_CALENDARS = '2021-04-15';
const HL_TIMEOUT_MS = 20000;

// ---- injectable dependencies (tests) ----
const deps = { storeFactory: null, hlFetchImpl: null };

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

// ---- HighLevel Seller Calls calendar sync ----

function hlConfig() {
  if (String(process.env.CC_HL_SYNC || '') === '0') return null;
  const token = String(process.env.HL_API_TOKEN || '').trim();
  if (!token) return null;
  return {
    token,
    locationId: String(process.env.HL_LOCATION_ID || '').trim() || libClient.defaultLocationId(),
    calendarId: String(process.env.HL_CALENDAR_ID || '').trim() || libClient.defaultCalendarId(),
    userId: String(process.env.HL_USER_ID || '').trim(),
  };
}

async function hlFetch(cfg, path, opts) {
  if (deps.hlFetchImpl) return deps.hlFetchImpl(cfg, path, opts);
  const o = opts || {};
  const method = o.method || 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HL_TIMEOUT_MS);
  try {
    const res = await fetch(HL_API_BASE + path, {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Version': HL_VERSION_CALENDARS,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON body */ }
    if (!res.ok) throw new Error(`HL ${res.status}: ${(data && data.message) || text.slice(0, 150)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// An HL contact/event id (20-char alphanumeric) vs a CC phone-key
// (11 digits). The CC stores phone-keys as contactId; HL needs its
// own contact id — the two are never interchangeable.
function looksLikeHlId(v) {
  const s = String(v || '');
  return s.length >= 10 && /[A-Za-z]/.test(s) && /^[A-Za-z0-9]+$/.test(s);
}

function e164OfPhone(phone) {
  const d = digitsOnly(phone);
  if (!d) return '';
  if (d.length === 10) return '+1' + d;
  return '+' + d;
}

// Resolve the HL contact id for a booking: the record's contactId
// when it already is one, else lookup by phone, else create the HL
// contact (the seller is an HL contact in the live flow — the bot
// creates them there too). Throws when there is no phone and no id.
async function resolveHlContactId(rec, cfg) {
  if (looksLikeHlId(rec.hlContactId)) return String(rec.hlContactId);
  if (looksLikeHlId(rec.contactId)) return String(rec.contactId);
  const phone = e164OfPhone(rec.phone);
  if (!phone) throw new Error('no phone or HL contact id to book against');
  const found = await hlFetch(cfg, `/contacts/lookup?phone=${encodeURIComponent(phone)}&locationId=${encodeURIComponent(cfg.locationId)}`).catch(() => null);
  const hit = found && (found.contact || found);
  const hitId = hit && (hit.id || (Array.isArray(hit.contacts) && hit.contacts[0] && hit.contacts[0].id));
  if (hitId) return String(hitId);
  const name = String(rec.name || '').trim();
  const parts = name ? name.split(/\s+/) : [];
  const created = await hlFetch(cfg, '/contacts/', {
    method: 'POST',
    body: {
      locationId: cfg.locationId,
      firstName: parts[0] || 'Seller',
      lastName: parts.slice(1).join(' ') || '',
      phone,
      ...(rec.email ? { email: rec.email } : {}),
    },
  });
  const c = created && (created.contact || created);
  const id = c && (c.id || c.contactId);
  if (!id) throw new Error('HL contact create returned no id');
  return String(id);
}

// Create the HL event for a Blobs booking. Returns the HL event id.
// ISO-vs-epoch (Nov 27, 2026 — resolved against the LIVE bot):
// the create path posts ISO strings (startTime: rec.startISO), exactly
// as the live bot does (custom-bot src/hl.js createAppointment posts
// startTime: startISO / endTime: endISO on /calendars/events/
// appointments, version 2021-04-15). Only the /calendars/events LIST
// query takes epoch ms (see listHlEventsMapped) — do NOT convert the
// create body to epoch; HL accepts the ISO form here and the bot has
// booked on it live since Oct 2026.
// Assignee (Oct 27 live-bot lesson): HL sometimes drops an assigned
// user id on create, which hides the event from user-filtered views
// and the phone app — so when HL_USER_ID is configured the assignee
// is verified by re-read and forced with a PUT when it did not stick.
// Never throws over the assignee: the booking itself already exists.
async function createHlAppointment(rec, cfg) {
  const contactId = await resolveHlContactId(rec, cfg);
  const body = {
    calendarId: cfg.calendarId,
    locationId: cfg.locationId,
    contactId,
    startTime: rec.startISO,
    endTime: rec.endISO,
    title: rec.title || ('Seller call — ' + (rec.name || 'seller')),
    appointmentStatus: 'confirmed',
    ignoreDateRange: false,
    toNotify: true,
  };
  if (cfg.userId) body.assignedUserId = cfg.userId;
  const created = await hlFetch(cfg, '/calendars/events/appointments', { method: 'POST', body });
  const c = created || {};
  const id = c.id || c.eventId || c.appointmentId;
  if (!id) throw new Error('HL appointment create returned no id');
  if (cfg.userId) {
    try {
      const reread = await hlFetch(cfg, `/calendars/events/appointments/${id}`);
      const stuck = reread && (reread.assignedUserId || reread.assigned_user_id || (reread.user && reread.user.id) || reread.userId);
      if (String(stuck || '') !== String(cfg.userId)) {
        await hlFetch(cfg, `/calendars/events/appointments/${id}`, {
          method: 'PUT',
          body: { assignedUserId: cfg.userId, userId: cfg.userId },
        }).catch(() => hlFetch(cfg, `/calendars/events/appointments/${id}`, {
          method: 'PUT',
          body: { assignedUserId: cfg.userId },
        }));
        const reread2 = await hlFetch(cfg, `/calendars/events/appointments/${id}`).catch(() => null);
        const stuck2 = reread2 && (reread2.assignedUserId || reread2.assigned_user_id || (reread2.user && reread2.user.id) || reread2.userId);
        if (String(stuck2 || '') !== String(cfg.userId)) {
          console.error('[cc-appointments] HL assignee NOT PERSISTED for', id, 'expected', cfg.userId, 'got', stuck2 || null);
        }
      }
    } catch (e) {
      console.error('[cc-appointments] HL assignee verify failed for', id, String((e && e.message) || e).slice(0, 150));
    }
  }
  return { hlEventId: String(id), hlContactId: String(contactId) };
}

// Cancel the HL event for a booking (HL-native status change — the
// record stays auditable; it no longer blocks the slot). Throws on
// failure: a Blobs record must not read cancelled while HL still
// holds the slot.
async function cancelHlAppointment(hlEventId, cfg) {
  await hlFetch(cfg, `/calendars/events/appointments/${encodeURIComponent(hlEventId)}`, {
    method: 'PUT',
    body: { appointmentStatus: 'cancelled' },
  });
}

// HL events in a window, mapped to the Blobs record shape so slot
// generation and the calendar page see them. Contact phones/names
// resolve per event (best-effort, bounded): the /calendars/events
// payload carries contactId only, and the CC filters match on the
// phone-key — without the lookup an HL booking would be invisible to
// the bot's existing-booking check. Returns [] when HL is not
// configured, the range is open-ended, or HL fails (fail-open: the
// Blobs list still answers).
async function listHlEventsMapped(fromMs, toMs, cfg) {
  if (!cfg) return [];
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs))) return [];
  let raw = [];
  try {
    const data = await hlFetch(cfg, `/calendars/events?locationId=${encodeURIComponent(cfg.locationId)}&calendarId=${encodeURIComponent(cfg.calendarId)}&startTime=${Math.floor(fromMs)}&endTime=${Math.floor(toMs)}`);
    raw = (data && (data.events || data.appointments)) || (Array.isArray(data) ? data : []);
  } catch (e) {
    console.error('[cc-appointments] HL events read failed (Blobs-only):', String((e && e.message) || e).slice(0, 150));
    return [];
  }
  const live = (Array.isArray(raw) ? raw : []).filter((e) => {
    if (!e || !e.id) return false;
    const st = String(e.appointmentStatus || e.appoinmentStatus || e.status || '').toLowerCase();
    return st !== 'cancelled' && st !== 'invalid';
  });
  // Resolve contact phone/name per event, in batches of 25 (Nov 27,
  // P1-6): the old `live.length <= 25` cap left every event past 25
  // without a phone/name, so larger lists lost their contact match.
  // Batches run sequentially (one in-flight batch at a time); the
  // events still map even when a lookup fails.
  const contacts = {};
  for (let i = 0; i < live.length; i += 25) {
    const batch = live.slice(i, i + 25);
    await Promise.all(batch.map(async (e) => {
      try {
        const c = await hlFetch(cfg, `/contacts/${encodeURIComponent(e.contactId)}`);
        const contact = c && (c.contact || c);
        if (contact) contacts[e.contactId] = contact;
      } catch (err) { /* phone stays blank; the event still maps */ }
    }));
  }
  return live.map((e) => {
    const contact = contacts[e.contactId] || {};
    const phone = e164OfPhone(contact.phoneNumber || contact.phone || '');
    const name = String(contact.name || contact.firstName || '').trim()
      || String(contact.firstName || '').trim()
      || '';
    const startMs = Date.parse(e.startTime || e.start_time || '');
    const endMs = Date.parse(e.endTime || e.end_time || '');
    const phoneKey = digitsOnly(phone);
    return {
      id: 'hl-' + e.id,
      hlEventId: String(e.id),
      hlContactId: String(e.contactId || ''),
      calendarId: CALENDAR_ID,
      hlCalendarId: String(e.calendarId || cfg.calendarId),
      contactId: phoneKey || String(e.contactId || ''),
      phone,
      name,
      email: String(contact.email || ''),
      address1: String(e.address || contact.address1 || ''),
      title: String(e.title || 'Appointment'),
      startISO: e.startTime || e.start_time || null,
      endISO: e.endTime || e.end_time || null,
      startMs: Number.isFinite(startMs) ? startMs : null,
      endMs: Number.isFinite(endMs) ? endMs : null,
      status: String(e.appointmentStatus || e.appoinmentStatus || 'confirmed').toLowerCase(),
      source: 'highlevel',
      hlSync: 'ok',
      createdAt: Date.parse(e.dateAdded || '') || null,
    };
  }).filter((r) => r.startMs != null && r.endMs != null);
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
  // HighLevel sync (Nov 27, 2026 — Troy: the booking must actually
  // land on the calendar): Blobs-first so the attempt is never lost,
  // then the HL event. HL failure marks the record and THROWS — the
  // caller must not confirm a time that is not held on the real
  // calendar (and no appointment push fires for it). No HL token
  // configured: the Blobs booking still lands, marked skipped.
  const cfg = hlConfig();
  if (!cfg) {
    out.hlSync = 'skipped-no-config';
    console.error('[cc-appointments] HL_API_TOKEN unset — booking', out.id, 'is Blobs-only, NOT on the HL calendar');
    await writeJson(s, recordKey(out.id), out);
  } else {
    try {
      const made = await createHlAppointment(out, cfg);
      out.hlEventId = made.hlEventId;
      out.hlContactId = made.hlContactId;
      out.hlSync = 'ok';
      await writeJson(s, recordKey(out.id), out);
    } catch (e) {
      out.hlSync = 'failed';
      out.hlError = String((e && e.message) || e).slice(0, 200);
      await writeJson(s, recordKey(out.id), out).catch(() => {});
      console.error('[cc-appointments] HL sync FAILED for', out.id, out.hlError);
      throw e;
    }
  }
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

// Blobs-only list (no HL merge): the reconcile action's input —
// it must see the raw Blobs records, including ones HL never heard
// of, without the merged HL twins mixed in.
async function listBlobsAppointments(range, event) {
  const { fromMs, toMs } = range || {};
  const from = fromMs != null ? Number(fromMs) : -Infinity;
  const to = toMs != null ? Number(toMs) : Infinity;
  const s = makeStore(event);
  const all = await loadAll(s);
  function toMs2(rec) { return toMs(rec.startISO || rec.startTime); }
  function toMs2End(rec) { return toMs(rec.endISO || rec.endTime); }
  return all.filter((rec) => {
    const start = rec.startMs != null ? rec.startMs : toMs2(rec);
    const end = rec.endMs != null ? rec.endMs : toMs2End(rec);
    if (start == null || end == null) return false;
    return start < to && from < end;
  });
}

// Stamp an HL match onto a Blobs record (reconcile only): sets the HL
// event id + sync state, clears a stale hlError on success. Returns
// the updated record, or null when the id is unknown.
async function stampHlSync(id, patch, event) {
  const s = makeStore(event);
  const rec = await readJson(s, recordKey(bareId(id)));
  if (!rec) return null;
  const p = patch || {};
  if (p.hlEventId !== undefined) rec.hlEventId = p.hlEventId;
  if (p.hlSync !== undefined) rec.hlSync = p.hlSync;
  if (p.hlContactId !== undefined) rec.hlContactId = p.hlContactId;
  if (p.hlError === null || p.hlError === undefined) delete rec.hlError;
  else rec.hlError = p.hlError;
  await writeJson(s, recordKey(rec.id), rec);
  return rec;
}

async function listAppointments(range, event) {
  const { fromMs, toMs } = range || {};
  const mine = await listBlobsAppointments(range, event);
  // HL merge: HL-native bookings (manual, live-bot) must block slots
  // and show on the CC calendar page. Fail-open: an HL outage never
  // empties the list. Dedupe: a CC booking also lives in HL — the
  // Blobs record (with hlEventId) wins, the HL twin is skipped.
  let merged = mine;
  try {
    const cfg = hlConfig();
    if (cfg && Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      const hl = await listHlEventsMapped(fromMs, toMs, cfg);
      const mineHlIds = new Set(mine.map((r) => r.hlEventId).filter(Boolean));
      const extra = hl.filter((r) => !mineHlIds.has(r.hlEventId));
      merged = mine.concat(extra);
    }
  } catch (e) {
    console.error('[cc-appointments] HL list merge failed (Blobs-only):', String((e && e.message) || e).slice(0, 150));
  }
  merged.sort((a, b) => {
    const sa = a.startMs != null ? a.startMs : toMs(a.startISO || a.startTime);
    const sb = b.startMs != null ? b.startMs : toMs(b.startISO || b.startTime);
    return (sa || 0) - (sb || 0);
  });
  return merged;
}

async function cancelAppointment(id, event) {
  const s = makeStore(event);
  const bare = bareId(id);
  const cfg = hlConfig();
  if (bare.startsWith('hl-')) {
    // HL-only booking (no Blobs record): cancel on HL directly.
    // HL failure throws — the slot is still held, so the caller
    // must not report it cancelled.
    if (!cfg) throw new Error('HL_API_TOKEN not set — cannot cancel the HL booking');
    await cancelHlAppointment(bare.slice(3), cfg);
    return { id: bare, hlEventId: bare.slice(3), status: 'cancelled' };
  }
  const rec = await readJson(s, recordKey(bare));
  if (!rec) return null;
  if (rec.hlEventId) {
    if (!cfg) throw new Error('HL_API_TOKEN not set — cannot cancel the HL booking for ' + rec.id);
    await cancelHlAppointment(rec.hlEventId, cfg);
  }
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
  listBlobsAppointments,
  stampHlSync,
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
  // Fake the HL API (cfg, path, opts) -> parsed JSON, or throw to
  // simulate an HL failure. Null restores the real fetch.
  setHlFetch(fn) {
    deps.hlFetchImpl = fn || null;
  },
  reset() {
    deps.storeFactory = null;
    deps.hlFetchImpl = null;
  },
};

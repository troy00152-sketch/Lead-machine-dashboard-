// netlify/functions/cc-calendar-api.js
// lm_auth-gated API behind the standalone Command Center's Calendar
// screen (calendar.html). Storage lives in cc-appointments.js (built
// in parallel — required lazily against its exact contract):
//   CALENDAR_ID = 'seller-calls'
//   createAppointment(rec, event) / listAppointments({fromMs, toMs},
//   event) / getAppointment(id, event) / cancelAppointment(id, event)
//
// Routing:
//   GET  ?action=list&from=<ms>&to=<ms>   appointments overlapping the
//                                         range, mapped for the page
//   POST {action:'create', name, phone, startISO, minutes?, title?}
//         (double-booking guard: merged Blobs + HL check first;
//          conflict -> 409 {error:'slot_taken', alternatives:[...]})
//   POST {action:'cancel', id}
//   POST {action:'reconcile'}  stamp hlEventId/hlSync on pre-Nov-27
//         Blobs-only bookings that match an HL event by phone + start
//         time; returns {matched, matchedIds, unmatched} — report only,
//         never auto-cancels.
//
// Store failures -> 503, like the other cc APIs.
'use strict';

const crypto = require('crypto');

const lib = require('./telnyx-lib');
const slots = require('./cc-slots');

// cc-appointments.js is required lazily so this module still loads
// before that file lands; tests may inject a fake via
// _test.setAppointments.
let apptsOverride = null;
function appts() {
  if (apptsOverride) return apptsOverride;
  return require('./cc-appointments');
}

// ---- auth: verify the dashboard lm_auth cookie (same HMAC as gate.ts) ----
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
const forbidden = () => json(403, { error: 'Calling access only — the calendar is not part of the calling login.' });
const ccAuth = require('./cc-auth');
function serverError(msg) {
  return json(503, { error: 'Calendar storage is not ready yet', detail: msg });
}
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

function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function publicAppt(a) {
  return {
    id: a.id,
    title: a.title || '',
    name: a.name || '',
    phone: a.phone || '',
    startISO: a.startISO,
    endISO: a.endISO,
    status: a.status || '',
    source: a.source || '',
    // HL sync state (Nov 27, P0-4): the page renders a badge from
    // these — a Blobs-only booking must be visibly different from a
    // synced one. hlSync: 'ok' | 'failed' | 'skipped-no-config' |
    // undefined (pre-sync records); hlError carries the failure.
    hlSync: a.hlSync || null,
    hlError: a.hlError || null,
    hlEventId: a.hlEventId || null,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) return ccAuth.isIrish(event) ? forbidden() : unauth();

    const params = event.queryStringParameters || {};
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return bad('Bad JSON body.');
      }
    }
    const action = params.action || body.action || '';
    const store = appts();

    if (action === 'list') {
      const fromMs = Number(params.from != null ? params.from : body.from);
      const toMs = Number(params.to != null ? params.to : body.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        return bad('from and to (epoch ms) are required.');
      }
      const records = await store.listAppointments({ fromMs, toMs }, event);
      const appointments = (Array.isArray(records) ? records : []).map(publicAppt);
      return ok({ appointments });
    }

    if (action === 'create') {
      const name = cleanStr(body.name, 120);
      if (!name) return bad('Missing name.');
      if (!body.phone) return bad('Missing phone.');
      let phoneE164;
      let contactId;
      try {
        phoneE164 = lib.toE164(body.phone);
        contactId = lib.phoneKey(body.phone);
      } catch (e) {
        return bad('Invalid phone number.');
      }
      const startMs = Date.parse(body.startISO || '');
      if (!Number.isFinite(startMs)) return bad('Missing or invalid startISO.');
      const minutes = Number(body.minutes) > 0 ? Number(body.minutes) : 30;
      const startISO = new Date(startMs).toISOString();
      const endISO = new Date(startMs + minutes * 60000).toISOString();
      const endMs = startMs + minutes * 60000;
      // Double-booking guard (Nov 27, P1-5): check the requested time
      // against the MERGED (Blobs + HL) appointments before creating
      // — an HL-native booking blocks the slot exactly like a CC one.
      // Cancelled / invalid records never block. On conflict the
      // caller gets slot_taken + the next 2–3 free times (same helper
      // the slot engine uses), never a silent double-book.
      const dayParts = slots.zonedParts(startMs);
      const rangeStart = slots.zonedTimeToUtc({ year: dayParts.year, month: dayParts.month, day: dayParts.day, hour: 0, minute: 0 });
      const rangeEnd = rangeStart + 3 * 24 * 60 * 60 * 1000;
      const windowAppts = await store.listAppointments({ fromMs: rangeStart, toMs: rangeEnd }, event);
      const live = (Array.isArray(windowAppts) ? windowAppts : []).filter((a) => {
        const st = String(a.status || '').toLowerCase();
        return st !== 'cancelled' && st !== 'invalid';
      });
      const clash = live.some((a) => {
        const s = a.startMs != null ? Number(a.startMs) : Date.parse(a.startISO || a.startTime || '');
        const e = a.endMs != null ? Number(a.endMs) : Date.parse(a.endISO || a.endTime || '');
        return Number.isFinite(s) && Number.isFinite(e) && startMs < e && s < endMs;
      });
      if (clash) {
        const alternatives = slots.generateFreeSlots(live, rangeStart, rangeEnd)
          .filter((iso) => Date.parse(iso) > startMs)
          .slice(0, 3);
        return json(409, { error: 'slot_taken', message: 'That time is already booked.', alternatives });
      }
      const appointment = await store.createAppointment(
        {
          contactId,
          phone: phoneE164,
          name,
          title: cleanStr(body.title, 200) || 'Seller call — ' + name,
          startISO,
          endISO,
          startMs,
          endMs,
          source: 'manual',
          calendarId: store.CALENDAR_ID || 'seller-calls',
        },
        event
      );
      return ok({ ok: true, appointment });
    }

    if (action === 'reconcile') {
      // Reconcile pre-Nov-27 Blobs-only bookings (Nov 27, P1-7): for
      // every Blobs booking with no hlEventId, search the HL events
      // in the booking's day window and match by contact phone + start
      // time; matches get hlEventId + hlSync 'ok' stamped. REPORT
      // ONLY — nothing is ever auto-cancelled here; unmatched
      // bookings are returned for a human to chase.
      const listBlobs = typeof store.listBlobsAppointments === 'function'
        ? (r) => store.listBlobsAppointments(r, event)
        : async (r) => (await store.listAppointments(r, event)).filter((a) => a.source !== 'highlevel');
      const stamp = typeof store.stampHlSync === 'function'
        ? (id, patch) => store.stampHlSync(id, patch, event)
        : null;
      if (!stamp) return serverError('cc-appointments.js does not expose stampHlSync yet');
      const allBlobs = await listBlobs({ fromMs: 0, toMs: Date.now() + 366 * 24 * 60 * 60 * 1000 });
      const claimed = new Set((allBlobs || []).map((r) => r.hlEventId).filter(Boolean));
      const pending = (allBlobs || []).filter((r) => {
        if (r.hlEventId) return false;
        const st = String(r.status || '').toLowerCase();
        return st !== 'cancelled' && st !== 'invalid' && r.startMs != null;
      });
      // Group by ET calendar day so each day costs one HL list call.
      const byDay = new Map();
      for (const r of pending) {
        const p = slots.zonedParts(Number(r.startMs));
        const dayStart = slots.zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 });
        if (!byDay.has(dayStart)) byDay.set(dayStart, []);
        byDay.get(dayStart).push(r);
      }
      const matchedIds = [];
      const unmatched = [];
      for (const [dayStart, recs] of byDay) {
        let merged = [];
        try {
          merged = await store.listAppointments({ fromMs: dayStart, toMs: dayStart + 24 * 60 * 60 * 1000 }, event);
        } catch (e) {
          merged = [];
        }
        const hlEvents = (merged || []).filter((r) => r.source === 'highlevel' && r.hlEventId && !claimed.has(r.hlEventId));
        for (const rec of recs) {
          const recPhone = lib.digitsOnly(rec.phone || '');
          const hit = hlEvents.find((h) => {
            if (claimed.has(h.hlEventId)) return false;
            const hp = lib.digitsOnly(h.phone || '');
            if (!hp || !recPhone || hp !== recPhone) return false;
            // Same start, allowing 60s of HL timestamp rounding.
            return Math.abs(Number(h.startMs) - Number(rec.startMs)) <= 60000;
          });
          if (hit) {
            claimed.add(hit.hlEventId);
            await stamp(rec.id, { hlEventId: hit.hlEventId, hlSync: 'ok', hlError: null });
            matchedIds.push(rec.id);
          } else {
            unmatched.push({ id: rec.id, phone: rec.phone || '', name: rec.name || '', startISO: rec.startISO || null });
          }
        }
      }
      return ok({ matched: matchedIds.length, matchedIds, unmatched });
    }

    if (action === 'cancel') {
      const id = body.id || params.id;
      if (!id) return bad('Missing id.');
      let result;
      try {
        result = await store.cancelAppointment(id, event);
      } catch (e) {
        if (/not found|unknown/i.test(String((e && e.message) || e))) {
          return bad('Unknown appointment.');
        }
        throw e;
      }
      if (!result) return bad('Unknown appointment.');
      return ok({ ok: true });
    }

    return bad('Unknown action.');
  } catch (e) {
    return serverError(String((e && e.message) || e));
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  setAppointments(m) {
    apptsOverride = m || null;
  },
  reset() {
    apptsOverride = null;
  },
};

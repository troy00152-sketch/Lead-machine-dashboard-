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
//   POST {action:'cancel', id}
//
// Store failures -> 503, like the other cc APIs.
'use strict';

const crypto = require('crypto');

const lib = require('./telnyx-lib');

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
      const appointment = await store.createAppointment(
        {
          contactId,
          phone: phoneE164,
          name,
          title: cleanStr(body.title, 200) || 'Seller call — ' + name,
          startISO,
          endISO,
          startMs,
          endMs: startMs + minutes * 60000,
          source: 'manual',
          calendarId: store.CALENDAR_ID || 'seller-calls',
        },
        event
      );
      return ok({ ok: true, appointment });
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

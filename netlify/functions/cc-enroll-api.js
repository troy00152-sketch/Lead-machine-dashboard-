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

// netlify/functions/mail-webhook.js
// PostGrid tracking-event receiver for the Command Center direct-mail build.
//
// PostGrid Starter allows ONE webhook: register this endpoint URL in the
// PostGrid dashboard with enabled events postcard.created + postcard.updated.
// PostGrid posts one event per status change; this function updates the
// Blobs send log and, on delivery, tags the HighLevel contact
// `mail-delivered` (on a return, `mail-returned`).
//
// Delivery detection (PostGrid has no per-step "delivered" event type):
//   - postcard.updated with status "completed" (PostGrid sets status to
//     completed once the carrier reports delivery), OR carrierTracking
//     .status === "delivered".
//   - returned when imbStatus === "returned_to_sender".
//
// SECURITY — signature verification is mandatory, fail-closed:
//   PostGrid signs webhooks with the webhook secret (env var
//   POSTGRID_WEBHOOK_SECRET — Troy sets it in Netlify when he registers
//   this endpoint URL in PostGrid). Two payload formats are supported:
//     a) JWT (PostGrid's default): the whole body is a JWT signed with
//        HMAC-SHA256 using the secret. Verified here with Node built-ins
//        only (no JWT library): signature over header.payload, plus the
//        exp/iat claims when present (older than 5 minutes = stale).
//     b) JSON payload: PostGrid sends a `PostGrid-Signature` header.
//        Verified as HMAC-SHA256 of the raw body (hex or base64 digest).
//   Either scheme verifies. If POSTGRID_WEBHOOK_SECRET is unset, EVERY
//   request is rejected (503) — an unsigned event is never processed.
//   The raw body is verified BEFORE any JSON parsing.
//
// Event envelope (guides.postgrid.com): { id, type, createdAt, data:
// { id, object: "postcard", status, imbStatus, carrierTracking,
// metadata: {...}, ... } }. The parser also tolerates `event_type`
// for the type and a top-level resource, so a payload-shape change
// degrades to "ignored" instead of crashing.
//
// Responses are always 200 for a verified event (even unknown event types
// — PostGrid retries non-200s, and an unknown type is not an error). A bad
// signature is 401; a missing secret is 503 (webhook not configured).
'use strict';

const crypto = require('crypto');
const https = require('https');
const data = require('./mail-templates-data.js');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_API_VERSION = '2021-07-28';
const LOG_STORE = 'direct-mail-log';
const TOLERANCE_SECONDS = 300; // 5 minutes, replay protection

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, PostGrid-Signature',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

function base64urlDecode(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}
function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

// Pure verifier, exported for the fixture regression suite.
// headers: plain object with lowercase keys.
// Returns { ok, scheme?, payload?, reason? }. For the JWT scheme the
// decoded payload is returned so the handler never re-parses the body.
function verifySignature({ headers, rawBody, secret, nowMs }) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  const nowSec = Math.floor((nowMs || Date.now()) / 1000);
  const h = headers || {};
  const raw = String(rawBody || '');
  // Trimmed copy is used ONLY to recognise a JWT; the HMAC below always
  // runs over the exact raw bytes, so any tamper (even trailing space)
  // fails verification.
  const body = raw.trim();

  // Scheme (a): JWT — three base64url segments, HMAC-SHA256 signed.
  const parts = body.split('.');
  if (parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    let payload;
    try {
      payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
    } catch (e) {
      return { ok: false, reason: 'bad_jwt_payload' };
    }
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, reason: 'bad_jwt_payload' };
    }
    if (Number.isFinite(payload.exp) && nowSec > payload.exp) {
      return { ok: false, reason: 'stale_timestamp' };
    }
    if (Number.isFinite(payload.iat) && nowSec - payload.iat > TOLERANCE_SECONDS) {
      return { ok: false, reason: 'stale_timestamp' };
    }
    const expected = base64urlEncode(
      crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`, 'utf8').digest(),
    );
    if (!safeEqual(expected, parts[2])) return { ok: false, reason: 'signature_mismatch' };
    return { ok: true, scheme: 'jwt', payload };
  }

  // Scheme (b): JSON payload + PostGrid-Signature header (HMAC-SHA256
  // of the raw body, hex or base64).
  const pgSig = h['postgrid-signature'] || h['PostGrid-Signature'] || '';
  if (pgSig) {
    const hex = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
    const b64 = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64');
    if (safeEqual(hex, pgSig) || safeEqual(b64, pgSig)) {
      return { ok: true, scheme: 'postgrid-signature' };
    }
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: false, reason: 'no_signature' };
}

// Pure event parser, exported for fixtures.
function parsePostGridEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const eventType = body.type || body.event_type || '';
  const resource =
    body.data && typeof body.data === 'object'
      ? body.data
      : body.body && typeof body.body === 'object'
        ? body.body
        : body.resource || body;
  const postgridId = (resource && resource.id) || null;
  const metadata = (resource && resource.metadata) || {};
  const carrierStatus =
    (resource && resource.carrierTracking && resource.carrierTracking.status) || null;
  const status = (resource && resource.status) || null;
  const imbStatus = (resource && resource.imbStatus) || null;
  const delivered = status === 'completed' || carrierStatus === 'delivered';
  const returned =
    imbStatus === 'returned_to_sender' ||
    status === 'returned_to_sender' ||
    status === 'returned';
  return {
    eventType: String(eventType),
    postgridId: postgridId ? String(postgridId) : null,
    contactId: metadata.contactId ? String(metadata.contactId) : null,
    object: (resource && resource.object) || null,
    status,
    imbStatus,
    carrierStatus,
    delivered,
    returned,
    dateCreated: body.createdAt || body.date_created || null,
  };
}

function hlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: HL_API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}
function postJsonHttps(urlStr, { headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
          if (text.length > 1_000_000) req.destroy(new Error('Response too large'));
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.write(body);
    req.end();
  });
}
function getLogStoreFor(event) {
  // Same Blobs-context rule as mail-templates.js / mail-send.js (Nov 11
  // fix): connectLambda(event) must run before getStore(), or getStore()
  // throws MissingBlobsEnvironmentError in production. Never throws:
  // on any Blobs failure returns null and the webhook falls back to
  // tagging only (the log update is best-effort; the handler never 500s
  // a webhook retry loop on our own bug).
  if (!blobs) return null;
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) {
    /* best-effort; getStore may still work with ambient context */
  }
  try {
    return blobs.getStore(LOG_STORE);
  } catch (e) {
    return null;
  }
}

function getLogStore() {
  return getLogStoreFor(null);
}

async function updateLogEntry(store, parsed) {
  // Find the send entry by postgridId: entries live at
  // sends/<month>/<postgridId>.json. The month is not in the event, so
  // scan the current and previous month.
  if (!store || !parsed.postgridId) return false;
  const now = new Date();
  const months = [data.monthKey(now)];
  const prev = new Date(now);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  months.push(data.monthKey(prev));
  for (const month of months) {
    try {
      const key = `sends/${month}/${parsed.postgridId}.json`;
      const entry = await store.get(key, { type: 'json' });
      if (!entry) continue;
      entry.status = parsed.status || parsed.eventType.replace(/^postcard\./, '') || entry.status;
      if (parsed.delivered) entry.deliveredAt = new Date().toISOString();
      if (parsed.returned) entry.returnedAt = new Date().toISOString();
      entry.lastEventAt = new Date().toISOString();
      await store.setJSON(key, entry);
      return true;
    } catch (e) {
      /* keep scanning */
    }
  }
  return false;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (event.httpMethod !== 'POST') return json(400, { error: 'POST only.' });

    const secret = process.env.POSTGRID_WEBHOOK_SECRET || '';
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '';

    const check = verifySignature({
      headers: event.headers || {},
      rawBody,
      secret,
    });
    if (!check.ok) {
      if (check.reason === 'no_secret') return json(503, { error: 'Mail webhook is not configured yet (POSTGRID_WEBHOOK_SECRET missing).' });
      return json(401, { error: 'Bad webhook signature — event ignored.' });
    }

    let parsedBody;
    if (check.scheme === 'jwt') {
      parsedBody = check.payload;
    } else {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (e) {
        return json(200, { ok: true, ignored: 'not-json' });
      }
    }
    const parsed = parsePostGridEvent(parsedBody);
    if (!parsed || !parsed.eventType) return json(200, { ok: true, ignored: 'no-event-type' });

    const store = getLogStoreFor(event);
    const logUpdated = await updateLogEntry(store, parsed);

    // Delivery / return tags (best-effort; the log is the audit trail).
    let tagged = false;
    const tag = parsed.delivered ? 'mail-delivered' : parsed.returned ? 'mail-returned' : null;
    if (tag && parsed.contactId && process.env.HL_API_TOKEN) {
      try {
        const res = await postJsonHttps(
          `${HL_API_BASE}/contacts/${encodeURIComponent(parsed.contactId)}/tags`,
          { headers: hlHeaders(process.env.HL_API_TOKEN), body: JSON.stringify({ tags: [tag] }) },
        );
        tagged = res.status >= 200 && res.status < 300;
      } catch (e) {
        tagged = false;
      }
    }

    console.log(
      `mail-webhook event=${parsed.eventType} postgridId=${parsed.postgridId || '-'} status=${parsed.status || '-'} logUpdated=${logUpdated} tagged=${tagged}`,
    );
    return json(200, { ok: true, event: parsed.eventType, logUpdated, tagged });
  } catch (e) {
    // Never 500 a webhook retry loop on our own bug — log and ack.
    console.log(`mail-webhook error: ${String((e && e.message) || e).slice(0, 200)}`);
    return json(200, { ok: true, ignored: 'handler-error' });
  }
};

exports._test = {
  verifySignature,
  parsePostGridEvent,
  base64urlEncode,
  base64urlDecode,
  getLogStoreFor,
  // Test seam: swap the Blobs client (returns the previous one).
  _setBlobs: (b) => {
    const prev = blobs;
    blobs = b;
    return prev;
  },
};

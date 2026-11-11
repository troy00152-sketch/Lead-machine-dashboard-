// netlify/functions/mail-webhook.js
// Lob tracking-event receiver for the Command Center direct-mail build.
//
// Lob posts one event per tracking step (created, in_transit, in_local_area,
// processed_for_delivery, delivered, re_routed, returned_to_sender). This
// function updates the Blobs send log and, on delivery, tags the HighLevel
// contact `mail-delivered` (on a return, `mail-returned`).
//
// SECURITY — signature verification is mandatory, fail-closed:
//   Lob signs webhooks one of two ways (both are HMAC-SHA256 with the
//   webhook signing secret from the Lob dashboard, env var
//   LOB_WEBHOOK_SECRET — Troy sets it in Netlify when he registers this
//   endpoint URL in Lob):
//     a) Lob-Signature: "t=<unix seconds>,v1=<hex>" — signed message is
//        "<timestamp>.<raw body>" (hex digest).
//     b) Standard Webhooks headers: webhook-id / webhook-timestamp /
//        webhook-signature "v1,<base64>" — signed message is
//        "<webhook-id>.<webhook-timestamp>.<raw body>" (base64 digest).
//   Either scheme verifies; timestamps older than 5 minutes are rejected
//   (replay protection). If LOB_WEBHOOK_SECRET is unset, EVERY request is
//   rejected (401) — an unsigned event is never processed.
//   The raw body is verified BEFORE any JSON parsing.
//
// Lob event envelope (docs.lob.com): { id, event_type, date_created,
// body: { id, object: "postcard", metadata: {...}, ... } }. The handler
// also tolerates `type` for event_type and a top-level resource, so a
// Lob payload-shape change degrades to "ignored" instead of crashing.
//
// Responses are always 200 for a verified event (even unknown event types
// — Lob retries 4xx/5xx, and an unknown type is not an error). A bad
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
  'Access-Control-Allow-Headers': 'Content-Type, Lob-Signature, Lob-Signature-Timestamp, webhook-id, webhook-timestamp, webhook-signature',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

function parseLobSignature(header) {
  // "t=1712345678,v1=abcdef..." -> { t, v1 }
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(',')) {
    const [k, ...rest] = part.trim().split('=');
    if (k && rest.length) out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

// Pure verifier, exported for the fixture regression suite.
// headers: plain object with lowercase keys. Returns { ok, reason? }.
function verifySignature({ headers, rawBody, secret, nowMs }) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  const nowSec = Math.floor((nowMs || Date.now()) / 1000);
  const h = headers || {};

  // Scheme (a): Lob-Signature "t=...,v1=..." (+ optional timestamp header).
  const lobSig = h['lob-signature'] || h['Lob-Signature'] || '';
  if (lobSig) {
    const parts = parseLobSignature(lobSig);
    const t = parts.t || h['lob-signature-timestamp'] || h['Lob-Signature-Timestamp'] || '';
    const v1 = parts.v1 || '';
    if (!t || !v1) return { ok: false, reason: 'bad_lob_signature_format' };
    const ts = parseInt(t, 10);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TOLERANCE_SECONDS)
      return { ok: false, reason: 'stale_timestamp' };
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${t}.${rawBody}`, 'utf8')
      .digest('hex');
    if (!safeEqualHex(expected, v1)) return { ok: false, reason: 'signature_mismatch' };
    return { ok: true, scheme: 'lob' };
  }

  // Scheme (b): Standard Webhooks — webhook-signature "v1,<base64>".
  const whSig = h['webhook-signature'] || h['Webhook-Signature'] || '';
  const whId = h['webhook-id'] || h['Webhook-Id'] || '';
  const whTs = h['webhook-timestamp'] || h['Webhook-Timestamp'] || '';
  if (whSig && whId && whTs) {
    const ts = parseInt(whTs, 10);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TOLERANCE_SECONDS)
      return { ok: false, reason: 'stale_timestamp' };
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${whId}.${whTs}.${rawBody}`, 'utf8')
      .digest('base64');
    const candidates = String(whSig)
      .split(' ')
      .map((s) => s.replace(/^v1,/, '').trim())
      .filter(Boolean);
    for (const c of candidates) {
      if (safeEqualHex(expected, c)) return { ok: true, scheme: 'standard-webhooks' };
    }
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: false, reason: 'no_signature' };
}

// Pure event parser, exported for fixtures.
function parseLobEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const eventType = body.event_type || body.type || '';
  const resource = body.body && typeof body.body === 'object' ? body.body : body.resource || body;
  const lobId = (resource && resource.id) || null;
  const metadata = (resource && resource.metadata) || {};
  return {
    eventType: String(eventType),
    lobId: lobId ? String(lobId) : null,
    contactId: metadata.contactId ? String(metadata.contactId) : null,
    object: (resource && resource.object) || null,
    dateCreated: body.date_created || null,
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
function getLogStore() {
  if (!blobs) return null;
  return blobs.getStore(LOG_STORE);
}

async function updateLogEntry(store, parsed) {
  // Find the send entry by lobId: entries live at sends/<month>/<lobId>.json.
  // The month is not in the event, so scan the current and previous month.
  if (!store || !parsed.lobId) return false;
  const now = new Date();
  const months = [data.monthKey(now)];
  const prev = new Date(now);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  months.push(data.monthKey(prev));
  for (const month of months) {
    try {
      const key = `sends/${month}/${parsed.lobId}.json`;
      const entry = await store.get(key, { type: 'json' });
      if (!entry) continue;
      entry.status = parsed.eventType.replace(/^postcard\./, '') || entry.status;
      if (parsed.eventType === 'postcard.delivered') entry.deliveredAt = new Date().toISOString();
      if (parsed.eventType === 'postcard.returned_to_sender') entry.returnedAt = new Date().toISOString();
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

    const secret = process.env.LOB_WEBHOOK_SECRET || '';
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '';

    const check = verifySignature({
      headers: event.headers || {},
      rawBody,
      secret,
    });
    if (!check.ok) {
      if (check.reason === 'no_secret') return json(503, { error: 'Mail webhook is not configured yet (LOB_WEBHOOK_SECRET missing).' });
      return json(401, { error: 'Bad webhook signature — event ignored.' });
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (e) {
      return json(200, { ok: true, ignored: 'not-json' });
    }
    const parsed = parseLobEvent(parsedBody);
    if (!parsed || !parsed.eventType) return json(200, { ok: true, ignored: 'no-event-type' });

    const store = getLogStore();
    const logUpdated = await updateLogEntry(store, parsed);

    // Delivery / return tags (best-effort; the log is the audit trail).
    let tagged = false;
    const tag =
      parsed.eventType === 'postcard.delivered'
        ? 'mail-delivered'
        : parsed.eventType === 'postcard.returned_to_sender'
          ? 'mail-returned'
          : null;
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
      `mail-webhook event=${parsed.eventType} lobId=${parsed.lobId || '-'} logUpdated=${logUpdated} tagged=${tagged}`,
    );
    return json(200, { ok: true, event: parsed.eventType, logUpdated, tagged });
  } catch (e) {
    // Never 500 a webhook retry loop on our own bug — log and ack.
    console.log(`mail-webhook error: ${String((e && e.message) || e).slice(0, 200)}`);
    return json(200, { ok: true, ignored: 'handler-error' });
  }
};

exports._test = { verifySignature, parseLobEvent, parseLobSignature };

// netlify/functions/telnyx-webhook.js
// Receives Telnyx messaging webhooks for the standalone Command Center
// and maintains the conversation store the Conversations UI reads.
//
// Events handled (Telnyx API v2 webhook envelope: {data:{event_type,
// payload}}):
//   message.received  -> append inbound message to the contact's thread,
//                        bump unread, refresh the thread index; then
//                        fire-and-forget cc-bot-hook.processInbound(key)
//                        (Phase 5 bot adapter — direct module call, the
//                        same pattern cc-workflow-tick.js uses for the
//                        engine; the bot hook NEVER blocks or fails the
//                        webhook ack)
//   message.sent      -> outbound message status -> 'sent'
//   message.finalized -> outbound terminal status from payload.to[].status
//                        ('delivered' -> delivered; 'delivery_failed' /
//                        'failed' / 'sending_failed' -> failed + reason)
//   message.failed    -> outbound status -> 'failed' + reason (defensive;
//                        Telnyx normally reports failures via finalized)
//
// Store (Netlify Blobs, store 'cc-conversations'):
//   <phoneDigits>  -> {phone, name, market, unread, updatedAt,
//                      messages: [{id, dir:'in'|'out', body, status, at,
//                                  from, to, failureReason?}]}
//   index          -> {updatedAt, threads: {<phoneDigits>: {phone, name,
//                      market, preview, lastAt, lastDir, unread}}}
// Message status values: queued | sent | delivered | failed | received
// (inbound). Status never moves backwards (delivered stays delivered).
//
// Signature verification: Telnyx signs webhooks with Ed25519 — headers
// 'telnyx-signature-ed25519' + 'telnyx-timestamp', signed content is
// "<timestamp>|<raw body>", public key in TELNYX_PUBLIC_KEY (base64).
// PRE-LAUNCH TODO: set TELNYX_PUBLIC_KEY in Netlify env before go-live.
// Until it is configured we log a warning and still process the event
// (the store is internal-only; the API that reads it is lm_auth-gated).
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');
const botHook = require('./cc-bot-hook');

const STORE_NAME = 'cc-conversations';
const INDEX_KEY = 'index';
const MAX_MESSAGES_PER_THREAD = 500;

// ---- store access (overridable for tests) ----
let storeFactory = null;
function convStore(event) {
  if (storeFactory) return storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
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

function emptyThread(phoneE164, key) {
  return { phone: phoneE164, key, name: '', market: '', unread: 0, updatedAt: 0, messages: [] };
}
async function loadThread(s, key) {
  const t = await readJson(s, key);
  if (t && Array.isArray(t.messages)) return t;
  return emptyThread('+' + key, key);
}
async function saveThread(s, thread) {
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  await writeJson(s, thread.key, thread);
  // refresh index entry
  const idx = (await readJson(s, INDEX_KEY)) || { updatedAt: 0, threads: {} };
  const last = thread.messages[thread.messages.length - 1] || null;
  idx.threads[thread.key] = {
    phone: thread.phone,
    name: thread.name || '',
    market: thread.market || '',
    preview: last ? String(last.body || '').slice(0, 120) : '',
    lastAt: last ? last.at : thread.updatedAt || 0,
    lastDir: last ? last.dir : null,
    unread: thread.unread || 0,
  };
  idx.updatedAt = Date.now();
  await writeJson(s, INDEX_KEY, idx);
}

// Which market does one of OUR numbers belong to? (Pools are empty until
// numbers are purchased; unknown numbers leave the market as-is.)
function marketForOurNumber(e164) {
  for (const [market, pool] of Object.entries(lib.SENDER_POOLS)) {
    if (pool.includes(e164)) return market;
  }
  return '';
}

// Status ordering so late/duplicate webhooks never move a message
// backwards (e.g. a 'sent' event arriving after 'delivered').
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, failed: 2, received: 2 };
function applyStatus(msg, status, failureReason) {
  const cur = STATUS_RANK[msg.status] != null ? STATUS_RANK[msg.status] : 0;
  const nxt = STATUS_RANK[status];
  if (nxt == null) return false;
  if (msg.status === 'delivered' && status !== 'delivered') return false;
  if (nxt < cur) return false;
  msg.status = status;
  if (status === 'failed') msg.failureReason = failureReason || msg.failureReason || 'Delivery failed';
  return true;
}

function failureReasonFrom(payload) {
  const to = (payload && payload.to && payload.to[0]) || {};
  const errs = to.errors || payload.errors || [];
  if (errs.length) {
    const e = errs[0] || {};
    return e.detail || e.title || e.code || 'Delivery failed';
  }
  return 'Delivery failed';
}

// Map a message.finalized payload to {status, failureReason?}.
function finalizedStatus(payload) {
  const to = (payload && payload.to && payload.to[0]) || {};
  const st = String(to.status || payload.status || '').toLowerCase();
  if (st === 'delivered') return { status: 'delivered' };
  if (st === 'delivery_failed' || st === 'failed' || st === 'sending_failed' || st === 'invalid') {
    return { status: 'failed', failureReason: failureReasonFrom(payload) };
  }
  if (st === 'sent') return { status: 'sent' };
  return null;
}

// ---- core event application (pure store logic; unit-tested) ----
async function applyEvent(s, evt) {
  const type = evt && evt.event_type;
  const payload = (evt && evt.payload) || {};
  const msgId = payload.id || null;

  if (type === 'message.received') {
    const from = payload.from && payload.from.phone_number;
    const to0 = payload.to && payload.to[0] && payload.to[0].phone_number;
    if (!from) return { handled: false, reason: 'no from' };
    const key = lib.phoneKey(from);
    const thread = await loadThread(s, key);
    thread.phone = lib.toE164(from);
    if (to0) {
      const m = marketForOurNumber(lib.toE164(to0));
      if (m) thread.market = m;
    }
    if (msgId && thread.messages.some((m) => m.id === msgId)) {
      return { handled: true, duplicate: true }; // Telnyx retries webhooks
    }
    thread.messages.push({
      id: msgId || 'in-' + Date.now(),
      dir: 'in',
      body: String(payload.text || ''),
      status: 'received',
      at: Date.parse(payload.received_at || '') || Date.now(),
      from: thread.phone,
      to: to0 || '',
    });
    thread.unread = (thread.unread || 0) + 1;
    thread.updatedAt = Date.now();
    await saveThread(s, thread);
    return { handled: true, thread: key };
  }

  if (type === 'message.sent' || type === 'message.finalized' || type === 'message.failed') {
    const to0 = payload.to && payload.to[0] && payload.to[0].phone_number;
    if (!to0 || !msgId) return { handled: false, reason: 'no to/id' };
    const key = lib.phoneKey(to0);
    const thread = await loadThread(s, key);
    const msg = thread.messages.find((m) => m.id === msgId);
    if (!msg) return { handled: false, reason: 'message not in store yet', thread: key };
    let target = null;
    if (type === 'message.sent') target = { status: 'sent' };
    else if (type === 'message.failed') target = { status: 'failed', failureReason: failureReasonFrom(payload) };
    else target = finalizedStatus(payload);
    if (!target) return { handled: false, reason: 'unmapped finalized status' };
    const changed = applyStatus(msg, target.status, target.failureReason);
    if (changed) {
      thread.updatedAt = Date.now();
      await saveThread(s, thread);
    }
    return { handled: true, changed, thread: key };
  }

  return { handled: false, reason: 'unhandled event type: ' + type };
}

// ---- signature verification (Ed25519) ----
function verifySignature(rawBody, headers) {
  const pubB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!pubB64) return { configured: false, valid: true }; // see header TODO
  const sigB64 = headers['telnyx-signature-ed25519'];
  const ts = headers['telnyx-timestamp'];
  if (!sigB64 || !ts) return { configured: true, valid: false };
  try {
    const rawKey = Buffer.from(pubB64, 'base64');
    // Wrap the raw 32-byte Ed25519 key in an SPKI DER envelope.
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    const data = Buffer.from(String(ts) + '|' + rawBody, 'utf8');
    const sig = Buffer.from(sigB64, 'base64');
    return { configured: true, valid: crypto.verify(null, data, key, sig) };
  } catch (e) {
    return { configured: true, valid: false, error: String((e && e.message) || e) };
  }
}

exports.handler = async (event) => {
  const respond = (status, obj) => ({
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  try {
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });
    let raw = event.body || '';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');

    const sig = verifySignature(raw, event.headers || {});
    if (!sig.configured) {
      console.warn('[telnyx-webhook] TELNYX_PUBLIC_KEY not set — processing unverified webhook (pre-launch TODO).');
    } else if (!sig.valid) {
      return respond(400, { error: 'Invalid webhook signature' });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return respond(400, { error: 'Bad JSON' });
    }
    const evt = parsed && parsed.data ? parsed.data : parsed;
    const s = convStore(event);
    const result = await applyEvent(s, evt);
    // Phase 5: hand inbound messages to the bot adapter, fire-and-forget.
    // Duplicates (Telnyx retries) are skipped — applyEvent already
    // deduped them, and the bot must never answer the same text twice.
    if (
      evt && evt.event_type === 'message.received' &&
      result && result.handled && result.thread && !result.duplicate
    ) {
      try {
        const p = botHook.processInbound(result.thread, event);
        if (p && typeof p.catch === 'function') {
          p.catch((e) => console.error('[telnyx-webhook] bot hook failed:', e));
        }
      } catch (e) {
        console.error('[telnyx-webhook] bot hook failed:', e);
      }
    }
    return respond(200, { received: true, ...result });
  } catch (e) {
    console.error('[telnyx-webhook]', e);
    // 200 on internal errors would hide real bugs during the build phase;
    // Telnyx retries on 5xx, which is what we want for transient store errors.
    return respond(500, { error: String((e && e.message) || e) });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  applyEvent,
  finalizedStatus,
  applyStatus,
  verifySignature,
  setStoreFactory(fn) {
    storeFactory = fn;
  },
};

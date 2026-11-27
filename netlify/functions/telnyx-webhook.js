// netlify/functions/telnyx-webhook.js
// Receives Telnyx messaging webhooks for the standalone Command Center
// and maintains the conversation store the Conversations UI reads.
//
// Events handled (Telnyx API v2 webhook envelope: {data:{event_type,
// payload}}):
//   message.received  -> append inbound message to the contact's thread,
//                        bump unread, refresh the thread index; then
//                        AWAIT cc-bot-hook.processInbound(key) (bounded,
//                        BOT_HOOK_TIMEOUT_MS) — Phase 5 bot adapter,
//                        direct module call, the same pattern
//                        cc-workflow-tick.js uses for the engine. The
//                        await is load-bearing: fire-and-forget let the
//                        Lambda freeze on the 200 and kill the in-flight
//                        LLM call + send (Nov 26, 2026 — two live Paula
//                        texts, bot silent). The bot hook NEVER fails
//                        the webhook ack (timeout/error only logs).
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
const push = require('./cc-push');

const STORE_NAME = 'cc-conversations';
const INDEX_KEY = 'index';
const MAX_MESSAGES_PER_THREAD = 500;

// Bound on the bot-hook await (Nov 26, 2026 silent-bot fix). Budget
// math (Nov 27, 2026 fix): cold build ~3–5s + LLM abort at 15s
// (bot/src/llm.js llmTimeoutMs, default 15000 — the old 25s default
// is why a slow reply was abandoned at 22s with no reply and no
// botLog entry: 25s + ~1s send > 22s) + ~1s for the Telnyx send fits
// inside 22s with margin; the push await below is bounded ~3s inside
// cc-push, so the worst case stays inside the 26s function budget
// (netlify.toml [functions."telnyx-webhook"]). On timeout the webhook
// still acks 200 — Telnyx retries are deduped by applyEvent, so a slow
// first attempt can never double-reply.
const BOT_HOOK_TIMEOUT_MS = 22000;

// Test-only bot-hook override (see _test.setBotHook below).
let botHookOverride = null;

// Test-only Telnyx lookup fetch (see _test.setTelnyxFetch): the
// reconciliation sweep calls lib.getMessage with it when set.
const deps = { telnyxFetch: null };

// hasBotDecisionFor (FIX D, Nov 27 2026): did the bot already
// evaluate this inbound? True when ANY of these hold:
//   (a) a botLog entry carries this message's id (every entry the
//       hook writes now carries messageId — FIX A/B/C);
//   (b) a PRE-FIX botLog entry matches by body + recency (entries
//       land within seconds of processing, so a 5-minute window is
//       generous; two different texts with the same body inside the
//       window are the known false-positive — it fails toward a
//       skipped re-evaluation, never toward a double reply);
//   (c) a bot outbound already sits after this inbound on the thread.
// Anything else means "not yet evaluated" — a Telnyx retry must
// re-run the hook instead of being dropped as a duplicate.
function hasBotDecisionFor(thread, msg) {
  if (!thread || !msg || !msg.id) return false;
  const log = Array.isArray(thread.botLog) ? thread.botLog : [];
  if (log.some((e) => e && e.messageId && String(e.messageId) === String(msg.id))) return true;
  const body = String(msg.body || '');
  const at = msg.at || 0;
  if (body && log.some((e) => e && !e.messageId && String(e.inbound || '') === body && Math.abs((e.at || 0) - at) <= 5 * 60 * 1000)) return true;
  if (Array.isArray(thread.messages) && thread.messages.some((m) => m && m.dir === 'out' && m.via === 'bot' && (m.at || 0) >= at)) return true;
  return false;
}

// Bounded await — same race pattern as cc-push.withTimeout: the
// timeout resolves {timedOut:true} while the underlying promise keeps
// running; a rejection is reported as {timedOut:false, error} so the
// race itself never rejects and a late failure can't surface as an
// unhandled rejection after the timeout wins.
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const wrapped = Promise.resolve(promise).then(
    (value) => ({ timedOut: false, value }),
    (error) => ({ timedOut: false, error })
  );
  return Promise.race([wrapped, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

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
  // Merge-atomic (§3): re-read immediately before writing and union
  // messages by id, so a concurrent writer's messages (e.g. the bot
  // appending its reply while a delivery receipt lands) are never
  // wiped by this write. In-memory entries win on an id conflict;
  // dnd is OR (a seal is never unwritten here); unread takes the max
  // (the webhook only ever bumps it — never lower it here).
  const fresh = await readJson(s, thread.key);
  if (fresh && Array.isArray(fresh.messages)) {
    const byId = new Map();
    for (const m of fresh.messages) if (m && m.id) byId.set(m.id, m);
    for (const m of thread.messages) if (m && m.id) byId.set(m.id, m);
    const merged = [...byId.values()];
    const tripleOf = (m) => (m.dir || '') + '|' + (m.at || '') + '|' + String(m.body || '');
    const seenTriples = new Set(merged.map(tripleOf));
    for (const src of [fresh.messages, thread.messages]) {
      for (const m of src) {
        if (!m || m.id) continue;
        const t = tripleOf(m);
        if (!seenTriples.has(t)) {
          merged.push(m);
          seenTriples.add(t);
        }
      }
    }
    merged.sort((a, b) => (a.at || 0) - (b.at || 0));
    thread.messages = merged;
    if (fresh.dnd === true) thread.dnd = true;
    thread.unread = Math.max(fresh.unread || 0, thread.unread || 0);
    thread.updatedAt = Math.max(fresh.updatedAt || 0, thread.updatedAt || 0);
    if (!thread.phone && fresh.phone) thread.phone = fresh.phone;
    if (!thread.market && fresh.market) thread.market = fresh.market;
    if (!thread.name && fresh.name) thread.name = fresh.name;
    if (!thread.ourNumber && fresh.ourNumber) thread.ourNumber = fresh.ourNumber;
  }
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
      // The number the seller wrote TO is the number we text them
      // from — the Conversations UI shows it as "Texting from".
      try {
        thread.ourNumber = lib.toE164(to0);
      } catch (e) {
        thread.ourNumber = to0;
      }
      const m = marketForOurNumber(lib.toE164(to0));
      if (m) thread.market = m;
    }
    if (msgId && thread.messages.some((m) => m.id === msgId)) {
      // Telnyx retries webhooks — but a retry is NOT always a
      // duplicate evaluation (FIX D, Nov 27 2026): the first attempt
      // may have stored the message and then never run the hook (or
      // run it and left no botLog — the Stephanie '325k' class). Run
      // the hook again when no bot decision exists for this message
      // id; dedupe on 'already evaluated', not 'already stored'.
      const inboundMsg = thread.messages.find((m) => m.id === msgId);
      const evaluated = hasBotDecisionFor(thread, inboundMsg);
      return {
        handled: true,
        duplicate: true,
        thread: key,
        needsBotRetry: !evaluated,
        message: inboundMsg
          ? { id: inboundMsg.id, body: inboundMsg.body, at: inboundMsg.at, to: inboundMsg.to, from: inboundMsg.from }
          : null,
      };
    }
    const appended = {
      id: msgId || 'in-' + Date.now(),
      dir: 'in',
      body: String(payload.text || ''),
      status: 'received',
      at: Date.parse(payload.received_at || '') || Date.now(),
      from: thread.phone,
      to: to0 || '',
    };
    thread.messages.push(appended);
    thread.unread = (thread.unread || 0) + 1;
    thread.updatedAt = Date.now();
    await saveThread(s, thread);
    return {
      handled: true,
      thread: key,
      name: thread.name,
      phone: thread.phone,
      preview: String(payload.text || '').slice(0, 120),
      // FIX A: the exact inbound just stored — processInbound trusts
      // this instead of re-reading a possibly lagging replica.
      message: { id: appended.id, body: appended.body, at: appended.at, to: appended.to, from: appended.from },
    };
  }

  if (type === 'message.sent' || type === 'message.finalized' || type === 'message.failed') {
    const to0 = payload.to && payload.to[0] && payload.to[0].phone_number;
    if (!to0 || !msgId) return { handled: false, reason: 'no to/id' };
    const key = lib.phoneKey(to0);
    const thread = await loadThread(s, key);
    const msg = thread.messages.find((m) => m.id === msgId);
    if (!msg) {
      // Log, don't swallow (§4): an unmatched status event means a
      // delivery receipt arrived for a message the store never saw —
      // a send that raced the webhook, or an id that was never stored
      // — and until Nov 27 this returned handled:false in silence, so
      // "0 SENT TODAY" had no trail at all. The return shape is
      // unchanged (handled:false); only the silence is gone.
      console.error('[telnyx-webhook] ' + type + ' for unknown message id ' + msgId + ' to ' + to0 + ' — message not in store yet');
      return { handled: false, reason: 'message not in store yet', thread: key };
    }
    let target = null;
    if (type === 'message.sent') target = { status: 'sent' };
    else if (type === 'message.failed') target = { status: 'failed', failureReason: failureReasonFrom(payload) };
    else target = finalizedStatus(payload);
    if (!target) {
      console.error('[telnyx-webhook] ' + type + ' for message id ' + msgId + ' to ' + to0 + ' — unmapped finalized status: ' + JSON.stringify((payload.to && payload.to[0] && payload.to[0].status) || payload.status || ''));
      return { handled: false, reason: 'unmapped finalized status' };
    }
    const changed = applyStatus(msg, target.status, target.failureReason);
    if (changed) {
      thread.updatedAt = Date.now();
      await saveThread(s, thread);
    }
    return { handled: true, changed, thread: key };
  }

  return { handled: false, reason: 'unhandled event type: ' + type };
}

// ---- delivery reconciliation (FIX E, Nov 27 2026) ----
// Stored outbounds never advance past 'queued' when the
// message.sent / message.finalized webhook never lands — the "0
// SENT TODAY" class. The status branch above is verified correct in
// code, so the likely break is upstream (the webhook URL configured
// on the Telnyx messaging profile — that portal check is still owed
// and cannot be fixed from code) plus a race with no retry: a
// receipt that arrives before the send is stored, or a lost webhook,
// leaves the message 'queued' forever. This sweep re-checks
// stuck-queued messages against Telnyx directly (GET /v2/messages/{id})
// and advances them through the same finalizedStatus/applyStatus path
// the webhook uses. Bounded per tick (the 1/min cc-inbound-sweep
// calls it): only messages 'queued' longer than STALE_MS, only
// recent traffic, at most MAX_PER_TICK lookups, and a message is not
// re-asked more often than RECHECK_MS — a Telnyx-side 'queued' that
// never terminalizes must not burn a lookup every minute forever.
// Messages whose id never reached Telnyx ('pending-*' / 'in-*'
// placeholders) are skipped — there is nothing to look up.
const RECONCILE_STALE_MS = 10 * 60 * 1000;
const RECONCILE_RECHECK_MS = 60 * 60 * 1000;
const RECONCILE_MAX_PER_TICK = 10;
const RECONCILE_WINDOW_MS = 48 * 60 * 60 * 1000;

async function reconcileQueuedStatuses(event, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const maxPerTick = typeof o.maxPerTick === 'number' ? o.maxPerTick : RECONCILE_MAX_PER_TICK;
  const fetchImpl = o.fetchImpl || deps.telnyxFetch || globalThis.fetch;
  const apiKey = o.apiKey || process.env.TELNYX_API_KEY;
  if (!apiKey) return { ok: false, reason: 'TELNYX_API_KEY not configured', checked: 0, advanced: 0, stillQueued: 0, failed: 0, checkedIds: [] };
  const s = convStore(event);
  const idx = (await readJson(s, INDEX_KEY)) || { threads: {} };
  const keys = Object.keys(idx.threads || {});
  let checked = 0;
  let advanced = 0;
  let stillQueued = 0;
  let failed = 0;
  const checkedIds = [];
  for (const key of keys) {
    if (checked >= maxPerTick) break;
    const thread = await loadThread(s, key);
    let dirty = false;
    for (const m of thread.messages) {
      if (checked >= maxPerTick) break;
      if (!m || m.dir !== 'out' || m.status !== 'queued') continue;
      if (!m.id || /^(pending|in)-/.test(String(m.id))) continue;
      const at = m.at || 0;
      if (!at || now - at < RECONCILE_STALE_MS) continue;
      if (now - at > RECONCILE_WINDOW_MS) continue;
      if (m.reconciledAt && now - m.reconciledAt < RECONCILE_RECHECK_MS) continue;
      checked += 1;
      checkedIds.push(m.id);
      try {
        const data = await lib.getMessage({ id: m.id, apiKey, fetchImpl });
        m.reconciledAt = now;
        const target = finalizedStatus(data);
        if (target && applyStatus(m, target.status, target.failureReason)) {
          advanced += 1;
        } else {
          // Telnyx still says queued/sending (or an unmapped state):
          // leave the message queued — the re-check backoff below
          // keeps this from burning a lookup every minute.
          stillQueued += 1;
        }
      } catch (e) {
        // A failed lookup (auth, outage, deleted message) is logged
        // and stamped too — retrying it every minute cannot fix it,
        // and it must not starve the rest of the batch.
        m.reconciledAt = now;
        failed += 1;
        console.error('[telnyx-webhook] reconcile lookup failed for ' + m.id + ':', String((e && e.message) || e));
      }
      dirty = true;
    }
    if (dirty) {
      thread.updatedAt = Math.max(thread.updatedAt || 0, now);
      await saveThread(s, thread);
    }
  }
  return { ok: true, checked, advanced, stillQueued, failed, checkedIds };
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
    // Phase 5: hand inbound messages to the bot adapter — AWAITED,
    // bounded (BOT_HOOK_TIMEOUT_MS). Nov 26, 2026 lesson: this used to
    // be fire-and-forget, so the Lambda froze the moment the handler
    // returned 200 and killed the in-flight LLM call + send — the bot
    // stayed silent on two live Paula texts (10:37 + 10:44 PM) even
    // though both reached the thread. Duplicates (Telnyx retries) are
    // skipped — applyEvent already deduped them, and the bot must
    // never answer the same text twice — EXCEPT when the first
    // attempt never evaluated the message (FIX D): then
    // needsBotRetry is true and the hook runs, deduping on 'already
    // evaluated' instead of 'already stored'. The exact inbound just
    // stored is passed through (FIX A) so the hook never has to
    // re-read a lagging replica to find it.
    if (
      evt && evt.event_type === 'message.received' &&
      result && result.handled && result.thread &&
      (!result.duplicate || result.needsBotRetry)
    ) {
      try {
        const hook = botHookOverride || botHook.processInbound;
        const timed = await withTimeout(hook(result.thread, event, result.message || null), BOT_HOOK_TIMEOUT_MS);
        if (timed.timedOut) {
          console.error('[telnyx-webhook] bot hook timed out after ' + BOT_HOOK_TIMEOUT_MS + 'ms — reply may not have sent');
        } else if (timed.error) {
          console.error('[telnyx-webhook] bot hook failed:', timed.error);
        } else if (timed.value && timed.value.handled === false) {
          // FIX A: an unhandled hook result used to vanish — the Nov 27
          // 'no inbound message on thread' silence had no trail here
          // either. Log it with the message id so the miss is findable.
          console.error('[telnyx-webhook] bot hook returned unhandled for thread ' + result.thread
            + ' message ' + (result.message && result.message.id)
            + ' — reason: ' + (timed.value.reason || 'unknown'));
        }
      } catch (e) {
        console.error('[telnyx-webhook] bot hook failed:', e);
      }
    }
    // Phone push: seller reply — same gate as the bot hook (handled,
    // not a Telnyx retry duplicate). Awaited but bounded inside
    // cc-push (never throws, never past ~3s) so a reply push is
    // never silently dropped by a frozen lambda.
    if (
      evt && evt.event_type === 'message.received' &&
      result && result.handled && result.thread && !result.duplicate
    ) {
      try {
        await push.notifyReply({
          threadKey: result.thread,
          name: result.name,
          phone: result.phone,
          preview: result.preview,
          at: Date.now(),
        }, event);
      } catch (e) {
        console.error('[telnyx-webhook] push failed:', e);
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

exports.reconcileQueuedStatuses = reconcileQueuedStatuses;

// Test hooks (not part of the deployed surface).
exports._test = {
  applyEvent,
  finalizedStatus,
  applyStatus,
  verifySignature,
  hasBotDecisionFor,
  reconcileQueuedStatuses,
  setStoreFactory(fn) {
    storeFactory = fn;
  },
  // Test-only Telnyx lookup fetch for the reconciliation sweep
  // (null restores global fetch).
  setTelnyxFetch(fn) {
    deps.telnyxFetch = fn || null;
  },
  // Test-only bot-hook override: setBotHook(fn) replaces the
  // processInbound call the handler awaits (null restores the real
  // hook). Lets tests prove the handler waits for a slow hook before
  // responding 200.
  setBotHook(fn) {
    botHookOverride = typeof fn === 'function' ? fn : null;
  },
  reset() {
    storeFactory = null;
    deps.telnyxFetch = null;
    botHookOverride = null;
  },
};

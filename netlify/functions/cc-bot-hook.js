// netlify/functions/cc-bot-hook.js
// Phase 5 of the standalone Command Center build: the bot adapter.
//
// Invoked whenever an inbound SMS lands in the 'cc-conversations' store.
// telnyx-webhook.js calls processInbound() directly (module call — the
// same pattern cc-workflow-tick.js uses for cc-workflow-engine.js; no
// network hop, no secret needed inside the same deploy). This file also
// exposes an HTTP handler so the hook can be triggered/replayed
// externally; the handler is protected by the SAME shared-secret scheme
// as cc-workflow-tick.js (header `x-cc-tick-secret` vs CC_TICK_SECRET,
// FAIL CLOSED when the env var is unset).
//
// What it does, in order:
//   1. Load the thread (cc-conversations) + enrollment (cc-enrollments).
//   2. OPT-OUT SEAL, in the adapter itself (mirrors the HL platform):
//      if the latest inbound is exactly an opt-out keyword (STOP / OUT /
//      END / QUIT / UNSUBSCRIBE / CANCEL, case/punctuation-insensitive),
//      the enrollment is sealed immediately — `dnc` tag added, dnd=true —
//      with NO bot call and NO reply. 24/7, before anything else.
//   3. Already-sealed contacts (dnc tag / dnd) never reach the bot.
//   4. Assemble the bot input in the shape the custom-bot handler works
//      with (contact + HL-shaped customFields {id, value} for pricing,
//      tags, full thread history, the triggering inbound) and hand it to
//      the bot through a configurable transport:
//        CC_BOT_LOCAL=1 + runner configured -> the REAL vendored bot
//                                    brain runs in-process against the
//                                    standalone stores (cc-bot-runner
//                                    -> cc-client). Wins over the URL
//                                    transport; sends/tags/seals happen
//                                    inside the bot via cc-client.
//        CC_BOT_WEBHOOK_URL set   -> POST the payload there; apply the
//                                    returned actions (contract below).
//        neither                  -> LOG-ONLY mode: the decision
//                                    'bot-skipped: no transport configured'
//                                    is recorded on the thread and NOTHING
//                                    is sent. We never invent a reply.
//
// Bot response contract (JSON):
//   { "actions": [
//       { "type": "reply",  "body": "text to send" },
//       { "type": "addTags", "tags": ["tag one", "tag two"] },
//       { "type": "seal" },                      // dnc tag + DND
//       { "type": "silence" }                    // explicit no-op
//   ]}
// Shorthand also accepted: { "reply": "...", "tags": [...], "seal": true }.
// A transport error or unparseable response is logged on the thread as a
// bot-error and produces SILENCE — same doctrine as the bot itself
// (generation failure => no fallback text, ever).
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');

const CONV_STORE = 'cc-conversations';
const ENROLL_STORE = 'cc-enrollments';
const MAX_MESSAGES_PER_THREAD = 500;
const MAX_BOT_LOG = 50;

// HL custom-field IDs for the pricing trio (production HL shape:
// customFields = {id, value} ONLY — see the zero-mistake release rule).
const PRICING_FIELD_IDS = {
  arv: 'cOE6XmJNOdVKsDNpiGqR',
  mao: 'B8Mfg1TQfjjo4Dl214A2',
  lao: 'JUPzLFhe7VG0PCJqL0n8',
};

// Carrier/HL platform opt-out keywords. A reply whose ENTIRE body is one
// of these (after trim + case/punctuation normalization) is an opt-out.
const OPT_OUT_KEYWORDS = ['STOP', 'OUT', 'END', 'QUIT', 'UNSUBSCRIBE', 'CANCEL'];
function optOutKeyword(body) {
  const t = String(body == null ? '' : body).trim().toUpperCase().replace(/[^A-Z]/g, '');
  return OPT_OUT_KEYWORDS.includes(t) ? t : null;
}

// ---- injectable dependencies (tests) ----
const deps = { convStoreFactory: null, enrollStoreFactory: null, fetch: null, sendSms: null };
function fetchImpl() {
  return deps.fetch || globalThis.fetch;
}
function sendSmsImpl() {
  return deps.sendSms || lib.sendSms;
}

function makeStore(name, factory, event) {
  if (factory) return factory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(name);
}
function convStore(event) {
  return makeStore(CONV_STORE, deps.convStoreFactory, event);
}
function enrollStore(event) {
  return makeStore(ENROLL_STORE, deps.enrollStoreFactory, event);
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

async function loadThread(s, key) {
  const t = await readJson(s, key);
  if (t && Array.isArray(t.messages)) return t;
  return { phone: '+' + key, key, name: '', market: '', unread: 0, updatedAt: 0, messages: [] };
}
async function saveThread(s, thread) {
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  if (Array.isArray(thread.botLog) && thread.botLog.length > MAX_BOT_LOG) {
    thread.botLog = thread.botLog.slice(-MAX_BOT_LOG);
  }
  await writeJson(s, thread.key, thread);
  const idx = (await readJson(s, 'index')) || { updatedAt: 0, threads: {} };
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
  await writeJson(s, 'index', idx);
}
function logBotEvent(thread, entry) {
  if (!Array.isArray(thread.botLog)) thread.botLog = [];
  thread.botLog.push(Object.assign({ at: Date.now() }, entry));
  thread.lastBotDecision = entry.decision || entry.type || '';
}

// ---- enrollment helpers ----
function lowerTags(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());
}
function isSealed(rec) {
  if (!rec) return false;
  return rec.dnd === true || lowerTags(rec.tags).includes('dnc');
}
// Seal = `dnc` tag + dnd flag on the enrollment record (+ a dnd flag on
// the thread so the Conversations UI can show it). Written directly to
// the record key: the enrollments index only carries {market, stage},
// which a seal does not change.
async function sealEnrollment(es, key, thread, reason) {
  let rec = await readJson(es, key);
  if (!rec) {
    rec = {
      key,
      phone: thread.phone || '+' + key,
      name: thread.name || '',
      market: thread.market || '',
      tags: [],
      stage: 'sealed',
      enrolledAt: null,
    };
  }
  const tags = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
  if (!lowerTags(tags).includes('dnc')) tags.push('dnc');
  rec.tags = tags;
  rec.dnd = true;
  rec.sealedAt = Date.now();
  rec.sealReason = reason;
  await writeJson(es, key, rec);
  thread.dnd = true;
  return rec;
}
async function addTagsToEnrollment(es, key, newTags) {
  const rec = await readJson(es, key);
  if (!rec) return null;
  const tags = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
  const have = lowerTags(tags);
  for (const t of newTags || []) {
    const tag = String(t || '').trim();
    if (tag && !have.includes(tag.toLowerCase())) {
      tags.push(tag);
      have.push(tag.toLowerCase());
    }
  }
  rec.tags = tags;
  await writeJson(es, key, rec);
  return rec;
}

// ---- bot input assembly ----
// Mirrors what the custom-bot handler consumes in HL today: a contact
// (with HL-shaped customFields), tags, the full conversation history and
// the triggering inbound message. Pricing comes from the enrollment
// record when the pricing writer has stamped it there (rec.pricing =
// {arv, mao, lao} or top-level rec.arv/mao/lao or a raw rec.customFields
// array, passed through untouched).
function assembleBotInput(key, thread, enrollment, inbound) {
  const rec = enrollment || {};
  const customFields = [];
  if (Array.isArray(rec.customFields)) {
    for (const f of rec.customFields) {
      if (f && f.id) customFields.push({ id: f.id, value: f.value });
    }
  }
  const pricingSrc = rec.pricing && typeof rec.pricing === 'object' ? rec.pricing : {};
  const pricing = {
    arv: pricingSrc.arv != null ? pricingSrc.arv : rec.arv != null ? rec.arv : null,
    mao: pricingSrc.mao != null ? pricingSrc.mao : rec.mao != null ? rec.mao : null,
    lao: pricingSrc.lao != null ? pricingSrc.lao : rec.lao != null ? rec.lao : null,
  };
  for (const k of ['arv', 'mao', 'lao']) {
    if (pricing[k] != null && !customFields.some((f) => f.id === PRICING_FIELD_IDS[k])) {
      customFields.push({ id: PRICING_FIELD_IDS[k], value: String(pricing[k]) });
    }
  }
  const tags = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
  return {
    source: 'cc-bot-hook',
    contactId: key, // standalone contact identity = phone key
    phone: thread.phone,
    market: rec.market || thread.market || '',
    contact: {
      id: key,
      phone: thread.phone,
      name: rec.name || thread.name || '',
      firstName: rec.firstName || '',
      address1: rec.address1 || '',
      city: rec.city || '',
      tags,
      dnd: !!rec.dnd,
      customFields,
    },
    pricing,
    tags,
    // Notes and draft suggestions are Troy-facing, not seller turns:
    // they must never reach the model as inbound/outbound history.
    history: (thread.messages || [])
      .filter((m) => m.kind !== 'note' && m.kind !== 'suggestion')
      .map((m) => ({
      id: m.id || null,
      direction: m.dir === 'in' ? 'inbound' : 'outbound',
      body: String(m.body || ''),
      status: m.status || '',
      at: m.at || null,
    })),
    inbound: { body: String(inbound.body || ''), at: inbound.at || null, messageId: inbound.id || null },
  };
}

// Normalize a bot transport response into an action list.
function normalizeActions(resp) {
  if (!resp || typeof resp !== 'object') return [];
  if (Array.isArray(resp.actions)) return resp.actions;
  const out = [];
  if (resp.reply) out.push({ type: 'reply', body: String(resp.reply) });
  const tags = resp.addTags || resp.tags;
  if (Array.isArray(tags) && tags.length) out.push({ type: 'addTags', tags });
  if (resp.seal) out.push({ type: 'seal' });
  if (resp.silence) out.push({ type: 'silence' });
  return out;
}

// Send a bot reply: appended to the thread exactly like the other sends
// (stored 'queued' with the real Telnyx id/from; the webhook advances
// the status; a send failure marks the stored message 'failed').
// FROM-NUMBER: the reply goes out on the number the seller texted (the
// latest inbound's destination) whenever we know it — the conversation
// stays on one number, exactly like HL. The market round-robin pool is
// only the fallback when no inbound destination is on the thread.
async function sendReply(cs, thread, enrollment, body) {
  const market = (enrollment && enrollment.market) || thread.market || undefined;
  let replyFrom = '';
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (m && m.dir === 'in' && m.to) {
      try {
        const candidate = lib.toE164(m.to);
        if (candidate && candidate !== thread.phone) replyFrom = candidate;
      } catch (e) { /* unusable destination — fall back to the pool */ }
      break;
    }
  }
  const msg = {
    id: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    dir: 'out',
    body: String(body),
    status: 'queued',
    at: Date.now(),
    from: replyFrom,
    to: thread.phone,
    via: 'bot',
  };
  thread.messages.push(msg);
  thread.updatedAt = Date.now();
  await saveThread(cs, thread);
  try {
    const sent = await sendSmsImpl()({ to: thread.phone, body: msg.body, market, from: replyFrom || undefined });
    msg.id = sent.id || msg.id;
    msg.from = sent.from || replyFrom || '';
    await saveThread(cs, thread);
    return { ok: true, messageId: msg.id };
  } catch (e) {
    msg.status = 'failed';
    msg.failureReason = String((e && e.message) || e);
    await saveThread(cs, thread);
    return { ok: false, error: msg.failureReason };
  }
}

// ---- core: process the latest inbound on a thread ----
// Returns a result object describing the decision; never throws for
// bot/transport problems (silence is the failure mode), only for store
// failures the caller may want to log.
async function processInbound(key, event) {
  const cs = convStore(event);
  const es = enrollStore(event);
  const thread = await loadThread(cs, key);
  const enrollment = await readJson(es, key);

  let inbound = null;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i].dir === 'in') {
      inbound = thread.messages[i];
      break;
    }
  }
  if (!inbound) return { handled: false, reason: 'no inbound message on thread' };

  // 1) Opt-out seal — adapter-level, mirrors the HL platform behavior.
  const keyword = optOutKeyword(inbound.body);
  if (keyword) {
    await sealEnrollment(es, key, thread, 'opt-out:' + keyword);
    logBotEvent(thread, { type: 'opt-out-seal', decision: 'sealed: opt-out ' + keyword, inbound: String(inbound.body || '') });
    thread.updatedAt = Date.now();
    await saveThread(cs, thread);
    return { handled: true, action: 'sealed-opt-out', keyword, botCalled: false };
  }

  // 2) Already sealed -> the bot never sees it.
  if (isSealed(enrollment)) {
    logBotEvent(thread, { type: 'bot-skipped', decision: 'bot-skipped: contact sealed', inbound: String(inbound.body || '') });
    thread.updatedAt = Date.now();
    await saveThread(cs, thread);
    return { handled: true, action: 'skipped-sealed', botCalled: false };
  }

  const payload = assembleBotInput(key, thread, enrollment, inbound);

  // 2.5) LOCAL BOT (the standalone port): CC_BOT_LOCAL=1 + a configured
  // runner (bot secret + LLM key) runs the real vendored bot brain
  // in-process via cc-bot-runner -> cc-client against the standalone
  // stores. The bot sends/tags/seals through cc-client itself, so the
  // adapter only records the outcome. Local mode wins over the HTTP
  // transport: it can never point at a HighLevel-backed deployment.
  const localWanted = /^(1|true)$/i.test(String(process.env.CC_BOT_LOCAL || ''));
  if (localWanted) {
    let runner = null;
    try {
      runner = require('./cc-bot-runner');
    } catch (e) {
      runner = null;
    }
    if (runner && runner.configured()) {
      // Thread the Lambda event through: without it the runner's
      // CcClient builds context-less Blobs stores (reads miss, writes
      // silently no-op — the Nov 26 Amber repeat-question +
      // missing-outbound bug). telnyx-webhook already passes this
      // invocation's event to processInbound; it must not stop here.
      const result = await runner.runBot({
        contactId: key,
        conversationId: key,
        messageId: inbound.id || null,
        body: String(inbound.body || ''),
        type: 'SMS',
        toNumber: inbound.to || null,
      }, undefined, event);
      // The bot wrote to the same stores through cc-client — reload
      // before logging so we never overwrite its messages with the
      // stale in-memory copy.
      const fresh = await loadThread(cs, key);
      logBotEvent(fresh, {
        type: 'bot-local',
        decision: 'bot-local: ' + result.outcome,
        inbound: String(inbound.body || ''),
      });
      fresh.updatedAt = Date.now();
      await saveThread(cs, fresh);
      return { handled: true, action: 'bot-local', outcome: result.outcome, botCalled: true };
    }
    // Wanted but not configured: fall through — the log-only branch
    // below records why nothing ran.
  }

  const url = process.env.CC_BOT_WEBHOOK_URL;

  // 3) LOG-ONLY mode — no transport configured. Record and stay silent.
  if (!url) {
    logBotEvent(thread, {
      type: 'bot-skipped',
      decision: 'bot-skipped: no transport configured',
      inbound: String(inbound.body || ''),
    });
    thread.updatedAt = Date.now();
    await saveThread(cs, thread);
    return { handled: true, action: 'log-only', decision: 'bot-skipped: no transport configured', botCalled: false };
  }

  // 4) Transport: POST to the bot, apply returned actions.
  let respJson = null;
  try {
    const fetchFn = fetchImpl();
    if (typeof fetchFn !== 'function') throw new Error('No fetch implementation available.');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.CC_TICK_SECRET) headers['x-cc-tick-secret'] = process.env.CC_TICK_SECRET;
    const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    try {
      respJson = await res.json();
    } catch (e) {
      respJson = null;
    }
    if (!res.ok) throw new Error('Bot transport HTTP ' + res.status);
    if (!respJson || typeof respJson !== 'object') throw new Error('Bot transport returned no JSON actions.');
  } catch (e) {
    logBotEvent(thread, {
      type: 'bot-error',
      decision: 'bot-error: ' + String((e && e.message) || e),
      inbound: String(inbound.body || ''),
    });
    thread.updatedAt = Date.now();
    await saveThread(cs, thread);
    return { handled: true, action: 'bot-error', error: String((e && e.message) || e), botCalled: true };
  }

  const actions = normalizeActions(respJson);
  const applied = [];
  let currentEnrollment = enrollment;
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'reply' && a.body) {
      const r = await sendReply(cs, thread, currentEnrollment, a.body);
      applied.push({ type: 'reply', ok: r.ok, messageId: r.messageId || null, error: r.error || null });
    } else if (a.type === 'addTags' && Array.isArray(a.tags)) {
      currentEnrollment = (await addTagsToEnrollment(es, key, a.tags)) || currentEnrollment;
      applied.push({ type: 'addTags', tags: a.tags });
    } else if (a.type === 'seal') {
      currentEnrollment = await sealEnrollment(es, key, thread, 'bot-seal');
      applied.push({ type: 'seal' });
    } else if (a.type === 'silence') {
      applied.push({ type: 'silence' });
    }
  }
  logBotEvent(thread, {
    type: 'bot-actions',
    decision: 'bot: ' + (applied.map((a) => a.type).join(',') || 'no actions'),
    inbound: String(inbound.body || ''),
    actions: applied,
  });
  thread.updatedAt = Date.now();
  await saveThread(cs, thread);
  return { handled: true, action: 'bot', botCalled: true, applied };
}

// ---- HTTP handler (external trigger / replay) ----
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

exports.handler = async (event) => {
  const secret = process.env.CC_TICK_SECRET;
  if (!secret) {
    return json(503, { error: 'CC_TICK_SECRET is not configured — bot hook endpoint disabled.' });
  }
  const headers = event.headers || {};
  const provided = headers['x-cc-tick-secret'] || headers['X-Cc-Tick-Secret'] || '';
  if (!provided || !safeEqual(provided, secret)) {
    return json(401, { error: 'Unauthorized.' });
  }
  if (event.httpMethod && event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return json(400, { error: 'Bad JSON body.' });
  }
  const rawPhone = body.phone || body.key;
  if (!rawPhone) return json(400, { error: 'Missing phone.' });
  let key;
  try {
    key = lib.phoneKey(rawPhone);
  } catch (e) {
    return json(400, { error: 'Invalid phone number.' });
  }
  try {
    const result = await processInbound(key, event);
    return json(200, { ok: true, ...result });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

exports.processInbound = processInbound;

// Test hooks (not part of the deployed surface).
exports._test = {
  optOutKeyword,
  assembleBotInput,
  normalizeActions,
  isSealed,
  setStores(stores) {
    deps.convStoreFactory = stores && stores.conversations ? () => stores.conversations : null;
    deps.enrollStoreFactory = stores && stores.enrollments ? () => stores.enrollments : null;
  },
  setFetch(fn) {
    deps.fetch = fn || null;
  },
  setSendSms(fn) {
    deps.sendSms = fn || null;
  },
  reset() {
    deps.convStoreFactory = null;
    deps.enrollStoreFactory = null;
    deps.fetch = null;
    deps.sendSms = null;
  },
};

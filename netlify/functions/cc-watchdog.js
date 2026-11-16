// netlify/functions/cc-watchdog.js
// Standalone Command Center watchdog: flags seller conversations whose
// latest inbound text has gone unanswered for too long, so a human never
// lets a hot reply sit silent.
//
//   scan()       — one pass over the 'cc-conversations' store:
//                    * FLAG: a thread whose LAST message is inbound,
//                      older than the threshold (default 30 min), not
//                      suppressed (thread.dnd === true, or the matching
//                      'cc-enrollments' record has dnd === true), with
//                      no existing flag for that inbound and no outbound
//                      after it -> a new 'open' flag in
//                      'cc-notifications' (key 'flags' -> {flags: []}).
//                    * AUTO-RESOLVE: an 'open' flag whose thread now has
//                      an outbound message after the flagged inbound ->
//                      'resolved' (resolvedAt stamped).
//                    * CAP: the flags array is held at 200 entries —
//                      oldest 'resolved'/'dismissed' drop first, then
//                      oldest 'open'.
//   listFlags()  — all flags, open first then newest flaggedAt first.
//   dismissFlag()— mark one flag 'dismissed'.
//
// HTTP handler: POST only, protected by the SAME shared-secret scheme
// as cc-workflow-tick.js (header `x-cc-tick-secret` vs CC_TICK_SECRET,
// FAIL CLOSED — 503 when the env var is unset, 401 on mismatch). On
// success it runs one scan and returns {ok: true, ...summary}.
// cc-workflow-tick.js also calls scan() directly (fail-soft) after each
// engine tick. This module sends NOTHING — it only writes flags.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const CONV_STORE = 'cc-conversations';
const ENROLL_STORE = 'cc-enrollments';
const NOTIF_STORE = 'cc-notifications';
const FLAGS_KEY = 'flags';
const MAX_FLAGS = 200;
const DEFAULT_THRESHOLD_MINUTES = 30;

// ---- injectable stores (tests) ----
const deps = {
  convStoreFactory: null,
  enrollStoreFactory: null,
  notifStoreFactory: null,
};

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
function notifStore(event) {
  return makeStore(NOTIF_STORE, deps.notifStoreFactory, event);
}

// Strict read: store errors PROPAGATE (a dead conversations store must
// surface as a scan error so the tick can record watchdogError instead
// of silently reporting zero flags). Missing keys read as null.
async function readJson(s, key) {
  const v = await s.get(key, { type: 'json' });
  return v && typeof v === 'object' ? v : null;
}
// Lenient read for optional per-record lookups (thread bodies, the
// enrollment suppression check): a failure just means "not available".
async function readJsonSafe(s, key) {
  try {
    return await readJson(s, key);
  } catch (e) {
    return null;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

// ---- notifications store ----
async function loadFlags(ns) {
  const rec = await readJson(ns, FLAGS_KEY);
  return rec && Array.isArray(rec.flags) ? rec.flags : [];
}
async function saveFlags(ns, flags) {
  await writeJson(ns, FLAGS_KEY, { flags });
}

// ---- conversations ----
// The index (key 'index') is {threads: {<key>: summary}} in production
// (an array shape is also tolerated). Summaries carry no messages, so
// the full thread record is loaded per key; an index entry that itself
// carries a messages array is used as-is when no record loads.
async function loadThreads(cs) {
  const idx = await readJson(cs, 'index');
  const entries = [];
  if (idx && idx.threads) {
    if (Array.isArray(idx.threads)) {
      for (const t of idx.threads) {
        if (t && typeof t === 'object') entries.push({ key: t.key || null, summary: t });
      }
    } else if (typeof idx.threads === 'object') {
      for (const [k, t] of Object.entries(idx.threads)) {
        entries.push({ key: k, summary: t && typeof t === 'object' ? t : {} });
      }
    }
  }
  const threads = [];
  for (const e of entries) {
    let thread = e.key ? await readJsonSafe(cs, e.key) : null;
    if (thread && Array.isArray(thread.messages)) {
      if (!thread.key) thread.key = e.key;
      threads.push(thread);
    } else if (e.summary && Array.isArray(e.summary.messages)) {
      const t = e.summary;
      if (!t.key) t.key = e.key;
      threads.push(t);
    } else if (thread) {
      thread.messages = [];
      if (!thread.key) thread.key = e.key;
      threads.push(thread);
    }
    // else: summary-only entry with no loadable record — nothing to scan.
  }
  return threads;
}

// Suppressed = thread.dnd === true, or the matching enrollment record
// (same key) has dnd === true. (A thread whose last message is outbound
// never flags anyway — that is the flag condition, checked in scan().)
async function isSuppressed(es, thread) {
  if (thread.dnd === true) return true;
  if (es && thread.key) {
    const rec = await readJsonSafe(es, thread.key);
    if (rec && rec.dnd === true) return true;
  }
  return false;
}

// Hold the array at MAX_FLAGS: oldest 'resolved'/'dismissed' first
// (by flaggedAt), then oldest 'open'.
function capFlags(flags) {
  if (flags.length <= MAX_FLAGS) return flags;
  const arr = flags.slice();
  const oldestIndex = (pred) => {
    let victim = -1;
    let victimAt = Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (!pred(arr[i])) continue;
      const at = typeof arr[i].flaggedAt === 'number' ? arr[i].flaggedAt : 0;
      if (at < victimAt) {
        victimAt = at;
        victim = i;
      }
    }
    return victim;
  };
  while (arr.length > MAX_FLAGS) {
    let victim = oldestIndex((f) => f.status === 'resolved' || f.status === 'dismissed');
    if (victim === -1) victim = oldestIndex(() => true);
    arr.splice(victim, 1);
  }
  return arr;
}

// ---- core scan ----
async function scan(opts, event) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const thresholdMinutes =
    typeof o.thresholdMinutes === 'number' ? o.thresholdMinutes : DEFAULT_THRESHOLD_MINUTES;
  const thresholdMs = thresholdMinutes * 60000;

  const cs = convStore(event);
  const ns = notifStore(event);
  let es = null;
  try {
    es = enrollStore(event);
  } catch (e) {
    es = null; // enrollment suppression is best-effort ("when available")
  }

  const threads = await loadThreads(cs);
  const byKey = new Map();
  for (const t of threads) {
    if (t && t.key) byKey.set(t.key, t);
  }

  let flags = await loadFlags(ns);

  // Auto-resolve: an outbound message after the flagged inbound means a
  // human (or the bot) already answered.
  let resolved = 0;
  for (const f of flags) {
    if (f.status !== 'open') continue;
    const t = byKey.get(f.key);
    if (!t || !Array.isArray(t.messages)) continue;
    const answered = t.messages.some(
      (m) => m && m.dir === 'out' && typeof m.at === 'number' && m.at > f.inboundAt
    );
    if (answered) {
      f.status = 'resolved';
      f.resolvedAt = now;
      resolved += 1;
    }
  }

  // Flag newly-stale unanswered inbounds.
  let flagged = 0;
  for (const t of threads) {
    const msgs = Array.isArray(t.messages) ? t.messages : [];
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    if (!last || last.dir !== 'in') continue;
    if (typeof last.at !== 'number') continue;
    if (!(now - last.at > thresholdMs)) continue;
    if (await isSuppressed(es, t)) continue;
    if (flags.some((f) => f.key === t.key && f.inboundId === last.id)) continue;
    // No outbound after that inbound (the last-message check above makes
    // this belt-and-braces for unsorted histories).
    if (msgs.some((m) => m && m.dir === 'out' && typeof m.at === 'number' && m.at > last.at)) {
      continue;
    }
    flags.push({
      id: crypto.randomUUID(),
      key: t.key,
      phone: t.phone || '',
      name: t.name || '',
      market: t.market || '',
      inboundId: last.id,
      preview: String(last.body || '').slice(0, 120),
      inboundAt: last.at,
      flaggedAt: now,
      status: 'open',
    });
    flagged += 1;
  }

  flags = capFlags(flags);
  await saveFlags(ns, flags);
  const open = flags.filter((f) => f.status === 'open').length;
  return { flagged, resolved, open };
}

async function listFlags(event) {
  const ns = notifStore(event);
  const flags = await loadFlags(ns);
  const rank = (f) => (f.status === 'open' ? 0 : 1);
  const sorted = flags
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (b.flaggedAt || 0) - (a.flaggedAt || 0));
  return { flags: sorted, openCount: flags.filter((f) => f.status === 'open').length };
}

async function dismissFlag(id, event) {
  const ns = notifStore(event);
  const flags = await loadFlags(ns);
  const openCount = () => flags.filter((f) => f.status === 'open').length;
  const f = flags.find((x) => x.id === id);
  if (!f) return { ok: false, openCount: openCount() };
  f.status = 'dismissed';
  await saveFlags(ns, flags);
  return { ok: true, openCount: openCount() };
}

// ---- HTTP handler (same secret gate as cc-workflow-tick.js) ----
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function handler(event) {
  const secret = process.env.CC_TICK_SECRET;
  if (!secret) {
    return json(503, { error: 'CC_TICK_SECRET is not configured — watchdog endpoint disabled.' });
  }
  const headers = event.headers || {};
  const provided = headers['x-cc-tick-secret'] || headers['X-Cc-Tick-Secret'] || '';
  if (!provided || !safeEqual(provided, secret)) {
    return json(401, { error: 'Unauthorized.' });
  }
  if (event.httpMethod && event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const summary = await scan({ now: Date.now() }, event);
    return json(200, { ok: true, ...summary });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
}

exports.scan = scan;
exports.listFlags = listFlags;
exports.dismissFlag = dismissFlag;
exports.handler = handler;

// Test hooks (not part of the deployed surface).
exports._test = {
  capFlags,
  setStores(stores) {
    deps.convStoreFactory =
      stores && stores.conversations ? () => stores.conversations : null;
    deps.enrollStoreFactory =
      stores && stores.enrollments ? () => stores.enrollments : null;
    deps.notifStoreFactory =
      stores && stores.notifications ? () => stores.notifications : null;
  },
  reset() {
    deps.convStoreFactory = null;
    deps.enrollStoreFactory = null;
    deps.notifStoreFactory = null;
  },
};

// netlify/functions/cc-hl-sync-queue.js
// Out-of-band HighLevel DND mirror queue (Nov 27, 2026).
//
// The gap: an auto opt-out seal (cc-bot-hook.sealEnrollment) seals
// the seller locally only — the enrollment record + thread — and
// NEVER writes to HighLevel, so HL workflows, the HL bot guard and
// the HL UI never see it and HL could still text a seller Troy just
// sealed. Jason Hogan proved it: sealed in the Command Center Nov 27
// 1:04 PM ("Out"), HL untouched since Oct 31, inbound block null.
//
// Why a queue instead of a direct call: the hot inbound path cannot
// afford synchronous HL calls inside the 22s bot-hook budget
// (syncHlDnd does a lookup GET + a contact GET + a PUT + a tag POST,
// each with a 20s timeout — a slow HL reproduces the §2 silence).
// So sealEnrollment enqueues a best-effort job and the 1/min
// cc-inbound-sweep drains it, bounded per sweep. The manual DND path
// (cc-dnd.setChannels) already syncs synchronously and does NOT use
// this queue.
//
// Guarantees:
//   * Enqueue never throws into the seal path — the local seal always
//     stands even if the queue write fails.
//   * One entry per enrollment key (re-seal replaces, attempts reset).
//   * Drainer re-checks the record before syncing: if the seller was
//     unsealed after enqueue, the entry is dropped, never synced.
//   * syncHlDnd is idempotent (same seal body + tag POST), so a
//     retry after a partial write is safe.
//   * Failed entries retry with backoff (5 min x attempts, cap 30)
//     and stay queued until they succeed — they are NEVER silently
//     dropped. After MAX_ATTEMPTS the watchdog raises an
//     'hl-sync-failed' flag (see cc-watchdog.js).
//   * 'unresolved' (no unique HL contact) drops after one attempt:
//     there is nothing to seal in HL, and the local seal stands.
'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

// cc-dnd owns syncHlDnd + the seal-state derivation. Guarded: the
// queue must never break a caller when that module cannot load.
let dndMod = null;
try {
  dndMod = require('./cc-dnd');
} catch (e) {
  dndMod = null;
}

const STORE_NAME = 'cc-hl-sync-queue';
const QUEUE_KEY = 'queue';
const ENROLL_STORE = 'cc-enrollments';
const MAX_ATTEMPTS = 5;
const MAX_PER_SWEEP = 2;
const ENTRY_TIMEOUT_MS = 10000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const MAX_OUTCOMES = 50;

let storeFactory = null; // (name) -> store; tests only
let syncHlDndImpl = null; // tests only

function openStore(name, event) {
  if (storeFactory) return storeFactory(name);
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(name);
}

function queueStore(event) {
  return openStore(STORE_NAME, event);
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

function emptyQueue() {
  return { entries: [], outcomes: {}, updatedAt: 0 };
}

function normalizeQueue(q) {
  const out = emptyQueue();
  if (q && Array.isArray(q.entries)) out.entries = q.entries.filter((e) => e && e.key);
  if (q && q.outcomes && typeof q.outcomes === 'object') out.outcomes = q.outcomes;
  return out;
}

function syncHlDndFn() {
  if (syncHlDndImpl) return syncHlDndImpl;
  if (dndMod && typeof dndMod.syncHlDnd === 'function') return dndMod.syncHlDnd;
  return null;
}

// Merge-atomic append: re-read immediately before writing and union
// by key, so a concurrent enqueue landing between the load and the
// write is not wiped. Never throws — returns the entry, or null.
async function enqueueSeal(event, entry) {
  try {
    const key = String((entry && entry.key) || '').trim();
    const phone = String((entry && entry.phone) || '').trim();
    if (!key || !phone) return null;
    const channels = (entry && entry.channels && typeof entry.channels === 'object')
      ? { sms: entry.channels.sms === true, email: entry.channels.email === true, call: entry.channels.call === true }
      : { sms: true, email: true, call: true };
    const s = queueStore(event);
    const now = Date.now();
    const next = {
      key,
      phone,
      channels,
      reason: String((entry && entry.reason) || 'opt-out'),
      enqueuedAt: now,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: '',
    };
    // Merge-atomic: read twice — the first read may be stale under
    // Blobs read lag, so the union below is computed over a second
    // read taken immediately before the write. A concurrent enqueue
    // landing between the two reads survives.
    await readJson(s, QUEUE_KEY);
    const fresh = normalizeQueue(await readJson(s, QUEUE_KEY));
    const idx = fresh.entries.findIndex((e) => e.key === key);
    if (idx >= 0) fresh.entries[idx] = next;
    else fresh.entries.push(next);
    fresh.updatedAt = now;
    await writeJson(s, QUEUE_KEY, fresh);
    return next;
  } catch (e) {
    console.error('[cc-hl-sync-queue] enqueue failed for ' + ((entry && entry.key) || '?') + ':', String((e && e.message) || e));
    return null;
  }
}

function backoffMs(attempts) {
  return Math.min(BACKOFF_BASE_MS * Math.max(1, attempts), BACKOFF_MAX_MS);
}

function sealedNow(rec) {
  if (!rec) return false;
  try {
    if (dndMod && typeof dndMod.deriveChannels === 'function') {
      return dndMod.deriveChannels(rec, null).sms === true;
    }
  } catch (e) { /* fall through to markers */ }
  if (rec.dnd === true) return true;
  if (rec.dndChannels && typeof rec.dndChannels === 'object') return rec.dndChannels.sms === true;
  return false;
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Drain due entries, bounded per sweep. Never throws — every failure
// mode is counted in the returned summary and the sweep keeps going.
// Returns {ok, drained, synced, unresolved, failed, skipped,
// droppedUnsealed, remaining, error?}.
async function drainQueue(event, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const maxPerSweep = typeof o.maxPerSweep === 'number' ? o.maxPerSweep : MAX_PER_SWEEP;
  const timeoutMs = typeof o.entryTimeoutMs === 'number' ? o.entryTimeoutMs : ENTRY_TIMEOUT_MS;
  const summary = {
    ok: true, drained: 0, synced: 0, unresolved: 0, failed: 0,
    skipped: 0, droppedUnsealed: 0, remaining: 0,
  };
  let qs;
  try {
    qs = queueStore(event);
  } catch (e) {
    summary.ok = false;
    summary.error = String((e && e.message) || e);
    return summary;
  }
  let doc;
  try {
    doc = normalizeQueue(await readJson(qs, QUEUE_KEY));
  } catch (e) {
    summary.ok = false;
    summary.error = String((e && e.message) || e);
    return summary;
  }
  if (!doc.entries.length) {
    summary.remaining = 0;
    return summary;
  }
  const syncFn = syncHlDndFn();
  if (!syncFn) {
    // No HL sync available (cc-dnd unloadable): leave everything
    // queued and say so — dropping would lose the seal mirror.
    summary.ok = false;
    summary.error = 'cc-dnd.syncHlDnd unavailable';
    summary.remaining = doc.entries.length;
    return summary;
  }
  let es = null;
  try {
    es = openStore(ENROLL_STORE, event);
  } catch (e) {
    es = null; // record re-check is best-effort; sync by phone alone
  }
  const removals = new Map(); // key -> outcome status
  const updates = new Map(); // key -> {attempts, nextAttemptAt, lastError}
  let processed = 0;
  for (const entry of doc.entries) {
    if (processed >= maxPerSweep) break;
    if (entry.nextAttemptAt && entry.nextAttemptAt > now) {
      summary.skipped += 1;
      continue;
    }
    processed += 1;
    summary.drained += 1;
    // Unsealed since enqueue? Drop — syncing a stale seal would
    // re-seal a seller Troy (or the seller) unsealed.
    let rec = null;
    if (es) {
      try {
        rec = await readJson(es, entry.key);
      } catch (e) {
        rec = null;
      }
    }
    if (rec && !sealedNow(rec)) {
      removals.set(entry.key, 'superseded');
      summary.droppedUnsealed += 1;
      continue;
    }
    let result;
    try {
      const r = await withTimeout(
        syncFn({
          rec: rec || { phone: entry.phone },
          thread: { phone: entry.phone },
          key: entry.key,
          channels: entry.channels,
          event,
        }),
        timeoutMs
      );
      result = r && r.__timeout ? { hlSync: 'failed', hlError: 'sync timed out after ' + timeoutMs + 'ms' } : r;
    } catch (e) {
      result = { hlSync: 'failed', hlError: String((e && e.message) || e) };
    }
    const outcome = result && result.hlSync;
    if (outcome === 'ok') {
      removals.set(entry.key, 'synced');
      summary.synced += 1;
    } else if (outcome === 'unresolved') {
      // No unique HL contact: nothing to seal. The local seal
      // stands; retrying cannot help.
      removals.set(entry.key, 'unresolved');
      summary.unresolved += 1;
    } else {
      // 'failed' / 'skipped-no-config' / timeout: keep queued with
      // backoff. After MAX_ATTEMPTS the watchdog flags it — the
      // entry itself is never silently dropped.
      const attempts = (entry.attempts || 0) + 1;
      const err = String((result && result.hlError) || 'HL sync failed').slice(0, 200);
      updates.set(entry.key, {
        attempts,
        nextAttemptAt: now + backoffMs(attempts),
        lastError: err,
      });
      summary.failed += 1;
      console.error('[cc-hl-sync-queue] HL sync failed for ' + entry.key + ' (attempt ' + attempts + '/' + MAX_ATTEMPTS + '): ' + err);
    }
  }
  // Merge-atomic write-back: re-read, then apply only this drain's
  // removals/updates, so a concurrent enqueue landing mid-drain
  // survives.
  try {
    const fresh = normalizeQueue(await readJson(qs, QUEUE_KEY));
    const remaining = [];
    for (const e of fresh.entries) {
      if (removals.has(e.key)) continue;
      const u = updates.get(e.key);
      if (u) {
        e.attempts = u.attempts;
        e.nextAttemptAt = u.nextAttemptAt;
        e.lastError = u.lastError;
      }
      remaining.push(e);
    }
    fresh.entries = remaining;
    for (const [key, status] of removals.entries()) {
      fresh.outcomes[key] = { status, at: now };
    }
    // Prune outcomes so the doc cannot grow without bound.
    const keys = Object.keys(fresh.outcomes);
    if (keys.length > MAX_OUTCOMES) {
      const sorted = keys.sort((a, b) => (fresh.outcomes[a].at || 0) - (fresh.outcomes[b].at || 0));
      for (const k of sorted.slice(0, keys.length - MAX_OUTCOMES)) delete fresh.outcomes[k];
    }
    fresh.updatedAt = now;
    await writeJson(qs, QUEUE_KEY, fresh);
    summary.remaining = fresh.entries.length;
  } catch (e) {
    // The syncs already landed (or were counted) — a write-back
    // failure must not report them as lost. The next sweep re-reads
    // the queue and re-processes; syncHlDnd is idempotent.
    summary.ok = false;
    summary.error = 'queue write-back failed: ' + String((e && e.message) || e);
    summary.remaining = doc.entries.length;
  }
  return summary;
}

// Entries the watchdog must flag: failed MAX_ATTEMPTS times and
// still queued. Read-only helper for cc-watchdog.js.
function listFailedEntries(queueDoc) {
  const doc = normalizeQueue(queueDoc);
  return doc.entries.filter((e) => (e.attempts || 0) >= MAX_ATTEMPTS);
}

module.exports = {
  enqueueSeal,
  drainQueue,
  listFailedEntries,
  queueStore,
  STORE_NAME,
  MAX_ATTEMPTS,
  MAX_PER_SWEEP,
  ENTRY_TIMEOUT_MS,
  _test: {
    setStoreFactory(fn) {
      storeFactory = fn || null;
    },
    setSyncHlDnd(fn) {
      syncHlDndImpl = fn || null;
    },
    reset() {
      storeFactory = null;
      syncHlDndImpl = null;
    },
  },
};

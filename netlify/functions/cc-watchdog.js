// netlify/functions/cc-watchdog.js
// Standalone Command Center watchdog: flags seller conversations whose
// latest inbound text has gone unanswered for too long, so a human never
// lets a hot reply sit silent.
//
//   scan()       — one pass over the 'cc-conversations' store:
//                    * FLAG: a thread whose LAST TEXT message is
//                      inbound, older than the threshold (default
//                      30 min), not suppressed (thread.dnd === true,
//                      or the matching 'cc-enrollments' record has
//                      dnd === true), with no existing flag for that
//                      inbound and no outbound after it -> a new
//                      'open' flag in 'cc-notifications' (key 'flags'
//                      -> {flags: []}). Call-history entries
//                      (kind 'call': the 'Missed call' / 'Call
//                      completed' bubbles logCallToThread appends)
//                      are NOT texts and are never the flagged
//                      inbound — a call is not an unreplied text.
//                    * AUTO-RESOLVE: an 'open' flag whose thread now has
//                      an outbound message after the flagged inbound ->
//                      'resolved' (resolvedAt stamped).
//                    * CAP: the flags array is held at 200 entries —
//                      oldest 'resolved'/'dismissed' drop first, then
//                      oldest 'open'.
//                    * STUCK CALL (Nov 25, 2026): a pairing in the
//                      'cc-dialer' store (key 'thread-calls') stuck
//                      unbridged (status 'dialing', 'ringing' or
//                      'answered') past stuckCallSeconds (default
//                      60) — seller leg live, bridge never formed —
//                      raises an 'open' flag of type 'stuck-call'
//                      carrying lastEvent/lastError/agentAnswered/
//                      sellerHuman, so the next debug round starts from
//                      the pairing's own diagnostics. Auto-resolves
//                      when the pairing later shows 'bridged'/'ended' —
//                      and (Nov 27, 2026 close-out) when the call is
//                      provably over without the pairing flipping:
//                      pairing record gone, lastEvent 'call.hangup'
//                      + 5 quiet minutes, or 2 hours with no update.
//                      A resolved callId never re-flags while its
//                      pairing stays quiet. Read-only alerting: this
//                      pass never touches a call. A dead/missing
//                      dialer store skips this pass (best-effort) and
//                      never breaks the unanswered-inbound scan.
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
const DIALER_STORE = 'cc-dialer';
const PAIRINGS_KEY = 'thread-calls';
const DEFAULT_STUCK_CALL_SECONDS = 60;
// Close-out bounds (Nov 27, 2026): a hangup ends the call even when
// the pairing never flips to 'ended' — see scan().
const STUCK_FLAG_HANGUP_QUIET_MS = 5 * 60 * 1000; // hangup + 5 quiet min
const STUCK_FLAG_STALE_MS = 2 * 60 * 60 * 1000; // no update for 2h = dead

// ---- injectable stores (tests) ----
const deps = {
  convStoreFactory: null,
  enrollStoreFactory: null,
  notifStoreFactory: null,
  dialerStoreFactory: null,
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
function dialerStore(event) {
  return makeStore(DIALER_STORE, deps.dialerStoreFactory, event);
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
  const stuckCallSeconds =
    typeof o.stuckCallSeconds === 'number' ? o.stuckCallSeconds : DEFAULT_STUCK_CALL_SECONDS;
  let ds = null;
  try {
    ds = dialerStore(event);
  } catch (e) {
    ds = null; // stuck-call pass is best-effort; a dead dialer store
    // must never break the unanswered-inbound scan.
  }

  const threads = await loadThreads(cs);
  const byKey = new Map();
  for (const t of threads) {
    if (t && t.key) byKey.set(t.key, t);
  }
  // Phone-keyed lookup alongside byKey: stuck-call pairing records
  // key by callControlId, NOT by thread key, so a flag (or a pairing)
  // that only carries a callControlId + a phone must still resolve to
  // its thread by phone. Digits of the thread phone (falling back to
  // the thread key, which in production IS the phone digits).
  const digitsOf = (v) => String(v || '').replace(/\D/g, '');
  const byPhone = new Map();
  for (const t of threads) {
    if (!t) continue;
    const d = digitsOf(t.phone) || digitsOf(t.key);
    if (d && !byPhone.has(d)) byPhone.set(d, t);
  }
  // Resolve a flag to its thread: exact key first, then phone — so
  // legacy flags stamped with a callControlId key still find their
  // thread (and still auto-resolve) by the phone they carry.
  const threadForFlag = (f) =>
    (f && f.key && byKey.get(f.key)) ||
    (f && f.phone && byPhone.get(digitsOf(f.phone))) ||
    null;
  const threadForPhone = (phone) => (phone && byPhone.get(digitsOf(phone))) || null;

  let flags = await loadFlags(ns);

  // Auto-resolve: an outbound message after the flagged inbound means a
  // human (or the bot) already answered.
  let resolved = 0;
  for (const f of flags) {
    if (f.status !== 'open') continue;
    const t = threadForFlag(f);
    if (!t || !Array.isArray(t.messages)) continue;
    const answered = t.messages.some(
      (m) => m && m.dir === 'out' && typeof m.at === 'number' && m.at > f.inboundAt
    );
    if (answered) {
      f.status = 'resolved';
      f.resolvedAt = now;
      resolved += 1;
    }
    // Call-history entries are not texts (Nov 27, 2026): an open
    // unreplied flag whose flagged inbound IS a call entry was
    // created by the same bug the flag pass below now skips — the
    // old pass flagged ANY last-dir-'in' message, and logCallToThread
    // writes inbound calls with dir 'in'. Resolve it so the false
    // flag clears from Troy's list instead of sitting open until a
    // human dismisses it. Stuck-call flags (f.type) are excluded —
    // their close-out lives in the stuck-call pass below. Call
    // entries carry no id, so these flags have no inboundId; match
    // on inboundAt, which the flag copies verbatim from the entry.
    // Same for a Sam note / draft suggestion (kind 'note' /
    // 'suggestion'): the pre-fix Sam notes carried dir 'in', so the
    // old pass could flag one as an unreplied inbound — a note is
    // not a seller text either.
    if (f.status === 'open' && !f.type) {
      const flaggedNonText = t.messages.some(
        (m) =>
          m &&
          (m.kind === 'call' || m.kind === 'note' || m.kind === 'suggestion') &&
          m.at === f.inboundAt
      );
      if (flaggedNonText) {
        f.status = 'resolved';
        f.resolvedAt = now;
        f.resolvedReason = 'not-a-text';
        resolved += 1;
        continue;
      }
    }
  }

  // Flag newly-stale unanswered inbounds.
  let flagged = 0;
  for (const t of threads) {
    const msgs = Array.isArray(t.messages) ? t.messages : [];
    if (!msgs.length) continue;
    // Call-history entries are not texts (Nov 27, 2026): a
    // 'Missed call' / 'Call completed' / 'Voicemail' bubble
    // (kind 'call', written by logCallToThread with dir 'in' for
    // inbound calls) is not a seller text waiting on a reply, so
    // it must never be the flagged inbound. Same for kind 'note'
    // (a Sam post-call note) and kind 'suggestion' (a draft bot
    // suggestion): neither is a seller text, and a trailing note
    // must not become the flagged inbound — nor reset the clock on
    // the real inbound underneath it. Scan back to the latest TEXT
    // message instead; a thread whose messages are all call entries
    // / notes has no unreplied text. (The old code took
    // msgs[msgs.length - 1] outright, so every missed/completed
    // call older than the threshold raised an unreplied-text flag
    // with preview 'Missed call' / 'Call completed' — Troy's
    // Nov 27 Conversations rows.)
    let last = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.kind !== 'call' && m.kind !== 'note' && m.kind !== 'suggestion') {
        last = m;
        break;
      }
    }
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

  // ---- stuck calls (Nov 25, 2026 call-audio deadlock guard) ----
  // A pairing stuck in 'dialing' past the threshold means the seller
  // leg is live but the bridge never formed — the exact failure Troy
  // hit: ringback played forever and the seller was unheard, and
  // nothing surfaced it. Flag it with the pairing's own diagnostics
  // so the next debug round starts from lastEvent/lastError instead
  // of a blank "it doesn't work". Read-only alerting: this pass never
  // touches a call, it only writes flags. Counts fold into the same
  // flagged/resolved/open summary as the inbound pass, so the scan
  // return shape is unchanged.
  if (ds) {
    const pairingsRec = await readJsonSafe(ds, PAIRINGS_KEY);
    const calls =
      pairingsRec && typeof pairingsRec.calls === 'object' ? pairingsRec.calls : {};
    // Auto-resolve: a stuck-call flag whose pairing has since bridged
    // or ended is done — the call got through (or was hung up).
    // Close-out (Nov 27, 2026): a hangup must ALSO close the flag.
    // The event path can strand a pairing in 'dialing'/'ringing'/
    // 'answered' after the call is over — the last agent leg died
    // with no hangup webhook, or the hangup landed on a leg the
    // handler did not treat as call-ending — so the flag sat open
    // for hours on calls Troy had already watched end (Nov 26: four
    // stale 'Call stuck unbridged' flags, all with last event
    // call.hangup). A flag resolves when the call is provably over:
    //   * pairing 'bridged'/'ended' (existing), or
    //   * pairing record gone — no live call exists without a record, or
    //   * lastEvent 'call.hangup' + 5 quiet minutes — the hangup was
    //     processed and nothing further will arrive (the quiet
    //     window keeps a just-processed hangup from racing the
    //     webhook's own save), or
    //   * pairing quiet 2 hours — no unbridged call is live that
    //     long (Telnyx legs time out in 20–30s; the sweep ends
    //     ringing at 2 min), so a 2-hour-quiet pairing is dead
    //     whatever its state.
    // resolvedReason is stamped so the next debug round can tell
    // which close-out path fired.
    for (const f of flags) {
      if (f.status !== 'open' || f.type !== 'stuck-call') continue;
      const rec = calls[f.callId];
      const resolve = (reason) => {
        f.status = 'resolved';
        f.resolvedAt = now;
        f.resolvedReason = reason;
        resolved += 1;
      };
      if (!rec) {
        resolve('pairing-gone');
        continue;
      }
      if (rec.status === 'bridged' || rec.status === 'ended') {
        resolve('call-ended');
        continue;
      }
      const quietMs =
        now - (typeof rec.updatedAt === 'number' ? rec.updatedAt : rec.startedAt || 0);
      if (rec.lastEvent === 'call.hangup' && quietMs > STUCK_FLAG_HANGUP_QUIET_MS) {
        resolve('hangup');
        continue;
      }
      if (quietMs > STUCK_FLAG_STALE_MS) {
        resolve('stale');
        continue;
      }
    }
    for (const [callId, rec] of Object.entries(calls)) {
      // Stuck = unbridged past the threshold. 'dialing' (never rang),
      // 'ringing' (rang, never answered) and 'answered' (seller picked
      // up, AMD pending or machine-verdict-but-unbridged — Nov 26,
      // 2026: the 'answered' state is new, and a bridge that never
      // forms there is the same deadlock with a different label).
      if (!rec || !['dialing', 'ringing', 'answered'].includes(rec.status)) continue;
      if (typeof rec.startedAt !== 'number') continue; // cannot age it — no guess
      const ageSeconds = Math.floor((now - rec.startedAt) / 1000);
      if (ageSeconds <= stuckCallSeconds) continue;
      if (flags.some((f) => f.type === 'stuck-call' && f.callId === callId && f.status === 'open')) {
        continue;
      }
      // Close-out (Nov 27, 2026): a call whose stuck-call flag
      // already resolved stays resolved while its pairing is dead —
      // the pairing record can linger unbridged for hours (hangup
      // processed, status never flipped to 'ended'), and without
      // this the next scan would re-flag the same dead call one
      // minute after resolving it. New activity on the pairing
      // (updatedAt past the resolution) means the call is live
      // again and may flag afresh.
      const recUpdatedAt =
        typeof rec.updatedAt === 'number' ? rec.updatedAt : rec.startedAt || 0;
      if (
        flags.some(
          (f) =>
            f.type === 'stuck-call' &&
            f.callId === callId &&
            f.status === 'resolved' &&
            typeof f.resolvedAt === 'number' &&
            recUpdatedAt < f.resolvedAt
        )
      ) {
        continue;
      }
      // Thread lookup by PHONE first: rec.key is the pairing's
      // callControlId, not a thread key — byKey.get(rec.key) never
      // matches, so name/market were always blank on stuck-call
      // flags. Fall back to the key for legacy pairings whose key
      // already is the phone digits.
      const thread =
        threadForPhone(rec.phone) ||
        (rec.key ? byKey.get(rec.key) : null) ||
        null;
      const detail = [
        rec.lastEvent ? 'last event: ' + rec.lastEvent : 'no webhook event recorded',
        rec.lastError ? 'error: ' + rec.lastError : null,
        'agent answered: ' + (rec.agentAnswered ? 'yes' : 'no'),
        'seller human: ' + (rec.sellerHuman ? 'yes' : 'no'),
        rec.amdResult ? 'AMD: ' + rec.amdResult : null,
      ]
        .filter(Boolean)
        .join('; ');
      // The flag's `key` is the PHONE key (digits) — that is what the
      // Conversations tap path opens on (groupNotifFlags groups by
      // phone, openNotifThread prefers the phone). The callControlId
      // stays in `callId` only, so the stuck-call auto-resolve /
      // dedupe above still match the pairing. A callControlId's
      // digits are junk as a key, so it is never used as one.
      const phoneKey =
        digitsOf(rec.phone) ||
        digitsOf(thread && thread.phone) ||
        digitsOf(thread && thread.key) ||
        (/^\d{10,11}$/.test(String(rec.key || '')) ? String(rec.key) : '');
      flags.push({
        id: crypto.randomUUID(),
        type: 'stuck-call',
        key: phoneKey,
        phone: rec.phone || (thread && thread.phone) || '',
        name: (thread && thread.name) || '',
        market: (thread && thread.market) || '',
        callId,
        startedAt: rec.startedAt,
        ageSeconds,
        lastEvent: rec.lastEvent || '',
        lastError: rec.lastError || '',
        agentAnswered: rec.agentAnswered === true,
        sellerHuman: rec.sellerHuman === true,
        preview: ('Call stuck unbridged ' + ageSeconds + 's — ' + detail).slice(0, 200),
        flaggedAt: now,
        status: 'open',
      });
      flagged += 1;
    }
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
    deps.dialerStoreFactory =
      stores && stores.dialer ? () => stores.dialer : null;
  },
  reset() {
    deps.convStoreFactory = null;
    deps.enrollStoreFactory = null;
    deps.notifStoreFactory = null;
    deps.dialerStoreFactory = null;
  },
};

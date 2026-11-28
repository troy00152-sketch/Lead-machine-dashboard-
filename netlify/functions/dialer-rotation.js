// netlify/functions/dialer-rotation.js
// Dialer number rotation — XLeads 3X Dialer parity (Nov 28, 2026).
//
// What XLeads calls "Best Choice Number" the Command Center now does
// server-side, in the dialer pick path only (SMS keeps its own
// pickSender round-robin — untouched):
//
//   1. PERSISTED CURSOR — the old in-memory cursor restarted at pool[0]
//      on every cold start, so the first number took every early call.
//      The cursor now lives in Blobs (cc-dialer store, key 'rotation')
//      and survives restarts.
//   2. BEST CHOICE AREA-CODE MATCH — prefer a pool number whose area
//      code matches the recipient's (a 252 seller gets a 252 caller ID
//      when one is free); fall back to rotation order.
//   3. DAILY CAP + REST — each number slows off after ~80 calls in a
//      day (ET), the way XLeads slows a number after ~80. A capped
//      number is skipped for the rest of the day. If EVERY number is
//      capped the least-called one is used anyway (reason
//      'cap-overflow') — the machine never strands a queue over a
//      guardrail; the cap protects reputation, it is not a stop.
//   4. STICKY NUMBER PER CONTACT — once a contact answers on a number,
//      that number is permanently associated with the contact and is
//      used first on future calls (recorded in telnyx-voice-webhook's
//      declareWinner — first human answer wins). A sticky pick still
//      loses to the daily cap and to the excluded list.
//   5. EXCLUDED NUMBERS — a config list; excluded numbers are never
//      picked.
//
// Pure logic + persisted state. No Telnyx calls, no env vars, no
// network — fully unit-testable. The caller (cc-dialer-api) owns the
// store and saves the state after each pick; the webhook owns the
// sticky record. Counts are guardrails, not billing — a lost count in
// a concurrent write is harmless.
'use strict';

const lib = require('./telnyx-lib');

const ROTATION_KEY = 'rotation';
const DEFAULT_DAILY_CAP = 80;
const MAX_STICKY = 5000; // oldest entries pruned past this

// ---- time (ET day — the dialer's day runs on Eastern, like the bot) ----
function todayKey(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function areaCodeOf(number) {
  const d = lib.digitsOnly(number);
  // E.164 US: 1 + 3-digit area code + 7 digits.
  if (d.length === 11 && d.startsWith('1')) return d.slice(1, 4);
  if (d.length === 10) return d.slice(0, 3);
  return '';
}

// ---- state ----
function emptyState() {
  return {
    version: 1,
    cursor: {}, // market -> next rotation position
    counts: {}, // 'YYYY-MM-DD' (ET) -> { '+1252...': n }
    sticky: {}, // phoneKey (digits, country code) -> E.164 number
    excluded: [], // E.164 numbers never picked
    dailyCap: DEFAULT_DAILY_CAP,
  };
}

// Fill defaults, drop stale day counts, normalize stored shapes.
function normalizeState(raw, now) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.cursor && typeof raw.cursor === 'object') {
    for (const [k, v] of Object.entries(raw.cursor)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) s.cursor[String(k).toLowerCase()] = Math.floor(n);
    }
  }
  const today = todayKey(now);
  if (raw.counts && typeof raw.counts === 'object' && raw.counts[today] && typeof raw.counts[today] === 'object') {
    s.counts[today] = {};
    for (const [num, n] of Object.entries(raw.counts[today])) {
      const c = Number(n);
      if (Number.isFinite(c) && c > 0) {
        try { s.counts[today][lib.toE164(num)] = Math.floor(c); } catch (e) { /* skip junk */ }
      }
    }
  }
  if (raw.sticky && typeof raw.sticky === 'object') {
    for (const [k, v] of Object.entries(raw.sticky)) {
      try { s.sticky[lib.phoneKey(k)] = lib.toE164(v); } catch (e) { /* skip junk */ }
    }
  }
  if (Array.isArray(raw.excluded)) {
    for (const v of raw.excluded) {
      try {
        const n = lib.toE164(v);
        if (!s.excluded.includes(n)) s.excluded.push(n);
      } catch (e) { /* skip junk */ }
    }
  }
  const cap = Number(raw.dailyCap);
  if (Number.isFinite(cap) && cap >= 1 && cap <= 500) s.dailyCap = Math.floor(cap);
  return s;
}

async function readJson(store, key) {
  try {
    const v = await store.get(key, { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

async function loadState(store, now) {
  const raw = store ? await readJson(store, ROTATION_KEY) : null;
  return normalizeState(raw, now);
}

async function saveState(store, state) {
  if (!store) return;
  await store.set(ROTATION_KEY, JSON.stringify(state), { contentType: 'application/json' });
}

// ---- picking ----
// pickFrom(state, {market, to, pool, now}) -> {from, reason}
//   reason: 'sticky' | 'area-code' | 'rotation' | 'cap-overflow'
// Mutates the state's cursor (rotation position). Call recordDial()
// after the call is actually placed so the count only ever reflects
// real dials. Throws (fail closed) on an empty pool or when every
// number is excluded — dialNextBatch turns that into session.lastError
// and stops, exactly like the old no-pool failure.
function pickFrom(state, opts) {
  const o = opts || {};
  const market = String(o.market || '').toLowerCase();
  if (!market) throw new Error('pickFrom requires a market.');
  const rawPool = Array.isArray(o.pool) ? o.pool : lib.SENDER_POOLS[market];
  if (!rawPool) throw new Error('Unknown market: ' + market);
  const pool = [];
  for (const v of rawPool) {
    try {
      const n = lib.toE164(v);
      if (!pool.includes(n)) pool.push(n);
    } catch (e) { /* skip junk numbers */ }
  }
  if (!pool.length) {
    throw new Error('No sender numbers configured for market "' + market + '" yet (numbers not purchased).');
  }
  const excluded = new Set(state.excluded || []);
  const eligible = pool.filter((n) => !excluded.has(n));
  if (!eligible.length) {
    throw new Error('All sender numbers for market "' + market + '" are excluded — dialing paused.');
  }
  const today = todayKey(o.now);
  const dayCounts = (state.counts && state.counts[today]) || {};
  const countOf = (n) => Number(dayCounts[n] || 0);
  const cap = Number(state.dailyCap) || DEFAULT_DAILY_CAP;
  const isCapped = (n) => countOf(n) >= cap;

  // 1. Sticky: the number this contact answered on, if it is still
  //    usable (in the pool, not excluded, not capped today).
  let stickyFrom = null;
  try {
    const key = lib.phoneKey(o.to);
    const sticky = state.sticky && state.sticky[key];
    if (sticky && eligible.includes(sticky) && !isCapped(sticky)) stickyFrom = sticky;
  } catch (e) { /* bad recipient number — sticky simply does not apply */ }
  if (stickyFrom) {
    advanceCursor(state, market, [stickyFrom]);
    return { from: stickyFrom, reason: 'sticky' };
  }

  // 2. Best Choice: area-code match first, among numbers under the cap.
  const uncapped = eligible.filter((n) => !isCapped(n));
  const toArea = areaCodeOf(o.to || '');
  let candidates = uncapped;
  let reason = 'rotation';
  if (toArea) {
    const local = uncapped.filter((n) => areaCodeOf(n) === toArea);
    if (local.length) {
      candidates = local;
      reason = 'area-code';
    }
  }
  // 3. All capped: least-called number anyway — the cap is a
  //    guardrail, not a stop (never strand a queue over it).
  if (!candidates.length) {
    let best = eligible[0];
    for (const n of eligible) if (countOf(n) < countOf(best)) best = n;
    advanceCursor(state, market, [best]);
    return { from: best, reason: 'cap-overflow' };
  }
  const idx = (Number(state.cursor[market]) || 0) % candidates.length;
  const from = candidates[idx];
  state.cursor[market] = idx + 1;
  return { from, reason };
}

function advanceCursor(state, market, candidates) {
  // Keep the cursor moving even on sticky / overflow picks so the
  // next rotation pick does not re-land on the same slot.
  const idx = (Number(state.cursor[market]) || 0) % Math.max(1, candidates.length);
  state.cursor[market] = idx + 1;
}

// Record a placed dial against the number's daily count. Call only
// after createCall succeeds (a pick that never dialed is not counted).
function recordDial(state, from, now) {
  const today = todayKey(now);
  if (!state.counts) state.counts = {};
  if (!state.counts[today] || typeof state.counts[today] !== 'object') state.counts[today] = {};
  let n = null;
  try { n = lib.toE164(from); } catch (e) { return; }
  state.counts[today][n] = (Number(state.counts[today][n]) || 0) + 1;
}

// Record a human answer: this contact's sticky number from now on.
// Best-effort by design — callers wrap it in try/catch.
function recordAnswer(state, opts) {
  const o = opts || {};
  let key = null;
  let from = null;
  try { key = lib.phoneKey(o.phone); } catch (e) { return false; }
  try { from = lib.toE164(o.from); } catch (e) { return false; }
  if (!key || !from) return false;
  if (!state.sticky) state.sticky = {};
  state.sticky[key] = from;
  // Prune oldest entries past the cap (insertion order).
  const keys = Object.keys(state.sticky);
  if (keys.length > MAX_STICKY) {
    for (const k of keys.slice(0, keys.length - MAX_STICKY)) delete state.sticky[k];
  }
  return true;
}

// ---- config ----
// setConfig(state, {dailyCap, excluded}) -> {errors[]}
// Excluded numbers must be valid E.164; bad entries are reported, not
// silently dropped. dailyCap must be 1..500.
function setConfig(state, cfg) {
  const errors = [];
  const c = cfg || {};
  if (c.dailyCap !== undefined && c.dailyCap !== null && c.dailyCap !== '') {
    const cap = Number(c.dailyCap);
    if (!Number.isFinite(cap) || cap < 1 || cap > 500) {
      errors.push('dailyCap must be a whole number between 1 and 500.');
    } else {
      state.dailyCap = Math.floor(cap);
    }
  }
  if (c.excluded !== undefined) {
    if (!Array.isArray(c.excluded)) {
      errors.push('excluded must be a list of phone numbers.');
    } else {
      const next = [];
      for (const v of c.excluded) {
        try {
          const n = lib.toE164(v);
          if (!next.includes(n)) next.push(n);
        } catch (e) {
          errors.push('Not a valid US phone number: ' + v);
        }
      }
      if (!errors.length) state.excluded = next;
    }
  }
  return { errors };
}

// ---- panel view ----
// summarize(state, pools, now) -> per-market rows for dialer.html:
//   {market, numbers: [{number, today, capped, excluded, stickyFor}]}
// plus {dailyCap, stickyCount}. Numbers with no calls today still show
// (today: 0) so the panel always lists the whole pool.
function summarize(state, pools, now) {
  const today = todayKey(now);
  const dayCounts = (state.counts && state.counts[today]) || {};
  const excluded = new Set(state.excluded || []);
  const cap = Number(state.dailyCap) || DEFAULT_DAILY_CAP;
  const stickyCounts = {};
  for (const n of Object.values(state.sticky || {})) {
    stickyCounts[n] = (stickyCounts[n] || 0) + 1;
  }
  const markets = [];
  for (const [market, rawPool] of Object.entries(pools || {})) {
    const numbers = [];
    for (const v of rawPool || []) {
      let n = null;
      try { n = lib.toE164(v); } catch (e) { continue; }
      const todayCount = Number(dayCounts[n] || 0);
      numbers.push({
        number: n,
        today: todayCount,
        capped: todayCount >= cap,
        excluded: excluded.has(n),
        stickyFor: stickyCounts[n] || 0,
      });
    }
    markets.push({ market, numbers });
  }
  return {
    dailyCap: cap,
    stickyCount: Object.keys(state.sticky || {}).length,
    excluded: (state.excluded || []).slice(),
    markets,
  };
}

module.exports = {
  ROTATION_KEY,
  DEFAULT_DAILY_CAP,
  MAX_STICKY,
  todayKey,
  areaCodeOf,
  emptyState,
  normalizeState,
  loadState,
  saveState,
  pickFrom,
  recordDial,
  recordAnswer,
  setConfig,
  summarize,
};

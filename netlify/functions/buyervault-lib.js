// netlify/functions/buyervault-lib.js
// BuyerVault Pro §5A — shared library for the buyervault-* functions.
// Pure logic lives here so buyervault-regression.js can test it without
// Netlify Blobs or the network:
//   - market resolution over the exported market index (spec §6.2)
//   - ingestion-job builder (spec §6.4/§6.5): stored-data runs execute
//     against the bundled BuyerVault snapshot and report REAL counts;
//     external pulls (PropertyReach Core, county recorder) are never run
//     from the dashboard — they stop at the pre-flight credit gate
//     [HARD RULE B] in state blocked_budget with the reason on the run.
//   - HighLevel sync gate (spec §5 qualification gate + §16.4): config is
//     OFF by default; a buyer syncs only when verified phone + evidence
//     buy box + end-buyer strategy + not suppressed + score >= threshold.
//   - GHL payload builder (spec §16.3): buyer tags live ONLY in the bv-*
//     namespace [HARD RULE I — buyers and sellers never mix].
//   - saved-market monitoring math (spec §6.6): cadence + next-due.
// Storage: Netlify Blobs when available; an in-memory fallback keeps the
// functions (and the regression suite) working locally. The fallback is
// per-instance and non-durable — production uses Blobs.
'use strict';

const crypto = require('crypto');

// ------------------------------------------------------------------ http ---
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

// ----------------------------------------------------------------- auth ----
// Same lm_auth HMAC check as buyer-verify.js (cookie set by the gate edge
// function; secret = GATE_SECRET || DASHBOARD_PASSWORD, env only).
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
  const headers = (event && event.headers) || {};
  const cookie = getCookie(headers.cookie || headers.Cookie || '', 'lm_auth');
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

// --------------------------------------------------------------- storage ---
let _blobs = null;
try { _blobs = require('@netlify/blobs'); } catch (e) { _blobs = null; }
const _mem = new Map(); // fallback only; production path is Blobs
function store(event, name) {
  if (_blobs) {
    try {
      if (typeof _blobs.connectLambda === 'function' && event) _blobs.connectLambda(event);
      const s = _blobs.getStore(name);
      return {
        backend: 'blobs',
        async get(key) { const v = await s.get(key, { type: 'json' }); return v == null ? null : v; },
        async set(key, val) { await s.set(key, JSON.stringify(val), { contentType: 'application/json' }); },
        async del(key) { try { await s.delete(key); } catch (e) { /* noop */ } },
        async list() {
          try {
            const r = await s.list();
            return (r && r.blobs ? r.blobs : []).map((b) => b.key);
          } catch (e) { return []; }
        },
      };
    } catch (e) { /* fall through to memory */ }
  }
  const prefix = name + ':';
  return {
    backend: 'memory',
    async get(key) { return _mem.has(prefix + key) ? JSON.parse(_mem.get(prefix + key)) : null; },
    async set(key, val) { _mem.set(prefix + key, JSON.stringify(val)); },
    async del(key) { _mem.delete(prefix + key); },
    async list() {
      return [..._mem.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
  };
}

// ------------------------------------------------------------ formatting ---
function digits10(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ------------------------------------------------------- market resolve ----
// Spec §6.2: input resolves to a canonical market. Our stored index keys
// markets on city (master buyers) and county (candidate harvest); a ZIP
// resolves through the ZIP -> city map built from the master bundle.
function resolveMarket(index, q) {
  const raw = cleanStr(q, 120);
  if (!raw) return { match: null, alternates: [] };
  const markets = (index && index.markets) || [];
  const zips = (index && index.zips) || {};
  const ql = raw.toLowerCase().trim();
  const zipMatch = raw.match(/\b(\d{5})(?:-\d{4})?\b/);
  let stateHint = null;
  const stMatch = raw.match(/,\s*([A-Za-z]{2})\s*$/);
  if (stMatch) stateHint = stMatch[1].toUpperCase();

  // 1) ZIP -> city market.
  if (zipMatch && zips[zipMatch[1]]) {
    const z = zips[zipMatch[1]];
    const m = markets.find((x) => x.kind === 'city'
      && x.city.toLowerCase() === z.city.toLowerCase() && x.state === z.state);
    if (m) return { match: m, alternates: [], via: 'zip' };
  }
  const namePart = ql.replace(/,?\s*[a-z]{2}\s*$/, '').replace(/\s+county\s*$/, '').trim();
  const scored = [];
  for (const m of markets) {
    if (stateHint && m.state !== stateHint) continue;
    const city = (m.city || '').toLowerCase();
    const county = (m.county || '').toLowerCase();
    let s = 0;
    if (city && city === namePart) s = 100;
    else if (county && county === namePart) s = 98;
    else if (city && namePart && city.startsWith(namePart)) s = 70;
    else if (county && namePart && county.startsWith(namePart)) s = 68;
    else if ((city && namePart.includes(city)) || (county && namePart.includes(county))) s = 50;
    if (s) scored.push({ m, s });
  }
  scored.sort((a, b) => b.s - a.s || (b.m.buyers + b.m.candidates) - (a.m.buyers + a.m.candidates));
  if (!scored.length) return { match: null, alternates: [] };
  const top = scored[0];
  return {
    match: top.m,
    alternates: scored.slice(1, 5).map((x) => x.m),
    via: top.m.kind,
  };
}

// ------------------------------------------------------------- jobs --------
// Spec §6.4: searching/refreshing a market creates an ingestion job with
// one run per source. Stored-data sources run against the bundled
// snapshot and report real counts. External sources that could spend
// credits stop at the pre-flight gate [HARD RULE B] — the dashboard
// never pulls PropertyReach or recorder data on its own.
const JOB_SOURCES = [
  { id: 'master_buyers', label: 'Master buyer database (stored)', kind: 'stored' },
  { id: 'buyer_candidates', label: 'BuyerVault candidate harvest (stored)', kind: 'stored' },
  { id: 'sunbiz_entities', label: 'Sunbiz entity registry (stored, FL)', kind: 'stored' },
  { id: 'propertyreach_core', label: 'PropertyReach Core — fresh pull', kind: 'external' },
  { id: 'county_recorder', label: 'County recorder — fresh deeds', kind: 'external' },
];
const CREDIT_GATE_NOTE = 'Pre-flight credit gate [HARD RULE B]: external pulls need '
  + "Troy's explicit approval with a balance check and a hard cap before they run. "
  + 'Not run from the dashboard.';

function buildJob(market, trigger, meta) {
  const now = new Date().toISOString();
  const runs = JOB_SOURCES.map((src) => {
    if (src.kind === 'external') {
      return {
        source: src.id, label: src.label, mode: 'incremental',
        state: 'blocked_budget', recordsSeen: 0, recordsNew: 0,
        recordsUpdated: 0, creditsSpent: 0, errorMessage: CREDIT_GATE_NOTE,
        startedAt: now, finishedAt: now,
      };
    }
    if (src.id === 'master_buyers') {
      return {
        source: src.id, label: src.label, mode: 'full', state: 'succeeded',
        recordsSeen: market.buyers || 0, recordsNew: 0, recordsUpdated: 0,
        creditsSpent: 0, startedAt: now, finishedAt: now,
      };
    }
    if (src.id === 'buyer_candidates') {
      if (!market.candidates) {
        return {
          source: src.id, label: src.label, mode: 'full',
          state: 'not_available', recordsSeen: 0, recordsNew: 0,
          recordsUpdated: 0, creditsSpent: 0,
          errorMessage: 'No candidate harvest stored for this market yet.',
          startedAt: now, finishedAt: now,
        };
      }
      return {
        source: src.id, label: src.label, mode: 'full', state: 'succeeded',
        recordsSeen: market.candidates, recordsNew: 0, recordsUpdated: 0,
        creditsSpent: 0, startedAt: now, finishedAt: now,
      };
    }
    // sunbiz_entities
    if (market.state !== 'FL' || !market.entitiesLinked) {
      return {
        source: src.id, label: src.label, mode: 'full', state: 'not_available',
        recordsSeen: 0, recordsNew: 0, recordsUpdated: 0, creditsSpent: 0,
        errorMessage: 'Sunbiz linking exists for Florida markets only.',
        startedAt: now, finishedAt: now,
      };
    }
    return {
      source: src.id, label: src.label, mode: 'full', state: 'succeeded',
      recordsSeen: market.entitiesLinked, recordsNew: 0, recordsUpdated: 0,
      creditsSpent: 0, startedAt: now, finishedAt: now,
    };
  });
  const blocked = runs.some((r) => r.state === 'blocked_budget');
  const failed = runs.some((r) => r.state === 'failed');
  const events = [
    { at: now, type: 'job_created', message: `Refresh job created for ${market.label} (trigger: ${trigger}).` },
    ...runs.filter((r) => r.state === 'succeeded').map((r) => ({
      at: now, type: 'run_succeeded',
      message: `${r.label}: ${r.recordsSeen.toLocaleString('en-US')} stored records read.`,
    })),
    ...(market.buyers ? [{
      at: now, type: 'buyer_discovered',
      message: `${market.buyers.toLocaleString('en-US')} buyers on file in ${market.label} `
        + `(${market.qualified.toLocaleString('en-US')} qualified).`,
    }] : []),
    ...(market.candidates ? [{
      at: now, type: 'buyer_discovered',
      message: `${market.candidates.toLocaleString('en-US')} harvested candidates in ${market.label} `
        + '— no phone yet; PropertyReach skip trace (free in Core) is the next step.',
    }] : []),
    ...runs.filter((r) => r.state === 'blocked_budget').map((r) => ({
      at: now, type: 'run_blocked_budget',
      message: `${r.label}: held at the credit gate — needs Troy's approval.`,
    })),
  ];
  return {
    id: uid('job'), marketKey: market.key, marketLabel: market.label,
    trigger: trigger || 'manual',
    state: failed ? 'partial' : (blocked ? 'partial' : 'succeeded'),
    createdAt: now, finishedAt: now,
    dataAsOf: (meta && meta.generatedAt) || null,
    creditsSpent: 0, runs, events,
  };
}

// ------------------------------------------------- saved markets (§6.6) --
const CADENCE_DAYS = { daily: 1, weekly: 7, paused: null };
function nextDueAt(saved) {
  if (!saved || saved.cadence === 'paused') return null;
  const days = CADENCE_DAYS[saved.cadence] || 7;
  const base = saved.lastRefreshedAt ? Date.parse(saved.lastRefreshedAt) : Date.parse(saved.createdAt);
  if (!Number.isFinite(base)) return null;
  return new Date(base + days * 86400000).toISOString();
}
function monitoringStatus(saved, nowMs) {
  if (!saved || saved.cadence === 'paused') return 'paused';
  const due = nextDueAt(saved);
  if (!due) return 'never_refreshed';
  return nowMs >= Date.parse(due) ? 'due' : 'monitoring';
}

// ------------------------------------------------------------ HL sync ------
// Spec §16 defaults: threshold is TROY'S undecided call — the spec
// recommends 60+ with phone + buy box. Config ships OFF; nothing syncs
// until Troy decides the threshold AND turns it on AND a live env flag
// (BUYERVAULT_SYNC_LIVE=1) is set in Netlify. All three gates are code.
const SYNC_DEFAULTS = {
  enabled: false,
  minScore: 60,          // spec §16 recommendation — NOT decided by Troy yet
  requirePhone: true,
  requireBuyBox: true,
  updatedAt: null,
  updatedBy: null,
  note: 'Sync threshold is undecided (Troy). Default OFF — do not enable without his word.',
};
function syncConfig(raw) {
  const c = Object.assign({}, SYNC_DEFAULTS, raw || {});
  c.enabled = c.enabled === true;
  c.minScore = Math.max(0, Math.min(100, parseInt(c.minScore, 10) || 0));
  c.requirePhone = c.requirePhone !== false;
  c.requireBuyBox = c.requireBuyBox !== false;
  return c;
}
// sync-index row fields: [name, phone, score, tier, strategy, city, state,
//   props, avgPurchase, portfolioValue, likelyWholesaler, qualified]
function syncEligibility(row, cfg) {
  const reasons = [];
  const phone = digits10(row[1]);
  if (cfg.requirePhone && phone.length !== 10) reasons.push('no verified phone');
  if (!row[11]) reasons.push('not qualified (phone + evidence buy box required)');
  if (cfg.requireBuyBox && !((row[7] || 0) >= 1 || (row[8] || 0) > 0)) reasons.push('no evidence buy box');
  if ((row[2] || 0) < cfg.minScore) reasons.push(`score ${row[2] || 0} below threshold ${cfg.minScore}`);
  if (row[10]) reasons.push('flagged likely wholesaler/intermediary [HARD RULE D]');
  const strategy = String(row[4] || '');
  if (!strategy) reasons.push('no end-buyer strategy on file');
  if (/(^|\+)Lender($|\+)/.test(strategy) && !/(Flipper|Landlord)/.test(strategy)) {
    reasons.push('lender-only — not an end buyer [HARD RULE D]');
  }
  return { eligible: reasons.length === 0, reasons, phone };
}
function syncPreview(index, cfg, sampleLimit) {
  let eligible = 0;
  const excluded = {};
  const sample = [];
  for (const row of index) {
    const r = syncEligibility(row, cfg);
    if (r.eligible) {
      eligible++;
      if (sample.length < (sampleLimit || 25)) {
        sample.push({
          name: row[0], phone: r.phone, score: row[2], tier: row[3],
          strategy: row[4], city: row[5], state: row[6], props: row[7],
          avgPurchase: row[8],
        });
      }
    } else {
      for (const reason of r.reasons) {
        const key = reason.replace(/score \d+/, 'score N');
        excluded[key] = (excluded[key] || 0) + 1;
      }
    }
  }
  return { total: index.length, eligible, excluded, sample };
}
// Spec §16.3 payload. Tags ONLY in the bv-* namespace [HARD RULE I].
function ghlPayload(row, marketFips) {
  const strategy = String(row[4] || '').toLowerCase();
  const stratTag = strategy.includes('flipper') && strategy.includes('landlord')
    ? 'mixed' : strategy.includes('flipper') ? 'flipper'
      : strategy.includes('landlord') ? 'landlord' : 'mixed';
  const tags = ['bv-buyer', 'bv-strategy-' + stratTag];
  if (marketFips) tags.push('bv-market-' + marketFips);
  return {
    name: row[0],
    phone: '+1' + digits10(row[1]),
    customFields: {
      bv_quality_score: row[2] || 0,
      bv_strategy: row[4] || '',
      bv_price_band: row[8] ? ('avg purchase $' + Number(row[8]).toLocaleString('en-US')) : '',
      bv_markets: [row[5], row[6]].filter(Boolean).join(', '),
      bv_verified: 'No',
    },
    tags,
  };
}
function syncGate(cfg) {
  // Returns null when a live sync may proceed, else the blocking reason.
  if (!cfg.enabled) return 'Sync is OFF. The sync threshold is still Troy\'s undecided call — nothing syncs until he sets it and turns sync on.';
  if (process.env.BUYERVAULT_SYNC_LIVE !== '1') return 'Live sync env flag (BUYERVAULT_SYNC_LIVE) is not set in Netlify — sync stays in test mode.';
  return null;
}

module.exports = {
  json, isAdmin, store, digits10, cleanStr, uid,
  resolveMarket, buildJob, JOB_SOURCES, CREDIT_GATE_NOTE,
  CADENCE_DAYS, nextDueAt, monitoringStatus,
  SYNC_DEFAULTS, syncConfig, syncEligibility, syncPreview, ghlPayload, syncGate,
};

/* data-skiptrace-batch.js — bulk PropertyReach skip-trace, SYNC half.
 *
 * Works as a pair with data-skiptrace-batch-background.js:
 *   - THIS file (sync, <26s): start a job, report status, resume a stalled
 *     job, fetch results. It never calls PropertyReach itself.
 *   - data-skiptrace-batch-background.js: does the actual tracing in
 *     chunks (~300 addresses per invocation, up to 15 min per run).
 *
 * Why two functions: one invocation cannot trace 2,083 addresses inside
 * the 26s sync limit (assume ~1-2s per trace). The job + address list
 * live in the Netlify Blobs store 'skiptrace-batch'; the background
 * worker advances a stored cursor, so a cut-off run never re-traces an
 * address it already did (each trace costs 2 PR credits).
 *
 * Auth: this function sits behind the dashboard password gate (gate.ts),
 * same as the other data-* functions — no extra auth inside. The gate
 * cookie is forwarded when this function triggers the background worker,
 * because the background endpoint passes through the same gate.
 *
 * PR request/response handling is copied verbatim from data-skiptrace.js
 * (POST /v1/skip-trace, x-api-key from process.env.PROPERTYREACH_API_KEY).
 * The key is NEVER in code, files, logs, or chat.
 *
 * PR phones carry NO line-type — every phone in the output is flagged
 * lineType:'unknown'. Mobile-only filtering happens at send time, not here.
 *
 * Endpoints (same-origin, dashboard cookie applies):
 *   POST {action:'start', jobId, addresses:[{street,city,state,zip,apn?}]}
 *        -> {jobId, total, status, triggered, ...} (idempotent per jobId)
 *   POST {action:'resume', jobId, clearQuota?}
 *        -> re-invokes the background worker for this job
 *   GET  ?jobId=...            -> status (+ hit rate, doneFlag, resultsUrl)
 *   GET  ?action=results&jobId=...&offset=0&limit=500 -> traced results
 */
'use strict';

let blobs = null;
try {
  // Installed via package.json. Netlify injects site credentials at runtime;
  // connectLambda(event) hydrates them for v1 (exports.handler) functions.
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'skiptrace-batch';
const MAX_ADDRESSES = 5000;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESULTS_DEFAULT_LIMIT = 500;
const RESULTS_MAX_LIMIT = 5000;

// ---- test hooks (never set in production) ----
let __testStore = null;
let __testTrigger = null; // fn(jobId, event) -> {ok, status|error}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const notFound = (msg) => json(404, { error: msg || 'Not found' });
function serverError(msg) {
  return json(503, {
    error: 'Skip-trace batch storage is not ready yet',
    detail: msg,
    setup: 'Deploy with the @netlify/blobs dependency installed (package.json) and redeploy.',
  });
}

// ---- blob store (same pattern as deals-api.js) ----
function store(event) {
  if (__testStore) return __testStore;
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) { /* connectLambda is best-effort */ }
  return blobs.getStore(STORE_NAME);
}
async function readJson(s, key, fallback) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

const jobKey = (id) => `job:${id}`;
const addressesKey = (id) => `job:${id}:addresses`;
const resultPrefix = (id) => `job:${id}:r:`;

// ---- helpers ----
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function cleanJobId(v) {
  const s = String(v == null ? '' : v).trim();
  return JOB_ID_RE.test(s) ? s : null;
}
function parseBody(event) {
  let raw = event.body || '{}';
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { raw = '{}'; }
  }
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Accept both the canonical names ({street, city, state, zip, apn}) and the
// Dayton CSV column names ({Address, City, State, 'ZIP Code', 'Parcel/APN'}).
function normalizeAddress(a, i) {
  if (!a || typeof a !== 'object') throw new Error(`addresses[${i}]: not an object`);
  const street = cleanStr(a.street != null ? a.street : a.Address, 200);
  const city = cleanStr(a.city != null ? a.city : a.City, 100);
  const state = cleanStr(a.state != null ? a.state : a.State, 20);
  const zip = cleanStr(a.zip != null ? a.zip : (a['ZIP Code'] != null ? a['ZIP Code'] : a.ZIP), 20);
  const apn = cleanStr(a.apn != null ? a.apn : (a['Parcel/APN'] != null ? a['Parcel/APN'] : a.APN), 100);
  if (!street) throw new Error(`addresses[${i}]: missing street/Address`);
  if (!city) throw new Error(`addresses[${i}]: missing city/City`);
  if (!state) throw new Error(`addresses[${i}]: missing state/State`);
  return { street, city, state, zip: zip || null, apn: apn || null };
}

// Base URL of this site, for invoking the background function server-side.
function siteBase(event) {
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || h.Host || '';
  if (host) {
    const proto = h['x-forwarded-proto'] || h['X-Forwarded-Proto'] || 'https';
    return `${proto}://${host}`;
  }
  if (process.env.URL) return String(process.env.URL).replace(/\/$/, '');
  return 'https://leadmachineapp.com';
}

// Invoke the background worker. Netlify background functions are files
// ending in `-background.js`; their URL KEEPS the suffix:
//   POST /.netlify/functions/data-skiptrace-batch-background
// Netlify answers 202 immediately and runs the function for up to 15 min.
// The caller's dashboard cookie is forwarded so the edge password gate
// (gate.ts) lets the server-to-server call through — without it the gate
// returns the sign-in page (401) instead of running the worker.
async function triggerBackground(event, jobId) {
  if (__testTrigger) return __testTrigger(jobId, event);
  const url = siteBase(event) + '/.netlify/functions/data-skiptrace-batch-background';
  const h = event.headers || {};
  const cookie = h.cookie || h.Cookie || '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          cookie ? { cookie } : {}
        ),
        body: JSON.stringify({ jobId }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 202) return { ok: true, status: 202 };
    return { ok: false, status: res.status, error: `background trigger got HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

function statusPayload(job) {
  return {
    jobId: job.jobId,
    status: job.status, // running | complete | quota-hit | error
    total: job.total,
    done: job.done,
    withPhone: job.withPhone,
    errors: job.errors,
    prCreditsUsed: job.prCreditsUsed || 0,
    quotaHit: !!job.quotaHit,
    quotaMessage: job.quotaMessage || null,
    lastError: job.lastError || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    doneFlag: job.status === 'complete',
    remaining: Math.max(0, job.total - job.done),
    hitRate: job.done > 0 ? +(job.withPhone / job.done).toFixed(4) : null,
    resultsUrl: `/.netlify/functions/data-skiptrace-batch?action=results&jobId=${encodeURIComponent(job.jobId)}`,
  };
}

// ---- actions ----
async function actionStart(s, event, body) {
  const jobId = cleanJobId(body.jobId);
  if (!jobId) return bad('jobId is required (letters, digits, dash, underscore, max 64).');
  if (!Array.isArray(body.addresses) || body.addresses.length === 0) {
    return bad('addresses is required (non-empty array).');
  }
  if (body.addresses.length > MAX_ADDRESSES) {
    return bad(`addresses is capped at ${MAX_ADDRESSES} per job — split larger lists.`);
  }
  // Idempotent: a second start with the same jobId returns the existing job
  // and never restarts it (re-tracing would burn PR credits).
  const existing = await readJson(s, jobKey(jobId), null);
  if (existing) {
    return ok(Object.assign(statusPayload(existing), {
      note: 'job already exists — returning existing job, not restarted',
    }));
  }
  let addresses;
  try {
    addresses = body.addresses.map((a, i) => normalizeAddress(a, i));
  } catch (err) {
    return bad(err.message);
  }
  const now = new Date().toISOString();
  const job = {
    jobId,
    status: 'running',
    total: addresses.length,
    done: 0,
    withPhone: 0,
    errors: 0,
    prCreditsUsed: 0,
    quotaHit: false,
    quotaMessage: null,
    lastError: null,
    cursor: 0,
    running: false,
    runStartedAt: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await writeJson(s, addressesKey(jobId), addresses);
  await writeJson(s, jobKey(jobId), job);
  const trig = await triggerBackground(event, jobId);
  return ok(Object.assign(statusPayload(job), {
    triggered: trig.ok,
    trigger: trig.ok ? undefined : trig,
  }));
}

async function actionResume(s, event, body) {
  const jobId = cleanJobId(body.jobId);
  if (!jobId) return bad('jobId is required.');
  const job = await readJson(s, jobKey(jobId), null);
  if (!job) return notFound('Job not found.');
  if (job.status === 'complete') {
    return ok(Object.assign(statusPayload(job), { note: 'job already complete' }));
  }
  if (job.quotaHit && !body.clearQuota) {
    return json(409, Object.assign(statusPayload(job), {
      error: 'quota-hit — fix the PropertyReach quota first, then resume with clearQuota:true',
    }));
  }
  if (job.quotaHit && body.clearQuota) {
    job.quotaHit = false;
    job.quotaMessage = null;
    job.lastError = null;
    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    await writeJson(s, jobKey(jobId), job);
  }
  const trig = await triggerBackground(event, jobId);
  return ok(Object.assign(statusPayload(job), {
    triggered: trig.ok,
    trigger: trig.ok ? undefined : trig,
  }));
}

async function actionStatus(s, qs) {
  const jobId = cleanJobId(qs.jobId);
  if (!jobId) return bad('jobId is required (?jobId=...).');
  const job = await readJson(s, jobKey(jobId), null);
  if (!job) return notFound('Job not found.');
  return ok(statusPayload(job));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function actionResults(s, qs) {
  const jobId = cleanJobId(qs.jobId);
  if (!jobId) return bad('jobId is required (?jobId=...).');
  const job = await readJson(s, jobKey(jobId), null);
  if (!job) return notFound('Job not found.');
  const offset = Math.max(0, parseInt(qs.offset || '0', 10) || 0);
  const limit = Math.min(
    RESULTS_MAX_LIMIT,
    Math.max(1, parseInt(qs.limit || String(RESULTS_DEFAULT_LIMIT), 10) || RESULTS_DEFAULT_LIMIT)
  );
  const prefix = resultPrefix(jobId);
  let entries = [];
  try {
    const l = await s.list({ prefix });
    entries = (l && l.blobs) || [];
  } catch (e) { entries = []; }
  const keyRe = new RegExp('^' + escapeRegExp(prefix) + '(\\d+)$');
  const idxs = entries
    .map((e) => { const m = keyRe.exec(e.key || ''); return m ? parseInt(m[1], 10) : -1; })
    .filter((n) => n >= 0)
    .sort((a, b) => a - b);
  const slice = idxs.slice(offset, offset + limit);
  const results = [];
  for (let i = 0; i < slice.length; i += 25) {
    const batch = slice.slice(i, i + 25);
    const got = await Promise.all(batch.map((n) => readJson(s, `${prefix}${n}`, null)));
    for (const r of got) if (r) results.push(r);
  }
  results.sort((a, b) => a.index - b.index);
  return ok({
    jobId,
    status: job.status,
    total: job.total,
    done: job.done,
    offset,
    limit,
    available: idxs.length,
    returned: results.length,
    results,
  });
}

// ---- handler ----
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  }
  let s;
  try {
    s = store(event);
  } catch (e) {
    return serverError(e.message);
  }
  const qs = event.queryStringParameters || {};
  try {
    if (event.httpMethod === 'GET') {
      if ((qs.action || '') === 'results') return await actionResults(s, qs);
      return await actionStatus(s, qs);
    }
    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (!body) return bad('Request body must be JSON.');
      const action = String(body.action || '');
      if (action === 'start') return await actionStart(s, event, body);
      if (action === 'resume') return await actionResume(s, event, body);
      return bad("Unknown action. Use {action:'start'|'resume'}.");
    }
    return bad('Use GET for status/results, POST for start/resume.');
  } catch (err) {
    console.error('[skiptrace-batch]', err.message);
    return json(500, { error: 'Skip-trace batch hit a snag', detail: String(err.message || err).slice(0, 200) });
  }
};

// Offline test hooks (never set in production): node test script injects a
// fake Blobs store and a fake background trigger so nothing hits the network.
module.exports._test = {
  setStore: (fake) => { __testStore = fake; },
  setTrigger: (fn) => { __testTrigger = fn; },
  normalizeAddress,
  cleanJobId,
  siteBase,
};

// Offline sanity check (no network): node -e "const m=require('./data-skiptrace-batch.js'); console.log(typeof m.handler)"

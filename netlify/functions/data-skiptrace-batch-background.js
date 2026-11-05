/* data-skiptrace-batch-background.js — bulk PropertyReach skip-trace, WORKER.
 *
 * BACKGROUND FUNCTION: the filename MUST end in `-background.js` — that is
 * how Netlify knows to run it asynchronously (up to 15 min per invocation)
 * and answer the triggering HTTP call with 202 immediately. Its URL keeps
 * the suffix: POST /.netlify/functions/data-skiptrace-batch-background
 *
 * Invoked by data-skiptrace-batch.js (start/resume) with {jobId} in the
 * body, or directly by the driver with the same body. Each invocation:
 *   1. Loads the job from the Blobs store 'skiptrace-batch'.
 *   2. Traces the next chunk of addresses from the stored cursor
 *      (sequentially, small polite delay between calls).
 *   3. Writes one result blob per address (job:{id}:r:{index}) and updates
 *      the job counters after every 25 traces and at chunk end.
 *   4. Stops early on: chunk done (~300), 12-min wall-clock budget,
 *      a PropertyReach quota/rate-limit error, or 10 consecutive errors.
 *   5. Sets status 'complete' when the cursor reaches the total; otherwise
 *      leaves status 'running' so the driver can resume it.
 *
 * RESUME SAFETY: the cursor only ever moves forward and each address is
 * written once (one blob per index). A cut-off run never re-traces an
 * address — each trace costs 2 PR credits. A run-lock (running +
 * runStartedAt) stops two invocations tracing the same job at once; a
 * stale lock (>14 min, i.e. a dead invocation) is taken over.
 *
 * PR request/response handling is copied verbatim from data-skiptrace.js
 * (POST /v1/skip-trace, x-api-key from process.env.PROPERTYREACH_API_KEY).
 * The key is NEVER in code, files, logs, or chat.
 *
 * PR phones carry NO line-type — every phone is stored with
 * lineType:'unknown'. Mobile-only filtering happens at send time, not here.
 *
 * Tunables (env vars, defaults in parentheses):
 *   SKIPTRACE_BATCH_CHUNK_SIZE (300)  — addresses per invocation
 *   SKIPTRACE_BATCH_MAX_MS (720000)   — wall-clock budget per invocation
 *   SKIPTRACE_BATCH_DELAY_MS (200)    — polite pause between PR calls
 */
'use strict';

const https = require('https');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const API_BASE = 'https://api.propertyreach.com';
const STORE_NAME = 'skiptrace-batch';
const CHUNK_SIZE = Math.max(1, parseInt(process.env.SKIPTRACE_BATCH_CHUNK_SIZE || '300', 10) || 300);
const MAX_CHUNK_MS = Math.max(1000, parseInt(process.env.SKIPTRACE_BATCH_MAX_MS || '720000', 10) || 720000);
const POLITE_DELAY_MS = Math.max(0, parseInt(process.env.SKIPTRACE_BATCH_DELAY_MS || '200', 10) || 0);
const CONSEC_ERROR_LIMIT = 10;
const RUN_LOCK_MS = 14 * 60 * 1000; // stale-run takeover window (bg limit is 15 min)
const TRIGGER_TIMEOUT_MS = 10000;

// ---- test hooks (never set in production) ----
let __testStore = null;
let __testPost = null; // fn(path, body, apiKey) -> {http, json}
let __testTrigger = null; // fn(jobId, event) -> {ok, ...}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- PR call (copied from data-skiptrace.js) ----
function post(path, body, apiKey) {
  if (__testPost) return __testPost(path, body, apiKey);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Content-Length': Buffer.byteLength(data) },
      timeout: 25000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ http: res.statusCode, json: JSON.parse(raw) }); }
        catch (e) { resolve({ http: res.statusCode, json: null, raw: raw.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function bodyOk(r) {
  return r && r.json && r.json.meta && (r.json.meta.status === 200 || r.json.meta.status === 201);
}

// Quota / rate-limit detection. PR reports real status in meta.status
// inside an HTTP 200 body, so check both the HTTP code and the meta.
function isQuotaError(res) {
  if (!res) return false;
  if (res.http === 402 || res.http === 429) return true;
  const meta = (res.json && res.json.meta) || {};
  if (meta.status === 402 || meta.status === 429) return true;
  const msg = [meta.message, meta.error, res.json && res.json.message, res.json && res.json.error]
    .filter(Boolean).join(' ');
  return /quota|insufficient\s+credit|credit\s+(limit|exceeded|exhausted)|rate\s*limit|too many requests/i.test(msg);
}
function quotaMessage(res) {
  const meta = (res && res.json && res.json.meta) || {};
  return (meta.message || meta.error || (res && res.json && (res.json.message || res.json.error)) || `HTTP ${res ? res.http : 'unknown'}`).toString().slice(0, 300);
}

// Same target whitelist as data-skiptrace.js — only non-empty fields.
function buildTarget(addr) {
  const target = {};
  if (addr.street) target.streetAddress = addr.street;
  if (addr.city) target.city = addr.city;
  if (addr.state) target.state = addr.state;
  if (addr.zip) target.zip = addr.zip;
  if (addr.apn) target.apn = addr.apn;
  return target;
}

// Map one PR skip-trace response to a stored result record. Persons/person
// mapping matches data-skiptrace.js; phones gain lineType:'unknown'
// because PR returns no line-type (mobile vs landline is decided at send).
function mapTraceResponse(res, addr, index) {
  const rec = {
    index,
    street: addr.street,
    city: addr.city,
    state: addr.state,
    zip: addr.zip || null,
    apn: addr.apn || null,
    ownerName: null,
    phones: [],
    emails: [],
    prStatus: 'no-match', // matched | no-match | error
    error: null,
    credits: null,
    tracedAt: new Date().toISOString(),
  };
  const meta = (res && res.json && res.json.meta) || {};
  if (meta.credits != null) rec.credits = meta.credits;
  if (!bodyOk(res)) {
    rec.prStatus = 'error';
    rec.error = (meta.message || meta.error || `upstream http ${res ? res.http : 'fetch-failed'}`).toString().slice(0, 300);
    return rec;
  }
  const persons = (res.json.persons || []).map((p) => ({
    firstName: p.firstName || null,
    middleName: p.middleName || null,
    lastName: p.lastName || null,
    emails: (p.emails || []).map((e) => ({ email: e.email, firstReported: e.firstReported || null, lastReported: e.lastReported || null })),
    phones: (p.phones || []).map((ph) => ({ phone: ph.phone, firstReported: ph.firstReported || null, lastReported: ph.lastReported || null, lineType: 'unknown' })),
  }));
  const allPhones = [];
  const allEmails = [];
  persons.forEach((p) => {
    (p.phones || []).forEach((ph) => { if (ph.phone && !allPhones.find((x) => x.phone === ph.phone)) allPhones.push(ph); });
    (p.emails || []).forEach((e) => { if (e.email && !allEmails.find((x) => x.email === e.email)) allEmails.push(e); });
  });
  rec.phones = allPhones;
  rec.emails = allEmails;
  if (persons.length) {
    rec.prStatus = 'matched';
    const p0 = persons[0];
    const name = [p0.firstName, p0.lastName].filter(Boolean).join(' ').trim();
    rec.ownerName = name || null;
  }
  return rec;
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
const resultKey = (id, index) => `job:${id}:r:${index}`;

function siteBase(event) {
  const h = (event && event.headers) || {};
  const host = h['x-forwarded-host'] || h.host || h.Host || '';
  if (host) {
    const proto = h['x-forwarded-proto'] || h['X-Forwarded-Proto'] || 'https';
    return `${proto}://${host}`;
  }
  if (process.env.URL) return String(process.env.URL).replace(/\/$/, '');
  return 'https://leadmachineapp.com';
}

// Best-effort self-chain: after a chunk, if work remains and the quota is
// fine, fire the next background invocation. The dashboard cookie is
// forwarded so the edge gate lets it through. If this fails, the driver
// resumes via the sync function — self-chaining is a convenience, not
// the only path forward.
async function triggerNext(event, jobId) {
  if (__testTrigger) return __testTrigger(jobId, event);
  const url = siteBase(event) + '/.netlify/functions/data-skiptrace-batch-background';
  const h = (event && event.headers) || {};
  const cookie = h.cookie || h.Cookie || '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRIGGER_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          cookie ? { cookie } : {}
        ),
        body: JSON.stringify({ jobId }),
      });
      return { ok: res.status === 202, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

function parseBody(event) {
  let raw = (event && event.body) || '{}';
  if (event && event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { raw = '{}'; }
  }
  try { return JSON.parse(raw); } catch (e) { return null; }
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const body = parseBody(event);
  const jobId = body && typeof body.jobId === 'string' ? body.jobId.trim() : '';
  if (!jobId) return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing jobId.' }) };

  let s;
  try {
    s = store(event);
  } catch (e) {
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Blobs not ready', detail: e.message }) };
  }

  const job = await readJson(s, jobKey(jobId), null);
  if (!job) {
    console.error('[skiptrace-batch-bg] unknown job', jobId);
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Job not found.' }) };
  }
  if (job.status === 'complete') {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, done: true, note: 'already complete' }) };
  }
  if (job.quotaHit) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, done: false, note: 'quota-hit — resume with clearQuota after the quota is fixed' }) };
  }
  // Run lock: another invocation is actively working this job.
  if (job.running && job.runStartedAt && (Date.now() - job.runStartedAt) < RUN_LOCK_MS) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, done: false, note: 'another run is active', runStartedAt: job.runStartedAt }) };
  }

  const apiKey = process.env.PROPERTYREACH_API_KEY;
  if (!apiKey) {
    job.lastError = 'PROPERTYREACH_API_KEY not set';
    job.updatedAt = new Date().toISOString();
    await writeJson(s, jobKey(jobId), job);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'PROPERTYREACH_API_KEY not set' }) };
  }
  const addresses = await readJson(s, addressesKey(jobId), null);
  if (!Array.isArray(addresses) || !addresses.length) {
    job.lastError = 'job has no addresses stored';
    job.updatedAt = new Date().toISOString();
    await writeJson(s, jobKey(jobId), job);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Job has no addresses stored.' }) };
  }

  // Take the lock.
  job.running = true;
  job.runStartedAt = Date.now();
  job.updatedAt = new Date().toISOString();
  await writeJson(s, jobKey(jobId), job);

  let cursor = job.cursor || 0;
  let tracedThisRun = 0;
  let consecErrors = 0;
  let stopReason = null;

  try {
    while (cursor < job.total && tracedThisRun < CHUNK_SIZE) {
      if (Date.now() - t0 > MAX_CHUNK_MS) { stopReason = 'time-budget'; break; }
      const addr = addresses[cursor];
      const index = cursor;
      let rec;
      try {
        const res = await post('/v1/skip-trace', { target: buildTarget(addr) }, apiKey);
        if (isQuotaError(res)) {
          // STOP the chunk — do not keep hammering a dead quota.
          job.quotaHit = true;
          job.quotaMessage = quotaMessage(res);
          job.lastError = `quota: ${job.quotaMessage}`;
          job.status = 'quota-hit';
          stopReason = 'quota';
          break;
        }
        rec = mapTraceResponse(res, addr, index);
      } catch (err) {
        rec = {
          index,
          street: addr.street, city: addr.city, state: addr.state,
          zip: addr.zip || null, apn: addr.apn || null,
          ownerName: null, phones: [], emails: [],
          prStatus: 'error', error: String(err).slice(0, 300), credits: null,
          tracedAt: new Date().toISOString(),
        };
      }
      // One blob per address index — a resumed run never overwrites or
      // re-traces an index it already wrote.
      await writeJson(s, resultKey(jobId, index), rec);
      job.done += 1;
      cursor += 1;
      tracedThisRun += 1;
      if (rec.prStatus === 'matched' && rec.phones.length) job.withPhone += 1;
      if (rec.prStatus === 'error') {
        job.errors += 1;
        consecErrors += 1;
      } else {
        consecErrors = 0;
      }
      if (rec.credits != null) job.prCreditsUsed = (job.prCreditsUsed || 0) + rec.credits;
      else if (rec.prStatus === 'matched') job.prCreditsUsed = (job.prCreditsUsed || 0) + 2; // documented cost when PR omits meta.credits
      job.cursor = cursor;
      job.updatedAt = new Date().toISOString();
      if (consecErrors >= CONSEC_ERROR_LIMIT) {
        job.lastError = `stopped: ${CONSEC_ERROR_LIMIT} consecutive errors (last: ${rec.error || 'unknown'})`;
        stopReason = 'consec-errors';
        break;
      }
      // Persist counters regularly so a cut-off run loses at most ~25.
      if (tracedThisRun % 25 === 0) await writeJson(s, jobKey(jobId), job);
      if (tracedThisRun < CHUNK_SIZE && cursor < job.total && POLITE_DELAY_MS > 0) {
        await sleep(POLITE_DELAY_MS);
      }
    }
  } finally {
    // Always release the lock and persist the cursor, even on crash.
    job.cursor = cursor;
    job.running = false;
    job.runStartedAt = null;
    job.updatedAt = new Date().toISOString();
    if (cursor >= job.total && !job.quotaHit) {
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
    }
    try { await writeJson(s, jobKey(jobId), job); } catch (e) { console.error('[skiptrace-batch-bg] failed to persist job', e.message); }
  }

  // Best-effort self-chain for the next chunk (driver resume is the backup).
  let chained = null;
  if (job.status !== 'complete' && !job.quotaHit && (stopReason === null || stopReason === 'time-budget')) {
    chained = await triggerNext(event, jobId);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      status: job.status,
      done: job.done,
      total: job.total,
      withPhone: job.withPhone,
      errors: job.errors,
      tracedThisRun,
      stopReason,
      chained: chained ? chained.ok : false,
      doneFlag: job.status === 'complete',
    }),
  };
};

// Offline test hooks (never set in production).
module.exports._test = {
  setStore: (fake) => { __testStore = fake; },
  setPost: (fn) => { __testPost = fn; },
  setTrigger: (fn) => { __testTrigger = fn; },
  isQuotaError,
  mapTraceResponse,
  buildTarget,
};

// Offline sanity check (no network): node -e "const m=require('./data-skiptrace-batch-background.js'); console.log(typeof m.handler)"

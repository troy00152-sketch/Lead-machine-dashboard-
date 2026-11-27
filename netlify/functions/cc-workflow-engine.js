// netlify/functions/cc-workflow-engine.js
// Phase 3 of the standalone Command Center build: the workflow engine
// that mirrors the five HighLevel market SMS workflows exactly (see
// cc-workflows-config.js + ~/workspace/standalone-build/
// hl-workflow-steps.md).
//
// What HL does per enrollment (and what this engine mirrors):
//   market tag added -> Create Opportunity (Pipeline: Lead, Stage:
//   New Lead, value 0, status Open — implemented in enroll() below,
//   same approach as the live bot's pipeline.js: env-or-lookup stage
//   resolution, open-opportunity dedupe, HL contact resolved by phone
//   first; any failure is logged and never blocks the enrollment or
//   the send)
//   -> drip 300/day -> Wait window Mon–Sat 11:00–17:00 America/New_York
//   -> drip 1 send/minute -> "Is Active lead?" gate -> round-robin
//   assign (DISPLAY-ONLY standalone: the engine has no HL users to
//   assign to — the enrollment records the market; assignment happens
//   when the seller engages)
//   -> Random Split A–E (20% each)
//   -> per-path bad-number guard -> ONE first-text SMS -> END
//
// This engine models ONE first text per enrollment, exactly like HL:
//   enroll(contact)  — only when the contact carries the market's
//                      trigger tag; assigns a random path A–E; stage
//                      starts 'queued'.
//   tick(now)        — called once a minute (cc-workflow-tick.js).
//                      Per market: outside the send window -> nothing;
//                      daily cap 300 sends/market/day; at most ONE
//                      enrollment processed per market per tick (the
//                      1-per-minute drip). For the next due enrollment:
//                        dnc tag            -> 'ended-dnc'       (no send)
//                        active-lead gate   -> 'ended-inactive'  (no send)
//                        bad-number guard   -> 'ended-bad-number'(no send)
//                        already texted     -> 'ended-already-texted'
//                                              (no send — the
//                                              duplicate-send lock:
//                                              a phone that already
//                                              received an outbound
//                                              NEVER gets a second
//                                              first text)
//                        otherwise          -> render + send the
//                                              path's first text,
//                                              stage 'sent'.
//                      Sends FAIL CLOSED: if telnyx-lib throws (no API
//                      key, empty sender pool, Telnyx rejection), the
//                      enrollment stays 'queued', the error is recorded
//                      on it (lastError), and NO message is appended to
//                      the conversation store — a retry tick can send
//                      it later. Never marked sent, never dropped.
//
// Stores (Netlify Blobs):
//   'cc-enrollments'   <phoneDigits> -> enrollment record
//                      'index'       -> {updatedAt, enrollments:
//                                         {<key>: {market, stage}}}
//                      'counter-<ET date>' -> {date, markets:
//                                         {<marketId>: sendsToday}}
//   'cc-conversations' — the Phase 2 store; sends append to it exactly
//                      like cc-conversations-api's send action does
//                      (message stored 'queued' with the real Telnyx
//                      id/from; the webhook advances the status).
'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');
const libClient = require('./lib-client');
const cfg = require('./cc-workflows-config');
// Workflow definitions resolve through cc-workflows-store: builder
// edits stored in Blobs override the static seeds above, sanitized
// so the locked steps (bad-number guard, active-lead gate) always
// survive. A workflow whose effective status is 'draft' never
// enrolls and never sends. Resolution FAILS CLOSED: if the stored
// definitions cannot be read, enroll/tick throw rather than fall
// back to the seeds — a transient read failure must never resurrect
// a workflow the operator turned off.
const wfStore = require('./cc-workflows-store');

const ENROLL_STORE = 'cc-enrollments';
const CONV_STORE = 'cc-conversations';
const ENROLL_INDEX_KEY = 'index';
const PATHS = ['A', 'B', 'C', 'D', 'E'];
const MAX_MESSAGES_PER_THREAD = 500;

// ---- injectable dependencies (tests) ----
const deps = {
  enrollStoreFactory: null,
  convStoreFactory: null,
  sendSms: null,
  random: null,
  hlFetch: null,
};
function sendSmsImpl() {
  return deps.sendSms || lib.sendSms;
}
function randomImpl() {
  return deps.random ? deps.random() : Math.random();
}

function makeStore(name, factory, event) {
  if (factory) return factory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(name);
}
function enrollStore(event) {
  return makeStore(ENROLL_STORE, deps.enrollStoreFactory, event);
}
function convStore(event) {
  return makeStore(CONV_STORE, deps.convStoreFactory, event);
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

// ---- time helpers (America/New_York, the HL account timezone) ----
function etDateString(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}
function etParts(ts) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (const p of fmt.formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    weekday: parts.weekday, // Mon, Tue, ...
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
  };
}
function windowOpen(window, ts) {
  const p = etParts(ts);
  if (!window.days.includes(p.weekday)) return false;
  const [sh, sm] = window.start.split(':').map(Number);
  const [eh, em] = window.end.split(':').map(Number);
  const mins = p.hour * 60 + p.minute;
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}
function counterKey(ts) {
  return 'counter-' + etDateString(ts);
}

// ---- enrollments ----
// ---- index-loss fallback (Nov 27, 2026; v2 same day) ----
// The batch enroll's rapid read-modify-write index updates lose entries
// when Blobs reads lag writes: the 50-lead NC batch left only its last
// enrollee (Aaron Bower) in the index while all 50 records survived —
// the Contacts list reads records, so the page showed 50 queued while
// the tick saw zero and idled for 19 straight minutes. When the index
// shows no queued enrollment for a market, scan the records directly
// and repair the index entries found.
//
// V2 LESSON (same day, 12:33–12:54 live): v1 repaired the index and
// then the send's own saveEnrollment RE-READ the index (stale) and
// clobbered the repair — sends ran exactly one per 10-minute throttle
// window (12:33, 12:44, 12:54) instead of one per minute. So the tick
// now threads ONE in-memory index through the whole invocation: the
// scan repairs into it, every save inside the tick writes from it, and
// nothing inside a tick ever re-reads the index. The counter is
// threaded the same way. A scan only reads records the index does not
// already know about (list pre-check), so in steady state it costs one
// list call and zero reads. Throttle is a 2-minute backstop; a fresh
// enrollment resets it for its market. The duplicate-send lock
// (sentAt / prior outbound thread) still guards every record the scan
// finds — a scan can never resurrect a send.
const INDEX_SCAN_MS = 2 * 60 * 1000;
const SCAN_CAP = 2000;
const lastIndexScanAt = {};
async function scanQueuedRecords(s, market, idx) {
  const known = new Set(Object.keys((idx && idx.enrollments) || (await loadEnrollIndex(s)).enrollments || {}));
  let listed = [];
  if (typeof s.list === 'function') {
    try {
      const res = await s.list();
      listed = (res && (res.blobs || res.keys)) || [];
    } catch (e) { /* no listing: nothing new to discover */ }
  }
  // Only read records the index does not already know about. In
  // steady state that is nothing (one list call, zero reads); after an
  // index loss it is exactly the orphaned records.
  const missing = [];
  for (const b of listed) {
    const k = typeof b === 'string' ? b : (b && b.key);
    if (k && k !== ENROLL_INDEX_KEY && !known.has(String(k))) missing.push(String(k));
  }
  if (!missing.length) return [];
  const out = [];
  for (const k of missing.slice(0, SCAN_CAP)) {
    const r = await loadEnrollment(s, k);
    if (r && r.key === k && r.market === market && r.stage === 'queued') out.push(r);
  }
  out.sort((a, b) => (a.enrolledAt || 0) - (b.enrolledAt || 0) || (a.key < b.key ? -1 : 1));
  return out;
}
async function repairIndexEntries(s, recs, idx) {
  const target = idx || (await loadEnrollIndex(s));
  for (const r of recs) target.enrollments[r.key] = { market: r.market, stage: r.stage };
  target.updatedAt = Date.now();
  await writeJson(s, ENROLL_INDEX_KEY, target);
}

async function loadEnrollIndex(s) {
  return (await readJson(s, ENROLL_INDEX_KEY)) || { updatedAt: 0, enrollments: {} };
}
async function saveEnrollment(s, rec, idxOpt) {
  await writeJson(s, rec.key, rec);
  // idxOpt (the tick's in-memory index): use it instead of re-reading.
  // A re-read here can return a snapshot older than a repair written
  // moments earlier in the same tick and clobber it — that is the v1
  // stall (one send per throttle window). Callers outside the tick omit
  // it and keep the old load-each-time behavior.
  const idx = idxOpt || (await loadEnrollIndex(s));
  idx.enrollments[rec.key] = { market: rec.market, stage: rec.stage };
  idx.updatedAt = Date.now();
  await writeJson(s, ENROLL_INDEX_KEY, idx);
}
async function loadEnrollment(s, key) {
  return readJson(s, key);
}

function firstNameOf(contact) {
  const fn = contact.firstName || contact.first_name;
  if (fn) return String(fn).trim();
  const name = String(contact.name || '').trim();
  return name ? name.split(/\s+/)[0] : '';
}
function lowerTags(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());
}

// ---- pricing / identity stamping helpers ----
// A pricing value counts only when it is a finite number > 0 (numeric
// strings are coerced); 0, negatives, 'abc', null, objects etc. are
// treated as absent.
function normalizePricingValue(v) {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function normalizePricingFields(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of ['arv', 'mao', 'lao']) {
    const n = normalizePricingValue(src[k]);
    if (n != null) out[k] = n;
  }
  return out;
}
// Pricing may arrive as contact.pricing {arv, mao, lao} OR as top-level
// arv/mao/lao fields (the latter is also how older enrollment records
// may carry it). The nested object wins field-by-field.
function extractPricing(obj) {
  const o = obj || {};
  const out = normalizePricingFields(o);
  const nested = normalizePricingFields(o.pricing);
  return Object.assign(out, nested);
}
function unionTags(existingTags, newTags) {
  const out = [];
  const seen = new Set();
  for (const t of [...(Array.isArray(existingTags) ? existingTags : []), ...(Array.isArray(newTags) ? newTags : [])]) {
    const tag = String(t);
    const k = tag.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(tag);
  }
  return out;
}
function ensureTag(tags, tag) {
  if (!lowerTags(tags).includes(tag.toLowerCase())) tags.push(tag);
  return tags;
}
// A record is sealed when it carries any seal marker: the dnd flag, a
// sealedAt / sealReason stamp, or the 'dnc' tag.
function isSealedRecord(rec) {
  if (!rec) return false;
  return rec.dnd === true || rec.sealedAt != null || rec.sealReason != null || lowerTags(rec.tags).includes('dnc');
}
function listingVerifiedOf(c, lt) {
  return c.listingVerified === true || lt.includes('listing-verified') || lt.includes('priced-verified');
}

// enroll(contact, event?) -> {ok:true, enrollment} | {ok:false, reason}
// contact: {phone, name, firstName?, address1, city, market?, tags: []}
async function enroll(contact, event) {
  const c = contact || {};
  let key;
  let phone;
  try {
    key = lib.phoneKey(c.phone);
    phone = lib.toE164(c.phone);
  } catch (e) {
    return { ok: false, reason: 'invalid phone: ' + String(c.phone || '') };
  }
  const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t)) : [];
  const lt = lowerTags(tags);

  // Market: explicit market id wins; otherwise resolve from the tags.
  // Resolution runs over the EFFECTIVE definitions (stored builder
  // overrides win over the static seeds).
  const eff = await wfStore.loadEffective(event);
  let workflow = null;
  if (c.market) workflow = eff.map[String(c.market).toLowerCase()] || null;
  if (!workflow) {
    for (const t of tags) {
      workflow = wfStore.workflowByTagFrom(eff.map, t);
      if (workflow) break;
    }
  }
  if (!workflow) return { ok: false, reason: 'no market workflow matched (no market, no trigger tag)' };

  // Draft safety: a draft workflow never enrolls (HL fires nothing
  // for a draft workflow either).
  if (workflow.status === 'draft') {
    return { ok: false, reason: 'workflow "' + workflow.id + '" is a draft (not published)' };
  }

  // Trigger: the contact must carry the market's trigger tag (HL fires
  // on "Contact Tag Added" for exactly this tag).
  if (!lt.includes(workflow.tag.toLowerCase())) {
    return { ok: false, reason: 'missing trigger tag "' + workflow.tag + '"' };
  }

  // Pricing + identity stamping inputs (see helpers above).
  const newPricing = extractPricing(c);
  const listingVerified = listingVerifiedOf(c, lt);
  const dndInput = c.dnd === true || lt.includes('dnc');

  const s = enrollStore(event);
  // Load any existing record BEFORE writing: a re-enrollment must
  // never resurrect a sealed contact, and a live (non-terminal)
  // enrollment is updated in place rather than replaced.
  const existing = await loadEnrollment(s, key);
  let terminalExisting = null;
  let terminalSealed = false;

  if (existing) {
    const existingStage = String(existing.stage || '');
    const isTerminal = existingStage.startsWith('ended-') || existingStage === 'done';
    const sealed = isSealedRecord(existing);

    if (!isTerminal) {
      // Update in place: union tags, merge pricing (new fields win,
      // absent fields keep existing), keep stage/path/enrolledAt and
      // every other existing field (sentAt, messageId, seal stamps…).
      const merged = { ...existing };
      merged.tags = unionTags(existing.tags, tags);
      const mergedPricing = { ...extractPricing(existing), ...newPricing };
      if (Object.keys(mergedPricing).length) merged.pricing = mergedPricing;
      else delete merged.pricing;
      if (listingVerified || existing.listingVerified === true) merged.listingVerified = true;
      if (c.phoneType != null && c.phoneType !== '') merged.phoneType = c.phoneType;
      if (c.legalDescription != null && String(c.legalDescription).trim() !== '') merged.legalDescription = String(c.legalDescription);
      if (dndInput) merged.dnd = true;
      if (sealed) {
        // Seal persistence: dnd + seal stamps + the 'dnc' tag all
        // survive. tick() checks the 'dnc' tag first and ends such a
        // record 'ended-dnc' before any send.
        merged.dnd = true;
        if (existing.sealedAt != null) merged.sealedAt = existing.sealedAt;
        if (existing.sealReason != null) merged.sealReason = existing.sealReason;
        ensureTag(merged.tags, 'dnc');
      }
      merged.updatedAt = Date.now();
      await saveEnrollment(s, merged);
      lastIndexScanAt[workflow.id] = 0; // fresh enrollment: let the next tick scan if the index comes up empty
      return { ok: true, enrollment: merged, merged: true };
    }

    // Terminal existing record: fall through to a fresh enrollment,
    // EXCEPT the seal preservation and (when the new contact carries
    // no pricing at all) pricing preservation applied below.
    terminalExisting = existing;
    terminalSealed = sealed;
  }

  const path = PATHS[Math.min(PATHS.length - 1, Math.floor(randomImpl() * PATHS.length))];
  const rec = {
    key,
    phone,
    name: String(c.name || ''),
    firstName: firstNameOf(c),
    address1: String(c.address1 || c.address || ''),
    city: String(c.city || ''),
    market: workflow.id,
    tags,
    path,
    stage: 'queued',
    enrolledAt: Date.now(),
    sentAt: null,
    messageId: null,
    lastError: null,
    lastAttemptAt: null,
  };
  if (Object.keys(newPricing).length) rec.pricing = newPricing;
  if (listingVerified) rec.listingVerified = true;
  if (c.phoneType != null && c.phoneType !== '') rec.phoneType = c.phoneType;
  // Legal description (Nov 27): cc-enroll-api.js carries it on the
  // contact record and the drawer edits it — the fresh enrollment
  // record must carry it through too, or a fresh enroll drops it.
  if (c.legalDescription != null && String(c.legalDescription).trim() !== '') rec.legalDescription = String(c.legalDescription);
  if (dndInput) rec.dnd = true;
  if (terminalExisting) {
    if (!Object.keys(newPricing).length) {
      const keptPricing = extractPricing(terminalExisting);
      if (Object.keys(keptPricing).length) rec.pricing = keptPricing;
    }
    if (rec.legalDescription == null && terminalExisting.legalDescription != null && String(terminalExisting.legalDescription).trim() !== '') {
      rec.legalDescription = String(terminalExisting.legalDescription);
    }
    if (terminalSealed) {
      rec.dnd = true;
      if (terminalExisting.sealedAt != null) rec.sealedAt = terminalExisting.sealedAt;
      if (terminalExisting.sealReason != null) rec.sealReason = terminalExisting.sealReason;
      ensureTag(rec.tags, 'dnc');
    }
    if (terminalExisting.sentAt != null) {
      // DUPLICATE-SEND LOCK (Troy, 2026-11-21): this phone already
      // received a first text from this system once. The send
      // history carries forward and the fresh record lands
      // terminal — a re-enrollment from a later list can never
      // queue a second first text. (In HighLevel on 2026-11-21,
      // sellers first texted weeks earlier got a fresh first text
      // again off a new campaign list — Randall Smith, Ernest
      // Govan. This lock is why that cannot happen here.)
      rec.sentAt = terminalExisting.sentAt;
      rec.messageId = terminalExisting.messageId || null;
      rec.stage = 'ended-already-texted';
    }
  }
  await saveEnrollment(s, rec);
  lastIndexScanAt[workflow.id] = 0; // fresh enrollment: let the next tick scan if the index comes up empty
  // "Create opportunity" step (Nov 27, P1-4): the HL workflow creates
  // a Lead-pipeline / New Lead opportunity per enrollment. Same
  // approach as the live bot's pipeline.js (env-or-lookup stage
  // resolution, open-opportunity dedupe) — but GUARDED: HL token
  // required, the HL contact must resolve by phone first (exactly one
  // match or skip — a contact is never created here), and ANY failure
  // is logged and the enrollment stands. Only for fresh queued
  // enrollments; an already-texted re-enrollment gets no opportunity.
  if (rec.stage === 'queued' && !rec.dnd) {
    try {
      const opp = await createLeadOpportunity(rec, workflow);
      if (opp && opp.opportunityId) {
        rec.hlOpportunityId = opp.opportunityId;
        await saveEnrollment(s, rec);
      }
    } catch (e) {
      console.error('[cc-workflow-engine] Lead opportunity skipped for', rec.key, String((e && e.message) || e).slice(0, 150));
    }
  }
  return { ok: true, enrollment: rec };
}

// ---- HighLevel "Create opportunity" (Lead / New Lead) ----
// Per-endpoint HL versions (AGENTS.md): Opportunities + Contacts ride
// 2021-07-28; the search GET takes snake_case location_id /
// contact_id / pipeline_id (the raw DTO forbids camelCase there),
// while the POST body is camelCase — both exactly as the live bot's
// hl.js does it (searchOpportunities / createOpportunity).
const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_VERSION_OPPORTUNITIES = '2021-07-28';
const HL_VERSION_CONTACTS = '2021-07-28';
const HL_TIMEOUT_MS = 20000;
// Troy's own test contact — bookings from these never create
// opportunities (same skip as the live bot's pipeline.js).
const TEST_CONTACT_PHONES = new Set(['12035657810']); // Troy's own cell

function hlOppConfig() {
  const token = String(process.env.HL_API_TOKEN || '').trim();
  if (!token) return null;
  return {
    token,
    locationId: String(process.env.HL_LOCATION_ID || '').trim() || libClient.defaultLocationId(),
  };
}

async function hlFetchReal(cfgHl, path, opts) {
  const o = opts || {};
  const method = o.method || 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HL_TIMEOUT_MS);
  try {
    const res = await fetch(HL_API_BASE + path, {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + cfgHl.token,
        'Version': o.version || HL_VERSION_OPPORTUNITIES,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON body */ }
    if (!res.ok) throw new Error(`HL ${res.status}: ${(data && data.message) || text.slice(0, 150)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
function hlFetch(cfgHl, path, opts) {
  return (deps.hlFetch || hlFetchReal)(cfgHl, path, opts);
}

// In-memory pipeline cache per location (same as the live bot —
// Netlify functions are short-lived, so this mostly saves repeat
// lookups inside warm invocations).
const pipelineCache = new Map();

// Resolve the Lead pipeline id + its New Lead stage id. Env override
// wins (HL_LEAD_PIPELINE_ID / HL_LEAD_NEW_LEAD_STAGE_ID, no API call);
// otherwise one live lookup per location, cached. Throws when the
// pipeline or stage cannot be found — the caller treats that as "no
// opportunity", never as an enrollment failure.
async function resolveLeadPipelineNewLead(cfgHl) {
  const envPipe = String(process.env.HL_LEAD_PIPELINE_ID || '').trim();
  const envStage = String(process.env.HL_LEAD_NEW_LEAD_STAGE_ID || '').trim();
  if (envPipe && envStage) return { pipelineId: envPipe, stageId: envStage, source: 'env' };
  const cached = pipelineCache.get(cfgHl.locationId);
  if (cached) return { pipelineId: cached.pipelineId, stageId: cached.stageId, source: 'cache' };
  const data = await hlFetch(cfgHl, `/opportunities/pipelines?locationId=${encodeURIComponent(cfgHl.locationId)}`, { version: HL_VERSION_OPPORTUNITIES });
  const pipes = (data && data.pipelines) || [];
  const pipe = pipes.find((p) => String(p.name || '').toLowerCase() === 'lead');
  if (!pipe) throw new Error('Lead pipeline not found among location pipelines');
  const stage = (pipe.stages || []).find((s) => String(s.name || '').toLowerCase() === 'new lead');
  if (!stage) throw new Error('New Lead stage not found in the Lead pipeline');
  const resolved = { pipelineId: pipe.id, stageId: stage.id };
  pipelineCache.set(cfgHl.locationId, resolved);
  return { pipelineId: resolved.pipelineId, stageId: resolved.stageId, source: 'lookup' };
}

// Resolve the HL contact id for a phone via /contacts/lookup — a
// lookup returns a single contact (or 404), so a hit IS exactly one
// match. Returns null on miss: the caller SKIPS (never creates a
// contact here — an SMS-list enrollment must not mint HL contacts).
async function resolveHlContactIdByPhone(phoneE164, cfgHl) {
  const data = await hlFetch(cfgHl, `/contacts/lookup?phone=${encodeURIComponent(phoneE164)}&locationId=${encodeURIComponent(cfgHl.locationId)}`, { version: HL_VERSION_CONTACTS }).catch(() => null);
  if (!data) return null;
  const hit = data.contact || data;
  const id = hit && (hit.id || (Array.isArray(hit.contacts) && hit.contacts[0] && hit.contacts[0].id));
  return id ? String(id) : null;
}

// Create (or find) the Lead / New Lead opportunity for a fresh
// enrollment. Returns {opportunityId} on create-or-dedupe, or
// {skipped: reason} when there is nothing to do. THROWS on HL
// failure — the caller catches and keeps the enrollment.
async function createLeadOpportunity(rec, workflow) {
  const cfgHl = hlOppConfig();
  if (!cfgHl) return { skipped: 'no-hl-token' };
  const digits = String(rec.key || '').replace(/\D/g, '');
  if (TEST_CONTACT_PHONES.has(digits) || /troy final test/i.test(String(rec.name || ''))) return { skipped: 'test-contact' };
  const contactId = await resolveHlContactIdByPhone(rec.phone, cfgHl);
  if (!contactId) return { skipped: 'no-hl-contact' };
  const { pipelineId, stageId } = await resolveLeadPipelineNewLead(cfgHl);
  const found = await hlFetch(cfgHl, `/opportunities/search?location_id=${encodeURIComponent(cfgHl.locationId)}&contact_id=${encodeURIComponent(contactId)}&pipeline_id=${encodeURIComponent(pipelineId)}`, { version: HL_VERSION_OPPORTUNITIES });
  const opps = (found && found.opportunities) || [];
  const open = opps.find((o) => String(o.status || '').toLowerCase() === 'open' && String(o.pipelineId || o.pipeline_id || '') === String(pipelineId));
  if (open) return { existing: true, opportunityId: String(open.id) };
  const who = rec.firstName || rec.name || rec.address1 || 'Seller';
  const created = await hlFetch(cfgHl, '/opportunities/', {
    method: 'POST',
    version: HL_VERSION_OPPORTUNITIES,
    body: {
      locationId: cfgHl.locationId,
      pipelineId,
      pipelineStageId: stageId,
      contactId,
      name: who + ' — ' + (workflow.name || workflow.id) + ' lead',
      status: 'open',
    },
  });
  const c = created || {};
  const id = c.id || (c.opportunity && c.opportunity.id);
  if (!id) throw new Error('HL opportunity create returned no id');
  return { created: true, opportunityId: String(id) };
}

// ---- conversation store append (mirrors cc-conversations-api send) ----
async function appendOutbound(cs, key, phoneE164, market, msg) {
  const thread = (await readJson(cs, key)) || {
    phone: phoneE164, key, name: '', market: '', unread: 0, updatedAt: 0, messages: [],
  };
  if (!Array.isArray(thread.messages)) thread.messages = [];
  thread.phone = phoneE164;
  if (market && !thread.market) thread.market = market;
  // The Conversations screen shows "Texting from" this number.
  if (msg && msg.from) thread.ourNumber = msg.from;
  thread.messages.push(msg);
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  thread.updatedAt = Date.now();
  await writeJson(cs, key, thread);
  const idx = (await readJson(cs, 'index')) || { updatedAt: 0, threads: {} };
  const last = thread.messages[thread.messages.length - 1] || null;
  idx.threads[key] = {
    phone: thread.phone,
    name: thread.name || '',
    market: thread.market || '',
    preview: last ? String(last.body || '').slice(0, 120) : '',
    lastAt: last ? last.at : thread.updatedAt || 0,
    lastDir: last ? last.dir : null,
    unread: thread.unread || 0,
  };
  idx.updatedAt = Date.now();
  await writeJson(cs, 'index', idx);
  return thread;
}

// ---- daily counter ----
async function loadCounter(s, ts) {
  const key = counterKey(ts);
  return (await readJson(s, key)) || { date: etDateString(ts), markets: {} };
}
async function bumpCounter(s, ts, market) {
  const c = await loadCounter(s, ts);
  c.markets[market] = (c.markets[market] || 0) + 1;
  await writeJson(s, counterKey(ts), c);
  return c.markets[market];
}

// ---- tick ----
// Processes at most ONE due enrollment per market (the 1/min drip).
// Returns a per-market summary of what happened.
async function tick(now, event) {
  const ts = typeof now === 'number' ? now : Date.now();
  const es = enrollStore(event);
  const cs = convStore(event);
  const idx = await loadEnrollIndex(es);
  const counter = await loadCounter(es, ts);
  const results = [];

  const eff = await wfStore.loadEffective(event);
  for (const workflow of eff.list) {
    const market = workflow.id;
    const res = { market, action: 'idle' };

    // Draft safety: a draft workflow never sends, even for contacts
    // enrolled before it was unpublished — they stay queued.
    if (workflow.status === 'draft') {
      res.action = 'draft';
      results.push(res);
      continue;
    }

    if (!windowOpen(workflow.window, ts)) {
      res.action = 'window-closed';
      results.push(res);
      continue;
    }
    const sentToday = counter.markets[market] || 0;
    res.sentToday = sentToday;
    if (sentToday >= workflow.dripPerDay) {
      res.action = 'cap-reached';
      results.push(res);
      continue;
    }

    // Next due enrollment for this market: oldest queued first.
    let queuedKeys = Object.keys(idx.enrollments).filter(
      (k) => idx.enrollments[k].market === market && idx.enrollments[k].stage === 'queued'
    );
    if (!queuedKeys.length) {
      // Index-loss fallback (Nov 27, 2026): the index can lose entries
      // while the records survive, so an empty index must not end the
      // search. Scan the records, repair the index, and use what the
      // scan found. Throttled per market; a fresh enrollment resets it.
      const lastScan = lastIndexScanAt[market] || 0;
      if (ts - lastScan >= INDEX_SCAN_MS) {
        lastIndexScanAt[market] = ts;
        const scanned = await scanQueuedRecords(es, market, idx);
        if (scanned.length) {
          await repairIndexEntries(es, scanned, idx);
          res.repairedIndex = scanned.length;
          queuedKeys = scanned.map((r) => r.key);
        }
      }
      if (!queuedKeys.length) {
        results.push(res);
        continue;
      }
    }
    const recs = [];
    for (const k of queuedKeys) {
      const r = await loadEnrollment(es, k);
      if (r && r.stage === 'queued') recs.push(r);
    }
    recs.sort((a, b) => (a.enrolledAt || 0) - (b.enrolledAt || 0) || (a.key < b.key ? -1 : 1));
    if (!recs.length) {
      results.push(res);
      continue;
    }
    const rec = recs[0];
    res.key = rec.key;
    res.path = rec.path;
    const lt = lowerTags(rec.tags);

    // Opt-out seal: a dnc tag means never send, ever.
    if (lt.includes('dnc')) {
      rec.stage = 'ended-dnc';
      await saveEnrollment(es, rec, idx);
      res.action = 'ended-dnc';
      results.push(res);
      continue;
    }
    // "Is Active lead?" gate — none of the gate tags -> END.
    if (!workflow.activeLeadTags.some((t) => lt.includes(t.toLowerCase()))) {
      rec.stage = 'ended-inactive';
      await saveEnrollment(es, rec, idx);
      res.action = 'ended-inactive';
      results.push(res);
      continue;
    }
    // Per-path bad-number guard — before EVERY path's send.
    if (lt.includes(workflow.badNumberGuard.tag.toLowerCase())) {
      rec.stage = 'ended-bad-number';
      await saveEnrollment(es, rec, idx);
      res.action = 'ended-bad-number';
      results.push(res);
      continue;
    }

    // DUPLICATE-SEND LOCK (Troy, 2026-11-21): never a second first
    // text to the same phone — not from a re-enrollment, not from
    // another market's list, not after a manual send. Two proofs,
    // either one ends the enrollment without sending:
    //   1. this record already carries a sentAt (a first text went
    //      out under an earlier enrollment for this phone), or
    //   2. the conversation thread already holds ANY outbound
    //      message (a manual Conversations send, a bot reply — the
    //      person is already being talked to).
    if (rec.sentAt != null) {
      rec.stage = 'ended-already-texted';
      await saveEnrollment(es, rec, idx);
      res.action = 'ended-already-texted';
      results.push(res);
      continue;
    }
    const priorThread = await readJson(cs, rec.key);
    if (
      priorThread &&
      Array.isArray(priorThread.messages) &&
      priorThread.messages.some((m) => m && m.dir === 'out')
    ) {
      rec.stage = 'ended-already-texted';
      await saveEnrollment(es, rec, idx);
      res.action = 'ended-already-texted';
      results.push(res);
      continue;
    }

    const body = wfStore.renderFirstTextFrom(workflow, rec.path, {
      firstName: rec.firstName,
      address1: rec.address1,
      city: rec.city,
    });

    let sent;
    try {
      sent = await sendSmsImpl()({ to: rec.phone, body, market: workflow.telnyxMarket });
    } catch (e) {
      // FAIL CLOSED: stay queued, record the error, append nothing.
      rec.lastError = String((e && e.message) || e);
      rec.lastAttemptAt = ts;
      await saveEnrollment(es, rec, idx);
      res.action = 'send-error';
      res.error = rec.lastError;
      results.push(res);
      continue;
    }

    const msg = {
      id: sent.id || 'pending-' + ts + '-' + Math.random().toString(36).slice(2, 8),
      dir: 'out',
      body,
      status: 'queued', // webhook advances to sent/delivered/failed
      at: ts,
      from: sent.from || '',
      to: rec.phone,
    };
    await appendOutbound(cs, rec.key, rec.phone, market, msg);

    rec.stage = 'sent';
    rec.sentAt = ts;
    rec.messageId = msg.id;
    rec.lastError = null;
    rec.lastAttemptAt = ts;
    await saveEnrollment(es, rec, idx);
    // Thread the counter through the tick's in-memory copy, same as the
    // index: a reload here could lose another market's bump.
    counter.markets[market] = (counter.markets[market] || 0) + 1;
    await writeJson(es, counterKey(ts), counter);
    res.sentToday = counter.markets[market];
    res.action = 'sent';
    res.messageId = msg.id;
    results.push(res);
  }

  return { at: ts, dateET: etDateString(ts), results };
}

// ---- stampPricing (the auto-pricing writer's write path) ----
// stampPricing(phoneOrKey, pricing, event?, opts?) -> {ok:true,
// enrollment} | {ok:false, reason}. Merges normalized pricing fields
// onto an existing enrollment without wiping anything else;
// opts.listingVerified stamps the listing-verified flag.
async function stampPricing(phoneOrKey, pricing, event, opts) {
  let key;
  try {
    key = lib.phoneKey(phoneOrKey);
  } catch (e) {
    return { ok: false, reason: 'invalid phone: ' + String(phoneOrKey || '') };
  }
  const s = enrollStore(event);
  const rec = await loadEnrollment(s, key);
  if (!rec) return { ok: false, reason: 'not enrolled' };
  const mergedPricing = { ...extractPricing(rec), ...normalizePricingFields(pricing) };
  if (Object.keys(mergedPricing).length) rec.pricing = mergedPricing;
  if (opts && opts.listingVerified) rec.listingVerified = true;
  rec.updatedAt = Date.now();
  await saveEnrollment(s, rec);
  return { ok: true, enrollment: rec };
}

// ---- counts (for cc-enroll-api GET) ----
async function counts(event) {
  const es = enrollStore(event);
  const idx = await loadEnrollIndex(es);
  const byMarket = {};
  const totals = {};
  let total = 0;
  for (const entry of Object.values(idx.enrollments)) {
    const m = entry.market || 'unknown';
    if (!byMarket[m]) byMarket[m] = {};
    byMarket[m][entry.stage] = (byMarket[m][entry.stage] || 0) + 1;
    totals[entry.stage] = (totals[entry.stage] || 0) + 1;
    total += 1;
  }
  return { byMarket, totals, total };
}

module.exports = { enroll, tick, counts, stampPricing };

// Test hooks (not part of the deployed surface).
module.exports._test = {
  etDateString,
  etParts,
  windowOpen,
  counterKey,
  loadCounter,
  setStores(stores) {
    deps.enrollStoreFactory = stores && stores.enrollments ? () => stores.enrollments : null;
    deps.convStoreFactory = stores && stores.conversations ? () => stores.conversations : null;
  },
  setSendSms(fn) {
    deps.sendSms = fn || null;
  },
  setRandom(fn) {
    deps.random = fn || null;
  },
  // Fake the HL API (cfg, path, opts) -> parsed JSON, or throw to
  // simulate an HL failure. Null restores the real fetch.
  setHlFetch(fn) {
    deps.hlFetch = fn || null;
  },
  reset() {
    deps.enrollStoreFactory = null;
    deps.convStoreFactory = null;
    deps.sendSms = null;
    deps.random = null;
    deps.hlFetch = null;
    for (const k of Object.keys(lastIndexScanAt)) delete lastIndexScanAt[k];
    pipelineCache.clear();
  },
};

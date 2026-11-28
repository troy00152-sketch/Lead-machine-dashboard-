// netlify/functions/cc-bot-runner.js
// Runs the REAL seller bot (vendored verbatim from
// playbook-system/custom-bot — see bot/VENDOR.md) against the standalone
// stores via cc-client.js. This is the bot-core port: the brain is the
// proven handler/guards/booking/pipeline code; only the transport
// changed. NOTHING here talks to HighLevel — cc-client reads/writes
// cc-conversations / cc-enrollments / cc-appointments / cc-opportunities
// only.
//
// Activation (all Troy's go-live switches):
//   CC_BOT_LOCAL=1            cc-bot-hook routes inbound replies here
//   CC_BOT_SECRET             shared secret for the internal handler
//                             event (falls back to CC_TICK_SECRET)
//   LLM_API_KEY (or OPENAI_API_KEY)   the model key the bot already uses
// Without the secret or an LLM key, configured() is false and
// cc-bot-hook stays in log-only mode — fail closed, never a fake reply.
'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../../bot/src/config');
const { createHandler } = require('../../bot/src/handler');
const { createLlm } = require('../../bot/src/llm');
const { loadKnowledge } = require('../../bot/src/prompt');
const telnyxLib = require('./telnyx-lib');

// Captured from HighLevel 2026-11-16 (standalone-build/hl-inventory.md):
// the Lead pipeline + its Appointment Set stage, so pipeline.js takes
// its env fast-path instead of a live lookup.
const LEAD_PIPELINE_ID = 'TBpvmSWKwDTX8heKQ3VK';
const LEAD_APPOINTMENT_STAGE_ID = '4696c413-c115-4514-ae2e-e66efdaf0b13';
const SELLER_CALLS_CALENDAR_ID = 'seller-calls';

function botSecret() {
  return process.env.CC_BOT_SECRET || process.env.CC_TICK_SECRET || '';
}
function llmKeyPresent() {
  return !!(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY);
}
function configured() {
  return !!botSecret() && llmKeyPresent();
}

// Knowledge bootstrap: prefer the vendored prompt.js loader (its
// candidate dirs cover the deployed bundle via $LAMBDA_TASK_ROOT and
// cwd). When the files aren't reachable that way (e.g. a bundler layout
// where only included_files shipped them), inject the cache directly
// from this repo's knowledge/ dir, replicating the persona name swap
// prompt.js performs (Ashley -> Amber for the amber persona).
let knowledgeReady = false;
// Pristine vendored knowledge, captured once per container before any
// config override is applied. Overrides MUST always start from this
// copy: re-applying them to an already-overridden kb would shift the
// 'faq-N' -> index mapping after a deletion (and double-append
// additions). The live handler re-reads knowledge through
// loadKnowledge() at prompt-build time, so re-injecting the overridden
// copy here is what the model actually sees.
let pristineKnowledge = null;

// applyBotConfigToKnowledge(persona, botConfig, log) — layer the
// stored Conversation AI config onto the vendored knowledge and
// re-inject it via loadKnowledge.cache() (the same injection the
// fallback path below uses). Idempotent: every application starts from
// pristineKnowledge, so a warm container re-applying on every
// invocation converges instead of drifting.
//   * instructions.<persona> (joined section text from the screen)
//     REPLACES the prompt body — the code-owned output contract in
//     prompt.js buildSystemPrompt() is NOT touched.
//   * faqs {'faq-N': answer} replace the vendored answer at index N-1
//     (kb.json carries no ids; the screen's starter set is kb.json's
//     first 31 entries, in order). Any other key matches by exact
//     question text.
//   * faqsDeleted removes starter entries; faqAdditions appends the
//     screen's added questions (deduped by id).
// Returns true when an override was applied.
function applyBotConfigToKnowledge(persona, botConfig, log) {
  if (!botConfig || !pristineKnowledge) return false;
  try {
    const cloned = JSON.parse(JSON.stringify(pristineKnowledge));
    const faqs = Array.isArray(cloned.kb.faqs) ? cloned.kb.faqs : [];
    let changed = false;
    const overrides = (botConfig.faqs && typeof botConfig.faqs === 'object') ? botConfig.faqs : {};
    for (const key of Object.keys(overrides)) {
      const ans = String(overrides[key] || '');
      if (!ans) continue;
      let idx = -1;
      const m = /^faq-(\d+)$/.exec(String(key));
      if (m) {
        const n = parseInt(m[1], 10);
        // kb.json carries no ids but DOES carry n (1..31, in order);
        // prefer the n match, fall back to array position N-1.
        idx = faqs.findIndex((f) => f && f.n === n);
        if (idx === -1 && n >= 1 && n <= faqs.length) idx = n - 1;
      }
      if (idx === -1) idx = faqs.findIndex((f) => String(f.question || '').trim() === String(key).trim());
      if (idx !== -1) {
        faqs[idx] = { ...faqs[idx], answer: ans };
        changed = true;
      }
    }
    const deleted = new Set(Array.isArray(botConfig.faqsDeleted) ? botConfig.faqsDeleted.map(String) : []);
    if (deleted.size) {
      cloned.kb.faqs = faqs.filter((f, i) => !deleted.has('faq-' + (f.n || (i + 1))));
      changed = true;
    } else {
      cloned.kb.faqs = faqs;
    }
    const additions = Array.isArray(botConfig.faqAdditions) ? botConfig.faqAdditions : [];
    if (additions.length) {
      const have = new Set((cloned.kb.faqs || []).map((f) => String(f.id || f.question || '')));
      for (const a of additions) {
        if (!a || !a.question || !a.answer) continue;
        const id = String(a.id || a.question);
        if (have.has(id)) continue;
        have.add(id);
        cloned.kb.faqs.push({ id: a.id || undefined, question: String(a.question), answer: String(a.answer) });
        changed = true;
      }
    }
    const instr = (botConfig.instructions && typeof botConfig.instructions === 'object') ? botConfig.instructions : {};
    const text = persona === 'sam'
      ? (instr.sam || '')
      : (persona === 'amber' ? (instr.amber || instr.ashley || '') : (instr.ashley || ''));
    if (text && String(text).trim()) {
      cloned.promptBody = String(text).trim();
      changed = true;
    }
    if (!changed) return false;
    loadKnowledge.cache(cloned);
    log('cc-bot-runner: applied stored bot config to knowledge (persona ' + persona + ')');
    return true;
  } catch (e) {
    log('cc-bot-runner: bot-config knowledge override FAILED — running vendored knowledge: ' + e.message);
    return false;
  }
}

function ensureKnowledge(persona, log, botConfig) {
  if (!knowledgeReady) {
    try {
      loadKnowledge(persona);
      knowledgeReady = true;
    } catch (e) {
      log('cc-bot-runner: natural knowledge load failed (' + e.message + ') — trying cache injection');
      try {
        const dir = path.resolve(__dirname, '..', '..', 'knowledge');
        const promptMd = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
        const kb = JSON.parse(fs.readFileSync(path.join(dir, 'kb.json'), 'utf8'));
        const swap = (t) => (persona === 'amber' ? String(t || '').replace(/\bAshley\b/g, 'Amber') : String(t || ''));
        const body = promptMd.replace(/<!--[\s\S]*?-->/g, '').trim();
        const swappedKb = {
          ...kb,
          faqs: (kb.faqs || []).map((f) => ({ ...f, question: swap(f.question), answer: swap(f.answer) })),
          objections: (kb.objections || []).map((o) => ({ ...o, trigger: swap(o.trigger), reply: swap(o.reply) })),
        };
        loadKnowledge.cache({ promptBody: swap(body), kb: swappedKb });
        knowledgeReady = true;
        log('cc-bot-runner: knowledge injected from ' + dir);
      } catch (e2) {
        log('cc-bot-runner: KNOWLEDGE LOAD FAILED — bot will fail closed to silence: ' + e2.message);
        return false;
      }
    }
  }
  // Capture the pristine copy once (before any override), then layer
  // the stored config on top — on EVERY invocation, so a screen edit
  // lands without waiting for a cold start. Fail-open: any failure
  // here leaves the vendored knowledge in place.
  if (knowledgeReady && !pristineKnowledge) {
    try {
      pristineKnowledge = JSON.parse(JSON.stringify(loadKnowledge(persona)));
    } catch (e) {
      log('cc-bot-runner: could not snapshot vendored knowledge — config overrides skipped: ' + e.message);
    }
  }
  if (knowledgeReady && botConfig) applyBotConfigToKnowledge(persona, botConfig, log);
  return knowledgeReady;
}

let handlerInstance = null;
let handlerClient = null;
let testOverrides = null;
// Live handler config (the loadConfig object the vendored handler
// closes over) + persona, so per-invocation config can be applied to a
// warm container without rebuilding the handler.
let liveHandlerConfig = null;
let livePersona = 'amber';
// Test override for the stored bot config: undefined = not set (load
// from the store); null = force fail-open (no config); an object =
// use it instead of the store.
let botConfigOverride;
let lastBotConfig = null;

// loadBotConfigForInvocation(event) -> merged stored config, or null.
// Null means "could not read the store" — the caller FAILS OPEN to
// vendored knowledge + env booking rules (a transient Blobs failure
// must never silence the live bot). A successful load with no stored
// record returns the merged DEFAULTS (never null).
async function loadBotConfigForInvocation(lambdaEvent) {
  if (botConfigOverride !== undefined) {
    lastBotConfig = botConfigOverride;
    return botConfigOverride;
  }
  try {
    const mod = require('./cc-bot-config');
    const cfg = await mod.loadBotConfig(lambdaEvent);
    lastBotConfig = cfg;
    return cfg;
  } catch (e) {
    lastBotConfig = null;
    return null;
  }
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
// Guardrail toggles (Nov 27, 2026 — Conversation AI screen): the stored
// config's guardrails are copied onto the live handler config, so the
// vendored handler gates each seal/silence rule on its toggle (see
// bot/src/handler.js guardOn). Only an explicit `false` disables a
// rule; true/absent means ON.
// FAIL-CLOSED: when the stored config can't be read (botConfig null),
// any previously applied toggles are CLEARED from the live config, so
// a warm container never carries a stale OFF across a failed config
// load — every rule reads as ON.
const GUARDRAIL_IDS = ['optout', 'big-ask', 'over-mao', 'referral', 'booked', 'listed'];
function applyGuardrailsConfig(liveConfig, botConfig, log) {
  if (!liveConfig) return false;
  const g = botConfig && botConfig.guardrails && typeof botConfig.guardrails === 'object'
    ? botConfig.guardrails
    : null;
  if (!g) {
    if (liveConfig.guardrails) delete liveConfig.guardrails;
    return false;
  }
  const out = {};
  for (const id of GUARDRAIL_IDS) {
    if (typeof g[id] === 'boolean') out[id] = g[id];
  }
  liveConfig.guardrails = out;
  log('cc-bot-runner: guardrails applied ('
    + GUARDRAIL_IDS.map((id) => id + '=' + (out[id] === false ? 'OFF' : 'on')).join(', ') + ')');
  return true;
}
// applyBookingConfig(liveConfig, botConfig, log) — feed the screen's
// booking rule into the slot engine through the knobs the vendored
// booking.js ALREADY reads per call:
//   windowDays  -> config.slotDaysAhead (offer/bookable horizon)
//   slots       -> config.slotOfferCount (offer cap)
//   minGapHours -> config.slotMinGapHours. booking.js spaces offers by
//     this gap in getOfferSlots/getWindowSlots (Nov 27 mirror close-out);
//     getBookableSlots is deliberately NOT spaced (pick verification).
// DECOUPLED (Nov 27, 2026 — Paula's 5:12 PM retest): the stored booking
// hours (hoursStart/hoursEnd, the CALL window, last start 16:30) are
// NEVER copied onto config.hoursStart/hoursEnd. Those fields are the
// REPLY gate (vendored 8-21 in bot/src/config.js — Troy's rule: the bot
// answers 8 AM-9 PM ET). The Nov 27 9:15 AM deploy overwrote them with
// the booking hours (+30-min skew: 16:30 -> 17), so every inbound after
// 5 PM hit step 7 'after-hours' and the bot stayed silent. The slot
// engine does not need the copy: getOfferSlots/getBookableSlots hard-clip
// to inBookingWindow (8 AM-5 PM) and cc-slots.js only generates starts
// 08:00-16:30, so no evening slot can ever be offered.
function applyBookingConfig(liveConfig, botConfig, log) {
  if (!liveConfig || !botConfig || !botConfig.booking) return false;
  const b = botConfig.booking;
  liveConfig.slotDaysAhead = clampInt(b.windowDays, 1, 14, liveConfig.slotDaysAhead);
  liveConfig.slotOfferCount = clampInt(b.slots, 1, 6, liveConfig.slotOfferCount);
  liveConfig.slotMinGapHours = clampInt(b.minGapHours, 0, 12, 3);
  log('cc-bot-runner: booking rules applied (window ' + liveConfig.slotDaysAhead
    + 'd, ' + liveConfig.slotOfferCount + ' slots, gap ' + liveConfig.slotMinGapHours
    + 'h; reply gate stays ' + liveConfig.hoursStart + '-' + liveConfig.hoursEnd + ')');
  return true;
}

// Merge the module-level test overrides with per-call overrides
// (dry-run). Per-call wins per key; stores merge per store.
function effectiveOverrides(callOverrides) {
  const base = testOverrides || {};
  const over = callOverrides || {};
  const merged = { ...base, ...over };
  if (base.stores || over.stores) merged.stores = { ...(base.stores || {}), ...(over.stores || {}) };
  return merged;
}

function buildHandler(log, lambdaEvent, callOverrides) {
  const ov = effectiveOverrides(callOverrides);
  const env = {
    ...process.env,
    // The vendored loadConfig requires these keys to exist; cc-client
    // ignores the values entirely (it never calls HighLevel).
    HL_API_TOKEN: process.env.HL_API_TOKEN || 'cc-standalone-unused',
    HL_LOCATION_ID: process.env.HL_LOCATION_ID || 'cc-standalone',
    HL_CALENDAR_ID: process.env.HL_CALENDAR_ID || SELLER_CALLS_CALENDAR_ID,
    WEBHOOK_SHARED_SECRET: botSecret(),
    HL_LEAD_PIPELINE_ID: LEAD_PIPELINE_ID,
    HL_LEAD_APPOINTMENT_STAGE_ID: LEAD_APPOINTMENT_STAGE_ID,
    // The live twin runs Amber (Nov 5, 2026) — default to her when the
    // env doesn't say otherwise.
    BOT_PERSONA: process.env.BOT_PERSONA || 'amber',
  };
  const config = loadConfig(env);
  liveHandlerConfig = config;
  livePersona = config.botPersona || 'amber';
  // Kansas City Telnyx numbers are Central-time sellers too: extend the
  // config's KC set (which holds the old HL numbers) with our pool so
  // offer times get Central labels for KC threads.
  try {
    const kc = (telnyxLib.SENDER_POOLS && telnyxLib.SENDER_POOLS.kansascity) || [];
    for (const n of kc) {
      const digits = String(n).replace(/\D/g, '');
      const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      if (ten.length === 10) config.centralMarketNumbers.add(ten);
    }
  } catch (e) {
    log('cc-bot-runner: could not extend centralMarketNumbers: ' + e.message);
  }

  ensureKnowledge(config.botPersona || 'amber', log);

  const CcClient = require('./cc-client').CcClient;
  const clientOpts = {};
  if (ov && ov.stores) {
    if (ov.stores.conversations) clientOpts.conversations = ov.stores.conversations;
    if (ov.stores.enrollments) clientOpts.enrollments = ov.stores.enrollments;
    if (ov.stores.opportunities) clientOpts.opportunities = ov.stores.opportunities;
    if (ov.stores.appointments) {
      // cc-client reads appointments through the cc-appointments module;
      // point its store factory at the injected store.
      try {
        require('./cc-appointments')._test.setStoreFactory(() => ov.stores.appointments);
      } catch (e) {
        log('cc-bot-runner: could not inject appointments store: ' + e.message);
      }
    }
  }
  if (ov && ov.sendSms) clientOpts.sendSms = ov.sendSms;
  // Suggest capture (cc-bot-drafts): the handler's appointment calls
  // go through this API instead of the real cc-appointments module,
  // so a would-be booking lands in the mem store only — no HighLevel
  // event, no push — until a human approves the draft.
  if (ov && ov.appointmentsApi) clientOpts.appointmentsApi = ov.appointmentsApi;
  // The Lambda event for this invocation: without it the client's
  // default Blobs stores have no context on Netlify Functions v1
  // (reads miss, writes silently no-op — the Nov 26 Amber
  // repeat-question + missing-outbound bug). The handler calls hl.*
  // with no event argument, so the client must carry it.
  if (lambdaEvent) clientOpts.event = lambdaEvent;
  const hl = new CcClient(clientOpts);
  handlerClient = hl;
  const llm = ov && ov.llm ? ov.llm : createLlm(config);
  const deps = { config, hl, llm, logger: { log } };
  if (ov && ov.now) deps.now = ov.now;
  return createHandler(deps);
}

// runBot(payload, log, lambdaEvent) -> {outcome, statusCode, ...} — never throws; any
// internal failure resolves to outcome 'error' and the adapter treats
// it as silence (the bot's own doctrine: failure = no reply, ever).
// `lambdaEvent` is the Lambda event of the current invocation, threaded
// through so the client's Blobs stores get their context (see
// buildHandler). A warm container reuses the cached handler, so the
// stored event is refreshed on every call that carries one.
//
// Config (Nov 27): the stored Conversation AI config is loaded fresh
// on EVERY invocation (cached per invocation, never across them) and
// applied three ways before the handler runs:
//   1. MODE GATE (text bot = ashley/Amber): Off -> silence, logged.
//      Suggest -> runBotSuggest: the reply Auto would have computed
//      is saved as a draft in cc-bot-drafts (cc-bot-drafts.js) for a
//      human to approve — NOTHING is sent. See runCaptured below for
//      why the handler runs against in-memory stores to do that.
//   2. Knowledge overrides (ensureKnowledge): FAQ / instruction text.
//   3. Booking rules (applyBookingConfig): window/slots/hours onto the
//      live handler config object, so a warm container picks them up.
//   4. Guardrails (applyGuardrailsConfig): the stored guardrail
//      toggles onto the live handler config, so each seal/silence rule
//      is gated on its toggle — explicit false skips that one rule
//      (logged + recorded as guardrailsBypassed); true/absent, or a
//      config-load failure, leaves every rule ON (fail-closed).
// A config-load ERROR fails open (bot runs as before, vendored
// knowledge + env booking rules) — a Blobs blip must never silence
// the live bot. `opts.dryRun` delegates to runBotDryRun.
async function runBot(payload, log, lambdaEvent, opts) {
  const logger = typeof log === 'function' ? log : (...a) => console.log(...a);
  const callOpts = opts || {};
  if (callOpts.dryRun) {
    return runBotDryRun(callOpts.dryRunSeed || {}, payload, logger, lambdaEvent);
  }
  if (!configured() && !testOverrides) {
    return { outcome: 'not-configured', statusCode: 503 };
  }
  try {
    const botConfig = await loadBotConfigForInvocation(lambdaEvent);
    if (botConfig) {
      const ash = botConfig.ashley || {};
      const on = ash.on !== false;
      const mode = ash.mode || 'auto';
      if (!on || mode === 'off') {
        logger('cc-bot-runner: bot off (ashley on=' + on + ' mode=' + mode + ') — silence, no reply');
        return { outcome: 'bot-off', statusCode: 200, silenced: true, reason: 'bot-off' };
      }
      if (mode === 'suggest') {
        return runBotSuggest(payload, logger, lambdaEvent, botConfig);
      }
    }
    return await invokeHandler(payload, logger, lambdaEvent, null, botConfig);
  } catch (e) {
    logger('cc-bot-runner: run failed: ' + ((e && e.message) || e));
    return { outcome: 'error', statusCode: 500, error: String((e && e.message) || e) };
  }
}

async function invokeHandler(payload, logger, lambdaEvent, callOverrides, botConfig) {
  if (!handlerInstance) handlerInstance = buildHandler(logger, lambdaEvent, callOverrides);
  else if (lambdaEvent && handlerClient) handlerClient.setEvent(lambdaEvent);
  // Per-invocation config: a warm container reuses the handler, so
  // knowledge + booking rules are re-applied on EVERY call — a screen
  // edit lands on the next inbound message, not the next cold start.
  // Guardrails apply on every call too, INCLUDING a null config (which
  // fail-closes them all to ON — see applyGuardrailsConfig).
  if (liveHandlerConfig) applyGuardrailsConfig(liveHandlerConfig, botConfig, logger);
  if (botConfig) {
    ensureKnowledge(livePersona || 'amber', logger, botConfig);
    if (liveHandlerConfig) applyBookingConfig(liveHandlerConfig, botConfig, logger);
  }
  const event = {
    httpMethod: 'POST',
    headers: { 'x-bot-secret': botSecret() || (testOverrides && testOverrides.secret) || '' },
    body: JSON.stringify(payload || {}),
  };
  const res = await handlerInstance(event);
  let body = {};
  try { body = JSON.parse(res.body || '{}'); } catch (e) { body = {}; }
  return { outcome: body.outcome || 'unknown', statusCode: res.statusCode, ...body };
}

// In-memory Blobs-shaped store (dry-run only).
function memStore() {
  const data = new Map();
  return {
    async get(key, opts) {
      const v = data.get(key);
      if (v == null) return null;
      return opts && opts.type === 'json' ? JSON.parse(v) : v;
    },
    async set(key, value) { data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    _data: data,
  };
}

// ---- Suggest capture engine ----
// The handler sends, books, tags and seals INLINE (hl.sendSms,
// hl.createAppointment, hl.addTags, hl.setDnd) — there is no
// "compute the reply, then decide" seam. So Suggest cannot run the
// handler against the live stores: a capturing send stub alone would
// still append the reply to the live thread (CcClient.sendSms writes
// the thread BEFORE calling the injected sender) and a book action
// would create a REAL appointment — in prod, cc-appointments also
// syncs it to the HighLevel calendar and pushes Troy's phone.
//
// runCaptured() runs the REAL handler against in-memory stores
// seeded from the live thread / enrollment / appointments, with:
//   * a capturing sendSms: the reply text is recorded, nothing is
//     sent (no Telnyx), and the outbound lands in the MEM thread
//     only — the live thread never sees it;
//   * a capture appointmentsApi: reads delegate to the real
//     cc-appointments module (against the mem store), but
//     createAppointment writes a Blobs-shaped record to the mem
//     store ONLY — no HighLevel event, no push. A would-be booking
//     is reported as bookedAttempted and only becomes real when a
//     human approves the draft (cc-bot-drafts approve creates it
//     through the real CcClient.createAppointment);
//   * tags / seals / opportunities land in the mem stores only and
//     are reported back (the caller diffs the mem enrollment against
//     the live one for wouldTags / wouldSeal).
// The caller decides what the capture means: the dry-run test action
// reports it as a preview; Suggest saves it as a draft. Either way
// the handler is dropped afterwards (never reused for live traffic)
// and the appointments store factory is restored — the same
// discipline the old dry-run kept. (Single-threaded caveat,
// documented: a live invocation landing mid-capture in the same warm
// container would briefly see the mem appointments factory. Captures
// are one handler run; the window is the same as the old dry-run.)

function canonicalKey(idOrPhone) {
  let d = String(idOrPhone == null ? '' : idOrPhone).replace(/\D/g, '');
  if (d.length === 10) d = '1' + d;
  return d;
}

async function readStoreJson(s, key) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

let runnerBlobs = null;
try {
  runnerBlobs = require('@netlify/blobs');
} catch (e) {
  runnerBlobs = null;
}
function blobStore(name, event) {
  if (!runnerBlobs) return null;
  try {
    if (typeof runnerBlobs.connectLambda === 'function' && event) runnerBlobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  try {
    return runnerBlobs.getStore(name);
  } catch (e) {
    return null;
  }
}

// loadSuggestSeed(payload, lambdaEvent) -> dry-run-shaped seed built
// from the LIVE thread + enrollment + appointments, or null when the
// seller has neither. Source stores are the test overrides when
// present (tests), else the real Blobs stores. Appointments come
// from the live appointments store (index + records) or, without an
// injected store, listBlobsAppointments (Blobs-only, no HL merge).
async function loadSuggestSeed(payload, lambdaEvent) {
  const key = canonicalKey((payload && (payload.contactId || payload.conversationId || payload.phone)) || '');
  if (!key || key.length < 11) return null;
  const ov = testOverrides || {};
  let conv = (ov.stores && ov.stores.conversations) || null;
  let enroll = (ov.stores && ov.stores.enrollments) || null;
  const apptStore = (ov.stores && ov.stores.appointments) || null;
  if (!conv || !enroll) {
    conv = conv || blobStore('cc-conversations', lambdaEvent);
    enroll = enroll || blobStore('cc-enrollments', lambdaEvent);
    if (!conv || !enroll) return null;
  }
  const thread = await readStoreJson(conv, key);
  const rec = await readStoreJson(enroll, key);
  if (!thread && !rec) return null;
  const now = Date.now();
  let appointments = [];
  try {
    if (apptStore) {
      const idx = await readStoreJson(apptStore, 'index');
      const ids = (idx && Array.isArray(idx.ids)) ? idx.ids : [];
      for (const id of ids) {
        const raw = String(id || '');
        const r = await readStoreJson(apptStore, raw.startsWith('appt-') ? raw : 'appt-' + raw);
        if (r) appointments.push(r);
      }
    } else {
      const apptsMod = require('./cc-appointments');
      appointments = await apptsMod.listBlobsAppointments(
        { fromMs: now - 90 * 24 * 3600 * 1000, toMs: now + 365 * 24 * 3600 * 1000 },
        lambdaEvent
      );
    }
  } catch (e) {
    appointments = [];
  }
  const contact = {
    key,
    phone: '+' + key,
    name: (rec && rec.name) || (thread && thread.name) || '',
    firstName: (rec && (rec.firstName || String(rec.name || '').split(/\s+/)[0])) || '',
    address1: (rec && (rec.address1 || rec.address)) || (thread && thread.address1) || '',
    city: (rec && rec.city) || '',
    state: (rec && rec.state) || '',
    market: (rec && rec.market) || (thread && thread.market) || '',
    tags: (rec && Array.isArray(rec.tags)) ? rec.tags.map((t) => String(t)) : [],
    stage: (rec && rec.stage) || 'sent',
  };
  const messages = ((thread && Array.isArray(thread.messages)) ? thread.messages : [])
    .filter((m) => m && m.kind !== 'note' && m.kind !== 'suggestion')
    .map((m, i) => ({
      id: String(m.id || ('live-' + i)),
      dir: m.dir === 'out' ? 'out' : 'in',
      body: String(m.body || ''),
      at: Number(m.at) || now,
      from: String(m.from || ''),
      to: String(m.to || ''),
      status: m.status || 'delivered',
    }));
  return { contact, messages, appointments, _liveEnrollment: rec || null, _threadKey: key };
}

// Capture appointments API: reads delegate to the real module
// (which, during a capture, reads the mem store via the factory
// buildHandler installs — the same reads Auto performs), but writes
// are mem-only. createAppointment mirrors the real record shape
// (id, calendarId, contactId, phone, name, title, start/end ISO+ms,
// status 'confirmed', source, createdAt) and updates the mem index,
// so the handler's getUpcomingAppointments / getFreeSlots see the
// would-be booking exactly as they would a real one — minus the
// HighLevel event and the push, which only happen on approve.
function makeCaptureAppointmentsApi(memAppointments) {
  const real = require('./cc-appointments');
  const cryptoMod = require('crypto');
  function recordKey(id) {
    const raw = String(id || '');
    return raw.startsWith('appt-') ? raw : 'appt-' + raw;
  }
  function toMs(v) {
    if (v == null) return null;
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? ms : null;
  }
  return {
    listAppointments: (range, event) => real.listAppointments(range, event),
    getAppointment: (id, event) => real.getAppointment(id, event),
    createAppointment: async (rec) => {
      const r = rec || {};
      const startMs = r.startMs != null ? Number(r.startMs) : toMs(r.startISO || r.startTime);
      const endMs = r.endMs != null ? Number(r.endMs) : toMs(r.endISO || r.endTime);
      const out = {
        id: cryptoMod.randomUUID(),
        calendarId: r.calendarId || 'seller-calls',
        contactId: r.contactId || null,
        phone: r.phone || '',
        name: r.name || '',
        email: r.email || '',
        address1: r.address1 || '',
        title: r.title || '',
        startISO: r.startISO || r.startTime || (startMs != null ? new Date(startMs).toISOString() : null),
        endISO: r.endISO || r.endTime || (endMs != null ? new Date(endMs).toISOString() : null),
        startMs,
        endMs,
        status: r.status || 'confirmed',
        source: r.source || 'bot',
        createdAt: r.createdAt != null ? r.createdAt : Date.now(),
        // Capture-only marker: this booking exists in the mem store
        // alone. It becomes a real calendar event only if a human
        // approves the draft (cc-bot-drafts approve path).
        hlSync: 'skipped-suggest-capture',
      };
      await memAppointments.set(recordKey(out.id), JSON.stringify(out));
      const idx = await readStoreJson(memAppointments, 'index');
      const ids = (idx && Array.isArray(idx.ids)) ? idx.ids.slice() : [];
      if (!ids.includes(out.id)) ids.push(out.id);
      await memAppointments.set('index', JSON.stringify({ ids }));
      return out;
    },
    cancelAppointment: async (id) => {
      const found = await readStoreJson(memAppointments, recordKey(id));
      if (!found) return null;
      found.status = 'cancelled';
      await memAppointments.set(recordKey(found.id), JSON.stringify(found));
      return found;
    },
  };
}

// runCaptured(seed, payload, logger, lambdaEvent, botConfig) — run
// the REAL handler against in-memory stores seeded from `seed`
// (dry-run shape: {contact, messages, appointments}), with a
// capturing send stub and the capture appointments API. NOTHING is
// sent (no Telnyx), NOTHING is written to the real stores, and any
// booking the model attempts lands in the mem appointments store
// (reported as bookedAttempted, never created). Returns the handler
// result plus {replyText, actions, sendsAttempted, bookedAttempted,
// stores}. The caller owns the mode decision (dry-run preview vs
// Suggest draft); this function applies NO mode gate. The capture
// handler is NEVER reused for live traffic: the cached handler is
// dropped in the finally so the next live call rebuilds fresh. The
// appointments store factory is likewise restored to null.
async function runCaptured(seed, payload, logger, lambdaEvent, botConfig) {
  const conversations = memStore();
  const enrollments = memStore();
  const opportunities = memStore();
  const appointments = memStore();
  const key = String((seed.contact && seed.contact.key) || '').replace(/\D/g, '');
  const now = Date.now();
  await enrollments.set(key, JSON.stringify({ ...seed.contact, key }));
  await conversations.set(key, JSON.stringify({
    key,
    phone: (seed.contact && seed.contact.phone) || ('+' + key),
    name: (seed.contact && seed.contact.name) || '',
    market: (seed.contact && seed.contact.market) || '',
    unread: 1,
    updatedAt: now,
    botLog: [],
    messages: Array.isArray(seed.messages) ? seed.messages : [],
  }));
  for (const a of (Array.isArray(seed.appointments) ? seed.appointments : [])) {
    if (a && a.id) {
      const raw = String(a.id);
      await appointments.set(raw.startsWith('appt-') ? raw : 'appt-' + raw, JSON.stringify(a));
    }
  }
  // The mem appointments index (loadAll reads it): without it the
  // handler's getUpcomingAppointments / getFreeSlots would see an
  // empty calendar and a booked seller would look unbooked.
  const apptIds = [...appointments._data.keys()]
    .filter((k) => k.startsWith('appt-'))
    .map((k) => k.slice('appt-'.length));
  await appointments.set('index', JSON.stringify({ ids: apptIds }));
  const apptKeysBefore = new Set([...appointments._data.keys()]);
  const sendsAttempted = [];
  // Drop any cached live handler: the capture must build its own
  // (mem-store) client, and must never leave it behind for live use.
  handlerInstance = null;
  handlerClient = null;
  try {
    handlerInstance = buildHandler(logger, lambdaEvent, {
      stores: { conversations, enrollments, opportunities, appointments },
      sendSms: async (opts) => {
        sendsAttempted.push({ to: opts.to || '', body: String(opts.message || opts.body || '') });
        return { id: 'capture-' + sendsAttempted.length, from: opts.from || '', to: opts.to || '', status: 'queued' };
      },
      appointmentsApi: makeCaptureAppointmentsApi(appointments),
    });
    // Guardrails (Nov 27, 2026): the stored toggles gate the handler's
    // seal/silence rules — same as the live path (invokeHandler). The
    // capture builds a fresh handler, so a null config is fail-closed
    // by construction; the explicit clear in applyGuardrailsConfig
    // keeps it that way if this ever runs on a reused handler.
    if (liveHandlerConfig) applyGuardrailsConfig(liveHandlerConfig, botConfig, logger);
    if (botConfig) {
      ensureKnowledge(livePersona || 'amber', logger, botConfig);
      if (liveHandlerConfig) applyBookingConfig(liveHandlerConfig, botConfig, logger);
    }
    const event = {
      httpMethod: 'POST',
      headers: { 'x-bot-secret': botSecret() || (testOverrides && testOverrides.secret) || '' },
      body: JSON.stringify(payload || {}),
    };
    const res = await handlerInstance(event);
    let body = {};
    try { body = JSON.parse(res.body || '{}'); } catch (e) { body = {}; }
    const result = { outcome: body.outcome || 'unknown', statusCode: res.statusCode, ...body };
    const actions = Array.isArray(result.actions) ? result.actions : [];
    let replyText = '';
    const replyAction = actions.find((a) => a && a.type === 'reply' && a.body);
    if (replyAction) replyText = String(replyAction.body);
    else if (typeof result.reply === 'string') replyText = result.reply;
    else if (sendsAttempted.length) replyText = sendsAttempted[0].body;
    const bookedAttempted = [...appointments._data.entries()]
      .filter(([k]) => !apptKeysBefore.has(k))
      .map(([, v]) => { try { return JSON.parse(v); } catch (e) { return { raw: String(v) }; } })
      .filter((r) => r && r.id && r.startISO);
    return {
      ...result,
      replyText,
      actions,
      sendsAttempted,
      bookedAttempted,
      stores: { conversations, enrollments, opportunities, appointments },
    };
  } finally {
    handlerInstance = null;
    handlerClient = null;
    try {
      require('./cc-appointments')._test.setStoreFactory(null);
    } catch (e) { /* already clear */ }
  }
}

// runBotSuggest(payload, logger, lambdaEvent, botConfig) — the
// Suggest-mode live path. Computes the reply exactly as Auto would
// (same handler, same knowledge, same booking rules, same guards),
// against in-memory stores seeded from the live thread, then SAVES
// it as a draft in cc-bot-drafts instead of sending it. Never
// throws: any failure resolves to a silent outcome, and a draft-save
// failure resolves to 'suggest-draft-save-failed' — the reply is
// lost (logged), the seller hears nothing, and NOTHING is ever sent
// to compensate. Only a human tapping Approve in the panel (or the
// drafts API) can send the reply, book the would-be slot, or apply
// the would-be tags/seal.
async function runBotSuggest(payload, logger, lambdaEvent, botConfig) {
  const log = typeof logger === 'function' ? logger : (...a) => console.log(...a);
  try {
    const seed = await loadSuggestSeed(payload, lambdaEvent);
    if (!seed) {
      log('cc-bot-runner: suggest seed unavailable — no live thread/enrollment for this seller; silence, no reply');
      return { outcome: 'suggest-seed-failed', statusCode: 200, silenced: true, reason: 'suggest-seed-failed' };
    }
    const captured = await runCaptured(seed, payload, log, lambdaEvent, botConfig);
    const { stores, ...capturedResult } = captured;
    const replyText = String(captured.replyText || '').trim();
    // No reply computed (guard silence / seal / model-silent /
    // booked-silent / generation failure): Suggest has nothing to
    // draft, so it stays silent exactly as Auto would — no draft,
    // no send, no side effects (the mem stores are discarded).
    if (!captured.sendsAttempted.length || !replyText) {
      log('cc-bot-runner: suggest silent (' + (captured.outcome || 'no-reply') + ') — no draft, no reply');
      return { ...capturedResult, silenced: true, reason: captured.outcome || 'suggest-silent' };
    }
    // What Auto WOULD have done besides sending: tags added / seal
    // applied to the mem enrollment, bookings in the mem store.
    const liveRec = seed._liveEnrollment || {};
    const memRec = await readStoreJson(stores.enrollments, seed._threadKey);
    const liveTags = (Array.isArray(liveRec.tags) ? liveRec.tags : []).map((t) => String(t).trim().toLowerCase());
    const memTags = (memRec && Array.isArray(memRec.tags)) ? memRec.tags.map((t) => String(t)) : [];
    const wouldTags = memTags.filter((t) => !liveTags.includes(String(t).trim().toLowerCase()));
    const wouldSeal = (memRec && memRec.dnd === true && liveRec.dnd !== true)
      || wouldTags.some((t) => String(t).trim().toLowerCase() === 'dnc');
    const wouldBook = (captured.bookedAttempted || [])
      .filter((a) => a && a.startISO)
      .map((a) => ({ startISO: a.startISO, endISO: a.endISO || '', title: a.title || '' }));
    // Save the draft — FAIL SOFT, same doctrine as the HL sync queue:
    // a store failure must never throw into the reply path, and must
    // never turn into a send.
    let draft = null;
    try {
      const draftsMod = require('./cc-bot-drafts');
      draft = await draftsMod.saveDraft(lambdaEvent, {
        threadKey: seed._threadKey,
        phone: (seed.contact && seed.contact.phone) || ('+' + seed._threadKey),
        contactName: (seed.contact && seed.contact.name) || '',
        sellerMessage: String((payload && payload.body) || ''),
        suggestedReply: replyText,
        wouldBook: wouldBook.length ? wouldBook[0] : null,
        wouldTags,
        wouldSeal,
        outcome: captured.outcome || '',
        messageId: (payload && payload.messageId) || null,
      });
    } catch (e) {
      log('cc-bot-runner: suggest draft save FAILED — nothing sent: ' + ((e && e.message) || e));
      return { outcome: 'suggest-draft-save-failed', statusCode: 200, silenced: true, reason: 'suggest-draft-save-failed', error: String((e && e.message) || e) };
    }
    log('cc-bot-runner: suggest draft saved ' + draft.id + ' for ' + seed._threadKey + ' (outcome ' + (captured.outcome || '') + ') — nothing sent');
    return {
      outcome: 'suggest-draft-saved',
      statusCode: 200,
      silenced: true,
      reason: 'suggest-draft-saved',
      draftId: draft.id,
      suggestedReply: replyText,
      wouldBook: draft.wouldBook || null,
    };
  } catch (e) {
    log('cc-bot-runner: suggest capture failed — silence, no reply: ' + ((e && e.message) || e));
    return { outcome: 'suggest-error', statusCode: 200, silenced: true, reason: 'suggest-error', error: String((e && e.message) || e) };
  }
}

// runBotDryRun(seed, payload, log, lambdaEvent) — the `test` action
// behind cc-bot-config.js. Runs the REAL handler against in-memory
// stores seeded from the supplied test thread, with a capturing send
// stub: NOTHING is sent (no Telnyx), NOTHING is written to the real
// stores, and any booking the model attempts lands in the mem
// appointments store (reported as bookedAttempted, never created).
// The live mode gate applies for Off (silence). Suggest previews
// instead of silencing: the capture computes the reply Auto would
// have sent and reports it as the draft that WOULD be saved —
// nothing is saved here, nothing is sent.
async function runBotDryRun(seed, payload, log, lambdaEvent) {
  const logger = typeof log === 'function' ? log : (...a) => console.log(...a);
  if (!configured() && !testOverrides) {
    return { outcome: 'not-configured', statusCode: 503, dryRun: true, silenced: false, replyText: '', actions: [], sendsAttempted: [], bookedAttempted: [], mode: null, note: 'Bot is not configured.' };
  }
  const contact = (seed && seed.contact) || {};
  // Canonical store key, matching cc-client.js keyOf(): 11 digits with
  // the US '1' prefix (a 10-digit key would miss on read).
  let key = String(contact.key || '').replace(/\D/g, '');
  if (key.length === 10) key = '1' + key;
  if (!key) {
    return { outcome: 'error', statusCode: 400, dryRun: true, silenced: false, replyText: '', actions: [], sendsAttempted: [], bookedAttempted: [], mode: null, note: 'dry-run needs seed.contact.key' };
  }
  try {
    const botConfig = await loadBotConfigForInvocation(lambdaEvent);
    if (botConfig) {
      const ash = botConfig.ashley || {};
      const on = ash.on !== false;
      const mode = ash.mode || 'auto';
      if (!on || mode === 'off') {
        logger('cc-bot-runner: dry-run bot off (ashley on=' + on + ' mode=' + mode + ') — silence, no reply');
        return { outcome: 'bot-off', statusCode: 200, dryRun: true, silenced: true, reason: 'bot-off', replyText: '', actions: [], sendsAttempted: [], bookedAttempted: [], mode, note: 'Bot is silent in bot-off mode.' };
      }
    }
    const captured = await runCaptured(seed, payload, logger, lambdaEvent, botConfig);
    const { stores, ...rest } = captured;
    const mode = botConfig && botConfig.ashley ? (botConfig.ashley.mode || 'auto') : null;
    const suggest = mode === 'suggest';
    return {
      ...rest,
      dryRun: true,
      mode,
      silenced: !!rest.silenced,
      note: suggest
        ? 'Suggest mode — this reply would be saved as a draft for approval, not sent.'
        : (rest.silenced ? ('Bot is silent in ' + (rest.reason || rest.outcome) + ' mode.') : ''),
    };
  } catch (e) {
    logger('cc-bot-runner: dry-run failed: ' + ((e && e.message) || e));
    return { outcome: 'error', statusCode: 500, dryRun: true, silenced: false, replyText: '', actions: [], sendsAttempted: [], bookedAttempted: [], mode: null, note: String((e && e.message) || e) };
  }
}

module.exports = { runBot, runBotDryRun, configured, botSecret, llmKeyPresent, LEAD_PIPELINE_ID, LEAD_APPOINTMENT_STAGE_ID };

// Test hook (not part of the deployed surface).
module.exports._test = {
  setOverrides(o) {
    testOverrides = o || null;
    handlerInstance = null;
    handlerClient = null;
    knowledgeReady = false;
    pristineKnowledge = null;
    liveHandlerConfig = null;
    try { loadKnowledge.cache(null); } catch (e) { /* no cache to clear */ }
  },
  reset() {
    testOverrides = null;
    handlerInstance = null;
    handlerClient = null;
    knowledgeReady = false;
    pristineKnowledge = null;
    liveHandlerConfig = null;
    botConfigOverride = undefined;
    lastBotConfig = null;
    // Clear the vendored prompt.js knowledge cache too, or the next
    // ensureKnowledge would snapshot an already-overridden kb as
    // "pristine" and the override would leak across tests.
    try { loadKnowledge.cache(null); } catch (e) { /* no cache to clear */ }
  },
  // Use this config instead of the Blobs store (null = force fail-open).
  setBotConfigOverride(cfg) {
    botConfigOverride = cfg;
  },
  getLastBotConfig() {
    return lastBotConfig;
  },
  getLiveHandlerConfig() {
    return liveHandlerConfig;
  },
};

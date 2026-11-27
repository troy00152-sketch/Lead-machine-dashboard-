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
//      Suggest -> silence + log 'suggest-mode-unavailable' — Suggest
//      has no draft-approve UI anywhere yet, so the bot must not reply
//      AND must not pretend a draft exists. Deliberate, not a half
//      backend; see the report.
//   2. Knowledge overrides (ensureKnowledge): FAQ / instruction text.
//   3. Booking rules (applyBookingConfig): window/slots/hours onto the
//      live handler config object, so a warm container picks them up.
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
        logger('cc-bot-runner: suggest-mode-unavailable — Suggest has no draft-approve UI yet; silence, no reply');
        return { outcome: 'suggest-mode-unavailable', statusCode: 200, silenced: true, reason: 'suggest-mode-unavailable' };
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

// runBotDryRun(seed, payload, log, lambdaEvent) — the `test` action
// behind cc-bot-config.js. Runs the REAL handler against in-memory
// stores seeded from the supplied test thread, with a capturing send
// stub: NOTHING is sent (no Telnyx), NOTHING is written to the real
// stores, and any booking the model attempts lands in the mem
// appointments store (reported as bookedAttempted, never created).
// The live mode gate applies (Off / Suggest -> silence, same as live).
// The dry-run handler is NEVER reused for live traffic: the cached
// handler is dropped in the finally so the next live call rebuilds
// fresh. The appointments store factory is likewise restored to null.
// (Single-threaded caveat, documented: a live invocation landing
// mid-dry-run in the same warm container would briefly see the mem
// appointments factory. Dry-runs are manual and rare; the window is
// one handler run.)
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
  const conversations = memStore();
  const enrollments = memStore();
  const opportunities = memStore();
  const appointments = memStore();
  const now = Date.now();
  await enrollments.set(key, JSON.stringify({ ...contact, key }));
  await conversations.set(key, JSON.stringify({
    key,
    phone: contact.phone || ('+' + key),
    name: contact.name || '',
    market: contact.market || '',
    unread: 1,
    updatedAt: now,
    botLog: [],
    messages: Array.isArray(seed.messages) ? seed.messages : [],
  }));
  for (const a of (Array.isArray(seed.appointments) ? seed.appointments : [])) {
    if (a && a.id) await appointments.set(String(a.id), JSON.stringify(a));
  }
  const apptKeysBefore = new Set([...appointments._data.keys()]);
  const sendsAttempted = [];
  // Drop any cached live handler: the dry-run must build its own
  // (mem-store) client, and must never leave it behind for live use.
  handlerInstance = null;
  handlerClient = null;
  try {
    const result = await invokeHandlerWithOverrides(payload, logger, lambdaEvent, {
      stores: { conversations, enrollments, opportunities, appointments },
      sendSms: async (opts) => {
        sendsAttempted.push({ to: opts.to || '', body: String(opts.message || opts.body || '') });
        return { id: 'dry-run-' + sendsAttempted.length, from: opts.from || '', to: opts.to || '', status: 'queued' };
      },
    });
    const actions = Array.isArray(result.actions) ? result.actions : [];
    let replyText = '';
    const replyAction = actions.find((a) => a && a.type === 'reply' && a.body);
    if (replyAction) replyText = String(replyAction.body);
    else if (typeof result.reply === 'string') replyText = result.reply;
    else if (sendsAttempted.length) replyText = sendsAttempted[0].body;
    const bookedAttempted = [...appointments._data.entries()]
      .filter(([k]) => !apptKeysBefore.has(k))
      .map(([, v]) => { try { return JSON.parse(v); } catch (e) { return { raw: String(v) }; } });
    const botConfig = lastBotConfig;
    return {
      ...result,
      dryRun: true,
      replyText,
      actions,
      sendsAttempted,
      bookedAttempted,
      mode: botConfig && botConfig.ashley ? (botConfig.ashley.mode || 'auto') : null,
      silenced: !!result.silenced,
      note: result.silenced ? ('Bot is silent in ' + (result.reason || result.outcome) + ' mode.') : '',
    };
  } catch (e) {
    logger('cc-bot-runner: dry-run failed: ' + ((e && e.message) || e));
    return { outcome: 'error', statusCode: 500, dryRun: true, silenced: false, replyText: '', actions: [], sendsAttempted, bookedAttempted: [], mode: null, note: String((e && e.message) || e) };
  } finally {
    handlerInstance = null;
    handlerClient = null;
    try {
      require('./cc-appointments')._test.setStoreFactory(null);
    } catch (e) { /* already clear */ }
  }
}

// invokeHandlerWithOverrides: like invokeHandler, but forces a fresh
// handler build with per-call overrides (dry-run) and applies the mode
// gate + per-invocation config first.
async function invokeHandlerWithOverrides(payload, logger, lambdaEvent, callOverrides) {
  const botConfig = await loadBotConfigForInvocation(lambdaEvent);
  if (botConfig) {
    const ash = botConfig.ashley || {};
    const on = ash.on !== false;
    const mode = ash.mode || 'auto';
    if (!on || mode === 'off') {
      logger('cc-bot-runner: dry-run bot off (ashley on=' + on + ' mode=' + mode + ') — silence, no reply');
      return { outcome: 'bot-off', statusCode: 200, silenced: true, reason: 'bot-off' };
    }
    if (mode === 'suggest') {
      logger('cc-bot-runner: dry-run suggest-mode-unavailable — Suggest has no draft-approve UI yet; silence, no reply');
      return { outcome: 'suggest-mode-unavailable', statusCode: 200, silenced: true, reason: 'suggest-mode-unavailable' };
    }
  }
  handlerInstance = buildHandler(logger, lambdaEvent, callOverrides);
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

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
function ensureKnowledge(persona, log) {
  if (knowledgeReady) return true;
  try {
    loadKnowledge(persona);
    knowledgeReady = true;
    return true;
  } catch (e) {
    log('cc-bot-runner: natural knowledge load failed (' + e.message + ') — trying cache injection');
  }
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
    return true;
  } catch (e) {
    log('cc-bot-runner: KNOWLEDGE LOAD FAILED — bot will fail closed to silence: ' + e.message);
    return false;
  }
}

let handlerInstance = null;
let testOverrides = null;

function buildHandler(log) {
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

  ensureKnowledge(config.persona, log);

  const CcClient = require('./cc-client').CcClient;
  const clientOpts = {};
  if (testOverrides && testOverrides.stores) {
    if (testOverrides.stores.conversations) clientOpts.conversations = testOverrides.stores.conversations;
    if (testOverrides.stores.enrollments) clientOpts.enrollments = testOverrides.stores.enrollments;
    if (testOverrides.stores.opportunities) clientOpts.opportunities = testOverrides.stores.opportunities;
    if (testOverrides.stores.appointments) {
      // cc-client reads appointments through the cc-appointments module;
      // point its store factory at the injected store.
      try {
        require('./cc-appointments')._test.setStoreFactory(() => testOverrides.stores.appointments);
      } catch (e) {
        log('cc-bot-runner: could not inject appointments store: ' + e.message);
      }
    }
  }
  if (testOverrides && testOverrides.sendSms) clientOpts.sendSms = testOverrides.sendSms;
  const hl = new CcClient(clientOpts);
  const llm = testOverrides && testOverrides.llm ? testOverrides.llm : createLlm(config);
  const deps = { config, hl, llm, logger: { log } };
  if (testOverrides && testOverrides.now) deps.now = testOverrides.now;
  return createHandler(deps);
}

// runBot(payload) -> {outcome, statusCode, ...} — never throws; any
// internal failure resolves to outcome 'error' and the adapter treats
// it as silence (the bot's own doctrine: failure = no reply, ever).
async function runBot(payload, log) {
  const logger = typeof log === 'function' ? log : (...a) => console.log(...a);
  if (!configured() && !testOverrides) {
    return { outcome: 'not-configured', statusCode: 503 };
  }
  try {
    if (!handlerInstance) handlerInstance = buildHandler(logger);
    const event = {
      httpMethod: 'POST',
      headers: { 'x-bot-secret': botSecret() || (testOverrides && testOverrides.secret) || '' },
      body: JSON.stringify(payload || {}),
    };
    const res = await handlerInstance(event);
    let body = {};
    try { body = JSON.parse(res.body || '{}'); } catch (e) { body = {}; }
    return { outcome: body.outcome || 'unknown', statusCode: res.statusCode, ...body };
  } catch (e) {
    logger('cc-bot-runner: run failed: ' + ((e && e.message) || e));
    return { outcome: 'error', statusCode: 500, error: String((e && e.message) || e) };
  }
}

module.exports = { runBot, configured, botSecret, llmKeyPresent, LEAD_PIPELINE_ID, LEAD_APPOINTMENT_STAGE_ID };

// Test hook (not part of the deployed surface).
module.exports._test = {
  setOverrides(o) {
    testOverrides = o || null;
    handlerInstance = null;
    knowledgeReady = false;
  },
  reset() {
    testOverrides = null;
    handlerInstance = null;
    knowledgeReady = false;
  },
};

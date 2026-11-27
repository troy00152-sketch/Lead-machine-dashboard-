// netlify/functions/cc-bot-config.js
// Server-side Conversation AI config (Nov 27, 2026) — closes the
// config-only gap: before this file, every Conversation AI screen edit
// lived in the browser's localStorage and the live bot never read it,
// so modes, KB edits, instructions, booking rules and voice picks
// changed nothing live. The screen now GETs this endpoint on open and
// POSTs edits (debounced); the live bot (cc-bot-runner) reads the same
// store on every invocation.
//
// Store: Netlify Blobs 'cc-bot-config', key 'config' (one config for
// the owner account — resale multi-tenant config is LATER; the screen
// only syncs when its tenant is 'troy', other tenants stay
// localStorage-only). Netlify Blobs on v1 functions REQUIRES
// connectLambda(event) at handler start (Nov 19 lesson) — every store
// access here goes through store(event).
//
// Auth: the same scheme as the other cc-* APIs (cc-auth.js) — the full
// dashboard lm_auth cookie only. The calling-only (Irish) login gets
// 403, no cookie gets 401.
//
// Config shape (GET returns merged defaults + stored overrides):
//   { ashley:{on,mode}, sam:{on,mode},
//     faqs:{<faqId>: <overridden answer>},
//     faqAdditions:[{id, question, answer}],   // questions the screen added
//     faqsDeleted:[<faqId>],                    // starter entries the screen removed
//     instructions:{ashley, sam},               // joined instruction text per bot
//     instructionSections:[{id, body}],         // the screen's 10 sections (round-trip)
//     booking:{calendar, windowDays, slots, minGapHours, hoursStart, hoursEnd, callMinutes},
//     guardrails:{<id>: bool},
//     voice:{sam: <voice selection>},
//     names:{ashley, sam},
//     updatedAt }
// FAQ ids are the screen's ids: 'faq-1'..'faq-31' map to the vendored
// knowledge/kb.json entries IN ORDER (kb.json carries no ids; the
// screen's starter set is kb.json's first 31 entries, verified by
// conversation-ai-regression.js). cc-bot-runner applies them by that
// mapping.
//
// Booking truth (P1-2, Nov 27): the screen used to promise 08:00-21:00
// but the live slot engine (cc-slots.js) only ever generates 08:00-
// 16:30 ET Mon-Sat. The default here is hoursEnd '16:30' and the screen
// copy says so.
//
// Routes:
//   GET  /.netlify/functions/cc-bot-config
//        -> {config} (merged defaults + stored overrides)
//   POST {config:{...}}  validate + save -> {config} (merged, saved)
//   POST {action:'test', botId?, contact?, messages?}
//        dry-run: run the bot's reply logic for a supplied test thread
//        WITHOUT sending anything. Returns {outcome, replyText,
//        actions, sendsAttempted, bookedAttempted}. The bot runs against
//        in-memory stores seeded from the supplied thread, with a
//        capturing send stub — no Telnyx send, no store writes, no HL
//        sync. The live mode gate applies: Off / Suggest returns
//        silence with a reason, exactly like the live bot.
//        A test thread is {contact:{phone,name,address1,...},
//        messages:[{body, dir:'in'|'out', at}]} — the last inbound
//        message is the triggering message.
//
// What this file does NOT do: guardrails and voice are STORED here
// (validated, round-tripped) but not yet enforced live — the vendored
// bot already encodes the guardrails in code, and Sam's voice is
// applied by the ElevenLabs agent config (cc-sam-init, another file).
// Suggest mode has no draft-approve UI anywhere yet: the live bot
// treats Suggest as Off + logs 'suggest-mode-unavailable' (see
// cc-bot-runner.js). That is deliberate, not a half backend.
'use strict';

const ccAuth = require('./cc-auth');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'cc-bot-config';
const CONFIG_KEY = 'config';

// ---- test backdoor (same pattern as cc-conversations-api.js) ----
let storeFactory = null;

function store(event) {
  if (storeFactory) return storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
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

// ---- defaults ----
// Booking default hoursEnd '16:30' is the LIVE truth (cc-slots.js:
// 08:00-16:30 ET Mon-Sat). The screen used to ship '21:00' and promise
// 9 PM offers the engine could never make.
function defaultConfig() {
  return {
    ashley: { on: true, mode: 'auto' },
    sam: { on: true, mode: 'auto' },
    faqs: {},
    faqAdditions: [],
    faqsDeleted: [],
    instructions: { ashley: '', sam: '' },
    instructionSections: null,
    booking: {
      calendar: 'Seller Calls',
      windowDays: 3,
      slots: 3,
      minGapHours: 3,
      hoursStart: '08:00',
      hoursEnd: '16:30',
      callMinutes: 30,
    },
    guardrails: {
      optout: true,
      'big-ask': true,
      'over-mao': true,
      referral: true,
      booked: true,
      listed: true,
    },
    voice: { sam: 'el:CwhRBWXzGAHq8TQ4Fs17' },
    names: { ashley: 'Amber', sam: 'Sam' },
    updatedAt: 0,
  };
}

const BOT_MODES = ['auto', 'suggest', 'off'];
const GUARDRAIL_IDS = ['optout', 'big-ask', 'over-mao', 'referral', 'booked', 'listed'];
const INSTRUCTION_IDS = ['role', 'job', 'flow', 'numbers', 'walkaway', 'booking', 'optout', 'language', 'buyers', 'hours'];
const MAX_TEXT = 20000;
const MAX_ANSWER = 4000;

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function cleanText(v, max) {
  const s = String(v == null ? '' : v);
  return s.length > max ? s.slice(0, max) : s;
}
function timeOk(t, fb) {
  return /^\d{2}:\d{2}$/.test(String(t || '')) ? String(t) : fb;
}
function sanitizeBot(b, dflt) {
  const out = { on: dflt.on, mode: dflt.mode };
  if (b && typeof b === 'object') {
    if (typeof b.on === 'boolean') out.on = b.on;
    if (BOT_MODES.indexOf(b.mode) !== -1) out.mode = b.mode;
  }
  return out;
}
function sanitizeBooking(v, dflt) {
  if (!v || typeof v !== 'object') return { ...dflt };
  return {
    calendar: String(v.calendar || '').trim() || dflt.calendar,
    windowDays: clampInt(v.windowDays, 1, 14, dflt.windowDays),
    slots: clampInt(v.slots, 1, 6, dflt.slots),
    minGapHours: clampInt(v.minGapHours, 0, 12, dflt.minGapHours),
    hoursStart: timeOk(v.hoursStart, dflt.hoursStart),
    hoursEnd: timeOk(v.hoursEnd, dflt.hoursEnd),
    callMinutes: clampInt(v.callMinutes, 5, 120, dflt.callMinutes),
  };
}
function sanitizeFaqs(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v)) {
      const key = String(k).trim();
      const ans = cleanText(v[k], MAX_ANSWER).trim();
      if (key && ans) out[key] = ans;
    }
  }
  return out;
}
function sanitizeFaqAdditions(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = {};
  for (const f of v) {
    if (!f || typeof f !== 'object') continue;
    const q = cleanText(f.question, 500).trim();
    const a = cleanText(f.answer, MAX_ANSWER).trim();
    if (!q || !a) continue;
    const id = String(f.id || '').trim() || ('faq-added-' + out.length + '-' + Date.now().toString(36));
    if (seen[id]) continue;
    seen[id] = 1;
    out.push({ id, question: q, answer: a });
  }
  return out;
}
function sanitizeFaqsDeleted(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 100);
}
function sanitizeInstructions(v, dflt) {
  const out = { ashley: dflt.ashley, sam: dflt.sam };
  if (v && typeof v === 'object') {
    if (typeof v.ashley === 'string') out.ashley = cleanText(v.ashley, MAX_TEXT);
    if (typeof v.sam === 'string') out.sam = cleanText(v.sam, MAX_TEXT);
  }
  return out;
}
function sanitizeInstructionSections(v) {
  if (!Array.isArray(v)) return null;
  const byId = {};
  for (const s of v) {
    if (s && s.id && INSTRUCTION_IDS.indexOf(String(s.id)) !== -1) {
      byId[String(s.id)] = cleanText(s.body, MAX_TEXT);
    }
  }
  if (!Object.keys(byId).length) return null;
  return INSTRUCTION_IDS.filter((id) => Object.prototype.hasOwnProperty.call(byId, id))
    .map((id) => ({ id, body: byId[id] }));
}
function sanitizeGuardrails(v, dflt) {
  const out = { ...dflt };
  if (v && typeof v === 'object') {
    for (const id of GUARDRAIL_IDS) {
      if (typeof v[id] === 'boolean') out[id] = v[id];
    }
  }
  return out;
}
function sanitizeVoice(v, dflt) {
  const out = { ...dflt };
  if (v && typeof v === 'object' && typeof v.sam === 'string') {
    const s = v.sam.trim();
    // Same shape the screen stores: 'el:<id>', a built-in style id, or 'browser:<name>'.
    if (/^el:[A-Za-z0-9]{15,30}$/.test(s) || /^[a-z][a-z0-9-]{2,30}$/.test(s) || s.indexOf('browser:') === 0) out.sam = s;
  }
  return out;
}
function sanitizeNames(v, dflt) {
  const out = { ...dflt };
  if (v && typeof v === 'object') {
    for (const k of ['ashley', 'sam']) {
      if (typeof v[k] === 'string') {
        const s = v[k].replace(/<[^>]*>/g, ' ').replace(/[<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (s) out[k] = s;
      }
    }
  }
  return out;
}

// sanitizeConfig(input) -> merged full config (defaults + input).
// Unknown keys are dropped; every field is clamped to its valid range.
function sanitizeConfig(input) {
  const d = defaultConfig();
  if (!input || typeof input !== 'object') return d;
  const out = {
    ashley: sanitizeBot(input.ashley, d.ashley),
    sam: sanitizeBot(input.sam, d.sam),
    faqs: sanitizeFaqs(input.faqs),
    faqAdditions: sanitizeFaqAdditions(input.faqAdditions),
    faqsDeleted: sanitizeFaqsDeleted(input.faqsDeleted),
    instructions: sanitizeInstructions(input.instructions, d.instructions),
    instructionSections: sanitizeInstructionSections(input.instructionSections),
    booking: sanitizeBooking(input.booking, d.booking),
    guardrails: sanitizeGuardrails(input.guardrails, d.guardrails),
    voice: sanitizeVoice(input.voice, d.voice),
    names: sanitizeNames(input.names, d.names),
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : d.updatedAt,
  };
  // Keep the joined instruction text and the sections consistent: when
  // sections are present they are the source of truth for the text.
  if (out.instructionSections) {
    const joined = out.instructionSections.map((s) => s.id.toUpperCase() + '\n' + s.body).join('\n\n');
    if (!out.instructions.ashley) out.instructions.ashley = joined;
    if (!out.instructions.sam) out.instructions.sam = joined.replace(/\bAmber\b/g, 'Sam');
  }
  return out;
}

// loadBotConfig(event) -> merged config, or null on ANY error.
// Fail-open by design: the caller (cc-bot-runner) treats null as "no
// stored config" and runs the vendored knowledge + env booking rules.
// A missing stored record is NOT an error — it yields pure defaults.
async function loadBotConfig(event) {
  try {
    const s = store(event);
    const stored = await readJson(s, CONFIG_KEY);
    if (!stored) return sanitizeConfig(null);
    const merged = sanitizeConfig(stored);
    merged.updatedAt = typeof stored.updatedAt === 'number' ? stored.updatedAt : 0;
    return merged;
  } catch (e) {
    return null;
  }
}

async function saveBotConfig(event, input) {
  const clean = sanitizeConfig(input);
  clean.updatedAt = Date.now();
  const s = store(event);
  await writeJson(s, CONFIG_KEY, clean);
  return clean;
}

// ---- slot spacing (pure) ----
// spaceSlots(isos, maxCount, minGapMs): from a sorted free-slot list,
// keep at most maxCount slots each at least minGapMs after the previous
// kept slot (greedy, chronological). The HL Sam booking rule: offer up
// to 3 slots, at least 3h apart. Shared by cc-sam-tools.js and the
// tests; the text bot's vendored booking.js has no gap knob yet (see
// cc-bot-runner.js — remaining work).
function spaceSlots(isos, maxCount, minGapMs) {
  const list = (Array.isArray(isos) ? isos : []).slice().sort();
  const max = clampInt(maxCount, 1, 12, 3);
  const gap = Math.max(0, Number(minGapMs) || 0);
  const out = [];
  let last = null;
  for (const iso of list) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    if (last !== null && t - last < gap) continue;
    out.push(iso);
    last = t;
    if (out.length >= max) break;
  }
  return out;
}

function parseHours(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]), minutes: Number(m[1]) * 60 + Number(m[2]) };
}

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

// ---- dry-run test action ----
// Runs the bot's reply logic for a supplied test thread with NO sends
// and NO store writes. The runner is required lazily (it requires this
// module lazily too — no load-time cycle).
async function runDryRun(body, event) {
  let runner = null;
  try {
    runner = require('./cc-bot-runner');
  } catch (e) {
    return respond(503, { error: 'Bot runner is not available: ' + String((e && e.message) || e) });
  }
  if (!runner.configured()) {
    return respond(503, { error: 'Bot is not configured (CC_BOT_SECRET / LLM key missing) — dry-run unavailable.' });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const inbound = messages.filter((m) => m && String(m.dir || 'in') === 'in').slice(-1)[0]
    || messages.slice(-1)[0];
  if (!inbound || !String(inbound.body || '').trim()) {
    return respond(400, { error: 'test needs messages with at least one inbound body' });
  }
  const contact = (body.contact && typeof body.contact === 'object') ? body.contact : {};
  const phone = String(contact.phone || contact.key || '').replace(/\D/g, '');
  if (phone.length < 10) {
    return respond(400, { error: 'test needs contact.phone (10+ digits)' });
  }
  // Canonical store key, matching cc-client.js keyOf(): 11 digits with
  // the US '1' prefix. A 10-digit key would miss the enrollment the
  // handler loads (keyOf normalizes 10 -> 11 on read).
  const key = phone.length === 10 ? '1' + phone : phone;
  const now = Date.now();
  const seed = {
    contact: {
      key,
      phone: '+' + key,
      name: String(contact.name || 'Test Seller'),
      firstName: String(contact.firstName || contact.name || 'Test').split(' ')[0],
      address1: String(contact.address1 || contact.address || '123 Test Street'),
      city: String(contact.city || 'Greenville'),
      state: String(contact.state || 'NC'),
      market: String(contact.market || 'carolina'),
      tags: ['dry-run-test'],
      stage: 'sent',
    },
    messages: messages.map((m, i) => ({
      id: String(m.id || ('dry-' + i)),
      dir: String(m.dir || 'in') === 'out' ? 'out' : 'in',
      body: String(m.body || ''),
      at: Number(m.at) || (now - (messages.length - i) * 60000),
      from: String(m.dir || 'in') === 'out' ? (body.toNumber || '+12525387760') : '+' + key,
      to: String(m.dir || 'in') === 'out' ? '+' + key : (body.toNumber || '+12525387760'),
      status: 'delivered',
    })),
    appointments: Array.isArray(body.appointments) ? body.appointments : [],
  };
  const payload = {
    contactId: key,
    conversationId: key,
    messageId: String(inbound.id || 'dry-trigger'),
    body: String(inbound.body),
    type: 'SMS',
    toNumber: body.toNumber || '+12525387760',
  };
  const logLines = [];
  const log = (...a) => { logLines.push(a.join(' ')); };
  try {
    const result = await runner.runBotDryRun(seed, payload, log, event);
    return respond(200, {
      action: 'test',
      outcome: result.outcome,
      replyText: result.replyText || '',
      actions: result.actions || [],
      sendsAttempted: result.sendsAttempted || [],
      bookedAttempted: result.bookedAttempted || [],
      mode: result.mode || null,
      silenced: !!result.silenced,
      note: result.note || '',
      log: logLines,
    });
  } catch (e) {
    return respond(500, { error: 'dry-run failed: ' + String((e && e.message) || e), log: logLines });
  }
}

async function handler(event) {
  const tier = ccAuth.authTier(event);
  if (!tier) return respond(401, { error: 'Not signed in — open the dashboard and sign in first.' });
  if (tier !== 'full') return respond(403, { error: 'Calling access only — bot config is not part of the calling login.' });
  try {
    if (event.httpMethod === 'GET') {
      const cfg = await loadBotConfig(event);
      if (!cfg) return respond(503, { error: 'Bot config storage is not ready yet' });
      return respond(200, { config: cfg, source: cfg.updatedAt ? 'stored' : 'defaults' });
    }
    if (event.httpMethod === 'POST') {
      let body = {};
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch (e) {
        return respond(400, { error: 'Bad JSON' });
      }
      if (body && body.action === 'test') return runDryRun(body, event);
      if (!body || typeof body.config !== 'object') {
        return respond(400, { error: 'POST needs {config:{...}} or {action:\'test\', ...}' });
      }
      const saved = await saveBotConfig(event, body.config);
      return respond(200, { config: saved, saved: true });
    }
    return respond(405, { error: 'Method not allowed' });
  } catch (e) {
    return respond(503, { error: 'Bot config storage failed: ' + String((e && e.message) || e) });
  }
}

module.exports = {
  handler,
  DEFAULT_CONFIG: defaultConfig,
  defaultConfig,
  sanitizeConfig,
  loadBotConfig,
  saveBotConfig,
  spaceSlots,
  parseHours,
  STORE_NAME,
  CONFIG_KEY,
};

// Test hook (not part of the deployed surface).
module.exports._test = {
  setStoreFactory(fn) {
    storeFactory = fn || null;
  },
  reset() {
    storeFactory = null;
  },
};

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
//     avatars:{ashley, sam},            // photo pick per original bot ('ph-*' or 'initials')
//     voiceDepth:{<ownerId>: {<voiceSel>: 'light'|'medium'|'deep'}},
//                                       // per-voice depth, Nov 19 design: {ownerId:{selId:depth}}
//     profiles:[{id, name, channel, mode, on, voice, avatar}],
//                                       // bots added on the screen (picker-only: the live
//                                       // runner only ever runs ashley/sam — persisting a
//                                       // profile syncs the picker across devices, it does
//                                       // NOT give the added bot a live number or runner)
//     selected:<bot id>,               // picker selection ('ashley' | 'sam' | added-bot id)
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
// Booking hours are the CALL window only — they are NOT the bot's reply
// hours. The reply gate is the vendored 8-21 in bot/src/config.js
// (Troy's rule: the bot answers 8 AM-9 PM ET), and cc-bot-runner.js
// must never copy booking hours onto it: the Nov 27 9:15 AM deploy did
// exactly that (16:30 + 30-min skew -> gate 17) and silenced Paula's
// 5:12 PM retest with 'after-hours'. The slot engine caps offers at
// 16:30 by itself (inBookingWindow + cc-slots.js), so the two windows
// stay decoupled. Do NOT "restore" this default to '21:00' to fix reply
// hours — replies are gated by the vendored 8-21, not by this field;
// 21:00 here would only make the screen preview offer evening call
// times the live engine can never make.
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
//        sync. The live mode gate applies for Off (silence with a
//        reason, exactly like the live bot). Suggest previews: the
//        reply Auto would have sent is returned as the draft that
//        WOULD be saved — nothing is saved here, nothing is sent.
//        A test thread is {contact:{phone,name,address1,...},
//        messages:[{body, dir:'in'|'out', at}]} — the last inbound
//        message is the triggering message.
//
// Enforcement notes:
// Guardrails ARE enforced live (Nov 27): cc-bot-runner copies
// botConfig.guardrails onto the handler config on every invocation,
// and bot/src/handler.js gates each seal/silence rule on its toggle —
// explicit false skips that one rule (logged + recorded as
// guardrailsBypassed on the thread botLog); true, absent, or an
// unreadable config leaves every rule ON (fail-closed). The vendored
// bot still encodes the guardrails in code; the toggles gate them,
// they do not rewrite them.
// Sam's voice IS applied live (Nov 27, 2026, cc-sam-voice.js): saving
// a changed voice.sam PATCHes the ElevenLabs agent's
// conversation_config.tts.voice_id and GET-verifies it stuck; a
// failure never breaks the config save — the save succeeds and the
// voice-apply status rides in the response (and in GET, as voiceApply)
// so the page can show it honestly.
// avatars / voiceDepth / profiles / selected are presentation state
// stored here so the screen syncs across devices; the live runner
// only ever runs ashley/sam — an added profile gets NO live number,
// no runner and no inbound route from being stored. Voice depth is
// applied in the browser preview path only (playback-rate shift);
// the live Sam voice pitch comes from the ElevenLabs agent config.
// Suggest mode HAS a draft-approve flow (Nov 27, 2026): the live
// runner (cc-bot-runner.js runBotSuggest) computes the reply Auto
// would have sent and saves it as a draft in cc-bot-drafts.js; the
// conversation-ai "Suggested replies" panel lists pending drafts for
// Approve / Dismiss. Sam is voice-only and has no draft UI — this
// covers the text bot (Ashley/Amber) only.
'use strict';

const ccAuth = require('./cc-auth');
const samVoice = require('./cc-sam-voice');

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
// Booking default hoursEnd '16:30' is the LIVE truth for CALLS
// (cc-slots.js: 08:00-16:30 ET Mon-Sat). The screen used to ship '21:00'
// and promise 9 PM offers the engine could never make. This is the call
// window only — the bot's REPLY window is the vendored 8-21 and lives
// nowhere in this config; see the Booking-truth note above.
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
    // Nov 27 audit batch B: avatar picks, per-voice depth, added-bot
    // profiles and the picker selection used to be localStorage-only
    // (conversation-ai.html said so in a comment) — they are server
    // fields now, so they survive across devices. Sam wears Roger's
    // photo, Amber wears Amber's, matching the Nov 19 shipped faces.
    avatars: { ashley: 'ph-ashley', sam: 'ph-roger' },
    voiceDepth: {},
    profiles: [],
    selected: 'ashley',
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
// ---- avatar / voice-depth / added-bot presentation state ----
// Photo faces shipped Nov 19 (one per real voice + Amber's), in
// /avatars/<name>.webp. 'initials' renders the bot's initial in the
// account accent color. The old illustrated 'ava-*' ids no longer
// validate on the screen either (photos only since Nov 19), so they
// fall back to the per-bot default here too.
const PHOTO_AVATAR_IDS = [
  'ph-ashley', 'ph-sarah', 'ph-bella', 'ph-jessica', 'ph-matilda', 'ph-laura',
  'ph-alice', 'ph-lily', 'ph-roger', 'ph-eric', 'ph-brian', 'ph-chris',
  'ph-will', 'ph-liam', 'ph-adam', 'ph-bill', 'ph-callum', 'ph-harry',
  'ph-charlie', 'ph-george', 'ph-daniel', 'ph-river',
];
function sanitizeAvatarSel(v, dflt) {
  const s = String(v == null ? '' : v).trim();
  if (s === 'initials' || PHOTO_AVATAR_IDS.indexOf(s) !== -1) return s;
  return dflt;
}
function sanitizeAvatars(v, dflt) {
  const out = { ...dflt };
  if (v && typeof v === 'object') {
    out.ashley = sanitizeAvatarSel(v.ashley, dflt.ashley);
    out.sam = sanitizeAvatarSel(v.sam, dflt.sam);
  }
  return out;
}
// One voice-selection shape, shared by Sam's voice, added-bot voices
// and voice-depth keys: 'el:<id>', a built-in style id, or 'browser:<name>'.
function voiceSelOk(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (/^el:[A-Za-z0-9]{15,30}$/.test(t)) return true;
  if (/^[a-z][a-z0-9-]{2,30}$/.test(t)) return true;
  if (t.indexOf('browser:') === 0 && t.length <= 130) return true;
  return false;
}
const VOICE_DEPTHS = ['light', 'medium', 'deep'];
// Voice depth, Nov 19 design: { ownerId: { voiceSel: depth } } —
// Light / Medium / Deep per voice, so a voice keeps its depth when
// it gets Selected. A legacy per-bot STRING value (the pre-Nov-27
// local shape) has no voice key, so it is dropped here; the screen
// converts it to the keyed shape before saving.
function sanitizeVoiceDepth(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const owner of Object.keys(v).slice(0, 20)) {
    if (owner !== 'ashley' && owner !== 'sam' && !/^bot_[A-Za-z0-9_]{1,64}$/.test(owner)) continue;
    const entry = v[owner];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const inner = {};
    for (const selId of Object.keys(entry).slice(0, 30)) {
      if (!voiceSelOk(selId)) continue;
      const d = String(entry[selId] || '').trim();
      if (VOICE_DEPTHS.indexOf(d) !== -1) inner[selId] = d;
    }
    if (Object.keys(inner).length) out[owner] = inner;
  }
  return out;
}
const MAX_PROFILES = 20;
function sanitizeProfileName(v, dflt) {
  const s = String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || dflt;
}
// Added-bot profiles: the screen's small list (same shape it already
// sanitizes client-side). Ids are 'bot_<...>' from the screen's
// caiNewId('bot'); the reserved originals can never be shadowed, and
// a junk id is dropped, never stored.
function sanitizeProfiles(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = {};
  for (const p of v.slice(0, MAX_PROFILES)) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '').trim();
    if (!id || id === 'ashley' || id === 'sam' || seen[id]) continue;
    if (!/^bot_[A-Za-z0-9_]{1,64}$/.test(id)) continue;
    seen[id] = 1;
    const channel = p.channel === 'voice' ? 'voice' : 'text';
    out.push({
      id,
      name: sanitizeProfileName(p.name, 'New bot'),
      channel,
      mode: BOT_MODES.indexOf(p.mode) !== -1 ? p.mode : 'auto',
      on: typeof p.on === 'boolean' ? p.on : true,
      voice: voiceSelOk(p.voice) ? String(p.voice).trim() : 'natural',
      avatar: sanitizeAvatarSel(p.avatar, channel === 'voice' ? 'ph-roger' : 'ph-ashley'),
    });
  }
  return out;
}
function sanitizeSelected(v, profiles) {
  const s = String(v == null ? '' : v).trim();
  if (s === 'ashley' || s === 'sam') return s;
  if (Array.isArray(profiles) && profiles.some((p) => p && p.id === s)) return s;
  return 'ashley';
}

// sanitizeConfig(input) -> merged full config (defaults + input).
// Unknown keys are dropped; every field is clamped to its valid range.
function sanitizeConfig(input) {
  const d = defaultConfig();
  if (!input || typeof input !== 'object') return d;
  const profiles = sanitizeProfiles(input.profiles);
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
    avatars: sanitizeAvatars(input.avatars, d.avatars),
    voiceDepth: sanitizeVoiceDepth(input.voiceDepth),
    profiles,
    selected: sanitizeSelected(input.selected, profiles),
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

// ---- Sam live-voice apply (Nov 27, 2026) ----
// applySamVoiceIfChanged(prev, saved, event) -> voiceApply status.
// Runs AFTER the config save, so an ElevenLabs failure can never
// break the save itself: the save succeeds and this reports its own
// status separately (the page shows it and keeps the old voice as
// current). Only a CHANGED voice.sam triggers an ElevenLabs call —
// every debounced save re-posting the same voice must not PATCH the
// agent again. The last outcome is persisted under the 'voice-apply'
// key so GET can report the live-voice state without calling
// ElevenLabs on every page load.
const VOICE_APPLY_KEY = 'voice-apply';

async function readVoiceApply(event) {
  try {
    const s = store(event);
    const v = await readJson(s, VOICE_APPLY_KEY);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

async function applySamVoiceIfChanged(prev, saved, event, force) {
  const prevVoice = prev && prev.voice && typeof prev.voice.sam === 'string' ? prev.voice.sam : null;
  const nextVoice = saved && saved.voice && typeof saved.voice.sam === 'string' ? saved.voice.sam : null;
  if (!force && prevVoice === nextVoice) {
    return { ok: true, applied: false, unchanged: true, verified: false, voiceId: nextVoice, currentVoiceId: nextVoice };
  }
  let result = null;
  try {
    result = await samVoice.applySamVoice(nextVoice);
  } catch (e) {
    result = { ok: false, applied: false, verified: false, error: 'Sam voice apply failed: ' + String((e && e.message) || e), voiceId: nextVoice, currentVoiceId: prevVoice };
  }
  if (!result || typeof result !== 'object') {
    result = { ok: false, applied: false, verified: false, error: 'Sam voice apply returned no result', voiceId: nextVoice, currentVoiceId: prevVoice };
  }
  // Fill the "current" voice the page should keep showing on failure:
  // the voice Sam was on before this save (the live one), not the
  // newly picked one that never landed.
  if (!result.ok && (result.currentVoiceId == null || result.currentVoiceId === undefined)) {
    result.currentVoiceId = prevVoice;
  }
  // Normalize: the page reads voiceId/currentVoiceId as BARE
  // ElevenLabs ids ('el:' + id = the stored selection). The unchanged
  // shortcut above hands back the full 'el:...' selection, and the
  // failure fill hands back the previous full selection — strip the
  // prefix here so every shape the server emits is the same.
  var bare = function (v) {
    return typeof v === 'string' && v.indexOf('el:') === 0 ? v.slice(3) : v;
  };
  result.voiceId = bare(result.voiceId);
  result.currentVoiceId = bare(result.currentVoiceId);
  result.requestedVoiceId = nextVoice;
  result.at = Date.now();
  try {
    const s = store(event);
    await writeJson(s, VOICE_APPLY_KEY, result);
  } catch (e) { /* status persistence never fails the save */ }
  return result;
}

async function handler(event) {
  const tier = ccAuth.authTier(event);
  if (!tier) return respond(401, { error: 'Not signed in — open the dashboard and sign in first.' });
  if (tier !== 'full') return respond(403, { error: 'Calling access only — bot config is not part of the calling login.' });
  try {
    if (event.httpMethod === 'GET') {
      const cfg = await loadBotConfig(event);
      if (!cfg) return respond(503, { error: 'Bot config storage is not ready yet' });
      const voiceApply = await readVoiceApply(event);
      return respond(200, { config: cfg, source: cfg.updatedAt ? 'stored' : 'defaults', voiceApply: voiceApply || null });
    }
    if (event.httpMethod === 'POST') {
      let body = {};
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch (e) {
        return respond(400, { error: 'Bad JSON' });
      }
      if (body && body.action === 'test') return runDryRun(body, event);
      if (body && body.action === 'apply-sam-voice') {
        // Explicit Apply step: re-apply the STORED voice.sam to the
        // live agent even when it did not change (retry after a
        // failed save-time apply, or a first apply of a voice that
        // was saved before this wiring existed).
        const cfg = await loadBotConfig(event);
        if (!cfg) return respond(503, { error: 'Bot config storage is not ready yet' });
        const voiceApply = await applySamVoiceIfChanged(null, cfg, event, true);
        return respond(200, { action: 'apply-sam-voice', voice: cfg.voice.sam, voiceApply });
      }
      if (!body || typeof body.config !== 'object') {
        return respond(400, { error: 'POST needs {config:{...}} or {action:\'test\' | \'apply-sam-voice\', ...}' });
      }
      const prev = await loadBotConfig(event);
      const saved = await saveBotConfig(event, body.config);
      const voiceApply = await applySamVoiceIfChanged(prev, saved, event, false);
      return respond(200, { config: saved, saved: true, voiceApply });
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
  VOICE_APPLY_KEY,
};

// Test hook (not part of the deployed surface).
module.exports._test = {
  setStoreFactory(fn) {
    storeFactory = fn || null;
  },
  // Stub the ElevenLabs fetch used by the Sam voice apply (cc-sam-voice.js).
  setSamVoiceFetch(fn) {
    samVoice._test.setFetch(fn);
  },
  reset() {
    storeFactory = null;
    samVoice._test.reset();
  },
};

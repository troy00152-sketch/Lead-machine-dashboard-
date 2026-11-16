// netlify/functions/cc-workflow-engine.js
// Phase 3 of the standalone Command Center build: the workflow engine
// that mirrors the five HighLevel market SMS workflows exactly (see
// cc-workflows-config.js + ~/workspace/standalone-build/
// hl-workflow-steps.md).
//
// What HL does per enrollment (and what this engine mirrors):
//   market tag added -> opportunity (Phase 5/bot territory, not here)
//   -> drip 300/day -> Wait window Mon–Sat 11:00–17:00 America/New_York
//   -> drip 1 send/minute -> "Is Active lead?" gate -> round-robin
//   assign (n/a standalone) -> Random Split A–E (20% each)
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
const cfg = require('./cc-workflows-config');

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
async function loadEnrollIndex(s) {
  return (await readJson(s, ENROLL_INDEX_KEY)) || { updatedAt: 0, enrollments: {} };
}
async function saveEnrollment(s, rec) {
  await writeJson(s, rec.key, rec);
  const idx = await loadEnrollIndex(s);
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
  let workflow = null;
  if (c.market) workflow = cfg.getWorkflow(String(c.market).toLowerCase());
  if (!workflow) {
    for (const t of tags) {
      workflow = cfg.workflowByTag(t);
      if (workflow) break;
    }
  }
  if (!workflow) return { ok: false, reason: 'no market workflow matched (no market, no trigger tag)' };

  // Trigger: the contact must carry the market's trigger tag (HL fires
  // on "Contact Tag Added" for exactly this tag).
  if (!lt.includes(workflow.tag.toLowerCase())) {
    return { ok: false, reason: 'missing trigger tag "' + workflow.tag + '"' };
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
  const s = enrollStore(event);
  await saveEnrollment(s, rec);
  return { ok: true, enrollment: rec };
}

// ---- conversation store append (mirrors cc-conversations-api send) ----
async function appendOutbound(cs, key, phoneE164, market, msg) {
  const thread = (await readJson(cs, key)) || {
    phone: phoneE164, key, name: '', market: '', unread: 0, updatedAt: 0, messages: [],
  };
  if (!Array.isArray(thread.messages)) thread.messages = [];
  thread.phone = phoneE164;
  if (market && !thread.market) thread.market = market;
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

  for (const workflow of Object.values(cfg.WORKFLOWS)) {
    const market = workflow.id;
    const res = { market, action: 'idle' };

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
    const queuedKeys = Object.keys(idx.enrollments).filter(
      (k) => idx.enrollments[k].market === market && idx.enrollments[k].stage === 'queued'
    );
    if (!queuedKeys.length) {
      results.push(res);
      continue;
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
      await saveEnrollment(es, rec);
      res.action = 'ended-dnc';
      results.push(res);
      continue;
    }
    // "Is Active lead?" gate — none of the gate tags -> END.
    if (!workflow.activeLeadTags.some((t) => lt.includes(t.toLowerCase()))) {
      rec.stage = 'ended-inactive';
      await saveEnrollment(es, rec);
      res.action = 'ended-inactive';
      results.push(res);
      continue;
    }
    // Per-path bad-number guard — before EVERY path's send.
    if (lt.includes(workflow.badNumberGuard.tag.toLowerCase())) {
      rec.stage = 'ended-bad-number';
      await saveEnrollment(es, rec);
      res.action = 'ended-bad-number';
      results.push(res);
      continue;
    }

    const body = cfg.renderFirstText(market, rec.path, {
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
      await saveEnrollment(es, rec);
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
    await saveEnrollment(es, rec);
    res.sentToday = await bumpCounter(es, ts, market);
    res.action = 'sent';
    res.messageId = msg.id;
    results.push(res);
  }

  return { at: ts, dateET: etDateString(ts), results };
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

module.exports = { enroll, tick, counts };

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
  reset() {
    deps.enrollStoreFactory = null;
    deps.convStoreFactory = null;
    deps.sendSms = null;
    deps.random = null;
  },
};

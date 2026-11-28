// netlify/functions/cc-dialer-api.js
// lm_auth-gated API behind the standalone Command Center's triple-line
// dialer (dialer.html) — see the Dialer section of
// ~/workspace/standalone-build/BUILD-PLAN.md.
//
// The dialer is a Command Center section (Troy's final placement call,
// Nov 16, 2026). Primary caller: Irish (mirroring her HighLevel setup —
// her own calling screen, coach on screen, ~1 hr/day); Troy can use it
// too. Recordings live ONLY in this dialer's store/panel.
//
// Flow: create a session from a call list (cc-enrollments for a market,
// or a pasted list) -> Start -> the engine dials up to 3 seller legs at
// once via Telnyx Call Control with answering-machine detection -> the
// telnyx-voice-webhook applies events (first human answer wins, losers
// are hung up, machines/no-answers auto-disposition and the queue
// advances) -> the winner bridges to the agent's browser (WebRTC) ->
// the agent files a disposition on the connected-call card.
//
// Routing (same action pattern as the other dashboard functions):
//   GET  ?action=config       {configured, missing, markets} — the page
//                             shows its "voice not configured" state
//                             from this; never leaks env values
//   GET  ?action=state        current session (leads, legs, stats) +
//                             latest recordings
//   GET  ?action=recordings   recordings list (dialer area only)
//   POST {action:'create-session', source:'enrollments'|'paste',
//         market?, leads?}    build the queue (refused while a session
//                             is running)
//   POST {action:'start', agentSipUri}   begin dialing (fail closed
//                             when voice is not configured)
//   POST {action:'pause'} / {action:'stop'}
//   POST {action:'disposition', leadKey, disposition, notes?}
//   GET  ?action=rotation-state   number-rotation view (per-number
//                             calls today, capped/resting, excluded,
//                             sticky count) — feeds the dialer page's
//                             rotation panel
//   POST {action:'rotation-config', dailyCap?, excluded?}
//                             daily cap (1..500) + excluded numbers
//
// Number rotation (Nov 28, 2026 — XLeads 3X Dialer parity, see
// dialer-rotation.js): dialNextBatch picks an explicit `from` per leg
// — persisted cursor (no cold-start restart at pool[0]), Best Choice
// area-code match, per-number daily cap ~80 with rest, sticky number
// per contact (recorded by telnyx-voice-webhook on first human
// answer). SMS keeps its own pickSender round-robin — untouched.
//
// Stores (Netlify Blobs):
//   'cc-dialer'      'session'    -> the current session record
//                    'recordings' -> {recordings: [...]}
//                    'hot-leads'  -> {leads: [...]} — the crossover to
//                                    Troy's pipeline (mirrors HL's
//                                    `hot lead` tag -> Acquisitions
//                                    deal); the ONLY thing that leaves
//                                    the dialer area
//                    'voice-credential' -> WebRTC credential cache
//                                    (cc-voice-token.js)
//                    'rotation'     -> number-rotation state (cursor,
//                                    per-number daily counts, sticky
//                                    contact->number, excluded list,
//                                    daily cap) — dialer-rotation.js
//   'cc-enrollments' — read for list building; written ONLY by the DNC
//                      seal and the `hot lead` tag, mirroring
//                      cc-bot-hook's seal semantics exactly.
//   'cc-conversations' — never touched by the dialer.
//
// ALL actions require the dashboard lm_auth cookie (same HMAC as
// gate.ts / cc-conversations-api.js).
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');
const voice = require('./telnyx-voice-lib');
const rotation = require('./dialer-rotation');
const ccAuth = require('./cc-auth');

const DIALER_STORE = 'cc-dialer';
const ENROLL_STORE = 'cc-enrollments';
const SESSION_KEY = 'session';
const RECORDINGS_KEY = 'recordings';
const HOT_LEADS_KEY = 'hot-leads';
const MAX_CONCURRENT_LEGS = 3; // hard cap — triple-line means three
const MAX_RECORDINGS = 500;
const MAX_HOT_LEADS = 1000;

const DISPOSITIONS = [
  'Hot Lead',
  'Appointment Set',
  'Not Interested',
  'Wrong Number',
  'DNC',
  'Callback Later',
  'No Answer',
  'Voicemail',
  'Machine',
];

// ---- injectable dependencies (tests) ----
const deps = {
  dialerStoreFactory: null,
  enrollStoreFactory: null,
  voiceLib: null,
};
function voiceLib() {
  return deps.voiceLib || voice;
}

function makeStore(name, factory, event) {
  if (factory) return factory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(name);
}
function dialerStore(event) {
  return makeStore(DIALER_STORE, deps.dialerStoreFactory, event);
}
function enrollStore(event) {
  return makeStore(ENROLL_STORE, deps.enrollStoreFactory, event);
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

// ---- auth (same lm_auth HMAC as gate.ts / cc-enroll-api.js) ----
const COOKIE_NAME = 'lm_auth';
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
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
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
  const headers = event.headers || {};
  const cookieHeader = headers.cookie || headers.Cookie || '';
  const cookie = getCookie(cookieHeader, COOKIE_NAME);
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

// ---- session model ----
function emptyStats() {
  return { dials: 0, connects: 0, machines: 0, noAnswers: 0, hotLeads: 0, appointments: 0, callbacks: 0 };
}
function newSession(fields) {
  return Object.assign(
    {
      id: 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      status: 'idle', // idle | running | paused | connected | stopped | complete
      source: '',
      market: '',
      agentSipUri: '',
      leads: [],
      legs: {}, // callControlId -> leg record
      winnerCallControlId: null,
      agentCallControlId: null,
      connectedLeadKey: null,
      stats: emptyStats(),
      lastError: null,
      createdAt: Date.now(),
      startedAt: null,
      updatedAt: Date.now(),
      endedAt: null,
    },
    fields || {}
  );
}
async function loadSession(event) {
  const s = dialerStore(event);
  return readJson(s, SESSION_KEY);
}
async function saveSession(session, event) {
  session.updatedAt = Date.now();
  const s = dialerStore(event);
  await writeJson(s, SESSION_KEY, session);
  return session;
}
function findLead(session, leadKey) {
  return session.leads.find((l) => l.key === leadKey) || null;
}
// Seller legs still in flight (not ended). The agent leg never counts
// against the 3-line cap.
function activeSellerLegs(session) {
  return Object.values(session.legs).filter((l) => l.kind === 'seller' && l.state !== 'ended');
}
function sessionComplete(session) {
  return (
    !session.leads.some((l) => l.status === 'pending' || l.status === 'dialing') &&
    activeSellerLegs(session).length === 0 &&
    !session.winnerCallControlId
  );
}

// ---- list building ----
function leadFromEnrollment(rec) {
  return {
    key: rec.key,
    phone: rec.phone,
    name: rec.name || '',
    address1: rec.address1 || '',
    city: rec.city || '',
    market: rec.market || '',
    status: 'pending',
    disposition: null,
    autoDisposition: false,
    notes: '',
    attempts: 0,
    callControlId: null,
    lastCallAt: null,
    durationSecs: null,
  };
}
function lowerTags(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());
}
// Callable = has a phone, is not sealed (dnc tag / dnd), not bad-number.
// Mirrors the messaging side's guards — a sealed seller is never dialed.
// A manual call-channel DND (cc-dnd dndChannels.call) also blocks
// dialing even when the texting seal is off — HL parity: the Calls
// DND box stops calls, not texts.
function enrollmentCallable(rec) {
  if (!rec || !rec.phone) return false;
  if (rec.dnd === true) return false;
  if (rec.dndChannels && rec.dndChannels.call === true) return false;
  const lt = lowerTags(rec.tags);
  if (lt.includes('dnc') || lt.includes('bad-number')) return false;
  return true;
}
async function leadsFromEnrollments(market, event) {
  const es = enrollStore(event);
  const idx = (await readJson(es, 'index')) || { enrollments: {} };
  const leads = [];
  for (const [key, entry] of Object.entries(idx.enrollments || {})) {
    if (market && entry.market !== market) continue;
    const rec = await readJson(es, key);
    if (!enrollmentCallable(rec)) continue;
    leads.push(leadFromEnrollment(rec));
  }
  leads.sort((a, b) => (a.key < b.key ? -1 : 1));
  return leads;
}
function leadsFromPaste(list, defaultMarket) {
  const leads = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.phone) continue;
    let key;
    let phone;
    try {
      key = lib.phoneKey(item.phone);
      phone = lib.toE164(item.phone);
    } catch (e) {
      continue; // junk row — skipped, never dialed
    }
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push({
      key,
      phone,
      name: String(item.name || ''),
      address1: String(item.address1 || item.address || ''),
      city: String(item.city || ''),
      market: String(item.market || defaultMarket || ''),
      status: 'pending',
      disposition: null,
      autoDisposition: false,
      notes: '',
      attempts: 0,
      callControlId: null,
      lastCallAt: null,
      durationSecs: null,
    });
  }
  return leads;
}

// ---- the dial engine ----
// Dials pending leads until the 3-leg cap is reached. Only runs while
// the session is 'running' (never while paused/stopped, and never while
// a winner is connected — the agent is talking). FAIL CLOSED: if the
// voice lib throws (not configured, empty caller-ID pool, Telnyx
// rejection), the error lands on the session and dialing stops — no
// lead is ever marked dialed without a real call_control_id.
async function dialNextBatch(session, event) {
  const dialed = [];
  if (session.status !== 'running') return { dialed, reason: 'not-running' };
  if (session.winnerCallControlId) return { dialed, reason: 'winner-active' };
  const v = voiceLib();
  // Number rotation (Nov 28, 2026 — XLeads 3X Dialer parity): one
  // persisted rotation state per batch; each leg gets an explicit
  // `from` — persisted cursor, Best Choice area-code match, daily cap
  // with rest, sticky number per contact. A pick that never dials
  // (createCall throws) is not counted — recordDial runs only after
  // Telnyx returns a call_control_id.
  let rState = null;
  try {
    rState = await rotation.loadState(dialerStore(event));
  } catch (e) {
    rState = rotation.emptyState();
  }
  while (activeSellerLegs(session).length < MAX_CONCURRENT_LEGS) {
    const lead = session.leads.find((l) => l.status === 'pending');
    if (!lead) break;
    // Rotation pick — only when the market actually has numbers. A
    // market with no pool keeps the legacy path (no `from`): the voice
    // lib itself fails closed there, exactly as before rotation
    // existed, so an empty pool never changes behaviour.
    let pick = null;
    const pool = lib.SENDER_POOLS[lead.market || session.market];
    if (pool && pool.length) {
      try {
        pick = rotation.pickFrom(rState, {
          market: lead.market || session.market,
          to: lead.phone,
          pool,
        });
      } catch (e) {
        session.lastError = String((e && e.message) || e);
        await saveSession(session, event);
        return { dialed, error: session.lastError };
      }
    }
    const callOpts = {
      to: lead.phone,
      market: lead.market || session.market || undefined,
      clientState: { sessionId: session.id, leadKey: lead.key, leg: 'seller' },
    };
    if (pick) callOpts.from = pick.from;
    let created;
    try {
      created = await v.createCall(callOpts);
    } catch (e) {
      session.lastError = String((e && e.message) || e);
      await saveSession(session, event);
      return { dialed, error: session.lastError };
    }
    if (!created || !created.callControlId) {
      session.lastError = 'Telnyx did not return a call_control_id — dialing stopped.';
      await saveSession(session, event);
      return { dialed, error: session.lastError };
    }
    if (pick) {
      rotation.recordDial(rState, pick.from);
      try {
        await rotation.saveState(dialerStore(event), rState);
      } catch (e) { /* rotation state is a guardrail, not the session — a lost count never blocks dialing */ }
    }
    lead.status = 'dialing';
    lead.attempts += 1;
    lead.callControlId = created.callControlId;
    lead.lastCallAt = Date.now();
    session.legs[created.callControlId] = {
      callControlId: created.callControlId,
      kind: 'seller',
      leadKey: lead.key,
      phone: lead.phone,
      from: created.from || '',
      state: 'initiated',
      amdResult: null,
      startedAt: Date.now(),
      answeredAt: null,
      endedAt: null,
    };
    session.stats.dials += 1;
    dialed.push(lead.key);
  }
  await saveSession(session, event);
  return { dialed };
}

// ---- enrollment side effects (DNC seal / hot-lead crossover) ----
// Mirrors cc-bot-hook.sealEnrollment exactly: `dnc` tag + dnd=true on
// the enrollment record; a stub record is written when the phone was
// never enrolled, so the seal survives.
async function sealEnrollmentForDnc(lead, event) {
  const es = enrollStore(event);
  let rec = await readJson(es, lead.key);
  if (!rec) {
    rec = {
      key: lead.key,
      phone: lead.phone,
      name: lead.name || '',
      market: lead.market || '',
      tags: [],
      stage: 'sealed',
      enrolledAt: null,
    };
  }
  const tags = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
  if (!lowerTags(tags).includes('dnc')) tags.push('dnc');
  rec.tags = tags;
  rec.dnd = true;
  rec.sealedAt = Date.now();
  rec.sealReason = 'dialer-dnc';
  await writeJson(es, lead.key, rec);
  return rec;
}
async function tagEnrollmentHotLead(lead, event) {
  const es = enrollStore(event);
  const rec = await readJson(es, lead.key);
  if (!rec) return null;
  const tags = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
  if (!lowerTags(tags).includes('hot lead')) tags.push('hot lead');
  rec.tags = tags;
  await writeJson(es, lead.key, rec);
  return rec;
}
// The crossover record — mirrors HL's `hot lead` tag creating an
// Acquisitions "New" deal. Lives in the cc-dialer store; a future
// pipeline writer consumes this key.
async function writeHotLeadRecord(session, lead, notes, event) {
  const s = dialerStore(event);
  const box = (await readJson(s, HOT_LEADS_KEY)) || { leads: [] };
  const record = {
    id: 'hot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    phone: lead.phone,
    key: lead.key,
    name: lead.name || '',
    address1: lead.address1 || '',
    city: lead.city || '',
    market: lead.market || session.market || '',
    notes: notes || lead.notes || '',
    source: 'dialer',
    sessionId: session.id,
    at: Date.now(),
  };
  box.leads.unshift(record);
  if (box.leads.length > MAX_HOT_LEADS) box.leads = box.leads.slice(0, MAX_HOT_LEADS);
  await writeJson(s, HOT_LEADS_KEY, box);
  return record;
}

// applyDisposition(session, leadKey, disposition, notes, event)
// Shared by the API action (manual, agent-filed) — the webhook files
// its own auto-dispositions directly on the session. Handles the
// enrollment side effects for DNC + Hot Lead.
async function applyDisposition(session, leadKey, disposition, notes, event) {
  if (!DISPOSITIONS.includes(disposition)) {
    return { ok: false, reason: 'unknown disposition: ' + disposition };
  }
  const lead = findLead(session, leadKey);
  if (!lead) return { ok: false, reason: 'lead not in session: ' + leadKey };
  lead.disposition = disposition;
  lead.autoDisposition = false;
  if (notes != null) lead.notes = String(notes);
  lead.status = 'done';
  if (session.connectedLeadKey === leadKey) session.connectedLeadKey = null;
  if (disposition === 'DNC') await sealEnrollmentForDnc(lead, event);
  if (disposition === 'Hot Lead') {
    session.stats.hotLeads += 1;
    await tagEnrollmentHotLead(lead, event);
    await writeHotLeadRecord(session, lead, notes, event);
  }
  if (disposition === 'Appointment Set') session.stats.appointments += 1;
  if (disposition === 'Callback Later') session.stats.callbacks += 1;
  await saveSession(session, event);
  return { ok: true, lead };
}

// ---- recordings ----
async function listRecordings(event) {
  const s = dialerStore(event);
  const box = (await readJson(s, RECORDINGS_KEY)) || { recordings: [] };
  return Array.isArray(box.recordings) ? box.recordings : [];
}
async function addRecording(rec, event) {
  const s = dialerStore(event);
  const box = (await readJson(s, RECORDINGS_KEY)) || { recordings: [] };
  if (!Array.isArray(box.recordings)) box.recordings = [];
  if (box.recordings.some((r) => r.id === rec.id)) return { added: false, duplicate: true };
  box.recordings.unshift(rec);
  if (box.recordings.length > MAX_RECORDINGS) box.recordings = box.recordings.slice(0, MAX_RECORDINGS);
  await writeJson(s, RECORDINGS_KEY, box);
  return { added: true };
}

// ---- state view for the page ----
function publicSession(session) {
  if (!session) return null;
  const counts = { pending: 0, dialing: 0, connected: 0, done: 0 };
  for (const l of session.leads) {
    if (l.status === 'pending') counts.pending += 1;
    else if (l.status === 'dialing' || l.status === 'answered') counts.dialing += 1;
    else if (l.status === 'connected' || l.status === 'awaiting-disposition') counts.connected += 1;
    else if (l.status === 'done') counts.done += 1;
  }
  const activeLegs = Object.values(session.legs)
    .filter((l) => l.state !== 'ended')
    .map((l) => ({
      callControlId: l.callControlId,
      kind: l.kind,
      leadKey: l.leadKey || null,
      phone: l.phone,
      from: l.from || null, // caller ID this leg dialed out on (rotation pick)
      state: l.state,
      amdResult: l.amdResult || null,
      startedAt: l.startedAt,
      answeredAt: l.answeredAt || null,
    }));
  const connectedLead = session.connectedLeadKey ? findLead(session, session.connectedLeadKey) : null;
  return {
    id: session.id,
    status: session.status,
    source: session.source,
    market: session.market,
    counts,
    totalLeads: session.leads.length,
    stats: session.stats,
    lastError: session.lastError || null,
    activeLegs,
    connectedLead: connectedLead
      ? {
          key: connectedLead.key,
          phone: connectedLead.phone,
          name: connectedLead.name,
          address1: connectedLead.address1,
          city: connectedLead.city,
          market: connectedLead.market,
          attempts: connectedLead.attempts,
        }
      : null,
    queue: session.leads.slice(0, 60).map((l) => ({
      key: l.key,
      phone: l.phone,
      name: l.name,
      address1: l.address1,
      city: l.city,
      market: l.market,
      status: l.status,
      disposition: l.disposition,
      attempts: l.attempts,
    })),
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

// ---- HTTP handler ----
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    // Full login OR Irish's calling-only login (cc-auth) — the dialer
    // API is one of the two functions her tier may reach.
    if (!isAdmin(event) && !ccAuth.isIrish(event)) return unauth();

    const params = event.queryStringParameters || {};
    let body = null;
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return bad('Bad JSON body.');
      }
    }
    const action = params.action || (body && body.action) || (event.httpMethod === 'GET' ? 'state' : '');

    if (action === 'config') {
      const cfg = voice.voiceConfig();
      return ok({
        configured: cfg.configured,
        missing: cfg.missing,
        markets: Object.keys(lib.SENDER_POOLS),
        poolsReady: Object.fromEntries(
          Object.entries(lib.SENDER_POOLS).map(([m, pool]) => [m, Array.isArray(pool) && pool.length > 0])
        ),
      });
    }

    if (action === 'state') {
      const session = await loadSession(event);
      const recordings = await listRecordings(event);
      let rotationView = null;
      try {
        const rState = await rotation.loadState(dialerStore(event));
        rotationView = rotation.summarize(rState, lib.SENDER_POOLS);
      } catch (e) { /* rotation panel degrades to empty, never blocks state */ }
      return ok({ session: publicSession(session), recordings: recordings.slice(0, 50), rotation: rotationView });
    }

    if (action === 'rotation-state') {
      const rState = await rotation.loadState(dialerStore(event));
      return ok({ rotation: rotation.summarize(rState, lib.SENDER_POOLS) });
    }

    if (action === 'rotation-config') {
      const rState = await rotation.loadState(dialerStore(event));
      const r = rotation.setConfig(rState, body || {});
      if (r.errors.length) return bad(r.errors.join(' '));
      await rotation.saveState(dialerStore(event), rState);
      return ok({ rotation: rotation.summarize(rState, lib.SENDER_POOLS) });
    }

    if (action === 'recordings') {
      const recordings = await listRecordings(event);
      return ok({ recordings });
    }

    if (action === 'create-session') {
      const existing = await loadSession(event);
      if (existing && (existing.status === 'running' || existing.status === 'connected')) {
        return bad('A dialer session is already running — stop it before creating a new one.');
      }
      const source = body && body.source === 'paste' ? 'paste' : 'enrollments';
      const market = body && body.market ? String(body.market).toLowerCase() : '';
      let leads;
      if (source === 'paste') {
        leads = leadsFromPaste(body && body.leads, market);
      } else {
        leads = await leadsFromEnrollments(market || null, event);
      }
      if (!leads.length) {
        return bad(
          source === 'paste'
            ? 'No usable leads in the pasted list (every row needs a valid US phone).'
            : 'No callable enrollments found' + (market ? ' for market "' + market + '"' : '') + ' (sealed / bad-number contacts are excluded).'
        );
      }
      const session = newSession({ source, market, leads });
      await saveSession(session, event);
      return ok({ session: publicSession(session) });
    }

    if (action === 'start') {
      // FAIL CLOSED before anything is marked running.
      const cfg = voice.voiceConfig();
      if (!cfg.configured) {
        return json(503, {
          error: 'Telnyx voice is not configured — missing env: ' + cfg.missing.join(', ') + '.',
          configured: false,
          missing: cfg.missing,
        });
      }
      const session = await loadSession(event);
      if (!session) return bad('No session — create one first.');
      // Nov 28: never dial the wrong list. The page sends the id of
      // the session it built; if the stored session is a different
      // one (a stale save overwrote the new list — seen live twice
      // Nov 28, Start resumed the 48-seller enrolled session instead
      // of the 1-seller paste list), refuse loudly instead of
      // silently dialing the wrong sellers.
      if (body && body.sessionId && session.id !== body.sessionId) {
        return bad('The session changed since this list was built — rebuild the list before dialing.');
      }
      if (session.status === 'running' || session.status === 'connected') {
        return ok({ session: publicSession(session), already: true });
      }
      if (body && body.agentSipUri) session.agentSipUri = String(body.agentSipUri);
      if (!session.agentSipUri) {
        return bad('Agent audio is not connected yet — connect audio first so answered calls have somewhere to bridge.');
      }
      session.status = 'running';
      session.startedAt = session.startedAt || Date.now();
      session.endedAt = null;
      session.lastError = null;
      await saveSession(session, event);
      const r = await dialNextBatch(session, event);
      const fresh = await loadSession(event);
      return ok({ session: publicSession(fresh), dialed: r.dialed, error: r.error || null });
    }

    if (action === 'pause') {
      const session = await loadSession(event);
      if (!session) return bad('No session.');
      if (session.status === 'running') session.status = 'paused';
      await saveSession(session, event);
      return ok({ session: publicSession(session) });
    }

    if (action === 'stop') {
      const session = await loadSession(event);
      if (!session) return bad('No session.');
      // Hang up every live leg — seller legs AND the agent leg — and
      // say so when a hangup fails. A failed hangup used to be
      // swallowed and the leg marked 'ended' anyway, so a seller's
      // phone could keep ringing with the record claiming it was dead
      // (Nov 28: a ringing leg survived two Stops and page reloads).
      // A leg whose hangup fails stays live in the record (and its
      // lead stays 'dialing', so it can't be re-dialed while the
      // first leg still rings) — a second Stop retries it. A
      // 404/not-found from Telnyx means the leg is already gone, so
      // that one is marked ended. Telnyx's terminal-state error —
      // "This call is no longer active and can't receive commands" —
      // means the same thing (the call is already dead at Telnyx, so
      // there is nothing left to hang up); Nov 28 live test showed a
      // leg stuck 'Dialing' forever because only 404 counted as gone.
      const v = voiceLib();
      const alreadyGone = (e) => /404|not[\s-]?found|no longer active|receive commands/i.test(String((e && e.message) || e));
      const hangupFailures = [];
      const failedLeadKeys = new Set();
      const hangupLeg = async (callControlId, label, leadKey) => {
        try {
          await v.hangup(callControlId);
          return true;
        } catch (e) {
          if (alreadyGone(e)) return true;
          hangupFailures.push(label + ': ' + String((e && e.message) || e));
          if (leadKey) failedLeadKeys.add(leadKey);
          return false;
        }
      };
      for (const leg of Object.values(session.legs)) {
        if (leg.state === 'ended') continue;
        const hungUp = await hangupLeg(leg.callControlId, leg.phone || leg.callControlId, leg.leadKey);
        if (hungUp) {
          leg.state = 'ended';
          leg.endedAt = Date.now();
        }
      }
      // The agent leg usually rides in session.legs already (summonAgent
      // records it there); hang it up here only when it has no map entry.
      const legIds = new Set(Object.values(session.legs).map((l) => l.callControlId));
      if (session.agentCallControlId && !legIds.has(session.agentCallControlId)) {
        const hungUp = await hangupLeg(session.agentCallControlId, 'agent leg', null);
        if (hungUp) session.agentCallControlId = null;
      } else if (session.agentCallControlId && legIds.has(session.agentCallControlId)) {
        const agentLeg = session.legs[session.agentCallControlId];
        if (agentLeg && agentLeg.state === 'ended') session.agentCallControlId = null;
      }
      for (const lead of session.leads) {
        if (failedLeadKeys.has(lead.key)) continue; // still ringing — do not re-dial
        if (lead.status === 'dialing' || lead.status === 'answered') lead.status = 'pending';
        if (lead.status === 'connected' || lead.status === 'awaiting-disposition') lead.status = 'done';
      }
      session.winnerCallControlId = null;
      session.connectedLeadKey = null;
      session.status = 'stopped';
      session.endedAt = Date.now();
      if (hangupFailures.length) {
        session.lastError = 'stop-hangup-failed: ' + hangupFailures.join(' | ');
      } else if (session.lastError && session.lastError.indexOf('stop-hangup-failed:') === 0) {
        session.lastError = null; // a later Stop cleared the earlier failure
      }
      await saveSession(session, event);
      return ok({ session: publicSession(session) });
    }

    if (action === 'disposition') {
      const session = await loadSession(event);
      if (!session) return bad('No session.');
      const leadKey = body && body.leadKey;
      const disposition = body && body.disposition;
      if (!leadKey || !disposition) return bad('leadKey and disposition are required.');
      const r = await applyDisposition(session, leadKey, String(disposition), body.notes, event);
      if (!r.ok) return bad(r.reason);
      // If that was the connected call, the agent is free — resume.
      let dial = null;
      const fresh = await loadSession(event);
      if (fresh && fresh.status === 'connected') {
        fresh.status = 'running';
        await saveSession(fresh, event);
        dial = await dialNextBatch(fresh, event);
      }
      const after = await loadSession(event);
      if (after && after.status === 'running' && sessionComplete(after)) {
        after.status = 'complete';
        after.endedAt = Date.now();
        await saveSession(after, event);
      }
      const finalSession = await loadSession(event);
      return ok({ session: publicSession(finalSession), dialed: dial ? dial.dialed : [] });
    }

    return bad('Unknown action.');
  } catch (e) {
    return json(503, { error: 'Dialer storage is not ready yet', detail: String((e && e.message) || e) });
  }
};

Object.assign(module.exports, {
  DISPOSITIONS,
  MAX_CONCURRENT_LEGS,
  DIALER_STORE,
  ENROLL_STORE,
  SESSION_KEY,
  RECORDINGS_KEY,
  HOT_LEADS_KEY,
});

// Engine surface shared with telnyx-voice-webhook.js (same cross-require
// pattern as telnyx-webhook -> cc-bot-hook).
module.exports._engine = {
  loadSession,
  saveSession,
  dialNextBatch,
  findLead,
  activeSellerLegs,
  sessionComplete,
  listRecordings,
  addRecording,
  dialerStore,
  enrollStore,
  readJson,
  writeJson,
};

// Test hooks (not part of the deployed surface).
module.exports._test = {
  setStores(stores) {
    deps.dialerStoreFactory = stores && stores.dialer ? () => stores.dialer : null;
    deps.enrollStoreFactory = stores && stores.enrollments ? () => stores.enrollments : null;
  },
  setVoiceLib(v) {
    deps.voiceLib = v || null;
  },
  reset() {
    deps.dialerStoreFactory = null;
    deps.enrollStoreFactory = null;
    deps.voiceLib = null;
  },
  leadsFromPaste,
  leadsFromEnrollments,
  enrollmentCallable,
  publicSession,
  newSession,
};

// netlify/functions/cc-dnd.js
// Manual DND (Do Not Contact) for the standalone Command Center —
// the operator-side control behind the Conversations contact panel,
// mirroring the DND panel in the HighLevel app: per-channel toggles
// for Text Messages / Email / Calls & voicemail, set or cleared by
// hand, effective immediately for the workflow engine, the bot, and
// the dialer.
//
// State model (Troy's proven HL seal model, in standalone shapes):
//   rec.dndChannels = { sms, email, call } on the enrollment record
//   (cc-enrollments store) is the per-channel source of truth.
// The seal markers the automated side reads are kept in sync on every
// write, in exactly the shapes cc-bot-hook.sealEnrollment writes:
//   SMS channel ON  -> rec.dnd = true + 'dnc' tag (+ sealedAt /
//                      sealReason stamps). The engine ends such an
//                      enrollment 'ended-dnc' with zero sends and the
//                      bot never replies (cc-bot-hook.isSealed).
//   SMS channel OFF -> rec.dnd = false, 'dnc' tag removed, seal
//                      stamps cleared — a manual unseal is explicit,
//                      same as removing DND by hand in HL.
//   Call channel ON -> the dialer treats the lead as not callable
//                      (cc-dialer-api.enrollmentCallable).
//   thread.dnd mirrors the SMS channel — the same flag the bot's
//   seal sets on the conversation record.
// Records sealed before per-channel state existed (bot / workflow /
// dialer seals) carry no dndChannels: they derive all-three-ON,
// because every seal in this system mirrors HL's all-channel seal
// (master OFF + per-channel ON + dnc tag). Once an operator touches
// the toggles, dndChannels is written explicitly and read as stored.
'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const ENROLL_STORE = 'cc-enrollments';
const CONV_STORE = 'cc-conversations';
const CHANNELS = ['sms', 'email', 'call'];
const MANUAL_SEAL_REASON = 'manual-dnd';

// ---- store ----
let storeFactory = null; // (name) -> store; tests only
function makeStore(name, event) {
  if (storeFactory) return storeFactory(name);
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(name);
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

// ---- pure state logic ----
function lowerTags(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());
}

// Normalize an operator-supplied channel set. Returns null when the
// input is not an object at all; missing/non-true channels are OFF
// (fail-closed toward "not set", never toward "sealed by accident"
// in the other direction either: only an explicit true turns a
// channel on).
function cleanChannels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return {
    sms: input.sms === true,
    email: input.email === true,
    call: input.call === true,
  };
}

// Any seal marker the automated side honors (mirrors
// cc-workflow-engine.isSealedRecord + cc-bot-hook.isSealed, plus the
// thread flag the bot's seal writes).
function hasSealMarkers(rec, thread) {
  if (rec) {
    if (rec.dnd === true) return true;
    if (lowerTags(rec.tags).includes('dnc')) return true;
    if (rec.sealedAt != null || rec.sealReason != null) return true;
  }
  if (thread && thread.dnd === true) return true;
  return false;
}

// The per-channel truth for a record pair: an explicitly stored
// dndChannels wins; a legacy seal (no stored channels) derives
// all-three-ON; anything else is all-OFF.
function deriveChannels(rec, thread) {
  if (rec && rec.dndChannels && typeof rec.dndChannels === 'object') {
    return {
      sms: rec.dndChannels.sms === true,
      email: rec.dndChannels.email === true,
      call: rec.dndChannels.call === true,
    };
  }
  const sealed = hasSealMarkers(rec, thread);
  return { sms: sealed, email: sealed, call: sealed };
}

function stateFrom(rec, thread) {
  const channels = deriveChannels(rec, thread);
  return {
    channels,
    smsSealed: channels.sms,
    anyOn: channels.sms || channels.email || channels.call,
    allOn: channels.sms && channels.email && channels.call,
    tag: rec ? lowerTags(rec.tags).includes('dnc') : false,
    sealedAt: rec && rec.sealedAt != null ? rec.sealedAt : null,
    sealReason: rec && rec.sealReason != null ? rec.sealReason : null,
  };
}

// Apply a channel set to an enrollment record (mutates + returns it).
// Keeps the seal markers in sync with the SMS channel, in the exact
// shapes the engine / bot / dialer read. An existing seal's
// provenance (sealedAt / sealReason from the bot or the dialer) is
// preserved while SMS stays on; turning SMS off is an explicit
// manual unseal and clears the stamps.
function applyChannels(rec, channels, now) {
  const ch = cleanChannels(channels) || { sms: false, email: false, call: false };
  rec.dndChannels = { sms: ch.sms, email: ch.email, call: ch.call };
  let tags = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
  if (ch.sms) {
    if (!lowerTags(tags).includes('dnc')) tags.push('dnc');
    rec.dnd = true;
    if (rec.sealedAt == null) rec.sealedAt = now;
    if (rec.sealReason == null) rec.sealReason = MANUAL_SEAL_REASON;
  } else {
    tags = tags.filter((t) => String(t).trim().toLowerCase() !== 'dnc');
    rec.dnd = false;
    delete rec.sealedAt;
    delete rec.sealReason;
  }
  rec.tags = tags;
  rec.updatedAt = now;
  return rec;
}

// ---- store-level API ----
async function loadPair(key, event) {
  const es = makeStore(ENROLL_STORE, event);
  const cs = makeStore(CONV_STORE, event);
  const rec = await readJson(es, key);
  const thread = await readJson(cs, key);
  return { es, cs, rec, thread };
}

async function getState(key, event) {
  const { rec, thread } = await loadPair(key, event);
  return stateFrom(rec, thread);
}

async function setChannels(key, channels, event) {
  const ch = cleanChannels(channels);
  if (!ch) throw new Error('Invalid channels.');
  const { es, cs, rec: existing, thread } = await loadPair(key, event);
  let rec = existing;
  if (!rec) {
    if (!ch.sms && !ch.email && !ch.call) {
      // Nothing stored and nothing to seal: report the empty state
      // without minting a record.
      return stateFrom(null, thread);
    }
    // Same stub shape cc-client._ensureEnrollment writes, so the
    // seal survives on a phone that was never enrolled.
    const now = Date.now();
    rec = {
      key,
      phone: thread && thread.phone ? thread.phone : '+' + key,
      name: thread && thread.name ? thread.name : '',
      market: thread && thread.market ? thread.market : '',
      tags: [],
      dnd: false,
      status: 'stub',
      stub: true,
      createdAt: now,
      updatedAt: now,
    };
  }
  applyChannels(rec, ch, Date.now());
  await writeJson(es, key, rec);
  if (thread) {
    // Mirror cc-bot-hook.sealEnrollment: the thread carries the SMS
    // channel as its dnd flag (the Conversations UI hint). The
    // conversations index carries no dnd field, so a direct record
    // write is the whole update.
    thread.dnd = ch.sms;
    await writeJson(cs, key, thread);
  }
  return stateFrom(rec, thread);
}

module.exports = {
  CHANNELS,
  MANUAL_SEAL_REASON,
  cleanChannels,
  deriveChannels,
  stateFrom,
  applyChannels,
  getState,
  setChannels,
  _test: {
    setStoreFactory(fn) {
      storeFactory = fn || null;
    },
  },
};

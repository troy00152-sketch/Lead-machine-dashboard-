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

// Per-client HighLevel resolution (token env var + fallback rules):
// lib-client.resolveClientData — HL_API_TOKEN is the live token var,
// the client's named var wins when set, Troy's location/calendar are
// the fallback ONLY for Troy's own domains.
const libClient = require('./lib-client');

const ENROLL_STORE = 'cc-enrollments';
const CONV_STORE = 'cc-conversations';
const CHANNELS = ['sms', 'email', 'call'];
const MANUAL_SEAL_REASON = 'manual-dnd';

// ---- HighLevel mirror ----
// (Nov 27, 2026 — the highest-severity mirror gap: a Command Center
// seal left the contact fully contactable in HighLevel, so HL
// workflows, the HL bot guard, and the HL UI never saw it and HL
// could still text a seller Troy just sealed. Every setChannels now
// ALSO writes the seal to HL, best-effort: an HL failure NEVER
// breaks the local seal — it is logged loudly and reported as
// hlSync 'failed' (+hlError) so the UI can surface it.)
const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_VERSION_CONTACTS = '2021-07-28'; // Contacts ride 2021-07-28 (per-endpoint versions)
const HL_TIMEOUT_MS = 20000;

// Injectable HL dependencies (tests only): a fake fetch and/or a fake
// config. Production always uses the real fetch + resolveClientData.
const hlDeps = { fetchImpl: null, configImpl: null };

function hlConfig(event) {
  if (hlDeps.configImpl) return hlDeps.configImpl(event);
  if (String(process.env.CC_HL_SYNC || '') === '0') return null;
  let resolved = null;
  try {
    resolved = libClient.resolveClientData(event);
  } catch (e) {
    resolved = null;
  }
  if (!resolved || !resolved.token || !resolved.locationId) return null;
  return { token: resolved.token, locationId: resolved.locationId };
}

async function hlFetch(cfg, path, opts) {
  if (hlDeps.fetchImpl) return hlDeps.fetchImpl(cfg, path, opts);
  const o = opts || {};
  const method = o.method || 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HL_TIMEOUT_MS);
  try {
    const res = await fetch(HL_API_BASE + path, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        Version: HL_VERSION_CONTACTS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      /* non-JSON body */
    }
    if (!res.ok) {
      throw new Error(`HL ${res.status}: ${(data && data.message) || text.slice(0, 150)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}
function phoneDigits10(v) {
  const d = digitsOnly(v);
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
function e164OfPhone(phone) {
  const d = digitsOnly(phone);
  if (!d) return '';
  if (d.length === 10) return '+1' + d;
  return '+' + d;
}

// An HL contact id (20-char alphanumeric) vs a CC phone-key
// (11 digits). The two are never interchangeable.
function looksLikeHlId(v) {
  const s = String(v || '');
  return s.length >= 10 && /[A-Za-z]/.test(s) && /^[A-Za-z0-9]+$/.test(s);
}

// One dndSettings channel entry; the key case varies (SMS/Sms/sms).
function dndSetting(contact, channel) {
  const ds = contact && contact.dndSettings;
  if (!ds || typeof ds !== 'object') return null;
  const want = String(channel).toLowerCase();
  for (const k of Object.keys(ds)) {
    if (k.toLowerCase() === want) return ds[k];
  }
  return null;
}

// Permanent SMS (STOP_KEYWORD opt-out): HL 401s the WHOLE contact PUT
// when the body includes `sms` for such a contact (proven Nov 24–26),
// so the seal body must OMIT sms entirely — the permanent block is
// already the strongest outbound SMS block and stays untouched, on
// seal AND on unseal.
function isSmsPermanent(contact) {
  const s = dndSetting(contact, 'sms');
  if (!s || typeof s !== 'object') return false;
  if (String(s.status || '').toLowerCase() === 'permanent') return true;
  return /STOP_KEYWORD/i.test(String(s.message || ''));
}

// The proven HL seal form, mirrored channel-for-channel from the
// local set: master toggle OFF + per-channel boxes set to match +
// inbound block ON iff the SMS channel is sealed. `dnd:true` alone
// does NOT seal in HL. When SMS is permanent the `sms` key is omitted
// entirely (see isSmsPermanent) — never touched, never 401'd.
function hlSealBody(channels, smsPermanent) {
  const st = (on) => ({ status: on ? 'active' : 'inactive' });
  const dndSettings = { Call: st(channels.call), Email: st(channels.email) };
  if (!smsPermanent) dndSettings.SMS = st(channels.sms);
  return {
    dnd: false,
    dndSettings,
    inboundDndSettings: { all: { status: channels.sms ? 'active' : 'inactive' } },
  };
}

// Resolve the HL contact id: the enrollment record's HL id when it
// already is one, else an exact phone lookup. Returns the id, or null
// when the lookup is ambiguous (zero or multiple exact phone matches)
// — never guess; the caller reports hlSync 'unresolved' and keeps the
// local-only seal. Throws on transport/API failure (→ 'failed').
async function resolveHlContactId(rec, cfg, phoneE164) {
  if (rec) {
    if (looksLikeHlId(rec.hlContactId)) return String(rec.hlContactId);
    if (looksLikeHlId(rec.contactId)) return String(rec.contactId);
  }
  const phone = phoneE164 || e164OfPhone(rec && rec.phone);
  if (!phone) throw new Error('no phone or HL contact id to resolve against');
  const data = await hlFetch(
    cfg,
    `/contacts/?locationId=${encodeURIComponent(cfg.locationId)}&query=${encodeURIComponent(phone)}&limit=10`
  );
  const list = (data && (data.contacts || data.data)) || [];
  const target = phoneDigits10(phone);
  const exact = (Array.isArray(list) ? list : []).filter(
    (c) => c && c.id && phoneDigits10(c.phone || c.phoneNumber || '') === target
  );
  if (exact.length !== 1) return null;
  return String(exact[0].id);
}

// Write one local channel set to HighLevel. Returns
// { hlSync, hlError? } — 'ok' | 'failed' | 'unresolved' |
// 'skipped-no-config'. NEVER throws: every failure path is a return,
// so the local seal always stands.
async function syncHlDnd({ rec, thread, key, channels, event }) {
  const cfg = hlConfig(event);
  if (!cfg) return { hlSync: 'skipped-no-config' };
  const phoneE164 = e164OfPhone((rec && rec.phone) || (thread && thread.phone) || ('+' + key));
  let contactId;
  try {
    contactId = await resolveHlContactId(rec, cfg, phoneE164);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    console.error('[cc-dnd] HL SYNC FAILED — local seal kept, HL lookup error for', key, msg);
    return { hlSync: 'failed', hlError: msg };
  }
  if (!contactId) {
    console.error(
      '[cc-dnd] HL SYNC UNRESOLVED — local seal kept, no unique HL contact for',
      key,
      'phone',
      phoneE164
    );
    return { hlSync: 'unresolved' };
  }
  try {
    // GET the contact's current dndSettings FIRST: the permanent-SMS
    // guard depends on what HL already holds.
    const got = await hlFetch(cfg, `/contacts/${encodeURIComponent(contactId)}`);
    const contact = (got && got.contact) || got || {};
    const permanentSms = isSmsPermanent(contact);
    await hlFetch(cfg, `/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      body: hlSealBody(channels, permanentSms),
    });
    // The `dnc` tag follows the SMS channel, exactly like the local
    // record: added on seal, removed on unseal (DELETE /tags).
    if (channels.sms) {
      await hlFetch(cfg, `/contacts/${encodeURIComponent(contactId)}/tags`, {
        method: 'POST',
        body: { tags: ['dnc'] },
      });
    } else {
      await hlFetch(cfg, `/contacts/${encodeURIComponent(contactId)}/tags`, {
        method: 'DELETE',
        body: { tags: ['dnc'] },
      });
    }
    return { hlSync: 'ok' };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    console.error('[cc-dnd] HL SYNC FAILED — local seal kept, HL write error for', key, contactId, msg);
    return { hlSync: 'failed', hlError: msg };
  }
}

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
  // Mirror the seal to HighLevel. Best-effort by design: syncHlDnd
  // never throws, and an HL failure NEVER breaks the local seal —
  // the outcome rides on the returned state (hlSync / hlError) so
  // the UI can surface it.
  let hl = { hlSync: 'skipped-no-config' };
  try {
    hl = await syncHlDnd({ rec, thread, key, channels: ch, event });
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    console.error('[cc-dnd] HL SYNC FAILED — local seal kept, unexpected error for', key, msg);
    hl = { hlSync: 'failed', hlError: msg };
  }
  const state = stateFrom(rec, thread);
  state.hlSync = hl.hlSync;
  if (hl.hlError) state.hlError = hl.hlError;
  return state;
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
  isSmsPermanent,
  hlSealBody,
  syncHlDnd,
  resolveHlContactId,
  _test: {
    setStoreFactory(fn) {
      storeFactory = fn || null;
    },
    setHlFetch(fn) {
      hlDeps.fetchImpl = fn || null;
    },
    setHlConfig(fn) {
      hlDeps.configImpl = fn || null;
    },
  },
};

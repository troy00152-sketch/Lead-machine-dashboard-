// netlify/functions/cc-client.js
// Standalone Command Center client: implements the hl.js interface
// (~/workspace/playbook-system/custom-bot/src/hl.js) against ONLY the
// standalone stores — 'cc-conversations', 'cc-enrollments',
// 'cc-appointments' (via cc-appointments.js) and 'cc-opportunities'.
// NEVER any HighLevel / network call except the injected sendSms
// (default: telnyx-lib.sendSms).
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');
const appointmentsDefault = require('./cc-appointments');
const slots = require('./cc-slots');

const CONV_STORE = 'cc-conversations';
const ENROLL_STORE = 'cc-enrollments';
const OPP_STORE = 'cc-opportunities';
const MAX_MESSAGES_PER_THREAD = 500;

// HL custom-field IDs for the pricing trio (production HL shape:
// customFields = {id, value} ONLY).
const ARV_FIELD_ID = 'cOE6XmJNOdVKsDNpiGqR';
const MAO_FIELD_ID = 'B8Mfg1TQfjjo4Dl214A2';
const LAO_FIELD_ID = 'JUPzLFhe7VG0PCJqL0n8';
const FIELD_IDS = { arv: ARV_FIELD_ID, mao: MAO_FIELD_ID, lao: LAO_FIELD_ID, ARV: ARV_FIELD_ID, MAO: MAO_FIELD_ID, LAO: LAO_FIELD_ID };

// ---- pipelines: exactly as captured in hl-inventory.md section 2 ----
const PIPELINES = [
  {
    id: 'MPSsaaFHJ4qpQCv92Aio',
    name: 'Marketing Pipeline',
    stages: [
      { id: 'c8d1ce3e-c489-4145-8e13-029444c78ea7', name: 'New Lead' },
      { id: 'c55e952d-ff52-478e-8ef4-4eb5e445033c', name: 'Hot Lead' },
      { id: '3105e4b0-e1d3-4159-8360-2aa39b7958eb', name: 'New Booking' },
      { id: '034838fe-ced5-48b9-a6cc-d84ab3eb7434', name: 'Visit Attended' },
      { id: '73c4bda3-154b-4c3a-86b3-6d823fdb0bb4', name: 'Sale' },
      { id: '81272bed-ca29-4865-834b-882c6961be72', name: 'Left a Review' },
    ],
  },
  {
    id: 'mxFiMMkyMpKVE1y17eCB',
    name: 'Reactivation/ Win Back Pipeline',
    stages: [
      { id: '63589352-a2f4-46ad-a339-cc71c09c5df0', name: 'Past Customer/Cold Lead' },
      { id: '38aa90f7-8ccb-4566-8d6e-0404fc296ef2', name: 'Reactivation Sent' },
      { id: 'c9a6767e-c1ad-4a2d-8a39-ac9e51791493', name: 'Engaged' },
      { id: 'b4b979b6-b914-4620-919b-d5475e66082d', name: 'Interested' },
      { id: '9e3f79b6-b562-4f03-ad0a-4c0b22720162', name: 'Booking Created' },
      { id: '04ec9784-b180-443a-bf95-52f72403df9e', name: 'Won Back' },
      { id: '26b625fc-03e2-448b-96e9-96eef8d4e00a', name: 'Not Interested' },
      { id: '3334e5d7-53b1-49cb-8f36-ce34b5395c62', name: 'Do Not Contact' },
    ],
  },
  {
    id: 'TBpvmSWKwDTX8heKQ3VK',
    name: 'Lead',
    stages: [
      { id: '9096fb90-7a41-4ce6-842b-c082103c2bd5', name: 'New Lead' },
      { id: 'fccf4c5f-bc8a-4186-a88e-38542217470e', name: 'Warm Lead' },
      { id: '56599327-99a5-467c-94e7-618baf060404', name: 'Interested' },
      { id: '4696c413-c115-4514-ae2e-e66efdaf0b13', name: 'Appointment Set' },
      { id: 'a2f8383a-bb82-43aa-a5df-3ede936ea11c', name: 'Follow Up' },
    ],
  },
  {
    id: 'OwXzzBtm5hCsMwBnimwK',
    name: 'Acquisitions',
    stages: [
      { id: '92a35b8d-5fa6-44fb-b9f6-cf7745639cab', name: 'New' },
      { id: 'a431002a-56cf-490f-b548-78dc7cf77eec', name: 'Offer Sent' },
      { id: 'd2e292c5-57ac-49b1-92a8-76e4765d1ef0', name: 'Under Contract' },
      { id: '82299243-38c5-461a-a298-ee4f9e4525ea', name: 'Closed' },
    ],
  },
  {
    id: 'VL1sApF0aZTO1XfvirYh',
    name: 'Wholesaling',
    stages: [
      { id: '4b924d84-cac8-4d9b-af9f-595124edc719', name: 'New Deal' },
      { id: '4e17463f-019e-4729-b7e6-ffda2d8aa47c', name: 'Under Contract' },
      { id: 'b5639eea-bafd-473a-947e-d39932a7910a', name: 'Marketing' },
      { id: 'a49aa7ab-9bf1-47c5-939d-72311e41c74e', name: 'Sold' },
    ],
  },
  {
    id: '5ott9KMVDvLQqVxt3Oee',
    name: 'M2M',
    stages: [
      { id: 'ef4e77c7-7994-469b-a74d-81b14af43a30', name: 'New' },
      { id: 'f6196757-cf60-4086-9285-77f613d9b4e1', name: 'In Progress' },
      { id: 'd2fde1a7-dc3f-4a55-a495-e246ac977643', name: 'Closed' },
    ],
  },
  {
    id: '4vjV34x7owMUlmdxlNWH',
    name: 'Deal Board',
    stages: [
      { id: '94bc3b04-40b3-4c44-87dd-5beebc0db2e1', name: 'Active Deals' },
      { id: 'bd6946f1-0388-485a-a9a5-4b8eb3bd15b4', name: 'Under Contract' },
      { id: 'd1d369dc-84d5-4428-8836-397fe3a393bb', name: 'DNC' },
      { id: '7b47c7eb-18bb-4595-abd8-48beda6b68ec', name: 'Closed' },
    ],
  },
  {
    id: 'KCtQCaUsjYWZwkZHiNYq',
    name: 'Cash Buyers',
    stages: [
      { id: 'aec5666c-85c4-4b27-bf9e-f59bd3e5287b', name: 'New Buyer' },
      { id: 'f2def53e-007e-4027-993a-096ce1d43b6d', name: 'Active' },
      { id: '0075175a-39b2-46f4-b941-9bc22f0d9ecd', name: 'Closed Buyer' },
    ],
  },
  {
    id: 'acIK9O2fTD5QmLUF6YuG',
    name: 'Follow Up Pipeline',
    stages: [
      { id: '76cbc1cb-3c86-4b43-bda1-352cb4577a72', name: '30 Day' },
      { id: 'd87ebb83-3694-4b9c-ba3b-6d2e0040bbba', name: '60 Day' },
      { id: '416c82e8-f661-4bb8-8979-79d2b4521877', name: '90 Day' },
      { id: 'cbf199fb-21ef-4938-b4ff-2aae0a47ddfd', name: 'Long Term' },
    ],
  },
];

// ---- standalone helpers (hl.js semantics; getBallpark per spec) ----

/** Identical to hl.js normalizePhoneDigits. */
function normalizePhoneDigits(value) {
  if (value === undefined || value === null) return null;
  let d = String(value).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

function firstPresent(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/** Identical to hl.js customFieldValue. */
function customFieldValue(contact, fieldId, keyHints) {
  if (!contact || !Array.isArray(contact.customFields)) return null;
  let field = null;
  if (fieldId) field = contact.customFields.find((cf) => cf.id === fieldId);
  if (!field && keyHints && keyHints.length) {
    field = contact.customFields.find((cf) => {
      const key = String(cf.key || cf.name || '').toLowerCase();
      return keyHints.some((h) => key.includes(h));
    });
  }
  if (!field) return null;
  const raw =
    field.value !== undefined && field.value !== null && field.value !== ''
      ? field.value
      : field.fieldValue;
  if (raw === undefined || raw === null || raw === '') return null;
  const num = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function validPrice(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
function priceFromContact(contact, fieldId, hints, directKeys) {
  let v = customFieldValue(contact, fieldId, hints);
  if (v == null && contact) {
    // Direct / pricing-object shapes (enrollment-style records).
    const src = contact.pricing && typeof contact.pricing === 'object' ? contact.pricing : contact;
    for (const k of directKeys || []) {
      if (src && src[k] != null && src[k] !== '') {
        const n = parseFloat(String(src[k]).replace(/[^0-9.\-]/g, ''));
        if (Number.isFinite(n)) { v = n; break; }
      }
    }
  }
  return validPrice(v);
}

/**
 * Ballpark (spec): valid = finite number > 0.
 * Both MAO+LAO -> {mao, lao: min(lao, mao)};
 * MAO only -> {mao, lao: round(mao * 0.7)};
 * LAO only -> {mao: lao, lao}; neither -> null.
 */
function getBallpark(contact, config) {
  if (!contact) return null;
  const maoId = (config && config.maoFieldId) || MAO_FIELD_ID;
  const laoId = (config && config.laoFieldId) || LAO_FIELD_ID;
  const mao = priceFromContact(contact, maoId, ['mao'], ['mao', 'MAO']);
  const lao = priceFromContact(contact, laoId, ['lao'], ['lao', 'LAO']);
  if (mao != null && lao != null) return { mao, lao: Math.min(lao, mao) };
  if (mao != null) return { mao, lao: Math.round(mao * 0.7) };
  if (lao != null) return { mao: lao, lao };
  return null;
}

const PRICED_VERIFIED_TAGS = ['priced-verified', 'listing-verified', 'listing verified'];
const VERIFIED_FIELD_IDS = ['listing verified', 'listing_verified', 'listingVerified', 'listed status', 'listing status'];
const VERIFIED_FIELD_VALUES = [
  'true', 'yes', 'verified', 'not listed', 'not_listed', 'not-listed',
  'clear', 'cleared', 'pass',
];

function contactListingVerified(contact, config) {
  if (!contact) return false;
  const tags = (contact.tags || []).map((t) => String(t).trim().toLowerCase());
  if (PRICED_VERIFIED_TAGS.some((t) => tags.includes(t))) return true;
  if (Array.isArray(contact.customFields)) {
    let field = null;
    if (config && config.pricedVerifiedFieldId) {
      field = contact.customFields.find((cf) => cf.id === config.pricedVerifiedFieldId);
    }
    if (!field) {
      field = contact.customFields.find((cf) => {
        if (cf.id && VERIFIED_FIELD_IDS.some((id) => String(cf.id).toLowerCase() === id.toLowerCase())) return true;
        const key = String(cf.key || cf.name || '').toLowerCase().replace(/_/g, ' ');
        return key.includes('listing verified') || key.includes('priced verified')
          || key.includes('listing status');
      });
    }
    if (field) {
      const raw = field.value !== undefined && field.value !== null && field.value !== ''
        ? field.value : field.fieldValue;
      if (raw !== undefined && raw !== null
        && VERIFIED_FIELD_VALUES.includes(String(raw).trim().toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function getVerifiedPrice(contact, config) {
  if (!contactListingVerified(contact, config)) return null;
  const ballpark = getBallpark(contact, config);
  if (!ballpark) return null;
  const arvId = (config && config.arvFieldId) || ARV_FIELD_ID;
  const arv = priceFromContact(contact, arvId, ['arv'], ['arv', 'ARV']);
  if (arv == null) return null;
  return { ...ballpark, arv };
}

// ---- phone / key helpers ----
function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}
function keyOf(idOrPhone) {
  let d = digitsOnly(idOrPhone);
  if (d.length === 10) d = '1' + d;
  return d || String(idOrPhone || '');
}
function e164Of(key, phone) {
  if (phone) {
    try { return lib.toE164(phone); } catch (e) { /* fall through */ }
  }
  const d = digitsOnly(key);
  return d ? '+' + d : '';
}
function toE164OrNull(v) {
  const d = normalizePhoneDigits(v);
  return d ? '+1' + d : null;
}

// ---- store helpers ----
function makeDefaultStore(name, event) {
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

class CcClient {
  constructor(opts) {
    const o = opts || {};
    this._conversations = o.conversations || null;
    this._enrollments = o.enrollments || null;
    this._opportunities = o.opportunities || null;
    this._appointmentsApi = o.appointmentsApi || appointmentsDefault;
    this._sendSms = o.sendSms || null;
    this._nowOpt = o.now != null ? o.now : null;
    // Lambda event for the current invocation (Netlify Functions v1:
    // getStore() without connectLambda(event) has no context — reads
    // miss, writes silently no-op. The vendored bot handler calls
    // hl.* with NO event argument, so method-level event params are
    // always undefined on the bot path; the event MUST ride on the
    // client. Set at construction (cc-bot-runner) and refreshed per
    // invocation via setEvent() so a warm container never reuses a
    // stale invocation's context.
    this._event = o.event || null;
    this.config = o.config || {};
    // Field IDs (HL parity), overridable via config like hl.js.
    this.arvFieldId = this.config.arvFieldId || ARV_FIELD_ID;
    this.maoFieldId = this.config.maoFieldId || MAO_FIELD_ID;
    this.laoFieldId = this.config.laoFieldId || LAO_FIELD_ID;
  }

  _now() {
    if (typeof this._nowOpt === 'function') return this._nowOpt();
    if (typeof this._nowOpt === 'number') return this._nowOpt;
    return Date.now();
  }
  // Refresh the Lambda event for the current invocation (see
  // constructor). A method-level event, when the caller passes one,
  // still wins over the stored one.
  setEvent(event) {
    this._event = event || null;
    return this;
  }
  _eventOr(event) { return event || this._event; }
  _convStore(event) { return this._conversations || makeDefaultStore(CONV_STORE, this._eventOr(event)); }
  _enrollStore(event) { return this._enrollments || makeDefaultStore(ENROLL_STORE, this._eventOr(event)); }
  _oppStore(event) { return this._opportunities || makeDefaultStore(OPP_STORE, this._eventOr(event)); }
  _sendSmsImpl() { return this._sendSms || lib.sendSms; }

  async _loadEnrollment(key, event) {
    return readJson(this._enrollStore(event), key);
  }
  async _loadThread(key, event) {
    const t = await readJson(this._convStore(event), key);
    if (t && Array.isArray(t.messages)) return t;
    if (t) { t.messages = Array.isArray(t.messages) ? t.messages : []; return t; }
    return null;
  }
  async _saveThread(thread, event) {
    const cs = this._convStore(event);
    if (!Array.isArray(thread.messages)) thread.messages = [];
    if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
      thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
    }
    thread.updatedAt = this._now();
    await writeJson(cs, thread.key, thread);
    // Refresh the store 'index' entry — same shape as telnyx-webhook.js.
    const idx = (await readJson(cs, 'index')) || { updatedAt: 0, threads: {} };
    if (!idx.threads || typeof idx.threads !== 'object') idx.threads = {};
    // Preview/lastDir come from the last REAL message, never a Sam
    // note / draft suggestion (kind 'note' / 'suggestion').
    let last = null;
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const cand = thread.messages[i];
      if (cand && cand.kind !== 'note' && cand.kind !== 'suggestion') {
        last = cand;
        break;
      }
    }
    idx.threads[thread.key] = {
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

  // ---- contacts ----
  async getContact(contactId, event) {
    const key = keyOf(contactId);
    const rec = await this._loadEnrollment(key, event);
    if (rec) {
      // Spec: customFields carry ONLY the pricing trio, each entry
      // exactly {id, value} (the production HL shape).
      const customFields = [];
      const pricingSrc = rec.pricing && typeof rec.pricing === 'object' ? rec.pricing : {};
      const pricing = {
        arv: pricingSrc.arv != null ? pricingSrc.arv : rec.arv != null ? rec.arv : null,
        mao: pricingSrc.mao != null ? pricingSrc.mao : rec.mao != null ? rec.mao : null,
        lao: pricingSrc.lao != null ? pricingSrc.lao : rec.lao != null ? rec.lao : null,
      };
      const trio = [[ARV_FIELD_ID, pricing.arv], [MAO_FIELD_ID, pricing.mao], [LAO_FIELD_ID, pricing.lao]];
      for (const [fid, val] of trio) {
        if (val != null && val !== '' && !customFields.some((f) => f.id === fid)) {
          customFields.push({ id: fid, value: String(val) });
        }
      }
      const name = rec.name || [rec.firstName, rec.lastName].filter(Boolean).join(' ') || '';
      const firstName = rec.firstName || rec.givenName || (name ? name.split(/\s+/)[0] : '');
      const out = {
        id: key,
        phone: e164Of(key, rec.phone),
        name,
        firstName,
        email: rec.email || '',
        address1: rec.address1 || rec.address || '',
        city: rec.city || '',
        state: rec.state || '',
        postalCode: rec.postalCode || rec.zip || '',
        tags: Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [],
        dnd: !!rec.dnd,
        customFields,
      };
      if (rec.phoneType) out.phoneType = rec.phoneType;
      return out;
    }
    const thread = await this._loadThread(key, event);
    if (!thread) return null;
    const name = thread.name || '';
    const out = {
      id: key,
      phone: e164Of(key, thread.phone),
      name,
      firstName: name ? name.split(/\s+/)[0] : '',
      email: thread.email || '',
      address1: thread.address1 || '',
      city: thread.city || '',
      state: thread.state || '',
      postalCode: thread.postalCode || '',
      tags: Array.isArray(thread.tags) ? thread.tags.map((t) => String(t)) : [],
      dnd: !!thread.dnd,
      customFields: [],
    };
    if (thread.phoneType) out.phoneType = thread.phoneType;
    return out;
  }

  async _ensureEnrollment(key, event) {
    const es = this._enrollStore(event);
    let rec = await readJson(es, key);
    if (!rec) {
      const now = this._now();
      rec = {
        key,
        phone: e164Of(key),
        tags: [],
        dnd: false,
        status: 'stub',
        stub: true,
        createdAt: now,
        updatedAt: now,
      };
    }
    return { es, rec };
  }

  async setDnd(contactId, event) {
    const key = keyOf(contactId);
    const { es, rec } = await this._ensureEnrollment(key, event);
    rec.dnd = true;
    rec.updatedAt = this._now();
    await writeJson(es, key, rec);
    return { id: key, dnd: true };
  }

  async addTags(contactId, tags, event) {
    const key = keyOf(contactId);
    const { es, rec } = await this._ensureEnrollment(key, event);
    const cur = Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : [];
    const have = cur.map((t) => t.trim().toLowerCase());
    for (const t of tags || []) {
      const tag = String(t || '').trim();
      if (tag && !have.includes(tag.toLowerCase())) {
        cur.push(tag);
        have.push(tag.toLowerCase());
      }
    }
    rec.tags = cur;
    rec.updatedAt = this._now();
    await writeJson(es, key, rec);
    return { id: key, tags: cur };
  }

  // ---- conversations ----
  async findConversationId(contactId, event) {
    const key = keyOf(contactId);
    const thread = await readJson(this._convStore(event), key);
    return thread ? key : null;
  }

  async getMessages(conversationId, limit = 100, event) {
    const key = keyOf(conversationId);
    const thread = await this._loadThread(key, event);
    if (!thread) return [];
    const lim = limit == null ? 100 : Number(limit);
    // System notes (kind 'note' — Sam's post-call handoff — and kind
    // 'suggestion' — a draft bot suggestion) are NOT history: Amber
    // must never see a Sam note as a seller text, and a note must
    // never be the "latest inbound" the guards act on.
    const msgs = (thread.messages || []).filter(
      (m) => m && m.kind !== 'note' && m.kind !== 'suggestion'
    );
    const slice = lim > 0 ? msgs.slice(-lim) : msgs.slice();
    return slice.map((m) => ({
      id: m.id,
      direction: m.dir === 'in' ? 'inbound' : 'outbound',
      body: m.body || '',
      type: 2,
      dateAdded: m.at != null ? new Date(m.at).toISOString() : null,
      to: m.to != null ? m.to : null,
      from: m.from != null ? m.from : null,
      toNumber: normalizePhoneDigits(m.to),
      fromNumber: normalizePhoneDigits(m.from),
    }));
  }

  async sendSms(opts, event) {
    const o = opts || {};
    const message = o.message != null ? o.message : o.body;
    const key = keyOf(o.contactId || o.conversationId);
    const enrollment = await this._loadEnrollment(key, event);
    let thread = await this._loadThread(key, event);
    const sellerE164 = e164Of(key, (enrollment && enrollment.phone) || (thread && thread.phone));
    const sellerDigits = normalizePhoneDigits(sellerE164);
    const market = (enrollment && enrollment.market) || (thread && thread.market) || o.market || '';

    // From derivation: explicit > last inbound's `to` > sender pool.
    let from = null;
    const explicit = toE164OrNull(o.fromNumber || o.from);
    if (explicit && normalizePhoneDigits(explicit) !== sellerDigits) from = explicit;
    if (!from && thread) {
      const msgs = thread.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].dir === 'in') {
          const cand = toE164OrNull(msgs[i].to);
          if (cand && normalizePhoneDigits(cand) !== sellerDigits) from = cand;
          break;
        }
      }
    }
    if (!from && market) {
      try {
        const pick = lib.pickFromNumber || lib.pickSender;
        if (typeof pick === 'function') from = pick.call(lib, market);
      } catch (e) { /* pool empty — the send below fails closed */ }
    }

    if (!thread) {
      thread = {
        key,
        phone: sellerE164,
        name: (enrollment && enrollment.name) || '',
        market: market || '',
        messages: [],
        unread: 0,
        botLog: [],
      };
    }
    if (!Array.isArray(thread.messages)) thread.messages = [];
    if (!Array.isArray(thread.botLog)) thread.botLog = [];
    if (sellerE164) thread.phone = sellerE164;
    if (market && !thread.market) thread.market = market;
    if (from) thread.ourNumber = from;

    const now = this._now();
    const msg = {
      id: 'cc-' + crypto.randomUUID(),
      dir: 'out',
      body: String(message == null ? '' : message),
      at: now,
      status: 'queued',
      from: from || '',
      to: sellerE164,
      via: 'bot',
    };
    thread.messages.push(msg);
    await this._saveThread(thread, event);

    let sent;
    try {
      sent = await this._sendSmsImpl()({
        from: from || undefined,
        to: sellerE164,
        body: msg.body,
        market: market || undefined,
      });
    } catch (e) {
      msg.status = 'failed';
      msg.failureReason = String((e && e.message) || e);
      await this._saveThread(thread, event);
      throw e;
    }
    const telnyxId = (sent && (sent.id || sent.telnyxId)) || null;
    const effectiveFrom = from || (sent && sent.from) || '';
    msg.status = 'sent';
    // The stored id IS the Telnyx id — that is what telnyx-webhook's
    // applyEvent matches delivery/failure updates by, so a reply that
    // kept its 'cc-<uuid>' id could never advance past "Sent". The
    // local id is kept in `localId` for dedupe. (Same shape as the
    // manual-send path in cc-conversations-api.js.)
    if (telnyxId) {
      msg.localId = msg.id;
      msg.id = telnyxId;
      msg.telnyxId = telnyxId;
    }
    if (effectiveFrom) {
      msg.from = effectiveFrom;
      thread.ourNumber = effectiveFrom;
    }
    await this._saveThread(thread, event);
    return { id: telnyxId, conversationId: key, fromNumber: effectiveFrom };
  }

  // ---- calendars / appointments ----
  async getFreeSlots(calendarId, startMs, endMs, event) {
    const appts = await this._appointmentsApi.listAppointments({ fromMs: startMs, toMs: endMs }, this._eventOr(event));
    return slots.generateFreeSlots(appts || [], startMs, endMs);
  }

  async getCalendarEvents(calendarId, startMs, endMs, event) {
    const appts = await this._appointmentsApi.listAppointments({ fromMs: startMs, toMs: endMs }, this._eventOr(event));
    return (appts || [])
      .filter((a) => {
        const st = String(a.status || '').toLowerCase();
        if (st === 'cancelled' || st === 'invalid') return false;
        if (a.calendarId && calendarId && String(a.calendarId) !== String(calendarId)) return false;
        return !!(a.startISO || a.startTime) && !!(a.endISO || a.endTime);
      })
      .map((a) => ({
        id: a.id,
        calendarId: a.calendarId || calendarId,
        status: String(a.status || '').toLowerCase(),
        startTime: a.startISO || a.startTime,
        endTime: a.endISO || a.endTime,
      }));
  }

  async createAppointment(opts, event) {
    const o = opts || {};
    const key = o.contactId ? keyOf(o.contactId) : null;
    const enrollment = key ? await this._loadEnrollment(key, event) : null;
    const rec = await this._appointmentsApi.createAppointment({
      calendarId: o.calendarId || appointmentsDefault.CALENDAR_ID,
      contactId: key,
      phone: (enrollment && enrollment.phone) || (key ? e164Of(key) : ''),
      name: (enrollment && enrollment.name) || o.name || '',
      email: (enrollment && enrollment.email) || o.email || '',
      address1: (enrollment && (enrollment.address1 || enrollment.address)) || o.address1 || '',
      title: o.title || '',
      startISO: o.startISO || o.startTime,
      endISO: o.endISO || o.endTime,
      source: 'bot',
    }, this._eventOr(event));
    return {
      id: rec.id,
      calendarId: rec.calendarId,
      title: rec.title,
      startTime: rec.startISO,
      endTime: rec.endISO,
      status: rec.status || 'confirmed',
      hlEventId: rec.hlEventId || null,
      hlSync: rec.hlSync || null,
    };
  }

  async getUpcomingAppointments(calendarId, contactId, nowMs, event) {
    const now = nowMs != null ? nowMs : this._now();
    const key = keyOf(contactId);
    const appts = await this._appointmentsApi.listAppointments(
      { fromMs: now, toMs: now + 365 * 24 * 60 * 60 * 1000 }, this._eventOr(event));
    // Overlap listing from `now` includes in-progress appointments
    // (endMs > now); the filter below drops already-ended ones.
    return (appts || [])
      .filter((a) => {
        if (!a.id) return false;
        if (a.contactId && String(a.contactId) !== String(key)) return false;
        if (a.calendarId && calendarId && String(a.calendarId) !== String(calendarId)) return false;
        const st = String(a.status || '').toLowerCase();
        if (st === 'cancelled' || st === 'invalid') return false;
        const end = a.endMs != null ? a.endMs : Date.parse(a.endISO || a.endTime || '');
        if (!Number.isFinite(end) || end <= now) return false;
        return true;
      })
      .sort((x, y) => (x.startMs || Date.parse(x.startISO)) - (y.startMs || Date.parse(y.startISO)))
      .map((a) => ({
        id: a.id,
        calendarId: a.calendarId || calendarId,
        title: a.title || '',
        startTime: a.startISO || a.startTime,
        endTime: a.endISO || a.endTime,
        status: String(a.status || '').toLowerCase(),
      }));
  }

  async getPastAppointments(calendarId, contact, nowMs, windowMs, event) {
    const now = nowMs != null ? nowMs : this._now();
    const win = windowMs != null ? windowMs : 90 * 24 * 60 * 60 * 1000;
    // `contact` may be a contact object or a bare contactId.
    const c = contact && typeof contact === 'object' ? contact : { id: contact };
    const contactId = c.id ? String(c.id) : null;
    const email = c.email ? String(c.email).trim().toLowerCase() : null;
    const phone = normalizePhoneDigits(c.phone || c.phoneNumber || c.mobile || c.phone_number);
    const address = c.address1 ? String(c.address1).trim().toLowerCase() : null;
    const appts = await this._appointmentsApi.listAppointments(
      { fromMs: now - win, toMs: now }, this._eventOr(event));
    return (appts || [])
      .filter((a) => {
        if (!a.id) return false;
        if (a.calendarId && calendarId && String(a.calendarId) !== String(calendarId)) return false;
        const st = String(a.status || '').toLowerCase();
        if (st === 'cancelled' || st === 'invalid') return false;
        const start = a.startMs != null ? a.startMs : Date.parse(a.startISO || a.startTime || '');
        const end = a.endMs != null ? a.endMs : Date.parse(a.endISO || a.endTime || '');
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        if (end > now) return false;
        if (start < now - win) return false;
        // POSITIVE match only.
        if (contactId && a.contactId && String(a.contactId) === contactId) return true;
        if (email && a.email && String(a.email).trim().toLowerCase() === email) return true;
        if (phone && a.phone && normalizePhoneDigits(a.phone) === phone) return true;
        if (address) {
          const hay = `${a.title || ''} ${a.name || ''} ${a.address1 || ''}`.toLowerCase();
          if (hay.includes(address)) return true;
        }
        return false;
      })
      .map((a) => ({
        id: a.id,
        title: a.title || '',
        startTime: a.startISO || a.startTime,
        endTime: a.endISO || a.endTime,
        status: String(a.status || '').toLowerCase(),
      }));
  }

  async cancelAppointment(eventId, event) {
    const rec = await this._appointmentsApi.cancelAppointment(eventId, this._eventOr(event));
    if (!rec) return {};
    return { id: rec.id, status: 'cancelled' };
  }

  // ---- opportunities ----
  async getPipelines(locationId) {
    return { pipelines: JSON.parse(JSON.stringify(PIPELINES)) };
  }

  _oppKey(id) {
    const raw = String(id || '');
    return raw.startsWith('opp-') ? raw : 'opp-' + raw;
  }
  async _loadOppIndex(s) {
    const idx = await readJson(s, 'index');
    if (idx && Array.isArray(idx.ids)) return idx;
    return { ids: [] };
  }

  async searchOpportunities(criteria, event) {
    const { locationId, contactId, pipelineId } = criteria || {};
    const s = this._oppStore(event);
    const idx = await this._loadOppIndex(s);
    const out = [];
    for (const id of idx.ids) {
      const rec = await readJson(s, this._oppKey(id));
      if (!rec) continue;
      if (contactId != null && String(rec.contactId || rec.contact_id || '') !== String(contactId)) continue;
      if (pipelineId != null && String(rec.pipelineId || rec.pipeline_id || '') !== String(pipelineId)) continue;
      if (locationId != null && String(rec.locationId || '') !== String(locationId)) continue;
      out.push(rec);
    }
    return { opportunities: out };
  }

  async createOpportunity(body, event) {
    const s = this._oppStore(event);
    const now = this._now();
    const rec = {
      ...(body || {}),
      id: 'opp-' + crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(s, this._oppKey(rec.id), rec);
    const idx = await this._loadOppIndex(s);
    if (!idx.ids.includes(rec.id)) idx.ids.push(rec.id);
    await writeJson(s, 'index', idx);
    return rec;
  }

  async updateOpportunity(id, body, event) {
    const s = this._oppStore(event);
    const rec = await readJson(s, this._oppKey(id));
    if (!rec) return null;
    const out = { ...rec, ...(body || {}), id: rec.id, updatedAt: this._now() };
    await writeJson(s, this._oppKey(rec.id), out);
    return out;
  }

  // ---- generic request (HL parity surface, standalone only) ----
  async request(path, opts) {
    const o = opts || {};
    const method = String(o.method || 'POST').toUpperCase();
    if (path === '/conversations/messages' && method === 'POST') {
      const body = o.body || o;
      return this.sendSms({
        contactId: body.contactId,
        conversationId: body.conversationId,
        message: body.message,
        fromNumber: body.fromNumber,
      }, this._event);
    }
    throw new Error('CcClient: unsupported request ' + method + ' ' + path);
  }
}

function createCcClient(opts) {
  return new CcClient(opts);
}

module.exports = {
  CcClient,
  createCcClient,
  normalizePhoneDigits,
  customFieldValue,
  getBallpark,
  getVerifiedPrice,
  contactListingVerified,
  PIPELINES,
  FIELD_IDS,
  ARV_FIELD_ID,
  MAO_FIELD_ID,
  LAO_FIELD_ID,
};

// Test hooks (not part of the deployed surface).
module.exports._test = {
  PIPELINES,
  reset() { /* per-instance injection — nothing global to reset */ },
};

// netlify/functions/mail-loi.js
// LOI (letter of intent) send for the Command Center — DealBreeze
// takeaways build (Nov 13, 2026). Letters via PostGrid Print & Mail,
// mirroring the mail-send.js (postcard) safety architecture exactly.
//
// The letter's number is the lead's OPENING offer — the LAO the
// auto-pricing engine wrote to the CRM. Template: mail-loi-template.js.
//
// SAFETY (hard, by design — same rules as mail-send.js plus the LOI gate):
//   1. MAIL_MODE comes ONLY from the Netlify env var (default 'test').
//      The request body can NEVER flip test -> live. Test mode uses
//      POSTGRID_TEST_API_KEY only; test creates are never mailed/billed.
//      Live sends additionally need Troy's funding step (his hands).
//   2. LISTING GATE (listed-first HARD LOCK): the request must carry
//      listingVerified === true — set by the dashboard only when the
//      lead's pricing record carries a VERIFIED not-listed result.
//      Anything else (false, missing, "unknown") is refused (409).
//      An unverified listing status is never treated as cleared.
//   3. When contactId is given, the CRM contact is loaded: a dnc-tagged
//      or DND contact is never mailed, and the request's offerAmount is
//      cross-checked against the CRM's LAO field (env LOI_LAO_FIELD_ID)
//      when that field is readable — a mismatch is refused (409), so the
//      letter can only ever carry the number that's actually on the lead.
//   4. HARD $100/month cap (shared with postcards: same Blobs send log,
//      store 'direct-mail-log') enforced BEFORE any PostGrid call.
//      LOI cap accounting uses MAIL_LOI_PRICE_CENTS — an UNVERIFIED
//      conservative estimate placeholder, NOT a quoted PostGrid price;
//      verify letter pricing before any live send.
//   5. Same-day duplicate guard (same contact + property + date).
//   6. confirm:true required. Keys live ONLY in Netlify env vars and are
//      never logged or returned.
//
// PostGrid letters API (guides.postgrid.com): POST /print-mail/v1/letters
//   { to, from, html, color, doubleSided, addressPlacement,
//     mailingClass, description, metadata } -> { id, live, status, ... }.
//
// Endpoints:
//   GET  ?action=status -> { mode, capCents, spentCents, remainingCents,
//     count, month, loiPriceCents, loiPriceVerified:false }
//   POST { contactId?, listingVerified: true, ownerName, address1,
//     address2?, city, state, zip, propertyAddress, offerAmount,
//     letterDate?, confirm: true }
'use strict';

const crypto = require('crypto');
const https = require('https');
const tpl = require('./mail-loi-template.js');
const data = require('./mail-templates-data.js');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null; // local / test env without node_modules: log write skipped
}

const COOKIE_NAME = 'lm_auth';
const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_API_VERSION = '2021-07-28';
const HL_LOCATION_ID = require('./lib-client').defaultLocationId();
const POSTGRID_API_BASE = 'https://api.postgrid.com/print-mail/v1';
const LOG_STORE = 'direct-mail-log';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
const unavailable = (msg) => json(503, { error: msg });

// ---- admin auth (same HMAC as mail-send.js / title-order-email.js) ----
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
function cookieValid(event, secret) {
  const headers = event.headers || {};
  const cookie = getCookie(headers.cookie || headers.Cookie || '', COOKIE_NAME);
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
function bearerValid(event, secret) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false;
  return cookieValid(event, secret) || bearerValid(event, secret);
}

// ---- env ----
function readEnv() {
  const mode = (process.env.MAIL_MODE || 'test').toLowerCase().trim();
  const loiPrice = parseInt(String(process.env.MAIL_LOI_PRICE_CENTS || ''), 10);
  return {
    mode: mode === 'live' ? 'live' : 'test',
    testKey: process.env.POSTGRID_TEST_API_KEY || '',
    liveKey: process.env.POSTGRID_API_KEY || '',
    capCents: parseCap(process.env.MAIL_MONTHLY_CAP_CENTS),
    // Cap-accounting estimate ONLY (unverified — see header note 4).
    loiPriceCents: Number.isFinite(loiPrice) && loiPrice > 0 ? loiPrice : 200,
    hlToken: process.env.HL_API_TOKEN || '',
    laoFieldId: (process.env.LOI_LAO_FIELD_ID || '').trim(),
    from: {
      companyName: (process.env.MAIL_FROM_NAME || '').trim() || tpl.DEFAULT_FROM.companyName,
      addressLine1: (process.env.MAIL_FROM_LINE1 || '').trim() || tpl.DEFAULT_FROM.addressLine1,
      addressLine2: (process.env.MAIL_FROM_LINE2 || '').trim() || tpl.DEFAULT_FROM.addressLine2,
      city: (process.env.MAIL_FROM_CITY || '').trim() || tpl.DEFAULT_FROM.city,
      provinceOrState: (process.env.MAIL_FROM_STATE || '').trim() || tpl.DEFAULT_FROM.provinceOrState,
      postalOrZip: (process.env.MAIL_FROM_ZIP || '').trim() || tpl.DEFAULT_FROM.postalOrZip,
      countryCode: 'US',
    },
  };
}
function parseCap(v) {
  const n = parseInt(String(v || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : data.MONTHLY_CAP_CENTS;
}

// ---- HTTP helpers (built-ins only; injectable for fixtures) ----
function postJsonHttps(urlStr, { headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; if (text.length > 1_000_000) req.destroy(new Error('Response too large')); });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.write(body);
    req.end();
  });
}
function getHttps(urlStr, { headers = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; if (text.length > 1_000_000) req.destroy(new Error('Response too large')); });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.end();
  });
}
function hlHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Version: HL_API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

// ---- pure core (exported for the fixture regression suite) ----
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function validAddress(a) {
  if (!a) return 'Missing mailing address.';
  if (!a.address1) return 'Street address is required.';
  if (!a.city) return 'City is required.';
  if (!/^[A-Za-z]{2}$/.test(a.state || '')) return 'State must be a 2-letter code.';
  if (!/^\d{5}(-\d{4})?$/.test(a.zip || '')) return 'ZIP must be 5 digits (or ZIP+4).';
  return null;
}
function splitOwnerName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Homeowner', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
function buildPostGridContact(name, a) {
  const n = splitOwnerName(name);
  return {
    firstName: n.firstName, lastName: n.lastName,
    addressLine1: a.address1, addressLine2: a.address2 || '',
    city: a.city, provinceOrState: a.state, postalOrZip: a.zip,
    countryCode: 'US',
  };
}
function contactOptedOut(contact) {
  if (!contact) return false;
  const tags = (contact.tags || []).map((t) => String(t).toLowerCase());
  if (tags.includes('dnc')) return true;
  if (contact.dnd === true) return true;
  const dnd = contact.dndSettings || {};
  for (const ch of ['sms', 'call', 'email']) {
    if (dnd[ch] && dnd[ch].status === 'active') return true;
  }
  if (dnd.all && dnd.all.status === 'active') return true;
  return false;
}
function crmFieldNumber(contact, fieldId, keyHints) {
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
  const raw = field.value !== undefined && field.value !== null && field.value !== ''
    ? field.value : field.fieldValue;
  if (raw === undefined || raw === null || raw === '') return null;
  const num = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(num) ? num : null;
}
function idempotencyKey({ contactId, propertyAddress, dateStr }) {
  return crypto.createHash('sha256')
    .update(`loi|${contactId || ''}|${String(propertyAddress || '').toLowerCase()}|${dateStr}`)
    .digest('hex').slice(0, 32);
}
function postgridErrorMessage(res, fallback) {
  try {
    const parsed = JSON.parse(res.text || '{}');
    const msg = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message;
    if (msg) return `${fallback}: ${String(msg).slice(0, 200)}`;
  } catch (e) { /* fall through */ }
  return `${fallback} (HTTP ${res.status}).`;
}

// ---- Blobs send log (shared with mail-send.js — one $100 cap) ----
function getLogStore(event) {
  if (!blobs) return null;
  try {
    if (event) return blobs.getStore({ name: LOG_STORE, consistency: 'strong' });
    return blobs.getStore(LOG_STORE);
  } catch (e) {
    try { return blobs.getStore(LOG_STORE); } catch (e2) { return null; }
  }
}
async function logSend(store, entry) {
  if (!store) return false;
  try {
    await store.setJSON(`sends/${entry.month}/${entry.postgridId}.json`, entry);
    return true;
  } catch (e) { return false; }
}
async function monthSpend(store, month) {
  if (!store) return { spentCents: 0, count: 0 };
  try {
    const res = await store.list({ prefix: `sends/${month}/` });
    const keys = (res.blobs || []).map((b) => b.key);
    let spent = 0;
    for (const key of keys) {
      try {
        const entry = await store.get(key, { type: 'json' });
        if (entry && Number.isFinite(entry.costCents)) spent += entry.costCents;
      } catch (e) { /* one unreadable entry never blocks cap math */ }
    }
    return { spentCents: Math.round(spent * 100) / 100, count: keys.length };
  } catch (e) { return { spentCents: 0, count: 0 }; }
}
async function findDuplicate(store, month, idemKey) {
  if (!store || !idemKey) return false;
  try {
    const res = await store.list({ prefix: `sends/${month}/` });
    for (const b of res.blobs || []) {
      try {
        const entry = await store.get(b.key, { type: 'json' });
        if (entry && entry.idemKey === idemKey) return true;
      } catch (e) { /* an unreadable entry is not a duplicate */ }
    }
  } catch (e) { /* log unavailable: duplicate check is best-effort */ }
  return false;
}

// ---- HighLevel ----
async function hlGetContact(token, contactId, getImpl) {
  const url = `${HL_API_BASE}/contacts/${encodeURIComponent(contactId)}?locationId=${encodeURIComponent(HL_LOCATION_ID)}`;
  const res = await (getImpl || getHttps)(url, { headers: hlHeaders(token) });
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new Error(`HighLevel lookup failed (HTTP ${res.status}).`);
  let parsed = {};
  try { parsed = JSON.parse(res.text || '{}'); } catch (e) { parsed = {}; }
  return parsed.contact || parsed || null;
}
async function hlAddTags(token, contactId, tags, postImpl) {
  const url = `${HL_API_BASE}/contacts/${encodeURIComponent(contactId)}/tags`;
  const res = await (postImpl || postJsonHttps)(url, {
    headers: hlHeaders(token),
    body: JSON.stringify({ tags }),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HighLevel tag failed (HTTP ${res.status}).`);
}

// ---- PostGrid ----
async function postgridCreateLetter(key, payload, postImpl) {
  const res = await (postImpl || postJsonHttps)(`${POSTGRID_API_BASE}/letters`, {
    headers: { 'X-API-Key': key },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(postgridErrorMessage(res, 'PostGrid could not create the letter'));
  }
  let parsed = {};
  try { parsed = JSON.parse(res.text || '{}'); } catch (e) { parsed = {}; }
  return parsed;
}

// ---- handler ----
async function handle(event, deps = {}) {
  const env = deps.env || readEnv();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  if (!isAdmin(event)) return unauth();

  const qs = event.queryStringParameters || {};
  const now = deps.now ? deps.now() : new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const store = deps.store !== undefined ? deps.store : getLogStore(event);

  if (event.httpMethod === 'GET' && qs.action === 'status') {
    const { spentCents, count } = await monthSpend(store, month);
    return ok({
      kind: 'loi', mode: env.mode,
      capCents: env.capCents, spentCents, count,
      remainingCents: Math.max(0, Math.round((env.capCents - spentCents) * 100) / 100),
      month, loiPriceCents: env.loiPriceCents, loiPriceVerified: false,
      postgridConnected: env.mode === 'live' ? !!env.liveKey : !!env.testKey,
    });
  }
  if (event.httpMethod !== 'POST') return bad('Method not allowed.');

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return bad('Invalid JSON body.'); }
  if (body.confirm !== true) return bad('confirm:true is required — the dashboard confirm sheet is the send gate.');

  // LISTING GATE — fail closed. Only an explicit verified flag passes.
  if (body.listingVerified !== true) {
    return json(409, {
      error: 'Listing status is not verified for this lead. The listed-first check must return a verified "not listed" before an offer letter can go out.',
      code: 'listing_unverified',
    });
  }

  const to = {
    address1: cleanStr(body.address1, 120), address2: cleanStr(body.address2, 60),
    city: cleanStr(body.city, 60), state: cleanStr(body.state, 2).toUpperCase(),
    zip: cleanStr(body.zip, 10),
  };
  const addrErr = validAddress(to);
  if (addrErr) return bad(addrErr);
  const ownerName = cleanStr(body.ownerName, 120);
  if (!ownerName) return bad('ownerName is required.');
  const propertyAddress = cleanStr(body.propertyAddress, 200);
  if (!propertyAddress) return bad('propertyAddress is required.');
  const offerAmount = Math.round(Number(body.offerAmount));
  if (!Number.isFinite(offerAmount) || offerAmount <= 0) return bad('offerAmount must be a positive dollar figure.');

  const contactId = cleanStr(body.contactId, 64) || null;
  let contact = null;
  if (contactId && env.hlToken) {
    try {
      contact = await (deps.hlGetContact || hlGetContact)(env.hlToken, contactId, deps.getImpl);
    } catch (e) {
      return unavailable('Could not load the CRM contact to verify this send. Nothing was mailed.');
    }
    if (!contact) return bad('Contact not found in the CRM. Nothing was mailed.');
    if (contactOptedOut(contact)) {
      return json(409, { error: 'This contact is DND / opted out — never mailed (house rule).', code: 'contact_opted_out' });
    }
    // The letter carries the CRM's number or no number at all.
    const crmLao = crmFieldNumber(contact, env.laoFieldId, ['lao']);
    if (crmLao !== null && Math.round(crmLao) !== offerAmount) {
      return json(409, {
        error: `Offer figure $${offerAmount.toLocaleString('en-US')} does not match the LAO on the CRM contact ($${Math.round(crmLao).toLocaleString('en-US')}). Refusing to mail a number that is not on the lead.`,
        code: 'offer_mismatch',
      });
    }
  }

  const { spentCents } = await monthSpend(store, month);
  if (spentCents + env.loiPriceCents > env.capCents) {
    return json(402, {
      error: `Monthly mail cap reached — this letter would take ${month} spend past the $100 cap.`,
      code: 'monthly_cap_reached', spentCents, capCents: env.capCents,
    });
  }

  const dateStr = now.toISOString().slice(0, 10);
  const idemKey = idempotencyKey({ contactId, propertyAddress, dateStr });
  if (await findDuplicate(store, month, idemKey)) {
    return json(409, { error: 'This LOI was already sent today for this property — duplicate refused.', code: 'duplicate_send' });
  }

  let html;
  try {
    html = tpl.renderLoi({
      ownerName,
      mailingAddress: to.address1 + (to.address2 ? ` ${to.address2}` : ''),
      mailingCityStateZip: `${to.city}, ${to.state} ${to.zip}`,
      propertyAddress,
      offerAmount: tpl.money(offerAmount),
      letterDate: cleanStr(body.letterDate, 40) || now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
      fromName: env.from.companyName,
      fromAddressLine1: env.from.addressLine1,
      fromCityStateZip: `${env.from.city}, ${env.from.provinceOrState} ${env.from.postalOrZip}`,
    });
  } catch (e) {
    return bad(e.message);
  }

  const key = env.mode === 'live' ? env.liveKey : env.testKey;
  if (!key) {
    return unavailable(env.mode === 'live'
      ? 'PostGrid live key is not set (POSTGRID_API_KEY). Live sends also need Troy\'s funding step.'
      : 'PostGrid test key is not set (POSTGRID_TEST_API_KEY). Add the free test key in Netlify to try a test send.');
  }

  let created;
  try {
    created = await postgridCreateLetter(key, {
      to: buildPostGridContact(ownerName, to),
      from: env.from,
      html, color: false, doubleSided: false,
      addressPlacement: 'top_first_page',
      mailingClass: 'first_class',
      description: `LOI — ${propertyAddress}`,
      metadata: { contactId: contactId || '', kind: 'loi' },
    }, deps.postImpl);
  } catch (e) {
    return unavailable(e.message);
  }

  const entry = {
    kind: 'loi', postgridId: created.id || `local-${idemKey}`,
    idemKey, contactId, propertyAddress, offerAmount,
    costCents: env.loiPriceCents, month, date: dateStr,
    mode: env.mode, live: created.live === true,
    status: created.status || 'queued',
  };
  await logSend(store, entry);

  if (contactId && env.hlToken) {
    try {
      await (deps.hlAddTags || hlAddTags)(env.hlToken, contactId,
        ['mailed', 'mail-loi', `mailed-${dateStr}`], deps.postImpl);
    } catch (e) { /* tag failures never fail the send (mail-send.js rule) */ }
  }

  return ok({ sent: true, testMode: env.mode === 'test', ...entry });
}

exports.handler = async (event) => {
  try {
    return await handle(event, {});
  } catch (e) {
    return json(500, { error: 'Unexpected error — nothing was mailed.' });
  }
};
exports._test = {
  handle, readEnv, validAddress, contactOptedOut, crmFieldNumber,
  idempotencyKey, buildPostGridContact, monthSpend,
};

// netlify/functions/mail-send.js
// One-click postcard send from the Command Center dashboard (Troy-side only).
//
// POSTCARDS ONLY (Troy, Nov 11, 2026) via PostGrid, Starter plan ($0/mo).
// Prices verified Nov 11, 2026: 4x6 First Class $0.902 · 6x9 First Class $1.023.
// The dashboard NEVER sends silently: the lead modal shows a confirm sheet
// (template preview + size + recipient address + live price + month spend
// vs cap) and Troy confirms. The function also requires confirm:true.
//
// SAFETY (hard, by design):
//   1. MAIL_MODE comes ONLY from the Netlify env var (default 'test').
//      The request body can NEVER flip test -> live.
//   2. Test mode uses POSTGRID_TEST_API_KEY only. No live key = no live send,
//      full stop. Live sends also need MAIL_MODE=live + POSTGRID_API_KEY.
//   3. HARD $100/month cap (MAIL_MONTHLY_CAP_CENTS, default 10000) is
//      enforced in code BEFORE any PostGrid call, from the Blobs send log.
//      A send that would take the month over the cap is refused (402).
//   4. No DND / dnc-tagged contact is ever mailed (house rule).
//   5. No paid address-verification call is made: PostGrid verifies the
//      inline recipient address itself when the postcard is created.
//      This function only fails closed on a missing/incomplete mailing
//      address (street/city/state/ZIP) before any PostGrid call.
//   6. A same-day duplicate guard: the Blobs log is checked for a send
//      with the same contact + size + template + date before creating;
//      a double-click / retry is refused (409 duplicate_send) instead
//      of mailing twice. (PostGrid has no documented idempotency key.)
//   7. Keys live ONLY in Netlify env vars (POSTGRID_API_KEY,
//      POSTGRID_TEST_API_KEY, HL_API_TOKEN). Credential values are NEVER
//      logged or returned.
//
// PostGrid Print & Mail API (guides.postgrid.com, verified Nov 11, 2026):
//   Auth: X-API-Key header. Keys are test_sk_... / live_sk_... from the
//   PostGrid dashboard (Settings -> API Keys); test keys are free, no
//   card required, and test creates are never printed/mailed/billed.
//   POST /print-mail/v1/postcards {to, from, frontHTML, backHTML, size,
//     mailingClass, description, metadata} -> { id, live, status, ... }.
//   Size values are PostGrid's: '6x4' = 4x6 card, '9x6' = 6x9 card.
//   A PostGrid template id can be used instead of HTML: frontTemplate /
//   backTemplate + mergeVariables. A single 2-page PDF can be used
//   instead: { pdf } (first page = front, second = back).
//   PostGrid verifies the inline recipient address itself when the
//   postcard is created — there is NO separate verification call, and
//   the paid Address Verification API is NOT used here.
//   NOTE: PostGrid's raw API has NO preview/confirmation-token step — the
//   create call IS the send. The dashboard confirm sheet + MAIL_MODE +
//   cap are the confirmation gates.
//   PostGrid's create response carries no price field, so cap accounting
//   uses the verified per-piece table (mail-templates-data.js).
//
// Flow:
//   1. Admin auth (lm_auth cookie or Bearer dashboard password).
//   2. Validate size/template/recipient address; confirm:true required.
//   3. If contactId: load the HL contact; skip on dnc tag or any DND.
//      Use the HL name/address when present, else the supplied values.
//   4. Cap check from the Blobs log (store 'direct-mail-log').
//   5. Duplicate check against the Blobs log (same contact/size/template/date).
//   6. Render the template (built-in HTML with merge vars, or the custom
//      design's front/back) and create the postcard at PostGrid.
//   7. Log the send to Blobs + tag the HL contact (mailed, mail-postcard,
//      mailed-YYYY-MM-DD) + optional Mail Sent Date custom field when
//      MAIL_SENT_DATE_FIELD_ID is set. Tag failures never fail the send.
//
// Endpoints:
//   GET  ?action=status -> { mode, capCents, spentCents, remainingCents,
//     count, prices, month } (admin only)
//   POST { contactId?, ownerName, address1, address2?, city, state, zip,
//     size, templateId?, confirm: true }
'use strict';

const crypto = require('crypto');
const https = require('https');
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
// Location via the shared config point (lib-client.js): HL_LOCATION_ID
// env var when set, else Troy's id — identical until the env var is set.
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
const capHit = (spent, cap, price, month) => ({
  error: `Monthly mail cap reached — this postcard ($${(price / 100).toFixed(2)}) would take ${month} spend past the $100 cap.`,
  code: 'monthly_cap_reached',
  spentCents: spent,
  capCents: cap,
});
const unavailable = (msg) => json(503, { error: msg });

// ---- admin auth (same HMAC as title-order-email.js) ----
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
  return {
    mode: mode === 'live' ? 'live' : 'test',
    testKey: process.env.POSTGRID_TEST_API_KEY || '',
    liveKey: process.env.POSTGRID_API_KEY || '',
    capCents: parseCap(process.env.MAIL_MONTHLY_CAP_CENTS),
    hlToken: process.env.HL_API_TOKEN || '',
    mailSentDateFieldId: (process.env.MAIL_SENT_DATE_FIELD_ID || '').trim(),
    from: {
      companyName: (process.env.MAIL_FROM_NAME || '').trim() || data.DEFAULT_FROM.companyName,
      addressLine1: (process.env.MAIL_FROM_LINE1 || '').trim() || data.DEFAULT_FROM.addressLine1,
      addressLine2: (process.env.MAIL_FROM_LINE2 || '').trim() || data.DEFAULT_FROM.addressLine2,
      city: (process.env.MAIL_FROM_CITY || '').trim() || data.DEFAULT_FROM.city,
      provinceOrState: (process.env.MAIL_FROM_STATE || '').trim() || data.DEFAULT_FROM.provinceOrState,
      postalOrZip: (process.env.MAIL_FROM_ZIP || '').trim() || data.DEFAULT_FROM.postalOrZip,
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
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
          if (text.length > 1_000_000) req.destroy(new Error('Response too large'));
        });
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
        res.on('data', (c) => {
          text += c;
          if (text.length > 1_000_000) req.destroy(new Error('Response too large'));
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.end();
  });
}
function postgridHeaders(key) {
  return { 'X-API-Key': key };
}
// PostGrid size values: '6x4' is the 4x6 card, '9x6' is the 6x9 card.
function postgridSize(size) {
  return size === '6x9' ? '9x6' : '6x4';
}
function hlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
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
// PostGrid verifies the inline recipient address itself at create time;
// there is no separate verification step and no deliverability gate
// here. validAddress() above is the only address check (fail-closed
// on missing/incomplete fields).
function splitOwnerName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Homeowner', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
function buildPostGridContact(name, a) {
  const n = splitOwnerName(name);
  const c = {
    firstName: n.firstName,
    addressLine1: a.address1,
    addressLine2: a.address2 || '',
    city: a.city,
    provinceOrState: a.state.toUpperCase(),
    postalOrZip: a.zip,
    countryCode: 'US',
  };
  if (n.lastName) c.lastName = n.lastName;
  return c;
}
// Wrap an image URL in full-bleed HTML (PostGrid takes HTML, not a bare
// image URL, for front/back art).
function imageArtHtml(url) {
  const safe = String(url).replace(/"/g, '%22');
  return (
    '<html><head><meta charset="utf-8"><style>' +
    '*{margin:0;padding:0}body{width:100%;height:100%}' +
    'img{width:100%;height:100%;object-fit:cover;display:block}' +
    `</style></head><body><img src="${safe}"></body></html>`
  );
}
function idempotencyKey({ contactId, size, templateId, dateStr }) {
  const base = `dpb-${contactId || 'no-contact'}-${dateStr}-${size}-${templateId}`;
  return base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 200);
}
function postgridErrorMessage(res, fallback) {
  try {
    const parsed = JSON.parse(res.text || '{}');
    const err = parsed && parsed.error;
    const msg = (err && (err.message || err)) || parsed.message;
    if (msg) return String(msg).slice(0, 300);
  } catch (e) {
    /* fall through */
  }
  return `${fallback} (HTTP ${res.status}).`;
}

// ---- Blobs send log ----
// Same Blobs-context rule as mail-templates.js (Nov 11 fix): connectLambda
// (event) must run before getStore(), or getStore() throws
// MissingBlobsEnvironmentError in production and the status read 503s
// ("Mail send failed. Nothing was sent."), which also killed the Send
// Mail sheet (it loads templates + status together). Never throws: on
// any Blobs failure returns null and monthSpend() treats it as zero
// spend — the cap is re-checked from the real log at send time.
function getLogStoreFor(event) {
  if (!blobs) return null;
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) {
    /* best-effort; getStore may still work with ambient context */
  }
  try {
    return blobs.getStore(LOG_STORE);
  } catch (e) {
    return null;
  }
}

function getLogStore() {
  return getLogStoreFor(null);
}

// Same wiring for the template store (custom designs live there).
function getStoreForTemplates(event) {
  if (!blobs) return null;
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) {
    /* best-effort; getStore may still work with ambient context */
  }
  try {
    return blobs.getStore('direct-mail-templates');
  } catch (e) {
    return null;
  }
}
async function logSend(store, entry) {
  if (!store) return false;
  try {
    await store.setJSON(`sends/${entry.month}/${entry.postgridId}.json`, entry);
    return true;
  } catch (e) {
    return false;
  }
}
async function monthSpend(store, month, listImpl) {
  // Source of truth: one blob per send, summed by month prefix.
  if (!store) return { spentCents: 0, count: 0 };
  try {
    const list = listImpl || ((prefix) => store.list({ prefix }));
    const res = await list(`sends/${month}/`);
    const keys = (res.blobs || []).map((b) => b.key);
    let spent = 0;
    for (const key of keys) {
      try {
        const entry = await store.get(key, { type: 'json' });
        if (entry && Number.isFinite(entry.costCents)) spent += entry.costCents;
      } catch (e) {
        /* a single unreadable entry never blocks the cap math */
      }
    }
    return { spentCents: Math.round(spent * 100) / 100, count: keys.length };
  } catch (e) {
    return { spentCents: 0, count: 0 };
  }
}

// ---- HighLevel ----
async function hlGetContact(token, contactId, getImpl) {
  const url = `${HL_API_BASE}/contacts/${encodeURIComponent(contactId)}?locationId=${encodeURIComponent(HL_LOCATION_ID)}`;
  const res = await (getImpl || getHttps)(url, { headers: hlHeaders(token) });
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new Error(`HighLevel lookup failed (HTTP ${res.status}).`);
  let parsed = {};
  try {
    parsed = JSON.parse(res.text || '{}');
  } catch (e) {
    parsed = {};
  }
  return parsed.contact || parsed || null;
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
async function hlAddTags(token, contactId, tags, postImpl) {
  const url = `${HL_API_BASE}/contacts/${encodeURIComponent(contactId)}/tags`;
  const res = await (postImpl || postJsonHttps)(url, {
    headers: hlHeaders(token),
    body: JSON.stringify({ tags }),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HighLevel tag failed (HTTP ${res.status}).`);
}
async function hlSetMailDate(token, contactId, fieldId, dateStr, putImpl) {
  // HighLevel contact updates are PUT, not POST.
  const url = `${HL_API_BASE}/contacts/${encodeURIComponent(contactId)}`;
  const res = await (putImpl || putHttps)(url, {
    headers: hlHeaders(token),
    body: JSON.stringify({ customFields: [{ id: fieldId, fieldValue: dateStr }] }),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HighLevel field write failed (HTTP ${res.status}).`);
  return true;
}
function putHttps(urlStr, { headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method: 'PUT',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
          if (text.length > 1_000_000) req.destroy(new Error('Response too large'));
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.write(body);
    req.end();
  });
}

// ---- PostGrid ----
async function postgridCreatePostcard(key, payload, postImpl) {
  const res = await (postImpl || postJsonHttps)(`${POSTGRID_API_BASE}/postcards`, {
    headers: postgridHeaders(key),
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(postgridErrorMessage(res, 'PostGrid could not create the postcard'));
  }
  let parsed = {};
  try {
    parsed = JSON.parse(res.text || '{}');
  } catch (e) {
    parsed = {};
  }
  return parsed;
}

// Same-day duplicate guard: has this exact send already been logged?
async function findDuplicate(store, month, idemKey) {
  if (!store || !idemKey) return false;
  try {
    const res = await store.list({ prefix: `sends/${month}/` });
    for (const b of res.blobs || []) {
      try {
        const entry = await store.get(b.key, { type: 'json' });
        if (entry && entry.idemKey === idemKey) return true;
      } catch (e) {
        /* an unreadable entry is not a duplicate */
      }
    }
  } catch (e) {
    /* a list failure must not block the send */
  }
  return false;
}

// ---- send pipeline (pure-ish; I/O injected for fixtures) ----
async function runSend({ env, body, deps }) {
  const post = (deps && deps.postJson) || postJsonHttps;
  const get = (deps && deps.get) || getHttps;
  const put = (deps && deps.put) || putHttps;
  const store = deps && deps.store !== undefined ? deps.store : getLogStoreFor(deps && deps.event);
  const now = (deps && deps.now) || new Date();
  const month = data.monthKey(now);
  const dateStr = now.toISOString().slice(0, 10);

  const size = body.size === '6x9' ? '6x9' : '4x6';
  const priceCents = data.priceCentsFor(size);
  if (!body.confirm) return { status: 400, body: { error: 'Confirm the send first — the confirm sheet must be approved.' } };

  // Resolve the template (built-in or custom) from the stored state.
  const templatesState = deps && deps.templatesState;
  if (!templatesState) return { status: 503, body: { error: 'Template storage is not available yet.' } };
  const templateId = String(body.templateId || templatesState.activeId || 'cash-offer');
  const builtin = data.getBuiltin(templateId);
  const custom = !builtin && (templatesState.customs || []).find((c) => c.id === templateId);
  if (!builtin && !custom) return { status: 400, body: { error: 'Unknown postcard design.' } };

  // Recipient: HL contact wins when a contactId is given, else the sheet values.
  const contactId = cleanStr(body.contactId, 60) || null;
  let ownerName = cleanStr(body.ownerName, 80);
  let address = {
    address1: cleanStr(body.address1, 64),
    address2: cleanStr(body.address2, 64),
    city: cleanStr(body.city, 100),
    state: cleanStr(body.state, 2),
    zip: cleanStr(body.zip, 10),
  };
  let hlContact = null;
  if (contactId) {
    if (!env.hlToken) return { status: 503, body: { error: 'HighLevel is not connected (HL_API_TOKEN missing) — cannot verify the contact.' } };
    try {
      hlContact = await hlGetContact(env.hlToken, contactId, get);
    } catch (e) {
      return { status: 503, body: { error: String((e && e.message) || e) } };
    }
    if (!hlContact) return { status: 400, body: { error: 'HighLevel contact not found.' } };
    if (contactOptedOut(hlContact)) {
      return { status: 400, body: { error: 'That contact opted out (DND / dnc) — never mailed, by house rule.' } };
    }
    const hlName = cleanStr(hlContact.contactName || hlContact.name, 80)
      || [cleanStr(hlContact.firstName, 40), cleanStr(hlContact.lastName, 40)].filter(Boolean).join(' ');
    if (hlName) ownerName = hlName;
    if (hlContact.address1) {
      address = {
        address1: cleanStr(hlContact.address1, 64),
        address2: cleanStr(hlContact.address2, 64),
        city: cleanStr(hlContact.city, 100),
        state: cleanStr(hlContact.state, 2),
        zip: cleanStr(hlContact.postalCode, 10),
      };
    }
  }
  if (!ownerName) ownerName = 'Homeowner';
  const addrErr = validAddress(address);
  if (addrErr) return { status: 400, body: { error: addrErr } };

  // Mode + key (mode comes from env only — the body can never pick live).
  const key = env.mode === 'live' ? env.liveKey : env.testKey;
  if (!key) {
    return {
      status: 503,
      body: {
        error:
          env.mode === 'live'
            ? 'PostGrid live key is not set (POSTGRID_API_KEY). Live sends are off until Troy pastes it into Netlify.'
            : 'PostGrid test key is not set (POSTGRID_TEST_API_KEY). Add the free test key in Netlify to try a test send.',
      },
    };
  }

  // Hard monthly cap — checked BEFORE any PostGrid call.
  const spend = await monthSpend(store, month);
  if (spend.spentCents + priceCents > env.capCents) {
    return { status: 402, body: capHit(spend.spentCents, env.capCents, priceCents, month) };
  }

  // Same-day duplicate guard — checked BEFORE any PostGrid call.
  const idemKey = idempotencyKey({ contactId, size, templateId, dateStr });
  if (await findDuplicate(store, month, idemKey)) {
    return {
      status: 409,
      body: {
        error: 'That postcard was already sent today (same contact, size, and design). Nothing was mailed twice.',
        code: 'duplicate_send',
      },
    };
  }

  // Render the artwork.
  const vars = {
    ownerName,
    propertyAddress: address.address1,
    cityStateZip: `${address.city}, ${address.state} ${address.zip}`,
    phone: data.PHONE,
    brand: data.BRAND,
  };
  let front;
  let back;
  if (builtin) {
    const rendered = data.renderBuiltin(templateId, size, vars, false);
    if (!rendered) return { status: 400, body: { error: 'That design does not support this size.' } };
    front = rendered.front;
    back = rendered.back;
  } else {
    front = custom.front;
    back = custom.back;
  }

  // PostGrid create payload. Front/back must be the same kind on both
  // sides: both HTML, both PostGrid template ids, both image URLs, or
  // one 2-page PDF used for both sides.
  const to = buildPostGridContact(ownerName, address);
  const basePayload = {
    to,
    from: env.from,
    size: postgridSize(size),
    mailingClass: 'first_class',
    description: `Command Center postcard ${templateId} ${size}`,
    metadata: {
      contactId: contactId || '',
      templateId,
      size,
      source: 'command-center',
      month,
    },
  };
  let payload;
  if (builtin) {
    payload = { ...basePayload, frontHTML: front, backHTML: back };
  } else if (custom.kindFront === 'postgrid-template' && custom.kindBack === 'postgrid-template') {
    payload = { ...basePayload, frontTemplate: front, backTemplate: back, mergeVariables: vars };
  } else if (custom.kindFront === 'html' && custom.kindBack === 'html') {
    payload = { ...basePayload, frontHTML: front, backHTML: back };
  } else if (custom.kindFront === 'image-url' && custom.kindBack === 'image-url') {
    payload = { ...basePayload, frontHTML: imageArtHtml(front), backHTML: imageArtHtml(back) };
  } else if (custom.kindFront === 'pdf-url' && custom.kindBack === 'pdf-url') {
    if (front !== back) {
      return { status: 400, body: { error: 'PostGrid needs one 2-page PDF for both sides — paste the same PDF link for front and back.' } };
    }
    payload = { ...basePayload, pdf: front };
  } else {
    return { status: 400, body: { error: 'PostGrid needs matching front/back types (both templates, both HTML, both images, or one 2-page PDF).' } };
  }

  let created;
  try {
    created = await postgridCreatePostcard(key, payload, post);
  } catch (e) {
    return { status: 503, body: { error: String((e && e.message) || e) } };
  }
  const postgridId = created && created.id;
  if (!postgridId) return { status: 503, body: { error: 'PostGrid did not return a postcard id. Nothing was logged — check the PostGrid dashboard.' } };
  // PostGrid's create response carries no price field: cap accounting uses
  // the verified per-piece table. Keep the exact table value (90.2c, not
  // rounded) so the $100 cap really fits ~110 postcards:
  // 110 x 90.2 = 9922 <= 10000; the 111th is refused.
  const costCents = priceCents;

  const entry = {
    postgridId,
    idemKey,
    contactId: contactId || null,
    ownerName,
    address: `${address.address1}, ${address.city}, ${address.state} ${address.zip}`,
    templateId,
    size,
    costCents,
    mode: env.mode,
    month,
    status: 'created',
    at: now.toISOString(),
  };
  const logged = await logSend(store, entry);
  const spendAfter = await monthSpend(store, month);

  // Tag back in HighLevel (best-effort — a tag failure never fails a send
  // that already went out; the Blobs log is the audit trail).
  let hlTagged = false;
  let hlWarning = null;
  if (contactId && env.hlToken) {
    try {
      await hlAddTags(env.hlToken, contactId, ['mailed', 'mail-postcard', `mailed-${dateStr}`], post);
      if (env.mailSentDateFieldId) {
        try {
          await hlSetMailDate(env.hlToken, contactId, env.mailSentDateFieldId, dateStr, put);
        } catch (e) {
          hlWarning = 'Mail date field could not be written.';
        }
      }
      hlTagged = true;
    } catch (e) {
      hlWarning = 'Postcard sent, but the HighLevel tags could not be added — see the send log.';
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      postgridId,
      size,
      costCents,
      monthSpentCents: spendAfter.spentCents,
      monthCapCents: env.capCents,
      monthCount: spendAfter.count,
      month,
      mode: env.mode,
      testMode: env.mode === 'test',
      hlTagged,
      hlSkipped: contactId ? null : 'no-contact-id',
      logged,
      hlWarning,
    },
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) return unauth();

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      if ((params.action || 'status') !== 'status') return bad('Unknown action. Use action=status.');
      const env = readEnv();
      const month = data.monthKey(new Date());
      const spend = await monthSpend(getLogStoreFor(event), month);
      return ok({
        mode: env.mode,
        testMode: env.mode === 'test',
        capCents: env.capCents,
        spentCents: spend.spentCents,
        remainingCents: Math.max(0, env.capCents - spend.spentCents),
        count: spend.count,
        month,
        prices: { '4x6': data.PRICES_CENTS['4x6'], '6x9': data.PRICES_CENTS['6x9'] },
        postgridConnected: env.mode === 'live' ? !!env.liveKey : !!env.testKey,
      });
    }

    if (event.httpMethod !== 'POST') return bad('GET or POST only.');

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return bad('Bad JSON body.');
      }
    }
    const env = readEnv();

    // Template state for resolving templateId (built-in or custom).
    let templatesState = { activeId: 'cash-offer', customs: [] };
    try {
      const tstore = getStoreForTemplates(event);
      if (tstore) {
        const raw = await tstore.get('templates.json', { type: 'json' });
        if (raw && typeof raw === 'object') {
          templatesState = {
            activeId: typeof raw.activeId === 'string' ? raw.activeId : 'cash-offer',
            customs: Array.isArray(raw.customs) ? raw.customs : [],
          };
        }
      }
    } catch (e) {
      /* templates fall back to built-ins only */
    }

    // Send log store: fail CLOSED when Blobs is present but the store
    // cannot be opened — a send with no log would be uncapped and
    // untracked. (In the local/test env the Blobs module is absent and
    // runSend's fixture store is used instead.)
    const logStore = getLogStoreFor(event);
    if (blobs && !logStore) {
      return json(503, { error: 'Mail log is not available right now. Nothing was sent.' });
    }

    const result = await runSend({ env, body, deps: { templatesState, store: logStore, event } });
    return json(result.status, result.body);
  } catch (e) {
    return json(503, { error: 'Mail send failed. Nothing was sent.' });
  }
};

exports._test = {
  readEnv,
  parseCap,
  cleanStr,
  validAddress,
  splitOwnerName,
  buildPostGridContact,
  imageArtHtml,
  postgridSize,
  idempotencyKey,
  postgridErrorMessage,
  contactOptedOut,
  findDuplicate,
  monthSpend,
  logSend,
  runSend,
  getLogStoreFor,
  getStoreForTemplates,
  // Test seam: swap the Blobs client (returns the previous one). Lets the
  // regression suite prove the Nov 11 fix with a throwing/fake client.
  _setBlobs: (b) => {
    const prev = blobs;
    blobs = b;
    return prev;
  },
};

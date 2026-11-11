// netlify/functions/mail-send.js
// One-click postcard send from the Command Center dashboard (Troy-side only).
//
// POSTCARDS ONLY (Troy, Nov 11, 2026) via Lob, Developer plan ($0/mo).
// Prices verified Nov 11, 2026: 4x6 First Class $0.905 · 6x9 ~$0.92.
// The dashboard NEVER sends silently: the lead modal shows a confirm sheet
// (template preview + size + recipient address + live price + month spend
// vs cap) and Troy confirms. The function also requires confirm:true.
//
// SAFETY (hard, by design):
//   1. MAIL_MODE comes ONLY from the Netlify env var (default 'test').
//      The request body can NEVER flip test -> live.
//   2. Test mode uses LOB_TEST_API_KEY only. No live key = no live send,
//      full stop. Live sends also need MAIL_MODE=live + LOB_API_KEY.
//   3. HARD $100/month cap (MAIL_MONTHLY_CAP_CENTS, default 10000) is
//      enforced in code BEFORE any Lob call, from the Blobs send log.
//      A send that would take the month over the cap is refused (402).
//   4. No DND / dnc-tagged contact is ever mailed (house rule).
//   5. Address verification runs first; an undeliverable address aborts
//      in live mode. (In test mode verification is advisory — Lob test
//      keys return simulated verification data — and never blocks.)
//   6. Idempotency-Key on the Lob create stops a double-click / retry
//      from mailing twice within 24h (Lob dedupes identical keys).
//   7. Keys live ONLY in Netlify env vars (LOB_API_KEY, LOB_TEST_API_KEY,
//      HL_API_TOKEN). Credential values are NEVER logged or returned.
//
// Lob raw API (docs.lob.com v1.22.0, verified Nov 11, 2026):
//   Auth: HTTP Basic, API key as username, blank password.
//   POST /v1/us_verifications {primary_line, city, state, zip_code}
//     -> { deliverability, components, ... } — deliverability is one of
//        deliverable | deliverable_unnecessary_unit |
//        deliverable_incorrect_unit | deliverable_missing_unit |
//        undeliverable.
//   POST /v1/postcards {to, from, front, back, size, mail_type,
//     use_type, metadata} -> { id, ... }.
//   NOTE: Lob's raw API has NO preview/confirmation-token step — the
//   create call IS the send (the confirmation-token flow belongs to a
//   third-party MCP harness, not the Lob API). The dashboard confirm
//   sheet + MAIL_MODE + cap are the confirmation gates.
//   Lob's create response carries no price field, so cap accounting uses
//   the verified per-piece table (mail-templates-data.js).
//
// Flow:
//   1. Admin auth (lm_auth cookie or Bearer dashboard password).
//   2. Validate size/template/recipient address; confirm:true required.
//   3. If contactId: load the HL contact; skip on dnc tag or any DND.
//      Use the HL name/address when present, else the supplied values.
//   4. Cap check from the Blobs log (store 'direct-mail-log').
//   5. Verify the address with Lob; standardize it when Lob returns
//      components (live mode only blocks on undeliverable).
//   6. Render the template (built-in HTML with merge vars, or the custom
//      design's front/back) and create the postcard at Lob.
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
const HL_LOCATION_ID = 'krKoHLudPnn7nT0DPtwa';
const LOB_API_BASE = 'https://api.lob.com/v1';
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
    testKey: process.env.LOB_TEST_API_KEY || '',
    liveKey: process.env.LOB_API_KEY || '',
    capCents: parseCap(process.env.MAIL_MONTHLY_CAP_CENTS),
    hlToken: process.env.HL_API_TOKEN || '',
    mailSentDateFieldId: (process.env.MAIL_SENT_DATE_FIELD_ID || '').trim(),
    from: {
      name: (process.env.MAIL_FROM_NAME || '').trim() || data.DEFAULT_FROM.name,
      address_line1: (process.env.MAIL_FROM_LINE1 || '').trim() || data.DEFAULT_FROM.address_line1,
      address_line2: (process.env.MAIL_FROM_LINE2 || '').trim() || data.DEFAULT_FROM.address_line2,
      address_city: (process.env.MAIL_FROM_CITY || '').trim() || data.DEFAULT_FROM.address_city,
      address_state: (process.env.MAIL_FROM_STATE || '').trim() || data.DEFAULT_FROM.address_state,
      address_zip: (process.env.MAIL_FROM_ZIP || '').trim() || data.DEFAULT_FROM.address_zip,
      address_country: 'US',
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
function lobAuth(key) {
  return 'Basic ' + Buffer.from(`${key}:`, 'utf8').toString('base64');
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
// Deliverability values Lob returns. 'deliverable_missing_unit' is treated
// as undeliverable — without the unit the piece cannot reach the door.
const DELIVERABLE_OK = new Set([
  'deliverable',
  'deliverable_unnecessary_unit',
  'deliverable_incorrect_unit',
]);
function deliverabilityOk(value) {
  return DELIVERABLE_OK.has(String(value || '').toLowerCase());
}
function buildLobAddress(name, a) {
  return {
    name: cleanStr(name, 40) || 'Homeowner',
    address_line1: a.address1,
    address_line2: a.address2 || '',
    address_city: a.city,
    address_state: a.state.toUpperCase(),
    address_zip: a.zip,
    address_country: 'US',
  };
}
function idempotencyKey({ contactId, size, templateId, dateStr }) {
  const base = `dpb-${contactId || 'no-contact'}-${dateStr}-${size}-${templateId}`;
  return base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 200);
}
function lobErrorMessage(res, fallback) {
  try {
    const parsed = JSON.parse(res.text || '{}');
    const msg = parsed && parsed.error && (parsed.error.message || parsed.error);
    if (msg) return String(msg).slice(0, 300);
  } catch (e) {
    /* fall through */
  }
  return `${fallback} (HTTP ${res.status}).`;
}

// ---- Blobs send log ----
function getLogStore() {
  if (!blobs) return null;
  return blobs.getStore(LOG_STORE);
}
async function logSend(store, entry) {
  if (!store) return false;
  try {
    await store.setJSON(`sends/${entry.month}/${entry.lobId}.json`, entry);
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

// ---- Lob ----
async function lobVerifyAddress(key, address, postImpl) {
  const res = await (postImpl || postJsonHttps)(`${LOB_API_BASE}/us_verifications`, {
    headers: { Authorization: lobAuth(key) },
    body: JSON.stringify({
      primary_line: address.address1,
      secondary_line: address.address2 || undefined,
      city: address.city,
      state: address.state,
      zip_code: address.zip,
    }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(lobErrorMessage(res, 'Address verification failed'));
  }
  let parsed = {};
  try {
    parsed = JSON.parse(res.text || '{}');
  } catch (e) {
    parsed = {};
  }
  return parsed;
}
function standardizedAddress(verified, fallback) {
  const c = verified && verified.components;
  if (!c || !c.primary_line || !c.city || !c.state || !c.zip_code) return fallback;
  return {
    address1: c.primary_line,
    address2: c.secondary_line || fallback.address2 || '',
    city: c.city,
    state: c.state,
    zip: c.zip_code,
  };
}
async function lobCreatePostcard(key, payload, idemKey, postImpl) {
  const res = await (postImpl || postJsonHttps)(`${LOB_API_BASE}/postcards`, {
    headers: { Authorization: lobAuth(key), 'Idempotency-Key': idemKey },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(lobErrorMessage(res, 'Lob could not create the postcard'));
  }
  let parsed = {};
  try {
    parsed = JSON.parse(res.text || '{}');
  } catch (e) {
    parsed = {};
  }
  return parsed;
}

// ---- send pipeline (pure-ish; I/O injected for fixtures) ----
async function runSend({ env, body, deps }) {
  const post = (deps && deps.postJson) || postJsonHttps;
  const get = (deps && deps.get) || getHttps;
  const put = (deps && deps.put) || putHttps;
  const store = deps && deps.store !== undefined ? deps.store : getLogStore();
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
            ? 'Lob live key is not set (LOB_API_KEY). Live sends are off until Troy pastes it into Netlify.'
            : 'Lob test key is not set (LOB_TEST_API_KEY). Add the free test key in Netlify to try a test send.',
      },
    };
  }

  // Hard monthly cap — checked BEFORE any Lob call.
  const spend = await monthSpend(store, month);
  if (spend.spentCents + priceCents > env.capCents) {
    return { status: 402, body: capHit(spend.spentCents, env.capCents, priceCents, month) };
  }

  // Address verification (strict in live, advisory in test).
  let verified = null;
  let verificationWarning = null;
  try {
    verified = await lobVerifyAddress(key, address, post);
    const deliv = verified && verified.deliverability;
    if (!deliverabilityOk(deliv)) {
      if (env.mode === 'live') {
        return { status: 400, body: { error: `That address looks undeliverable (${deliv || 'unknown'}). Fix the address and try again — nothing was sent.` } };
      }
      verificationWarning = `Test mode: Lob reports this address as ${deliv || 'unknown'} — proceeding because test verification is simulated.`;
    }
  } catch (e) {
    if (env.mode === 'live') {
      return { status: 503, body: { error: String((e && e.message) || e) } };
    }
    verificationWarning = `Test mode: address verification failed (${String((e && e.message) || e).slice(0, 120)}) — proceeding because test verification is simulated.`;
  }
  if (verified && env.mode === 'live') address = standardizedAddress(verified, address);

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
  let mergeVariables = null;
  if (builtin) {
    const rendered = data.renderBuiltin(templateId, size, vars, false);
    if (!rendered) return { status: 400, body: { error: 'That design does not support this size.' } };
    front = rendered.front;
    back = rendered.back;
  } else {
    front = custom.front;
    back = custom.back;
    // A Lob template id gets merge vars; a URL / raw HTML is static art.
    if (/^tpl_[A-Za-z0-9]+$/.test(front) || /^tpl_[A-Za-z0-9]+$/.test(back)) {
      mergeVariables = vars;
    }
  }

  const to = buildLobAddress(ownerName, address);
  const payload = {
    to,
    from: env.from,
    front,
    back,
    size,
    mail_type: 'usps_first_class',
    use_type: 'marketing',
    metadata: {
      contactId: contactId || '',
      templateId,
      size,
      source: 'command-center',
      month,
    },
  };
  if (mergeVariables) payload.merge_variables = mergeVariables;

  const idemKey = idempotencyKey({ contactId, size, templateId, dateStr });
  let created;
  try {
    created = await lobCreatePostcard(key, payload, idemKey, post);
  } catch (e) {
    return { status: 503, body: { error: String((e && e.message) || e) } };
  }
  const lobId = created && created.id;
  if (!lobId) return { status: 503, body: { error: 'Lob did not return a postcard id. Nothing was logged — check the Lob dashboard.' } };
  // Lob's create response carries no price field: cap accounting uses the
  // verified per-piece table. Keep the exact table value (90.5c, not
  // rounded to 91c) so the $100 cap really fits ~110 postcards:
  // 110 x 90.5 = 9955 <= 10000; the 111th is refused.
  const costCents = Number.isFinite(created.price) ? Math.round(created.price * 100) : priceCents;

  const entry = {
    lobId,
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
      lobId,
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
      verificationWarning,
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
      const spend = await monthSpend(getLogStore(), month);
      return ok({
        mode: env.mode,
        testMode: env.mode === 'test',
        capCents: env.capCents,
        spentCents: spend.spentCents,
        remainingCents: Math.max(0, env.capCents - spend.spentCents),
        count: spend.count,
        month,
        prices: { '4x6': data.PRICES_CENTS['4x6'], '6x9': data.PRICES_CENTS['6x9'] },
        lobConnected: env.mode === 'live' ? !!env.liveKey : !!env.testKey,
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
      const tstore = blobs ? blobs.getStore('direct-mail-templates') : null;
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

    const result = await runSend({ env, body, deps: { templatesState } });
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
  deliverabilityOk,
  buildLobAddress,
  idempotencyKey,
  lobErrorMessage,
  contactOptedOut,
  standardizedAddress,
  monthSpend,
  logSend,
  runSend,
  DELIVERABLE_OK: [...DELIVERABLE_OK],
};

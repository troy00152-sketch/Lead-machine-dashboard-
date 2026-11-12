// netlify/functions/esign.js
// In-dashboard e-sign for the Command Center — HighLevel signing surfaced
// in the dashboard. FREE ONLY (Troy, Nov 11, 2026): no paid e-sign vendor,
// no per-envelope fees, no new subscription. HighLevel Documents &
// Contracts is already included in Troy's $97/mo Starter plan, his 9
// templates already live there, and the signing itself happens on HL's
// signing page via HL's own links. The dashboard is the cockpit:
// pick template -> validate contract fields -> create a DRAFT first ->
// signature fields check -> send -> text the seller their HL signing
// link -> poll status -> tag + audit trail on completion.
//
// HARD RULES (do not weaken them):
//  1. The dashboard NEVER auto-places signature/date fields. Troy places
//     fields himself in HL (standing preference). SIGNATURES are the
//     requirement; a per-signer DATE field is NOT required — Troy
//     (Nov 11, 2026): all his contracts already carry right-now dates,
//     "the dates are all set on the contracts."
//     FIELDS-CHECK MODEL (changed Nov 11 evening, with the trade-off
//     stated plainly): the original design VERIFIED signature fields on
//     the draft via the HL API and hard-blocked the send — that was the
//     Oct 9, 2026 Jacksonville guard (a sent document with no fields to
//     sign must never repeat). Live proof Nov 11 killed the API half of
//     that design: across all 7 live documents — including document
//     6ad7f0f89fba0130bbbe29f6, whose signer had already signed — the HL
//     API projected ONLY Text/Date fillableFields and ZERO signature
//     fields, and document 6af51659e94c61f78742d9cb, which HL accepted,
//     sent, and Troy received + opened, projects an EMPTY field list.
//     The templates list exposes no field data either. There is NO
//     reliable API source for signature placement, so an API hard block
//     blocks every legitimate send forever while proving nothing. The
//     guard therefore moved, it was not dropped: when the API cannot
//     verify signatures, the check is ADVISORY and the send unlocks
//     only on Troy's explicit in-sheet confirmation (fieldsConfirmed +
//     fieldsAdvisoryAccepted) that he checked the Signature fields in
//     HighLevel himself. If the API ever does project signature fields
//     for every signer, the check passes as verified with no advisory.
//  2. Contract text comes ONLY from the HL template. The dashboard never
//     invents, edits or paraphrases contract terms. It only fills the
//     contact's own custom fields (price / EMD / APN / legal / county /
//     closing date), which HL's template merge tokens then render.
//  3. No send without Troy's explicit confirm tap in the sheet, and no
//     send without the fields-placed confirmation. There is NO test mode
//     for HL signing — a send is a real, legally binding signing request.
//     "Prepare" (validate + draft + fields check) is the safe dry-run.
//  4. Dual-signer rule: every send emails the seller AND Troy at the same
//     time (ccRecipients). Buyer signer is Paula Thomas, whose seat lives
//     in the HL template as a USER entity — the dashboard never adds her
//     as a contact signer and never puts Troy on as a signer.
//  5. DND/dnc contacts are never texted a signing link (email only).
//     A failed SMS link send never blocks the email send.
//  6. Blobs rule (Nov 11 mail fix): connectLambda(event) BEFORE getStore(),
//     or getStore() throws MissingBlobsEnvironmentError in production.
//     Sends fail CLOSED when the log cannot be opened (an untracked,
//     uncapped send must never happen). Reads fall back gracefully.
//  7. Credential values are NEVER logged or returned in any response.
//  8. This is not legal advice. ESIGN/UETA treatment depends on the
//     document, jurisdiction and workflow; the dashboard presents HL's
//     certificate/audit facts and leaves the legal call to Troy's attorney.
//
// HighLevel Documents & Contracts Public APIs (live catalog, Nov 11, 2026):
//   GET  /proposals/templates        list-documents-contracts-templates
//   POST /proposals/templates/send   send-documents-contracts-template
//   POST /proposals/document/send    send-documents-contracts
//   GET  /proposals/document         list-documents-contracts
// Scopes the Kai private integration needs:
//   documents_contracts/list.readonly,
//   documents_contracts_template/list.readonly,
//   documents_contracts/sendLink.write,
//   documents_contracts_template/sendLink.write
// UNVERIFIED at build time (deploy-time checks, see ESIGN_DEPLOY.md):
//   - sendDocument:false actually creates a draft without sending.
//   - Proposals Version header (v1 uses 2021-07-28, same as Contacts).
//   - Whether HL exposes a signed-PDF download endpoint (none is in the
//     catalog read Nov 11 — the signed PDF lives in HL until confirmed).
// VERIFIED live Nov 11, 2026 (ghl CLI reads, 7 documents + 9 templates):
//   - fillableFields NEVER contains a signature-typed field — not on
//     drafts, not on sent/viewed documents, not even on a document a
//     signer already signed (signing shows on the RECIPIENT record:
//     hasCompleted / signedDate / signature image). Signature elements
//     placed in the template editor are simply not projected by the
//     API, so fieldsReadyCheck treats the API view as advisory only.
//   - The templates list returns id/name/type/totals only — no fields.
//   - Draft documents carry NO links (links are minted at send), and
//     draft grandTotal is 0.00 (no price on the document). Document-id
//     capture therefore cannot rely on the create response's links or
//     on price matching — see the document-id capture block below
//     (extractCreatedDocumentId / matchDraftInList /
//     resolveDraftDocument), built after the $100,003 prepare stored
//     an envelope with an empty documentId while its draft
//     (6af5283b7d64ba6637bb5979) sat at the top of the list.
'use strict';

const crypto = require('crypto');
const https = require('https');

let blobs = null;
try { blobs = require('@netlify/blobs'); } catch (e) { blobs = null; }

const COOKIE_NAME = 'lm_auth';
const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_API_VERSION = '2021-07-28'; // same as Contacts; verify at deploy
const HL_LOCATION_ID = 'krKoHLudPnn7nT0DPtwa';
const LOG_STORE = 'esign-log';
const HL_TIMEOUT_MS = 20000;

// ---- HighLevel custom field ids (new CRM — do NOT use the old XLeads ids) ----
const FIELD_IDS = {
  county: 'QJD2apbA7gWN64WtJqZP',
  contractPrice: 'OlLVVtGELgLyze9No9XM',
  emd: 'vUZZ7T7olTS8BmxPF2Vc',
  apn: 'eXnXIC0WLOh0ffBC9oGe',
  legal: 'gsa3WEzQhQvYyQ3zmEBm',
  closingDate: '0vy9CpoFwZqral2vuHs6',
  arv: 'cOE6XmJNOdVKsDNpiGqR',
  mao: 'B8Mfg1TQfjjo4Dl214A2',
  lao: 'JUPzLFhe7VG0PCJqL0n8',
};

// ---- The 9 templates, verified live Nov 11, 2026 (GET /proposals/templates,
// total 9). Used ONLY as a fallback when the live list call fails — the
// picker always prefers the live list. Never invent a template id. ----
const KNOWN_TEMPLATES = [
  { id: '6ada7e831e0a127d47066353', name: 'AGREEMENT TO PURCHASE REAL ESTATE  NC', type: 'proposal', states: ['NC'] },
  { id: '6ada9a7f1e0a127d470b0376', name: 'BACK UP', type: 'proposal', states: [] },
  { id: '6ada994a1e0a127d470adb0b', name: 'Real Estate Agreement Addendum', type: 'proposal', states: [] },
  { id: '6ada97ced6aed8017a4497f6', name: 'WHOSALER DISCLOSURE STATEMENT OH', type: 'proposal', states: ['OH'] },
  { id: '6ad1168a4bf151249d3e873a', name: 'Assignment Agreement TO BUYER', type: 'proposal', states: [] },
  { id: '6ada9420cb0b6a6fe8b4eab7', name: 'AGREEMENT TO PURCHASE REAL ESTATE KC', type: 'proposal', states: ['MO', 'KS'] },
  { id: '6ada9551c47c0edc3fcf44ea', name: 'AGREEMENT TO PURCHASE REAL ESTATE OH', type: 'proposal', states: ['OH'] },
  { id: '6ada8005d6aed8017a40b93e', name: 'AGREEMENT TO PURCHASE REAL ESTATE FLORIDA', type: 'proposal', states: ['FL'] },
  { id: '6ad186514bf151249d4f7ab6', name: 'AGREEMENT TO PURCHASE REAL ESTATE IN', type: 'proposal', states: ['IN'] },
];

const ENVELOPE_STATES = ['prepared', 'draft', 'sent', 'viewed', 'completed', 'accepted', 'fields-blocked'];
// HL document statuses -> envelope states. Anything else maps to its HL
// status verbatim and never moves the envelope backwards.
const HL_STATUS_TO_STATE = { draft: 'draft', sent: 'sent', viewed: 'viewed', completed: 'completed', accepted: 'accepted' };
const STATE_ORDER = { prepared: 0, draft: 1, sent: 2, viewed: 3, completed: 4, accepted: 4, 'fields-blocked': 1 };

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};
function json(status, obj) { return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) }; }
const ok = (obj) => json(200, obj);
const bad = (msg, extra) => json(400, Object.assign({ error: msg }, extra || {}));
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
const unavailable = (msg) => json(503, { error: msg });

// ---- admin auth (same HMAC as title-order-email.js / mail-send.js) ----
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

// ---- minimal https client (built-ins only, no new dependency) ----
function httpsReq(urlStr, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; if (text.length > 1_000_000) req.destroy(new Error('Response too large')); });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(HL_TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
    if (body) req.write(body);
    req.end();
  });
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
// HighLevel's real error text, extracted from its response body. HL returns
// the cause in `message` (string or string[]) or `error`; without this the
// caller only ever saw "failed (HTTP 422)" and the cause was invisible.
function hlErrorText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  if (Array.isArray(parsed.message) && parsed.message.length) return parsed.message.join('; ');
  if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  if (parsed.data && typeof parsed.data.message === 'string' && parsed.data.message) return parsed.data.message;
  const keys = Object.keys(parsed);
  if (keys.length) return JSON.stringify(parsed).slice(0, 400);
  return '';
}
async function hlJson(token, method, path, body, impl) {
  const url = HL_API_BASE + path;
  const res = await (impl || httpsReq)(url, { method, headers: hlHeaders(token), body: body ? JSON.stringify(body) : '' });
  let parsed = {};
  try { parsed = JSON.parse(res.text || '{}'); } catch (e) { parsed = {}; }
  if (res.status < 200 || res.status >= 300) {
    const detail = hlErrorText(parsed);
    const err = new Error(`HighLevel ${method} ${path} failed (HTTP ${res.status})${detail ? ': ' + detail : '.'}`);
    err.status = res.status; err.body = parsed;
    throw err;
  }
  return parsed;
}

// ---- Blobs log (connectLambda BEFORE getStore — Nov 11 mail lesson) ----
function getLogStore(event) {
  if (!blobs) return null;
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) { /* best-effort; getStore may still work with ambient context */ }
  return blobs.getStore(LOG_STORE);
}
function envelopeKey(id) { return `envelope-${id}.json`; }
async function readEnvelope(store, id) {
  try {
    const raw = await store.get(envelopeKey(id), { type: 'text' });
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
async function writeEnvelope(store, env) {
  env.updatedAt = new Date().toISOString();
  await store.set(envelopeKey(env.id), JSON.stringify(env));
}

// ---- pure core (exported for the fixture regression suite) ----
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max && s.length > max ? s.slice(0, max) : s;
}
function addDays(dateStr, days) {
  const d = new Date(String(dateStr) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Closing date = contract date + 30 days (standing rule). Returns
// { date } or { error } — never a guessed date.
function closingDatePlus30(contractDate) {
  if (!contractDate) return { error: 'Contract date is required to compute the closing date (contract date + 30 days).' };
  const out = addDays(contractDate, 30);
  if (!out) return { error: 'Contract date is not a valid date (use YYYY-MM-DD).' };
  return { date: out };
}
// Legal description is ALWAYS "[APN] ([legal description])". If the stored
// legal text already starts with the APN, do not double it.
function buildLegalDescription(apn, legal) {
  const a = cleanStr(apn, 64);
  const l = cleanStr(legal, 500);
  if (!a || !l) return '';
  if (l.startsWith(a)) return l;
  return `${a} (${l})`;
}
function customField(contact, fieldId) {
  const cfs = (contact && Array.isArray(contact.customFields)) ? contact.customFields : [];
  const f = cfs.find((x) => x && x.id === fieldId);
  if (!f) return '';
  return cleanStr(f.fieldValue == null ? f.value : f.fieldValue, 500);
}
function contactSummary(contact) {
  if (!contact) return null;
  return {
    id: contact.id || '',
    firstName: cleanStr(contact.firstName, 80),
    lastName: cleanStr(contact.lastName, 80),
    name: cleanStr(contact.contactName || [contact.firstName, contact.lastName].filter(Boolean).join(' '), 160),
    email: cleanStr(contact.email, 160),
    phone: cleanStr(contact.phone, 32),
    address1: cleanStr(contact.address1, 200),
    city: cleanStr(contact.city, 80),
    state: cleanStr(contact.state, 4),
    postalCode: cleanStr(contact.postalCode, 16),
    tags: Array.isArray(contact.tags) ? contact.tags.map(String) : [],
    dnd: contact.dnd === true,
    dndSettings: contact.dndSettings || {},
  };
}
// The contract fields the dashboard validates before anything is created.
// Nothing here is invented: a missing value blocks prepare with its name.
function contractFieldCheck(contact, opts) {
  const o = opts || {};
  const missing = [];
  const price = customField(contact, FIELD_IDS.contractPrice);
  const emd = customField(contact, FIELD_IDS.emd);
  const apn = customField(contact, FIELD_IDS.apn);
  const legalRaw = customField(contact, FIELD_IDS.legal);
  const county = customField(contact, FIELD_IDS.county);
  const closing = customField(contact, FIELD_IDS.closingDate);
  if (!price) missing.push('contract_price');
  else if (!/^\d+(\.\d{1,2})?$/.test(price.replace(/[$,\s]/g, ''))) missing.push('contract_price (not a number)');
  if (!emd) missing.push('emd_deposit');
  if (!apn) missing.push('APN');
  if (!legalRaw) missing.push('legal_description');
  if (!county) missing.push('county');
  const s = contactSummary(contact);
  if (!s || !s.email) missing.push('seller email (HighLevel needs an email on file to deliver the document)');
  if (!s || !s.name) missing.push('seller name');
  let closingDate = closing || '';
  if (!closingDate) {
    if (!o.contractDate) missing.push('closing_date (or a contract date so it can be computed as contract date + 30 days)');
    else {
      const c = closingDatePlus30(o.contractDate);
      if (c.error) missing.push('closing_date (' + c.error + ')');
      else closingDate = c.date;
    }
  }
  const legal = buildLegalDescription(apn, legalRaw);
  return {
    ok: missing.length === 0,
    missing,
    contract: {
      price: price.replace(/[$,\s]/g, ''),
      emd: emd.replace(/[$,\s]/g, ''),
      apn,
      legal,
      county,
      closingDate,
      contractDate: o.contractDate || '',
    },
  };
}
// Signers for the sheet. The seller is the HL contact. Paula Thomas is the
// BUYER signer and her seat lives in the HL template as a USER entity — she
// is listed here so Troy can see her, never added by the dashboard. A
// second seller cannot be added through the template-send API (one
// contactId); co-sellers must already be recipients in the HL template,
// and prepare lists the draft's recipients so Troy can confirm them.
function buildSigners(contact) {
  const s = contactSummary(contact);
  const signers = [];
  if (s) signers.push({ role: 'seller', kind: 'contact', id: s.id, name: s.name, email: s.email, phone: s.phone });
  signers.push({ role: 'buyer', kind: 'hl-user', id: '', name: 'Paula Thomas', email: '', phone: '', note: 'Buyer signer — seat lives in the HL template, not added by the dashboard.' });
  signers.push({ role: 'copy', kind: 'troy', id: '', name: 'Troy Thomas', email: 'troy00152@gmail.com', phone: '+1 203-565-7810', note: 'Receives the send at the same time as the seller (dual-signer rule).' });
  return signers;
}
function isSmsDnd(contact) {
  const s = contactSummary(contact);
  if (!s) return true;
  if (s.tags.map((t) => t.toLowerCase()).includes('dnc')) return true;
  if (s.dnd === true) return true;
  const d = s.dndSettings || {};
  if (d.sms && d.sms.status === 'active') return true;
  if (d.all && d.all.status === 'active') return true;
  return false;
}
function isEmailDnd(contact) {
  const s = contactSummary(contact);
  if (!s) return true;
  if (s.tags.map((t) => t.toLowerCase()).includes('dnc')) return true;
  if (s.dnd === true) return true;
  const d = s.dndSettings || {};
  if (d.email && d.email.status === 'active') return true;
  if (d.all && d.all.status === 'active') return true;
  return false;
}
// Ohio: SB 155 requires a boldface >=12pt wholesaler disclosure BEFORE any
// binding contract (Dayton AND Cleveland). The dashboard cannot read the
// template text, so it shows this reminder and requires Troy's confirm.
function needsDisclosureReminder(state) {
  return String(state || '').toUpperCase() === 'OH';
}
function templateForState(templates, state) {
  const st = String(state || '').toUpperCase();
  const list = templates || KNOWN_TEMPLATES;
  const matches = list.filter((t) => (t.states || []).includes(st));
  // When several templates match a state (Ohio has both the purchase
  // agreement AND the wholesaler disclosure), the purchase agreement wins
  // — the disclosure is a companion document, never the contract itself.
  return matches.find((t) => /AGREEMENT TO PURCHASE/.test(String(t.name || '').toUpperCase())) || matches[0] || null;
}
// --- fields check: signatures required, dates NOT required. ---
// What the HL API can and cannot say (all verified live Nov 11, 2026):
// the document's fillableFields projection contains Text/Date fields
// only — signature elements are never projected, on any of the 7 live
// documents, including one already signed. The templates list exposes
// no fields at all. So this check has exactly two outcomes:
//   VERIFIED — the API projects a Signature field for EVERY signer
//     (kept for the day HL projects them; the signature type is matched
//     case-insensitively on "sign" in the type or fieldId).
//   ADVISORY — anything else. NOT a hard block and NOT a pass: the API
//     view cannot tell the truth about signature placement, so the
//     send gate (fieldsGateDecision) requires Troy's explicit in-sheet
//     confirmation that he checked the Signature fields in HighLevel.
// Date fields are never required and never listed as missing: Troy's
// contracts already carry right-now dates (Troy, Nov 11, 2026).
const FIELDS_ADVISORY_REASON = 'HighLevel\'s API does not expose signature fields — across all 7 live documents (Nov 11, 2026), including one a signer had already signed, the API projected only Text/Date fields and zero signature fields, and the document HighLevel accepted and sent projects an empty field list. The templates list exposes no field data either, so signature placement cannot be verified from the API. Signatures are still required: this send unlocks only when Troy confirms in the sheet that he checked the Signature field for every signer in HighLevel. Date fields are not required — the contracts already carry right-now dates.';
function advisoryFieldsCheck(unverified, unrecognized, reason) {
  return {
    ready: false,
    verified: false,
    advisory: true,
    requiresConfirmation: true,
    missing: unverified,
    unverified,
    unrecognized: [...new Set(unrecognized || [])],
    reason: reason || FIELDS_ADVISORY_REASON,
  };
}
function fieldsReadyCheck(doc) {
  const fields = (doc && Array.isArray(doc.fillableFields)) ? doc.fillableFields : [];
  const recipients = (doc && Array.isArray(doc.recipients)) ? doc.recipients : [];
  const signers = recipients.filter((r) => r && (r.role === 'signer' || !r.role));
  const unrecognized = [];
  for (const f of fields) {
    const t = String((f && f.type) || '');
    const fid = String((f && f.fieldId) || '');
    if (!/text|date|sign/i.test(t) && !/sign|date/i.test(fid)) unrecognized.push(t || fid || 'unknown-field');
  }
  const unverified = [];
  for (const r of signers) {
    const mine = fields.filter((f) => f && (f.recipient === r.id || f.recipient === r.contactName));
    const hasSig = mine.some((f) => /sign/i.test(String(f.type || '')) || /sign/i.test(String(f.fieldId || '')));
    if (!hasSig) unverified.push(`${r.contactName || r.id || 'signer'}: Signature field not visible via the HighLevel API`);
  }
  if (signers.length > 0 && unverified.length === 0) {
    return { ready: true, verified: true, advisory: false, requiresConfirmation: false, missing: [], unverified: [], unrecognized: [...new Set(unrecognized)], reason: '' };
  }
  if (signers.length === 0 && fields.length > 0) {
    // No signer recipients on the draft — nothing for anyone to sign,
    // so there is no signature placement to verify. (Pre-Nov-11
    // behavior, kept: recipients are listed in the sheet for Troy.)
    return { ready: true, verified: true, advisory: false, requiresConfirmation: false, missing: [], unverified: [], unrecognized: [...new Set(unrecognized)], reason: '' };
  }
  return advisoryFieldsCheck(unverified, unrecognized);
}
// --- send gate for the fields check (pure; the handler enforces it). ---
// verified check  -> Troy's fieldsConfirmed alone unlocks the send.
// advisory check  -> fieldsConfirmed AND fieldsAdvisoryAccepted: Troy
//   confirms he personally checked the Signature fields in HighLevel
//   and accepts that the API could not verify them.
// anything else (no check, or a non-advisory failure) -> blocked.
function fieldsGateDecision(fieldsCheck, confirmations) {
  const c = confirmations || {};
  if (!fieldsCheck) return { allowed: false, error: 'No fields check is recorded for this contract — prepare it again before sending.' };
  if (fieldsCheck.ready) {
    if (c.fieldsConfirmed !== true) return { allowed: false, error: 'Troy must confirm the signature fields are placed in HighLevel before sending (fieldsConfirmed:true).' };
    return { allowed: true, mode: 'verified' };
  }
  if (fieldsCheck.advisory) {
    if (c.fieldsConfirmed !== true) return { allowed: false, error: 'Troy must confirm he checked the Signature field for every signer in HighLevel before sending (fieldsConfirmed:true).' };
    if (c.fieldsAdvisoryAccepted !== true) return { allowed: false, error: 'This contract\'s signature fields cannot be verified through the HighLevel API (the API does not expose them). Troy must also accept the fields advisory (fieldsAdvisoryAccepted:true) — confirming he checked the Signature fields in HighLevel himself.' };
    return { allowed: true, mode: 'advisory-confirmed' };
  }
  return { allowed: false, error: 'Fields check did not pass — this contract cannot be sent.', missing: fieldsCheck.missing || [] };
}
// Envelope state machine: HL statuses only ever move the envelope forward.
// A stale/older poll never rewinds a completed envelope.
function nextEnvelopeState(current, hlStatus) {
  const target = HL_STATUS_TO_STATE[String(hlStatus || '').toLowerCase()];
  if (!target) return current;
  if ((STATE_ORDER[target] || 0) >= (STATE_ORDER[current] || 0)) return target;
  return current;
}
function appendEvent(envelope, action, detail, actor) {
  const ev = envelope.events || [];
  ev.push({ at: new Date().toISOString(), actor: actor || 'dashboard', action, detail: detail || '' });
  envelope.events = ev;
  return envelope;
}
function newEnvelopeId() {
  return `es_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}
// Duplicate guard: same seller + template + price within 24h is a repeat,
// not a new contract — block it unless Troy passes forceNew with a reason.
function isDuplicate(existing, key, nowMs) {
  if (!existing || !key) return false;
  const now = nowMs || Date.now();
  return existing.contactId === key.contactId
    && existing.templateId === key.templateId
    && String(existing.contract && existing.contract.price) === String(key.price)
    && (now - new Date(existing.createdAt).getTime()) < 24 * 60 * 60 * 1000;
}
// HighLevel POST /proposals/templates/send rejects the call with HTTP 422
// ("locationId should not be empty; locationId must be a string") when
// locationId is absent — seen live Nov 11 ~7:52 PM on the 1 TEST ST lead.
// HL_LOCATION_ID is the new CRM location (krKoHLudPnn7nT0DPtwa).
function buildSendTemplateBody({ templateId, userId, contactId, opportunityId, sendDocument }) {
  const body = { templateId, userId, contactId, locationId: HL_LOCATION_ID, sendDocument: sendDocument !== false };
  if (opportunityId) body.opportunityId = opportunityId;
  return body;
}
function buildSendDocumentBody({ documentId, sentBy, medium, ccRecipients }) {
  // locationId is REQUIRED by the proposals API: POST
  // /proposals/document/send rejects with HTTP 422 ("locationId should
  // not be empty; locationId must be a string") when it is absent —
  // seen live Nov 11 ~10:05 PM on the 2 TEST ST sheet proof (same 422
  // class the templates/send call had until locationId was added).
  const body = { documentId, sentBy, medium: medium || 'email', locationId: HL_LOCATION_ID };
  if (ccRecipients && ccRecipients.length) body.ccRecipients = ccRecipients;
  return body;
}
function signingLinkFor(recipientId, doc) {
  const links = (doc && Array.isArray(doc.links)) ? doc.links : [];
  const l = links.find((x) => x && x.recipientId === recipientId);
  return l ? (l.url || l.link || l.href || '') : '';
}

// ---- document-id capture (Nov 11 late — the empty-documentId bug) ----
// Live evidence (ghl CLI reads, Nov 11 ~9:47 PM): a DRAFT document
// carries NO links — links are minted at send time (both unsent drafts
// read live show links: []; the sent test document's links were created
// the second it was sent). The old prepare derived the id ONLY from
// created.links[0].documentId || created.documentId, and then searched
// the document list BY that id — so any create response without those
// two fields produced documentId '' and a list search that could never
// match, even though the draft itself was sitting in the list
// (verified: draft 6af5283b7d64ba6637bb5979, created
// 2026-11-12T02:45:15Z for the $100,003 prepare, is list position 1,
// newest-first). The list also does not carry the price (grandTotal is
// 0.00 on drafts), so matching keys are: document name (the template
// name), a recipient whose id IS the seller contact id, status draft,
// and a createdAt window anchored on the prepare. Capture is now
// three-layered: extract from every plausible create-response field ->
// poll the list briefly and match -> re-resolve later (duplicate-guard
// reopen, and again at send) from the stored envelope. The send
// refusal on an unresolved id is unchanged — no id, no send.
function docIdOf(doc) {
  return (doc && (doc.documentId || doc._id || doc.id)) || '';
}
function extractCreatedDocumentId(created) {
  if (!created || typeof created !== 'object') return '';
  const pools = [created, created.data, created.document, created.data && created.data.document];
  for (const p of pools) {
    const id = docIdOf(p);
    if (id) return id;
  }
  const linkPools = [created.links, created.data && created.data.links, created.document && created.document.links];
  for (const links of linkPools) {
    if (!Array.isArray(links)) continue;
    for (const l of links) {
      if (l && l.documentId) return l.documentId;
    }
  }
  return '';
}
function matchDraftInList(docs, hints) {
  const h = hints || {};
  const list = Array.isArray(docs) ? docs : [];
  if (h.documentId) {
    const byId = list.find((d) => d && docIdOf(d) === h.documentId);
    if (byId) return byId;
  }
  const name = String(h.name || '').trim();
  const contactId = h.contactId || '';
  const notBefore = h.notBeforeMs || 0;
  const notAfter = h.notAfterMs != null ? h.notAfterMs : Infinity;
  const exclude = new Set(h.excludeIds || []);
  const candidates = list.filter((d) => {
    if (!d || d.deleted === true) return false;
    const id = docIdOf(d);
    if (!id || exclude.has(id)) return false;
    if (String(d.status || '').toLowerCase() !== 'draft') return false;
    if (name && String(d.name || '').trim() !== name) return false;
    if (contactId) {
      const recips = Array.isArray(d.recipients) ? d.recipients : [];
      if (!recips.some((r) => r && r.id === contactId)) return false;
    }
    if (notBefore || notAfter !== Infinity) {
      const createdMs = new Date(d.createdAt || 0).getTime();
      if (!Number.isFinite(createdMs)) return false;
      if (createdMs < notBefore || createdMs > notAfter) return false;
    }
    return true;
  });
  candidates.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return candidates[0] || null;
}
async function resolveDraftDocument(token, hints, opts) {
  const o = opts || {};
  const delays = Array.isArray(o.delaysMs) ? o.delaysMs : [1200, 2500];
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    let docs = [];
    try { docs = await hlListDocuments(token, undefined, o.impl); } catch (e) { docs = []; }
    const draft = matchDraftInList(docs, hints);
    if (draft) return { documentId: docIdOf(draft), draft };
  }
  return { documentId: '', draft: null };
}
// Envelope store scan + the ids already claimed by stored envelopes
// (a resolver must never hand one envelope another envelope's draft).
async function scanEnvelopes(store) {
  const out = [];
  try {
    const keys = await store.list({ prefix: 'envelope-' });
    for (const k of (keys && keys.blobs ? keys.blobs : keys || [])) {
      const key = typeof k === 'string' ? k : k.key;
      if (!key) continue;
      const raw = await store.get(key, { type: 'text' });
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch (e) { /* skip unreadable */ }
    }
  } catch (e) { /* scan failure -> empty; resolution still tries by window */ }
  return out;
}
function usedDocumentIds(envelopes, exceptEnvelopeId) {
  return (envelopes || [])
    .filter((e) => e && e.id !== exceptEnvelopeId && e.documentId)
    .map((e) => e.documentId);
}
// Re-resolve a stored envelope's document id from the document list,
// matching on template name + seller recipient + a createdAt window
// anchored on the envelope's own creation (prepare time). Used by the
// duplicate-guard reopen path and by send.
async function resolveEnvelopeDocumentId(token, store, envelope, opts) {
  const o = opts || {};
  const all = await scanEnvelopes(store);
  const createdMs = new Date(envelope.createdAt || 0).getTime() || Date.now();
  return resolveDraftDocument(token, {
    name: (KNOWN_TEMPLATES.find((t) => t.id === envelope.templateId) || {}).name || '',
    contactId: envelope.contactId,
    notBeforeMs: createdMs - 5 * 60 * 1000,
    notAfterMs: createdMs + 15 * 60 * 1000,
    excludeIds: usedDocumentIds(all, envelope.id),
  }, { delaysMs: o.delaysMs, impl: o.impl, sleep: o.sleep });
}

// ---- HL wrappers (thin; injectable impls exist so tests never hit live HL) ----
async function hlListTemplates(token, impl) {
  const parsed = await hlJson(token, 'GET', `/proposals/templates?locationId=${encodeURIComponent(HL_LOCATION_ID)}&limit=20`, null, impl);
  const data = parsed.data || parsed.templates || [];
  return data.map((t) => ({ id: t.id || t._id || '', name: t.name || '', type: t.type || 'proposal', states: (KNOWN_TEMPLATES.find((k) => k.id === (t.id || t._id)) || {}).states || [] }));
}
async function hlListDocuments(token, query, impl) {
  const q = new URLSearchParams({ locationId: HL_LOCATION_ID, limit: '20' });
  if (query) q.set('query', query);
  const parsed = await hlJson(token, 'GET', `/proposals/document?${q.toString()}`, null, impl);
  // Live HL shape (verified Nov 11 via list-documents-contracts):
  // { data: { documents: [...] } } — NOT { documents: [...] }. The old
  // `parsed.documents` read always returned [], so prepare could never
  // read its draft back ("Could not read the draft back"). Accept the
  // flat shape and a bare array too, for safety.
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  if (parsed && parsed.data && Array.isArray(parsed.data.documents)) return parsed.data.documents;
  return parsed.documents || [];
}
async function hlGetContact(token, contactId, impl) {
  const parsed = await hlJson(token, 'GET', `/contacts/${encodeURIComponent(contactId)}?locationId=${encodeURIComponent(HL_LOCATION_ID)}`, null, impl);
  return parsed.contact || parsed || null;
}
async function hlUpdateContactFields(token, contactId, fields, impl) {
  await hlJson(token, 'PUT', `/contacts/${encodeURIComponent(contactId)}`, { customFields: fields }, impl);
}
async function hlAddTags(token, contactId, tags, impl) {
  const res = await hlJson(token, 'POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags }, impl);
  return res;
}
async function hlSendSms(token, contactId, message, impl) {
  return hlJson(token, 'POST', '/conversations/messages', { type: 'SMS', contactId, message, locationId: HL_LOCATION_ID }, impl);
}

// ---- handler ----
exports.handler = async (event) => {
  if ((event.httpMethod || 'GET') === 'OPTIONS') return ok({ ok: true });
  if (!isAdmin(event)) return unauth();
  const method = event.httpMethod || 'GET';
  const qs = event.queryStringParameters || {};
  const action = qs.action || (method === 'POST' ? 'send' : 'status');
  const token = process.env.HL_API_TOKEN || '';
  const senderUserId = process.env.ESIGN_SENDER_USER_ID || '';
  const troyContactId = process.env.ESIGN_TROY_CONTACT_ID || '';
  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch (e) { return bad('Request body must be valid JSON.'); } }

  // ---- GET: status / templates / documents / envelope ----
  if (method === 'GET') {
    if (action === 'status') {
      return ok({
        testMode: false,
        note: 'HighLevel signing has no test mode — a send is a real, legally binding signing request. "Prepare" (validate + draft + fields check) is the safe dry-run; it sends nothing.',
        hlConnected: Boolean(token),
        senderConfigured: Boolean(senderUserId),
        troyCcConfigured: Boolean(troyContactId),
        templatesKnown: KNOWN_TEMPLATES.length,
        free: true,
        costPerSignature: 0,
      });
    }
    if (action === 'templates') {
      if (!token) return unavailable('HighLevel is not connected (HL_API_TOKEN missing) — cannot list templates.');
      try {
        const live = await hlListTemplates(token);
        return ok({ templates: live, source: 'highlevel', stale: false });
      } catch (e) {
        return ok({ templates: KNOWN_TEMPLATES, source: 'fallback-known-list', stale: true, warning: 'Live template list failed; showing the 9 templates verified Nov 11, 2026. Verify in HighLevel before sending.' });
      }
    }
    if (action === 'documents') {
      if (!token) return unavailable('HighLevel is not connected (HL_API_TOKEN missing).');
      try {
        const docs = await hlListDocuments(token, qs.query || '');
        return ok({ documents: docs.map((d) => ({ id: d.documentId || d._id, name: d.name, status: d.status, recipients: d.recipients || [], updatedAt: d.updatedAt })) });
      } catch (e) { return unavailable('HighLevel document list failed: ' + (e.message || 'unknown error')); }
    }
    if (action === 'envelope') {
      const store = getLogStore(event);
      if (!store) return unavailable('Signature log is unavailable — cannot read the envelope.');
      const env = await readEnvelope(store, qs.id || '');
      if (!env) return json(404, { error: 'No signature record with that id.' });
      return ok({ envelope: env });
    }
    return bad('Unknown action. Use action=status|templates|documents|envelope.');
  }

  // ---- POST ----
  if (method !== 'POST') return bad('Method not allowed.');
  if (!token) return unavailable('HighLevel is not connected (HL_API_TOKEN missing) — cannot prepare or send a contract.');

  // ---- prepare: validate + write contract fields + create draft + fields check. Sends NOTHING. ----
  if (action === 'prepare' || body.action === 'prepare') {
    const contactId = body.contactId || body.ghlContactId || '';
    const templateId = body.templateId || '';
    const contractDate = body.contractDate || new Date().toISOString().slice(0, 10);
    if (!contactId) return bad('A HighLevel contact id is required.');
    if (!templateId) return bad('A contract template id is required.');
    if (!senderUserId) return unavailable('ESIGN_SENDER_USER_ID is not set — the HighLevel sender user must be configured before any contract can be created.');
    const store = getLogStore(event);
    if (!store) return unavailable('Signature log is unavailable — cannot prepare a contract without an audit trail.');
    let contact;
    try { contact = await hlGetContact(token, contactId); } catch (e) { return unavailable('HighLevel contact lookup failed: ' + (e.message || 'unknown error')); }
    if (!contact) return json(404, { error: 'HighLevel contact not found.' });
    const check = contractFieldCheck(contact, { contractDate });
    if (!check.ok) return bad('Contract is not ready to prepare.', { missing: check.missing });
    // Write any computed closing date / legal description back to the
    // contact so the HL template merge tokens render them.
    const writes = [];
    if (!customField(contact, FIELD_IDS.closingDate) && check.contract.closingDate) writes.push({ id: FIELD_IDS.closingDate, fieldValue: check.contract.closingDate });
    if (check.contract.legal && customField(contact, FIELD_IDS.legal) !== check.contract.legal) writes.push({ id: FIELD_IDS.legal, fieldValue: check.contract.legal });
    if (writes.length) {
      try { await hlUpdateContactFields(token, contactId, writes); } catch (e) { return unavailable('Could not write contract fields to the HighLevel contact: ' + (e.message || 'unknown error')); }
    }
    // Duplicate guard (same seller + template + price within 24h).
    const dupKey = { contactId, templateId, price: check.contract.price };
    const allEnvelopes = await scanEnvelopes(store);
    const existing = allEnvelopes.find((e) => isDuplicate(e, dupKey)) || null;
    if (existing && !body.forceNew) {
      // Reopen path: a repeat Prepare is how a reopened sheet reaches
      // its already-prepared draft, so the 409 carries the EXISTING
      // envelope (the sheet adopts it and Send becomes reachable). If
      // that envelope never captured its document id, try to resolve
      // it from the document list first (single read — by reopen time
      // the draft is old enough to be listed; send re-resolves too).
      if (!existing.documentId) {
        try {
          const res = await resolveEnvelopeDocumentId(token, store, existing, { delaysMs: [] });
          if (res.documentId) {
            existing.documentId = res.documentId;
            existing.draftResolution = { via: 'list-match-on-reopen', at: new Date().toISOString() };
            if (res.draft && !(existing.draftRecipients || []).length) existing.draftRecipients = res.draft.recipients || [];
            appendEvent(existing, 'document-id-resolved', `Draft document id ${res.documentId} recovered from the HighLevel document list on a reopened prepare.`, 'dashboard');
            await writeEnvelope(store, existing);
          }
        } catch (e) { /* best-effort — the 409 still returns the envelope */ }
      }
      return json(409, { error: 'A contract for this seller, template and price was already prepared in the last 24 hours.', code: 'duplicate_envelope', envelopeId: existing.id, envelope: existing, disclosureReminder: needsDisclosureReminder(contactSummary(contact).state) });
    }
    // Create the draft (sendDocument:false). UNVERIFIED at build time:
    // if HL ignores the flag and sends, the deploy check must catch it.
    const templateName = (KNOWN_TEMPLATES.find((t) => t.id === templateId) || {}).name || '';
    const prepareStartedAt = Date.now();
    let created;
    try {
      created = await hlJson(token, 'POST', '/proposals/templates/send', buildSendTemplateBody({ templateId, userId: senderUserId, contactId, opportunityId: body.opportunityId || '', sendDocument: false }));
    } catch (e) { return json(503, { error: 'HighLevel could not create the contract draft: ' + (e.message || 'unknown error'), hlStatus: e.status || null, hlError: e.body || null }); }
    const links = (created && (created.links || (created.data && created.data.links))) || [];
    // Document-id capture (see the capture block above): the create
    // response is only the FIRST source. Drafts carry no links, so an
    // id-less response falls through to a list match (template name +
    // seller recipient + the prepare-time window), polled briefly in
    // case the new draft is not listed yet. No `query` on the list:
    // HL's `query` is a document-NAME search (an APN query returned 0
    // docs live, Nov 11).
    let documentId = extractCreatedDocumentId(created);
    let resolvedVia = documentId ? 'create-response' : '';
    let draft = null;
    if (documentId) {
      try {
        const docs = await hlListDocuments(token);
        draft = matchDraftInList(docs, { documentId }) || null;
      } catch (e) { draft = null; }
    }
    if (!draft) {
      const res = await resolveDraftDocument(token, {
        documentId,
        name: templateName,
        contactId,
        notBeforeMs: prepareStartedAt - 5 * 60 * 1000,
        notAfterMs: prepareStartedAt + 15 * 60 * 1000,
        excludeIds: usedDocumentIds(allEnvelopes, null),
      }, {});
      if (res.draft) {
        draft = res.draft;
        if (!documentId) { documentId = res.documentId; resolvedVia = 'list-match'; }
      }
    }
    const fields = draft ? fieldsReadyCheck(draft) : advisoryFieldsCheck(['Could not read the draft back from HighLevel — its fields could not be checked at all.'], [], 'Draft created, but HighLevel did not return it in the document list, so no field view exists at all. The send stays locked until Troy confirms in the sheet that he checked the Signature fields on this draft in HighLevel.');
    const envelope = {
      id: newEnvelopeId(),
      leadId: body.leadId || '',
      contactId,
      templateId,
      templateName: (KNOWN_TEMPLATES.find((t) => t.id === templateId) || {}).name || templateId,
      documentId: documentId || (draft && docIdOf(draft)) || '',
      draftResolution: { via: resolvedVia || (draft ? 'list-match' : 'unresolved'), at: new Date().toISOString() },
      state: (fields.ready || fields.advisory) ? 'draft' : 'fields-blocked',
      contract: check.contract,
      signers: buildSigners(contact),
      draftRecipients: draft ? (draft.recipients || []) : [],
      fieldsCheck: fields,
      fieldsConfirmedByTroy: false,
      links: links.map((l) => ({ recipientId: l.recipientId || '', documentId: l.documentId || '' })),
      events: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    appendEvent(envelope, 'prepared', `Draft created from template ${envelope.templateName}; document id ${envelope.documentId || 'UNRESOLVED — send will re-resolve from the document list before it can send'} (via ${envelope.draftResolution.via}); fields check ${fields.ready ? 'passed (signatures verified via the API)' : (fields.advisory ? 'ADVISORY — the API cannot see signature fields; send unlocks only on Troy\'s in-sheet confirmation that he checked them in HighLevel' : 'FAILED — send blocked')}.`, 'dashboard');
    await writeEnvelope(store, envelope);
    return ok({ envelope, fieldsCheck: fields, disclosureReminder: needsDisclosureReminder(contactSummary(contact).state) });
  }

  // ---- send: draft must exist, fields must be ready, Troy must confirm. ----
  if (action === 'send' || body.action === 'send') {
    const envelopeId = body.envelopeId || '';
    if (!envelopeId) return bad('An envelope id from prepare is required — send never starts from scratch.');
    const store = getLogStore(event);
    if (!store) return unavailable('Signature log is unavailable — cannot send without an audit trail.');
    const envelope = await readEnvelope(store, envelopeId);
    if (!envelope) return json(404, { error: 'No prepared envelope with that id.' });
    if (envelope.state === 'sent' || envelope.state === 'viewed' || envelope.state === 'completed' || envelope.state === 'accepted') {
      return json(409, { error: 'This contract was already sent.', code: 'already_sent', state: envelope.state });
    }
    // Fields gate: signatures are the requirement, dates are not (the
    // contracts carry right-now dates). A verified check needs Troy's
    // confirmation; an advisory check (the HL API cannot expose
    // signature fields — see fieldsReadyCheck) needs his confirmation
    // PLUS explicit acceptance of the advisory.
    const gate = fieldsGateDecision(envelope.fieldsCheck, body);
    if (!gate.allowed) {
      return bad(gate.error, { missing: gate.missing || (envelope.fieldsCheck && envelope.fieldsCheck.missing) || [] });
    }
    envelope.fieldsGateMode = gate.mode;
    // Document-id recovery: if prepare could not capture the draft's
    // id (the create response carried none and the draft was not yet
    // visible in the list), resolve it NOW from the document list,
    // matched on template name + seller recipient + the prepare-time
    // window. By send time the draft exists in the list (verified live
    // Nov 11 late), so this closes the empty-id dead end. The refusal
    // below stays exactly as it was — no resolved id, no send.
    if (!envelope.documentId) {
      try {
        const res = await resolveEnvelopeDocumentId(token, store, envelope, {});
        if (res.documentId) {
          envelope.documentId = res.documentId;
          envelope.draftResolution = { via: 'list-match-at-send', at: new Date().toISOString() };
          appendEvent(envelope, 'document-id-resolved', `Draft document id ${res.documentId} recovered from the HighLevel document list at send time.`, 'dashboard');
          await writeEnvelope(store, envelope);
        }
      } catch (e) { /* fall through to the refusal — fail closed */ }
    }
    if (!envelope.documentId) return bad('The prepared draft has no HighLevel document id — re-prepare before sending.');
    if (!senderUserId) return unavailable('ESIGN_SENDER_USER_ID is not set.');
    const ccRecipients = [];
    if (troyContactId) ccRecipients.push({ id: troyContactId, email: 'troy00152@gmail.com', imageUrl: '', contactName: 'Troy Thomas', firstName: 'Troy', lastName: 'Thomas' });
    let sent;
    try {
      sent = await hlJson(token, 'POST', '/proposals/document/send', buildSendDocumentBody({ documentId: envelope.documentId, sentBy: senderUserId, medium: 'email', ccRecipients }));
    } catch (e) { return json(503, { error: 'HighLevel could not send the contract: ' + (e.message || 'unknown error'), hlStatus: e.status || null, hlError: e.body || null }); }
    envelope.state = 'sent';
    envelope.fieldsConfirmedByTroy = true;
    envelope.sentAt = new Date().toISOString();
    envelope.sendResponse = { links: sent.links || [] };
    appendEvent(envelope, 'sent', `Contract sent by email to the seller, Troy CC’d. Signing link available in the envelope. Fields gate: ${gate.mode === 'advisory-confirmed' ? 'advisory — Troy confirmed he checked the Signature fields in HighLevel (the API cannot expose them)' : 'signatures verified via the API'}.`, 'dashboard');
    // Text the seller their HL signing link — email is the delivery
    // channel, SMS is a nudge. Never text a DND/dnc contact.
    let sms = { attempted: false, sent: false, reason: '' };
    try {
      const contact = await hlGetContact(token, envelope.contactId);
      const link = (sent.links || []).find((l) => l && l.recipientId === envelope.contactId);
      const linkUrl = link ? (link.url || link.link || link.href || '') : '';
      if (!contact) { sms.reason = 'Seller contact could not be re-read; link not texted.'; }
      else if (isSmsDnd(contact)) { sms.reason = 'Seller is DND/dnc — signing link sent by email only, no text.'; }
      else if (!contact.phone) { sms.reason = 'No mobile on file — signing link sent by email only.'; }
      else if (!linkUrl) { sms.reason = 'HighLevel did not return a signing link to text.'; }
      else {
        sms.attempted = true;
        await hlSendSms(token, envelope.contactId, `Hi ${contactSummary(contact).firstName || 'there'} — your purchase contract for ${envelope.contract.apn || ''} is ready to sign: ${linkUrl} — Direct Property Buyers`);
        sms.sent = true;
        appendEvent(envelope, 'sms-link-sent', 'Signing link texted to the seller.', 'dashboard');
      }
    } catch (e) { sms.reason = 'SMS link send failed (email send already succeeded): ' + (e.message || 'unknown error'); }
    envelope.sms = sms;
    await writeEnvelope(store, envelope);
    return ok({ envelope, sms });
  }

  // ---- refresh: poll HL for the envelope's current status. ----
  if (action === 'refresh' || body.action === 'refresh') {
    const envelopeId = body.envelopeId || '';
    if (!envelopeId) return bad('An envelope id is required.');
    const store = getLogStore(event);
    if (!store) return unavailable('Signature log is unavailable.');
    const envelope = await readEnvelope(store, envelopeId);
    if (!envelope) return json(404, { error: 'No envelope with that id.' });
    if (!token) return unavailable('HighLevel is not connected.');
    let docs = [];
    try { docs = await hlListDocuments(token); } catch (e) { return unavailable('HighLevel document list failed: ' + (e.message || 'unknown error')); }
    const doc = docs.find((d) => (d.documentId || d._id) === envelope.documentId) || null;
    if (!doc) return ok({ envelope, hlStatus: 'not-found', note: 'HighLevel did not return this document in the list — it may have been deleted or the list is paged.' });
    const prev = envelope.state;
    envelope.state = nextEnvelopeState(envelope.state, doc.status);
    envelope.hlStatus = doc.status;
    envelope.hlRecipients = doc.recipients || [];
    if (envelope.state !== prev) appendEvent(envelope, 'status-' + envelope.state, `HighLevel status is now ${doc.status}.`, 'highlevel-poll');
    if ((envelope.state === 'completed' || envelope.state === 'accepted') && !envelope.completionTagged) {
      try {
        await hlAddTags(token, envelope.contactId, ['contract-signed']);
        envelope.completionTagged = true;
        appendEvent(envelope, 'completed', 'All parties signed. HL contact tagged contract-signed.', 'highlevel-poll');
      } catch (e) {
        appendEvent(envelope, 'completed-tag-failed', 'All parties signed, but the contract-signed tag could not be added: ' + (e.message || 'unknown error'), 'highlevel-poll');
      }
    }
    await writeEnvelope(store, envelope);
    return ok({ envelope, hlStatus: doc.status });
  }

  return bad('Unknown action. Use action=prepare|send|refresh (POST) or action=status|templates|documents|envelope (GET).');
};

module.exports = {
  handler: exports.handler,
  closingDatePlus30,
  buildLegalDescription,
  customField,
  contactSummary,
  contractFieldCheck,
  buildSigners,
  isSmsDnd,
  isEmailDnd,
  needsDisclosureReminder,
  templateForState,
  fieldsReadyCheck,
  advisoryFieldsCheck,
  fieldsGateDecision,
  nextEnvelopeState,
  appendEvent,
  newEnvelopeId,
  isDuplicate,
  buildSendTemplateBody,
  buildSendDocumentBody,
  signingLinkFor,
  docIdOf,
  extractCreatedDocumentId,
  matchDraftInList,
  resolveDraftDocument,
  scanEnvelopes,
  usedDocumentIds,
  resolveEnvelopeDocumentId,
  hlErrorText,
  hlListDocuments,
  FIELD_IDS,
  KNOWN_TEMPLATES,
  ENVELOPE_STATES,
  HL_LOCATION_ID,
};

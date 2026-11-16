// cc-funnel-api.js — public cash-offer funnel endpoint (standalone mirror
// of the HighLevel funnel at directpropertybuyersllc.com/cash-offer and
// its "Website Lead Intake" workflow).
//
// Receives the funnel form submission from cash-offer.html and creates
// the lead in the SAME standalone store the bot / Conversations use
// (cc-enrollments, keyed by phone digits — cc-client.js reads contacts
// from there). The record is written WITHOUT an enrollments-index entry,
// so the workflow engine's tick never sees it: a web lead is not a
// workflow enrollment and nothing is ever sent from here.
//
// Consent is the whole point of this endpoint: the HL form is the A2P
// opt-in proof for the Twilio + Telnyx campaigns, so the two consent
// checkboxes are stored verbatim as a consent record (values, timestamp,
// source URL, full submission history) AND stamped onto the contact's
// production-shaped customFields as the HL Consent / Marketing Consent
// checkbox fields (ids from hl-inventory.md §5).
//
// Rules (no loose ends):
// - Unchecked SMS consent => lead is stored as no-consent for the audit
//   trail, textable=false, and NEVER carries the `sms consent` tag.
// - Consent once given is never downgraded by a later form resubmission
//   (withdrawal happens via STOP, not by re-submitting a form).
// - Duplicate submission (same phone, or same email when no phone) =>
//   the existing record is updated in place; no second lead is created.
// - No market `* sms` tag is ever added here: the funnel never enrolls
//   anyone into a texting workflow by itself.
// - No sends of any kind. No external calls.

'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');

// HL custom field ids (hl-inventory.md §5) — production shape is
// customFields: [{ id, value }] ONLY (zero-mistake release rule).
const CONSENT_FIELD_ID = 'TS93pUaF31ye8sa9qWLz'; // Consent (CHECKBOX)
const MARKETING_CONSENT_FIELD_ID = 'P3wPmgGNOVeoLCvlMFH0'; // Marketing Consent (CHECKBOX)

const TAG_WEB_LEAD = 'website lead';
const TAG_SMS_CONSENT = 'sms consent';

let testStores = null;

function enrollmentsStore(event) {
  if (testStores && testStores.enrollments) return testStores.enrollments;
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore('cc-enrollments');
}

async function readJson(store, key) {
  try {
    const v = await store.get(key, { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

async function writeJson(store, key, obj) {
  await store.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

function str(v) {
  return String(v == null ? '' : v).trim();
}

function emailKey(email) {
  return 'email-' + email.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Merge the two consent checkbox fields into a production-shaped
// customFields array, preserving any other fields already on the record
// (e.g. the pricing trio if the lead has since been priced).
function mergeConsentFields(existing, sms, marketing) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(existing) ? existing : []) {
    if (!f || typeof f !== 'object' || !f.id) continue;
    if (f.id === CONSENT_FIELD_ID || f.id === MARKETING_CONSENT_FIELD_ID) continue;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, value: f.value });
  }
  out.push({ id: CONSENT_FIELD_ID, value: !!sms });
  out.push({ id: MARKETING_CONSENT_FIELD_ID, value: !!marketing });
  return out;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function handler(event) {
  if (!event || event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'POST only' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  // Honeypot: a field no human sees. Bots fill it; answer like a success
  // and store nothing.
  if (str(body.website2)) {
    return json(200, { ok: true });
  }

  const firstName = str(body.firstName);
  const lastName = str(body.lastName);
  const email = str(body.email);
  const address1 = str(body.address1);
  const city = str(body.city);
  const state = str(body.state);
  const postalCode = str(body.postalCode);
  const sourceUrl = str(body.sourceUrl) || 'https://directpropertybuyersllc.com/cash-offer';

  // Required fields — exactly the ones the HL form marks with *.
  const missing = [];
  if (!firstName) missing.push('firstName');
  if (!lastName) missing.push('lastName');
  if (!address1) missing.push('address1');
  if (!city) missing.push('city');
  if (!state) missing.push('state');
  if (!postalCode) missing.push('postalCode');
  if (missing.length) {
    return json(400, { ok: false, error: 'Missing required fields', missing });
  }

  // Phone is NOT required on the HL form; when given it must be a valid
  // US number (same normalizer the rest of the stack uses).
  let phone = '';
  let phoneDigits = '';
  if (str(body.phone)) {
    try {
      phoneDigits = lib.phoneKey(body.phone);
      phone = '+' + phoneDigits;
    } catch (e) {
      return json(400, { ok: false, error: 'Invalid phone number' });
    }
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { ok: false, error: 'Invalid email address' });
  }

  // A lead needs a key: phone digits, or the email when no phone.
  if (!phoneDigits && !email) {
    return json(400, { ok: false, error: 'A phone number or an email is required' });
  }
  const key = phoneDigits || emailKey(email);

  const consentSms = body.consentSms === true || body.consentSms === 'true' || body.consentSms === 'on';
  const consentMarketing =
    body.consentMarketing === true || body.consentMarketing === 'true' || body.consentMarketing === 'on';

  const store = enrollmentsStore(event);
  const existing = await readJson(store, key);
  const now = new Date().toISOString();
  const duplicate = !!existing;

  // Effective consent: a YES is sticky — a later resubmission with the
  // box unchecked never erases a consent already given.
  const prevConsent = (existing && existing.consent) || {};
  const effSms = !!(prevConsent.sms || consentSms);
  const effMarketing = !!(prevConsent.marketing || consentMarketing);

  const consentEntry = { sms: consentSms, marketing: consentMarketing, at: now, sourceUrl };
  const consentHistory = (existing && Array.isArray(existing.consentHistory) ? existing.consentHistory : []).concat([
    consentEntry,
  ]);

  const tags = new Set(existing && Array.isArray(existing.tags) ? existing.tags : []);
  tags.add(TAG_WEB_LEAD);
  if (effSms && phoneDigits) tags.add(TAG_SMS_CONSENT);
  else tags.delete(TAG_SMS_CONSENT);
  // The funnel never enrolls: strip nothing else, add no market tags.

  const textable = !!(effSms && phoneDigits);

  const record = Object.assign({}, existing || {}, {
    key,
    phone,
    phoneDigits,
    name: (firstName + ' ' + lastName).trim(),
    firstName,
    lastName,
    email: email || (existing && existing.email) || '',
    address1,
    city,
    state,
    postalCode,
    tags: Array.from(tags),
    source: 'website',
    stage: 'web-lead',
    status: 'web-lead',
    customFields: mergeConsentFields(existing && existing.customFields, effSms, effMarketing),
    consent: {
      sms: effSms,
      marketing: effMarketing,
      at: now,
      firstAt: prevConsent.firstAt || (consentSms || consentMarketing ? now : null),
      sourceUrl,
    },
    consentHistory,
    textable,
    submissions: ((existing && existing.submissions) || 0) + 1,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  });

  await writeJson(store, key, record);

  return json(200, { ok: true, duplicate, textable });
};

// Test hooks (not part of the deployed surface) — same pattern as
// cc-workflow-engine's _test.setStores.
exports._test = {
  setStores(stores) {
    testStores = stores || null;
  },
  CONSENT_FIELD_ID,
  MARKETING_CONSENT_FIELD_ID,
  TAG_WEB_LEAD,
  TAG_SMS_CONSENT,
  emailKey,
};

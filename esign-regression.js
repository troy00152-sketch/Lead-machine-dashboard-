// esign-regression.js — fixture tests for the in-dashboard e-sign build.
// Run: node esign-regression.js
// FIXTURE-ONLY: no live HighLevel calls, no live sends, no money, no Blobs.
// Covers the contract math, the fields check (signatures required,
// dates NOT required; advisory model since Nov 11 evening — the HL API
// provably does not expose signature fields), the send gate, the state
// machine, the duplicate guard, DND handling, and the FREE-only
// constraint (no paid vendor may appear anywhere in the function code).
'use strict';

const fs = require('fs');
const path = require('path');
const esign = require('./netlify/functions/esign.js');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.error('FAIL:', name, extra || ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---- fixtures ----
function contact(over) {
  const c = {
    id: 'QNFTFhtDD6QkRB1hkRgK',
    firstName: 'Willard', lastName: 'Gatlin',
    contactName: 'Willard Gatlin',
    email: 'wgatlin2@cox.net', phone: '+17573104762',
    address1: '705 McDowell St', city: 'Greenville', state: 'NC', postalCode: '27834',
    tags: [],
    customFields: [
      { id: esign.FIELD_IDS.county, fieldValue: 'Pitt County' },
      { id: esign.FIELD_IDS.contractPrice, fieldValue: '60000' },
      { id: esign.FIELD_IDS.emd, fieldValue: '100' },
      { id: esign.FIELD_IDS.apn, fieldValue: '008539' },
      { id: esign.FIELD_IDS.legal, fieldValue: 'LINCOLN PARK ADDITION 1' },
      { id: esign.FIELD_IDS.closingDate, fieldValue: '2026-12-07' },
    ],
  };
  return Object.assign(c, over || {});
}
function stripField(c, fieldId) {
  c.customFields = c.customFields.filter((f) => f.id !== fieldId);
  return c;
}

// ---- 1. closing date = contract date + 30 days ----
t('closing: Gatlin 2026-11-07 -> 2026-12-07', esign.closingDatePlus30('2026-11-07').date === '2026-12-07');
t('closing: month boundary 2026-01-31 -> 2026-03-02', esign.closingDatePlus30('2026-01-31').date === '2026-03-02');
t('closing: leap year 2028-02-29 -> 2028-03-30', esign.closingDatePlus30('2028-02-29').date === '2028-03-30');
t('closing: missing date errors, never guesses', Boolean(esign.closingDatePlus30('').error));
t('closing: invalid date errors', Boolean(esign.closingDatePlus30('not-a-date').error));

// ---- 2. legal description format ----
t('legal: "[APN] ([legal])"', esign.buildLegalDescription('008539', 'LINCOLN PARK ADDITION 1') === '008539 (LINCOLN PARK ADDITION 1)');
t('legal: already-prefixed text is not doubled', esign.buildLegalDescription('008539', '008539 (LINCOLN PARK ADDITION 1)') === '008539 (LINCOLN PARK ADDITION 1)');
t('legal: missing APN -> empty (blocks, never invents)', esign.buildLegalDescription('', 'LINCOLN PARK ADDITION 1') === '');
t('legal: missing legal text -> empty', esign.buildLegalDescription('008539', '') === '');

// ---- 3. contract field check ----
(function () {
  const c = contact();
  const r = esign.contractFieldCheck(c, { contractDate: '2026-11-07' });
  t('fields: complete Gatlin contact passes', r.ok === true, JSON.stringify(r.missing));
  t('fields: price/EMD/APN/legal/county/closing read', r.contract.price === '60000' && r.contract.emd === '100' && r.contract.apn === '008539' && r.contract.legal === '008539 (LINCOLN PARK ADDITION 1)' && r.contract.county === 'Pitt County' && r.contract.closingDate === '2026-12-07');
  const noPrice = esign.contractFieldCheck(stripField(contact(), esign.FIELD_IDS.contractPrice), {});
  t('fields: missing price blocks', noPrice.ok === false && noPrice.missing.includes('contract_price'));
  const badPrice = contact(); badPrice.customFields.find((f) => f.id === esign.FIELD_IDS.contractPrice).fieldValue = 'sixty thousand';
  t('fields: non-numeric price blocks', esign.contractFieldCheck(badPrice, {}).ok === false);
  const noEmd = esign.contractFieldCheck(stripField(contact(), esign.FIELD_IDS.emd), {});
  t('fields: missing EMD blocks', noEmd.ok === false && noEmd.missing.includes('emd_deposit'));
  const noApn = esign.contractFieldCheck(stripField(contact(), esign.FIELD_IDS.apn), {});
  t('fields: missing APN blocks', noApn.ok === false && noApn.missing.includes('APN'));
  const noLegal = esign.contractFieldCheck(stripField(contact(), esign.FIELD_IDS.legal), {});
  t('fields: missing legal blocks', noLegal.ok === false && noLegal.missing.includes('legal_description'));
  const noCounty = esign.contractFieldCheck(stripField(contact(), esign.FIELD_IDS.county), {});
  t('fields: missing county blocks', noCounty.ok === false && noCounty.missing.includes('county'));
  const noEmail = contact(); noEmail.email = '';
  t('fields: missing seller email blocks (HL needs it to deliver)', esign.contractFieldCheck(noEmail, {}).ok === false);
  const noClosing = stripField(contact(), esign.FIELD_IDS.closingDate);
  const computed = esign.contractFieldCheck(noClosing, { contractDate: '2026-11-07' });
  t('fields: missing closing date is computed from contract date +30', computed.ok === true && computed.contract.closingDate === '2026-12-07');
  const noClosingNoDate = esign.contractFieldCheck(noClosing, {});
  t('fields: missing closing date AND no contract date blocks', noClosingNoDate.ok === false);
})();

// ---- 4. signers ----
(function () {
  const s = esign.buildSigners(contact());
  t('signers: seller first', s[0].role === 'seller' && s[0].name === 'Willard Gatlin');
  t('signers: Paula is buyer, HL-user seat (never a contact signer)', s[1].role === 'buyer' && s[1].kind === 'hl-user' && s[1].name === 'Paula Thomas');
  t('signers: Troy is copy-only, never a signer', s[2].role === 'copy' && s[2].name === 'Troy Thomas');
  t('signers: exactly 3 seats', s.length === 3);
})();

// ---- 5. fields check — signatures required, dates NOT required ----
// Model (Nov 11 evening): the HL API provably does NOT project signature
// fields (7 live documents read, incl. one already signed — Text/Date
// only; the sent test document 6af51659e94c61f78742d9cb projects an
// EMPTY list). So the check is VERIFIED only when the API shows a
// Signature field for every signer, and ADVISORY otherwise — never a
// hard block on API evidence, and the send gate (section 5b) requires
// Troy's explicit confirmation + advisory acceptance instead.
(function () {
  const gatlinDoc = {
    documentId: '6aefcfc12c8f6fac64629f96', status: 'viewed',
    fillableFields: [],
    recipients: [
      { id: 'QNFTFhtDD6QkRB1hkRgK', contactName: 'willard gatlin', role: 'signer' },
      { id: 'BsoCeQWYI6BRct8hBKdz', contactName: 'Paula Thomas', role: 'signer' },
    ],
  };
  const g = esign.fieldsReadyCheck(gatlinDoc);
  t('fields: empty fillableFields is ADVISORY, not a hard block (Gatlin shape)', g.ready === false && g.advisory === true && g.requiresConfirmation === true, JSON.stringify(g));
  t('fields: advisory reason states the API cannot expose signature fields', /does not expose signature fields/i.test(g.reason || ''));
  t('fields: advisory lists both signers as unverified for Signature', g.unverified.length === 2 && g.unverified.every((m) => /Signature/.test(m)));
  t('fields: advisory NEVER lists a missing Date (dates are set on the contracts)', !g.unverified.some((m) => /no Date|missing.*Date/i.test(m)) && !/Date field/.test(g.unverified.join(' ')));
  // The sent test document itself: HL accepted + sent it with an empty
  // projected field list — the exact shape that hard-blocked forever.
  const sentTestDoc = {
    documentId: '6af51659e94c61f78742d9cb', status: 'viewed',
    fillableFields: [],
    recipients: [
      { id: 'qFBg9HS2LtXQg8mWjQuA', contactName: 'TEST E-Sign Do Not Use', role: 'signer' },
      { id: 'a4vyLnhwrRQn75dqek7k', contactName: 'Paula Thomas', role: 'signer' },
    ],
  };
  const st = esign.fieldsReadyCheck(sentTestDoc);
  t('fields: the successfully sent test doc is advisory (not verified, not blocked)', st.advisory === true && st.ready === false);
  // IN agreement shape WITH signature fields projected for both signers.
  const inDoc = {
    documentId: '6ad7f0f89fba0130bbbe29f6', status: 'sent',
    fillableFields: [
      { id: 'f1', fieldId: 'text_field_1', type: 'TextField', recipient: 'a4vyLnhwrRQn75dqek7k', isRequired: true },
      { id: 'f2', fieldId: 'date_field_2', type: 'DateField', recipient: 'a4vyLnhwrRQn75dqek7k', isRequired: true },
      { id: 'f3', fieldId: 'signature_field_1', type: 'SignatureField', recipient: 'a4vyLnhwrRQn75dqek7k', isRequired: true },
      { id: 'f4', fieldId: 'text_field_2', type: 'TextField', recipient: 'zLMWqeRk6yD5BdH866hS', isRequired: true },
      { id: 'f5', fieldId: 'date_field_3', type: 'DateField', recipient: 'zLMWqeRk6yD5BdH866hS', isRequired: true },
      { id: 'f6', fieldId: 'signature_field_2', type: 'SignatureField', recipient: 'zLMWqeRk6yD5BdH866hS', isRequired: true },
    ],
    recipients: [
      { id: 'a4vyLnhwrRQn75dqek7k', contactName: 'Troy Thomas', role: 'signer' },
      { id: 'zLMWqeRk6yD5BdH866hS', contactName: 'Seller', role: 'signer' },
    ],
  };
  const okDoc = esign.fieldsReadyCheck(inDoc);
  t('fields: all signers with a Signature field passes VERIFIED', okDoc.ready === true && okDoc.verified === true && okDoc.advisory === false, JSON.stringify(okDoc));
  const missingDate = JSON.parse(JSON.stringify(inDoc));
  missingDate.fillableFields = missingDate.fillableFields.filter((f) => f.id !== 'f5');
  const md = esign.fieldsReadyCheck(missingDate);
  t('fields: a signer with Signature but NO Date still passes (dates not required)', md.ready === true, JSON.stringify(md));
  const noDatesAtAll = JSON.parse(JSON.stringify(inDoc));
  noDatesAtAll.fillableFields = noDatesAtAll.fillableFields.filter((f) => f.type !== 'DateField');
  t('fields: signatures only, zero Date fields anywhere, still passes', esign.fieldsReadyCheck(noDatesAtAll).ready === true);
  const missingSig = JSON.parse(JSON.stringify(inDoc));
  missingSig.fillableFields = missingSig.fillableFields.filter((f) => f.id !== 'f3');
  const ms = esign.fieldsReadyCheck(missingSig);
  t('fields: one signer without a visible Signature is advisory and names them', ms.ready === false && ms.advisory === true && ms.unverified.some((m) => /Troy Thomas/.test(m) && /Signature/.test(m)), JSON.stringify(ms.unverified));
  const weird = JSON.parse(JSON.stringify(inDoc));
  weird.fillableFields.push({ id: 'f9', fieldId: 'mystery_field_9', type: 'QuantumField', recipient: 'a4vyLnhwrRQn75dqek7k' });
  const w = esign.fieldsReadyCheck(weird);
  t('fields: unrecognized field type is reported, not a block, when signatures verify', w.ready === true && w.unrecognized.includes('QuantumField'));
  const noRecipients = { fillableFields: inDoc.fillableFields, recipients: [] };
  t('fields: no recipients + fields present passes (nothing to sign)', esign.fieldsReadyCheck(noRecipients).ready === true);
})();

// ---- 5b. send gate (fieldsGateDecision) ----
(function () {
  const verified = { ready: true, verified: true, advisory: false };
  const advisory = { ready: false, verified: false, advisory: true, requiresConfirmation: true, missing: ['Seller: Signature field not visible via the HighLevel API'] };
  t('gate: verified + Troy confirmation allows (mode verified)', (() => { const d = esign.fieldsGateDecision(verified, { fieldsConfirmed: true }); return d.allowed === true && d.mode === 'verified'; })());
  t('gate: verified without confirmation blocks', esign.fieldsGateDecision(verified, {}).allowed === false);
  t('gate: advisory + confirmation + acceptance allows (mode advisory-confirmed)', (() => { const d = esign.fieldsGateDecision(advisory, { fieldsConfirmed: true, fieldsAdvisoryAccepted: true }); return d.allowed === true && d.mode === 'advisory-confirmed'; })());
  t('gate: advisory + confirmation but NO acceptance blocks', esign.fieldsGateDecision(advisory, { fieldsConfirmed: true }).allowed === false);
  t('gate: advisory + acceptance but NO confirmation blocks', esign.fieldsGateDecision(advisory, { fieldsAdvisoryAccepted: true }).allowed === false);
  t('gate: advisory block names the advisory acceptance it needs', /fieldsAdvisoryAccepted/.test(esign.fieldsGateDecision(advisory, { fieldsConfirmed: true }).error || ''));
  t('gate: no fields check at all blocks (re-prepare)', esign.fieldsGateDecision(null, { fieldsConfirmed: true, fieldsAdvisoryAccepted: true }).allowed === false);
  t('gate: a non-advisory failed check still blocks even with both confirmations', esign.fieldsGateDecision({ ready: false, advisory: false, missing: ['x'] }, { fieldsConfirmed: true, fieldsAdvisoryAccepted: true }).allowed === false);
})();

// ---- 6. state machine ----
t('state: sent -> viewed moves forward', esign.nextEnvelopeState('sent', 'viewed') === 'viewed');
t('state: viewed -> completed moves forward', esign.nextEnvelopeState('viewed', 'completed') === 'completed');
t('state: completed -> viewed NEVER rewinds', esign.nextEnvelopeState('completed', 'viewed') === 'completed');
t('state: draft -> sent moves forward', esign.nextEnvelopeState('draft', 'sent') === 'sent');
t('state: unknown HL status leaves state alone', esign.nextEnvelopeState('sent', 'mystery') === 'sent');
t('state: accepted maps at completed level', esign.nextEnvelopeState('sent', 'accepted') === 'accepted');

// ---- 7. duplicate guard ----
(function () {
  const now = Date.now();
  const existing = { contactId: 'C1', templateId: 'T1', contract: { price: '60000' }, createdAt: new Date(now - 60 * 60 * 1000).toISOString() };
  t('dup: same seller+template+price within 24h is a duplicate', esign.isDuplicate(existing, { contactId: 'C1', templateId: 'T1', price: '60000' }, now) === true);
  t('dup: different price is not a duplicate', esign.isDuplicate(existing, { contactId: 'C1', templateId: 'T1', price: '65000' }, now) === false);
  t('dup: different template is not a duplicate', esign.isDuplicate(existing, { contactId: 'C1', templateId: 'T2', price: '60000' }, now) === false);
  const old = Object.assign({}, existing, { createdAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() });
  t('dup: same key after 24h is not a duplicate', esign.isDuplicate(old, { contactId: 'C1', templateId: 'T1', price: '60000' }, now) === false);
})();

// ---- 8. request builders ----
(function () {
  const draft = esign.buildSendTemplateBody({ templateId: 'T1', userId: 'U1', contactId: 'C1', sendDocument: false });
  t('api: draft body has sendDocument:false', draft.sendDocument === false && draft.templateId === 'T1' && draft.userId === 'U1' && draft.contactId === 'C1');
  // Nov 11 ~7:52 PM live 422: POST /proposals/templates/send failed with
  // "locationId should not be empty; locationId must be a string" — the
  // body carried no locationId at all. It must be present, a string, and
  // the new CRM location (krKoHLudPnn7nT0DPtwa), never the old XLeads one.
  t('api: template-send body carries locationId as a string', typeof draft.locationId === 'string' && draft.locationId.length > 0);
  t('api: template-send locationId is the new CRM location', draft.locationId === 'krKoHLudPnn7nT0DPtwa' && draft.locationId === esign.HL_LOCATION_ID);
  t('api: template-send locationId is not the old XLeads location', draft.locationId !== 'A4u3hypJbinp3GL9qhgd');
  const live = esign.buildSendTemplateBody({ templateId: 'T1', userId: 'U1', contactId: 'C1' });
  t('api: send body defaults sendDocument:true', live.sendDocument === true);
  t('api: live send body also carries locationId as a string', typeof live.locationId === 'string' && live.locationId === 'krKoHLudPnn7nT0DPtwa');
  const opp = esign.buildSendTemplateBody({ templateId: 'T1', userId: 'U1', contactId: 'C1', opportunityId: 'O1', sendDocument: false });
  t('api: opportunityId passes through when given', opp.opportunityId === 'O1');
  const doc = esign.buildSendDocumentBody({ documentId: 'D1', sentBy: 'U1', medium: 'email', ccRecipients: [{ id: 'T', email: 'troy00152@gmail.com' }] });
  t('api: send-document body carries documentId, sentBy, medium email, Troy CC', doc.documentId === 'D1' && doc.sentBy === 'U1' && doc.medium === 'email' && doc.ccRecipients.length === 1);
  // POST /proposals/document/send 422s ("locationId should not be
  // empty") without locationId — live blocker Nov 11 ~10:05 PM.
  t('api: send-document body carries locationId equal to the location constant', typeof doc.locationId === 'string' && doc.locationId === esign.HL_LOCATION_ID);
  t('api: send-document locationId is the new CRM location', doc.locationId === 'krKoHLudPnn7nT0DPtwa');
  t('api: no CC when none given', !('ccRecipients' in esign.buildSendDocumentBody({ documentId: 'D1', sentBy: 'U1' })));
  t('api: send-document body without CC still carries locationId', esign.buildSendDocumentBody({ documentId: 'D1', sentBy: 'U1' }).locationId === esign.HL_LOCATION_ID);
})();

// ---- 9. DND handling ----
(function () {
  const clean = contact();
  t('dnd: clean contact can be texted the link', esign.isSmsDnd(clean) === false);
  const dncTag = contact(); dncTag.tags = ['dnc'];
  t('dnd: dnc tag blocks SMS link', esign.isSmsDnd(dncTag) === true);
  const smsDnd = contact(); smsDnd.dndSettings = { sms: { status: 'active' } };
  t('dnd: SMS channel DND blocks SMS link', esign.isSmsDnd(smsDnd) === true);
  const emailOnly = contact(); emailOnly.dndSettings = { email: { status: 'active' } };
  t('dnd: email-only DND does NOT block the SMS link', esign.isSmsDnd(emailOnly) === false);
  t('dnd: email-only DND DOES block email (checked separately)', esign.isEmailDnd(emailOnly) === true);
  const master = contact(); master.dnd = true;
  t('dnd: master DND blocks SMS link', esign.isSmsDnd(master) === true);
})();

// ---- 10. state -> template + disclosure ----
t('template: IN picks the IN agreement', esign.templateForState(esign.KNOWN_TEMPLATES, 'IN').id === '6ad186514bf151249d4f7ab6');
t('template: NC picks the NC agreement', esign.templateForState(esign.KNOWN_TEMPLATES, 'NC').id === '6ada7e831e0a127d47066353');
t('template: OH picks the OH agreement', esign.templateForState(esign.KNOWN_TEMPLATES, 'OH').id === '6ada9551c47c0edc3fcf44ea');
t('template: FL picks the FLORIDA agreement', esign.templateForState(esign.KNOWN_TEMPLATES, 'FL').id === '6ada8005d6aed8017a40b93e');
t('template: MO picks the KC agreement', esign.templateForState(esign.KNOWN_TEMPLATES, 'MO').id === '6ada9420cb0b6a6fe8b4eab7');
t('template: unknown state picks nothing (never guesses)', esign.templateForState(esign.KNOWN_TEMPLATES, 'TX') === null);
t('disclosure: OH needs the SB 155 reminder', esign.needsDisclosureReminder('OH') === true);
t('disclosure: IN does not', esign.needsDisclosureReminder('IN') === false);
t('templates: exactly the 9 verified live Nov 11', esign.KNOWN_TEMPLATES.length === 9);
t('templates: ids unique', new Set(esign.KNOWN_TEMPLATES.map((x) => x.id)).size === 9);

// ---- 11. audit trail + ids + links ----
(function () {
  const env = { id: 'es_test', events: [] };
  esign.appendEvent(env, 'prepared', 'Draft created.', 'dashboard');
  esign.appendEvent(env, 'sent', 'Sent by email.', 'dashboard');
  t('audit: events append in order', env.events.length === 2 && env.events[0].action === 'prepared' && env.events[1].action === 'sent');
  t('audit: events carry timestamps', Boolean(env.events[0].at));
  const a = esign.newEnvelopeId(), b = esign.newEnvelopeId();
  t('id: envelope ids are unique and es_-prefixed', a !== b && a.startsWith('es_'));
  const doc = { links: [{ recipientId: 'C1', url: 'https://sign.example/C1' }, { recipientId: 'C2', url: 'https://sign.example/C2' }] };
  t('links: signing link found by recipient', esign.signingLinkFor('C2', doc) === 'https://sign.example/C2');
  t('links: unknown recipient -> empty string', esign.signingLinkFor('C9', doc) === '');
})();

// ---- 12. FREE-only guard: no paid vendor anywhere in the function code ----
// The function must call HighLevel and nothing else, and must not name a
// paid e-sign vendor. If this fails, the FREE constraint was broken.
(function () {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/esign.js'), 'utf8');
  const banned = /docusign|pandadoc|hellosign|dropbox\s*sign|signnow|adobe\s*sign|rabbitsign/i;
  t('free: no paid e-sign vendor named in esign.js', !banned.test(src));
  // Strip line comments first: the header legitimately says "no
  // per-envelope fees" — the guard must catch pricing CODE, not the
  // sentence that forbids it.
  const codeOnly = src.replace(/\/\/[^\n]*/g, '');
  t('free: no per-envelope / per-document pricing in esign.js', !/per[- ]envelope|per[- ]document|\$1\/doc/i.test(codeOnly));
  const hosts = [...src.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
  t('free: function only calls HighLevel (services.leadconnectorhq.com)', hosts.every((h) => h === 'services.leadconnectorhq.com'), hosts.join(', '));
  t('free: Blobs store is esign-log (connectLambda rule in file)', src.includes("'esign-log'") && src.includes('connectLambda'));
  const ui = fs.readFileSync(path.join(__dirname, 'assets/esign.js'), 'utf8');
  t('free: UI names no paid vendor either', !banned.test(ui));
})();

// ---- 12b. HighLevel error surfacing (Nov 11 422 bug) ----
// The prepare step used to return only "failed (HTTP 422)" — HL's real
// reason (in `message` / `error`) was thrown away. hlErrorText must
// surface it so the sheet shows the actual cause.
(function () {
  t('hlerr: string message passes through', esign.hlErrorText({ message: 'Template not found' }) === 'Template not found');
  t('hlerr: message array joins', esign.hlErrorText({ message: ['companyId must be a string', 'companyId should not be empty'] }) === 'companyId must be a string; companyId should not be empty');
  t('hlerr: error string passes through', esign.hlErrorText({ error: 'Unprocessable Entity' }) === 'Unprocessable Entity');
  t('hlerr: nested data.message passes through', esign.hlErrorText({ data: { message: 'User not found' } }) === 'User not found');
  t('hlerr: empty body -> empty (no invented cause)', esign.hlErrorText({}) === '');
  t('hlerr: null body -> empty', esign.hlErrorText(null) === '');
  t('hlerr: unknown shape falls back to JSON, truncated', esign.hlErrorText({ statusCode: 422, traceId: 'x' }).includes('422'));
})();

// ---- 13. UI: manual HighLevel contact link (Nov 11 v1 bug) ----
// The v1 sheet dead-ended on EVERY unlinked lead: openEsignSheet blocked
// when lead.ghlContactId was empty, and nothing in the repo ever set
// that field (pushLeadToGHL ignores the HL response). These fixture
// tests drive assets/esign.js in a minimal DOM/fetch stub — no browser,
// no live calls, no sends.
(async function () {
  const vm = require('vm');
  const uiSrc = fs.readFileSync(path.join(__dirname, 'assets/esign.js'), 'utf8');

  function makeEnv(opts) {
    const bareLeadsOnly = Boolean(opts && opts.bareLeadsOnly);
    const calls = []; // { action, body }
    const alerts = [];
    let saveStateCalls = 0;
    let sendCalls = 0;
    const els = {};
    function el(id) {
      if (!els[id]) els[id] = { id: id, innerHTML: '', value: '', classList: { add: function () {}, remove: function () {} } };
      return els[id];
    }
    const leads = [];
    const sandbox = {
      console: console,
      leads: leads,
      document: { getElementById: function (id) { return el(id); } },
      fetch: async function (url, opts) {
        const m = /[?&]action=([^&]+)/.exec(url);
        const action = m ? decodeURIComponent(m[1]) : '';
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        calls.push({ action: action, body: body });
        if (action === 'send') sendCalls++;
        if (action === 'templates') {
          return { ok: true, status: 200, json: async function () { return { templates: esign.KNOWN_TEMPLATES, stale: false }; } };
        }
        if (action === 'prepare') {
          if (body.contactId === 'C-bad') {
            // Server shape (esign.js prepare): unknown id -> HL lookup error.
            return { ok: false, status: 404, json: async function () { return { error: 'HighLevel contact not found.' }; } };
          }
          if (body.contactId === 'C-advisory') {
            // Advisory shape (Nov 11 evening): the API cannot see the
            // signature fields, so prepare returns an advisory check on
            // a sendable draft — NOT a fields-blocked envelope.
            return { ok: true, status: 200, json: async function () { return { envelope: { id: 'es_adv1', templateId: body.templateId, state: 'draft', contract: { price: '100001', emd: '100', apn: 'TEST-000001', legal: 'TEST-000001 (TEST SUBDIVISION)', county: 'Marion County', contractDate: '2026-11-11', closingDate: '2026-12-11' }, signers: [{ name: 'TEST E-Sign Do Not Use', role: 'seller', email: 'troy00152+esigntest@gmail.com' }] }, fieldsCheck: { ready: false, verified: false, advisory: true, requiresConfirmation: true, missing: ['TEST E-Sign Do Not Use: Signature field not visible via the HighLevel API'], unverified: ['TEST E-Sign Do Not Use: Signature field not visible via the HighLevel API'], unrecognized: [], reason: 'HighLevel\'s API does not expose signature fields.' }, disclosureReminder: false }; } };
          }
          if (body.contactId === 'C-dup') {
            // Duplicate-guard shape (Nov 11 late): a repeat Prepare
            // inside 24h returns 409 carrying the EXISTING envelope —
            // the sheet must adopt it (Send reachable), not dead-end.
            return { ok: false, status: 409, json: async function () { return { error: 'A contract for this seller, template and price was already prepared in the last 24 hours.', code: 'duplicate_envelope', envelopeId: 'es_dup1', envelope: { id: 'es_dup1', templateId: body.templateId, state: 'draft', documentId: '6af5283b7d64ba6637bb5979', contract: { price: '100003', emd: '100', apn: 'TEST-000000', legal: 'TEST-000000 (TEST SUBDIVISION)', county: 'Marion County', contractDate: '2026-11-11', closingDate: '2026-12-11' }, signers: [{ name: 'TEST E-Sign Do Not Use', role: 'seller', email: 'troy00152+esigntest@gmail.com' }], fieldsCheck: { ready: false, verified: false, advisory: true, requiresConfirmation: true, unverified: ['TEST E-Sign Do Not Use: Signature field not visible via the HighLevel API'], unrecognized: [], reason: 'HighLevel\'s API does not expose signature fields.' }, events: [] }, disclosureReminder: false }; } };
          }
          if (body.contactId === 'C-nofields') {
            return { ok: false, status: 400, json: async function () { return { error: 'Contract is not ready to prepare.', missing: ['contract_price', 'emd_deposit', 'APN', 'legal_description', 'county'] }; } };
          }
          return { ok: true, status: 200, json: async function () { return { envelope: { id: 'es_test1', templateId: body.templateId, state: 'draft', contract: { price: '60000', emd: '100', apn: '008539', legal: '008539 (X)', county: 'Pitt County', contractDate: '2026-11-07', closingDate: '2026-12-07' }, signers: [{ name: 'Willard Gatlin', role: 'seller', email: 'wgatlin2@cox.net' }] }, fieldsCheck: { ready: true }, disclosureReminder: false }; } };
        }
        return { ok: false, status: 400, json: async function () { return { error: 'unknown action' }; } };
      },
      alert: function (msg) { alerts.push(String(msg)); },
      // NOTE: no `confirm` stub on purpose (Nov 11) — the sheet must
      // never call the native confirm dialog; if any code path does,
      // the vm throws and the UI tests fail.
      saveState: function () { saveStateCalls++; },
    };
    // Live shape: index.html declares `let leads = []` at top level, and a
    // top-level `let` does NOT create window.leads. When bareLeadsOnly is
    // set, window is a separate object with no `leads` — bare `leads`
    // must still resolve. The old makeEnv masked this by setting
    // window = sandbox (so window.leads always existed).
    sandbox.window = bareLeadsOnly
      ? { document: sandbox.document, saveState: sandbox.saveState }
      : sandbox;
    vm.createContext(sandbox);
    vm.runInContext(uiSrc, sandbox);
    return {
      sandbox: sandbox, leads: leads, calls: calls, alerts: alerts,
      body: function () { return el('esignBody').innerHTML; },
      input: function (id) { return el(id); },
      prepareCalls: function () { return calls.filter((c) => c.action === 'prepare'); },
      get saveStateCalls() { return saveStateCalls; },
      get sendCalls() { return sendCalls; },
    };
  }

  // (a) unlinked lead opens the sheet with the manual-id field
  const envA = makeEnv();
  envA.leads.push({ id: 'L1', state: 'IN', address1: '1 Test St' });
  await envA.sandbox.esignOpenSheet('L1');
  t('ui-link: unlinked lead opens sheet with manual contact-id field', /id="esignContactId"/.test(envA.body()));
  t('ui-link: dead-end message is gone', !/push it to GHL first/.test(envA.body()));
  t('ui-link: hint says where the id lives (HL contact page URL)', /page URL/.test(envA.body()));
  t('ui-link: templates still load for an unlinked lead', envA.calls.some((c) => c.action === 'templates'));

  // (b) prepare uses the entered id and links the lead
  envA.input('esignContactId').value = 'C-manual';
  envA.input('esignTemplate').value = '6ad186514bf151249d4f7ab6';
  await envA.sandbox.esignPrepare();
  t('ui-link: prepare sends the manually entered contact id', envA.prepareCalls().length === 1 && envA.prepareCalls()[0].body.contactId === 'C-manual');
  t('ui-link: successful prepare persists the id on the lead', envA.leads[0].ghlContactId === 'C-manual');
  t('ui-link: successful prepare saves state so the link sticks', envA.saveStateCalls === 1);
  t('ui-link: after linking, the manual field is gone', !/id="esignContactId"/.test(envA.body()));
  t('ui-link: no send happened during prepare', envA.sendCalls === 0);

  // (c) linked lead still uses its stored id (unchanged path)
  const envC = makeEnv();
  envC.leads.push({ id: 'L2', state: 'NC', ghlContactId: 'C-linked' });
  await envC.sandbox.esignOpenSheet('L2');
  t('ui-link: linked lead shows NO manual-id field (unchanged path)', !/id="esignContactId"/.test(envC.body()));
  await envC.sandbox.esignPrepare();
  t('ui-link: linked lead prepare uses its stored id', envC.prepareCalls().length === 1 && envC.prepareCalls()[0].body.contactId === 'C-linked');
  t('ui-link: linked lead id is unchanged', envC.leads[0].ghlContactId === 'C-linked');
  t('ui-link: linked lead prepare does not re-save state', envC.saveStateCalls === 0);

  // (d) empty id is still blocked
  const envD = makeEnv();
  envD.leads.push({ id: 'L3', state: 'IN' });
  await envD.sandbox.esignOpenSheet('L3');
  envD.input('esignContactId').value = '   ';
  await envD.sandbox.esignPrepare();
  t('ui-link: empty id blocks prepare (no fetch)', envD.prepareCalls().length === 0);
  t('ui-link: empty id alerts with a clear message', envD.alerts.some((a) => /HighLevel contact ID/i.test(a)));
  t('ui-link: empty id sends nothing', envD.sendCalls === 0);

  // (e) invalid id fails closed without sending
  const envE = makeEnv();
  envE.leads.push({ id: 'L4', state: 'IN' });
  await envE.sandbox.esignOpenSheet('L4');
  envE.input('esignContactId').value = 'C-bad';
  await envE.sandbox.esignPrepare();
  t('ui-link: invalid id surfaces the HL lookup error', /HighLevel contact not found/.test(envE.body()));
  t('ui-link: invalid id does not link the lead', envE.leads[0].ghlContactId === undefined);
  t('ui-link: invalid id does not save state', envE.saveStateCalls === 0);
  t('ui-link: invalid id sends nothing', envE.sendCalls === 0);

  // (f) missing contract fields still surface, typed id survives re-render
  const envF = makeEnv();
  envF.leads.push({ id: 'L5', state: 'IN' });
  await envF.sandbox.esignOpenSheet('L5');
  envF.input('esignContactId').value = 'C-nofields';
  await envF.sandbox.esignPrepare();
  t('ui-link: missing contract fields still surface (not masked by link flow)', /contract_price/.test(envF.body()));
  t('ui-link: typed id survives a failed prepare (re-render keeps it)', /value="C-nofields"/.test(envF.body()));
  t('ui-link: failed prepare does not link the lead', envF.leads[0].ghlContactId === undefined);
  t('ui-link: failed prepare sends nothing', envF.sendCalls === 0);

  // (g) findLead reads the bare `leads` global (Nov 11 live regression):
  // commit 4d43c7d regressed findLead to `window.leads || window.LEADS`,
  // but the dashboard declares `let leads = []`, which creates no
  // window.leads — so on the live page findLead always returned null and
  // "Send for Signature" did nothing ("Lead not found."). This env
  // reproduces the live shape: bare `leads` exists, window.leads does not.
  const envG = makeEnv({ bareLeadsOnly: true });
  envG.leads.push({ id: 'L1', state: 'IN', address1: '1 Test St' });
  await envG.sandbox.window.esignOpenSheet('L1');
  t('findlead: sheet opens when only the bare leads global exists', envG.calls.some((c) => c.action === 'templates'));
  t('findlead: no "Lead not found" alert in the live shape', !envG.alerts.some((a) => /Lead not found/.test(a)));
  t('findlead: sheet renders the manual contact-id field in the live shape', /id="esignContactId"/.test(envG.body()));

  // (h) draft read-back — Nov 11 live failure: prepare created draft
  // 6af5112d2feb5ce2ae8f93a3 but the sheet logged "Could not read the
  // draft back". Two code bugs, both verified live via
  // list-documents-contracts: (1) HL returns { data: { documents: [] } }
  // and the code read parsed.documents (always []); (2) prepare passed
  // the APN as `query`, and HL's query is a document-NAME search, so
  // query=TEST-000000 returned 0 docs. hlListDocuments must parse the
  // live shape, and the no-query call must not send a query param.
  const liveDoc = {
    documentId: '6af5112d2feb5ce2ae8f93a3', status: 'draft',
    fillableFields: [
      { id: '459bda42-618c-40d6-b109-f4523d62b9c9', fieldId: 'text_field_1', type: 'TextField', recipient: 'a4vyLnhwrRQn75dqek7k', isRequired: true },
      { id: '7508a68f-9945-439b-96bd-faeb110312aa', fieldId: 'date_field_2', type: 'DateField', recipient: 'qFBg9HS2LtXQg8mWjQuA', isRequired: true },
    ],
    recipients: [
      { id: 'qFBg9HS2LtXQg8mWjQuA', contactName: 'TEST E-Sign Do Not Use', role: 'signer' },
      { id: 'a4vyLnhwrRQn75dqek7k', contactName: 'Paula Thomas', role: 'signer' },
    ],
  };
  function fakeListImpl(payload) {
    const seen = [];
    const impl = async function (url, opts) {
      seen.push(url);
      return { status: 200, text: JSON.stringify(payload) };
    };
    return { impl: impl, seen: seen };
  }
  const f1 = fakeListImpl({ data: { documents: [liveDoc] } });
  t('readback: live HL shape {data:{documents}} parses', JSON.stringify(await esign.hlListDocuments('T', undefined, f1.impl)) === JSON.stringify([liveDoc]));
  t('readback: no-query call sends no query param', !f1.seen[0].includes('query='));
  const f2 = fakeListImpl({ documents: [liveDoc] });
  t('readback: flat {documents} shape still parses', (await esign.hlListDocuments('T', undefined, f2.impl)).length === 1);
  const f3 = fakeListImpl([liveDoc]);
  t('readback: bare array shape still parses', (await esign.hlListDocuments('T', undefined, f3.impl)).length === 1);
  const f4 = fakeListImpl({ data: {} });
  t('readback: empty data -> empty list, never null', JSON.stringify(await esign.hlListDocuments('T', undefined, f4.impl)) === '[]');
  const f5 = fakeListImpl({ data: { documents: [liveDoc] } });
  await esign.hlListDocuments('T', 'AGREEMENT TO PURCHASE REAL ESTATE IN', f5.impl);
  t('readback: a name query still passes through (documents action)', f5.seen[0].includes('query=AGREEMENT'));
  // The live draft itself: it has TextField + DateField only — the API
  // projects no Signature fields for either signer (that is an API
  // limitation, proven across all 7 live documents, not proof the
  // template lacks signatures). The check must be ADVISORY for it, and
  // must NOT demand Date fields (dates are set on the contracts).
  const liveCheck = esign.fieldsReadyCheck(liveDoc);
  t('readback: live draft 6af5112d is advisory — no Signature visible via API for either signer', liveCheck.ready === false && liveCheck.advisory === true && liveCheck.unverified.some((m) => /TEST E-Sign/.test(m) && /Signature/.test(m)) && liveCheck.unverified.some((m) => /Paula Thomas/.test(m) && /Signature/.test(m)), JSON.stringify(liveCheck.unverified));
  t('readback: live draft demands NO Date field for Paula (dates already set on the contract)', !liveCheck.unverified.some((m) => /Date/.test(m)), JSON.stringify(liveCheck.unverified));

  // (i) advisory flow — the sheet must be SENDABLE on an advisory check:
  // Prepare returns state 'draft' + advisory fieldsCheck; the sheet
  // shows the advisory (amber, not a red block), offers the Send button
  // behind the confirmation checkbox, and esignSend posts
  // fieldsConfirmed:true + fieldsAdvisoryAccepted:true. This is the
  // exact flow the successful HL test send proved the contract needs.
  const envI = makeEnv();
  envI.leads.push({ id: 'L6', state: 'IN', ghlContactId: 'C-advisory' });
  await envI.sandbox.esignOpenSheet('L6');
  await envI.sandbox.esignPrepare();
  t('ui-advisory: advisory prepare renders the ADVISORY notice', /ADVISORY/.test(envI.body()));
  t('ui-advisory: advisory is not rendered as a hard FAILED block', !/Fields check FAILED/.test(envI.body()));
  t('ui-advisory: Send button is offered on an advisory draft', /Send for signature/.test(envI.body()));
  t('ui-advisory: confirmation checkbox asks about Signature fields', /Signature field for every signer is placed/.test(envI.body()));
  t('ui-advisory: checkbox does NOT demand a Date field', !/Signature and a Date field/.test(envI.body()));
  envI.input('esignFieldsConfirmed').checked = true;
  await envI.sandbox.esignSend();
  const sendCallI = envI.calls.find((c) => c.action === 'send');
  t('ui-advisory: sheet Send posts fieldsConfirmed:true', Boolean(sendCallI) && sendCallI.body.fieldsConfirmed === true);
  t('ui-advisory: sheet Send posts fieldsAdvisoryAccepted:true on an advisory envelope', Boolean(sendCallI) && sendCallI.body.fieldsAdvisoryAccepted === true);
  t('ui-advisory: sheet Send targets the prepared envelope', Boolean(sendCallI) && sendCallI.body.envelopeId === 'es_adv1');

  // (j) no native confirm (Nov 11): the native dialog is auto-dismissed
  // as Cancel in automated browsers, so esignSend must not call it —
  // the in-sheet checkbox is the send confirmation. Verified two ways:
  // statically (no confirm call in the esignSend source) and live (the
  // stub env above has NO confirm stub at all, yet the advisory Send
  // in (i) still posted its confirmations and completed).
  const sendFnSrc = uiSrc.slice(uiSrc.indexOf('window.esignSend'), uiSrc.indexOf('window.esignRefresh'));
  t('ui-noconfirm: esignSend source contains no native confirm call', sendFnSrc.length > 0 && !/confirm\s*\(/.test(sendFnSrc));
  t('ui-noconfirm: stub env exposes no confirm function', typeof envI.sandbox.confirm === 'undefined');
  t('ui-noconfirm: sheet Send completed without a confirm stub (advisory confirmations posted)', Boolean(sendCallI) && sendCallI.body.fieldsConfirmed === true && sendCallI.body.fieldsAdvisoryAccepted === true);

  // (k) duplicate-guard reopen (Nov 11 late): the sheet used to
  // dead-end on the 409 error text ("Could not load the signature
  // sheet: A contract for this seller, template and price was already
  // prepared..."), so a reopened sheet could NEVER reach Send for an
  // already-prepared draft. The 409 now carries the existing envelope
  // and the sheet adopts it.
  const envK = makeEnv();
  envK.leads.push({ id: 'L7', state: 'IN', ghlContactId: 'C-dup' });
  await envK.sandbox.esignOpenSheet('L7');
  await envK.sandbox.esignPrepare();
  t('ui-reopen: duplicate 409 does NOT render the dead-end error', !/Could not load the signature sheet/.test(envK.body()));
  t('ui-reopen: reopened sheet shows the existing draft status', /Draft ready — not sent/.test(envK.body()));
  t('ui-reopen: Send button is reachable on the reopened draft', /Send for signature — real contract/.test(envK.body()));
  t('ui-reopen: reopened sheet shows the existing $100,003 contract', /\$100,003/.test(envK.body()));
  t('ui-reopen: reopening sends nothing', envK.sendCalls === 0);

  // (l) document-id capture (Nov 11 late — the ONLY blocker to the
  // sheet proof): the $100,003 Prepare created draft
  // 6af5283b7d64ba6637bb5979 in HL but the envelope stored NO
  // documentId, so Send refused ("The prepared draft has no HighLevel
  // document id"). Root causes, all verified live via the ghl CLI:
  // drafts carry NO links (links are minted at send — both live
  // drafts show links: []), so an id-less create response gives the
  // old links[0]/created.documentId capture nothing; the old
  // read-back then searched the list BY that empty id and could never
  // match; and the draft's grandTotal is 0.00, so price cannot match
  // either. The draft WAS in the list, newest-first, the whole time.
  // Fixtures below are the LIVE document shapes (ids/dates real).
  const DOC_100003 = { documentId: '6af5283b7d64ba6637bb5979', _id: '6af5283b7d64ba6637bb5979', name: 'AGREEMENT TO PURCHASE REAL ESTATE IN', status: 'draft', deleted: false, createdAt: '2026-11-12T02:45:15.969Z', updatedAt: '2026-11-12T02:45:16.692Z', links: [], fillableFields: [], recipients: [{ id: '6ZTlI8jcjEdRsO5UrBHX', contactName: 'TEST E-Sign Do Not Use', role: 'signer' }, { id: 'a4vyLnhwrRQn75dqek7k', contactName: 'Paula Thomas', role: 'signer' }] };
  const DOC_100002 = { documentId: '6af51ffd6edc2082d016e4d1', _id: '6af51ffd6edc2082d016e4d1', name: 'AGREEMENT TO PURCHASE REAL ESTATE IN', status: 'draft', deleted: false, createdAt: '2026-11-12T02:10:05.968Z', links: [], fillableFields: [], recipients: [{ id: '6ZTlI8jcjEdRsO5UrBHX', contactName: 'TEST E-Sign Do Not Use', role: 'signer' }, { id: 'a4vyLnhwrRQn75dqek7k', contactName: 'Paula Thomas', role: 'signer' }] };
  const DOC_SENT = { documentId: '6af51659e94c61f78742d9cb', _id: '6af51659e94c61f78742d9cb', name: 'AGREEMENT TO PURCHASE REAL ESTATE IN', status: 'viewed', deleted: false, createdAt: '2026-11-12T01:28:57.702Z', links: [{ documentId: '6af51659e94c61f78742d9cb', recipientId: 'qFBg9HS2LtXQg8mWjQuA' }], fillableFields: [], recipients: [{ id: 'qFBg9HS2LtXQg8mWjQuA', contactName: 'TEST E-Sign Do Not Use', role: 'signer' }] };
  const T_100003 = new Date('2026-11-12T02:45:16Z').getTime();
  // extraction: every plausible create-response field
  t('docid: top-level documentId extracted', esign.extractCreatedDocumentId({ documentId: 'D1', links: [] }) === 'D1');
  t('docid: _id fallback extracted', esign.extractCreatedDocumentId({ _id: 'D2', links: [] }) === 'D2');
  t('docid: nested data.documentId extracted', esign.extractCreatedDocumentId({ data: { documentId: 'D3' } }) === 'D3');
  t('docid: nested data._id extracted', esign.extractCreatedDocumentId({ data: { _id: 'D4' } }) === 'D4');
  t('docid: link documentId extracted (the old working path)', esign.extractCreatedDocumentId({ links: [{ recipientId: 'C1', documentId: 'D5' }] }) === 'D5');
  t('docid: data.links documentId extracted', esign.extractCreatedDocumentId({ data: { links: [{ documentId: 'D6' }] } }) === 'D6');
  t('docid: draft-shaped response (links: [], no id fields) -> empty, never invented', esign.extractCreatedDocumentId({ links: [], success: true }) === '');
  t('docid: null/garbage -> empty', esign.extractCreatedDocumentId(null) === '' && esign.extractCreatedDocumentId('x') === '');
  // list matching: name + seller recipient + window, newest first
  const hints100003 = { name: 'AGREEMENT TO PURCHASE REAL ESTATE IN', contactId: '6ZTlI8jcjEdRsO5UrBHX', notBeforeMs: T_100003 - 5 * 60 * 1000, notAfterMs: T_100003 + 15 * 60 * 1000 };
  t('docid: list match finds the $100,003 draft (live shape)', (esign.matchDraftInList([DOC_100003, DOC_100002, DOC_SENT], hints100003) || {}).documentId === '6af5283b7d64ba6637bb5979');
  t('docid: the $100,002 draft (35 min older) is outside the prepare window', (esign.matchDraftInList([DOC_100002], hints100003) || null) === null);
  t('docid: a sent/viewed document never matches (drafts only)', (esign.matchDraftInList([DOC_SENT], { name: hints100003.name, contactId: 'qFBg9HS2LtXQg8mWjQuA', notBeforeMs: 0 }) || null) === null);
  t('docid: a different seller contact never matches', (esign.matchDraftInList([DOC_100003], Object.assign({}, hints100003, { contactId: 'C-other' })) || null) === null);
  t('docid: an id claimed by another envelope is excluded', (esign.matchDraftInList([DOC_100003], Object.assign({}, hints100003, { excludeIds: ['6af5283b7d64ba6637bb5979'] })) || null) === null);
  t('docid: direct id match wins when the create response carried an id', (esign.matchDraftInList([DOC_100002, DOC_100003], { documentId: '6af51ffd6edc2082d016e4d1' }) || {}).documentId === '6af51ffd6edc2082d016e4d1');
  t('docid: a deleted draft never matches', (esign.matchDraftInList([Object.assign({}, DOC_100003, { deleted: true })], hints100003) || null) === null);
  // resolver: polls until the draft appears (eventual consistency)
  function listImplSequence(payloads) {
    let i = 0;
    return async function () {
      const p = payloads[Math.min(i, payloads.length - 1)]; i++;
      return { status: 200, text: JSON.stringify({ data: { documents: p } }) };
    };
  }
  const sleeps = [];
  const resPoll = await esign.resolveDraftDocument('T', hints100003, { impl: listImplSequence([[], [DOC_100002], [DOC_100003, DOC_100002]]), sleep: async function (ms) { sleeps.push(ms); }, delaysMs: [10, 10] });
  t('docid: resolver polls until the draft appears in the list', resPoll.documentId === '6af5283b7d64ba6637bb5979' && resPoll.draft && resPoll.draft.documentId === '6af5283b7d64ba6637bb5979');
  t('docid: resolver actually waited between reads', sleeps.length === 2);
  const resNone = await esign.resolveDraftDocument('T', hints100003, { impl: listImplSequence([[]]), sleep: async function () {}, delaysMs: [1, 1] });
  t('docid: resolver gives up empty (never invents an id)', resNone.documentId === '' && resNone.draft === null);
  const resThrow = await esign.resolveDraftDocument('T', hints100003, { impl: async function () { throw new Error('network down'); }, sleep: async function () {}, delaysMs: [] });
  t('docid: a failing list read resolves empty, does not throw', resThrow.documentId === '');
  // envelope store scan + claimed ids
  const fakeStore = {
    list: async function () { return { blobs: [{ key: 'envelope-a.json' }, { key: 'envelope-b.json' }, { key: 'envelope-c.json' }] }; },
    get: async function (k) {
      const all = {
        'envelope-a.json': JSON.stringify({ id: 'es_a', documentId: 'DOC-A' }),
        'envelope-b.json': JSON.stringify({ id: 'es_b', documentId: '' }),
        'envelope-c.json': 'not json',
      };
      return all[k] || null;
    },
  };
  const scanned = await esign.scanEnvelopes(fakeStore);
  t('docid: store scan reads envelopes and skips unreadable ones', scanned.length === 2 && scanned.some((e) => e.id === 'es_a'));
  t('docid: usedDocumentIds lists claimed ids, excluding self', JSON.stringify(esign.usedDocumentIds(scanned, 'es_x')) === JSON.stringify(['DOC-A']) && JSON.stringify(esign.usedDocumentIds(scanned, 'es_a')) === JSON.stringify([]));

  // handler export (Nov 11 live 502): module.exports overwrote exports.handler,
  // so Netlify reported "esign.handler is undefined or not exported".
  t('exports: handler is exported (Netlify runtime needs esign.handler)', typeof esign.handler === 'function');

  console.log(`\nesign-regression: ${pass} passed, ${fail} failed.`);
  if (fail) { console.error('Failures:\n- ' + failures.join('\n- ')); process.exit(1); }
})();

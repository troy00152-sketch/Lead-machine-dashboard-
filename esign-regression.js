// esign-regression.js — fixture tests for the in-dashboard e-sign build.
// Run: node esign-regression.js
// FIXTURE-ONLY: no live HighLevel calls, no live sends, no money, no Blobs.
// Covers the contract math, the Oct 9 fields guard, the state machine,
// the duplicate guard, DND handling, and the FREE-only constraint
// (no paid vendor may appear anywhere in the function code).
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

// ---- 5. fields-ready check — the Oct 9 guard ----
// Live Gatlin document shape (Nov 11 read): fillableFields [].
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
  t('fields-guard: empty fillableFields BLOCKS (Gatlin shape)', g.ready === false, JSON.stringify(g));
  t('fields-guard: empty-fields reason names the problem', /no fillable fields/i.test(g.reason || ''));
  // Live IN agreement shape: TextField + DateField, both recipients covered.
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
  t('fields-guard: all signers with Signature+Date passes', okDoc.ready === true, JSON.stringify(okDoc));
  const missingDate = JSON.parse(JSON.stringify(inDoc));
  missingDate.fillableFields = missingDate.fillableFields.filter((f) => f.id !== 'f5');
  const md = esign.fieldsReadyCheck(missingDate);
  t('fields-guard: one signer missing Date blocks and names them', md.ready === false && md.missing.some((m) => /Seller/.test(m) && /Date/.test(m)), JSON.stringify(md.missing));
  const missingSig = JSON.parse(JSON.stringify(inDoc));
  missingSig.fillableFields = missingSig.fillableFields.filter((f) => f.id !== 'f3');
  const ms = esign.fieldsReadyCheck(missingSig);
  t('fields-guard: one signer missing Signature blocks and names them', ms.ready === false && ms.missing.some((m) => /Troy Thomas/.test(m) && /Signature/.test(m)), JSON.stringify(ms.missing));
  const weird = JSON.parse(JSON.stringify(inDoc));
  weird.fillableFields.push({ id: 'f9', fieldId: 'mystery_field_9', type: 'QuantumField', recipient: 'a4vyLnhwrRQn75dqek7k' });
  const w = esign.fieldsReadyCheck(weird);
  t('fields-guard: unrecognized field type blocks, never passes on a guess', w.ready === false && w.unrecognized.includes('QuantumField'));
  const noRecipients = { fillableFields: inDoc.fillableFields, recipients: [] };
  t('fields-guard: no recipients + fields present passes (nothing to sign)', esign.fieldsReadyCheck(noRecipients).ready === true);
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
  const live = esign.buildSendTemplateBody({ templateId: 'T1', userId: 'U1', contactId: 'C1' });
  t('api: send body defaults sendDocument:true', live.sendDocument === true);
  const opp = esign.buildSendTemplateBody({ templateId: 'T1', userId: 'U1', contactId: 'C1', opportunityId: 'O1', sendDocument: false });
  t('api: opportunityId passes through when given', opp.opportunityId === 'O1');
  const doc = esign.buildSendDocumentBody({ documentId: 'D1', sentBy: 'U1', medium: 'email', ccRecipients: [{ id: 'T', email: 'troy00152@gmail.com' }] });
  t('api: send-document body carries documentId, sentBy, medium email, Troy CC', doc.documentId === 'D1' && doc.sentBy === 'U1' && doc.medium === 'email' && doc.ccRecipients.length === 1);
  t('api: no CC when none given', !('ccRecipients' in esign.buildSendDocumentBody({ documentId: 'D1', sentBy: 'U1' })));
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

console.log(`\nesign-regression: ${pass} passed, ${fail} failed.`);
if (fail) { console.error('Failures:\n- ' + failures.join('\n- ')); process.exit(1); }

// mail-regression.js — direct-mail postcard regression suite.
// FIXTURE-ONLY: no live Lob calls, no live HighLevel calls, no network,
// no credits, no money. Run:  node mail-regression.js   (exit 0 = all pass)
//
// Covers:
//   - per-piece prices + the $100/month hard cap (~110 postcards at $0.905)
//   - cap enforcement in runSend (allowed at 110, refused at 111, and
//     refused BEFORE any Lob call is made)
//   - test/live mode separation (body can never pick live; test key used
//     in test mode; missing test key fails closed)
//   - DND / dnc contacts are never mailed (Lob never called)
//   - address validation + deliverability gate (live blocks undeliverable,
//     test proceeds with a warning because test verification is simulated)
//   - confirm:true required
//   - template rendering (3 built-ins x 2 sizes, merge vars, preview vs
//     print back), custom-design validation
//   - webhook signature verification (both Lob schemes, tamper, stale,
//     missing secret) + event parsing
//   - template list/resolve helpers
'use strict';

const crypto = require('crypto');
const assert = require('assert');
const data = require('./netlify/functions/mail-templates-data.js');
const sendMod = require('./netlify/functions/mail-send.js');
const tplMod = require('./netlify/functions/mail-templates.js');
const hookMod = require('./netlify/functions/mail-webhook.js');

const T = sendMod._test;
const TH = tplMod._test;
const WH = hookMod._test;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log(`  PASS ${name}`); },
        (e) => { failed++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); },
      );
    }
    passed++;
    console.log(`  PASS ${name}`);
    return Promise.resolve();
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}: ${e.message}`);
    return Promise.resolve();
  }
}

// ---------- fake stores / transports ----------
function fakeStore() {
  const map = new Map();
  return {
    map,
    async setJSON(key, val) { map.set(key, JSON.parse(JSON.stringify(val))); },
    async get(key, opts) {
      if (!map.has(key)) return null;
      const v = map.get(key);
      return opts && opts.type === 'json' ? v : JSON.stringify(v);
    },
    async list({ prefix }) {
      const blobs = [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { blobs };
    },
  };
}

function makeFakeTransport({ deliverability = 'deliverable', hlContact = null } = {}) {
  const calls = { verify: 0, create: 0, tags: 0, get: 0, authUsed: [] };
  const postJson = async (url, { headers, body }) => {
    if (url.includes('/us_verifications')) {
      calls.verify++;
      calls.authUsed.push(headers.Authorization);
      return {
        status: 200,
        text: JSON.stringify({
          deliverability,
          components: {
            primary_line: '123 Main St', secondary_line: '', city: 'Indianapolis',
            state: 'IN', zip_code: '46201',
          },
        }),
      };
    }
    if (url.includes('/postcards')) {
      calls.create++;
      calls.authUsed.push(headers.Authorization);
      const parsed = JSON.parse(body);
      assert.ok(parsed.to && parsed.to.name, 'create payload needs a recipient');
      assert.ok(parsed.front && parsed.back, 'create payload needs front+back');
      assert.ok(['4x6', '6x9'].includes(parsed.size), 'create payload needs a size');
      assert.ok(parsed.metadata && parsed.metadata.source === 'command-center', 'metadata source');
      return { status: 200, text: JSON.stringify({ id: 'psc_test_abc123' }) };
    }
    if (url.includes('/tags')) {
      calls.tags++;
      return { status: 200, text: '{}' };
    }
    return { status: 404, text: '{}' };
  };
  const get = async (url) => {
    calls.get++;
    if (hlContact) return { status: 200, text: JSON.stringify({ contact: hlContact }) };
    return { status: 404, text: '{}' };
  };
  const put = async () => ({ status: 200, text: '{}' });
  return { calls, postJson, get, put };
}

function testEnv(over = {}) {
  return {
    mode: 'test',
    testKey: 'test_lob_key',
    liveKey: 'live_lob_key',
    capCents: 10000,
    hlToken: 'hl_token',
    mailSentDateFieldId: '',
    from: data.DEFAULT_FROM,
    ...over,
  };
}
function sendBody(over = {}) {
  return {
    ownerName: 'Test Owner',
    address1: '123 Main St',
    address2: '',
    city: 'Indianapolis',
    state: 'IN',
    zip: '46201',
    size: '4x6',
    templateId: 'cash-offer',
    confirm: true,
    ...over,
  };
}
const TEMPLATES_STATE = { activeId: 'cash-offer', customs: [] };
const FIXED_NOW = new Date('2026-11-11T15:00:00Z');

async function run() {
  console.log('== mail regression: prices + cap math ==');
  await check('4x6 price is $0.905 (90.5c)', () => assert.strictEqual(data.priceCentsFor('4x6'), 90.5));
  await check('6x9 price is $0.92 (92c)', () => assert.strictEqual(data.priceCentsFor('6x9'), 92));
  await check('unknown size has no price', () => assert.strictEqual(data.priceCentsFor('11x17'), null));
  await check('default cap is $100 (10000c)', () => assert.strictEqual(data.MONTHLY_CAP_CENTS, 10000));
  await check('110 postcards at $0.905 fit the cap (9955c)', () => {
    assert.ok(110 * 90.5 <= 10000);
    assert.ok(111 * 90.5 > 10000);
  });
  await check('monthKey is YYYY-MM (UTC)', () => {
    assert.strictEqual(data.monthKey(new Date('2026-11-11T15:00:00Z')), '2026-11');
    assert.strictEqual(data.monthKey(new Date('2026-12-01T02:00:00Z')), '2026-12');
  });

  console.log('== mail regression: merge vars + templates ==');
  await check('applyMergeVars substitutes + escapes', () => {
    const out = data.applyMergeVars('Hi {{ownerName}} at {{propertyAddress}}!', {
      ownerName: 'Tom & Jerry <b>', propertyAddress: '1 Main St',
    });
    assert.strictEqual(out, 'Hi Tom &amp; Jerry &lt;b&gt; at 1 Main St!');
  });
  await check('unknown merge var renders empty, not {{var}}', () => {
    assert.strictEqual(data.applyMergeVars('x{{nope}}y', {}), 'xy');
  });
  for (const t of data.BUILTIN_TEMPLATES) {
    for (const size of ['4x6', '6x9']) {
      await check(`render ${t.id} ${size}: phone + brand + vars, no {{ left`, () => {
        const r = data.renderBuiltin(t.id, size, {
          ownerName: 'Ada', propertyAddress: '9 Oak Ave',
          cityStateZip: 'Indianapolis, IN 46201', phone: data.PHONE, brand: data.BRAND,
        }, false);
        assert.ok(r && r.front && r.back, 'renders');
        assert.ok(r.front.includes('(203) 565-7810'), 'front has phone');
        assert.ok(r.back.includes('Ada'), 'back has owner name');
        assert.ok(r.back.includes('9 Oak Ave'), 'back has property');
        assert.ok(!r.front.includes('{{') && !r.back.includes('{{'), 'no unmerged vars');
        assert.ok(!r.back.includes('Recipient address'), 'print back leaves the address area blank');
      });
      await check(`preview ${t.id} ${size}: shows address placeholder`, () => {
        const r = data.renderBuiltin(t.id, size, data.defaultMergeVars(), true);
        assert.ok(r.back.includes('Recipient address'), 'preview back marks the address area');
      });
    }
  }
  await check('renderBuiltin rejects unknown template/size', () => {
    assert.strictEqual(data.renderBuiltin('nope', '4x6', {}, false), null);
    assert.strictEqual(data.renderBuiltin('cash-offer', '11x17', {}, false), null);
  });
  await check('listBuiltins returns 3 designs', () => {
    assert.strictEqual(data.listBuiltins().length, 3);
    assert.ok(data.listBuiltins().every((t) => t.builtin === true));
  });
  await check('validateCustomSource accepts tpl_ id', () => {
    assert.deepStrictEqual(data.validateCustomSource('tpl_abc123'), { ok: true, kind: 'lob-template' });
  });
  await check('validateCustomSource accepts https PDF/PNG/JPG', () => {
    assert.strictEqual(data.validateCustomSource('https://example.com/art.pdf').ok, true);
    assert.strictEqual(data.validateCustomSource('https://example.com/art.png?v=2').ok, true);
    assert.strictEqual(data.validateCustomSource('https://example.com/art.jpg').ok, true);
  });
  await check('validateCustomSource accepts raw HTML', () => {
    assert.deepStrictEqual(data.validateCustomSource('<html>hi</html>'), { ok: true, kind: 'html' });
  });
  await check('validateCustomSource rejects garbage / http / empty', () => {
    assert.strictEqual(data.validateCustomSource('just some words').ok, false);
    assert.strictEqual(data.validateCustomSource('http://example.com/art.pdf').ok, false);
    assert.strictEqual(data.validateCustomSource('').ok, false);
    assert.strictEqual(data.validateCustomSource('tpl-abc').ok, false);
  });

  console.log('== mail regression: address + deliverability ==');
  await check('validAddress accepts a full US address', () => {
    assert.strictEqual(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'IN', zip: '46201' }), null);
    assert.strictEqual(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'IN', zip: '46201-1234' }), null);
  });
  await check('validAddress rejects missing pieces', () => {
    assert.ok(T.validAddress({ city: 'Indy', state: 'IN', zip: '46201' }));
    assert.ok(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'Indiana', zip: '46201' }));
    assert.ok(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'IN', zip: '4620' }));
  });
  await check('deliverabilityOk accepts deliverable variants only', () => {
    assert.ok(T.deliverabilityOk('deliverable'));
    assert.ok(T.deliverabilityOk('deliverable_unnecessary_unit'));
    assert.ok(T.deliverabilityOk('deliverable_incorrect_unit'));
    assert.ok(!T.deliverabilityOk('undeliverable'));
    assert.ok(!T.deliverabilityOk('deliverable_missing_unit'));
    assert.ok(!T.deliverabilityOk(''));
  });
  await check('idempotencyKey is stable + sanitized', () => {
    const k = T.idempotencyKey({ contactId: 'abc 123', size: '4x6', templateId: 'cash-offer', dateStr: '2026-11-11' });
    assert.strictEqual(k, 'dpb-abc-123-2026-11-11-4x6-cash-offer');
  });

  console.log('== mail regression: send pipeline (fixtures) ==');
  await check('test-mode send succeeds, uses TEST key, logs + tags', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.lobId, 'psc_test_abc123');
    assert.strictEqual(r.body.costCents, 90.5);
    assert.strictEqual(r.body.testMode, true);
    assert.strictEqual(r.body.monthSpentCents, 90.5);
    assert.strictEqual(tr.calls.verify, 1);
    assert.strictEqual(tr.calls.create, 1);
    // The test key — never the live key — went over the wire.
    const expectedAuth = 'Basic ' + Buffer.from('test_lob_key:', 'utf8').toString('base64');
    assert.ok(tr.calls.authUsed.every((a) => a === expectedAuth), 'only the test key was used');
    const entry = await store.get('sends/2026-11/psc_test_abc123.json', { type: 'json' });
    assert.ok(entry && entry.templateId === 'cash-offer' && entry.mode === 'test');
  });
  await check('send with a clean HL contact tags mailed + mail-postcard', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport({
      hlContact: { id: 'c1', contactName: 'Clean Owner', address1: '123 Main St', city: 'Indianapolis', state: 'IN', postalCode: '46201', tags: [], dnd: false },
    });
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ contactId: 'c1', ownerName: '', address1: '', city: '', state: '', zip: '' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.hlTagged, true);
    assert.strictEqual(tr.calls.tags, 1);
    assert.strictEqual(tr.calls.get, 1);
  });
  await check('dnc-tagged contact is refused and Lob is NEVER called', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport({
      hlContact: { id: 'c2', contactName: 'Opted Out', tags: ['dnc'], dnd: false },
    });
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ contactId: 'c2' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.ok(/opted out/i.test(r.body.error));
    assert.strictEqual(tr.calls.verify, 0);
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('DND-active contact is refused and Lob is NEVER called', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport({
      hlContact: { id: 'c3', contactName: 'DND Owner', tags: [], dnd: true },
    });
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ contactId: 'c3' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('confirm:false refuses before any Lob call', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ confirm: false }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(tr.calls.verify, 0);
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('missing test key fails closed (503, no Lob call)', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv({ testKey: '' }),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 503);
    assert.ok(/LOB_TEST_API_KEY/.test(r.body.error));
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('unknown template refuses before any Lob call', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ templateId: 'nope' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('110th postcard fits the cap, 111th is refused BEFORE Lob', async () => {
    const store = fakeStore();
    // Seed 110 sends at 90.5c = 9955c spent.
    for (let i = 0; i < 110; i++) {
      await store.setJSON(`sends/2026-11/psc_seed_${i}.json`, { lobId: `psc_seed_${i}`, costCents: 90.5, month: '2026-11' });
    }
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 402, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'monthly_cap_reached');
    assert.strictEqual(tr.calls.verify, 0, 'cap check runs before verification');
    assert.strictEqual(tr.calls.create, 0, 'cap check runs before the Lob create');
  });
  await check('110th postcard (109 seeded) is allowed', async () => {
    const store = fakeStore();
    for (let i = 0; i < 109; i++) {
      await store.setJSON(`sends/2026-11/psc_seed_${i}.json`, { lobId: `psc_seed_${i}`, costCents: 90.5, month: '2026-11' });
    }
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.monthSpentCents, 9955);
  });
  await check('undeliverable blocks in LIVE mode, never creates', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport({ deliverability: 'undeliverable' });
    const r = await T.runSend({
      env: testEnv({ mode: 'live' }),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.ok(/undeliverable/i.test(r.body.error));
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('undeliverable proceeds in TEST mode with a warning (simulated verification)', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport({ deliverability: 'undeliverable' });
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.verificationWarning, 'warning recorded');
    assert.strictEqual(tr.calls.create, 1);
  });
  await check('6x9 send costs 92c', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ size: '6x9' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.costCents, 92);
  });

  console.log('== mail regression: templates function helpers ==');
  await check('listTemplates merges built-ins + customs, keeps activeId', () => {
    const out = TH.listTemplates({
      activeId: 'custom_x',
      customs: [{ id: 'custom_x', name: 'My Card', front: 'tpl_a', back: 'tpl_b' }],
    });
    assert.strictEqual(out.templates.length, 4);
    assert.strictEqual(out.activeId, 'custom_x');
    assert.strictEqual(out.templates[3].builtin, false);
  });
  await check('listTemplates falls back to cash-offer on unknown activeId', () => {
    assert.strictEqual(TH.listTemplates({ activeId: 'nope', customs: [] }).activeId, 'cash-offer');
  });
  await check('resolveTemplate finds builtin, custom, and rejects unknown', () => {
    const state = { activeId: 'cash-offer', customs: [{ id: 'custom_x', name: 'My Card', front: 'tpl_a', back: 'tpl_b' }] };
    assert.strictEqual(TH.resolveTemplate(state, 'sell-fast').kind, 'builtin');
    assert.strictEqual(TH.resolveTemplate(state, 'custom_x').kind, 'custom');
    assert.strictEqual(TH.resolveTemplate(state, 'nope'), null);
    assert.strictEqual(TH.resolveTemplate(state, null).id, 'cash-offer');
  });

  console.log('== mail regression: webhook signature + events ==');
  const secret = 'whsec_test';
  const rawBody = '{"event_type":"postcard.delivered","body":{"id":"psc_1","object":"postcard","metadata":{"contactId":"c1"}}}';
  const nowMs = 1762880000000; // fixed "now" for deterministic signatures
  const ts = Math.floor(nowMs / 1000);
  await check('Lob-Signature scheme verifies', () => {
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
    const r = WH.verifySignature({
      headers: { 'lob-signature': `t=${ts},v1=${sig}` },
      rawBody, secret, nowMs,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.scheme, 'lob');
  });
  await check('tampered body fails Lob-Signature', () => {
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
    const r = WH.verifySignature({
      headers: { 'lob-signature': `t=${ts},v1=${sig}` },
      rawBody: rawBody + ' ', secret, nowMs,
    });
    assert.strictEqual(r.ok, false);
  });
  await check('stale timestamp (>5 min) fails', () => {
    const oldTs = ts - 301;
    const sig = crypto.createHmac('sha256', secret).update(`${oldTs}.${rawBody}`, 'utf8').digest('hex');
    const r = WH.verifySignature({
      headers: { 'lob-signature': `t=${oldTs},v1=${sig}` },
      rawBody, secret, nowMs,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'stale_timestamp');
  });
  await check('Standard Webhooks scheme verifies', () => {
    const id = 'msg_abc';
    const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${rawBody}`, 'utf8').digest('base64');
    const r = WH.verifySignature({
      headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` },
      rawBody, secret, nowMs,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.scheme, 'standard-webhooks');
  });
  await check('missing secret rejects everything (fail-closed)', () => {
    const r = WH.verifySignature({ headers: { 'lob-signature': 't=1,v1=abc' }, rawBody, secret: '', nowMs });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_secret');
  });
  await check('no signature header fails', () => {
    const r = WH.verifySignature({ headers: {}, rawBody, secret, nowMs });
    assert.strictEqual(r.ok, false);
  });
  await check('parseLobEvent reads delivered + contactId from metadata', () => {
    const p = WH.parseLobEvent(JSON.parse(rawBody));
    assert.strictEqual(p.eventType, 'postcard.delivered');
    assert.strictEqual(p.lobId, 'psc_1');
    assert.strictEqual(p.contactId, 'c1');
  });
  await check('parseLobEvent tolerates type + top-level resource', () => {
    const p = WH.parseLobEvent({ type: 'postcard.returned_to_sender', id: 'psc_2', metadata: {} });
    assert.strictEqual(p.eventType, 'postcard.returned_to_sender');
    assert.strictEqual(p.lobId, 'psc_2');
  });

  console.log('');
  if (failed) {
    console.log(`RESULT: ${passed} passed, ${failed} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`RESULT: ${passed} passed, 0 failed`);
}

run().catch((e) => {
  console.error('Suite crashed:', e);
  process.exit(1);
});

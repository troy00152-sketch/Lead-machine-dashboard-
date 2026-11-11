// mail-regression.js — direct-mail postcard regression suite (PostGrid).
// FIXTURE-ONLY: no live PostGrid calls, no live HighLevel calls, no network,
// no credits, no money. Run:  node mail-regression.js   (exit 0 = all pass)
//
// Covers:
//   - per-piece prices + the $100/month hard cap (~110 postcards at $0.902)
//   - cap enforcement in runSend (allowed at 110, refused at 111, and
//     refused BEFORE any PostGrid call is made)
//   - test/live mode separation (body can never pick live; test key used
//     in test mode; missing test key fails closed)
//   - DND / dnc contacts are never mailed (PostGrid never called)
//   - address validation (missing/incomplete fields refuse before any
//     PostGrid call; no paid verification API is used)
//   - same-day duplicate guard (409 duplicate_send, PostGrid called once)
//   - confirm:true required
//   - template rendering (3 built-ins x 2 sizes, merge vars, preview vs
//     print back), custom-design validation (PostGrid template / PDF /
//     image / HTML) + PostGrid payload variants
//   - webhook signature verification (JWT scheme, JSON + PostGrid-Signature
//     scheme, tamper, stale, missing secret) + event parsing
//   - template list/resolve helpers
//   - Blobs context (Nov 11 prod bug): getStore() without connectLambda
//     throws in production and 503'd the whole Send Mail sheet; the
//     template list + status read now survive a dead Blobs client
'use strict';

const crypto = require('crypto');
const assert = require('assert');
const fs = require('fs');
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

function makeFakeTransport({ hlContact = null } = {}) {
  const calls = { create: 0, tags: 0, get: 0, authUsed: [], lastPayload: null };
  const postJson = async (url, { headers, body }) => {
    if (url.includes('/postcards')) {
      calls.create++;
      calls.authUsed.push(headers['X-API-Key']);
      const parsed = JSON.parse(body);
      calls.lastPayload = parsed;
      assert.ok(parsed.to && parsed.to.firstName, 'create payload needs a recipient firstName');
      assert.ok(parsed.to.addressLine1, 'create payload needs addressLine1');
      assert.ok(parsed.to.city && parsed.to.provinceOrState && parsed.to.postalOrZip, 'create payload needs city/state/zip');
      assert.ok(parsed.from && parsed.from.companyName, 'create payload needs a from company');
      assert.ok(['6x4', '9x6'].includes(parsed.size), 'PostGrid size must be 6x4 or 9x6, got ' + parsed.size);
      assert.strictEqual(parsed.mailingClass, 'first_class', 'mailingClass is first_class');
      assert.ok(parsed.metadata && parsed.metadata.source === 'command-center', 'metadata source');
      const hasHtml = parsed.frontHTML && parsed.backHTML;
      const hasTpl = parsed.frontTemplate && parsed.backTemplate;
      const hasPdf = !!parsed.pdf;
      assert.ok(hasHtml || hasTpl || hasPdf, 'create payload needs HTML, templates, or a PDF');
      if (hasTpl) assert.ok(parsed.mergeVariables, 'template send passes mergeVariables');
      return { status: 200, text: JSON.stringify({ id: 'postcard_test_abc123', live: false, status: 'ready' }) };
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
    testKey: 'test_sk_postgrid',
    liveKey: 'live_sk_postgrid',
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

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(secret, payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`, 'utf8').digest());
  return `${header}.${body}.${sig}`;
}

async function run() {
  console.log('== mail regression: prices + cap math ==');
  await check('4x6 price is $0.902 (90.2c)', () => assert.strictEqual(data.priceCentsFor('4x6'), 90.2));
  await check('6x9 price is $1.023 (102.3c)', () => assert.strictEqual(data.priceCentsFor('6x9'), 102.3));
  await check('unknown size has no price', () => assert.strictEqual(data.priceCentsFor('11x17'), null));
  await check('default cap is $100 (10000c)', () => assert.strictEqual(data.MONTHLY_CAP_CENTS, 10000));
  await check('110 postcards at $0.902 fit the cap (9922c)', () => {
    assert.ok(110 * 90.2 <= 10000);
    assert.ok(111 * 90.2 > 10000);
  });
  await check('97 6x9 postcards fit the cap, 98 do not', () => {
    assert.ok(97 * 102.3 <= 10000);
    assert.ok(98 * 102.3 > 10000);
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
  await check('validateCustomSource accepts PostGrid template id', () => {
    assert.deepStrictEqual(data.validateCustomSource('template_abc123'), { ok: true, kind: 'postgrid-template' });
  });
  await check('validateCustomSource accepts https PDF (pdf-url)', () => {
    assert.deepStrictEqual(data.validateCustomSource('https://example.com/art.pdf'), { ok: true, kind: 'pdf-url' });
  });
  await check('validateCustomSource accepts https PNG/JPG (image-url)', () => {
    assert.deepStrictEqual(data.validateCustomSource('https://example.com/art.png?v=2'), { ok: true, kind: 'image-url' });
    assert.deepStrictEqual(data.validateCustomSource('https://example.com/art.jpg'), { ok: true, kind: 'image-url' });
  });
  await check('validateCustomSource accepts raw HTML', () => {
    assert.deepStrictEqual(data.validateCustomSource('<html>hi</html>'), { ok: true, kind: 'html' });
  });
  await check('validateCustomSource rejects garbage / http / empty / old tpl_ id', () => {
    assert.strictEqual(data.validateCustomSource('just some words').ok, false);
    assert.strictEqual(data.validateCustomSource('http://example.com/art.pdf').ok, false);
    assert.strictEqual(data.validateCustomSource('').ok, false);
    assert.strictEqual(data.validateCustomSource('tpl_abc123').ok, false);
    assert.strictEqual(data.validateCustomSource('template-abc').ok, false);
  });

  console.log('== mail regression: address + PostGrid contact shape ==');
  await check('validAddress accepts a full US address', () => {
    assert.strictEqual(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'IN', zip: '46201' }), null);
    assert.strictEqual(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'IN', zip: '46201-1234' }), null);
  });
  await check('validAddress rejects missing pieces', () => {
    assert.ok(T.validAddress({ city: 'Indy', state: 'IN', zip: '46201' }));
    assert.ok(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'Indiana', zip: '46201' }));
    assert.ok(T.validAddress({ address1: '1 Main St', city: 'Indy', state: 'IN', zip: '4620' }));
  });
  await check('postgridSize maps 4x6->6x4 and 6x9->9x6', () => {
    assert.strictEqual(T.postgridSize('4x6'), '6x4');
    assert.strictEqual(T.postgridSize('6x9'), '9x6');
  });
  await check('splitOwnerName splits first/last, falls back to Homeowner', () => {
    assert.deepStrictEqual(T.splitOwnerName('Ada Lovelace'), { firstName: 'Ada', lastName: 'Lovelace' });
    assert.deepStrictEqual(T.splitOwnerName('Madonna'), { firstName: 'Madonna', lastName: '' });
    assert.deepStrictEqual(T.splitOwnerName(''), { firstName: 'Homeowner', lastName: '' });
  });
  await check('buildPostGridContact uses PostGrid field names', () => {
    const c = T.buildPostGridContact('Ada Lovelace', { address1: '1 Main St', address2: '', city: 'Indy', state: 'in', zip: '46201' });
    assert.strictEqual(c.firstName, 'Ada');
    assert.strictEqual(c.lastName, 'Lovelace');
    assert.strictEqual(c.addressLine1, '1 Main St');
    assert.strictEqual(c.provinceOrState, 'IN');
    assert.strictEqual(c.postalOrZip, '46201');
    assert.strictEqual(c.countryCode, 'US');
    assert.ok(!('address_line1' in c) && !('name' in c), 'no legacy snake_case fields');
  });
  await check('imageArtHtml wraps the URL and escapes quotes', () => {
    const h = T.imageArtHtml('https://example.com/a"b.png');
    assert.ok(h.includes('<img src="https://example.com/a%22b.png">'));
  });
  await check('idempotencyKey is stable + sanitized', () => {
    const k = T.idempotencyKey({ contactId: 'abc 123', size: '4x6', templateId: 'cash-offer', dateStr: '2026-11-11' });
    assert.strictEqual(k, 'dpb-abc-123-2026-11-11-4x6-cash-offer');
  });

  console.log('== mail regression: send pipeline (fixtures) ==');
  await check('test-mode send succeeds, uses TEST key via X-API-Key, logs + tags', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.postgridId, 'postcard_test_abc123');
    assert.strictEqual(r.body.costCents, 90.2);
    assert.strictEqual(r.body.testMode, true);
    assert.strictEqual(r.body.monthSpentCents, 90.2);
    assert.strictEqual(tr.calls.create, 1);
    // The test key — never the live key — went over the wire, as X-API-Key.
    assert.ok(tr.calls.authUsed.every((a) => a === 'test_sk_postgrid'), 'only the test key was used');
    assert.strictEqual(tr.calls.lastPayload.size, '6x4', '4x6 dashboard size maps to PostGrid 6x4');
    assert.ok(tr.calls.lastPayload.frontHTML && tr.calls.lastPayload.backHTML, 'HTML variant sent');
    const entry = await store.get('sends/2026-11/postcard_test_abc123.json', { type: 'json' });
    assert.ok(entry && entry.templateId === 'cash-offer' && entry.mode === 'test');
  });
  await check('body can never pick live: mode=live in body still uses the test key', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ mode: 'live' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.testMode, true);
    assert.ok(tr.calls.authUsed.every((a) => a === 'test_sk_postgrid'));
  });
  await check('live env uses the LIVE key', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv({ mode: 'live' }),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.testMode, false);
    assert.ok(tr.calls.authUsed.every((a) => a === 'live_sk_postgrid'));
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
    assert.strictEqual(tr.calls.lastPayload.to.firstName, 'Clean');
    assert.strictEqual(tr.calls.lastPayload.to.lastName, 'Owner');
  });
  await check('dnc-tagged contact is refused and PostGrid is NEVER called', async () => {
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
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('DND-active contact is refused and PostGrid is NEVER called', async () => {
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
  await check('confirm:false refuses before any PostGrid call', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ confirm: false }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('missing test key fails closed (503, no PostGrid call)', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv({ testKey: '' }),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 503);
    assert.ok(/POSTGRID_TEST_API_KEY/.test(r.body.error));
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('missing address fields refuse before any PostGrid call', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ address1: '', city: '', state: '', zip: '' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(tr.calls.create, 0);
  });
  await check('unknown template refuses before any PostGrid call', async () => {
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
  await check('110th postcard fits the cap, 111th is refused BEFORE PostGrid', async () => {
    const store = fakeStore();
    // Seed 110 sends at 90.2c = 9922c spent.
    for (let i = 0; i < 110; i++) {
      await store.setJSON(`sends/2026-11/postcard_seed_${i}.json`, { postgridId: `postcard_seed_${i}`, costCents: 90.2, month: '2026-11' });
    }
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 402, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'monthly_cap_reached');
    assert.strictEqual(tr.calls.create, 0, 'cap check runs before the PostGrid create');
  });
  await check('110th postcard (109 seeded) is allowed', async () => {
    const store = fakeStore();
    for (let i = 0; i < 109; i++) {
      await store.setJSON(`sends/2026-11/postcard_seed_${i}.json`, { postgridId: `postcard_seed_${i}`, costCents: 90.2, month: '2026-11' });
    }
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody(),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.monthSpentCents, 9922);
  });
  await check('same-day duplicate send is refused 409, PostGrid called once', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const deps = { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put };
    const first = await T.runSend({ env: testEnv(), body: sendBody(), deps });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await T.runSend({ env: testEnv(), body: sendBody(), deps });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body.code, 'duplicate_send');
    assert.strictEqual(tr.calls.create, 1, 'duplicate never reached PostGrid');
  });
  await check('6x9 send costs 102.3c and maps to PostGrid 9x6', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ size: '6x9' }),
      deps: { templatesState: TEMPLATES_STATE, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.costCents, 102.3);
    assert.strictEqual(tr.calls.lastPayload.size, '9x6');
  });
  await check('custom PostGrid-template design sends frontTemplate/backTemplate + mergeVariables', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const state = {
      activeId: 'custom_t',
      customs: [{ id: 'custom_t', name: 'My Card', front: 'template_aaa', back: 'template_bbb', kindFront: 'postgrid-template', kindBack: 'postgrid-template' }],
    };
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ templateId: 'custom_t' }),
      deps: { templatesState: state, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(tr.calls.lastPayload.frontTemplate, 'template_aaa');
    assert.strictEqual(tr.calls.lastPayload.backTemplate, 'template_bbb');
    assert.strictEqual(tr.calls.lastPayload.mergeVariables.ownerName, 'Test Owner');
  });
  await check('custom image design sends full-bleed HTML wrapping the image URLs', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const state = {
      activeId: 'custom_i',
      customs: [{ id: 'custom_i', name: 'Img Card', front: 'https://example.com/f.png', back: 'https://example.com/b.png', kindFront: 'image-url', kindBack: 'image-url' }],
    };
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ templateId: 'custom_i' }),
      deps: { templatesState: state, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(tr.calls.lastPayload.frontHTML.includes('https://example.com/f.png'));
    assert.ok(tr.calls.lastPayload.backHTML.includes('https://example.com/b.png'));
  });
  await check('custom PDF design sends one pdf when front == back', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const state = {
      activeId: 'custom_p',
      customs: [{ id: 'custom_p', name: 'PDF Card', front: 'https://example.com/card.pdf', back: 'https://example.com/card.pdf', kindFront: 'pdf-url', kindBack: 'pdf-url' }],
    };
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ templateId: 'custom_p' }),
      deps: { templatesState: state, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(tr.calls.lastPayload.pdf, 'https://example.com/card.pdf');
  });
  await check('mismatched PDF front/back is refused before PostGrid', async () => {
    const store = fakeStore();
    const tr = makeFakeTransport();
    const state = {
      activeId: 'custom_p2',
      customs: [{ id: 'custom_p2', name: 'PDF Card', front: 'https://example.com/a.pdf', back: 'https://example.com/b.pdf', kindFront: 'pdf-url', kindBack: 'pdf-url' }],
    };
    const r = await T.runSend({
      env: testEnv(),
      body: sendBody({ templateId: 'custom_p2' }),
      deps: { templatesState: state, store, now: FIXED_NOW, postJson: tr.postJson, get: tr.get, put: tr.put },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(tr.calls.create, 0);
  });

  console.log('== mail regression: templates function helpers ==');
  await check('listTemplates merges built-ins + customs, keeps activeId', () => {
    const out = TH.listTemplates({
      activeId: 'custom_x',
      customs: [{ id: 'custom_x', name: 'My Card', front: 'template_a', back: 'template_b' }],
    });
    assert.strictEqual(out.templates.length, 4);
    assert.strictEqual(out.activeId, 'custom_x');
    assert.strictEqual(out.templates[3].builtin, false);
  });
  await check('listTemplates falls back to cash-offer on unknown activeId', () => {
    assert.strictEqual(TH.listTemplates({ activeId: 'nope', customs: [] }).activeId, 'cash-offer');
  });
  await check('resolveTemplate finds builtin, custom, and rejects unknown', () => {
    const state = { activeId: 'cash-offer', customs: [{ id: 'custom_x', name: 'My Card', front: 'template_a', back: 'template_b' }] };
    assert.strictEqual(TH.resolveTemplate(state, 'sell-fast').kind, 'builtin');
    assert.strictEqual(TH.resolveTemplate(state, 'custom_x').kind, 'custom');
    assert.strictEqual(TH.resolveTemplate(state, 'nope'), null);
    assert.strictEqual(TH.resolveTemplate(state, null).id, 'cash-offer');
  });

  console.log('== mail regression: webhook signature + events ==');
  const secret = 'whsec_test';
  const nowMs = 1762880000000; // fixed "now" for deterministic signatures
  const ts = Math.floor(nowMs / 1000);
  const jwtBody = {
    type: 'postcard.updated',
    createdAt: '2026-11-11T15:00:00Z',
    iat: ts,
    exp: ts + 300,
    data: {
      id: 'postcard_1', object: 'postcard', status: 'completed',
      metadata: { contactId: 'c1', templateId: 'cash-offer', source: 'command-center' },
    },
  };
  await check('JWT scheme verifies and returns the payload', () => {
    const token = makeJwt(secret, jwtBody);
    const r = WH.verifySignature({ headers: {}, rawBody: token, secret, nowMs });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.scheme, 'jwt');
    assert.strictEqual(r.payload.type, 'postcard.updated');
    assert.strictEqual(r.payload.data.id, 'postcard_1');
  });
  await check('tampered JWT payload fails', () => {
    const token = makeJwt(secret, jwtBody);
    const parts = token.split('.');
    const bad = `${parts[0]}.${b64url(JSON.stringify({ ...jwtBody, type: 'postcard.created' }))}.${parts[2]}`;
    const r = WH.verifySignature({ headers: {}, rawBody: bad, secret, nowMs });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'signature_mismatch');
  });
  await check('expired JWT (exp in the past) fails stale', () => {
    const token = makeJwt(secret, { ...jwtBody, exp: ts - 10 });
    const r = WH.verifySignature({ headers: {}, rawBody: token, secret, nowMs });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'stale_timestamp');
  });
  await check('JWT with a wrong secret fails', () => {
    const token = makeJwt('other_secret', jwtBody);
    const r = WH.verifySignature({ headers: {}, rawBody: token, secret, nowMs });
    assert.strictEqual(r.ok, false);
  });
  await check('JSON + PostGrid-Signature (hex) verifies', () => {
    const rawBody = '{"type":"postcard.created","data":{"id":"postcard_2","object":"postcard","status":"ready","metadata":{}}}';
    const sig = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const r = WH.verifySignature({
      headers: { 'postgrid-signature': sig },
      rawBody, secret, nowMs,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.scheme, 'postgrid-signature');
  });
  await check('JSON + tampered body fails PostGrid-Signature', () => {
    const rawBody = '{"type":"postcard.created","data":{"id":"postcard_2"}}';
    const sig = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const r = WH.verifySignature({
      headers: { 'postgrid-signature': sig },
      rawBody: rawBody + ' ', secret, nowMs,
    });
    assert.strictEqual(r.ok, false);
  });
  await check('missing secret rejects everything (fail-closed)', () => {
    const token = makeJwt(secret, jwtBody);
    const r = WH.verifySignature({ headers: {}, rawBody: token, secret: '', nowMs });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_secret');
  });
  await check('no signature header fails (plain JSON)', () => {
    const r = WH.verifySignature({ headers: {}, rawBody: '{"type":"postcard.updated"}', secret, nowMs });
    assert.strictEqual(r.ok, false);
  });
  await check('parsePostGridEvent reads completed + contactId from data.metadata', () => {
    const p = WH.parsePostGridEvent(jwtBody);
    assert.strictEqual(p.eventType, 'postcard.updated');
    assert.strictEqual(p.postgridId, 'postcard_1');
    assert.strictEqual(p.contactId, 'c1');
    assert.strictEqual(p.status, 'completed');
    assert.strictEqual(p.delivered, true);
    assert.strictEqual(p.returned, false);
  });
  await check('parsePostGridEvent flags returned_to_sender via imbStatus', () => {
    const p = WH.parsePostGridEvent({
      type: 'postcard.updated',
      data: { id: 'postcard_3', object: 'postcard', status: 'in_transit', imbStatus: 'returned_to_sender', metadata: {} },
    });
    assert.strictEqual(p.returned, true);
    assert.strictEqual(p.delivered, false);
  });
  await check('parsePostGridEvent flags delivery via carrierTracking.status', () => {
    const p = WH.parsePostGridEvent({
      type: 'postcard.updated',
      data: { id: 'postcard_4', object: 'postcard', status: 'in_transit', carrierTracking: { status: 'delivered' }, metadata: {} },
    });
    assert.strictEqual(p.delivered, true);
  });
  await check('parsePostGridEvent: created/ready is neither delivered nor returned', () => {
    const p = WH.parsePostGridEvent({
      type: 'postcard.created',
      data: { id: 'postcard_5', object: 'postcard', status: 'ready', metadata: {} },
    });
    assert.strictEqual(p.delivered, false);
    assert.strictEqual(p.returned, false);
  });
  await check('parsePostGridEvent tolerates event_type + top-level resource', () => {
    const p = WH.parsePostGridEvent({ event_type: 'postcard.created', id: 'postcard_6', metadata: {} });
    assert.strictEqual(p.eventType, 'postcard.created');
    assert.strictEqual(p.postgridId, 'postcard_6');
  });

  console.log('== mail regression: Blobs context (Nov 11 prod bug) ==');
  // PRODUCTION BUG, Nov 11: the live Send Mail sheet showed "Template
  // request failed. Nothing was changed." The mail functions called
  // blobs.getStore() WITHOUT blobs.connectLambda(event) first, so in the
  // Netlify Functions runtime getStore() throws
  // MissingBlobsEnvironmentError ("The environment has not been configured
  // to use Netlify Blobs..."). The working functions (buyer-verify,
  // deals-api) call connectLambda; the mail functions did not. These
  // tests inject fake Blobs clients that reproduce the exact production
  // failure mode and prove the sheet survives it.
  const blobsError = new Error('The environment has not been configured to use Netlify Blobs. To use it manually, supply the following properties when creating a store: siteID, token');
  const throwingBlobs = { connectLambda: () => {}, getStore: () => { throw blobsError; } };
  const throwingConnectBlobs = {
    connectLambda: () => { throw new Error('no blobs field on event'); },
    getStore: () => fakeStore(),
  };
  function recordingBlobs(store) {
    let seenEvent = null;
    return {
      seen: () => seenEvent,
      connectLambda: (ev) => { seenEvent = ev; },
      getStore: () => store,
    };
  }
  const listEvent = { httpMethod: 'GET', queryStringParameters: { action: 'list' }, headers: {} };
  function adminStatusEvent() {
    const secret = 'test-gate-secret';
    process.env.DASHBOARD_PASSWORD = secret;
    const expiry = String(Math.floor(Date.now() / 1000) + 3600);
    const sig = crypto.createHmac('sha256', secret).update(expiry).digest('hex');
    return {
      httpMethod: 'GET',
      queryStringParameters: { action: 'status' },
      headers: { cookie: `lm_auth=${expiry}.${sig}` },
    };
  }
  await check('Blobs getStore throws (Nov 11 prod bug): template list still 200 with 3 built-ins', async () => {
    const prev = TH._setBlobs(throwingBlobs);
    try {
      const res = await tplMod.handler(listEvent);
      assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.templates.length, 3);
      assert.deepStrictEqual(body.templates.map((t) => t.name), ['We Buy Houses for Cash', 'Need to Sell Fast?', 'Inherited a Home?']);
      assert.strictEqual(body.activeId, 'cash-offer');
    } finally {
      TH._setBlobs(prev);
    }
  });
  await check('template list calls connectLambda with the Lambda event before getStore', async () => {
    const rec = recordingBlobs(fakeStore());
    const prev = TH._setBlobs(rec);
    try {
      const res = await tplMod.handler(listEvent);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(rec.seen(), listEvent, 'connectLambda did not receive the handler event');
    } finally {
      TH._setBlobs(prev);
    }
  });
  await check('connectLambda throwing does not break the template list', async () => {
    const prev = TH._setBlobs(throwingConnectBlobs);
    try {
      const res = await tplMod.handler(listEvent);
      assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
      assert.strictEqual(JSON.parse(res.body).templates.length, 3);
    } finally {
      TH._setBlobs(prev);
    }
  });
  await check('Blobs getStore throws: mail-send status still 200 with zero spend', async () => {
    const prev = T._setBlobs(throwingBlobs);
    try {
      const res = await sendMod.handler(adminStatusEvent());
      assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.spentCents, 0);
      assert.strictEqual(body.count, 0);
      assert.strictEqual(body.postgridConnected, false);
      assert.strictEqual(body.prices['4x6'], 90.2);
      assert.strictEqual(body.prices['6x9'], 102.3);
    } finally {
      T._setBlobs(prev);
      delete process.env.DASHBOARD_PASSWORD;
    }
  });
  await check('mail-send status calls connectLambda with the Lambda event', async () => {
    const rec = recordingBlobs(fakeStore());
    const prev = T._setBlobs(rec);
    try {
      const ev = adminStatusEvent();
      const res = await sendMod.handler(ev);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(rec.seen(), ev, 'connectLambda did not receive the handler event');
    } finally {
      T._setBlobs(prev);
      delete process.env.DASHBOARD_PASSWORD;
    }
  });
  await check('webhook getLogStoreFor never throws with a throwing Blobs client', () => {
    const prev = WH._setBlobs(throwingBlobs);
    try {
      assert.strictEqual(WH.getLogStoreFor({}), null);
    } finally {
      WH._setBlobs(prev);
    }
  });
  await check('mail.js sheet survives a failed status read (allSettled + fallback)', () => {
    const src = fs.readFileSync(`${__dirname}/assets/mail.js`, 'utf8');
    assert.ok(src.includes('allSettled'), 'mail.js must load templates + status with allSettled');
    assert.ok(src.includes('statusUnavailable'), 'mail.js must fall back when the status read fails');
  });
  await check('real @netlify/blobs: bare getStore throws without context (prod repro)', () => {
    let realBlobs;
    try {
      realBlobs = require('@netlify/blobs');
    } catch (e) {
      console.log('    (SKIP — @netlify/blobs not installed in this env)');
      return;
    }
    assert.throws(
      () => realBlobs.getStore('direct-mail-templates'),
      /not been configured to use Netlify Blobs/,
    );
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

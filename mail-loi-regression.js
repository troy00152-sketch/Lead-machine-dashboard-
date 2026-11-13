// mail-loi-regression.js — LOI letter channel regression suite (PostGrid).
// FIXTURE-ONLY: no live PostGrid calls, no live HighLevel calls, no network,
// no credits, no money. Run:  node mail-loi-regression.js  (exit 0 = all pass)
//
// Covers the DealBreeze-takeaways LOI build (Nov 13, 2026):
//   - listing gate fails CLOSED (missing/false verified flag -> 409,
//     PostGrid never called) — unverified is never treated as cleared
//   - confirm:true required; admin auth required
//   - test/live mode separation (env only; test key used in test mode)
//   - DND / dnc contacts never mailed
//   - offer figure cross-checked against the CRM LAO (mismatch -> 409)
//   - $100/month cap shared with postcards (refused BEFORE any PostGrid call)
//   - same-day duplicate guard
//   - template rendering: real numbers in, blanks refused
'use strict';

process.env.DASHBOARD_PASSWORD = 'test-pw';

const assert = require('assert');
const tpl = require('./netlify/functions/mail-loi-template.js');
const loi = require('./netlify/functions/mail-loi.js');
const T = loi._test;

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

const AUTH = { authorization: 'Bearer ' + 'test-pw' };
const NOW = () => new Date('2026-11-13T15:00:00Z');

function baseEnv(over = {}) {
  return {
    mode: 'test', testKey: 'test_sk_x', liveKey: '',
    capCents: 10000, loiPriceCents: 200, hlToken: 'hltok', laoFieldId: '',
    from: { ...tpl.DEFAULT_FROM },
    ...over,
  };
}
function mockStore(seed = []) {
  const map = new Map(seed.map((e) => [`sends/${e.month}/${e.postgridId}.json`, e]));
  return {
    map,
    async list({ prefix }) {
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
    async get(key) { return map.get(key) || null; },
    async setJSON(key, entry) { map.set(key, entry); },
  };
}
function event(body, headers = AUTH) {
  return { httpMethod: 'POST', headers, queryStringParameters: {}, body: JSON.stringify(body) };
}
const GOOD = {
  confirm: true, listingVerified: true, contactId: 'c1',
  ownerName: 'Jane Owner', address1: '1 Mail St', city: 'Indianapolis',
  state: 'IN', zip: '46222',
  propertyAddress: '955 Olin Ave, Indianapolis, IN 46222', offerAmount: 32657,
};
function deps(over = {}) {
  const calls = { postgrid: [], tags: [] };
  return {
    calls,
    env: baseEnv(),
    store: mockStore(),
    now: NOW,
    hlGetContact: async () => ({ id: 'c1', tags: [], customFields: [{ id: 'f-lao', key: 'contact.lao', value: '32657' }] }),
    postImpl: async (url, opts) => {
      calls.postgrid.push({ url, body: JSON.parse(opts.body) });
      return { status: 200, text: JSON.stringify({ id: 'letter_1', live: false, status: 'queued' }) };
    },
    hlAddTags: async (token, id, tags) => { calls.tags.push(tags); },
    ...over,
  };
}

(async () => {
  console.log('mail-loi regression');

  await check('template renders the real offer figure', () => {
    const html = tpl.renderLoi({
      ownerName: 'Jane Owner', mailingAddress: '1 Mail St',
      mailingCityStateZip: 'Indianapolis, IN 46222',
      propertyAddress: GOOD.propertyAddress, offerAmount: tpl.money(32657),
      letterDate: 'November 13, 2026',
    });
    assert.ok(html.includes('$32,657'));
    assert.ok(!/\{\{/.test(html));
  });

  await check('template refuses a blank offer (no blank-number letters)', () => {
    assert.throws(() => tpl.renderLoi({
      ownerName: 'Jane Owner', mailingAddress: '1 Mail St',
      mailingCityStateZip: 'Indianapolis, IN 46222',
      propertyAddress: GOOD.propertyAddress, offerAmount: '',
      letterDate: 'November 13, 2026',
    }), /missing/);
  });

  await check('unauthenticated request refused', async () => {
    const d = deps();
    const res = await T.handle(event(GOOD, {}), d);
    assert.equal(res.statusCode, 401);
    assert.equal(d.calls.postgrid.length, 0);
  });

  await check('confirm:true required', async () => {
    const d = deps();
    const res = await T.handle(event({ ...GOOD, confirm: false }), d);
    assert.equal(res.statusCode, 400);
    assert.equal(d.calls.postgrid.length, 0);
  });

  await check('LISTING GATE: unverified status refused, PostGrid never called', async () => {
    for (const flag of [undefined, false, 'unknown']) {
      const d = deps();
      const body = { ...GOOD };
      if (flag === undefined) delete body.listingVerified; else body.listingVerified = flag;
      const res = await T.handle(event(body), d);
      assert.equal(res.statusCode, 409, `flag=${flag}`);
      assert.equal(JSON.parse(res.body).code, 'listing_unverified');
      assert.equal(d.calls.postgrid.length, 0);
    }
  });

  await check('happy path (test mode): letter created, logged, tagged', async () => {
    const d = deps();
    const res = await T.handle(event(GOOD), d);
    const out = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(out.sent, true);
    assert.equal(out.testMode, true);
    assert.equal(d.calls.postgrid.length, 1);
    assert.ok(d.calls.postgrid[0].url.endsWith('/letters'));
    assert.ok(d.calls.postgrid[0].body.html.includes('$32,657'));
    assert.equal(d.calls.postgrid[0].body.metadata.kind, 'loi');
    assert.deepEqual(d.calls.tags[0], ['mailed', 'mail-loi', 'mailed-2026-11-13']);
    assert.equal(d.store.map.size, 1);
  });

  await check('body can never pick live mode; test key is used in test mode', async () => {
    const d = deps();
    const res = await T.handle(event({ ...GOOD, mode: 'live', MAIL_MODE: 'live' }), d);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).testMode, true);
  });

  await check('DND / dnc contact is never mailed', async () => {
    const d = deps({ hlGetContact: async () => ({ id: 'c1', tags: ['dnc'], customFields: [] }) });
    const res = await T.handle(event(GOOD), d);
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'contact_opted_out');
    assert.equal(d.calls.postgrid.length, 0);
  });

  await check('offer mismatch vs CRM LAO refused (letter carries the CRM number or none)', async () => {
    const d = deps();
    const res = await T.handle(event({ ...GOOD, offerAmount: 40000 }), d);
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'offer_mismatch');
    assert.equal(d.calls.postgrid.length, 0);
  });

  await check('monthly cap refused BEFORE any PostGrid call', async () => {
    const seed = [{ month: '2026-11', postgridId: 'pc1', costCents: 9900, idemKey: 'other' }];
    const d = deps({ store: mockStore(seed) });
    const res = await T.handle(event(GOOD), d);
    assert.equal(res.statusCode, 402);
    assert.equal(d.calls.postgrid.length, 0);
  });

  await check('same-day duplicate refused', async () => {
    const d = deps();
    const first = await T.handle(event(GOOD), d);
    assert.equal(first.statusCode, 200);
    const second = await T.handle(event(GOOD), d);
    assert.equal(second.statusCode, 409);
    assert.equal(JSON.parse(second.body).code, 'duplicate_send');
    assert.equal(d.calls.postgrid.length, 1);
  });

  await check('missing test key fails closed', async () => {
    const d = deps({ env: baseEnv({ testKey: '' }) });
    const res = await T.handle(event(GOOD), d);
    assert.equal(res.statusCode, 503);
    assert.equal(d.calls.postgrid.length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(failures.join('\n'));
  process.exit(failed ? 1 : 0);
})();

// workflows-builder-regression.js
// Regression for the standalone workflow builder: cc-workflows-api.js
// (admin auth, seed load, save/publish), cc-workflows-store.js
// (sanitize + locked-step preservation + override resolution), the
// engine patch in cc-workflow-engine.js (stored def wins, static
// fallback, drafts never send, guards hold under an override), and
// the workflows.html page + sidebar wiring.
//
// Run: node workflows-builder-regression.js
'use strict';

process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'wf-test-secret';
const SECRET = process.env.DASHBOARD_PASSWORD;

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cfg = require('./netlify/functions/cc-workflows-config');
const store = require('./netlify/functions/cc-workflows-store');
const api = require('./netlify/functions/cc-workflows-api');
const engine = require('./netlify/functions/cc-workflow-engine');

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS ' + name);
  } catch (e) {
    failed += 1;
    failures.push(name + ': ' + e.message);
    console.log('  FAIL ' + name + ' — ' + e.message);
  }
}

// ---- fake Blobs store (get/set/delete, {type:'json'} aware) ----
class FakeStore {
  constructor() { this.data = new Map(); }
  async get(key, opts) {
    if (!this.data.has(key)) return null;
    const v = this.data.get(key);
    return opts && opts.type === 'json' ? JSON.parse(v) : v;
  }
  async set(key, val) { this.data.set(key, String(val)); }
  async delete(key) { this.data.delete(key); }
}
const wfFake = new FakeStore();
const enFake = new FakeStore();
const convFake = new FakeStore();
store._test.setStoreFactory(() => wfFake);
engine._test.setStores({ enrollments: enFake, conversations: convFake });

const sent = [];
// The engine calls the injected sender with ONE object argument.
engine._test.setSendSms(async ({ market, to, body }) => {
  sent.push({ market, to, body });
  return { id: 'test-' + sent.length, from: '+14632783964' };
});
engine._test.setRandom(() => 0); // path A every time

// ---- auth cookies ----
function adminCookie() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return 'lm_auth=' + exp + '.' + sig;
}
function irishCookie() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', SECRET).update(exp + '.irish').digest('hex');
  return 'lm_irish=' + exp + '.irish.' + sig;
}
function callApi({ method = 'GET', action, id, body, cookie }) {
  const qs = {};
  if (action) qs.action = action;
  if (id) qs.id = id;
  return api.handler({
    httpMethod: method,
    headers: cookie ? { cookie } : {},
    queryStringParameters: qs,
    body: body ? JSON.stringify(body) : null,
  });
}
const bodyOf = (res) => JSON.parse(res.body);
// Snapshot of a seed value BEFORE any save runs (mutation check).
const SEED_INDY_A = cfg.WORKFLOWS.indianapolis.firstTexts.A;

// Monday Nov 16, 2026 in America/New_York (EST, UTC-5)
const MON_0930_ET = Date.UTC(2026, 10, 16, 14, 30, 0);
const MON_1200_ET = Date.UTC(2026, 10, 16, 17, 0, 0);

(async () => {
  console.log('— A. API auth —');
  await check('list without a cookie -> 401', async () => {
    const res = await callApi({ action: 'list' });
    assert.strictEqual(res.statusCode, 401);
  });
  await check('list with a bad cookie -> 401', async () => {
    const res = await callApi({ action: 'list', cookie: 'lm_auth=9999999999.deadbeef' });
    assert.strictEqual(res.statusCode, 401);
  });
  await check('list with the Irish calling-only cookie -> 403', async () => {
    const res = await callApi({ action: 'list', cookie: irishCookie() });
    assert.strictEqual(res.statusCode, 403);
  });
  await check('save without a cookie -> 401', async () => {
    const res = await callApi({ method: 'POST', body: { action: 'save', workflow: { id: 'carolina', tag: 'x' } } });
    assert.strictEqual(res.statusCode, 401);
  });

  console.log('— B. Seed load —');
  let seedList = null;
  await check('list returns the 5 market workflows', async () => {
    const res = await callApi({ action: 'list', cookie: adminCookie() });
    assert.strictEqual(res.statusCode, 200);
    seedList = bodyOf(res).workflows;
    assert.strictEqual(seedList.length, 5);
    assert.deepStrictEqual(seedList.map((w) => w.id), ['indianapolis', 'carolina', 'kansascity', 'cleveland', 'florida']);
  });
  await check('seed trigger tags match the HL mirror (cleveland is "oh sms")', async () => {
    const byId = Object.fromEntries(seedList.map((w) => [w.id, w]));
    assert.strictEqual(byId.indianapolis.tag, 'indianapolis sms');
    assert.strictEqual(byId.carolina.tag, 'carolina sms');
    assert.strictEqual(byId.kansascity.tag, 'kansas city sms');
    assert.strictEqual(byId.cleveland.tag, 'oh sms');
    assert.strictEqual(byId.florida.tag, 'florida sms');
  });
  await check('seeds resolve Published + source static', async () => {
    for (const w of seedList) {
      assert.strictEqual(w.status, 'published', w.id);
      assert.strictEqual(w.source, 'static', w.id);
    }
  });
  await check('get returns the seed definition verbatim', async () => {
    const res = await callApi({ action: 'get', id: 'carolina', cookie: adminCookie() });
    assert.strictEqual(res.statusCode, 200);
    const wf = bodyOf(res).workflow;
    assert.strictEqual(wf.firstTexts.A, cfg.WORKFLOWS.carolina.firstTexts.A);
    assert.strictEqual(wf.badNumberGuard.tag, 'bad-number');
  });

  console.log('— C. Save round-trip + locked-step preservation —');
  await check('a hostile save cannot drop the locked steps', async () => {
    const hostile = JSON.parse(JSON.stringify(cfg.WORKFLOWS.indianapolis));
    hostile.name = 'Indianapolis SMS (edited)';
    hostile.firstTexts.A = 'EDITED {{first_name}} at {{address1}}';
    hostile.status = 'draft';
    hostile.badNumberGuard = null;          // try to remove the guard
    hostile.activeLeadTags = [];             // try to empty the gate
    hostile.activeLeadGate = 'off';          // try to disable the gate
    hostile.split = null;                    // try to remove the split
    hostile.telnyxMarket = 'hacked';         // try to reroute senders
    hostile.pipeline = 'Hacked';             // try to move the pipeline
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'save', workflow: hostile } });
    assert.strictEqual(res.statusCode, 200);

    const get = await callApi({ action: 'get', id: 'indianapolis', cookie: adminCookie() });
    const wf = bodyOf(get).workflow;
    // editable fields took effect
    assert.strictEqual(wf.name, 'Indianapolis SMS (edited)');
    assert.strictEqual(wf.firstTexts.A, 'EDITED {{first_name}} at {{address1}}');
    assert.strictEqual(wf.status, 'draft');
    assert.strictEqual(wf.source, 'stored');
    // locked / structural fields survived untouched
    assert.strictEqual(wf.badNumberGuard.tag, 'bad-number');
    assert.deepStrictEqual(wf.badNumberGuard.appliesToPaths, ['A', 'B', 'C', 'D', 'E']);
    assert.strictEqual(wf.badNumberGuard.action, 'end');
    assert.deepStrictEqual(wf.activeLeadTags, cfg.WORKFLOWS.indianapolis.activeLeadTags);
    assert.strictEqual(wf.activeLeadGate, cfg.WORKFLOWS.indianapolis.activeLeadGate);
    assert.strictEqual(wf.split.paths.A, cfg.WORKFLOWS.indianapolis.split.paths.A);
    assert.strictEqual(wf.telnyxMarket, 'indianapolis');
    assert.strictEqual(wf.pipeline, 'Lead');
  });
  await check('the static seed itself was not mutated by the save', async () => {
    assert.strictEqual(cfg.WORKFLOWS.indianapolis.firstTexts.A, SEED_INDY_A);
    assert.strictEqual(cfg.WORKFLOWS.indianapolis.status, undefined);
    assert.strictEqual(cfg.WORKFLOWS.indianapolis.badNumberGuard.tag, 'bad-number');
  });
  await check('an invalid window falls back to the seed window', async () => {
    const payload = JSON.parse(JSON.stringify(cfg.WORKFLOWS.carolina));
    payload.window = { days: ['Mon'], start: '17:00', end: '11:00' }; // start >= end
    payload.status = 'published';
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'save', workflow: payload } });
    assert.strictEqual(res.statusCode, 200);
    const wf = bodyOf(res).workflow;
    assert.strictEqual(wf.window.start, '11:00');
    assert.strictEqual(wf.window.end, '17:00');
    assert.deepStrictEqual(wf.window.days, cfg.WORKFLOWS.carolina.window.days);
  });
  await check('save without a trigger tag -> 400', async () => {
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'save', workflow: { id: 'carolina', tag: '  ' } } });
    assert.strictEqual(res.statusCode, 400);
  });
  await check('unknown action -> 400, publish of unknown id -> 404', async () => {
    const r1 = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'explode' } });
    assert.strictEqual(r1.statusCode, 400);
    const r2 = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'publish', id: 'nope-market' } });
    assert.strictEqual(r2.statusCode, 404);
  });

  console.log('— D. Publish toggle —');
  await check('publish flips a stored draft to published', async () => {
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'publish', id: 'indianapolis' } });
    assert.strictEqual(bodyOf(res).workflow.status, 'published');
  });
  await check('unpublish flips it back to draft', async () => {
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'unpublish', id: 'indianapolis' } });
    assert.strictEqual(bodyOf(res).workflow.status, 'draft');
  });
  await check('unpublishing a seed materializes a stored def (texts intact)', async () => {
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'unpublish', id: 'cleveland' } });
    const wf = bodyOf(res).workflow;
    assert.strictEqual(wf.status, 'draft');
    assert.strictEqual(wf.source, 'stored');
    assert.strictEqual(wf.firstTexts.A, cfg.WORKFLOWS.cleveland.firstTexts.A);
    const back = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'publish', id: 'cleveland' } });
    assert.strictEqual(bodyOf(back).workflow.status, 'published');
  });

  console.log('— E. Create + duplicate —');
  await check('create makes a Draft with the shared structure and empty texts', async () => {
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'create', name: 'Test Market', tag: 'test sms' } });
    assert.strictEqual(res.statusCode, 200);
    const wf = bodyOf(res).workflow;
    assert.strictEqual(wf.id, 'test-market');
    assert.strictEqual(wf.status, 'draft');
    assert.deepStrictEqual(wf.firstTexts, { A: '', B: '', C: '', D: '', E: '' });
    assert.strictEqual(wf.badNumberGuard.tag, 'bad-number');
    assert.deepStrictEqual(wf.window.days, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });
  await check('create with the same name gets a unique id', async () => {
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'create', name: 'Test Market', tag: 'test2 sms' } });
    assert.strictEqual(bodyOf(res).workflow.id, 'test-market-2');
  });
  await check('duplicate copies texts + sender pool, starts as Draft', async () => {
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'duplicate', id: 'carolina' } });
    const wf = bodyOf(res).workflow;
    assert.strictEqual(wf.id, 'carolina-sms-copy');
    assert.strictEqual(wf.status, 'draft');
    assert.strictEqual(wf.firstTexts.A, cfg.WORKFLOWS.carolina.firstTexts.A);
    assert.strictEqual(wf.telnyxMarket, 'carolina');
    assert.strictEqual(wf.tag, 'carolina sms');
  });
  await check('list now shows seeds + created + duplicate', async () => {
    const res = await callApi({ action: 'list', cookie: adminCookie() });
    assert.strictEqual(bodyOf(res).workflows.length, 8);
  });

  console.log('— F. Engine override resolution —');
  wfFake.data.clear(); enFake.data.clear(); convFake.data.clear(); sent.length = 0;

  await check('no stored def -> engine falls back to the static seed', async () => {
    const enr = await engine.enroll(
      { phone: '+19195550101', firstName: 'Sam', address1: '12 Oak St', city: 'Raleigh', tags: ['carolina sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    const tick = await engine.tick(MON_1200_ET, {});
    assert.ok(Array.isArray(tick.results));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].market, 'carolina');
    assert.strictEqual(
      sent[0].body,
      "Hi Sam, Riley with Direct Property Buyers. I came across 12 Oak St and wanted to see if you'd be open to a quick chat about it."
    );
  });

  await check('stored def wins: override window + override first text', async () => {
    const payload = JSON.parse(JSON.stringify(cfg.WORKFLOWS.indianapolis));
    payload.window = { timezone: 'America/New_York', days: ['Mon'], start: '09:00', end: '10:00' };
    payload.settingsWindow = payload.window;
    payload.firstTexts.A = 'OVERRIDE {{first_name}}';
    payload.status = 'published';
    const res = await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'save', workflow: payload } });
    assert.strictEqual(res.statusCode, 200);

    const e1 = await engine.enroll({ phone: '+13175550142', firstName: 'Pat', tags: ['indianapolis sms', 'lead - sms'] }, {});
    const e2 = await engine.enroll({ phone: '+13175550143', firstName: 'Jo', tags: ['indianapolis sms', 'lead - sms'] }, {});
    assert.strictEqual(e1.ok, true);
    assert.strictEqual(e2.ok, true);

    const before = sent.length;
    await engine.tick(MON_0930_ET, {}); // 9:30 AM — open ONLY under the override window
    assert.strictEqual(sent.length, before + 1);
    assert.strictEqual(sent[sent.length - 1].body, 'OVERRIDE Pat');

    await engine.tick(MON_1200_ET, {}); // noon — open under the seed window, closed under the override
    assert.strictEqual(sent.length, before + 1, 'override window must keep noon closed');
  });

  await check('draft never sends: enroll refused, queued contacts held', async () => {
    await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'unpublish', id: 'indianapolis' } });
    const enr = await engine.enroll({ phone: '+13175550144', firstName: 'Dee', tags: ['indianapolis sms', 'lead - sms'] }, {});
    assert.strictEqual(enr.ok, false);
    assert.ok(/draft/.test(enr.reason), enr.reason);
    const before = sent.length;
    const tick = await engine.tick(MON_0930_ET, {});
    assert.strictEqual(sent.length, before, 'a draft workflow must not send queued contacts');
    const row = tick.results.find((r) => r.market === 'indianapolis');
    assert.strictEqual(row.action, 'draft');
  });

  await check('bad-number guard still ends the enrollment under an override', async () => {
    await callApi({ method: 'POST', cookie: adminCookie(), body: { action: 'publish', id: 'indianapolis' } });
    const enr = await engine.enroll(
      { phone: '+13175550145', firstName: 'Bad', tags: ['indianapolis sms', 'lead - sms', 'bad-number'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    await engine.tick(MON_0930_ET, {}); // sends the still-queued 'Jo' first (oldest)
    assert.strictEqual(sent[sent.length - 1].body, 'OVERRIDE Jo');
    const before = sent.length;
    await engine.tick(MON_0930_ET, {}); // now the bad-number enrollment is due
    assert.strictEqual(sent.length, before, 'bad-number contact must not be texted');
    const rec = JSON.parse(enFake.data.get('13175550145'));
    assert.strictEqual(rec.stage, 'ended-bad-number');
  });

  await check('active-lead gate still ends the enrollment under an override', async () => {
    const enr = await engine.enroll({ phone: '+13175550146', firstName: 'Cold', tags: ['indianapolis sms'] }, {});
    assert.strictEqual(enr.ok, true);
    const before = sent.length;
    await engine.tick(MON_0930_ET, {});
    assert.strictEqual(sent.length, before);
    const rec = JSON.parse(enFake.data.get('13175550146'));
    assert.strictEqual(rec.stage, 'ended-inactive');
  });

  await check('DND still ends the enrollment under an override', async () => {
    const enr = await engine.enroll({ phone: '+13175550147', firstName: 'Dn', tags: ['indianapolis sms', 'lead - sms', 'dnc'] }, {});
    assert.strictEqual(enr.ok, true);
    const before = sent.length;
    await engine.tick(MON_0930_ET, {});
    assert.strictEqual(sent.length, before);
    const rec = JSON.parse(enFake.data.get('13175550147'));
    assert.strictEqual(rec.stage, 'ended-dnc');
  });

  console.log('— G. Page + nav wiring —');
  await check('workflows.html exists and is wired to the API', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'workflows.html'), 'utf8');
    assert.ok(html.includes('cc-workflows-api'), 'page must call cc-workflows-api');
    assert.ok(html.includes('id="wfList"'), 'list container');
    assert.ok(html.includes('id="flow"'), 'builder flow container');
    assert.ok(html.includes('LOCKED'), 'locked steps must be visible');
    assert.ok(html.includes('{{first_name}}'), 'placeholders documented');
  });
  await check('index.html sidebar links Workflows after Dialer', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const d = html.indexOf('href="/dialer.html"');
    const w = html.indexOf('href="/workflows.html"');
    assert.ok(d > -1 && w > d, 'workflows nav entry must follow the dialer entry');
  });

  console.log('');
  console.log('workflows-builder-regression: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL WORKFLOWS BUILDER CHECKS PASS');
})().catch((e) => {
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

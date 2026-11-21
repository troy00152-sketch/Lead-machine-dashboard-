// workflow-dedupe-regression.js
// Regression for the DUPLICATE-SEND LOCK in cc-workflow-engine.js
// (Troy, 2026-11-21): a phone that has ever received an outbound
// text from this system must NEVER get a second first text — not
// from a re-enrollment off a later list, not from another market's
// list, not after a manual Conversations send. Born of the
// HighLevel 2026-11-21 campaign sends, where sellers first texted
// weeks earlier (Randall Smith, Ernest Govan) got a fresh first
// text again off a new list.
//
// Run: node workflow-dedupe-regression.js
'use strict';

const assert = require('assert');

const store = require('./netlify/functions/cc-workflows-store');
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

// ---- fake Blobs stores ----
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
engine._test.setSendSms(async ({ market, to, body }) => {
  sent.push({ market, to, body });
  return { id: 'test-' + sent.length, from: '+14632783964' };
});
engine._test.setRandom(() => 0); // path A every time

const sendsTo = (e164) => sent.filter((s) => s.to === e164).length;
const recOf = (digits) => JSON.parse(enFake.data.get(digits));

// Monday Nov 16, 2026, 12:00 PM America/New_York — inside every
// seed workflow's Mon–Sat 11:00–17:00 ET send window.
const MON_1200_ET = Date.UTC(2026, 10, 16, 17, 0, 0);

const P1 = '+19195550101'; const P1K = '19195550101'; // carolina
const P2 = '+18165550102'; const P2K = '18165550102'; // kansas city
const P3 = '+19195550103'; const P3K = '19195550103'; // carolina
const P4 = '+12165550104'; const P4K = '12165550104'; // cleveland
const P5 = '+19045550105'; const P5K = '19045550105'; // florida
const P6 = '+13175550106'; const P6K = '13175550106'; // indianapolis

(async () => {
  console.log('— Duplicate-send lock —');

  await check('baseline: a fresh enrollment sends exactly one first text', async () => {
    const enr = await engine.enroll(
      { phone: P1, firstName: 'Randall', address1: '2028 Rustic Rd', city: 'Dayton', tags: ['carolina sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    assert.strictEqual(enr.enrollment.stage, 'queued');
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P1), 1);
    const rec = recOf(P1K);
    assert.strictEqual(rec.stage, 'sent');
    assert.ok(rec.sentAt != null, 'sentAt must be stamped');
  });

  await check('re-enrollment after the enrollment closed can never re-text', async () => {
    const before = recOf(P1K);
    // Simulate a later process closing the enrollment out.
    const closed = { ...before, stage: 'done' };
    enFake.data.set(P1K, JSON.stringify(closed));
    const idx = JSON.parse(enFake.data.get('index'));
    idx.enrollments[P1K] = { market: closed.market, stage: 'done' };
    enFake.data.set('index', JSON.stringify(idx));

    // Weeks later the same phone lands on a fresh list.
    const enr = await engine.enroll(
      { phone: P1, firstName: 'Randall', address1: '2028 Rustic Rd', city: 'Dayton', tags: ['carolina sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    assert.strictEqual(enr.enrollment.stage, 'ended-already-texted');
    assert.strictEqual(enr.enrollment.sentAt, before.sentAt, 'send history must carry forward');
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P1), 1, 'no second first text, ever');
  });

  await check('a manual outbound in the thread blocks a first text', async () => {
    convFake.data.set(P2K, JSON.stringify({
      phone: P2, key: P2K, name: 'Ernest', market: '', unread: 0, updatedAt: 1,
      messages: [{ id: 'm1', dir: 'out', body: 'manual text from the Conversations screen', at: 1 }],
    }));
    const enr = await engine.enroll(
      { phone: P2, firstName: 'Ernest', address1: '1439 W 2Nd St', city: 'Jacksonville', tags: ['kansas city sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    assert.strictEqual(enr.enrollment.stage, 'queued');
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P2), 0, 'already talked to — no first text');
    assert.strictEqual(recOf(P2K).stage, 'ended-already-texted');
  });

  await check('an inbound-only thread does NOT block the first text', async () => {
    convFake.data.set(P3K, JSON.stringify({
      phone: P3, key: P3K, name: '', market: '', unread: 1, updatedAt: 1,
      messages: [{ id: 'm1', dir: 'in', body: 'who is this?', at: 1 }],
    }));
    const enr = await engine.enroll(
      { phone: P3, firstName: 'Pat', address1: '9 Pine St', city: 'Raleigh', tags: ['carolina sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P3), 1);
  });

  await check('a never-sent terminal record may re-enroll and send', async () => {
    const enr = await engine.enroll(
      { phone: P4, firstName: 'Cold', address1: '5 Elm St', city: 'Cleveland', tags: ['oh sms'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P4), 0);
    assert.strictEqual(recOf(P4K).stage, 'ended-inactive');

    const re = await engine.enroll(
      { phone: P4, firstName: 'Cold', address1: '5 Elm St', city: 'Cleveland', tags: ['oh sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(re.ok, true);
    assert.strictEqual(re.enrollment.stage, 'queued', 'never sent -> a fresh queue is allowed');
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P4), 1);
  });

  await check('the same phone on two market lists gets one text total', async () => {
    const enr = await engine.enroll(
      { phone: P5, firstName: 'Flo', address1: '7 Beach Blvd', city: 'Jacksonville', tags: ['florida sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(enr.ok, true);
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P5), 1);

    const again = await engine.enroll(
      { phone: P5, firstName: 'Flo', address1: '7 Beach Blvd', city: 'Jacksonville', tags: ['carolina sms', 'lead - sms'] },
      {}
    );
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.enrollment.stage, 'sent', 'merged in place — never re-queued');
    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P5), 1, 'one phone, one first text, across all markets');
  });

  await check('a queued record that already carries sentAt is ended, not sent', async () => {
    const idx = JSON.parse(enFake.data.get('index'));
    const rec = {
      key: P6K, phone: P6, name: 'Seeded', firstName: 'Seeded',
      address1: '1 Main St', city: 'Indianapolis', market: 'indianapolis',
      tags: ['indianapolis sms', 'lead - sms'], path: 'A', stage: 'queued',
      enrolledAt: 1, sentAt: 999, messageId: 'earlier-send', lastError: null, lastAttemptAt: null,
    };
    enFake.data.set(P6K, JSON.stringify(rec));
    idx.enrollments[P6K] = { market: 'indianapolis', stage: 'queued' };
    enFake.data.set('index', JSON.stringify(idx));

    await engine.tick(MON_1200_ET, {});
    assert.strictEqual(sendsTo(P6), 0);
    assert.strictEqual(recOf(P6K).stage, 'ended-already-texted');
  });

  console.log('');
  console.log('workflow-dedupe-regression: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL DEDUPE LOCK CHECKS PASS');
})().catch((e) => {
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

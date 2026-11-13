// offer-flow-regression.js — one-screen lead -> price -> offer flow suite.
// FIXTURE-ONLY: reads local files, no network, no credits. Run:
//   node offer-flow-regression.js   (exit 0 = all pass)
//
// Proves the screen can only show sourced numbers:
//   - each lead's ARV/MAO/LAO == the CRM read-back values from the
//     auto-pricing write-back test (the price of record)
//   - scenario table == the validated ground truth (light/medium/heavy)
//   - comps of record average EXACTLY to the ARV
//   - the LOI offer on the lead == the CRM LAO, and the generated sample
//     letter file exists and prints that figure
//   - seller score on the lead == the scorer's sample run, and every
//     factor breakdown sums to the score
//   - listing state is honestly UNVERIFIED for every lead (offers locked)
//   - the page JS contains no price computation of its own
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PS = path.join(__dirname, '..', 'playbook-system');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
}

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/offer-flow-data.js'), 'utf8'), ctx);
const LEADS = ctx.window.OFFER_FLOW_LEADS;

const wb = readJson(path.join(PS, 'auto-pricing/output/writeback-test.json'));
const gt = readJson(path.join(PS, 'auto-pricing/ground_truth.json'));
const loiVer = readJson(path.join(PS, 'dealbreeze-takeaways/loi/verification.json'));
const scores = readJson(path.join(PS, 'dealbreeze-takeaways/seller-score/sample-scores.json'));
const F = { arv: 'cOE6XmJNOdVKsDNpiGqR', mao: 'B8Mfg1TQfjjo4Dl214A2', lao: 'JUPzLFhe7VG0PCJqL0n8' };
const wbByContact = Object.fromEntries(wb.map((e) => [gt.find((g) => String(g.n) === String(e.n)).contact_id, e]));
const gtByContact = Object.fromEntries(gt.map((g) => [g.contact_id, g]));
const loiByContact = Object.fromEntries(loiVer.map((v) => [v.contact_id, v]));
const scoreByContact = Object.fromEntries(scores.map((s) => [s.contact_id, s]));

console.log('offer-flow regression');

check('data file carries exactly the 5 auto-pricing test leads', () => {
  assert.equal(LEADS.length, 5);
  for (const l of LEADS) assert.ok(wbByContact[l.contact_id], `unknown contact ${l.contact_id}`);
});

for (const l of LEADS) {
  check(`${l.street}: price of record == CRM read-back`, () => {
    const after = wbByContact[l.contact_id].after;
    assert.equal(l.crm.arv, after[F.arv]);
    assert.equal(l.crm.mao, after[F.mao]);
    assert.equal(l.crm.lao, after[F.lao]);
  });
  check(`${l.street}: scenarios match ground truth + CRM medium`, () => {
    const g = gtByContact[l.contact_id];
    assert.equal(l.scenarios.light.mao, g.mao_light);
    assert.equal(l.scenarios.medium.mao, g.mao_medium);
    assert.equal(l.scenarios.heavy.mao, g.mao_heavy);
    assert.equal(l.scenarios.medium.lao, g.lao_medium);
    assert.equal(l.scenarios.medium.mao, l.crm.mao);
    assert.equal(l.scenarios.medium.lao, l.crm.lao);
  });
  check(`${l.street}: comps of record average exactly to the ARV`, () => {
    assert.ok(l.comps_of_record.length >= 2);
    const avg = l.comps_of_record.reduce((a, c) => a + c.amount, 0) / l.comps_of_record.length;
    assert.equal(Math.round(avg), l.crm.arv);
  });
  check(`${l.street}: LOI offer == CRM LAO and the sample letter prints it`, () => {
    assert.equal(l.loi_offer, l.crm.lao);
    const v = loiByContact[l.contact_id];
    assert.ok(v && v.ok, 'LOI verification record ok');
    const html = fs.readFileSync(v.letter_file, 'utf8');
    assert.ok(html.includes(money(l.crm.lao)), 'letter prints the LAO');
    assert.ok(!html.includes(money(l.crm.mao)), 'letter never prints the MAO ceiling');
  });
  check(`${l.street}: seller score matches the scorer run and sums`, () => {
    const s = scoreByContact[l.contact_id];
    assert.ok(s, 'score exists');
    assert.equal(l.seller_score.score, s.score);
    assert.equal(l.seller_score.factors.reduce((a, f) => a + f.points, 0), s.score);
  });
  check(`${l.street}: listing honestly unverified (offers locked)`, () => {
    assert.equal(l.listing.verified, false);
    assert.equal(l.listing.status, 'unknown');
  });
}

check('page JS computes no prices of its own', () => {
  const js = fs.readFileSync(path.join(__dirname, 'assets/offer-flow.js'), 'utf8');
  assert.ok(!/OfferMath/.test(js), 'must not recompute offer math client-side');
  assert.ok(!/arv\s*\*/i.test(js), 'no ARV arithmetic');
});

check('page HTML wires every element the JS renders into', () => {
  const html = fs.readFileSync(path.join(__dirname, 'offer-flow.html'), 'utf8');
  for (const id of ['rail', 'head', 'banner', 'priceCard', 'scoreCard', 'compsCard', 'actionsCard', 'loiModal', 'loiBody']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('assets/offer-flow-data.js'));
  assert.ok(html.includes('assets/offer-flow.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(failures.join('\n'));
process.exit(failed ? 1 : 0);

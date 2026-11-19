// Regression tests for the Command Center subject lookup (Nov 5, 2026;
// rewritten Nov 18, 2026 for the ATTOM strip):
// the data provider (PropertyReach via data-api) is the ONLY source now.
// ATTOM — the old backup source — was cut off and removed entirely, so
// there is no fallback: when the data provider fails, returns no match,
// or its quota is out (matched:false with upstream meta.status 402), the
// lookup honestly reports no match and the analyzer shows "No property
// record found", exactly one data-provider call per lookup.
// Run: node command-center-fallback-regression.js (exit non-zero on any failure)
// No live API calls: fetch is fully mocked; any non-data-api URL throws.
'use strict';

const fs = require('fs');
const path = require('path');
const { lookupSubjectProperty } = require('./subject-lookup.js');

const ADDR = '4405 E Edgewood Ave, Indianapolis, IN 46237';

function compRow(address, amount, date) {
  return { address, amount, date, distance: 0.4, sqft: 2600, beds: 3, baths: 2, ppsf: Math.round(amount / 2600 * 100) / 100, score: 2, deviations: [] };
}

const prQuota = {
  matched: false, address: ADDR, source: 'data provider',
  upstream: { status: 402, message: 'You have exceeded the number of available API calls. Please purchase additional usage blocks.' },
};
const prOk = {
  matched: true, address: ADDR, source: 'data provider',
  property: { address: ADDR, owner1: 'ERIC KINSEY', beds: 3, baths: 2, sqft: 2726, yearBuilt: 1962, marketValue: 254226, latitude: 39.68, longitude: -86.15, freeAndClear: false, mortgage: { amount: 120000 } },
  avm: { value: 254226, low: null, high: null, score: null, note: 'data provider market value — screen only, never ARV' },
  comps: { criteria: 'data-api-2mi-12mo', indication: 250590, confidence: 'HIGH', best: [compRow('4401 E Edgewood Ave, Indianapolis, IN 46237', 248000, '2026-08-15'), compRow('4412 E Edgewood Ave, Indianapolis, IN 46237', 252000, '2026-09-02'), compRow('4390 E Edgewood Ave, Indianapolis, IN 46237', 251770, '2026-07-20')] },
  linkedProperties: [],
};
const prNoComps = Object.assign({}, prOk, { comps: null });

function mockFetch(scenario) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url.includes('data-api')) {
      if (scenario === 'throw') throw new Error('fetch failed');
      if (scenario === 'http500') return { ok: false, status: 500, json: async () => ({}) };
      if (scenario === 'quota') return { ok: true, status: 200, json: async () => prQuota };
      if (scenario === 'ok') return { ok: true, status: 200, json: async () => prOk };
      if (scenario === 'noComps') return { ok: true, status: 200, json: async () => prNoComps };
    }
    throw new Error('unexpected url ' + url);
  };
  fn.calls = calls;
  return fn;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  // 1. PR healthy with comps -> renders, exactly one call, no second source.
  {
    const f = mockFetch('ok');
    const d = await lookupSubjectProperty(ADDR, f);
    check('1 healthy primary renders', d.matched && d.property && d.source === 'data provider', JSON.stringify({ matched: d.matched, source: d.source }));
    check('1 comps pass the 3-comp gate', d.comps && d.comps.best && d.comps.best.length === 3, 'best=' + (d.comps && d.comps.best && d.comps.best.length));
    check('1 ARV is the comp indication, not the AVM', d.comps && d.comps.indication === 250590, 'indication=' + (d.comps && d.comps.indication));
    check('1 exactly one data-provider call, no other source called', f.calls.length === 1 && f.calls[0].includes('data-api'), f.calls.join(' | '));
  }
  // 2. PR matched but no comps -> PR subject still renders (comps null).
  {
    const f = mockFetch('noComps');
    const d = await lookupSubjectProperty(ADDR, f);
    check('2 matched-no-comps keeps the PR subject', d.matched && d.property && d.property.owner1 === 'ERIC KINSEY' && d.comps === null && d.source === 'data provider',
      JSON.stringify({ owner: d.property && d.property.owner1, comps: d.comps, source: d.source }));
    check('2 exactly one call on the no-comps path', f.calls.length === 1, f.calls.join(' | '));
  }
  // 3. PR quota 402 -> honest no-match (no backup source exists anymore).
  {
    const f = mockFetch('quota');
    const d = await lookupSubjectProperty(ADDR, f);
    check('3 quota-402 stays unmatched', d.matched === false && d.source === 'data provider', 'matched=' + d.matched);
    check('3 exactly one call on the quota path', f.calls.length === 1, f.calls.join(' | '));
  }
  // 4. PR fetch throws (network) -> honest no-match, no crash.
  {
    const f = mockFetch('throw');
    const d = await lookupSubjectProperty(ADDR, f);
    check('4 fetch failure stays unmatched', d.matched === false, 'matched=' + d.matched);
  }
  // 5. PR HTTP 500 -> honest no-match.
  {
    const f = mockFetch('http500');
    const d = await lookupSubjectProperty(ADDR, f);
    check('5 HTTP 500 stays unmatched', d.matched === false, 'matched=' + d.matched);
  }
  // 6. Wiring + strip checks on the shipped files.
  {
    const cc = fs.readFileSync(path.join(__dirname, 'command-center.html'), 'utf8');
    const lookup = fs.readFileSync(path.join(__dirname, 'subject-lookup.js'), 'utf8');
    check('6 analyzer loads the shared lookup', cc.includes('<script src="subject-lookup.js"></script>'));
    check('6 analyzer calls the shared lookup', cc.includes('lookupSubjectProperty(addr)'));
    check('6 no backup-source note left in command-center.html', !cc.includes('via backup source'));
    check('6 no vendor name in command-center.html', !/attom/i.test(cc), 'found an attom mention in the page');
    check('6 no vendor name or endpoint anywhere in subject-lookup.js', !/attom/i.test(lookup), 'found an attom mention in subject-lookup.js');
    check('6 lookup calls data-api exactly once in source', (lookup.match(/\/\.netlify\/functions\/data-api/g) || []).length === 1);
  }

  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('ALL command-center fallback regression tests PASS');
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

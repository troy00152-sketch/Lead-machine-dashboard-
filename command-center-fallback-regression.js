// Regression tests for the Command Center subject-lookup fallback (Nov 5, 2026):
// the data provider's API quota hit 0, so data-api returns matched:false with
// upstream meta.status 402 and the subject analyzer showed "No property
// record found" for every address. The analyzer must now fall back to the
// backup source (same hybrid as the Comps page) with no further
// data-provider calls on the fallback path.
// Run: node command-center-fallback-regression.js (exit non-zero on any failure)
// No live API calls: fetch is fully mocked.
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
const attomOk = {
  matched: true, address: ADDR,
  property: { address: ADDR, owner1: 'ERIC KINSEY', beds: 3, baths: 2, sqft: 2726, yearBuilt: 1962, marketValue: 190000, assessedValue: 185000, latitude: 39.68, longitude: -86.15, freeAndClear: false, mortgage: { amount: 120000, lender: 'ARVEST' } },
  avm: { value: 245000, low: 230000, high: 260000, score: 72 },
  comps: { criteria: 'standard', indication: 250590, confidence: 'HIGH', best: [compRow('4401 E Edgewood Ave, Indianapolis, IN 46237', 248000, '2026-08-15'), compRow('4412 E Edgewood Ave, Indianapolis, IN 46237', 252000, '2026-09-02'), compRow('4390 E Edgewood Ave, Indianapolis, IN 46237', 251770, '2026-07-20')] },
};
const attomNoMatch = { matched: false, address: ADDR };

function mockFetch(scenarios) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url.includes('data-api')) {
      const s = scenarios.primary;
      if (s === 'throw') throw new Error('fetch failed');
      if (s === 'http500') return { ok: false, status: 500, json: async () => ({}) };
      if (s === 'quota') return { ok: true, status: 200, json: async () => prQuota };
      if (s === 'ok') return { ok: true, status: 200, json: async () => prOk };
      if (s === 'noComps') return { ok: true, status: 200, json: async () => prNoComps };
    }
    if (url.includes('attom-lookup')) {
      const s = scenarios.backup;
      if (s === 'throw') throw new Error('fetch failed');
      if (s === 'http500') return { ok: false, status: 500, json: async () => ({}) };
      if (s === 'ok') return { ok: true, status: 200, json: async () => attomOk };
      if (s === 'noMatch') return { ok: true, status: 200, json: async () => attomNoMatch };
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
  // 1. PR quota 402 -> backup supplies property + 3 comps; exactly one PR call.
  {
    const f = mockFetch({ primary: 'quota', backup: 'ok' });
    const d = await lookupSubjectProperty(ADDR, f);
    check('1 quota-402 falls back and renders', d.matched && d.property && d.source === 'backup', JSON.stringify({ matched: d.matched, source: d.source }));
    check('1 fallback comps pass the 3-comp gate', d.comps && d.comps.best && d.comps.best.length === 3, 'best=' + (d.comps && d.comps.best && d.comps.best.length));
    check('1 fallback ARV is the comp indication, not the AVM', d.comps && d.comps.indication === 250590, 'indication=' + (d.comps && d.comps.indication));
    check('1 no second data-provider call on fallback path', f.calls.filter(u => u.includes('data-api')).length === 1 && f.calls.filter(u => u.includes('attom-lookup')).length === 1, f.calls.join(' | '));
  }
  // 2. PR healthy with comps -> backup never called.
  {
    const f = mockFetch({ primary: 'ok', backup: 'ok' });
    const d = await lookupSubjectProperty(ADDR, f);
    check('2 healthy primary needs no fallback', d.matched && d.source === 'data provider', 'source=' + d.source);
    check('2 backup not called when primary answers', f.calls.filter(u => u.includes('attom-lookup')).length === 0, f.calls.join(' | '));
  }
  // 3. PR fetch throws (network) -> backup renders.
  {
    const f = mockFetch({ primary: 'throw', backup: 'ok' });
    const d = await lookupSubjectProperty(ADDR, f);
    check('3 fetch failure falls back', d.matched && d.source === 'backup', JSON.stringify({ matched: d.matched, source: d.source }));
  }
  // 4. PR matched but no comps -> keep PR subject, fill comps from backup.
  {
    const f = mockFetch({ primary: 'noComps', backup: 'ok' });
    const d = await lookupSubjectProperty(ADDR, f);
    check('4 PR subject kept, backup comps filled', d.matched && d.property && d.property.owner1 === 'ERIC KINSEY' && d.comps && d.comps.best.length === 3 && d.source === 'backup',
      JSON.stringify({ owner: d.property && d.property.owner1, best: d.comps && d.comps.best && d.comps.best.length, source: d.source }));
  }
  // 5. PR quota + backup no-match -> honest no-match.
  {
    const f = mockFetch({ primary: 'quota', backup: 'noMatch' });
    const d = await lookupSubjectProperty(ADDR, f);
    check('5 both sources empty stays unmatched', d.matched === false, 'matched=' + d.matched);
  }
  // 6. PR quota + backup throws -> honest no-match, no crash.
  {
    const f = mockFetch({ primary: 'quota', backup: 'throw' });
    const d = await lookupSubjectProperty(ADDR, f);
    check('6 backup failure stays unmatched', d.matched === false, 'matched=' + d.matched);
  }
  // 7. PR HTTP 500 -> backup renders.
  {
    const f = mockFetch({ primary: 'http500', backup: 'ok' });
    const d = await lookupSubjectProperty(ADDR, f);
    check('7 HTTP 500 falls back', d.matched && d.source === 'backup', JSON.stringify({ matched: d.matched, source: d.source }));
  }
  // 8. Wiring + white-label checks on the shipped files.
  {
    const cc = fs.readFileSync(path.join(__dirname, 'command-center.html'), 'utf8');
    const lookup = fs.readFileSync(path.join(__dirname, 'subject-lookup.js'), 'utf8');
    check('8 analyzer loads the shared lookup', cc.includes('<script src="subject-lookup.js"></script>'));
    check('8 analyzer calls the shared lookup', cc.includes('lookupSubjectProperty(addr)'));
    check('8 fallback note is generic', cc.includes('via backup source'));
    check('8 no vendor name in command-center.html', !/attom/i.test(cc), 'found an attom mention in the page');
    const attomHits = (lookup.match(/attom/gi) || []).length;
    const urlHits = (lookup.match(/\/\.netlify\/functions\/attom-lookup/g) || []).length;
    check('8 vendor name appears only in the function URL, never in UI text', attomHits === urlHits && urlHits === 1, `attom mentions=${attomHits}, url mentions=${urlHits}`);
    check('8 no vendor name in the fallback note', !/attom/i.test('via backup source'));
  }

  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('ALL command-center fallback regression tests PASS');
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

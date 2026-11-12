// data-api-mls-regression.js — fixture tests for the MLS comp filter in
// netlify/functions/data-api.js (Nov 11 cleanup build).
// Run: node data-api-mls-regression.js
// FIXTURE-ONLY: global.fetch is stubbed; no live PropertyReach calls,
// no credits spent (the API balance is 0 by design in this suite).
// Covers: the comparables request carries comparableSource "MLS" first;
// a sufficient MLS set stops there (no extra credit); a thin MLS set
// falls back once to "Both" and merges deduped; an MLS failure falls
// back to "Both"; total failure leaves comps null (page falls back to
// ATTOM); the ±20% sqft hard filter still keeps out-of-band rows out
// of the best-3 when 3 in-band comps exist.
'use strict';

const dataApi = require('./netlify/functions/data-api.js');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.error('FAIL:', name, extra || ''); }
}

function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const SUBJECT = {
  id: 'subj-1',
  apn: 'APN-1',
  streetAddress: '123 Main St', city: 'Indianapolis', state: 'IN', zip: '46204',
  county: 'Marion', fips: '18097',
  propertyType: 'Single Family Residential',
  squareFeet: 1500, bedrooms: 3, bathrooms: 2, yearBuilt: 1990,
  owner1Name: 'Fixture Owner', openLoanCount: 0,
};

function compRow(street, amount, sqft, daysAgo) {
  return {
    streetAddress: street, city: 'Indianapolis', state: 'IN', zip: '46204',
    lastSaleAmount: amount, lastSaleDate: daysAgoIso(daysAgo),
    squareFeet: sqft, bedrooms: 3, bathrooms: 2, yearBuilt: 1992,
    saleSituation: 'Cash Purchase',
  };
}

function okJson(obj) {
  return { status: 200, text: async () => JSON.stringify(obj) };
}
function apiOk(properties) {
  return okJson({ meta: { status: 200 }, properties });
}
function apiFail(status) {
  return okJson({ meta: { status, message: 'fixture failure' } });
}

// Install a fetch stub for one scenario; returns the recorded calls.
function stubFetch(compHandler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, body });
    if (u.includes('/property?')) {
      return okJson({ meta: { status: 200 }, property: SUBJECT });
    }
    if (u.endsWith('/comparables')) {
      return compHandler(body, calls.filter((c) => c.url.endsWith('/comparables')).length);
    }
    if (u.endsWith('/linked-properties')) return apiFail(404);
    throw new Error('unexpected fetch: ' + u);
  };
  return calls;
}

async function run(address) {
  const res = await dataApi.handler({
    httpMethod: 'GET',
    queryStringParameters: { address: address || '123 Main St, Indianapolis, IN 46204' },
    headers: {},
  });
  return JSON.parse(res.body);
}

(async function main() {
  process.env.PROPERTYREACH_API_KEY = 'fixture-key';
  const GOOD = [
    compRow('101 Fixture Ave', 200000, 1450, 30),
    compRow('102 Fixture Ave', 205000, 1520, 60),
    compRow('103 Fixture Ave', 198000, 1480, 90),
    compRow('104 Fixture Ave', 202000, 1550, 45),
  ];

  // ---- A. MLS sufficient: one call, MLS filter, MLS labels ----
  {
    const calls = stubFetch(() => apiOk(GOOD));
    const out = await run();
    const compCalls = calls.filter((c) => c.url.endsWith('/comparables'));
    t('A: exactly one comparables call when MLS suffices', compCalls.length === 1, 'calls=' + compCalls.length);
    const f = (compCalls[0] && compCalls[0].body && compCalls[0].body.filter) || {};
    t('A: request filter carries comparableSource MLS', f.comparableSource === 'MLS', JSON.stringify(f));
    t('A: existing filters preserved (2mi / class R / sale-date min)',
      f.distanceFromSubject === 2 && JSON.stringify(f.propertyClassCode) === '["R"]' && typeof f.lastSaleDateMin === 'string');
    t('A: comps priced, compSource labelled MLS', !!out.comps && out.comps.compSource === 'MLS', JSON.stringify(out.comps && out.comps.compSource));
    t('A: best-3 present and every best row labelled MLS',
      !!out.comps && out.comps.best.length === 3 && out.comps.best.every((c) => c.source === 'MLS'),
      JSON.stringify(out.comps && out.comps.best.map((c) => c.source)));
  }

  // ---- B. MLS thin: one fallback to Both, merged + deduped ----
  {
    const calls = stubFetch((body) => {
      if (body.filter.comparableSource === 'MLS') return apiOk([GOOD[0]]);
      return apiOk([GOOD[0], GOOD[1], GOOD[2]]); // GOOD[0] duplicates the MLS row
    });
    const out = await run();
    const compCalls = calls.filter((c) => c.url.endsWith('/comparables'));
    t('B: fallback fired exactly once (2 calls)', compCalls.length === 2, 'calls=' + compCalls.length);
    t('B: second call asks for Both', compCalls.length === 2 && compCalls[1].body.filter.comparableSource === 'Both');
    t('B: compSource labelled MLS+Both', !!out.comps && out.comps.compSource === 'MLS+Both', JSON.stringify(out.comps && out.comps.compSource));
    t('B: merge deduped (4 raw rows -> 3 returned)', !!out.comps && out.comps.returnedCount === 3, 'returned=' + (out.comps && out.comps.returnedCount));
    t('B: best-3 complete after fallback', !!out.comps && out.comps.best.length === 3);
  }

  // ---- C. MLS request fails outright: Both still prices the set ----
  {
    stubFetch((body) => (body.filter.comparableSource === 'MLS' ? apiFail(500) : apiOk(GOOD.slice(0, 3))));
    const out = await run();
    t('C: MLS failure falls back to Both and prices comps',
      !!out.comps && out.comps.compSource === 'Both' && out.comps.best.length === 3,
      JSON.stringify(out.comps && out.comps.compSource));
  }

  // ---- D. ±20% sqft hard filter untouched ----
  {
    const outlier = compRow('999 Outlier Blvd', 201000, 3200, 40); // subject 1500 sqft -> way outside ±20%
    stubFetch(() => apiOk([GOOD[0], GOOD[1], GOOD[2], outlier]));
    const out = await run();
    t('D: out-of-band sqft row kept out of best-3 when 3 in-band comps exist',
      !!out.comps && out.comps.best.length === 3 && !out.comps.best.some((c) => c.address.includes('Outlier')),
      JSON.stringify(out.comps && out.comps.best.map((c) => c.address)));
  }

  // ---- E. Both sources fail: comps null, matched survives ----
  {
    stubFetch(() => apiFail(500));
    const out = await run();
    t('E: total comparables failure -> comps null (ATTOM fallback path intact)',
      out.matched === true && out.comps === null, JSON.stringify({ matched: out.matched, comps: out.comps }));
  }

  console.log(`\ndata-api-mls-regression: ${pass} passed, ${fail} failed.`);
  if (fail) { console.error('Failures:\n- ' + failures.join('\n- ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

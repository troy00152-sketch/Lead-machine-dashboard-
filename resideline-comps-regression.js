// resideline-comps-regression.js — Resideline comp feed wiring, Nov 18 2026.
// Fixture tests for netlify/functions/resideline-comps.js. NO live calls:
// global fetch is stubbed and the only key used is an obviously fake TEST
// value. Run: node resideline-comps-regression.js (exit non-zero on any
// failure).
//
// What it proves:
//   1. No RESIDELINE_API_KEY -> 503 { error: 'not_configured' } and fetch
//      is never called (dormant, same pattern as grok-assist).
//   2. The chain is property_details first (POST
//      https://api.resideline.com/v1/api/property_details, body exactly
//      { address }, 0 credits), then property_value
//      (?enrich_if_missing=true) with a SPEC-EXACT body — only address,
//      beds, baths, sqft_size, subject_year_built, property_type; the
//      legacy non-spec fields (city, zipcode, max_radius_miles,
//      max_comp_age_days, sqft_band_abs, year_built_diff_cap) and any
//      caller bounds are never forwarded. Caller facts beat fetched
//      facts; fetched facts fill gaps.
//   3. Money strings ("$120,938") parse to numbers; comp rows map to the
//      dashboard comp shape (price -> amount, sold_date MM/DD/YYYY ->
//      ISO date, price_per_sqft -> ppsf); vendor ARV/as-is come back
//      labeled as vendor values and the engine indication is computed
//      from the comps, NOT copied from the vendor ARV.
//   4. Fewer than 3 upstream comps -> insufficient_comps, comps null,
//      no indication — no price verdict.
//   5. Upstream 402 -> credits_exhausted, 403 -> invalid_key,
//      404 -> not_found, 400 -> bad_input with only code/suggestion
//      passed through (top-level or under detail). The key never
//      appears in any response body.
//   6. The live failure modes from Nov 18, 2026: a property_value 400
//      INVALID_PROPERTY_DATA is rescued by property_report when
//      property_details supplied year_built + property_type (report
//      body uses sqft / year_built, comps parse from
//      property_valuation.comps); a property_value 200 whose comps
//      nest under property_valuation parses without the report call;
//      thin results everywhere stay insufficient_comps with the best
//      vendor values found.
//   7. index.html wires Resideline as the Comps page's primary comp
//      source ahead of the data-provider fallback.
//   8. Round-2 facts hardening (Nov 18, 2026 — the first live deploy
//      returned full comps for 4 of 6 addresses, but both Indianapolis
//      addresses 400ed: property_details returned 200 with facts=none
//      on every call, so the value call went out address-only and the
//      report fallback never fired): broadened field aliases,
//      recursive record search (depth <= 3), the keys-only
//      details shape= diagnostic (no values ever logged), the
//      missing= list on a value-step 400, subject facts taken from
//      the value payload's own property_details, and index.html
//      passing the data-provider subject facts as query params.
//   9. Round-3 (Nov 18, 2026 — round-2 parsing worked live, but
//      Eastern/421 still 400ed on ONE missing fact each, the report
//      fallback 400ed too, and the Comps page had no facts to pass
//      while the data provider was down): the documented
//      property_info details shape is parsed FIRST; property types
//      are normalized per endpoint (value: "Single-family", report:
//      "house"; unknown types pass through); the report fallback
//      tries a required-only body (report(min)) before the full body
//      (report(full)), with the value error staying the mapped error
//      when everything fails; index.html merges the current lead's
//      stashed subject facts UNDER the data-provider subject.
//      NOTE: round 3 deliberately changed six round-1/2 assertions
//      that pinned the old verbatim type passthrough and the single
//      full-body report call — they now assert the normalized
//      vocabulary and the report(min) body.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const fn = require('./netlify/functions/resideline-comps.js');
const T = fn._test;
const FAKE_KEY = 'rl-TEST-FAKE-KEY';

const realFetch = global.fetch;
const realKey = process.env.RESIDELINE_API_KEY;
let fetchCalls = [];
let fetchImpl = null;
function stubFetch(impl) {
  fetchCalls = [];
  fetchImpl = impl;
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
}
function fakeRes(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}
// Routes upstream calls by endpoint: routes = { details, value, report },
// each an async (parsedBody) => fakeRes. A missing route throws, so a
// test fails loudly if the chain makes a call it should not.
function stubRoutes(routes) {
  fetchCalls = [];
  fetchImpl = null;
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    const kind = url.includes('property_details') ? 'details'
      : url.includes('property_report') ? 'report' : 'value';
    const impl = routes[kind];
    if (!impl) throw new Error('unexpected upstream call: ' + kind + ' ' + url);
    return impl(JSON.parse(opts.body || '{}'));
  };
}
function post(body) {
  return { httpMethod: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) };
}
function get(qs) {
  return { httpMethod: 'GET', queryStringParameters: qs || {}, body: '' };
}

const ADDR = '3051 Eastern Ave, Indianapolis, IN 46218';
// Abridged but field-faithful property_value response (Nov 18 contract).
function upstreamOk(compCount) {
  const all = [
    { address: '3114 Adams St, Indianapolis, IN 46218', price: 63000, sold_date: '03/15/2026', beds: 2, baths: 1, sqft: 725, price_per_sqft: 87, distance: 0.4, similarity_score: 0.95 },
    { address: '2736 N Dearborn St, Indianapolis, IN 46218', price: 65000, sold_date: '10/02/2026', beds: 2, baths: 1, sqft: 720, price_per_sqft: 90, distance: 0.5, similarity_score: 0.93 },
    { address: '2839 N Lasalle St, Indianapolis, IN 46218', price: 55000, sold_date: '01/20/2026', beds: 2, baths: 1, sqft: 768, price_per_sqft: 72, distance: 0.5, similarity_score: 0.91 },
    { address: '3023 Adams St, Indianapolis, IN 46218', price: 80000, sold_date: '12/10/2025', beds: 2, baths: 1, sqft: 875, price_per_sqft: 91, distance: 0.5, similarity_score: 0.88 },
    { address: '2926 Adams St, Indianapolis, IN 46218', price: 109200, sold_date: '02/11/2026', beds: 2, baths: 1, sqft: 898, price_per_sqft: 122, distance: 0.5, similarity_score: 0.85 },
  ];
  return {
    arv_market_value: '$120,938',
    as_is_value: '$79,318',
    interval_10_90: ['$96,750', '$145,126'],
    confidence: 'medium',
    confidence_score: 0.72,
    subject: { address: ADDR, beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' },
    search_criteria_used: { radius_miles: 1, max_age_days: 365, sqft_band: 300, year_built_diff: 20 },
    comps: all.slice(0, compCount),
    credits_charged: 2,
    credits_remaining: 2490,
  };
}

(async () => {
  // ---- 1. not configured ----
  delete process.env.RESIDELINE_API_KEY;
  stubFetch(async () => { throw new Error('fetch must not be called'); });
  let r = await fn.handler(post({ address: ADDR }));
  let b = JSON.parse(r.body);
  check('no key -> 503', r.statusCode === 503, 'got ' + r.statusCode);
  check('no key -> error not_configured', b.error === 'not_configured' && b.status === 'not_configured');
  check('no key -> fetch never called', fetchCalls.length === 0);

  // ---- 2. request shape (funded key) ----
  process.env.RESIDELINE_API_KEY = FAKE_KEY;
  stubRoutes({
    details: async () => fakeRes(200, {}),
    value: async () => fakeRes(200, upstreamOk(5)),
  });
  r = await fn.handler(post({ address: ADDR, beds: 2, baths: 1, sqft: 720, yearBuilt: 1947, propertyType: 'Single Family' }));
  check('funded -> 200', r.statusCode === 200, 'got ' + r.statusCode);
  check('chain stops after details+value when value has >= 3 comps', fetchCalls.length === 2, 'calls=' + fetchCalls.length);
  const dCall = fetchCalls[0];
  check('first call is property_details (v1)', dCall.url === 'https://api.resideline.com/v1/api/property_details', dCall.url);
  check('details call carries the API-Key header', dCall.opts.headers['API-Key'] === FAKE_KEY);
  check('details call is a POST', dCall.opts.method === 'POST');
  const dBody = JSON.parse(dCall.opts.body);
  check('details body is exactly { address }', dBody.address === ADDR && Object.keys(dBody).length === 1, JSON.stringify(dBody));
  const call = fetchCalls[1];
  check('second call is property_value on api.resideline.com', call.url.startsWith('https://api.resideline.com/v2/api/property_value'), call.url);
  check('enrich_if_missing=true is set', call.url.includes('enrich_if_missing=true'), call.url);
  check('API-Key header carries the key', call.opts.headers['API-Key'] === FAKE_KEY);
  check('Content-Type is JSON', call.opts.headers['Content-Type'] === 'application/json');
  check('method is POST', call.opts.method === 'POST');
  const sent = JSON.parse(call.opts.body);
  check('body address is the full address', sent.address === ADDR, sent.address);
  check('body beds mapped', sent.beds === 2);
  check('body baths mapped', sent.baths === 1);
  check('body sqft -> sqft_size', sent.sqft_size === 720, 'sqft_size=' + sent.sqft_size);
  check('body yearBuilt -> subject_year_built', sent.subject_year_built === 1947);
  check('body propertyType -> property_type (round-3: value vocabulary)', sent.property_type === 'Single-family', sent.property_type);
  const SPEC_KEYS = ['address', 'beds', 'baths', 'sqft_size', 'subject_year_built', 'property_type'];
  check('value body is spec-exact (no non-spec fields)', Object.keys(sent).every(k => SPEC_KEYS.includes(k)), Object.keys(sent).join(','));
  check('no city/zipcode/bounds fields leak upstream', !('city' in sent) && !('zipcode' in sent) && !('max_radius_miles' in sent) && !('max_comp_age_days' in sent) && !('sqft_band_abs' in sent) && !('year_built_diff_cap' in sent));

  // Caller bounds are legacy input: parsed, never forwarded upstream.
  stubRoutes({
    details: async () => fakeRes(200, {}),
    value: async () => fakeRes(200, upstreamOk(5)),
  });
  r = await fn.handler(post({ address: ADDR, bounds: { radiusMiles: 2, maxAgeDays: 180, sqftBand: 250, yearBuiltDiff: 15 } }));
  const sent2 = JSON.parse(fetchCalls[1].opts.body);
  check('caller bounds are NOT forwarded upstream', !('max_radius_miles' in sent2) && !('max_comp_age_days' in sent2) && !('sqft_band_abs' in sent2) && !('year_built_diff_cap' in sent2), JSON.stringify(sent2));
  stubRoutes({
    details: async () => fakeRes(200, {}),
    value: async () => fakeRes(200, upstreamOk(5)),
  });
  r = await fn.handler(get({ address: ADDR }));
  check('GET ?address= works (dashboard convention)', r.statusCode === 200 && JSON.parse(r.body).matched === true, 'got ' + r.statusCode);

  // ---- 3. money parsing + comp mapping + vendor labeling ----
  check('parseMoney "$528,700" -> 528700', T.parseMoney('$528,700') === 528700);
  check('parseMoney "$1,234.56" -> 1234.56', T.parseMoney('$1,234.56') === 1234.56);
  check('parseMoney number passes through', T.parseMoney(120938) === 120938);
  check('parseMoney blank -> null', T.parseMoney('') === null && T.parseMoney(null) === null && T.parseMoney('n/a') === null);
  check('soldDateToIso MM/DD/YYYY -> ISO', T.soldDateToIso('03/15/2026') === '2026-03-15', T.soldDateToIso('03/15/2026'));
  check('soldDateToIso single digits padded', T.soldDateToIso('1/5/2026') === '2026-01-05');
  check('soldDateToIso garbage -> null', T.soldDateToIso('recently') === null);

  b = JSON.parse(r.body); // the GET response from the last stub (upstreamOk(5))
  check('response source is resideline', b.source === 'resideline');
  check('response matched', b.matched === true);
  check('vendorArv parsed from money string', b.vendorArv === 120938, 'vendorArv=' + b.vendorArv);
  check('vendorAsIs parsed from money string', b.vendorAsIs === 79318, 'vendorAsIs=' + b.vendorAsIs);
  check('vendorInterval parsed', Array.isArray(b.vendorInterval) && b.vendorInterval[0] === 96750 && b.vendorInterval[1] === 145126);
  check('avm slot carries the vendor value as screen-only', b.avm && b.avm.value === 120938 && /screen only, never ARV/.test(b.avm.note || ''), JSON.stringify(b.avm));
  check('credits echoed', b.credits_charged === 2 && b.credits_remaining === 2490);
  check('search_criteria_used echoed', b.search_criteria_used && b.search_criteria_used.radius_miles === 1);
  check('vendor confidence echoed', b.confidence === 'medium' && b.confidenceScore === 0.72);
  check('property shape: subject facts mapped', b.property && b.property.sqft === 720 && b.property.beds === 2 && b.property.yearBuilt === 1947, JSON.stringify(b.property));
  check('comps shape: criteria labeled resideline', b.comps && b.comps.criteria === 'resideline');
  check('comps shape: returnedCount 5', b.comps.returnedCount === 5, 'returnedCount=' + (b.comps && b.comps.returnedCount));
  check('comps shape: best has 3 picks', (b.comps.best || []).length === 3, 'best=' + (b.comps.best || []).length);
  const row = (b.comps.best || []).find(x => x.address.includes('3114 Adams')) || (b.comps.best || [])[0] || {};
  check('comp row: amount is the sale price number', row.amount === 63000, 'amount=' + row.amount);
  check('comp row: date converted to ISO', row.date === '2026-03-15', 'date=' + row.date);
  check('comp row: ppsf carried', row.ppsf === 87, 'ppsf=' + row.ppsf);
  check('comp row: distance carried', row.distance === 0.4, 'distance=' + row.distance);
  check('comp row: sqft/beds/baths carried', row.sqft === 725 && row.beds === 2 && row.baths === 1);
  check('comp row: similarity score kept', row.similarityScore === 0.95, 'similarityScore=' + row.similarityScore);
  check('engine indication is the comp mean, NOT the vendor ARV', b.comps.indication === Math.round((63000 + 65000 + 55000) / 3), 'indication=' + b.comps.indication + ' vendorArv=' + b.vendorArv);
  check('engine confidence present', typeof b.comps.confidence === 'string' && b.comps.confidence.length > 0);

  // ---- 4. 3-comp minimum ----
  // Details returns an empty payload: with the recursive facts search,
  // a valuation-shaped details response would yield its nested subject
  // facts, so "no facts anywhere" needs a genuinely empty details body.
  stubRoutes({
    details: async () => fakeRes(200, {}),
    value: async () => fakeRes(200, upstreamOk(2)),
    report: async () => fakeRes(200, upstreamOk(2)),
  });
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('2 comps -> HTTP 200 with insufficient_comps', r.statusCode === 200 && b.error === 'insufficient_comps', 'got ' + r.statusCode + ' ' + (b.error || ''));
  check('2 comps -> matched false, comps null, no indication', b.matched === false && b.comps === null && b.compsReturned === 2);
  check('2 comps + no facts anywhere -> report fallback not attempted', !fetchCalls.some(c => c.url.includes('property_report')), 'calls=' + fetchCalls.map(c => c.url).join(' | '));
  stubFetch(async () => fakeRes(200, upstreamOk(0)));
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('0 comps -> insufficient_comps', b.error === 'insufficient_comps' && b.compsReturned === 0);
  stubFetch(async () => fakeRes(200, upstreamOk(3)));
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('exactly 3 comps -> usable set', b.matched === true && (b.comps.best || []).length === 3, 'best=' + (b.comps && (b.comps.best || []).length));

  // ---- 5. upstream error mapping ----
  const scenarios = [
    [402, 'credits_exhausted', 402],
    [403, 'invalid_key', 403],
    [404, 'not_found', 404],
    [422, 'validation_failed', 422],
    [500, 'upstream_error', 502],
  ];
  for (const [up, want, http] of scenarios) {
    stubFetch(async () => fakeRes(up, { detail: 'upstream detail text' }));
    r = await fn.handler(post({ address: ADDR }));
    b = JSON.parse(r.body);
    check('upstream ' + up + ' -> ' + want, r.statusCode === http && b.error === want, 'got ' + r.statusCode + ' ' + (b.error || ''));
    check('upstream ' + up + ' -> key never leaks', !r.body.includes(FAKE_KEY));
    check('upstream ' + up + ' -> raw body never forwarded', !r.body.includes('upstream detail text'));
  }
  stubFetch(async () => fakeRes(400, { detail: { code: 'MISSING_FACTS', suggestion: 'Provide beds and sqft' } }));
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('upstream 400 -> bad_input', r.statusCode === 400 && b.error === 'bad_input');
  check('upstream 400 -> only code/suggestion pass through', b.code === 'MISSING_FACTS' && b.suggestion === 'Provide beds and sqft', JSON.stringify(b));
  // The live Nov 18 400 body carries code/suggestion at the TOP level.
  stubFetch(async () => fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'Provide these fields in the body or allow enrichment & scraping', secret_junk: 'do-not-forward' }));
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('upstream 400 (top-level shape) -> bad_input with code/suggestion', r.statusCode === 400 && b.error === 'bad_input' && b.code === 'INVALID_PROPERTY_DATA' && b.suggestion === 'Provide these fields in the body or allow enrichment & scraping', JSON.stringify(b));
  check('upstream 400 (top-level shape) -> other body fields never forwarded', !r.body.includes('do-not-forward') && !r.body.includes(FAKE_KEY));
  stubFetch(async () => { throw new Error('network down'); });
  r = await fn.handler(post({ address: ADDR }));
  check('fetch throw -> 502 upstream_failed', r.statusCode === 502 && JSON.parse(r.body).error === 'upstream_failed', 'got ' + r.statusCode);
  r = await fn.handler(post({}));
  check('missing address -> 400 missing_address', r.statusCode === 400 && JSON.parse(r.body).error === 'missing_address');
  r = await fn.handler(post('{not json'));
  check('bad JSON -> 400', r.statusCode === 400 && JSON.parse(r.body).error === 'bad_json');
  r = await fn.handler({ httpMethod: 'DELETE', body: '' });
  check('DELETE -> 405', r.statusCode === 405);

  // ---- 6. the details -> value -> report chain ----
  // unit: facts parsing from property_details shapes
  const factsTop = T.parsePropertyDetails({ beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' });
  check('details parse: top-level record', factsTop && factsTop.beds === 2 && factsTop.baths === 1 && factsTop.sqft === 720 && factsTop.yearBuilt === 1947 && factsTop.propertyType === 'Single Family', JSON.stringify(factsTop));
  const factsNested = T.parsePropertyDetails({ property_details: { beds: 3, baths: 2, sqft_size: 1100, subject_year_built: 1955, property_type: 'Condo' } });
  check('details parse: nested property_details + sqft_size/subject_year_built variants', factsNested && factsNested.beds === 3 && factsNested.sqft === 1100 && factsNested.yearBuilt === 1955 && factsNested.propertyType === 'Condo', JSON.stringify(factsNested));
  const factsWrapped = T.parsePropertyDetails({ data: { property_details: { beds: 4, baths: 2, sqft: 1500, year_built: 1970, property_type: 'Townhouse' } } });
  check('details parse: data-wrapped record', factsWrapped && factsWrapped.beds === 4 && factsWrapped.sqft === 1500 && factsWrapped.yearBuilt === 1970, JSON.stringify(factsWrapped));
  check('details parse: empty/garbage -> null', T.parsePropertyDetails({}) === null && T.parsePropertyDetails(null) === null && T.parsePropertyDetails({ credits_remaining: 5 }) === null);
  const merged = T.mergeFacts({ beds: null, baths: null, sqft: 999, yearBuilt: null, propertyType: null }, factsTop);
  check('mergeFacts: caller wins, fetched fills gaps', merged.sqft === 999 && merged.beds === 2 && merged.yearBuilt === 1947 && merged.propertyType === 'Single Family', JSON.stringify(merged));

  // unit: valuation payload parsing from both comp locations
  const okBody = upstreamOk(5);
  const pvTop = T.parseValuationPayload(okBody);
  check('value parse: top-level comps + vendor values', pvTop.comps.length === 5 && pvTop.vendorArv === 120938 && pvTop.vendorAsIs === 79318 && pvTop.interval[0] === 96750 && pvTop.interval[1] === 145126);
  const nestedBody = {
    property_valuation: {
      arv_market_value: '$526,639', as_is_value: '$410,000',
      value_low: '$450,000', value_high: '$600,000',
      confidence_score: 0.45, comps: okBody.comps,
    },
    property_details: { address: ADDR, beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' },
  };
  const pvNested = T.parseValuationPayload(nestedBody);
  check('value parse: comps nested under property_valuation', pvNested.comps.length === 5, 'comps=' + pvNested.comps.length);
  check('value parse: nested vendor values + value_low/high interval', pvNested.vendorArv === 526639 && pvNested.vendorAsIs === 410000 && pvNested.interval[0] === 450000 && pvNested.interval[1] === 600000, JSON.stringify({ v: pvNested.vendorArv, i: pvNested.interval }));
  check('value parse: nested confidence score', pvNested.confidenceScore === 0.45, 'score=' + pvNested.confidenceScore);
  check('value parse: subject record from property_details', pvNested.subject && pvNested.subject.sqft === 720 && pvNested.subject.year_built === 1947);
  check('value parse: garbage -> empty parse, no throw', T.parseValuationPayload(null).comps.length === 0 && T.parseValuationPayload('x').vendorArv === null);

  // unit: body builders
  const repBody = T.buildReportBody({ address: ADDR }, { beds: 2, baths: 1, sqft: 720, yearBuilt: 1947, propertyType: 'Single Family' });
  check('report body: address + year_built + property_type (round-3: report vocabulary)', repBody.address === ADDR && repBody.year_built === 1947 && repBody.property_type === 'house', JSON.stringify(repBody));
  check('report body: sqft (not sqft_size), no subject_year_built', repBody.sqft === 720 && !('sqft_size' in repBody) && !('subject_year_built' in repBody), JSON.stringify(repBody));
  check('report body: beds/baths ride along', repBody.beds === 2 && repBody.baths === 1);
  const valBody = T.buildUpstreamBody({ address: ADDR, beds: null, baths: null, sqft: null, yearBuilt: null, propertyType: null }, factsTop);
  check('value body from fetched facts is spec-exact', valBody.sqft_size === 720 && valBody.subject_year_built === 1947 && valBody.property_type === 'Single-family' && Object.keys(valBody).every(k => SPEC_KEYS.includes(k)), JSON.stringify(valBody));
  const prefer = T.preferParsed(T.parseValuationPayload(upstreamOk(2)), T.parseValuationPayload({ property_valuation: { arv_market_value: '$110,000', comps: okBody.comps.slice(0, 1) } }));
  check('preferParsed: keeps the larger comp set + its vendor values', prefer.comps.length === 2 && prefer.vendorArv === 120938, 'comps=' + prefer.comps.length + ' arv=' + prefer.vendorArv);
  check('factsSummary renders the log shape', T.factsSummary(factsTop) === 'beds:2,baths:1,sqft:720,yb:1947' && T.factsSummary(null) === 'none', T.factsSummary(factsTop));

  // handler: Eastern Ave — details facts rescue a 400ing valuation via the report
  const reportOk = {
    property_details: { address: ADDR, beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' },
    property_valuation: {
      arv_market_value: '$120,938', as_is_value: '$79,318',
      value_low: '$96,750', value_high: '$145,126',
      comps: okBody.comps, search_criteria_used: { via: 'report' },
    },
    credits_charged: 10, credits_remaining: 2480,
  };
  stubRoutes({
    details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family', address: ADDR }),
    value: async () => fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'Provide these fields in the body or allow enrichment & scraping' }),
    report: async () => fakeRes(200, reportOk),
  });
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('chain: value 400 -> report rescues, matched', r.statusCode === 200 && b.matched === true, 'got ' + r.statusCode + ' ' + r.body.slice(0, 160));
  check('chain: all three calls in order details -> value -> report', fetchCalls.length === 3 && fetchCalls[0].url.includes('property_details') && fetchCalls[1].url.includes('property_value') && fetchCalls[2].url.includes('property_report'), fetchCalls.map(c => c.url).join(' | '));
  const repSent = JSON.parse(fetchCalls[2].opts.body);
  check('chain: report(min) body carries year_built + property_type from details (report vocabulary)', repSent.year_built === 1947 && repSent.property_type === 'house', JSON.stringify(repSent));
  check('chain: report(min) body is required-only — no beds/baths/sqft, no sqft_size / subject_year_built', repSent.beds === undefined && repSent.baths === undefined && repSent.sqft === undefined && !('sqft_size' in repSent) && !('subject_year_built' in repSent), JSON.stringify(repSent));
  check('chain: vendor values labeled from the report', b.vendorArv === 120938 && b.vendorAsIs === 79318, 'arv=' + b.vendorArv);
  check('chain: engine indication computed from report comps, not vendor ARV', b.comps && b.comps.indication === Math.round((63000 + 65000 + 55000) / 3), 'indication=' + (b.comps && b.comps.indication));
  check('chain: property facts from the report subject record', b.property && b.property.sqft === 720 && b.property.yearBuilt === 1947, JSON.stringify(b.property));
  check('chain: key never leaks', !r.body.includes(FAKE_KEY));

  // handler: Waterbury — value 200 with comps nested under property_valuation
  stubRoutes({
    details: async () => fakeRes(200, {}),
    value: async () => fakeRes(200, nestedBody),
  });
  r = await fn.handler(post({ address: '229 Plaza Ave, Waterbury, CT 06710' }));
  b = JSON.parse(r.body);
  check('nested comps -> matched, report never called', b.matched === true && fetchCalls.length === 2, 'matched=' + b.matched + ' calls=' + fetchCalls.length);
  check('nested comps -> vendor ARV from property_valuation', b.vendorArv === 526639 && b.vendorAsIs === 410000, 'arv=' + b.vendorArv);
  check('nested comps -> vendor interval from value_low/high', Array.isArray(b.vendorInterval) && b.vendorInterval[0] === 450000 && b.vendorInterval[1] === 600000);
  check('nested comps -> best picks present', (b.comps.best || []).length === 3, 'best=' + (b.comps && (b.comps.best || []).length));

  // handler: details facts flow into the value body; caller facts win
  stubRoutes({
    details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' }),
    value: async () => fakeRes(200, upstreamOk(5)),
  });
  r = await fn.handler(post({ address: ADDR }));
  const vSent = JSON.parse(fetchCalls[1].opts.body);
  check('details facts fill the value body', vSent.beds === 2 && vSent.sqft_size === 720 && vSent.subject_year_built === 1947 && vSent.property_type === 'Single-family', JSON.stringify(vSent));
  stubRoutes({
    details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' }),
    value: async () => fakeRes(200, upstreamOk(5)),
  });
  r = await fn.handler(post({ address: ADDR, sqft: 999 }));
  const vSent2 = JSON.parse(fetchCalls[1].opts.body);
  check('caller facts beat fetched facts in the value body', vSent2.sqft_size === 999 && vSent2.subject_year_built === 1947, JSON.stringify(vSent2));

  // handler: thin everywhere -> insufficient with the best vendor values
  stubRoutes({
    details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' }),
    value: async () => fakeRes(200, upstreamOk(2)),
    report: async () => fakeRes(200, { property_valuation: { arv_market_value: '$110,000', comps: okBody.comps.slice(0, 1) } }),
  });
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('thin everywhere -> insufficient_comps, comps null', b.error === 'insufficient_comps' && b.matched === false && b.comps === null, 'error=' + (b.error || ''));
  check('thin everywhere -> best comp count kept (2, not 1)', b.compsReturned === 2, 'compsReturned=' + b.compsReturned);
  check('thin everywhere -> best vendor values kept', b.vendorArv === 120938 && b.vendorAsIs === 79318, 'arv=' + b.vendorArv);
  check('thin everywhere -> report was attempted', fetchCalls.some(c => c.url.includes('property_report')));

  // handler: a property_details failure is not fatal
  stubRoutes({
    details: async () => fakeRes(500, { detail: 'boom' }),
    value: async () => fakeRes(200, upstreamOk(5)),
  });
  r = await fn.handler(post({ address: ADDR, beds: 2, baths: 1, sqft: 720, yearBuilt: 1947, propertyType: 'Single Family' }));
  check('details 500 + caller facts -> value still succeeds', r.statusCode === 200 && JSON.parse(r.body).matched === true, 'got ' + r.statusCode);

  // ---- 7. frontend wiring ----
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // Scope the order checks to loadCompsForAddress itself — other lookups
  // sit earlier in the file.
  const fnStart = html.indexOf('async function loadCompsForAddress');
  const fnEnd = html.indexOf('function openLiveCallForLead', fnStart);
  const seg = html.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  check('loadCompsForAddress found in index.html', fnStart > 0);
  const rlIdx = seg.indexOf("/.netlify/functions/resideline-comps?address=");
  const prIdx = seg.indexOf("if(!d && prData && prData.comps");
  check('index.html calls resideline-comps', rlIdx > 0);
  check('Resideline is tried before the data-provider comp fallback', rlIdx > 0 && prIdx > rlIdx, 'rl=' + rlIdx + ' pr=' + prIdx);
  check('no ATTOM fallback remains in loadCompsForAddress', !seg.includes('/.netlify/functions/attom-lookup'), 'attom-lookup call found in loadCompsForAddress');
  check('Resideline acceptance requires the 3-comp minimum', seg.includes("(rj.comps.best || []).length >= 3"));
  check('PR subject merge kept for the Resideline win', seg.includes("compSource = 'Resideline+PR'"));
  check('no Resideline key material in index.html', !html.includes('RESIDELINE_API_KEY'));

  // ---- 8. round-2 facts hardening ----
  // aliases: the exact payload shape the task calls out
  const aliasFacts = T.parsePropertyDetails({ bedrooms: '3', bathrooms: 2, living_area_sqft: '1450', yearBuilt: 1962, type: 'Single Family' });
  check('aliases: bedrooms/living_area_sqft/yearBuilt/type yield facts (string numbers parse)', aliasFacts && aliasFacts.beds === 3 && aliasFacts.baths === 2 && aliasFacts.sqft === 1450 && aliasFacts.yearBuilt === 1962 && aliasFacts.propertyType === 'Single Family', JSON.stringify(aliasFacts));
  const aliasFacts2 = T.factsFromRecord({ bed_count: 4, total_baths: '2.5', gross_living_area: 2100, yr_built: 1981, property_class: 'Residential' });
  check('aliases: bed_count/total_baths/gross_living_area/yr_built/property_class', aliasFacts2 && aliasFacts2.beds === 4 && aliasFacts2.baths === 2.5 && aliasFacts2.sqft === 2100 && aliasFacts2.yearBuilt === 1981 && aliasFacts2.propertyType === 'Residential', JSON.stringify(aliasFacts2));
  const aliasFacts3 = T.factsFromRecord({ bed: 1, bath: 1, square_feet: 640, built_year: 1938, structure_type: 'Duplex' });
  check('aliases: bed/bath/square_feet/built_year/structure_type', aliasFacts3 && aliasFacts3.beds === 1 && aliasFacts3.baths === 1 && aliasFacts3.sqft === 640 && aliasFacts3.yearBuilt === 1938 && aliasFacts3.propertyType === 'Duplex', JSON.stringify(aliasFacts3));
  const aliasFacts4 = T.factsFromRecord({ num_beds: 2, num_baths: 1, living_area: 880, construction_year: 1975, use_type: 'SFR' });
  check('aliases: num_beds/num_baths/living_area/construction_year/use_type', aliasFacts4 && aliasFacts4.beds === 2 && aliasFacts4.baths === 1 && aliasFacts4.sqft === 880 && aliasFacts4.yearBuilt === 1975 && aliasFacts4.propertyType === 'SFR', JSON.stringify(aliasFacts4));
  const aliasFacts5 = T.factsFromRecord({ bathroom_count: 3, building_area: 1750 });
  check('aliases: bath_count-family names are NOT invented (bathroom_count unlisted) but building_area parses', aliasFacts5 && aliasFacts5.baths === null && aliasFacts5.sqft === 1750, JSON.stringify(aliasFacts5));
  const aliasFacts6 = T.factsFromRecord({ baths: 3, livingArea: 1750 });
  check('aliases: livingArea (camelCase) parses', aliasFacts6 && aliasFacts6.baths === 3 && aliasFacts6.sqft === 1750, JSON.stringify(aliasFacts6));

  // recursive record search
  const deepFacts = T.parsePropertyDetails({ result: { property: { bedrooms: 2, baths: 1, living_area: 900, built_year: 1951, use_type: 'SFR' } } });
  check('recursive search: record nested under result.property (depth 3)', deepFacts && deepFacts.beds === 2 && deepFacts.sqft === 900 && deepFacts.yearBuilt === 1951 && deepFacts.propertyType === 'SFR', JSON.stringify(deepFacts));
  const arrFacts = T.parsePropertyDetails({ results: [{ bedrooms: 5, bathrooms: 3, living_area_sqft: 2400, year_built: 1999, property_type: 'Single Family' }] });
  check('recursive search: record inside an array first element', arrFacts && arrFacts.beds === 5 && arrFacts.sqft === 2400 && arrFacts.yearBuilt === 1999, JSON.stringify(arrFacts));
  const subjFacts = T.parsePropertyDetails({ subject: { bedrooms: 3, living_area_sqft: 1300, yr_built: 1968, type: 'Condo' } });
  check('recursive search: record under a subject wrapper', subjFacts && subjFacts.beds === 3 && subjFacts.sqft === 1300 && subjFacts.yearBuilt === 1968 && subjFacts.propertyType === 'Condo', JSON.stringify(subjFacts));
  const tooDeep = T.parsePropertyDetails({ a: { b: { c: { d: { bedrooms: 9 } } } } });
  check('recursive search: beyond depth 3 stays null', tooDeep === null, JSON.stringify(tooDeep));
  check('recursive search: fact-free payload stays null', T.parsePropertyDetails({ meta: { request_id: 'x' }, credits_remaining: 5 }) === null);

  // shapeOf: key paths only
  check('shapeOf renders key paths, arrays as key[0].subkey', T.shapeOf({ a: { b: 1 }, list: [{ c: 2 }], plain: 'x' }) === 'a,a.b,list,list[0].c,plain', T.shapeOf({ a: { b: 1 }, list: [{ c: 2 }], plain: 'x' }));
  check('shapeOf of empty/garbage is empty', T.shapeOf({}) === '' && T.shapeOf(null) === '');

  // missingFactsList units
  check('missingFactsList: all missing', T.missingFactsList({ beds: null, baths: null, sqft: null, yearBuilt: null, propertyType: null }) === 'beds,baths,sqft,yearBuilt,propertyType');
  check('missingFactsList: partial', T.missingFactsList({ beds: 2, baths: 1, sqft: null, yearBuilt: null, propertyType: null }) === 'sqft,yearBuilt,propertyType');
  check('missingFactsList: none missing -> empty string', T.missingFactsList({ beds: 2, baths: 1, sqft: 720, yearBuilt: 1947, propertyType: 'Single Family' }) === '');

  // handler: unparseable details payload -> keys-only shape log, no values
  const SENTINEL = 'SENTINEL-VALUE-9f3k';
  const realLog = console.log;
  let captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };
  try {
    stubRoutes({
      details: async () => fakeRes(200, { meta: { request_id: SENTINEL }, wrapper: { inner: { note: SENTINEL } } }),
      value: async () => fakeRes(200, upstreamOk(5)),
    });
    r = await fn.handler(post({ address: ADDR }));
  } finally { console.log = realLog; }
  b = JSON.parse(r.body);
  const shapeLine = captured.find(l => l.includes('details shape='));
  check('shape log: fires when details facts parse as none', !!shapeLine, captured.join(' | '));
  check('shape log: carries recursive key paths', !!shapeLine && shapeLine.includes('meta.request_id') && shapeLine.includes('wrapper.inner.note'), shapeLine || '');
  check('shape log: no payload values leak into any log line', !captured.join('\n').includes(SENTINEL));
  check('shape log: request still succeeds via value', r.statusCode === 200 && b.matched === true, 'got ' + r.statusCode);

  // handler: shape log stays silent when facts parse
  captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };
  try {
    stubRoutes({
      details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' }),
      value: async () => fakeRes(200, upstreamOk(5)),
    });
    r = await fn.handler(post({ address: ADDR }));
  } finally { console.log = realLog; }
  check('shape log: silent when facts parse', !captured.some(l => l.includes('details shape=')), captured.join(' | '));

  // handler: value 400 -> missing= names the locally-missing facts
  captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };
  try {
    stubRoutes({
      details: async () => fakeRes(200, {}),
      value: async () => fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'Provide these fields in the body or allow enrichment & scraping' }),
    });
    r = await fn.handler(post({ address: ADDR }));
  } finally { console.log = realLog; }
  const vLine = captured.find(l => l.includes('value status=400'));
  check('missing log: value 400 lists every locally-missing fact', !!vLine && vLine.includes('missing=beds,baths,sqft,yearBuilt,propertyType'), vLine || captured.join(' | '));
  check('missing log: no facts -> report not attempted, 400 maps to bad_input', r.statusCode === 400 && JSON.parse(r.body).error === 'bad_input' && !fetchCalls.some(c => c.url.includes('property_report')), 'got ' + r.statusCode);
  captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };
  try {
    stubRoutes({
      details: async () => fakeRes(200, {}),
      value: async () => fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'x' }),
    });
    r = await fn.handler(post({ address: ADDR, beds: 2, baths: 1 }));
  } finally { console.log = realLog; }
  const vLine2 = captured.find(l => l.includes('value status=400'));
  check('missing log: partial facts list only the gaps', !!vLine2 && vLine2.includes('missing=sqft,yearBuilt,propertyType'), vLine2 || captured.join(' | '));

  // handler: subject facts from the value payload's own property_details (aliases)
  const valWithAliasDetails = Object.assign({}, upstreamOk(5), {
    subject: undefined,
    property_details: { bedrooms: 2, bathrooms: 1, living_area_sqft: 720, yearBuilt: 1947, type: 'Single Family' },
  });
  stubRoutes({
    details: async () => fakeRes(200, {}),
    value: async () => fakeRes(200, valWithAliasDetails),
  });
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('value payload property_details (aliases) fills the subject record', b.matched === true && b.property && b.property.sqft === 720 && b.property.beds === 2 && b.property.yearBuilt === 1947 && b.property.propertyType === 'Single Family', JSON.stringify(b.property));

  // frontend: subject facts ride into the Resideline call
  check('index.html passes PR subject facts to resideline-comps', seg.includes('prSubject.beds') && seg.includes('prSubject.baths') && seg.includes('prSubject.sqft') && seg.includes('prSubject.yearBuilt') && seg.includes('prSubject.propertyType'));
  check('index.html appends facts as query params on the resideline URL', seg.includes("rlUrl += '&' + k + '=' + encodeURIComponent(v)") && seg.includes('fetch(rlUrl)'));

  // ---- 9. round-3: property_info, type vocabulary, report(min)->report(full), lead facts ----
  // property_info-first parsing (the documented blog shape)
  const infoFacts = T.parsePropertyDetails({ address: ADDR, lat: 39.79, lng: -86.1, property_info: { beds: 2, baths: 1, sqft_size: 720, subject_year_built: '1947', property_type: 'Single Family', images: ['x.jpg'] } });
  check('property_info: documented shape yields facts (string year parses)', infoFacts && infoFacts.beds === 2 && infoFacts.baths === 1 && infoFacts.sqft === 720 && infoFacts.yearBuilt === 1947 && infoFacts.propertyType === 'Single Family', JSON.stringify(infoFacts));
  const infoFirst = T.parsePropertyDetails({ property_info: { beds: 2, baths: 1, sqft_size: 720, subject_year_built: 1947, property_type: 'House' }, property_details: { beds: 9, baths: 9, sqft: 9000, year_built: 2001, property_type: 'Condo' } });
  check('property_info: wins over property_details when both present', infoFirst && infoFirst.beds === 2 && infoFirst.sqft === 720 && infoFirst.yearBuilt === 1947 && infoFirst.propertyType === 'House', JSON.stringify(infoFirst));
  const infoWrapped = T.parsePropertyDetails({ data: { property_info: { beds: 3, baths: 2, sqft_size: 1250, subject_year_built: 1960, property_type: 'Condo' } } });
  check('property_info: data-wrapped location parses', infoWrapped && infoWrapped.beds === 3 && infoWrapped.sqft === 1250 && infoWrapped.yearBuilt === 1960 && infoWrapped.propertyType === 'Condo', JSON.stringify(infoWrapped));

  // type vocabulary units
  check('typeForValue: house -> Single-family', T.typeForValue('house') === 'Single-family');
  check('typeForValue: Single Family / Single-family / SINGLE_FAMILY -> Single-family', T.typeForValue('Single Family') === 'Single-family' && T.typeForValue('Single-family') === 'Single-family' && T.typeForValue('SINGLE_FAMILY') === 'Single-family');
  check('typeForReport: Single-family -> house', T.typeForReport('Single-family') === 'house');
  check('typeForReport: house stays house', T.typeForReport('house') === 'house');
  check('type vocabulary: condo both ways', T.typeForValue('Condo') === 'Condo' && T.typeForReport('condo') === 'condo');
  check('type vocabulary: townhouse both ways', T.typeForValue('townhouse') === 'Townhouse' && T.typeForReport('Townhouse') === 'townhouse');
  check('type vocabulary: multi-family variants', T.typeForValue('multi-family') === 'Multi-family' && T.typeForValue('Multi Family') === 'Multi-family' && T.typeForReport('multifamily') === 'multi-family' && T.typeForReport('Multi-family') === 'multi-family');
  check('type normalization: unknown types pass through unchanged', T.typeForValue('Duplex') === 'Duplex' && T.typeForReport('Duplex') === 'Duplex' && T.typeForValue('Vacant Land') === 'Vacant Land');
  check('type normalization: null/empty pass through', T.typeForValue(null) === null && T.typeForReport('') === '');
  const vbHouse = T.buildUpstreamBody({ address: ADDR }, { beds: null, baths: null, sqft: null, yearBuilt: null, propertyType: 'house' });
  check('value body: stored "house" emitted as Single-family', vbHouse.property_type === 'Single-family', JSON.stringify(vbHouse));
  const rbSf = T.buildReportBody({ address: ADDR }, { beds: 2, baths: 1, sqft: 720, yearBuilt: 1947, propertyType: 'Single-family' });
  check('report body: stored "Single-family" emitted as house, sqft kept', rbSf.property_type === 'house' && rbSf.sqft === 720, JSON.stringify(rbSf));
  const rbMinBody = T.buildReportBody({ address: ADDR }, { beds: 2, baths: 1, sqft: 720, yearBuilt: 1947, propertyType: 'Single Family' }, { minimal: true });
  check('report(min) body builder: exactly the required fields', Object.keys(rbMinBody).sort().join(',') === 'address,property_type,year_built' && rbMinBody.year_built === 1947 && rbMinBody.property_type === 'house', JSON.stringify(rbMinBody));
  const rbUnknown = T.buildReportBody({ address: ADDR }, { beds: null, baths: null, sqft: null, yearBuilt: 1990, propertyType: 'Duplex' });
  check('report body: unknown type passes through', rbUnknown.property_type === 'Duplex', JSON.stringify(rbUnknown));

  // handler: value 400 -> report(min) rescues; report(full) never called.
  // Details arrive in the documented property_info shape here, which
  // also proves those facts flow into the value body end to end.
  let repBodies = [];
  stubRoutes({
    details: async () => fakeRes(200, { address: ADDR, property_info: { beds: 2, baths: 1, sqft_size: 720, subject_year_built: '1947', property_type: 'Single Family', images: [] } }),
    value: async () => fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'Provide these fields in the body or allow enrichment & scraping' }),
    report: async (body) => { repBodies.push(body); return fakeRes(200, reportOk); },
  });
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('seq: value 400 -> report(min) 200 rescues, matched', r.statusCode === 200 && b.matched === true, 'got ' + r.statusCode + ' ' + r.body.slice(0, 160));
  check('seq: report called exactly once (min only), 3 upstream calls', repBodies.length === 1 && fetchCalls.length === 3, 'repCalls=' + repBodies.length + ' calls=' + fetchCalls.length);
  check('seq: the single report call was the required-only body (report vocabulary)', repBodies[0] && repBodies[0].beds === undefined && repBodies[0].baths === undefined && repBodies[0].sqft === undefined && repBodies[0].year_built === 1947 && repBodies[0].property_type === 'house', JSON.stringify(repBodies[0]));
  const vBody9 = JSON.parse(fetchCalls[1].opts.body);
  check('seq: property_info facts flowed into the value body', vBody9.beds === 2 && vBody9.sqft_size === 720 && vBody9.subject_year_built === 1947 && vBody9.property_type === 'Single-family', JSON.stringify(vBody9));

  // handler: value 400 -> report(min) 400 -> report(full) 200 rescues
  repBodies = [];
  stubRoutes({
    details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' }),
    value: async () => fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'x' }),
    report: async (body) => { repBodies.push(body); return body.sqft != null ? fakeRes(200, reportOk) : fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'min rejected' }); },
  });
  captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };
  try { r = await fn.handler(post({ address: ADDR })); } finally { console.log = realLog; }
  b = JSON.parse(r.body);
  check('seq: report(min) 400 -> report(full) 200 rescues, matched', r.statusCode === 200 && b.matched === true, 'got ' + r.statusCode + ' ' + r.body.slice(0, 160));
  check('seq: both report attempts made (4 upstream calls)', repBodies.length === 2 && fetchCalls.length === 4, 'repCalls=' + repBodies.length + ' calls=' + fetchCalls.length);
  check('seq: full body carries beds/baths/sqft + report-vocab type, sqft not sqft_size', repBodies[1] && repBodies[1].beds === 2 && repBodies[1].baths === 1 && repBodies[1].sqft === 720 && repBodies[1].property_type === 'house' && !('sqft_size' in repBodies[1]) && !('subject_year_built' in repBodies[1]), JSON.stringify(repBodies[1]));
  check('seq: attempts logged distinctly as report(min)/report(full)', captured.some(l => l.includes('report(min) status=400')) && captured.some(l => l.includes('report(full) status=200')), captured.join(' | '));

  // handler: everything fails -> the VALUE error stays the mapped error
  stubRoutes({
    details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' }),
    value: async () => fakeRes(400, { error: 'bad_input', code: 'INVALID_PROPERTY_DATA', suggestion: 'value says no' }),
    report: async (body) => fakeRes(400, { error: 'bad_input', code: body.sqft != null ? 'REPORT_FULL_CODE' : 'REPORT_MIN_CODE', suggestion: 'report says no' }),
  });
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('seq: all fail -> original bad_input mapping from the value error', r.statusCode === 400 && b.error === 'bad_input' && b.code === 'INVALID_PROPERTY_DATA' && b.suggestion === 'value says no', JSON.stringify(b));
  check('seq: all fail -> both report attempts were made', fetchCalls.length === 4, 'calls=' + fetchCalls.length);

  // handler: thin value (2 comps) -> report(min) is the first fallback attempt
  repBodies = [];
  stubRoutes({
    details: async () => fakeRes(200, { beds: 2, baths: 1, sqft: 720, year_built: 1947, property_type: 'Single Family' }),
    value: async () => fakeRes(200, upstreamOk(2)),
    report: async (body) => { repBodies.push(body); return fakeRes(200, reportOk); },
  });
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('seq: thin value -> report(min) rescues to a full set', b.matched === true && repBodies.length === 1 && repBodies[0].sqft === undefined, 'matched=' + b.matched + ' repCalls=' + repBodies.length);

  // frontend: lead facts merge (openCompsForLead stash + loadCompsForAddress merge)
  check('index.html merges lead facts under prSubject in the Resideline params', seg.includes('compLeadFacts.address === addr') && seg.includes('leadFacts ? leadFacts.beds : null') && seg.includes('leadFacts ? leadFacts.propertyType : null'));
  const leadStart = html.indexOf('function openCompsForLead');
  const leadEnd = html.indexOf('/* ============ THEME', leadStart);
  const leadSeg = html.slice(leadStart, leadEnd > leadStart ? leadEnd : undefined);
  check('openCompsForLead found in index.html', leadStart > 0);
  check('openCompsForLead stashes the lead subject facts (page spellings)', leadSeg.includes('compLeadFacts = { address: addr, facts:') && leadSeg.includes('l.bedrooms') && leadSeg.includes('l.bathrooms') && leadSeg.includes('l.sqft') && leadSeg.includes('l.yearBuilt') && leadSeg.includes('l.propertyType || l.propType'), leadSeg.slice(0, 200));
  check('compLeadFacts global declared', html.includes('let compLeadFacts = null'));

  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESIDELINE_API_KEY;
  else process.env.RESIDELINE_API_KEY = realKey;

  console.log('resideline-comps-regression: ' + pass + ' passed, ' + fail + ' failed.');
  if (fail) process.exit(1);
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

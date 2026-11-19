// resideline-comps-regression.js — Resideline comp feed wiring, Nov 18 2026.
// Fixture tests for netlify/functions/resideline-comps.js. NO live calls:
// global fetch is stubbed and the only key used is an obviously fake TEST
// value. Run: node resideline-comps-regression.js (exit non-zero on any
// failure).
//
// What it proves:
//   1. No RESIDELINE_API_KEY -> 503 { error: 'not_configured' } and fetch
//      is never called (dormant, same pattern as grok-assist).
//   2. The upstream call is POST https://api.resideline.com/v2/api/
//      property_value?enrich_if_missing=true with the API-Key header, the
//      address as the only required body field, subject hints mapped to
//      the upstream names (sqft -> sqft_size, yearBuilt ->
//      subject_year_built), and the default comp bounds
//      (radius 1 / age 365 / sqft band 300 / year diff 20).
//   3. Money strings ("$120,938") parse to numbers; comp rows map to the
//      dashboard comp shape (price -> amount, sold_date MM/DD/YYYY ->
//      ISO date, price_per_sqft -> ppsf); vendor ARV/as-is come back
//      labeled as vendor values and the engine indication is computed
//      from the comps, NOT copied from the vendor ARV.
//   4. Fewer than 3 upstream comps -> insufficient_comps, comps null,
//      no indication — no price verdict.
//   5. Upstream 402 -> credits_exhausted, 403 -> invalid_key,
//      404 -> not_found, 400 -> bad_input with only code/suggestion
//      passed through. The key never appears in any response body.
//   6. index.html wires Resideline as the Comps page's primary comp
//      source ahead of the data provider / ATTOM fallbacks.
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
  stubFetch(async () => fakeRes(200, upstreamOk(5)));
  r = await fn.handler(post({ address: ADDR, beds: 2, baths: 1, sqft: 720, yearBuilt: 1947, propertyType: 'Single Family' }));
  check('funded -> 200', r.statusCode === 200, 'got ' + r.statusCode);
  check('exactly one upstream call', fetchCalls.length === 1, 'calls=' + fetchCalls.length);
  const call = fetchCalls[0];
  check('upstream URL is property_value on api.resideline.com', call.url.startsWith('https://api.resideline.com/v2/api/property_value'), call.url);
  check('enrich_if_missing=true is set', call.url.includes('enrich_if_missing=true'), call.url);
  check('API-Key header carries the key', call.opts.headers['API-Key'] === FAKE_KEY);
  check('Content-Type is JSON', call.opts.headers['Content-Type'] === 'application/json');
  check('method is POST', call.opts.method === 'POST');
  const sent = JSON.parse(call.opts.body);
  check('body address is the full address', sent.address === ADDR, sent.address);
  check('body beds mapped', sent.beds === 2);
  check('body sqft -> sqft_size', sent.sqft_size === 720, 'sqft_size=' + sent.sqft_size);
  check('body yearBuilt -> subject_year_built', sent.subject_year_built === 1947);
  check('body propertyType -> property_type', sent.property_type === 'Single Family');
  check('body city/zipcode parsed from address', sent.city === 'Indianapolis' && sent.zipcode === '46218', JSON.stringify({ city: sent.city, zipcode: sent.zipcode }));
  check('default bounds: radius 1', sent.max_radius_miles === 1, 'max_radius_miles=' + sent.max_radius_miles);
  check('default bounds: age 365', sent.max_comp_age_days === 365);
  check('default bounds: sqft band 300', sent.sqft_band_abs === 300);
  check('default bounds: year diff 20', sent.year_built_diff_cap === 20);

  // bounds override + GET convention (what the Comps page sends)
  stubFetch(async () => fakeRes(200, upstreamOk(5)));
  r = await fn.handler(post({ address: ADDR, bounds: { radiusMiles: 2, maxAgeDays: 180, sqftBand: 250, yearBuiltDiff: 15 } }));
  const sent2 = JSON.parse(fetchCalls[0].opts.body);
  check('bounds override respected', sent2.max_radius_miles === 2 && sent2.max_comp_age_days === 180 && sent2.sqft_band_abs === 250 && sent2.year_built_diff_cap === 15, JSON.stringify(sent2));
  stubFetch(async () => fakeRes(200, upstreamOk(5)));
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
  stubFetch(async () => fakeRes(200, upstreamOk(2)));
  r = await fn.handler(post({ address: ADDR }));
  b = JSON.parse(r.body);
  check('2 comps -> HTTP 200 with insufficient_comps', r.statusCode === 200 && b.error === 'insufficient_comps', 'got ' + r.statusCode + ' ' + (b.error || ''));
  check('2 comps -> matched false, comps null, no indication', b.matched === false && b.comps === null && b.compsReturned === 2);
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
  stubFetch(async () => { throw new Error('network down'); });
  r = await fn.handler(post({ address: ADDR }));
  check('fetch throw -> 502 upstream_failed', r.statusCode === 502 && JSON.parse(r.body).error === 'upstream_failed', 'got ' + r.statusCode);
  r = await fn.handler(post({}));
  check('missing address -> 400 missing_address', r.statusCode === 400 && JSON.parse(r.body).error === 'missing_address');
  r = await fn.handler(post('{not json'));
  check('bad JSON -> 400', r.statusCode === 400 && JSON.parse(r.body).error === 'bad_json');
  r = await fn.handler({ httpMethod: 'DELETE', body: '' });
  check('DELETE -> 405', r.statusCode === 405);

  // ---- 6. frontend wiring ----
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // Scope the order checks to loadCompsForAddress itself — other pages
  // (lead modal) call attom-lookup directly and sit earlier in the file.
  const fnStart = html.indexOf('async function loadCompsForAddress');
  const fnEnd = html.indexOf('function openLiveCallForLead', fnStart);
  const seg = html.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  check('loadCompsForAddress found in index.html', fnStart > 0);
  const rlIdx = seg.indexOf("/.netlify/functions/resideline-comps?address=");
  const prIdx = seg.indexOf("if(!d && prData && prData.comps");
  const atIdx = seg.indexOf("/.netlify/functions/attom-lookup?address=");
  check('index.html calls resideline-comps', rlIdx > 0);
  check('Resideline is tried before the data-provider comp fallback', rlIdx > 0 && prIdx > rlIdx, 'rl=' + rlIdx + ' pr=' + prIdx);
  check('Resideline is tried before ATTOM', rlIdx > 0 && atIdx > rlIdx, 'rl=' + rlIdx + ' attom=' + atIdx);
  check('Resideline acceptance requires the 3-comp minimum', seg.includes("(rj.comps.best || []).length >= 3"));
  check('PR subject merge kept for the Resideline win', seg.includes("compSource = 'Resideline+PR'"));
  check('no Resideline key material in index.html', !html.includes('RESIDELINE_API_KEY'));

  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESIDELINE_API_KEY;
  else process.env.RESIDELINE_API_KEY = realKey;

  console.log('resideline-comps-regression: ' + pass + ' passed, ' + fail + ' failed.');
  if (fail) process.exit(1);
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

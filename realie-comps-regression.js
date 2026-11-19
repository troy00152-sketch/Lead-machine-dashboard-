#!/usr/bin/env node
// realie-comps regression — Nov 19, 2026.
//
// Pins netlify/functions/realie-comps.js, the Command Center's Realie
// feed (Realie replaced Resideline as the property-data + comps feed
// on Nov 19, 2026, on Troy's order: "take everything that API has to
// offer and wire it up into the system").
//
// Everything runs against the REAL payloads captured live on Nov 19,
// 2026 and saved in ~/workspace/realie-test/ (4 tokens total):
//   eastern-property.json / eastern-comps.json — 3051 Eastern Ave,
//     Indianapolis, IN 46218 (2 bd, 720 sqft, 1947; Realie baths 0/0 —
//     the known 0-baths gap; parcelId 49-07-20-115-077.000-101 and
//     legalDescription "TACOMA VILLAGE L140" match the signed
//     contract's parcel + legal).
//   kc-property.json / kc-comps.json — 1619 E 33rd St, Kansas City, MO
//     (2 bd / 1 ba, 1,052 sqft, 1997; comp set carries $2,355 / $2,898
//     non-arm's-length transfers the selection engine must screen).
// All upstream Realie calls are stubbed — this suite spends 0 tokens.
//
// Covered:
//   1. Address parsing / normalization and URL building (street line 1
//      + state only; comps lat/lon, radius, timeFrame, full=true).
//   2. Subject mapping: APN, legal description, owner + owner-occupied,
//      beds, sqft, year built, type, lot, lat/lon, last sale, assessed
//      / market value, tax, mortgage, free-and-clear.
//   3. Baths gap: Realie 0 baths = missing, never a fact; the
//      existing-record rescue keeps the caller's count and flags it
//      (bathsFromExisting, audit 'from-existing-record').
//   4. Comp mapping: price/date/address/facts, haversine distance
//      computed server-side, per-comp APN + legal.
//   5. Selection engine: nominal transfers out, median outliers both
//      directions out, best-3, indication + confidence; Realie's own
//      valuation is reference-only (vendorArv / avm), never the
//      indication.
//   6. Handler end-to-end on both fixtures + per-address cache: a
//      repeat view costs 0 upstream calls (cached: true,
//      tokensSpent: 0); insufficient_comps still carries the subject
//      record so APN/legal land on the page.
//   7. Error mapping: no key -> 503 not_configured; 402 ->
//      credits_exhausted; 401 -> invalid_key; 404 -> not_found;
//      missing state -> 400 STATE_REQUIRED; missing address -> 400.
//   8. index.html wiring: realie-comps is the page's primary feed,
//      the subject is captured even on thin comps, provider-path
//      blanks are filled from Realie, APN + legal rows render on the
//      subject card, the field-audit "Not on record" line exists, the
//      Realie baths note exists, and no key material is in the page.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const fn = require('./netlify/functions/realie-comps.js');
const T = fn._test;
const FAKE_KEY = 're-TEST-FAKE-KEY';

const FIX = '/home/hatch/workspace/realie-test';
const easternPropBody = JSON.parse(fs.readFileSync(path.join(FIX, 'eastern-property.json'), 'utf8')).data;
const easternCompsBody = JSON.parse(fs.readFileSync(path.join(FIX, 'eastern-comps.json'), 'utf8')).data;
const kcPropBody = JSON.parse(fs.readFileSync(path.join(FIX, 'kc-property.json'), 'utf8')).data;
const kcCompsBody = JSON.parse(fs.readFileSync(path.join(FIX, 'kc-comps.json'), 'utf8')).data;

let fetchCalls = [];
function stubFetch(routes) {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    const kind = url.includes('premium/comparables') ? 'comps' : 'subject';
    const impl = routes[kind];
    if (!impl) throw new Error('unexpected upstream call: ' + kind + ' ' + url);
    return impl(url, opts);
  };
}
function fakeRes(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}
function memStore() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); } };
}
function get(qs) { return { httpMethod: 'GET', queryStringParameters: qs || {}, body: '' }; }
function post(body) { return { httpMethod: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }; }

const EAST = '3051 Eastern Ave, Indianapolis, IN 46218';
const KC = '1619 E 33rd St, Kansas City, MO 64109';

(async () => {
  // ---- 1. address parsing + URL building ----
  let pa = T.parseAddress(EAST);
  check('parseAddress: comma form', pa.street === '3051 Eastern Ave' && pa.city === 'Indianapolis' && pa.state === 'IN' && pa.zip === '46218', JSON.stringify(pa));
  check('parseAddress: no state -> state blank (handler 400s)', T.parseAddress('3051 Eastern Ave, Indianapolis').state === '');
  check('normalizeAddress: comma-less typed address rebuilt', T.normalizeAddress('3051 eastern ave indianapolis in 46218') === '3051 Eastern Ave, Indianapolis, IN 46218', T.normalizeAddress('3051 eastern ave indianapolis in 46218'));
  check('normalizeAddress: comma form untouched', T.normalizeAddress(EAST) === EAST);
  check('cacheKeyFor: case/space-insensitive', T.cacheKeyFor('  3051  Eastern Ave, Indianapolis, IN 46218 ') === T.cacheKeyFor(EAST.toLowerCase()));
  const su = T.buildSubjectUrl('3051 Eastern Ave', 'IN');
  check('subject URL: street line 1 + state only', su.includes('address=3051%20Eastern%20Ave') && su.includes('state=IN') && !su.includes('Indianapolis'), su);
  const cu = T.buildCompsUrl(39.81224175, -86.11784574999996);
  check('comps URL: lat/lon + radius/timeFrame/full', cu.includes('latitude=39.81224175') && cu.includes('longitude=-86.11784574999996') && cu.includes('radius=1') && cu.includes('timeFrame=18') && cu.includes('full=true'), cu);

  // ---- 2. subject mapping (Eastern) ----
  const em = T.mapRealieSubject(easternPropBody.property, {}, EAST);
  const es = em.property;
  check('subject: APN from parcelId', es.apn === '49-07-20-115-077.000-101', es.apn);
  check('subject: legal description exact', es.legalDescription === 'TACOMA VILLAGE L140', es.legalDescription);
  check('subject: owner name', es.owner1 === 'HAYES ELENORA T', es.owner1);
  check('subject: owner-occupied -> absentee false', es.absentee === false);
  check('subject: beds', es.beds === 2);
  check('subject: sqft from livingArea', es.sqft === 720);
  check('subject: year built', es.yearBuilt === 1947);
  check('subject: type from classification', es.propertyType === 'Single Family', es.propertyType);
  check('subject: lot', es.lotSqft === 7318 && es.lotAcres === 0.168, es.lotSqft + '/' + es.lotAcres);
  check('subject: lat/lon from the record', es.latitude === 39.81224175 && es.longitude === -86.11784574999996);
  check('subject: last sale from salesHistory', es.lastSaleAmount === 62000 && es.lastSaleDate === '2005-10-10', es.lastSaleAmount + ' ' + es.lastSaleDate);
  check('subject: assessed + market value', es.assessedValue === 59000 && es.marketValue === 59000);
  check('subject: tax amount/year', es.taxAmount === 1093.96 && es.taxYear === 2024);
  check('subject: mortgage mapped', !!es.mortgage && es.mortgage.lender === 'THE UNION SAVINGS BANK' && es.mortgage.amount === 2000 && es.mortgage.dueDate === '2028-10-01' && es.freeAndClear === false, JSON.stringify(es.mortgage));
  check('subject: flags carry mortgage + long-term owner', es.flags.includes('mortgage_on_record') && es.flags.includes('long_term_owner'), JSON.stringify(es.flags));

  // ---- 3. baths gap + rescue ----
  check('baths: Realie 0/0 -> null (never a fact)', es.baths === null);
  check('baths: gap recorded', Array.isArray(em.realieGaps) && em.realieGaps.includes('baths'));
  check('baths: no rescue -> bathsFromExisting false', em.bathsFromExisting === false);
  const ea = T.buildFieldAudit(es, em.bathsFromExisting);
  check('audit: baths missing, everything else ok, missingFields=[Baths]', ea.audit.baths === 'missing' && ea.audit.beds === 'ok' && ea.audit.apn === 'ok' && ea.audit.legalDescription === 'ok' && JSON.stringify(ea.missingFields) === JSON.stringify(['Baths']), JSON.stringify(ea));
  const rm = T.mapRealieSubject(easternPropBody.property, { baths: 1 }, EAST);
  const ra = T.buildFieldAudit(rm.property, rm.bathsFromExisting);
  check('baths: existing-record count kept when Realie has none', rm.property.baths === 1 && rm.bathsFromExisting === true);
  check('baths: audit marks from-existing-record, not missing', ra.audit.baths === 'from-existing-record' && ra.missingFields.length === 0, JSON.stringify(ra.audit));

  // KC subject: baths present, no owner-occupied flag on record, free & clear
  const km = T.mapRealieSubject(kcPropBody.property, {}, KC);
  const ks = km.property;
  check('KC subject: baths from full count', ks.baths === 1);
  check('KC subject: legal', ks.legalDescription === 'LINWOOD ANNEX LOT 3', ks.legalDescription);
  check('KC subject: APN', ks.apn === '29-730-16-03-00-0-00-000');
  check('KC subject: owner-occupied not on record -> absentee null (never invented)', ks.absentee === null);
  check('KC subject: empty mortgage array -> freeAndClear, no mortgage object', ks.freeAndClear === true && ks.mortgage === null);
  check('KC subject: no realieGaps when baths present', km.realieGaps.length === 0);
  check('KC subject: last sale', ks.lastSaleAmount === 16000 && ks.lastSaleDate === '2009-12-03');

  // ---- 4. comp mapping + haversine ----
  const keystone = easternCompsBody.comparables.find((c) => c.transferPrice === 96143);
  const ec = T.mapRealieComp(keystone, em.lat, em.lon);
  check('comp: price/date/address', ec.amount === 96143 && ec.date === '2026-04-21' && ec.address === '3220 N KEYSTONE AVE, INDIANAPOLIS, IN 46218', JSON.stringify({ a: ec.amount, d: ec.date, addr: ec.address }));
  check('comp: distance computed (~0.29 mi)', ec.distance != null && Math.abs(ec.distance - 0.29) < 0.03, String(ec.distance));
  check('comp: per-comp APN + legal carried', ec.apn === '49-07-19-114-004.000-101' && ec.legalDescription === 'F L PALMERS N KEYSTONE ADD L4', JSON.stringify({ apn: ec.apn, legal: ec.legalDescription }));
  check('haversine: identical points = 0', T.haversineMiles(39.81, -86.11, 39.81, -86.11) === 0);
  check('haversine: missing coords -> null', T.haversineMiles(null, -86.11, 39.81, -86.11) === null);

  // ---- 5. selection engine on the real fixtures ----
  const eRows = easternCompsBody.comparables.map((c) => T.mapRealieComp(c, em.lat, em.lon));
  const eShaped = T.shapeCompsResult(T.analyzeComps(em.subject, eRows), eRows.length);
  check('engine (Eastern): best 3 are the screened set', JSON.stringify(eShaped.best.map((c) => c.amount).sort((a, b) => a - b)) === JSON.stringify([62000, 73600, 96143]), JSON.stringify(eShaped.best.map((c) => c.amount)));
  check('engine (Eastern): indication + confidence', eShaped.indication === 77248 && eShaped.confidence === 'MEDIUM', eShaped.indication + ' ' + eShaped.confidence);
  check('engine (Eastern): $250K excluded as above-pocket outlier', eShaped.excluded.some((c) => c.amount === 250000 && /outlier above pocket/.test(c.reason)), JSON.stringify(eShaped.excluded));
  check('engine (Eastern): best comps carry APN + legal through shaping', eShaped.best.every((c) => !!c.apn && !!c.legalDescription));
  const kRows = kcCompsBody.comparables.map((c) => T.mapRealieComp(c, km.lat, km.lon));
  const kShaped = T.shapeCompsResult(T.analyzeComps(km.subject, kRows), kRows.length);
  check('engine (KC): nominal $2,355/$2,898 transfers screened out', kShaped.excluded.some((c) => c.amount === 2355 && /nominal/.test(c.reason)) && kShaped.excluded.some((c) => c.amount === 2898) && !kShaped.best.some((c) => c.amount < 5000), JSON.stringify(kShaped.excluded.map((c) => c.amount)));
  check('engine (KC): low outliers excluded, best 3 + indication', JSON.stringify(kShaped.best.map((c) => c.amount).sort((a, b) => a - b)) === JSON.stringify([33000, 44100, 75000]) && kShaped.indication === 50700, JSON.stringify(kShaped.best.map((c) => c.amount)));

  // ---- 6. handler end-to-end + cache ----
  process.env.REALIE_API_KEY = FAKE_KEY;
  T._setStore(memStore()); T._clearMemCache();
  stubFetch({
    subject: async () => fakeRes(200, easternPropBody),
    comps: async () => fakeRes(200, easternCompsBody),
  });
  let r = await fn.handler(get({ address: EAST, baths: '1' }));
  let b = JSON.parse(r.body);
  check('handler: Eastern matched end-to-end', r.statusCode === 200 && b.matched === true && b.source === 'realie', r.statusCode + ' ' + (b.error || ''));
  check('handler: subject carries APN + legal', b.property.apn === '49-07-20-115-077.000-101' && b.property.legalDescription === 'TACOMA VILLAGE L140');
  check('handler: caller baths rescue surfaced', b.bathsFromExisting === true && b.property.baths === 1 && b.fieldAudit.baths === 'from-existing-record', JSON.stringify({ f: b.bathsFromExisting, fa: b.fieldAudit && b.fieldAudit.baths }));
  check('handler: vendor valuation reference-only (vendorArv/avm, indication differs)', b.vendorArv === 98920 && b.avm && b.avm.value === 98920 && b.comps.indication === 77248, JSON.stringify({ v: b.vendorArv, ind: b.comps && b.comps.indication }));
  check('handler: tokens spent = 2 (subject + comps)', b.tokensSpent === 2 && fetchCalls.length === 2, 'calls=' + fetchCalls.length);
  check('handler: auth header is the raw env key', fetchCalls[0].opts.headers.Authorization === FAKE_KEY);
  check('handler: comps URL used subject lat/lon + full=true', fetchCalls[1].url.includes('latitude=39.81224175') && fetchCalls[1].url.includes('full=true'), fetchCalls[1].url);
  r = await fn.handler(get({ address: EAST, baths: '1' }));
  b = JSON.parse(r.body);
  check('cache: repeat view served from cache, 0 new upstream calls', b.cached === true && b.tokensSpent === 0 && fetchCalls.length === 2, 'calls=' + fetchCalls.length);
  r = await fn.handler(post({ address: KC }));
  check('handler: a different address is a cache miss (2 more calls)', fetchCalls.length === 4, 'calls=' + fetchCalls.length);

  // insufficient comps still returns the subject record
  T._setStore(memStore()); T._clearMemCache();
  stubFetch({
    subject: async () => fakeRes(200, easternPropBody),
    comps: async () => fakeRes(200, { comparables: easternCompsBody.comparables.slice(0, 2) }),
  });
  r = await fn.handler(get({ address: '999 Nowhere Ln, Indianapolis, IN 46218' }));
  b = JSON.parse(r.body);
  check('handler: thin comps -> 200 insufficient_comps WITH subject (APN/legal land)', r.statusCode === 200 && b.matched === false && b.error === 'insufficient_comps' && b.property && b.property.apn === '49-07-20-115-077.000-101' && b.property.legalDescription === 'TACOMA VILLAGE L140', r.statusCode + ' ' + JSON.stringify(b.property && b.property.apn));

  // ---- 7. error mapping ----
  T._setStore(memStore()); T._clearMemCache();
  stubFetch({ subject: async () => fakeRes(404, { error: 'Property not found' }) });
  r = await fn.handler(get({ address: '1 Missing St, Indianapolis, IN 46218' }));
  b = JSON.parse(r.body);
  check('error: subject 404 -> 404 not_found', r.statusCode === 404 && b.error === 'not_found', r.statusCode + ' ' + b.error);
  stubFetch({ subject: async () => fakeRes(402, { error: 'Payment Required' }) });
  r = await fn.handler(get({ address: '2 Broke St, Indianapolis, IN 46218' }));
  b = JSON.parse(r.body);
  check('error: 402 -> 402 credits_exhausted', r.statusCode === 402 && b.error === 'credits_exhausted', r.statusCode + ' ' + b.error);
  stubFetch({ subject: async () => fakeRes(401, { error: 'Unauthorized' }) });
  r = await fn.handler(get({ address: '3 Badkey St, Indianapolis, IN 46218' }));
  b = JSON.parse(r.body);
  check('error: 401 -> 403 invalid_key', r.statusCode === 403 && b.error === 'invalid_key', r.statusCode + ' ' + b.error);
  r = await fn.handler(get({ address: '3051 Eastern Ave, Indianapolis' }));
  b = JSON.parse(r.body);
  check('error: address without state -> 400 STATE_REQUIRED', r.statusCode === 400 && b.code === 'STATE_REQUIRED', r.statusCode + ' ' + (b.code || b.error));
  r = await fn.handler(get({}));
  check('error: missing address -> 400', r.statusCode === 400);
  delete process.env.REALIE_API_KEY;
  r = await fn.handler(get({ address: EAST }));
  b = JSON.parse(r.body);
  check('error: no env key -> 503 not_configured', r.statusCode === 503 && b.error === 'not_configured', r.statusCode + ' ' + b.error);
  process.env.REALIE_API_KEY = FAKE_KEY;

  // ---- 8. index.html wiring ----
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const fnStart = html.indexOf('async function loadCompsForAddress');
  const fnEnd = html.indexOf('function openLiveCallForLead', fnStart);
  const seg = html.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  check('wiring: loadCompsForAddress calls realie-comps', seg.includes("/.netlify/functions/realie-comps?address="));
  check('wiring: Realie subject captured even on thin comps', seg.includes('realieSubject = rj.property'));
  check('wiring: provider-path blanks filled from Realie', seg.includes('Object.assign({}, realieSubject, d.property)'));
  check('wiring: Realie baths note text present', html.includes('Baths not on the Realie record — showing the count from the existing property record.'));
  check('wiring: subject card renders APN row', html.includes('APN:</span>') && html.includes('prop.apn'));
  check('wiring: subject card renders legal description row', html.includes('Legal description:</span>') && html.includes('prop.legalDescription'));
  check('wiring: field-audit "Not on record" line present', html.includes('compMissingFieldsHtml') && html.includes('Not on record: '));
  check('wiring: audit helper reads the ok/missing audit shape', html.includes("fa[k] === 'missing'"));
  check('wiring: no Realie key material in index.html', !html.includes('REALIE_API_KEY'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });

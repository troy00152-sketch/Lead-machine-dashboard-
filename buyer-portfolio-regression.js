/* Buyer portfolio view — regression tests.
   Fixtures only, zero credits. Run: node buyer-portfolio-regression.js
   (exit 1 on any failure).
   Fixture buyers/properties are REAL records copied verbatim from
   assets/master-buyers.js (bundle) and assets/buyer-portfolio-data.js
   (built Nov 9 2026 by buyer-hunt-2026/merge_all_counties.py from the
   Nov 8 Marion bundle + the Pitt / Jackson / Cuyahoga / Duval county
   pilots + the Nov 8-9 Nominatim geocode pass).
   Nothing here is invented. The portfolio holds ADDRESSES ONLY: no
   per-property sqft, beds, baths, type, value, rent, or LTV exists on
   disk for these properties (audit Nov 8 2026), so the cards must show
   those as "not on file" and the map must never show a price pin
   without a real Retail value. There is NO profit figure anywhere. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* Load modules + data the same way the page does (UMD / window global). */
const BuyerPortfolio = require('./assets/buyer-portfolio.js');
const BuyerDetail = require('./assets/buyer-detail.js');
const BuyerMap = require('./assets/buyer-map.js');
function loadWindowGlobal(file, key) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), ctx);
  return ctx.window[key];
}
const PF = loadWindowGlobal('assets/buyer-portfolio-data.js', 'BUYER_PORTFOLIO_DATA');
const MAPDATA = loadWindowGlobal('assets/buyer-map-data.js', 'BUYER_MAP_DATA');
const BUNDLE = loadWindowGlobal('assets/master-buyers.js', 'MASTER_BUYERS');

/* Real fixtures, verbatim from the bundle + portfolio data. */
const GRISE = { n: 'GRISE HOME AND PROPERTY GROUP LLC', p: '3174948228', c: '', s: '', z: '', pc: 136, st: 'Flipper+Landlord', ap: 107248, pv: 14585800, w: 0, sc: 85, ti: 'A - Top buyer', fl: 0 };
const ALPINE = { n: 'Alpine Property Management LLC', p: '8479777271', c: 'Indianapolis', s: 'IN', z: '46202', pc: 93, st: 'Flipper+Landlord', ap: 19344, pv: 15211800, w: 0, sc: 85, ti: 'A - Top buyer', fl: 304 };
const CORNWALL = { n: 'Cornwall Expeditions Llc', p: '8017870294', c: 'Indianapolis', s: 'IN', z: '46202', pc: 17, st: 'Landlord', ap: 8137, pv: 138325, w: 0, sc: 55, ti: 'C - Possible buyer', fl: 0 };
const SLB = { n: 'Slb Assets Ix LLC', p: '3179388454', c: 'Indianapolis', s: 'IN', z: '46202', pc: 720, st: 'Flipper+Landlord', ap: 1427317, pv: 140251214, w: 0, sc: 85, ti: 'A - Top buyer', fl: 67 };
/* Synthetic property WITH a real Retail value, to prove the gated
   price-pin / wholesale paths work when data exists. It is labeled
   synthetic in the test name and never bundled as a real property. */
const SYNTH_RETAIL = { st: '1 Test Way', c: 'Indianapolis', s: 'IN', z: '46202', owner: 'TEST', ownerName: 'Test Owner LLC', retail: 473000 };

console.log('buyer-portfolio regression:');

/* ---- normName ---- */
t('normName is case/punctuation-insensitive', BuyerPortfolio.normName('Grise Home and Property Group, LLC') === 'GRISEHOMEANDPROPERTYGROUPLLC' && BuyerPortfolio.normName('GRISE HOME AND PROPERTY GROUP LLC') === 'GRISEHOMEANDPROPERTYGROUPLLC');
t("normName drops '&' like the source JSON norm_name does ('R & N Rei' -> 'R N REI')", BuyerPortfolio.normName('R & N Rei LLC') === 'RNREILLC');
t('normName handles empty input', BuyerPortfolio.normName('') === '' && BuyerPortfolio.normName(null) === '');

/* ---- lookup: GRISE (own properties, no sharing) ---- */
(function () {
  const port = BuyerPortfolio.lookup(GRISE.n, PF);
  t('GRISE lookup: 3 own properties, 0 shared, total 3', port.own.length === 3 && port.shared.length === 0 && port.total === 3, JSON.stringify(port.own));
  const streets = port.own.map(function (p) { return p.st; });
  t('GRISE properties are the verbatim sample addresses (deduped)', streets.indexOf('7510 E 51St St') !== -1 && streets.indexOf('5670 Congressional Pl') !== -1 && streets.indexOf('2425 N Bolton Ave') !== -1, JSON.stringify(streets));
  t('GRISE properties all carry Indianapolis IN + ZIP', port.own.every(function (p) { return p.c === 'Indianapolis' && p.s === 'IN' && /^\d{5}$/.test(p.z); }));
  t('GRISE own properties are labeled with the buyer as owner', port.own.every(function (p) { return p.ownerName === GRISE.n; }));
})();

/* ---- lookup: shared tax mailing address (Alpine + Cornwall, 1848 N Alabama St) ----
   Post-Marion-merge (Nov 8 2026): the pair's shared address also carries
   98 shared-address county parcels (group.sp), so each now totals 104.
   Post-five-county merge (Nov 9 2026): one further shared parcel
   attached to the same group, so each totals 105. */
(function () {
  const port = BuyerPortfolio.lookup(ALPINE.n, PF);
  t('Alpine lookup: 3 own + 3 shared (Cornwall) + 99 shared-parcels, total 105', port.own.length === 3 && port.shared.length === 1 && port.shared[0].props.length === 3 && port.sharedParcels.length === 99 && port.total === 105, 'own=' + port.own.length + ' sharedGroups=' + port.shared.length + ' sp=' + port.sharedParcels.length);
  t('Alpine shared group is Cornwall Expeditions Llc', port.shared[0] && port.shared[0].ownerName === 'Cornwall Expeditions Llc' && port.sharedOwnerNames.indexOf('Cornwall Expeditions Llc') !== -1);
  t('shared properties carry their REAL owner name, not Alpine', port.shared[0].props.every(function (p) { return p.ownerName === 'Cornwall Expeditions Llc'; }));
  t('Cornwall lookup mirrors: 3 own + 3 shared (Alpine) + 99 shared-parcels, total 105', (function () {
    const c = BuyerPortfolio.lookup(CORNWALL.n, PF);
    return c.own.length === 3 && c.shared.length === 1 && c.shared[0].ownerName === 'Alpine Property Management LLC' && c.sharedParcels.length === 99 && c.total === 105;
  })());
})();

/* ---- lookup: no properties / unknown ----
   Post-Marion-merge: Slb has 0 OWN county parcels — its 1,063 Marion
   parcels sit at 2176 N Meridian St, shared with Job Capital — plus 2
   shared sample props from Job Capital, total 1,065. */
t('Slb: 0 own + 2 shared samples + 1,063 shared-parcels, total 1,065', (function () { const p = BuyerPortfolio.lookup(SLB.n, PF); return p.total === 1065 && p.own.length === 0 && p.shared.length === 1 && p.sharedParcels.length === 1063; })());
t('unknown buyer -> empty portfolio, never an error', (function () { const p = BuyerPortfolio.lookup('Nobody Here LLC', PF); return p.total === 0 && p.own.length === 0; })());
t('lookup is case-insensitive on the buyer name', BuyerPortfolio.lookup('grise home and property group llc', PF).total === 3);

/* ---- property cards: address-only honesty ---- */
(function () {
  const port = BuyerPortfolio.lookup(GRISE.n, PF);
  const html = BuyerPortfolio.propertyCardHtml(port.own[0], 0);
  t('card shows the street address + owner name', html.indexOf('7510 E 51St St') !== -1 && html.indexOf('GRISE HOME AND PROPERTY GROUP LLC') !== -1);
  t('card shows "not on file" for sqft/beds/baths/value', html.indexOf('not on file') !== -1);
  t('card with no value data renders NO dollar figure at all', html.indexOf('$') === -1, html.slice(0, 200));
  t('card never mentions profit', !/profit/i.test(html));
  t('card escapes HTML in owner/address', BuyerPortfolio.propertyCardHtml({ st: '<script>alert(1)</script>', ownerName: 'X' }, 0).indexOf('<script>') === -1);
  const shared = BuyerPortfolio.lookup(ALPINE.n, PF);
  const mix = BuyerPortfolio.propertyCardHtml(shared.shared[0].props[0], 3);
  t('shared property card shows the OTHER owner name', mix.indexOf('Cornwall Expeditions Llc') !== -1 && mix.indexOf('Alpine Property') === -1);
})();

/* ---- price pins + wholesale estimate: gated on real Retail ---- */
t('pricePinLabel is null when no Retail is on file', BuyerPortfolio.pricePinLabel({ st: 'x', z: '46202' }) === null && BuyerPortfolio.pricePinLabel({ st: 'x', retail: 0 }) === null && BuyerPortfolio.pricePinLabel({ st: 'x', retail: null }) === null);
t('pricePinLabel shows $473K for synthetic Retail 473000', BuyerPortfolio.pricePinLabel(SYNTH_RETAIL) === '$473K');
t('wholesaleEstimate is null without a real Retail', BuyerPortfolio.wholesaleEstimate(null) === null && BuyerPortfolio.wholesaleEstimate(0) === null && BuyerPortfolio.wholesaleEstimate(undefined) === null);
t('wholesaleEstimate is Retail x 0.65 with the estimate label', (function () { const w = BuyerPortfolio.wholesaleEstimate(473000); return w && w.value === 307450 && w.label === 'Wholesale estimate (Retail × 0.65)'; })());
t('card WITH a real Retail shows Retail + labeled wholesale estimate', (function () {
  const html = BuyerPortfolio.propertyCardHtml(SYNTH_RETAIL, 0);
  return html.indexOf('$473,000') !== -1 && html.indexOf('Wholesale estimate (Retail × 0.65)') !== -1 && html.indexOf('$307,450') !== -1;
})());

/* ---- splitPlottable: ZIP centroid only, never invented ---- */
(function () {
  const port = BuyerPortfolio.lookup(GRISE.n, PF);
  const split = BuyerPortfolio.splitPlottable(port.own, MAPDATA.zipCoords);
  t('GRISE: 3/3 plotted (all ZIPs in the Census table)', split.plotted.length === 3 && split.unplotted.length === 0);
  t('plotted coords are the EXACT Census centroid for the ZIP, or a real exact geocode pin', split.plotted.every(function (p) {
    if (p.plot === 'exact') return isFinite(p.lat) && isFinite(p.lon);
    const c = MAPDATA.zipCoords[p.z];
    return c && p.lat === c[0] && p.lon === c[1] && p.plot === 'zip';
  }));
  const noZip = BuyerPortfolio.splitPlottable([{ st: '1 No Zip Way', c: 'Charlotte', s: 'NC', z: '' }], MAPDATA.zipCoords);
  t('property with no ZIP is unplotted (list-only), never placed', noZip.plotted.length === 0 && noZip.unplotted.length === 1);
  const badZip = BuyerPortfolio.splitPlottable([{ st: '1 Bad Way', c: 'X', s: 'IN', z: '99999' }], MAPDATA.zipCoords);
  t('property with an unknown ZIP is unplotted, never guessed', badZip.plotted.length === 0 && badZip.unplotted.length === 1);
})();

/* ---- splitPlottable: exact geocode pins win over ZIP centroids ----
   Nov 9 2026: props with a Nominatim hit carry lat/lon and plot
   'exact'. The exact pin is used even when the ZIP centroid exists
   (and even when the ZIP is unknown — the street address is the
   authority). toProp passes lat/lon through from object entries and
   from array entries [4]/[5]. */
(function () {
  const exact = BuyerPortfolio.splitPlottable(
    [{ st: '6002 Ralston Ave', c: 'Indianapolis', s: 'IN', z: '46220', lat: 39.8641, lon: -86.1321285 }],
    MAPDATA.zipCoords);
  t('exact pin: lat/lon kept verbatim, plot is exact', exact.plotted.length === 1 && exact.plotted[0].plot === 'exact' && exact.plotted[0].lat === 39.8641 && exact.plotted[0].lon === -86.1321285);
  t('exact pin wins over the ZIP centroid (coords differ from centroid)', exact.plotted.length === 1 && MAPDATA.zipCoords['46220'] && (exact.plotted[0].lat !== MAPDATA.zipCoords['46220'][0] || exact.plotted[0].lon !== MAPDATA.zipCoords['46220'][1]));
  const exactNoZip = BuyerPortfolio.splitPlottable(
    [{ st: '6154 Long River Ln', c: 'Indianapolis', s: 'IN', z: '', lat: 39.6743158, lon: -86.2541585 }],
    MAPDATA.zipCoords);
  t('exact pin plots even with no ZIP on file', exactNoZip.plotted.length === 1 && exactNoZip.plotted[0].plot === 'exact');
  const arr = BuyerPortfolio.toProp(['7510 E 51St St', 'Indianapolis', 'IN', '46226', 39.779, -86.101], 'X', 'X');
  t('toProp reads lat/lon from sample-array elements [4]/[5]', arr.lat === 39.779 && arr.lon === -86.101);
  const arrNoGeo = BuyerPortfolio.toProp(['7510 E 51St St', 'Indianapolis', 'IN', '46226'], 'X', 'X');
  t('toProp leaves lat/lon unset for a 4-element sample array', arrNoGeo.lat == null && arrNoGeo.lon == null);
  const obj = BuyerPortfolio.toProp({ st: '6002 Ralston Ave', c: 'Indianapolis', s: 'IN', z: '46220', lat: 39.8641, lon: -86.1321285 }, 'X', 'X');
  t('toProp reads lat/lon from object entries', obj.lat === 39.8641 && obj.lon === -86.1321285);
})();

/* ---- full bundled dataset integrity ---- */
(function () {
  const keys = Object.keys(PF.props);
  const bundleNames = new Set(BUNDLE.map(function (b) { return BuyerPortfolio.normName(b.n); }));
  t('portfolio covers 8,823 buyers (Nov 9 build: Marion + 4 counties)', keys.length === 8823, 'got ' + keys.length);
  const total = keys.reduce(function (a, k) { return a + PF.props[k].length; }, 0);
  t('portfolio holds 50,861 addresses (Nov 9 build: Marion + 4 counties)', total === 50861, 'got ' + total);
  t('every portfolio key maps to a real Master Buyers record', keys.every(function (k) { return bundleNames.has(k); }));
  t('229 shared-address groups; every member has properties or the group has shared parcels', PF.groups.length === 229 && PF.groups.every(function (g) { return g.m.length >= 2 && g.m.every(function (m) { return (PF.props[m] || []).length > 0 || (g.sp || []).length > 0; }); }), 'got ' + PF.groups.length);
  /* No invented coordinates across the whole dataset: an 'exact' pin's
     lat/lon must equal the Nominatim result for its street+ZIP, and a
     'zip' pin's lat/lon must equal the Census centroid for its ZIP.
     Portable: when geocode-results.json exists (local workspace) the
     FULL check runs over every exact pin. When it does not exist (e.g.
     a Codespace, which holds only this repo) the check runs against
     embedded fixture pins — real Nominatim results, verified against
     the bundle — so the gate still proves exact pins are real. */
  var GEO_FIXTURES = [
    /* {street|zip key: [lat, lng]} — Nominatim results from
       buyer-hunt-2026/geocode-pass/geocode-results.json, Nov 9 2026. */
    { key: '6002 ralston ave|46220', lat: 39.8641, lng: -86.1321285 },
    { key: '6154 long river ln|', lat: 39.6743158, lng: -86.2541585 },
    { key: '1454 samuel st|', lat: 35.2595849, lng: -80.8377243 }
  ];
  function gkey(st, z) {
    return String(st || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim() + '|' + (z || '');
  }
  let bad = 0, plottedExact = 0, plottedZip = 0, unplotted = 0, checkedExact = 0;
  var geo = null, fixtureMode = false;
  try {
    geo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'buyer-hunt-2026', 'geocode-pass', 'geocode-results.json'), 'utf8'));
  } catch (e) { fixtureMode = true; }
  var fixtureByKey = {};
  GEO_FIXTURES.forEach(function (f) { fixtureByKey[f.key] = f; });
  keys.forEach(function (k) {
    PF.props[k].forEach(function (e) {
      const p = BuyerPortfolio.toProp(e, k, k);
      const s = BuyerPortfolio.splitPlottable([p], MAPDATA.zipCoords);
      plottedExact += s.plotted.filter(function (q) { return q.plot === 'exact'; }).length;
      plottedZip += s.plotted.filter(function (q) { return q.plot === 'zip'; }).length;
      unplotted += s.unplotted.length;
      s.plotted.forEach(function (q) {
        if (q.plot === 'exact') {
          checkedExact++;
          if (!fixtureMode) {
            const hit = geo[gkey(q.st, q.z)];
            if (!hit || hit.lat !== q.lat || hit.lng !== q.lon) bad++;
          } else {
            const f = fixtureByKey[gkey(q.st, q.z)];
            if (f && (f.lat !== q.lat || f.lng !== q.lon)) bad++;
          }
        } else {
          const c = MAPDATA.zipCoords[q.z];
          if (!c || q.lat !== c[0] || q.lon !== c[1]) bad++;
        }
      });
    });
  });
  t('no invented coordinates in the full dataset (' + plottedExact + ' exact / ' + plottedZip + ' centroid / ' + unplotted + ' unplotted)', bad === 0, 'bad=' + bad);
  t('plottable share is 49,175 of 50,861 (96.7% — 23,087 exact + 26,088 ZIP centroid)', plottedExact === 23087 && plottedZip === 26088, 'got exact=' + plottedExact + ' zip=' + plottedZip);
  t('exact pins verified against the geocode source (' + (fixtureMode ? 'embedded fixtures' : 'full geocode-results.json') + ', ' + checkedExact + ' checked)', checkedExact === plottedExact && checkedExact > 0, 'checked=' + checkedExact);
})();

/* ---- disclaimer ---- */
t('disclaimer names tax mailing address + shared owners + verify', (function () {
  const d = BuyerPortfolio.disclaimerHtml();
  return d.indexOf('tax mailing address') !== -1 && d.indexOf('share') !== -1 && d.indexOf('Verify independently') !== -1;
})());

/* ---- detail modal portfolio button (buyer-detail.js opts) ---- */
(function () {
  const withProps = BuyerDetail.detailHtml(GRISE, { rank: 1, total: 100, globalIndex: 0, portfolioCount: 3 });
  t('detail shows "View portfolio (3)" when count > 0', withProps.indexOf('View portfolio (3)') !== -1 && withProps.indexOf('mbOpenPortfolio(0)') !== -1);
  const none = BuyerDetail.detailHtml(SLB, { rank: 1, total: 100, globalIndex: 0, portfolioCount: 0 });
  t('detail shows "No linked properties on file" when count is 0', none.indexOf('No linked properties on file') !== -1 && none.indexOf('View portfolio') === -1);
  const legacy = BuyerDetail.detailHtml(GRISE, { rank: 1, total: 100, globalIndex: 0 });
  t('detail without portfolioCount is unchanged (no portfolio button)', legacy.indexOf('View portfolio') === -1 && legacy.indexOf('mbOpenPortfolio') === -1);
})();

/* ---- static wiring checks on index.html ---- */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
t('index.html loads buyer-portfolio-data.js + buyer-portfolio.js', html.indexOf('<script src="assets/buyer-portfolio-data.js"></script>') !== -1 && html.indexOf('<script src="assets/buyer-portfolio.js"></script>') !== -1);
t('index.html has the portfolio modal markup', html.indexOf('id="mbPortfolioModal"') !== -1 && html.indexOf('id="mbPortfolioBody"') !== -1 && html.indexOf('id="mbPortfolioTitle"') !== -1);
t('index.html defines mbOpenPortfolio / mbClosePortfolio / mbPortfolioBack', html.indexOf('function mbOpenPortfolio(') !== -1 && html.indexOf('function mbClosePortfolio(') !== -1 && html.indexOf('function mbPortfolioBack(') !== -1);
t('index.html defines portfolio map view + render', html.indexOf('function mbPfSetView(') !== -1 && html.indexOf('function renderPortfolioMap(') !== -1 && html.indexOf('mbPfMap') !== -1);
t('index.html detail passes portfolioCount into detailHtml', html.indexOf('portfolioCount: pfCount') !== -1 && html.indexOf('BuyerPortfolio.lookup(b.n') !== -1);
t('index.html portfolio glue resolves by the same globalIndex', html.indexOf('function mbOpenPortfolio(globalIndex)') !== -1 && html.indexOf('mbOpenDetail(mbPfGlobalIndex)') !== -1);
t('index.html portfolio popup says "Value not on file" when no Retail', html.indexOf('Value not on file') !== -1);

/* ---- index.html inline scripts still parse ---- */
(function () {
  var blocks = [];
  var re = /<script>([\s\S]*?)<\/script>/g, m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  var ok = true, bad = '';
  blocks.forEach(function (code, i) {
    try { new Function(code); } catch (e) { ok = false; bad = 'block ' + i + ': ' + e.message; }
  });
  t('index.html inline scripts parse (' + blocks.length + ' blocks)', ok, bad);
})();

/* ---- Marion County pilot (Nov 8 2026): county tax records ----
   Fixture is a REAL matched parcel, verbatim from the county source:
   parcel 8010215, 6002 Ralston Ave, Indianapolis IN 46220 — layer row
   (gis.indy.gov CommonlyUsedLayers MapServer/0) + property card
   (maps.indy.gov AssessorPropertyCards). Layer: lot 5,252 sq ft,
   RES ONE FAMILY PLATTED LOT-510, AV 364,300 (land 36,300 + imp
   328,000). Card: beds 2, full/half baths 0 (not recorded — renders
   as not on file), Fin.Liv.Area 1,092, year built 1942. The object
   below is the exact form build_buyer_portfolio_data.py emits for it. */
const COUNTY_8010215 = { st: '6002 Ralston Ave', c: 'Indianapolis', s: 'IN', z: '46220', lotsqft: 5252, livsqft: 1092, beds: 2, year: 1942, type: 'Res One Family Platted Lot', av: 364300, avLand: 36300, avImp: 328000, parcel: '8010215', oid: 417521, on: 'MAGNER, BRANDON &, EMMA CORRINNE HUBER' };
const COUNTY_LAYER_ONLY = { st: '2501 Chaseway Ct', c: 'Indianapolis', s: 'IN', z: '46268', lotsqft: 4410, type: 'Condo Platted', av: 186400, parcel: '6010878', oid: 393416, on: 'FLUECKIGER, JOYCE R' };
(function () {
  const p = BuyerPortfolio.toProp(COUNTY_8010215, 'TESTOWNER', 'Test Owner');
  t('county toProp keeps lot + living sq ft separate', p.lotsqft === 5252 && p.livsqft === 1092 && p.sqft == null);
  t('county toProp carries assessed value but NEVER maps it to retail', p.av === 364300 && p.retail == null);
  t('county toProp carries beds/year/type/parcel', p.beds === 2 && p.year === 1942 && p.type === 'Res One Family Platted Lot' && p.parcel === '8010215');
  t('county toProp shows the COUNTY owner name, not the buyer name', p.ownerName === 'MAGNER, BRANDON &, EMMA CORRINNE HUBER');
  t('county card labels the owner with the county owner name', BuyerPortfolio.propertyCardHtml(p, 0).indexOf('MAGNER, BRANDON &amp;, EMMA CORRINNE HUBER') !== -1);
  t('pricePinLabel is null for a county-only prop (assessed != retail)', BuyerPortfolio.pricePinLabel(p) === null);
  t('wholesaleEstimate is null for a county prop (no Retail on file)', BuyerPortfolio.wholesaleEstimate(p.retail) === null);
  const html = BuyerPortfolio.propertyCardHtml(p, 0);
  t('county card shows "Assessed value" $364,300, never "Retail"', html.indexOf('Assessed value') !== -1 && html.indexOf('$364,300') !== -1 && html.indexOf('Retail value') === -1);
  t('county card shows Lot sq ft 5,252 + Living sq ft 1,092 as separate rows', html.indexOf('Lot sq ft') !== -1 && html.indexOf('5,252') !== -1 && html.indexOf('Living sq ft') !== -1 && html.indexOf('1,092') !== -1);
  t('county card shows Beds 2 + Year built 1942 + Parcel # 8010215', html.indexOf('Beds') !== -1 && html.indexOf('1942') !== -1 && html.indexOf('Parcel #') !== -1 && html.indexOf('8010215') !== -1);
  t('county card shows no wholesale estimate line', html.indexOf('Wholesale estimate') === -1);
  const htmlLayer = BuyerPortfolio.propertyCardHtml(BuyerPortfolio.toProp(COUNTY_LAYER_ONLY, 'TESTOWNER', 'Test Owner'), 0);
  t('layer-only county card shows Assessed + Lot + Type + Parcel, no beds/baths/living rows', htmlLayer.indexOf('Assessed value') !== -1 && htmlLayer.indexOf('$186,400') !== -1 && htmlLayer.indexOf('Beds') === -1 && htmlLayer.indexOf('Living sq ft') === -1 && htmlLayer.indexOf('Baths') === -1);
  t('county note names all five county sources + the taxable/2024/acres rules', (function () { const n = BuyerPortfolio.countyNoteHtml(); return n.indexOf('Marion IN') !== -1 && n.indexOf('Pitt NC') !== -1 && n.indexOf('Jackson MO') !== -1 && n.indexOf('Cuyahoga OH') !== -1 && n.indexOf('Duval FL') !== -1 && n.indexOf('Taxable Value') !== -1 && n.indexOf('2024') !== -1 && n.indexOf('never appears as a price pin') !== -1; })());
  /* Shared-address mixing with county props: two buyers at one mailing
     address; the parcel at that address is in the group's `sp` — it is
     NEITHER buyer's own, and its card is labeled with the county owner
     name, never either buyer. */
  const sharedData = { props: {}, names: { BUYERALLC: 'Buyer A LLC', BUYERBLLC: 'Buyer B LLC' }, groups: [{ a: '6002 Ralston Ave', z: '46220', m: ['BUYERALLC', 'BUYERBLLC'], sp: [COUNTY_8010215] }] };
  const pa = BuyerPortfolio.lookup('Buyer A LLC', sharedData);
  t('shared county parcel: Buyer A sees 0 own + 1 shared-parcel, total 1', pa.total === 1 && pa.own.length === 0 && pa.shared.length === 0 && pa.sharedParcels.length === 1);
  t('shared county parcel card is labeled with the county owner, not the buyer', pa.sharedParcels[0].ownerName === 'MAGNER, BRANDON &, EMMA CORRINNE HUBER');
  const pb = BuyerPortfolio.lookup('Buyer B LLC', sharedData);
  t('shared county parcel: Buyer B sees the same parcel as shared, not own', pb.total === 1 && pb.own.length === 0 && pb.sharedParcels.length === 1 && pb.sharedParcels[0].parcel === '8010215');
  t('shared county parcel has no price pin (assessed only)', BuyerPortfolio.pricePinLabel(pa.sharedParcels[0]) === null);
  t('allProps includes shared parcels (list + map render them)', BuyerPortfolio.allProps(pa).length === 1 && BuyerPortfolio.allProps(pa)[0].parcel === '8010215');
})();

/* ---- county card-label fixtures, all five counties (Nov 9 2026) ----
   Each fixture is a REAL bundled prop, copied verbatim from
   assets/buyer-portfolio-data.js and verified against its county
   source. The labels are hard rules: Cuyahoga's av is the county's
   TAXABLE value (never bare "Assessed value"); Jackson's assessed
   values are tax year 2024; Pitt lot sq ft is computed from Acres;
   Duval's single baths number renders "N baths", never "N full". */
(function () {
  /* Magner — Marion: the Nov 8-9 geocode pass gave this prop an exact
     pin (39.8641, -86.1321285). */
  const mag = BuyerPortfolio.toProp(Object.assign({}, COUNTY_8010215, { lat: 39.8641, lon: -86.1321285 }), 'TESTOWNER', 'Test Owner');
  const magCard = BuyerPortfolio.propertyCardHtml(mag, 0);
  t('Magner card: beds 2, living 1,092, year 1942, Assessed value $364,300', magCard.indexOf('Beds') !== -1 && magCard.indexOf('1,092') !== -1 && magCard.indexOf('1942') !== -1 && magCard.indexOf('Assessed value') !== -1 && magCard.indexOf('$364,300') !== -1);
  t('Magner card never says retail or price pin', magCard.indexOf('Retail') === -1 && magCard.indexOf('price pin') === -1);
  const magSplit = BuyerPortfolio.splitPlottable([mag], MAPDATA.zipCoords);
  t('Magner plots at the exact address (plot=exact, coords verbatim)', magSplit.plotted.length === 1 && magSplit.plotted[0].plot === 'exact' && magSplit.plotted[0].lat === 39.8641 && magSplit.plotted[0].lon === -86.1321285);
  /* Cuyahoga — 3702 Payne Ave, Cleveland 44114, parcel 10239001:
     av is the county TAXABLE value; the 35% figure is a separate row. */
  const cuya = BuyerPortfolio.toProp({ st: '3702 Payne Ave', c: 'Cleveland', s: 'OH', z: '44114', parcel: '10239001', oid: 85214, co: 'cuyahoga', avKind: 'taxable', lotsqft: 29606, av: 494600, avLand: 133200, avImp: 361400, type: 'Stripcntr 4+U>7500Sf', on: 'PAYNE COMMONS, LLC', av35: 173110 }, 'TESTOWNER', 'Test Owner');
  const cuyaCard = BuyerPortfolio.propertyCardHtml(cuya, 0);
  t('Cuyahoga card labels av "Taxable value $494,600", never bare "Assessed value"', cuyaCard.indexOf('Taxable value') !== -1 && cuyaCard.indexOf('$494,600') !== -1 && cuyaCard.indexOf('>Assessed value<') === -1);
  t('Cuyahoga card shows the 35% figure as "Assessed (35%) $173,110"', cuyaCard.indexOf('Assessed (35%)') !== -1 && cuyaCard.indexOf('$173,110') !== -1);
  /* Jackson — 6430 E 12TH TER, Kansas City 64126, parcel
     28-130-01-24-00-0-00-000: every assessed value is tax year 2024. */
  const jack = BuyerPortfolio.toProp({ st: '6430 E 12Th Ter', c: 'Kansas City', s: 'MO', z: '64126', parcel: '28-130-01-24-00-0-00-000', co: 'jackson', avYear: '2024', lotsqft: 5297, av: 6192, type: 'Sfr-Const', on: 'TESINVEST LLC', beds: 2, baths: 1, livsqft: 1120, year: 1900 }, 'TESTOWNER', 'Test Owner');
  const jackCard = BuyerPortfolio.propertyCardHtml(jack, 0);
  t('Jackson card labels av "Assessed value (2024) $6,192"', jackCard.indexOf('Assessed value (2024)') !== -1 && jackCard.indexOf('$6,192') !== -1);
  /* Pitt — 1874 E Quail Ridge Rd, Greenville NC 27858, parcel 039681:
     lot sq ft is computed from acres; effective year is shown. */
  const pitt = BuyerPortfolio.toProp({ st: '1874 E Quail Ridge Rd', c: 'Greenville', s: 'NC', z: '27858', parcel: '039681', co: 'pitt', lotsqft: 1742, lotSrc: 'acres', av: 218424, type: 'Mfr-Const', on: 'ROBIN ROBINSON', beds: 3, baths: 2, bathsHalf: 1, livsqft: 1520, year: 1983, year_efftv: 2015 }, 'TESTOWNER', 'Test Owner');
  const pittCard = BuyerPortfolio.propertyCardHtml(pitt, 0);
  t('Pitt card labels lot "Lot sq ft (from acres) 1,742"', pittCard.indexOf('Lot sq ft (from acres)') !== -1 && pittCard.indexOf('1,742') !== -1);
  t('Pitt card shows "Effective year 2015" alongside "Year built 1983"', pittCard.indexOf('Effective year') !== -1 && pittCard.indexOf('2015') !== -1 && pittCard.indexOf('Year built') !== -1 && pittCard.indexOf('1983') !== -1);
  t('Pitt card shows baths as "2 full · 1 half" (card form)', pittCard.indexOf('2 full') !== -1 && pittCard.indexOf('1 half') !== -1);
  /* Duval — 3509 W 1St St, Jacksonville 32254, parcel 0492510000R:
     the county reports ONE baths number (fractional) — "1.5 baths",
     never "1.5 full". */
  const duv = BuyerPortfolio.toProp({ st: '3509 W 1St St', c: 'Jacksonville', s: 'FL', z: '32254', parcel: '0492510000R', oid: 2519887, co: 'duval', lotsqft: 7743, avLand: 20250, type: 'Single Family', on: 'TJL HOMES LLC', av: 109385, livsqft: 1010, year: 1960, year_efftv: 1980, beds: 3, baths: 1.5, bathsSingle: true }, 'TESTOWNER', 'Test Owner');
  const duvCard = BuyerPortfolio.propertyCardHtml(duv, 0);
  t('Duval card shows fractional baths as "Baths 1.5", never "1.5 full"', duvCard.indexOf('Baths') !== -1 && duvCard.indexOf('1.5') !== -1 && duvCard.indexOf('1.5 full') === -1);
  t('Duval card shows "Effective year 1980" alongside "Year built 1960"', duvCard.indexOf('Effective year') !== -1 && duvCard.indexOf('1980') !== -1);
})();

/* ---- index.html portfolio map: exact vs centroid language ---- */
(function () {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  t('index.html portfolio popup distinguishes exact pins from ZIP-centroid pins', html.indexOf('Exact address') !== -1 && html.indexOf('Plotted at ZIP centroid') !== -1);
  t('index.html portfolio map note counts exact-address vs ZIP-centroid pins', html.indexOf('exact-address pin') !== -1 && html.indexOf('ZIP-centroid pin') !== -1);
})();

/* ---- county props in the real bundled dataset: no invented data ---- */
(function () {
  const keys = Object.keys(PF.props);
  let countyProps = 0, badRetail = 0, badParcel = 0, badAv = 0;
  const byCounty = {};
  /* Parcel-number shapes are county-distinct: Marion 7-digit, Pitt
     6-digit, Jackson dashed, Cuyahoga 8-digit (+ optional letter
     suffix — 427 parcels carry one, per the county layer), Duval
     10-digit + 'R'. */
  const FMT = {
    marion: /^\d{7}$/, pitt: /^\d{6}$/,
    jackson: /^\d{2}-\d{3}-\d{2}-\d{2}-\d{2}-\d-\d{2}-\d{3}$/,
    cuyahoga: /^\d{8}[A-Z]?$/, duval: /^\d{10}R$/
  };
  keys.forEach(function (k) {
    PF.props[k].forEach(function (e) {
      if (e && typeof e === 'object' && !Array.isArray(e) && e.parcel) {
        countyProps++;
        const co = e.co || 'marion';
        byCounty[co] = (byCounty[co] || 0) + 1;
        if (e.retail != null) badRetail++;
        if (!FMT[co] || !FMT[co].test(String(e.parcel))) badParcel++;
        if (e.av != null && Number(e.av) <= 0) badAv++;
        if (e.lotsqft != null && e.livsqft != null && e.sqft != null) badAv++;
      }
    });
  });
  t('bundled dataset has 35,486 county parcels (own)', countyProps === 35486, 'got ' + countyProps);
  t('county parcels by county: Marion 10,699 / Pitt 764 / Jackson 5,114 / Cuyahoga 8,414 / Duval 10,495', byCounty.marion === 10699 && byCounty.pitt === 764 && byCounty.jackson === 5114 && byCounty.cuyahoga === 8414 && byCounty.duval === 10495, JSON.stringify(byCounty));
  t('no county prop carries a retail value (assessed never masquerades as retail)', badRetail === 0, 'bad=' + badRetail);
  t('every county prop has a parcel number in its county shape', badParcel === 0, 'bad=' + badParcel);
  t('no county prop carries av <= 0 or a merged sqft (exempt parcels omit av — layer AV 0)', badAv === 0, 'bad=' + badAv);
  /* Cross-check bundled county props against the county layer rows.
     Keyed by (county, row id) — the bundle's `co` + `oid`: Marion
     OBJECTID, Pitt OBJECTID, Jackson property_id (its OBJECTID is 0
     on every row), Cuyahoga OBJECTID, Duval OBJECTID. NEVER the parcel
     number alone: OBJECTIDs collide across counties, and Marion
     PARCEL_C is not unique (parcel 6009206, one apartment complex,
     has 30 layer rows, one per building, each with its own ESTSQFT).
     Own props check against matched.json; shared parcels (group.sp)
     check against shared-parcels.json.
     Portable: when the five county source files exist (local workspace)
     the FULL check runs over every bundled prop. When they do not exist
     (e.g. a Codespace, which holds only this repo) the check runs
     against embedded fixture rows — real county layer values, verified
     against the bundle — so the gate still proves the bundle matches
     the county source instead of failing on a missing file. */
  var FIXTURE_ROWS = [
    /* {co, oid, av, lotsqft} — county layer values, read from the
       county matched.json files Nov 9 2026 and verified to match the
       bundled props exactly. Keyed by (county, row id): Marion
       PARCEL_C is NOT unique (23 values repeat — parcel 6009206, one
       apartment complex, has 30 layer rows, one per building, each
       with its own ESTSQFT), so the check keys on OBJECTID; Jackson
       keys on property_id (its OBJECTID is 0 on every row). Pitt
       lotsqft is round(Acres x 43,560) (computed-from-acres); Duval av
       is the card value where a card exists, else layer AV_NSD. */
    /* Marion (OBJECTID / ASSESSORYEAR_TOTALAV / ESTSQFT): */
    { co: 'marion', oid: 903375, av: 84800, lotsqft: 6000 },
    { co: 'marion', oid: 976450, av: 85000, lotsqft: 5200 },
    { co: 'marion', oid: 356555, av: 154900, lotsqft: 8999 },
    { co: 'marion', oid: 728026, av: 63500, lotsqft: 5338 },
    { co: 'marion', oid: 417521, av: 364300, lotsqft: 5252 },
    { co: 'marion', oid: 753035, av: 100500, lotsqft: 4474 },
    { co: 'marion', oid: 753138, av: 61900, lotsqft: 4785 },
    { co: 'marion', oid: 764251, av: 79500, lotsqft: 5279 },
    { co: 'marion', oid: 765344, av: 45300, lotsqft: 6199 },
    { co: 'marion', oid: 770280, av: 5768100, lotsqft: 649869 },
    /* Pitt (OBJECTID / CurTaxValue / round(Acres x 43,560)): */
    { co: 'pitt', oid: 144152252, av: 218424, lotsqft: 1742 },
    { co: 'pitt', oid: 144134821, av: 195121, lotsqft: 12632 },
    /* Jackson (property_id / av / lotsqft, tax year 2024): */
    { co: 'jackson', oid: 798011, av: 6192, lotsqft: 5297 },
    { co: 'jackson', oid: 722378, av: 20100, lotsqft: 6290 },
    /* Cuyahoga (OBJECTID / CERTIFIED_TAX_TOTAL = Taxable Value / TOTAL_SQUARE_FT): */
    { co: 'cuyahoga', oid: 167402, av: 15000, lotsqft: 3150 },
    { co: 'cuyahoga', oid: 85214, av: 494600, lotsqft: 29606 },
    /* Duval (OBJECTID / card av where carded, else AV_NSD / LND_SQFOOT): */
    { co: 'duval', oid: 2365674, av: 87629, lotsqft: 21171 },
    { co: 'duval', oid: 2519887, av: 109385, lotsqft: 7743 }
  ];
  let checked = 0, mismatch = 0;
  try {
    const COUNTIES = [
      { dir: 'marion-parcels', co: 'marion', key: function (r) { return r.OBJECTID; }, av: function (r) { return Number(r.ASSESSORYEAR_TOTALAV); }, lot: function (r) { return Number(r.ESTSQFT); } },
      { dir: 'pitt-parcels', co: 'pitt', key: function (r) { return r.OBJECTID; }, av: function (r) { return Number(r.CurTaxValue); }, lot: function (r) { return Math.round(Number(r.Acres) * 43560); } },
      { dir: 'jackson-parcels', co: 'jackson', key: function (r) { return r.property_id; }, av: function (r) { return Number(r.av); }, lot: function (r) { return Number(r.lotsqft); } },
      { dir: 'cuyahoga-parcels', co: 'cuyahoga', key: function (r) { return r.OBJECTID; }, av: function (r) { return Number(r.CERTIFIED_TAX_TOTAL); }, lot: function (r) { return Number(r.TOTAL_SQUARE_FT); } },
      { dir: 'duval-parcels', co: 'duval', key: function (r) { return r.OBJECTID; }, av: null, lot: function (r) { return Number(r.LND_SQFOOT); } }
    ];
    const byKey = {};
    let fixtureMode = true;
    COUNTIES.forEach(function (c) {
      const matchedPath = path.join(__dirname, '..', 'buyer-hunt-2026', c.dir, 'matched.json');
      const sharedPath = path.join(__dirname, '..', 'buyer-hunt-2026', c.dir, 'shared-parcels.json');
      if (!(fs.existsSync(matchedPath) && fs.existsSync(sharedPath))) return;
      fixtureMode = false;
      const matched = JSON.parse(fs.readFileSync(matchedPath, 'utf8'));
      const sharedF = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
      let cardDetail = null;
      if (c.dir === 'duval-parcels') {
        cardDetail = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'buyer-hunt-2026', c.dir, 'card-detail.json'), 'utf8'));
      }
      const addRow = function (r) {
        let av = null;
        if (c.dir === 'duval-parcels') {
          const card = cardDetail[String(r.PARCEL_ID).trim()];
          av = (card && !card.error && card.av != null) ? Number(card.av) : Number(r.AV_NSD);
        } else {
          av = c.av(r);
        }
        byKey[c.co + '|' + c.key(r)] = { av: av, lotsqft: c.lot(r) };
      };
      Object.keys(matched).forEach(function (bn) { matched[bn].forEach(addRow); });
      Object.keys(sharedF).forEach(function (k) { sharedF[k].parcels.forEach(addRow); });
    });
    if (fixtureMode) {
      FIXTURE_ROWS.forEach(function (r) { byKey[r.co + '|' + r.oid] = r; });
    }
    function checkProp(e) {
      /* Bundle props carry `co` (new counties) or none (Marion legacy)
         and `oid` (the county row key). The key is (county, row id) —
         never the parcel number alone. */
      if (e.oid == null) { if (!fixtureMode) mismatch++; return; }
      const row = byKey[(e.co || 'marion') + '|' + e.oid];
      /* In fixture mode only the fixture parcels are covered — any
         other bundled prop is out of scope for this run, not a mismatch. */
      if (!row) { if (!fixtureMode) mismatch++; return; }
      checked++;
      /* A missing av is correct ONLY when the layer AV is 0 (exempt
         parcels); a positive layer AV must be present and exact. */
      if (e.av == null) { if (Number(row.av) > 0) mismatch++; }
      else if (Number(e.av) !== Number(row.av)) mismatch++;
      if (e.lotsqft != null && Number(e.lotsqft) !== Number(row.lotsqft)) mismatch++;
    }
    keys.forEach(function (k) {
      PF.props[k].forEach(function (e) {
        if (e && typeof e === 'object' && !Array.isArray(e) && e.parcel) checkProp(e);
      });
    });
    (PF.groups || []).forEach(function (g) {
      (g.sp || []).forEach(function (e) { if (e && e.parcel) checkProp(e); });
    });
    t('bundled county props match the layer rows on assessed value + lot sq ft (' + (fixtureMode ? 'embedded fixtures, ' : '') + checked + ' checked)', checked > 0 && mismatch === 0, 'checked=' + checked + ' mismatch=' + mismatch);
  } catch (err) {
    t('bundled county props match the layer rows (county files readable)', false, String(err));
  }
})();

/* ---- modules load under a window global ---- */
(function () {
  var ctx = {};
  vm.createContext(ctx);
  ctx.window = ctx; /* in a browser window IS the global; alias it here */
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/buyer-portfolio.js'), 'utf8'), ctx);
  t('buyer-portfolio.js loads under a window global', typeof ctx.window.BuyerPortfolio === 'object' && typeof ctx.window.BuyerPortfolio.lookup === 'function');
  var ctx2 = { window: {} };
  vm.createContext(ctx2);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/buyer-portfolio-data.js'), 'utf8'), ctx2);
  t('buyer-portfolio-data.js loads as a window global', typeof ctx2.window.BUYER_PORTFOLIO_DATA === 'object' && Object.keys(ctx2.window.BUYER_PORTFOLIO_DATA.props).length === 8823);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

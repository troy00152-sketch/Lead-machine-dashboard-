/* Buyer portfolio view — regression tests.
   Fixtures only, zero credits. Run: node buyer-portfolio-regression.js
   (exit 1 on any failure).
   Fixture buyers/properties are REAL records copied verbatim from
   assets/master-buyers.js (bundle) and assets/buyer-portfolio-data.js
   (built Nov 8 2026 by buyer-hunt-2026/build_buyer_portfolio_data.py
   from the county buyer files + all-buyers-10000 + lead-machine-buyers).
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

/* ---- lookup: shared tax mailing address (Alpine + Cornwall, 1848 N Alabama St) ---- */
(function () {
  const port = BuyerPortfolio.lookup(ALPINE.n, PF);
  t('Alpine lookup: 3 own + 3 shared (Cornwall), total 6', port.own.length === 3 && port.shared.length === 1 && port.shared[0].props.length === 3 && port.total === 6, 'own=' + port.own.length + ' sharedGroups=' + port.shared.length);
  t('Alpine shared group is Cornwall Expeditions Llc', port.shared[0] && port.shared[0].ownerName === 'Cornwall Expeditions Llc' && port.sharedOwnerNames.indexOf('Cornwall Expeditions Llc') !== -1);
  t('shared properties carry their REAL owner name, not Alpine', port.shared[0].props.every(function (p) { return p.ownerName === 'Cornwall Expeditions Llc'; }));
  t('Cornwall lookup mirrors: 3 own + 3 shared (Alpine)', (function () {
    const c = BuyerPortfolio.lookup(CORNWALL.n, PF);
    return c.own.length === 3 && c.shared.length === 1 && c.shared[0].ownerName === 'Alpine Property Management LLC' && c.total === 6;
  })());
})();

/* ---- lookup: no properties / unknown ---- */
t('Slb (720 properties on file, 0 sample addresses) -> empty portfolio', (function () { const p = BuyerPortfolio.lookup(SLB.n, PF); return p.total === 0 && p.own.length === 0 && p.shared.length === 0; })());
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
  t('plotted coords are the EXACT Census centroid for the ZIP', split.plotted.every(function (p) {
    const c = MAPDATA.zipCoords[p.z];
    return c && p.lat === c[0] && p.lon === c[1] && p.plot === 'zip';
  }));
  const noZip = BuyerPortfolio.splitPlottable([{ st: '1 No Zip Way', c: 'Charlotte', s: 'NC', z: '' }], MAPDATA.zipCoords);
  t('property with no ZIP is unplotted (list-only), never placed', noZip.plotted.length === 0 && noZip.unplotted.length === 1);
  const badZip = BuyerPortfolio.splitPlottable([{ st: '1 Bad Way', c: 'X', s: 'IN', z: '99999' }], MAPDATA.zipCoords);
  t('property with an unknown ZIP is unplotted, never guessed', badZip.plotted.length === 0 && badZip.unplotted.length === 1);
})();

/* ---- full bundled dataset integrity ---- */
(function () {
  const keys = Object.keys(PF.props);
  const bundleNames = new Set(BUNDLE.map(function (b) { return BuyerPortfolio.normName(b.n); }));
  t('portfolio covers 5,462 buyers (Nov 8 build)', keys.length === 5462, 'got ' + keys.length);
  const total = keys.reduce(function (a, k) { return a + PF.props[k].length; }, 0);
  t('portfolio holds 15,692 addresses (Nov 8 build)', total === 15692, 'got ' + total);
  t('every portfolio key maps to a real Master Buyers record', keys.every(function (k) { return bundleNames.has(k); }));
  t('112 shared-address groups, every member has properties', PF.groups.length === 112 && PF.groups.every(function (g) { return g.m.length >= 2 && g.m.every(function (m) { return (PF.props[m] || []).length > 0; }); }), 'got ' + PF.groups.length);
  /* No invented coordinates across the whole dataset: every plottable
     property's lat/lon must equal the Census centroid for its ZIP. */
  let bad = 0, plotted = 0, unplotted = 0;
  keys.forEach(function (k) {
    PF.props[k].forEach(function (e) {
      const p = BuyerPortfolio.toProp(e, k, k);
      const s = BuyerPortfolio.splitPlottable([p], MAPDATA.zipCoords);
      plotted += s.plotted.length; unplotted += s.unplotted.length;
      s.plotted.forEach(function (q) {
        const c = MAPDATA.zipCoords[q.z];
        if (!c || q.lat !== c[0] || q.lon !== c[1]) bad++;
      });
    });
  });
  t('no invented coordinates in the full dataset (' + plotted + ' plotted / ' + unplotted + ' unplotted)', bad === 0, 'bad=' + bad);
  t('plottable share is 5,849 of 15,692 (37.3% — ZIP in the Census table)', plotted === 5849, 'got ' + plotted);
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
  t('buyer-portfolio-data.js loads as a window global', typeof ctx2.window.BUYER_PORTFOLIO_DATA === 'object' && Object.keys(ctx2.window.BUYER_PORTFOLIO_DATA.props).length === 5462);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

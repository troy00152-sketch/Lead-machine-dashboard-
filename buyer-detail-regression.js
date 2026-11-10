/* Investor performance card + buyer detail — regression tests.
   Fixtures only, zero credits. Run: node buyer-detail-regression.js
   (exit 1 on any failure).
   Fixture buyers are REAL records copied verbatim from
   assets/master-buyers.js (bundle fields n/p/c/s/z/pc/st/ap/pv/w/sc/ti/fl),
   cross-checked against ~/workspace/buyer-hunt-2026/master-buyers.json.
   Nothing here is invented. The bundle was regenerated Nov 8 2026 with
   `fl` (flips from the source JSON; 0 = no flips on file, 2,657 of
   28,423 records have flips > 0). There is NO profit or appreciation
   field anywhere in the source data — the detail must never show one. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* Load the module (UMD -> module.exports in Node), the map module (for
   cross-module deep-link consistency), and the full buyer bundle. */
const BuyerDetail = require('./assets/buyer-detail.js');
const BuyerMap = require('./assets/buyer-map.js');
const bundleSrc = fs.readFileSync(path.join(__dirname, 'assets/master-buyers.js'), 'utf8');
const bundleCtx = { window: {} };
vm.createContext(bundleCtx);
vm.runInContext(bundleSrc, bundleCtx);
const BUNDLE = bundleCtx.window.MASTER_BUYERS;

/* Real fixtures, verbatim from the regenerated bundle. */
const REI = { n: 'Rei Nation LLC', p: '9012772207', c: 'Germantown', s: 'TN', z: '38183', pc: 220, st: 'Flipper+Landlord', ap: 135738, pv: 55768773, w: 0, sc: 85, ti: 'A - Top buyer', fl: 1561 };
const GILLS = { n: 'Gills Property Inc', p: '6096105779', c: 'Indianapolis', s: 'IN', z: '46237', pc: 11, st: 'Landlord', ap: 45273, pv: 1620298, w: 0, sc: 85, ti: 'A - Top buyer', fl: 0 };
const BSZ = { n: 'Bsz Rehab Business LLC', p: '3174506089', c: 'Indianapolis', s: 'IN', z: '46239', pc: 0, st: 'Flipper', ap: 0, pv: 0, w: 0, sc: 45, ti: 'C - Possible buyer', fl: 1 };
const LATITUDE = { n: 'Latitude Community Investments LLC', p: '3178091609', c: 'Indianapolis', s: 'IN', z: '46259', pc: 10, st: 'Flipper+Landlord', ap: 169100, pv: 2348175, w: 0, sc: 75, ti: 'B - Solid buyer', fl: 4 };
const SLB = { n: 'Slb Assets Ix LLC', p: '3179388454', c: 'Indianapolis', s: 'IN', z: '46202', pc: 720, st: 'Flipper+Landlord', ap: 1427317, pv: 140251214, w: 0, sc: 85, ti: 'A - Top buyer', fl: 67 };
const CITY = { n: 'City Of Indianapolis', p: '8128310827', c: 'Indianapolis', s: 'IN', z: '46204', pc: 40, st: 'Landlord', ap: 11069, pv: 442750, w: 0, sc: 65, ti: 'B - Solid buyer', fl: 0 };
const ELIASAR = { n: 'Eliasar Vasquez', p: '4802865991', c: '', s: 'IN', z: '00000', pc: 1, st: 'Landlord', ap: 10000, pv: 10000, w: 0, sc: 55, ti: 'C - Possible buyer', fl: 0 };
const TAYLOR = { n: 'Taylor Morrison Of Indiana LLC', p: '', c: 'Carmel', s: 'IN', z: '46032', pc: 0, st: 'Flipper', ap: 0, pv: 0, w: 0, sc: 20, ti: 'D - Thin data', fl: 16 };
const MARTIN = { n: 'Martin  Steele', p: '7574502721', c: 'Virginia Beach', s: 'VA', z: '23452', pc: 0, st: '', ap: 0, pv: 0, w: 0, sc: 25, ti: 'D - Thin data', fl: 0 };

console.log('buyer-detail regression:');

/* ---- money / count / shortMoney / flips helpers ---- */
t('money(0) is —, money(169100) is $169,100, money(null) is —', BuyerDetail.money(0) === '—' && BuyerDetail.money(169100) === '$169,100' && BuyerDetail.money(null) === '—');
t('money never renders $0', BuyerDetail.money(0).indexOf('$0') === -1 && BuyerDetail.money(null).indexOf('$0') === -1);
t('count renders thousands separators, count(0) is 0', BuyerDetail.count(720) === '720' && BuyerDetail.count(140251214) === '140,251,214' && BuyerDetail.count(0) === '0' && BuyerDetail.count(null) === '—');
t('shortMoney: $140.3M / $2.3M / $254K / —', BuyerDetail.shortMoney(140251214) === '$140.3M' && BuyerDetail.shortMoney(2348175) === '$2.3M' && BuyerDetail.shortMoney(254320) === '$254K' && BuyerDetail.shortMoney(0) === '—' && BuyerDetail.shortMoney(null) === '—');
t('flips: 1561 -> 1,561; 0 / null / missing -> —', BuyerDetail.flips(1561) === '1,561' && BuyerDetail.flips(1) === '1' && BuyerDetail.flips(0) === '—' && BuyerDetail.flips(null) === '—' && BuyerDetail.flips(undefined) === '—');
t('hasFlips: true only when fl > 0', BuyerDetail.hasFlips(REI) === true && BuyerDetail.hasFlips(BSZ) === true && BuyerDetail.hasFlips(GILLS) === false && BuyerDetail.hasFlips({}) === false && BuyerDetail.hasFlips({ fl: 0 }) === false);

/* ---- strategy roles ---- */
t('roles parses Flipper+Landlord', JSON.stringify(BuyerDetail.roles(SLB)) === JSON.stringify(['Flipper', 'Landlord']));
t('roles: landlord-only, flipper-only, empty', JSON.stringify(BuyerDetail.roles(GILLS)) === JSON.stringify(['Landlord']) && JSON.stringify(BuyerDetail.roles(BSZ)) === JSON.stringify(['Flipper']) && JSON.stringify(BuyerDetail.roles(MARTIN)) === JSON.stringify([]));
t('roles handles Lender in a combined strategy', JSON.stringify(BuyerDetail.roles({ st: 'Flipper+Lender' })) === JSON.stringify(['Flipper', 'Lender']));
t('isFlipper / isLandlord / isLender agree with roles', BuyerDetail.isFlipper(SLB) && BuyerDetail.isLandlord(SLB) && !BuyerDetail.isLender(SLB) && BuyerDetail.isLandlord(GILLS) && !BuyerDetail.isFlipper(GILLS) && BuyerDetail.isFlipper(BSZ) && !BuyerDetail.isLandlord(BSZ));
t('pillsHtml: Slb gets Flipper + Landlord pills', BuyerDetail.pillsHtml(SLB).indexOf('Flipper') !== -1 && BuyerDetail.pillsHtml(SLB).indexOf('Landlord') !== -1);
t('pillsHtml: Gills gets Landlord only, Martin gets none', BuyerDetail.pillsHtml(GILLS).indexOf('Flipper') === -1 && BuyerDetail.pillsHtml(GILLS).indexOf('Landlord') !== -1 && BuyerDetail.pillsHtml(MARTIN) === '');
t('pillsHtml escapes HTML', BuyerDetail.pillsHtml({ st: 'Flipper', n: 'X' }).indexOf('<script>') === -1 && BuyerDetail.pillsHtml({ st: '<script>' }).indexOf('<script>') === -1);

/* ---- buy box ---- */
t('buyBoxText: Latitude = Flipper+Landlord · $169K avg', BuyerDetail.buyBoxText(LATITUDE) === 'Flipper+Landlord · $169K avg');
t('buyBoxText: Gills = Landlord · $45K avg', BuyerDetail.buyBoxText(GILLS) === 'Landlord · $45K avg');
t('buyBoxText empty when no strategy and no avg', BuyerDetail.buyBoxText(MARTIN) === '');

/* ---- card metrics ---- */
var mRei = BuyerDetail.cardMetrics(REI);
t('cardMetrics Rei: flips 1,561 present, props 220, avg $135,738, portfolio $55,768,773', mRei[0].value === '1,561' && mRei[0].present === true && mRei[1].value === '220' && mRei[2].value === '$135,738' && mRei[3].value === '$55,768,773');
var mGills = BuyerDetail.cardMetrics(GILLS);
t('cardMetrics Gills: flips — (not present), props 11, avg $45,273', mGills[0].value === '—' && mGills[0].present === false && mGills[1].value === '11' && mGills[2].value === '$45,273');
var mBsz = BuyerDetail.cardMetrics(BSZ);
t('cardMetrics Bsz: flips 1 present, avg buy —, portfolio —', mBsz[0].value === '1' && mBsz[0].present === true && mBsz[2].value === '—' && mBsz[3].value === '—');
var mMartin = BuyerDetail.cardMetrics(MARTIN);
t('cardMetrics Martin: flips —, avg —, portfolio —', mMartin[0].value === '—' && mMartin[2].value === '—' && mMartin[3].value === '—');

/* ---- detail: flip-heavy buyer (Rei Nation) ---- */
var dRei = BuyerDetail.detailHtml(REI, { rank: 1, total: 28423, globalIndex: 0, verifiedBadge: '' });
t('detail Rei: rank + name + place', dRei.indexOf('#1 of 28,423') !== -1 && dRei.indexOf('Rei Nation LLC') !== -1 && dRei.indexOf('Germantown, TN, 38183') !== -1);
t('detail Rei: phone as tel link', dRei.indexOf('tel:+19012772207') !== -1 && dRei.indexOf('9012772207') !== -1);
t('detail Rei: BOTH Landlord and Flipper Insights', dRei.indexOf('Landlord Insights') !== -1 && dRei.indexOf('Flipper Insights') !== -1);
t('detail Rei: flips 1,561 and portfolio $55,768,773', dRei.indexOf('1,561') !== -1 && dRei.indexOf('$55,768,773') !== -1);
t('detail Rei: buy box + tier shown', dRei.indexOf('Flipper+Landlord · $136K avg') !== -1 && dRei.indexOf('A - Top buyer') !== -1);
t('detail Rei: action buttons resolve to globalIndex 0', dRei.indexOf('mbShowOnMap(0)') !== -1 && dRei.indexOf('mbFocusBuyer(0)') !== -1 && dRei.indexOf('mbCloseDetail()') !== -1);

/* ---- detail: landlord-only buyer (Gills) ---- */
var dGills = BuyerDetail.detailHtml(GILLS, { rank: 5, total: 28423, globalIndex: 4, verifiedBadge: '' });
t('detail Gills: Landlord Insights, NO Flipper Insights', dGills.indexOf('Landlord Insights') !== -1 && dGills.indexOf('Flipper Insights') === -1);
t('detail Gills: flips — (not on file) is honest, no invented count', dGills.indexOf('Landlord Insights') !== -1 && dGills.indexOf('(not on file)') === -1 && dGills.indexOf('Flips') === -1);
t('detail Gills: portfolio $1,620,298 + avg $45,273', dGills.indexOf('$1,620,298') !== -1 && dGills.indexOf('$45,273') !== -1);

/* ---- detail: thin-data flipper (Bsz) ---- */
var dBsz = BuyerDetail.detailHtml(BSZ, { rank: 11, total: 28423, globalIndex: 10, verifiedBadge: '' });
t('detail Bsz: Flipper Insights, NO Landlord Insights', dBsz.indexOf('Flipper Insights') !== -1 && dBsz.indexOf('Landlord Insights') === -1);
t('detail Bsz: flips 1 shown, avg buy — (never $0)', dBsz.indexOf('>1<') !== -1 && dBsz.indexOf('Avg purchase') !== -1 && dBsz.indexOf('$0') === -1);
t('detail Bsz: no $0 anywhere', dBsz.indexOf('$0') === -1);

/* ---- detail: no-phone, no-strategy, no-ZIP edge cases ---- */
var dTaylor = BuyerDetail.detailHtml(TAYLOR, { rank: 3, total: 28423, globalIndex: 2, verifiedBadge: '' });
t('detail Taylor (no phone): phone row is —, no tel: link', dTaylor.indexOf('tel:') === -1 && dTaylor.indexOf('Phone') !== -1);
t('detail Taylor: flips 16 shown despite zero portfolio', dTaylor.indexOf('>16<') !== -1 && dTaylor.indexOf('Flipper Insights') !== -1);
var dMartin = BuyerDetail.detailHtml(MARTIN, { rank: 9, total: 28423, globalIndex: 8, verifiedBadge: '' });
t('detail Martin (no strategy): NO Insights sections at all', dMartin.indexOf('Insights') === -1);
t('detail Martin: Buy box not on file', dMartin.indexOf('Buy box not on file') !== -1);
var dEli = BuyerDetail.detailHtml(ELIASAR, { rank: 17, total: 28423, globalIndex: 16, verifiedBadge: '' });
t('detail Eliasar (no ZIP): place shows state only, no invented ZIP', dEli.indexOf('00000') === -1 && dEli.indexOf('>IN<') !== -1);

/* ---- detail: verified badge passthrough + escaping ---- */
var dSlb = BuyerDetail.detailHtml(SLB, { rank: 1, total: 28423, globalIndex: 0, verifiedBadge: ' <span>✅</span>' });
t('detail passes the verified badge through', dSlb.indexOf('✅') !== -1);
t('detail escapes HTML in names', BuyerDetail.detailHtml({ n: 'X <script>alert(1)</script>', c: 'Y', s: 'IN', z: '46202' }, { rank: 1, globalIndex: 0 }).indexOf('<script>') === -1);

/* ---- detail: NO profit, NO appreciation — the hard rule ---- */
[REI, GILLS, BSZ, LATITUDE, SLB, CITY, ELIASAR, TAYLOR, MARTIN].forEach(function (b, i) {
  var h = BuyerDetail.detailHtml(b, { rank: i + 1, total: 28423, globalIndex: i, verifiedBadge: '' });
  t('detail ' + b.n + ': no profit figure of any kind', !/Total Profit|Gross Profit|Net Profit|Profit Margin|Avg\.? Gross|profit:/i.test(h));
  t('detail ' + b.n + ': no appreciation section or figure', !/Appreciation<\/|appreciation:\s*\$|appreciation:\s*\d/i.test(h));
  t('detail ' + b.n + ': carries the no-deed-history note', h.indexOf('no deed buy-vs-sell history') !== -1);
});

/* ---- deep-link consistency: list / detail / map resolve to one record ---- */
var pop7 = BuyerMap.popupHtml({ rec: SLB, rank: 1, globalIndex: 7 });
t('map popup for the same buyer calls mbOpenDetail(7) + mbFocusBuyer(7)', pop7.indexOf('mbOpenDetail(7)') !== -1 && pop7.indexOf('mbFocusBuyer(7)') !== -1);
var d7 = BuyerDetail.detailHtml(SLB, { rank: 8, total: 28423, globalIndex: 7, verifiedBadge: '' });
t('detail for the same buyer calls mbShowOnMap(7) + mbFocusBuyer(7)', d7.indexOf('mbShowOnMap(7)') !== -1 && d7.indexOf('mbFocusBuyer(7)') !== -1);
t('map tooltip and detail agree on Slb figures (one source of truth)', BuyerMap.tooltipHtml({ rec: SLB, rank: 1, globalIndex: 7 }).indexOf('$140,251,214') !== -1 && d7.indexOf('$140,251,214') !== -1 && d7.indexOf('67') !== -1);

/* ---- bundle field presence (full 28,670-record bundle; was 28,423 before the Nov 9 trace merge: +248 merged, −1 CASH4YOURHOME dropped) ---- */
t('bundle has 28,670 records', BUNDLE.length === 28670);
t('every bundle record carries fl (number)', BUNDLE.every(function (r) { return typeof r.fl === 'number'; }));
t('bundle flips>0 count is exactly 2,657', BUNDLE.filter(function (r) { return r.fl > 0; }).length === 2657);
t('bundle Rei Nation matches source JSON exactly', (function () {
  var r = BUNDLE.filter(function (x) { return x.n === 'Rei Nation LLC'; })[0];
  return r && r.pc === 220 && r.ap === 135738 && r.pv === 55768773 && r.fl === 1561 && r.sc === 85;
})());
t('bundle Gills flips is 0 (not on file), not invented', (function () {
  var r = BUNDLE.filter(function (x) { return x.n === 'Gills Property Inc'; })[0];
  return r && r.fl === 0;
})());

/* ---- static wiring checks on index.html ---- */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
t('index.html loads assets/buyer-detail.js', html.indexOf('<script src="assets/buyer-detail.js"></script>') !== -1);
t('index.html has the buyer detail modal markup', html.indexOf('id="mbDetailModal"') !== -1 && html.indexOf('id="mbDetailBody"') !== -1 && html.indexOf('id="mbDetailTitle"') !== -1);
t('index.html defines mbOpenDetail / mbCloseDetail / mbShowOnMap', html.indexOf('function mbOpenDetail(') !== -1 && html.indexOf('function mbCloseDetail(') !== -1 && html.indexOf('function mbShowOnMap(') !== -1);
t('index.html list rows carry a Flips column + View button', html.indexOf('>Flips</th>') !== -1 && html.indexOf('mbOpenDetail(${gi})') !== -1);
t('index.html list rows show strategy pills + portfolio value', html.indexOf('pillsHtml(b)') !== -1 && html.indexOf('shortMoney(b.pv)') !== -1);
t('index.html map keeps a per-buyer marker index for View on map', html.indexOf('mbMapMarkerByIndex') !== -1 && html.indexOf('mbMapMarkerByIndex[p.globalIndex] = m') !== -1);
t('index.html renders no profit figures in the Master Buyers code', !/Total Profit|Gross Profit/i.test(html.slice(html.indexOf('/* Master Buyers'), html.indexOf('/* ============ MASTER BUYERS — MAP VIEW'))));

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

/* ---- module loads under a window global ---- */
(function () {
  var ctx = {};
  vm.createContext(ctx);
  ctx.window = ctx; /* in a browser window IS the global; alias it here */
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/buyer-detail.js'), 'utf8'), ctx);
  t('buyer-detail.js loads under a window global', typeof ctx.window.BuyerDetail === 'object' && typeof ctx.window.BuyerDetail.detailHtml === 'function');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

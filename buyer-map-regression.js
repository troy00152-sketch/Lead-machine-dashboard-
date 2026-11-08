/* Ranked investor map — regression tests. Fixtures only, zero credits.
   Run: node buyer-map-regression.js (exit 1 on any failure).
   Fixture buyers are REAL records copied verbatim from
   assets/master-buyers.js (bundle fields n/p/c/s/z/pc/st/ap/pv/w/sc/ti/fl),
   cross-checked against ~/workspace/buyer-hunt-2026/master-buyers.json.
   Coordinates come only from assets/buyer-map-data.js (Census 2025
   Gazetteer ZCTA centroids, bundled Nov 8 2026). Nothing here is invented.
   Coverage tests load the full buyer bundle and assert plotted % overall
   and per market against the bundled centroid table. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* Load the module (UMD -> module.exports in Node) and the bundled data. */
const BuyerMap = require('./assets/buyer-map.js');
const dataSrc = fs.readFileSync(path.join(__dirname, 'assets/buyer-map-data.js'), 'utf8');
const dataCtx = { window: {} };
vm.createContext(dataCtx);
vm.runInContext(dataSrc, dataCtx);
const DATA = dataCtx.window.BUYER_MAP_DATA;

/* 16 real Indianapolis-metro buyers, bundle fields verbatim, plus one real
   no-ZIP record (Eliasar Vasquez, z 00000, blank city) for the unplotted
   path — it is a real bundle record, not a synthetic one. */
const FIXTURES = [
  { n: 'Slb Assets Ix LLC', p: '3179388454', c: 'Indianapolis', s: 'IN', z: '46202', pc: 720, st: 'Flipper+Landlord', ap: 1427317, pv: 140251214, w: 0, sc: 85, ti: 'A - Top buyer', fl: 67 },
  { n: 'In Motion Homes', p: '3174078418', c: 'Indianapolis', s: 'IN', z: '46214', pc: 230, st: 'Flipper+Landlord', ap: 13624, pv: 32917377, w: 0, sc: 85, ti: 'A - Top buyer', fl: 54 },
  { n: 'Indy Boo Boo LLC', p: '7073499250', c: 'Indianapolis', s: 'IN', z: '46227', pc: 123, st: 'Flipper+Landlord', ap: 509261, pv: 26279658, w: 0, sc: 85, ti: 'A - Top buyer', fl: 204 },
  { n: '22nd And Wyandotte LLC', p: '3175016452', c: 'Indianapolis', s: 'IN', z: '46203', pc: 64, st: 'Flipper+Landlord', ap: 140277, pv: 8548247, w: 0, sc: 75, ti: 'B - Solid buyer', fl: 4 },
  { n: 'Ownez Holdings 1 LLC', p: '9512286086', c: 'Indianapolis', s: 'IN', z: '46268', pc: 41, st: 'Flipper+Landlord', ap: 91461, pv: 7788153, w: 0, sc: 85, ti: 'A - Top buyer', fl: 31 },
  { n: 'Grace Home LLC', p: '3174124701', c: 'Indianapolis', s: 'IN', z: '46239', pc: 40, st: 'Flipper+Landlord', ap: 105365, pv: 6997834, w: 0, sc: 75, ti: 'B - Solid buyer', fl: 38 },
  { n: 'City Of Indianapolis', p: '8128310827', c: 'Indianapolis', s: 'IN', z: '46204', pc: 40, st: 'Landlord', ap: 11069, pv: 442750, w: 0, sc: 65, ti: 'B - Solid buyer', fl: 0 },
  { n: 'Rtolt LLC', p: '4632495426', c: 'Indianapolis', s: 'IN', z: '46250', pc: 34, st: 'Flipper+Landlord', ap: 35618, pv: 6186963, w: 0, sc: 85, ti: 'A - Top buyer', fl: 2 },
  { n: 'Christopher F. Meyer', p: '3175900961', c: 'Indianapolis', s: 'IN', z: '46220', pc: 29, st: 'Landlord', ap: 29449, pv: 4661127, w: 0, sc: 85, ti: 'A - Top buyer', fl: 0 },
  { n: 'Bilal Karim LLC', p: '3179036046', c: 'Indianapolis', s: 'IN', z: '46278', pc: 24, st: 'Flipper+Landlord', ap: 11885, pv: 3000035, w: 0, sc: 75, ti: 'B - Solid buyer', fl: 5 },
  { n: 'Bsz Rehab Business LLC', p: '3174506089', c: 'Indianapolis', s: 'IN', z: '46239', pc: 0, st: 'Flipper', ap: 0, pv: 0, w: 0, sc: 45, ti: 'C - Possible buyer', fl: 1 },
  { n: 'Nathaniel  Smith', p: '9174555667', c: 'Indianapolis', s: 'IN', z: '46219', pc: 0, st: 'Flipper', ap: 0, pv: 0, w: 0, sc: 55, ti: 'C - Possible buyer', fl: 3 },
  { n: 'R & N Rei LLC', p: '3174807208', c: 'Indianapolis', s: 'IN', z: '46227', pc: 0, st: 'Flipper', ap: 0, pv: 0, w: 0, sc: 55, ti: 'C - Possible buyer', fl: 27 },
  { n: 'Tlc Investments Indy LLC', p: '3176505028', c: 'Greenwood', s: 'IN', z: '46142', pc: 1, st: 'Flipper+Landlord', ap: 136000, pv: 254320, w: 0, sc: 75, ti: 'B - Solid buyer', fl: 8 },
  { n: 'Tranquil Abodes LLC', p: '3179192303', c: 'Carmel', s: 'IN', z: '46032', pc: 7, st: 'Flipper+Landlord', ap: 672258, pv: 1004819, w: 0, sc: 85, ti: 'A - Top buyer', fl: 24 },
  { n: 'Kai Holdings LLC', p: '7633509442', c: 'Fishers', s: 'IN', z: '46038', pc: 16, st: 'Flipper+Landlord', ap: 90863, pv: 3050261, w: 0, sc: 85, ti: 'A - Top buyer', fl: 19 },
  { n: 'Eliasar Vasquez', p: '4802865991', c: '', s: 'IN', z: '00000', pc: 1, st: 'Landlord', ap: 10000, pv: 10000, w: 0, sc: 55, ti: 'C - Possible buyer', fl: 0 }
];

console.log('buyer-map regression:');

/* ---- ranking ---- */
var ranked = BuyerMap.rankPage(FIXTURES, 0, 50);
t('rankPage page 0 numbers 1..17 in list order', ranked.length === 17 && ranked[0].rank === 1 && ranked[0].rec.n === 'Slb Assets Ix LLC' && ranked[15].rank === 16 && ranked[15].rec.n === 'Kai Holdings LLC' && ranked[16].rank === 17 && ranked[16].rec.n === 'Eliasar Vasquez');
t('rankPage globalIndex tracks full-results position', ranked[5].globalIndex === 5 && ranked[5].rec.n === 'Grace Home LLC');
var page2 = BuyerMap.rankPage(FIXTURES, 1, 10);
t('rankPage page 1 (perPage 10) ranks 11..17', page2.length === 7 && page2[0].rank === 11 && page2[0].globalIndex === 10 && page2[6].rank === 17);
t('rankPage empty input returns empty', BuyerMap.rankPage([], 0, 50).length === 0);
t('rankPage beyond last page returns empty', BuyerMap.rankPage(FIXTURES, 5, 50).length === 0);

/* ---- plottable split: no invented coordinates ---- */
var split = BuyerMap.splitPlottable(ranked, DATA.zipCoords);
t('splitPlottable: 16 plotted, 1 unplotted of 17 fixtures', split.plotted.length === 16 && split.unplotted.length === 1);
t('unplotted is the no-ZIP record (00000, no ZCTA exists)', split.unplotted.length === 1 && split.unplotted[0].rec.z === '00000');
t('Carmel (46032) and Fishers (46038) now plot — full ZIP table, not the old 12', split.plotted.some(function (p) { return p.rec.z === '46032'; }) && split.plotted.some(function (p) { return p.rec.z === '46038'; }));
t('unplotted keeps its rank (17, not renumbered)', split.unplotted.every(function (u) { return u.rank === 17; }));
var slb = split.plotted.find(function (p) { return p.rec.n === 'Slb Assets Ix LLC'; });
t('plotted lat/lon copied EXACTLY from centroid table (no rounding/jitter)', slb && slb.lat === 39.7841 && slb.lon === -86.161616 && slb.plot === 'zip');
t('same-ZIP buyers both plotted at identical coords (no dedup, no offset)', (function () {
  var z39 = split.plotted.filter(function (p) { return p.rec.z === '46239'; });
  var z27 = split.plotted.filter(function (p) { return p.rec.z === '46227'; });
  return z39.length === 2 && z39[0].lat === z39[1].lat && z39[0].lon === z39[1].lon &&
         z27.length === 2 && z27[0].lat === z27[1].lat;
})());
t('unplotted records carry no lat/lon at all', split.unplotted.every(function (u) { return u.lat === undefined && u.lon === undefined; }));
t('splitPlottable with empty table plots nothing, unplots everything', (function () {
  var s = BuyerMap.splitPlottable(ranked, {});
  return s.plotted.length === 0 && s.unplotted.length === 17;
})());

/* ---- tooltip: real fields only, flips when on file, never profit ---- */
var tipSlb = BuyerMap.tooltipHtml({ rec: FIXTURES[0], rank: 1, globalIndex: 0 });
t('tooltip shows rank + name + properties + avg buy + portfolio + tier', tipSlb.indexOf('#1') !== -1 && tipSlb.indexOf('Slb Assets Ix LLC') !== -1 && tipSlb.indexOf('720 properties') !== -1 && tipSlb.indexOf('$1,427,317') !== -1 && tipSlb.indexOf('$140,251,214') !== -1 && tipSlb.indexOf('A - Top buyer') !== -1);
var tipBsz = BuyerMap.tooltipHtml({ rec: FIXTURES[10], rank: 11, globalIndex: 10 });
t('tooltip renders zero-data fields as — (never $0)', tipBsz.indexOf('0 properties') !== -1 && tipBsz.indexOf('Avg buy —') !== -1 && tipBsz.indexOf('Portfolio —') !== -1 && tipBsz.indexOf('$0') === -1);
t('tooltip shows flips when on file (Slb fl=67)', tipSlb.indexOf('Flips 67') !== -1);
t('tooltip omits flips when fl=0 (City Of Indianapolis)', BuyerMap.tooltipHtml({ rec: FIXTURES[6], rank: 7, globalIndex: 6 }).indexOf('Flips') === -1);
t('tooltip never claims profit (no such field anywhere)', !/profit/i.test(tipSlb) && !/profit/i.test(tipBsz));
t('tooltip escapes HTML in names', BuyerMap.tooltipHtml({ rec: { n: 'A <b> & Co', pc: 1, ap: 100, pv: 200, ti: 'A' }, rank: 1 }).indexOf('<b>') === -1);

/* ---- popup: deep link + honesty note ---- */
var pop = BuyerMap.popupHtml({ rec: FIXTURES[0], rank: 1, globalIndex: 0 });
t('popup has deep-link button to globalIndex 0', pop.indexOf('mbFocusBuyer(0)') !== -1);
t('popup has View details button to globalIndex 0', pop.indexOf('mbOpenDetail(0)') !== -1);
var popLast = BuyerMap.popupHtml({ rec: FIXTURES[15], rank: 16, globalIndex: 15 });
t('popup deep-link tracks the buyer (globalIndex 15)', popLast.indexOf('mbFocusBuyer(15)') !== -1);
t('popup shows place, strategy, score, phone', pop.indexOf('Indianapolis') !== -1 && pop.indexOf('Flipper+Landlord') !== -1 && pop.indexOf('85%') !== -1 && pop.indexOf('3179388454') !== -1);
t('popup carries the ZIP-centroid honesty note', pop.indexOf('ZIP centroid') !== -1);
t('popup escapes HTML in names', BuyerMap.popupHtml({ rec: { n: 'X <script>', c: 'Y', s: 'IN', z: '46202' }, rank: 1, globalIndex: 0 }).indexOf('<script>') === -1);

/* ---- money / count helpers ---- */
t('money(0) is —, money(1427317) is $1,427,317, money(null) is —', BuyerMap.money(0) === '—' && BuyerMap.money(1427317) === '$1,427,317' && BuyerMap.money(null) === '—');
t('count renders thousands separators', BuyerMap.count(140251214) === '140,251,214');

/* ---- point-in-polygon ---- */
var square = [[39.7, -86.2], [39.7, -86.1], [39.8, -86.1], [39.8, -86.2], [39.7, -86.2]];
t('pointInPolygon: inside point', BuyerMap.pointInPolygon(39.75, -86.15, square) === true);
t('pointInPolygon: outside point', BuyerMap.pointInPolygon(39.9, -86.15, square) === false);
t('pointInPolygon: degenerate ring (<4 pts) is false', BuyerMap.pointInPolygon(39.75, -86.15, [[39.7, -86.2], [39.7, -86.1]]) === false);
t('pointInPolygon: empty ring is false', BuyerMap.pointInPolygon(39.75, -86.15, []) === false);

/* ---- draw-area filter ---- */
var downtown = [[39.76, -86.18], [39.76, -86.13], [39.80, -86.13], [39.80, -86.18], [39.76, -86.18]];
var inside = BuyerMap.filterInside(split.plotted, downtown);
t('filterInside downtown box keeps only 46202/46204 pins', inside.length === 2 && inside.every(function (p) { return p.rec.z === '46202' || p.rec.z === '46204'; }));
t('filterInside with no ring returns all plotted', BuyerMap.filterInside(split.plotted, null).length === 16);
t('filterInside with ring covering nothing returns none', BuyerMap.filterInside(split.plotted, [[30, -81], [30, -80], [31, -80], [31, -81], [30, -81]]).length === 0);

/* ---- boundaries: bundled GeoJSON converts cleanly ---- */
var indyRings = BuyerMap.geojsonToLatLngs(DATA.boundaries.indianapolis);
t('Indianapolis boundary converts with no issues (4 rings, holes kept)', indyRings.issues.length === 0 && indyRings.rings.length === 4);
Object.keys(DATA.boundaries).forEach(function (k) {
  var r = BuyerMap.geojsonToLatLngs(DATA.boundaries[k]);
  t('boundary ' + k + ' converts cleanly', r.issues.length === 0 && r.rings.length > 0);
});
t('all 11 Indianapolis fixture ZIP centroids fall inside the city boundary', (function () {
  var outer = indyRings.rings[0];
  var indyZips = ['46202', '46203', '46204', '46214', '46219', '46220', '46227', '46239', '46250', '46268', '46278'];
  return indyZips.every(function (z) { var c = DATA.zipCoords[z]; return c && BuyerMap.pointInPolygon(c[0], c[1], outer); });
})());
t('Greenwood ZIP centroid (46142) falls OUTSIDE the city boundary', (function () {
  var outer = indyRings.rings[0];
  var c = DATA.zipCoords['46142'];
  return BuyerMap.pointInPolygon(c[0], c[1], outer) === false;
})());
t('Greenville city centre falls inside its main boundary part', (function () {
  var main = BuyerMap.geojsonToLatLngs(DATA.boundaries.carolina).rings[2];
  return BuyerMap.pointInPolygon(35.6132240, -77.3724593, main);
})());
t('geojsonToLatLngs reports an unclosed ring instead of fixing it', (function () {
  var r = BuyerMap.geojsonToLatLngs({ type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]] });
  return r.issues.length === 1 && /not closed/.test(r.issues[0]);
})());

/* ---- map search matching ---- */
t('marketForQuery "indianapolis" -> market', (function () { var r = BuyerMap.marketForQuery('indianapolis', DATA); return r && r.kind === 'market' && r.key === 'indianapolis'; })());
t('marketForQuery "Indianapolis, IN" -> market', (function () { var r = BuyerMap.marketForQuery('Indianapolis, IN', DATA); return r && r.kind === 'market'; })());
t('marketForQuery "46202" -> zip with exact Census centroid', (function () { var r = BuyerMap.marketForQuery('46202', DATA); return r && r.kind === 'zip' && r.lat === 39.7841 && r.lon === -86.161616; })());
t('marketForQuery "44113" (Cleveland) -> zip', (function () { var r = BuyerMap.marketForQuery('44113', DATA); return r && r.kind === 'zip' && r.lat === 41.483241 && r.lon === -81.697166; })());
t('marketForQuery "64106" (Kansas City) -> zip', (function () { var r = BuyerMap.marketForQuery('64106', DATA); return r && r.kind === 'zip' && r.lat === 39.105274 && r.lon === -94.570088; })());
t('marketForQuery "27834" (Greenville NC) -> zip', (function () { var r = BuyerMap.marketForQuery('27834', DATA); return r && r.kind === 'zip' && r.lat === 35.65677 && r.lon === -77.379527; })());
t('marketForQuery "32202" (Jacksonville) -> zip', (function () { var r = BuyerMap.marketForQuery('32202', DATA); return r && r.kind === 'zip' && r.lat === 30.32462 && r.lon === -81.647232; })());
t('marketForQuery "45402" (Dayton) -> zip', (function () { var r = BuyerMap.marketForQuery('45402', DATA); return r && r.kind === 'zip' && r.lat === 39.760114 && r.lon === -84.207627; })());
t('marketForQuery "00000" -> null (junk ZIP never guesses)', BuyerMap.marketForQuery('00000', DATA) === null);
t('marketForQuery "99999" -> null (never guesses)', BuyerMap.marketForQuery('99999', DATA) === null);
t('marketForQuery "nowhere" -> null', BuyerMap.marketForQuery('nowhere', DATA) === null);
t('marketForQuery empty -> null', BuyerMap.marketForQuery('', DATA) === null);

/* ---- bundled data validates clean ---- */
var issues = BuyerMap.validateData(DATA);
t('validateData: bundled data has zero issues', issues.length === 0, issues.join('; '));
t('validateData: catches a bad centroid', BuyerMap.validateData({ zipCoords: { '46202': [999, 0] }, centers: {}, markets: {}, boundaries: {} }).length > 0);
t('validateData: catches a missing market boundary', (function () {
  var d = JSON.parse(JSON.stringify(DATA)); delete d.boundaries.dayton;
  return BuyerMap.validateData(d).some(function (i) { return /dayton/.test(i); });
})());

/* ---- tile sources: free, no key ---- */
t('street tiles are OSM (free, no key)', BuyerMap.TILES.street.url.indexOf('tile.openstreetmap.org') !== -1);
t('satellite tiles are Esri World Imagery (free, no key)', BuyerMap.TILES.satellite.url.indexOf('server.arcgisonline.com') !== -1 && BuyerMap.TILES.satellite.url.indexOf('World_Imagery') !== -1);

/* ---- static wiring checks on index.html ---- */
var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
t('index.html loads buyer-map-data.js', html.indexOf('assets/buyer-map-data.js') !== -1);
t('index.html loads buyer-map.js', html.indexOf('assets/buyer-map.js') !== -1);
t('index.html loads buyer-map data BEFORE the module', html.indexOf('assets/buyer-map-data.js') < html.indexOf('assets/buyer-map.js'));
t('index.html has the Map view container #mbMap', html.indexOf('id="mbMap"') !== -1);
t('index.html has List/Map toggle buttons', html.indexOf('mbViewListBtn') !== -1 && html.indexOf('mbViewMapBtn') !== -1);
t('index.html has the map note line #mbMapNote', html.indexOf('id="mbMapNote"') !== -1);
t('index.html has the map search box #mbMapSearch', html.indexOf('id="mbMapSearch"') !== -1);
t('index.html has street/satellite toggle', html.indexOf('mbTilesStreet') !== -1 && html.indexOf('mbTilesSat') !== -1);
t('index.html has draw-area controls', html.indexOf('mbDrawBtn') !== -1 && html.indexOf('mbClearDrawBtn') !== -1);
t('index.html wires renderBuyerMap + mbFocusBuyer', html.indexOf('function renderBuyerMap') !== -1 && html.indexOf('function mbFocusBuyer') !== -1);
t('list rows carry an id for deep-link highlight (mbRow-)', html.indexOf('mbRow-') !== -1);
t('index.html still loads Leaflet + markercluster (clustering source)', html.indexOf('leaflet@1.9.4') !== -1 && html.indexOf('leaflet.markercluster') !== -1);
t('buyer-map.js contains no jitter/random placement', (function () {
  var src = fs.readFileSync(path.join(__dirname, 'assets/buyer-map.js'), 'utf8');
  var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return code.indexOf('Math.random') === -1 && /jitter/i.test(code) === false;
})());
t('buyer-map-data.js still parses as a script', (function () {
  try { new vm.Script(dataSrc); return true; } catch (e) { return false; }
})());

/* ---- coverage: full buyer bundle vs the centroid table ---- */
/* Market = the market city itself (city + state exact), matching the
   map's six markets. "Other" is every buyer outside those cities. */
function marketOfRec(b) {
  var c = String(b.c || '').trim().toLowerCase();
  var s = String(b.s || '').trim().toUpperCase();
  if (c === 'indianapolis' && s === 'IN') return 'indianapolis';
  if (c === 'cleveland' && s === 'OH') return 'cleveland';
  if (c === 'kansas city' && (s === 'MO' || s === 'KS')) return 'kansascity';
  if (c === 'greenville' && s === 'NC') return 'carolina';
  if (c === 'jacksonville' && s === 'FL') return 'jacksonville';
  if (c === 'dayton' && s === 'OH') return 'dayton';
  return 'other';
}
var bundleSrc = fs.readFileSync(path.join(__dirname, 'assets/master-buyers.js'), 'utf8');
var BUNDLE = JSON.parse(bundleSrc.replace(/^window\.MASTER_BUYERS\s*=\s*/, '').replace(/;\s*$/, ''));
var fullRanked = BuyerMap.rankPage(BUNDLE, 0, BUNDLE.length);
var fullSplit = BuyerMap.splitPlottable(fullRanked, DATA.zipCoords);
var covOverall = 100 * fullSplit.plotted.length / BUNDLE.length;
t('coverage overall: plotted >= 78% of all buyers (was 1.45% on the old 12-ZIP table)', covOverall >= 78, covOverall.toFixed(2) + '% plotted (' + fullSplit.plotted.length + '/' + BUNDLE.length + ')');
var covByMarket = {};
BUNDLE.forEach(function (b, i) {
  var m = marketOfRec(b);
  if (!covByMarket[m]) covByMarket[m] = { total: 0, plotted: 0 };
  covByMarket[m].total++;
});
fullSplit.plotted.forEach(function (p) {
  covByMarket[marketOfRec(p.rec)].plotted++;
});
['indianapolis', 'cleveland', 'kansascity', 'carolina', 'jacksonville', 'dayton'].forEach(function (m) {
  var r = covByMarket[m];
  var pct = 100 * r.plotted / r.total;
  t('coverage ' + m + ': plotted >= 90% (' + r.plotted + '/' + r.total + ')', pct >= 90, pct.toFixed(2) + '%');
});
t('coverage: centroid table holds >= 6000 ZIPs', Object.keys(DATA.zipCoords).length >= 6000, Object.keys(DATA.zipCoords).length + ' entries');
t('coverage: no plotted pin carries a coordinate outside the table (no invented coords)', fullSplit.plotted.every(function (p) {
  var c = DATA.zipCoords[String(p.rec.z).trim()];
  return c && p.lat === c[0] && p.lon === c[1];
}));
t('coverage: every unplotted buyer has no table entry and no lat/lon', fullSplit.unplotted.every(function (u) {
  return !DATA.zipCoords[String(u.rec.z || '').trim()] && u.lat === undefined && u.lon === undefined;
}));
t('coverage: unplotted count equals exactly the buyers with no table ZIP', (function () {
  var noZip = BUNDLE.filter(function (b) { return !DATA.zipCoords[String(b.z || '').trim()]; }).length;
  return noZip === fullSplit.unplotted.length;
})(), fullSplit.unplotted.length + ' unplotted');

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

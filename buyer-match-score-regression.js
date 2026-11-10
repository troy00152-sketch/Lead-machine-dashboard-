// buyer-match-score-regression.js — verification for the Buyer Match Score (0-1000).
// Run: node buyer-match-score-regression.js
// Fixtures only — zero live API credits, zero network. The score is pure
// client-side math on buyer + deal fields, so every expected value below is
// hand-computed in the comments; if a check fails, re-do the arithmetic
// before touching the formula. Exits 1 on any failure.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./assets/buyer-match-score.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function scoreOf(deal, buyer, opts) { return M.buyerMatchScore(deal, buyer, opts).score; }

const INDY_DEAL = { city: 'Indianapolis', state: 'IN', zip: '46220', price: 83000 };
const INDY_FLIP = { city: 'Indianapolis', state: 'IN', zip: '46220', price: 83000, dealType: 'flip' };

// ---- 1. Module shape ----
console.log('Module shape:');
check('exports buyerMatchScore', typeof M.buyerMatchScore, 'function');
check('matchScore alias is same fn', M.matchScore === M.buyerMatchScore, true);
check('exports rankBuyers', typeof M.rankBuyers, 'function');
check('TIERS', M.TIERS, { BEST_MATCH: 750, STRONG: 550, POSSIBLE: 350, WEAK: 150 });
check('BUCKETS', M.BUCKETS, { market: 250, price: 250, activity: 150, strategy: 150, verified: 200 });
check('buyerMatchScore takes deal, buyer, opts', M.buyerMatchScore.length, 3);
check('window global loads', (function () {
  var ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/buyer-match-score.js'), 'utf8'), ctx);
  return typeof ctx.window.BuyerMatchScore.buyerMatchScore;
})(), 'function');

// ---- 2. No data at all ----
console.log('No data:');
check('null buyer -> 0 / NO DATA', [scoreOf(INDY_DEAL, null), M.buyerMatchScore(INDY_DEAL, null).label], [0, 'NO DATA']);
check('{} buyer -> 0 / NO DATA', [scoreOf(INDY_DEAL, {}), M.buyerMatchScore(INDY_DEAL, {}).label], [0, 'NO DATA']);
check('{} coverage 0', M.buyerMatchScore(INDY_DEAL, {}).coverage, 0);
check('{} missing flags it', M.buyerMatchScore(INDY_DEAL, {}).missing, ['No buyer data on this record']);

// ---- 3. Perfect buyer: same ZIP, exact avg, 50 flips, 100 props, verified, flip deal ----
// market 250 + price 250 + activity 130 (fl 80 + pc 50) + strategy 150 + verified 200 = 980 BEST MATCH.
console.log('Perfect buyer:');
const PERFECT = { n: 'Perfect Flipper LLC', c: 'Indianapolis', s: 'IN', z: '46220', pc: 100, st: 'Flipper+Landlord', ap: 83000, pv: 8300000, fl: 50, verified: true };
check('perfect score', scoreOf(INDY_FLIP, PERFECT), 980);
check('perfect label', M.buyerMatchScore(INDY_FLIP, PERFECT).label, 'BEST MATCH');
check('perfect score100', M.buyerMatchScore(INDY_FLIP, PERFECT).score100, 98);
check('perfect buckets', [M.buyerMatchScore(INDY_FLIP, PERFECT).marketPts, M.buyerMatchScore(INDY_FLIP, PERFECT).pricePts, M.buyerMatchScore(INDY_FLIP, PERFECT).activityPts, M.buyerMatchScore(INDY_FLIP, PERFECT).strategyPts, M.buyerMatchScore(INDY_FLIP, PERFECT).verifiedPts], [250, 250, 130, 150, 200]);
check('perfect top reason', M.buyerMatchScore(INDY_FLIP, PERFECT).topReasons[0], 'Same ZIP 46220 (+250)');
check('perfect missing empty', M.buyerMatchScore(INDY_FLIP, PERFECT).missing, []);
check('perfect coverage 5', M.buyerMatchScore(INDY_FLIP, PERFECT).coverage, 5);

// ---- 4. HLGF INVESTMENTS, LLC / John Sherby — REAL record from master-buyers.js ----
// Phone 3174329382 (Sherby), pc 9, Flipper+Landlord, ap $136,666, pv $1,230,000,
// sc 85 tier A, fl 0 — but c/s/z are ALL EMPTY: no location on file.
// Indy deal $83,000, deal type unknown:
// market 0 (no location) + price 160 (83,000/136,666 = 0.607, log2 -0.719,
// 250*(1-0.360) = 160) + activity 25 (pc 9) + strategy 120 (both, unknown
// type) + verified 200 = 505 POSSIBLE. The missing location is flagged,
// not papered over — and the score still credits what IS real.
console.log('Sherby / HLGF fixture:');
const HLGF = { n: 'HLGF INVESTMENTS, LLC', p: '3174329382', c: '', s: '', z: '', pc: 9, st: 'Flipper+Landlord', ap: 136666, pv: 1230000, fl: 0, verified: true };
const hlgf = M.buyerMatchScore(INDY_DEAL, HLGF);
check('HLGF score', hlgf.score, 505);
check('HLGF label', hlgf.label, 'POSSIBLE');
check('HLGF score100', hlgf.score100, 51);
check('HLGF buckets', [hlgf.marketPts, hlgf.pricePts, hlgf.activityPts, hlgf.strategyPts, hlgf.verifiedPts], [0, 160, 25, 120, 200]);
check('HLGF top reason', hlgf.topReasons[0], '✅ Verified buyer (+200)');
check('HLGF missing flags location', hlgf.missing, ['No location on file — market fit unknown']);
check('HLGF coverage 4', hlgf.coverage, 4);

// ---- 5. Bare buyer: name + phone only — no buy box, no history ----
// Every bucket 0, coverage 0 -> NO DATA. Must never outscore a real buyer.
console.log('Bare buyer:');
const BARE = { n: 'No Data Buyer', p: '3175550100' };
const bare = M.buyerMatchScore(INDY_DEAL, BARE);
check('bare score 0', bare.score, 0);
check('bare label NO DATA', bare.label, 'NO DATA');
check('bare coverage 0', bare.coverage, 0);
check('bare missing lists every gap', bare.missing, ['No location on file — market fit unknown', 'No avg purchase on file — buy box unknown', 'No purchase history on file', 'No strategy on file', 'Verified status not checked']);

// ---- 6. Verified vs unverified pair — same record, delta must be exactly 200 ----
// market 250 (ZIP) + price 216 (83,000/100,000 = 0.83, log2 -0.269,
// 250*(1-0.134) = 216) + activity 105 (fl 10 -> 65, pc 20 -> 40) +
// strategy 150 (flip + flipper) + verified 200/0 = 921 BEST MATCH / 721 STRONG.
console.log('Verified vs unverified pair:');
const PAIR = { n: 'Pair Buyer LLC', c: 'Indianapolis', s: 'IN', z: '46220', pc: 20, st: 'Flipper', ap: 100000, pv: 2000000, fl: 10 };
const pairV = M.buyerMatchScore(INDY_FLIP, Object.assign({}, PAIR, { verified: true }));
const pairU = M.buyerMatchScore(INDY_FLIP, Object.assign({}, PAIR, { verified: false }));
check('verified pair score', pairV.score, 921);
check('verified pair label', pairV.label, 'BEST MATCH');
check('unverified pair score', pairU.score, 721);
check('unverified pair label', pairU.label, 'STRONG');
check('verified delta is exactly 200', pairV.score - pairU.score, 200);
check('unverified missing empty (verified=false is known, not missing)', pairU.missing, []);

// ---- 7. City-only landlord on a flip deal, 2x price ----
// market 210 (city, no ZIP) + price 125 (ratio 0.5, log2 -1, 250*0.5) +
// activity 25 (pc 5) + strategy 60 (landlord-only on flip) + verified 0 = 420 POSSIBLE.
console.log('City-only landlord on flip:');
const CITY_LL = { n: 'City Landlord LLC', c: 'Indianapolis', s: 'IN', z: '', pc: 5, st: 'Landlord', ap: 166000, pv: 830000, fl: 0, verified: false };
check('city landlord score', scoreOf(INDY_FLIP, CITY_LL), 420);
check('city landlord label', M.buyerMatchScore(INDY_FLIP, CITY_LL).label, 'POSSIBLE');
check('city landlord score100', M.buyerMatchScore(INDY_FLIP, CITY_LL).score100, 42);
check('city landlord coverage 5', M.buyerMatchScore(INDY_FLIP, CITY_LL).coverage, 5);

// ---- 8. State-only flipper, 4x price — bad fit is NOT missing data ----
// market 100 (state, ZIP3 differs) + price 0 (ratio 0.25, log2 -2, 250*0) +
// activity 80 (fl 30) + strategy 150 (flip + flipper) + verified 0 = 330 WEAK.
// Missing is empty: the price data was present, the fit is just bad.
console.log('State-only flipper, 4x price:');
const STATE_FL = { n: 'State Flipper Inc', c: 'Fort Wayne', s: 'IN', z: '46805', pc: 0, st: 'Flipper', ap: 332000, pv: 0, fl: 30, verified: false };
const stateFl = M.buyerMatchScore(INDY_FLIP, STATE_FL);
check('state flipper score', stateFl.score, 330);
check('state flipper label', stateFl.label, 'WEAK');
check('state flipper price 0 but not missing', [stateFl.pricePts, stateFl.missing], [0, []]);

// ---- 9. Server-row shape (buyer-match function response) — the wire-in input ----
// Same deal. market 250 (ZIP) + price 235 (83,000/90,000 = 0.922, log2
// -0.117, 250*(1-0.058) = 235) + activity 105 (fl 12 -> 65, pc 40 -> 40) +
// strategy 150 (both + flip) + verified 0 = 740 STRONG.
// The row's own 0-99 server score (87) must NOT feed the new score.
console.log('Server-row shape:');
const ROW = { name: 'Server Row Buyer LLC', city: 'Indianapolis', state: 'IN', zip: '46220', areas: ['Indianapolis'], states: ['IN'], score: 87, verified: false, portfolioCount: 40, portfolioValue: 4000000, avgPurchase: 90000, flips: 12, isFlipper: true, isLandlord: true, isEntity: true, highVolume: false };
check('server row score', scoreOf(INDY_FLIP, ROW), 740);
check('server row label', M.buyerMatchScore(INDY_FLIP, ROW).label, 'STRONG');
check('server 0-99 score ignored', scoreOf(INDY_FLIP, Object.assign({}, ROW, { score: 12 })), 740);
check('server row buckets', (function () { var r = M.buyerMatchScore(INDY_FLIP, ROW); return [r.marketPts, r.pricePts, r.activityPts, r.strategyPts, r.verifiedPts]; })(), [250, 235, 105, 150, 0]);

// ---- 10. Land deal — deal type derived from propertyType ----
// Deal: vacant land $25,000. Buyer Hoosier Land Co (name has 'land'):
// market 250 (ZIP) + price 217 (25,000/30,000 = 0.833, log2 -0.263,
// 250*(1-0.132) = 217) + activity 50 (fl 2 -> 25, pc 15 -> 25) +
// strategy 150 (land investor) + verified 0 = 667 STRONG.
// Landlord-only on the same land deal gets strategy 40 -> 532 POSSIBLE.
console.log('Land deal:');
const LAND_DEAL = { city: 'Indianapolis', state: 'IN', zip: '46220', price: 25000, propertyType: 'Vacant Land' };
const LAND_CO = { n: 'Hoosier Land Co', c: 'Indianapolis', s: 'IN', z: '46220', pc: 15, st: 'Flipper', ap: 30000, pv: 450000, fl: 2, verified: false };
check('land dealType derived', M.dealTypeOf(LAND_DEAL), 'land');
check('land investor score', scoreOf(LAND_DEAL, LAND_CO), 667);
check('land investor label', M.buyerMatchScore(LAND_DEAL, LAND_CO).label, 'STRONG');
const LAND_LL = { n: 'Rental Homes LLC', c: 'Indianapolis', s: 'IN', z: '46220', pc: 15, st: 'Landlord', ap: 30000, pv: 450000, fl: 0, verified: false };
check('landlord-only on land score', scoreOf(LAND_DEAL, LAND_LL), 532);
check('landlord-only on land strategy 40', M.buyerMatchScore(LAND_DEAL, LAND_LL).strategyPts, 40);

// ---- 11. County parcels feed activity; score caps at 1000 ----
// County-only buyer: market 250 + price 250 + activity 20 (county only) +
// strategy 150 (flip + flipper) + verified 0 = 670 STRONG.
// Whale: every bucket maxed -> exactly 1000, never above.
console.log('County parcels + cap:');
const COUNTY_ONLY = { n: 'County Buyer LLC', c: 'Indianapolis', s: 'IN', z: '46220', pc: 0, st: 'Flipper', ap: 83000, pv: 0, fl: 0, countyParcels: 5, verified: false };
check('county-only activity 20', M.buyerMatchScore(INDY_FLIP, COUNTY_ONLY).activityPts, 20);
check('county-only score', scoreOf(INDY_FLIP, COUNTY_ONLY), 670);
const WHALE = { n: 'Whale LLC', c: 'Indianapolis', s: 'IN', z: '46220', pc: 1000, st: 'Flipper+Landlord', ap: 83000, pv: 999999999, fl: 500, countyParcels: 100, verified: true };
check('whale caps at 1000', scoreOf(INDY_FLIP, WHALE), 1000);
check('whale activity caps at 150', M.buyerMatchScore(INDY_FLIP, WHALE).activityPts, 150);

// ---- 12. Deal with no price; deal with nothing at all ----
// No price: price bucket 0 + missing note; perfect buyer otherwise ->
// market 250 + activity 130 + strategy 120 (type unknown, both) +
// verified 200 = 700 STRONG, coverage 4.
// Null deal: market + price both unknown -> activity 130 + strategy 120 +
// verified 200 = 450 POSSIBLE, both deal gaps listed.
console.log('Missing deal data:');
const NO_PRICE = { city: 'Indianapolis', state: 'IN', zip: '46220' };
const noPrice = M.buyerMatchScore(NO_PRICE, PERFECT);
check('no-price score', noPrice.score, 700);
check('no-price label', noPrice.label, 'STRONG');
check('no-price missing flags price', noPrice.missing, ['No asking price — price fit unknown']);
check('no-price coverage 4', noPrice.coverage, 4);
const NO_DEAL = M.buyerMatchScore(null, PERFECT);
check('null-deal score', NO_DEAL.score, 450);
check('null-deal missing lists both gaps', NO_DEAL.missing, ['No deal location — market fit unknown', 'No asking price — price fit unknown']);

// ---- 13. rankBuyers: order + verifiedMap lookup by phone ----
// [bare, HLGF, perfect] ranks perfect (980), HLGF, bare (0).
// NOTE: rankBuyers runs on INDY_FLIP (dealType 'flip'), so HLGF scores
// 535 here, not 505: strategy is 150 (flip + flipper) instead of 120
// (both strategies, type unknown). Same buyer, different deal, different
// score — that is the point of a per-deal score.
console.log('rankBuyers:');
const ranked = M.rankBuyers(INDY_FLIP, [BARE, HLGF, PERFECT]);
check('rank order', ranked.map(function (r) { return r.buyer.n; }), ['Perfect Flipper LLC', 'HLGF INVESTMENTS, LLC', 'No Data Buyer']);
check('rank scores desc', ranked.map(function (r) { return r.match.score; }), [980, 535, 0]);
const MAP_BUYER = { n: 'Map Buyer LLC', c: 'Indianapolis', s: 'IN', z: '46220', pc: 20, st: 'Flipper', ap: 100000, pv: 2000000, fl: 10, p: '3174329382' };
check('verifiedMap lookup adds 200', scoreOf(INDY_FLIP, MAP_BUYER, { verifiedMap: { '3174329382': { name: 'HLGF INVESTMENTS, LLC', how: 'deal-room offer', at: 1 } } }), 921);
check('verifiedMap miss scores unverified', scoreOf(INDY_FLIP, MAP_BUYER, { verifiedMap: {} }), 721);

// ---- 14. Wire-in: index.html Buyer Match Ai page shows the score ----
// The 0-99 server ring stays (bmRing(b.score)); the new score is added
// next to it in the results list and in the buyer profile overlay, and
// the list re-sorts by the new score. No send/blast behavior changes:
// the Buyer Blast flow must not reference the new scorer at all.
console.log('Wire-in:');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
check('index.html loads buyer-match-score.js', indexHtml.includes('<script src="assets/buyer-match-score.js"></script>'), true);
check('index.html loads it after sellability.js', indexHtml.indexOf('<script src="assets/sellability.js"></script>') !== -1 && indexHtml.indexOf('<script src="assets/sellability.js"></script>') < indexHtml.indexOf('<script src="assets/buyer-match-score.js"></script>'), true);
check('runBuyerMatch computes the new score', indexHtml.includes('buyerMatchScore('), true);
check('results re-sort by new score', indexHtml.includes('_match.score'), true);
check('profile overlay shows match score', indexHtml.includes('Match Score'), true);
check('server ring intact', indexHtml.includes('bmRing(b.score)'), true);
check('buyer-match fetch unchanged', indexHtml.includes("fetch('/.netlify/functions/buyer-match'"), true);
check('blast flow does not use the new scorer', (function () {
  var blast = indexHtml.slice(indexHtml.indexOf('/* One-click dispo:'), indexHtml.indexOf('/* One-click dispo:') + 12000);
  return blast.indexOf('buyerMatchScore') === -1;
})(), true);

// ---- 15. Inline-script syntax check (parse only, never executes) ----
console.log('Inline script syntax:');
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}
const blocks = inlineScripts(indexHtml);
check('index.html has inline script blocks', blocks.length > 0, true);
let okAll = true, bad = -1;
blocks.forEach(function (code, i) {
  try { new Function(code); } catch (e) { okAll = false; bad = i; }
});
check('index.html inline scripts parse (' + blocks.length + ' blocks)', okAll, true);
if (!okAll) console.log('    first bad block index: ' + bad);

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

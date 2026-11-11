// sellability-regression.js — verification for the Sellability Score (0-1000).
// Run: node sellability-regression.js
// Fixtures only — zero live API credits, zero network. The score is pure
// client-side math on record fields, so every expected value below is
// hand-computed in the comments; if a check fails, re-do the arithmetic
// before touching the formula. Exits 1 on any failure.
const fs = require('fs');
const path = require('path');
const S = require('./assets/sellability.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function scoreOf(x) { return S.wholesaleScore(x).score; }

// ---- 1. Module shape ----
console.log('Module shape:');
check('exports wholesaleScore', typeof S.wholesaleScore, 'function');
check('sellabilityScore alias is same fn', S.sellabilityScore === S.wholesaleScore, true);
check('TIERS', S.TIERS, { LAYUP: 750, HOT: 550, WARM: 350, COOL: 150 });
check('BUCKETS', S.BUCKETS, { distress: 400, equity: 300, ownership: 150, stackCondition: 150 });
check('wholesaleScore takes one arg (no market input)', S.wholesaleScore.length, 1);

// ---- 2. No data at all ----
console.log('No data:');
check('null -> 0 / NO DATA', [scoreOf(null), S.wholesaleScore(null).label], [0, 'NO DATA']);
check('{} -> 0 / NO DATA', [scoreOf({}), S.wholesaleScore({}).label], [0, 'NO DATA']);
check('{} coverage 0', S.wholesaleScore({}).coverage, 0);
check('{} missing flags it', S.wholesaleScore({}).missing, ['No property data on this record']);
check('address-only -> NO DATA', S.wholesaleScore({ address: '1 Main St, Nowhere, OH 43001' }).label, 'NO DATA');

// ---- 3. Cold lead: no signals, 20% equity, owned 2y, built 2010 ----
// 0 distress + 90 equity + 10 own + 0 stack = 100 COLD.
console.log('Cold lead:');
const cold = { dmEquityPct: 20, ownershipMonths: 24, yearBuilt: 2010, ownerOccupied: true };
check('cold score', scoreOf(cold), 100);
check('cold label', S.wholesaleScore(cold).label, 'COLD');
check('cold score100', S.wholesaleScore(cold).score100, 10);

// ---- 4. Single-signal WARM: tax delinquent, 50% equity, owned 10y, built 2010 ----
// distress 160 + equity 190 + own 50 + stack 40 (1 list) = 440 WARM.
console.log('Single-signal lead:');
const oneSignal = { taxDelinquentYear: '2024', dmEquityPct: 50, ownershipMonths: 120, yearBuilt: 2010 };
check('one-signal score', scoreOf(oneSignal), 440);
check('one-signal label', S.wholesaleScore(oneSignal).label, 'WARM');
check('one-signal signals', S.wholesaleScore(oneSignal).signals, ['Tax Delinquent']);
check('one-signal top reason', S.wholesaleScore(oneSignal).topReasons[0], 'Equity 50% (+190)');

// ---- 5. Gatlin fixture (lead shape, known facts only — no invented sale date) ----
// 705 McDowell St, Greenville NC: code-violation list, free & clear
// (owes nothing, seller-confirmed), built 1961, owner-occupied.
// distress 120 + equity 300 (free & clear = 100%) + own 40 + stack 55
// (1 list 40 + built 1961 15) = 515 WARM. Old 0-100 formula gave 51 WARM
// (12 + 35 + 4) — same tier, score100 52 vs old 51.
console.log('Gatlin fixture:');
const gatlin = {
  address: '705 McDowell St, Greenville, NC 27834',
  distressSignal: 'Code Violations', _stackSignals: ['Code Violations'],
  dmNumMortgages: 0, yearBuilt: 1961, ownerOccupied: true
};
const g = S.wholesaleScore(gatlin);
check('gatlin score', g.score, 515);
check('gatlin label', g.label, 'WARM');
check('gatlin score100 (old scale)', g.score100, 52);
check('gatlin buckets', [g.distressPts, g.equityPts, g.ownPts, g.stackPts], [120, 300, 40, 55]);
check('gatlin top reason', g.topReasons[0], 'Equity 100% (+300)');
check('gatlin top reasons count', g.topReasons.length, 3);
check('gatlin coverage (all 4 buckets)', g.coverage, 4);
check('gatlin missing (none)', g.missing, []);
check('gatlin legacy aliases', [g.distress, g.equity, g.own], [120, 300, 40]);

// ---- 6. Tier boundaries (exact scores + the twin just below) ----
// 750 LAYUP: distress 300 (PF 180 + tax 80 + absentee 40) + equity 230
// (60%) + own 120 (absentee 60 + 22y 60) + stack 100 (2 lists 70 + 1955 30).
console.log('Tier boundaries:');
const layup = { preforeclosure: 'Yes', taxDelinquentYear: '2024', dmEquityPct: 60, absenteeOwner: 'Yes', ownershipMonths: 264, yearBuilt: 1955 };
check('750 -> LAYUP', [scoreOf(layup), S.wholesaleScore(layup).label], [750, 'LAYUP — HIT HARD']);
const justBelowLayup = Object.assign({}, layup, { yearBuilt: 1970 }); // age 30 -> 15, stack 100 -> 85
check('735 -> HOT (just below LAYUP)', [scoreOf(justBelowLayup), S.wholesaleScore(justBelowLayup).label], [735, 'HOT']);
// 550 HOT: distress 220 (PF 180 + absentee 40) + equity 190 (50%) +
// own 70 (absentee 60 + 2y 10) + stack 70 (1 list 40 + 1955 30).
const hot = { preforeclosure: 'Yes', dmEquityPct: 50, absenteeOwner: 'Yes', ownershipMonths: 24, yearBuilt: 1955 };
check('550 -> HOT', [scoreOf(hot), S.wholesaleScore(hot).label], [550, 'HOT']);
const justBelowHot = Object.assign({}, hot, { yearBuilt: 1970 }); // stack 70 -> 55
check('535 -> WARM (just below HOT)', [scoreOf(justBelowHot), S.wholesaleScore(justBelowHot).label], [535, 'WARM']);
// 350 WARM: distress 160 (tax) + equity 90 (20%) + own 60 (22y) +
// stack 40 (1 list, built 1985).
const warm = { taxDelinquentYear: '2024', dmEquityPct: 20, ownershipMonths: 264, yearBuilt: 1985 };
check('350 -> WARM', [scoreOf(warm), S.wholesaleScore(warm).label], [350, 'WARM']);
const justBelowWarm = Object.assign({}, warm, { ownershipMonths: 120 }); // own 60 -> 50
check('340 -> COOL (just below WARM)', [scoreOf(justBelowWarm), S.wholesaleScore(justBelowWarm).label], [340, 'COOL']);
// 150 COOL: 0 + 90 (20%) + 60 (22y) + 0 = 150.
const cool = { dmEquityPct: 20, ownershipMonths: 264, yearBuilt: 1985 };
check('150 -> COOL', [scoreOf(cool), S.wholesaleScore(cool).label], [150, 'COOL']);
const justBelowCool = Object.assign({}, cool, { ownershipMonths: 120 }); // own 60 -> 50
check('140 -> COLD (just below COOL)', [scoreOf(justBelowCool), S.wholesaleScore(justBelowCool).label], [140, 'COLD']);

// ---- 7. Maxed lead: every bucket at its cap -> 1000 ----
// distress caps at 400 (8 signals), equity 300, own caps at 150, stack 150.
console.log('Maxed lead:');
const maxed = {
  preforeclosure: 'Yes', taxDelinquentYear: '2024', numLiens: 2,
  _stackSignals: ['Pre-Foreclosure', 'Tax Delinquent', 'Vacant / Abandoned', 'Liens / Judgments', 'Probate / Inherited', 'Bankruptcy', 'Code Violations', 'Divorce'],
  dmEquityPct: 100, absenteeOwner: 'Yes', outOfStateOwner: 'Yes',
  ownershipMonths: 312, dmNumMortgages: 0, yearBuilt: 1950
};
const m = S.wholesaleScore(maxed);
check('maxed score (all caps)', m.score, 1000);
check('maxed label', m.label, 'LAYUP — HIT HARD');
check('maxed buckets', [m.distressPts, m.equityPts, m.ownPts, m.stackPts], [400, 300, 150, 150]);
check('maxed top reason', m.topReasons[0], 'Equity 100% (+300)');

// ---- 8. Missing data degrades gracefully, never fails, never invents ----
console.log('Missing data:');
const noEquity = { preforeclosure: 'Yes', ownershipMonths: 132, yearBuilt: 1990 };
// distress 180 + equity 0 + own 50 (11y) + stack 40 = 270 COOL.
check('equity unknown scores on the rest', [scoreOf(noEquity), S.wholesaleScore(noEquity).label], [270, 'COOL']);
check('equity unknown is flagged', S.wholesaleScore(noEquity).missing, ['Equity unknown — no equity figure on this record']);
check('equity unknown coverage 3', S.wholesaleScore(noEquity).coverage, 3);
const noOwn = { preforeclosure: 'Yes', dmEquityPct: 80 };
// distress 180 + equity 270 + own 0 + stack 40 = 490 WARM.
check('ownership unknown scores on the rest', [scoreOf(noOwn), S.wholesaleScore(noOwn).label], [490, 'WARM']);
check('ownership unknown is flagged', S.wholesaleScore(noOwn).missing, ['Ownership history unknown — no sale date, tenure, or occupancy on this record']);
// lastSaleDate path (years owned from a real sale date, not months).
const bySaleDate = { preforeclosure: 'Yes', dmEquityPct: 80, lastSaleDate: '2000-01-01', yearBuilt: 1990 };
check('lastSaleDate gives 20y+ ownership', S.wholesaleScore(bySaleDate).ownPts, 60);

// ---- 9. Nationwide: the score is a pure function of the record ----
// Same record, five different markets (and one with no market fields at
// all) -> identical scores. No market/ZIP/calibration input exists.
console.log('Nationwide (no market input):');
const base = { taxDelinquentYear: '2024', dmEquityPct: 50, ownershipMonths: 120, yearBuilt: 2010 };
const markets = [
  { address: '1 Main St, Indianapolis, IN 46201', market: 'Indianapolis' },
  { address: '2 Oak Ave, Austin, TX 78701', market: 'Austin' },
  { address: '3 Pine Rd, Seattle, WA 98101', market: 'Seattle' },
  { address: '4 Palm Dr, Miami, FL 33101', market: 'Miami' },
  { address: '5 Desert Ln, Phoenix, AZ 85001', market: 'Phoenix' },
  { address: '6 Hill St' }
];
markets.forEach(function (mk) {
  check('same record scores the same in ' + (mk.market || 'no-market'), scoreOf(Object.assign({}, base, mk)), 440);
});

// ---- 10. data-api subject shape (command-center.html) ----
console.log('Subject shape (command-center):');
const subject = {
  address: '123 Main St, Indianapolis, IN 46201',
  preForeclosure: true, taxDelinquency: true, taxDelinquencyYear: 2024,
  vacant: false, bankruptcy: false, preProbate: false, lienCount: 1,
  estimatedEquityRatio: 0.62, absentee: true, freeAndClear: false,
  ownershipMonths: 130, yearBuilt: 1968,
  flags: ['pre_foreclosure', 'tax_delinquent_2024', 'absentee_owner', 'liens_on_record']
};
// distress 350 (PF 180 + tax 80 + liens 50 + absentee 40) + equity 230
// (62%) + own 110 (absentee 60 + 10.8y 50) + stack 115 (3 lists 100 +
// 1968 15) = 805 LAYUP.
const sub = S.wholesaleScore(subject);
check('subject-shape score', sub.score, 805);
check('subject-shape label', sub.label, 'LAYUP — HIT HARD');
check('subject-shape signals', sub.signals, ['Pre-Foreclosure', 'Tax Delinquent', 'Liens / Judgments', 'Absentee Owner']);
// Flags alone carry the distress story when no other fields exist:
// distress 300 (PF 180 + tax 80 + absentee 40) + equity 0 + own 60 +
// stack 70 (2 lists) = 430 WARM.
const flagsOnly = { flags: ['pre_foreclosure', 'tax_delinquent_2024', 'absentee_owner'] };
const fo = S.wholesaleScore(flagsOnly);
check('flags-only score', fo.score, 430);
check('flags-only label', fo.label, 'WARM');
check('flags-only signals', fo.signals, ['Pre-Foreclosure', 'Tax Delinquent', 'Absentee Owner']);
check('flags-only missing equity', fo.missing, ['Equity unknown — no equity figure on this record']);
// Out-of-state derived from mailing address vs property address.
const oos = { dmEquityPct: 50, ownershipMonths: 120, yearBuilt: 2010, mailingAddress: '9 Elsewhere Rd, Columbus, OH 43215', address: '1 Main St, Indianapolis, IN 46201' };
check('out-of-state derived from mailing address', S.wholesaleScore(oos).ownPts, 90); // 10y 50 + out-of-state 40
const notOos = Object.assign({}, oos, { mailingAddress: '9 Local Rd, Indianapolis, IN 46201' });
check('same-state mailing is not out-of-state', S.wholesaleScore(notOos).ownPts, 50);

// ---- 11. Back-compat: score100 and legacy aliases on every fixture ----
console.log('Back-compat:');
[gatlin, cold, oneSignal, layup, hot, warm, cool, maxed, subject].forEach(function (fx, i) {
  const r = S.wholesaleScore(fx);
  check('fixture ' + i + ' score100 = round(score/10)', r.score100, Math.round(r.score / 10));
  check('fixture ' + i + ' legacy aliases', [r.distress, r.equity, r.own], [r.distressPts, r.equityPts, r.ownPts]);
  check('fixture ' + i + ' score within 0-1000', r.score >= 0 && r.score <= 1000, true);
});

// ---- 12. Static checks: the pages actually use the shared module ----
console.log('Static checks (pages use the module):');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const ccHtml = fs.readFileSync(path.join(__dirname, 'command-center.html'), 'utf8');
check('index.html loads sellability.js', indexHtml.includes('<script src="assets/sellability.js"></script>'), true);
check('index.html has no inline wholesaleScore', indexHtml.includes('function wholesaleScore('), false);
check('index.html has no inline scoreSignalList', indexHtml.includes('function scoreSignalList('), false);
check('index.html has no inline scoreEquityPct', indexHtml.includes('function scoreEquityPct('), false);
check('index.html HOT filters use 550', (indexHtml.match(/x\.ws\.score >= 550/g) || []).length, 2);
check('index.html has no stale >= 55 HOT filter', /x\.ws\.score >= 55(?!\d)/.test(indexHtml), false);
check('index.html has no stale /45 bucket text', indexHtml.includes('distressPts}/45'), false);
check('index.html has no stale / 100 chip', indexHtml.includes("' / 100 · '"), false);
check('index.html breakdown shows /1000 scale', indexHtml.includes("' / 1000 · '"), true);
check('command-center.html loads sellability.js', ccHtml.includes('<script src="assets/sellability.js"></script>'), true);
check('command-center.html has no old simple scorer', ccHtml.includes('distress+=16'), false);
check('command-center.html breakdown shows /400', ccHtml.includes("'Distress '+ws.distress+'/400"), true);
check('command-center.html CRM fallback scales x10', ccHtml.includes('lead.score*10'), true);

// ---- 13. Inline-script syntax check (parse only, never executes) ----
console.log('Inline script syntax:');
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}
[['index.html', indexHtml], ['command-center.html', ccHtml]].forEach(function ([name, html]) {
  const blocks = inlineScripts(html);
  check(name + ' has inline script blocks', blocks.length > 0, true);
  let okAll = true, bad = -1;
  blocks.forEach(function (code, i) {
    try { new Function(code); } catch (e) { okAll = false; bad = i; }
  });
  check(name + ' inline scripts parse (' + blocks.length + ' blocks)', okAll, true);
  if (!okAll) console.log('    first bad block index: ' + bad);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

// live-call-regression.js — verification for the Live Call Console (Ginn #4).
// Run: node live-call-regression.js
// Checks: (1) MAO/LAO on 5 documented deals matches the dashboard's own figures;
// (2) tier boundaries; (3) calibration min-rule (Norfolk sample);
// (4) live-call.js pure functions (slug, reply render, objection picks, score,
// markdown); (5) every getElementById in live-call.js exists in live-call.html;
// (6) inlined objections byte-identical to kb.json. Exits 1 on any failure.
const fs = require('fs');
const path = require('path');
const OfferMath = require('./assets/offer-math.js');
const LiveCall = require('./live-call.js');
const KB = require('/home/hatch/workspace/playbook-system/custom-bot/knowledge/kb.json');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ---- 1. Five documented deals (tier only, no calibration file) ----
console.log('MAO/LAO — 5 documented deals:');
const deals = [
  // NOTE on 123 Main St LAO: doc 16 prints $118,094, but the dashboard's own
  // canonical code (Math.round(168705 * 0.70)) gives $118,093 — 168705*0.7 is
  // 118093.4999… in floating point. The module matches the dashboard code
  // exactly; the doc's printed figure is $1 high. Same in index.html and
  // dashboard-ai.js (both Math.round(mao * 0.70)).
  // address, ARV, repairs, expected MAO, expected LAO, source
  ['303 Elizabeth St, Greenville NC', 150000, 50000, 80000, 56000, 'Chet Mentlewski — $150K airtight ARV, repairs $50K'],
  ['2623 Brighton Ave, Kansas City MO', 107420, 27000, 56294, 39406, 'Abraham Hoff precall 2026-10-28 (medium repairs)'],
  ['123 Main St, Port St. Lucie FL', 240000, 33000, 168705, 118093, 'Ginn doc 16 live-call-coach worked example'],
  ['Doc 05 worked example (no street address)', 300000, 40000, 215540, 150878, 'Ginn doc 05 offer-math worked example'],
  ['dashboard-ai.js worked example', 290000, 40000, 203750, 142625, 'netlify/functions/dashboard-ai.js comment'],
];
deals.forEach(([addr, arv, rep, mao, lao]) => {
  const r = OfferMath.offerMath(arv, rep);
  check(addr + ' MAO', r.mao, mao);
  check(addr + ' LAO', r.lao, lao);
});

// ---- 2. Tier boundaries ----
console.log('Tier boundaries:');
[[119999, 0.70], [120000, 0.80], [219999, 0.80], [220000, 0.815], [299999, 0.815], [300000, 0.829], [399999, 0.829], [400000, 0.849]]
  .forEach(([arv, tier]) => check('ARV $' + arv.toLocaleString() + ' tier', OfferMath.maoTier(arv).tier, tier));

// ---- 3. Calibration min-rule (Norfolk sample: 72.9% calibrated < 81.5% tier) ----
// NOTE: calibration applies only when a market is passed and it matches the
// calibration's market (default 'Indianapolis' when the fixture has no market
// field). These min-rule checks pass 'Indianapolis' explicitly so they test
// the min-rule, not the gate — the gate itself is covered in section 3b.
console.log('Calibration min-rule:');
const norfolk = OfferMath.offerMath(274000, 27000, { calibrated: true, multiplierMedian: 0.729, byPriceBand: {} }, 'Indianapolis');
check('Norfolk MAO (calibrated 72.9%)', norfolk.mao, 180063);
check('Norfolk source', norfolk.source, 'calibrated overall median');
const highCal = OfferMath.offerMath(240000, 33000, { calibrated: true, multiplierMedian: 0.90, byPriceBand: {} }, 'Indianapolis');
check('Calibrated above tier -> tier wins MAO', highCal.mao, 168705);

// ---- 3b. Market gate: the Indianapolis calibration must NOT leak onto other markets ----
// Fixture mirrors the live assets/mao-calibration.json (Indianapolis, 54 investors).
console.log('Market gate:');
const indyCal = { calibrated: true, market: 'Indianapolis', multiplierMedian: 0.713939393939394,
  byPriceBand: { '$120k-$220k': { median: 0.5695588898820925, n: 18 }, '$220k-$300k': { median: 0.5630630630630631, n: 9 }, '$300k-$400k': { median: 0.8121865161220281, n: 10 }, '$400k+': { median: 0.44028103044496486, n: 3 }, 'under $120k': { median: 0.789, n: 3 } } };
check('marketFor Indianapolis IN', OfferMath.marketFor('Indianapolis', 'IN'), 'Indianapolis');
check('marketFor case-insensitive', OfferMath.marketFor('indianapolis', 'in'), 'Indianapolis');
check('marketFor full state name', OfferMath.marketFor('Indianapolis', 'Indiana'), 'Indianapolis');
check('marketFor Greenville NC', OfferMath.marketFor('Greenville', 'NC'), 'Carolina');
check('marketFor Charlotte NC', OfferMath.marketFor('Charlotte', 'NC'), 'Carolina');
check('marketFor Dayton OH', OfferMath.marketFor('Dayton', 'OH'), 'Dayton');
check('marketFor Cleveland OH', OfferMath.marketFor('Cleveland', 'OH'), 'Cleveland');
check('marketFor Kansas City MO', OfferMath.marketFor('Kansas City', 'MO'), 'Kansas City');
check('marketFor Kansas City KS', OfferMath.marketFor('Kansas City', 'KS'), 'Kansas City');
check('marketFor Jacksonville FL', OfferMath.marketFor('Jacksonville', 'FL'), 'Jacksonville');
check('marketFor blank city -> null', OfferMath.marketFor('', 'IN'), null);
check('marketFor blank state -> null', OfferMath.marketFor('Indianapolis', ''), null);
check('marketFor Fort Wayne IN -> null', OfferMath.marketFor('Fort Wayne', 'IN'), null);
check('marketFor Columbus OH -> null', OfferMath.marketFor('Columbus', 'OH'), null);
check('marketFor Raleigh NC -> null', OfferMath.marketFor('Raleigh', 'NC'), null);
check('marketFor Miami FL -> null', OfferMath.marketFor('Miami', 'FL'), null);
// The proof case: 303 Elizabeth St, Greenville NC, ARV $150K / repairs $50K
// was getting MAO $56,956 (57.0% calibrated) — must be $80,000 / $56,000 tier.
const indyDeal = OfferMath.offerMath(150000, 50000, indyCal, 'Indianapolis');
check('Indianapolis 150K/50K MAO (calibrated)', indyDeal.mao, 56956);
check('Indianapolis 150K/50K LAO (calibrated)', indyDeal.lao, 39869);
check('Indianapolis 150K/50K label', indyDeal.label, '57.0% calibrated');
const greenvilleDeal = OfferMath.offerMath(150000, 50000, indyCal, 'Carolina');
check('Greenville NC 150K/50K MAO (tier)', greenvilleDeal.mao, 80000);
check('Greenville NC 150K/50K LAO (tier)', greenvilleDeal.lao, 56000);
check('Greenville NC 150K/50K label', greenvilleDeal.label, '80% tier · not calibrated for this market');
check('Blank market -> tier MAO', OfferMath.offerMath(150000, 50000, indyCal, null).mao, 80000);
check('Blank market -> tier LAO', OfferMath.offerMath(150000, 50000, indyCal, null).lao, 56000);
check('Cleveland OH -> tier MAO', OfferMath.offerMath(150000, 50000, indyCal, 'Cleveland').mao, 80000);
check('Dayton OH -> tier MAO', OfferMath.offerMath(150000, 50000, indyCal, 'Dayton').mao, 80000);
// End-to-end through marketFor, as live-call.js calls it:
check('marketFor-driven Indy deal MAO', OfferMath.offerMath(150000, 50000, indyCal, OfferMath.marketFor('Indianapolis', 'IN')).mao, 56956);
check('marketFor-driven Greenville deal MAO', OfferMath.offerMath(150000, 50000, indyCal, OfferMath.marketFor('Greenville', 'NC')).mao, 80000);

// ---- 4. live-call.js pure functions ----
console.log('live-call.js pure functions:');
check('slugify', LiveCall.slugify('303 Elizabeth St, Greenville, NC'), '303-elizabeth-st-greenville-nc');
check('renderReply swaps Ashley->Troy', LiveCall.renderReply("I'm Ashley with Direct Property Buyers — looking around [city].", 'Troy', 'Indianapolis'),
  "I'm Troy with Direct Property Buyers — looking around Indianapolis.");
check('renderReply swaps Ashley->Irish', LiveCall.renderReply("I'm Ashley with Direct Property Buyers.", 'Irish', null),
  "I'm Irish with Direct Property Buyers.");
const obs = KB.objections;
check('objections count', obs.length, 77);
check('probate expected cats', LiveCall.pickExpectedObjections(obs, 'probate').map(o => o.cat), ['situ', 'third', 'stall']);
check('code-violation expected cats', LiveCall.pickExpectedObjections(obs, 'code violation').map(o => o.cat), ['cond', 'process', 'price']);
check('D4D expected cats', LiveCall.pickExpectedObjections(obs, 'D4D').map(o => o.cat), ['open', 'compete', 'process']);
check('openingLine has address + name, no distress lead',
  LiveCall.openingLine('303 Elizabeth St', 'Troy', 'probate').includes('303 Elizabeth St') &&
  LiveCall.openingLine('303 Elizabeth St', 'Troy', 'probate').includes('Do NOT lead with the probate'), true);
const allYes = {}; LiveCall.SCORECARD.forEach(c => { allYes[c.id] = true; });
const s10 = LiveCall.scoreDebrief(allYes, { address: '303 Elizabeth St', callerName: 'Troy', lao: 56000 });
check('all-checked score', s10.score, 10);
check('all-checked verdict', s10.verdict, 'Locked in');
check('all-checked biggest leak', s10.biggestLeak, null);
const none = {};
const s0 = LiveCall.scoreDebrief(none, { address: '303 Elizabeth St', callerName: 'Troy', lao: 56000 });
check('none-checked score', s0.score, 0);
check('none-checked biggest leak is conditioning', s0.biggestLeak, 'Conditioned for yes/no BEFORE any number');
check('conditioning line present', s0.lineNeeded.includes('yes-or-no decision today'), true);
const onlyTalkMissed = Object.assign({}, allYes, { talk: false });
const sTalk = LiveCall.scoreDebrief(onlyTalkMissed, {});
check('talk-only miss -> 9/10', sTalk.score, 9);
check('talk-only miss leak', sTalk.biggestLeak, 'Seller talked ≥ 80% of the time');
const md = LiveCall.buildDebriefMarkdown({
  date: '2026-11-06', callerName: 'Troy', address: '303 Elizabeth St, Greenville, NC',
  arv: 150000, repairs: 50000, mao: 80000, lao: 56000, multiplierLabel: '80% tier · not calibrated',
  score: 7, total: 10, verdict: 'Solid call', biggestLeak: 'Anchored low — at or near LAO, not MAO',
  lineNeeded: 'I was talking to my partner and they said around $56,000.',
  worked: ['Opened with the two-question script'], nextAction: 'Call back', nextActionDate: '2026-11-08',
  notes: ['Seller: "I need to think about it."'], talkPct: 85, motivation: 'Behind on taxes', outcome: 'follow-up',
});
check('markdown has score header', md.includes('## Score: 7/10 — Solid call'), true);
check('markdown has numbers', md.includes('MAO: $80,000 · LAO: $56,000'), true);
check('markdown has filename slug source', LiveCall.slugify('303 Elizabeth St, Greenville, NC'), '303-elizabeth-st-greenville-nc');

// ---- 5. Every getElementById in live-call.js exists in live-call.html ----
console.log('DOM id cross-check:');
const html = fs.readFileSync(path.join(__dirname, 'live-call.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'live-call.js'), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
// dynamic ids: sc-<criterion> checkboxes are static in the template;
// buyerOut is created by buildPrep, chipReply is created by renderChips
const dynamicIds = new Set(['buyerOut', 'chipReply']);
const missing = new Set();
[...js.matchAll(/\$\('([^']+)'\)/g)].forEach(m => { if (!ids.has(m[1]) && !dynamicIds.has(m[1])) missing.add(m[1]); });
[...js.matchAll(/getElementById\('([^']+)'\)/g)].forEach(m => { if (!ids.has(m[1]) && !dynamicIds.has(m[1])) missing.add(m[1]); });
// sc- checkboxes come from SCORECARD ids
LiveCall.SCORECARD.forEach(c => { if (!ids.has('sc-' + c.id)) missing.add('sc-' + c.id); });
check('all JS-referenced ids exist in HTML', [...missing], []);

// ---- 6. Inlined objections byte-identical to kb.json ----
console.log('Objection byte-identity:');
const start = html.indexOf('window.LIVE_CALL_OBJECTIONS = ') + 'window.LIVE_CALL_OBJECTIONS = '.length;
const end = html.indexOf(';</script>', start);
const inlined = html.slice(start, end);
check('no placeholder left', html.includes('{{OBJECTIONS_JSON}}'), false);
check('inlined JSON normalizes to kb.json array', JSON.stringify(JSON.parse(inlined)), JSON.stringify(KB.objections));
check('inlined JSON parses to kb.json array', JSON.parse(inlined), KB.objections);

// ---- 7. Auto-fill (?lead= / URL params) ----
console.log('Auto-fill (?lead= / URL params):');
check('splitAddress full', LiveCall.splitAddress('303 Elizabeth St, Greenville, NC 27528'),
  { address: '303 Elizabeth St', city: 'Greenville', state: 'NC', zip: '27528' });
check('splitAddress Indy', LiveCall.splitAddress('3928 Millersville Dr, Indianapolis, IN 46205'),
  { address: '3928 Millersville Dr', city: 'Indianapolis', state: 'IN', zip: '46205' });
check('splitAddress no ZIP', LiveCall.splitAddress('123 Main St, Cleveland, OH'),
  { address: '123 Main St', city: 'Cleveland', state: 'OH', zip: '' });
check('splitAddress street only', LiveCall.splitAddress('123 Main St'),
  { address: '123 Main St', city: '', state: '', zip: '' });
check('splitAddress lowercase state', LiveCall.splitAddress('1 Main St, Dayton, oh 45402'),
  { address: '1 Main St', city: 'Dayton', state: 'OH', zip: '45402' });
check('splitAddress empty', LiveCall.splitAddress(''), { address: '', city: '', state: '', zip: '' });
check('params lead+arv', LiveCall.parseAutoFillParams('?lead=lead_7&arv=150000'), { leadId: 'lead_7', arv: 150000 });
check('params full deal', LiveCall.parseAutoFillParams('?address=303%20Elizabeth%20St%2C%20Greenville%2C%20NC%2027528&arv=150000&repairs=50000'),
  { address: '303 Elizabeth St, Greenville, NC 27528', arv: 150000, repairs: 50000 });
check('params bad arv dropped, address kept', LiveCall.parseAutoFillParams('?address=1%20Main%20St&arv=abc'), { address: '1 Main St' });
check('params empty', LiveCall.parseAutoFillParams(''), {});
const stubStore = [
  { id: 'lead_1', address: '303 Elizabeth St', city: 'Greenville', state: 'NC', zip: '27528', estimatedValue: 150000, arv: 150000, repairs: 50000, distressSignal: 'Code Violations', ownerName: 'Chet Mentlewski', bedrooms: 3, bathrooms: 2, sqft: 1450, yearBuilt: 1987, phones: [{ number: '(252) 555-0100', type: 'Mobile' }] },
  { id: 'lead_2', address: '3928 Millersville Dr', city: 'Indianapolis', state: 'IN', zip: '46205', estimatedValue: 145000, repairs: 30000, distressSignal: 'Code Violations' },
  { id: 'lead_3', address: 'No ARV St', city: 'Dayton', state: 'OH', zip: '45402', distressSignal: 'General' },
];
check('findLeadInStore hits', LiveCall.findLeadInStore(stubStore, 'lead_2').address, '3928 Millersville Dr');
check('findLeadInStore misses -> null', LiveCall.findLeadInStore(stubStore, 'lead_99'), null);
const d1 = LiveCall.leadToAutoFill(stubStore[0]);
check('lead fill address', d1.address, '303 Elizabeth St');
check('lead fill city/state/zip', [d1.city, d1.state, d1.zip], ['Greenville', 'NC', '27528']);
check('lead fill ARV', d1.arv, 150000);
check('lead fill repairs', d1.repairs, 50000);
check('lead fill source from signal', d1.listSource, 'code violation');
check('lead fill owner', d1.ownerName, 'Chet Mentlewski');
check('lead fill beds/baths', d1.bedsBaths, '3 / 2');
check('lead fill sqft/year', [d1.sqft, d1.yearBuilt], ['1450', '1987']);
check('lead fill mobile phone', d1.sellerPhone, '(252) 555-0100');
check('lead fill not listed', d1.listed, false);
const d3 = LiveCall.leadToAutoFill(stubStore[2]);
check('lead without ARV -> arv null, never 0', d3.arv, null);
check('lead without ARV -> source other', d3.listSource, 'other');
check('lead ARV falls back to value', LiveCall.leadToAutoFill({ id: 'x', value: 99000 }).arv, 99000);
check('lead ARV prefers estimatedValue over arv', LiveCall.leadToAutoFill({ id: 'x', estimatedValue: 150000, arv: 140000 }).arv, 150000);
check('lead listed flag', LiveCall.leadToAutoFill({ id: 'x', listingStatus: 'listed' }).listed, true);
const r1 = LiveCall.resolveAutoFill('?lead=lead_2', stubStore);
check('resolve lead wins', r1.source, 'lead');
check('resolve lead ARV', r1.deal.arv, 145000);
check('resolve lead repairs', r1.deal.repairs, 30000);
const r2 = LiveCall.resolveAutoFill('?lead=lead_99&address=1%20Main%20St&arv=200000', stubStore);
check('missing lead falls back to params', r2.source, 'params');
check('fallback params ARV', r2.deal.arv, 200000);
check('missing lead, no params -> null', LiveCall.resolveAutoFill('?lead=lead_99', stubStore), null);
check('no query -> null', LiveCall.resolveAutoFill('', stubStore), null);
const r3 = LiveCall.resolveAutoFill('?address=303%20Elizabeth%20St%2C%20Greenville%2C%20NC%2027528&arv=150000&repairs=50000', stubStore);
check('params deal city', r3.deal.city, 'Greenville');
check('params deal state', r3.deal.state, 'NC');
check('params deal ZIP', r3.deal.zip, '27528');
check('params deal street', r3.deal.address, '303 Elizabeth St');
// MAO figures unchanged by this build (real calibration file, market-gated).
OfferMath.setCalibration(require('./assets/mao-calibration.json'));
check('Greenville 303 MAO unchanged', OfferMath.offerMath(150000, 50000, undefined, OfferMath.marketFor('Greenville', 'NC')).mao, 80000);
check('Greenville 303 LAO unchanged', OfferMath.offerMath(150000, 50000, undefined, OfferMath.marketFor('Greenville', 'NC')).lao, 56000);
check('Indy 3928 MAO unchanged', OfferMath.offerMath(145000, 30000, undefined, OfferMath.marketFor('Indianapolis', 'IN')).mao, 65499);
check('Indy 3928 LAO unchanged', OfferMath.offerMath(145000, 30000, undefined, OfferMath.marketFor('Indianapolis', 'IN')).lao, 45849);

// ---- 8. Calibration load race: a card built before the fetch resolves must
// end up calibrated, and a failed/hanging fetch must fall back to tier. ----
// (Async — awaited before the final tally.)
console.log('Calibration load race:');
async function section8() {
  const realCal = require('./assets/mao-calibration.json');
  // Slow fetch: the real calibration file, arriving after 300ms.
  const slowFetch = () => new Promise(res => setTimeout(() => res({ ok: true, json: () => Promise.resolve(realCal) }), 300));
  OfferMath.loadMaoCalibration(slowFetch);
  const t0 = Date.now();
  const ready = await OfferMath.whenCalibrationReady(2000);
  const waited = Date.now() - t0;
  check('slow fetch: whenCalibrationReady resolves true', ready, true);
  check('slow fetch: waited for the fetch (>=250ms)', waited >= 250, true);
  // The proof case: 3928 Millersville Dr, Indianapolis, ARV $145K / $30K repairs
  // auto-built before the fetch resolved showed $92,000 / $64,400 tier-only.
  check('slow fetch: Indy 3928 MAO calibrated after wait', OfferMath.offerMath(145000, 30000, undefined, 'Indianapolis').mao, 65499);
  check('slow fetch: Indy 3928 LAO calibrated after wait', OfferMath.offerMath(145000, 30000, undefined, 'Indianapolis').lao, 45849);
  check('slow fetch: Greenville 303 MAO stays tier', OfferMath.offerMath(150000, 50000, undefined, 'Carolina').mao, 80000);
  check('slow fetch: Greenville 303 LAO stays tier', OfferMath.offerMath(150000, 50000, undefined, 'Carolina').lao, 56000);
  // Failed fetch: rejects outright -> settles immediately, tier fallback.
  const failFetch = () => Promise.reject(new Error('calibration fetch failed'));
  OfferMath.loadMaoCalibration(failFetch);
  const ready2 = await OfferMath.whenCalibrationReady(2000);
  check('failed fetch: whenCalibrationReady resolves (settled)', ready2, true);
  check('failed fetch: Indy 3928 falls back to tier MAO', OfferMath.offerMath(145000, 30000, undefined, 'Indianapolis').mao, 92000);
  check('failed fetch: Indy 3928 falls back to tier LAO', OfferMath.offerMath(145000, 30000, undefined, 'Indianapolis').lao, 64400);
  // Hanging fetch: never settles -> timeout -> false, tier fallback, page not blocked.
  const hangFetch = () => new Promise(() => {});
  OfferMath.loadMaoCalibration(hangFetch);
  const t1 = Date.now();
  const ready3 = await OfferMath.whenCalibrationReady(200);
  const waited3 = Date.now() - t1;
  check('hanging fetch: whenCalibrationReady times out (false)', ready3, false);
  check('hanging fetch: timed out near 200ms', waited3 >= 150 && waited3 < 1000, true);
  check('hanging fetch: Indy 3928 falls back to tier MAO', OfferMath.offerMath(145000, 30000, undefined, 'Indianapolis').mao, 92000);
}

// ---- 9. Quick Offer summary card: MAO/LAO regexes must capture each card's OWN number ----
// calcComp renders number-first, label-second:
//   <div class="num">$80,000</div><div class="lbl">MAO (ceiling)</div>
//   <div class="num">$56,000</div><div class="lbl">LAO (opening)</div>
//   <div class="num">$24,000</div><div class="lbl">Negotiation Room</div>
// The old label-then-next-$ regexes captured the NEXT card's value (MAO box
// showed the LAO, LAO box showed the spread). Extract the SHIPPED regexes
// from index.html and apply them to the exact rendered HTML.
console.log('Quick Offer summary card (index.html):');
const idxHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function qoRegex(varName) {
  const anchor = 'const ' + varName + ' = html.match(';
  const i = idxHtml.indexOf(anchor);
  if (i === -1) return null;
  const j = idxHtml.indexOf('/', i + anchor.length);
  let k = j + 1;
  while (k < idxHtml.length) {
    if (idxHtml[k] === '\\') { k += 2; continue; }
    if (idxHtml[k] === '/') break;
    k++;
  }
  const flags = idxHtml.slice(k + 1, idxHtml.indexOf(')', k));
  return new RegExp(idxHtml.slice(j + 1, k), flags);
}
function qoCards(mao, lao) {
  const spread = mao - lao;
  return '<div class="cards">' +
    '<div class="card"><div class="num">$' + mao.toLocaleString() + '</div><div class="lbl">MAO (ceiling)</div><div class="sub">80.0% tier</div></div>' +
    '<div class="card"><div class="num" style="color:var(--green)">$' + lao.toLocaleString() + '</div><div class="lbl">LAO (opening)</div><div class="sub">70% of MAO</div></div>' +
    '<div class="card"><div class="num" style="color:var(--blue)">$' + spread.toLocaleString() + '</div><div class="lbl">Negotiation Room</div></div></div>';
}
const qoMaoRe = qoRegex('maoM'), qoLaoRe = qoRegex('laoM');
check('Quick Offer MAO regex found in index.html', qoMaoRe != null, true);
check('Quick Offer LAO regex found in index.html', qoLaoRe != null, true);
const greenvilleHtml = qoCards(80000, 56000);
check('Quick Offer Greenville MAO box', parseInt(greenvilleHtml.match(qoMaoRe)[1].replace(/,/g, ''), 10), 80000);
check('Quick Offer Greenville LAO box', parseInt(greenvilleHtml.match(qoLaoRe)[1].replace(/,/g, ''), 10), 56000);
const indyHtml = qoCards(92000, 64400);
check('Quick Offer Indy MAO box', parseInt(indyHtml.match(qoMaoRe)[1].replace(/,/g, ''), 10), 92000);
check('Quick Offer Indy LAO box', parseInt(indyHtml.match(qoLaoRe)[1].replace(/,/g, ''), 10), 64400);

// ---- 10. Draft carryover: a fresh auto-filled card must not inherit the
// previous call's details (live test, main@6fa6595: the Greenville card
// showed Indy's ZIP 46201). Different address -> non-deal draft cleared;
// same address -> draft kept; no draft address -> no-op; deal fields from
// the auto-fill preserved after the clear. ----
console.log('Draft carryover:');
check('normalizeAddress strips case/punct/space', LiveCall.normalizeAddress('303 Elizabeth St, Greenville, NC'), '303elizabethstgreenvillenc');
check('normalizeAddress empty', LiveCall.normalizeAddress(''), '');
check('normalizeAddress null', LiveCall.normalizeAddress(null), '');
check('isSameAddress case/punct-insensitive (spec pair)', LiveCall.isSameAddress('303 Elizabeth St, Greenville, NC', '303 elizabeth st greenville nc'), true);
check('isSameAddress street-only vs full', LiveCall.isSameAddress('303 Elizabeth St', '303 Elizabeth St, Greenville, NC 27528'), true);
check('isSameAddress different street', LiveCall.isSameAddress('303 Elizabeth St, Greenville, NC', '3928 Millersville Dr, Indianapolis, IN'), false);
check('isSameAddress different city, same street', LiveCall.isSameAddress('1 Main St, Greenville, NC', '1 Main St, Cleveland, OH'), false);
check('isSameAddress 12 Main vs 123 Main (prefix guard)', LiveCall.isSameAddress('12 Main St', '123 Main St'), false);
check('isSameAddress blank vs real -> false', LiveCall.isSameAddress('', '303 Elizabeth St'), false);
check('isSameAddress both blank -> false', LiveCall.isSameAddress('', ''), false);
check('different address -> clear', LiveCall.shouldClearDraftForDeal('3928 Millersville Dr, Indianapolis, IN', '303 Elizabeth St, Greenville, NC'), true);
check('same address (normalized) -> keep', LiveCall.shouldClearDraftForDeal('303 Elizabeth St, Greenville, NC', '303 elizabeth st greenville nc'), false);
check('same address exact -> keep', LiveCall.shouldClearDraftForDeal('303 Elizabeth St', '303 Elizabeth St'), false);
check('same street, one full one short -> keep', LiveCall.shouldClearDraftForDeal('303 Elizabeth St, Greenville, NC', '303 Elizabeth St'), false);
check('no draft address -> keep', LiveCall.shouldClearDraftForDeal('', '303 Elizabeth St'), false);
check('no draft address (null) -> keep', LiveCall.shouldClearDraftForDeal(null, '303 Elizabeth St'), false);
check('no deal address -> keep', LiveCall.shouldClearDraftForDeal('3928 Millersville Dr', ''), false);
['address', 'city', 'state', 'zip', 'arv', 'repairs', 'bedsBaths', 'sqft', 'yearBuilt', 'ownerName', 'sellerPhone', 'buyerName', 'listSource', 'listed']
  .forEach(id => check('deal key: ' + id, LiveCall.isDealDraftKey(id), true));
['caller', 'motivation', 'motivationStrength', 'repairLevel', 'condition', 'timeframe', 'sellerPrice', 'decisionMakers', 'direction', 'durationMin', 'talkPct', 'sc-opener', 'sc-talk', 'sc-mctp', 'sc-conditioned', 'sc-anchored', 'sc-reverseAnchor', 'sc-nextAction', 'sc-noLeadDistress', 'sc-heldAnchor', 'sc-decisionMakers', 'offerMade', 'sellerCounter', 'outcome', 'nextAction', 'nextActionDate', '__notes']
  .forEach(id => check('non-deal key: ' + id, LiveCall.isNonDealDraftKey(id), true));
// DEAL_FIELD_IDS must match exactly what fillDealFields writes (source scan,
// like section 9): set('...', deal.*) ids plus listSource/listed, which are
// set by direct assignment in the same function body.
const fillBody = js.slice(js.indexOf('function fillDealFields'), js.indexOf('function autoFillFromUrl'));
const fillSetIds = [...fillBody.matchAll(/set\('([^']+)', deal\./g)].map(m => m[1]);
const fillExtraIds = [...fillBody.matchAll(/\$\('(listSource|listed)'\)/g)].map(m => m[1]);
check('DEAL_FIELD_IDS matches fillDealFields writes', LiveCall.DEAL_FIELD_IDS.slice().sort(), [...fillSetIds, ...fillExtraIds].sort());
// Object-level clear: an Indy draft, opened for the Greenville deal.
const indyDraft = { address: '3928 Millersville Dr', city: 'Indianapolis', state: 'IN', zip: '46201', arv: 145000, repairs: 30000, bedsBaths: '3 / 2', sqft: '1450', yearBuilt: '1987', caller: 'Troy', motivation: 'Behind on taxes', timeframe: 'within 30 days', 'sc-opener': true, 'sc-talk': true, offerMade: '$45,849', nextAction: 'Call back', __notes: ['10:15 — Seller: "I need to think about it."'] };
const cleaned = LiveCall.cleanDraftForNewDeal(indyDraft);
check('cleaned draft keeps only deal keys', Object.keys(cleaned).sort(), ['address', 'arv', 'bedsBaths', 'city', 'repairs', 'sqft', 'state', 'yearBuilt', 'zip'].sort());
check('cleaned draft drops caller/MCTP/scorecard/notes', cleaned.caller === undefined && cleaned.motivation === undefined && cleaned['sc-opener'] === undefined && cleaned.__notes === undefined && cleaned.nextAction === undefined, true);
check('cleaned draft keeps stale ZIP value (deal key, fill overwrites)', cleaned.zip, '46201');
check('cleanDraft does not mutate the original', indyDraft.caller, 'Troy');
check('cleanDraft null -> null', LiveCall.cleanDraftForNewDeal(null), null);
// End-to-end pure flow: Indy draft + Greenville auto-fill deal (stub store lead_1).
const gDeal = LiveCall.resolveAutoFill('?lead=lead_1', stubStore).deal;
check('Greenville deal resolves', gDeal.address, '303 Elizabeth St');
check('Indy draft vs Greenville deal -> clear', LiveCall.shouldClearDraftForDeal(indyDraft.address, gDeal.address), true);
check('deal fields preserved after clear (address)', gDeal.address, '303 Elizabeth St');
check('deal fields preserved after clear (zip)', gDeal.zip, '27528');
check('deal fields preserved after clear (arv/repairs)', [gDeal.arv, gDeal.repairs], [150000, 50000]);
check('deal fields preserved after clear (beds/sqft/year)', [gDeal.bedsBaths, gDeal.sqft, gDeal.yearBuilt], ['3 / 2', '1450', '1987']);
check('Greenville draft vs Greenville deal -> keep', LiveCall.shouldClearDraftForDeal('303 Elizabeth St, Greenville, NC', gDeal.address), false);
check('no draft (null) vs Greenville deal -> keep', LiveCall.shouldClearDraftForDeal(null, gDeal.address), false);

// ---- 11. Draft carryover, DOM-level: the clear must blank deal fields the
// payload does not supply, and Duration must reset (leftovers from
// main@071ef54 — a params-only open showed the previous property's ZIP /
// beds / sqft / year and Duration 12; those values turned out to be the
// HTML placeholders showing through empty fields, but the clear now blanks
// the fields explicitly so a fresh card can never show another property's
// facts). Fake-DOM harness: the module's DOM section runs at load, so run
// the source in a vm context with fake document/window/localStorage and
// fire the captured DOMContentLoaded handler per scenario. ----
console.log('Draft carryover (DOM-level):');
const vm = require('vm');

// Parse live-call.html into fake elements: every tag with an id gets one;
// input type/checked/value, select options (with the selected one), and the
// data-draft flag come straight from the markup (script blocks stripped
// first so inlined JSON cannot false-match), so the harness tracks the
// real page.
function parseLiveCallElements() {
  const els = {};
  const noScript = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(noScript)) !== null) {
    const tag = m[1], attrs = m[2];
    const idM = attrs.match(/\bid="([^"]+)"/);
    if (!idM || els[idM[1]]) continue;
    const id = idM[1];
    const typeM = attrs.match(/\btype="([^"]+)"/);
    const valM = attrs.match(/\bvalue="([^"]*)"/);
    // Initial text content (button labels, span text): the text between
    // this opening tag and the next '<'. Buttons/spans render through
    // textContent, not value — the harness must carry it faithfully.
    const afterTag = noScript.slice(tagRe.lastIndex);
    const textM = afterTag.match(/^([^<]*)/);
    const initialText = textM ? textM[1].trim() : '';
    const el = {
      id, tagName: tag.toUpperCase(),
      type: typeM ? typeM[1] : (tag === 'select' ? 'select-one' : 'text'),
      defaultValue: valM ? valM[1] : '',
      checked: /\bchecked\b/.test(attrs),
      selectedIndex: 0, innerHTML: '', textContent: initialText,
      _draft: /\bdata-draft\b/.test(attrs),
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      querySelectorAll() { return []; },
    };
    // DOM inputs always hold strings — coerce like a real input.value, so
    // restoreDraft storing a number (draft JSON) still behaves like the page.
    let _v = valM ? valM[1] : '';
    Object.defineProperty(el, 'value', {
      get() { return _v; },
      set(v) { _v = v == null ? '' : String(v); },
      enumerable: true, configurable: true,
    });
    if (tag === 'select') {
      const rest = noScript.slice(tagRe.lastIndex);
      const end = rest.indexOf('</select>');
      const opts = [];
      let selIdx = 0;
      const optRe = /<option\b([^>]*)>/g;
      let om;
      while ((om = optRe.exec(rest.slice(0, end))) !== null) {
        const vM = om[1].match(/\bvalue="([^"]*)"/);
        opts.push(vM ? vM[1] : '');
        if (/\bselected\b/.test(om[1])) selIdx = opts.length - 1;
      }
      el.options = opts.map(v => ({ value: v }));
      el.selectedIndex = selIdx;
      Object.defineProperty(el, 'value', {
        get() { const o = this.options[this.selectedIndex]; return o ? o.value : ''; },
        set(v) { const i = this.options.findIndex(o => o.value === v); this.selectedIndex = i === -1 ? 0 : i; },
        enumerable: true, configurable: true,
      });
    }
    els[id] = el;
  }
  return els;
}

function runLiveCallScenario({ draft, search, store, fetchStub }) {
  const elements = parseLiveCallElements();
  const seed = { 'acc_leads': JSON.stringify(store || []) };
  if (draft) seed['liveCallDraft.v1'] = JSON.stringify(draft);
  const storage = {
    _map: seed,
    getItem(k) { return k in this._map ? this._map[k] : null; },
    setItem(k, v) { this._map[k] = String(v); },
    removeItem(k) { delete this._map[k]; },
  };
  const handlers = {};
  const doc = {
    _handlers: handlers,
    getElementById(id) { return elements[id] || null; },
    querySelectorAll(sel) {
      if (sel === '[data-draft]') return Object.values(elements).filter(e => e._draft);
      return [];
    },
    addEventListener(type, fn) { handlers[type] = fn; },
    createElement(tag) { return { tagName: tag.toUpperCase(), src: '', onload: null, onerror: null, addEventListener() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  const sandbox = {
    window: { location: { search: search || '' }, OfferMath, LIVE_CALL_OBJECTIONS: KB.objections },
    document: doc,
    localStorage: storage,
    // vm contexts get no Node globals: live-call.js needs URLSearchParams
    // (parseAutoFillParams) plus timers/Promise/console.
    URLSearchParams,
    setTimeout, clearTimeout, Promise, console,
    // Coach path: fetch (stubbed per scenario) + AbortController.
    fetch: fetchStub || (async () => { throw new Error('no fetch stub'); }),
    AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  if (handlers.DOMContentLoaded) handlers.DOMContentLoaded();
  return {
    elements, storage,
    val(id) { const el = elements[id]; return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; },
    el(id) { return elements[id]; },
    html(id) { const el = elements[id]; return el ? el.innerHTML : undefined; },
    click(id) { const el = elements[id]; (el && el._listeners.click || []).forEach(fn => fn.call(el)); },
    change(id) { const el = elements[id]; (el && el._listeners.change || []).forEach(fn => fn.call(el)); },
    input(id) { const el = elements[id]; (el && el._listeners.input || []).forEach(fn => fn.call(el)); },
  };
}

// blankDealFields (pure): all 14 ids, text blank, listed false, listSource other.
check('blankDealFields covers all 14 deal ids', Object.keys(LiveCall.blankDealFields()).sort(), LiveCall.DEAL_FIELD_IDS.slice().sort());
check('blankDealFields text ids blank', ['address', 'city', 'state', 'zip', 'arv', 'repairs', 'bedsBaths', 'sqft', 'yearBuilt', 'ownerName', 'sellerPhone', 'buyerName'].every(id => LiveCall.blankDealFields()[id] === ''), true);
check('blankDealFields listed false', LiveCall.blankDealFields().listed, false);
check('blankDealFields listSource other (not probate)', LiveCall.blankDealFields().listSource, 'other');

// MAO figures unchanged by this build (real calibration file, market-gated).
check('DOM-level: Greenville 303 MAO unchanged', OfferMath.offerMath(150000, 50000, undefined, OfferMath.marketFor('Greenville', 'NC')).mao, 80000);
check('DOM-level: Greenville 303 LAO unchanged', OfferMath.offerMath(150000, 50000, undefined, OfferMath.marketFor('Greenville', 'NC')).lao, 56000);
check('DOM-level: Indy 3928 MAO unchanged', OfferMath.offerMath(145000, 30000, undefined, OfferMath.marketFor('Indianapolis', 'IN')).mao, 65499);
check('DOM-level: Indy 3928 LAO unchanged', OfferMath.offerMath(145000, 30000, undefined, OfferMath.marketFor('Indianapolis', 'IN')).lao, 45849);

const domIndyDraft = Object.assign({}, indyDraft, { caller: 'Irish', direction: 'inbound', durationMin: '12', talkPct: '80' });
const domGreenvilleDraft = { address: '303 Elizabeth St', city: 'Greenville', state: 'NC', zip: '27528', arv: 150000, repairs: 50000, bedsBaths: '3 / 2', sqft: '1450', yearBuilt: '1987', ownerName: 'Chet Mentlewski', sellerPhone: '(252) 555-0100', listSource: 'code violation', caller: 'Irish', motivation: 'Behind on taxes', durationMin: '12', talkPct: '80', 'sc-opener': true, __notes: ['11:02 — Seller: "I need to think about it."'] };

// A. Different address, params-only payload (Comps link: address/ARV/repairs).
const scA = runLiveCallScenario({ draft: domIndyDraft, search: '?address=303%20Elizabeth%20St%2C%20Greenville%2C%20NC&arv=150000&repairs=50000', store: [] });
check('A params-only: address/city/state filled', [scA.val('address'), scA.val('city'), scA.val('state')], ['303 Elizabeth St', 'Greenville', 'NC']);
check('A params-only: ARV/repairs filled', [scA.val('arv'), scA.val('repairs')], ['150000', '50000']);
check('A params-only: ZIP blank (not Indy 46201)', scA.val('zip'), '');
check('A params-only: beds blank', scA.val('bedsBaths'), '');
check('A params-only: sqft blank', scA.val('sqft'), '');
check('A params-only: year blank', scA.val('yearBuilt'), '');
check('A params-only: owner/phone/buyer blank', [scA.val('ownerName'), scA.val('sellerPhone'), scA.val('buyerName')], ['', '', '']);
check('A params-only: listSource other', scA.val('listSource'), 'other');
check('A params-only: listed unchecked', scA.val('listed'), false);
check('A params-only: Duration blank (not 12)', scA.val('durationMin'), '');
check('A params-only: caller reset to Troy', scA.val('caller'), 'Troy');
check('A params-only: direction reset to outbound', scA.val('direction'), 'outbound');
check('A params-only: talkPct reset to 50', scA.val('talkPct'), '50');
check('A params-only: motivation blank', scA.val('motivation'), '');
check('A params-only: scorecard cleared', [scA.val('sc-opener'), scA.val('sc-talk')], [false, false]);
check('A params-only: next action blank', scA.val('nextAction'), '');
check('A params-only: notes cleared', scA.el('noteLog').innerHTML.includes('No notes yet'), true);

// B. Same address, full payload (lead): draft kept.
const scB = runLiveCallScenario({ draft: domGreenvilleDraft, search: '?lead=lead_1', store: stubStore });
check('B same-address: ZIP kept (lead fill)', scB.val('zip'), '27528');
check('B same-address: beds/sqft/year kept', [scB.val('bedsBaths'), scB.val('sqft'), scB.val('yearBuilt')], ['3 / 2', '1450', '1987']);
check('B same-address: owner/phone kept', [scB.val('ownerName'), scB.val('sellerPhone')], ['Chet Mentlewski', '(252) 555-0100']);
check('B same-address: Duration kept', scB.val('durationMin'), '12');
check('B same-address: caller kept', scB.val('caller'), 'Irish');
check('B same-address: motivation kept', scB.val('motivation'), 'Behind on taxes');
check('B same-address: scorecard kept', scB.val('sc-opener'), true);
check('B same-address: notes kept', scB.el('noteLog').innerHTML.includes('I need to think about it'), true);

// C. Different address, full payload (lead): deal filled, debrief cleared.
const scC = runLiveCallScenario({ draft: domIndyDraft, search: '?lead=lead_1', store: stubStore });
check('C lead: ZIP filled from lead', scC.val('zip'), '27528');
check('C lead: beds/sqft/year filled', [scC.val('bedsBaths'), scC.val('sqft'), scC.val('yearBuilt')], ['3 / 2', '1450', '1987']);
check('C lead: owner/phone filled', [scC.val('ownerName'), scC.val('sellerPhone')], ['Chet Mentlewski', '(252) 555-0100']);
check('C lead: listSource from signal', scC.val('listSource'), 'code violation');
check('C lead: Duration blank', scC.val('durationMin'), '');
check('C lead: scorecard cleared', scC.val('sc-opener'), false);
check('C lead: motivation blank', scC.val('motivation'), '');
check('C lead: notes cleared', scC.el('noteLog').innerHTML.includes('No notes yet'), true);

// D. Manual open (no auto-fill): everything kept.
const scD = runLiveCallScenario({ draft: domIndyDraft, search: '', store: [] });
check('D manual: ZIP kept', scD.val('zip'), '46201');
check('D manual: beds/sqft/year kept', [scD.val('bedsBaths'), scD.val('sqft'), scD.val('yearBuilt')], ['3 / 2', '1450', '1987']);
check('D manual: Duration kept', scD.val('durationMin'), '12');
check('D manual: scorecard kept', scD.val('sc-opener'), true);
check('D manual: notes kept', scD.el('noteLog').innerHTML.includes('I need to think about it'), true);

// ---- 12. Live Coach: match + prompt + guard + throttle + DOM wiring ----
// The coach hears the seller and flashes replies. Grounding: vetted line
// first when one matches, AI backups second, never a $ figure above MAO.
console.log('Live Coach:');
const coachObs = KB.objections;
check('coach match "that\'s too low" -> L013', (LiveCall.matchObjection("That's too low.", coachObs) || {}).id, 'L013');
check('coach match "I need to think about it" -> L030', (LiveCall.matchObjection('I need to think about it.', coachObs) || {}).id, 'L030');
check('coach match "what\'s your offer" -> L023', (LiveCall.matchObjection("What's your offer?", coachObs) || {}).id, 'L023');
check('coach match "zillow says it\'s worth more" -> L017', (LiveCall.matchObjection("Zillow says it's worth more.", coachObs) || {}).id, 'L017');
check('coach match longest keyword wins', (LiveCall.matchObjection('I need to talk to my wife about it.', coachObs) || {}).id, 'L039');
check('coach match no match -> null', LiveCall.matchObjection('The sky is blue today.', coachObs), null);
check('coach match empty -> null', LiveCall.matchObjection('', coachObs), null);
check('coach match case-insensitive', (LiveCall.matchObjection("THAT'S TOO LOW.", coachObs) || {}).id, 'L013');
check('extractDollarAmounts', LiveCall.extractDollarAmounts('I want $120,000 and $56,000'), [120000, 56000]);
check('extractDollarAmounts none', LiveCall.extractDollarAmounts('no numbers here'), []);
check('guard: $56,000 under MAO $80,000 safe', LiveCall.coachSuggestionGuard('How about $56,000?', 80000), true);
check('guard: $200,000 above MAO $80,000 dropped', LiveCall.coachSuggestionGuard('We could do $200,000.', 80000), false);
check('guard: no $ figure safe', LiveCall.coachSuggestionGuard('Tell me about the roof.', 80000), true);
check('guard: $ figure with no MAO fails closed', LiveCall.coachSuggestionGuard('How about $56,000?', null), false);
check('guard: exactly MAO safe', LiveCall.coachSuggestionGuard('At most $80,000.', 80000), true);
const coachCtx = LiveCall.coachDealContext({ address: '303 Elizabeth St', city: 'Greenville', state: 'NC', arv: 150000, repairs: 50000, mao: 80000, lao: 56000, multiplierLabel: '80% tier', callerName: 'Troy' });
check('coachDealContext keeps numbers', [coachCtx.mao, coachCtx.lao], [80000, 56000]);
check('coachDealContext nulls stay null', LiveCall.coachDealContext({}).mao, null);
const coachPrompt = LiveCall.buildCoachPrompt(coachCtx, ['10:01 — That\'s too low.'], KB.objections.find(o => o.id === 'L013'));
check('coach prompt system has LAO/MAO guard', coachPrompt.system.includes('$56,000') && coachPrompt.system.includes('$80,000'), true);
check('coach prompt system forbids above MAO', coachPrompt.system.includes('never quote above MAO'), true);
check('coach prompt system has walkaway rule', coachPrompt.system.includes('2x MAO'), true);
check('coach prompt system has opt-out silence', coachPrompt.system.includes('opt out'), true);
check('coach prompt user has deal facts', coachPrompt.user.includes('303 Elizabeth St') && coachPrompt.user.includes('MAO $80,000'), true);
check('coach prompt user has transcript', coachPrompt.user.includes("That's too low."), true);
check('coach prompt user includes matched line first', coachPrompt.user.includes('vetted reply matches'), true);
const coachPromptNoMatch = LiveCall.buildCoachPrompt(coachCtx, ['10:01 — Hello?'], null);
check('coach prompt no matched line -> no vetted line', coachPromptNoMatch.user.includes('vetted reply matches'), false);
check('parseCoachResponse valid', LiveCall.parseCoachResponse({ suggestions: ['A', 'B', 'C'] }, 80000), ['A', 'B', 'C']);
check('parseCoachResponse caps at 3', LiveCall.parseCoachResponse({ suggestions: ['A', 'B', 'C', 'D'] }, 80000).length, 3);
check('parseCoachResponse drops empties', LiveCall.parseCoachResponse({ suggestions: ['A', '', '  ', 'B'] }, 80000), ['A', 'B']);
check('parseCoachResponse drops over-MAO', LiveCall.parseCoachResponse({ suggestions: ['We can do $200,000.', 'How about $56,000?'] }, 80000), ['How about $56,000?']);
check('parseCoachResponse non-array -> []', LiveCall.parseCoachResponse({ suggestions: 'nope' }, 80000), []);
check('parseCoachResponse null body -> []', LiveCall.parseCoachResponse(null, 80000), []);
check('parseCoachResponse no MAO -> $ suggestions dropped', LiveCall.parseCoachResponse({ suggestions: ['How about $56,000?', 'Tell me about the roof.'] }, null), ['Tell me about the roof.']);
check('shouldSuggestCoach normal', LiveCall.shouldSuggestCoach({ text: "That's too low for me.", lastSuggestedAt: 1000, now: 6000 }), true);
check('shouldSuggestCoach cooldown blocks', LiveCall.shouldSuggestCoach({ text: "That's too low for me.", lastSuggestedAt: 5000, now: 6000 }), false);
check('shouldSuggestCoach cooldown passes at 4s', LiveCall.shouldSuggestCoach({ text: "That's too low for me.", lastSuggestedAt: 1000, now: 5000 }), true);
check('shouldSuggestCoach short text rejected', LiveCall.shouldSuggestCoach({ text: 'No.', lastSuggestedAt: null, now: 6000 }), false);
check('shouldSuggestCoach 2 words rejected', LiveCall.shouldSuggestCoach({ text: 'Too low.', lastSuggestedAt: null, now: 6000 }), false);
check('shouldSuggestCoach 3 words ok', LiveCall.shouldSuggestCoach({ text: 'That is low.', lastSuggestedAt: null, now: 6000 }), true);
// Markdown transcript section.
const mdCoach = LiveCall.buildDebriefMarkdown({ date: '2026-11-06', callerName: 'Troy', address: '303 Elizabeth St', score: 7, total: 10, verdict: 'Solid call', transcript: ['10:01 — That\'s too low.', '10:02 — I need to think about it.'] });
check('markdown includes live transcript', mdCoach.includes('## Live transcript') && mdCoach.includes("That's too low."), true);
const mdNoCoach = LiveCall.buildDebriefMarkdown({ date: '2026-11-06', callerName: 'Troy', address: '303 Elizabeth St', score: 7, total: 10, verdict: 'Solid call' });
check('markdown omits transcript section when empty', mdNoCoach.includes('## Live transcript'), false);

// DOM-level: the simulate box feeds the same pipeline the mic feeds.
// Stubbed fetch returns canned AI suggestions; the matched vetted line
// renders first; an over-MAO AI suggestion is dropped client-side.
// (Async — awaited before the final tally.)
async function section12() {
  const coachDraft = { address: '303 Elizabeth St', city: 'Greenville', state: 'NC', zip: '27528', arv: 150000, repairs: 50000, listSource: 'code violation' };
  const cannedFetch = async () => ({ ok: true, json: async () => ({ suggestions: ['We could do $200,000.', 'How about $56,000?'] }) });
  const scCoach = runLiveCallScenario({ draft: coachDraft, search: '', store: [], fetchStub: cannedFetch });
  // Consent gate: Start without the box checked does not start listening.
  scCoach.click('coachToggle');
  check('coach consent gate blocks start', scCoach.el('coachStatus').textContent, 'Tell the seller first — check the box above, then start.');
  check('coach toggle label unchanged when gated', scCoach.el('coachToggle').textContent, '🎙 Start listening');
  // Simulate "That's too low." -> vetted L013 first + $56,000 backup;
  // the $200,000 AI suggestion is dropped by the client-side guard.
  scCoach.el('coachSimInput').value = "That's too low.";
  scCoach.click('coachSimBtn');
  await new Promise(r => setTimeout(r, 100));
  const sugHtml = scCoach.html('coachSuggestions');
  check('coach sim: vetted line renders first', sugHtml.includes('Vetted line') && sugHtml.includes('I understand. To take it as-is'), true);
  check('coach sim: safe AI backup renders', sugHtml.includes('How about $56,000?'), true);
  check('coach sim: over-MAO AI suggestion dropped', sugHtml.includes('$200,000'), false);
  check('coach sim: latency shown', scCoach.el('coachLatency').textContent.includes('suggested in'), true);
  check('coach sim: transcript logged', scCoach.html('coachTranscript').includes('too low'), true);
  // AI unreachable -> vetted line alone, clearly labeled.
  const deadFetch = async () => { throw new Error('network down'); };
  const scDead = runLiveCallScenario({ draft: coachDraft, search: '', store: [], fetchStub: deadFetch });
  scDead.el('coachSimInput').value = 'I need to think about it.';
  scDead.click('coachSimBtn');
  await new Promise(r => setTimeout(r, 100));
  const deadHtml = scDead.html('coachSuggestions');
  check('coach AI-down: vetted line still renders', deadHtml.includes('Vetted line') && deadHtml.includes('what do you need to think about'), true);
  check('coach AI-down: labeled vetted-only', deadHtml.includes('vetted line only'), true);
  // No match at all -> honest empty state, no invented line.
  const scNone = runLiveCallScenario({ draft: coachDraft, search: '', store: [], fetchStub: async () => ({ ok: true, json: async () => ({ suggestions: [] }) }) });
  scNone.el('coachSimInput').value = 'The sky is blue today.';
  scNone.click('coachSimBtn');
  await new Promise(r => setTimeout(r, 100));
  check('coach no-match: honest empty state', scNone.html('coachSuggestions').includes('No line matched'), true);
}

// ---- 13. Address lookup: property record + verified comps auto-fill ----
// Fixtures only — zero live API credits. Gatlin numbers from the Nov 6
// pre-call sheet (ARV $154,167 from 405 Greenview $175,000 / 405 Arbor
// $150,000 / 503 Pittman $137,500; 2bd/1ba, 986 sqft, 1961).
const gatlinComps3 = {
  confidence: 'HIGH', confidenceText: 'HIGH — 3 comps pass all selection rules',
  best: [
    { address: '405 Greenview Dr, Greenville, NC 27834', amount: 175000 },
    { address: '405 Arbor St, Greenville, NC 27834', amount: 150000 },
    { address: '503 Pittman Dr, Greenville, NC 27834', amount: 137500 },
  ],
};
const gatlinPR = {
  matched: true, address: '705 McDowell St, Greenville, NC 27834',
  property: { address: '705 MCDOWELL ST, GREENVILLE, NC 27834', owner1: 'WILLARD D GATLIN', owner2: '', beds: 2, baths: 1, sqft: 986, yearBuilt: 1961, onMarket: false, listingStatus: null },
  comps: gatlinComps3,
};
const gatlinATTOM = {
  matched: true, address: '705 McDowell St, Greenville, NC 27834',
  property: { address: '705 MCDOWELL ST, GREENVILLE, NC 27834', owner1: 'WILLARD D GATLIN', owner2: '', beds: 2, baths: 1, sqft: 986, yearBuilt: 1961 },
  comps: gatlinComps3,
};
const gatlinPRNoComps = Object.assign({}, gatlinPR, { comps: { confidence: 'LOW', confidenceText: 'LOW — no comps pass', best: [] } });
const gatlinPRListed = Object.assign({}, gatlinPR, {
  property: Object.assign({}, gatlinPR.property, { onMarket: true, listingStatus: 'listed' }),
});
const gatlinPRThin = Object.assign({}, gatlinPR, {
  comps: { confidence: 'LOW', confidenceText: 'LOW — only 2 comps pass', best: gatlinComps3.best.slice(0, 2) },
});
// Waterbury fixture (live test Nov 6 9:24 PM): 1 comp, LOW — candidate
// $495,000, ARV blank.
const waterburyComps1 = {
  confidence: 'LOW', confidenceText: 'LOW — fewer than 3 usable comps, do not lock a number on this set',
  best: [{ address: '55 Water St, Waterbury, CT 06710', amount: 495000 }],
};
const waterburyPR = {
  matched: true, address: '229 Plaza Ave, Waterbury, CT 06710',
  property: { address: '229 PLAZA AVE, WATERBURY, CT 06710', owner1: 'ANSON GRAY', owner2: '', beds: 7, baths: 2.5, sqft: 3930, yearBuilt: 1913, onMarket: false, listingStatus: null },
  comps: waterburyComps1,
};
// Gatlin with the live-test ARV ($179,167): Greenview + Pittman + a $225,000
// renovated comp — the automated pick after 405 Arbor St hard-fails the
// ±20% sqft rule (1,184 sqft vs 986 = +20.08%).
const gatlinComps179 = {
  confidence: 'HIGH', confidenceText: 'HIGH — 3 comps pass all selection rules',
  best: [
    { address: '405 Greenview Dr, Greenville, NC 27834', amount: 175000 },
    { address: '503 Pittman Dr, Greenville, NC 27834', amount: 137500 },
    { address: '225 Renovation Way, Greenville, NC 27834', amount: 225000 },
  ],
};
const gatlinPR179 = Object.assign({}, gatlinPR, { comps: gatlinComps179 });
// A saved draft holding Gatlin's facts with a stale ARV (the live-test state).
const gatlinDraft = { address: '705 McDowell St, Greenville, NC 27834', city: 'Greenville', state: 'NC', zip: '27834', arv: 150000, repairs: 30000, bedsBaths: '2 / 1', sqft: '986', yearBuilt: '1961', ownerName: 'WILLARD D GATLIN', sellerPhone: '7573104762', listSource: 'code violation', caller: 'Troy' };
// Fetch stub that answers per ADDRESS (not per route): data-api returns the
// fixture for the looked-up address, attom-lookup reports no match.
function lookupFetchByAddress(map) {
  return async (url) => {
    const u = String(url);
    if (u.indexOf('attom-lookup') !== -1) return { ok: true, json: async () => ({ matched: false }) };
    const m = u.match(/address=([^&]*)/);
    const a = m ? decodeURIComponent(m[1]) : '';
    const body = /waterbury/i.test(a) ? map.waterbury : /mcdowell/i.test(a) ? map.gatlin : null;
    if (!body) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  };
}
function lookupFetchStub(routes) {
  return async (url) => {
    for (const k of Object.keys(routes)) {
      if (String(url).indexOf(k) !== -1) {
        const body = routes[k];
        if (body === null) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => body };
      }
    }
    throw new Error('unexpected fetch URL: ' + url);
  };
}
const GATLIN_SEARCH = '?address=705%20McDowell%20St%2C%20Greenville%2C%20NC%2027834';
async function section13() {
  // Section 8 deliberately leaves a HANGING calibration promise behind
  // (loadMaoCalibration(hangFetch)); a real page load starts with a fresh
  // settled one. Restore the settled state so the lookup's buildPrep is
  // gated on microtasks, not the 2s timeout — the timeout fallback itself
  // is already proven by section 8's own checks.
  OfferMath.loadMaoCalibration();
  // lookupPropertyAndComps: PR path (same sequence as the Comps page).
  const prRes = await LiveCall.lookupPropertyAndComps('705 McDowell St, Greenville, NC 27834', lookupFetchStub({ 'data-api': gatlinPR, 'attom-lookup': gatlinATTOM }));
  check('lookup PR: matched', prRes && prRes.matched, true);
  check('lookup PR: source', prRes && prRes.source, 'data provider');
  check('lookup PR: owner', prRes && prRes.property.owner1, 'WILLARD D GATLIN');
  check('lookup PR: 3 comps', prRes && prRes.comps.best.length, 3);
  // PR matched but no comps -> ATTOM comps, PR subject merged over ATTOM.
  const attomRes = await LiveCall.lookupPropertyAndComps('705 McDowell St, Greenville, NC 27834', lookupFetchStub({ 'data-api': gatlinPRNoComps, 'attom-lookup': gatlinATTOM }));
  check('lookup PR-no-comps: source ATTOM+PR', attomRes && attomRes.source, 'ATTOM+PR');
  check('lookup PR-no-comps: owner from PR', attomRes && attomRes.property.owner1, 'WILLARD D GATLIN');
  check('lookup PR-no-comps: comps from ATTOM', attomRes && attomRes.comps.best.length, 3);
  // PR down -> ATTOM alone.
  const attomOnly = await LiveCall.lookupPropertyAndComps('705 McDowell St, Greenville, NC 27834', async (url) => {
    if (url.indexOf('data-api') !== -1) throw new Error('PR down');
    return { ok: true, json: async () => gatlinATTOM };
  });
  check('lookup PR down: source ATTOM', attomOnly && attomOnly.source, 'ATTOM');
  // Neither matched -> null (no record, not an error).
  check('lookup both unmatched: null', await LiveCall.lookupPropertyAndComps('705 McDowell St, Greenville, NC 27834', lookupFetchStub({ 'data-api': { matched: false }, 'attom-lookup': { matched: false } })), null);
  // Both fetches throw -> throws (caller says "unavailable").
  let threw = false;
  try { await LiveCall.lookupPropertyAndComps('705 McDowell St, Greenville, NC 27834', async () => { throw new Error('down'); }); } catch (e) { threw = true; }
  check('lookup both down: throws', threw, true);
  // PR matched, no comps, ATTOM down -> record still fills, comps null.
  const prOnly = await LiveCall.lookupPropertyAndComps('705 McDowell St, Greenville, NC 27834', async (url) => {
    if (url.indexOf('data-api') !== -1) return { ok: true, json: async () => gatlinPRNoComps };
    throw new Error('ATTOM down');
  });
  check('lookup PR-only: source data provider', prOnly && prOnly.source, 'data provider');
  check('lookup PR-only: comps null', prOnly && prOnly.comps, null);
  // ARV gate: HIGH/MEDIUM with 3+ pass; LOW-MEDIUM and thin do not.
  check('arvFromComps HIGH 3: arv 154167', LiveCall.arvFromComps(gatlinComps3), { arv: 154167, candidate: 154167, count: 3, confidence: 'HIGH', confidenceText: 'HIGH — 3 comps pass all selection rules', passes: true });
  const med = { confidence: 'MEDIUM', confidenceText: 'MEDIUM', best: gatlinComps3.best };
  check('arvFromComps MEDIUM 3: passes', LiveCall.arvFromComps(med).passes, true);
  check('arvFromComps MEDIUM 3: arv 154167', LiveCall.arvFromComps(med).arv, 154167);
  const lowMed = { confidence: 'LOW-MEDIUM', confidenceText: 'LOW-MEDIUM', best: gatlinComps3.best };
  check('arvFromComps LOW-MEDIUM 3: arv null', LiveCall.arvFromComps(lowMed).arv, null);
  check('arvFromComps LOW-MEDIUM 3: candidate kept', LiveCall.arvFromComps(lowMed).candidate, 154167);
  check('arvFromComps LOW-MEDIUM 3: not passes', LiveCall.arvFromComps(lowMed).passes, false);
  check('arvFromComps LOW 2: arv null', LiveCall.arvFromComps(gatlinPRThin.comps).arv, null);
  check('arvFromComps LOW 2: candidate 162500', LiveCall.arvFromComps(gatlinPRThin.comps).candidate, 162500);
  check('arvFromComps LOW 2: count 2', LiveCall.arvFromComps(gatlinPRThin.comps).count, 2);
  check('arvFromComps no comps: arv null', LiveCall.arvFromComps(null).arv, null);
  check('arvFromComps no comps: candidate null', LiveCall.arvFromComps(null).candidate, null);
  // lookupDealFromResult: Gatlin mapping end to end.
  const gatlinDeal = LiveCall.lookupDealFromResult(prRes, '705 McDowell St, Greenville, NC 27834');
  check('lookupDeal Gatlin: owner', gatlinDeal.ownerName, 'WILLARD D GATLIN');
  check('lookupDeal Gatlin: bedsBaths', gatlinDeal.bedsBaths, '2 / 1');
  check('lookupDeal Gatlin: sqft', gatlinDeal.sqft, '986');
  check('lookupDeal Gatlin: yearBuilt', gatlinDeal.yearBuilt, '1961');
  check('lookupDeal Gatlin: city/state/zip', [gatlinDeal.city, gatlinDeal.state, gatlinDeal.zip], ['Greenville', 'NC', '27834']);
  check('lookupDeal Gatlin: arv 154167', gatlinDeal.arv, 154167);
  check('lookupDeal Gatlin: listed false', gatlinDeal.listed, false);
  check('lookupDeal Gatlin: confidence HIGH', gatlinDeal.confidence, 'HIGH');
  // Listed record -> PASS.
  const listedDeal = LiveCall.lookupDealFromResult({ matched: true, source: 'data provider', property: gatlinPRListed.property, comps: gatlinComps3 }, '705 McDowell St, Greenville, NC 27834');
  check('lookupDeal listed: listed true', listedDeal.listed, true);
  // owner2 joins with &.
  const twoOwner = LiveCall.lookupDealFromResult({ matched: true, property: Object.assign({}, gatlinPR.property, { owner2: 'MARY GATLIN' }), comps: gatlinComps3 }, '705 McDowell St, Greenville, NC 27834');
  check('lookupDeal owner2: joined', twoOwner.ownerName, 'WILLARD D GATLIN & MARY GATLIN');
  // Street-only typed address -> city/state/zip from the record's one-line.
  const streetOnly = LiveCall.lookupDealFromResult(prRes, '705 McDowell St');
  check('lookupDeal street-only: city/state/zip from record', [streetOnly.city, streetOnly.state, streetOnly.zip], ['Greenville', 'NC', '27834']);
  // Thin deal: ARV null, candidate kept, gate fails.
  const thinDeal = LiveCall.lookupDealFromResult({ matched: true, source: 'data provider', property: gatlinPR.property, comps: gatlinPRThin.comps }, '705 McDowell St, Greenville, NC 27834');
  check('lookupDeal thin: arv null', thinDeal.arv, null);
  check('lookupDeal thin: candidate 162500', thinDeal.candidateArv, 162500);
  check('lookupDeal thin: gate false', thinDeal.arvPassesGate, false);
  // MAO/LAO end to end on the auto-filled ARV (Carolina, tier-only).
  check('lookup MAO end-to-end: 99334', OfferMath.offerMath(154167, 30000, undefined, OfferMath.marketFor('Greenville', 'NC')).mao, 99334);
  check('lookup LAO end-to-end: 69534', OfferMath.offerMath(154167, 30000, undefined, OfferMath.marketFor('Greenville', 'NC')).lao, 69534);

  // DOM: params open + Indy draft -> params win AND the lookup fills the card.
  const scE1 = runLiveCallScenario({ draft: domIndyDraft, search: GATLIN_SEARCH + '&repairs=30000', store: [], fetchStub: lookupFetchStub({ 'data-api': gatlinPR, 'attom-lookup': gatlinATTOM }) });
  await new Promise(r => setTimeout(r, 200));
  check('E1 params+lookup: draft dropped (caller Troy)', scE1.val('caller'), 'Troy');
  check('E1 params+lookup: owner filled', scE1.val('ownerName'), 'WILLARD D GATLIN');
  check('E1 params+lookup: bedsBaths', scE1.val('bedsBaths'), '2 / 1');
  check('E1 params+lookup: sqft', scE1.val('sqft'), '986');
  check('E1 params+lookup: yearBuilt', scE1.val('yearBuilt'), '1961');
  check('E1 params+lookup: city/state/zip', [scE1.val('city'), scE1.val('state'), scE1.val('zip')], ['Greenville', 'NC', '27834']);
  check('E1 params+lookup: ARV filled 154167', scE1.val('arv'), '154167');
  check('E1 params+lookup: listed false', scE1.val('listed'), false);
  check('E1 params+lookup: status names HIGH + ARV', scE1.el('lookupStatus').textContent.includes('HIGH') && scE1.el('lookupStatus').textContent.includes('154,167'), true);
  check('E1 params+lookup: card MAO $99,334', scE1.html('prepOut').includes('$99,334'), true);
  check('E1 params+lookup: card LAO $69,534', scE1.html('prepOut').includes('$69,534'), true);
  // DOM: a param-supplied ARV is Troy's verified number — never overwritten.
  const scE2 = runLiveCallScenario({ draft: null, search: GATLIN_SEARCH + '&arv=150000&repairs=30000', store: [], fetchStub: lookupFetchStub({ 'data-api': gatlinPR, 'attom-lookup': gatlinATTOM }) });
  await new Promise(r => setTimeout(r, 200));
  check('E2 ARV preserved: stays 150000', scE2.val('arv'), '150000');
  check('E2 ARV preserved: owner still fills', scE2.val('ownerName'), 'WILLARD D GATLIN');
  check('E2 ARV preserved: card MAO $96,000', scE2.html('prepOut').includes('$96,000'), true);
  // DOM: listed record -> checkbox + PASS banner, MAO/LAO cleared.
  const scE3 = runLiveCallScenario({ draft: null, search: GATLIN_SEARCH + '&repairs=30000', store: [], fetchStub: lookupFetchStub({ 'data-api': gatlinPRListed, 'attom-lookup': gatlinATTOM }) });
  await new Promise(r => setTimeout(r, 200));
  check('E3 listed: checkbox checked', scE3.val('listed'), true);
  check('E3 listed: PASS banner', scE3.html('prepOut').includes('LISTED WITH A REALTOR — PASS'), true);
  check('E3 listed: MAO cleared', scE3.html('prepOut').includes('$99,334'), false);
  check('E3 listed: status says LISTED', scE3.el('lookupStatus').textContent.includes('LISTED'), true);
  // DOM: thin comps -> ARV stays blank, candidate note shown, no math fed.
  const scE4 = runLiveCallScenario({ draft: null, search: GATLIN_SEARCH + '&repairs=30000', store: [], fetchStub: lookupFetchStub({ 'data-api': gatlinPRThin, 'attom-lookup': { matched: false } }) });
  await new Promise(r => setTimeout(r, 200));
  check('E4 thin: ARV stays blank', scE4.val('arv'), '');
  check('E4 thin: status names candidate', scE4.el('lookupStatus').textContent.includes('candidate'), true);
  check('E4 thin: card shows candidate note', scE4.html('prepOut').includes('ARV candidate'), true);
  check('E4 thin: no MAO from candidate', scE4.html('prepOut').includes('$99,334'), false);
  // DOM: the 🔍 button path (manual open, type address, tap lookup).
  const scE5 = runLiveCallScenario({ draft: null, search: '', store: [], fetchStub: lookupFetchStub({ 'data-api': gatlinPR, 'attom-lookup': gatlinATTOM }) });
  scE5.el('address').value = '705 McDowell St, Greenville, NC 27834';
  scE5.click('lookupBtn');
  await new Promise(r => setTimeout(r, 200));
  check('E5 button: owner filled', scE5.val('ownerName'), 'WILLARD D GATLIN');
  check('E5 button: ARV filled', scE5.val('arv'), '154167');
  check('E5 button: city filled from typed address', scE5.val('city'), 'Greenville');
  check('E5 button: card MAO at $0 repairs $123,334', scE5.html('prepOut').includes('$123,334'), true);
  // DOM: lookup failure writes nothing.
  const scE6 = runLiveCallScenario({ draft: null, search: '', store: [], fetchStub: async () => { throw new Error('down'); } });
  scE6.el('address').value = '705 McDowell St, Greenville, NC 27834';
  scE6.click('lookupBtn');
  await new Promise(r => setTimeout(r, 200));
  check('E6 failure: owner untouched', scE6.val('ownerName'), '');
  check('E6 failure: ARV untouched', scE6.val('arv'), '');
  check('E6 failure: status says unavailable', scE6.el('lookupStatus').textContent.includes('unavailable'), true);

  // Pure: blankAddressFields / resolveLookupArv / lookupSourceLabel.
  check('blankAddressFields', LiveCall.blankAddressFields(), { city: '', state: '', zip: '', arv: '', ownerName: '', bedsBaths: '', sqft: '', yearBuilt: '', listed: false });
  check('resolveLookupArv blank-field write', LiveCall.resolveLookupArv(null, 154167, false, false), { action: 'write', value: 154167 });
  check('resolveLookupArv lookup-owned overwrite', LiveCall.resolveLookupArv(154167, 179167, true, false), { action: 'write', value: 179167 });
  check('resolveLookupArv hand-typed keep', LiveCall.resolveLookupArv(150000, 154167, false, false), { action: 'keep', value: 150000 });
  check('resolveLookupArv address-change write', LiveCall.resolveLookupArv(150000, 154167, false, true), { action: 'write', value: 154167 });
  check('resolveLookupArv gated blanks lookup-owned', LiveCall.resolveLookupArv(154167, null, true, false), { action: 'blank', value: null });
  check('resolveLookupArv gated blanks on address change', LiveCall.resolveLookupArv(150000, null, false, true), { action: 'blank', value: null });
  check('resolveLookupArv gated keeps hand-typed', LiveCall.resolveLookupArv(150000, null, false, false), { action: 'keep', value: 150000 });
  check('lookupSourceLabel PropertyReach', LiveCall.lookupSourceLabel('data provider'), 'PropertyReach');
  check('lookupSourceLabel ATTOM', LiveCall.lookupSourceLabel('ATTOM'), 'ATTOM');
  check('lookupSourceLabel ATTOM+PR', LiveCall.lookupSourceLabel('ATTOM+PR'), 'ATTOM + PropertyReach');
  check('lookupDeal source rides along', gatlinDeal.source, 'data provider');
  check('lookupDeal bestComps', gatlinDeal.bestComps, [
    { address: '405 Greenview Dr, Greenville, NC 27834', amount: 175000 },
    { address: '405 Arbor St, Greenville, NC 27834', amount: 150000 },
    { address: '503 Pittman Dr, Greenville, NC 27834', amount: 137500 },
  ]);

  // DOM E7: the live-test sequence — Gatlin draft restored, then a Waterbury
  // lookup, then back to Gatlin. Every lookup must write city/state/ZIP/ARV
  // from ITS result; a gated ARV must blank the field; the card must never
  // compute from the previous address's ARV.
  const scE7 = runLiveCallScenario({ draft: gatlinDraft, search: '', store: [], fetchStub: lookupFetchByAddress({ waterbury: waterburyPR, gatlin: gatlinPR }) });
  check('E7 draft: ARV starts 150000', scE7.val('arv'), '150000');
  check('E7 draft: city starts Greenville', scE7.val('city'), 'Greenville');
  scE7.el('address').value = '229 Plaza Ave, Waterbury, CT 06710';
  scE7.click('lookupBtn');
  // Synchronous: the address change blanks the stale facts BEFORE the
  // fetch resolves — the form must never show Greenville next to Waterbury.
  check('E7 blank-before-result: city blank', scE7.val('city'), '');
  check('E7 blank-before-result: state blank', scE7.val('state'), '');
  check('E7 blank-before-result: zip blank', scE7.val('zip'), '');
  check('E7 blank-before-result: ARV blank', scE7.val('arv'), '');
  check('E7 blank-before-result: owner blank', scE7.val('ownerName'), '');
  check('E7 blank-before-result: beds blank', scE7.val('bedsBaths'), '');
  await new Promise(r => setTimeout(r, 200));
  check('E7 Waterbury: city Waterbury', scE7.val('city'), 'Waterbury');
  check('E7 Waterbury: state CT', scE7.val('state'), 'CT');
  check('E7 Waterbury: zip 06710', scE7.val('zip'), '06710');
  check('E7 Waterbury: owner ANSON GRAY', scE7.val('ownerName'), 'ANSON GRAY');
  check('E7 Waterbury: bedsBaths 7 / 2.5', scE7.val('bedsBaths'), '7 / 2.5');
  check('E7 Waterbury: sqft 3930', scE7.val('sqft'), '3930');
  check('E7 Waterbury: year 1913', scE7.val('yearBuilt'), '1913');
  check('E7 Waterbury: gated ARV blank', scE7.val('arv'), '');
  check('E7 Waterbury: status names candidate', scE7.el('lookupStatus').textContent.includes('candidate $495,000'), true);
  check('E7 Waterbury: status names source', scE7.el('lookupStatus').textContent.includes('via PropertyReach'), true);
  check('E7 Waterbury: no stale MAO $96,000', scE7.html('prepOut').includes('$96,000'), false);
  check('E7 Waterbury: no stale MAO $80,000', scE7.html('prepOut').includes('$80,000'), false);
  check('E7 Waterbury: card shows candidate note', scE7.html('prepOut').includes('ARV candidate $495,000'), true);
  // Back to Gatlin — via tab-out (change), not the button.
  scE7.el('address').value = '705 McDowell St, Greenville, NC 27834';
  scE7.change('address');
  check('E7 blank-before-result 2: city blank', scE7.val('city'), '');
  check('E7 blank-before-result 2: ARV blank', scE7.val('arv'), '');
  await new Promise(r => setTimeout(r, 200));
  check('E7 Gatlin: city Greenville', scE7.val('city'), 'Greenville');
  check('E7 Gatlin: state NC', scE7.val('state'), 'NC');
  check('E7 Gatlin: zip 27834', scE7.val('zip'), '27834');
  check('E7 Gatlin: owner WILLARD D GATLIN', scE7.val('ownerName'), 'WILLARD D GATLIN');
  check('E7 Gatlin: ARV 154167', scE7.val('arv'), '154167');
  check('E7 Gatlin: status ARV + source', scE7.el('lookupStatus').textContent.includes('ARV $154,167 via PropertyReach'), true);
  check('E7 Gatlin: card MAO $99,334', scE7.html('prepOut').includes('$99,334'), true);
  check('E7 Gatlin: card LAO $69,534', scE7.html('prepOut').includes('$69,534'), true);
  check('E7 Gatlin: card lists picked comps', scE7.html('prepOut').includes('405 Greenview Dr') && scE7.html('prepOut').includes('503 Pittman Dr'), true);

  // DOM E8: a hand-typed ARV for THIS address is never overwritten by the
  // feed on a same-address re-lookup — the status must say so.
  const scE8 = runLiveCallScenario({ draft: gatlinDraft, search: '', store: [], fetchStub: lookupFetchByAddress({ waterbury: waterburyPR, gatlin: gatlinPR }) });
  scE8.click('lookupBtn');
  await new Promise(r => setTimeout(r, 200));
  check('E8 hand-typed ARV kept: stays 150000', scE8.val('arv'), '150000');
  check('E8 hand-typed ARV kept: owner still fills', scE8.val('ownerName'), 'WILLARD D GATLIN');
  check('E8 hand-typed ARV kept: status says kept', scE8.el('lookupStatus').textContent.includes('kept your $150,000'), true);
  check('E8 hand-typed ARV kept: card MAO $96,000', scE8.html('prepOut').includes('$96,000'), true);

  // DOM E9: an ARV the LOOKUP wrote is lookup-owned — a second same-address
  // lookup with a different feed ARV overwrites it. Typing in the field
  // re-asserts hand-typed status, and the next lookup keeps the typed value.
  let e9Calls = 0;
  const e9Fetch = async (url) => {
    const u = String(url);
    if (u.indexOf('attom-lookup') !== -1) return { ok: true, json: async () => ({ matched: false }) };
    e9Calls++;
    return { ok: true, json: async () => (e9Calls === 1 ? gatlinPR : gatlinPR179) };
  };
  const scE9 = runLiveCallScenario({ draft: null, search: '', store: [], fetchStub: e9Fetch });
  scE9.el('address').value = '705 McDowell St, Greenville, NC 27834';
  scE9.click('lookupBtn');
  await new Promise(r => setTimeout(r, 200));
  check('E9 lookup-owned ARV: first 154167', scE9.val('arv'), '154167');
  scE9.click('lookupBtn');
  await new Promise(r => setTimeout(r, 200));
  check('E9 lookup-owned ARV: overwritten 179167', scE9.val('arv'), '179167');
  check('E9 lookup-owned ARV: status 179,167', scE9.el('lookupStatus').textContent.includes('ARV $179,167'), true);
  scE9.el('arv').value = '160000';
  scE9.input('arv');
  scE9.click('lookupBtn');
  await new Promise(r => setTimeout(r, 200));
  check('E9 typed ARV re-asserted: stays 160000', scE9.val('arv'), '160000');
  check('E9 typed ARV re-asserted: status says kept', scE9.el('lookupStatus').textContent.includes('kept your $160,000'), true);

  // DOM E10: the Listed checkbox is address-dependent (Troy Nov 6: the
  // check must reflect the house on screen). A checked box unchecks the
  // moment the address changes — before the new lookup returns — and a
  // not-listed result leaves it unchecked.
  const scE10 = runLiveCallScenario({ draft: gatlinDraft, search: '', store: [], fetchStub: lookupFetchByAddress({ waterbury: waterburyPR, gatlin: gatlinPR }) });
  scE10.el('listed').checked = true; // Troy checked it for Gatlin (or a listed record did).
  scE10.el('address').value = '229 Plaza Ave, Waterbury, CT 06710';
  scE10.change('address');
  check('E10 address change: listed unchecks before result', scE10.val('listed'), false);
  await new Promise(r => setTimeout(r, 200));
  check('E10 not-listed result: listed stays unchecked', scE10.val('listed'), false);
  check('E10 not-listed result: owner still fills', scE10.val('ownerName'), 'ANSON GRAY');

  // DOM E11: the lookup still only ADDS the PASS — a listed result for the
  // NEW address re-checks the box the address change just cleared.
  const waterburyPRListed = Object.assign({}, waterburyPR, {
    property: Object.assign({}, waterburyPR.property, { onMarket: true, listingStatus: 'listed' }),
  });
  const scE11 = runLiveCallScenario({ draft: gatlinDraft, search: '', store: [], fetchStub: lookupFetchByAddress({ waterbury: waterburyPRListed, gatlin: gatlinPR }) });
  scE11.el('listed').checked = true; // checked for Gatlin; the new address must clear it first.
  scE11.el('address').value = '229 Plaza Ave, Waterbury, CT 06710';
  scE11.change('address');
  check('E11 address change: listed unchecks before result', scE11.val('listed'), false);
  await new Promise(r => setTimeout(r, 200));
  check('E11 listed result: listed re-checks', scE11.val('listed'), true);
  check('E11 listed result: status says LISTED', scE11.el('lookupStatus').textContent.includes('LISTED'), true);
  check('E11 listed result: PASS banner', scE11.html('prepOut').includes('LISTED WITH A REALTOR — PASS'), true);
}

(async function () {
  await section8();
  await section12();
  await section13();
  section14();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// ---- 14. Comp-pick determinism: the same comp set must yield the same
// best-3 regardless of upstream row order. A score tie at the cutoff used
// to flip the pick (Nov 6: same Gatlin address, ARV $179,167 live vs
// $154,167 in the morning). Both server engines now break ties by amount,
// then address. Fixtures only — no live calls.
// Tie design (subject 1,000 sqft / 3 beds, Nov 6 2026): C is clearly best;
// X, Y, Z tie exactly on score, so without a tie-breaker the input order
// decides which two of the three make the cut — and the mean moves.
const DataApi = require('./netlify/functions/data-api.js');
const AttomLookup = require('./netlify/functions/attom-lookup.js');
const tieSubject = { sqft: 1000, beds: 3, propertyType: 'Single Family Residence' };
const tieToday = { y: 2026, mo: 11, d: 6 };
function tieComps() {
  return [
    { address: '1 C St', amount: 190000, distance: 0.2, date: '2026-10-01', dateParts: { y: 2026, mo: 10, d: 1 }, sqft: 1000, beds: 3, arms: 'A', onMarket: false },
    { address: '2 X St', amount: 200000, distance: 0.5, date: '2026-09-01', dateParts: { y: 2026, mo: 9, d: 1 }, sqft: 1000, beds: 3, arms: 'A', onMarket: false },
    { address: '3 Y St', amount: 210000, distance: 0.5, date: '2026-09-01', dateParts: { y: 2026, mo: 9, d: 1 }, sqft: 1000, beds: 3, arms: 'A', onMarket: false },
    { address: '4 Z St', amount: 220000, distance: 0.5, date: '2026-09-01', dateParts: { y: 2026, mo: 9, d: 1 }, sqft: 1000, beds: 3, arms: 'A', onMarket: false },
  ];
}
function section14() {
  console.log('Comp-pick determinism:');
  for (const [name, mod] of [['data-api', DataApi], ['attom-lookup', AttomLookup]]) {
    const fwd = mod._test.analyzeComps(tieSubject, tieComps(), tieToday);
    const rev = mod._test.analyzeComps(tieSubject, tieComps().reverse(), tieToday);
    check(name + ': tie scores equal', fwd.best.map(c => c.score), rev.best.map(c => c.score));
    check(name + ': same best-3 in both orders', fwd.best.map(c => c.address), ['1 C St', '2 X St', '3 Y St']);
    check(name + ': reversed best-3 identical', rev.best.map(c => c.address), ['1 C St', '2 X St', '3 Y St']);
    check(name + ': same indication both orders', [fwd.indication, rev.indication], [200000, 200000]);
    check(name + ': confidence HIGH', fwd.confidence, 'HIGH');
  }
}

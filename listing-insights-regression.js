// listing-insights-regression.js — verification for the Listing Insights
// panel + property detail view (Nov 9, 2026).
// Run: node listing-insights-regression.js
// Fixtures only — zero live API credits, zero network. Expected values are
// hand-computed in the comments from the 3326 W Michigan St XLeads page
// (read Nov 9, 8:37 PM). Exits 1 on any failure.
const LI = require('./assets/listing-insights.js');
const PDV = require('./assets/property-detail-view.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function contains(name, html, needle) {
  const ok = String(html).indexOf(needle) !== -1;
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' — missing ' + JSON.stringify(needle)); }
}

// ---- 1. Module shape ----
console.log('Module shape:');
check('ListingInsights exports isPassStatus', typeof LI.isPassStatus, 'function');
check('ListingInsights exports panelHtml', typeof LI.panelHtml, 'function');
check('PropertyDetailView exports detailViewHtml', typeof PDV.detailViewHtml, 'function');
check('PropertyDetailView exports carouselHtml', typeof PDV.carouselHtml, 'function');

// ---- 2. Status set + gate ----
console.log('Status gate:');
check('active passes', LI.isPassStatus('active'), true);
check('pending passes', LI.isPassStatus('pending'), true);
check('sold passes', LI.isPassStatus('sold'), true);
check('expired does NOT pass', LI.isPassStatus('expired'), false);
check('withdrawn does NOT pass', LI.isPassStatus('withdrawn'), false);
check('inactive does NOT pass', LI.isPassStatus('inactive'), false);
check('not-listed does NOT pass', LI.isPassStatus('not-listed'), false);
check('blank does NOT pass', LI.isPassStatus(''), false);
check('legacy listed passes', LI.isPassStatus('listed'), true);
check('pass reason active', LI.passReason('active'), 'Listed with a realtor');
check('pass reason pending', LI.passReason('pending'), 'Under contract');
check('pass reason sold', LI.passReason('sold'), 'Already sold');
check('status label expired', LI.statusLabel('expired'), '⚠️ Expired — no live listing');
check('status label not-listed', LI.statusLabel('not-listed'), '✓ Not listed — clear to comp');
check('status date label expired', LI.statusDateLabel('expired'), 'Expired date');
check('status date label active', LI.statusDateLabel('active'), 'Listed date');
check('status date label sold', LI.statusDateLabel('sold'), 'Sold date');

// ---- 3. Math ----
console.log('Math:');
check('ppsf 152400/1822 = 84', LI.ppsf(152400, 1822), 84);
check('ppsf missing sqft -> null', LI.ppsf(152400, 0), null);
check('aboveBelow 152400 vs 151465', LI.aboveBelow(152400, 151465).text, '+$935 (0% above value)');
check('aboveBelow 152400 vs 167500', LI.aboveBelow(152400, 167500).text, '−$15,100 (9% below value)');
check('aboveBelow missing ref -> null', LI.aboveBelow(152400, 0), null);

// ---- 4. Listing Insights panel: Charday EXPIRED (XLeads page values) ----
console.log('Panel: Charday EXPIRED:');
const chardayListing = {
  status: 'expired', price: 152400, sqft: 1822,
  listedDate: '', statusDate: '2026-11-01', dom: '',
  agent: 'Anthony Burris', agentPhone: '317-657-0923', agentEmail: 'rrealtyinvestments@gmail.com',
  office: 'Resilient Realty Investments', type: 'Single Family', mls: '406063160',
  description: '3 bed, 2 bath home on a fully fenced lot.',
  arv: 167500, avm: 151465
};
const chardayHtml = LI.panelHtml(chardayListing);
contains('expired status label', chardayHtml, 'Expired — no live listing');
contains('price + $/sqft', chardayHtml, '$152,400 ($84/sqft)');
contains('status change date 11/01/2026', chardayHtml, '11/01/2026');
contains('above/below vs AVM', chardayHtml, '+$935 (0% above value) vs AVM');
contains('MLS#', chardayHtml, '406063160');
contains('type', chardayHtml, 'Single Family');
contains('agent', chardayHtml, 'Anthony Burris');
contains('agent phone', chardayHtml, '317-657-0923');
contains('agent email', chardayHtml, 'rrealtyinvestments@gmail.com');
contains('office', chardayHtml, 'Resilient Realty Investments');
contains('description', chardayHtml, '3 bed, 2 bath home on a fully fenced lot.');
contains('no PASS on expired panel', chardayHtml.indexOf('PASS') === -1, true);
check('expired is not a pass', LI.isPassStatus(chardayListing.status), false);

// ---- 5. Listing Insights panel: ACTIVE triggers PASS ----
console.log('Panel: ACTIVE:');
const activeHtml = LI.panelHtml({
  status: 'active', price: 200000, sqft: 2000, listedDate: '2026-10-15',
  statusDate: '', dom: '12', agent: 'Jane Agent', agentPhone: '', agentEmail: '',
  office: '', type: 'Single Family', mls: '', description: '', arv: 0, avm: 190000
});
contains('active status label', activeHtml, 'Active — listed with a realtor — PASS');
contains('active price + $/sqft', activeHtml, '$200,000 ($100/sqft)');
contains('active above/below', activeHtml, '+$10,000 (5% above value) vs AVM');
check('active is a pass', LI.isPassStatus('active'), true);

// ---- 6. Listing Insights panel: no data shows dashes, never invented ----
console.log('Panel: empty:');
const emptyHtml = LI.panelHtml({});
contains('empty status', emptyHtml, 'Not checked yet');
contains('empty price dash', emptyHtml, 'Listing Price');
check('empty panel has dashes', (emptyHtml.match(/—/g) || []).length >= 5, true);

// ---- 7. Property detail view: Charday fixture ----
console.log('Detail view: Charday:');
const chardayView = {
  address: '3326 W Michigan St', city: 'Indianapolis', state: 'IN', zip: '46222', county: 'Marion County',
  beds: 4, baths: 1, sqft: 1822, units: 1, type: 'Single Family', yearBuilt: 1905,
  lotSqft: 6011, condition: 'Average',
  owner: 'Charday Cooke Fowler', ownerMailing: '3326 W Michigan St, Indianapolis, IN 46222',
  ownerPhones: [
    { label: 'Mobile', number: '(317) 966-3450', dnc: false },
    { label: 'Residential', number: '(317) 555-0100', dnc: true }
  ],
  ownerEmail: 'ccookefowler@gmail.com',
  photos: [
    { src: 'https://example.com/photo1.jpg', label: 'Property photo' },
    { src: 'https://example.com/sv0.jpg', label: 'Street View — front' },
    { src: 'https://example.com/sv90.jpg', label: 'Street View — right' },
    { src: 'https://example.com/sv180.jpg', label: 'Street View — back' },
    { src: 'https://example.com/sv270.jpg', label: 'Street View — left' }
  ],
  zillowUrl: 'https://www.zillow.com/homes/3326-W-Michigan-St-Indianapolis-IN-46222_rb/',
  listing: chardayListing,
  avm: { value: 151465, low: 135000, high: 200000, score: 89, source: 'Property records', date: '2026-11-09' },
  countyValue: 162100, tax: 2227, taxYear: 2024, rent: 1406,
  mortgage: { freeClear: false, amount: 147283, lender: 'Fairway Independent', loanType: 'FHA 30-yr fixed', termMonths: 360, recordedDate: '2022-01-12', dueDate: null },
  lastSale: { date: '2021-04-21', amount: 135000, seller: 'Sarah E. Freeman & Brian J. Freeman', buyer: 'Charday Cooke', deedType: 'Warranty Deed' },
  saleHistory: [
    { date: '2021-04-21', amount: 135000, deedType: 'Warranty Deed', seller: 'Sarah E. Freeman & Brian J. Freeman', buyer: 'Charday Cooke' },
    { date: '2020-11-23', amount: 27500, deedType: '—', seller: '', buyer: '' },
    { date: '1969-06-06', amount: 11700, deedType: '—', seller: '', buyer: '' }
  ],
  linkedProperties: [],
  sellability: { score: 515, label: 'WARM', reasons: ['Expired listing — did not sell at $152,400', 'FHA mortgage — payoff near MAO'] },
  distress: { preForeclosure: false, detail: '' },
  listingHistory: {
    before: { price: 135000, date: '2021-04-21', dom: '69', beds: 3, baths: 1, description: '3 bed, 1 bath home.' },
    after: { price: 152400, date: '', dom: '', beds: 3, baths: 2, description: '3 bed, 2 bath home on a fully fenced lot.', mls: '406063160', agent: 'Anthony Burris' }
  }
};
const viewHtml = PDV.detailViewHtml(chardayView);
contains('header address', viewHtml, '3326 W Michigan St');
contains('header city/state/zip + county', viewHtml, 'Indianapolis, IN 46222 · Marion County');
contains('header facts line', viewHtml, '4 bed · 1 bath · 1,822 sqft · 1 unit · Single Family');
contains('owner name', viewHtml, 'Charday Cooke Fowler');
contains('owner mobile', viewHtml, '(317) 966-3450');
contains('DNC badge on residential phone', viewHtml, 'DO NOT CALL');
contains('owner email', viewHtml, 'ccookefowler@gmail.com');
contains('carousel photo count', viewHtml, '5 photos');
contains('zillow photo link', viewHtml, 'Full listing photos');
contains('Deal AI banner', viewHtml, 'Deal AI');
contains('sellability score', viewHtml, '515/1000');
contains('Add to My Leads button', viewHtml, 'Add to My Leads');
contains('Target Match AI button', viewHtml, 'Target Match AI');
contains('Buyer Match AI button', viewHtml, 'Buyer Match AI');
contains('Google Results button', viewHtml, 'Google Results');
contains('Post My Deal button', viewHtml, 'Post My Deal');
contains('Collapse All button', viewHtml, 'Collapse All');
// Section order: Overview -> Listing Insights -> Deal Insights -> Owner
// Insights -> Before & After -> Property Insights -> Financial Insights ->
// Building Insights -> Construction & Materials -> Loans -> Transactions ->
// Pre-Foreclosures.
const titles = ['Overview', 'Listing Insights', 'Deal Insights', 'Owner Insights',
  'Before &amp; After', 'Property Insights', 'Financial Insights', 'Building Insights',
  'Construction &amp; Materials', 'Loans', 'Transactions', 'Pre-Foreclosures'];
let lastIdx = -1, orderOk = true;
titles.forEach(function (t) {
  const i = viewHtml.indexOf('>' + t + '<');
  if (i === -1 || i < lastIdx) orderOk = false;
  lastIdx = Math.max(lastIdx, i);
});
check('12 sections in XLeads order', orderOk, true);
contains('before $135,000', viewHtml, '$135,000');
contains('before 69 DOM', viewHtml, '69 days on market');
contains('after $152,400', viewHtml, '$152,400');
contains('transaction 2021 row', viewHtml, '04/21/2021');
contains('transaction $74/sqft', viewHtml, '$74/sqft');
contains('transaction deed', viewHtml, 'Warranty Deed');
contains('transaction seller', viewHtml, 'Sarah E. Freeman');
contains('transaction 2020 $15/sqft', viewHtml, '$15/sqft');
contains('transaction 1969 $6/sqft', viewHtml, '$6/sqft');
contains('financial value avg AVM+County', viewHtml, '$156,782');
contains('financial AVM', viewHtml, '$151,465');
contains('financial county', viewHtml, '$162,100');
contains('financial rent', viewHtml, '$1,406');
contains('financial tax', viewHtml, '$2,227 (2024)');
contains('mortgage lender', viewHtml, 'Fairway Independent');
contains('mortgage amount', viewHtml, '$147,283');
contains('years owned chip present', viewHtml, 'Years Owned');
contains('no pre-foreclosure', viewHtml, 'No pre-foreclosure on record');
check('no XLeads branding', viewHtml.indexOf('XLeads'), -1);
check('no DealMachine branding', viewHtml.indexOf('DealMachine'), -1);

// ---- 8. Detail view: empty view renders dashes, never crashes ----
console.log('Detail view: empty:');
const emptyViewHtml = PDV.detailViewHtml({});
check('empty view renders', typeof emptyViewHtml, 'string');
check('empty view has dashes', (emptyViewHtml.match(/—/g) || []).length >= 5, true);
contains('empty view still has sections', emptyViewHtml, 'Listing Insights');
contains('empty carousel fallback', PDV.carouselHtml([]), 'No property photo available');

// ---- 9. Detail view: free & clear loan ----
console.log('Detail view: free & clear:');
const fcHtml = PDV.detailViewHtml(Object.assign({}, chardayView, { mortgage: { freeClear: true } }));
contains('free & clear loans section', fcHtml, 'Free &amp; Clear');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/*
 * List Builder One-Click Recipes regression — added Nov 13 at Troy's
 * delegation ("you're the one that runs the system... if you think that's
 * something we need then do it"). Modeled on DealBreeze's Lead Finder
 * (stackable named filters) but grounded ONLY in fields the List Builder's
 * data path (data-search -> PropertyReach /v1/search) verifiably carries.
 *
 * Pins:
 *  - recipe predicates extract cleanly from index.html and run
 *  - Tired Landlord = absentee AND lastSaleDate 10+ years ago; a missing
 *    or unparseable sale date FAILS (unverifiable is never a match)
 *  - Tax Lien / Pre-Foreclosure match on the exact stamp conventions
 *    prRunListSearch writes (taxDelinquentYear / preforeclosure)
 *  - county-lane recipes (codeViolation / waterShutoff / probate) are
 *    unavailable on this data path: they never match, contribute no
 *    server filter, and their buttons render disabled with the honest
 *    county-lane note — no fake counts
 *  - AND stack: stacked count = true intersection of all armed recipes
 *  - server filters merge into the SAME one search call (no extra calls)
 *  - wiring: buttons + preview live in the List Builder page; the
 *    delegated toggle handler covers BOTH .lb-recipe and .lb-chip
 *    (the manual chips had NO handler before this change — dead UI)
 *  - $0 rule: the recipe logic makes no fetch / API calls of its own
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/* --- extract + eval the pure recipe functions verbatim from index.html --- */
const names = ['lbRecipeDefs', 'lbYearsOwned', 'lbIsAbsentee', 'lbMatchTiredLandlord',
  'lbMatchTaxLien', 'lbMatchPreForeclosure', 'lbMatchRecipe', 'lbMatchAllRecipes',
  'lbRecipeCounts', 'lbRecipeServerFilter', 'lbRecipeSignals'];
const fns = {};
for (const n of names) {
  const i = scripts.indexOf('function ' + n + '(');
  if (i < 0) { fns[n] = null; continue; }
  let depth = 0, j = scripts.indexOf('{', i);
  do { if (scripts[j] === '{') depth++; else if (scripts[j] === '}') depth--; j++; } while (depth > 0 && j < scripts.length);
  fns[n] = scripts.slice(i, j);
}
check('all 11 recipe functions found in index.html', names.every(n => fns[n]),
  names.filter(n => !fns[n]).join(','));
const ctx = {};
if (names.every(n => fns[n])) {
  const factory = new Function(names.map(n => fns[n]).join('\n') + '\nreturn { ' + names.join(', ') + ' };');
  Object.assign(ctx, factory());
}
const { lbRecipeDefs, lbYearsOwned, lbMatchTiredLandlord, lbMatchTaxLien,
  lbMatchPreForeclosure, lbMatchRecipe, lbMatchAllRecipes, lbRecipeCounts,
  lbRecipeServerFilter, lbRecipeSignals } = ctx;

const NOW = Date.parse('2026-11-13T12:00:00Z');

/* --- fixtures: records in the data-search projection shape, with the
       stamp fields prRunListSearch writes (absenteeOwner 'Yes',
       ownerOccupied false, preforeclosure 'Yes', taxDelinquentYear 'Yes') --- */
const A = { address: '1 A St', city: 'Indianapolis', state: 'IN', zip: '46201', lastSaleDate: '2011-04-02', lastSaleAmount: 40000, absenteeOwner: 'Yes', ownerOccupied: false, taxDelinquentYear: 'Yes', preforeclosure: 'Yes' };
const B = { address: '2 B St', city: 'Indianapolis', state: 'IN', zip: '46201', lastSaleDate: '2021-03-01', lastSaleAmount: 90000, absenteeOwner: 'Yes', ownerOccupied: false, taxDelinquentYear: 'Yes' };
const C = { address: '3 C St', city: 'Greenville', state: 'NC', zip: '27834', lastSaleDate: null, lastSaleAmount: null, absenteeOwner: 'Yes', ownerOccupied: false, preforeclosure: 'Yes' };
const D = { address: '4 D St', city: 'Kansas City', state: 'MO', zip: '64127', lastSaleDate: '2005-01-15', lastSaleAmount: 30000, ownerOccupied: true, taxDelinquentYear: 'Yes', preforeclosure: 'Yes' };
const E = { address: '5 E St', city: 'Cleveland', state: 'OH', zip: '44101', lastSaleDate: '2016-11-13', lastSaleAmount: 55000, absenteeOwner: true };
const F = { address: '6 F St', city: 'Dayton', state: 'OH', zip: '45402', lastSaleDate: '2024-06-01', lastSaleAmount: 120000, ownerOccupied: true };
const ALL = [A, B, C, D, E, F];

/* --- years owned --- */
check('yearsOwned: 2011 sale is 15+ years at Nov 2026', lbYearsOwned && lbYearsOwned('2011-04-02', NOW) > 15);
check('yearsOwned: null date -> null (unverifiable)', lbYearsOwned && lbYearsOwned(null, NOW) === null);
check('yearsOwned: garbage date -> null', lbYearsOwned && lbYearsOwned('not-a-date', NOW) === null);

/* --- Tired Landlord: absentee AND 10+ years, nothing less --- */
check('tired: absentee + 2011 sale matches', lbMatchTiredLandlord && lbMatchTiredLandlord(A, NOW) === true);
check('tired: absentee + 2021 sale does NOT match (under 10 yrs)', lbMatchTiredLandlord && lbMatchTiredLandlord(B, NOW) === false);
check('tired: absentee + NO sale date does NOT match (unverifiable)', lbMatchTiredLandlord && lbMatchTiredLandlord(C, NOW) === false);
check('tired: owner-occupied + old sale does NOT match', lbMatchTiredLandlord && lbMatchTiredLandlord(D, NOW) === false);
check('tired: boolean absentee + exactly 10 yrs matches', lbMatchTiredLandlord && lbMatchTiredLandlord(E, NOW) === true);
check('tired: plain recent owner-occupied matches nothing', lbMatchTiredLandlord && lbMatchTiredLandlord(F, NOW) === false);

/* --- Tax Lien / Pre-Foreclosure stamp conventions --- */
check('tax: taxDelinquentYear Yes matches', lbMatchTaxLien && lbMatchTaxLien(A) === true);
check('tax: boolean taxDelinquent matches', lbMatchTaxLien && lbMatchTaxLien({ taxDelinquent: true }) === true);
check('tax: no stamp -> no match', lbMatchTaxLien && lbMatchTaxLien(E) === false);
check('prefc: preforeclosure Yes matches', lbMatchPreForeclosure && lbMatchPreForeclosure(C) === true);
check('prefc: no stamp -> no match', lbMatchPreForeclosure && lbMatchPreForeclosure(B) === false);

/* --- county-lane recipes: unavailable means unavailable --- */
const defs = lbRecipeDefs ? lbRecipeDefs() : {};
check('defs: exactly the 6 recipes exist', Object.keys(defs).length === 6);
check('defs: 3 search recipes available', ['tiredLandlord', 'taxLien', 'preForeclosure'].every(k => defs[k] && defs[k].available === true));
check('defs: 3 county-lane recipes unavailable', ['codeViolation', 'waterShutoff', 'probate'].every(k => defs[k] && defs[k].available === false));
check('county-lane recipes never match any record',
  lbMatchRecipe && ['codeViolation', 'waterShutoff', 'probate'].every(k => lbMatchRecipe(k, A, NOW) === false && lbMatchRecipe(k, F, NOW) === false));
check('signals: county-lane keys produce no lead signals',
  lbRecipeSignals && lbRecipeSignals(['codeViolation', 'probate']).length === 0 &&
  lbRecipeSignals(['tiredLandlord', 'taxLien']).join('|') === 'Tired Landlord|Tax Lien');

/* --- server filter merge (the ONE search call) --- */
const sf = lbRecipeServerFilter ? lbRecipeServerFilter(['tiredLandlord', 'taxLien', 'preForeclosure']) : {};
check('server filter: all 3 merged', sf.absenteeOwner === true && sf.taxDelinquent === true && sf.preForeclosure === true && Object.keys(sf).length === 3);
check('server filter: county-lane keys contribute nothing',
  lbRecipeServerFilter && Object.keys(lbRecipeServerFilter(['codeViolation', 'waterShutoff', 'probate'])).length === 0);
check('server filter: none armed -> empty', lbRecipeServerFilter && Object.keys(lbRecipeServerFilter([])).length === 0);

/* --- AND-stack counts (the live count math) --- */
const counts = lbRecipeCounts ? lbRecipeCounts(ALL, ['tiredLandlord', 'taxLien', 'preForeclosure'], NOW) : null;
check('counts: total is the record count', counts && counts.total === 6);
check('counts: per-recipe tired = 2 (A, E)', counts && counts.per.tiredLandlord === 2, counts && String(counts.per.tiredLandlord));
check('counts: per-recipe tax = 3 (A, B, D)', counts && counts.per.taxLien === 3);
check('counts: per-recipe prefc = 3 (A, C, D)', counts && counts.per.preForeclosure === 3);
check('counts: stacked AND of 3 = 1 (only A)', counts && counts.stacked === 1);
const counts2 = lbRecipeCounts ? lbRecipeCounts(ALL, ['tiredLandlord', 'taxLien'], NOW) : null;
check('counts: stacked AND of 2 = 1 (only A)', counts2 && counts2.stacked === 1);
const counts0 = lbRecipeCounts ? lbRecipeCounts(ALL, [], NOW) : null;
check('counts: no recipes armed -> stacked 0, never the total', counts0 && counts0.stacked === 0);
check('matchAll: record matching every armed recipe passes',
  lbMatchAllRecipes && lbMatchAllRecipes(A, ['tiredLandlord', 'taxLien', 'preForeclosure'], NOW) === true);
check('matchAll: partial match fails the stack',
  lbMatchAllRecipes && lbMatchAllRecipes(D, ['tiredLandlord', 'taxLien'], NOW) === false);

/* --- wiring in the page --- */
check('recipes section exists (id=lbRecipes)', html.indexOf('id="lbRecipes"') > 0);
check('all 6 recipe buttons render', ['tiredLandlord', 'taxLien', 'preForeclosure', 'codeViolation', 'waterShutoff', 'probate'].every(k => html.indexOf('data-r="' + k + '"') > 0));
check('county-lane buttons are disabled in the markup',
  ['codeViolation', 'waterShutoff', 'probate'].every(k => new RegExp('data-r="' + k + '" disabled').test(html)));
check('county-lane tag shows on the disabled buttons', (html.match(/lb-lane/g) || []).length >= 3);
check('honest note: no fake counts for county-lane data', html.indexOf('no button here faking a count') > 0);
check('count preview element exists (id=lbRecipePreview)', html.indexOf('id="lbRecipePreview"') > 0);
check('preview copy admits there is no free count', scripts.indexOf('no free count') > 0);
check('search filters merge armed recipes (one call)', scripts.indexOf('lbRecipeServerFilter(lbArmedRecipes())') > 0);
check('search run computes live recipe counts', scripts.indexOf('lbRecipeCounts(lbSearchCache, armedRecipes, Date.now())') > 0);
check('search run intersects the stack (AND)', scripts.indexOf('lbMatchAllRecipes(p, armedRecipes, Date.now())') > 0);
check('status line carries the recipe stack result', scripts.indexOf('lbRecipeStatusHtml()') > 0);
check('toggle wiring covers recipe buttons', scripts.indexOf("closest('.lb-recipe')") > 0);
check('toggle wiring also fixes the manual chips', scripts.indexOf("closest('.lb-chip')") > 0);
check('recipe CSS present in both themes', (html.match(/\.lb-recipe\.active/g) || []).length >= 2);

/* --- $0 rule: recipe logic calls nothing --- */
check('recipe functions make no fetch / API calls',
  names.every(n => !/fetch\(|netlify\/functions|api\.propertyreach|apiKey/i.test(fns[n] || '')));

console.log('list-builder-regression: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

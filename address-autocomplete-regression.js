// Regression tests for the address type-ahead (Troy, Nov 22, 2026):
// Quick Offer field + AI assistant input prompt the full address
// (street, city, state, zip) from the first few typed characters.
// Suggestion source is FREE and keyless (ArcGIS suggest via
// netlify/functions/address-suggest.js) — never PropertyReach
// credits, never Realie tokens.
// Run: node address-autocomplete-regression.js (exit non-zero on failure)
'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
let total = 0;
function check(name, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}\n  got      ${JSON.stringify(got)}\n  expected ${JSON.stringify(expected)}`);
  }
}
function checkTrue(name, cond) { check(name, !!cond, true); }

/* ---------- 1. address-suggest function: parsing ---------- */
const fn = require('./netlify/functions/address-suggest.js');
const t = fn._test;

check('parse full address', t.parseSuggestionText('1329 Lamar St, Dayton, OH, 45404, USA'),
  { streetAddress: '1329 Lamar St', city: 'Dayton', state: 'OH', zip: '45404' });
check('parse ZIP+4 trims to 5', t.parseSuggestionText('3051 Eastern Ave, Indianapolis, IN, 46218-1234, USA'),
  { streetAddress: '3051 Eastern Ave', city: 'Indianapolis', state: 'IN', zip: '46218' });
check('parse no zip', t.parseSuggestionText('4405 E Edgewood Ave, Indianapolis, IN, USA'),
  { streetAddress: '4405 E Edgewood Ave', city: 'Indianapolis', state: 'IN', zip: '' });
check('buildLabel joins with zip', t.buildLabel({ streetAddress: '1329 Lamar St', city: 'Dayton', state: 'OH', zip: '45404' }),
  '1329 Lamar St, Dayton, OH 45404');
checkTrue('suggest URL is the free keyless endpoint', t.buildSuggestUrl('1329 Lam', null)
  .indexOf('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?f=json&countryCode=US') === 0);
checkTrue('suggest URL carries NO api key', !/key|token/i.test(t.buildSuggestUrl('1329 Lam', null)));
check('seven market biases', t.MARKETS.length, 7);

/* ---------- 2. ranking: dedupe, filter noise, local match first ---------- */
const ranked = t.rankSuggestions([
  { text: 'Lamar St, Dayton, OH, USA', isCollection: false, biased: true },              // street-only: filtered
  { text: 'Dayton, OH, USA', isCollection: true, biased: true },                          // collection: filtered
  { text: '1329 Lamanche St, New Orleans, LA, 70117, USA', isCollection: false, biased: false },
  { text: '1329 Lamar St, Dayton, OH, 45404, USA', isCollection: false, biased: true },
  { text: '1329 Lamar St, Dayton, OH, 45404, USA', isCollection: false, biased: false },  // dupe
  { text: '1329 Lammers Pike, Batesville, IN, 47006, USA', isCollection: false, biased: true },
], '1329 Lam');
check('ranked count after filter+dedupe', ranked.length, 3);
check('Dayton Lamar St ranks first', ranked[0] && ranked[0].label, '1329 Lamar St, Dayton, OH 45404');
check('ranked entry carries zip', ranked[0] && ranked[0].zip, '45404');

/* ---------- 3. handler: well-formed output + fail-soft ---------- */
(async () => {
  let upstreamCalls = 0;
  t.setFetchJson(async (url) => {
    upstreamCalls++;
    if (url.indexOf('location=-84.1916,39.7589') >= 0) { // Dayton bias
      return { suggestions: [
        { text: '1329 Lamar St, Dayton, OH, 45404, USA', isCollection: false },
        { text: '1329 Lamplighter Ln, Fairborn, OH, 45324, USA', isCollection: false },
      ] };
    }
    if (url.indexOf('location=-86.1581,39.7684') >= 0) { // Indianapolis bias
      return { suggestions: [{ text: '1329 Lammers Pike, Batesville, IN, 47006, USA', isCollection: false }] };
    }
    return { suggestions: [{ text: '1329 Lamanche St, New Orleans, LA, 70117, USA', isCollection: false }] };
  });
  const res = await fn.handler({ httpMethod: 'GET', queryStringParameters: { q: '1329 Lam' } });
  check('handler status', res.statusCode, 200);
  const body = JSON.parse(res.body);
  checkTrue('handler returns suggestions array', Array.isArray(body.suggestions));
  const dayton = body.suggestions.find((s) => s.label === '1329 Lamar St, Dayton, OH 45404');
  checkTrue('handler surfaces the Dayton address for "1329 Lam"', !!dayton);
  check('Dayton entry zip', dayton && dayton.zip, '45404');
  checkTrue('handler fanned out to markets + unbiased', upstreamCalls >= 8);

  const res2 = await fn.handler({ httpMethod: 'GET', queryStringParameters: { q: '1329 Lamar St' } });
  const body2 = JSON.parse(res2.body);
  check('with street type typed, Dayton Lamar St is #1', body2.suggestions[0] && body2.suggestions[0].label, '1329 Lamar St, Dayton, OH 45404');

  const callsBefore = upstreamCalls;
  const short = await fn.handler({ httpMethod: 'GET', queryStringParameters: { q: 'ab' } });
  check('short query returns empty', JSON.parse(short.body).suggestions, []);
  check('short query never calls upstream', upstreamCalls, callsBefore);

  t.setFetchJson(async () => { throw new Error('upstream down'); });
  const down = await fn.handler({ httpMethod: 'GET', queryStringParameters: { q: '9999 Nowhere' } });
  check('upstream failure still 200', down.statusCode, 200);
  check('upstream failure fails soft to empty', JSON.parse(down.body).suggestions, []);
  t.setFetchJson(null);

  /* ---------- 4. browser widget: pure helpers ---------- */
  const widget = require('./address-autocomplete.js');
  check('widget endpoint', widget.ENDPOINT, '/.netlify/functions/address-suggest');
  check('widget buildLabel', widget.buildLabel({ streetAddress: '3051 Eastern Ave', city: 'Indianapolis', state: 'IN', zip: '46218' }),
    '3051 Eastern Ave, Indianapolis, IN 46218');
  const merged = widget.mergeSuggestions(
    [{ label: '1329 Lamar St, Dayton, OH 45404', streetAddress: '1329 Lamar St', city: 'Dayton', state: 'OH', zip: '45404' }],
    [
      { label: '1329 Lamar St, Dayton, OH 45404', streetAddress: '1329 Lamar St', city: 'Dayton', state: 'OH', zip: '45404' },
      { label: '1329 Lamanche St, New Orleans, LA 70117', streetAddress: '1329 Lamanche St', city: 'New Orleans', state: 'LA', zip: '70117' },
    ], 8);
  check('merge keeps local first + dedupes', merged.map((s) => s.label),
    ['1329 Lamar St, Dayton, OH 45404', '1329 Lamanche St, New Orleans, LA 70117']);
  check('merge marks local source', merged[0].source, 'local');
  const fakeInput = { value: '1329 Lam' };
  widget.fillInput(fakeInput, merged[0]);
  check('selecting fills FULL address incl zip', fakeInput.value, '1329 Lamar St, Dayton, OH 45404');

  /* ---------- 5. wiring: both fields attached, script order ---------- */
  const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const aiJs = fs.readFileSync(path.join(__dirname, 'ai-assistant.js'), 'utf8');
  const widgetJs = fs.readFileSync(path.join(__dirname, 'address-autocomplete.js'), 'utf8');
  const fnJs = fs.readFileSync(path.join(__dirname, 'netlify/functions/address-suggest.js'), 'utf8');

  const acTag = indexHtml.indexOf('<script src="address-autocomplete.js"></script>');
  const aiTag = indexHtml.indexOf('<script src="ai-assistant.js"></script>');
  checkTrue('index.html loads address-autocomplete.js', acTag >= 0);
  checkTrue('autocomplete loads BEFORE ai-assistant.js', acTag >= 0 && aiTag > acTag);
  checkTrue('Quick Offer input still #qoAddr', /<input[^>]*id="qoAddr"/.test(indexHtml));
  checkTrue('index.html attaches autocomplete to #qoAddr',
    indexHtml.indexOf("attachAddressAutocomplete(document.getElementById('qoAddr')") >= 0);
  checkTrue('index.html provides local candidates from leads',
    indexHtml.indexOf('window.ccLocalAddressCandidates') >= 0 && indexHtml.indexOf('addressLine1 || l.address') >= 0);
  checkTrue('ai-assistant.js attaches autocomplete to #aiInput',
    aiJs.indexOf('attachAddressAutocomplete') >= 0 && aiJs.indexOf("getElementById('aiInput')") >= 0);
  checkTrue('widget fetches the free suggest function', widgetJs.indexOf('/.netlify/functions/address-suggest') >= 0);
  checkTrue('widget intercepts keys in capture phase (beats Enter-to-run/send)',
    /addEventListener\('keydown'[\s\S]*?,\s*true\)/.test(widgetJs));
  checkTrue('widget supports mouse selection', widgetJs.indexOf("addEventListener('mousedown'") >= 0);
  checkTrue('widget fills via fillInput on select', widgetJs.indexOf('fillInput(input, item)') >= 0);
  checkTrue('function never calls PropertyReach', fnJs.indexOf('api.propertyreach.com') < 0 && fnJs.indexOf('PROPERTYREACH_API_KEY') < 0);
  checkTrue('function never calls Realie', fnJs.indexOf('REALIE_API_KEY') < 0 && fnJs.indexOf('api.realie') < 0);

  console.log(`${total} checks run`);
  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('ALL address-autocomplete regression tests PASS');
})().catch((e) => { console.log('ERROR', e); process.exit(1); });

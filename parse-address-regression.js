// Regression tests for parseAddress state-grab bug (Nov 5, 2026):
// "4405 E edgewood ave Indianapolis 46237" used to parse as
// street "4405 E edgewood ave Indianapol", state "IS" -> upstream
// property lookup returned no match in Command Center / Comps.
// Run: node parse-address-regression.js (exit non-zero on any failure)
'use strict';

const dataApi = require('./netlify/functions/data-api.js')._test;
const attom = require('./netlify/functions/attom-lookup.js')._test;
const ai = require('./netlify/functions/dashboard-ai.js')._test;

const cases = [
  // [input, expected {street, city, state, zip}]
  ['4405 E edgewood ave Indianapolis 46237', { street: '4405 E edgewood ave', city: 'Indianapolis', state: '', zip: '46237' }],
  ['4405 E Edgewood Ave, Indianapolis, IN 46237', { street: '4405 E Edgewood Ave', city: 'Indianapolis', state: 'IN', zip: '46237' }],
  ['4405 E Edgewood Ave, Indianapolis 46237', { street: '4405 E Edgewood Ave', city: 'Indianapolis', state: '', zip: '46237' }],
  ['4405 E edgewood ave Indianapolis IN 46237', { street: '4405 E edgewood ave', city: 'Indianapolis', state: 'IN', zip: '46237' }],
  ['1108 E 111Th St, Cleveland, OH 44108', { street: '1108 E 111Th St', city: 'Cleveland', state: 'OH', zip: '44108' }],
  ['1108 E 111Th St Cleveland 44108', { street: '1108 E 111Th St', city: 'Cleveland', state: '', zip: '44108' }],
  ['123 Main St, Austin, TX 78701', { street: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' }],
  ['4405 E Edgewood Ave, Indianapolis, IN 46237-1234', { street: '4405 E Edgewood Ave', city: 'Indianapolis', state: 'IN', zip: '46237' }],
  ['4405 E Edgewood Ave', { street: '4405 E Edgewood Ave', city: '', state: '', zip: '' }],
  ['', { street: '', city: '', state: '', zip: '' }],
];

let failures = 0;
for (const [name, mod] of [['data-api', dataApi], ['attom-lookup', attom], ['dashboard-ai', ai]]) {
  if (typeof mod.parseAddress !== 'function') { console.log(`FAIL ${name}: parseAddress not exported`); failures++; continue; }
  for (const [input, expected] of cases) {
    const got = mod.parseAddress(input);
    const ok = got.street === expected.street && got.city === expected.city && got.state === expected.state && got.zip === expected.zip;
    if (!ok) {
      failures++;
      console.log(`FAIL ${name} :: ${JSON.stringify(input)}\n  got      ${JSON.stringify(got)}\n  expected ${JSON.stringify(expected)}`);
    }
  }
  console.log(`${name}: ${cases.length} cases run`);
}
if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
console.log('ALL parseAddress regression tests PASS');

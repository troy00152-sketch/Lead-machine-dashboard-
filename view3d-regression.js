#!/usr/bin/env node
/*
 * 3D View regression — the Google Earth / Street View deep links added
 * Nov 13 at Troy's request ("look up a seller and the house automatically
 * pops up... one click, use it immediately").
 *
 * Pins:
 *  - the URL builders live in index.html inline code, extract cleanly and run
 *  - coords win over address (Earth @lat,lng URL / Maps cbll URL)
 *  - address fallback is fully URL-encoded (spaces, commas, # safe)
 *  - no address AND no coords -> NO url (button renders nothing: never a
 *    dead link, never a fake target)
 *  - bad/non-numeric coords fall back to the address, never into the URL
 *  - viewLinksHtml renders both links pre-targeted, or '' when unbuildable
 *  - wiring: the lead-modal gallery renders the links right beside the
 *    Zillow listing-photos link, and the comps subject card renders them
 *    under the photo — both bound to the record being displayed
 *  - $0 rule: no API keys, no function calls in the URL builders
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; /* console.log('  ok  ' + name); */ }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/* --- extract + eval the builder functions verbatim from index.html --- */
const names = ['geoHasCoords', 'earthViewUrl', 'streetViewLinkUrl', 'leadFullAddress', 'viewLinksHtml'];
const fns = {};
for (const n of names) {
  const i = scripts.indexOf('function ' + n + '(');
  if (i < 0) { fns[n] = null; continue; }
  let depth = 0, j = scripts.indexOf('{', i);
  const start = j;
  do { if (scripts[j] === '{') depth++; else if (scripts[j] === '}') depth--; j++; } while (depth > 0 && j < scripts.length);
  fns[n] = scripts.slice(i, j);
}
check('all 5 builder functions found in index.html', names.every(n => fns[n]));
const ctx = {};
if (names.every(n => fns[n])) {
  const factory = new Function(names.map(n => fns[n]).join('\n') + '\nreturn { ' + names.join(', ') + ' };');
  Object.assign(ctx, factory());
}
const { earthViewUrl, streetViewLinkUrl, leadFullAddress, viewLinksHtml } = ctx;

/* --- coords preference --- */
check('earth: coords preferred over address',
  earthViewUrl && earthViewUrl('236 N Mount St, Indianapolis, IN 46222', 39.77, -86.17)
    === 'https://earth.google.com/web/@39.77,-86.17,80a,120d,35y,0h,60t,0r',
  earthViewUrl && earthViewUrl('236 N Mount St, Indianapolis, IN 46222', 39.77, -86.17));
check('street view: coords preferred (cbll)',
  streetViewLinkUrl && streetViewLinkUrl('236 N Mount St, Indianapolis, IN 46222', '39.77', '-86.17')
    === 'https://www.google.com/maps?q=&layer=c&cbll=39.77,-86.17');
check('earth: string coords accepted',
  earthViewUrl && earthViewUrl('', '39.77', '-86.17').indexOf('/@39.77,-86.17,') > 0);

/* --- address fallback, fully encoded --- */
const addr = '6540 Ryefield Dr, Fayetteville, NC 28311';
check('earth: address fallback is search URL, encoded',
  earthViewUrl && earthViewUrl(addr, null, null)
    === 'https://earth.google.com/web/search/' + encodeURIComponent(addr));
check('earth: no raw spaces/commas in fallback URL',
  earthViewUrl && !/[\s,]/.test(earthViewUrl(addr, undefined, undefined).split('/search/')[1]));
check('earth: special chars (#) cannot break out of the path',
  earthViewUrl && earthViewUrl('Apt #4, 1 Main St', null, null).indexOf('%23') > 0);
check('street view: address fallback is a Maps search URL',
  streetViewLinkUrl && streetViewLinkUrl(addr, null, null)
    === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr));

/* --- nothing to point at -> no URL, no button --- */
check('earth: empty everything -> empty string', earthViewUrl && earthViewUrl('', null, null) === '');
check('earth: whitespace address -> empty string', earthViewUrl && earthViewUrl('   ', '', '') === '');
check('earth: null address, no coords -> empty string', earthViewUrl && earthViewUrl(null, null, null) === '');
check('street view: empty everything -> empty string', streetViewLinkUrl && streetViewLinkUrl('', null, null) === '');
check('viewLinksHtml: unbuildable -> renders nothing (button hidden)',
  viewLinksHtml && viewLinksHtml('', null, null) === '');

/* --- bad coords never leak into a URL --- */
check('earth: non-numeric coords fall back to address',
  earthViewUrl && earthViewUrl(addr, 'abc', 'def') === 'https://earth.google.com/web/search/' + encodeURIComponent(addr));
check('earth: NaN coord pair with no address -> empty string',
  earthViewUrl && earthViewUrl('', NaN, NaN) === '');
check('earth: only ONE coord present falls back to address',
  earthViewUrl && earthViewUrl(addr, 39.77, null).indexOf('/search/') > 0);

/* --- lead address assembly + rendered links --- */
check('leadFullAddress joins street/city/state/zip',
  leadFullAddress && leadFullAddress({ address: '236 N Mount St', city: 'Indianapolis', state: 'IN', zip: '46222' })
    === '236 N Mount St, Indianapolis, IN, 46222');
check('leadFullAddress skips blanks',
  leadFullAddress && leadFullAddress({ address: '1 Main St', state: 'NC' }) === '1 Main St, NC');
const rendered = viewLinksHtml ? viewLinksHtml(addr, 35.05, -78.87) : '';
check('viewLinksHtml renders the 3D View button', rendered.indexOf('🌐 3D View ↗') > 0);
check('viewLinksHtml renders the Street View link', rendered.indexOf('📍 Street View ↗') > 0);
check('viewLinksHtml links open in a new tab', (rendered.match(/target="_blank"/g) || []).length === 2);
check('viewLinksHtml earth href is pre-targeted at the coords',
  rendered.indexOf('https://earth.google.com/web/@35.05,-78.87,') > 0);
check('viewLinksHtml address-only render uses the encoded search URL',
  viewLinksHtml && viewLinksHtml(addr, null, null).indexOf(encodeURIComponent(addr)) > 0);

/* --- wiring in the page --- */
check('lead modal: links render beside the Zillow listing-photos link',
  /zillowUrl\(l\)[\s\S]{0,220}viewLinksHtml\(leadFullAddress\(l\), l\.latitude, l\.longitude\)/.test(scripts));
check('comps subject card: links render under the photo, bound to the subject record',
  scripts.indexOf("photoHtml\n    + viewLinksHtml(showAddr, prop.latitude, prop.longitude)") > 0);
check('button CSS present (.img-view-link)', html.indexOf('.img-view-link{') > 0);

/* --- $0 rule --- */
check('builders reference no API key / no netlify function',
  names.every(n => !/GOOGLE_MAPS_KEY|netlify\/functions|apiKey/i.test(fns[n] || '')));

console.log('view3d-regression: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

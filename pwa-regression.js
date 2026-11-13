/* PWA v1 regression — manifest, icons, service worker strategy, page wire-up.
 * Run: node pwa-regression.js   (exit 0 = all pass)
 * Pure file checks — no network, no live data. */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.log('FAIL: ' + label); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function pngSize(rel) {
  var buf = fs.readFileSync(path.join(ROOT, rel));
  var sigOk = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!sigOk) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/* ---------- manifest ---------- */
var manifest = null;
try { manifest = JSON.parse(read('manifest.webmanifest')); } catch (e) { /* handled below */ }
ok(!!manifest, 'manifest.webmanifest parses as JSON');
if (manifest) {
  ok(manifest.name === 'Lead Machine — Command Center', 'manifest name');
  ok(manifest.short_name === 'Command Center', 'manifest short_name');
  ok(typeof manifest.start_url === 'string' && manifest.start_url.charAt(0) === '/', 'manifest start_url is absolute path');
  ok(fs.existsSync(path.join(ROOT, manifest.start_url.replace(/^\//, ''))), 'manifest start_url file exists: ' + manifest.start_url);
  ok(manifest.display === 'standalone', 'manifest display standalone');
  ok(/^#[0-9a-f]{6}$/i.test(manifest.background_color || ''), 'manifest background_color is a hex color');
  ok(/^#[0-9a-f]{6}$/i.test(manifest.theme_color || ''), 'manifest theme_color is a hex color');
  ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'manifest declares >= 2 icons');
  (manifest.icons || []).forEach(function (icon) {
    var rel = String(icon.src || '').replace(/^\//, '');
    ok(fs.existsSync(path.join(ROOT, rel)), 'manifest icon exists: ' + icon.src);
    var size = pngSize(rel);
    ok(!!size, 'manifest icon is a real PNG: ' + icon.src);
    if (size) {
      var want = String(icon.sizes || '').split('x').map(Number);
      ok(size.w === want[0] && size.h === want[1],
        'manifest icon exact dimensions ' + icon.sizes + ' for ' + icon.src + ' (got ' + size.w + 'x' + size.h + ')');
    }
  });
  var purposes = (manifest.icons || []).map(function (i) { return i.purpose; }).join(' ');
  ok(purposes.indexOf('maskable') !== -1, 'manifest includes a maskable icon');
}

/* ---------- icon files ---------- */
[['assets/icons/icon-192.png', 192], ['assets/icons/icon-512.png', 512], ['assets/icons/icon-maskable-512.png', 512]]
.forEach(function (pair) {
  ok(fs.existsSync(path.join(ROOT, pair[0])), 'icon file exists: ' + pair[0]);
  var s = pngSize(pair[0]);
  ok(!!s && s.w === pair[1] && s.h === pair[1], 'icon exact size ' + pair[1] + 'x' + pair[1] + ': ' + pair[0]);
});

/* ---------- service worker ---------- */
var sw = read('sw.js');
ok(/CACHE_NAME\s*=\s*'leadmachine-pwa-v\d+'/.test(sw), 'sw.js has a versioned cache name');
ok(sw.indexOf("indexOf('/.netlify/functions/')") !== -1 || sw.indexOf('"/.netlify/functions/"') !== -1 || sw.indexOf("startsWith('/.netlify/functions/')") !== -1,
  'sw.js checks the /.netlify/functions/ path');
// The functions guard must come before ANY cache write so a function
// response can never be cache-put by an earlier code path.
var guardIdx = sw.indexOf('/.netlify/functions/');
var firstPutIdx = sw.indexOf('.put(');
ok(guardIdx !== -1 && (firstPutIdx === -1 || guardIdx < firstPutIdx),
  'sw.js functions guard appears before any cache.put');
ok(sw.indexOf("request.mode === 'navigate'") !== -1, 'sw.js handles navigations (network-first path)');
ok(sw.indexOf('caches.delete') !== -1 && sw.indexOf("'activate'") !== -1, 'sw.js activate handler cleans old caches');
ok(sw.indexOf('cache.addAll') !== -1 || sw.indexOf('addAll') !== -1, 'sw.js precaches core static assets on install');

/* ---------- registration ---------- */
var pwaJs = read('assets/pwa.js');
ok(pwaJs.indexOf('serviceWorker') !== -1 && pwaJs.indexOf("register('/sw.js')") !== -1,
  'assets/pwa.js registers /sw.js');

var WIRED_PAGES = ['index.html', 'command-center.html', 'closing-tracker.html', 'live-call.html',
  'room.html', 'training.html', 'bread-hl.html', 'batch-start.html', 'test-title-email.html'];
WIRED_PAGES.forEach(function (page) {
  var html = read(page);
  ok(html.indexOf('rel="manifest"') !== -1 && html.indexOf('/manifest.webmanifest') !== -1, page + ': manifest link present');
  ok(html.indexOf('name="theme-color"') !== -1, page + ': theme-color meta present');
  ok(html.indexOf('apple-touch-icon') !== -1, page + ': apple-touch-icon present');
  ok(html.indexOf('apple-mobile-web-app-capable') !== -1, page + ': apple-mobile-web-app-capable present');
  ok(html.indexOf('/assets/pwa.js') !== -1, page + ': pwa.js registration script present');
});

/* ---------- guard: hardcoded buyer tile in index.html undisturbed ---------- */
ok(read('index.html').indexOf("getElementById('statBuyers').textContent = '30,057'") !== -1,
  'index.html hardcoded statBuyers literal untouched');

console.log('pwa-regression: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);

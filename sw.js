/* Lead Machine — Command Center service worker (PWA v1).
 *
 * Strategy, deliberately conservative:
 * - /.netlify/functions/*  -> NETWORK ONLY. Live CRM data must always be
 *   fresh; function responses are never read from or written to any cache.
 * - Page navigations / HTML -> NETWORK-FIRST. The fresh page wins whenever
 *   the network answers; the cached copy is only an offline fallback.
 * - Static assets (CSS/JS/images/fonts/manifest) -> CACHE-FIRST, populated
 *   from the network on first use. These are versioned by deploy + the
 *   cache name below.
 *
 * Bump CACHE_NAME on any strategy change: activate deletes every old cache.
 */
var CACHE_NAME = 'leadmachine-pwa-v1';

var PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-512.png',
  '/assets/pwa.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE_NAME) return caches.delete(name);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isStaticAsset(url) {
  return /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|webmanifest|json)$/i.test(url.pathname);
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);

  // Live data: never intercept, never cache. Let the request hit the
  // network untouched so CRM/function data is always fresh.
  if (url.pathname.indexOf('/.netlify/functions/') === 0) return;

  // Pages: network-first, cache is only an offline fallback.
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith(
      fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        return response;
      }).catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || caches.match('/index.html');
        });
      })
    );
    return;
  }

  // Static assets: cache-first, then network (and remember the result).
  if (url.origin === self.location.origin && isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response && response.ok) {
            var copy = response.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else (cross-origin, media, etc.): plain network, no caching.
});

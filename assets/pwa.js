/* PWA registration — shared by every dashboard entry page.
 * Registers /sw.js once the page has loaded. Fails silently: a dashboard
 * without a service worker must work exactly as before. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {
      /* no-op — installability is additive, never a page dependency */
    });
  });
})();

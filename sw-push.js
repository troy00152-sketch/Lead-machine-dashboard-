/* Command Center phone-push handlers (Web Push v1).
 *
 * Loaded by /sw.js via importScripts('/sw-push.js') — one service
 * worker per scope, so push lives in the same worker that already
 * serves the dashboard (registered by assets/pwa.js on every page).
 *
 *   push              -> show the notification. The payload is the
 *                        JSON cc-push.js built: {title, body, icon,
 *                        badge, tag, url, type, threadKey, at}.
 *                        tag collapses repeats (a second reply in
 *                        the same thread replaces the first banner).
 *                        A push with no payload (or an unparseable
 *                        one) still shows a generic banner — a
 *                        silent delivery is worse than a vague one.
 *   notificationclick -> tap opens the conversation (reply) or the
 *                        calendar (appointment). If a dashboard tab
 *                        is already open on conversations/calendar/
 *                        index, it is focused AND navigated to the
 *                        deep link — except dialer/live-call/
 *                        conversation-ai tabs, which are never
 *                        navigated away from mid-call; those get a
 *                        fresh tab instead.
 */
self.addEventListener('push', function (event) {
  var data = null;
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data = null; }
    if (!data) {
      try { data = { body: event.data.text() }; } catch (e2) { data = null; }
    }
  }
  var payload = data || {};
  var title = payload.title || 'Command Center';
  var body = payload.body || 'New activity in the Command Center.';
  var url = payload.url || '/conversations.html';
  var options = {
    body: body,
    icon: payload.icon || '/assets/icons/icon-192.png',
    badge: payload.badge || '/assets/icons/icon-192.png',
    tag: payload.tag || 'cc-general',
    renotify: true,
    data: {
      url: url,
      type: payload.type || 'general',
      threadKey: payload.threadKey || null,
      at: payload.at || Date.now()
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/conversations.html';
  var full;
  try { full = new URL(url, self.location.origin).href; } catch (e) { full = self.location.origin + '/conversations.html'; }
  // Never navigate away from a live-call surface: the dialer, the
  // live-call room, and the Conversation AI test-call page. A tap
  // while Troy is on a call must open a fresh tab, never steal the
  // tab the call is on.
  var LIVE_CALL_PAGES = ['/dialer.html', '/live-call.html', '/conversation-ai.html'];
  var NAVIGABLE = ['/conversations.html', '/calendar.html', '/index.html'];
  function navigable(clientUrl) {
    try {
      var u = new URL(clientUrl);
      if (u.origin !== self.location.origin) return false;
      if (LIVE_CALL_PAGES.indexOf(u.pathname) !== -1) return false;
      return NAVIGABLE.some(function (p) { return u.pathname === p; });
    } catch (e) { return false; }
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url === full) return list[i].focus();
      }
      for (var j = 0; j < list.length; j++) {
        if (navigable(list[j].url)) {
          var c = list[j];
          try { c.navigate(full); } catch (e) { /* focus only */ }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(full);
      return undefined;
    })
  );
});

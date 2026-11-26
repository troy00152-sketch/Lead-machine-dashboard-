/* Command Center phone alerts — client side (Web Push v1).
 *
 * Wires the "Phone alerts" button (id="pushBtn") on the Conversations
 * page. The button is the only UI: tap once, allow notifications when
 * Chrome asks, and seller replies + bookings pop on this phone like
 * a text. Tap again to turn them off.
 *
 * Flow: Notification permission -> reuse the already-registered
 * /sw.js worker (assets/pwa.js registers it on every page) ->
 * pushManager.subscribe with the VAPID public key from
 * cc-push-api?action=publicKey -> POST the subscription to
 * cc-push-api?action=subscribe (lm_auth cookie, same-origin).
 * Nothing is stored on the phone except the browser's own push
 * subscription; the server keeps the endpoint in Netlify Blobs.
 *
 * Safe no-ops: if #pushBtn is absent the script does nothing; if
 * push is unsupported the button reads "Not supported"; if
 * permission is blocked the button says so and points at the
 * browser's site settings (the code cannot re-prompt a denied
 * permission — Chrome only asks once until the user resets it).
 */
(function () {
  'use strict';

  var API = '/.netlify/functions/cc-push-api';
  var BTN_ID = 'pushBtn';

  function supported() {
    return ('serviceWorker' in navigator) &&
      ('PushManager' in window) &&
      ('Notification' in window);
  }

  function b64urlToUint8(str) {
    var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var raw = window.atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function post(action, body) {
    return fetch(API + '?action=' + encodeURIComponent(action), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function get(path) {
    return fetch(API + path, { credentials: 'same-origin' })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
          return data;
        });
      });
  }

  function currentSubscription() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    });
  }

  function setBtn(btn, text, disabled) {
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = !!disabled;
  }

  function refresh(btn) {
    if (!btn) return Promise.resolve();
    if (!supported()) { setBtn(btn, '🔔 Phone alerts: not supported', true); return Promise.resolve(); }
    if (window.Notification && Notification.permission === 'denied') {
      setBtn(btn, '🔔 Alerts blocked — allow in Chrome site settings', true);
      return Promise.resolve();
    }
    return currentSubscription().then(function (sub) {
      setBtn(btn, sub ? '🔔 Phone alerts: ON — tap to turn off' : '🔔 Turn on phone alerts');
    }).catch(function () {
      setBtn(btn, '🔔 Turn on phone alerts');
    });
  }

  function enable(btn) {
    setBtn(btn, '🔔 Turning on…', true);
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('Notifications not allowed.');
      return get('?action=publicKey');
    }).then(function (data) {
      if (!data.publicKey) throw new Error('Push is not set up yet (VAPID key missing).');
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (existing) {
          if (existing) return existing;
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64urlToUint8(data.publicKey)
          });
        });
      });
    }).then(function (sub) {
      return post('subscribe', {
        subscription: sub.toJSON(),
        device: (navigator.userAgentData && navigator.userAgentData.platform) || '',
        userAgent: String(navigator.userAgent || '').slice(0, 200)
      });
    }).then(function () {
      return refresh(btn);
    });
  }

  function disable(btn) {
    setBtn(btn, '🔔 Turning off…', true);
    return currentSubscription().then(function (sub) {
      if (!sub) return null;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function () { return endpoint; });
    }).then(function (endpoint) {
      if (!endpoint) return null;
      return post('unsubscribe', { endpoint: endpoint }).catch(function () { return null; });
    }).then(function () {
      return refresh(btn);
    });
  }

  function toggle(btn) {
    return currentSubscription().then(function (sub) {
      return sub ? disable(btn) : enable(btn);
    }).catch(function (e) {
      setBtn(btn, '🔔 Turn on phone alerts');
      throw e;
    });
  }

  function init() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    refresh(btn);
    btn.addEventListener('click', function () {
      toggle(btn).catch(function (e) {
        refresh(btn);
        if (window.toast) window.toast('Phone alerts: ' + (e && e.message ? e.message : e));
      });
    });
  }

  // Public handle for the page (and for the live test): send a test
  // push to every subscribed device.
  function sendTest() {
    return post('test', {});
  }

  window.CommandCenterPush = {
    supported: supported,
    refresh: refresh,
    enable: enable,
    disable: disable,
    toggle: toggle,
    sendTest: sendTest
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();

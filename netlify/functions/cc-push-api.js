// netlify/functions/cc-push-api.js
// Phone push subscription endpoint for the Command Center.
//
//   GET  ?action=publicKey     -> {publicKey, configured} (no auth —
//                                  the VAPID public key is public by
//                                  design; the browser needs it to
//                                  subscribe)
//   GET  ?action=status        -> {configured, subscriptions, devices}
//                                  (admin only — how many phones are
//                                  subscribed, for the dashboard)
//   POST {action:'subscribe', subscription, device?, userAgent?}
//                              -> saves the browser's push
//                                 subscription (admin only)
//   POST {action:'unsubscribe', endpoint}
//                              -> removes one subscription (admin only)
//   POST {action:'test'}       -> sends a test push to every
//                                  subscribed device (admin only —
//                                  this is how Troy proves the phone
//                                  pops before a real seller replies)
//
// Auth: full dashboard login only (cc-auth isAdmin). Irish's
// calling-only login gets 403 — push is Troy's phone, not the
// caller's. Same-origin only: no CORS headers, the dashboard pages
// call this from the same origin with the lm_auth cookie.
//
// Env vars: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// (see cc-push.js). Without them, publicKey reports configured:false
// and subscribe still stores the subscription (so the phone can be
// enrolled before the keys land) — sends are skipped until the keys
// are set.
'use strict';

const push = require('./cc-push');
const ccAuth = require('./cc-auth');

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
const forbidden = () => json(403, { error: 'Full dashboard login required — phone alerts belong to Troy.' });

function isAdmin(event) {
  return ccAuth.isAdmin(event);
}

exports.handler = async (event) => {
  try {
    const params = (event && event.queryStringParameters) || {};
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return bad('Bad JSON body.');
      }
    }
    const action = params.action || body.action || '';

    // The VAPID public key is public by design — the browser needs
    // it to subscribe, and knowing it lets nobody send a push.
    if (action === 'publicKey') {
      const publicKey = push.getPublicKey();
      return ok({ publicKey, configured: !!publicKey });
    }

    if (!isAdmin(event)) return ccAuth.isIrish(event) ? forbidden() : unauth();

    if (action === 'status') {
      const devices = await push.listSubscriptions(event);
      return ok({ ok: true, configured: !!push.getPublicKey(), subscriptions: devices.length, devices });
    }

    if (action === 'subscribe') {
      const sub = body.subscription;
      if (!push.validSubscription(sub)) return bad('Invalid push subscription.');
      const saved = await push.saveSubscription(sub, {
        device: String(body.device || '').slice(0, 120),
        userAgent: String(body.userAgent || '').slice(0, 200),
      }, event);
      return ok({ ok: true, count: saved.count });
    }

    if (action === 'unsubscribe') {
      const endpoint = String(body.endpoint || '');
      if (!endpoint) return bad('Missing endpoint.');
      const removed = await push.removeSubscription(endpoint, event);
      return ok({ ok: true, count: removed.count });
    }

    if (action === 'test') {
      const result = await push.sendToAll({
        title: 'Command Center alerts are on',
        body: 'If you can see this, seller replies and bookings will pop on this phone.',
        icon: '/assets/icons/icon-192.png',
        badge: '/assets/icons/icon-192.png',
        tag: 'cc-test',
        url: '/conversations.html',
        type: 'test',
        at: Date.now(),
      }, event);
      return ok({ ok: true, ...result });
    }

    return bad('Unknown action.');
  } catch (e) {
    console.error('[cc-push-api]', e);
    return json(503, { error: 'Push storage is not ready yet', detail: String((e && e.message) || e) });
  }
};

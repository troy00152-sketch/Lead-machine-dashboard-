// netlify/functions/cc-push.js
// Shared Web Push sender for the standalone Command Center.
//
// One choke point for every phone notification: seller replies,
// appointment bookings, and (later) anything else that needs to pop
// on Troy's phone. Callers build a payload with the builders below
// and hand it to sendToAll(); this module owns subscriptions,
// VAPID auth, delivery, and pruning dead endpoints.
//
// Subscriptions live in Netlify Blobs, store 'cc-push-subscriptions':
//   'subscriptions' -> {updatedAt, subs: [{endpoint, keys:{p256dh,auth},
//                       device, userAgent, createdAt, updatedAt}]}
// One subscription per device/browser. The dashboard is Troy's phone
// (Galaxy S25 Ultra, Chrome) — today that means one row; the store
// supports more without code changes.
//
// Delivery uses the `web-push` npm package (VAPID + RFC 8291
// aes128gcm). Env vars (Netlify UI, never in the repo):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — generated Nov 26, 2026;
//   the private key lives ONLY in ~/workspace/command-center-push/
//   vapid-private.key (outside the repo) and in Netlify env.
//   VAPID_SUBJECT — 'mailto:Troy00152@gmail.com' (default).
//
// Fail-soft by design: sendToAll never throws and never blocks a
// caller past ~3s. A missed push is logged, never fatal — the
// in-app bell badge is the backstop, and the webhook/thread store
// is the source of truth. Hooks await it (bounded), so a reply
// push is never silently dropped by a frozen lambda.
'use strict';

const crypto = require('crypto');

let blobs = null;
try { blobs = require('@netlify/blobs'); } catch (e) { blobs = null; }

let webPushLib = null;
try { webPushLib = require('web-push'); } catch (e) { webPushLib = null; }

const STORE_NAME = 'cc-push-subscriptions';
const SUBS_KEY = 'subscriptions';
const SEND_TIMEOUT_MS = 3000;
const PUSH_TTL_SECONDS = 86400; // 24h — a seller reply is stale after a day
const ICON = '/assets/icons/icon-192.png';

// ---- injectable dependencies (tests) ----
const deps = { storeFactory: null, webPush: null };
function webPush() { return deps.webPush || webPushLib; }

function pushStore(event) {
  if (deps.storeFactory) return deps.storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try { if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event); } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
}

async function readJson(s, key) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

// ---- small formatters (local — no dependency on telnyx-lib) ----
function formatPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return String(e164 || '');
}
function phoneKey(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? d.slice(1) : d;
}
function formatWhen(startMs, startISO) {
  const ms = startMs != null ? Number(startMs) : Date.parse(String(startISO || ''));
  if (!Number.isFinite(ms)) return '';
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', month: 'short',
      day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ms));
    return s + ' ET';
  } catch (e) {
    return new Date(ms).toISOString();
  }
}

// ---- VAPID ----
function b64urlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}
function vapidDetails() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(process.env.VAPID_SUBJECT || 'mailto:Troy00152@gmail.com').trim();
  if (!publicKey || !privateKey) return { configured: false, reason: 'missing-key' };
  try {
    const pub = b64urlDecode(publicKey);
    const priv = b64urlDecode(privateKey);
    // Uncompressed P-256 point: 65 bytes, starts 0x04. Private: 32 bytes.
    if (pub.length !== 65 || pub[0] !== 0x04) return { configured: false, reason: 'bad-public-key' };
    if (priv.length !== 32) return { configured: false, reason: 'bad-private-key' };
  } catch (e) {
    return { configured: false, reason: 'bad-key-encoding' };
  }
  return { configured: true, publicKey, privateKey, subject };
}
function getPublicKey() {
  const v = vapidDetails();
  return v.configured ? v.publicKey : null;
}

// ---- notification payloads (what the service worker shows) ----
// Payload shape the SW (sw-push.js) renders:
//   {title, body, icon, badge, tag, url, type, threadKey?, at}
// tag collapses repeats: a second reply in the same thread replaces
// the first banner instead of stacking a new one.
function buildReplyPayload(input) {
  const r = input || {};
  const key = r.threadKey || phoneKey(r.phone);
  const name = String(r.name || '').trim();
  const preview = String(r.preview || r.body || '').trim().slice(0, 120);
  return {
    title: name || formatPhone(r.phone) || 'Seller reply',
    body: preview || 'New reply in the conversation.',
    icon: ICON,
    badge: ICON,
    tag: 'cc-reply-' + key,
    url: '/conversations.html?thread=' + encodeURIComponent(key),
    type: 'reply',
    threadKey: key,
    at: r.at || Date.now(),
  };
}
function buildAppointmentPayload(input) {
  const r = input || {};
  const when = formatWhen(r.startMs, r.startISO);
  const name = String(r.name || '').trim();
  const title = r.requested ? 'Appointment requested' : 'Appointment booked';
  const body = (name || formatPhone(r.phone) || 'A seller') +
    (when ? ' — ' + when : '') +
    (r.title && r.title !== ('Seller call — ' + name) ? ' · ' + String(r.title).slice(0, 80) : '');
  return {
    title,
    body,
    icon: ICON,
    badge: ICON,
    tag: 'cc-appt-' + (r.requested ? 'req-' : '') + (r.id || phoneKey(r.phone) + '-' + (r.startMs || '')),
    url: '/calendar.html',
    type: 'appointment',
    at: r.at || Date.now(),
  };
}
// Inbound call (Nov 26, 2026): a seller dialed one of our numbers. This
// is a WAKE-UP notification, not a ring — a mobile browser has no
// PushKit/CallKit, so the push cannot ring the phone by itself. Its job
// is to get Troy to tap: the tap opens/focuses Conversations at the
// ?inbound=<callControlId> deep link, the page (re)connects, and the
// re-dial flow rings the now-live client. High urgency + short TTL
// (~120s): a call that is still unanswered after two minutes is a
// missed call, and a stale "incoming call" banner is worse than none.
// tag is unique per call (never collapses): two inbound calls must
// never replace each other.
function buildInboundCallPayload(input) {
  const r = input || {};
  const callId = String(r.callId || r.key || '');
  const name = String(r.name || '').trim();
  const who = name || formatPhone(r.phone) || 'A seller';
  return {
    title: 'Incoming call — ' + who,
    body: who + ' is calling your business line. Tap to answer.',
    icon: ICON,
    badge: ICON,
    tag: 'cc-inbound-' + (callId || phoneKey(r.phone) + '-' + (r.at || Date.now())),
    url: '/conversations.html' + (callId ? '?inbound=' + encodeURIComponent(callId) : ''),
    type: 'incoming-call',
    callId,
    at: r.at || Date.now(),
  };
}

// ---- subscriptions ----
function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) return false;
  const keys = sub.keys || {};
  if (typeof keys.p256dh !== 'string' || !keys.p256dh) return false;
  if (typeof keys.auth !== 'string' || !keys.auth) return false;
  return true;
}
async function loadSubs(event) {
  const s = pushStore(event);
  const box = await readJson(s, SUBS_KEY);
  if (box && Array.isArray(box.subs)) return box;
  return { updatedAt: 0, subs: [] };
}
async function saveSubs(box, event) {
  const s = pushStore(event);
  box.updatedAt = Date.now();
  await writeJson(s, SUBS_KEY, box);
  return box;
}
async function saveSubscription(sub, meta, event) {
  if (!validSubscription(sub)) throw new Error('Invalid push subscription.');
  const box = await loadSubs(event);
  const now = Date.now();
  const row = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    device: (meta && meta.device) || '',
    userAgent: (meta && meta.userAgent) || '',
    createdAt: now,
    updatedAt: now,
  };
  const i = box.subs.findIndex((x) => x.endpoint === sub.endpoint);
  if (i >= 0) {
    // Re-subscribe from the same browser: refresh keys, keep the
    // original createdAt — never a duplicate row.
    row.createdAt = box.subs[i].createdAt || now;
    box.subs[i] = row;
  } else {
    box.subs.push(row);
  }
  await saveSubs(box, event);
  return { count: box.subs.length };
}
async function removeSubscription(endpoint, event) {
  const box = await loadSubs(event);
  const kept = box.subs.filter((x) => x.endpoint !== endpoint);
  if (kept.length !== box.subs.length) await saveSubs({ updatedAt: Date.now(), subs: kept }, event);
  return { count: kept.length };
}
async function listSubscriptions(event) {
  const box = await loadSubs(event);
  return box.subs.map((x) => ({
    endpointTail: String(x.endpoint || '').slice(-12),
    device: x.device || '',
    createdAt: x.createdAt || 0,
    updatedAt: x.updatedAt || 0,
  }));
}

// ---- delivery ----
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function sendToAll(payload, event, opts) {
  const result = { sent: 0, failed: 0, pruned: 0, total: 0 };
  try {
    const vapid = vapidDetails();
    if (!vapid.configured) { result.skipped = 'vapid-' + (vapid.reason || 'not-configured'); return result; }
    const wp = webPush();
    if (!wp) { result.skipped = 'web-push-not-installed'; return result; }
    const box = await loadSubs(event);
    const subs = box.subs || [];
    result.total = subs.length;
    if (!subs.length) { result.skipped = 'no-subscriptions'; return result; }
    try {
      wp.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    } catch (e) {
      result.skipped = 'vapid-invalid';
      result.error = String((e && e.message) || e);
      return result;
    }
    const o = opts && typeof opts === 'object' ? opts : {};
    // Per-send delivery: a seller reply may sit 24h; an inbound call is
    // stale after ~2 minutes. Defaults preserve the old behavior.
    const ttl = typeof o.ttl === 'number' && o.ttl > 0 ? Math.floor(o.ttl) : PUSH_TTL_SECONDS;
    const urgency = o.urgency === 'high' || o.urgency === 'low' ? o.urgency : 'normal';
    const body = JSON.stringify(payload);
    const sends = subs.map((sub) =>
      wp.sendNotification(sub, body, { TTL: ttl, urgency })
        .then(() => ({ ok: true, sub }))
        .catch((err) => ({ ok: false, sub, statusCode: err && err.statusCode }))
    );
    const timed = await withTimeout(Promise.all(sends), SEND_TIMEOUT_MS);
    if (timed.timedOut) {
      // FCM was too slow — the sends keep running in the background,
      // but the caller is not blocked. The bell badge is the backstop.
      result.failed = subs.length;
      result.timedOut = true;
      return result;
    }
    const dead = [];
    for (const o of timed.value) {
      if (o.ok) result.sent++;
      else {
        result.failed++;
        // 404/410 = the subscription is gone (browser uninstalled the
        // PWA / permission revoked). Prune it so the next send is clean.
        if (o.statusCode === 404 || o.statusCode === 410) dead.push(o.sub.endpoint);
      }
    }
    if (dead.length) {
      const kept = subs.filter((s) => dead.indexOf(s.endpoint) === -1);
      await saveSubs({ updatedAt: Date.now(), subs: kept }, event);
      result.pruned = subs.length - kept.length;
    }
    return result;
  } catch (e) {
    console.error('[cc-push] send failed:', e);
    result.error = String((e && e.message) || e);
    return result;
  }
}

async function notifyReply(input, event) {
  return sendToAll(buildReplyPayload(input), event);
}
async function notifyAppointment(input, event) {
  return sendToAll(buildAppointmentPayload(input), event);
}
// Inbound call wake-up: high urgency, ~120s TTL (see
// buildInboundCallPayload). Fail-soft like the other notifiers —
// sendToAll never throws and never blocks past ~3s.
async function notifyInboundCall(input, event) {
  return sendToAll(buildInboundCallPayload(input), event, { ttl: 120, urgency: 'high' });
}

module.exports = {
  STORE_NAME,
  buildReplyPayload,
  buildAppointmentPayload,
  buildInboundCallPayload,
  getPublicKey,
  vapidDetails,
  validSubscription,
  saveSubscription,
  removeSubscription,
  listSubscriptions,
  sendToAll,
  notifyReply,
  notifyAppointment,
  notifyInboundCall,
  formatPhone,
  formatWhen,
};

// Test hooks (not part of the deployed surface).
module.exports._test = {
  setStoreFactory(fn) {
    deps.storeFactory = fn || null;
  },
  setWebPush(wp) {
    deps.webPush = wp || null;
  },
  reset() {
    deps.storeFactory = null;
    deps.webPush = null;
  },
};

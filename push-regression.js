/* Command Center phone-push regression (Web Push v1).
 * Run: node push-regression.js   (from ~/workspace/command-center-push/)
 * Pure Node — no network, no live data. Exit 0 = all pass.
 *
 * What it proves:
 *  1. The generated VAPID keys are well-formed P-256 keys.
 *  2. The encryption path is standards-valid: an independent
 *     decryptor written from RFC 8291 section 3.4 + RFC 8188
 *     (aes128gcm body = salt || rs || keyid-len || keyid ||
 *     ciphertext+tag) reproduces the RFC 8291 Appendix A
 *     intermediate values exactly, decrypts a fixed-parameter
 *     encryption of the RFC section 5 example ("When I grow up, I
 *     want to be a watermelon"), and round-trips fresh web-push
 *     output back to the original payload.
 *  3. The VAPID Authorization header web-push generates verifies
 *     against the VAPID public key (ES256 JWT).
 *  4. Payload builders, subscription storage, send/prune, and the
 *     static shape of every new file.
 *  5. The PUSH_PLAN.md patch anchors still exist verbatim in the
 *     dashboard source (so the deployer is patching real lines).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var webPush = require('web-push');
var ece = require('http_ece');
var push = require('./netlify-functions/cc-push');

var ROOT = __dirname;
var DASH = path.join(ROOT, '..', 'dashboard-src');
var passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.log('FAIL: ' + label); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function dashRead(rel) { return fs.readFileSync(path.join(DASH, rel), 'utf8'); }
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64d(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/* ---------- 1. VAPID keys ---------- */
var VAPID_PUBLIC = read('vapid-public.key').trim();
var VAPID_PRIVATE = read('vapid-private.key').trim();
process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC;
process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE;
process.env.VAPID_SUBJECT = 'mailto:Troy00152@gmail.com';
(function () {
  var pub = b64d(VAPID_PUBLIC);
  var priv = b64d(VAPID_PRIVATE);
  ok(pub.length === 65 && pub[0] === 0x04, 'VAPID public key is a 65-byte uncompressed P-256 point');
  ok(priv.length === 32, 'VAPID private key is 32 bytes');
  var v = push.vapidDetails();
  ok(v.configured === true, 'cc-push vapidDetails reports configured with the generated keys');
  ok(push.getPublicKey() === VAPID_PUBLIC, 'cc-push getPublicKey returns the generated public key');
})();

/* ---------- 2. RFC 8291 — independent decryptor + Appendix A ---------- */
// Decryptor written from the spec (RFC 8291 s3.4 + RFC 8188 aes128gcm),
// NOT from the web-push source: it is the independent check that what
// web-push produces is decryptable by any spec-compliant receiver.
function decryptPushBody(bodyBuf, uaPrivB64, authB64) {
  var salt = bodyBuf.slice(0, 16);
  var rs = bodyBuf.readUInt32BE(16);
  var klen = bodyBuf[20];
  var asPub = bodyBuf.slice(21, 21 + klen);
  var ct = bodyBuf.slice(21 + klen);
  var uaPriv = b64d(uaPrivB64);
  var auth = b64d(authB64);
  var e = crypto.createECDH('prime256v1');
  e.setPrivateKey(uaPriv);
  var uaPub = e.getPublicKey();
  var ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPriv);
  var shared = ecdh.computeSecret(asPub);
  var prkKey = crypto.createHmac('sha256', auth).update(shared).digest();
  var keyInfo = Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0]), uaPub, asPub]);
  var ikm = crypto.createHmac('sha256', prkKey).update(Buffer.concat([keyInfo, Buffer.from([1])])).digest();
  var prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  var cek = crypto.createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'ascii'), Buffer.from([0, 1])]))
    .digest().slice(0, 16);
  var nonce = crypto.createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from('Content-Encoding: nonce', 'ascii'), Buffer.from([0, 1])]))
    .digest().slice(0, 12);
  var tag = ct.slice(-16);
  var data = ct.slice(0, -16);
  var d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  var plain = Buffer.concat([d.update(data), d.final()]);
  var end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 0x02) throw new Error('bad padding delimiter: ' + plain[end - 1]);
  return {
    text: plain.slice(0, end - 1).toString('utf8'),
    sharedB64: b64u(shared),
    prkKeyB64: b64u(prkKey),
    ikmB64: b64u(ikm),
    prkB64: b64u(prk),
    asPublicB64: b64u(asPub),
    rs: rs,
  };
}
var RFC = {
  uaPriv: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPub: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPriv: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPub: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  plaintext: 'When I grow up, I want to be a watermelon',
};
(function () {
  // Fixed-parameter encryption of the RFC section 5 example, using
  // http_ece (the same encryptor web-push uses) with the RFC's own
  // salt + sender key — then decrypt with the independent decryptor.
  var sender = crypto.createECDH('prime256v1');
  sender.setPrivateKey(b64d(RFC.asPriv));
  var body = ece.encrypt(Buffer.from(RFC.plaintext, 'utf8'), {
    version: 'aes128gcm', dh: RFC.uaPub, privateKey: sender, salt: RFC.salt, authSecret: RFC.auth,
  });
  ok(Buffer.isBuffer(body) && body.length > 16, 'RFC example encrypts to a body');
  ok(body.slice(0, 16).toString('base64url') === RFC.salt, 'RFC body carries the RFC salt first');
  ok(body.readUInt32BE(16) === 4096, 'RFC body record size is 4096');
  ok(body[20] === 65, 'RFC body keyid length is 65');
  var out = decryptPushBody(body, RFC.uaPriv, RFC.auth);
  ok(out.text === RFC.plaintext, 'independent decryptor recovers the RFC section 5 plaintext');
  ok(out.asPublicB64 === RFC.asPub, 'decryptor reads the sender public key from the body keyid');
  // Appendix A intermediate values, verbatim from the RFC.
  ok(out.sharedB64 === 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs', 'Appendix A shared ECDH secret');
  ok(out.prkKeyB64 === 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k', 'Appendix A PRK_key');
  ok(out.ikmB64 === 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg', 'Appendix A input keying material');
  ok(out.prkB64 === '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc', 'Appendix A content-encryption PRK');
})();

/* ---------- 3. web-push round-trip (fresh subscriber) ---------- */
function freshSubscriber() {
  var e = crypto.createECDH('prime256v1');
  e.generateKeys();
  return {
    sub: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test-sub-' + Date.now(),
      keys: { p256dh: b64u(e.getPublicKey()), auth: b64u(crypto.randomBytes(16)) },
    },
    priv: b64u(e.getPrivateKey()),
  };
}
(function () {
  var s = freshSubscriber();
  var payloads = [
    JSON.stringify(push.buildReplyPayload({
      threadKey: '13179454227', name: 'José García', phone: '+13179454227',
      preview: 'Yes I am open — can we talk at 2:30? I have the keys ready 🔑', at: 1795732800000,
    })),
    JSON.stringify(push.buildAppointmentPayload({
      id: 'appt-test', name: 'Elenora Hayes', phone: '+13179454227',
      startMs: Date.parse('2026-11-30T19:30:00.000Z'), title: 'Seller call — Elenora Hayes',
    })),
  ];
  payloads.forEach(function (payload, i) {
    var enc = webPush.encrypt(s.sub.keys.p256dh, s.sub.keys.auth, payload, 'aes128gcm');
    ok(enc && Buffer.isBuffer(enc.cipherText), 'web-push encrypts payload ' + i);
    var body = Buffer.isBuffer(enc.cipherText) ? enc.cipherText : Buffer.from(enc.cipherText);
    var out = decryptPushBody(body, s.priv, s.sub.keys.auth);
    ok(out.text === payload, 'independent decryptor recovers web-push payload ' + i + ' byte-for-byte');
  });
})();

/* ---------- 4. VAPID request details ---------- */
(function () {
  var s = freshSubscriber();
  var details = webPush.generateRequestDetails(s.sub, '{"title":"t"}', {
    vapidDetails: { subject: 'mailto:Troy00152@gmail.com', publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE },
    TTL: 86400,
  });
  ok(details.endpoint === s.sub.endpoint, 'request details keep the subscription endpoint');
  ok(details.headers && typeof details.headers.Authorization === 'string', 'request has a VAPID Authorization header');
  var m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(details.headers.Authorization || '');
  ok(!!m, 'Authorization header parses as vapid t=,k=');
  if (m) {
    ok(m[2] === VAPID_PUBLIC, 'VAPID k= is the generated public key');
    // Verify the ES256 JWT against the public key.
    var parts = m[1].split('.');
    ok(parts.length === 3, 'VAPID token has three JWT segments');
    var jwtPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    ok(jwtPayload.sub === 'mailto:Troy00152@gmail.com', 'VAPID JWT sub is the configured subject');
    ok(jwtPayload.exp * 1000 > Date.now(), 'VAPID JWT exp is in the future');
    var rawSig = Buffer.from(parts[2], 'base64url');
    ok(rawSig.length === 64, 'VAPID JWT signature is raw R||S (64 bytes)');
    // Raw R||S -> DER for Node verify.
    function derSig(raw) {
      function intBuf(b) {
        var v = Buffer.from(b);
        while (v.length > 1 && v[0] === 0) v = v.slice(1);
        if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
        return Buffer.concat([Buffer.from([0x02, v.length]), v]);
      }
      var r = intBuf(raw.slice(0, 32));
      var s2 = intBuf(raw.slice(32));
      return Buffer.concat([Buffer.from([0x30, r.length + s2.length]), r, s2]);
    }
    var spki = Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      b64d(VAPID_PUBLIC),
    ]);
    var key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    var verified = crypto.createVerify('SHA256')
      .update(parts[0] + '.' + parts[1])
      .verify(key, derSig(rawSig));
    ok(verified === true, 'VAPID JWT signature verifies with the public key');
  }
  // aes128gcm carries salt + sender key IN THE BODY (RFC 8188) —
  // there is no Crypto-Key/Encryption header for this encoding.
  // The body layout is proven by decrypting it below.
  ok(details.headers['Content-Encoding'] === 'aes128gcm', 'request Content-Encoding is aes128gcm');
  ok(details.headers.Urgency === 'normal', 'request urgency is normal');
  ok(details.body && details.body.length > 86, 'request body is a non-empty encrypted payload');
  var reqBody = Buffer.isBuffer(details.body) ? details.body : Buffer.from(details.body);
  ok(reqBody.readUInt32BE(16) === 4096, 'request body record size is 4096');
  ok(reqBody[20] === 65, 'request body keyid length is 65');
  var reqOut = decryptPushBody(reqBody, s.priv, s.sub.keys.auth);
  ok(reqOut.text === '{"title":"t"}', 'request body decrypts to the original payload');
})();

/* ---------- 5. payload builders ---------- */
(function () {
  var r1 = push.buildReplyPayload({ threadKey: '13179454227', name: 'Elenora Hayes', phone: '+13179454227', preview: 'Yes, Tuesday works', at: 1 });
  ok(r1.title === 'Elenora Hayes', 'reply title uses the contact name');
  ok(r1.body === 'Yes, Tuesday works', 'reply body is the preview');
  ok(r1.tag === 'cc-reply-13179454227', 'reply tag collapses per thread');
  ok(r1.url === '/conversations.html?thread=13179454227', 'reply tap opens the thread deep link');
  ok(r1.type === 'reply', 'reply type is reply');
  var r2 = push.buildReplyPayload({ phone: '+13179454227', preview: 'hello' });
  ok(r2.title === '(317) 945-4227', 'reply without a name falls back to the formatted phone');
  ok(r2.threadKey === '3179454227', 'reply threadKey is the phone digits');
  var long = new Array(200).join('x');
  var r3 = push.buildReplyPayload({ threadKey: '1', name: 'A', preview: long });
  ok(r3.body.length === 120, 'reply preview truncates to 120 chars');
  var a1 = push.buildAppointmentPayload({
    id: 'appt-1', name: 'Elenora Hayes', phone: '+13179454227',
    startMs: Date.parse('2026-11-30T19:30:00.000Z'), title: 'Seller call — Elenora Hayes',
  });
  ok(a1.title === 'Appointment booked', 'appointment title is booked');
  ok(/Nov 30/.test(a1.body) && /2:30 PM ET/.test(a1.body), 'appointment body shows the ET time (Nov 30, 2:30 PM ET)');
  ok(/Elenora Hayes/.test(a1.body), 'appointment body names the seller');
  ok(a1.url === '/calendar.html', 'appointment tap opens the calendar');
  ok(a1.tag === 'cc-appt-appt-1', 'appointment tag is per booking id');
  var a2 = push.buildAppointmentPayload({ phone: '+13179454227', requested: true, at: 5 });
  ok(a2.title === 'Appointment requested', 'requested disposition title differs from booked');
  ok(a2.body.indexOf('ET') === -1, 'appointment without a time shows no time');
  ok(push.formatPhone('+13179454227') === '(317) 945-4227', 'formatPhone formats a US number');
  ok(push.formatWhen(Date.parse('2026-11-30T19:30:00.000Z')).indexOf('2:30 PM ET') !== -1, 'formatWhen renders 19:30Z as 2:30 PM ET');
})();

/* ---------- 6. subscription store (fake Blobs) ---------- */
function fakeStore() {
  var map = new Map();
  return {
    get: async function (key, opts) {
      var v = map.get(key);
      if (v == null) return null;
      if (opts && opts.type === 'json') { try { return JSON.parse(v); } catch (e) { return null; } }
      return v;
    },
    set: async function (key, value) { map.set(key, String(value)); },
  };
}
function fakeSub(id) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + id,
    keys: { p256dh: b64u(crypto.randomBytes(65).map(function (b, i) { return i === 0 ? 4 : b; })), auth: b64u(crypto.randomBytes(16)) },
  };
}
async function storeTests() {
  var store = fakeStore();
  push._test.setStoreFactory(function () { return store; });
  try {
    var subA = fakeSub('phone-a');
    var subB = fakeSub('phone-b');
    ok(push.validSubscription(subA) === true, 'valid subscription passes validation');
    ok(push.validSubscription({ endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } }) === false, 'http endpoint is rejected');
    ok(push.validSubscription({ endpoint: 'https://x', keys: { p256dh: '', auth: 'b' } }) === false, 'missing p256dh is rejected');
    ok(push.validSubscription({ endpoint: 'https://x' }) === false, 'missing keys are rejected');
    var r1 = await push.saveSubscription(subA, { device: 'Galaxy S25 Ultra' }, null);
    ok(r1.count === 1, 'first subscribe stores one subscription');
    var list1 = await push.listSubscriptions(null);
    ok(list1.length === 1 && list1[0].device === 'Galaxy S25 Ultra', 'list shows the saved device');
    var createdAt = list1[0].createdAt;
    await new Promise(function (r) { setTimeout(r, 5); });
    var subA2 = { endpoint: subA.endpoint, keys: { p256dh: subA.keys.p256dh, auth: b64u(crypto.randomBytes(16)) } };
    var r2 = await push.saveSubscription(subA2, { device: 'Galaxy S25 Ultra' }, null);
    ok(r2.count === 1, 're-subscribe from the same browser does not duplicate');
    var list2 = await push.listSubscriptions(null);
    ok(list2.length === 1 && list2[0].createdAt === createdAt, 're-subscribe keeps the original createdAt');
    ok(list2[0].endpointTail === subA.endpoint.slice(-12), 'list exposes only the endpoint tail, never the full endpoint');
    await push.saveSubscription(subB, { device: 'Pixel' }, null);
    ok((await push.listSubscriptions(null)).length === 2, 'second device adds a second subscription');
    var r3 = await push.removeSubscription(subA.endpoint, null);
    ok(r3.count === 1, 'unsubscribe removes one subscription');
    ok((await push.listSubscriptions(null)).length === 1, 'one subscription remains after unsubscribe');
    var r4 = await push.removeSubscription('https://fcm.googleapis.com/fcm/send/nope', null);
    ok(r4.count === 1, 'unsubscribing an unknown endpoint is a no-op');
  } finally {
    push._test.reset();
  }
}

/* ---------- 7. sendToAll (fake push service) ---------- */
async function sendTests() {
  var store = fakeStore();
  push._test.setStoreFactory(function () { return store; });
  try {
    // No subscriptions yet.
    var empty = await push.sendToAll({ title: 't', body: 'b' }, null);
    ok(empty.skipped === 'no-subscriptions' && empty.sent === 0, 'send with no subscriptions skips cleanly');
    // Two subscriptions: one delivers, one is gone (410) and pruned.
    var subA = fakeSub('ok-phone');
    var subB = fakeSub('dead-phone');
    await push.saveSubscription(subA, {}, null);
    await push.saveSubscription(subB, {}, null);
    var seen = [];
    var fakeWp = {
      setVapidDetails: function () {},
      sendNotification: async function (sub, body, opts) {
        seen.push({ endpoint: sub.endpoint, body: body, opts: opts });
        if (sub.endpoint.indexOf('dead-phone') !== -1) {
          var err = new Error('gone');
          err.statusCode = 410;
          throw err;
        }
        return { statusCode: 201 };
      },
    };
    push._test.setWebPush(fakeWp);
    var res = await push.sendToAll({ title: 'Reply', body: 'hi', tag: 'x', url: '/conversations.html' }, null);
    ok(res.sent === 1, 'send delivers to the live subscription');
    ok(res.failed === 1 && res.pruned === 1, 'send prunes the 410 subscription');
    ok(seen.length === 2, 'send attempted both subscriptions');
    ok(seen[0].opts && seen[0].opts.TTL === 86400, 'send uses a 24h TTL');
    ok(JSON.parse(seen[0].body).title === 'Reply', 'send body is the JSON payload');
    ok((await push.listSubscriptions(null)).length === 1, 'dead subscription is gone from the store');
    // notifyReply / notifyAppointment go through the same path.
    var res2 = await push.notifyReply({ threadKey: '13179454227', name: 'Paula', phone: '+12034196726', preview: 'yes' }, null);
    ok(res2.sent === 1, 'notifyReply sends to the remaining subscription');
    var res3 = await push.notifyAppointment({ id: 'appt-9', name: 'Elenora', phone: '+13179454227', startMs: Date.parse('2026-11-30T19:30:00.000Z') }, null);
    ok(res3.sent === 1, 'notifyAppointment sends to the remaining subscription');
    // VAPID not configured.
    var savedPub = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    var res4 = await push.sendToAll({ title: 't' }, null);
    ok(res4.skipped === 'vapid-missing-key' && res4.sent === 0, 'send without VAPID keys skips cleanly');
    process.env.VAPID_PUBLIC_KEY = savedPub;
    // A hung push service never blocks the caller past ~3s.
    var hungWp = {
      setVapidDetails: function () {},
      sendNotification: function () { return new Promise(function () { /* never settles */ }); },
    };
    push._test.setWebPush(hungWp);
    var t0 = Date.now();
    var res5 = await push.sendToAll({ title: 't' }, null);
    var took = Date.now() - t0;
    ok(res5.timedOut === true, 'hung push service reports timedOut');
    ok(took < 4500, 'hung push service returns in under 4.5s (took ' + took + 'ms)');
  } finally {
    push._test.reset();
  }
}

/* ---------- 8. static shape of the new files ---------- */
(function () {
  var swPush = read('sw-push.js');
  ok(swPush.indexOf("addEventListener('push'") !== -1, 'sw-push.js handles the push event');
  ok(swPush.indexOf("addEventListener('notificationclick'") !== -1, 'sw-push.js handles notificationclick');
  ok(swPush.indexOf('showNotification') !== -1, 'sw-push.js shows the notification');
  ok(swPush.indexOf('openWindow') !== -1, 'sw-push.js opens a window when no tab matches');
  ok(swPush.indexOf("var NAVIGABLE = ['/conversations.html', '/calendar.html', '/index.html'];") !== -1,
    'sw-push.js only ever navigates conversations/calendar/index tabs');
  ok(swPush.indexOf("var LIVE_CALL_PAGES = ['/dialer.html', '/live-call.html', '/conversation-ai.html'];") !== -1,
    'sw-push.js names the live-call pages a tap must never navigate away from');
  var client = read('assets/push.js');
  ok(client.indexOf('cc-push-api') !== -1, 'assets/push.js talks to cc-push-api');
  ok(client.indexOf('applicationServerKey') !== -1, 'assets/push.js subscribes with the VAPID key');
  ok(client.indexOf("var BTN_ID = 'pushBtn';") !== -1 && client.indexOf('getElementById(BTN_ID)') !== -1,
    'assets/push.js wires the pushBtn button');
  ok(client.indexOf('requestPermission') !== -1, 'assets/push.js requests notification permission');
  ok(client.indexOf('same-origin') !== -1, 'assets/push.js sends the lm_auth cookie (same-origin)');
  var api = read('netlify-functions/cc-push-api.js');
  ['publicKey', 'status', 'subscribe', 'unsubscribe', 'test'].forEach(function (a) {
    ok(api.indexOf("'" + a + "'") !== -1 || api.indexOf('"' + a + '"') !== -1, 'cc-push-api.js has the ' + a + ' action');
  });
  ok(api.indexOf('isAdmin') !== -1 && api.indexOf("require('./cc-auth')") !== -1,
    'cc-push-api.js gates admin actions behind cc-auth');
  ok(api.indexOf("require('./cc-push')") !== -1, 'cc-push-api.js uses the shared cc-push helper');
  var helper = read('netlify-functions/cc-push.js');
  ['notifyReply', 'notifyAppointment', 'sendToAll', 'buildReplyPayload', 'buildAppointmentPayload',
   'saveSubscription', 'removeSubscription', 'listSubscriptions', 'validSubscription',
   'getPublicKey', 'vapidDetails'].forEach(function (fn) {
    ok(helper.indexOf(fn) !== -1, 'cc-push.js exports ' + fn);
  });
  ok(helper.indexOf("connectLambda") !== -1, 'cc-push.js calls connectLambda for Blobs (Netlify v1 pattern)');
  ok(helper.indexOf('VAPID_PUBLIC_KEY') !== -1 && helper.indexOf('VAPID_PRIVATE_KEY') !== -1,
    'cc-push.js reads VAPID keys from env, never hardcoded');
  ok(helper.indexOf('cc-push-subscriptions') !== -1, 'cc-push.js uses the cc-push-subscriptions store');
  ok(helper.indexOf('410') !== -1 && helper.indexOf('404') !== -1, 'cc-push.js prunes dead (404/410) subscriptions');
  ok(fs.existsSync(path.join(DASH, 'assets', 'icons', 'icon-192.png')), 'notification icon exists in the repo (assets/icons/icon-192.png)');
})();

/* ---------- 9. PUSH_PLAN.md patch anchors still exist verbatim ---------- */
(function () {
  function anchor(rel, needle, label) {
    var src = null;
    try { src = dashRead(rel); } catch (e) { src = null; }
    ok(src !== null && src.indexOf(needle) !== -1, 'anchor in ' + rel + ': ' + label);
  }
  anchor('netlify/functions/telnyx-webhook.js',
    "const botHook = require('./cc-bot-hook');", 'bot-hook require (push require goes next to it)');
  anchor('netlify/functions/telnyx-webhook.js',
    'result.thread && !result.duplicate', 'inbound dedupe gate (push fires under the same gate)');
  anchor('netlify/functions/cc-appointments.js',
    'await saveRecord(s, out);', 'createAppointment save (push hook goes after it)');
  anchor('netlify/functions/cc-call-api.js',
    'await writeJson(s, DISPOSITIONS_KEY, box);', 'disposition save (Requested Appointment hook goes after it)');
  anchor('netlify/functions/cc-call-api.js',
    "const ccAuth = require('./cc-auth');", 'cc-auth require (push require goes next to it)');
  anchor('conversations.html',
    '<button class="btn small" id="notifBtn"', 'bell button (push button goes next to it)');
  anchor('conversations.html',
    '<script src="/assets/pwa.js" defer></script>', 'pwa.js script tag (push.js tag goes after it)');
  anchor('conversations.html',
    'refreshAll().then(function () {\n    var deep = null;\n    try { deep = new URLSearchParams(window.location.search).get(\'thread\'); } catch (e) { deep = null; }\n    if (deep) selectThread(deep).catch(handleLoadError);\n  });', 'init deep-link block (?thread= selects the thread after load)');
  anchor('sw.js',
    "var CACHE_NAME = 'leadmachine-pwa-v7';", 'SW cache version v7 (bumped when sw-push was wired in)');
  anchor('sw.js',
    "self.addEventListener('install'", 'SW install handler (importScripts goes above the handlers)');
  anchor('package.json', '"@netlify/blobs"', 'package.json dependencies (web-push line goes after it)');
  anchor('manifest.webmanifest', 'icon-192.png', 'manifest declares the notification icon');
})();

/* ---------- run the async sections ---------- */
(async function () {
  await storeTests();
  await sendTests();
  console.log('push gate: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('push gate crashed:', e);
  process.exit(1);
});

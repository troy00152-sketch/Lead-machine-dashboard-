// seller-photos-regression.js — Seller photo walkthrough, Nov 18 2026.
// Fixture tests for netlify/functions/photo-link.js +
// netlify/functions/photo-upload.js + photos.html / photos-admin.html.
// NO live calls and NO real Blobs: both functions are pointed at one
// shared in-memory fake store via their _test.setStore hooks (the
// cc-funnel-api.js pattern). The admin cookie is minted with an
// obviously fake TEST secret. Run: node seller-photos-regression.js
// (exit non-zero on any failure).
//
// What it proves:
//   1. photo-link is admin-only (401 without the lm_auth cookie) and a
//      minted token is unguessable-shaped (>= 20 url-safe chars) with
//      the public url on leadmachineapp.com; the manifest stub lands
//      in the shared store.
//   2. getSession resumes: bad / unknown tokens are rejected, a good
//      token returns address + seller first name + per-step counts.
//   3. uploadPhoto validates for real: JPEG/PNG/WebP magic accepted,
//      GIF/text rejected, >8MB rejected, unknown step rejected — and
//      the manifest updates on upload (photo entry, step counts, and a
//      per-photo capturedAt timestamp).
//   4. Single-photo steps replace in place; multi steps append
//      ({stepId}-0, {stepId}-1, ...).
//   5. finish stamps the manifest complete with the seller's notes.
//   6. Admin GETs (listPhotos / getPhoto / session list) reject
//      no-auth calls and serve authed ones — getPhoto streams the
//      exact uploaded bytes back with the image content-type.
//   7. photos.html carries all 15 steps, the Direct Property Buyers
//      branding, the expectation / resume / quality-check / review /
//      thank-you copy, the Google Voice number — and NONE of Troy's
//      home address or personal number anywhere seller-facing.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// ---- shared in-memory fake of the 'seller-photos' Blobs store ----
function makeFakeStore() {
  const map = new Map();
  return {
    async get(key, opts) {
      const buf = map.get(key);
      if (!buf) return null;
      const type = opts && opts.type;
      if (type === 'json') {
        try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
      }
      if (type === 'arrayBuffer') {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      return buf.toString('utf8');
    },
    async set(key, value) {
      if (typeof value === 'string') map.set(key, Buffer.from(value, 'utf8'));
      else if (Buffer.isBuffer(value)) map.set(key, Buffer.from(value));
      else if (value instanceof ArrayBuffer) map.set(key, Buffer.from(new Uint8Array(value)));
      else map.set(key, Buffer.from(String(value)));
    },
    async delete(key) { map.delete(key); },
    async list() { return { blobs: Array.from(map.keys()).map((key) => ({ key })) }; },
    _map: map,
  };
}

const photoUpload = require('./netlify/functions/photo-upload.js');
const photoLink = require('./netlify/functions/photo-link.js');
const store = makeFakeStore();
photoUpload._test.setStore(store);
photoLink._test.setStore(store);

// ---- admin cookie minted with a TEST secret (buyer-verify HMAC scheme) ----
process.env.GATE_SECRET = 'seller-photos-TEST-secret';
const expiry = String(Math.floor(Date.now() / 1000) + 3600);
const sig = crypto.createHmac('sha256', process.env.GATE_SECRET).update(expiry).digest('hex');
const ADMIN = { cookie: 'lm_auth=' + expiry + '.' + sig };
const NOAUTH = {};

function post(fn, body, headers) {
  return fn.handler({ httpMethod: 'POST', headers: headers || {}, queryStringParameters: {}, body: JSON.stringify(body) });
}
function get(fn, params, headers) {
  return fn.handler({ httpMethod: 'GET', headers: headers || {}, queryStringParameters: params || {} });
}
function body(r) { return JSON.parse(r.body); }

// ---- tiny fixture images (magic bytes are what the function sniffs) ----
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('retake-jpeg-body')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x12, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('fake-webp')]);
const GIF = Buffer.from('GIF89a-this-is-not-accepted');
const b64 = (buf) => buf.toString('base64');

(async () => {
  // ---- 1. photo-link: admin-only + token shape + manifest stub ----
  let r = await post(photoLink, { address: '1 Main St', sellerName: 'Test Seller' }, NOAUTH);
  check('photo-link POST without auth -> 401', r.statusCode === 401, 'got ' + r.statusCode);
  r = await get(photoLink, {}, NOAUTH);
  check('photo-link GET without auth -> 401', r.statusCode === 401, 'got ' + r.statusCode);

  r = await post(photoLink, { address: '', sellerName: 'Test Seller' }, ADMIN);
  check('photo-link POST without address -> 400', r.statusCode === 400, 'got ' + r.statusCode);

  r = await post(photoLink, {
    address: '3051 Eastern Ave, Indianapolis, IN 46218',
    sellerName: 'Elenora Hayes',
    phone: '+13179454227',
    contactId: 'contact-123',
  }, ADMIN);
  let b = body(r);
  check('photo-link POST with auth -> 200 ok', r.statusCode === 200 && b.ok === true, 'got ' + r.statusCode);
  const token = b.token;
  check('token is >= 20 url-safe chars', typeof token === 'string' && token.length >= 20 && /^[A-Za-z0-9_-]+$/.test(token), String(token));
  check('url is the public photos page with the token', b.url === 'https://leadmachineapp.com/photos.html?k=' + token, b.url);
  const stubRaw = store._map.get(token + '/manifest.json');
  check('manifest stub written to the shared store', !!stubRaw);
  const stub = stubRaw ? JSON.parse(stubRaw.toString('utf8')) : {};
  check('stub carries address + seller + first name', stub.address === '3051 Eastern Ave, Indianapolis, IN 46218' && stub.sellerName === 'Elenora Hayes' && stub.sellerFirstName === 'Elenora');
  check('stub starts incomplete with zero photos', stub.complete === false && Array.isArray(stub.photos) && stub.photos.length === 0);

  // ---- 2. getSession: resume + bad-token rejection ----
  r = await post(photoUpload, { action: 'getSession', token: 'AAAAAAAAAAAAAAAAAAAA' }, NOAUTH);
  check('getSession unknown token -> 404', r.statusCode === 404, 'got ' + r.statusCode);
  r = await post(photoUpload, { action: 'getSession', token: 'bad token!!' }, NOAUTH);
  check('getSession malformed token -> 404', r.statusCode === 404, 'got ' + r.statusCode);
  r = await post(photoUpload, { action: 'getSession', token }, NOAUTH);
  b = body(r);
  check('getSession good token -> 200', r.statusCode === 200 && b.ok === true, 'got ' + r.statusCode);
  check('getSession returns address + first name', b.address === '3051 Eastern Ave, Indianapolis, IN 46218' && b.sellerFirstName === 'Elenora');
  check('getSession starts with zero photos', b.photoCount === 0 && Object.keys(b.stepsWithPhotos || {}).length === 0);

  // ---- 3. uploadPhoto validation + manifest updates + capturedAt ----
  r = await post(photoUpload, { action: 'uploadPhoto', token: 'AAAAAAAAAAAAAAAAAAAA', stepId: 'front', image: b64(JPEG) }, NOAUTH);
  check('uploadPhoto unknown token -> 404', r.statusCode === 404, 'got ' + r.statusCode);
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'garage', image: b64(JPEG) }, NOAUTH);
  check('uploadPhoto unknown step -> 400', r.statusCode === 400, 'got ' + r.statusCode);
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'front', image: b64(GIF) }, NOAUTH);
  check('uploadPhoto GIF bytes -> 400 (not JPEG/PNG/WebP)', r.statusCode === 400, 'got ' + r.statusCode);
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'front', image: b64(Buffer.from('just text')) }, NOAUTH);
  check('uploadPhoto text bytes -> 400', r.statusCode === 400, 'got ' + r.statusCode);
  const bigBuf = Buffer.alloc(photoUpload._test.MAX_IMAGE_BYTES + 1, 0x41);
  bigBuf[0] = 0xff; bigBuf[1] = 0xd8; bigBuf[2] = 0xff;
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'front', image: b64(bigBuf) }, NOAUTH);
  check('uploadPhoto >8MB -> 400 (oversize rejected)', r.statusCode === 400, 'got ' + r.statusCode);

  const capturedAt = '2026-11-18T18:00:00.000Z';
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'front', image: b64(JPEG), capturedAt }, NOAUTH);
  b = body(r);
  check('uploadPhoto JPEG -> 200 ok', r.statusCode === 200 && b.ok === true, 'got ' + r.statusCode);
  check('uploadPhoto key is {token}/front-0', b.key === token + '/front-0', b.key);
  check('photo bytes stored in Blobs', !!store._map.get(token + '/front-0') && store._map.get(token + '/front-0').equals(JPEG));

  r = await post(photoUpload, { action: 'getSession', token }, NOAUTH);
  b = body(r);
  check('manifest updated: getSession sees front=1', b.photoCount === 1 && b.stepsWithPhotos.front === 1);

  r = await get(photoUpload, { action: 'listPhotos', token }, ADMIN);
  b = body(r);
  const frontEntry = (b.photos || [])[0] || {};
  check('manifest entry records contentType + size', frontEntry.contentType === 'image/jpeg' && frontEntry.size === JPEG.length);
  check('manifest entry records capturedAt from the client', frontEntry.capturedAt === capturedAt, String(frontEntry.capturedAt));
  check('manifest entry records upload time', typeof frontEntry.at === 'string' && frontEntry.at.length > 0);

  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'roof', image: b64(PNG) }, NOAUTH);
  check('uploadPhoto PNG magic -> accepted', r.statusCode === 200 && body(r).ok === true, 'got ' + r.statusCode);
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'panel', image: b64(WEBP) }, NOAUTH);
  check('uploadPhoto WebP magic -> accepted', r.statusCode === 200 && body(r).ok === true, 'got ' + r.statusCode);

  // ---- 4. single replace vs multi append ----
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'front', image: b64(JPEG2) }, NOAUTH);
  b = body(r);
  check('single step re-upload replaces (stepCount stays 1)', b.stepCount === 1 && b.key === token + '/front-0', JSON.stringify(b));
  check('replaced bytes are the new photo', store._map.get(token + '/front-0').equals(JPEG2));

  await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'damage', image: b64(JPEG) }, NOAUTH);
  r = await post(photoUpload, { action: 'uploadPhoto', token, stepId: 'damage', image: b64(PNG) }, NOAUTH);
  b = body(r);
  check('multi step appends (stepCount 2)', b.stepCount === 2, 'got ' + b.stepCount);
  check('multi keys are damage-0 and damage-1', !!store._map.get(token + '/damage-0') && !!store._map.get(token + '/damage-1'));

  // ---- 5. finish ----
  r = await post(photoUpload, { action: 'finish', token, notes: 'Roof is about 10 years old.' }, NOAUTH);
  b = body(r);
  check('finish -> 200 complete', r.statusCode === 200 && b.complete === true, 'got ' + r.statusCode);
  r = await post(photoUpload, { action: 'getSession', token }, NOAUTH);
  b = body(r);
  check('getSession after finish shows complete', b.complete === true);
  const man = JSON.parse(store._map.get(token + '/manifest.json').toString('utf8'));
  check('manifest stamped completedAt + notes', typeof man.completedAt === 'string' && man.notes === 'Roof is about 10 years old.');

  // ---- 6. admin GETs ----
  r = await get(photoUpload, { action: 'listPhotos', token }, NOAUTH);
  check('listPhotos without auth -> 401', r.statusCode === 401, 'got ' + r.statusCode);
  r = await get(photoUpload, { action: 'getPhoto', token, key: token + '/front-0' }, NOAUTH);
  check('getPhoto without auth -> 401', r.statusCode === 401, 'got ' + r.statusCode);
  r = await get(photoUpload, { action: 'listPhotos', token }, ADMIN);
  b = body(r);
  check('listPhotos with auth -> manifest + keys', r.statusCode === 200 && b.ok === true && b.manifest.address.includes('Eastern Ave') && Array.isArray(b.keys) && b.keys.length === 5, 'keys=' + (b.keys || []).length);
  r = await get(photoUpload, { action: 'getPhoto', token, key: token + '/front-0' }, ADMIN);
  check('getPhoto with auth -> 200 base64 stream', r.statusCode === 200 && r.isBase64Encoded === true, 'got ' + r.statusCode);
  check('getPhoto content-type is image/jpeg', (r.headers || {})['Content-Type'] === 'image/jpeg', (r.headers || {})['Content-Type']);
  check('getPhoto returns the exact uploaded bytes', Buffer.from(r.body, 'base64').equals(JPEG2));
  r = await get(photoUpload, { action: 'getPhoto', token, key: 'someone-else/front-0' }, ADMIN);
  check('getPhoto with a key outside the token -> 400', r.statusCode === 400, 'got ' + r.statusCode);

  r = await get(photoLink, {}, ADMIN);
  b = body(r);
  const sess = (b.sessions || []).find((s) => s.token === token);
  check('photo-link GET lists the session', !!sess);
  check('session summary: photo count + complete', !!sess && sess.photoCount === 5 && sess.complete === true, sess ? JSON.stringify({ n: sess.photoCount, c: sess.complete }) : 'missing');

  // ---- 7. static checks: photos.html ----
  const html = fs.readFileSync(path.join(__dirname, 'photos.html'), 'utf8');
  const stepIds = photoUpload._test.STEPS.map((s) => s.id);
  check('function defines exactly 15 steps', stepIds.length === 15, 'got ' + stepIds.length);
  for (const id of stepIds) {
    check('photos.html carries step "' + id + '"', html.includes("id: '" + id + "'"));
  }
  check('photos.html has Direct Property Buyers branding', html.includes('Direct Property Buyers'));
  check('photos.html sets the 10-minute expectation', html.includes('about 10 minutes'));
  check('photos.html promises resume on the same link', html.includes('picks up right where you left off'));
  check('photos.html has the quality self-check copy', html.includes('Can you see the whole room clearly?') && html.includes('Looks Good'));
  check('photos.html has the friendly upload confirmation', html.includes('Got it — that one'));
  check('photos.html has the collapsible Your progress strip', html.includes('Your progress'));
  check('photos.html has the pre-finish review grid', html.includes('Give them a quick look') && html.includes('reviewGroups'));
  check('photos.html thank-you states next steps', html.includes("We've got your photos") && html.includes('get back to you shortly'));
  check('photos.html shows the Google Voice number', html.includes('(860) 452-6497'));
  check('photos.html talks to the photo-upload function', html.includes('/.netlify/functions/photo-upload'));
  check('photos.html camera input allows capture', html.includes('accept="image/*"') && html.includes('capture="environment"'));
  check('photos.html sends capturedAt with uploads', html.includes('capturedAt'));
  check('photos.html has NO home address', !html.includes('208 Burgundy Hill') && !html.includes('Burgundy'));
  check('photos.html has NO personal number', !html.includes('203-565-7810') && !html.includes('565-7810'));

  // ---- 8. static checks: admin page + gate pass-through ----
  const admin = fs.readFileSync(path.join(__dirname, 'photos-admin.html'), 'utf8');
  check('photos-admin.html uses both admin endpoints', admin.includes('/.netlify/functions/photo-link') && admin.includes('/.netlify/functions/photo-upload'));
  check('photos-admin.html has NO personal number', !admin.includes('565-7810'));
  const gate = fs.readFileSync(path.join(__dirname, 'netlify', 'edge-functions', 'gate.ts'), 'utf8');
  check('gate.ts passes photos.html + photo-upload through publicly', gate.includes('"/photos.html"') && gate.includes('"/.netlify/functions/photo-upload"'));
  check('gate.ts does NOT open photo-link publicly', !gate.includes('"/.netlify/functions/photo-link"') && !gate.includes('"/photos-admin.html"'));

  console.log('\nseller-photos-regression: ' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

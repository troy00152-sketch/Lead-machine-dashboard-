// netlify/functions/cc-sam-store.js
// Shared Blobs access for the Sam (ElevenLabs) functions — cc-sam-init,
// cc-sam-webhook, cc-sam-tools. Small, self-contained, and deliberately
// NOT built on CcClient: the bot path's CcClient is constructed without
// a Lambda event (see the Nov 27 Amber fix), and on Netlify Functions
// v1 a store built without connectLambda(event) reads-miss / writes
// silently no-op. These functions are invoked by real HTTP POSTs, so
// the real Lambda event is always available here — pass it in.
//
// Store shapes (mirroring cc-client.js / cc-appointments.js):
//   'cc-conversations' key <phoneKey> -> {key, phone, name, market,
//     messages: [{id, dir, body, at, via?, ...}], unread, updatedAt}
//   'cc-conversations' key 'index'    -> {updatedAt, threads: {key: {phone, name, market, preview, lastAt, lastDir, unread}}}
//   'cc-enrollments'   key <phoneKey> -> {phone, name, firstName, email,
//     address1, city, state, postalCode, tags}
//   'cc-appointments' is owned by cc-appointments.js — use its
//     listAppointments / createAppointment with the event, never raw.
'use strict';

const lib = require('./telnyx-lib');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const CONV_STORE = 'cc-conversations';
const ENROLL_STORE = 'cc-enrollments';
const MAX_MESSAGES_PER_THREAD = 500;

const deps = { storeFactory: null };

function makeStore(name, event) {
  if (deps.storeFactory) return deps.storeFactory(name);
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(name);
}

function convStore(event) {
  return makeStore(CONV_STORE, event);
}
function enrollStore(event) {
  return makeStore(ENROLL_STORE, event);
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

async function loadThread(key, event) {
  const t = await readJson(convStore(event), key);
  if (!t) return null;
  if (!Array.isArray(t.messages)) t.messages = [];
  return t;
}

async function loadEnrollment(key, event) {
  return readJson(enrollStore(event), key);
}

// Append one message to a thread (creating the thread when needed)
// and refresh the store 'index' entry — same shape as
// cc-client.js _saveThread / telnyx-webhook.js applyEvent, so the
// Conversations UI lists the thread the same way. Returns the saved
// thread, or null when the store write failed.
async function appendThreadMessage(key, msg, event) {
  const cs = convStore(event);
  let thread = await readJson(cs, key);
  if (!thread) {
    thread = {
      key,
      phone: (msg && msg.phone) || key,
      name: (msg && msg.name) || '',
      market: (msg && msg.market) || '',
      messages: [],
      unread: 0,
    };
  }
  if (!Array.isArray(thread.messages)) thread.messages = [];
  const m = Object.assign({}, msg);
  if (!m.id) m.id = 'sam-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  if (!m.at) m.at = Date.now();
  // A system note (kind 'note' — Sam's post-call handoff — or kind
  // 'suggestion' — a draft bot suggestion) carries no dir: it is not
  // an inbound seller text, so it must never bump unread, never be
  // the thread preview, and never look like an unanswered inbound.
  // Only real texts default to dir 'in'.
  const isNote = m.kind === 'note' || m.kind === 'suggestion';
  if (!m.dir && !isNote) m.dir = 'in';
  thread.messages.push(m);
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  thread.updatedAt = Date.now();
  if (m.dir === 'in' && !isNote) thread.unread = (thread.unread || 0) + 1;
  await writeJson(cs, thread.key, thread);
  const idx = (await readJson(cs, 'index')) || { updatedAt: 0, threads: {} };
  if (!idx.threads || typeof idx.threads !== 'object') idx.threads = {};
  // Preview/lastDir come from the last REAL message, never a note —
  // a Sam note must never become the thread preview in the list.
  let last = null;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const cand = thread.messages[i];
    if (cand && cand.kind !== 'note' && cand.kind !== 'suggestion') {
      last = cand;
      break;
    }
  }
  idx.threads[thread.key] = {
    phone: thread.phone,
    name: thread.name || '',
    market: thread.market || '',
    preview: last ? String(last.body || '').slice(0, 120) : '',
    lastAt: last ? last.at : thread.updatedAt || 0,
    lastDir: last ? last.dir : null,
    unread: thread.unread || 0,
  };
  idx.updatedAt = Date.now();
  await writeJson(cs, 'index', idx);
  return thread;
}

module.exports = {
  CONV_STORE,
  ENROLL_STORE,
  convStore,
  enrollStore,
  readJson,
  writeJson,
  loadThread,
  loadEnrollment,
  appendThreadMessage,
  phoneKey: lib.phoneKey,
  digitsOnly: lib.digitsOnly,
};

// Test hooks (not part of the deployed surface).
module.exports._test = {
  setStoreFactory(fn) {
    deps.storeFactory = typeof fn === 'function' ? fn : null;
  },
  reset() {
    deps.storeFactory = null;
  },
};

// netlify/functions/cc-tasks-api.js
// Server-backed Tasks for contacts.html (Nov 27, 2026).
//
// The gap (Nov 27 audit): Tasks lived in localStorage only — the
// page itself disclosed "the Command Center has no task backend
// yet" — so a task added on Troy's phone never appeared on his Mac.
// Tasks now live in a Blobs store (one JSON doc, same pattern as
// lib-client-status.js / lib-client-brand.js) and the page
// write-throughs every mutation to the server, keeping localStorage
// as the instant cache. On load the page reconciles: local-only
// tasks (created while the server was unreachable) are uploaded
// first, then the server list replaces the cache.
//
// Auth: the dashboard lm_auth HMAC cookie — the SAME check as
// client-admin.js / buyer-verify.js. Every action requires it;
// contacts.html already shows its auth banner on 401/403.
//
// Actions (?action=):
//   list     GET  -> { ok:true, tasks:[...] }
//   add      POST { task: { id?, contactId, contactName, title, due } }
//                  -> { ok:true, task, tasks:[...] }
//                  The client passes its own id (assigned at creation
//                  so the instant local paint and the server agree);
//                  an id that already exists is returned as-is
//                  (idempotent retry), never duplicated.
//   set-done POST { id, done } -> { ok:true, task, tasks:[...] }
//   delete   POST { id }        -> { ok:true, tasks:[...] }
// Every write returns the full updated list so the client can
// replace its cache with the server truth in one round trip.
//
// Writes are merge-atomic (re-read immediately before writing) so
// a concurrent write from another device is not wiped.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'cc-tasks';
const TASKS_KEY = 'tasks';

const COOKIE_NAME = 'lm_auth';
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
// Admin auth: the dashboard lm_auth HMAC cookie — the SAME check as
// client-admin.js / buyer-verify.js.
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false;
  const headers = (event && event.headers) || {};
  const cookieHeader = headers.cookie || headers.Cookie || '';
  const cookie = getCookie(cookieHeader, COOKIE_NAME);
  if (!cookie) return false;
  const [expiry, sig] = cookie.split('.');
  if (!expiry || !sig) return false;
  const exp = parseInt(expiry, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(expiry).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let storeFactory = null; // tests only
function openStore(event) {
  if (storeFactory) return storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
}

async function readDoc(s) {
  try {
    const v = await s.get(TASKS_KEY, { type: 'json' });
    if (v && Array.isArray(v.tasks)) return { tasks: v.tasks, updatedAt: v.updatedAt || 0 };
  } catch (e) { /* fall through to empty */ }
  return { tasks: [], updatedAt: 0 };
}

async function writeDoc(s, tasks) {
  await s.set(
    TASKS_KEY,
    JSON.stringify({ tasks, updatedAt: Date.now() }),
    { contentType: 'application/json' }
  );
}

function cleanTask(t) {
  if (!t || typeof t !== 'object') return null;
  const title = String(t.title || '').trim();
  if (!title) return null;
  return {
    id: String(t.id || crypto.randomUUID()),
    contactId: String(t.contactId || ''),
    contactName: String(t.contactName || ''),
    title: title.slice(0, 200),
    due: String(t.due || ''),
    done: t.done === true,
    doneAt: t.done === true ? (typeof t.doneAt === 'number' ? t.doneAt : Date.now()) : null,
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: JSON_HEADERS, body: '' };
  if (!isAdmin(event)) {
    return json(401, { ok: false, error: 'Not signed in — open the dashboard and sign in first.' });
  }
  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'list';
  let store;
  try {
    store = openStore(event);
  } catch (e) {
    return json(503, { ok: false, error: 'task store is not ready yet', detail: String((e && e.message) || e) });
  }
  try {
    if (action === 'list') {
      const doc = await readDoc(store);
      return json(200, { ok: true, tasks: doc.tasks });
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: action + ' requires POST' });
    }
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { ok: false, error: 'invalid JSON body' });
    }
    if (action === 'add') {
      const task = cleanTask(body.task);
      if (!task) return json(400, { ok: false, error: 'task title is required' });
      // Merge-atomic: read immediately before writing, so a
      // concurrent write from another device is not wiped.
      const fresh = await readDoc(store);
      const existing = fresh.tasks.find((t) => t.id === task.id);
      if (existing) return json(200, { ok: true, task: existing, tasks: fresh.tasks, duplicate: true });
      fresh.tasks.push(task);
      await writeDoc(store, fresh.tasks);
      return json(200, { ok: true, task, tasks: fresh.tasks });
    }
    if (action === 'set-done') {
      const id = String(body.id || '');
      if (!id) return json(400, { ok: false, error: 'id is required' });
      const fresh = await readDoc(store);
      const found = fresh.tasks.find((t) => t.id === id);
      if (!found) return json(404, { ok: false, error: 'task not found' });
      found.done = body.done === true;
      found.doneAt = found.done ? Date.now() : null;
      await writeDoc(store, fresh.tasks);
      return json(200, { ok: true, task: found, tasks: fresh.tasks });
    }
    if (action === 'delete') {
      const id = String(body.id || '');
      if (!id) return json(400, { ok: false, error: 'id is required' });
      const fresh = await readDoc(store);
      const before = fresh.tasks.length;
      fresh.tasks = fresh.tasks.filter((t) => t.id !== id);
      if (fresh.tasks.length === before) return json(404, { ok: false, error: 'task not found' });
      await writeDoc(store, fresh.tasks);
      return json(200, { ok: true, tasks: fresh.tasks });
    }
    return json(400, { ok: false, error: 'unknown action: ' + action });
  } catch (e) {
    return json(500, { ok: false, error: 'cc-tasks-api failed', detail: String((e && e.message) || e).slice(0, 200) });
  }
};

module.exports._test = {
  setStoreFactory(fn) {
    storeFactory = fn || null;
  },
  reset() {
    storeFactory = null;
  },
};

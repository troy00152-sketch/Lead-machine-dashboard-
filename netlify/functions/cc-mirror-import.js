// netlify/functions/cc-mirror-import.js
// One-shot HL → Command Center history import (Nov 27, 2026 mirror fix).
//
// The Conversations screen promises "mirrored from the CRM", but the
// cc-conversations Blobs store only ever held messages that arrived on
// the five new Telnyx numbers (Nov 25/26) — HighLevel's ~10,000 existing
// conversations were never imported. This endpoint merges an exported
// HL thread batch (see ~/workspace/mirror-import/hl-export-conversations.py)
// into the store so a seller's full history shows in one place.
//
//   POST {action:'import-threads', threads:[{phone, hlConversationId,
//         contactName, messages:[{hlId, dir:'in'|'out', body, at, type}]}]}
//   Header: x-cc-tick-secret: <CC_TICK_SECRET>  (same secret as the
//   watchdog/sweep endpoints; no browser auth — this is a server job.)
//
// Merge rules:
//  - Thread key is the phone digits (same as telnyx-webhook / cc-client).
//  - Only TYPE_SMS messages are merged (emails + opportunity activities
//    are not text history; the exporter already filters, this re-checks).
//  - Dedupe by message id 'hl:<hlId>' — re-running the same batch is a
//    no-op, so the export can resume/overlap safely.
//  - Messages sort by time; a thread caps at 500 (same as the webhook).
//  - Imported history never creates unread — it is read history, not
//    new arrivals. A new thread starts at unread 0.
//  - The thread index preview becomes the newest message body.
'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');

const STORE_NAME = 'cc-conversations';
const INDEX_KEY = 'index';
const MAX_MESSAGES_PER_THREAD = 500;

let storeFactory = null;

function json(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

function store(event) {
  if (storeFactory) return storeFactory();
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
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

async function loadIndex(s) {
  return (await readJson(s, INDEX_KEY)) || { updatedAt: 0, threads: {} };
}

async function loadThread(s, key) {
  const t = await readJson(s, key);
  if (t && Array.isArray(t.messages)) return t;
  return { phone: '+' + key, key, name: '', market: '', unread: 0, updatedAt: 0, messages: [] };
}

async function saveThread(s, thread) {
  await writeJson(s, thread.key, thread);
  const idx = await loadIndex(s);
  const last = thread.messages[thread.messages.length - 1] || null;
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
  await writeJson(s, INDEX_KEY, idx);
}

function importThread(thread, hl) {
  let imported = 0;
  let skipped = 0;
  const seen = new Set(thread.messages.map((m) => m.id));
  for (const m of Array.isArray(hl.messages) ? hl.messages : []) {
    if (m.type && m.type !== 'TYPE_SMS') { skipped += 1; continue; }
    const body = String(m.body || '');
    if (!body.trim()) { skipped += 1; continue; }
    const id = 'hl:' + String(m.hlId || m.id || '');
    if (!m.hlId && !m.id) { skipped += 1; continue; }
    if (seen.has(id)) { skipped += 1; continue; }
    seen.add(id);
    const at = Number(m.at) || 0;
    thread.messages.push({
      id,
      dir: m.dir === 'out' ? 'out' : 'in',
      body: body.slice(0, 4000),
      status: m.dir === 'out' ? 'delivered' : 'received',
      at,
      from: m.dir === 'out' ? '' : thread.phone,
      to: m.dir === 'out' ? thread.phone : '',
      hlConversationId: hl.hlConversationId || null,
    });
    imported += 1;
  }
  thread.messages.sort((a, b) => (a.at || 0) - (b.at || 0));
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  if (hl.contactName && !thread.name) thread.name = hl.contactName;
  const last = thread.messages[thread.messages.length - 1];
  if (last) thread.updatedAt = Math.max(thread.updatedAt || 0, last.at || 0);
  return { imported, skipped };
}

exports.handler = async (event) => {
  try {
    const secret = process.env.CC_TICK_SECRET;
    if (!secret) {
      return json(503, { error: 'CC_TICK_SECRET is not configured — mirror import disabled.' });
    }
    const headers = event.headers || {};
    const provided = headers['x-cc-tick-secret'] || headers['X-Cc-Tick-Secret'] || '';
    if (provided !== secret) {
      return json(401, { error: 'Bad tick secret.' });
    }
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return json(400, { error: 'Invalid JSON body.' });
    }
    if (body.action !== 'import-threads') {
      return json(400, { error: 'Unknown action.' });
    }
    const threads = Array.isArray(body.threads) ? body.threads : [];
    if (!threads.length) return json(400, { error: 'No threads in payload.' });
    if (threads.length > 500) {
      return json(400, { error: 'Max 500 threads per batch — split the export.' });
    }
    const s = store(event);
    let totalImported = 0;
    let totalSkipped = 0;
    let threadsTouched = 0;
    const perThread = [];
    for (const hl of threads) {
      let key = '';
      try {
        key = lib.phoneKey(hl.phone || '');
      } catch (e) {
        key = '';
      }
      if (!key) { totalSkipped += (hl.messages || []).length; continue; }
      const thread = await loadThread(s, key);
      if (!thread.phone || thread.phone === '+' + key) thread.phone = hl.phone;
      const r = importThread(thread, hl);
      if (r.imported > 0) {
        await saveThread(s, thread);
        threadsTouched += 1;
      }
      totalImported += r.imported;
      totalSkipped += r.skipped;
      perThread.push({ phone: thread.phone, imported: r.imported, skipped: r.skipped });
    }
    return json(200, {
      ok: true,
      threadsReceived: threads.length,
      threadsTouched,
      imported: totalImported,
      skipped: totalSkipped,
      perThread,
    });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  setStoreFactory(fn) {
    storeFactory = fn;
  },
  importThread,
};

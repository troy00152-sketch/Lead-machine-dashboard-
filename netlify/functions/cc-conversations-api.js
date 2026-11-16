// netlify/functions/cc-conversations-api.js
// Authenticated API behind the standalone Command Center's Conversations
// screen (Phase 2/4 of the HighLevel mirror build). Reads and writes the
// 'cc-conversations' Blobs store maintained by telnyx-webhook.js.
//
// Routing (same action pattern as the other dashboard functions):
//   GET  ?action=threads[&market=indianapolis]   thread list (index),
//                                                newest activity first
//   GET  ?action=thread&phone=<digits|e164>      one thread; marks it read
//   POST {action:'send', phone, body, market?}   manual outbound SMS via
//                                                telnyx-lib; stored as
//                                                'queued', the webhook
//                                                moves it sent/delivered/
//                                                failed
//   GET  ?action=stats                           today's queue stats per
//                                                market (America/New_York):
//                                                {sent, queued, failed,
//                                                replies} + totals
//
// ALL actions require the dashboard lm_auth cookie (verified in-function,
// same HMAC as gate.ts / buyer-verify.js).
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const lib = require('./telnyx-lib');

const STORE_NAME = 'cc-conversations';
const INDEX_KEY = 'index';
const COOKIE_NAME = 'lm_auth';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
function serverError(msg) {
  return json(503, { error: 'Conversations storage is not ready yet', detail: msg });
}

// ---- admin auth: verify the dashboard lm_auth cookie (same HMAC as gate.ts) ----
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false;
  const headers = event.headers || {};
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

// ---- store ----
let storeFactory = null;
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

// Calendar date (YYYY-MM-DD) of a timestamp in America/New_York — the
// "today" the Conversations header cards count against.
function etDateString(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) return unauth();

    const params = event.queryStringParameters || {};
    let body = {};
    if (event.body) {
      try { body = JSON.parse(event.body); } catch (e) { return bad('Bad JSON body.'); }
    }
    const action = params.action || body.action || 'threads';
    const s = store(event);

    if (action === 'threads') {
      const market = cleanStr(params.market || body.market, 40).toLowerCase();
      const idx = await loadIndex(s);
      let list = Object.entries(idx.threads).map(([key, t]) => ({ key, ...t }));
      if (market) list = list.filter((t) => (t.market || '') === market);
      list.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      const unreadTotal = list.reduce((n, t) => n + (t.unread || 0), 0);
      return ok({ threads: list, count: list.length, unreadTotal });
    }

    if (action === 'thread') {
      const rawPhone = params.phone || body.phone;
      if (!rawPhone) return bad('Missing phone.');
      let key;
      try {
        key = lib.phoneKey(rawPhone);
      } catch (e) {
        return bad('Invalid phone number.');
      }
      const thread = await loadThread(s, key);
      const wasUnread = thread.unread || 0;
      if (wasUnread > 0) {
        thread.unread = 0;
        thread.updatedAt = Date.now();
        await saveThread(s, thread);
      }
      return ok({ thread, markedRead: wasUnread });
    }

    if (action === 'send') {
      const rawPhone = body.phone;
      const text = cleanStr(body.body, 1600);
      if (!rawPhone) return bad('Missing phone.');
      if (!text) return bad('Message body is empty.');
      let key;
      let toE164;
      try {
        toE164 = lib.toE164(rawPhone);
        key = lib.phoneKey(rawPhone);
      } catch (e) {
        return bad('Invalid phone number.');
      }
      const thread = await loadThread(s, key);
      thread.phone = toE164;
      const market =
        cleanStr(body.market, 40).toLowerCase() || thread.market || '';
      if (market && !thread.market) thread.market = market;

      // Store first as 'queued' — the Telnyx webhook moves the status to
      // sent/delivered/failed. If the send itself throws (no API key, no
      // numbers yet, Telnyx rejection), the stored message is marked
      // 'failed' with the reason — never silently dropped.
      const msg = {
        id: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        dir: 'out',
        body: text,
        status: 'queued',
        at: Date.now(),
        from: '',
        to: toE164,
      };
      thread.messages.push(msg);
      thread.updatedAt = Date.now();
      await saveThread(s, thread);

      try {
        const sent = await lib.sendSms({ to: toE164, body: text, market: market || undefined });
        msg.id = sent.id || msg.id;
        msg.from = sent.from;
        await saveThread(s, thread);
        return ok({ ok: true, message: msg, segments: sent.segments });
      } catch (e) {
        msg.status = 'failed';
        msg.failureReason = String((e && e.message) || e);
        await saveThread(s, thread);
        return json(502, { error: msg.failureReason, message: msg });
      }
    }

    if (action === 'stats') {
      const today = etDateString(Date.now());
      const idx = await loadIndex(s);
      const perMarket = {};
      const totals = { sent: 0, queued: 0, failed: 0, replies: 0 };
      const bump = (market, field) => {
        const m = market || 'unknown';
        if (!perMarket[m]) perMarket[m] = { sent: 0, queued: 0, failed: 0, replies: 0 };
        perMarket[m][field] += 1;
        totals[field] += 1;
      };
      for (const key of Object.keys(idx.threads)) {
        const thread = await loadThread(s, key);
        for (const m of thread.messages) {
          if (etDateString(m.at) !== today) continue;
          if (m.dir === 'in') bump(thread.market, 'replies');
          else if (m.status === 'delivered' || m.status === 'sent') bump(thread.market, 'sent');
          else if (m.status === 'queued') bump(thread.market, 'queued');
          else if (m.status === 'failed') bump(thread.market, 'failed');
        }
      }
      return ok({ date: today, perMarket, totals });
    }

    return bad('Unknown action.');
  } catch (e) {
    return serverError(String((e && e.message) || e));
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  etDateString,
  setStoreFactory(fn) {
    storeFactory = fn;
  },
};

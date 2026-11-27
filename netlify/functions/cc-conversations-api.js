// netlify/functions/cc-conversations-api.js
// Authenticated API behind the standalone Command Center's Conversations
// screen (Phase 2/4 of the HighLevel mirror build). Reads and writes the
// 'cc-conversations' Blobs store maintained by telnyx-webhook.js.
//
// Routing (same action pattern as the other dashboard functions):
//   GET  ?action=threads[&market=indianapolis]   thread list (index),
//                                                newest activity first
//   GET  ?action=thread&phone=<digits|e164>      one thread; marks it read;
//                                                the response also carries
//                                                the contact's DND state
//                                                (cc-dnd) as `dnd`
//   POST {action:'dnd-set', phone, channels}     manual DND: set the
//                                                per-channel DND state
//                                                {sms, email, call} on the
//                                                contact (cc-dnd), exactly
//                                                like the HL DND panel
//   POST {action:'send', phone, body, market?}   manual outbound SMS via
//                                                telnyx-lib; stored as
//                                                'queued', the webhook
//                                                moves it sent/delivered/
//                                                failed
//   GET  ?action=numbers                         our Telnyx numbers per
//                                                market (SENDER_POOLS) —
//                                                the dialer pod's
//                                                "call from" switcher
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

// cc-watchdog.js (built in parallel) owns the notification flags the
// Conversations topbar badge reads. Required lazily so this module
// still loads before that file lands; tests inject a fake via
// _test.setWatchdog.
let watchdogOverride = null;
function watchdog() {
  if (watchdogOverride) return watchdogOverride;
  try {
    return require('./cc-watchdog');
  } catch (e) {
    return null;
  }
}

// cc-dnd.js owns the manual per-channel DND state the contact panel
// reads and writes. Same lazy-require + test-override pattern.
let dndOverride = null;
function dnd() {
  if (dndOverride) return dndOverride;
  try {
    return require('./cc-dnd');
  } catch (e) {
    return null;
  }
}

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
const forbidden = () => json(403, { error: 'Calling access only — conversations are not part of the calling login.' });
const ccAuth = require('./cc-auth');
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
  // The list preview is a TEXT preview: a Sam note / draft suggestion
  // (kind 'note' / 'suggestion') is never the preview — the last real
  // message is, even when a note is newer.
  let last = null;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (m && m.kind !== 'note' && m.kind !== 'suggestion') {
      last = m;
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

// Notifications panel: one row per conversation (phone), like GoHighLevel —
// NOT one row per flag. The watchdog can raise several flags for the same
// phone (e.g. an unreplied text + a completed-call entry + a stuck-call
// flag for Paula's number), and the panel showed each as its own row.
// Grouping happens here, server-side, so the page needs no change: the
// grouped row keeps the newest open flag's fields, carries `count` (open
// flags in the group) and `flagIds`, and its `id` is the comma-joined flag
// ids so one X dismiss clears the whole group.
function groupNotifFlags(flags) {
  const byPhone = new Map();
  for (const f of flags || []) {
    // Phone digits FIRST: a stuck-call flag's `key` is the pairing's
    // callControlId (not a phone), so keying on it splits one
    // conversation's flags across junk groups — and the row's key
    // would be unopenable. Fall back to `key` only when no phone.
    // (Nov 27, 2026: when the key itself carries no digits either —
    // an 'engine-stall:<market>' flag has no phone at all — group
    // on the RAW key, so each stalled market gets its own bell row
    // instead of every market collapsing into one 'unknown' group.)
    const key =
      String(f.phone || '').replace(/\D/g, '') ||
      String(f.key || '').replace(/\D/g, '') ||
      String(f.key || '') ||
      'unknown';
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(f);
  }
  const atOf = (f) => (typeof f.flaggedAt === 'number' ? f.flaggedAt : (f.at || 0));
  const groups = [];
  for (const [groupKey, list] of byPhone.entries()) {
    const sorted = list.slice().sort((a, b) => atOf(b) - atOf(a));
    const open = sorted.filter((f) => f.status !== 'resolved');
    const rep = open[0] || sorted[0];
    const ids = sorted.map((f) => f.id).filter(Boolean);
    const preview = String(rep.preview || '');
    groups.push({
      ...rep,
      key: groupKey,
      id: ids.join(','),
      flagIds: ids,
      count: open.length,
      preview: open.length > 1 ? preview + ' · ' + open.length + ' alerts' : preview,
    });
  }
  // Groups with open flags first (newest open first), then resolved-only.
  groups.sort((a, b) => {
    if ((a.count > 0) !== (b.count > 0)) return a.count > 0 ? -1 : 1;
    return atOf(b) - atOf(a);
  });
  return groups;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) return ccAuth.isIrish(event) ? forbidden() : unauth();

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
      // Backfill ourNumber for older records: the number WE texted
      // from is the last inbound message's `to` (they wrote to us on
      // it), else the last outbound message's `from`.
      if (!thread.ourNumber) {
        let found = null;
        for (let i = thread.messages.length - 1; i >= 0 && !found; i--) {
          const m = thread.messages[i];
          if (m.dir === 'in' && m.to) found = m.to;
        }
        for (let i = thread.messages.length - 1; i >= 0 && !found; i--) {
          const m = thread.messages[i];
          if (m.dir === 'out' && m.from) found = m.from;
        }
        thread.ourNumber = found || null;
      }
      // The contact's manual-DND state (cc-dnd) rides along so the
      // contact panel can render the per-channel toggles truthfully.
      // Fail-soft: a DND read failure never breaks the thread view —
      // the panel simply hides until a read succeeds.
      let dndState = null;
      const d = dnd();
      if (d && typeof d.getState === 'function') {
        try {
          dndState = await d.getState(key, event);
        } catch (e) {
          dndState = null;
        }
      }
      return ok({ thread, markedRead: wasUnread, dnd: dndState });
    }

    if (action === 'dnd-set') {
      const rawPhone = body.phone;
      if (!rawPhone) return bad('Missing phone.');
      let key;
      try {
        key = lib.phoneKey(rawPhone);
      } catch (e) {
        return bad('Invalid phone number.');
      }
      if (!body.channels || typeof body.channels !== 'object' || Array.isArray(body.channels)) {
        return bad('Missing channels.');
      }
      const d = dnd();
      if (!d || typeof d.setChannels !== 'function') {
        return serverError('cc-dnd is not available yet.');
      }
      // Only an explicit true turns a channel on — the same
      // normalization cc-dnd.cleanChannels applies.
      const channels = {
        sms: body.channels.sms === true,
        email: body.channels.email === true,
        call: body.channels.call === true,
      };
      const state = await d.setChannels(key, channels, event);
      return ok({ ok: true, dnd: state });
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
        if (sent.from) thread.ourNumber = sent.from;
        await saveThread(s, thread);
        return ok({ ok: true, message: msg, segments: sent.segments });
      } catch (e) {
        msg.status = 'failed';
        msg.failureReason = String((e && e.message) || e);
        await saveThread(s, thread);
        return json(502, { error: msg.failureReason, message: msg });
      }
    }

    if (action === 'numbers') {
      const pools = (lib && lib.SENDER_POOLS) || {};
      const flat = [];
      for (const [market, numbers] of Object.entries(pools)) {
        for (const n of numbers || []) flat.push({ market, number: n });
      }
      return ok({ numbers: pools, flat });
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

    if (action === 'notifications') {
      const wd = watchdog();
      if (!wd || typeof wd.listFlags !== 'function') {
        return serverError('cc-watchdog is not available yet.');
      }
      const result = await wd.listFlags(event);
      const flags = result && Array.isArray(result.flags) ? result.flags : [];
      const grouped = groupNotifFlags(flags);
      // Badge counts grouped rows with open alerts, so it matches the
      // number of rows the panel shows.
      const openCount = grouped.reduce((n, g) => n + (g.count > 0 ? 1 : 0), 0);
      return ok({ flags: grouped, openCount });
    }

    if (action === 'notification-dismiss') {
      const id = body.id || params.id;
      if (!id) return bad('Missing flag id.');
      const wd = watchdog();
      if (!wd || typeof wd.dismissFlag !== 'function') {
        return serverError('cc-watchdog is not available yet.');
      }
      // A grouped row's id is comma-joined flag ids — dismiss them all.
      const ids = String(id).split(',').map((s) => s.trim()).filter(Boolean);
      for (const one of ids) await wd.dismissFlag(one, event);
      return ok({ ok: true, id, dismissed: ids.length });
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
  setWatchdog(wd) {
    watchdogOverride = wd || null;
  },
  setDnd(d) {
    dndOverride = d || null;
  },
};

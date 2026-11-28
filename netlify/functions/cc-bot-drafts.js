// netlify/functions/cc-bot-drafts.js
// Suggest-mode draft store + approve/dismiss API for the text bot
// (Nov 27, 2026 — closes the dead-control gap: conversation-ai
// offered a "Suggest" mode, but the live runner treated Suggest as
// Off + logged 'suggest-mode-unavailable' because no draft-approve
// UI existed anywhere. Now the runner (cc-bot-runner.js) computes
// the reply exactly as Auto would, against in-memory stores, and
// saves it here instead of sending it; this endpoint is the human
// half — list pending drafts, approve (send), dismiss (delete).
//
// Store: Netlify Blobs 'cc-bot-drafts', key 'drafts' (one JSON doc,
// same pattern as cc-tasks-api.js). A draft:
//   { id, threadKey, phone, contactName, sellerMessage,
//     suggestedReply, wouldBook: {startISO, endISO, title} | null,
//     wouldTags: [], wouldSeal: bool, outcome, messageId,
//     createdAt, status: 'pending' | 'sending' | 'sent' | 'dismissed',
//     sentAt, sentMessageId }
//
// Auth: the dashboard lm_auth HMAC cookie — the SAME check as
// cc-tasks-api.js / client-admin.js. Every action requires it.
//
// Actions (?action=):
//   list     GET  -> { ok:true, drafts:[pending, newest first] }
//   approve  POST { id } -> sends the suggested reply, then marks sent.
//   dismiss  POST { id } -> deletes the draft.
//
// Approve sends through the EXISTING send path — CcClient.sendSms,
// the same routine the vendored handler calls for Auto replies
// (thread append + Telnyx send + from-number derivation). There is
// no second sender here. A would-be booking the capture run computed
// is created for real first (CcClient.createAppointment — the same
// routine the handler uses), so the confirmation text never goes out
// for a time that is not held; if the slot is no longer free, or the
// booking fails, NOTHING is sent and the draft stays pending.
// Approve is idempotent: a second approve of a sent draft is a
// no-op reporting alreadySent (no resend, ever). A concurrent double
// tap is claimed first (pending -> 'sending', merge-atomic), so only
// one approve can be in flight; a failed send/booking reverts the
// claim to pending so Troy can retry. A draft never auto-sends.
//
// Writes are merge-atomic (re-read immediately before writing) so a
// concurrent write from another device is not wiped.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'cc-bot-drafts';
const DRAFTS_KEY = 'drafts';
const MAX_TEXT = 2000;

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
// cc-tasks-api.js / client-admin.js.
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
let sendSmsOverride = null; // tests only: injected into the CcClient
let clientStores = null; // tests only: {conversations, enrollments, opportunities, appointments}
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
    const v = await s.get(DRAFTS_KEY, { type: 'json' });
    if (v && Array.isArray(v.drafts)) return { drafts: v.drafts, updatedAt: v.updatedAt || 0 };
  } catch (e) { /* fall through to empty */ }
  return { drafts: [], updatedAt: 0 };
}

async function writeDoc(s, drafts) {
  await s.set(
    DRAFTS_KEY,
    JSON.stringify({ drafts, updatedAt: Date.now() }),
    { contentType: 'application/json' }
  );
}

function cleanText(v) {
  const s = String(v == null ? '' : v);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}
function cleanWouldBook(v) {
  if (!v || typeof v !== 'object') return null;
  const startISO = String(v.startISO || v.startTime || '');
  const endISO = String(v.endISO || v.endTime || '');
  if (!startISO || !Number.isFinite(Date.parse(startISO))) return null;
  return {
    startISO,
    endISO: endISO || '',
    title: String(v.title || '').slice(0, 200),
  };
}
function cleanDraft(t) {
  if (!t || typeof t !== 'object') return null;
  const suggestedReply = cleanText(t.suggestedReply).trim();
  if (!suggestedReply) return null;
  const threadKey = String(t.threadKey || t.contactId || '').replace(/\D/g, '');
  if (!threadKey) return null;
  return {
    id: String(t.id || crypto.randomUUID()),
    threadKey,
    phone: String(t.phone || ('+' + threadKey)),
    contactName: String(t.contactName || '').slice(0, 120),
    sellerMessage: cleanText(t.sellerMessage).trim(),
    suggestedReply,
    wouldBook: cleanWouldBook(t.wouldBook),
    wouldTags: (Array.isArray(t.wouldTags) ? t.wouldTags : [])
      .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20),
    wouldSeal: t.wouldSeal === true,
    outcome: String(t.outcome || ''),
    messageId: t.messageId != null ? String(t.messageId) : null,
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
    status: 'pending',
    sentAt: null,
    sentMessageId: null,
  };
}

// saveDraft(event, fields) -> the saved draft. Used by cc-bot-runner
// (Suggest capture). Merge-atomic append; an id that already exists
// is returned as-is (idempotent retry), never duplicated. Throws on
// store failure — the runner catches it and fails soft (no send).
async function saveDraft(event, fields) {
  const draft = cleanDraft(fields);
  if (!draft) throw new Error('draft needs a threadKey and a non-empty suggestedReply');
  const s = openStore(event);
  const fresh = await readDoc(s);
  const existing = fresh.drafts.find((d) => d.id === draft.id);
  if (existing) return existing;
  fresh.drafts.push(draft);
  await writeDoc(s, fresh.drafts);
  return draft;
}

async function listPendingDrafts(event) {
  const s = openStore(event);
  const doc = await readDoc(s);
  return doc.drafts
    .filter((d) => d && d.status === 'pending')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function getDraft(event, id) {
  const s = openStore(event);
  const doc = await readDoc(s);
  return doc.drafts.find((d) => d && String(d.id) === String(id)) || null;
}

// Merge-atomic status claim: pending -> 'sending'. Returns
// {ok:true, draft} on claim, {ok:false, current} when the draft is
// no longer pending (already sent / being sent / dismissed).
async function claimDraft(event, id) {
  const s = openStore(event);
  const fresh = await readDoc(s);
  const draft = fresh.drafts.find((d) => d && String(d.id) === String(id));
  if (!draft) return { ok: false, current: null };
  if (draft.status !== 'pending') return { ok: false, current: draft.status };
  draft.status = 'sending';
  draft.sentAttemptAt = Date.now();
  await writeDoc(s, fresh.drafts);
  return { ok: true, draft };
}

// Merge-atomic status write after a claim. Best-effort: a failure
// here must never mask a send that already landed.
async function setDraftStatus(event, id, status, extra) {
  try {
    const s = openStore(event);
    const fresh = await readDoc(s);
    const draft = fresh.drafts.find((d) => d && String(d.id) === String(id));
    if (!draft) return null;
    draft.status = status;
    if (extra && typeof extra === 'object') Object.assign(draft, extra);
    if (status === 'pending') delete draft.sentAttemptAt;
    await writeDoc(s, fresh.drafts);
    return draft;
  } catch (e) {
    return null;
  }
}

function buildClient(event) {
  const mod = require('./cc-client');
  const opts = { event };
  if (clientStores) Object.assign(opts, clientStores);
  if (sendSmsOverride) opts.sendSms = sendSmsOverride;
  return new mod.CcClient(opts);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Approve: claim -> book the would-be slot for real (if any) ->
// apply the would-be tags/seal -> send via CcClient.sendSms ->
// mark sent. Any failure before the send reverts the claim to
// pending and sends nothing.
async function approveDraft(event, id) {
  const claimed = await claimDraft(event, id);
  if (!claimed.ok) {
    if (claimed.current === null) return { status: 404, body: { ok: false, error: 'draft not found' } };
    if (claimed.current === 'sent') {
      const draft = await getDraft(event, id);
      return { status: 200, body: { ok: true, draft, alreadySent: true } };
    }
    return { status: 409, body: { ok: false, error: 'draft is already being sent — try again in a moment' } };
  }
  const draft = claimed.draft;
  const revert = () => setDraftStatus(event, id, 'pending', { sentAttemptAt: null });
  let client;
  try {
    client = buildClient(event);
  } catch (e) {
    await revert();
    return { status: 503, body: { ok: false, error: 'send path is not ready yet', detail: String((e && e.message) || e).slice(0, 200) } };
  }
  // 1) Would-be booking: the slot must still be free, then it is
  // created for real (CcClient.createAppointment — the same routine
  // the handler uses for Auto bookings, HL calendar sync included).
  // A stale slot, or a booking failure, sends NOTHING.
  let appointment = null;
  if (draft.wouldBook && draft.wouldBook.startISO) {
    const startMs = Date.parse(draft.wouldBook.startISO);
    const endMs = draft.wouldBook.endISO ? Date.parse(draft.wouldBook.endISO) : startMs + 30 * 60 * 1000;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      await revert();
      return { status: 409, body: { ok: false, error: 'draft booking time is invalid — nothing sent' } };
    }
    try {
      const appts = require('./cc-appointments');
      const held = await appts.listAppointments({ fromMs: startMs, toMs: endMs }, event);
      const clash = (held || []).some((r) => {
        if (!r) return false;
        const st = String(r.status || '').trim().toLowerCase();
        if (!st || st === 'cancelled' || st === 'invalid') return false;
        const rs = r.startMs != null ? r.startMs : Date.parse(r.startISO || r.startTime || '');
        const re = r.endMs != null ? r.endMs : Date.parse(r.endISO || r.endTime || '');
        if (!Number.isFinite(rs) || !Number.isFinite(re)) return false;
        return overlaps(startMs, endMs, rs, re);
      });
      if (clash) {
        await revert();
        return { status: 409, body: { ok: false, error: 'That call time is no longer free — nothing sent. Dismiss this draft or wait for a fresh one.' } };
      }
    } catch (e) {
      // A slot re-check failure fails CLOSED: never confirm a time
      // we could not verify is free.
      await revert();
      return { status: 503, body: { ok: false, error: 'Could not verify the call time is still free — nothing sent', detail: String((e && e.message) || e).slice(0, 200) } };
    }
    try {
      appointment = await client.createAppointment({
        contactId: draft.threadKey,
        startISO: draft.wouldBook.startISO,
        endISO: draft.wouldBook.endISO || new Date(endMs).toISOString(),
        title: draft.wouldBook.title || ('Seller call — ' + (draft.contactName || 'seller')),
      });
    } catch (e) {
      await revert();
      return { status: 409, body: { ok: false, error: 'Could not book that call time — nothing sent', detail: String((e && e.message) || e).slice(0, 200) } };
    }
  }
  // 2) Would-be tags / seal the capture run computed (e.g. the
  // appointment-reply tag). Applied through the same CcClient
  // routines the handler uses — never a direct store write here.
  try {
    if (draft.wouldSeal) await client.setDnd(draft.threadKey);
    const tags = [];
    if (draft.wouldSeal && !(draft.wouldTags || []).map((t) => String(t).toLowerCase()).includes('dnc')) tags.push('dnc');
    for (const t of draft.wouldTags || []) tags.push(t);
    if (tags.length) await client.addTags(draft.threadKey, tags);
  } catch (e) {
    await revert();
    return { status: 502, body: { ok: false, error: 'Could not apply the draft actions — nothing sent', detail: String((e && e.message) || e).slice(0, 200) } };
  }
  // 3) The send itself — CcClient.sendSms, the same routine the
  // vendored handler calls for Auto replies.
  let sent;
  try {
    sent = await client.sendSms({
      contactId: draft.threadKey,
      conversationId: draft.threadKey,
      message: draft.suggestedReply,
    });
  } catch (e) {
    await revert();
    return { status: 502, body: { ok: false, error: 'Send failed — nothing was delivered, draft is still pending', detail: String((e && e.message) || e).slice(0, 200) } };
  }
  const marked = await setDraftStatus(event, id, 'sent', {
    sentAt: Date.now(),
    sentMessageId: (sent && sent.id) || null,
    appointmentId: appointment ? appointment.id : null,
  });
  return { status: 200, body: { ok: true, draft: marked || { ...draft, status: 'sent', sentAt: Date.now(), sentMessageId: (sent && sent.id) || null }, sent: true, appointmentId: appointment ? appointment.id : null } };
}

async function dismissDraft(event, id) {
  const s = openStore(event);
  const fresh = await readDoc(s);
  const draft = fresh.drafts.find((d) => d && String(d.id) === String(id));
  if (!draft) return { status: 404, body: { ok: false, error: 'draft not found' } };
  if (draft.status === 'sent') return { status: 409, body: { ok: false, error: 'draft was already sent — it cannot be dismissed' } };
  if (draft.status === 'sending') return { status: 409, body: { ok: false, error: 'draft is being sent right now — try again in a moment' } };
  fresh.drafts = fresh.drafts.filter((d) => d && String(d.id) !== String(id));
  await writeDoc(s, fresh.drafts);
  const pending = fresh.drafts.filter((d) => d && d.status === 'pending')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { status: 200, body: { ok: true, drafts: pending } };
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
    return json(503, { ok: false, error: 'draft store is not ready yet', detail: String((e && e.message) || e) });
  }
  try {
    if (action === 'list') {
      const doc = await readDoc(store);
      const pending = doc.drafts
        .filter((d) => d && d.status === 'pending')
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json(200, { ok: true, drafts: pending });
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
    if (action === 'approve') {
      const id = String(body.id || '');
      if (!id) return json(400, { ok: false, error: 'id is required' });
      const r = await approveDraft(event, id);
      return json(r.status, r.body);
    }
    if (action === 'dismiss') {
      const id = String(body.id || '');
      if (!id) return json(400, { ok: false, error: 'id is required' });
      const r = await dismissDraft(event, id);
      return json(r.status, r.body);
    }
    return json(400, { ok: false, error: 'unknown action: ' + action });
  } catch (e) {
    return json(500, { ok: false, error: 'cc-bot-drafts failed', detail: String((e && e.message) || e).slice(0, 200) });
  }
};

module.exports = {
  handler: exports.handler,
  saveDraft,
  listPendingDrafts,
  getDraft,
  STORE_NAME,
  DRAFTS_KEY,
  cleanDraft,
};

module.exports._test = {
  setStoreFactory(fn) {
    storeFactory = fn || null;
  },
  setSendSms(fn) {
    sendSmsOverride = fn || null;
  },
  setClientStores(stores) {
    clientStores = stores || null;
  },
  reset() {
    storeFactory = null;
    sendSmsOverride = null;
    clientStores = null;
  },
};

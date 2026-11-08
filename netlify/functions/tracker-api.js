// netlify/functions/tracker-api.js
// Closing Tracker API — the closing board for the dashboard page
// (/closing-tracker.html). Blobs-backed CRUD for under-contract deals,
// mirroring the Muse-space Closing Tracker (slug closing-tracker) so the
// dashboard page can replace it. Troy-side only: every action requires
// the dashboard lm_auth cookie (same HMAC check as deals-api.js /
// gate.ts). No public actions — the board is owner-only.
//
// Data model (Blobs store 'closing-tracker'):
//   deal:{id}   -> JSON deal {id, address, city, state, zip, seller,
//                  market, contractPrice, emdAmount, contractDate,
//                  closingDate, apn, legalDescription, titleCompany,
//                  titlePhone, titleEmail, emdStatus, status,
//                  titleOrderSentAt, titleOrderSentTo,
//                  milestones:[{id, label, done, dueDate}],
//                  createdAt, updatedAt}
//   deal:index  -> {ids: [...]}
//
// Routing: single function, `action` in the query string (GET) or JSON
// body (POST). All actions are ADMIN (lm_auth cookie required):
//   GET  ?action=getBoard                 full board, newest first
//   POST {action:'createDeal', ...fields} create deal -> {id}; seeds the
//                                          6 standard TC milestones
//   POST {action:'updateDeal', id, ...}   update deal fields
//   POST {action:'deleteDeal', id}        delete deal + milestones
//   POST {action:'markTitleOrderSent', id, to}
//                                          stamp titleOrderSentAt/To
//   POST {action:'addMilestone', id, label, dueDate?}
//   POST {action:'setMilestoneDone', id, milestoneId, done}
//   POST {action:'deleteMilestone', id, milestoneId}
//   POST {action:'updateMilestone', id, milestoneId, label, dueDate}
//   POST {action:'setEmdStatus', id, emdStatus}
//   POST {action:'setDealStatus', id, status}
//
// Title companies are resolved server-side from the market key using the
// same defaults as ~/workspace/title-companies/defaults.md (the source of
// truth). Market keys: indianapolis, cleveland, kansas_city, greenville,
// jacksonville, dayton, charlotte. (NOTE: carolina sms -> greenville, NOT
// Charlotte — Charlotte/Harry Marsh is manual-only, no tag.)
//
// CREDIT NOTES: Blobs only, no Netlify Database. No lookups of any kind —
// this function never calls PropertyReach, ATTOM, or DealMachine.
'use strict';

const crypto = require('crypto');

let blobs = null;
try {
  // Installed via package.json. Netlify injects site credentials at runtime;
  // connectLambda(event) hydrates them for v1 (exports.handler) functions.
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'closing-tracker';
const COOKIE_NAME = 'lm_auth';

// ---- title companies (mirror of ~/workspace/title-companies/defaults.md) ----
const TITLE_COMPANIES = {
  indianapolis: {
    market: 'Indianapolis, IN',
    company: 'Hocker Title (Hocker & Associates)',
    phone: '(317) 578-1630',
    emailOrders: 'contracts@hockerlaw.com',
  },
  cleveland: {
    market: 'Cleveland, OH',
    company: 'Ohio Real Title Agency',
    phone: '(216) 373-9900',
    emailOrders: 'info@ohiorealtitle.com',
  },
  kansas_city: {
    market: 'Kansas City, MO/KS',
    company: 'Clear Title Nationwide',
    phone: '(816) 251-4590',
    emailOrders: 'orders@mycleartitle.com',
  },
  greenville: {
    market: 'Greenville, NC (Pitt County)',
    company: 'Innovative Closing Solutions',
    phone: '336-793-1953',
    emailOrders: 'orders@innovativeclosingsolutions.com',
  },
  jacksonville: {
    market: 'Jacksonville, FL',
    company: 'Title Company of Florida',
    phone: '904-938-4853',
    emailOrders: 'orders@titlecompanyofflorida.com',
  },
  dayton: {
    market: 'Dayton, OH',
    company: 'CLOSED Title',
    phone: '800-405-7150',
    emailOrders: 'order@closedtitle.com',
  },
  charlotte: {
    market: 'Charlotte, NC',
    company: 'Harry Marsh Law',
    phone: '(704) 743-6387',
    emailOrders: 'Closings@HarryMarshLaw.com',
  },
};

// The 6 standard TC milestones seeded on every new deal (same list as the
// Muse-space tracker and the tc-kickoff cron).
const STANDARD_MILESTONES = [
  'Title opened — contract sent to title company',
  'EMD collected and confirmed at title',
  'Title commitment received and reviewed',
  'Assignment / buyer docs ready',
  'Clear to close confirmed',
  'Closing scheduled and funded',
];

const EMD_STATUSES = ['not due', 'due', 'sent', 'confirmed at title'];
const DEAL_STATUSES = ['under contract', 'closing', 'closed', 'dead'];

// ---- responses ----
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
const notFound = (msg) => json(404, { error: msg || 'Not found' });
function serverError(msg) {
  return json(503, {
    error: 'Closing Tracker storage is not ready yet',
    detail: msg,
    setup: 'Deploy with the @netlify/blobs dependency installed (package.json) and redeploy.',
  });
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
  if (!secret) return false; // fail closed — gate.ts 503s without it too
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

// ---- blob store ----
function store(event) {
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) {
    // connectLambda is best-effort; getStore may still work if the
    // runtime injected NETLIFY_BLOBS_CONTEXT ambiently.
  }
  return blobs.getStore(STORE_NAME);
}

async function readJson(s, key, fallback) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

const dealKey = (id) => `deal:${id}`;

function newId(prefix, bytes) {
  return prefix + crypto.randomBytes(bytes).toString('hex');
}
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function cleanNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function cleanDate(v) {
  const s = cleanStr(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function cleanMarket(v) {
  const s = cleanStr(v, 40).toLowerCase().replace(/[\s-]+/g, '_');
  return TITLE_COMPANIES[s] ? s : null;
}
function resolveTitle(market) {
  if (!market) return { titleCompany: null, titlePhone: null, titleEmail: null };
  const t = TITLE_COMPANIES[market];
  if (!t) return { titleCompany: null, titlePhone: null, titleEmail: null };
  return { titleCompany: t.company, titlePhone: t.phone, titleEmail: t.emailOrders };
}
function seedMilestones() {
  return STANDARD_MILESTONES.map((label) => ({
    id: newId('m_', 8),
    label,
    done: false,
    dueDate: null,
  }));
}

async function getIndex(s) {
  let idx = await readJson(s, 'deal:index', null);
  if (idx && Array.isArray(idx.ids)) return idx;
  // rebuild from store listing as a fallback
  const ids = [];
  try {
    const { blobs: entries } = await s.list({ prefix: 'deal:' });
    for (const e of entries || []) {
      const m = /^deal:([^:]+)$/.exec(e.key || '');
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
  } catch (e) { /* ignore */ }
  idx = { ids };
  try { await writeJson(s, 'deal:index', idx); } catch (e) { /* ignore */ }
  return idx;
}
async function indexAdd(s, id) {
  const idx = await getIndex(s);
  if (!idx.ids.includes(id)) {
    idx.ids.push(id);
    await writeJson(s, 'deal:index', idx);
  }
}
async function indexRemove(s, id) {
  const idx = await getIndex(s);
  idx.ids = idx.ids.filter((x) => x !== id);
  await writeJson(s, 'deal:index', idx);
}
async function loadDeal(s, id) {
  if (!id) return null;
  return readJson(s, dealKey(id), null);
}

// ================= ADMIN =================

async function adminGetBoard(s) {
  const idx = await getIndex(s);
  const deals = [];
  for (const id of idx.ids) {
    const d = await loadDeal(s, id);
    if (d) deals.push(d);
  }
  deals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ok({ deals });
}

async function adminCreateDeal(s, body) {
  const address = cleanStr(body.address, 200);
  if (!address) return bad('Address is required.');
  const market = body.market !== undefined ? cleanMarket(body.market) : null;
  if (body.market !== undefined && body.market !== '' && !market) {
    return bad('Unknown market. Pick one of: indianapolis, cleveland, kansas_city, greenville, jacksonville, dayton, charlotte.');
  }
  const now = Date.now();
  const deal = Object.assign(
    {
      id: newId('ct_', 12),
      address,
      city: cleanStr(body.city, 100),
      state: cleanStr(body.state, 20),
      zip: cleanStr(body.zip, 20),
      seller: cleanStr(body.seller, 200),
      market,
      contractPrice: cleanNum(body.contractPrice),
      emdAmount: cleanNum(body.emdAmount),
      contractDate: cleanDate(body.contractDate),
      closingDate: cleanDate(body.closingDate),
      apn: cleanStr(body.apn, 60),
      legalDescription: cleanStr(body.legalDescription, 500),
      emdStatus: 'not due',
      status: 'under contract',
      titleOrderSentAt: null,
      titleOrderSentTo: null,
      milestones: seedMilestones(),
      createdAt: now,
      updatedAt: now,
    },
    resolveTitle(market),
  );
  await writeJson(s, dealKey(deal.id), deal);
  await indexAdd(s, deal.id);
  return ok({ id: deal.id, deal });
}

async function adminUpdateDeal(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  if (body.address !== undefined) {
    const a = cleanStr(body.address, 200);
    if (!a) return bad('Address cannot be empty.');
    d.address = a;
  }
  for (const f of ['city', 'state', 'zip', 'seller', 'apn', 'legalDescription']) {
    if (body[f] !== undefined) d[f] = cleanStr(body[f], f === 'legalDescription' ? 500 : 200);
  }
  for (const f of ['contractPrice', 'emdAmount']) {
    if (body[f] !== undefined) d[f] = cleanNum(body[f]);
  }
  for (const f of ['contractDate', 'closingDate']) {
    if (body[f] !== undefined) d[f] = cleanDate(body[f]);
  }
  if (body.market !== undefined) {
    const m = body.market === '' ? null : cleanMarket(body.market);
    if (body.market !== '' && !m) return bad('Unknown market.');
    d.market = m;
    Object.assign(d, resolveTitle(m));
  }
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true, deal: d });
}

async function adminDeleteDeal(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  try { await s.delete(dealKey(id)); } catch (e) { /* ignore */ }
  await indexRemove(s, id);
  return ok({ ok: true });
}

async function adminMarkTitleOrderSent(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  const to = cleanStr(body.to, 200).toLowerCase();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return bad('A valid recipient email is required to stamp the send.');
  }
  d.titleOrderSentAt = new Date().toISOString();
  d.titleOrderSentTo = to;
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true, titleOrderSentAt: d.titleOrderSentAt, titleOrderSentTo: d.titleOrderSentTo });
}

async function adminAddMilestone(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  const label = cleanStr(body.label, 200);
  if (!label) return bad('Milestone label is required.');
  const m = {
    id: newId('m_', 8),
    label,
    done: false,
    dueDate: cleanDate(body.dueDate),
  };
  d.milestones = Array.isArray(d.milestones) ? d.milestones : [];
  d.milestones.push(m);
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true, milestone: m });
}

async function adminSetMilestoneDone(s, body) {
  const id = cleanStr(body.id, 64);
  const milestoneId = cleanStr(body.milestoneId, 64);
  if (!id || !milestoneId) return bad('Missing id or milestoneId.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  const m = (d.milestones || []).find((x) => x.id === milestoneId);
  if (!m) return notFound('Milestone not found.');
  m.done = body.done === true || body.done === 'true';
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true });
}

async function adminDeleteMilestone(s, body) {
  const id = cleanStr(body.id, 64);
  const milestoneId = cleanStr(body.milestoneId, 64);
  if (!id || !milestoneId) return bad('Missing id or milestoneId.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  const before = (d.milestones || []).length;
  d.milestones = (d.milestones || []).filter((x) => x.id !== milestoneId);
  if (d.milestones.length === before) return notFound('Milestone not found.');
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true });
}

async function adminUpdateMilestone(s, body) {
  const id = cleanStr(body.id, 64);
  const milestoneId = cleanStr(body.milestoneId, 64);
  if (!id || !milestoneId) return bad('Missing id or milestoneId.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  const m = (d.milestones || []).find((x) => x.id === milestoneId);
  if (!m) return notFound('Milestone not found.');
  if (body.label !== undefined) {
    const label = cleanStr(body.label, 200);
    if (!label) return bad('Milestone label cannot be empty.');
    m.label = label;
  }
  if (body.dueDate !== undefined) m.dueDate = cleanDate(body.dueDate);
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true });
}

async function adminSetEmdStatus(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  const v = cleanStr(body.emdStatus, 40);
  if (!EMD_STATUSES.includes(v)) return bad('Unknown EMD status.');
  d.emdStatus = v;
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true });
}

async function adminSetDealStatus(s, body) {
  const id = cleanStr(body.id, 64);
  if (!id) return bad('Missing id.');
  const d = await loadDeal(s, id);
  if (!d) return notFound('Deal not found.');
  const v = cleanStr(body.status, 40);
  if (!DEAL_STATUSES.includes(v)) return bad('Unknown deal status.');
  d.status = v;
  d.updatedAt = Date.now();
  await writeJson(s, dealKey(id), d);
  return ok({ ok: true });
}

// ================= HANDLER =================

const ADMIN_ACTIONS = new Set([
  'getBoard', 'createDeal', 'updateDeal', 'deleteDeal', 'markTitleOrderSent',
  'addMilestone', 'setMilestoneDone', 'deleteMilestone', 'updateMilestone',
  'setEmdStatus', 'setDealStatus',
]);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  }

  let s;
  try {
    s = store(event);
  } catch (e) {
    return serverError(e.message);
  }

  const qs = event.queryStringParameters || {};
  let action = qs.action || '';
  let body = {};
  if (event.httpMethod === 'POST') {
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return bad('Request body must be JSON.');
    }
    action = body.action || action;
  }
  action = String(action);

  try {
    if (!ADMIN_ACTIONS.has(action)) {
      return bad('Unknown action. Pass ?action=getBoard (GET) or {action:...} (POST).');
    }
    if (!isAdmin(event)) return unauth();
    switch (action) {
      case 'getBoard': return await adminGetBoard(s);
      case 'createDeal': return await adminCreateDeal(s, body);
      case 'updateDeal': return await adminUpdateDeal(s, body);
      case 'deleteDeal': return await adminDeleteDeal(s, body);
      case 'markTitleOrderSent': return await adminMarkTitleOrderSent(s, body);
      case 'addMilestone': return await adminAddMilestone(s, body);
      case 'setMilestoneDone': return await adminSetMilestoneDone(s, body);
      case 'deleteMilestone': return await adminDeleteMilestone(s, body);
      case 'updateMilestone': return await adminUpdateMilestone(s, body);
      case 'setEmdStatus': return await adminSetEmdStatus(s, body);
      case 'setDealStatus': return await adminSetDealStatus(s, body);
      default: return bad('Unknown action.');
    }
  } catch (err) {
    console.error('[tracker-api]', action, err.message);
    return json(500, { error: 'Closing Tracker hit a snag', detail: String(err.message || err).slice(0, 200) });
  }
};

// Offline sanity checks (no network): node -e "const t=require('./tracker-api.js'); console.log(typeof t.handler)"

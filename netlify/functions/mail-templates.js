// netlify/functions/mail-templates.js
// Template picker backend for the Command Center direct-mail build.
//
// The active postcard template is stored SERVER-SIDE in the Netlify Blobs
// store 'direct-mail-templates' (key 'templates.json'), never in browser
// localStorage (Troy's rule: no keys/config in the browser). Built-in
// designs live in ./mail-templates-data.js; custom designs Troy supplies
// (his own front/back artwork) are stored as Blobs records.
//
// Endpoints (all JSON):
//   GET  ?action=list
//        -> { templates: [{id,name,blurb,sizes,builtin}], activeId }
//        No auth: returns design metadata + preview HTML only, no secrets.
//   GET  ?action=preview&templateId=..&size=4x6
//        [&ownerName=..&propertyAddress=..&cityStateZip=..]
//        -> { front, back } rendered HTML for the confirm-sheet preview.
//        Built-ins render with the caller's merge vars (or samples);
//        customs return their stored front/back as-is.
//   POST { action: 'setActive', templateId }            (admin)
//   POST { action: 'addCustom', name, front, back }     (admin)
//   POST { action: 'removeCustom', templateId }         (admin)
//
// Admin auth = the dashboard lm_auth cookie (same HMAC check as
// title-order-email.js / buyer-verify.js) OR Authorization: Bearer
// <dashboard password>. Mutations without it fail closed (401).
//
// Custom design sources (see mail-templates-data.js validateCustomSource):
//   - PostGrid template id (template_...) — merge vars passed at send time.
//   - https URL to a 2-page PDF — sent to PostGrid as the order's pdf.
//   - https URL to a PNG/JPG — wrapped in full-bleed HTML at send time.
//   - Raw HTML starting with '<' — sent to PostGrid as the artwork.
// A custom design has the same front+back for every size (PostGrid renders
// the artwork to the chosen size); the picker still lets Troy choose 4x6/6x9.
//
// No PostGrid calls are made here. No money moves here. No keys in this file.
'use strict';

const crypto = require('crypto');
const data = require('./mail-templates-data.js');

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null; // local / test env without node_modules: mutations fail closed
}

const STORE_NAME = 'direct-mail-templates';
const STATE_KEY = 'templates.json';
const COOKIE_NAME = 'lm_auth';
const DEFAULT_ACTIVE_ID = 'cash-offer';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const ok = (obj) => json(200, obj);
const bad = (msg) => json(400, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
const unavailable = (msg) =>
  json(503, { error: msg || 'Template storage is not available yet.' });

// ---- admin auth (same HMAC as title-order-email.js) ----
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
function cookieValid(event, secret) {
  const headers = event.headers || {};
  const cookie = getCookie(headers.cookie || headers.Cookie || '', COOKIE_NAME);
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
function bearerValid(event, secret) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false;
  return cookieValid(event, secret) || bearerValid(event, secret);
}

// ---- stored state (Blobs) ----
// Netlify Blobs needs connectLambda(event) before getStore() — without it
// getStore() throws MissingBlobsEnvironmentError in production ("The
// environment has not been configured to use Netlify Blobs..."). The
// working functions (buyer-verify, deals-api) call connectLambda; the
// mail functions did not, so the template list 503'd on every live call
// (Nov 11: "Template request failed. Nothing was changed.") and the
// Send Mail sheet never opened. getStoreFor() also never throws: on any
// Blobs failure it returns null and callers fall back to the built-in
// designs (the list is static data — it must not 503 when Blobs is down).
function getStoreFor(event) {
  if (!blobs) return null;
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
  } catch (e) {
    /* best-effort; getStore may still work with ambient context */
  }
  try {
    return blobs.getStore(STORE_NAME);
  } catch (e) {
    return null;
  }
}

function getStore() {
  return getStoreFor(null);
}

async function readState(store) {
  // { activeId, customs: [{ id, name, front, back, kindFront, kindBack, createdAt }] }
  if (!store) return { activeId: DEFAULT_ACTIVE_ID, customs: [] };
  try {
    const raw = await store.get(STATE_KEY, { type: 'json' });
    if (!raw || typeof raw !== 'object') return { activeId: DEFAULT_ACTIVE_ID, customs: [] };
    return {
      activeId: typeof raw.activeId === 'string' ? raw.activeId : DEFAULT_ACTIVE_ID,
      customs: Array.isArray(raw.customs) ? raw.customs : [],
    };
  } catch (e) {
    return { activeId: DEFAULT_ACTIVE_ID, customs: [] };
  }
}

async function writeState(store, state) {
  if (!store) return false;
  try {
    await store.setJSON(STATE_KEY, state);
    return true;
  } catch (e) {
    return false;
  }
}

// Pure helpers, exported for the fixture regression suite.
function listTemplates(state) {
  const customs = (state.customs || []).map((c) => ({
    id: c.id,
    name: c.name,
    blurb: 'Custom design supplied by Troy.',
    sizes: data.SIZES.slice(),
    builtin: false,
  }));
  const activeId =
    data.getBuiltin(state.activeId) || customs.some((c) => c.id === state.activeId)
      ? state.activeId
      : DEFAULT_ACTIVE_ID;
  return { templates: [...data.listBuiltins(), ...customs], activeId };
}

function resolveTemplate(state, templateId) {
  const id = String(templateId || state.activeId || DEFAULT_ACTIVE_ID);
  const builtin = data.getBuiltin(id);
  if (builtin) return { kind: 'builtin', id, name: builtin.name, sizes: builtin.sizes.slice() };
  const custom = (state.customs || []).find((c) => c.id === id);
  if (custom)
    return { kind: 'custom', id, name: custom.name, sizes: data.SIZES.slice(), front: custom.front, back: custom.back };
  return null;
}

function cleanStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    const params = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      const action = params.action || 'list';
      const store = getStoreFor(event);
      const state = await readState(store);

      if (action === 'list') {
        return ok(listTemplates(state));
      }

      if (action === 'preview') {
        const size = params.size === '6x9' ? '6x9' : '4x6';
        const vars = {
          ownerName: cleanStr(params.ownerName, 80) || data.defaultMergeVars().ownerName,
          propertyAddress: cleanStr(params.propertyAddress, 120) || data.defaultMergeVars().propertyAddress,
          cityStateZip: cleanStr(params.cityStateZip, 80) || data.defaultMergeVars().cityStateZip,
          phone: data.PHONE,
          brand: data.BRAND,
        };
        const resolved = resolveTemplate(state, params.templateId);
        if (!resolved) return bad('Unknown template.');
        if (resolved.kind === 'builtin') {
          const rendered = data.renderBuiltin(resolved.id, size, vars, true);
          if (!rendered) return bad('That design does not support this size.');
          return ok({ templateId: resolved.id, name: resolved.name, size, ...rendered, preview: true });
        }
        // Custom: static artwork — same front/back for both sizes.
        return ok({ templateId: resolved.id, name: resolved.name, size, front: resolved.front, back: resolved.back, preview: true });
      }

      return bad('Unknown action. Use action=list or action=preview.');
    }

    if (event.httpMethod !== 'POST') return bad('GET or POST only.');
    if (!isAdmin(event)) return unauth();

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return bad('Bad JSON body.');
      }
    }
    const store = getStoreFor(event);
    if (!store) return unavailable();
    const state = await readState(store);

    if (body.action === 'setActive') {
      const resolved = resolveTemplate(state, body.templateId);
      if (!resolved) return bad('Unknown template.');
      state.activeId = resolved.id;
      if (!(await writeState(store, state))) return unavailable('Could not save the active template.');
      return ok({ ok: true, activeId: resolved.id, name: resolved.name });
    }

    if (body.action === 'addCustom') {
      const name = cleanStr(body.name, 60);
      if (!name) return bad('Give the custom design a name.');
      const frontCheck = data.validateCustomSource(body.front);
      if (!frontCheck.ok) return bad('Front: ' + frontCheck.error);
      const backCheck = data.validateCustomSource(body.back);
      if (!backCheck.ok) return bad('Back: ' + backCheck.error);
      if ((state.customs || []).length >= 10) return bad('Custom design limit reached (10). Remove one first.');
      const custom = {
        id: `custom_${Date.now().toString(36)}`,
        name,
        front: String(body.front).trim(),
        back: String(body.back).trim(),
        kindFront: frontCheck.kind,
        kindBack: backCheck.kind,
        createdAt: new Date().toISOString(),
      };
      state.customs = [...(state.customs || []), custom];
      if (!(await writeState(store, state))) return unavailable('Could not save the custom design.');
      return ok({ ok: true, template: { id: custom.id, name: custom.name, builtin: false } });
    }

    if (body.action === 'removeCustom') {
      const id = String(body.templateId || '');
      const before = (state.customs || []).length;
      state.customs = (state.customs || []).filter((c) => c.id !== id);
      if (state.customs.length === before) return bad('No custom design with that id.');
      if (state.activeId === id) state.activeId = DEFAULT_ACTIVE_ID;
      if (!(await writeState(store, state))) return unavailable('Could not save.');
      return ok({ ok: true, removed: id, activeId: state.activeId });
    }

    return bad('Unknown action. Use setActive, addCustom, or removeCustom.');
  } catch (e) {
    return json(503, { error: 'Template request failed. Nothing was changed.' });
  }
};

exports._test = {
  listTemplates,
  resolveTemplate,
  readState,
  getStoreFor,
  DEFAULT_ACTIVE_ID,
  // Test seam: swap the Blobs client (returns the previous one). Lets the
  // regression suite prove the fix with a throwing/fake client, since the
  // real @netlify/blobs package is not installed in the test env.
  _setBlobs: (b) => {
    const prev = blobs;
    blobs = b;
    return prev;
  },
};

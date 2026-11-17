// netlify/functions/cc-workflows-api.js
// Admin API behind the standalone workflow builder (workflows.html).
//
//   GET  ?action=list                       effective workflow defs
//   GET  ?action=get&id=<id>                one effective definition
//   POST {action:'save', workflow:{...}}    upsert a builder save
//   POST {action:'create', name, tag}       new Draft workflow
//   POST {action:'duplicate', id, name?}    copy under a fresh id
//   POST {action:'publish', id}             status -> published
//   POST {action:'unpublish', id}           status -> draft
//
// Definitions persist in Netlify Blobs via cc-workflows-store.js;
// the static seeds in cc-workflows-config.js stay the defaults and
// are never mutated. Saves are sanitized in the store layer: only
// the builder-editable fields (name, tag, dripPerDay, window,
// settingsWindow, firstTexts, status) are taken from the payload —
// the bad-number guard, the active-lead gate and the other locked
// steps always resolve from the base definition.
//
// ALL actions require the full dashboard login (lm_auth). Irish's
// calling-only session gets 403 — the builder is Troy-tier only.
'use strict';

const crypto = require('crypto');

const store = require('./cc-workflows-store');
const ccAuth = require('./cc-auth');

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
const notFound = (msg) => json(404, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
function serverError(msg) {
  return json(503, { error: 'Workflow storage is not ready yet', detail: msg });
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (!isAdmin(event)) {
      // Irish's calling-only session is signed in but restricted —
      // 403, not 401 (cc-auth two-tier split).
      if (ccAuth.isIrish(event)) return json(403, { error: 'Calling access only — the workflow builder is not part of the calling login.' });
      return unauth();
    }

    const params = event.queryStringParameters || {};
    let body = null;
    if (event.body) {
      try { body = JSON.parse(event.body); } catch (e) { return bad('Bad JSON body.'); }
    }
    const action = params.action || (body && body.action) || (event.httpMethod === 'GET' ? 'list' : '');

    if (action === 'list') {
      const eff = await store.loadEffective(event);
      return ok({ workflows: eff.list });
    }

    if (action === 'get') {
      const id = String(params.id || (body && body.id) || '');
      const eff = await store.loadEffective(event);
      const def = eff.map[id];
      if (!def) return notFound('Unknown workflow: ' + id);
      return ok({ workflow: def });
    }

    if (action === 'save') {
      const wf = body && body.workflow;
      if (!wf || typeof wf !== 'object') return bad('Missing workflow.');
      try {
        const def = await store.upsertWorkflow(event, wf);
        return ok({ ok: true, workflow: def });
      } catch (e) {
        return bad(String((e && e.message) || e));
      }
    }

    if (action === 'create') {
      try {
        const def = await store.createWorkflow(event, body || {});
        return ok({ ok: true, workflow: def });
      } catch (e) {
        return bad(String((e && e.message) || e));
      }
    }

    if (action === 'duplicate') {
      const id = String((body && body.id) || '');
      if (!id) return bad('Missing workflow id.');
      try {
        const def = await store.duplicateWorkflow(event, id, body && body.name);
        return ok({ ok: true, workflow: def });
      } catch (e) {
        return bad(String((e && e.message) || e));
      }
    }

    if (action === 'publish' || action === 'unpublish') {
      const id = String((body && body.id) || params.id || '');
      if (!id) return bad('Missing workflow id.');
      const def = await store.setStatus(event, id, action === 'publish' ? 'published' : 'draft');
      if (!def) return notFound('Unknown workflow: ' + id);
      return ok({ ok: true, workflow: def });
    }

    return bad('Unknown action.');
  } catch (e) {
    return serverError(String((e && e.message) || e));
  }
};

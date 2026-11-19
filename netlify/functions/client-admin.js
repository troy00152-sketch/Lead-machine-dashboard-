// netlify/functions/client-admin.js
// Resale Clients admin — kill switch v2 (Nov 19).
// The control surface for Troy's white-label disconnect, living
// behind the Resale Clients screen in his own Command Center
// (clients-admin.html). Troy clicks Suspend/Restore there; this
// function writes the live status override (lib-client-status.js)
// that client-config.js and cc-data.js consult on every request, so
// the flip takes effect immediately — no file edit, no redeploy.
//
// Routing (ALL actions require the dashboard admin cookie):
//   GET  ?action=list                          every white-label client with
//                                              config flag + live override +
//                                              effective status
//   POST {action:'set', subdomain, active}     write a live override
//   POST {action:'clear', subdomain}           drop the override (the client
//                                              returns to its config default)
//
// Auth: the SAME lm_auth HMAC cookie check as buyer-verify.js. Any
// caller without a valid admin cookie gets 401 for every action.
//
// HARD SAFETY, enforced here AND in lib-client.js: the owner account
// (Troy) can never be suspended. A set/clear aimed at Troy's
// subdomain is refused outright, no override for him is ever written,
// and the resolver ignores the flag/override for Troy regardless.
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const {
  CLIENTS_DIR,
  TROY_SUBDOMAIN,
  sanitizeSubdomain,
  loadClient,
  effectiveSuspended,
} = require('./lib-client');
const statusStore = require('./lib-client-status');

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
const forbidden = (msg) => json(403, { error: msg });
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
function serverError(msg) {
  return json(503, { error: 'Client admin is not ready yet', detail: msg });
}

// ---- admin auth: verify the dashboard lm_auth cookie (same HMAC as buyer-verify.js) ----
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

// Every real client file in clients/ — the filename base IS the
// client's subdomain key (the resolver loads clients/{subdomain}.json
// the same way). Files starting with '_' are internal (_default
// neutral, _template) and are never listed as clients.
function listClientSubdomains() {
  let names = [];
  try {
    names = fs.readdirSync(CLIENTS_DIR);
  } catch (e) {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.startsWith('_'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

function clientRow(subdomain, override) {
  const cfg = loadClient(subdomain) || {};
  const owner = subdomain === TROY_SUBDOMAIN;
  const suspended = effectiveSuspended(cfg, owner, override || null);
  return {
    subdomain,
    companyName: cfg.companyName || (cfg.bot && cfg.bot.businessName) || subdomain,
    configActive: cfg.active !== false,
    override: override || null,
    effectiveStatus: suspended ? 'suspended' : 'active',
    owner,
    locked: owner, // the owner account can never be suspended
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});

    // Every action is admin-only.
    if (!isAdmin(event)) return unauth();

    const params = event.queryStringParameters || {};
    let body = {};
    if (event.body) {
      try { body = JSON.parse(event.body); } catch (e) { return bad('Bad JSON body.'); }
    }
    const action = params.action || body.action || 'list';

    if (action === 'list') {
      const { ok: storeOk, map } = await statusStore.readOverrides(event);
      const clients = listClientSubdomains().map((sub) => clientRow(sub, storeOk ? map[sub] : null));
      // Owner first, then clients A–Z (listClientSubdomains is sorted).
      clients.sort((a, b) => (b.owner - a.owner) || a.subdomain.localeCompare(b.subdomain));
      return ok({ ok: true, storeOk, clients });
    }

    if (action === 'set' || action === 'clear') {
      const subdomain = sanitizeSubdomain(body.subdomain || params.subdomain || '');
      if (!subdomain) return bad('Missing client.');
      // HARD SAFETY: never write any override for the owner account.
      if (subdomain === TROY_SUBDOMAIN) return forbidden('The owner account cannot be suspended.');
      if (subdomain.startsWith('_') || !loadClient(subdomain)) return bad('Unknown client.');

      if (action === 'set') {
        if (typeof body.active !== 'boolean') return bad('Say whether the client should be active or suspended.');
        const entry = { active: body.active, at: Date.now(), by: 'owner dashboard' };
        await statusStore.setOverride(event, subdomain, entry);
        return ok({ ok: true, client: clientRow(subdomain, entry) });
      }

      await statusStore.clearOverride(event, subdomain);
      return ok({ ok: true, client: clientRow(subdomain, null) });
    }

    return bad('Unknown action.');
  } catch (e) {
    return serverError(String((e && e.message) || e));
  }
};

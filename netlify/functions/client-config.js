// netlify/functions/client-config.js
// White-label multi-tenant client config.
// Reads the request (Host subdomain, or `x-client-subdomain` header)
// and returns the matching client's PUBLIC config fields
// (companyName, logo, primaryColor, subdomain, accountStatus, crmUrl,
// ghlWebhookUrl). Resolution lives in lib-client.js, shared with
// cc-data.js so both functions agree on which client a request
// belongs to.
//
// KILL SWITCH (Nov 19): when the resolved client is suspended
// (clients/{subdomain}.json sets "active": false), the public config
// reports accountStatus "suspended" with the CRM link + webhook
// blanked — the pages render an inactive notice instead of the app.
// Troy can never be suspended (see isClientSuspended in lib-client).
//
// KILL SWITCH V2 (Nov 19): Troy flips a client LIVE from his own
// Command Center (Resale Clients screen -> client-admin.js). Before
// answering, this handler consults the dynamic status store
// (lib-client-status.js) for the resolved client's override and lets
// it decide suspension (see effectiveSuspended in lib-client.js):
// the override wins over the config flag in both directions, and a
// store read failure falls back to the config flag. Troy and the
// neutral default never consult the store. The response is no-store
// so a flip shows on the client's next page load, not minutes later.
//
// SECURITY: secrets (HighLevel tokens, data provider keys) are NEVER in
// the client JSON files and NEVER returned by this function. They live
// only in Netlify env vars, referenced by name in the config files.
//
// Mapping:
//   leadmachineapp.com / www.leadmachineapp.com / app.leadmachineapp.com -> troy
//   {subdomain}.leadmachineapp.com -> clients/{subdomain}.json
//   localhost / *.netlify.app (dev + previews) -> troy
//   unknown subdomain / unknown host -> NEUTRAL default
//     (clients/_default.json: "Command Center", no logo, no Troy
//     numbers, no Troy location). NEVER Troy — an unknown subdomain
//     must not receive Troy's branding (fixed Nov 11; the old code
//     fell back to Troy for any unknown subdomain).
'use strict';

const { resolveClient, publicConfig } = require('./lib-client');
const { getOverride } = require('./lib-client-status');
let brandMod = null;
try {
  brandMod = require('./lib-client-brand');
} catch (e) {
  brandMod = null;
}
const crypto = require('crypto');

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
// client-admin.js / buyer-verify.js. Required for every brand write;
// the GET stays public, exactly as before.
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

exports.handler = async (event) => {
  const base = resolveClient(event);
  if (!base.cfg) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'no client config available' }),
    };
  }

  // ---- brand writes (Nov 27, 2026) ----
  // Settings "Save Branding" used to write localStorage only, so the
  // brand never followed Troy across devices. POST save-brand /
  // reset-brand persists it server-side (lib-client-brand.js) and the
  // GET below merges it into the response. Admin cookie required; the
  // shared neutral default can never be rebranded.
  if (event.httpMethod === 'POST') {
    if (!isAdmin(event)) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not signed in — open the dashboard and sign in first.' }),
      };
    }
    if (base.isNeutral) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'branding is per-client — the shared default cannot be rebranded' }),
      };
    }
    if (!brandMod) {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'brand store is not ready yet' }),
      };
    }
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'invalid JSON body' }),
      };
    }
    const action = String(body.action || '');
    try {
      if (action === 'save-brand') {
        const brand = {
          companyName: String(body.name || '').trim(),
          accentColor: String(body.color || ''),
        };
        if (!brandMod.isValidBrand(brand)) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'invalid brand (name required, color must be #rrggbb)' }),
          };
        }
        const saved = await brandMod.setBrandOverride(event, base.subdomain, brand);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify({ ok: true, brand: saved }),
        };
      }
      if (action === 'reset-brand') {
        const cleared = await brandMod.clearBrandOverride(event, base.subdomain);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify({ ok: true, cleared }),
        };
      }
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'unknown action: ' + action }),
      };
    } catch (e) {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'brand store write failed', detail: String((e && e.message) || e) }),
      };
    }
  }

  // Live override check — real clients only. getOverride never
  // throws; null means "no override / store unreadable", and the
  // config-flag verdict from the first resolution stands.
  let suspended = base.suspended;
  if (!base.isTroy && !base.isNeutral) {
    const override = await getOverride(event, base.subdomain);
    if (override) suspended = resolveClient(event, override).suspended;
  }

  const out = publicConfig(base.cfg, { suspended });
  // Brand override (Nov 27): a saved brand wins over the config
  // file's companyName, and carries the accent color the Settings
  // page edits. brandUpdatedAt lets the page decide server-vs-cache
  // precedence (newer wins; a local-only save that never synced
  // always wins on its own device). Never for the neutral default —
  // its shared branding must not be rebrandable. Fail-soft: a dead
  // store reads as "no override" and the config file's brand stands.
  if (!base.isNeutral && brandMod) {
    try {
      const brand = await brandMod.getBrandOverride(event, base.subdomain);
      if (brand) {
        out.companyName = brand.companyName;
        out.accentColor = brand.accentColor;
        out.brandUpdatedAt = brand.updatedAt || 0;
      }
    } catch (e) { /* fail-soft: config brand stands */ }
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(out),
  };
};

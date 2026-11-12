// netlify/functions/lib-client.js — SHARED per-client resolution.
// Used by client-config.js (public branding) and cc-data.js (per-client
// HighLevel location/calendar/token). One module so the two functions can
// never disagree about which client a request belongs to.
//
// HOW A REQUEST MAPS TO A CLIENT (in order):
//   1. `x-client-subdomain` request header, when present and naming a
//      client file that exists (lets local dev / Netlify previews pick a
//      client without a real subdomain).
//   2. Host subdomain: {sub}.leadmachineapp.com -> clients/{sub}.json.
//   3. leadmachineapp.com / www. / app. -> 'troy' (Troy's own domains).
//   4. Local dev / Netlify preview hosts (localhost, *.netlify.app,
//      empty host) -> 'troy' — Troy develops against his own data locally.
//      Documented convenience, not a leak: these hosts are never a
//      stranger's production subdomain.
//   5. Anything else (unknown *.leadmachineapp.com subdomain, unknown
//      host) -> the NEUTRAL client (clients/_default.json). NEVER Troy.
//      An unknown subdomain must never receive Troy's branding, his
//      market phone numbers, or his CRM data.
//
// SECURITY: client JSON files hold NO secrets — only env-var NAMES
// (highLevel.apiTokenEnvVar). Tokens are read from process.env at call
// time. The live token env var is HL_API_TOKEN (what cc-data.js,
// deals-api.js and bread-hl.js all already use); a client's named var
// wins when it is actually set, HL_API_TOKEN is the fallback — so
// troy.json naming TROY_HL_TOKEN does NOT break Troy's live feed.
// Server-side identifiers (api hostnames, env var names) are never
// renamed — white-label covers user-visible text only.
'use strict';

const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, '..', '..', 'clients');
const TROY_SUBDOMAIN = 'troy';
const NEUTRAL_SUBDOMAIN = '_default';
// Legacy Troy identifiers — ONLY a fallback when the troy client file
// itself has no location/calendar. Never applied to any other client:
// a non-Troy client without its own location gets NO data, not Troy's.
const LEGACY_TROY_LOCATION_ID = 'krKoHLudPnn7nT0DPtwa';
const LEGACY_TROY_CALENDAR_ID = 'aG6lop6FROsWlIrB0Y0H'; // Seller Calls - Paula

// MULTI-TENANT CONFIG POINT (Nov 11 cleanup): the single-tenant
// functions that cannot resolve a per-client file (esign, mail-send,
// bread-hl, deals-api notifications) take Troy's location/calendar
// from HERE instead of hardcoding the literals. Precedence: the
// HL_LOCATION_ID / HL_CALENDAR_ID Netlify env vars when set, else the
// legacy Troy ids above — so production behavior is IDENTICAL until
// someone deliberately sets the env vars for another tenant. (New env
// var names; no existing env var was renamed.)
const HL_LOCATION_ID_ENV = 'HL_LOCATION_ID';
const HL_CALENDAR_ID_ENV = 'HL_CALENDAR_ID';
function defaultLocationId() {
  return process.env[HL_LOCATION_ID_ENV] || LEGACY_TROY_LOCATION_ID;
}
function defaultCalendarId() {
  return process.env[HL_CALENDAR_ID_ENV] || LEGACY_TROY_CALENDAR_ID;
}

// OPERATOR / BRAND DEFAULTS (multi-tenant pass, Nov 11): the
// single-tenant functions (esign, deals-api, title-order-email) also
// need the tenant operator's identity — the person who receives the
// copy of every contract send, the deal-room view/offer text alerts,
// and the title-order test sends. That identity is per-tenant CONFIG
// DATA: it lives in the default tenant's client file
// (clients/troy.json -> "operator" / "buyerSignerName" /
// "companyName"). The legacy literals below are ONLY a fallback when
// the client file or the field is missing, so behavior for Troy is
// byte-identical either way. A future tenant's fork edits its own
// client file (see TENANT_SETUP.md), never this code.
const LEGACY_OPERATOR = {
  name: 'Troy Thomas',
  firstName: 'Troy',
  lastName: 'Thomas',
  email: 'troy00152@gmail.com',
  phone: '+1 203-565-7810',
  phoneDigits: '12035657810',
};
const LEGACY_BUYER_SIGNER_NAME = 'Paula Thomas';
const LEGACY_COMPANY_NAME = 'Direct Property Buyers';

function defaultOperator() {
  const cfg = loadClient(TROY_SUBDOMAIN) || {};
  const op = cfg.operator || {};
  const merged = {};
  for (const k of Object.keys(LEGACY_OPERATOR)) {
    merged[k] = op[k] || LEGACY_OPERATOR[k];
  }
  return merged;
}
function defaultBuyerSignerName() {
  const cfg = loadClient(TROY_SUBDOMAIN) || {};
  return cfg.buyerSignerName || LEGACY_BUYER_SIGNER_NAME;
}
function defaultCompanyName() {
  const cfg = loadClient(TROY_SUBDOMAIN) || {};
  return cfg.companyName || (cfg.bot && cfg.bot.businessName) || LEGACY_COMPANY_NAME;
}

// Parsed client files, cached for the life of the function instance.
// Config files change only on deploy, which restarts the function.
const clientCache = new Map();

function sanitizeSubdomain(subdomain) {
  // Underscore is allowed so the internal neutral client '_default'
  // resolves; everything else outside [a-z0-9-_] is stripped, so no
  // path traversal (no '/', '.', or '..') can escape CLIENTS_DIR.
  return String(subdomain || '').toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 63);
}

function loadClient(subdomain) {
  const safe = sanitizeSubdomain(subdomain);
  if (!safe) return null;
  if (clientCache.has(safe)) return clientCache.get(safe);
  const file = path.join(CLIENTS_DIR, safe + '.json');
  let cfg = null;
  try {
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[lib-client] failed to load', safe, e.message);
    cfg = null;
  }
  clientCache.set(safe, cfg);
  return cfg;
}

function loadNeutral() {
  return loadClient(NEUTRAL_SUBDOMAIN);
}

// Host -> subdomain, or null when the host maps to nobody (neutral).
// Returns 'troy' for Troy's own domains and for local/preview hosts.
function subdomainFromHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase().trim();
  if (!h) return TROY_SUBDOMAIN; // no host (local invoke) -> Troy dev default
  if (h === 'leadmachineapp.com' || h === 'www.leadmachineapp.com' || h === 'app.leadmachineapp.com') {
    return TROY_SUBDOMAIN;
  }
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.netlify.app')) {
    return TROY_SUBDOMAIN; // local dev / preview deploys -> Troy
  }
  const suffix = '.leadmachineapp.com';
  if (h.endsWith(suffix)) {
    const sub = h.slice(0, -suffix.length);
    if (sub && !sub.includes('.')) return sub;
  }
  return null; // unknown host -> neutral, never Troy
}

function headerSubdomain(event) {
  const headers = (event && event.headers) || {};
  const raw = headers['x-client-subdomain'] || headers['X-Client-Subdomain'] || '';
  const safe = sanitizeSubdomain(raw);
  return safe || null;
}

// Resolve the request to a client config. Never throws.
// Returns { cfg, subdomain, isTroy, isNeutral } — cfg is the neutral
// config when nothing else resolves, so callers can always brand the
// page; callers that need CRM data must check isNeutral / locationId.
function resolveClient(event) {
  const headerSub = headerSubdomain(event);
  const host = (event && event.headers && (event.headers.host || event.headers.Host)) || '';
  let subdomain = headerSub || subdomainFromHost(host);
  if (subdomain) {
    const cfg = loadClient(subdomain);
    if (cfg) return { cfg, subdomain, isTroy: subdomain === TROY_SUBDOMAIN, isNeutral: false };
  }
  // Unknown subdomain, or a header naming a client file that does not
  // exist: neutral default. Never Troy.
  const neutral = loadNeutral();
  return {
    cfg: neutral,
    subdomain: NEUTRAL_SUBDOMAIN,
    isTroy: false,
    isNeutral: true,
  };
}

// Resolve the request to CRM data settings for cc-data.js.
// Returns null when the client has NO HighLevel location configured —
// the caller must answer with an honest error, NEVER fall back to
// Troy's location: serving Troy's live CRM data to a stranger's
// subdomain would be a data leak, not a fallback.
function resolveClientData(event) {
  const resolved = resolveClient(event);
  const cfg = resolved.cfg || {};
  const hl = cfg.highLevel || {};
  const isTroy = resolved.isTroy;
  const locationId = hl.locationId || (isTroy ? defaultLocationId() : null);
  const calendarId = hl.calendarId || (isTroy ? defaultCalendarId() : null);
  if (!locationId || !calendarId) return null;
  // Named token env var wins when set; HL_API_TOKEN is the live var
  // already in use by cc-data/deals-api/bread-hl — the fallback that
  // keeps Troy working (troy.json names TROY_HL_TOKEN, which is not
  // the var Netlify actually sets today).
  const token = (hl.apiTokenEnvVar && process.env[hl.apiTokenEnvVar])
    || process.env.HL_API_TOKEN
    || null;
  if (!token) return null;
  return {
    locationId,
    calendarId,
    token,
    subdomain: resolved.subdomain,
    isTroy,
  };
}

// Public fields only — safe to send to the browser.
// Generic fallbacks, NOT Troy's: a client file without branding gets
// the neutral name and NO logo (the page hides the logo img when the
// logo is empty) — never Troy's name or logo.
// crmUrl + ghlWebhookUrl (multi-tenant pass, Nov 11): the browser
// needs the tenant's "Back to CRM" target and lead-push webhook.
// Both are derived from the client's own config (highLevel.locationId
// / highLevel.webhookUrl) — for Troy they resolve to EXACTLY the URLs
// index.html used to hardcode; for the neutral client both are empty
// (the page hides the CRM buttons and refuses the push). Neither is a
// secret: both URLs already shipped in the page source before this
// pass; tokens still never leave the server.
function publicConfig(cfg) {
  const c = cfg || {};
  const hl = c.highLevel || {};
  return {
    companyName: c.companyName || 'Command Center',
    logo: c.logo || '',
    primaryColor: c.primaryColor || '#00d4ff',
    subdomain: c.subdomain || NEUTRAL_SUBDOMAIN,
    crmUrl: hl.locationId ? 'https://app.gohighlevel.com/v2/location/' + hl.locationId + '/' : '',
    ghlWebhookUrl: hl.webhookUrl || '',
  };
}

module.exports = {
  CLIENTS_DIR,
  TROY_SUBDOMAIN,
  NEUTRAL_SUBDOMAIN,
  LEGACY_TROY_LOCATION_ID,
  LEGACY_TROY_CALENDAR_ID,
  HL_LOCATION_ID_ENV,
  HL_CALENDAR_ID_ENV,
  defaultLocationId,
  defaultCalendarId,
  LEGACY_OPERATOR,
  LEGACY_BUYER_SIGNER_NAME,
  LEGACY_COMPANY_NAME,
  defaultOperator,
  defaultBuyerSignerName,
  defaultCompanyName,
  sanitizeSubdomain,
  loadClient,
  loadNeutral,
  subdomainFromHost,
  headerSubdomain,
  resolveClient,
  resolveClientData,
  publicConfig,
};

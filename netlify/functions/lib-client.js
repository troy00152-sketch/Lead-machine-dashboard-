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
  const locationId = hl.locationId || (isTroy ? LEGACY_TROY_LOCATION_ID : null);
  const calendarId = hl.calendarId || (isTroy ? LEGACY_TROY_CALENDAR_ID : null);
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

// Public branding fields only — safe to send to the browser.
// Generic fallbacks, NOT Troy's: a client file without branding gets
// the neutral name and NO logo (the page hides the logo img when the
// logo is empty) — never Troy's name or logo.
function publicConfig(cfg) {
  const c = cfg || {};
  return {
    companyName: c.companyName || 'Command Center',
    logo: c.logo || '',
    primaryColor: c.primaryColor || '#00d4ff',
    subdomain: c.subdomain || NEUTRAL_SUBDOMAIN,
  };
}

module.exports = {
  CLIENTS_DIR,
  TROY_SUBDOMAIN,
  NEUTRAL_SUBDOMAIN,
  LEGACY_TROY_LOCATION_ID,
  LEGACY_TROY_CALENDAR_ID,
  sanitizeSubdomain,
  loadClient,
  loadNeutral,
  subdomainFromHost,
  headerSubdomain,
  resolveClient,
  resolveClientData,
  publicConfig,
};

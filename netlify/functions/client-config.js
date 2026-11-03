// netlify/functions/client-config.js
// White-label multi-tenant client config.
// Reads the Host header, extracts the subdomain, and returns the matching
// client's PUBLIC branding fields (companyName, logo, primaryColor, subdomain).
//
// SECURITY: secrets (HighLevel tokens, PropertyReach keys) are NEVER in the
// client JSON files and NEVER returned by this function. They live only in
// Netlify env vars, referenced by name in the config files.
//
// Mapping:
//   leadmachineapp.com / www.leadmachineapp.com / app.leadmachineapp.com -> troy
//   {subdomain}.leadmachineapp.com -> clients/{subdomain}.json
//   unknown subdomain -> troy (safe fallback)
'use strict';

const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, '..', '..', 'clients');
const TROY_SUBDOMAIN = 'troy';

// Public fields only — safe to send to the browser.
function publicConfig(cfg) {
  return {
    companyName: cfg.companyName || 'Direct Property Buyers',
    logo: cfg.logo || '/assets/dpb-logo.png',
    primaryColor: cfg.primaryColor || '#00d4ff',
    subdomain: cfg.subdomain || TROY_SUBDOMAIN,
  };
}

function loadClient(subdomain) {
  const safe = String(subdomain || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!safe) return null;
  const file = path.join(CLIENTS_DIR, safe + '.json');
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg;
  } catch (e) {
    console.error('[client-config] failed to load', safe, e.message);
    return null;
  }
}

function subdomainFromHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  // Root domain and www/app map to Troy.
  if (h === 'leadmachineapp.com' || h === 'www.leadmachineapp.com' || h === 'app.leadmachineapp.com') {
    return TROY_SUBDOMAIN;
  }
  const suffix = '.leadmachineapp.com';
  if (h.endsWith(suffix)) {
    const sub = h.slice(0, -suffix.length);
    // Guard against deep subdomains (a.b.leadmachineapp.com) — take the first label only if simple.
    if (sub && !sub.includes('.')) return sub;
  }
  // Local dev / Netlify preview / unknown host -> Troy.
  return TROY_SUBDOMAIN;
}

exports.handler = async (event) => {
  const host = (event.headers && (event.headers.host || event.headers.Host)) || '';
  const subdomain = subdomainFromHost(host);

  let cfg = loadClient(subdomain);
  if (!cfg) {
    // Unknown subdomain — fall back to Troy rather than 404ing the dashboard.
    cfg = loadClient(TROY_SUBDOMAIN);
  }
  if (!cfg) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'no client config available' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(publicConfig(cfg)),
  };
};

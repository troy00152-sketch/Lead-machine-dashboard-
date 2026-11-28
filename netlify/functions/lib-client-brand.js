// netlify/functions/lib-client-brand.js
// Per-client branding override — Settings "Save Branding" (Nov 27, 2026).
//
// The gap (Nov 27 audit): Save Branding wrote lm_brand_v1 to
// localStorage only, so the brand never followed Troy from his phone
// to his Mac. The brand now also lives server-side, in a Blobs store
// holding one JSON map (same pattern as lib-client-status.js), one
// entry per client subdomain:
//   { companyName: string, accentColor: '#rrggbb', updatedAt: epochMs }
//
// PRECEDENCE (enforced by the callers, not here):
//   live override (this store)  >  client config file (default)
// client-config.js merges the override into its GET response
// (companyName + accentColor), and the dashboard head hook applies
// it; the Settings page keeps localStorage as an instant cache and
// the server value corrects it when the config fetch lands.
//
// FAIL-SAFE READS: getBrandOverride NEVER throws. A missing module, a
// store outage, or a malformed entry all read as "no override", so
// resolution falls back to the config file — a store error can never
// break the dashboard brand. WRITES are the opposite:
// setBrandOverride/clearBrandOverride throw on failure so the
// caller can answer honestly instead of pretending a save landed.
//
// The override is keyed by the resolved subdomain, so a caller can
// only ever write their own client's brand — and the write path
// (client-config.js POST) additionally requires the lm_auth admin
// cookie, the same check as client-admin.js.
'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'client-brand-overrides';
const OVERRIDES_KEY = 'overrides';

function store(event) {
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
}

// Read the whole override map. Never throws: { ok:false, map:{} }
// means "store unreadable — treat every client as no-override".
async function readOverrides(event) {
  try {
    const s = store(event);
    const v = await s.get(OVERRIDES_KEY, { type: 'json' });
    return { ok: true, map: v && typeof v === 'object' ? v : {} };
  } catch (e) {
    return { ok: false, map: {} };
  }
}

async function writeOverrides(event, map) {
  const s = store(event);
  await s.set(OVERRIDES_KEY, JSON.stringify(map), { contentType: 'application/json' });
}

function isValidBrand(b) {
  if (!b || typeof b !== 'object') return false;
  if (typeof b.companyName !== 'string' || !b.companyName.trim()) return false;
  if (b.companyName.trim().length > 100) return false;
  if (typeof b.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.accentColor)) return false;
  return true;
}

// Never throws: null means "no override / store unreadable".
async function getBrandOverride(event, subdomain) {
  if (!subdomain) return null;
  const { map } = await readOverrides(event);
  const entry = map[subdomain];
  if (!entry || typeof entry !== 'object') return null;
  if (!isValidBrand(entry)) return null;
  return {
    companyName: entry.companyName.trim(),
    accentColor: entry.accentColor,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
  };
}

// Throws on failure so the caller can answer honestly. A failed
// READ also throws: writing from an empty map would wipe every other
// client's override.
async function setBrandOverride(event, subdomain, brand) {
  if (!subdomain) throw new Error('subdomain is required');
  if (!isValidBrand(brand)) throw new Error('invalid brand (name required, color must be #rrggbb)');
  const { ok, map } = await readOverrides(event);
  if (!ok) throw new Error('brand store unreadable');
  const next = Object.assign({}, map);
  next[subdomain] = {
    companyName: brand.companyName.trim(),
    accentColor: brand.accentColor,
    updatedAt: Date.now(),
  };
  await writeOverrides(event, next);
  return next[subdomain];
}

// Throws on failure so the caller can answer honestly. A failed
// READ also throws: "nothing to clear" cannot be verified when the
// store is unreadable, and answering {cleared:false} would be a lie
// while the override may still exist.
async function clearBrandOverride(event, subdomain) {
  if (!subdomain) throw new Error('subdomain is required');
  const { ok, map } = await readOverrides(event);
  if (!ok) throw new Error('brand store unreadable');
  if (!Object.prototype.hasOwnProperty.call(map, subdomain)) return false;
  const next = Object.assign({}, map);
  delete next[subdomain];
  await writeOverrides(event, next);
  return true;
}

module.exports = {
  getBrandOverride,
  setBrandOverride,
  clearBrandOverride,
  isValidBrand,
  STORE_NAME,
  _test: {
    readOverrides,
    writeOverrides,
  },
};

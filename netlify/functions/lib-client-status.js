// netlify/functions/lib-client-status.js
// Live per-client account-status overrides — kill switch v2 (Nov 19).
//
// V1 of the kill switch read an "active" flag from the client's
// config file (clients/{subdomain}.json, see lib-client.js), which
// meant flipping a client required a file edit + redeploy. Troy's
// directive: the disconnect must live in his Command Center as a
// control he clicks himself, taking effect live. This module is the
// dynamic half: a server-side store (same pattern as buyer-verify.js
// — a Blobs store holding one JSON map) with one entry per client
// subdomain: { active: bool, at: epochMs, by: string }.
//
// PRECEDENCE (enforced in lib-client.js effectiveSuspended):
//   live override (this store)  >  config "active" flag (default)
// A boolean override wins in BOTH directions — Troy can suspend a
// client whose config says active, or restore one whose config says
// inactive, without a redeploy. Clearing the override returns the
// client to its config default.
//
// FAIL-SAFE READS: getOverride NEVER throws. A missing module, a
// store outage, or a malformed entry all read as "no override", so
// resolution falls back to the config flag — a store error can
// neither fail open for a config-suspended client (their flag still
// suspends them) nor suspend anyone on its own. WRITES are the
// opposite: setOverride/clearOverride throw on failure so the admin
// function can answer honestly instead of pretending a flip landed.
//
// HARD SAFETY lives in lib-client.js, not here: Troy's own client
// can never be suspended at any layer, and the per-request tenant
// functions never even consult this store for Troy or the neutral
// default. client-admin.js additionally refuses to WRITE an override
// for Troy's subdomain.
'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const STORE_NAME = 'client-status';
const OVERRIDES_KEY = 'overrides';

function store(event) {
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event);
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

// One client's override entry, or null when there is none (or the
// store could not be read, or the stored entry is malformed).
async function getOverride(event, subdomain) {
  if (!subdomain) return null;
  const { ok, map } = await readOverrides(event);
  if (!ok) return null;
  const entry = map[subdomain];
  return entry && typeof entry === 'object' && typeof entry.active === 'boolean' ? entry : null;
}

// Strict read for writers: a write that started from an unread map
// could clobber other clients' overrides, so writers fail loudly.
async function readOverridesStrict(event) {
  const s = store(event);
  const v = await s.get(OVERRIDES_KEY, { type: 'json' });
  return v && typeof v === 'object' ? v : {};
}

async function writeOverrides(event, map) {
  const s = store(event);
  await s.set(OVERRIDES_KEY, JSON.stringify(map), { contentType: 'application/json' });
}

// Set/replace one client's override. Throws on any store failure.
async function setOverride(event, subdomain, entry) {
  const map = await readOverridesStrict(event);
  map[subdomain] = entry;
  await writeOverrides(event, map);
  return map[subdomain];
}

// Remove one client's override (back to its config default).
// Throws on any store failure.
async function clearOverride(event, subdomain) {
  const map = await readOverridesStrict(event);
  delete map[subdomain];
  await writeOverrides(event, map);
}

// Test hook (same pattern as the mail functions): swap the Blobs
// module for a fake and get the previous one back for restore.
function _setBlobs(fake) {
  const prev = blobs;
  blobs = fake;
  return prev;
}

module.exports = {
  STORE_NAME,
  OVERRIDES_KEY,
  readOverrides,
  getOverride,
  setOverride,
  clearOverride,
  _setBlobs,
};

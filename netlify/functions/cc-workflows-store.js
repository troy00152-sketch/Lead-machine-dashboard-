// netlify/functions/cc-workflows-store.js
// Runtime persistence + resolution for the standalone workflow
// builder (workflows.html / cc-workflows-api.js).
//
// The static seeds in cc-workflows-config.js remain the DEFAULTS —
// they are the exact HighLevel mirror and are never mutated. Builder
// edits live in Netlify Blobs:
//
//   store 'cc-workflows', key 'definitions'
//     -> { updatedAt, workflows: { <id>: <stored definition> } }
//
// Resolution (what the engine runs):
//   effective(id) = stored definition, when one exists, sanitized
//                   over its base; otherwise the static seed.
//   base          = the static seed for the five markets; for a
//                   builder-created workflow, a blank definition
//                   built from the same shared structure
//                   (cc-workflows-config's `market()` factory).
//
// LOCKED STEPS — sanitized by construction, not by trust:
// sanitizeWorkflow() starts from a deep clone of the BASE and
// overlays ONLY the builder-editable fields (name, tag, dripPerDay,
// window, settingsWindow, firstTexts, status). Everything else —
// the bad-number guard, the active-lead gate (tags + rule), the
// random split, pipeline/stage, telnyxMarket — comes from the base
// no matter what a save payload contains, and the same sanitize runs
// again on every read, so even a hand-corrupted stored document
// resolves with the guards intact.
//
// STATUS: a stored definition carries status 'draft' | 'published'.
// Static seeds carry no status and resolve 'published' (the engine's
// behavior before the builder existed — unchanged). The engine
// refuses to enroll into, and never sends for, a 'draft' workflow.
'use strict';

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null;
}

const cfg = require('./cc-workflows-config');

const STORE_NAME = 'cc-workflows';
const DOC_KEY = 'definitions';
const PATHS = ['A', 'B', 'C', 'D', 'E'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---- store plumbing (same pattern as cc-dnd.js / the engine) ----
let storeFactory = null; // tests only: (name) -> store
function makeStore(event) {
  if (storeFactory) return storeFactory(STORE_NAME);
  if (!blobs) throw new Error('The @netlify/blobs module is not installed.');
  try {
    if (typeof blobs.connectLambda === 'function' && event) blobs.connectLambda(event);
  } catch (e) { /* best-effort */ }
  return blobs.getStore(STORE_NAME);
}
async function readJson(s, key) {
  try {
    const v = await s.get(key, { type: 'json' });
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}
async function writeJson(s, key, obj) {
  await s.set(key, JSON.stringify(obj), { contentType: 'application/json' });
}

// ---- pure helpers ----
function clone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}
function cleanStr(v, max, fallback) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return fallback;
  return s.length > max ? s.slice(0, max) : s;
}
function validTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
function cleanWindow(w, base) {
  const b = base || cfg.WAIT_WINDOW;
  if (!w || typeof w !== 'object') return clone(b);
  const days = DAYS.filter((d) => Array.isArray(w.days) && w.days.includes(d));
  const start = validTime(w.start) ? w.start : b.start;
  const end = validTime(w.end) ? w.end : b.end;
  if (!days.length || start >= end) return clone(b);
  return { timezone: b.timezone || 'America/New_York', days, start, end };
}
function cleanFirstTexts(ft, base) {
  const out = {};
  for (const p of PATHS) {
    const v = ft && typeof ft === 'object' ? ft[p] : undefined;
    out[p] = typeof v === 'string' ? v.slice(0, 1600) : (base && typeof base[p] === 'string' ? base[p] : '');
  }
  return out;
}
function cleanDrip(v, base) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return base;
  return Math.min(5000, Math.max(1, n));
}
function cleanStatus(v, fallback) {
  return v === 'draft' || v === 'published' ? v : fallback;
}

// The blank base for a builder-created workflow: the shared market
// structure with empty first texts. telnyxMarket may be carried over
// (duplicates keep the source market's sender pool).
function blankBase(id, raw) {
  const r = raw || {};
  return cfg.market({
    id,
    name: cleanStr(r.name, 120, id),
    tag: cleanStr(r.tag, 80, ''),
    opportunitySource: cleanStr(r.tag, 80, id),
    telnyxMarket: cleanStr(r.telnyxMarket, 80, id),
    firstTexts: { A: '', B: '', C: '', D: '', E: '' },
  });
}

// sanitizeWorkflow(input, base, defaultStatus) -> definition.
// Starts from a clone of base; overlays ONLY editable fields. The
// locked/structural fields of the result always equal the base's.
function sanitizeWorkflow(input, base, defaultStatus) {
  const inp = input && typeof input === 'object' ? input : {};
  const def = clone(base);
  def.id = base.id;
  def.name = cleanStr(inp.name, 120, base.name);
  def.tag = cleanStr(inp.tag, 80, base.tag);
  def.dripPerDay = cleanDrip(inp.dripPerDay, base.dripPerDay);
  def.dripBatch = Object.assign({}, base.dripBatch, { size: def.dripPerDay });
  def.window = cleanWindow(inp.window, base.window);
  def.settingsWindow = cleanWindow(inp.settingsWindow, base.settingsWindow || base.window);
  def.firstTexts = cleanFirstTexts(inp.firstTexts, base.firstTexts);
  def.status = cleanStatus(inp.status, cleanStatus(base.status, defaultStatus || 'published'));
  return def;
}

// resolveWorkflows(doc) -> { map: {id: def}, list: [def, ...] }.
// Pure: doc is the stored definitions document (or null). Static
// order first (config order), then builder-created ids in stored
// order. Every def carries `status` and `source` ('static'|'stored').
function resolveWorkflows(doc) {
  const stored = (doc && typeof doc === 'object' && doc.workflows) || {};
  const map = {};
  const list = [];
  for (const seed of Object.values(cfg.WORKFLOWS)) {
    let def;
    if (stored[seed.id]) {
      def = sanitizeWorkflow(stored[seed.id], seed, 'published');
      def.source = 'stored';
    } else {
      def = clone(seed);
      def.status = cleanStatus(def.status, 'published');
      def.source = 'static';
    }
    map[def.id] = def;
    list.push(def);
  }
  for (const id of Object.keys(stored)) {
    if (map[id]) continue;
    const def = sanitizeWorkflow(stored[id], blankBase(id, stored[id]), 'draft');
    def.source = 'stored';
    map[id] = def;
    list.push(def);
  }
  return { map, list };
}

function workflowByTagFrom(map, tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return null;
  for (const w of Object.values(map)) {
    if (String(w.tag || '').toLowerCase() === t) return w;
  }
  return null;
}

// Same placeholder fill as cc-workflows-config.renderFirstText, but
// against an arbitrary (effective) definition.
function renderFirstTextFrom(workflow, path, contact) {
  if (!workflow) throw new Error('Unknown workflow');
  const tpl = (workflow.firstTexts || {})[String(path || '').toUpperCase()];
  if (tpl == null) throw new Error('Unknown path ' + path + ' for workflow ' + workflow.id);
  const c = contact || {};
  const vals = {
    first_name: c.first_name || c.firstName || '',
    address1: c.address1 || c.address || '',
    city: c.city || '',
  };
  const body = String(tpl).replace(/\{\{(first_name|address1|city)\}\}/g, (m, k) => String(vals[k] || ''));
  // A2P opt-out line on EVERY first text (Troy, Nov 25: "put reply out").
  // OUT is a recognized opt-out keyword in cc-bot-hook (seals the enrollment).
  return /opt out/i.test(body) ? body : body + ' Reply OUT to opt out.';
}

// ---- persistence ----
async function loadDefinitions(event) {
  const s = makeStore(event);
  const doc = await readJson(s, DOC_KEY);
  if (!doc || typeof doc !== 'object' || !doc.workflows || typeof doc.workflows !== 'object') {
    return { updatedAt: 0, workflows: {} };
  }
  return doc;
}
async function saveDefinitions(event, doc) {
  const s = makeStore(event);
  doc.updatedAt = Date.now();
  await writeJson(s, DOC_KEY, doc);
  return doc;
}
async function loadEffective(event) {
  return resolveWorkflows(await loadDefinitions(event));
}

function slugify(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'workflow';
}
function uniqueId(baseId, taken) {
  if (!taken[baseId]) return baseId;
  let i = 2;
  while (taken[baseId + '-' + i]) i += 1;
  return baseId + '-' + i;
}

// Upsert a builder save. input must carry a valid id; the base is the
// static seed or a blank for a new id. Returns the effective def.
async function upsertWorkflow(event, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const id = String(inp.id || '').trim();
  if (!ID_RE.test(id)) throw new Error('Invalid workflow id.');
  if (!cleanStr(inp.tag, 80, '')) throw new Error('A trigger tag is required.');
  const doc = await loadDefinitions(event);
  const seed = cfg.getWorkflow(id);
  const base = seed || blankBase(id, doc.workflows[id] || inp);
  const def = sanitizeWorkflow(inp, base, seed ? 'published' : 'draft');
  const storedDef = clone(def);
  delete storedDef.source;
  doc.workflows[id] = storedDef;
  await saveDefinitions(event, doc);
  return resolveWorkflows(doc).map[id];
}

// Create a brand-new workflow (Draft, shared structure, empty texts).
async function createWorkflow(event, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const name = cleanStr(inp.name, 120, '');
  const tag = cleanStr(inp.tag, 80, '');
  if (!name) throw new Error('A workflow name is required.');
  if (!tag) throw new Error('A trigger tag is required.');
  const doc = await loadDefinitions(event);
  const taken = Object.assign({}, cfg.WORKFLOWS, doc.workflows);
  const id = uniqueId(slugify(name), taken);
  const def = sanitizeWorkflow({ name, tag, status: 'draft' }, blankBase(id, { name, tag }), 'draft');
  const storedDef = clone(def);
  delete storedDef.source;
  doc.workflows[id] = storedDef;
  await saveDefinitions(event, doc);
  return resolveWorkflows(doc).map[id];
}

// Duplicate an existing (effective) workflow under a fresh id.
// The copy starts as Draft and keeps the source's sender pool.
async function duplicateWorkflow(event, id, name) {
  const doc = await loadDefinitions(event);
  const eff = resolveWorkflows(doc);
  const src = eff.map[id];
  if (!src) throw new Error('Unknown workflow: ' + id);
  const taken = Object.assign({}, cfg.WORKFLOWS, doc.workflows);
  const newName = cleanStr(name, 120, (src.name || id) + ' (copy)');
  const newId = uniqueId(slugify(newName), taken);
  const base = blankBase(newId, { name: newName, tag: src.tag, telnyxMarket: src.telnyxMarket });
  const def = sanitizeWorkflow(Object.assign(clone(src), { name: newName, status: 'draft' }), base, 'draft');
  const storedDef = clone(def);
  delete storedDef.source;
  doc.workflows[newId] = storedDef;
  await saveDefinitions(event, doc);
  return resolveWorkflows(doc).map[newId];
}

// Flip ONLY the status of a workflow, materializing a stored
// definition from the seed when none exists yet (so unpublishing a
// seed market actually stops it). Returns the effective def or null.
async function setStatus(event, id, status) {
  if (!ID_RE.test(String(id || ''))) throw new Error('Invalid workflow id.');
  const doc = await loadDefinitions(event);
  const eff = resolveWorkflows(doc);
  const cur = eff.map[id];
  if (!cur) return null;
  const storedDef = clone(cur);
  delete storedDef.source;
  storedDef.status = status;
  doc.workflows[id] = storedDef;
  await saveDefinitions(event, doc);
  return resolveWorkflows(doc).map[id];
}

module.exports = {
  STORE_NAME,
  DOC_KEY,
  PATHS,
  sanitizeWorkflow,
  resolveWorkflows,
  workflowByTagFrom,
  renderFirstTextFrom,
  blankBase,
  slugify,
  loadDefinitions,
  saveDefinitions,
  loadEffective,
  upsertWorkflow,
  createWorkflow,
  duplicateWorkflow,
  setStatus,
  _test: {
    setStoreFactory(fn) {
      storeFactory = fn || null;
    },
  },
};

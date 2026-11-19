// netlify/functions/realie-comps.js
// Property records + verified sold comps via Realie — the Command
// Center's property-data + comp feed (Troy, Nov 19, 2026: "Take
// everything that API has to offer and wire it up into the system").
// Replaces Resideline as the feed the Comps page actually uses:
// Realie returns the subject record (APN, legal description, owner,
// beds/baths/sqft/year, last sale, tax) AND the sold comps in one
// provider, which also fills the APN/legal gap the page had while
// the PropertyReach data-api pool is down. Keeps REALIE_API_KEY
// server-side (Netlify env vars, Functions scope); the key is never
// logged and never reaches the browser.
//
// Dashboard calls (same GET convention as data-api / resideline-comps):
//   GET  /.netlify/functions/realie-comps?address=<url-encoded address>
// Direct calls may instead POST a JSON body:
//   { address, beds?, baths?, sqft?, yearBuilt?, propertyType? }
// Caller facts are used ONLY for the baths rescue below — Realie is
// always queried by address alone, exactly as verified live.
//
// Upstream chain (1 token per successful 200 call; failures unbilled):
//   Step 1 — GET /api/public/property/address?address=<street line 1>
//     &state=<ST>. Returns { property } at the top level: parcelId (APN),
//     legalInformation.legalDescription, currentOwner, roomInformation,
//     buildingInformation (livingArea, actualYearBuilt), coordinates,
//     salesHistory, taxInformation, valuationInformation,
//     realieValuation (vendor values — reference only).
//   Step 2 — GET /api/public/premium/comparables/?latitude&longitude
//     &radius=1&timeFrame=18&maxResults=10&full=true. Returns
//     { comparables: [...] } with transferPrice + transferDateObject per
//     comp, plus per-comp APN / legal / beds / baths / sqft / lat-lng
//     in the full record. Distances are computed here (haversine)
//     from the real coordinates — the selection engine scores on them.
//
// TOKEN DISCIPLINE (free plan, 25 tokens/mo): every completed result
// — matched or insufficient — is cached server-side in Netlify Blobs
// (store 'realie-cache', keyed by the normalized address), so a
// repeat view of an address costs 0 tokens. Errors are never cached.
// There is no bulk or loop path: one address per call, two upstream
// calls maximum.
//
// BATHS QUIRK (verified live Nov 19, 2026): Realie's record for
// 3051 Eastern Ave carries 0 full / 0 half baths where the county
// record says 1. A Realie bath total of 0 is treated as MISSING,
// never as fact. When it is missing and the caller supplied a baths
// value (the page passes the existing property record's facts), the
// existing value is kept and the response flags it
// (bathsFromExisting: true, fieldAudit.baths =
// 'from-existing-record') so the page can disclose it. No other fact
// is ever filled this way, and nothing is ever assumed: sqft, beds,
// year built and type come from Realie or stay blank.
//
// FIELD AUDIT (Troy's rule): every response carries fieldAudit +
// missingFields for beds, baths, sqft, yearBuilt, propertyType, apn,
// legalDescription, owner, lastSale — missing fields are surfaced,
// never passed over silently.
//
// 3-COMP MINIMUM (unchanged): fewer than 3 sold comps returns
// { error: 'insufficient_comps' } with no comp set and no price
// verdict — but WITH the subject property block, so APN/legal/owner
// still land on the page. Realie's own valuation (realieValuation)
// is a VENDOR value: returned labeled (vendorArv / avm slot) and
// never an ARV — our comp-selection engine below (the same engine
// the Resideline feed used) produces the indication the offer math
// runs on. Non-arm's-length junk is screened by that engine's
// nominal-transfer rule (amount < $5,000 is not sales evidence —
// the Nov 19 Kansas City test set's $2,355 / $2,898 transfers are
// excluded by it) plus its median-outlier rules.
//
// ARV ACCURACY SCREENS (Nov 19, 2026, Troy's hard lock — born of
// the county audit of this very fixture set): (1) a transfer that
// Realie's own sales history flags distressed (distressedSale:
// true) or non-arm's-length (armsLength: false) is excluded with
// the flag named — the audit found 3220 N Keystone Ave ($96,143,
// county Valid=N) anchoring the best-3 on exactly such a flag;
// (2) a fact-less comp (no sqft AND no beds on record — 3808 E
// 31st St, a parcel with no building facts) may not enter the
// best-3 while 3+ factual candidates survive, and caps the
// confidence at MEDIUM when it has to fill a thin set.
'use strict';

const SUBJECT_URL = 'https://app.realie.ai/api/public/property/address';
const COMPS_URL = 'https://app.realie.ai/api/public/premium/comparables/';
const TIMEOUT_MS = 12000;
const CACHE_STORE = 'realie-cache';

/* ---------------- small numeric / date helpers ---------------- */

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(nums) { return nums.reduce((a, b) => a + b, 0) / nums.length; }
function round1(x) { return Math.round(x * 10) / 10; }
function fmtInt(x) { return Math.round(x).toLocaleString('en-US'); }

function todayParts() {
  const t = new Date();
  return { y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate() };
}
function monthsBetween(a, b) { return Math.abs((a.y - b.y) * 12 + (a.mo - b.mo)); }

function isoToParts(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], iso: m[0] };
}
function isoDateOf(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return isoToParts(s) ? s : null;
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// Great-circle distance in miles between two lat/lng points.
function haversineMiles(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------------- address parsing (mirrors data-api) ---------------- */

const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']);

function parseAddress(full) {
  const out = { street: '', city: '', state: '', zip: '' };
  if (!full) return out;
  let head = String(full).trim();
  const sz = head.match(/(?:^|,|\s)([A-Za-z]{2})\s*,?\s*(\d{5})(?:-\d{4})?\s*$/);
  if (sz && US_STATES.has(sz[1].toUpperCase())) {
    out.state = sz[1].toUpperCase();
    out.zip = sz[2];
    head = head.slice(0, sz.index).replace(/,\s*$/, '').trim();
  } else {
    const z = head.match(/\s+(\d{5})(?:-\d{4})?\s*$/);
    if (z) {
      out.zip = z[1];
      head = head.slice(0, z.index).replace(/,\s*$/, '').trim();
    }
  }
  const parts = head.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.city = parts[parts.length - 1];
    out.street = parts.slice(0, -1).join(', ');
    return out;
  }
  out.street = head;
  return out;
}

/* ---------------- address normalization (mirrors resideline-comps round 5) ----------------
   The Comps page sends addresses exactly as typed, often comma-less
   and lowercase ("229 plaza ave waterbury ct 06710"). normalizeAddress
   rebuilds such an address into the standard "Street, City, ST ZIP"
   form so parseAddress can split street / city / state reliably for
   the Realie call. Already-comma'd input is returned untouched. */

const STREET_SUFFIXES = new Set([
  'ave', 'avenue', 'st', 'street', 'rd', 'road', 'dr', 'drive', 'ln',
  'lane', 'blvd', 'boulevard', 'ct', 'court', 'pl', 'place', 'way',
  'ter', 'terr', 'terrace', 'cir', 'circle', 'hwy', 'highway',
  'pkwy', 'parkway', 'trl', 'trail', 'aly', 'alley', 'sq', 'square',
  'loop', 'run', 'row', 'pass', 'pt', 'point', 'xing', 'crossing',
]);
const UNIT_DESIGNATORS = new Set(['apt', 'unit', 'ste', 'suite', '#']);
const DIRECTIONAL_TOKENS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

function titleCaseToken(tok) {
  const lower = tok.toLowerCase();
  if (DIRECTIONAL_TOKENS.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function normalizeAddress(addr) {
  if (addr === null || addr === undefined) return addr;
  const original = String(addr);
  const trimmed = original.trim();
  if (!trimmed || trimmed.includes(',')) return original;
  const m = trimmed.match(/^(.*?)\s+([A-Za-z]{2})\s+(\d{5})(-\d{4})?\s*$/);
  if (!m) return original;
  const tokens = m[1].split(/\s+/).filter(Boolean);
  let suffixIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (STREET_SUFFIXES.has(tokens[i].toLowerCase().replace(/\.$/, ''))) suffixIdx = i;
  }
  if (suffixIdx < 0) return original;
  let streetEnd = suffixIdx;
  const next = tokens[suffixIdx + 1];
  if (next !== undefined) {
    if (UNIT_DESIGNATORS.has(next.toLowerCase().replace(/\.$/, ''))
      && tokens[suffixIdx + 2] !== undefined) {
      streetEnd = suffixIdx + 2;
    } else if (next.charAt(0) === '#' && next.length > 1) {
      streetEnd = suffixIdx + 1;
    }
  }
  const streetTokens = tokens.slice(0, streetEnd + 1);
  streetTokens[suffixIdx] = streetTokens[suffixIdx].replace(/\.$/, '');
  const cityTokens = tokens.slice(streetEnd + 1);
  if (!cityTokens.length) return original;
  const zip = m[3] + (m[4] || '');
  return streetTokens.map(titleCaseToken).join(' ')
    + ', ' + cityTokens.map(titleCaseToken).join(' ')
    + ', ' + m[2].toUpperCase() + ' ' + zip;
}

/* ---------------- request shaping ---------------- */

// Normalizes POST JSON and GET query params into one input shape.
// Caller facts are carried for the baths rescue only (see header).
function parseInput(event) {
  let raw = {};
  if (event.httpMethod === 'POST') {
    try { raw = JSON.parse(event.body || '{}'); } catch (e) { return { error: 'bad_json' }; }
  } else {
    raw = event.queryStringParameters || {};
  }
  const pick = (a, c) => (a !== undefined && a !== null && a !== '' ? a : c);
  return {
    address: String(raw.address || '').trim(),
    beds: numOrNull(raw.beds),
    baths: numOrNull(raw.baths),
    sqft: numOrNull(pick(raw.sqft, raw.sqft_size)),
    yearBuilt: numOrNull(pick(raw.yearBuilt, raw.subject_year_built)),
    propertyType: raw.propertyType || raw.property_type || null,
  };
}

/* ---------------- result cache (Netlify Blobs) ----------------
   One entry per normalized address holding the final response body.
   L1 is a module-level Map (warm-invocation repeats); L2 is Blobs
   (survives cold starts). Any cache failure degrades to a live pull —
   the cache must never break a comp run. */

const _memCache = new Map();
let _blobs = null;
try { _blobs = require('@netlify/blobs'); } catch (e) { _blobs = null; }
let _storeOverride = null; // tests only (see _test)

function cacheKeyFor(normalizedAddress) {
  return 'v1:' + String(normalizedAddress || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCacheStore(event) {
  if (_storeOverride) return _storeOverride;
  if (!_blobs) return null;
  try {
    if (typeof _blobs.connectLambda === 'function') _blobs.connectLambda(event);
    return _blobs.getStore(CACHE_STORE);
  } catch (e) {
    return null;
  }
}

async function cacheRead(event, key) {
  if (_memCache.has(key)) return _memCache.get(key);
  const s = getCacheStore(event);
  if (!s) return null;
  try {
    const v = await s.get(key, { type: 'json' });
    if (v && typeof v === 'object') {
      _memCache.set(key, v);
      return v;
    }
  } catch (e) { /* cache is best-effort */ }
  return null;
}

async function cacheWrite(event, key, body) {
  _memCache.set(key, body);
  const s = getCacheStore(event);
  if (!s) return;
  try {
    await s.set(key, JSON.stringify(body), { contentType: 'application/json' });
  } catch (e) { /* cache is best-effort */ }
}

/* ---------------- upstream calls ---------------- */

function buildSubjectUrl(street, state) {
  return SUBJECT_URL
    + '?address=' + encodeURIComponent(street)
    + '&state=' + encodeURIComponent(state);
}

function buildCompsUrl(lat, lon) {
  return COMPS_URL
    + '?latitude=' + encodeURIComponent(lat)
    + '&longitude=' + encodeURIComponent(lon)
    + '&radius=1&timeFrame=18&maxResults=10&full=true';
}

// One upstream GET with its own timeout. Returns { status, ok, data };
// data is the parsed JSON body or null. Throws only on network /
// timeout failure (the handler maps that to upstream_failed).
async function callUpstream(url, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': apiKey,
        'Accept': 'application/json',
      },
    });
    const raw = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* mapped by status below */ }
    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

// Status-driven error mapping; upstream bodies are never forwarded.
function mapUpstreamError(status) {
  if (status === 402) return { statusCode: 402, body: { error: 'credits_exhausted' } };
  if (status === 401 || status === 403) return { statusCode: 403, body: { error: 'invalid_key' } };
  if (status === 404) return { statusCode: 404, body: { error: 'not_found' } };
  if (status === 400) return { statusCode: 400, body: { error: 'bad_input' } };
  if (status === 422) return { statusCode: 422, body: { error: 'validation_failed' } };
  return { statusCode: 502, body: { error: 'upstream_error' } };
}

/* ---------------- subject mapping: Realie property -> dashboard shape ---------------- */

// Bath total from a rooms/building pair: full + 0.5 * half. A total of
// exactly 0 is NOT a fact (see the header's baths quirk) — it returns
// null so the audit marks baths missing and the rescue can apply.
function bathTotal(rooms, building) {
  const full = numOrNull(rooms && rooms.fullBathCount != null ? rooms.fullBathCount
    : (building ? building.fullBathrooms : null));
  const half = numOrNull(rooms && rooms.halfBathCount != null ? rooms.halfBathCount
    : (building ? building.halfBathrooms : null));
  if (full == null && half == null) {
    const bc = numOrNull(rooms && rooms.bathCount);
    return bc != null && bc > 0 ? bc : null;
  }
  const total = (full || 0) + 0.5 * (half || 0);
  return total > 0 ? total : null;
}

// Human property-type label from Realie's classification. Only the
// distinctions Realie itself states are mapped; anything else stays
// blank rather than invented.
function realiePropertyType(p) {
  const pc = (p && p.propertyClassification) || {};
  if (pc.condo) return 'Condo';
  if (pc.residential) {
    const units = numOrNull(p.generalInformation && p.generalInformation.numberOfUnits);
    return units != null && units > 1 ? 'Multi-Family' : 'Single Family';
  }
  return '';
}

// Most recent PRICED sale in the subject's sales history. Nominal /
// $0 transfers (deeds into trusts, foreclosure shuffles) are not the
// last sale a buyer means; when no priced sale exists both stay null.
function lastPricedSale(p) {
  const hist = Array.isArray(p && p.salesHistory) ? p.salesHistory : [];
  const priced = hist
    .filter(s => s && numOrNull(s.salePrice) > 0 && isoDateOf(s.saleDate))
    .sort((a, b) => String(b.saleDate).localeCompare(String(a.saleDate)));
  if (!priced.length) return { amount: null, date: null };
  return { amount: numOrNull(priced[0].salePrice), date: isoDateOf(priced[0].saleDate) };
}

// Maps data.property into the dashboard property block (the exact key
// set the Comps page consumes from data-api) plus the engine subject
// and the field-audit inputs. input carries caller facts for the
// baths rescue only.
function mapRealieSubject(p, input, fallbackAddress) {
  const building = (p.buildingInformation && Array.isArray(p.buildingInformation.buildings)
    && p.buildingInformation.buildings[0]) || {};
  const rooms = p.roomInformation || {};
  const owner = (p.propertyIdentification && p.propertyIdentification.currentOwner) || {};
  const loc = p.propertyLocation || {};
  const coords = p.coordinates || {};
  const tax = p.taxInformation || {};
  const val = p.valuationInformation || {};
  const land = p.landInformation || {};
  const mortgages = Array.isArray(p.mortgages) ? p.mortgages : [];

  const beds = numOrNull(rooms.bedCount != null ? rooms.bedCount : building.totalBedrooms);
  let baths = bathTotal(rooms, building);
  let bathsFromExisting = false;
  const realieGaps = [];
  if (baths == null) {
    realieGaps.push('baths');
    if (input && input.baths != null) {
      baths = input.baths;
      bathsFromExisting = true;
    }
  }
  const sqft = numOrNull(building.livingArea);
  const yearBuilt = numOrNull(building.actualYearBuilt != null
    ? building.actualYearBuilt : building.effectiveYearBuilt);
  const propertyType = realiePropertyType(p);
  const sale = lastPricedSale(p);
  const lat = numOrNull(coords.latitude != null ? coords.latitude : p.latitude);
  const lon = numOrNull(coords.longitude != null ? coords.longitude : p.longitude);
  const freeAndClear = mortgages.length === 0;
  const m0 = mortgages[0] || null;

  const flags = [];
  const absentee = owner.ownerOccupied === false ? true
    : (owner.ownerOccupied === true ? false : null);
  if (absentee) flags.push('absentee_owner');
  if (freeAndClear) flags.push('free_and_clear');
  else flags.push('mortgage_on_record');
  if (sale.date) {
    const sp = isoToParts(sale.date);
    if (sp && monthsBetween(sp, todayParts()) >= 120) flags.push('long_term_owner');
  }
  if (owner.ownerName2) flags.push('two_owners_on_record');

  const fullAddress = loc.addressFull || fallbackAddress || '';
  const property = {
    owner1: owner.ownerName || null,
    owner2: owner.ownerName2 || null,
    mailingAddress: owner.ownerFullAddress || null,
    absentee,
    apn: p.parcelId || null,
    legalDescription: (p.legalInformation && p.legalInformation.legalDescription) || null,
    zoning: (p.zoningInfo && p.zoningInfo.zoningCode) || null,
    propertyType: propertyType || null,
    beds,
    baths,
    sqft,
    yearBuilt,
    lotSqft: numOrNull(land.totalLandArea),
    lotAcres: land.acres != null ? Math.round(Number(land.acres) * 1000) / 1000 : null,
    latitude: lat,
    longitude: lon,
    lastSaleAmount: sale.amount,
    lastSaleDate: sale.date,
    assessedValue: numOrNull(val.totalAssessedValue),
    marketValue: numOrNull(val.totalMarketValue),
    taxAmount: numOrNull(tax.taxAmount),
    taxYear: numOrNull(tax.taxYear),
    freeAndClear,
    mortgage: freeAndClear || !m0 ? null : {
      lender: m0.lender || null,
      amount: numOrNull(m0.amount),
      loanType: null,
      termMonths: m0.term != null && String(m0.termUnit || '').toLowerCase().startsWith('month')
        ? numOrNull(m0.term) : null,
      dueDate: isoDateOf(m0.dueDate),
      recordedDate: isoDateOf(m0.recordingDate),
    },
    flags,
    address: fullAddress,
  };
  const subject = {
    address: fullAddress,
    beds,
    baths,
    sqft,
    yearBuilt,
    propertyType: propertyType || '',
  };
  return { property, subject, bathsFromExisting, realieGaps, lat, lon };
}

/* ---------------- field audit (Troy's rule) ---------------- */

const AUDIT_FIELDS = [
  ['beds', 'Beds'],
  ['baths', 'Baths'],
  ['sqft', 'Sq ft'],
  ['yearBuilt', 'Year built'],
  ['propertyType', 'Type'],
  ['apn', 'APN'],
  ['legalDescription', 'Legal description'],
  ['owner', 'Owner'],
  ['lastSale', 'Last sale'],
];

function buildFieldAudit(property, bathsFromExisting) {
  const present = {
    beds: property.beds != null,
    baths: property.baths != null,
    sqft: property.sqft != null,
    yearBuilt: property.yearBuilt != null,
    propertyType: !!property.propertyType,
    apn: !!property.apn,
    legalDescription: !!property.legalDescription,
    owner: !!property.owner1,
    lastSale: property.lastSaleAmount != null && !!property.lastSaleDate,
  };
  const audit = {};
  const missingFields = [];
  for (const [key, label] of AUDIT_FIELDS) {
    if (key === 'baths' && bathsFromExisting) {
      audit.baths = 'from-existing-record';
      continue;
    }
    audit[key] = present[key] ? 'ok' : 'missing';
    if (!present[key]) missingFields.push(label);
  }
  return { audit, missingFields };
}

/* ---------------- comp mapping: Realie comparable -> engine row ---------------- */

// The sale that makes a row a comp is the salesHistory entry whose
// date AND price match the transfer (the history also carries older
// sales, whose flags describe THOSE sales, not this one). Realie
// flags the matching entry when the sale was distressed
// (distressedSale: true) or non-arm's-length (armsLength: false).
// A field absent on the matching entry means not flagged.
function saleFlagsFor(c, amount, date) {
  const nested = (c && c.property) || {};
  const hist = Array.isArray(nested.salesHistory) ? nested.salesHistory : [];
  if (amount == null || !date) return [];
  const entry = hist.find(s => s && isoDateOf(s.saleDate) === date && numOrNull(s.salePrice) === amount);
  if (!entry) return [];
  const flags = [];
  if (entry.distressedSale === true) flags.push('distressedSale: true');
  if (entry.armsLength === false) flags.push('armsLength: false');
  return flags;
}

function mapRealieComp(c, subjLat, subjLon) {
  const nested = (c && c.property) || {};
  const nLoc = nested.propertyLocation || {};
  const nRooms = nested.roomInformation || {};
  const nBuilding = (nested.buildingInformation && Array.isArray(nested.buildingInformation.buildings)
    && nested.buildingInformation.buildings[0]) || {};
  const amount = numOrNull(c && c.transferPrice);
  const sqft = numOrNull((c && c.realieSquareFootage) != null
    ? c.realieSquareFootage : nBuilding.livingArea);
  const date = isoDateOf(c && c.transferDateObject);
  const lat = numOrNull(c && c.latitude);
  const lon = numOrNull(c && c.longitude);
  const dist = haversineMiles(subjLat, subjLon, lat, lon);
  let baths = numOrNull(c && c.totalBathrooms);
  if (baths == null) {
    const bt = bathTotal(nRooms, nBuilding);
    if (bt != null) baths = bt;
  }
  const address = nLoc.addressFull
    || [c && c.address, c && c.city, c && c.state].filter(Boolean).join(', ');
  return {
    address,
    amount: amount != null && amount > 0 ? amount : null,
    date,
    dateParts: isoToParts(date),
    ppsf: amount && sqft ? amount / sqft : null,
    sqft,
    beds: numOrNull((c && c.totalBedrooms) != null ? c.totalBedrooms : nRooms.bedCount),
    baths,
    distance: dist != null ? Math.round(dist * 100) / 100 : 99,
    latitude: lat,
    longitude: lon,
    similarityScore: null,
    apn: (c && c.parcelId) || nested.parcelId || null,
    legalDescription: (nested.legalInformation && nested.legalInformation.legalDescription) || null,
    saleFlags: saleFlagsFor(c, amount, date),
  };
}

/* ---------------- comp filter + scoring (same engine as the previous feeds) ----------------
   Nominal transfers out, median outliers excluded in both directions
   with logged reasons, similarity scoring, hard similarity rules,
   deterministic best-3, plain confidence label. Realie rows are
   recorded sales it selected against the radius/timeframe we sent;
   the amount/outlier filters below are what guard the set. Two
   Realie-only screens sit on top (Nov 19, 2026 ARV accuracy lock):
   transfers Realie itself flags distressed / non-arm's-length are
   excluded before every other screen, and fact-less comps (no sqft
   and no beds) cannot anchor the best-3 while factual candidates
   survive. */

// A comp is fact-less when Realie carries neither a living area nor
// a bed count for the parcel (both missing/zero) — e.g. a land-only
// parcel record with a real sale price but no building facts.
function isFactLessComp(c) {
  return !(Number(c && c.sqft) > 0) && !(Number(c && c.beds) > 0);
}

function analyzeComps(subj, comps, today) {
  today = today || todayParts();
  const excluded = [];
  const candidates = [];
  const priced = comps.filter(c => c.amount);
  const med = priced.length ? median(priced.map(c => c.amount)) : null;

  for (const c of comps) {
    if (Array.isArray(c.saleFlags) && c.saleFlags.length) {
      excluded.push({ comp: c, reason: `flagged transfer (${c.saleFlags.join(' + ')}) — distressed/non-arm's-length sale per Realie sales history, not arm's-length sales evidence` });
      continue;
    }
    if (!c.amount || c.amount < 5000) {
      excluded.push({ comp: c, reason: 'nominal/zero-amount transfer — not sales evidence' });
      continue;
    }
    if (med && c.amount > 2.5 * med) {
      excluded.push({ comp: c, reason: `outlier above pocket (>$${fmtInt(2.5 * med)} = 2.5x median) — likely bundled/new-build sale, kept as upper-pocket note` });
      continue;
    }
    if (med && c.amount < 0.6 * med
        && priced.filter(x => x.amount && x.amount >= 0.6 * med).length >= 3) {
      excluded.push({ comp: c, reason: `low outlier (<$${fmtInt(0.6 * med)} = 0.6x median) — distressed/low-tail sale, flagged as as-is anchor evidence, not averaged` });
      continue;
    }
    candidates.push(c);
  }

  const candMed = candidates.length ? median(candidates.map(c => c.amount)) : null;
  const isVacant = String((subj && subj.propertyType) || '').toUpperCase().includes('VACANT');

  if (candidates.length === 2) {
    const sorted = [...candidates].sort((a, b) => a.amount - b.amount);
    if (sorted[0].amount < 0.6 * sorted[1].amount) sorted[0].thinLowOutlier = true;
  }

  for (const c of candidates) {
    let score = 0;
    const dev = [];
    score += c.distance * 10;
    if (c.distance >= 99) dev.push('distance unknown');
    else if (c.distance > 1) dev.push(`${c.distance.toFixed(2)} mi (>1 mi rule)`);
    if (candMed && Math.abs(c.amount - candMed) / candMed <= 0.20) {
      score -= 3; // price sits inside the pocket cluster
    }
    if (c.dateParts) {
      const m = monthsBetween(c.dateParts, today);
      score += Math.min(m, 12) * 0.3 + Math.max(0, m - 12) * 0.6;
      if (m > 12) dev.push(`sold ${m} mo ago (>12 mo rule)`);
    } else {
      score += 12;
      dev.push('no sale date');
    }
    const ss = subj ? subj.sqft : null;
    const cs = c.sqft;
    if (ss && cs) {
      if (Math.abs(cs - ss) / ss > 0.20) { score += 15; dev.push('sqft outside +-20%'); }
      else score += (Math.abs(cs - ss) / ss) * 20;
    } else if (subj && subj.propertyType && !isVacant) {
      score += 8;
      dev.push('sqft missing — similarity unverified');
    }
    const sb = subj ? subj.beds : null;
    const cb = c.beds;
    const cbMissing = cb === null || cb === undefined || cb === '' || cb === '0' || cb === 0;
    if (sb && !cbMissing && Math.abs(Number(cb) - Number(sb)) > 1) {
      score += 6;
      dev.push('bed count differs by >1');
    } else if (cbMissing && subj && subj.propertyType && !isVacant) {
      dev.push('beds missing');
    }
    c.score = round1(score);
    c.deviations = dev;
  }

  // Deterministic pick: ties on score break by amount, then address.
  candidates.sort((a, b) => (a.score - b.score) || (a.amount - b.amount) || String(a.address || '').localeCompare(String(b.address || '')));

  function hardFailReasons(c) {
    const reasons = [];
    if (subj && subj.sqft && c.sqft && Math.abs(c.sqft - subj.sqft) / subj.sqft > 0.20) reasons.push('sqft outside ±20%');
    const cbMissing = c.beds === null || c.beds === undefined || c.beds === '' || c.beds === '0' || c.beds === 0;
    if (subj && subj.beds && !cbMissing && Math.abs(Number(c.beds) - Number(subj.beds)) > 1) reasons.push('bed count differs by >1');
    if (c.dateParts && monthsBetween(c.dateParts, today) > 12) reasons.push('sold >12 mo ago');
    if (c.distance != null && c.distance < 99 && c.distance > 2) reasons.push('distance >2 mi');
    return reasons;
  }
  const hardPassing = [];
  const hardFailing = [];
  for (const c of candidates) {
    const r = hardFailReasons(c);
    if (r.length) hardFailing.push({ comp: c, reason: 'hard rule: ' + r.join('; ') });
    else hardPassing.push(c);
  }
  // FACT-LESS RULE (Realie feed only, Nov 19, 2026): a comp with no
  // sqft AND no beds on record may not anchor the best-3 while 3+
  // factual candidates survive the screens — it stays a candidate
  // (pocket / as-is evidence) but cannot set the number. With fewer
  // than 3 factual candidates it may fill the set (thin-set
  // behavior), and the confidence cap below then applies.
  const factualCandidates = candidates.filter(c => !isFactLessComp(c));
  let best;
  if (factualCandidates.length >= 3) {
    const factualHard = hardPassing.filter(c => !isFactLessComp(c));
    if (factualHard.length >= 3) {
      best = factualHard.slice(0, 3);
      for (const h of hardFailing) excluded.push(h);
    } else {
      best = factualCandidates.slice(0, 3);
    }
  } else if (hardPassing.length >= 3) {
    best = hardPassing.slice(0, 3);
    for (const h of hardFailing) excluded.push(h);
  } else {
    best = candidates.slice(0, 3);
  }

  const result = { excluded, candidates, best, unverified: [] };
  if (best.length) {
    const prices = best.map(c => c.amount);
    result.indication = mean(prices);
    result.rangeLow = Math.min(...prices);
    result.rangeHigh = Math.max(...prices);
    const ppsfs = best.filter(c => c.ppsf).map(c => c.ppsf);
    if (ppsfs.length && subj && subj.sqft) result.ppsfCheck = mean(ppsfs) * subj.sqft;
    const missing = best.filter(c => c.deviations.length).length;
    const totalDev = best.reduce((s, c) => s + c.deviations.length, 0);
    if (best.length === 3 && missing === 0) {
      result.confidence = 'HIGH';
      result.confidenceText = 'HIGH — 3 comps pass all selection rules';
    } else if (best.length === 3 && totalDev >= 7) {
      result.confidence = 'LOW-MEDIUM';
      result.confidenceText = 'LOW-MEDIUM — 3 comps used but the set is thin (many rule deviations); county verification is required before any number from this set is used';
    } else if (best.length === 3) {
      result.confidence = 'MEDIUM';
      result.confidenceText = 'MEDIUM — 3 comps used, deviations noted per comp';
    } else {
      result.confidence = 'LOW';
      result.confidenceText = 'LOW — fewer than 3 usable comps, do not lock a number on this set';
    }
    // A best set that had to lean on a fact-less comp (no sqft, no
    // beds on record) is never HIGH confidence, however clean the
    // rest of the set looks.
    if (best.some(c => isFactLessComp(c)) && result.confidence === 'HIGH') {
      result.confidence = 'MEDIUM';
      result.confidenceText = 'MEDIUM — best set includes a comp with no sqft/beds on record (fact-less); confidence capped at MEDIUM';
    }
    const candPpsfs = candidates.filter(c => c.ppsf).map(c => c.ppsf);
    if (candPpsfs.length >= 3) {
      const medPpsf = median(candPpsfs);
      const low = candidates.filter(c => c.ppsf)
        .reduce((a, b) => (b.ppsf < a.ppsf ? b : a));
      if (low.ppsf <= 0.7 * medPpsf) result.asIsAnchor = low;
    }
  } else {
    result.confidence = 'LOW';
    result.confidenceText = 'LOW — no usable comps after filters';
  }
  const upper = excluded.filter(e => e.reason.includes('upper-pocket')).map(e => e.comp);
  if (upper.length) result.upperPocket = upper;
  return result;
}

/* ---------------- output shaping (mirrors data-api compOut) ---------------- */

function compOut(c) {
  return {
    address: c.address,
    amount: c.amount != null ? Math.round(c.amount) : null,
    date: c.date || null,
    distance: c.distance != null ? Math.round(c.distance * 100) / 100 : null,
    sqft: c.sqft || null,
    beds: c.beds != null && c.beds !== '' ? c.beds : null,
    baths: c.baths != null && c.baths !== '' ? c.baths : null,
    latitude: c.latitude != null ? c.latitude : null,
    longitude: c.longitude != null ? c.longitude : null,
    ppsf: c.ppsf ? Math.round(c.ppsf * 100) / 100 : null,
    score: c.score != null ? c.score : null,
    deviations: c.deviations || [],
    similarityScore: c.similarityScore != null ? c.similarityScore : null,
    apn: c.apn || null,
    legalDescription: c.legalDescription || null,
    source: 'Realie',
  };
}

function shapeCompsResult(res, returnedCount) {
  return {
    criteria: 'realie',
    searchCriteria: null,
    returnedCount,
    candidateCount: res.candidates.length,
    indication: res.indication != null ? Math.round(res.indication) : null,
    range: res.indication != null ? { low: Math.round(res.rangeLow), high: Math.round(res.rangeHigh) } : null,
    ppsfCheck: res.ppsfCheck != null ? Math.round(res.ppsfCheck) : null,
    confidence: res.confidence,
    confidenceText: res.confidenceText,
    best: res.best.map(compOut),
    excluded: res.excluded.map(e => ({
      address: e.comp.address,
      amount: e.comp.amount != null ? Math.round(e.comp.amount) : null,
      reason: e.reason,
    })),
    upperPocket: (res.upperPocket || []).map(compOut),
    asIsAnchor: res.asIsAnchor ? compOut(res.asIsAnchor) : null,
    unverified: [],
  };
}

/* ---------------- handler ---------------- */

function json(statusCode, headers, obj) {
  return { statusCode, headers, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, corsHeaders, { error: 'Method Not Allowed' });
  }

  const apiKey = process.env.REALIE_API_KEY;
  if (!apiKey) {
    return json(503, corsHeaders, {
      status: 'not_configured',
      error: 'not_configured',
      setup: 'Add REALIE_API_KEY to this Netlify site\u2019s environment variables (Functions scope), then redeploy.',
    });
  }

  const input = parseInput(event);
  if (input.error === 'bad_json') {
    return json(400, corsHeaders, { error: 'bad_json' });
  }
  if (!input.address) {
    return json(400, corsHeaders, { error: 'missing_address' });
  }

  // Normalize a comma-less address once; the normalized form drives
  // the street/state split, the cache key and the response subject.
  input.address = normalizeAddress(input.address);
  const parsed = parseAddress(input.address);
  if (!parsed.street) {
    return json(400, corsHeaders, { error: 'missing_address' });
  }
  if (!parsed.state) {
    return json(400, corsHeaders, {
      error: 'bad_input',
      code: 'STATE_REQUIRED',
      suggestion: 'Include the 2-letter state in the address (e.g. "3051 Eastern Ave, Indianapolis, IN 46218").',
    });
  }

  const key = cacheKeyFor(input.address);
  const cached = await cacheRead(event, key);
  if (cached) {
    console.log('[realie-comps] cache hit address=' + input.address);
    return json(200, corsHeaders, Object.assign({}, cached, { cached: true, tokensSpent: 0 }));
  }

  try {
    // ---- Step 1: subject record (1 token on success).
    const s = await callUpstream(buildSubjectUrl(parsed.street, parsed.state), apiKey);
    if (!s.ok) {
      const mapped = mapUpstreamError(s.status);
      return json(mapped.statusCode, corsHeaders, Object.assign({ source: 'realie' }, mapped.body));
    }
    const prop = s.data && s.data.property;
    if (!prop) {
      return json(404, corsHeaders, { source: 'realie', error: 'not_found' });
    }
    const mapped = mapRealieSubject(prop, input, input.address);
    const { property, subject } = mapped;
    const { audit, missingFields } = buildFieldAudit(property, mapped.bathsFromExisting);
    const vendorVal = (prop.realieValuation && prop.realieValuation.comp) || {};
    const vendorArv = numOrNull(vendorVal.value);
    const vendorInterval = [numOrNull(vendorVal.low), numOrNull(vendorVal.high)];
    console.log('[realie-comps] subject ok apn=' + (property.apn || 'none')
      + ' missing=' + (missingFields.join(',') || 'none') + ' address=' + input.address);

    const base = {
      source: 'realie',
      address: property.address || input.address,
      property,
      avm: vendorArv != null ? {
        value: Math.round(vendorArv),
        low: vendorInterval[0] != null ? Math.round(vendorInterval[0]) : null,
        high: vendorInterval[1] != null ? Math.round(vendorInterval[1]) : null,
        score: null,
        note: 'Realie vendor value — screen only, never ARV',
      } : null,
      vendorArv: vendorArv != null ? Math.round(vendorArv) : null,
      vendorAsIs: null,
      vendorInterval: vendorInterval.map(v => (v != null ? Math.round(v) : null)),
      fieldAudit: audit,
      missingFields,
      bathsFromExisting: mapped.bathsFromExisting,
      realieGaps: mapped.realieGaps,
      linkedProperties: [],
      cached: false,
    };

    // No coordinates on the subject record: comps cannot be pulled.
    // The subject block still lands (APN/legal/owner) and the result
    // is cached — the subject token is spent either way.
    if (mapped.lat == null || mapped.lon == null) {
      const body = Object.assign({}, base, {
        matched: false,
        error: 'insufficient_comps',
        compsReturned: 0,
        comps: null,
        tokensSpent: 1,
      });
      await cacheWrite(event, key, body);
      return json(200, corsHeaders, body);
    }

    // ---- Step 2: sold comps (1 token on success).
    const c = await callUpstream(buildCompsUrl(mapped.lat, mapped.lon), apiKey);
    if (!c.ok) {
      const mappedErr = mapUpstreamError(c.status);
      return json(mappedErr.statusCode, corsHeaders, Object.assign({ source: 'realie' }, mappedErr.body));
    }
    const rawComps = (c.data && Array.isArray(c.data.comparables))
      ? c.data.comparables : [];
    const rows = rawComps.map(rc => mapRealieComp(rc, mapped.lat, mapped.lon));

    // 3-COMP MINIMUM: a thin upstream set is not a comp set — no
    // indication, no best picks, no price verdict from this source.
    // The subject block still returns (and is cached).
    if (rows.length < 3) {
      console.log('[realie-comps] insufficient comps=' + rows.length + ' address=' + input.address);
      const body = Object.assign({}, base, {
        matched: false,
        error: 'insufficient_comps',
        compsReturned: rows.length,
        comps: null,
        tokensSpent: 2,
      });
      await cacheWrite(event, key, body);
      return json(200, corsHeaders, body);
    }

    const analyzed = analyzeComps(subject, rows, todayParts());
    const comps = shapeCompsResult(analyzed, rows.length);
    console.log('[realie-comps] raw=' + rows.length + ' candidates=' + analyzed.candidates.length
      + ' best=' + analyzed.best.length + ' address=' + input.address);
    const body = Object.assign({}, base, {
      matched: true,
      comps,
      tokensSpent: 2,
    });
    await cacheWrite(event, key, body);
    return json(200, corsHeaders, body);
  } catch (err) {
    console.error('[realie-comps]', err && err.message);
    return json(502, corsHeaders, { source: 'realie', error: 'upstream_failed' });
  }
};

// Offline checks for realie-comps-regression.js (no network).
exports._test = {
  SUBJECT_URL,
  COMPS_URL,
  CACHE_STORE,
  parseAddress,
  normalizeAddress,
  parseInput,
  cacheKeyFor,
  buildSubjectUrl,
  buildCompsUrl,
  haversineMiles,
  bathTotal,
  realiePropertyType,
  lastPricedSale,
  mapRealieSubject,
  buildFieldAudit,
  mapRealieComp,
  saleFlagsFor,
  isFactLessComp,
  analyzeComps,
  shapeCompsResult,
  mapUpstreamError,
  _setStore(store) { _storeOverride = store; },
  _clearMemCache() { _memCache.clear(); },
};

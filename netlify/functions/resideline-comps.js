// netlify/functions/resideline-comps.js
// Verified comps via Resideline — the Command Center's primary comp feed
// (Troy, Nov 18, 2026: every Command Center comp pull runs off this API).
// Keeps RESIDELINE_API_KEY server-side (Netlify env vars, Functions scope);
// the key is never logged and never reaches the browser.
//
// Dashboard calls (same GET convention as data-api):
//   GET  /.netlify/functions/resideline-comps?address=<url-encoded address>
// Direct calls may instead POST a JSON body:
//   { address, beds?, baths?, sqft?, yearBuilt?, propertyType?,
//     bounds?: { radiusMiles?, maxAgeDays?, sqftBand?, yearBuiltDiff? } }
//
// Upstream chain (no standalone comps endpoint exists):
//   Step 0 — address normalization (round 5, Nov 18, 2026): an
//     address that reaches Resideline comma-less and lowercase
//     ("229 plaza ave waterbury ct 06710") fails upstream —
//     property_details 400s (facts=none) and property_value returns
//     ADDRESS_NORMALIZATION_FAILED — while the same address in the
//     standard "Street, City, ST ZIP" form works end to end. The
//     Comps page sends addresses exactly as typed, so the handler
//     runs normalizeAddress once and uses the normalized form for
//     every upstream call and the response subject. Input that
//     already contains a comma is left untouched.
//   Step 1 — POST /v1/api/property_details { address } — 0 credits.
//     Returns the subject facts (beds / baths / sqft / year built /
//     type). Resideline's valuation endpoint 400s with
//     INVALID_PROPERTY_DATA when it cannot enrich a property from the
//     address alone, so the facts are fetched first and sent in the
//     body (verified live Nov 18, 2026: address-only calls 400ed while
//     the key itself was accepted). Resideline's developer blog
//     documents the response shape: the facts nest under
//     `property_info` with the SAME field names the property_value
//     body takes (beds, baths, sqft_size, subject_year_built,
//     property_type) — parsePropertyDetails tries that location
//     first. The parser still accepts a broad alias set per fact and
//     searches the payload recursively (depth <= 3, arrays' first
//     elements included); when it finds nothing it logs the
//     payload's key structure only (details shape=…, keys, never
//     values) as the evidence trail for the real shape.
//   Step 2 — POST /v2/api/property_value?enrich_if_missing=true —
//     2 credits. Spec-exact body only: address, beds, baths, sqft_size,
//     subject_year_built, property_type. The sold comps ride inside the
//     valuation response — at the top level (data.comps) per the
//     published sample, or nested under data.property_valuation; both
//     locations are parsed (verified live Nov 18, 2026: a 200 response
//     carried a valuation with an empty top-level comps read).
//   Step 2b — ASSUMED-BATHS RETRY (round 4, Nov 18, 2026; Troy
//     delegated the design call: "do what you think is best for the
//     system"). Live evidence: Resideline's own record for some
//     houses is missing exactly ONE fact and its enrichment will not
//     fill the hole — 3051 Eastern Ave has beds/sqft/year/type on
//     record but NO baths, and every call without baths 400ed with
//     INVALID_PROPERTY_DATA, while the same call WITH baths returned
//     11 comps. The narrow, disclosed fix: when the first valuation
//     attempt fails 400 INVALID_PROPERTY_DATA and baths is the ONLY
//     missing fact among {beds, baths, sqft, yearBuilt,
//     propertyType}, retry the valuation ONCE with baths = 1 added
//     (every other body field unchanged). A successful retry (>= 1
//     comp) is marked in the response as assumedFacts: ["baths"],
//     and the Comps page discloses it on screen ("Baths not on
//     record — valued as 1 bath (assumed).") — the assumption is
//     never silent. NO other fact is EVER assumed: a missing sqft /
//     beds / year / type (alone or together with baths) gets no
//     retry and falls through to Step 3 unchanged. Failed calls are
//     not charged, so the retry costs 2 credits only when it
//     succeeds.
//   Step 3 — POST /v2/api/property_report — 10 credits on success,
//     ONLY when Step 2 produced fewer than 3 comps and the facts allow
//     it (this endpoint requires year_built + property_type). Two
//     attempts: report(min) sends the required fields only, then
//     report(full) adds beds/baths/sqft if the minimal body failed.
//     Failed upstream calls (HTTP >= 400) are not charged, so the
//     extra attempt is free. Its comps nest under
//     property_valuation.comps.
//   Property-type vocabulary differs by endpoint: property_value
//   takes "Single-family" / "Condo" / "Townhouse", property_report
//   takes "house" / "condo" / "townhouse" / "multi-family" — the
//   body builders normalize the stored type into each endpoint's
//   vocabulary (unknown types pass through unchanged).
//   The valuation/report responses' own arv_market_value / as_is_value
//   are VENDOR values: they come back clearly labeled as such
//   (vendorArv / vendorAsIs and the screen-only avm slot, same
//   convention as data-api) and are never an ARV — our comp-selection
//   engine below (ported from the previous comp engine when ATTOM was
//   removed, Nov 18, 2026) produces the indication the offer math
//   runs on.
//
// 3-COMP MINIMUM: fewer than 3 sold comps after every step returns
// { error: 'insufficient_comps' } with no comp set and no price verdict.
'use strict';

const DETAILS_URL = 'https://api.resideline.com/v1/api/property_details';
const API_URL = 'https://api.resideline.com/v2/api/property_value?enrich_if_missing=true';
const REPORT_URL = 'https://api.resideline.com/v2/api/property_report';
// Per-call timeout; the chain is at most 5 calls (details + value +
// assumed-baths retry + report(min) + report(full)) and the common
// path is 2, well under the function limit.
const TIMEOUT_MS = 15000;

// Legacy caller bounds: still parsed for input compatibility, but NOT
// forwarded upstream — the published property_value body has no bounds
// fields, and non-spec fields are what the spec-exact body avoids.
const DEFAULT_BOUNDS = { radiusMiles: 1, maxAgeDays: 365, sqftBand: 300, yearBuiltDiff: 20 };

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

// Resideline money fields arrive as FORMATTED STRINGS ("$528,700").
// Numbers pass through untouched; blank/garbage becomes null, never 0.
function parseMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const n = parseFloat(String(v).replace(/[$,]/g, '').trim());
  return isNaN(n) ? null : n;
}

// Resideline sold_date is "MM/DD/YYYY"; the dashboard comp shape uses ISO.
function soldDateToIso(s) {
  if (!s) return null;
  const str = String(s).trim();
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mo = String(+m[1]).padStart(2, '0');
  const d = String(+m[2]).padStart(2, '0');
  return `${m[3]}-${mo}-${d}`;
}
function isoToParts(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], iso: m[0] };
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

/* ---------------- address normalization (round 5) ----------------
   Resideline rejects a comma-less address (see the Step 0 header
   note). normalizeAddress rebuilds such an address into the
   standard "Street, City, ST ZIP" form: it only acts when the
   input has NO comma and ends in "<2-letter state> <5-digit ZIP>"
   (optional ZIP+4), splits street from city at the LAST street-
   suffix token (an optional unit designator + value right after
   the suffix stays with the street), and title-cases the result.
   Anything it cannot parse confidently — already-comma'd input,
   no ZIP tail, no suffix, an empty city — is returned unchanged. */

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
  // Capitalize the first letter, lowercase the rest. Numeric and
  // ordinal tokens ("229", "33rd") pass through unharmed: their
  // first character is a digit and the rest is already lowercase.
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
  // The street/city boundary is the LAST suffix token: a street
  // name may itself contain an earlier suffix word ("Ave Maria Ln").
  let suffixIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (STREET_SUFFIXES.has(tokens[i].toLowerCase().replace(/\.$/, ''))) suffixIdx = i;
  }
  if (suffixIdx < 0) return original;
  let streetEnd = suffixIdx;
  // An optional unit designator + its value right after the suffix
  // ("... St Apt 4", "... St # 4", "... St #4") belongs to the street.
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

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// Normalizes POST JSON and GET query params into one input shape.
function parseInput(event) {
  let raw = {};
  if (event.httpMethod === 'POST') {
    try { raw = JSON.parse(event.body || '{}'); } catch (e) { return { error: 'bad_json' }; }
  } else {
    raw = event.queryStringParameters || {};
  }
  const b = (raw && raw.bounds) || {};
  const pick = (a, c) => (a !== undefined && a !== null && a !== '' ? a : c);
  return {
    address: String(raw.address || '').trim(),
    beds: numOrNull(raw.beds),
    baths: numOrNull(raw.baths),
    sqft: numOrNull(pick(raw.sqft, raw.sqft_size)),
    yearBuilt: numOrNull(pick(raw.yearBuilt, raw.subject_year_built)),
    propertyType: raw.propertyType || raw.property_type || null,
    bounds: {
      radiusMiles: numOrNull(pick(b.radiusMiles, raw.radiusMiles)) ?? DEFAULT_BOUNDS.radiusMiles,
      maxAgeDays: numOrNull(pick(b.maxAgeDays, raw.maxAgeDays)) ?? DEFAULT_BOUNDS.maxAgeDays,
      sqftBand: numOrNull(pick(b.sqftBand, raw.sqftBand)) ?? DEFAULT_BOUNDS.sqftBand,
      yearBuiltDiff: numOrNull(pick(b.yearBuiltDiff, raw.yearBuiltDiff)) ?? DEFAULT_BOUNDS.yearBuiltDiff,
    },
  };
}

// Merges caller-supplied facts with facts fetched from
// property_details. Caller facts always win; fetched facts fill gaps.
function mergeFacts(input, fetched) {
  const f = fetched || {};
  return {
    beds: input.beds != null ? input.beds : (f.beds != null ? f.beds : null),
    baths: input.baths != null ? input.baths : (f.baths != null ? f.baths : null),
    sqft: input.sqft != null ? input.sqft : (f.sqft != null ? f.sqft : null),
    yearBuilt: input.yearBuilt != null ? input.yearBuilt : (f.yearBuilt != null ? f.yearBuilt : null),
    propertyType: input.propertyType || f.propertyType || null,
  };
}

/* ---------------- property-type vocabulary ----------------
   The two comp endpoints speak different type vocabularies:
   property_value examples use "Single-family" / "Condo" /
   "Townhouse"; property_report examples use "house" / "condo" /
   "townhouse" / "multi-family". A stored type is canonicalized
   (case-insensitive, spaces / hyphens / underscores ignored) and
   each body builder emits its endpoint's form. Unknown types pass
   through unchanged — never invent a mapping. */

const TYPE_VOCAB = {
  singlefamily: { value: 'Single-family', report: 'house' },
  house: { value: 'Single-family', report: 'house' },
  condo: { value: 'Condo', report: 'condo' },
  townhouse: { value: 'Townhouse', report: 'townhouse' },
  multifamily: { value: 'Multi-family', report: 'multi-family' },
};
function canonicalTypeKey(t) {
  return String(t == null ? '' : t).toLowerCase().replace(/[\s\-_]+/g, '');
}
function typeForValue(t) {
  if (!t) return t;
  const v = TYPE_VOCAB[canonicalTypeKey(t)];
  return v ? v.value : t;
}
function typeForReport(t) {
  if (!t) return t;
  const v = TYPE_VOCAB[canonicalTypeKey(t)];
  return v ? v.report : t;
}

// Builds the upstream property_value body — SPEC-EXACT per
// resideline.com/resideline-api: only address, beds, baths, sqft_size,
// subject_year_built, property_type may be sent. Facts ride along when
// known (caller first, property_details filling gaps) because an
// address-only call 400s with INVALID_PROPERTY_DATA on properties
// Resideline cannot enrich from the address alone. The type is
// emitted in property_value vocabulary.
function buildUpstreamBody(input, facts) {
  const f = facts || mergeFacts(input, null);
  const body = { address: input.address };
  if (f.beds != null) body.beds = f.beds;
  if (f.baths != null) body.baths = f.baths;
  if (f.sqft != null) body.sqft_size = f.sqft;
  if (f.yearBuilt != null) body.subject_year_built = f.yearBuilt;
  if (f.propertyType) body.property_type = typeForValue(f.propertyType);
  return body;
}

// Builds the property_report body. This endpoint REQUIRES year_built +
// property_type and names its size field `sqft` (not sqft_size). The
// type is emitted in property_report vocabulary. With opts.minimal
// the body carries ONLY the required fields (address, year_built,
// property_type) — the chain tries that first, since a fuller body
// gives the endpoint more fields it can reject as invalid data.
function buildReportBody(input, facts, opts) {
  const f = facts || mergeFacts(input, null);
  const body = {
    address: input.address,
    year_built: f.yearBuilt,
    property_type: typeForReport(f.propertyType),
  };
  if (opts && opts.minimal) return body;
  if (f.beds != null) body.beds = f.beds;
  if (f.baths != null) body.baths = f.baths;
  if (f.sqft != null) body.sqft = f.sqft;
  return body;
}

/* ---------------- property_details facts parsing ---------------- */

// First non-null value among a record's alias keys, in priority order.
function firstVal(rec, keys) {
  for (const k of keys) {
    if (rec[k] != null) return rec[k];
  }
  return null;
}

// Normalizes one property record (any of the shapes Resideline uses)
// into a facts object, or null when the record carries no facts.
// The documented property_info record uses the property_value body
// field names; the live payload's first deploy matched none of the
// originally guessed names — so each fact accepts a broad alias set.
// String numbers parse via numOrNull. Acceptance rule unchanged: any
// one field present makes the record a facts record.
const FACT_ALIASES = {
  beds: ['beds', 'bedrooms', 'bed_count', 'num_beds', 'bed'],
  baths: ['baths', 'bathrooms', 'bath_count', 'num_baths', 'total_baths', 'bath'],
  sqft: ['sqft', 'sqft_size', 'living_area', 'living_area_sqft', 'livingArea', 'building_area', 'gross_living_area', 'square_feet', 'size_sqft'],
  yearBuilt: ['yearBuilt', 'year_built', 'subject_year_built', 'yr_built', 'construction_year', 'built_year'],
  propertyType: ['propertyType', 'property_type', 'type', 'property_class', 'use_type', 'structure_type'],
};
function factsFromRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const facts = {
    beds: numOrNull(firstVal(rec, FACT_ALIASES.beds)),
    baths: numOrNull(firstVal(rec, FACT_ALIASES.baths)),
    sqft: numOrNull(firstVal(rec, FACT_ALIASES.sqft)),
    yearBuilt: numOrNull(firstVal(rec, FACT_ALIASES.yearBuilt)),
    propertyType: firstVal(rec, FACT_ALIASES.propertyType) || null,
  };
  const any = facts.beds != null || facts.baths != null || facts.sqft != null
    || facts.yearBuilt != null || facts.propertyType;
  return any ? facts : null;
}

// Depth-limited recursive search for a facts-bearing record: the
// record may hide under wrapper keys (property / result / record /
// subject / data / …) or inside an array's first element. The payload
// itself is depth 1; records are checked down to depth 3.
function findFactsRecursive(node, depth) {
  if (!node || typeof node !== 'object' || depth > 3) return null;
  if (Array.isArray(node)) {
    return node.length ? findFactsRecursive(node[0], depth + 1) : null;
  }
  const f = factsFromRecord(node);
  if (f) return f;
  if (depth >= 3) return null;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') {
      const r = findFactsRecursive(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// The property_details record may sit at the top level of the response
// or nested under a wrapper. Resideline's developer blog documents the
// facts nested under `property_info` (field names matching the
// property_value body 1:1) — that location is tried FIRST, then the
// previously known locations (property_details, possibly inside a
// data wrapper); the recursive walk is the fallback for whatever
// nesting the real payload actually uses.
function parsePropertyDetails(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    data.property_info,
    data.property_details,
    data.data && data.data.property_info,
    data.data && data.data.property_details,
    data.data,
    data,
  ];
  for (const c of candidates) {
    const f = factsFromRecord(c);
    if (f) return f;
  }
  return findFactsRecursive(data, 1);
}

// Diagnostic: the payload's KEY STRUCTURE only — recursive key paths
// to depth 3 (objects as key.subkey, arrays as key[0].subkey). Values
// are never included, so nothing about the property or the key can
// leak into logs; this is the evidence trail for the real
// property_details shape when the parser still finds no facts.
function shapeOf(data) {
  const paths = [];
  const walk = (node, prefix, depth) => {
    if (!node || typeof node !== 'object' || depth > 3 || paths.length >= 200) return;
    if (Array.isArray(node)) {
      if (node.length) walk(node[0], prefix + '[0]', depth + 1);
      return;
    }
    for (const k of Object.keys(node)) {
      const p = prefix ? prefix + '.' + k : k;
      paths.push(p);
      const v = node[k];
      if (v && typeof v === 'object') walk(v, p, depth + 1);
      if (paths.length >= 200) return;
    }
  };
  walk(data, '', 1);
  return paths.join(',');
}

// Comma list of the facts still null in a merged facts object — the
// fields a 400ing valuation call was missing locally.
function missingFactsList(f) {
  const m = [];
  if (!f || f.beds == null) m.push('beds');
  if (!f || f.baths == null) m.push('baths');
  if (!f || f.sqft == null) m.push('sqft');
  if (!f || f.yearBuilt == null) m.push('yearBuilt');
  if (!f || !f.propertyType) m.push('propertyType');
  return m.join(',');
}

// Merged facts -> a subject record in upstream field names, for
// mapSubject. Null when no fact is known at all.
function factsToSubjectRecord(facts, address) {
  if (!facts) return null;
  const any = facts.beds != null || facts.baths != null || facts.sqft != null
    || facts.yearBuilt != null || facts.propertyType;
  if (!any) return null;
  return {
    address: address || '',
    beds: facts.beds,
    baths: facts.baths,
    sqft: facts.sqft,
    year_built: facts.yearBuilt,
    property_type: facts.propertyType || '',
  };
}

// Compact facts rendering for log lines (values only, never the key).
function factsSummary(f) {
  if (!f) return 'none';
  const parts = [];
  if (f.beds != null) parts.push('beds:' + f.beds);
  if (f.baths != null) parts.push('baths:' + f.baths);
  if (f.sqft != null) parts.push('sqft:' + f.sqft);
  if (f.yearBuilt != null) parts.push('yb:' + f.yearBuilt);
  return parts.length ? parts.join(',') : 'none';
}

/* ---------------- response mapping: Resideline -> dashboard comp shape ---------------- */

// One upstream comp -> the internal row the selection engine scores.
// Field mapping (upstream -> dashboard compOut shape):
//   price -> amount, sold_date "MM/DD/YYYY" -> date ISO,
//   price_per_sqft -> ppsf, distance -> distance (miles, real value).
// Resideline returns no per-row coordinates and no arm's-length flag.
function mapComp(c) {
  const amount = c && c.price != null ? Number(c.price) : null;
  const sqft = c && c.sqft != null && Number(c.sqft) > 0 ? Number(c.sqft) : null;
  const date = soldDateToIso(c && c.sold_date);
  const distRaw = c && c.distance != null ? Number(c.distance) : NaN;
  return {
    address: (c && c.address) || '',
    amount: amount != null && !isNaN(amount) ? amount : null,
    date,
    dateParts: isoToParts(date),
    ppsf: c && c.price_per_sqft != null ? Number(c.price_per_sqft) : (amount && sqft ? amount / sqft : null),
    sqft,
    beds: c && c.beds != null ? c.beds : null,
    baths: c && c.baths != null ? c.baths : null,
    distance: isNaN(distRaw) ? 99 : distRaw,
    latitude: null,
    longitude: null,
    similarityScore: c && c.similarity_score != null ? Number(c.similarity_score) : null,
  };
}

function mapSubject(s) {
  if (!s) return null;
  return {
    address: s.address || '',
    beds: s.beds != null ? s.beds : null,
    baths: s.baths != null ? s.baths : null,
    sqft: s.sqft != null ? Number(s.sqft) : null,
    yearBuilt: s.year_built != null ? s.year_built : null,
    propertyType: s.property_type || '',
  };
}

// The property block in the exact key set the Comps page consumes from
// data-api. Resideline's valuation response carries no
// owner / mortgage / tax record — those stay null here and the page's
// existing subject merge (data provider) fills them when it matched.
function shapeProperty(subj, fallbackAddress) {
  const s = subj || {};
  return {
    owner1: null,
    owner2: null,
    mailingAddress: null,
    absentee: null,
    apn: null,
    legalDescription: null,
    zoning: null,
    propertyType: s.propertyType || null,
    beds: s.beds != null ? s.beds : null,
    baths: s.baths != null ? s.baths : null,
    sqft: s.sqft != null ? s.sqft : null,
    yearBuilt: s.yearBuilt != null ? s.yearBuilt : null,
    lotSqft: null,
    lotAcres: null,
    latitude: null,
    longitude: null,
    lastSaleAmount: null,
    lastSaleDate: null,
    assessedValue: null,
    marketValue: null,
    taxAmount: null,
    taxYear: null,
    freeAndClear: null,
    mortgage: null,
    flags: [],
    address: s.address || fallbackAddress || '',
  };
}

/* ---------------- comp filter + scoring (ported from the previous engine) ----------------
   Same engine rules as the previous comp path — nominal transfers out, median
   outliers excluded in both directions with logged reasons, similarity
   scoring, hard similarity rules, deterministic best-3, plain confidence
   label. One adaptation: Resideline reports no arm's-length indicator,
   so there is no unverified bucket — its rows are recorded sales it
   selected against the bounds we sent, and the amount/outlier filters
   below are what guard the set. */

function analyzeComps(subj, comps, today) {
  today = today || todayParts();
  const excluded = [];
  const candidates = [];
  const priced = comps.filter(c => c.amount);
  const med = priced.length ? median(priced.map(c => c.amount)) : null;

  for (const c of comps) {
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
  let best;
  if (hardPassing.length >= 3) {
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
    latitude: null,
    longitude: null,
    ppsf: c.ppsf ? Math.round(c.ppsf * 100) / 100 : null,
    score: c.score != null ? c.score : null,
    deviations: c.deviations || [],
    similarityScore: c.similarityScore != null ? c.similarityScore : null,
    source: 'Resideline',
  };
}

function shapeCompsResult(res, searchCriteria, returnedCount) {
  return {
    criteria: 'resideline',
    searchCriteria: searchCriteria || null,
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

/* ---------------- valuation / report response parsing ----------------
   One parser serves both property_value and property_report: comps
   and vendor values may sit at the top level OR nested under
   property_valuation (property_report always nests them; a live
   property_value 200 carried its valuation nested with an empty
   top-level comps read). The subject record may ride as `subject`
   (property_value) or `property_details` (property_report). */

function parseValuationPayload(data) {
  const out = {
    comps: [],
    vendorArv: null,
    vendorAsIs: null,
    interval: [null, null],
    subject: null,
    searchCriteria: null,
    confidence: null,
    confidenceScore: null,
    credits: { credits_charged: null, credits_remaining: null },
  };
  if (!data || typeof data !== 'object') return out;
  const pv = (data.property_valuation && typeof data.property_valuation === 'object')
    ? data.property_valuation : {};
  const pick = (a, b) => (a != null ? a : b);

  out.comps = Array.isArray(data.comps) ? data.comps
    : (Array.isArray(pv.comps) ? pv.comps : []);
  out.vendorArv = parseMoney(pick(data.arv_market_value, pv.arv_market_value));
  out.vendorAsIs = parseMoney(pick(data.as_is_value, pv.as_is_value));
  const iv = Array.isArray(data.interval_10_90) ? data.interval_10_90
    : (Array.isArray(pv.interval_10_90) ? pv.interval_10_90 : null);
  if (iv) {
    out.interval = [parseMoney(iv[0]), parseMoney(iv[1])];
  } else {
    const lo = parseMoney(pick(data.value_low, pv.value_low));
    const hi = parseMoney(pick(data.value_high, pv.value_high));
    if (lo != null || hi != null) out.interval = [lo, hi];
  }
  out.subject = data.subject || data.property_details || pv.property_details || null;
  out.searchCriteria = data.search_criteria_used || pv.search_criteria_used || null;
  out.confidence = pick(data.confidence, pv.confidence);
  out.confidenceScore = data.confidence_score != null ? data.confidence_score
    : (pv.confidence_score != null ? pv.confidence_score : null);
  const cc = pick(data.credits_charged, pv.credits_charged);
  const cr = pick(data.credits_remaining, pv.credits_remaining);
  out.credits = {
    credits_charged: cc != null ? cc : null,
    credits_remaining: cr != null ? cr : null,
  };
  out.confidence = out.confidence != null ? out.confidence : null;
  return out;
}

// Keeps the parse with more comps; null vendor / subject fields in the
// winner are filled from the loser so an insufficient_comps response
// still carries the best vendor values found across the chain.
function preferParsed(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const main = b.comps.length > a.comps.length ? b : a;
  const other = main === b ? a : b;
  return {
    comps: main.comps,
    vendorArv: main.vendorArv != null ? main.vendorArv : other.vendorArv,
    vendorAsIs: main.vendorAsIs != null ? main.vendorAsIs : other.vendorAsIs,
    interval: (main.interval[0] != null || main.interval[1] != null) ? main.interval : other.interval,
    subject: main.subject || other.subject,
    searchCriteria: main.searchCriteria || other.searchCriteria,
    confidence: main.confidence != null ? main.confidence : other.confidence,
    confidenceScore: main.confidenceScore != null ? main.confidenceScore : other.confidenceScore,
    credits: {
      credits_charged: main.credits.credits_charged != null ? main.credits.credits_charged : other.credits.credits_charged,
      credits_remaining: main.credits.credits_remaining != null ? main.credits.credits_remaining : other.credits.credits_remaining,
    },
  };
}

/* ---------------- upstream calls ---------------- */

// One upstream POST with its own timeout. Returns { status, ok, data };
// data is the parsed JSON body or null. Throws only on network /
// timeout failure (the handler maps that to upstream_failed).
async function callUpstream(url, apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* mapped by status below */ }
    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

// The documented safe error fields, wherever the body carries them:
// the live 400 body is { error, code, suggestion } at the top level;
// the documented shape nests them under detail. Nothing else from an
// upstream error body is ever read or forwarded.
function extractErrorDetail(json) {
  const out = {};
  if (!json || typeof json !== 'object') return out;
  const detail = (json.detail && typeof json.detail === 'object') ? json.detail : {};
  const code = json.code != null ? json.code : detail.code;
  const suggestion = json.suggestion != null ? json.suggestion : detail.suggestion;
  if (code != null && code !== '') out.code = String(code);
  if (suggestion != null && suggestion !== '') out.suggestion = String(suggestion);
  return out;
}

/* ---------------- upstream error mapping ----------------
   Only the HTTP status drives the mapping; upstream bodies are never
   forwarded (a 400's code / suggestion — top-level or under detail —
   are the documented safe fields and are the only ones passed
   through). */

function mapUpstreamError(status, json) {
  if (status === 402) return { statusCode: 402, body: { error: 'credits_exhausted' } };
  if (status === 403) return { statusCode: 403, body: { error: 'invalid_key' } };
  if (status === 404) return { statusCode: 404, body: { error: 'not_found' } };
  if (status === 400) {
    const out = Object.assign({ error: 'bad_input' }, extractErrorDetail(json));
    return { statusCode: 400, body: out };
  }
  if (status === 422) return { statusCode: 422, body: { error: 'validation_failed' } };
  return { statusCode: 502, body: { error: 'upstream_error' } };
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

  const apiKey = process.env.RESIDELINE_API_KEY;
  if (!apiKey) {
    return json(503, corsHeaders, {
      status: 'not_configured',
      error: 'not_configured',
      setup: 'Add RESIDELINE_API_KEY to this Netlify site\u2019s environment variables (Functions scope), then redeploy.',
    });
  }

  const input = parseInput(event);
  if (input.error === 'bad_json') {
    return json(400, corsHeaders, { error: 'bad_json' });
  }
  if (!input.address) {
    return json(400, corsHeaders, { error: 'missing_address' });
  }

  // ---- Step 0: normalize a comma-less address once (round 5).
  // Mutating input.address here means the details / value / report
  // bodies, the logs and the response subject all carry the
  // normalized form.
  const normalizedAddress = normalizeAddress(input.address);
  if (normalizedAddress !== input.address) {
    console.log('[resideline-comps] normalized address=' + normalizedAddress);
    input.address = normalizedAddress;
  }

  try {
    // ---- Step 1: subject facts via property_details (0 credits).
    // A failure here is NOT fatal — the valuation may still enrich
    // from the address or the caller may have supplied the facts.
    let fetched = null;
    let detailsStatus = 'error';
    let detailsData = null;
    try {
      const d = await callUpstream(DETAILS_URL, apiKey, { address: input.address });
      detailsStatus = d.status;
      detailsData = d.data;
      if (d.ok && d.data) fetched = parsePropertyDetails(d.data);
    } catch (e) {
      detailsStatus = 'error';
    }
    console.log('[resideline-comps] details status=' + detailsStatus
      + ' facts=' + factsSummary(fetched) + ' address=' + input.address);
    if (!fetched && detailsData) {
      // No facts parsed — log the payload's key structure (keys only,
      // never values) so the real shape is on record for the next fix.
      console.log('[resideline-comps] details shape=' + shapeOf(detailsData)
        + ' address=' + input.address);
    }
    const facts = mergeFacts(input, fetched);

    // ---- Step 2: valuation (2 credits), spec-exact body.
    let parsed = null;
    let credits = { credits_charged: null, credits_remaining: null };
    let firstError = null;
    let assumedFacts = null;
    const v = await callUpstream(API_URL, apiKey, buildUpstreamBody(input, facts));
    if (v.ok && v.data) {
      parsed = parseValuationPayload(v.data);
      credits = parsed.credits;
      console.log('[resideline-comps] value status=200 comps=' + parsed.comps.length
        + ' address=' + input.address);
    } else {
      const det = extractErrorDetail(v.data);
      const miss = v.status === 400 ? missingFactsList(facts) : '';
      console.log('[resideline-comps] value status=' + v.status
        + (det.code ? ' code=' + det.code : '')
        + (miss ? ' missing=' + miss : '')
        + ' address=' + input.address);
      firstError = { status: v.ok ? 502 : v.status, data: v.data };

      // ---- Step 2b: assumed-baths retry (see header). NARROW
      // trigger: this exact upstream refusal, and baths the ONLY
      // missing fact (missingFactsList === 'baths' means the other
      // four are all present). One retry with baths = 1; every other
      // body field is the same body builder output. On failure the
      // chain falls through to Step 3 with firstError untouched —
      // the ORIGINAL value error stays the mapped error.
      if (v.status === 400 && det.code === 'INVALID_PROPERTY_DATA' && miss === 'baths') {
        const retryFacts = Object.assign({}, facts, { baths: 1 });
        const v2 = await callUpstream(API_URL, apiKey, buildUpstreamBody(input, retryFacts));
        if (v2.ok && v2.data) {
          const rp2 = parseValuationPayload(v2.data);
          console.log('[resideline-comps] value(assumed-baths) status=200 comps=' + rp2.comps.length
            + ' address=' + input.address);
          parsed = rp2;
          credits = rp2.credits;
          if (rp2.comps.length >= 1) assumedFacts = ['baths'];
        } else {
          const det2 = extractErrorDetail(v2.data);
          console.log('[resideline-comps] value(assumed-baths) status=' + v2.status
            + (det2.code ? ' code=' + det2.code : '')
            + ' address=' + input.address);
        }
      }
    }

    // ---- Step 3: full report fallback (10 credits on success) —
    // only when the valuation produced < 3 comps (including its 400
    // case) and the facts this endpoint requires are known. TWO
    // attempts: report(min) sends the required fields only
    // (year_built + property_type in report vocabulary); if that
    // fails, report(full) adds beds/baths/sqft. Failed calls are
    // not charged, so the second attempt costs nothing extra; a
    // success on either attempt ends the step.
    if ((!parsed || parsed.comps.length < 3) && facts.yearBuilt != null && facts.propertyType) {
      const attempts = [
        ['min', buildReportBody(input, facts, { minimal: true })],
        ['full', buildReportBody(input, facts)],
      ];
      for (const [tag, repBody] of attempts) {
        const rep = await callUpstream(REPORT_URL, apiKey, repBody);
        if (rep.ok && rep.data) {
          const rp = parseValuationPayload(rep.data);
          console.log('[resideline-comps] report(' + tag + ') status=200 comps=' + rp.comps.length
            + ' address=' + input.address);
          parsed = preferParsed(parsed, rp);
          if (rp.credits.credits_charged != null || rp.credits.credits_remaining != null) {
            credits = rp.credits;
          }
          break;
        }
        const det = extractErrorDetail(rep.data);
        console.log('[resideline-comps] report(' + tag + ') status=' + rep.status
          + (det.code ? ' code=' + det.code : '') + ' address=' + input.address);
        if (!firstError) firstError = { status: rep.ok ? 502 : rep.status, data: rep.data };
      }
    }

    // No step produced a parseable valuation: map the first upstream
    // error (status + documented code/suggestion only — never the
    // key, never the raw body).
    if (!parsed) {
      const mapped = mapUpstreamError(firstError ? firstError.status : 502, firstError ? firstError.data : null);
      return json(mapped.statusCode, corsHeaders, Object.assign({ source: 'resideline' }, mapped.body));
    }

    // Vendor values: labeled vendor screen values, never an ARV.
    const vendorArv = parsed.vendorArv;
    const vendorAsIs = parsed.vendorAsIs;
    const interval = parsed.interval;
    const rawComps = parsed.comps;

    // 3-COMP MINIMUM: a thin upstream set is not a comp set — no
    // indication, no best picks, no price verdict from this source.
    if (rawComps.length < 3) {
      console.log('[resideline-comps] insufficient comps=' + rawComps.length + ' address=' + input.address);
      return json(200, corsHeaders, {
        matched: false,
        source: 'resideline',
        error: 'insufficient_comps',
        address: input.address,
        assumedFacts,
        compsReturned: rawComps.length,
        comps: null,
        vendorArv,
        vendorAsIs,
        vendorInterval: interval,
        confidence: parsed.confidence,
        confidenceScore: parsed.confidenceScore,
        search_criteria_used: parsed.searchCriteria,
        credits_charged: credits.credits_charged,
        credits_remaining: credits.credits_remaining,
      });
    }

    // Subject record: the valuation/report payload's own subject
    // (subject / property_details) may carry facts under any of the
    // alias names — normalize it through factsFromRecord and let its
    // fields win, with the chain facts filling gaps, before falling
    // back to the raw record and then the chain facts alone.
    let subject = null;
    const psFacts = parsed.subject ? factsFromRecord(parsed.subject) : null;
    if (psFacts) {
      const mergedSubjectFacts = {
        beds: psFacts.beds != null ? psFacts.beds : facts.beds,
        baths: psFacts.baths != null ? psFacts.baths : facts.baths,
        sqft: psFacts.sqft != null ? psFacts.sqft : facts.sqft,
        yearBuilt: psFacts.yearBuilt != null ? psFacts.yearBuilt : facts.yearBuilt,
        propertyType: psFacts.propertyType || facts.propertyType || null,
      };
      subject = mapSubject(factsToSubjectRecord(mergedSubjectFacts, input.address));
    }
    if (!subject) {
      subject = mapSubject(parsed.subject)
        || mapSubject(factsToSubjectRecord(facts, input.address))
        || {
          address: input.address,
          beds: null, baths: null, sqft: null,
          yearBuilt: null, propertyType: '',
        };
    }
    const rows = rawComps.map(mapComp);
    const analyzed = analyzeComps(subject, rows, todayParts());
    const comps = shapeCompsResult(analyzed, parsed.searchCriteria, rows.length);
    console.log('[resideline-comps] raw=' + rows.length + ' candidates=' + analyzed.candidates.length
      + ' best=' + analyzed.best.length + ' credits_charged=' + credits.credits_charged
      + ' credits_remaining=' + credits.credits_remaining);

    return json(200, corsHeaders, {
      matched: true,
      source: 'resideline',
      address: subject.address || input.address,
      assumedFacts,
      property: shapeProperty(subject, input.address),
      // Screen-only slot, same convention as data-api: the page reads
      // avm.value as a reference marker; it is never an offer basis.
      avm: vendorArv != null ? {
        value: vendorArv,
        low: interval[0],
        high: interval[1],
        score: parsed.confidenceScore,
        note: 'Resideline vendor value — screen only, never ARV',
      } : null,
      vendorArv,
      vendorAsIs,
      vendorInterval: interval,
      confidence: parsed.confidence,
      confidenceScore: parsed.confidenceScore,
      search_criteria_used: parsed.searchCriteria,
      credits_charged: credits.credits_charged,
      credits_remaining: credits.credits_remaining,
      comps,
      linkedProperties: [],
    });
  } catch (err) {
    console.error('[resideline-comps]', err && err.message);
    return json(502, corsHeaders, { source: 'resideline', error: 'upstream_failed' });
  }
};

// Offline checks for resideline-comps-regression.js (no network).
exports._test = {
  API_URL,
  DETAILS_URL,
  REPORT_URL,
  DEFAULT_BOUNDS,
  parseMoney,
  soldDateToIso,
  parseAddress,
  normalizeAddress,
  parseInput,
  mergeFacts,
  typeForValue,
  typeForReport,
  buildUpstreamBody,
  buildReportBody,
  factsFromRecord,
  parsePropertyDetails,
  findFactsRecursive,
  shapeOf,
  missingFactsList,
  factsToSubjectRecord,
  factsSummary,
  parseValuationPayload,
  preferParsed,
  extractErrorDetail,
  mapComp,
  mapSubject,
  analyzeComps,
  shapeCompsResult,
  mapUpstreamError,
};

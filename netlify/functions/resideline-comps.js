// netlify/functions/resideline-comps.js
// Verified comps via Resideline — the Command Center's primary comp feed
// (Troy, Nov 18, 2026: every Command Center comp pull runs off this API).
// Keeps RESIDELINE_API_KEY server-side (Netlify env vars, Functions scope);
// the key is never logged and never reaches the browser.
//
// Dashboard calls (same GET convention as attom-lookup / data-api):
//   GET  /.netlify/functions/resideline-comps?address=<url-encoded address>
// Direct calls may instead POST a JSON body:
//   { address, beds?, baths?, sqft?, yearBuilt?, propertyType?,
//     bounds?: { radiusMiles?, maxAgeDays?, sqftBand?, yearBuiltDiff? } }
//
// Upstream: POST https://api.resideline.com/v2/api/property_value
//   ?enrich_if_missing=true — 2 credits. There is NO standalone comps
//   endpoint; the sold comps ride inside the valuation response. The
//   response's own arv_market_value / as_is_value are VENDOR values:
//   they come back clearly labeled as such (vendorArv / vendorAsIs and
//   the screen-only avm slot, same convention as data-api) and are never
//   an ARV — our comp-selection engine below (ported from attom-lookup)
//   produces the indication the offer math runs on.
//
// 3-COMP MINIMUM: fewer than 3 sold comps upstream returns
// { error: 'insufficient_comps' } with no comp set and no price verdict.
'use strict';

const API_URL = 'https://api.resideline.com/v2/api/property_value?enrich_if_missing=true';
const TIMEOUT_MS = 25000;

// Comp-set bounds sent upstream unless the caller overrides them.
const DEFAULT_BOUNDS = { radiusMiles: 1, maxAgeDays: 365, sqftBand: 300, yearBuiltDiff: 20 };

/* ---------------- small numeric / date helpers (mirror attom-lookup) ---------------- */

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

/* ---------------- address parsing (mirrors attom-lookup / data-api) ---------------- */

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

// Builds the upstream property_value body. Only `address` is required;
// subject facts ride along when known so the comp bounds bite, and the
// call always carries enrich_if_missing=true (in API_URL) so a missing
// fact enriches instead of 400ing.
function buildUpstreamBody(input) {
  const body = { address: input.address };
  const parts = parseAddress(input.address);
  if (parts.city) body.city = parts.city;
  if (parts.zip) body.zipcode = parts.zip;
  if (input.beds != null) body.beds = input.beds;
  if (input.baths != null) body.baths = input.baths;
  if (input.sqft != null) body.sqft_size = input.sqft;
  if (input.yearBuilt != null) body.subject_year_built = input.yearBuilt;
  if (input.propertyType) body.property_type = input.propertyType;
  body.max_radius_miles = input.bounds.radiusMiles;
  body.max_comp_age_days = input.bounds.maxAgeDays;
  body.sqft_band_abs = input.bounds.sqftBand;
  body.year_built_diff_cap = input.bounds.yearBuiltDiff;
  return body;
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
// attom-lookup / data-api. Resideline's valuation response carries no
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

/* ---------------- comp filter + scoring (ported from attom-lookup) ----------------
   Same engine rules as the ATTOM path — nominal transfers out, median
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

/* ---------------- output shaping (mirrors attom-lookup compOut) ---------------- */

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

/* ---------------- upstream error mapping ----------------
   Only the HTTP status drives the mapping; upstream bodies are never
   forwarded (a 400's detail.code / detail.suggestion are the documented
   safe fields and are the only ones passed through). */

function mapUpstreamError(status, json) {
  if (status === 402) return { statusCode: 402, body: { error: 'credits_exhausted' } };
  if (status === 403) return { statusCode: 403, body: { error: 'invalid_key' } };
  if (status === 404) return { statusCode: 404, body: { error: 'not_found' } };
  if (status === 400) {
    const detail = (json && json.detail) || {};
    const out = { error: 'bad_input' };
    if (detail.code) out.code = String(detail.code);
    if (detail.suggestion) out.suggestion = String(detail.suggestion);
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

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    let raw = '';
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildUpstreamBody(input)),
      });
      raw = await res.text().catch(() => '');
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* handled by status mapping below */ }

    if (!res.ok) {
      // Status + counts only — never the key, never the raw body.
      console.log('[resideline-comps] upstream status=' + res.status + ' address=' + input.address);
      const mapped = mapUpstreamError(res.status, data);
      return json(mapped.statusCode, corsHeaders, Object.assign({ source: 'resideline' }, mapped.body));
    }
    if (!data) {
      return json(502, corsHeaders, { source: 'resideline', error: 'upstream_error' });
    }

    // Vendor values: labeled vendor screen values, never an ARV.
    const vendorArv = parseMoney(data.arv_market_value);
    const vendorAsIs = parseMoney(data.as_is_value);
    const interval = Array.isArray(data.interval_10_90)
      ? [parseMoney(data.interval_10_90[0]), parseMoney(data.interval_10_90[1])]
      : [null, null];
    const credits = {
      credits_charged: data.credits_charged != null ? data.credits_charged : null,
      credits_remaining: data.credits_remaining != null ? data.credits_remaining : null,
    };

    const rawComps = Array.isArray(data.comps) ? data.comps : [];

    // 3-COMP MINIMUM: a thin upstream set is not a comp set — no
    // indication, no best picks, no price verdict from this source.
    if (rawComps.length < 3) {
      console.log('[resideline-comps] insufficient comps=' + rawComps.length + ' address=' + input.address);
      return json(200, corsHeaders, {
        matched: false,
        source: 'resideline',
        error: 'insufficient_comps',
        address: input.address,
        compsReturned: rawComps.length,
        comps: null,
        vendorArv,
        vendorAsIs,
        vendorInterval: interval,
        confidence: data.confidence != null ? data.confidence : null,
        confidenceScore: data.confidence_score != null ? data.confidence_score : null,
        search_criteria_used: data.search_criteria_used || null,
        credits_charged: credits.credits_charged,
        credits_remaining: credits.credits_remaining,
      });
    }

    const subject = mapSubject(data.subject) || {
      address: input.address,
      beds: input.beds, baths: input.baths, sqft: input.sqft,
      yearBuilt: input.yearBuilt, propertyType: input.propertyType || '',
    };
    const rows = rawComps.map(mapComp);
    const analyzed = analyzeComps(subject, rows, todayParts());
    const comps = shapeCompsResult(analyzed, data.search_criteria_used || null, rows.length);
    console.log('[resideline-comps] raw=' + rows.length + ' candidates=' + analyzed.candidates.length
      + ' best=' + analyzed.best.length + ' credits_charged=' + credits.credits_charged
      + ' credits_remaining=' + credits.credits_remaining);

    return json(200, corsHeaders, {
      matched: true,
      source: 'resideline',
      address: subject.address || input.address,
      property: shapeProperty(subject, input.address),
      // Screen-only slot, same convention as data-api: the page reads
      // avm.value as a reference marker; it is never an offer basis.
      avm: vendorArv != null ? {
        value: vendorArv,
        low: interval[0],
        high: interval[1],
        score: data.confidence_score != null ? data.confidence_score : null,
        note: 'Resideline vendor value — screen only, never ARV',
      } : null,
      vendorArv,
      vendorAsIs,
      vendorInterval: interval,
      confidence: data.confidence != null ? data.confidence : null,
      confidenceScore: data.confidence_score != null ? data.confidence_score : null,
      search_criteria_used: data.search_criteria_used || null,
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
  DEFAULT_BOUNDS,
  parseMoney,
  soldDateToIso,
  parseAddress,
  parseInput,
  buildUpstreamBody,
  mapComp,
  mapSubject,
  analyzeComps,
  shapeCompsResult,
  mapUpstreamError,
};

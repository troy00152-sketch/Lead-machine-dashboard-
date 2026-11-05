// netlify/functions/data-api.js
// data provider property records + MLS/public-record comparables via Netlify
// serverless function. Keeps the data API key server-side (Netlify env).
//
// Dashboard calls:
//   GET /.netlify/functions/data-api?address=<url-encoded full address>
//
// Response shape mirrors attom-lookup.js so the Comps page consumes it
// unchanged: { matched, address, property, comps }. The page tries this
// source first and falls back to ATTOM when it fails or returns no comps.
//
// Costs ~2 API credits per address (1 property + 1 comparables). Reads the
// response BODY status (the API returns HTTP 200 with embedded status codes).

const API_BASE = 'https://api.data-api.com/v1';

/* ---------------- helpers (mirrors attom-lookup) ---------------- */

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(nums) { return nums.reduce((a, b) => a + b, 0) / nums.length; }
function round1(x) { return Math.round(x * 10) / 10; }
function fmtInt(x) { return Math.round(x).toLocaleString('en-US'); }

function parseDateParts(s) {
  if (!s) return null;
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], iso: m[0] };
}
function monthsBetween(a, b) { return Math.abs((a.y - b.y) * 12 + (a.mo - b.mo)); }
function daysBetween(a, b) {
  return Math.round((Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(b.y, b.mo - 1, b.d)) / 86400000);
}
function todayParts() {
  const t = new Date();
  return { y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate() };
}
function isoDaysAgo(n) {
  const t = new Date();
  t.setDate(t.getDate() - n);
  return t.toISOString().slice(0, 10);
}

// US state abbreviations. The old state+ZIP regex grabbed the last two
// letters of the city name as a "state" ("Indianapolis 46237" -> state
// "IS", street "4405 E edgewood ave Indianapol"), which made the upstream
// property lookup return no match. Only accept the token as a state when
// it is a real US state abbreviation; otherwise fall back to ZIP-only.
const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']);

function parseAddress(full) {
  const out = { street: '', city: '', state: '', zip: '' };
  if (!full) return out;
  let head = String(full).trim();
  const sz = head.match(/(?:^|,|\s)([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
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
  const SUF = ['ave', 'avenue', 'st', 'street', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'blvd', 'boulevard', 'ct', 'court', 'way', 'pl', 'place', 'ter', 'terrace', 'cir', 'circle', 'hwy', 'highway', 'pkwy', 'parkway', 'aly', 'alley', 'trl', 'trail', 'sq', 'square', 'xing', 'crossing', 'pt', 'point', 'cove', 'cv', 'row', 'run', 'walk', 'path', 'ext'];
  const words = head.split(/\s+/);
  for (let i = 1; i < words.length - 1; i++) {
    if (SUF.includes(words[i].toLowerCase().replace(/\.$/, ''))) {
      out.street = words.slice(0, i + 1).join(' ');
      out.city = words.slice(i + 1).join(' ');
      return out;
    }
  }
  out.street = head;
  return out;
}

/* ---------------- upstream ---------------- */

async function prGet(path, query, apiKey) {
  const qs = new URLSearchParams(query).toString();
  const resp = await fetch(`${API_BASE}${path}?${qs}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* leave null */ }
  return { http: resp.status, json, text };
}

async function prPost(path, body, apiKey) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* leave null */ }
  return { http: resp.status, json, text };
}

// The API returns HTTP 200 with the real status inside meta.status —
// a dead/quota-exceeded key shows up as meta.status 403 in the body.
function bodyOk(r) {
  if (!r || !r.json || !r.json.meta) return false;
  const s = Number(r.json.meta.status);
  return s >= 200 && s < 300;
}

/* ---------------- subject shaping ---------------- */

function composeMailing(p) {
  const parts = [p.mailingStreetAddress, p.mailingCity, p.mailingState, p.mailingZip]
    .filter(x => x !== undefined && x !== null && String(x).trim() !== '');
  return parts.join(', ') || null;
}

function parseSubject(p, today) {
  const lat = (p.latitude !== undefined && p.latitude !== null && p.latitude !== '') ? parseFloat(p.latitude) : NaN;
  const lng = (p.longitude !== undefined && p.longitude !== null && p.longitude !== '') ? parseFloat(p.longitude) : NaN;
  const openCount = p.openLoanCount != null ? Number(p.openLoanCount) : null;
  const freeAndClear = openCount === 0;
  const subj = {
    address: p.address || [p.streetAddress, p.city, p.state, p.zip].filter(Boolean).join(', '),
    latitude: isNaN(lat) ? null : lat,
    longitude: isNaN(lng) ? null : lng,
    apn: p.apn || '',
    legalDescription: p.legalDescription || null,
    zoning: p.zoning || null,
    propertyType: p.propertyType || '',
    yearBuilt: p.yearBuilt || null,
    sqft: p.squareFeet || p.livingSquareFeet || null,
    beds: p.bedrooms != null ? p.bedrooms : null,
    baths: p.bathrooms != null ? p.bathrooms : null,
    lotSqft: p.lotSquareFeet || null,
    lotAcres: p.lotAcres || null,
    absentee: String(p.occupancyType || '').toLowerCase().includes('non-owner'),
    owner1: p.owner1Name || '',
    owner2: p.owner2Name || '',
    mailingAddress: composeMailing(p),
    lastSaleAmount: p.lastSaleAmount != null ? p.lastSaleAmount : null,
    lastSaleDate: p.lastSaleDate ? String(p.lastSaleDate).slice(0, 10) : null,
    assessedValue: p.assessedValue != null ? p.assessedValue : null,
    marketValue: p.marketValue != null ? p.marketValue : (p.estimatedValue != null ? p.estimatedValue : null),
    taxAmount: p.taxAmount != null ? p.taxAmount : null,
    taxYear: p.taxYear != null ? p.taxYear : null,
    onMarket: !!p.onMarket,
    listingStatus: p.listingStatus || null,
    // Distress signals (feed motivation scoring + title friction)
    distressed: !!p.distressed,
    preForeclosure: !!p.preForeclosure,
    preProbate: !!p.preProbate,
    bankruptcy: !!p.bankruptcy,
    taxDelinquency: !!p.taxDelinquency,
    taxDelinquencyYear: p.taxDelinquencyYear || null,
    vacant: !!p.vacant,
    // Equity
    estimatedEquity: p.estimatedEquity != null ? p.estimatedEquity : null,
    estimatedEquityRatio: p.estimatedEquityRatio != null ? p.estimatedEquityRatio : null,
    // Liens / title friction
    lienCount: p.lienCount != null ? Number(p.lienCount) : (p.propertyLienCount != null ? Number(p.propertyLienCount) : null),
    lienAmount: p.lienAmount != null ? p.lienAmount : null,
    // Ownership
    ownershipMonths: p.ownershipMonths != null ? Number(p.ownershipMonths) : null,
    ownershipType: p.ownershipType || null,
    // Financial / rental
    rentalValue: p.rentalValue != null ? p.rentalValue : null,
    grossYield: p.grossYield != null ? p.grossYield : null,
    // Site
    floodZone: p.floodZoneDescription || null,
    withinFloodZone: !!p.withinFloodZone,
    // Permits
    permitCount: p.permitCount != null ? Number(p.permitCount) : null,
    openPermitCount: p.openPermitCount != null ? Number(p.openPermitCount) : null,
    // Prior sale
    priorSaleAmount: p.priorSaleAmount != null ? p.priorSaleAmount : null,
    priorSaleDate: p.priorSaleDate ? String(p.priorSaleDate).slice(0, 10) : null,
    purchaseMethod: p.purchaseMethod || null,
    saleSituation: p.saleSituation || null,
    freeAndClear,
    mortgage: freeAndClear ? null : {
      lender: null, // not exposed by the API
      amount: p.openLoanAmount != null ? p.openLoanAmount : (p.loanAmount != null ? p.loanAmount : null),
      balance: p.loanBalance != null ? p.loanBalance : null,
      payment: p.loanPaymentAmount != null ? p.loanPaymentAmount : null,
      ltv: p.loanToValueRatio != null ? p.loanToValueRatio : null,
      loanCount: p.loanCount != null ? Number(p.loanCount) : null,
      openLoanCount: openCount,
      loanType: null,
      termMonths: null,
      dueDate: null,
      recordedDate: p.loan1RecordingDate ? String(p.loan1RecordingDate).slice(0, 10) : null,
    },
  };
  const flags = [];
  if (subj.absentee) flags.push('absentee_owner');
  if (freeAndClear) flags.push('free_and_clear');
  else flags.push('mortgage_on_record');
  const d = parseDateParts(subj.lastSaleDate);
  if (d && daysBetween(today, d) >= 3650) flags.push('long_term_owner');
  if (subj.owner2) flags.push('two_owners_on_record');
  if (subj.onMarket) flags.push('listed_on_market');
  if (subj.distressed) flags.push('distressed');
  if (subj.preForeclosure) flags.push('pre_foreclosure');
  if (subj.preProbate) flags.push('pre_probate');
  if (subj.bankruptcy) flags.push('bankruptcy');
  if (subj.taxDelinquency) flags.push('tax_delinquent' + (subj.taxDelinquencyYear ? '_' + subj.taxDelinquencyYear : ''));
  if (subj.vacant) flags.push('vacant');
  if (subj.lienCount) flags.push('liens_on_record');
  if (subj.withinFloodZone) flags.push('flood_zone');
  subj.flags = flags;
  return subj;
}

/* ---------------- comps ---------------- */

// saleSituation values: "Cash Purchase", "Financed", "New Construction",
// "Intra-Family", "Foreclosure", "Bank Sale"
function armsFromSituation(s) {
  const v = String(s || '');
  if (v === 'Intra-Family') return 'N';      // not arm's-length
  if (v === 'Foreclosure' || v === 'Bank Sale') return 'D'; // distressed
  return 'A';
}

function parseCompRow(r) {
  const amount = r.lastSaleAmount != null ? Number(r.lastSaleAmount) : null;
  const sqft = r.squareFeet != null && Number(r.squareFeet) > 0 ? Number(r.squareFeet) : null;
  return {
    address: [r.streetAddress, r.city, r.state, r.zip].filter(x => x !== undefined && x !== null && String(x).trim() !== '').join(', '),
    // NOTE: the comparables endpoint returns no per-row distance and no
    // per-row coordinates — every row passed the distanceFromSubject filter.
    distance: null,
    distanceNote: 'within search radius',
    amount,
    date: r.lastSaleDate ? String(r.lastSaleDate).slice(0, 10) : null,
    dateParts: parseDateParts(r.lastSaleDate ? String(r.lastSaleDate).slice(0, 10) : null),
    ppsf: r.pricePerSquareFoot != null ? Number(r.pricePerSquareFoot)
      : (amount && sqft ? amount / sqft : null),
    sqft,
    beds: r.bedrooms != null ? r.bedrooms : null,
    baths: r.bathrooms != null ? r.bathrooms : null,
    latitude: null,
    longitude: null,
    arms: armsFromSituation(r.saleSituation),
    saleSituation: r.saleSituation || null,
    listingStatus: r.listingStatus || null,
    onMarket: !!r.onMarket,
    daysOnMarket: r.daysOnMarket != null ? r.daysOnMarket : null,
    yearBuilt: r.yearBuilt || null,
    photoUrl: r.photoUrl || null,
    estimatedValue: r.estimatedValue != null ? r.estimatedValue : null,
  };
}

function analyzeComps(subj, comps, today) {
  today = today || todayParts();
  const excluded = [];
  const unverified = [];
  const candidates = [];
  const priced = comps.filter(c => c.amount);
  const med = priced.length ? median(priced.map(c => c.amount)) : null;

  for (const c of comps) {
    if (!c.amount || c.amount < 5000) {
      excluded.push({ comp: c, reason: 'nominal/zero-amount transfer — not sales evidence' });
      continue;
    }
    if (c.arms === 'N') {
      excluded.push({ comp: c, reason: `not arm's-length (sale situation: ${c.saleSituation})` });
      continue;
    }
    if (med && c.amount > 2.5 * med) {
      excluded.push({ comp: c, reason: `outlier above pocket (>$${fmtInt(2.5 * med)} = 2.5x median)` });
      continue;
    }
    if (med && c.amount < 0.6 * med
        && priced.filter(x => x.amount && x.amount >= 0.6 * med).length >= 3) {
      excluded.push({ comp: c, reason: `low outlier (<$${fmtInt(0.6 * med)} = 0.6x median) — distressed/low-tail sale` });
      continue;
    }
    candidates.push(c);
  }

  const candMed = candidates.length ? median(candidates.map(c => c.amount)) : null;

  for (const c of candidates) {
    let score = 0;
    const dev = [];
    // Distance: every row passed the radius filter, so no distance penalty.
    // Distressed situations stay visible but flagged.
    if (c.arms === 'D') { score += 4; dev.push(`distressed sale (${c.saleSituation})`); }
    if (c.onMarket) { score += 2; dev.push('currently listed'); }
    if (candMed && Math.abs(c.amount - candMed) / candMed <= 0.20) score -= 3;
    if (c.dateParts) {
      const m = monthsBetween(c.dateParts, today);
      score += Math.min(m, 12) * 0.3 + Math.max(0, m - 12) * 0.6;
      if (m > 12) dev.push(`sold ${m} mo ago (>12 mo rule)`);
    } else {
      score += 12;
      dev.push('no sale date');
    }
    const ss = subj.sqft;
    const cs = c.sqft;
    if (ss && cs) {
      if (Math.abs(cs - ss) / ss > 0.20) { score += 15; dev.push('sqft outside +-20%'); }
      else score += (Math.abs(cs - ss) / ss) * 20;
    } else if (subj.propertyType) {
      score += 8;
      dev.push('sqft missing — similarity unverified');
    }
    const sb = subj.beds;
    const cb = c.beds;
    const cbMissing = cb === null || cb === undefined || cb === '' || cb === '0' || cb === 0;
    if (sb && !cbMissing && Math.abs(Number(cb) - Number(sb)) > 1) {
      score += 6;
      dev.push('bed count differs by >1');
    } else if (cbMissing && subj.propertyType) {
      dev.push('beds missing');
    }
    c.score = round1(score);
    c.deviations = dev;
  }

  candidates.sort((a, b) => a.score - b.score);

  function hardFailReasons(c) {
    const reasons = [];
    if (subj.sqft && c.sqft && Math.abs(c.sqft - subj.sqft) / subj.sqft > 0.20) reasons.push('sqft outside ±20%');
    const cbMissing = c.beds === null || c.beds === undefined || c.beds === '' || c.beds === '0' || c.beds === 0;
    if (subj.beds && !cbMissing && Math.abs(Number(c.beds) - Number(subj.beds)) > 1) reasons.push('bed count differs by >1');
    if (c.dateParts && monthsBetween(c.dateParts, today) > 12) reasons.push('sold >12 mo ago');
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

  const result = { excluded, candidates, best, unverified };
  if (best.length) {
    const prices = best.map(c => c.amount);
    result.indication = mean(prices);
    result.rangeLow = Math.min(...prices);
    result.rangeHigh = Math.max(...prices);
    const ppsfs = best.filter(c => c.ppsf).map(c => c.ppsf);
    if (ppsfs.length && subj.sqft) result.ppsfCheck = mean(ppsfs) * subj.sqft;
    const totalDev = best.reduce((s, c) => s + c.deviations.length, 0);
    if (best.length === 3 && totalDev === 0) {
      result.confidence = 'HIGH';
      result.confidenceText = 'HIGH — 3 comps pass all selection rules';
    } else if (best.length === 3 && totalDev >= 7) {
      result.confidence = 'LOW-MEDIUM';
      result.confidenceText = 'LOW-MEDIUM — 3 comps used but the set is thin; county verification required before any number from this set is used';
    } else if (best.length === 3) {
      result.confidence = 'MEDIUM';
      result.confidenceText = 'MEDIUM — 3 comps used, deviations noted per comp';
    } else {
      result.confidence = 'LOW';
      result.confidenceText = 'LOW — fewer than 3 usable comps, do not lock a number on this set';
    }
  } else {
    result.confidence = 'LOW';
    result.confidenceText = 'LOW — no usable comps after filters';
  }
  return result;
}

function compOut(c) {
  return {
    address: c.address,
    amount: c.amount != null ? Math.round(c.amount) : null,
    date: c.date || null,
    distance: null,
    distanceNote: c.distanceNote || 'within search radius',
    sqft: c.sqft || null,
    beds: c.beds != null && c.beds !== '' ? c.beds : null,
    baths: c.baths != null && c.baths !== '' ? c.baths : null,
    latitude: null,
    longitude: null,
    ppsf: c.ppsf ? Math.round(c.ppsf * 100) / 100 : null,
    score: c.score != null ? c.score : null,
    deviations: c.deviations || [],
    saleSituation: c.saleSituation || null,
    listingStatus: c.listingStatus || null,
    onMarket: !!c.onMarket,
    daysOnMarket: c.daysOnMarket,
    yearBuilt: c.yearBuilt || null,
    photoUrl: c.photoUrl || null,
    source: 'data provider',
  };
}

/* ---------------- handler ---------------- */

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.PROPERTYREACH_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Data API key is not configured' }),
    };
  }

  const params = event.queryStringParameters || {};
  const parts = parseAddress(params.address || '');
  if (!parts.street) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing address query parameter' }) };
  }
  const fullAddress = (params.address || '').trim();
  const today = todayParts();

  try {
    // --- 1. property record ---
    const propRes = await prGet('/property', {
      streetAddress: parts.street,
      city: parts.city,
      state: parts.state,
      zip: parts.zip,
    }, apiKey).catch(() => null);

    if (!bodyOk(propRes)) {
      const meta = propRes && propRes.json && propRes.json.meta;
      // Key dead / quota exceeded surfaces here (meta.status 403 in body).
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          matched: false,
          address: fullAddress,
          source: 'data provider',
          upstream: meta ? { status: meta.status, message: meta.message } : { http: propRes ? propRes.http : 'fetch-failed' },
        }),
      };
    }

    const props = propRes.json.property ? [propRes.json.property] : (propRes.json.properties || []);
    // The endpoint returns { property: {...} } for a single match.
    const rawProp = propRes.json.property || props[0];
    if (!rawProp) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ matched: false, address: fullAddress, source: 'data provider' }),
      };
    }
    const subject = parseSubject(rawProp, today);

    // --- 2. comparables: try propertyId, then APN, then full address ---
    // (all 404 "Subject property not found" so far — trying every target form)
    const compTargets = [];
    if (rawProp.id) compTargets.push({ propertyId: rawProp.id });
    if (rawProp.apn) compTargets.push({ apn: rawProp.apn });
    const addrTarget = { streetAddress: parts.street, city: parts.city, state: parts.state, zip: parts.zip };
    if (rawProp.county) addrTarget.county = rawProp.county;
    if (rawProp.fips) addrTarget.fips = rawProp.fips;
    compTargets.push(addrTarget);
    let compRes = null;
    for (const target of compTargets) {
      compRes = await prPost('/comparables', {
        target,
        filter: {
          distanceFromSubject: 2,
          lastSaleDateMin: isoDaysAgo(365),
          propertyClassCode: ['R'],
        },
      }, apiKey).catch(() => null);
      if (bodyOk(compRes)) break;
      const meta = compRes && compRes.json && compRes.json.meta;
      console.log('[data-api] comparables failed: ' + JSON.stringify(meta || { http: compRes ? compRes.http : 'fetch-failed' }));
      compRes = null;
    }

    let comps = null;
    if (compRes) {
      const rows = (compRes.json.properties || []).map(parseCompRow);
      const res = analyzeComps(subject, rows, today);
      console.log('[data-api] comps raw=' + rows.length + ' candidates=' + res.candidates.length + ' best=' + res.best.length);
      comps = {
        criteria: 'data-api-2mi-12mo',
        returnedCount: rows.length,
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
        upperPocket: [],
        asIsAnchor: null,
        unverified: (res.unverified || []).map(compOut),
      };
    }
    // else: comps stays null -> page falls back to ATTOM

    // --- 3. linked properties: other properties owned by the same owner ---
    // (Nov 4, Troy: "some sellers mite have more then one house")
    // POST /v1/linked-properties, 1 credit. Target forms tried in order.
    let linkedProperties = [];
    const linkedTargets = [];
    if (rawProp.id) linkedTargets.push({ propertyId: rawProp.id });
    if (rawProp.apn) linkedTargets.push({ apn: rawProp.apn });
    linkedTargets.push(addrTarget);
    for (const target of linkedTargets) {
      const linkedRes = await prPost('/linked-properties', { target }, apiKey).catch(() => null);
      if (bodyOk(linkedRes) && linkedRes.json.properties) {
        linkedProperties = (linkedRes.json.properties || []).map(p => ({
          address: p.address || [p.streetAddress, p.city, p.state, p.zip].filter(Boolean).join(', '),
          city: p.city || null,
          state: p.state || null,
          zip: p.zip || null,
          propertyType: p.propertyType || null,
          beds: p.bedrooms != null ? p.bedrooms : null,
          baths: p.bathrooms != null ? p.bathrooms : null,
          sqft: p.squareFeet || p.livingSquareFeet || null,
          yearBuilt: p.yearBuilt || null,
          lastSaleAmount: p.lastSaleAmount != null ? p.lastSaleAmount : null,
          lastSaleDate: p.lastSaleDate ? String(p.lastSaleDate).slice(0, 10) : null,
          estimatedValue: p.estimatedValue != null ? p.estimatedValue : (p.marketValue != null ? p.marketValue : null),
        }));
        // Exclude the subject property itself from the list
        const subjAddr = (subject.address || '').toLowerCase().trim();
        linkedProperties = linkedProperties.filter(lp => (lp.address || '').toLowerCase().trim() !== subjAddr);
        break;
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        matched: true,
        address: subject.address || fullAddress,
        source: 'data provider',
        property: {
          owner1: subject.owner1 || null,
          owner2: subject.owner2 || null,
          mailingAddress: subject.mailingAddress || null,
          absentee: subject.absentee,
          apn: subject.apn || null,
          legalDescription: subject.legalDescription,
          zoning: subject.zoning,
          propertyType: subject.propertyType || null,
          beds: subject.beds,
          baths: subject.baths,
          sqft: subject.sqft,
          yearBuilt: subject.yearBuilt,
          lotSqft: subject.lotSqft,
          lotAcres: subject.lotAcres,
          latitude: subject.latitude,
          longitude: subject.longitude,
          lastSaleAmount: subject.lastSaleAmount,
          lastSaleDate: subject.lastSaleDate,
          assessedValue: subject.assessedValue,
          marketValue: subject.marketValue,
          taxAmount: subject.taxAmount,
          taxYear: subject.taxYear,
          onMarket: subject.onMarket,
          listingStatus: subject.listingStatus,
          freeAndClear: subject.freeAndClear,
          mortgage: subject.mortgage,
          flags: subject.flags,
          // Full-field pass-through: distress, equity, title, ownership
          distressed: subject.distressed,
          preForeclosure: subject.preForeclosure,
          preProbate: subject.preProbate,
          bankruptcy: subject.bankruptcy,
          taxDelinquency: subject.taxDelinquency,
          taxDelinquencyYear: subject.taxDelinquencyYear,
          vacant: subject.vacant,
          estimatedEquity: subject.estimatedEquity,
          estimatedEquityRatio: subject.estimatedEquityRatio,
          lienCount: subject.lienCount,
          lienAmount: subject.lienAmount,
          ownershipMonths: subject.ownershipMonths,
          ownershipType: subject.ownershipType,
          rentalValue: subject.rentalValue,
          grossYield: subject.grossYield,
          floodZone: subject.floodZone,
          withinFloodZone: subject.withinFloodZone,
          permitCount: subject.permitCount,
          openPermitCount: subject.openPermitCount,
          priorSaleAmount: subject.priorSaleAmount,
          priorSaleDate: subject.priorSaleDate,
          purchaseMethod: subject.purchaseMethod,
          saleSituation: subject.saleSituation,
        },
        avm: subject.marketValue != null ? {
          value: subject.marketValue, low: null, high: null, score: null, note: 'data provider market value — screen only, never ARV',
        } : null,
        comps,
        linkedProperties,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Lookup failed', detail: String(err).slice(0, 300) }),
    };
  }
};

exports._test = { parseAddress, parseSubject, parseCompRow, analyzeComps, armsFromSituation, bodyOk };

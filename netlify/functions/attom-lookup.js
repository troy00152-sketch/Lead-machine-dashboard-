// netlify/functions/attom-lookup.js
// Property records + verified comps lookup via Netlify serverless function.
// Keeps the ATTOM_API_KEY server-side (set in Netlify env vars, Functions scope).
// Dashboard calls:
//   GET /.netlify/functions/attom-lookup?address=<url-encoded full address>
// Also accepts address1/address2 or street/city/state/zip params.
//
// Fetches the expanded property profile, the automated value estimate, and
// Sales Comparables V2, then runs the comp filter server-side (ported from
// the comp engine): arm's-length sales only, nominal transfers out, median
// outliers excluded in both directions with logged reasons, similarity +
// pocket-cluster scoring, best-3 indication with a plain confidence label.
// The automated estimate is a fast screen only — it is never an ARV.

const API_BASE = 'https://api.gateway.attomdata.com';
const V1 = `${API_BASE}/propertyapi/v1.0.0`;

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

// Dates are handled as {y, mo, d, iso} parts to avoid timezone drift.
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

/* ---------------- address parsing (mirrors the dashboard's parser) ---------------- */

function parseAddress(full) {
  const out = { street: '', city: '', state: '', zip: '' };
  if (!full) return out;
  let head = String(full).trim();
  const sz = head.match(/,?\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
  if (sz) {
    out.state = sz[1].toUpperCase();
    out.zip = sz[2];
    head = head.slice(0, sz.index).replace(/,\s*$/, '').trim();
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

/* ---------------- subject record from the expanded profile ---------------- */

function derivedFlags(s, today) {
  const flags = [];
  if (s.absentee) flags.push('absentee_owner');
  if (!s.mortgageAmount) flags.push('free_and_clear');
  else flags.push('mortgage_on_record');
  const d = parseDateParts(s.lastSaleDate);
  if (d && daysBetween(today, d) >= 3650) flags.push('long_term_owner');
  if (String(s.propertyType || '').toUpperCase().includes('VACANT')) flags.push('vacant_land');
  if (s.owner2) flags.push('two_owners_on_record');
  return flags;
}

function parseSubject(data, today) {
  const props = (data && data.property) || [];
  if (!props.length) return null;
  const p = props[0];
  const b = p.building || {};
  const size = b.size || {};
  const rooms = b.rooms || {};
  const summ = p.summary || {};
  const sale = p.sale || {};
  const saleAmt = sale.amount || {};
  const assess = p.assessment || {};
  const owner = assess.owner || {};
  const mort = assess.mortgage || {};
  const first = mort.FirstConcurrent || {};
  const lot = p.lot || {};
  const subj = {
    address: (p.address || {}).oneLine || '',
    apn: (p.identifier || {}).apn || '',
    legalDescription: summ.legal1 || null,
    zoning: lot.siteZoningIdent || null,
    propertyType: summ.propertyType || '',
    yearBuilt: summ.yearBuilt || null,
    sqft: size.livingSize || size.universalSize || null,
    beds: rooms.beds != null ? rooms.beds : null,
    baths: rooms.bathsTotal != null ? rooms.bathsTotal : null,
    lotSqft: lot.lotSize2 || null,
    lotAcres: lot.lotSize1 || null,
    absentee: String(summ.absenteeInd || '').toUpperCase().includes('ABSENT') || owner.absenteeOwnerStatus === 'A',
    owner1: (owner.owner1 || {}).fullName || '',
    owner2: (owner.owner2 || {}).fullName || '',
    mailingAddress: owner.mailingAddressOneLine || '',
    lastSaleAmount: saleAmt.saleAmt != null ? saleAmt.saleAmt : null,
    lastSaleDate: saleAmt.saleRecDate || sale.saleTransDate || null,
    assessedValue: (assess.assessed || {}).assdTtlValue != null ? assess.assessed.assdTtlValue : null,
    marketValue: (assess.market || {}).mktTtlValue != null ? assess.market.mktTtlValue : null,
    taxAmount: (assess.tax || {}).taxAmt != null ? assess.tax.taxAmt : null,
    taxYear: (assess.tax || {}).taxYear != null ? assess.tax.taxYear : null,
    mortgageAmount: first.amount != null ? first.amount : null,
    mortgageLender: first.lenderLastName || '',
    mortgageLoanType: first.loanTypeCode || null,
    mortgageTermMonths: first.term ? Number(first.term) : null,
    mortgageDueDate: first.dueDate || null,
    mortgageDate: first.date || null,
  };
  subj.freeAndClear = !subj.mortgageAmount;
  subj.flags = derivedFlags(subj, today || todayParts());
  return subj;
}

/* ---------------- comps parsing (Sales Comparables V2 payload) ---------------- */

function parseComps(data) {
  let props;
  try {
    props = data.RESPONSE_GROUP.RESPONSE.RESPONSE_DATA
      .PROPERTY_INFORMATION_RESPONSE_ext.SUBJECT_PROPERTY_ext.PROPERTY;
  } catch (e) { return []; }
  if (!Array.isArray(props)) return [];
  const out = [];
  for (const p of props.slice(1)) { // index 0 is the subject itself
    const c = p && p.COMPARABLE_PROPERTY_ext;
    if (!c) continue;
    const sh = c.SALES_HISTORY || {};
    const st = c.STRUCTURE || {};
    const amtRaw = sh['@PropertySalesAmount'];
    let amount = null;
    if (amtRaw !== undefined && amtRaw !== null && amtRaw !== '') {
      const f = parseFloat(amtRaw);
      amount = isNaN(f) ? null : f;
    }
    const sqftRaw = st['@GrossLivingAreaSquareFeetCount'];
    let sqft = null;
    if (sqftRaw !== undefined && sqftRaw !== null && sqftRaw !== '' && sqftRaw !== '0') {
      const f = parseFloat(sqftRaw);
      sqft = isNaN(f) || f === 0 ? null : f;
    }
    const distRaw = c['@DistanceFromSubjectPropertyMilesCount'];
    let distance = 99;
    if (distRaw !== undefined && distRaw !== null && distRaw !== '') {
      const f = parseFloat(distRaw);
      distance = isNaN(f) ? 99 : f;
    }
    const date = parseDateParts(sh['@TransferDate_ext']);
    out.push({
      address: `${c['@_StreetAddress'] || ''}, ${c['@_City'] || ''} ${c['@_PostalCode'] || ''}`.replace(/,\s*$/, '').trim(),
      distance,
      amount,
      date: date ? date.iso : null,
      dateParts: date,
      ppsf: (amount && sqft) ? amount / sqft : null,
      sqft,
      beds: st['@TotalBedroomCount'] != null ? st['@TotalBedroomCount'] : null,
      baths: st['@TotalBathroomCount'] != null ? st['@TotalBathroomCount'] : null,
      arms: sh['@ArmsLengthTransactionIndicatorExt'] != null ? sh['@ArmsLengthTransactionIndicatorExt'] : null,
      seller: sh['@SellerUnparsedName'] || '',
    });
  }
  return out;
}

/* ---------------- comp filter + scoring (ported from the comp engine) ---------------- */

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
    if (c.arms && c.arms !== 'A') {
      excluded.push({ comp: c, reason: `not arm's-length (indicator ${c.arms})` });
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
  const isVacant = String(subj.propertyType || '').toUpperCase().includes('VACANT');

  for (const c of candidates) {
    let score = 0;
    const dev = [];
    score += c.distance * 10;
    if (c.distance > 1) dev.push(`${c.distance.toFixed(2)} mi (>1 mi rule)`);
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
    const ss = subj.sqft;
    const cs = c.sqft;
    if (ss && cs) {
      if (Math.abs(cs - ss) / ss > 0.20) { score += 15; dev.push('sqft outside +-20%'); }
      else score += (Math.abs(cs - ss) / ss) * 20;
    } else if (subj.propertyType && !isVacant) {
      score += 8;
      dev.push('sqft missing — similarity unverified');
    }
    const sb = subj.beds;
    const cb = c.beds;
    const cbMissing = cb === null || cb === undefined || cb === '' || cb === '0' || cb === 0;
    if (sb && !cbMissing && Math.abs(Number(cb) - Number(sb)) > 1) {
      score += 6;
      dev.push('bed count differs by >1');
    } else if (cbMissing && subj.propertyType && !isVacant) {
      dev.push('beds missing');
    }
    c.score = round1(score);
    c.deviations = dev;
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates.slice(0, 3);

  const result = { excluded, candidates, best };
  if (best.length) {
    const prices = best.map(c => c.amount);
    result.indication = mean(prices);
    result.rangeLow = Math.min(...prices);
    result.rangeHigh = Math.max(...prices);
    const ppsfs = best.filter(c => c.ppsf).map(c => c.ppsf);
    if (ppsfs.length && subj.sqft) result.ppsfCheck = mean(ppsfs) * subj.sqft;
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
    // As-is anchor: only when a usable comp sits materially below the pocket on $/sqft.
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

/* ---------------- output shaping ---------------- */

function compOut(c) {
  return {
    address: c.address,
    amount: c.amount != null ? Math.round(c.amount) : null,
    date: c.date || null,
    distance: Math.round(c.distance * 100) / 100,
    sqft: c.sqft || null,
    beds: c.beds != null && c.beds !== '' ? c.beds : null,
    baths: c.baths != null && c.baths !== '' ? c.baths : null,
    ppsf: c.ppsf ? Math.round(c.ppsf * 100) / 100 : null,
    score: c.score != null ? c.score : null,
    deviations: c.deviations || [],
  };
}

function shapeCompsResult(res, criteria, returnedCount) {
  const out = {
    criteria,
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
  };
  return out;
}

/* ---------------- upstream fetch ---------------- */

async function attomGet(url, apiKey) {
  const resp = await fetch(url, { headers: { apikey: apiKey, Accept: 'application/json' } });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* leave null */ }
  return { status: resp.status, ok: resp.ok, text, json };
}

function compsUrl(parts, wide) {
  const enc = encodeURIComponent;
  const base = `${API_BASE}/property/v2/SalesComparables/Address/${enc(parts.street)}/${enc(parts.city)}/-/${enc(parts.state)}/${enc(parts.zip)}`;
  const params = new URLSearchParams({
    searchType: 'Radius', minComps: '1', maxComps: '10', miles: '2', saleDateRange: '12',
  });
  if (wide) {
    // Wider windows for older / smaller homes where the standard criteria
    // return MinimumCompsNotMet. Zero-amount transfers excluded at the source.
    params.set('miles', '3');
    params.set('saleDateRange', '36');
    params.set('bedroomsRange', '10');
    params.set('bathroomRange', '10');
    params.set('sqFeetRange', '5000');
    params.set('lotSizeRange', '20000');
    params.set('yearBuiltRange', '100');
    params.set('include0SalesAmounts', 'False');
  }
  return `${base}?${params.toString()}`;
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

  const apiKey = process.env.ATTOM_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'ATTOM_API_KEY is not configured in Netlify environment variables' }),
    };
  }

  const params = event.queryStringParameters || {};
  let parts;
  if (params.street || params.city || params.state || params.zip) {
    parts = {
      street: (params.street || '').trim(),
      city: (params.city || '').trim(),
      state: (params.state || '').trim().toUpperCase(),
      zip: (params.zip || '').trim(),
    };
  } else if (params.address1 || params.address2) {
    const a2 = parseAddress(params.address2 || '');
    parts = {
      street: (params.address1 || '').trim(),
      city: a2.city,
      state: a2.state,
      zip: a2.zip,
    };
    if (!parts.city && params.address2) parts.city = String(params.address2).split(',')[0].trim();
  } else {
    parts = parseAddress(params.address || '');
  }

  const fullAddress = (params.address || '').trim()
    || [parts.street, parts.city, parts.state, parts.zip].filter(Boolean).join(', ');

  if (!parts.street) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing address query parameter' }) };
  }

  const address1 = parts.street;
  const address2 = [parts.city, `${parts.state} ${parts.zip}`.trim()].filter(Boolean).join(', ');
  const q = `address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`;
  const today = todayParts();

  try {
    // --- expanded profile + value estimate (independent, run together) ---
    const [expRes, avmRes] = await Promise.all([
      attomGet(`${V1}/property/expandedprofile?${q}`, apiKey).catch(() => null),
      attomGet(`${V1}/avm/detail?${q}`, apiKey).catch(() => null),
    ]);

    const subject = expRes && expRes.json ? parseSubject(expRes.json, today) : null;
    if (!subject) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ matched: false, address: fullAddress }),
      };
    }

    // --- value estimate (400 SuccessWithoutResult on vacant land = no estimate, not an error) ---
    let avm = null;
    if (avmRes && avmRes.ok && avmRes.json) {
      const avmNode = (((avmRes.json.property || [])[0] || {}).avm || {}).amount || {};
      if (avmNode.value != null) {
        avm = {
          value: avmNode.value,
          low: avmNode.low != null ? avmNode.low : null,
          high: avmNode.high != null ? avmNode.high : null,
          score: avmNode.scr != null ? avmNode.scr : null,
        };
      }
    }

    // --- comps: standard criteria first, one wide retry on MinimumCompsNotMet ---
    let compsPayload = null;
    let criteria = 'standard';
    if (parts.city && parts.state && parts.zip) {
      let r = await attomGet(compsUrl(parts, false), apiKey).catch(() => null);
      if (r && (r.status === 206 || (r.text || '').includes('MinimumCompsNotMet'))) {
        criteria = 'wide';
        r = await attomGet(compsUrl(parts, true), apiKey).catch(() => null);
      }
      if (r && r.json) compsPayload = r.json;
    }

    let comps = null;
    if (compsPayload) {
      const rawComps = parseComps(compsPayload);
      const res = analyzeComps(subject, rawComps, today);
      comps = shapeCompsResult(res, criteria, rawComps.length);
    }

    const result = {
      matched: true,
      address: subject.address || fullAddress,
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
        lastSaleAmount: subject.lastSaleAmount,
        lastSaleDate: subject.lastSaleDate,
        assessedValue: subject.assessedValue,
        marketValue: subject.marketValue,
        taxAmount: subject.taxAmount,
        taxYear: subject.taxYear,
        freeAndClear: subject.freeAndClear,
        mortgage: subject.freeAndClear ? null : {
          lender: subject.mortgageLender || null,
          amount: subject.mortgageAmount,
          loanType: subject.mortgageLoanType,
          termMonths: subject.mortgageTermMonths,
          dueDate: subject.mortgageDueDate,
          recordedDate: subject.mortgageDate,
        },
        flags: subject.flags,
      },
      avm,
      comps,
    };

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Lookup failed', detail: String(err).slice(0, 300) }),
    };
  }
};

// Exposed for the offline fixture test only (~/workspace/attom-layer/dashboard-test/).
exports._test = { parseSubject, parseComps, analyzeComps, parseDateParts, median, shapeCompsResult };

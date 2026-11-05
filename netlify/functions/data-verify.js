// data-verify.js — County sale cross-check for picked comps.
// Verifies each comp's sold price/date against the county recorder's own
// public data. Currently covers OHIO only (Cuyahoga County ArcGIS
// FeatureServer — free, keyless, live sale price + transfer date).
// Other states return status "unsupported" — never blocks the page.
// Fails silent: any error yields per-comp status "error", never a throw.

const CUYAHOGA_URL = 'https://gis.cuyahogacounty.gov/server/rest/services/CCFO/Parcel_Fabric_Taxparcels/FeatureServer/0/query';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function parseStreet(addr) {
  // "123 Main St, Cleveland, OH 44102" -> {num:"123", street:"MAIN ST"}
  const first = String(addr || '').split(',')[0].trim();
  const m = first.match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  return { num: m[1], street: normalizeStreet(m[2]) };
}

// County stores numbered streets WITHOUT ordinal suffixes: "E 113 ST",
// not "E 113TH ST". Strip suffixes on both sides before comparing,
// otherwise every numbered-street comp silently misses.
function normalizeStreet(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim()
    .replace(/\b(\d+)(ST|ND|RD|TH)\b/g, '$1')
    .replace(/\s+/g, ' ');
}

function parseState(addr) {
  const m = String(addr || '').match(/,\s*([A-Z]{2})\s+\d{5}/);
  return m ? m[1] : null;
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round(Math.abs(da - db) / 86400000);
}

function epochToDate(ms) {
  if (!ms) return null;
  const d = new Date(Number(ms));
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

async function queryCuyahoga(street) {
  const like = `%${street.num} ${street.street}%`;
  const params = new URLSearchParams({
    where: `UPPER(par_addr_all) LIKE UPPER('${like.replace(/'/g, "''")}') AND last_sales_amount IS NOT NULL`,
    outFields: 'parcelpin,par_addr_all,last_transfer_date,last_sales_amount',
    returnGeometry: 'false',
    resultRecordCount: '20',
    f: 'json',
  });
  const res = await fetch(CUYAHOGA_URL + '?' + params.toString(), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const json = await res.json();
  if (json.error) return [];
  return json.features || [];
}

function bestCountyMatch(features, street) {
  // Exact street-number + street-name match on the situs address.
  for (const f of features) {
    const a = String((f.attributes || {}).par_addr_all || '').toUpperCase();
    const m = a.match(/^(\d+)\s+([^,]+)/);
    if (!m) continue;
    const num = m[1];
    const st = normalizeStreet(m[2]);
    if (num === street.num && st === street.street) return f.attributes;
  }
  return null;
}

async function verifyOne(comp, fallbackState) {
  const base = { address: comp.address, status: 'unsupported', countyAmount: null, countyDate: null, note: null };
  const state = parseState(comp.address) || fallbackState;
  if (state !== 'OH') {
    base.note = 'County check covers Ohio only right now.';
    return base;
  }
  const street = parseStreet(comp.address);
  if (!street) { base.status = 'error'; base.note = 'Could not parse street address.'; return base; }
  try {
    const features = await queryCuyahoga(street);
    const match = bestCountyMatch(features, street);
    if (!match) {
      base.status = 'no-record';
      base.note = 'No Cuyahoga County record found for this address.';
      return base;
    }
    base.countyAmount = match.last_sales_amount != null ? Number(match.last_sales_amount) : null;
    base.countyDate = epochToDate(match.last_transfer_date);
    if (base.countyAmount == null || base.countyAmount <= 0 || !base.countyDate) {
      base.status = 'no-record';
      base.note = 'County record exists but carries no usable sale price/date.';
      return base;
    }
    if (!comp.date || !comp.amount) {
      base.status = 'no-record';
      base.note = 'Comp carries no sale price/date to check against.';
      return base;
    }
    const gap = daysBetween(comp.date, base.countyDate);
    const amtDiff = Math.abs(base.countyAmount - Number(comp.amount)) / Number(comp.amount);
    if (gap != null && gap <= 10 && amtDiff <= 0.02) {
      base.status = 'verified';
      base.note = 'County sale matches the comp price and date.';
    } else if (gap != null && new Date(base.countyDate) > new Date(comp.date + 'T00:00:00Z') && gap > 10) {
      base.status = 'resold';
      base.note = 'County shows a NEWER sale — property resold after this comp sale.';
    } else {
      base.status = 'mismatch';
      base.note = 'County sale differs from the comp — review before relying on it.';
    }
    return base;
  } catch (e) {
    base.status = 'error';
    base.note = 'County lookup failed — check skipped.';
    return base;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'POST only' }) };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const comps = Array.isArray(body.comps) ? body.comps.slice(0, 10) : [];
  const fallbackState = typeof body.state === 'string' ? body.state.toUpperCase() : null;
  const results = [];
  for (const c of comps) {
    results.push(await verifyOne(c, fallbackState));
  }
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ results }) };
};

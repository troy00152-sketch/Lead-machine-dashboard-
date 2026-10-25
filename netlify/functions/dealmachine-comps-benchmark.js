// netlify/functions/dealmachine-comps-benchmark.js
// BENCHMARK ONLY — not linked from any dashboard UI.
// Tests whether DealMachine's own sale-history fields can feed a comp engine:
// one radius search around a known-ARV subject, hard-capped at 30 records,
// property data only (contact_audience "none" => zero people credits).
// Key stays server-side (Netlify env DEALMACHINE_API_KEY); nothing here
// ever returns the key, and the endpoint never paginates past page 1.
//
// Usage (live site):
//   GET /.netlify/functions/dealmachine-comps-benchmark?mode=estimate
//     -> FREE cost preview (estimate_cost:true): no data, no credits spent.
//   GET /.netlify/functions/dealmachine-comps-benchmark?mode=pull
//     -> real pull, max 30 properties, normalized comp rows + credit info.
//
// Subject: 303 Elizabeth St, Greenville NC 27834 — airtight ARV $150,000
// (3 bed / 1 bath, built 1921). Benchmark question: do the returned recent
// sales, run through the comp rules, land near $150K?

const API_BASE = 'https://api.v2.dealmachine.com/v1';

// Benchmark constants — fixed so the endpoint cannot be reused as a
// general search tool.
const SUBJECT = {
  address: '303 Elizabeth St, Greenville, NC 27834',
  latitude: 35.614179,
  longitude: -77.379465,
};
const RADIUS_MILES = 1;
const MAX_RECORDS = 30;
const SALE_WINDOW_MONTHS = 12;

const FIELDS = [
  'last_sale_date',
  'last_sale_price',
  'num_bedrooms',
  'num_bathrooms',
  'living_area_sqft',
  'year_built',
  'property_type',
  'estimated_value',
];

function haversineMiles(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function saleWindowStart() {
  const d = new Date();
  d.setMonth(d.getMonth() - SALE_WINDOW_MONTHS);
  return d.toISOString().slice(0, 10);
}

function buildQuery(estimate) {
  const q = {
    locations: [
      {
        type: 'radius',
        latitude: SUBJECT.latitude,
        longitude: SUBJECT.longitude,
        radius_miles: RADIUS_MILES,
      },
    ],
    anchor: 'properties',
    contact_audience: 'none',
    fields: FIELDS,
    sort: [{ field_id: 'last_sale_date', direction: 'desc' }],
    page: 1,
    per_page: MAX_RECORDS,
  };
  if (estimate) q.estimate_cost = true;
  return q;
}

async function runSearch(apiKey, estimate) {
  const resp = await fetch(`${API_BASE}/properties/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildQuery(estimate)),
  });
  const dm = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, dm };
}

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
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Use GET' }) };
  }

  const apiKey = process.env.DEALMACHINE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'DEALMACHINE_API_KEY is not configured' }) };
  }

  const params = event.queryStringParameters || {};
  const mode = (params.mode || 'estimate').toLowerCase();
  if (mode !== 'estimate' && mode !== 'pull') {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'mode must be estimate or pull' }) };
  }

  try {
    // Estimate first, always: identical validation, zero credits.
    let est = await runSearch(apiKey, true);
    // If the sort field is rejected, retry the estimate without sorting.
    if (!est.ok && JSON.stringify(est.dm).includes('sort')) {
      const q = buildQuery(true);
      delete q.sort;
      const resp = await fetch(`${API_BASE}/properties/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(q),
      });
      est = { ok: resp.ok, status: resp.status, dm: await resp.json().catch(() => ({})) };
    }
    if (!est.ok) {
      return {
        statusCode: est.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'DealMachine API error (estimate)', detail: JSON.stringify(est.dm.error || est.dm).slice(0, 600) }),
      };
    }

    const estimated = est.dm.estimated_credits || {};
    const estimateOut = {
      mode,
      subject: SUBJECT.address,
      radius_miles: RADIUS_MILES,
      per_page_cap: MAX_RECORDS,
      totals: est.dm.totals || null,
      pagination: est.dm.pagination || null,
      estimated_credits: estimated,
    };

    if (mode === 'estimate') {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, ...estimateOut }) };
    }

    // PULL MODE — hard stop if the free estimate exceeds the cap.
    const thisPage = estimated.this_page ?? estimated.properties ?? null;
    if (typeof thisPage === 'number' && thisPage > MAX_RECORDS) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, reason: 'estimate_exceeds_cap', ...estimateOut }),
      };
    }

    let pull = await runSearch(apiKey, false);
    if (!pull.ok && JSON.stringify(pull.dm).includes('sort')) {
      const q = buildQuery(false);
      delete q.sort;
      const resp = await fetch(`${API_BASE}/properties/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(q),
      });
      pull = { ok: resp.ok, status: resp.status, dm: await resp.json().catch(() => ({})) };
    }
    if (!pull.ok) {
      return {
        statusCode: pull.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'DealMachine API error (pull)', detail: JSON.stringify(pull.dm.error || pull.dm).slice(0, 600) }),
      };
    }

    const cutoff = saleWindowStart();
    const rows = (pull.dm.data || []).map((p) => {
      const lat = p.latitude ?? null;
      const lng = p.longitude ?? null;
      return {
        address: p.full_address || '',
        distance_miles: lat != null && lng != null
          ? Math.round(haversineMiles(SUBJECT.latitude, SUBJECT.longitude, lat, lng) * 100) / 100
          : null,
        bedrooms: p.num_bedrooms ?? null,
        bathrooms: p.num_bathrooms ?? null,
        sqft: p.living_area_sqft ?? null,
        yearBuilt: p.year_built ?? null,
        propertyType: p.property_type || null,
        lastSaleDate: p.last_sale_date || null,
        lastSalePrice: p.last_sale_price ?? null,
        estimatedValue: p.estimated_value ?? null,
      };
    });
    const recent = rows.filter(
      (r) => r.lastSaleDate && r.lastSalePrice && r.lastSaleDate >= cutoff
        && !r.address.toLowerCase().includes('303 elizabeth')
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        ...estimateOut,
        credits: pull.dm.credits || null,
        returned: rows.length,
        recent_with_price: recent.length,
        sale_window_start: cutoff,
        rows,
        recent,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Benchmark failed', detail: String(err).slice(0, 300) }) };
  }
};

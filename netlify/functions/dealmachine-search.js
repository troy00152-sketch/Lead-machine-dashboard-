// netlify/functions/dealmachine-search.js
// DealMachine v2 API filtered property search via Netlify serverless function.
// Keeps the DEALMACHINE_API_KEY server-side (set in Netlify env vars).
// Dashboard calls: POST /.netlify/functions/dealmachine-search
//   { zip, filters: {absentee, highEquity, preforeclosure, taxDelinquent,
//                    freeAndClear, singleFamily, minValue, maxValue},
//     page, per_page, estimate_cost }
//
// Docs: https://api.docs.dealmachine.com/api-reference/properties/search-properties
// - locations: [{type:"zip_code", code:"46201"}]
// - BOOLEAN filters need no operator: {"filter_id":"has_absentee_owners","value":true}
// - NUMBER range: {"filter_id":"estimated_equity_percentage","operator":"range","value":{"min":50,"max":100}}
// - MULTI_SELECT needs numeric option IDs: {"filter_id":"property_type","operator":"contains_any","value":[<id>]}
// - estimate_cost:true previews cost for FREE (no credits consumed)

const API_BASE = 'https://api.v2.dealmachine.com/v1';

// In-memory cache of the property filter catalog (warm-function reuse)
let filterCatalogCache = null;
let filterCatalogAt = 0;

async function getFilterCatalog(apiKey) {
  // Refresh every 24h
  if (filterCatalogCache && Date.now() - filterCatalogAt < 24 * 3600 * 1000) {
    return filterCatalogCache;
  }
  const resp = await fetch(`${API_BASE}/filters?source_type=properties&per_page=250`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error('filter catalog HTTP ' + resp.status);
  const body = await resp.json();
  filterCatalogCache = (body.data || []).concat((body.filters || []));
  filterCatalogAt = Date.now();
  return filterCatalogCache;
}

function findOptionId(catalog, filterId, optionName) {
  for (const f of catalog) {
    const fid = f.filter_id || f.id || f.slug;
    if (fid !== filterId) continue;
    const options = f.options || f.values || f.allowed_values || [];
    for (const o of options) {
      const name = o.name || o.label || o.value;
      const id = o.id ?? o.option_id ?? o.value_id;
      if (name && String(name).toLowerCase() === String(optionName).toLowerCase() && id != null) {
        return Number(id);
      }
    }
  }
  return null;
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Use POST' }) };
  }

  const apiKey = process.env.DEALMACHINE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'DEALMACHINE_API_KEY is not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const zip = String(body.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Provide a valid 5-digit ZIP' }) };
  }

  const f = body.filters || {};
  const filters = [];
  if (f.absentee) filters.push({ filter_id: 'has_absentee_owners', value: true });
  if (f.highEquity) filters.push({ filter_id: 'estimated_equity_percentage', operator: 'range', value: { min: 50, max: 100 } });
  if (f.preforeclosure) filters.push({ filter_id: 'is_preforeclosure', value: true });
  if (f.taxDelinquent) filters.push({ filter_id: 'is_tax_delinquent', value: true });
  if (f.freeAndClear) filters.push({ filter_id: 'is_free_and_clear', value: true });
  if (f.minValue || f.maxValue) {
    filters.push({
      filter_id: 'estimated_value',
      operator: 'range',
      value: { min: Number(f.minValue) || 0, max: Number(f.maxValue) || 100000000 },
    });
  }
  if (f.singleFamily) {
    try {
      const catalog = await getFilterCatalog(apiKey);
      const optId = findOptionId(catalog, 'property_type', 'Single Family');
      if (optId == null) {
        return {
          statusCode: 422,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'filter_unavailable',
            detail: 'Could not resolve the "Single Family" property-type option. Uncheck Single Family and try again.',
          }),
        };
      }
      filters.push({ filter_id: 'property_type', operator: 'contains_any', value: [optId] });
    } catch (e) {
      return {
        statusCode: 422,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'filter_unavailable',
          detail: 'Property-type filter lookup failed (' + String(e.message).slice(0, 120) + '). Uncheck Single Family and try again.',
        }),
      };
    }
  }

  const dmBody = {
    locations: [{ type: 'zip_code', code: zip }],
    anchor: 'properties',
    contact_audience: 'none', // property data only — skip trace separately to save people credits
    filters,
    page: Math.max(1, Number(body.page) || 1),
    per_page: Math.min(250, Math.max(1, Number(body.per_page) || 25)),
  };
  if (body.estimate_cost) dmBody.estimate_cost = true;

  try {
    const resp = await fetch(`${API_BASE}/properties/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(dmBody),
    });
    const dm = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'DealMachine API error',
          detail: JSON.stringify(dm.error || dm).slice(0, 600),
        }),
      };
    }

    // Normalize properties for the dashboard
    const data = (dm.data || []).map((p) => ({
      dmPropertyId: p.dm_property_id || null,
      fullAddress: p.full_address || '',
      address: p.address || '',
      city: p.city || '',
      state: p.state || '',
      zip: p.zip || '',
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
      estimatedValue: p.estimated_value ?? null,
      equityPct: p.estimated_equity_percentage ?? null,
      equityAmount: p.estimated_equity_amount ?? null,
      bedrooms: p.num_bedrooms ?? null,
      bathrooms: p.num_bathrooms ?? null,
      sqft: p.living_area_sqft ?? null,
      yearBuilt: p.year_built ?? null,
      propertyType: p.property_type || null,
      images: p.images || null,
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        data,
        totals: dm.totals || null,
        pagination: dm.pagination || null,
        estimated_credits: dm.estimated_credits || null,
        credits: dm.credits || null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Search failed', detail: String(err).slice(0, 300) }),
    };
  }
};

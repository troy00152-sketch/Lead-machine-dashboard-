// netlify/functions/dealmachine-reverse.js
// DealMachine v2 API reverse-lookup proxy (enrichment anchors) via Netlify serverless function.
// Keeps the DEALMACHINE_API_KEY server-side (set in Netlify env vars).
// Dashboard calls: POST /.netlify/functions/dealmachine-reverse
//   { mode: "phone", phone: "9199397586" }
//   { mode: "email", email: "john@example.com" }
//   { mode: "apn", apn: "0123-45-6789", state: "NC" }          (state required for APN)
//   { mode: "apn", apn: "0123-45-6789", location: {type:"county", code:"..."} }
// Modes map to /v1/enrichment/phone, /v1/enrichment/email, /v1/enrichment/apn.
// Docs: https://api.docs.dealmachine.com (Enrich by phone / Enrich by email / Enrich by APN)
// Cost: 1 people credit per matched person (phone/email); 1 property credit per
// matched APN. Unmatched = free.

const API_BASE = 'https://api.v2.dealmachine.com/v1';

const PROPERTY_FIELDS = [
  'estimated_value', 'num_bedrooms', 'num_bathrooms', 'living_area_sqft',
  'lot_size_sqft', 'lot_size_acres', 'year_built', 'property_type',
  'last_sale_date', 'last_sale_price', 'assessed_total_value', 'tax_amount',
  'owner_1_full_name', 'owner_2_full_name', 'is_owner_occupied',
  'parcel_number_raw', 'legal_description', 'zoning', 'flood_zone',
  'estimated_equity_amount', 'estimated_equity_percentage', 'num_mortgages',
  'total_estimated_loan_balance', 'num_total_active_liens',
  'property_preforeclosure_status', 'is_tax_delinquent', 'tax_delinquent_year',
  // lat/lng + images are always included free, no need to request them
];

const PEOPLE_FIELDS = [
  'full_name', 'first_name', 'last_name', 'phones', 'emails',
  'estimated_household_income',
  // NOTE: 'age' is documented but REJECTS phone/email enrichment on this
  // plan (enrichment_failed) — do not add it back without live testing.
];

function normPerson(c) {
  return {
    personId: c.dm_person_id || null,
    fullName: c.full_name || '',
    firstName: c.first_name || '',
    lastName: c.last_name || '',
    age: c.age ?? null,
    householdIncome: c.estimated_household_income ?? null,
    phones: (c.phones || []).map((ph) => ({
      number: ph.number,
      type: ph.type || null,
      doNotCall: !!ph.do_not_call,
      carrier: ph.carrier || null,
    })),
    emails: (c.emails || []).map((e) => (typeof e === 'string' ? e : e.address)).filter(Boolean),
    residence: c.residence
      ? {
          address: c.residence.address || '',
          city: c.residence.city || '',
          state: c.residence.state || '',
          zip: c.residence.zip || '',
          fullAddress: c.residence.full_address || '',
        }
      : null,
    propertyCount: c.property_count ?? (c.properties || []).length,
    properties: (c.properties || []).map(normProperty),
  };
}

function normProperty(pr) {
  return {
    propertyId: pr.dm_property_id || null,
    fullAddress: pr.full_address || '',
    address: pr.address || '',
    city: pr.city || '',
    state: pr.state || '',
    zip: pr.zip || '',
    estimatedValue: pr.estimated_value ?? null,
    equityPct: pr.estimated_equity_percentage ?? null,
    equityAmount: pr.estimated_equity_amount ?? null,
    bedrooms: pr.num_bedrooms ?? null,
    bathrooms: pr.num_bathrooms ?? null,
    sqft: pr.living_area_sqft ?? null,
    lotSqft: pr.lot_size_sqft ?? null,
    yearBuilt: pr.year_built ?? null,
    propertyType: pr.property_type || null,
    lastSaleDate: pr.last_sale_date || null,
    lastSalePrice: pr.last_sale_price ?? null,
    owner1Name: pr.owner_1_full_name || null,
    owner2Name: pr.owner_2_full_name || null,
    ownerOccupied: pr.is_owner_occupied ?? pr.owner_occupied ?? null,
    apn: pr.apn || pr.parcel_number_raw || null,
    preforeclosureStatus: pr.property_preforeclosure_status || null,
    taxDelinquent: pr.is_tax_delinquent ?? null,
    latitude: pr.latitude ?? null,
    longitude: pr.longitude ?? null,
    images: pr.images || null,
    contacts: (pr.contacts || []).map((c) => ({
      fullName: c.full_name || '',
      phones: (c.phones || []).map((ph) => ({
        number: ph.number,
        type: ph.type || null,
        doNotCall: !!ph.do_not_call,
        carrier: ph.carrier || null,
      })),
    })),
  };
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

  const mode = String(body.mode || '').toLowerCase();
  let endpoint, dmBody, errMsg;

  if (mode === 'phone') {
    const digits = String(body.phone || '').replace(/\D/g, '');
    if (digits.length < 10) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'phone is required (10+ digits)' }) };
    }
    endpoint = '/enrichment/phone';
    dmBody = {
      data: [{ phone: digits }],
      include_properties: true,
      fields: PEOPLE_FIELDS.concat(['estimated_value']),
    };
    errMsg = 'Phone lookup failed';
  } else if (mode === 'email') {
    const email = String(body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'email is required (valid format)' }) };
    }
    endpoint = '/enrichment/email';
    dmBody = {
      data: [{ email }],
      include_properties: true,
      fields: PEOPLE_FIELDS.concat(['estimated_value']),
    };
    errMsg = 'Email lookup failed';
  } else if (mode === 'apn') {
    const apn = String(body.apn || '').trim();
    if (!apn) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'apn is required' }) };
    }
    let location = body.location || null;
    if (!location && body.state) {
      const st = String(body.state).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(st)) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'state must be a 2-letter abbreviation' }) };
      }
      location = { type: 'state', code: st };
    }
    if (!location) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'state (2-letter) is required for APN lookup' }) };
    }
    endpoint = '/enrichment/apn';
    dmBody = {
      data: [{ apn }],
      location,
      contact_audience: 'owners',
      fields: PROPERTY_FIELDS,
    };
    errMsg = 'APN lookup failed';
  } else {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'mode is required: "phone", "email", or "apn"' }),
    };
  }

  try {
    const resp = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(dmBody),
    });
    const dm = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'DealMachine API error', detail: JSON.stringify(dm.error || dm).slice(0, 600) }),
      };
    }

    const items = dm.data || [];
    const item = items[0] || {};
    const matched = !!item.matched;

    if (mode === 'apn') {
      // Property response shape
      if (!matched) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, matched: false, totals: dm.totals || null }) };
      }
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          matched: true,
          property: normProperty(item),
          warning: item.match_warning || null,
          totals: dm.totals || null,
          credits: dm.credits || null,
        }),
      };
    }

    // People response shape (phone / email): contacts[]
    const people = ((item || {}).contacts || []).map(normPerson);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        matched,
        matchFailure: item.match_failure || null,
        people,
        totals: dm.totals || null,
        credits: dm.credits || null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: errMsg, detail: String(err).slice(0, 300) }),
    };
  }
};

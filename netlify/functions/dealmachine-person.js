// netlify/functions/dealmachine-person.js
// DealMachine v2 API person lookup by name via Netlify serverless function.
// Keeps the DEALMACHINE_API_KEY server-side (set in Netlify env vars).
// Dashboard calls: POST /.netlify/functions/dealmachine-person
//   { first_name, last_name, state }   (state = 2-letter, optional)
//
// Docs: https://api.docs.dealmachine.com/api-reference/enrichment/enrich-by-name
// Returns matching people with phones, emails, residence, and associated properties.
// Cost: 1 people credit per matched person (property address fields free;
// include_properties adds 1 property credit per returned property).
// Supports estimate_cost:true to preview for FREE.

const API_BASE = 'https://api.v2.dealmachine.com/v1';

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

  const lastName = String(body.last_name || '').trim();
  const firstName = String(body.first_name || '').trim();
  const state = String(body.state || '').trim().toUpperCase();
  if (!lastName) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'last_name is required' }) };
  }
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'state must be a 2-letter abbreviation' }) };
  }

  const nameObj = { last_name: lastName };
  if (firstName) nameObj.first_name = firstName;

  const dmBody = {
    data: [nameObj],
    include_properties: true,
    fields: ['full_name', 'phones', 'emails'],
    per_page: 25,
    page: 1,
  };
  if (state) dmBody.location = { type: 'state', code: state };
  if (body.estimate_cost) dmBody.estimate_cost = true;

  try {
    const resp = await fetch(`${API_BASE}/enrichment/name`, {
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

    if (body.estimate_cost) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          estimate: true,
          totals: dm.totals || null,
          pagination: dm.pagination || null,
          estimated_credits: dm.estimated_credits || null,
        }),
      };
    }

    const people = (dm.data || []).map((p) => ({
      personId: p.dm_person_id || null,
      fullName: p.full_name || '',
      firstName: p.first_name || '',
      lastName: p.last_name || '',
      phones: (p.phones || []).map((ph) => ({
        number: ph.number,
        type: ph.type || null,
        doNotCall: !!ph.do_not_call,
        carrier: ph.carrier || null,
      })),
      emails: (p.emails || []).map((e) => e.address).filter(Boolean),
      residence: p.residence
        ? {
            address: p.residence.address || '',
            city: p.residence.city || '',
            state: p.residence.state || '',
            zip: p.residence.zip || '',
            fullAddress: p.residence.full_address || '',
          }
        : null,
      propertyCount: p.property_count ?? (p.properties || []).length,
      properties: (p.properties || []).map((pr) => ({
        propertyId: pr.dm_property_id || null,
        address: pr.address || '',
        city: pr.city || '',
        state: pr.state || '',
        zip: pr.zip || '',
        latitude: pr.latitude ?? null,
        longitude: pr.longitude ?? null,
      })),
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        people,
        pagination: dm.pagination || null,
        credits: dm.credits || null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Person lookup failed', detail: String(err).slice(0, 300) }),
    };
  }
};

// netlify/functions/dealmachine-dnc.js
// DealMachine v2 API bulk DNC + phone-type check via Netlify serverless function.
// Keeps the DEALMACHINE_API_KEY server-side (set in Netlify env vars).
// Dashboard calls: POST /.netlify/functions/dealmachine-dnc
//   { phones: ["3175551234", "(317) 555-9999", ...] }   (max 1000 per call)
//
// Docs: https://api.docs.dealmachine.com/api-reference/phones/check-dnc
// Response per number: matched, do_not_call (national registry only),
// phone_type (wireless/landline/voip/unknown), carrier.
// Cost: 1 credit per MATCHED phone; unmatched free; deduplicated per billing period.

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

  const rawPhones = Array.isArray(body.phones) ? body.phones : [];
  // Normalize: strip to digits, drop empties/short, dedupe
  const seen = new Set();
  const phones = [];
  for (const p of rawPhones) {
    const digits = String(p || '').replace(/\D/g, '');
    const norm = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
    if (norm.length === 10 && !seen.has(norm)) {
      seen.add(norm);
      phones.push({ number: norm });
    }
  }
  if (!phones.length) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No valid 10-digit phone numbers provided' }) };
  }
  if (phones.length > 1000) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Max 1000 phones per call' }) };
  }

  try {
    const resp = await fetch(`${API_BASE}/phones/dnc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phones }),
    });
    const dm = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'DealMachine API error', detail: JSON.stringify(dm.error || dm).slice(0, 600) }),
      };
    }

    const results = (dm.data || []).map((r) => ({
      number: (r.input && r.input.number) || null,
      matched: !!r.matched,
      doNotCall: r.do_not_call ?? null, // national registry only — not state lists
      phoneType: r.phone_type || null, // wireless | landline | voip | unknown
      carrier: r.carrier || null,
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        results,
        totals: dm.totals || null,
        credits: dm.credits || null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'DNC check failed', detail: String(err).slice(0, 300) }),
    };
  }
};

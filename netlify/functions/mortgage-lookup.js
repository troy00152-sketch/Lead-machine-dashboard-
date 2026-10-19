// netlify/functions/mortgage-lookup.js
// Homesage.ai mortgage/lien/foreclosure lookup via Netlify serverless function.
// Keeps the HOMESAGE_API_KEY server-side (set in Netlify env vars).
// Dashboard calls: GET /.netlify/functions/mortgage-lookup?address=<url-encoded full address>

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const params = event.queryStringParameters || {};
  const address = (params.address || '').trim();

  if (!address) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing address query parameter' }),
    };
  }

  const apiKey = process.env.HOMESAGE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'HOMESAGE_API_KEY is not configured in Netlify environment variables' }),
    };
  }

  // Normalized empty payload (graceful fallback — never crash)
  const emptyPayload = {
    openLoans: 0,
    lender: null,
    loanAmount: null,
    outstandingBalance: null,
    interestRate: null,
    loanTermMonths: null,
    recordingDate: null,
    foreclosureStatus: 'None',
    preForeclosure: false,
    totalOpenLienAmount: 0,
    hasData: false,
  };

  try {
    const url =
      'https://api.homesage.ai/api/mortgage-lien/analysis?address=' +
      encodeURIComponent(address);

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
    });

    if (!resp.ok) {
      // Upstream error — return graceful empty payload, don't crash
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ...emptyPayload, _upstreamStatus: resp.status }),
      };
    }

    const data = await resp.json();

    const current = (data.current_mortgages || [])[0] || null;
    const lienSummary = data.lien_summary || {};
    const preFc = data.pre_foreclosure || {};

    const payload = {
      openLoans: (data.current_mortgages || []).length,
      lender: current ? current.lender_name || null : null,
      loanAmount: current ? current.original_loan_amount ?? null : null,
      outstandingBalance:
        current && current.estimated_outstanding_balance != null
          ? current.estimated_outstanding_balance
          : lienSummary.total_open_lien_amount ?? null,
      interestRate: current ? current.interest_rate ?? null : null,
      loanTermMonths: current ? current.loan_term_months ?? null : null,
      recordingDate: current ? current.recording_date || null : null,
      foreclosureStatus: preFc.is_in_pre_foreclosure ? 'Pre-Foreclosure' : 'None',
      preForeclosure: !!preFc.is_in_pre_foreclosure,
      totalOpenLienAmount: lienSummary.total_open_lien_amount ?? 0,
      estimatedLtv: lienSummary.estimated_ltv ?? null,
      hasData: !!(current || (data.historical_mortgages || []).length),
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ...emptyPayload, _error: err.message }),
    };
  }
};

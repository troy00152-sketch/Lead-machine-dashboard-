// netlify/functions/dealmachine-lookup.js
// DealMachine v2 API property lookup via Netlify serverless function.
// Keeps the DEALMACHINE_API_KEY server-side (set in Netlify env vars).
// Dashboard calls: GET /.netlify/functions/dealmachine-lookup?address=<url-encoded full address>&phones=true
//
// Query params:
//   address (required): full address e.g. "303 Elizabeth St, Greenville, NC 27834"
//   phones (optional): "true" to include owner contact phones/emails (costs people credits)

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
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const params = event.queryStringParameters || {};
  const address = (params.address || '').trim();
  const wantPhones = params.phones === 'true';

  if (!address) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing address query parameter' }),
    };
  }

  const apiKey = process.env.DEALMACHINE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'DEALMACHINE_API_KEY is not configured in Netlify environment variables' }),
    };
  }

  try {
    const response = await fetch('https://api.v2.dealmachine.com/v1/enrichment/address', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: [{ full_address: address }],
        contact_audience: wantPhones ? 'owners' : 'none',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        statusCode: response.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'DealMachine API error', detail: errText.slice(0, 500) }),
      };
    }

    const dm = await response.json();
    const items = dm.data || [];
    if (!items.length || !items[0].matched) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ matched: false, address }),
      };
    }

    const p = items[0];

    // Normalize to dashboard-friendly shape
    const mortgages = (p.mortgages || []).map(m => ({
      lender: m.lender_name || null,
      balance: m.loan_balance ?? null,
      originalAmount: m.loan_amount ?? null,
      interestRate: m.loan_interest_rate ?? null,
      termMonths: m.loan_term_months ?? null,
      loanType: m.loan_type || null,
      financingType: m.loan_financing_type || null,
      lienPosition: m.lien_position ?? null,
      startDate: m.loan_start_date || null,
      dueDate: m.loan_due_date || null,
    }));

    // Extract mobile phones only (Troy's rule: mobile-only outreach)
    let phones = [];
    let ownerName = null;
    if (wantPhones && Array.isArray(p.contacts)) {
      for (const c of p.contacts) {
        if (!ownerName && c.full_name) ownerName = c.full_name;
        for (const ph of (c.phones || [])) {
          const t = (ph.type || '').toLowerCase();
          if (t === 'wireless' || t === 'mobile' || t === 'cell') {
            phones.push({
              number: ph.number,
              type: ph.type,
              doNotCall: !!ph.do_not_call,
              carrier: ph.carrier || null,
            });
          }
        }
      }
    }

    const result = {
      matched: true,
      address: p.full_address || address,
      // Property
      estimatedValue: p.estimated_value ?? null,
      bedrooms: p.num_bedrooms ?? null,
      bathrooms: p.num_bathrooms ?? null,
      sqft: p.living_area_sqft ?? null,
      lotSqft: p.lot_size_sqft ?? null,
      yearBuilt: p.year_built ?? null,
      propertyType: p.property_type || null,
      lastSaleDate: p.last_sale_date || null,
      lastSaleAmount: p.last_sale_amount ?? null,
      assessedValue: p.total_assessed_value ?? null,
      annualTax: p.annual_property_tax_amount ?? null,
      ownerOccupied: p.owner_occupied ?? null,
      apn: p.apn || null,
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
      // Owner
      ownerName,
      // Mortgage
      numMortgages: p.num_mortgages ?? 0,
      totalLoanBalance: p.total_estimated_loan_balance ?? null,
      estimatedEquity: p.estimated_equity_amount ?? null,
      estimatedEquityPct: p.estimated_equity_percentage ?? null,
      mortgages,
      // Primary mortgage shortcut (most-used fields)
      primaryMortgage: mortgages[0] || null,
      // Distress
      preforeclosureStatus: p.property_preforeclosure_status || null,
      foreclosureStatus: p.foreclosure_status || null,
      foreclosureAuctionDate: p.foreclosure_auction_date || null,
      taxDelinquentYear: p.tax_delinquent_year ?? null,
      numLiens: p.num_total_active_liens ?? null,
      // Phones (only when phones=true)
      phones,
      // Credits info
      creditsUsed: (dm.credits || {}).used ?? null,
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Lookup failed', detail: String(err).slice(0, 300) }),
    };
  }
};

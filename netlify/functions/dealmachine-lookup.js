// netlify/functions/dealmachine-lookup.js
// DealMachine v2 API property lookup via Netlify serverless function.
// Keeps the DEALMACHINE_API_KEY server-side (set in Netlify env vars).
// Dashboard calls:
//   GET /.netlify/functions/dealmachine-lookup?address=<url-encoded full address>&phones=true
//   GET /.netlify/functions/dealmachine-lookup?usage=1   -> DealMachine credit usage (FREE)
//
// Query params:
//   address (required unless usage=1): full address e.g. "303 Elizabeth St, Greenville, NC 27834"
//   phones (optional): "true" to include owner contact phones/emails (costs people credits)

const API_BASE = 'https://api.v2.dealmachine.com/v1';

// XLeads-style density: request every useful property/mortgage/distress field.
// Flat field IDs (mortgage_1..4_* include interest rates — verified in the
// field catalog, GET /v1/fields). Fields the API doesn't return simply come
// back absent; the nested `mortgages[]` array is mapped as a fallback.
// NOTE: foreclosure_auction_date / foreclosure_default_date /
// foreclosure_recording_date are PREMIUM fields on this plan — requesting
// them rejects the ENTIRE request, so they are excluded. Keep the list
// at <= 100 entries (API maximum for the fields array).
// NOTE: foreclosure_auction_date / foreclosure_default_date /
// foreclosure_recording_date are PREMIUM fields — requesting them rejects the
// entire request on this plan, so they are excluded. Keep this list <= 100
// (API maximum for the fields array).
const PROPERTY_FIELDS = [
  'estimated_value',
  'num_bedrooms',
  'num_bathrooms',
  'living_area_sqft',
  'lot_size_sqft',
  'lot_size_acres',
  'year_built',
  'property_type',
  'num_units',
  'last_sale_date',
  'last_sale_price',
  'assessed_total_value',
  'tax_amount',
  'tax_year',
  'owner_1_full_name',
  'owner_2_full_name',
  'is_owner_occupied',
  'homeowner_status',
  'ownership_entity_type',
  'has_absentee_owners',
  'has_out_of_state_owners',
  'parcel_number_raw',
  'legal_description',
  'zoning',
  'flood_zone',
  'estimated_equity_amount',
  'estimated_equity_percentage',
  'estimated_loan_to_value_percentage',
  'num_mortgages',
  'total_estimated_loan_balance',
  'total_original_loan_amount',
  'total_estimated_loan_payment_monthly',
  'mortgage_1_lender_name',
  'mortgage_1_loan_balance',
  'mortgage_1_loan_amount',
  'mortgage_1_loan_interest_rate',
  'mortgage_1_loan_term_months',
  'mortgage_1_loan_type',
  'mortgage_1_financing_type',
  'mortgage_1_lien_position',
  'mortgage_1_loan_start_date',
  'mortgage_1_loan_due_date',
  'mortgage_1_loan_recording_date',
  'mortgage_1_estimated_payment_amount',
  'mortgage_2_lender_name',
  'mortgage_2_loan_balance',
  'mortgage_2_loan_amount',
  'mortgage_2_loan_interest_rate',
  'mortgage_2_loan_term_months',
  'mortgage_2_loan_type',
  'mortgage_2_financing_type',
  'mortgage_2_lien_position',
  'mortgage_2_loan_start_date',
  'mortgage_2_loan_due_date',
  'mortgage_2_loan_recording_date',
  'mortgage_2_estimated_payment_amount',
  'mortgage_3_lender_name',
  'mortgage_3_loan_balance',
  'mortgage_3_loan_amount',
  'mortgage_3_loan_interest_rate',
  'mortgage_3_loan_term_months',
  'mortgage_3_loan_type',
  'mortgage_3_financing_type',
  'mortgage_3_lien_position',
  'mortgage_3_loan_start_date',
  'mortgage_3_loan_due_date',
  'mortgage_3_loan_recording_date',
  'mortgage_3_estimated_payment_amount',
  'mortgage_4_lender_name',
  'mortgage_4_loan_balance',
  'mortgage_4_loan_amount',
  'mortgage_4_loan_interest_rate',
  'mortgage_4_loan_term_months',
  'mortgage_4_loan_type',
  'mortgage_4_financing_type',
  'mortgage_4_lien_position',
  'mortgage_4_loan_start_date',
  'mortgage_4_loan_due_date',
  'mortgage_4_loan_recording_date',
  'mortgage_4_estimated_payment_amount',
  'num_total_active_liens',
  'num_total_open_liens',
  'total_open_lien_amount',
  'has_active_lien',
  'lien_doc_type',
  'property_preforeclosure_status',
  'is_preforeclosure',
  'foreclosure_status',
  'foreclosure_doc_type',
  'is_tax_delinquent',
  'tax_delinquent_year'
];

function money(v) { return v === undefined || v === null || v === '' ? null : v; }

// Build the mortgages array. Prefer the nested `mortgages[]` array when the API
// returns one; otherwise assemble from the flat mortgage_N_* fields.
function buildMortgages(p) {
  const nested = (p.mortgages || []).map(m => ({
    lender: m.lender_name || null,
    balance: money(m.loan_balance),
    originalAmount: money(m.loan_amount),
    interestRate: money(m.loan_interest_rate),
    termMonths: money(m.loan_term_months),
    loanType: m.loan_type || null,
    financingType: m.loan_financing_type || m.financing_type || null,
    lienPosition: money(m.lien_position),
    startDate: m.loan_start_date || null,
    dueDate: m.loan_due_date || null,
    recordingDate: m.loan_recording_date || null,
    paymentAmount: money(m.estimated_payment_amount),
  }));
  if (nested.length) return nested;

  const out = [];
  for (let i = 1; i <= 4; i++) {
    const g = (suffix) => p[`mortgage_${i}_${suffix}`];
    const lender = g('lender_name');
    const balance = g('loan_balance');
    const amount = g('loan_amount');
    if (!lender && balance == null && amount == null) continue;
    out.push({
      lender: lender || null,
      balance: money(balance),
      originalAmount: money(amount),
      interestRate: money(g('loan_interest_rate')),
      termMonths: money(g('loan_term_months')),
      loanType: g('loan_type') || null,
      financingType: g('financing_type') || null,
      lienPosition: money(g('lien_position')) ?? i,
      startDate: g('loan_start_date') || null,
      dueDate: g('loan_due_date') || null,
      recordingDate: g('loan_recording_date') || null,
      paymentAmount: money(g('estimated_payment_amount')),
    });
  }
  return out;
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
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
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

  const params = event.queryStringParameters || {};

  // --- Credits meter mode (FREE): GET ?usage=1 -> /v1/usage ---
  if (params.usage) {
    try {
      const resp = await fetch(`${API_BASE}/usage`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const dm = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          statusCode: resp.status,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'DealMachine API error', detail: JSON.stringify(dm.error || dm).slice(0, 500) }),
        };
      }
      const planResp = await fetch(`${API_BASE}/account`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }).catch(() => null);
      let plan = null;
      if (planResp && planResp.ok) {
        const acc = await planResp.json().catch(() => ({}));
        plan = (acc.data || {}).plan || null;
      }
      const c = dm.credits || {};
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          usage: {
            planName: (dm.plan || {}).name || (plan || {}).name || null,
            used: c.used ?? null,
            remaining: c.remaining ?? c.total_available ?? null,
            total: c.total_cap ?? c.included ?? null,
            included: c.included ?? null,
            overage: c.overage ?? 0,
            breakdown: c.breakdown || null,
            billingCycle: dm.billing_cycle || null,
          },
        }),
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Usage check failed', detail: String(err).slice(0, 300) }),
      };
    }
  }

  const address = (params.address || '').trim();
  const wantPhones = params.phones === 'true';

  if (!address) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing address query parameter' }),
    };
  }

  try {
    const response = await fetch(`${API_BASE}/enrichment/address`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: [{ full_address: address }],
        fields: PROPERTY_FIELDS,
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

    const mortgages = buildMortgages(p);

    // Extract mobile phones only (Troy's rule: mobile-only outreach)
    let phones = [];
    let ownerName = null;
    let ownerEmails = [];
    if (wantPhones && Array.isArray(p.contacts)) {
      for (const c of p.contacts) {
        if (!ownerName && c.full_name) ownerName = c.full_name;
        for (const e of (c.emails || [])) {
          const addr = typeof e === 'string' ? e : e.address;
          if (addr) ownerEmails.push(addr);
        }
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
    if (!ownerName) ownerName = p.owner_1_full_name || null;

    // Ownership length from last sale / mortgage start when available
    const result = {
      matched: true,
      address: p.full_address || address,
      // Property
      estimatedValue: p.estimated_value ?? null,
      bedrooms: p.num_bedrooms ?? null,
      bathrooms: p.num_bathrooms ?? null,
      sqft: p.living_area_sqft ?? null,
      lotSqft: p.lot_size_sqft ?? null,
      lotAcres: p.lot_size_acres ?? null,
      yearBuilt: p.year_built ?? null,
      propertyType: p.property_type || null,
      additionalPropertyTypes: p.additional_property_types ?? null,
      numUnits: p.num_units ?? null,
      numBuildings: p.num_buildings ?? null,
      lastSaleDate: p.last_sale_date || null,
      lastSaleAmount: p.last_sale_amount ?? p.last_sale_price ?? null,
      lastSalePrice: p.last_sale_price ?? p.last_sale_amount ?? null,
      lastSaleDocType: p.last_sale_doc_type || null,
      assessedValue: p.total_assessed_value ?? p.assessed_total_value ?? null,
      assessedLandValue: p.assessed_land_value ?? null,
      assessedImprovementValue: p.assessed_improvement_value ?? null,
      annualTax: p.annual_property_tax_amount ?? p.tax_amount ?? null,
      taxAmount: p.tax_amount ?? null,
      taxYear: p.tax_year ?? null,
      taxAssessmentYear: p.tax_assessment_year ?? null,
      ownerOccupied: p.owner_occupied ?? p.is_owner_occupied ?? null,
      isOwnerOccupied: p.is_owner_occupied ?? null,
      homeownerStatus: p.homeowner_status || null,
      ownershipEntityType: p.ownership_entity_type || null,
      absenteeOwner: p.has_absentee_owners ?? null,
      outOfStateOwner: p.has_out_of_state_owners ?? null,
      seniorOwner: p.has_senior_owners ?? null,
      apn: p.apn || p.parcel_number_raw || null,
      parcelNumber: p.parcel_number_raw || p.apn || null,
      legalDescription: p.legal_description || null,
      zoning: p.zoning || null,
      floodZone: p.flood_zone || null,
      inFloodHazardArea: p.is_inside_special_flood_hazard_area ?? null,
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
      images: p.images || null,
      // Owner
      ownerName,
      owner1Name: p.owner_1_full_name || null,
      owner2Name: p.owner_2_full_name || null,
      ownerEmails,
      // Mortgage
      numMortgages: p.num_mortgages ?? mortgages.length,
      totalLoanBalance: p.total_estimated_loan_balance ?? null,
      totalOriginalLoanAmount: p.total_original_loan_amount ?? null,
      totalMonthlyPayment: p.total_estimated_loan_payment_monthly ?? null,
      estimatedLtvPct: p.estimated_loan_to_value_percentage ?? null,
      estimatedEquity: p.estimated_equity_amount ?? null,
      estimatedEquityPct: p.estimated_equity_percentage ?? null,
      mortgages,
      // Primary mortgage shortcut (most-used fields)
      primaryMortgage: mortgages[0] || null,
      // Liens
      numLiens: p.num_total_active_liens ?? null,
      numOpenLiens: p.num_total_open_liens ?? null,
      totalOpenLienAmount: p.total_open_lien_amount ?? null,
      hasActiveLien: p.has_active_lien ?? null,
      hasHoaLien: p.has_hoa_lien ?? null,
      lienDocType: p.lien_doc_type || null,
      // Distress
      preforeclosureStatus: p.property_preforeclosure_status || null,
      isPreforeclosure: p.is_preforeclosure ?? null,
      foreclosureStatus: p.foreclosure_status || null,
      foreclosureAuctionDate: p.foreclosure_auction_date || null,
      foreclosureDefaultDate: p.foreclosure_default_date || null,
      foreclosureDocType: p.foreclosure_doc_type || null,
      taxDelinquent: p.is_tax_delinquent ?? null,
      taxDelinquentYear: p.tax_delinquent_year ?? null,
      // Phones (only when phones=true)
      phones,
      // Credits info
      creditsUsed: (dm.credits || {}).used ?? null,
      credits: dm.credits || null,
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

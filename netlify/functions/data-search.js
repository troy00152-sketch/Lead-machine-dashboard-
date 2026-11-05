/* pr-search.js — data provider /v1/search wrapper for the dashboard List Builder.
   Replaces dealmachine-search.js (DealMachine canceled Nov 19).
   POST /.netlify/functions/data-search
   Body: { target: {city, county, state, zip}, filter: {...}, limit, offset }
   Cost: 1 API credit per call. Up to 150 results per call. */
const https = require('https');

const API_BASE = 'https://api.propertyreach.com';

function post(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Content-Length': Buffer.byteLength(data) },
      timeout: 25000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ http: res.statusCode, json: JSON.parse(raw) }); }
        catch (e) { resolve({ http: res.statusCode, json: null, raw: raw.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function bodyOk(r) {
  return r && r.json && r.json.meta && (r.json.meta.status === 200 || r.json.meta.status === 201);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  const apiKey = process.env.PROPERTYREACH_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'PROPERTYREACH_API_KEY not set' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const target = body.target || {};
  const filter = body.filter || {};
  const limit = Math.min(Math.max(parseInt(body.limit) || 50, 1), 150);
  const offset = Math.max(parseInt(body.offset) || 0, 0);

  try {
    const res = await post('/v1/search', { target, filter, options: { limit, offset } }, apiKey);
    if (!bodyOk(res)) {
      const meta = res && res.json && res.json.meta;
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ matched: false, upstream: meta || { http: res ? res.http : 'fetch-failed' } }) };
    }
    const props = (res.json.properties || []).map(p => ({
      address: [p.streetAddress, p.city, p.state, p.zip].filter(Boolean).join(', '),
      streetAddress: p.streetAddress || null,
      city: p.city || null,
      state: p.state || null,
      zip: p.zip || null,
      propertyId: p.id || null,
      propertyType: p.propertyType || null,
      landUse: p.landUse || null,
      beds: p.bedrooms != null ? p.bedrooms : null,
      baths: p.bathrooms != null ? p.bathrooms : null,
      sqft: p.squareFeet || null,
      lotSqft: p.lotSquareFeet || null,
      yearBuilt: p.yearBuilt || null,
      estimatedValue: p.estimatedValue != null ? p.estimatedValue : null,
      lastSaleAmount: p.lastSaleAmount != null ? p.lastSaleAmount : null,
      lastSaleDate: p.lastSaleDate ? String(p.lastSaleDate).slice(0, 10) : null,
      onMarket: !!p.onMarket,
      listingStatus: p.listingStatus || null,
      photoUrl: p.photoUrl || null,
      photosAvailable: !!p.photosAvailable,
      pricePerSqft: p.pricePerSquareFoot != null ? p.pricePerSquareFoot : null,
      saleSituation: p.saleSituation || null,
      subdivision: p.subdivision || null,
    }));
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        matched: true,
        source: 'data provider',
        resultCount: res.json.meta.resultCount != null ? res.json.meta.resultCount : props.length,
        returnedCount: props.length,
        limit, offset,
        credits: res.json.meta.credits != null ? res.json.meta.credits : null,
        properties: props,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Search failed', detail: String(err).slice(0, 300) }) };
  }
};

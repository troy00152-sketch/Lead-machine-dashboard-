/* pr-suggest.js — data provider /v1/suggestions wrapper for address auto-complete.
   GET /.netlify/functions/data-suggest?query=...
   Cost: 0.01 API credits per successful call. */
const https = require('https');

const API_BASE = 'https://api.data-api.com';

function get(path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(API_BASE + path, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      timeout: 15000,
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
    req.end();
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  const apiKey = process.env.PROPERTYREACH_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'PROPERTYREACH_API_KEY not set' }) };

  const q = (event.queryStringParameters && event.queryStringParameters.query || '').trim();
  if (q.length < 3) return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions: [] }) };

  try {
    const res = await get('/v1/suggestions?query=' + encodeURIComponent(q), apiKey);
    const ok = res && res.json && res.json.meta && (res.json.meta.status === 200 || res.json.meta.status === 201);
    if (!ok) return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions: [] }) };
    const suggestions = (res.json.suggestions || []).map(s => ({
      type: s.type || null,
      title: s.title || null,
      streetAddress: s.streetAddress || null,
      city: s.city || null,
      state: s.state || null,
      zip: s.zip || null,
      county: s.county || null,
      propertyId: s.propertyId || null,
    }));
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions }) };
  } catch (err) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions: [] }) };
  }
};

/* pr-skiptrace.js — data provider /v1/skip-trace wrapper for the dashboard Skip Trace page.
   Replaces dealmachine-lookup?phones=true (DealMachine canceled Nov 19).
   POST /.netlify/functions/data-skiptrace
   Body: { streetAddress, city, state, zip, apn, propertyId }
   Cost: 2 API credits per successful call.
   NOTE: PR skip-trace phones carry first/last reported dates but NO line-type
   field — mobile vs landline is not distinguished in the response. */
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
  const target = {};
  ['apn', 'city', 'county', 'fips', 'propertyId', 'state', 'streetAddress', 'zip'].forEach(k => {
    if (body[k] != null && String(body[k]).trim() !== '') target[k] = body[k];
  });
  if (!Object.keys(target).length) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Provide at least one target field (streetAddress, city, state, zip, apn, or propertyId)' }) };
  }

  try {
    const res = await post('/v1/skip-trace', { target }, apiKey);
    if (!bodyOk(res)) {
      const meta = res && res.json && res.json.meta;
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ matched: false, upstream: meta || { http: res ? res.http : 'fetch-failed' } }) };
    }
    const persons = (res.json.persons || []).map(p => ({
      firstName: p.firstName || null,
      middleName: p.middleName || null,
      lastName: p.lastName || null,
      emails: (p.emails || []).map(e => ({ email: e.email, firstReported: e.firstReported || null, lastReported: e.lastReported || null })),
      phones: (p.phones || []).map(ph => ({ phone: ph.phone, firstReported: ph.firstReported || null, lastReported: ph.lastReported || null })),
    }));
    const allPhones = [];
    const allEmails = [];
    persons.forEach(p => {
      (p.phones || []).forEach(ph => { if (ph.phone && !allPhones.find(x => x.phone === ph.phone)) allPhones.push(ph); });
      (p.emails || []).forEach(e => { if (e.email && !allEmails.find(x => x.email === e.email)) allEmails.push(e); });
    });
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        matched: true,
        source: 'data provider',
        credits: res.json.meta.credits != null ? res.json.meta.credits : null,
        persons,
        phones: allPhones,
        emails: allEmails,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Skip trace failed', detail: String(err).slice(0, 300) }) };
  }
};

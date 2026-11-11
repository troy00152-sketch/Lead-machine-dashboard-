// netlify/functions/list-import-proxy.js
// List-import proxy — keeps the import secret server-side only.
// CC_IMPORT_SECRET lives in Netlify env vars (Functions scope) on THIS site;
// it must hold the same value as the command-center site's CC_WEBHOOK_SECRET.
// The browser never sees the secret: no key field, no localStorage — the
// dashboard calls:
//   POST /.netlify/functions/list-import-proxy  { market, csv, dryRun }
// and this function forwards the body to the command-center list-import
// function with the x-cc-secret header, passing its JSON report through
// unchanged (outcome / totals / rows). No secret -> 503 NOT_CONFIGURED
// (browser shows "Import failed: not-configured").

var UPSTREAM = 'https://command-center-dpb.netlify.app/.netlify/functions/list-import';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'method-not-allowed', expected: 'POST { market, csv, dryRun }' }) };
  var secret = process.env.CC_IMPORT_SECRET || '';
  if (!secret) return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'not-configured', reason: 'CC_IMPORT_SECRET not set in Netlify env' }) };
  try {
    var resp = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cc-secret': secret },
      body: event.body || '{}',
    });
    var text = await resp.text();
    return { statusCode: resp.status, headers: { 'Content-Type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'failed', reason: 'UPSTREAM_FAILED' }) };
  }
};

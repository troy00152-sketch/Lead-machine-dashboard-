// netlify/functions/pipeline-activity-proxy.js
// Pipeline-strip proxy — keeps the strip key server-side only.
// PIPELINE_STRIP_KEY lives in Netlify env vars (Functions scope) on THIS site;
// it must hold the same value as the bot site's PIPELINE_STRIP_KEY.
// The browser never sees the key: no paste field, no localStorage — the
// dashboard calls:
//   GET /.netlify/functions/pipeline-activity-proxy
// and this function forwards the request to the bot site's pipeline-activity
// function with the x-pipeline-key header, passing status + body through
// unchanged (401 = key rejected, 503 = key not configured upstream).
// No key on this site -> 503 NOT_CONFIGURED (strip shows "not connected").

var UPSTREAM = 'https://profound-nasturtium-bdce9c.netlify.app/.netlify/functions/pipeline-activity';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'method-not-allowed', expected: 'GET' }) };
  var key = process.env.PIPELINE_STRIP_KEY || '';
  if (!key) return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'not-configured', reason: 'PIPELINE_STRIP_KEY not set in Netlify env' }) };
  try {
    var resp = await fetch(UPSTREAM, { method: 'GET', headers: { 'x-pipeline-key': key, 'accept': 'application/json' } });
    var text = await resp.text();
    return { statusCode: resp.status, headers: { 'Content-Type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'failed', reason: 'UPSTREAM_FAILED' }) };
  }
};

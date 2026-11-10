// netlify/functions/rentcast-listing.js
// Listing lookup proxy — keeps the RentCast key server-side only.
// RENTCAST_API_KEY lives in Netlify env vars (Functions scope); the browser
// never sees the key: no key in localStorage, no key field in Settings.
// Each deployment carries its own key (Troy, Nov 9: no one may find the key
// when the system is sold). The dashboard calls:
//   GET /.netlify/functions/rentcast-listing?address=<url-encoded address>
// Returns the raw RentCast /v1/listings/sale array (limit 5); the dashboard
// picks the exact-address match. No key → 503 NO_KEY (panel stays
// "Not checked yet"). Free tier: 50 calls/mo, over 50 bills $0.20/call.

exports.handler = async (event) => {
  var key = process.env.RENTCAST_API_KEY || '';
  if (!key) return { statusCode: 503, body: JSON.stringify({ error: 'NO_KEY' }) };
  var address = ((event.queryStringParameters || {}).address || '').trim();
  if (!address) return { statusCode: 400, body: JSON.stringify({ error: 'NO_ADDRESS' }) };
  var url = 'https://api.rentcast.io/v1/listings/sale?address=' + encodeURIComponent(address) + '&limit=5';
  try {
    var resp = await fetch(url, { headers: { 'X-Api-Key': key, 'accept': 'application/json' } });
    var text = await resp.text();
    return { statusCode: resp.status, headers: { 'content-type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'UPSTREAM_FAILED' }) };
  }
};

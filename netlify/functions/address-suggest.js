// netlify/functions/address-suggest.js
// FREE address type-ahead for the Command Center (Troy, Nov 22, 2026):
// "from the time I start to type like the first couple digits it
// should just populate the address."
//
// Source: the public ArcGIS World Geocoding "suggest" endpoint —
// keyless, no account, no credits, no tokens. That is deliberate:
// PropertyReach API credits are hard-locked (pool at 0) and Realie
// tokens are reserved for comp runs, so suggestions must cost
// nothing. Do NOT swap this for a credit/token source without
// Troy's word. Do NOT rename the upstream hostname in any
// white-label scrub either — server-side identifiers stay real
// (Nov 5 lesson in AGENTS.md); white-labeling is user-visible
// text only, and this endpoint's output is plain addresses.
//
// Ranking: one unbiased US-wide suggest call + one call biased to
// each market Troy works. Biased calls put the local match first —
// proven Nov 22, 2026 against the live endpoint:
//   "1329 Lam"  + Dayton bias -> 1329 Lamar St, Dayton, OH 45404 (#1)
//   "3051 East" + Indy bias   -> 3051 Eastern Ave, Indianapolis, IN 46218 (#1)
// Results merge, dedupe, and sort: exact house-number + street
// prefix matches first, market-biased hits before unbiased ones.
//
// GET /.netlify/functions/address-suggest?q=<partial address>
//   -> { suggestions: [{ label, streetAddress, city, state, zip }] }
// Fails soft: any upstream problem returns an empty list, never a 500.
const https = require('https');

// WARNING: real upstream hostname — never white-label-rename (see header).
const SUGGEST_BASE = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest';

// Market centers Troy works — used only as ranking bias, never as a filter.
const MARKETS = [
  { name: 'Indianapolis', lon: -86.1581, lat: 39.7684 },
  { name: 'Dayton', lon: -84.1916, lat: 39.7589 },
  { name: 'Cleveland', lon: -81.6944, lat: 41.4993 },
  { name: 'Kansas City', lon: -94.5786, lat: 39.0997 },
  { name: 'Charlotte', lon: -80.8431, lat: 35.2271 },
  { name: 'Greenville NC', lon: -77.3664, lat: 35.6127 },
  { name: 'Jacksonville', lon: -81.6557, lat: 30.3322 },
];
const BIAS_DISTANCE_M = 60000; // ~37 miles around each market center
const MAX_SUGGESTIONS = 8;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function defaultFetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'LeadMachineCommandCenter/1.0 (address type-ahead)' },
      timeout: 5000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('bad upstream json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
let fetchJsonImpl = defaultFetchJson;

function buildSuggestUrl(q, market) {
  let url = SUGGEST_BASE + '?f=json&countryCode=US&maxSuggestions=6&text=' + encodeURIComponent(q);
  if (market) url += '&location=' + market.lon + ',' + market.lat + '&distance=' + BIAS_DISTANCE_M;
  return url;
}

// "1329 Lamar St, Dayton, OH, 45404, USA" ->
// { streetAddress: '1329 Lamar St', city: 'Dayton', state: 'OH', zip: '45404' }
function parseSuggestionText(text) {
  const parts = String(text || '').replace(/,\s*USA\s*$/i, '').split(',').map((s) => s.trim()).filter(Boolean);
  let zip = '';
  let state = '';
  if (parts.length && /^\d{5}(-\d{4})?$/.test(parts[parts.length - 1])) zip = parts.pop().slice(0, 5);
  if (parts.length && /^[A-Z]{2}$/.test(parts[parts.length - 1])) state = parts.pop();
  let city = '';
  if (parts.length >= 2) city = parts.pop();
  const streetAddress = parts.join(', ');
  return { streetAddress, city, state, zip };
}

function buildLabel(s) {
  const tail = ((s.state || '') + ' ' + (s.zip || '')).trim();
  return [s.streetAddress, s.city, tail].filter(Boolean).join(', ');
}

function queryTokens(q) {
  const toks = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const house = toks.length && /^\d+$/.test(toks[0]) ? toks[0] : '';
  const streetTok = house && toks.length > 1 ? toks[1] : (house ? '' : (toks[0] || ''));
  return { house, streetTok };
}

function scoreSuggestion(s, qt) {
  let score = 0;
  const street = String(s.streetAddress || '').toLowerCase();
  const m = street.match(/^(\d+)\s+(.*)$/);
  if (qt.house && m) {
    if (m[1] === qt.house) score += 100;
    const streetName = (m[2] || '').split(/\s+/)[0] || '';
    if (qt.streetTok && streetName.indexOf(qt.streetTok) === 0) score += 50;
  } else if (qt.streetTok && street.indexOf(qt.streetTok) >= 0) {
    score += 10;
  }
  if (s._biased) score += 25;
  return score;
}

// Merge raw ArcGIS suggestion lists (biased first), dedupe, rank.
// entries: [{ text, isCollection, biased }]
function rankSuggestions(entries, q) {
  const qt = queryTokens(q);
  const seen = new Map();
  for (const e of entries || []) {
    if (!e || e.isCollection || !e.text) continue;
    const parsed = parseSuggestionText(e.text);
    // Only real street addresses (house number first) are selectable
    // comp targets — street-only / city-only suggestions are noise here.
    if (!/^\d+\s+/.test(parsed.streetAddress)) continue;
    parsed.label = buildLabel(parsed);
    const key = parsed.label.toLowerCase();
    if (seen.has(key)) {
      if (e.biased) seen.get(key)._biased = true;
      continue;
    }
    parsed._biased = !!e.biased;
    seen.set(key, parsed);
  }
  const list = Array.from(seen.values());
  list.sort((a, b) => scoreSuggestion(b, qt) - scoreSuggestion(a, qt)); // Array.sort is stable
  return list.slice(0, MAX_SUGGESTIONS).map((s) => ({
    label: s.label,
    streetAddress: s.streetAddress,
    city: s.city,
    state: s.state,
    zip: s.zip,
  }));
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  const q = ((event.queryStringParameters && event.queryStringParameters.q) || '').trim();
  if (q.length < 3) return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions: [] }) };

  const cacheKey = q.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions: hit.suggestions }) };
  }

  try {
    const calls = [null].concat(MARKETS).map((market) =>
      fetchJsonImpl(buildSuggestUrl(q, market))
        .then((json) => (json && json.suggestions || []).map((s) => ({ text: s.text, isCollection: !!s.isCollection, biased: !!market })))
        .catch(() => [])
    );
    const lists = await Promise.all(calls);
    // Biased lists first so equal scores keep the local hit ahead.
    const entries = [];
    for (let i = 1; i < lists.length; i++) entries.push.apply(entries, lists[i]);
    entries.push.apply(entries, lists[0]);
    const suggestions = rankSuggestions(entries, q);
    if (cache.size > 200) cache.clear();
    cache.set(cacheKey, { at: Date.now(), suggestions });
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions }) };
  } catch (err) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ suggestions: [] }) };
  }
};

exports._test = {
  parseSuggestionText,
  buildLabel,
  rankSuggestions,
  buildSuggestUrl,
  MARKETS,
  setFetchJson: (fn) => { fetchJsonImpl = fn || defaultFetchJson; },
};

// netlify/functions/dashboard-ai.js
// Dashboard AI assistant for Troy's Acquisition Command Center.
// Same pattern as the SMS bot (custom-bot/src/llm.js): OpenAI-compatible
// chat completions via a Netlify function, pennies per chat. The API key
// lives ONLY in Netlify env vars (DASHBOARD_AI_API_KEY, falling back to
// LLM_API_KEY) — never in browser code.
//
// Dashboard calls: POST /.netlify/functions/dashboard-ai
//   { messages: [{ role: "user"|"assistant", content: "..." }] }
// Responds: { reply: "..." }  or  { error: "..." }
//
// data provider comps wiring (Troy approved Nov 2, 2026 — replaces DealMachine):
//   The model gets a get_comps tool. When Troy asks for ARV/comps/offer
//   numbers on a specific address, the function calls data provider's API
//   (https://api.propertyreach.com/v1) with PROPERTYREACH_API_KEY:
//   GET /v1/property (1 credit) to resolve the property, then
//   POST /v1/comparables (1 credit) for comparable sales.
//   Real cost: ~2 API credits per address lookup ($0.02 nominal at $30/100
//   credits, inside the 100/mo included). Guarded by MAX_TOOL_ITERATIONS
//   per request so one chat message can never burn more than 4 credits.
//   The API returns HTTP 200 with the real status in meta.status — always
//   read the body. Comp targets tried in order: propertyId, apn, address.
//   (Target/filter are SIBLINGS in the POST body — nesting target inside
//   filter was our Nov 2 bug.)
//
// Troy's approval gate (Oct 29, 2026): this function ships ONLY after his
// explicit review. No deploy until he says go.
'use strict';

const DEFAULT_MODEL = 'gpt-4.1';
const TIMEOUT_MS = 25000;
const PR_TIMEOUT_MS = 20000;
const MAX_TOKENS = 900;          // keeps replies tight and cheap
const MAX_MESSAGES = 40;         // history cap per request
const MAX_INPUT_CHARS = 4000;    // per-message cap
const MAX_TOOL_ITERATIONS = 2;   // max get_comps calls per chat request (≤4 credits)
const COMPS_LIMIT = 10;

// NOTE (Nov 5): real data-provider API hostname. The Nov 4 white-label
// scrub replaced it with api.data-api.com (nonexistent) and broke every
// server-side lookup. White-labeling covers USER-VISIBLE text only.
const PR_API_BASE = 'https://api.propertyreach.com/v1';

function money(n) {
  if (n == null || isNaN(Number(n))) return '?';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

// Canonical MAO/LAO math, in code, so the prompt's worked examples are exact.
function tierFor(arv) {
  if (arv < 120000) return 0.70;
  if (arv < 220000) return 0.80;
  if (arv < 300000) return 0.815;
  if (arv < 400000) return 0.829;
  return 0.849;
}
// MAO calibration: when a calibration object is supplied (see loadCalibration),
// the effective multiplier is min(calibrated, tier) — calibration can only LOWER
// MAO, never raise it. No calibration = tier only, exactly as before.
// market: the deal's market label (e.g. 'Indianapolis') or null when unknown.
// Calibration is PER-MARKET: it applies ONLY when the deal's market is known
// AND equals the calibration file's market (calibration.market, default
// 'Indianapolis'). Unknown market or a different market -> tier only.
// NOTE: the chat handler never calls offerMath — the model does the math from
// the system prompt, whose market instruction ("If a deal is outside the
// calibrated market, say the market is not calibrated and use the tier") is
// the AI-path guard. This param exists for the offline check and any future
// server-side use; the get_comps tool result carries city/state, but no code
// path computes MAO/LAO from it.
// Round-half-even, matching the pricing engine (pricing_core._round_money).
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

function offerMath(arv, repairs, calibration, market) {
  const tier = tierFor(arv);
  let multiplier = tier, source = 'tier default';
  if (calibration && calibration.calibrated && calibration.multiplierMedian) {
    const calMarket = String(calibration.market || 'Indianapolis').toLowerCase().trim();
    const dealMarket = market == null ? null : String(market).toLowerCase().trim();
    if (dealMarket && dealMarket === calMarket) {
      // UNIFIED Nov 13, 2026 with the auto-pricing engine (pricing_core.py
      // INDY_CALIBRATION, validated 214/216 vs the Nov 10 CRM-written
      // numbers): when the calibration carries appliedCalibration
      // { band_120_220, overall }, those engine constants rule (band
      // constant in $120k-$220k, overall elsewhere) — NOT the per-band
      // medians, which diverged from the CRM by up to ~$40K. Objects
      // without appliedCalibration keep the legacy median selection.
      const applied = calibration.appliedCalibration;
      let cal, calSource = 'calibrated';
      if (applied && typeof applied.band_120_220 === 'number' && typeof applied.overall === 'number') {
        cal = (arv >= 120000 && arv < 220000) ? applied.band_120_220 : applied.overall;
        calSource = 'calibrated (engine)';
      } else {
        const band = arv < 120000 ? 'under $120k' : arv < 220000 ? '$120k-$220k' : arv < 300000 ? '$220k-$300k' : arv < 400000 ? '$300k-$400k' : '$400k+';
        const entry = (calibration.byPriceBand || {})[band];
        cal = entry && entry.n >= 8 ? entry.median : calibration.multiplierMedian;
      }
      if (cal < tier) { multiplier = cal; source = calSource; }
    }
  }
  const mao = roundHalfEven((arv - repairs) * multiplier);
  const lao = roundHalfEven(mao * 0.70);
  return { tier, multiplier, source, mao, lao };
}

const SYSTEM_PROMPT = `You are the AI assistant inside Troy's Acquisition Command Center dashboard. Troy is a real estate wholesaler running the FreeWholesaling playbook. You help him with three jobs: answer deal questions, run offer math, and draft texts. You are direct, plain-spoken, and you never pad.

CANONICAL OFFER MATH (use exactly — the old 70%-of-ARV rule is dead):
MAO = (ARV − repairs) × tier multiplier, tier set by ARV:
- ARV under $120,000 → 70%
- ARV $120,000–$220,000 → 80%
- ARV $220,000–$300,000 → 81.5%
- ARV $300,000–$400,000 → 82.9%
- ARV $400,000+ → 84.9%
MAO is the CEILING (the buyer's price, never exceeded). LAO = MAO × 70% — the opening offer.
Worked example: ARV $290,000, repairs $40,000 → tier 81.5% → MAO = (290,000 − 40,000) × 0.815 = $203,750 → LAO = 203,750 × 0.70 = $142,625.
When you run numbers, ALWAYS show the formula line exactly like that so Troy can check your arithmetic.

HARD RULES:
1. NEVER invent an ARV. If Troy gives you an ARV, use his. If the get_comps tool returns verified comps, average the best ones that pass the similarity rules and say which ones. If you have neither, say so plainly and refuse to quote MAO/LAO — offer to run the numbers once he gives you an ARV or an address to pull comps for.
2. NEVER quote MAO/LAO from a thin or unverified comp set without labeling it "screen only, NOT airtight."
3. AVMs and automated estimates are a fast screen only — never an ARV.
4. Listed with a realtor = PASS immediately. No offer, no chase, no math. (You cannot check listing status — remind Troy to confirm it by hand.)
5. Present MAO/LAO as light / medium / heavy repair scenarios when repairs are unknown: Light $20K, Medium $40K, Heavy $70K.
6. Keep replies short. Lead with the number or the answer, then one line of reasoning at most.
7. Drafted texts follow Troy's SMS rules: no opt-out sentence in the body (footer handles it), no spam-trigger phrasing, plain and short, at most two sentences.
8. You never cancel bookings, never contact sellers yourself, never spend money. The ONLY credit spend allowed is the get_comps tool: ~2 data provider API credits per address lookup (Troy-approved Nov 2, 2026) — one lookup per address unless he asks for more.
9. Timezones: Kansas City sellers are Central; Indianapolis, Cleveland, Carolina, Florida are Eastern. Never show a conversion parenthetical.
10. COMP RULES for get_comps results: you need 3+ SOLD comps passing similarity (sqft ±20%, beds ±1, ≤12 months, ≤2 miles) before quoting MAO/LAO. Fewer than 3 = ARV screen-only, no offer numbers, say plainly the set is thin. Name the comps you used and one line each on why. Active listings are never comps — ignore them for ARV math.
11. ARV MATH IS DONE FOR YOU: the tool result includes a CODE-AVERAGE line with the exact average of the top-3 comps. Quote that figure as the ARV when you use those 3 comps — never recompute it yourself. If you swap in a different comp, show your arithmetic exactly like the CODE-AVERAGE line.
12. If a get_comps tool result contains a DIAGNOSTIC block, reproduce it EXACTLY in your reply (verbatim, no paraphrasing) so the failure can be fixed — then give Troy the plain-English one-liner too.
13. BUYER MATCHING: you have a match_buyers tool (23,837 buyers with phones, costs nothing). Call it when Troy asks "who are my buyers for this deal", "match buyers", "find buyers for [address]", or wants a buyer list for a blast. Pass the property address (or city/state/zip) and the deal price (MAO) when you have it. Present the top matches with name, score, strategy, avg buy, and phone. Never invent buyers — only report what the tool returns. If the tool finds none, say so plainly.`;

// ---- MAO calibration (cash-sales calibrated multiplier) ----
// The calibration run writes assets/mao-calibration.json; at deploy time the same
// file is copied into netlify/functions/mao-calibration.json so this function can
// read it. No file = tier only, and the prompt says so plainly.
let _calibrationCache = undefined;
function loadCalibration() {
  if (_calibrationCache !== undefined) return _calibrationCache;
  try {
    const fs = require('fs');
    const path = require('path');
    _calibrationCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'mao-calibration.json'), 'utf8'));
    if (!_calibrationCache.calibrated) _calibrationCache = null;
  } catch (e) { _calibrationCache = null; }
  return _calibrationCache;
}
function systemPromptWithCalibration() {
  const cal = loadCalibration();
  if (!cal) return SYSTEM_PROMPT;
  // UNIFIED Nov 13, 2026 with the pricing engine (pricing_core.py
  // INDY_CALIBRATION): when the calibration carries appliedCalibration,
  // the model gets the ENGINE rule — the as-applied constants — not the
  // per-band medians, which diverged from the CRM by up to ~$40K.
  const applied = cal.appliedCalibration;
  if (applied && typeof applied.band_120_220 === 'number' && typeof applied.overall === 'number') {
    return SYSTEM_PROMPT + `

CALIBRATED MULTIPLIER — ${cal.market || 'market'} (as applied by the pricing engine, validated against the CRM-written numbers):
For ${cal.market || 'this market'} deals the calibrated multiplier is ${(applied.band_120_220 * 100).toFixed(2)}% when the ARV is $120,000–$220,000, and ${(applied.overall * 100).toFixed(1)}% at every other ARV.
RULE: the effective multiplier is min(calibrated, tier) — calibration can only LOWER MAO, never raise it. When the calibrated number is lower than the tier, use it and say so (e.g. "71.4% calibrated, tier was 81.5%"). When it is higher, use the tier. If a deal is outside the calibrated market, say the market is not calibrated and use the tier. Round MAO to the nearest dollar, then LAO = MAO × 70% rounded to the nearest dollar.`;
  }
  const bands = Object.entries(cal.byPriceBand || {})
    .map(([b, v]) => `${b}: ${(v.median * 100).toFixed(1)}% (n=${v.n})`).join(', ');
  return SYSTEM_PROMPT + `

CALIBRATED MULTIPLIER — ${cal.market || 'market'} (cash-sales calibration, ${cal.generatedAt ? cal.generatedAt.slice(0, 10) : 'undated'}):
${cal.investorCount} genuine investor purchases out of ${cal.totalRows} cash sales; overall median ${(cal.multiplierMedian * 100).toFixed(1)}% of AVM.
By price band: ${bands || 'n/a'}.
RULE: the effective multiplier is min(calibrated, tier) — calibration can only LOWER MAO, never raise it. When the calibrated number is lower than the tier, use it and say so (e.g. "72.9% calibrated, tier was 81.5%"). When it is higher, use the tier. If a deal is outside the calibrated market, say the market is not calibrated and use the tier.`;
}

// ---- data provider client (get_comps tool backend) ----

// US state abbreviations. The old state+ZIP regex grabbed the last two
// letters of the city name as a "state" ("Indianapolis 46237" -> state
// "IS", street "4405 E edgewood ave Indianapol"), which made the upstream
// property lookup return no match. Only accept the token as a state when
// it is a real US state abbreviation; otherwise fall back to ZIP-only.
const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']);

function parseAddress(full) {
  const out = { street: '', city: '', state: '', zip: '' };
  if (!full) return out;
  let head = String(full).trim();
  const sz = head.match(/(?:^|,|\s)([A-Za-z]{2})\s*,?\s*(\d{5})(?:-\d{4})?\s*$/);
  if (sz && US_STATES.has(sz[1].toUpperCase())) {
    out.state = sz[1].toUpperCase();
    out.zip = sz[2];
    head = head.slice(0, sz.index).replace(/,\s*$/, '').trim();
  } else {
    const z = head.match(/\s+(\d{5})(?:-\d{4})?\s*$/);
    if (z) {
      out.zip = z[1];
      head = head.slice(0, z.index).replace(/,\s*$/, '').trim();
    }
  }
  const parts = head.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.city = parts[parts.length - 1];
    out.street = parts.slice(0, -1).join(', ');
    return out;
  }
  const SUF = ['ave', 'avenue', 'st', 'street', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'blvd', 'boulevard', 'ct', 'court', 'way', 'pl', 'place', 'ter', 'terrace', 'cir', 'circle', 'hwy', 'highway', 'pkwy', 'parkway', 'aly', 'alley', 'trl', 'trail', 'sq', 'square', 'xing', 'crossing', 'pt', 'point', 'cove', 'cv', 'row', 'run', 'walk', 'path', 'ext'];
  const words = head.split(/\s+/);
  for (let i = 1; i < words.length - 1; i++) {
    if (SUF.includes(words[i].toLowerCase().replace(/\.$/, ''))) {
      out.street = words.slice(0, i + 1).join(' ');
      out.city = words.slice(i + 1).join(' ');
      return out;
    }
  }
  out.street = head;
  return out;
}

function isoDaysAgo(n) {
  const t = new Date();
  t.setDate(t.getDate() - n);
  return t.toISOString().slice(0, 10);
}

async function prFetchJson(url, { apiKey, method, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PR_TIMEOUT_MS);
  try {
    const headers = { 'x-api-key': apiKey, Accept: 'application/json' };
    const opts = { method: method || 'GET', signal: controller.signal, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* leave null */ }
    return { http: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// The API returns HTTP 200 with the real status inside meta.status —
// a dead/quota-exceeded key shows up as meta.status 403 in the body.
function prBodyOk(r) {
  if (!r || !r.json || !r.json.meta) return false;
  const s = Number(r.json.meta.status);
  return s >= 200 && s < 300;
}

function tryParseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

// Normalize a data provider comp row to the shape the summary builder expects.
function normalizePrComp(r) {
  if (!r || typeof r !== 'object') return null;
  const street = pick(r, ['streetAddress', 'address', 'street']);
  const amount = pick(r, ['lastSaleAmount', 'sale_price', 'price', 'sold_price', 'amount']);
  if (!street || amount == null) return null;
  const city = pick(r, ['city']);
  const state = pick(r, ['state']);
  const zip = pick(r, ['zip']);
  const address = [street, city, state, zip].filter((x) => x).join(', ');
  return {
    address,
    city: city || null,
    state: state || null,
    zip: zip || null,
    price: Number(amount),
    date: pick(r, ['lastSaleDate', 'sale_date', 'sold_date', 'date'])
      ? String(pick(r, ['lastSaleDate', 'sale_date', 'sold_date', 'date'])).slice(0, 10)
      : null,
    status: pick(r, ['listingStatus', 'status']),
    distance_mi: null, // PR rows carry no per-row distance; all passed the radius filter
    beds: pick(r, ['bedrooms', 'beds']),
    baths: pick(r, ['bathrooms', 'baths']),
    sqft: pick(r, ['squareFeet', 'sqft', 'livingSquareFeet']),
    dom: pick(r, ['daysOnMarket', 'dom']),
    match: null,
    photo: pick(r, ['photoUrl', 'photo_url', 'image_url']),
    apn: pick(r, ['apn', 'parcelNumber']),
  };
}

async function prCompsLookup({ prApiKey, address, apn }) {
  const parts = parseAddress(address);
  if (!parts.street) {
    return { ok: false, credits: 0, summary: `No comps available for "${address}" — I can't quote ARV, MAO, or LAO. DIAGNOSTIC (show Troy verbatim): could not parse a street address from "${address}".` };
  }

  // Step 1: resolve the property record (1 credit).
  const propQs = new URLSearchParams({
    streetAddress: parts.street,
    city: parts.city,
    state: parts.state,
    zip: parts.zip,
  }).toString();
  const propRes = await prFetchJson(`${PR_API_BASE}/property?${propQs}`, { apiKey: prApiKey });
  if (!prBodyOk(propRes)) {
    const meta = propRes.json && propRes.json.meta;
    console.error('[dashboard-ai] PR property lookup failed for "' + address + '" — ' + JSON.stringify(meta || { http: propRes.http }));
    return { ok: false, credits: 0, summary: `No comps available for "${address}" — I can't quote ARV, MAO, or LAO. DIAGNOSTIC (show Troy verbatim): property lookup failed. meta.status: ${meta ? meta.status : 'n/a'}, message: ${meta ? (meta.message || '') : 'fetch failed'}.` };
  }
  const rawProp = (propRes.json && propRes.json.property) || {};
  const subjectApn = apn || rawProp.apn || '';
  const subjectBits = [
    [rawProp.streetAddress, rawProp.city, rawProp.state, rawProp.zip].filter(Boolean).join(', ') || address,
    rawProp.bedrooms ? `${rawProp.bedrooms}bd` : null,
    rawProp.bathrooms ? `${rawProp.bathrooms}ba` : null,
    rawProp.squareFeet ? `${Number(rawProp.squareFeet).toLocaleString()} sqft` : null,
    rawProp.yearBuilt ? `built ${rawProp.yearBuilt}` : null,
    subjectApn ? `APN ${subjectApn}` : null,
  ].filter(Boolean).join(' · ');

  // Step 2: pull comparables (1 credit). Try propertyId, then APN, then address.
  // target and filter are SIBLINGS — never nest target inside filter.
  const compTargets = [];
  if (rawProp.id) compTargets.push({ propertyId: rawProp.id });
  if (subjectApn) compTargets.push({ apn: subjectApn });
  const addrTarget = {
    streetAddress: parts.street,
    city: parts.city,
    state: parts.state,
    zip: parts.zip,
  };
  if (rawProp.county) addrTarget.county = rawProp.county;
  if (rawProp.fips) addrTarget.fips = rawProp.fips;
  compTargets.push(addrTarget);

  let compRes = null;
  let lastMeta = null;
  for (const target of compTargets) {
    compRes = await prFetchJson(`${PR_API_BASE}/comparables`, {
      apiKey: prApiKey,
      method: 'POST',
      body: {
        target,
        filter: {
          distanceFromSubject: 2,
          lastSaleDateMin: isoDaysAgo(365),
          propertyClassCode: ['R'],
        },
      },
    });
    if (prBodyOk(compRes)) break;
    lastMeta = compRes.json && compRes.json.meta;
    compRes = null;
  }
  if (!compRes) {
    console.error('[dashboard-ai] PR comparables failed for "' + address + '" — ' + JSON.stringify(lastMeta || {}));
    return { ok: false, credits: 1, summary: `No comps available for "${address}" — I can't quote ARV, MAO, or LAO. DIAGNOSTIC (show Troy verbatim): comparables lookup failed on all target forms. meta: ${JSON.stringify(lastMeta || {}).slice(0, 300)}` };
  }

  const rows = ((compRes.json && compRes.json.properties) || [])
    .map(normalizePrComp)
    .filter(Boolean)
    .filter((c) => c.price >= 5000); // drop nominal transfers

  const lines = rows.map((c, i) => {
    const bits = [
      `${i + 1}. ${c.address}`,
      `Sold ${money(c.price)}${c.date ? ` on ${c.date}` : ''}`,
      'within 2 mi',
      [c.beds != null ? `${c.beds}bd` : null, c.baths != null ? `${c.baths}ba` : null].filter(Boolean).join('/'),
      c.sqft ? `${Number(c.sqft).toLocaleString()} sqft` : null,
      c.dom != null ? `${c.dom} DOM` : null,
      c.apn ? `APN ${c.apn}` : null,
    ].filter(Boolean).join(' — ');
    return bits;
  });

  // CODE-COMPUTED average of the top-3: the model quotes this figure,
  // never recomputes it. (The model botched the arithmetic twice on 2026-10-30.)
  const priced = rows.filter((c) => Number.isFinite(c.price));
  const top3 = priced.slice(0, 3);
  const codeAvg = top3.length === 3
    ? Math.round((top3[0].price + top3[1].price + top3[2].price) / 3)
    : null;

  const summary = [
    `COMPS for "${address}" (data provider live pull, 2 credits used):`,
    subjectBits ? `Subject: ${subjectBits}` : null,
    rows.length ? `${rows.length} sold comps (12mo, ≤2mi):` : 'No sold comps returned — the feed, not the property, may be thin.',
    ...lines,
    '',
    codeAvg != null
      ? `CODE-AVERAGE of top-3: (${money(top3[0].price)} + ${money(top3[1].price)} + ${money(top3[2].price)}) / 3 = ${money(codeAvg)}. When quoting ARV from these exact 3 comps, use ${money(codeAvg)} — do NOT recompute. If you swap any comp, show your full arithmetic like this line.`
      : null,
    '',
    'Apply Troy\u2019s comp rules: need 3+ SOLD comps passing similarity (sqft ±20%, beds ±1, ≤12mo, ≤2mi) before quoting MAO/LAO. Fewer than 3 = ARV screen-only, no offer numbers, say the set is thin. Note: data provider rows carry no per-row distance — all passed the 2-mile filter.',
  ].filter((l) => l !== null).join('\n');

  return { ok: true, credits: 2, count: rows.length, summary };
}

// ---- LLM chat with function calling ----

const COMPS_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'get_comps',
    description: 'Pull live comparable sales for a property address from data provider. Costs ~2 API credits per lookup (1 for the property record, 1 for comps). Call it when Troy asks for ARV, comps, or offer numbers on a specific property address and you do not already have verified comps for it in this conversation. Do NOT call it for general questions, math on numbers he gave you, or text drafts. If Troy provides an APN, pass it for a more precise lookup.',
    parameters: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Full property address, e.g. "303 Elizabeth St, Greenville, NC 27834"',
        },
        apn: {
          type: 'string',
          description: 'Assessor parcel number, e.g. "49-06-29-103-094.000-901". Optional — improves comp matching when known.',
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
};

const MATCH_BUYERS_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'match_buyers',
    description: 'Find the best cash buyers for a deal from Troy\'s national buyer database (23,837 buyers with phones). Call it when Troy asks "who are my buyers for this deal", "match buyers", "find buyers for [address]", or wants to know who to send a deal to. Scores buyers by location match (zip/city/state), price fit vs their avg purchase, portfolio activity, and flipper/landlord strategy. Returns the top 10. Costs nothing — no API credits, local data only.',
    parameters: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Full property address, e.g. "303 Elizabeth St, Greenville, NC 27834". Best when you have it — city/state/zip are parsed from it.',
        },
        city: {
          type: 'string',
          description: 'Property city, e.g. "Greenville". Use when no full address.',
        },
        state: {
          type: 'string',
          description: 'Property state code, e.g. "NC".',
        },
        zip: {
          type: 'string',
          description: 'Property ZIP code, e.g. "27834".',
        },
        price: {
          type: 'number',
          description: 'Deal price (MAO) — matched against each buyer\'s average purchase price.',
        },
        property_type: {
          type: 'string',
          description: '"house" or "land". Land deals prefer buyers with land-investor strategy.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

// ---- Buyer matching (match_buyers tool backend) ----
// Index: buyer-index.json.gz — array of [name, phone, city, state, zip,
// portfolio_count, strategy, avg_price]. Built from master-buyers.js
// (phone-having buyers only). Lazy-loaded and cached; ~529KB gzipped.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- Verified buyer tier (see buyer-verify.js) ----
// Verified buyers get +20 match score so they rank first. Loaded fresh per
// request from the Blobs store — best-effort, never blocks matching.
let _blobs = null;
try { _blobs = require('@netlify/blobs'); } catch (e) { _blobs = null; }
function digits10(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
async function loadVerifiedMap(event) {
  try {
    if (!_blobs) return {};
    if (typeof _blobs.connectLambda === 'function') _blobs.connectLambda(event);
    const s = _blobs.getStore('buyer-verified');
    const v = await s.get('map', { type: 'json' });
    return (v && typeof v === 'object') ? v : {};
  } catch (e) {
    return {};
  }
}
let _buyerIndex = null;
function loadBuyerIndex() {
  if (_buyerIndex) return _buyerIndex;
  const gzPath = path.join(__dirname, 'buyer-index.json.gz');
  const raw = zlib.gunzipSync(fs.readFileSync(gzPath));
  _buyerIndex = JSON.parse(raw.toString('utf8'));
  return _buyerIndex;
}

// Scoring mirrors netlify/functions/buyer-match.js:
// geo (zip 40 / city 34 / state+zip3 24 / state 14) + price (≤30)
// + activity (≤20) + strategy (≤10). Cutoff ≥ 35.
function buyerGeoScore(b, subj) {
  const zip = subj.zip || '';
  const city = (subj.city || '').toLowerCase().trim();
  const state = (subj.state || '').toUpperCase().trim();
  const bz = b[4] || '', bc = (b[2] || '').toLowerCase().trim(), bs = (b[3] || '').toUpperCase().trim();
  if (zip && bz && zip === bz) return 40;
  if (city && bc && (bc === city || bc.includes(city) || city.includes(bc))) return 34;
  if (state && bs && bs === state) {
    if (zip && bz && zip.slice(0, 3) === bz.slice(0, 3)) return 24;
    return 14;
  }
  return 0;
}
function buyerPriceScore(b, price) {
  const ap = b[7] || 0;
  if (!price || !ap) return 12;
  const ratio = price / ap;
  const dist = Math.abs(Math.log2(ratio));
  return Math.max(0, Math.round(30 * (1 - dist / 2)));
}
function buyerActivityScore(b) {
  return Math.min(20, Math.round(6 + (b[5] || 0) * 0.28));
}
function buyerStrategyScore(b) {
  const st = b[6] || '';
  const f = st.includes('Flipper'), l = st.includes('Landlord');
  if (f && l) return 10;
  if (f || l) return 8;
  return 5;
}

function matchBuyersLookup({ address, city, state, zip, price, property_type, verifiedMap = {} }) {
  let subj = { city: city || '', state: state || '', zip: (zip || '').toString().slice(0, 5) };
  if (address) {
    const p = parseAddress(address);
    subj = {
      city: p.city || subj.city,
      state: p.state || subj.state,
      zip: (p.zip || subj.zip).toString().slice(0, 5),
    };
  }
  if (!subj.zip && !subj.city && !subj.state) {
    return { ok: false, summary: 'No location to match against — give me a city/state/ZIP or a full property address.' };
  }
  const index = loadBuyerIndex();
  const isLand = (property_type || '').toLowerCase() === 'land';
  const scored = [];
  for (const b of index) {
    const g = buyerGeoScore(b, subj);
    if (g === 0) continue;
    let score = Math.min(99, g + buyerPriceScore(b, price) + buyerActivityScore(b) + buyerStrategyScore(b));
    // Verified buyers rank first (+20) — they close.
    const verified = !!verifiedMap[digits10(b[1])];
    if (verified) score = Math.min(99, score + 20);
    /* Land deals: boost actual land investors (name contains 'land', not 'landlord').
       b[0]=name, b[6]=strategy. Old code checked strategy for 'land' which matched 'Landlord'. */
    if (isLand) {
      const nm = (b[0] || '').toLowerCase();
      if (nm.includes('land') && !nm.includes('landlord')) score = Math.min(99, score + 10);
    }
    if (score < 35) continue;
    scored.push({ b, score, verified });
  }
  scored.sort((x, y) => y.score - x.score || (y.b[5] || 0) - (x.b[5] || 0));
  const top = scored.slice(0, 10);
  if (!top.length) {
    return { ok: true, count: 0, summary: `No buyers scored 35+ for ${[subj.city, subj.state, subj.zip].filter(Boolean).join(', ')} — the database may be thin there. ${index.length.toLocaleString()} buyers searched.` };
  }
  const lines = top.map(({ b, score, verified }, i) => {
    const strat = b[6] || 'no strategy on file';
    const ap = b[7] ? money(b[7]) : 'n/a';
    const pc = b[5] || 0;
    return `${i + 1}. ${verified ? '✅ ' : ''}${b[0]} — ${b[2]}, ${b[3]} ${b[4]} — score ${score}/99 — ${strat} — avg buy ${ap} — ${pc} props — ${b[1]}`;
  });
  const loc = [subj.city, subj.state, subj.zip].filter(Boolean).join(', ');
  const summary = [
    `BUYER MATCH for ${loc}${price ? ` at ${money(price)}` : ''}${isLand ? ' (land deal)' : ''}:`,
    `${scored.length} buyers scored 35+, top 10:`,
    ...lines,
    '',
    'All have phones on file. Score = location (40/34/24/14) + price fit (≤30) + activity (≤20) + strategy (≤10).',
  ].join('\n');
  return { ok: true, count: scored.length, summary };
}

async function callLlm({ baseUrl, apiKey, model, messages, tools }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: systemPromptWithCalibration() }, ...messages],
        ...(tools ? { tools } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('LLM returned no message');
    return msg;
  } finally {
    clearTimeout(timer);
  }
}

async function runChat({ baseUrl, apiKey, model, prApiKey, messages, verifiedMap = {} }) {
  const convo = messages.slice();
  const tools = [MATCH_BUYERS_TOOL_DEF, ...(prApiKey ? [COMPS_TOOL_DEF] : [])];
  let totalCredits = 0;
  for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
    const msg = await callLlm({
      baseUrl, apiKey, model,
      messages: convo,
      tools,
    });
    const toolCalls = (msg.tool_calls || []).filter(
      (tc) => tc && tc.type === 'function' && tc.function &&
        (tc.function.name === 'get_comps' || tc.function.name === 'match_buyers')
    );
    if (!toolCalls.length) {
      const content = String(msg.content || '').trim();
      if (!content) throw new Error('LLM returned empty content');
      return { reply: content, compsCredits: totalCredits };
    }
    // Execute the tool call(s), feed results back, and let the model continue.
    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const tc of toolCalls.slice(0, MAX_TOOL_ITERATIONS)) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      let toolResult;
      if (tc.function.name === 'match_buyers') {
        try {
          const r = matchBuyersLookup({
            address: String(args.address || '').trim() || null,
            city: String(args.city || '').trim() || null,
            state: String(args.state || '').trim() || null,
            zip: String(args.zip || '').trim() || null,
            price: Number(args.price) || 0,
            property_type: String(args.property_type || '').trim() || null,
            verifiedMap,
          });
          toolResult = r.summary;
        } catch (err) {
          console.error('[dashboard-ai] match_buyers failed:', err.message);
          toolResult = `Buyer match failed: ${String(err.message || err).slice(0, 200)}`;
        }
      } else {
        if (!prApiKey) throw new Error('data provider API key not configured');
        const address = String(args.address || '').trim();
        const apn = String(args.apn || '').trim() || null;
        if (!address) {
          toolResult = 'No address provided — ask Troy for the full property address.';
        } else {
          try {
            const r = await prCompsLookup({ prApiKey, address, apn });
            totalCredits += r.credits || 0;
            toolResult = r.summary;
          } catch (err) {
            console.error('[dashboard-ai] get_comps failed:', err.message);
            toolResult = `No comps available for "${address}" — I can't quote ARV, MAO, or LAO. DIAGNOSTIC (show Troy verbatim): comp pull failed: ${String(err.message || err).slice(0, 400)}`;
          }
        }
      }
      convo.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }
  throw new Error('Too many tool iterations');
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.DASHBOARD_AI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'AI not wired yet',
        setup: 'Add DASHBOARD_AI_API_KEY to this Netlify site\u2019s environment variables (Functions scope), then redeploy. Same OpenAI key pattern as the SMS bot.',
      }),
    };
  }
  const baseUrl = process.env.DASHBOARD_AI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.DASHBOARD_AI_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL;
  const prApiKey = process.env.PROPERTYREACH_API_KEY || null;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Bad JSON body' }) };
  }
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_INPUT_CHARS) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Body needs messages[] ending with a user message' }) };
  }

  try {
    const verifiedMap = await loadVerifiedMap(event);
    const { reply, compsCredits } = await runChat({ baseUrl, apiKey, model, prApiKey, messages, verifiedMap });
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ reply, model, ...(compsCredits ? { comps_credits_used: compsCredits } : {}) }),
    };
  } catch (err) {
    console.error('[dashboard-ai]', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'AI request failed', detail: String(err.message || err).slice(0, 200) }),
    };
  }
};

// Offline checks (no network): node -e "const a=require('./dashboard-ai.js'); console.log(a._test.offerMath(290000,40000))"
exports._test = {
  tierFor, offerMath, money, SYSTEM_PROMPT, loadCalibration, systemPromptWithCalibration,
  parseAddress, normalizePrComp, prBodyOk, isoDaysAgo,
  COMPS_TOOL_DEF, MATCH_BUYERS_TOOL_DEF, MAX_TOOL_ITERATIONS,
  matchBuyersLookup, buyerGeoScore, buyerPriceScore, buyerActivityScore, buyerStrategyScore,
};

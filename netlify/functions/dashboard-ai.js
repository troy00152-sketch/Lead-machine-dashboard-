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
// PropertyReach comps wiring (Troy approved Nov 2, 2026 — replaces DealMachine):
//   The model gets a get_comps tool. When Troy asks for ARV/comps/offer
//   numbers on a specific address, the function calls PropertyReach's API
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
function offerMath(arv, repairs) {
  const tier = tierFor(arv);
  const mao = (arv - repairs) * tier;
  const lao = mao * 0.70;
  return { tier, mao: Math.round(mao), lao: Math.round(lao) };
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
8. You never cancel bookings, never contact sellers yourself, never spend money. The ONLY credit spend allowed is the get_comps tool: ~2 PropertyReach API credits per address lookup (Troy-approved Nov 2, 2026) — one lookup per address unless he asks for more.
9. Timezones: Kansas City sellers are Central; Indianapolis, Cleveland, Carolina, Florida are Eastern. Never show a conversion parenthetical.
10. COMP RULES for get_comps results: you need 3+ SOLD comps passing similarity (sqft ±20%, beds ±1, ≤12 months, ≤2 miles) before quoting MAO/LAO. Fewer than 3 = ARV screen-only, no offer numbers, say plainly the set is thin. Name the comps you used and one line each on why. Active listings are never comps — ignore them for ARV math.
11. ARV MATH IS DONE FOR YOU: the tool result includes a CODE-AVERAGE line with the exact average of the top-3 comps. Quote that figure as the ARV when you use those 3 comps — never recompute it yourself. If you swap in a different comp, show your arithmetic exactly like the CODE-AVERAGE line.
12. If a get_comps tool result contains a DIAGNOSTIC block, reproduce it EXACTLY in your reply (verbatim, no paraphrasing) so the failure can be fixed — then give Troy the plain-English one-liner too.`;

// ---- PropertyReach client (get_comps tool backend) ----

function parseAddress(full) {
  const out = { street: '', city: '', state: '', zip: '' };
  if (!full) return out;
  let head = String(full).trim();
  const sz = head.match(/,?\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
  if (sz) {
    out.state = sz[1].toUpperCase();
    out.zip = sz[2];
    head = head.slice(0, sz.index).replace(/,\s*$/, '').trim();
  }
  const parts = head.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.city = parts[parts.length - 1];
    out.street = parts.slice(0, -1).join(', ');
    return out;
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

// Normalize a PropertyReach comp row to the shape the summary builder expects.
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
    `COMPS for "${address}" (PropertyReach live pull, 2 credits used):`,
    subjectBits ? `Subject: ${subjectBits}` : null,
    rows.length ? `${rows.length} sold comps (12mo, ≤2mi):` : 'No sold comps returned — the feed, not the property, may be thin.',
    ...lines,
    '',
    codeAvg != null
      ? `CODE-AVERAGE of top-3: (${money(top3[0].price)} + ${money(top3[1].price)} + ${money(top3[2].price)}) / 3 = ${money(codeAvg)}. When quoting ARV from these exact 3 comps, use ${money(codeAvg)} — do NOT recompute. If you swap any comp, show your full arithmetic like this line.`
      : null,
    '',
    'Apply Troy\u2019s comp rules: need 3+ SOLD comps passing similarity (sqft ±20%, beds ±1, ≤12mo, ≤2mi) before quoting MAO/LAO. Fewer than 3 = ARV screen-only, no offer numbers, say the set is thin. Note: PropertyReach rows carry no per-row distance — all passed the 2-mile filter.',
  ].filter((l) => l !== null).join('\n');

  return { ok: true, credits: 2, count: rows.length, summary };
}

// ---- LLM chat with function calling ----

const COMPS_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'get_comps',
    description: 'Pull live comparable sales for a property address from PropertyReach. Costs ~2 API credits per lookup (1 for the property record, 1 for comps). Call it when Troy asks for ARV, comps, or offer numbers on a specific property address and you do not already have verified comps for it in this conversation. Do NOT call it for general questions, math on numbers he gave you, or text drafts. If Troy provides an APN, pass it for a more precise lookup.',
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
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
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

async function runChat({ baseUrl, apiKey, model, prApiKey, messages }) {
  const convo = messages.slice();
  let totalCredits = 0;
  for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
    const msg = await callLlm({
      baseUrl, apiKey, model,
      messages: convo,
      tools: prApiKey ? [COMPS_TOOL_DEF] : undefined,
    });
    const toolCalls = (msg.tool_calls || []).filter(
      (tc) => tc && tc.type === 'function' && tc.function && tc.function.name === 'get_comps'
    );
    if (!toolCalls.length) {
      const content = String(msg.content || '').trim();
      if (!content) throw new Error('LLM returned empty content');
      return { reply: content, compsCredits: totalCredits };
    }
    if (!prApiKey) throw new Error('PropertyReach API key not configured');
    // Execute the tool call(s), feed results back, and let the model continue.
    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const tc of toolCalls.slice(0, MAX_TOOL_ITERATIONS)) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      const address = String(args.address || '').trim();
      const apn = String(args.apn || '').trim() || null;
      let toolResult;
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
    const { reply, compsCredits } = await runChat({ baseUrl, apiKey, model, prApiKey, messages });
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
  tierFor, offerMath, money, SYSTEM_PROMPT,
  parseAddress, normalizePrComp, prBodyOk, isoDaysAgo,
  COMPS_TOOL_DEF, MAX_TOOL_ITERATIONS,
};

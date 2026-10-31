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
// DealMachine comps wiring (Troy approved Oct 30, 2026):
//   The model gets a get_comps tool. When Troy asks for ARV/comps/offer
//   numbers on a specific address, the function calls DealMachine's MCP
//   server (https://mcp.dealmachine.com/mcp) with the dashboard's existing
//   DEALMACHINE_API_KEY: enrich_address (1 credit) to resolve the property
//   ID, then dealmachine_comps (1 credit) for comparable sales.
//   Real cost: 2 property data credits per address lookup, $0 marginal
//   inside Troy's 20,000-credit pool. Guarded by MAX_TOOL_ITERATIONS per
//   request so one chat message can never burn more than 4 credits.
//
// Troy's approval gate (Oct 29, 2026): this function ships ONLY after his
// explicit review. No deploy until he says go.
'use strict';

const DEFAULT_MODEL = 'gpt-4.1';
const TIMEOUT_MS = 25000;
const MCP_TIMEOUT_MS = 20000;
const MAX_TOKENS = 900;          // keeps replies tight and cheap
const MAX_MESSAGES = 40;         // history cap per request
const MAX_INPUT_CHARS = 4000;    // per-message cap
const MAX_TOOL_ITERATIONS = 2;   // max get_comps calls per chat request (≤4 credits)
const COMPS_LIMIT = 10;

const DM_MCP_URL = 'https://mcp.dealmachine.com/mcp';

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
8. You never cancel bookings, never contact sellers yourself, never spend money. The ONLY credit spend allowed is the get_comps tool: 2 DealMachine credits per address lookup (Troy-approved Oct 30, 2026) — one lookup per address unless he asks for more.
9. Timezones: Kansas City sellers are Central; Indianapolis, Cleveland, Carolina, Florida are Eastern. Never show a conversion parenthetical.
10. COMP RULES for get_comps results: you need 3+ SOLD comps passing similarity (sqft ±20%, beds ±1, ≤12 months, ≤2 miles) before quoting MAO/LAO. Fewer than 3 = ARV screen-only, no offer numbers, say plainly the set is thin. Name the comps you used and one line each on why. Active listings are never comps — ignore them for ARV math.`;

// ---- DealMachine MCP client (get_comps tool backend) ----

function sseJson(text) {
  // MCP over HTTP returns Server-Sent Events; pull the last data: payload.
  let last = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('data: ')) last = line.slice(6).trim();
  }
  if (!last) throw new Error('MCP: empty SSE response');
  return JSON.parse(last);
}

async function mcpPost({ apiKey, sessionId, body, id }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(DM_MCP_URL, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const sid = res.headers.get('mcp-session-id') || sessionId || null;
    if (!res.ok) throw new Error(`MCP ${res.status}: ${text.slice(0, 200)}`);
    // notifications/initialized has no id and returns 202 with empty body.
    if (body.method === 'notifications/initialized') return { sessionId: sid, result: null };
    const data = sseJson(text);
    if (data.error) throw new Error(`MCP ${data.error.code}: ${String(data.error.message || '').slice(0, 200)}`);
    return { sessionId: sid, result: data.result };
  } finally {
    clearTimeout(timer);
  }
}

function mcpText(result) {
  // tools/call returns { content: [{ type: 'text', text: '...' }] }
  const parts = (result && result.content) || [];
  return parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
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

function normalizeComp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const address = pick(raw, ['address', 'full_address', 'street_address', 'property_address']);
  const price = pick(raw, ['sale_price', 'price', 'sold_price', 'list_price']);
  if (!address || price == null) return null;
  return {
    address: String(address),
    city: pick(raw, ['city', 'property_city']),
    state: pick(raw, ['state', 'property_state']),
    zip: pick(raw, ['zip', 'zip_code', 'postal_code']),
    price: Number(price),
    date: pick(raw, ['sale_date', 'sold_date', 'date', 'list_date']),
    status: pick(raw, ['status']),
    distance_mi: pick(raw, ['distance_miles', 'distance', 'distance_mi']),
    beds: pick(raw, ['bedrooms', 'beds']),
    baths: pick(raw, ['bathrooms', 'baths']),
    sqft: pick(raw, ['sqft', 'living_area', 'square_feet', 'building_area']),
    dom: pick(raw, ['dom', 'days_on_market']),
    match: pick(raw, ['match_score', 'match', 'match_percent']),
    photo: pick(raw, ['photo', 'photo_url', 'image_url', 'primary_photo']),
  };
}

function findCompArray(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.some((r) => r && typeof r === 'object' && (r.address || r.full_address) && (r.sale_price != null || r.price != null))
      ? parsed : [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  // Direct keys first, then a recursive hunt for any comp-looking array.
  for (const k of ['comps', 'comparables', 'comparable_sales', 'results', 'data', 'properties']) {
    if (Array.isArray(parsed[k]) && parsed[k].length) {
      const arr = findCompArray(parsed[k]);
      if (arr.length) return arr;
    }
  }
  const seen = new Set();
  const hunt = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && node.some((r) => r && typeof r === 'object' && (r.address || r.full_address))) return node;
      for (const el of node) { const hit = hunt(el); if (hit.length) return hit; }
      return [];
    }
    for (const v of Object.values(node)) { const hit = hunt(v); if (hit.length) return hit; }
    return [];
  };
  return hunt(parsed);
}

// Deep-search a parsed enrich response for the matched property's ID.
// Handles any nesting: {property:{id}}, {properties:[{id}]}, {data:{...}}, etc.
function findPropertyId(parsed) {
  const seen = new Set();
  const idKeys = ['id', 'property_id', 'dealmachine_id', 'propertyId'];
  const addrKeys = ['address', 'full_address', 'street_address'];
  let fallbackId = null;
  const hunt = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const el of node) { const hit = hunt(el); if (hit) return hit; }
      return null;
    }
    const id = pick(node, idKeys);
    const addr = pick(node, addrKeys);
    if (id != null && String(id).trim() !== '') {
      if (addr) return String(id); // id + address = the matched property
      if (fallbackId == null) fallbackId = String(id);
    }
    for (const v of Object.values(node)) { const hit = hunt(v); if (hit) return hit; }
    return null;
  };
  return hunt(parsed) || fallbackId;
}

// Same deep search, but returns the matched property OBJECT (for subject facts).
function findPropertyObj(parsed) {
  const seen = new Set();
  const idKeys = ['id', 'property_id', 'dealmachine_id', 'propertyId'];
  const addrKeys = ['address', 'full_address', 'street_address'];
  const hunt = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const el of node) { const hit = hunt(el); if (hit) return hit; }
      return null;
    }
    const id = pick(node, idKeys);
    const addr = pick(node, addrKeys);
    if (id != null && String(id).trim() !== '' && addr) return node;
    for (const v of Object.values(node)) { const hit = hunt(v); if (hit) return hit; }
    return null;
  };
  return hunt(parsed) || {};
}

function topKeys(parsed, n) {
  if (!parsed || typeof parsed !== 'object') return String(parsed).slice(0, 80);
  return Object.keys(parsed).slice(0, n || 8).join(', ');
}

async function dmCompsLookup({ dmApiKey, address }) {
  // Step 1: MCP handshake.
  let sessionId = null;
  {
    const r = await mcpPost({
      apiKey: dmApiKey,
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'command-center-ai', version: '1.0.0' } },
      },
    });
    sessionId = r.sessionId;
  }
  await mcpPost({ apiKey: dmApiKey, sessionId, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  const callTool = async (name, args, id) => {
    const r = await mcpPost({
      apiKey: dmApiKey, sessionId,
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    });
    if (r.result && r.result.isError) {
      const errText = mcpText(r.result).slice(0, 300);
      throw new Error(`DealMachine ${name} error: ${errText}`);
    }
    return r.result;
  };

  // Step 2: resolve the address to a DealMachine property ID (1 credit).
  const enrichResult = await callTool('dealmachine_enrich_address', {
    full_address: address,
    contact_audience: 'none', // property-only: zero people credits
    confirmed: true,
  }, 2);
  const enrichText = mcpText(enrichResult);
  const enrichParsed = tryParseJson(enrichText);
  const propertyId = findPropertyId(enrichParsed);
  if (!propertyId) {
    console.error('[dashboard-ai] enrich parse miss for "' + address + '" — top keys: ' + topKeys(enrichParsed) + ' — raw: ' + String(enrichText).slice(0, 300));
    return { ok: false, credits: 0, summary: `DealMachine could not match the address "${address}" — no comps available, so I can't quote ARV, MAO, or LAO. (Diagnostic: address lookup returned an unrecognized shape; keys: ${topKeys(enrichParsed)}. No credits spent.)` };
  }
  const enrichObj = findPropertyObj(enrichParsed) || {};
  const subjectBits = [
    pick(enrichObj, ['address', 'full_address']),
    [pick(enrichObj, ['bedrooms', 'beds']), 'bd'].filter(Boolean).join(''),
    [pick(enrichObj, ['bathrooms', 'baths']), 'ba'].filter(Boolean).join(''),
    pick(enrichObj, ['sqft', 'living_area']) ? `${pick(enrichObj, ['sqft', 'living_area'])} sqft` : null,
    pick(enrichObj, ['year_built']) ? `built ${pick(enrichObj, ['year_built'])}` : null,
  ].filter(Boolean).join(' · ');

  // Step 3: pull comps for the property ID (1 credit per subject).
  const compsResult = await callTool('dealmachine_comps', {
    property_ids: [String(propertyId)],
    criteria: {
      timeframe: '12months',
      sort_by: 'match',
      sort_direction: 'desc',
      limit: COMPS_LIMIT,
      include_active_listings: false, // sold only: active listings are never ARV comps
    },
    confirmed: true,
  }, 3);
  const compsParsed = tryParseJson(mcpText(compsResult));
  const rows = findCompArray(compsParsed).map(normalizeComp).filter(Boolean);

  const lines = rows.map((c, i) => {
    const bits = [
      `${i + 1}. ${c.address}${c.city ? `, ${c.city}` : ''}${c.state ? ` ${c.state}` : ''}`,
      `Sold ${money(c.price)}${c.date ? ` on ${c.date}` : ''}`,
      c.distance_mi != null ? `${c.distance_mi} mi` : null,
      [c.beds != null ? `${c.beds}bd` : null, c.baths != null ? `${c.baths}ba` : null].filter(Boolean).join('/'),
      c.sqft ? `${Number(c.sqft).toLocaleString()} sqft` : null,
      c.dom != null ? `${c.dom} DOM` : null,
      c.match != null ? `match ${c.match}%` : null,
    ].filter(Boolean).join(' — ');
    return bits;
  });

  const summary = [
    `COMPS for "${address}" (DealMachine live pull, 2 credits used):`,
    subjectBits ? `Subject: ${subjectBits}` : null,
    rows.length ? `${rows.length} sold comps (12mo, sorted by match):` : 'No sold comps returned — the feed, not the property, may be thin.',
    ...lines,
    '',
    'Apply Troy\u2019s comp rules: need 3+ SOLD comps passing similarity (sqft ±20%, beds ±1, ≤12mo, ≤2mi) before quoting MAO/LAO. Fewer than 3 = ARV screen-only, no offer numbers, say the set is thin.',
  ].filter((l) => l !== null).join('\n');

  return { ok: true, credits: 2, count: rows.length, summary };
}

// ---- LLM chat with function calling ----

const COMPS_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'get_comps',
    description: 'Pull live comparable sales for a property address from DealMachine. Costs 2 DealMachine credits per lookup (1 to match the address, 1 for comps). Call it when Troy asks for ARV, comps, or offer numbers on a specific property address and you do not already have verified comps for it in this conversation. Do NOT call it for general questions, math on numbers he gave you, or text drafts.',
    parameters: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Full property address, e.g. "303 Elizabeth St, Greenville, NC 27834"',
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

async function runChat({ baseUrl, apiKey, model, dmApiKey, messages }) {
  const convo = messages.slice();
  let totalCredits = 0;
  for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
    const msg = await callLlm({
      baseUrl, apiKey, model,
      messages: convo,
      tools: dmApiKey ? [COMPS_TOOL_DEF] : undefined,
    });
    const toolCalls = (msg.tool_calls || []).filter(
      (tc) => tc && tc.type === 'function' && tc.function && tc.function.name === 'get_comps'
    );
    if (!toolCalls.length) {
      const content = String(msg.content || '').trim();
      if (!content) throw new Error('LLM returned empty content');
      return { reply: content, compsCredits: totalCredits };
    }
    if (!dmApiKey) throw new Error('DealMachine API key not configured');
    // Execute the tool call(s), feed results back, and let the model continue.
    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const tc of toolCalls.slice(0, MAX_TOOL_ITERATIONS)) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      const address = String(args.address || '').trim();
      let toolResult;
      if (!address) {
        toolResult = 'No address provided — ask Troy for the full property address.';
      } else {
        try {
          const r = await dmCompsLookup({ dmApiKey, address });
          totalCredits += r.credits || 0;
          toolResult = r.summary;
        } catch (err) {
          console.error('[dashboard-ai] get_comps failed:', err.message);
          toolResult = `Comp pull failed: ${String(err.message || err).slice(0, 200)}. Tell Troy plainly the pull failed and quote no numbers from it.`;
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
  const dmApiKey = process.env.DEALMACHINE_API_KEY || null;

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
    const { reply, compsCredits } = await runChat({ baseUrl, apiKey, model, dmApiKey, messages });
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
  sseJson, normalizeComp, findCompArray, findPropertyId, findPropertyObj, topKeys,
  COMPS_TOOL_DEF, MAX_TOOL_ITERATIONS,
};

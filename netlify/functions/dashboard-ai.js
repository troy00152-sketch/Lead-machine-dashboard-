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
// Troy's approval gate (Oct 29, 2026): this function ships ONLY after his
// explicit review. No deploy until he says go.
'use strict';

const DEFAULT_MODEL = 'gpt-4.1';
const TIMEOUT_MS = 25000;
const MAX_TOKENS = 900;          // keeps replies tight and cheap
const MAX_MESSAGES = 40;         // history cap per request
const MAX_INPUT_CHARS = 4000;    // per-message cap

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
1. NEVER invent an ARV. If Troy gives you an ARV, use his. If he gives you comps, average the best verified ones and say which ones. If you have neither, say so plainly and refuse to quote MAO/LAO — offer to run the numbers once he gives you an ARV or comp prices.
2. NEVER quote MAO/LAO from a thin or unverified comp set without labeling it "screen only, NOT airtight."
3. AVMs and automated estimates are a fast screen only — never an ARV.
4. Listed with a realtor = PASS immediately. No offer, no chase, no math.
5. Present MAO/LAO as light / medium / heavy repair scenarios when repairs are unknown: Light $20K, Medium $40K, Heavy $70K.
6. Keep replies short. Lead with the number or the answer, then one line of reasoning at most.
7. Drafted texts follow Troy's SMS rules: no opt-out sentence in the body (footer handles it), no spam-trigger phrasing, plain and short, at most two sentences.
8. You never cancel bookings, never contact sellers yourself, never spend money or credits. You advise; Troy acts.
9. Timezones: Kansas City sellers are Central; Indianapolis, Cleveland, Carolina, Florida are Eastern. Never show a conversion parenthetical.`;

async function callLlm({ baseUrl, apiKey, model, messages }) {
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
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    if (!content || !String(content).trim()) throw new Error('LLM returned empty content');
    return String(content).trim();
  } finally {
    clearTimeout(timer);
  }
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
    const reply = await callLlm({ baseUrl, apiKey, model, messages });
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ reply, model }) };
  } catch (err) {
    console.error('[dashboard-ai]', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'AI request failed', detail: String(err.message || err).slice(0, 200) }),
    };
  }
};

// Offline math check (no network): node -e "const a=require('./dashboard-ai.js'); console.log(a._test.offerMath(290000,40000))"
exports._test = { tierFor, offerMath, money, SYSTEM_PROMPT };

// coach-suggest.js — Live Call Coach suggestion endpoint (Ginn #4, live coach).
// POST { system, user } -> { suggestions: [up to 3 short spoken replies] }.
// The client (live-call.js) builds the prompt: deal facts + transcript +
// the matched vetted line, with the grounding rules in the system prompt
// (open at LAO, never above MAO, walk away gracefully, silence on opt-out).
// This function is a thin LLM call: same OpenAI key/env pattern as
// dashboard-ai.js (DASHBOARD_AI_API_KEY / LLM_API_KEY), 10s timeout —
// a suggestion that takes longer is useless mid-call. Cost per call is a
// few hundred tokens, fractions of a cent; it draws on the same OpenAI
// balance as the SMS bot. No property data, no credits, no writes.
const DEFAULT_MODEL = 'gpt-4.1';
const TIMEOUT_MS = 10000;
const MAX_TOKENS = 300;

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
      body: JSON.stringify({ error: 'AI not wired yet' }),
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
  const system = String(body.system || '').slice(0, 4000);
  const user = String(body.user || '').slice(0, 4000);
  if (!system || !user) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Body needs system + user strings' }) };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    let suggestions = [];
    try {
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.suggestions)) suggestions = parsed.suggestions;
    } catch (e) {
      // Model ignored the JSON shape — fall back to one suggestion per line.
      suggestions = content.split('\n').map((l) => l.replace(/^[-•\d.)\s]+/, '').trim()).filter(Boolean);
    }
    suggestions = suggestions.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ suggestions, model }),
    };
  } catch (err) {
    console.error('[coach-suggest]', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'AI request failed', detail: String(err.message || err).slice(0, 200) }),
    };
  }
};

// grok-assist.js — Grok (xAI) assist for the Conversations page.
// POST { action, text } -> { status: 'ok', result } for two actions:
//   'summarize' — one-line summary of a seller thread + suggested next move.
//   'draft'     — a follow-up text to the seller, drafted for Troy's review.
//
// DRAFT ONLY BY DESIGN: this function never sends anything anywhere. Its
// only outbound call is the xAI chat completion; the draft comes back to
// the browser and Troy reviews / copies / sends it himself.
//
// The key lives ONLY in the Netlify env var XAI_API_KEY — never in
// browser code, never hardcoded. Billing is prepaid xAI credits: with no
// key the function reports 'not_configured', and when xAI answers with a
// billing error (402 / credit wording) it reports 'no_credit' — the UI
// shows both as one calm dormant state ("Grok isn't funded yet"), never
// a stack trace.
'use strict';

const API_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-4.7';
const TIMEOUT_MS = 25000;
const MAX_TOKENS = 500;
const MAX_TEXT_CHARS = 12000; // a full thread transcript fits; runaway bodies don't

const ACTIONS = {
  summarize: {
    system: [
      'You assist Troy, a real estate wholesaler, inside his Command Center.',
      'You are given a text-message thread between his team ("Us") and a home seller ("Seller").',
      'Reply with EXACTLY two short lines and nothing else:',
      'Line 1: a one-sentence summary of where this conversation stands — what the seller wants, any price or timeline they named, and the last thing that happened.',
      'Line 2: starts with "Next move:" followed by the single best next step for Troy.',
      'Use ONLY facts from the thread. Never invent a price, date, or detail that is not in it.',
    ].join(' '),
    user: (text) => 'Seller conversation thread:\n\n' + text,
  },
  draft: {
    system: [
      'You assist Troy, a real estate wholesaler, inside his Command Center.',
      'You are given a text-message thread between his team ("Us") and a home seller ("Seller").',
      'Draft ONE short follow-up text Troy could send the seller, for his review. He sends it himself — you never send anything.',
      'Rules: plain and short, at most two sentences. No opt-out sentence in the body (a footer handles that). No spam-trigger phrasing.',
      'Use ONLY facts from the thread — never invent a price, an appointment time, or a detail that is not already in it. If the thread names no price, do not quote one.',
      'Reply with the draft text only — no quotes, no label, no explanation.',
    ].join(' '),
    user: (text) => 'Seller conversation thread:\n\n' + text,
  },
};

function buildMessages(action, text) {
  const a = ACTIONS[action];
  return [
    { role: 'system', content: a.system },
    { role: 'user', content: a.user(text) },
  ];
}

// xAI bills from prepaid credits: an unfunded key surfaces as HTTP 402,
// or occasionally a 400/403 whose message names credits/billing/balance.
function isBillingError(httpStatus, bodyText) {
  if (httpStatus === 402) return true;
  if ((httpStatus === 400 || httpStatus === 403) && /credit|billing|balance/i.test(bodyText || '')) return true;
  return false;
}

function json(statusCode, headers, obj) {
  return { statusCode, headers, body: JSON.stringify(obj) };
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
    return json(405, corsHeaders, { status: 'error', error: 'Method Not Allowed' });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return json(503, corsHeaders, {
      status: 'not_configured',
      error: 'Grok is not configured yet',
      setup: 'Add XAI_API_KEY to this Netlify site\u2019s environment variables (Functions scope), then redeploy.',
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, corsHeaders, { status: 'error', error: 'Bad JSON body' });
  }
  const action = String(body.action || '');
  const text = String(body.text || '').slice(0, MAX_TEXT_CHARS);
  if (!ACTIONS[action]) {
    return json(400, corsHeaders, { status: 'error', error: 'Body needs action: "summarize" or "draft"' });
  }
  if (!text.trim()) {
    return json(400, corsHeaders, { status: 'error', error: 'Body needs the conversation text' });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.4,
          max_tokens: MAX_TOKENS,
          messages: buildMessages(action, text),
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      if (isBillingError(res.status, raw)) {
        return json(402, corsHeaders, {
          status: 'no_credit',
          error: 'Grok has no credit yet',
          detail: 'The xAI account balance is empty — add prepaid credits in the xAI console (Billing) and Grok assist wakes up on its own.',
        });
      }
      console.error('[grok-assist] xAI HTTP ' + res.status + ': ' + raw.slice(0, 200));
      return json(502, corsHeaders, { status: 'error', error: 'Grok request failed — try again in a moment.' });
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* handled below */ }
    const content = String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    if (!content) {
      return json(502, corsHeaders, { status: 'error', error: 'Grok came back empty — try again.' });
    }
    return json(200, corsHeaders, { status: 'ok', action, model: MODEL, result: content });
  } catch (err) {
    console.error('[grok-assist]', err.message);
    return json(502, corsHeaders, { status: 'error', error: 'Grok request failed — try again in a moment.' });
  }
};

// Offline checks (no network): node -e "const g=require('./grok-assist.js'); console.log(Object.keys(g._test.ACTIONS))"
exports._test = { ACTIONS, MODEL, API_URL, buildMessages, isBillingError, MAX_TEXT_CHARS };

// grok-assist.js — Grok (xAI) assist for the Conversations page.
// POST { action, text } -> { status: 'ok', result } for two actions:
//   'summarize' — one-line summary of a seller thread + suggested next move.
//   'draft'     — a follow-up text to the seller, drafted for Troy's review.
//
// DRAFT ONLY BY DESIGN: this function never sends anything anywhere. Its
// only outbound calls are the routed model completions (see
// cc-model-router.js); the draft comes back to the browser and Troy
// reviews / copies / sends it himself.
//
// Models come from cc-model-router.js — this file hardcodes no model for
// any job. This box pins engine 'grok', so the direct xAI model answers
// first (funded from the $5 prepaid xAI credits, non-reasoning so it
// answers in seconds) and the routed chain falls back across engines
// after that instead of going dead.
//
// The key lives ONLY in the Netlify env var XAI_API_KEY — never in
// browser code, never hardcoded. With no key the function reports
// 'not_configured', and when every funded provider is out of credit it
// reports 'no_credit' — the UI shows both as one calm dormant state
// ("Grok isn't funded yet"), never a stack trace.
'use strict';

const router = require('./cc-model-router');

const TIMEOUT_MS = 25000;
const MAX_TOKENS = 500;
const MAX_TEXT_CHARS = 12000; // a full thread transcript fits; runaway bodies don't
// Fixed sample for the GET ?selftest=1 verification route (see handler).
const SELFTEST_TEXT = [
  'Us: Hi, are you thinking of selling 123 Main St?',
  'Seller: Yes, I want $80,000 and I can show it this week.',
  'Us: Got it, can we call tomorrow at 2pm?',
  'Seller: Yes, 2pm works.',
].join('\n');

const ACTIONS = {
  summarize: {
    job: 'thread-summarize',
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
    job: 'draft-followup',
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
  // Self-test: GET ?selftest=1 runs a summarize over a fixed sample thread
  // so the wiring can be verified from a plain browser visit — the request
  // still passes the site's sign-in gate. No other GET allowed.
  const isSelftest = event.httpMethod === 'GET'
    && !!(event.queryStringParameters && event.queryStringParameters.selftest === '1');
  if (event.httpMethod !== 'POST' && !isSelftest) {
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

  let action;
  let text;
  if (isSelftest) {
    action = 'summarize';
    text = SELFTEST_TEXT;
  } else {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, corsHeaders, { status: 'error', error: 'Bad JSON body' });
    }
    action = String(body.action || '');
    text = String(body.text || '').slice(0, MAX_TEXT_CHARS);
    if (!ACTIONS[action]) {
      return json(400, corsHeaders, { status: 'error', error: 'Body needs action: "summarize" or "draft"' });
    }
    if (!text.trim()) {
      return json(400, corsHeaders, { status: 'error', error: 'Body needs the conversation text' });
    }
  }

  const result = await router.complete({
    job: ACTIONS[action].job,
    messages: buildMessages(action, text),
    engine: 'grok',
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  if (!result.ok) {
    if (result.status === 'no_credit') {
      return json(402, corsHeaders, {
        status: 'no_credit',
        error: 'Grok has no credit yet',
        detail: 'The xAI account balance is empty — add prepaid credits in the xAI console (Billing) and Grok assist wakes up on its own.',
      });
    }
    if (result.status === 'not_configured') {
      return json(503, corsHeaders, { status: 'not_configured', error: 'Grok is not configured yet' });
    }
    console.error('[grok-assist] router failed: ' + (result.error || 'unknown'));
    return json(502, corsHeaders, { status: 'error', error: 'Grok request failed — try again in a moment.', tried: result.tried, attempts: result.attempts });
  }
  const okBody = {
    status: 'ok', action, model: result.model, provider: result.provider,
    fallback: !!result.fallback, result: result.content,
  };
  if (isSelftest) okBody.selftest = true;
  return json(200, corsHeaders, okBody);
};

// Offline checks (no network): node -e "const g=require('./grok-assist.js'); console.log(Object.keys(g._test.ACTIONS))"
exports._test = { ACTIONS, buildMessages, isBillingError: router.isBillingError, MAX_TEXT_CHARS, SELFTEST_TEXT };

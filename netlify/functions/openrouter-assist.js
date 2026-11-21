// openrouter-assist.js — OpenRouter deep-read assist for the Conversations
// page (third AI engine, beside the Gemini and Grok assists).
// POST { action, text } -> { status: 'ok', result } for two actions:
//   'summarize' — one-line summary of a seller thread + suggested next move.
//   'draft'     — a follow-up text to the seller, drafted for Troy's review.
//
// DRAFT ONLY BY DESIGN: this function never sends anything anywhere. Its
// only outbound call is the OpenRouter chat completion; the draft comes
// back to the browser and Troy reviews / copies / sends it himself. It
// never prices a deal and never touches the live bot function.
//
// The key lives ONLY in the Netlify env var OPENROUTER_API_KEY — never in
// browser code, never hardcoded. Billing is prepaid OpenRouter credits:
// with no key the function reports 'not_configured', and when OpenRouter
// answers with a billing error (402 / credit wording) it reports
// 'no_credit' — the UI shows both as one calm dormant state ("Deep read
// isn't funded yet"), never a stack trace.
//
// SELF-TEST COST GUARD: the GET ?selftest=1 route runs against the free
// router model (openrouter/free) so verifying the wiring never burns
// paid credits. Real page actions use the deep-read model below.
'use strict';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Deep-read default: the strongest careful reader on the account for
// long seller threads and second-eyes work ($2 in / $10 out per M
// tokens at provider list price, billed from prepaid credits).
const MODEL = 'anthropic/claude-sonnet-5.5';
// Free router model — self-test only, so verification costs nothing.
const SELFTEST_MODEL = 'openrouter/free';
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

// OpenRouter bills from prepaid credits: an unfunded key surfaces as
// HTTP 402, or occasionally a 400/403 whose message names credits.
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
  // Self-test: GET ?selftest=1 runs a summarize over a fixed sample thread
  // so the wiring can be verified from a plain browser visit — the request
  // still passes the site's sign-in gate. It runs on the FREE router
  // model so verification never spends paid credits. No other GET allowed.
  const isSelftest = event.httpMethod === 'GET'
    && !!(event.queryStringParameters && event.queryStringParameters.selftest === '1');
  if (event.httpMethod !== 'POST' && !isSelftest) {
    return json(405, corsHeaders, { status: 'error', error: 'Method Not Allowed' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return json(503, corsHeaders, {
      status: 'not_configured',
      error: 'Deep read is not configured yet',
      setup: 'Add OPENROUTER_API_KEY to this Netlify site\u2019s environment variables (Functions scope), then redeploy.',
    });
  }

  let action;
  let text;
  let model = MODEL;
  if (isSelftest) {
    action = 'summarize';
    text = SELFTEST_TEXT;
    model = SELFTEST_MODEL;
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
          model: model,
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
          error: 'Deep read has no credit yet',
          detail: 'The OpenRouter balance is empty — add prepaid credits in OpenRouter (Credits) and deep read wakes up on its own. Free models still work.',
        });
      }
      console.error('[openrouter-assist] OpenRouter HTTP ' + res.status + ': ' + raw.slice(0, 200));
      return json(502, corsHeaders, { status: 'error', error: 'Deep read request failed — try again in a moment.' });
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* handled below */ }
    const content = String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    if (!content) {
      return json(502, corsHeaders, { status: 'error', error: 'Deep read came back empty — try again.' });
    }
    const okBody = { status: 'ok', action, model: model, result: content };
    if (isSelftest) okBody.selftest = true;
    return json(200, corsHeaders, okBody);
  } catch (err) {
    console.error('[openrouter-assist]', err.message);
    return json(502, corsHeaders, { status: 'error', error: 'Deep read request failed — try again in a moment.' });
  }
};

// Offline checks (no network): node -e "const o=require('./openrouter-assist.js'); console.log(Object.keys(o._test.ACTIONS))"
exports._test = { ACTIONS, MODEL, SELFTEST_MODEL, API_URL, buildMessages, isBillingError, MAX_TEXT_CHARS, SELFTEST_TEXT };

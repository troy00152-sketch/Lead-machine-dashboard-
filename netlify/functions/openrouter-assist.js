// openrouter-assist.js — Deep read assist for the Conversations page.
// POST { action, text, deal? } -> { status: 'ok', result } for four actions:
//   'summarize' — one-line summary of a seller thread + suggested next move.
//   'draft'     — a follow-up text to the seller, drafted for Troy's review.
//   'check'     — second-eyes deal sanity-check: FLAGS ONLY. It never
//                 computes or states a price, ARV, MAO or LAO — it only
//                 flags numbers that don't reconcile, missing facts, and
//                 risks, from the deal facts + thread it is given.
//   'loi'       — draft LOI email text for Troy's review, from the deal
//                 facts given. Never invents an address, price or term;
//                 lists the missing facts instead.
//
// DRAFT ONLY BY DESIGN: this function never sends anything anywhere. Its
// only outbound calls are the routed model completions (see
// cc-model-router.js); the draft comes back to the browser and Troy
// reviews / copies / sends it himself. It never prices a deal and never
// touches the live bot function.
//
// Models come from cc-model-router.js — this file hardcodes no model for
// any job. The Deep read box pins engine 'deepread', so the strongest
// reader answers first and the best free model answers while the
// OpenRouter balance is $0 — except the LOI action, which pins engine
// 'gemini': the LOI is Gemini-led by design (see the router's chain for
// 'loi-draft'), with the free candidates as resilience only.
//
// The key lives ONLY in the Netlify env var OPENROUTER_API_KEY — never in
// browser code, never hardcoded. With no key the function reports
// 'not_configured'; when every funded provider is out of credit it
// reports 'no_credit' — the UI shows both as one calm dormant state
// ("Deep read isn't funded yet"), never a stack trace.
//
// SELF-TEST COST GUARD: the GET ?selftest=1 route runs against the free
// router model (openrouter/free) so verifying the wiring never burns
// paid credits. Real page actions use the routed chain. Reasoning is
// capped low and one retry covers a transient empty reply: the free
// router can land on a reasoning model, and a default high/medium
// effort can burn the whole max_tokens budget on internal thinking and
// return an empty or cut-off answer.
'use strict';

const router = require('./cc-model-router');

// Free router model — self-test only, so verification costs nothing.
const SELFTEST_MODEL = 'openrouter/free';
const SELFTEST_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 25000;
const MAX_TEXT_CHARS = 12000; // a full thread transcript fits; runaway bodies don't
const MAX_DEAL_CHARS = 4000;
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
    maxTokens: 500,
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
    maxTokens: 500,
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
  check: {
    job: 'deal-check',
    maxTokens: 600,
    system: [
      'You are a second-eyes deal checker for Troy, a real estate wholesaler.',
      'You are given a seller thread and, when available, the deal facts his own Command Center computed (ARV, MAO, LAO, repairs, comps).',
      'Reply with a SHORT bullet list of FLAGS ONLY — nothing else:',
      '- a number that does not reconcile with the others (say which two disagree and by how much);',
      '- a fact that is missing and needed before Troy can trust the numbers;',
      '- a risk in the thread (seller hedging, a competing offer, a deadline, a condition).',
      'NEVER compute, restate as your own, or state a new price, ARV, MAO, LAO or offer figure. Quote the given figures only to point at a disagreement.',
      'If no deal facts were given, say so in one line and list the facts needed to check the deal — do not invent them.',
      'If nothing is wrong and nothing is missing, reply with exactly: "No flags — the numbers reconcile and nothing is missing."',
    ].join(' '),
    user: (text, deal) => 'Seller conversation thread:\n\n' + text +
      (deal ? '\n\nDeal facts from the Command Center:\n\n' + deal : ''),
  },
  loi: {
    job: 'loi-draft',
    maxTokens: 1500, // a full LOI letter needs room: 800 cut a draft off mid-sentence (Nov 28)
    system: [
      'You draft a letter of intent (LOI) email for Troy, a real estate wholesaler, to send a home seller.',
      'You are given a seller thread and, when available, the deal facts: property address, seller name, offer price and terms.',
      'Draft the LOI email body for Troy\u2019s review. He reviews and sends it himself — you never send anything.',
      'Use ONLY the facts given. Never invent an address, a price, a term, a date, or the seller\u2019s name.',
      'If the property address or the offer price is not in the facts given, do NOT draft the letter — reply with the short list of facts needed, nothing else.',
      'Tone: plain, professional, short. Sign it as Troy Thomas, Direct Property Buyers.',
      'Reply with the LOI text only — no quotes, no label, no explanation.',
    ].join(' '),
    user: (text, deal) => 'Seller conversation thread:\n\n' + text +
      (deal ? '\n\nDeal facts from the Command Center:\n\n' + deal : ''),
  },
};

// Deal facts come from the caller (the Command Center's own numbers).
// Whitelist the fields, cap the size, and render them as plain text —
// the model is never handed a free-form object it could misread.
const DEAL_FIELDS = [
  'address', 'propertyAddress', 'ownerName', 'sellerName', 'phone',
  'arv', 'mao', 'lao', 'repairs', 'offerAmount', 'price', 'terms',
  'city', 'state', 'zip', 'beds', 'baths', 'sqft', 'yearBuilt',
];
function formatDeal(deal) {
  if (!deal || typeof deal !== 'object' || Array.isArray(deal)) return '';
  const lines = [];
  DEAL_FIELDS.forEach((f) => {
    const v = deal[f];
    if (v === undefined || v === null || v === '') return;
    lines.push(f + ': ' + String(v).slice(0, 200));
  });
  if (Array.isArray(deal.comps)) {
    deal.comps.slice(0, 6).forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const bits = ['address', 'price', 'date', 'sqft', 'beds'].map((f) => (c[f] === undefined ? '' : f + ' ' + String(c[f]).slice(0, 80))).filter(Boolean);
      if (bits.length) lines.push('comp ' + (i + 1) + ': ' + bits.join(', '));
    });
  }
  return lines.join('\n').slice(0, MAX_DEAL_CHARS);
}

function buildMessages(action, text, deal) {
  const a = ACTIONS[action];
  return [
    { role: 'system', content: a.system },
    { role: 'user', content: a.user(text, deal) },
  ];
}

// OpenRouter bills from prepaid credits: an unfunded key surfaces as
// HTTP 402, or occasionally a 400/403 whose message names credits.
function isBillingError(httpStatus, bodyText) {
  return router.isBillingError(httpStatus, bodyText);
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

  if (isSelftest) {
    // Fixed sample, free router model, direct call — the self-test
    // proves the key + wiring for $0 and never touches the paid chain.
    // Reasoning is capped low: openrouter/free can land on a reasoning
    // model, and a default high/medium effort can burn the whole
    // max_tokens budget on internal thinking and return an empty or
    // cut-off answer. One retry covers a transient empty reply or a
    // transient upstream error.
    let content = '';
    let failure = null; // { kind: 'http' | 'empty' | 'throw', status? }
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let res;
        try {
          res = await fetch(SELFTEST_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              Authorization: 'Bearer ' + apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: SELFTEST_MODEL,
              temperature: 0.4,
              max_tokens: 500,
              reasoning: { effort: 'low' },
              messages: buildMessages('summarize', SELFTEST_TEXT, ''),
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
          failure = { kind: 'http', status: res.status };
          // Only a transient upstream error (429/5xx) is worth one retry.
          if (!(res.status === 429 || res.status >= 500)) break;
          continue;
        }
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* handled below */ }
        content = String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
        if (!content) failure = { kind: 'empty' };
      } catch (err) {
        console.error('[openrouter-assist]', err.message);
        failure = { kind: 'throw' };
        // A fetch throw (timeout/network) gets one retry.
      }
    }
    if (!content) {
      if (failure && failure.kind === 'empty') {
        return json(502, corsHeaders, { status: 'error', error: 'Deep read came back empty — try again.' });
      }
      return json(502, corsHeaders, { status: 'error', error: 'Deep read request failed — try again in a moment.' });
    }
    return json(200, corsHeaders, { status: 'ok', action: 'summarize', model: SELFTEST_MODEL, result: content, selftest: true });
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
    return json(400, corsHeaders, { status: 'error', error: 'Body needs action: "summarize", "draft", "check" or "loi"' });
  }
  if (!text.trim()) {
    return json(400, corsHeaders, { status: 'error', error: 'Body needs the conversation text' });
  }
  const deal = formatDeal(body.deal);

  const a = ACTIONS[action];
  const result = await router.complete({
    job: a.job,
    messages: buildMessages(action, text, deal),
    // LOI is Gemini-led by design; every other Deep read action pins
    // the Deep Read engine. (Pinning 'deepread' for the LOI routed it
    // Gemma-first — the Nov 28 truncation.)
    engine: action === 'loi' ? 'gemini' : 'deepread',
    maxTokens: a.maxTokens,
    timeoutMs: TIMEOUT_MS,
  });
  if (!result.ok) {
    if (result.status === 'no_credit') {
      return json(402, corsHeaders, {
        status: 'no_credit',
        error: 'Deep read has no credit yet',
        detail: 'No funded provider answered — add prepaid credits in OpenRouter (Credits) and deep read wakes up on its own. Free models still work.',
      });
    }
    if (result.status === 'not_configured') {
      return json(503, corsHeaders, { status: 'not_configured', error: 'Deep read is not configured yet' });
    }
    console.error('[openrouter-assist] router failed: ' + (result.error || 'unknown'));
    return json(502, corsHeaders, { status: 'error', error: 'Deep read request failed — try again in a moment.' });
  }
  return json(200, corsHeaders, {
    status: 'ok', action, model: result.model, provider: result.provider,
    fallback: !!result.fallback, result: result.content,
  });
};

// Offline checks (no network): node -e "const o=require('./openrouter-assist.js'); console.log(Object.keys(o._test.ACTIONS))"
exports._test = { ACTIONS, SELFTEST_MODEL, SELFTEST_URL, buildMessages, isBillingError, formatDeal, MAX_TEXT_CHARS, SELFTEST_TEXT };

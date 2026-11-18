// gemini-assist.js — Gemini (Google) assist for the Conversations page.
// POST { action, text } -> { status: 'ok', result } for two actions:
//   'summarize'  — one-line summary of a seller thread + suggested next move.
//   'draft_reply' — a follow-up text to the seller, drafted for Troy's review.
//
// DRAFT ONLY BY DESIGN: this function never sends anything anywhere. Its
// only outbound call is the Gemini generateContent request; the draft
// comes back to the browser and Troy reviews / copies / sends it himself.
// Any other action (including 'send') is refused with a 400.
//
// The key lives ONLY in the Netlify env var GEMINI_API_KEY — never in
// browser code, never hardcoded. With no key the function reports
// 'not_configured', and when the free tier answers with a quota error
// (429 RESOURCE_EXHAUSTED) it reports 'quota' — the UI shows both as one
// calm dormant state ("Gemini isn't configured yet"), never a stack trace.
'use strict';

const MODEL = 'gemini-3.5-flash';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
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
  draft_reply: {
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

function buildPayload(action, text) {
  const a = ACTIONS[action];
  return {
    system_instruction: { parts: [{ text: a.system }] },
    contents: [{ role: 'user', parts: [{ text: a.user(text) }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: MAX_TOKENS },
  };
}

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && p.text) || '').join('').trim();
}

// The free tier surfaces exhaustion as HTTP 429 (RESOURCE_EXHAUSTED) —
// on this API a 429 is always a quota / rate-limit answer, so it maps
// to the dormant state, not an error dump.
function isQuotaError(httpStatus, bodyText) {
  return httpStatus === 429;
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(503, corsHeaders, {
      status: 'not_configured',
      error: 'AI assist is not configured yet',
      setup: 'Add GEMINI_API_KEY to this Netlify site\u2019s environment variables (Functions scope), then redeploy.',
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
    return json(400, corsHeaders, { status: 'error', error: 'Body needs action: "summarize" or "draft_reply"' });
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
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildPayload(action, text)),
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      if (isQuotaError(res.status, raw)) {
        return json(429, corsHeaders, {
          status: 'quota',
          error: 'AI assist hit its usage limit',
          detail: 'The AI service is rate-limited right now — wait a bit and AI assist wakes up on its own.',
        });
      }
      console.error('[gemini-assist] Gemini HTTP ' + res.status + ': ' + raw.slice(0, 200));
      return json(502, corsHeaders, { status: 'error', error: 'AI assist request failed — try again in a moment.' });
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* handled below */ }
    const content = extractText(data);
    if (!content) {
      return json(502, corsHeaders, { status: 'error', error: 'AI assist came back empty — try again.' });
    }
    return json(200, corsHeaders, { status: 'ok', action, model: MODEL, result: content });
  } catch (err) {
    console.error('[gemini-assist]', err.message);
    return json(502, corsHeaders, { status: 'error', error: 'AI assist request failed — try again in a moment.' });
  }
};

// Offline checks (no network): node -e "const g=require('./gemini-assist.js'); console.log(Object.keys(g._test.ACTIONS))"
exports._test = { ACTIONS, MODEL, API_URL, buildPayload, extractText, isQuotaError, MAX_TEXT_CHARS };

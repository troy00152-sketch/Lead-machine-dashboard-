// grok-assist-regression.js — Grok (xAI) assist wiring, Nov 17 2026,
// routing update Nov 28 2026. Fixture tests for
// netlify/functions/grok-assist.js + the Conversations page control. NO
// live calls: global fetch is stubbed and the only key used is an
// obviously fake TEST value. Run: node grok-assist-regression.js
// (exit non-zero on any failure).
//
// What it proves:
//   1. No key at all (xAI, OpenRouter, Gemini all absent) -> 503
//      { status: 'not_configured' } and fetch is never called (dormant,
//      not an error dump).
//   2. Bad JSON / bad action / empty text -> clean 400s; GET -> 405.
//   3. Zero-balance key: xAI 402 on EVERY candidate ->
//      { status: 'no_credit' } with no stack trace in the body; a 400
//      naming credits maps the same way.
//   4. Funded key: 200 { status: 'ok', result } and the request really
//      went to api.x.ai/v1/chat/completions as Bearer <key>, model
//      grok-4.20-0309-non-reasoning, with the summarize/draft prompts
//      built from the text. Models come from cc-model-router.js; this box
//      pins engine 'grok' first.
//   4c. 402 on the direct xAI model falls through to the best FREE model
//      and still answers 200 (fallback: true).
//   5. Upstream 500 -> clean 502, no stack trace leaked.
//   6. conversations.html carries the Grok assist control: endpoint,
//      both buttons, and the calm "isn't funded yet" dormant copy.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const grok = require('./netlify/functions/grok-assist.js');
const T = grok._test;
// The router keeps a 10-minute unfunded flag per provider in memory;
// a 402 in one section must not make the next section's paid primary
// look dead. Reset between sections that need a clean slate.
const router = require('./netlify/functions/cc-model-router.js');

const realFetch = global.fetch;
const realKeys = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};
function restoreKeys() {
  for (const k of Object.keys(realKeys)) {
    if (realKeys[k] === undefined) delete process.env[k]; else process.env[k] = realKeys[k];
  }
}
let fetchCalls = [];
let fetchImpl = null;
function stubFetch(impl) {
  fetchCalls = [];
  fetchImpl = impl;
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
}
function fakeRes(status, bodyText) {
  return { ok: status >= 200 && status < 300, status, text: async () => bodyText };
}
function post(body) {
  return { httpMethod: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) };
}
function noStack(body) {
  return !/\n\s+at\s/.test(body) && !body.includes('node_modules');
}

(async () => {
  // ---- 1. not configured (no key on ANY provider) ----
  delete process.env.XAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  stubFetch(async () => { throw new Error('fetch must not be called'); });
  let r = await grok.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  let b = JSON.parse(r.body);
  check('no key -> 503', r.statusCode === 503, 'got ' + r.statusCode);
  check('no key -> status not_configured', b.status === 'not_configured');
  check('no key -> fetch never called', fetchCalls.length === 0);
  check('no key -> no stack trace', noStack(r.body));

  // ---- 2. request validation (key set so we reach validation) ----
  process.env.XAI_API_KEY = 'xai-TEST-FAKE-KEY';
  stubFetch(async () => fakeRes(200, '{}'));
  r = await grok.handler({ httpMethod: 'GET', body: '' });
  check('GET -> 405', r.statusCode === 405, 'got ' + r.statusCode);
  r = await grok.handler(post('{not json'));
  check('bad JSON -> 400', r.statusCode === 400 && JSON.parse(r.body).status === 'error');
  r = await grok.handler(post({ action: 'send', text: 'Seller: hi' }));
  check('unknown action -> 400 (draft-only: no send action exists)', r.statusCode === 400);
  r = await grok.handler(post({ action: 'summarize', text: '   ' }));
  check('empty text -> 400', r.statusCode === 400);
  check('validation failures never reach xAI', fetchCalls.length === 0);

  // ---- 3. zero-balance key -> no_credit ----
  stubFetch(async () => fakeRes(402, '{"error":{"message":"Payment required"}}'));
  r = await grok.handler(post({ action: 'summarize', text: 'Seller: asking 90k' }));
  b = JSON.parse(r.body);
  check('xAI 402 -> HTTP 402', r.statusCode === 402, 'got ' + r.statusCode);
  check('xAI 402 -> status no_credit', b.status === 'no_credit');
  check('no_credit body has no stack trace', noStack(r.body));
  stubFetch(async () => fakeRes(400, '{"error":{"message":"Insufficient credits on this team"}}'));
  r = await grok.handler(post({ action: 'draft', text: 'Seller: hello' }));
  check('xAI 400 naming credits -> no_credit', JSON.parse(r.body).status === 'no_credit');
  check('isBillingError: 402 true', T.isBillingError(402, '') === true);
  check('isBillingError: 400 without credit wording false', T.isBillingError(400, 'bad model') === false);
  check('isBillingError: 500 false', T.isBillingError(500, 'credits') === false);

  // ---- 4. funded key -> ok, correct wire shape ----
  router.resetFundingCache();
  stubFetch(async () => fakeRes(200, JSON.stringify({
    choices: [{ message: { content: 'Seller wants $90K, firm.\nNext move: send the LAO and hold.' } }],
  })));
  r = await grok.handler(post({ action: 'summarize', text: 'Seller: asking 90k, firm\nUs: ok' }));
  b = JSON.parse(r.body);
  check('funded -> 200', r.statusCode === 200, 'got ' + r.statusCode);
  check('funded -> status ok + result text', b.status === 'ok' && b.result.includes('Next move:'));
  check('funded -> model reported grok-4.20-0309-non-reasoning', b.model === 'grok-4.20-0309-non-reasoning');
  check('funded -> fallback false (direct Grok answered)', b.fallback === false);
  check('request URL is the xAI chat completions endpoint', fetchCalls[0].url === 'https://api.x.ai/v1/chat/completions', fetchCalls[0].url);
  check('request carries Bearer TEST key', fetchCalls[0].opts.headers.Authorization === 'Bearer xai-TEST-FAKE-KEY');
  const sent = JSON.parse(fetchCalls[0].opts.body);
  check('request model is grok-4.20-0309-non-reasoning', sent.model === 'grok-4.20-0309-non-reasoning');
  check('request messages carry the thread text', sent.messages[1].content.includes('asking 90k, firm'));
  check('summarize prompt demands the Next move line', sent.messages[0].content.includes('Next move:'));
  stubFetch(async () => fakeRes(200, JSON.stringify({ choices: [{ message: { content: 'Hi — just checking in.' } }] })));
  r = await grok.handler(post({ action: 'draft', text: 'Seller: hello' }));
  const draftSent = JSON.parse(fetchCalls[0].opts.body);
  check('draft prompt is review-only (never sends)', /never send/i.test(draftSent.messages[0].content));
  check('draft result returned for review', JSON.parse(r.body).result === 'Hi — just checking in.');

  // ---- 4c. 402 on direct Grok falls through to the best free model ----
  // The free candidates ride the OpenRouter key, so the OR key must be
  // present for this section (fake test value only).
  router.resetFundingCache();
  process.env.OPENROUTER_API_KEY = 'sk-or-TEST-FAKE-KEY';
  stubFetch(async (url, opts) => {
    const m = JSON.parse(opts.body).model;
    if (String(url).includes('api.x.ai')) return fakeRes(402, '{"error":"insufficient credits"}');
    // Both paid models in the chain are unfunded here, so the answer
    // must come from the best free reader — that is the point of the test.
    if (m === 'x-ai/grok-4.20' || m === 'anthropic/claude-sonnet-5.5') return fakeRes(402, '{"error":"insufficient credits"}');
    return fakeRes(200, JSON.stringify({ choices: [{ message: { content: 'Free-model summary.\nNext move: call at 2pm.' } }] }));
  });
  r = await grok.handler(post({ action: 'summarize', text: 'Seller: asking 90k, firm' }));
  b = JSON.parse(r.body);
  check('402 direct Grok -> still 200 via free fallback', r.statusCode === 200 && b.status === 'ok', 'got ' + r.statusCode);
  check('402 direct Grok -> fallback model is the best free reader', b.model === 'google/gemma-4-31b-it:free', b.model);
  check('402 direct Grok -> fallback true', b.fallback === true);
  check('402 direct Grok -> xAI was tried first', fetchCalls[0].url === 'https://api.x.ai/v1/chat/completions');
  delete process.env.OPENROUTER_API_KEY;

  // ---- 4b. self-test route (GET ?selftest=1) ----
  router.resetFundingCache();
  stubFetch(async () => fakeRes(200, JSON.stringify({ choices: [{ message: { content: 'Seller wants $80,000 and agreed to a 2pm call.\nNext move: call at 2pm.' } }] })));
  r = await grok.handler({ httpMethod: 'GET', queryStringParameters: { selftest: '1' }, body: '' });
  b = JSON.parse(r.body);
  check('selftest -> 200 ok + selftest flag', r.statusCode === 200 && b.status === 'ok' && b.selftest === true, 'got ' + r.statusCode);
  check('selftest -> ran the fixed sample thread', JSON.parse(fetchCalls[0].opts.body).messages[1].content.includes('123 Main St'));
  r = await grok.handler({ httpMethod: 'GET', queryStringParameters: {}, body: '' });
  check('plain GET (no selftest) -> 405', r.statusCode === 405, 'got ' + r.statusCode);

  // ---- 5. upstream failure -> clean 502 ----
  router.resetFundingCache();
  stubFetch(async () => fakeRes(500, 'Internal Server Error'));
  r = await grok.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  b = JSON.parse(r.body);
  check('xAI 500 -> 502 clean error', r.statusCode === 502 && b.status === 'error' && noStack(r.body));
  stubFetch(async () => { throw new Error('socket hang up'); });
  r = await grok.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  check('network throw -> 502 clean error', r.statusCode === 502 && noStack(r.body));

  // ---- 6. page wiring ----
  const html = fs.readFileSync(path.join(__dirname, 'conversations.html'), 'utf8');
  check('page points at the grok-assist function', html.includes("/.netlify/functions/grok-assist"));
  check('page has Summarize + Draft buttons', html.includes('data-grok-action="summarize"') && html.includes('data-grok-action="draft"'));
  check('page shows the calm dormant copy', html.includes('assistant service is configured'));
  check('page states drafts-only next to the control', html.includes('nothing sends from here'));
  check('page renders Grok results read-only (no send path)', !/runGrok[\s\S]{0,400}action: 'send'/.test(html));

  // restore environment
  global.fetch = realFetch;
  restoreKeys();

  console.log('\ngrok-assist-regression: ' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  global.fetch = realFetch;
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

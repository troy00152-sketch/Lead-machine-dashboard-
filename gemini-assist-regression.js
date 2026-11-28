// gemini-assist-regression.js — Gemini assist wiring, Nov 17 2026,
// routing update Nov 28 2026. Fixture tests for
// netlify/functions/gemini-assist.js + the Conversations page control.
// NO live calls: global fetch is stubbed and the only key used is an
// obviously fake TEST value. Run: node gemini-assist-regression.js
// (exit non-zero on any failure).
//
// What it proves:
//   1. No GEMINI_API_KEY -> 503 { status: 'not_configured' } and fetch is
//      never called (dormant, not an error dump).
//   2. Bad JSON / bad action / empty text -> clean 400s; GET -> 405.
//      The 'send' action is refused — draft only by design.
//   3. Free-tier quota: Gemini 429 -> { status: 'quota' } with no stack
//      trace in the body.
//   4. Configured key: 200 { status: 'ok', result } and the request really
//      went to generativelanguage.googleapis.com .../gemini-3.5-flash:
//      generateContent with the key in the x-goog-api-key header and the
//      summarize/draft_reply prompts built from the text. Models come from
//      cc-model-router.js; this box pins engine 'gemini' first.
//   4c. Gemini 429 walks on to the best FREE model and still answers 200
//      (fallback: true) instead of going dead on quota.
//   4d. Self-test route (GET ?selftest=1) answers 200 with the sample
//      thread on the Gemini model.
//   4e. Self-test: a 503 on flash is retried once and answers on the
//      retry; and the self-test is strict on ENGINE — a fallback serving
//      another engine (e.g. Gemma while Gemini is down) is a 502 naming
//      the model, never a silent "ok".
//   4f. Google attempts carry a 2048-token maxOutputTokens floor (the
//      raw 500-token budget would starve the visible answer on a
//      reasoning model).
//   5. Upstream 500 -> clean 502, no stack trace leaked; the 502
//      carries per-candidate attempts detail (model + HTTP status)
//      so a live failure can be diagnosed from the response.
//   6. conversations.html carries the Gemini assist control: endpoint,
//      both buttons, and the calm "isn't configured yet" dormant copy.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const gemini = require('./netlify/functions/gemini-assist.js');
const T = gemini._test;
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
function geminiOk(text) {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
}

(async () => {
  // ---- 1. not configured (no key on ANY provider) ----
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.XAI_API_KEY;
  stubFetch(async () => { throw new Error('fetch must not be called'); });
  let r = await gemini.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  let b = JSON.parse(r.body);
  check('no key -> 503', r.statusCode === 503, 'got ' + r.statusCode);
  check('no key -> status not_configured', b.status === 'not_configured');
  check('no key -> fetch never called', fetchCalls.length === 0);
  check('no key -> no stack trace', noStack(r.body));

  // ---- 2. request validation (key set so we reach validation) ----
  process.env.GEMINI_API_KEY = 'gemini-TEST-FAKE-KEY';
  stubFetch(async () => fakeRes(200, '{}'));
  r = await gemini.handler({ httpMethod: 'GET', body: '' });
  check('GET -> 405', r.statusCode === 405, 'got ' + r.statusCode);
  r = await gemini.handler(post('{not json'));
  check('bad JSON -> 400', r.statusCode === 400 && JSON.parse(r.body).status === 'error');
  r = await gemini.handler(post({ action: 'send', text: 'Seller: hi' }));
  check('send action -> 400 (draft-only: no send action exists)', r.statusCode === 400);
  r = await gemini.handler(post({ action: 'summarize', text: '   ' }));
  check('empty text -> 400', r.statusCode === 400);
  check('validation failures never reach Gemini', fetchCalls.length === 0);

  // ---- 3. free-tier quota -> dormant quota status ----
  stubFetch(async () => fakeRes(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}'));
  r = await gemini.handler(post({ action: 'summarize', text: 'Seller: asking 90k' }));
  b = JSON.parse(r.body);
  check('Gemini 429 -> HTTP 429', r.statusCode === 429, 'got ' + r.statusCode);
  check('Gemini 429 -> status quota', b.status === 'quota');
  check('quota body has no stack trace', noStack(r.body));
  check('isQuotaError: 429 true', T.isQuotaError(429, '') === true);
  check('isQuotaError: 500 false', T.isQuotaError(500, 'RESOURCE_EXHAUSTED') === false);

  // ---- 4. configured key -> ok, correct wire shape ----
  router.resetFundingCache();
  stubFetch(async () => fakeRes(200, geminiOk('Seller wants $90K, firm.\nNext move: send the LAO and hold.')));
  r = await gemini.handler(post({ action: 'summarize', text: 'Seller: asking 90k, firm\nUs: ok' }));
  b = JSON.parse(r.body);
  check('configured -> 200', r.statusCode === 200, 'got ' + r.statusCode);
  check('configured -> status ok + result text', b.status === 'ok' && b.result.includes('Next move:'));
  check('configured -> model reported gemini-3.5-flash', b.model === 'gemini-3.5-flash');
  check('configured -> fallback false (Gemini answered first)', b.fallback === false);
  check('request URL is the Gemini generateContent endpoint', fetchCalls[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', fetchCalls[0].url);
  check('request carries the TEST key in x-goog-api-key', fetchCalls[0].opts.headers['x-goog-api-key'] === 'gemini-TEST-FAKE-KEY');
  const sent = JSON.parse(fetchCalls[0].opts.body);
  check('request contents carry the thread text', sent.contents[0].parts[0].text.includes('asking 90k, firm'));
  check('Google attempt uses the 2048-token floor (not the raw 500)', sent.generationConfig.maxOutputTokens === 2048, 'got ' + sent.generationConfig.maxOutputTokens);
  check('summarize prompt demands the Next move line', sent.system_instruction.parts[0].text.includes('Next move:'));
  stubFetch(async () => fakeRes(200, geminiOk('Hi — just checking in.')));
  r = await gemini.handler(post({ action: 'draft_reply', text: 'Seller: hello' }));
  const draftSent = JSON.parse(fetchCalls[0].opts.body);
  check('draft prompt is review-only (never sends)', /never send/i.test(draftSent.system_instruction.parts[0].text));
  check('draft result returned for review', JSON.parse(r.body).result === 'Hi — just checking in.');
  check('extractText joins candidate parts', T.extractText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }) === 'ab');
  check('extractText on junk -> empty', T.extractText({}) === '' && T.extractText(null) === '');

  // ---- 4c. Gemini 429 walks on to the best free model ----
  // The free candidates ride the OpenRouter key, so the OR key must be
  // present for this section (fake test value only).
  router.resetFundingCache();
  process.env.OPENROUTER_API_KEY = 'sk-or-TEST-FAKE-KEY';
  stubFetch(async (url, opts) => {
    if (String(url).includes('generativelanguage')) {
      return fakeRes(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}');
    }
    const m = JSON.parse(opts.body).model;
    // Paid models of other engines never enter a pinned chain, so the
    // answer must come from the best free reader — that is the point of
    // the test. (The 402 branches below are dead code now; kept so the
    // stub still proves the point if the chain changes.)
    if (m === 'anthropic/claude-sonnet-5.5' || m === 'x-ai/grok-4.20') {
      return fakeRes(402, '{"error":"insufficient credits"}');
    }
    return fakeRes(200, JSON.stringify({ choices: [{ message: { content: 'Free-model summary.\nNext move: call at 2pm.' } }] }));
  });
  r = await gemini.handler(post({ action: 'summarize', text: 'Seller: asking 90k, firm' }));
  b = JSON.parse(r.body);
  check('Gemini 429 -> still 200 via free fallback', r.statusCode === 200 && b.status === 'ok', 'got ' + r.statusCode);
  check('Gemini 429 -> fallback model is the best free reader', b.model === 'google/gemma-4-31b-it:free', b.model);
  check('Gemini 429 -> fallback true', b.fallback === true);
  check('Gemini 429 -> Gemini was tried first', fetchCalls[0].url.includes('generativelanguage'));
  check('Gemini 429 -> paid models of other engines were never called', !fetchCalls.some((c) => {
    try { const m = JSON.parse(c.opts.body).model; return m === 'anthropic/claude-sonnet-5.5' || m === 'x-ai/grok-4.20'; } catch (e) { return false; }
  }));
  delete process.env.OPENROUTER_API_KEY;

  // ---- 4d. self-test route (GET ?selftest=1) ----
  router.resetFundingCache();
  stubFetch(async () => fakeRes(200, geminiOk('Seller wants $80,000 and agreed to a 2pm call.\nNext move: call at 2pm.')));
  r = await gemini.handler({ httpMethod: 'GET', queryStringParameters: { selftest: '1' }, body: '' });
  b = JSON.parse(r.body);
  check('selftest -> 200 ok + selftest flag', r.statusCode === 200 && b.status === 'ok' && b.selftest === true, 'got ' + r.statusCode);
  check('selftest -> ran the fixed sample thread', JSON.parse(fetchCalls[0].opts.body).contents[0].parts[0].text.includes('123 Main St'));
  check('selftest -> answered on the Gemini model', b.model === 'gemini-3.5-flash', b.model);
  r = await gemini.handler({ httpMethod: 'GET', queryStringParameters: {}, body: '' });
  check('plain GET (no selftest) -> 405', r.statusCode === 405, 'got ' + r.statusCode);

  // ---- 4e. self-test: a 503 on flash is retried once and answers ----
  router.resetFundingCache();
  let flashCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('generativelanguage')) {
      flashCalls += 1;
      if (flashCalls === 1) return fakeRes(503, '{"error":{"code":503,"status":"UNAVAILABLE","message":"high demand"}}');
      return fakeRes(200, geminiOk('Seller wants $80,000 and agreed to a 2pm call.\nNext move: call at 2pm.'));
    }
    return fakeRes(500, 'boom');
  });
  r = await gemini.handler({ httpMethod: 'GET', queryStringParameters: { selftest: '1' }, body: '' });
  b = JSON.parse(r.body);
  check('selftest 503 -> retried once, still 200 ok', r.statusCode === 200 && b.status === 'ok', 'got ' + r.statusCode);
  check('selftest 503 -> answered on gemini-3.5-flash, not a fallback', b.model === 'gemini-3.5-flash', b.model);
  check('selftest 503 -> flash was called twice (attempt + retry)', flashCalls === 2, 'calls: ' + flashCalls);

  // ---- 4f. self-test is strict on ENGINE: a fallback is a failure ----
  // Gemini down (500 on flash AND lite), Gemma answers. The box must
  // NOT report "ok" with Gemma's model — that is exactly the Nov 28
  // live failure (Claude served as the Gemini self-test).
  router.resetFundingCache();
  process.env.OPENROUTER_API_KEY = 'sk-or-TEST-FAKE-KEY';
  stubFetch(async (url, opts) => {
    if (String(url).includes('generativelanguage')) return fakeRes(500, 'Internal Server Error');
    return fakeRes(200, JSON.stringify({ choices: [{ message: { content: 'Free-model summary.\nNext move: call at 2pm.' } }] }));
  });
  r = await gemini.handler({ httpMethod: 'GET', queryStringParameters: { selftest: '1' }, body: '' });
  b = JSON.parse(r.body);
  check('selftest fallback -> 502, not a silent other-engine ok', r.statusCode === 502, 'got ' + r.statusCode);
  check('selftest fallback -> names the model that answered', (b.error || '').includes('google/gemma-4-31b-it:free'), b.error);
  check('selftest fallback -> body has no stack trace', noStack(r.body));
  check('selftest fallback -> selftest flag set', b.selftest === true);
  delete process.env.OPENROUTER_API_KEY;

  // ---- 5. upstream failure -> clean 502 ----
  router.resetFundingCache();
  stubFetch(async () => fakeRes(500, 'Internal Server Error'));
  r = await gemini.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  b = JSON.parse(r.body);
  check('Gemini 500 -> 502 clean error', r.statusCode === 502 && b.status === 'error' && noStack(r.body));
  check('Gemini 500 -> 502 carries attempts detail (model + HTTP status)', Array.isArray(b.attempts) && b.attempts.length > 0 && b.attempts.every((a) => a.model && a.httpStatus === 500), JSON.stringify(b.attempts));
  check('Gemini 500 -> 502 carries the tried list', Array.isArray(b.tried) && b.tried.length > 0);
  stubFetch(async () => { throw new Error('socket hang up'); });
  r = await gemini.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  check('network throw -> 502 clean error', r.statusCode === 502 && noStack(r.body));

  // ---- 6. page wiring ----
  const html = fs.readFileSync(path.join(__dirname, 'conversations.html'), 'utf8');
  check('page points at the gemini-assist function', html.includes("/.netlify/functions/gemini-assist"));
  check('page has Summarize + Draft buttons', html.includes('data-gemini-action="summarize"') && html.includes('data-gemini-action="draft_reply"'));
  check('page shows the calm dormant copy', html.includes('configured yet — add the API key in the dashboard settings'));
  check('page states drafts-only next to the control', /gemini-box[\s\S]{0,900}nothing sends from here/.test(html));
  check('page renders the Gemini panel in the contact panel', html.includes('geminiSection()'));
  check('page renders Gemini results read-only (no send path)', !/runGemini[\s\S]{0,400}action: 'send'/.test(html));
  check('panel heading is the vendor-neutral AI assist label', html.includes('AI assist</h3>') && !html.includes('Gemini assist</h3>'));
  check('dormant copy names AI assist, not the vendor', html.includes('AI assist isn') && html.includes('configured yet — add the API key in the dashboard settings'));

  // restore environment
  global.fetch = realFetch;
  restoreKeys();

  console.log('\ngemini-assist-regression: ' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  global.fetch = realFetch;
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

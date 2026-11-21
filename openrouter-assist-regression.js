// openrouter-assist-regression.js — OpenRouter deep-read assist wiring,
// Nov 21 2026. Fixture tests for netlify/functions/openrouter-assist.js +
// the Conversations page control. NO live calls: global fetch is stubbed
// and the only key used is an obviously fake TEST value.
// Run: node openrouter-assist-regression.js (exit non-zero on any failure).
//
// What it proves:
//   1. No OPENROUTER_API_KEY -> 503 { status: 'not_configured' } and
//      fetch is never called (dormant, not an error dump).
//   2. Bad JSON / bad action / empty text -> clean 400s; GET -> 405.
//   3. Zero-balance key: OpenRouter 402 -> { status: 'no_credit' } with
//      no stack trace in the body; a 400 naming credits maps the same.
//   4. Funded key: 200 { status: 'ok', result } and the request really
//      went to openrouter.ai/api/v1/chat/completions as Bearer <key>,
//      model anthropic/claude-sonnet-5.5, with the summarize/draft
//      prompts built from the text.
//   5. Self-test route runs the fixed sample on the FREE router model
//      (openrouter/free) so verification never burns paid credits.
//   6. Upstream 500 -> clean 502, no stack trace leaked.
//   7. conversations.html carries the Deep read control: endpoint, both
//      buttons, calm dormant copy, drafts-only note, no send path.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const or = require('./netlify/functions/openrouter-assist.js');
const T = or._test;

const realFetch = global.fetch;
const realKey = process.env.OPENROUTER_API_KEY;
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
  // ---- 1. not configured ----
  delete process.env.OPENROUTER_API_KEY;
  stubFetch(async () => { throw new Error('fetch must not be called'); });
  let r = await or.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  let b = JSON.parse(r.body);
  check('no key -> 503', r.statusCode === 503, 'got ' + r.statusCode);
  check('no key -> status not_configured', b.status === 'not_configured');
  check('no key -> setup names OPENROUTER_API_KEY', (b.setup || '').includes('OPENROUTER_API_KEY'));
  check('no key -> fetch never called', fetchCalls.length === 0);
  check('no key -> no stack trace', noStack(r.body));

  // ---- 2. request validation (key set so we reach validation) ----
  process.env.OPENROUTER_API_KEY = 'sk-or-TEST-FAKE-KEY';
  stubFetch(async () => fakeRes(200, '{}'));
  r = await or.handler({ httpMethod: 'GET', body: '' });
  check('GET -> 405', r.statusCode === 405, 'got ' + r.statusCode);
  r = await or.handler(post('{not json'));
  check('bad JSON -> 400', r.statusCode === 400 && JSON.parse(r.body).status === 'error');
  r = await or.handler(post({ action: 'send', text: 'Seller: hi' }));
  check('unknown action -> 400 (draft-only: no send action exists)', r.statusCode === 400);
  r = await or.handler(post({ action: 'price', text: 'Seller: hi' }));
  check('price action -> 400 (never prices deals)', r.statusCode === 400);
  r = await or.handler(post({ action: 'summarize', text: '   ' }));
  check('empty text -> 400', r.statusCode === 400);
  check('validation failures never reach OpenRouter', fetchCalls.length === 0);

  // ---- 3. zero-balance key -> no_credit ----
  stubFetch(async () => fakeRes(402, '{"error":{"message":"Insufficient credits"}}'));
  r = await or.handler(post({ action: 'summarize', text: 'Seller: asking 90k' }));
  b = JSON.parse(r.body);
  check('OpenRouter 402 -> HTTP 402', r.statusCode === 402, 'got ' + r.statusCode);
  check('OpenRouter 402 -> status no_credit', b.status === 'no_credit');
  check('no_credit body has no stack trace', noStack(r.body));
  stubFetch(async () => fakeRes(400, '{"error":{"message":"Insufficient credits for this key"}}'));
  r = await or.handler(post({ action: 'draft', text: 'Seller: hello' }));
  check('OpenRouter 400 naming credits -> no_credit', JSON.parse(r.body).status === 'no_credit');
  check('isBillingError: 402 true', T.isBillingError(402, '') === true);
  check('isBillingError: 400 without credit wording false', T.isBillingError(400, 'bad model') === false);
  check('isBillingError: 500 false', T.isBillingError(500, 'credits') === false);

  // ---- 4. funded key -> ok, correct wire shape ----
  stubFetch(async () => fakeRes(200, JSON.stringify({
    choices: [{ message: { content: 'Seller wants $90K, firm.\nNext move: send the LAO and hold.' } }],
  })));
  r = await or.handler(post({ action: 'summarize', text: 'Seller: asking 90k, firm\nUs: ok' }));
  b = JSON.parse(r.body);
  check('funded -> 200', r.statusCode === 200, 'got ' + r.statusCode);
  check('funded -> status ok + result text', b.status === 'ok' && b.result.includes('Next move:'));
  check('funded -> model reported anthropic/claude-sonnet-5.5', b.model === 'anthropic/claude-sonnet-5.5');
  check('request URL is the OpenRouter chat completions endpoint', fetchCalls[0].url === 'https://openrouter.ai/api/v1/chat/completions', fetchCalls[0].url);
  check('request carries Bearer TEST key', fetchCalls[0].opts.headers.Authorization === 'Bearer sk-or-TEST-FAKE-KEY');
  const sent = JSON.parse(fetchCalls[0].opts.body);
  check('request model is anthropic/claude-sonnet-5.5', sent.model === 'anthropic/claude-sonnet-5.5');
  check('request messages carry the thread text', sent.messages[1].content.includes('asking 90k, firm'));
  check('summarize prompt demands the Next move line', sent.messages[0].content.includes('Next move:'));
  stubFetch(async () => fakeRes(200, JSON.stringify({ choices: [{ message: { content: 'Hi — just checking in.' } }] })));
  r = await or.handler(post({ action: 'draft', text: 'Seller: hello' }));
  const draftSent = JSON.parse(fetchCalls[0].opts.body);
  check('draft prompt is review-only (never sends)', /never send/i.test(draftSent.messages[0].content));
  check('draft result returned for review', JSON.parse(r.body).result === 'Hi — just checking in.');

  // ---- 5. self-test route (GET ?selftest=1) runs on the FREE model ----
  stubFetch(async () => fakeRes(200, JSON.stringify({ choices: [{ message: { content: 'Seller wants $80,000 and agreed to a 2pm call.\nNext move: call at 2pm.' } }] })));
  r = await or.handler({ httpMethod: 'GET', queryStringParameters: { selftest: '1' }, body: '' });
  b = JSON.parse(r.body);
  check('selftest -> 200 ok + selftest flag', r.statusCode === 200 && b.status === 'ok' && b.selftest === true, 'got ' + r.statusCode);
  check('selftest -> ran the fixed sample thread', JSON.parse(fetchCalls[0].opts.body).messages[1].content.includes('123 Main St'));
  check('selftest -> used the FREE router model (no paid credit burn)', JSON.parse(fetchCalls[0].opts.body).model === 'openrouter/free', JSON.parse(fetchCalls[0].opts.body).model);
  check('selftest -> response reports the free model', b.model === 'openrouter/free');
  check('SELFTEST_MODEL export is openrouter/free', T.SELFTEST_MODEL === 'openrouter/free');
  r = await or.handler({ httpMethod: 'GET', queryStringParameters: {}, body: '' });
  check('plain GET (no selftest) -> 405', r.statusCode === 405, 'got ' + r.statusCode);

  // ---- 6. upstream failure -> clean 502 ----
  stubFetch(async () => fakeRes(500, 'Internal Server Error'));
  r = await or.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  b = JSON.parse(r.body);
  check('OpenRouter 500 -> 502 clean error', r.statusCode === 502 && b.status === 'error' && noStack(r.body));
  stubFetch(async () => { throw new Error('socket hang up'); });
  r = await or.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  check('network throw -> 502 clean error', r.statusCode === 502 && noStack(r.body));

  // ---- 7. page wiring ----
  const html = fs.readFileSync(path.join(__dirname, 'conversations.html'), 'utf8');
  check('page points at the openrouter-assist function', html.includes("/.netlify/functions/openrouter-assist"));
  check('page has Summarize + Draft buttons', html.includes('data-openrouter-action="summarize"') && html.includes('data-openrouter-action="draft"'));
  check('page shows the calm dormant copy', html.includes('Deep read isn\\u2019t set up yet'));
  check('page states drafts-only next to the control', (html.match(/nothing sends from here/g) || []).length >= 3);
  check('page renders deep-read results read-only (no send path)', !/runOpenRouter[\s\S]{0,400}action: 'send'/.test(html));
  check('page carries no vendor name in the deep-read box', !/openrouterSection\(\) \{[\s\S]{0,900}OpenRouter/.test(html));

  // restore environment
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = realKey;

  console.log('\nopenrouter-assist-regression: ' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  global.fetch = realFetch;
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

// gemini-assist-regression.js — Gemini assist wiring, Nov 17 2026.
// Fixture tests for netlify/functions/gemini-assist.js + the Conversations
// page control. NO live calls: global fetch is stubbed and the only key
// used is an obviously fake TEST value. Run: node gemini-assist-regression.js
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
//      summarize/draft_reply prompts built from the text.
//   5. Upstream 500 -> clean 502, no stack trace leaked.
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

const realFetch = global.fetch;
const realKey = process.env.GEMINI_API_KEY;
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
  // ---- 1. not configured ----
  delete process.env.GEMINI_API_KEY;
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
  stubFetch(async () => fakeRes(200, geminiOk('Seller wants $90K, firm.\nNext move: send the LAO and hold.')));
  r = await gemini.handler(post({ action: 'summarize', text: 'Seller: asking 90k, firm\nUs: ok' }));
  b = JSON.parse(r.body);
  check('configured -> 200', r.statusCode === 200, 'got ' + r.statusCode);
  check('configured -> status ok + result text', b.status === 'ok' && b.result.includes('Next move:'));
  check('configured -> model reported gemini-3.5-flash', b.model === 'gemini-3.5-flash');
  check('request URL is the Gemini generateContent endpoint', fetchCalls[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', fetchCalls[0].url);
  check('request carries the TEST key in x-goog-api-key', fetchCalls[0].opts.headers['x-goog-api-key'] === 'gemini-TEST-FAKE-KEY');
  const sent = JSON.parse(fetchCalls[0].opts.body);
  check('request contents carry the thread text', sent.contents[0].parts[0].text.includes('asking 90k, firm'));
  check('summarize prompt demands the Next move line', sent.system_instruction.parts[0].text.includes('Next move:'));
  stubFetch(async () => fakeRes(200, geminiOk('Hi — just checking in.')));
  r = await gemini.handler(post({ action: 'draft_reply', text: 'Seller: hello' }));
  const draftSent = JSON.parse(fetchCalls[0].opts.body);
  check('draft prompt is review-only (never sends)', /never send/i.test(draftSent.system_instruction.parts[0].text));
  check('draft result returned for review', JSON.parse(r.body).result === 'Hi — just checking in.');
  check('extractText joins candidate parts', T.extractText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }) === 'ab');
  check('extractText on junk -> empty', T.extractText({}) === '' && T.extractText(null) === '');

  // ---- 5. upstream failure -> clean 502 ----
  stubFetch(async () => fakeRes(500, 'Internal Server Error'));
  r = await gemini.handler(post({ action: 'summarize', text: 'Seller: hi' }));
  b = JSON.parse(r.body);
  check('Gemini 500 -> 502 clean error', r.statusCode === 502 && b.status === 'error' && noStack(r.body));
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
  if (realKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = realKey;

  console.log('\ngemini-assist-regression: ' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  global.fetch = realFetch;
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

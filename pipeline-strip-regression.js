// Regression tests for the "Today's Pipeline" strip last-good cache
// (Nov 19, 2026): the upstream pipeline feed sometimes answers with a
// Netlify "Inactivity Timeout" HTML page instead of JSON while its compute
// spins up. resp.json() then yields nothing usable and the old strip —
// which had no memory and no retry — showed UNAVAILABLE even though good
// data existed (a retry seconds later returned valid JSON: 18 replies).
// The fix in index.html (renderPipelineStrip + helpers):
//   1. every ok/partial payload is saved to localStorage as last-good;
//   2. a cached strip renders IMMEDIATELY on load (no LOADING flash) and
//      refreshes in the background;
//   3. a failed/unparseable fetch auto-retries (up to 3 attempts total);
//   4. on total failure WITH a last-good, the last known numbers stay up,
//      labeled with a muted "live refresh failed" note — the UNAVAILABLE
//      panel may only appear when no last-good exists at all;
//   5. the 401/503 connect-note behavior is unchanged (no retry).
// Run: node pipeline-strip-regression.js (exit non-zero on any failure)
// No live calls: fetch and localStorage are fully mocked; the strip code
// is extracted from index.html and run in a vm sandbox, like the other
// dashboard suites.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ---------- Extract the strip code from index.html ----------
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Extract a top-level function by brace counting (same helper as the
// hot-leads suite).
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in index.html');
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

const varLines = html.split('\n').filter((l) => l.startsWith('var PIPELINE_STRIP_')).join('\n');
const STRIP_CODE = varLines + '\n' + [
  'esc', 'pipelineStripUrl', 'pipelineStripTime', 'pipelineStripConnectNote',
  'pipelineStripLoadCache', 'pipelineStripSaveCache', 'pipelineStripUnavailable',
  'pipelineStripFetchOnce', 'pipelineStripRenderData', 'renderPipelineStrip',
].map((n) => extractFn(html, n)).join('\n');

const CACHE_KEY = 'cc_pipeline_strip_last_good';

// Production proxy shape (mirrors the Nov 19 live payload: 18 replies).
const GOOD = {
  outcome: 'ok', partial: false, repliesToday: 18, bookedCount: 1,
  bookedToday: [{ title: 'Seller call — 123 Main St', startTime: '2026-11-19T15:00:00.000Z' }],
  happeningToday: 1, underContractCount: 2,
  underContract: [{ name: '456 Oak Ave' }, { name: '789 Pine St' }],
  generatedAt: '2026-11-19T20:00:00.000Z', notes: [],
};
const CACHED_OLD = Object.assign({}, GOOD, { repliesToday: 7, generatedAt: '2026-11-19T18:30:00.000Z' });

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}
function seedCache(payload) {
  return { [CACHE_KEY]: JSON.stringify({ payload, savedAt: '2026-11-19T18:31:00.000Z' }) };
}

// Fetch mocks. Each returns a fetch-like function with a .calls counter.
function okFetch(payload) {
  const fn = async () => { fn.calls++; return { status: 200, json: async () => payload }; };
  fn.calls = 0; return fn;
}
function timeoutPageFetch() {
  // The live failure: HTTP 200 with an HTML "Inactivity Timeout" page —
  // resp.json() throws, exactly like the real thing.
  const fn = async () => {
    fn.calls++;
    return { status: 200, json: async () => { throw new Error('Unexpected token < in JSON at position 0'); } };
  };
  fn.calls = 0; return fn;
}
function throwFetch() {
  const fn = async () => { fn.calls++; throw new Error('network unreachable'); };
  fn.calls = 0; return fn;
}
function statusFetch(status) {
  const fn = async () => { fn.calls++; return { status, json: async () => ({}) }; };
  fn.calls = 0; return fn;
}
function sequenceFetch(impls) {
  const fn = async () => { const impl = impls[Math.min(fn.calls, impls.length - 1)]; fn.calls++; return impl(); };
  fn.calls = 0; return fn;
}
const respOk = (payload) => async () => ({ status: 200, json: async () => payload });
const respTimeoutPage = async () => ({ status: 200, json: async () => { throw new Error('Unexpected token < in JSON at position 0'); } });

function makeSandbox(fetchImpl, storage) {
  const zone = { innerHTML: '' };
  const sandbox = {
    console,
    setTimeout,
    fetch: fetchImpl,
    localStorage: storage,
    ccEl: (id) => (id === 'pipelineStripZone' ? zone : null),
  };
  vm.createContext(sandbox);
  vm.runInContext(STRIP_CODE, sandbox);
  // Keep the suite fast; the production default (3000) is asserted below.
  sandbox.PIPELINE_STRIP_RETRY_DELAY_MS = 0;
  return { sandbox, zone };
}

(async () => {
  // ---------- 0. Extraction / wiring sanity ----------
  check('0 cache key + retry-delay vars extracted', varLines.includes("PIPELINE_STRIP_CACHE_KEY = 'cc_pipeline_strip_last_good'") && varLines.includes('PIPELINE_STRIP_RETRY_DELAY_MS = 3000'), varLines);
  check('0 strip still wired into renderExtras', html.includes('function renderExtras(){ renderHitList(); renderContracts(); renderPipelineStrip(); }'));
  check('0 Refresh/Retry buttons still call renderPipelineStrip', html.includes('onclick="renderPipelineStrip()"'));

  // ---------- 1. Success renders live and SAVES the last-good ----------
  {
    const storage = makeStorage();
    const f = okFetch(GOOD);
    const sb = makeSandbox(f, storage);
    await sb.sandbox.renderPipelineStrip();
    const out = sb.zone.innerHTML;
    check('1 live render shows LIVE FROM CRM + 18 replies', out.includes('LIVE FROM CRM') && out.includes('>18<'), out.slice(0, 300));
    check('1 live render shows the real As of footer', out.includes('As of') && out.includes('ET'));
    check('1 success fetched exactly once (no needless retry)', f.calls === 1, 'calls=' + f.calls);
    const raw = storage.getItem(CACHE_KEY);
    check('1 last-good saved under ' + CACHE_KEY, !!raw);
    const entry = raw ? JSON.parse(raw) : null;
    check('1 last-good holds the production payload shape', !!entry && entry.payload && entry.payload.outcome === 'ok' && entry.payload.repliesToday === 18 && typeof entry.savedAt === 'string', raw && raw.slice(0, 200));
    check('1 no vendor name in the rendered strip', !out.includes('HighLevel'));
  }

  // ---------- 2. Cache renders IMMEDIATELY (no LOADING flash), then refreshes ----------
  {
    const storage = makeStorage(seedCache(CACHED_OLD));
    const f = okFetch(GOOD);
    const { sandbox, zone } = makeSandbox(f, storage);
    const p = sandbox.renderPipelineStrip(); // not awaited: first paint must already be the cache
    check('2 first paint is the cached numbers, no LOADING flash', zone.innerHTML.includes('>7<') && !zone.innerHTML.includes('LOADING'), zone.innerHTML.slice(0, 300));
    await p;
    check('2 background refresh re-renders the fresh numbers', zone.innerHTML.includes('>18<') && !zone.innerHTML.includes('last known numbers'), zone.innerHTML.slice(0, 300));
    const entry = JSON.parse(storage.getItem(CACHE_KEY));
    check('2 refresh updated the last-good cache', entry.payload.repliesToday === 18);
  }

  // ---------- 3. Timeout-page failure WITH cache: last-good stays, labeled, retried ----------
  {
    const storage = makeStorage(seedCache(CACHED_OLD));
    const f = timeoutPageFetch();
    const { sandbox, zone } = makeSandbox(f, storage);
    await sandbox.renderPipelineStrip();
    check('3 auto-retry: 3 attempts before falling back', f.calls === 3, 'calls=' + f.calls);
    check('3 last-good numbers stay up on failure', zone.innerHTML.includes('>7<'), zone.innerHTML.slice(0, 300));
    check('3 stale note says live refresh failed + last known numbers', zone.innerHTML.includes('Live refresh failed') && zone.innerHTML.includes('last known numbers'), zone.innerHTML.slice(-300));
    check('3 NO UNAVAILABLE when a last-good exists', !zone.innerHTML.includes('UNAVAILABLE'));
  }

  // ---------- 4. Network failure with NO cache: UNAVAILABLE (the only case allowed) ----------
  {
    const storage = makeStorage();
    const f = throwFetch();
    const { sandbox, zone } = makeSandbox(f, storage);
    await sandbox.renderPipelineStrip();
    check('4 auto-retry ran before giving up', f.calls === 3, 'calls=' + f.calls);
    check('4 UNAVAILABLE shows only with an empty cache', zone.innerHTML.includes('UNAVAILABLE') && zone.innerHTML.includes('Retry'), zone.innerHTML.slice(0, 300));
  }

  // ---------- 5. Retry succeeds on the 2nd attempt (the Nov 19 live pattern) ----------
  {
    const storage = makeStorage();
    const f = sequenceFetch([respTimeoutPage, respOk(GOOD)]);
    const { sandbox, zone } = makeSandbox(f, storage);
    await sandbox.renderPipelineStrip();
    check('5 second attempt succeeds', f.calls === 2, 'calls=' + f.calls);
    check('5 fresh numbers render, no stale note', zone.innerHTML.includes('>18<') && !zone.innerHTML.includes('last known numbers'));
    check('5 recovered payload became the last-good', JSON.parse(storage.getItem(CACHE_KEY)).payload.repliesToday === 18);
  }

  // ---------- 6. Partial payload: PARTIAL badge, cached, and honored later ----------
  {
    const partial = Object.assign({}, GOOD, { outcome: 'partial', partial: true });
    const storage = makeStorage();
    const f = okFetch(partial);
    const s1 = makeSandbox(f, storage);
    await s1.sandbox.renderPipelineStrip();
    check('6 partial renders the PARTIAL badge', s1.zone.innerHTML.includes('PARTIAL'));
    check('6 partial payload is saved as last-good', JSON.parse(storage.getItem(CACHE_KEY)).payload.outcome === 'partial');
    const f2 = throwFetch();
    const s2 = makeSandbox(f2, storage);
    await s2.sandbox.renderPipelineStrip();
    check('6 cached partial survives a later outage (no UNAVAILABLE)', s2.zone.innerHTML.includes('PARTIAL') && s2.zone.innerHTML.includes('last known numbers') && !s2.zone.innerHTML.includes('UNAVAILABLE'), s2.zone.innerHTML.slice(0, 300));
  }

  // ---------- 7/8. 401 / 503 connect notes unchanged, no retry ----------
  {
    const f = statusFetch(401);
    const { sandbox, zone } = makeSandbox(f, makeStorage());
    await sandbox.renderPipelineStrip();
    check('7 401 shows the key-rejected connect note', zone.innerHTML.includes('NOT CONNECTED') && zone.innerHTML.includes('strip key was rejected'), zone.innerHTML.slice(0, 300));
    check('7 401 is not retried', f.calls === 1, 'calls=' + f.calls);
  }
  {
    const f = statusFetch(503);
    const { sandbox, zone } = makeSandbox(f, makeStorage());
    await sandbox.renderPipelineStrip();
    check('8 503 shows the not-configured connect note', zone.innerHTML.includes('NOT CONNECTED') && zone.innerHTML.includes('not configured yet'), zone.innerHTML.slice(0, 300));
    check('8 503 is not retried', f.calls === 1, 'calls=' + f.calls);
  }

  // ---------- 9. Corrupt / wrong-shape cache is treated as NO cache ----------
  {
    const f = throwFetch();
    const { sandbox, zone } = makeSandbox(f, makeStorage({ [CACHE_KEY]: 'not-json{{{' }));
    await sandbox.renderPipelineStrip();
    check('9 unparseable cache ignored -> UNAVAILABLE on failure', zone.innerHTML.includes('UNAVAILABLE'));
  }
  {
    const bad = { [CACHE_KEY]: JSON.stringify({ payload: { outcome: 'bogus' }, savedAt: 'x' }) };
    const f = throwFetch();
    const { sandbox, zone } = makeSandbox(f, makeStorage(bad));
    await sandbox.renderPipelineStrip();
    check('9 wrong-outcome cache ignored -> UNAVAILABLE on failure', zone.innerHTML.includes('UNAVAILABLE'));
  }

  // ---------- 10. Unexpected-outcome JSON with no cache: retries, then UNAVAILABLE ----------
  {
    const f = okFetch({ outcome: 'error', message: 'upstream broke' });
    const { sandbox, zone } = makeSandbox(f, makeStorage());
    await sandbox.renderPipelineStrip();
    check('10 unexpected outcome retried 3x', f.calls === 3, 'calls=' + f.calls);
    check('10 unexpected outcome -> UNAVAILABLE with the unexpected-response wording', zone.innerHTML.includes('UNAVAILABLE') && zone.innerHTML.includes('unexpected response'), zone.innerHTML.slice(0, 300));
  }

  // ---------- 11. Manual Refresh path updates the cache (renderPipelineStrip is the handler) ----------
  {
    const storage = makeStorage(seedCache(CACHED_OLD));
    const fresh = Object.assign({}, GOOD, { repliesToday: 21 });
    const f = okFetch(fresh);
    const { sandbox } = makeSandbox(f, storage);
    await sandbox.renderPipelineStrip(); // same call the Refresh button makes
    check('11 manual refresh updates the last-good cache', JSON.parse(storage.getItem(CACHE_KEY)).payload.repliesToday === 21);
  }

  if (failures) { console.log(failures + ' FAILURE(S)'); process.exit(1); }
  console.log('ALL pipeline strip regression tests PASS');
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

// Regression tests for the Command Center scale fixes (Nov 11, 2026):
// (a) Pagination — /opportunities/search paged with the documented
//     `page` param past the 100/call cap (up to 10 pages = 1,000 opps),
//     close rate honest via oppsFetched/oppsTotal + closeRateCapped;
// (b) Speed — stage map fetched in parallel with page 0 and cached
//     10 min, contact enrichment capped at 100 leads with 20 in flight,
//     overview cache keyed per client, warm overview makes zero HL calls;
// (c) Per-client config — cc-data.js resolves location/calendar/token
//     from the request's client (lib-client.js), Troy's ids only for
//     Troy's own domains, unknown subdomains get NO data (400);
// (d) Neutral default — unknown subdomains get clients/_default.json
//     ("Command Center", no logo, no Troy numbers, no Troy location)
//     instead of falling back to Troy.
// Run: node command-center-scale-regression.js (exit non-zero on failure)
// No live API calls: global fetch is fully mocked (fixture HL server).
// Timing test uses simulated 10ms/call latency and a generous bound.
'use strict';

process.env.HL_API_TOKEN = 'fixture-token';

const fs = require('fs');
const path = require('path');

const ccData = require('./netlify/functions/cc-data.js');
const clientConfigFn = require('./netlify/functions/client-config.js');
const libClient = require('./netlify/functions/lib-client.js');
const ccDataSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/cc-data.js'), 'utf8');
const clientConfigSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/client-config.js'), 'utf8');
const ccHtml = fs.readFileSync(path.join(__dirname, 'command-center.html'), 'utf8');
const troyJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'clients/troy.json'), 'utf8'));
const defaultJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'clients/_default.json'), 'utf8'));

const TROY_LOCATION = 'krKoHLudPnn7nT0DPtwa';
const TROY_CALENDAR = 'aG6lop6FROsWlIrB0Y0H';
const TROY_NUMBERS = ['+14632783964', '+12165288706', '+18167205099', '+19803721662', '+19043952638'];

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ---------- Fixture HL server ----------
const STAGE_NEW = 'stage-new';
const STAGE_UC = 'stage-uc';
const STAGE_WON = 'stage-won';

const fixture = {
  total: 250,
  latencyMs: 0,
  overlapDup: false,
  calls: [],
};

function makeOpps(total) {
  const opps = [];
  for (let i = 0; i < total; i++) {
    const kind = (i % 25 === 0) ? 'won' : (i % 10 === 0) ? 'uc' : 'new';
    opps.push({
      id: 'opp-' + i,
      name: 'Lead ' + i,
      status: kind === 'won' ? 'won' : 'open',
      pipelineStageId: kind === 'won' ? STAGE_WON : kind === 'uc' ? STAGE_UC : STAGE_NEW,
      monetaryValue: kind === 'won' ? 50000 : 0,
      dateAdded: new Date(Date.now() - 3600 * 1000).toISOString(),
      contactId: 'contact-' + i,
    });
  }
  return opps;
}

function countKinds(opps) {
  let won = 0, uc = 0, nw = 0;
  for (const o of opps) {
    if (o.status === 'won') won++;
    else if (o.pipelineStageId === STAGE_UC) uc++;
    else nw++;
  }
  return { won, uc, nw };
}

global.fetch = async (url, opts) => {
  const u = new URL(url);
  const pathName = u.pathname;
  const method = (opts && opts.method) || 'GET';
  fixture.calls.push(method + ' ' + pathName + (method === 'POST' ? ' page=' + JSON.parse((opts && opts.body) || '{}').page : ''));
  if (fixture.latencyMs) await new Promise((r) => setTimeout(r, fixture.latencyMs));
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (pathName === '/opportunities/search' && method === 'POST') {
    const body = JSON.parse((opts && opts.body) || '{}');
    const page = Number(body.page || 0);
    const all = makeOpps(fixture.total);
    let rows = all.slice(page * 100, page * 100 + 100);
    // Overlap test: page 1 repeats the last row of page 0.
    if (fixture.overlapDup && page === 1 && rows.length) rows = [all[99], ...rows];
    return json({ opportunities: rows, total: fixture.total });
  }
  if (pathName === '/opportunities/pipelines') {
    return json({ pipelines: [{ id: 'pipe-1', stages: [
      { id: STAGE_NEW, name: 'New Lead' },
      { id: STAGE_UC, name: 'Under Contract' },
      { id: STAGE_WON, name: 'Closed Won' },
    ] }] });
  }
  if (pathName === '/conversations/search') {
    const convos = Array.from({ length: 30 }, (_, i) => ({
      id: 'conv-' + i, fullName: 'Seller ' + i,
      lastMessageDate: new Date(Date.now() - 3600 * 1000).toISOString(),
    }));
    return json({ conversations: convos });
  }
  if (/^\/conversations\/[^/]+\/messages$/.test(pathName)) {
    return json({ messages: { messages: [{ direction: 'inbound', dateAdded: new Date(Date.now() - 3600 * 1000).toISOString(), body: 'Yes, still interested' }] } });
  }
  if (pathName === '/calendars/events') {
    const t = new Date(Date.now() + 3600 * 1000).toISOString();
    return json({ events: [
      { id: 'ev-1', title: 'Seller call', startTime: t, appointmentStatus: 'confirmed', calendarId: TROY_CALENDAR },
      { id: 'ev-2', title: 'Seller call 2', startTime: t, appointmentStatus: 'confirmed' },
    ] });
  }
  if (/^\/contacts\/[^/]+$/.test(pathName)) {
    return json({ contact: { tags: [], customFields: [] } });
  }
  return { ok: false, status: 404, text: async () => 'not found in fixture' };
};

function overviewEvent(host, extraHeaders) {
  return {
    httpMethod: 'GET',
    queryStringParameters: { action: 'overview' },
    headers: Object.assign({ host }, extraHeaders || {}),
  };
}

function countCalls(prefix) {
  return fixture.calls.filter((c) => c.indexOf(prefix) === 0).length;
}

function resetCaches() {
  ccData._test.clearOverviewCache();
  ccData._test.clearStageMapCache();
}

(async () => {
  // ---------- 1. Pagination: 250 opps across 3 pages, all counted ----------
  {
    resetCaches();
    fixture.total = 250; fixture.latencyMs = 0; fixture.overlapDup = false; fixture.calls = [];
    const res = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    const d = JSON.parse(res.body);
    const truth = countKinds(makeOpps(250));
    check('1 overview 200 for Troy host', res.statusCode === 200 && d.ok === true, 'status=' + res.statusCode);
    check('1 all 3 search pages fetched', countCalls('POST /opportunities/search') === 3, JSON.stringify(fixture.calls.filter((c) => c.includes('opportunities/search'))));
    check('1 search pages are 0,1,2', fixture.calls.includes('POST /opportunities/search page=0') && fixture.calls.includes('POST /opportunities/search page=1') && fixture.calls.includes('POST /opportunities/search page=2'));
    check('1 closed counts won past page 0 (truth ' + truth.won + ')', d.closedCount === truth.won, 'closedCount=' + d.closedCount);
    check('1 closed volume = won x $50K', d.closedVolume === truth.won * 50000, 'closedVolume=' + d.closedVolume);
    check('1 close rate = closed/fetched (truth ' + Math.round(truth.won / 250 * 100) + '%)', d.closeRate === Math.round(truth.won / 250 * 100), 'closeRate=' + d.closeRate);
    check('1 NOT capped when all 250 fetched', d.closeRateCapped === false && d.oppsFetched === 250 && d.oppsTotal === 250, JSON.stringify({ capped: d.closeRateCapped, fetched: d.oppsFetched, total: d.oppsTotal }));
    check('1 under-contract + new-lead counts match fixture', d.underContract === truth.uc && d.newLeadsCount === truth.nw, JSON.stringify({ uc: d.underContract, nw: d.newLeadsCount, truth }));
    check('1 booked + replies still work', d.bookedToday === 2 && d.sellerReplies === 30, JSON.stringify({ booked: d.bookedToday, replies: d.sellerReplies }));
  }

  // ---------- 2. Pagination cap: 1,250 opps -> 1,000 fetched, honestly capped ----------
  {
    resetCaches();
    fixture.total = 1250; fixture.calls = [];
    const res = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    const d = JSON.parse(res.body);
    const truth = countKinds(makeOpps(1250));
    check('2 pages stop at the 10-page hard cap', countCalls('POST /opportunities/search') === 10, 'pages=' + countCalls('POST /opportunities/search'));
    check('2 fetched is capped at 1,000', d.oppsFetched === 1000 && d.oppsTotal === 1250, JSON.stringify({ fetched: d.oppsFetched, total: d.oppsTotal }));
    check('2 capped label is true past the cap', d.closeRateCapped === true);
    check('2 close rate uses fetched denominator', d.closeRate === Math.round(d.closedCount / 1000 * 100), 'closeRate=' + d.closeRate + ' closed=' + d.closedCount);
    check('2 closed counted within fetched window only', d.closedCount === countKinds(makeOpps(1000)).won, 'closedCount=' + d.closedCount + ' truth1000=' + countKinds(makeOpps(1000)).won);
    check('2 truth check: fixture really has more won past 1,000', truth.won > countKinds(makeOpps(1000)).won, 'won1250=' + truth.won);
  }

  // ---------- 3. Page-boundary dedupe ----------
  {
    resetCaches();
    fixture.total = 150; fixture.overlapDup = true; fixture.calls = [];
    const res = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    const d = JSON.parse(res.body);
    check('3 overlapping page rows deduped (fetched == total)', d.oppsFetched === 150 && d.oppsTotal === 150, JSON.stringify({ fetched: d.oppsFetched, total: d.oppsTotal }));
    fixture.overlapDup = false;
  }

  // ---------- 4. Cache behaviour ----------
  {
    resetCaches();
    fixture.total = 250; fixture.calls = [];
    const first = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    const firstCalls = fixture.calls.length;
    const firstPipelines = countCalls('GET /opportunities/pipelines');
    check('4 first call fetches + not cached', JSON.parse(first.body).cached === false && firstCalls > 0, 'calls=' + firstCalls);
    // 4a. Warm second call: zero new HL calls, cached flag set.
    fixture.calls = [];
    const second = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    check('4a warm overview makes ZERO HL calls', fixture.calls.length === 0, 'calls=' + fixture.calls.length);
    check('4a warm overview is flagged cached', JSON.parse(second.body).cached === true);
    // 4b. Overview cache cleared but stage map cached: pipelines NOT re-fetched.
    ccData._test.clearOverviewCache();
    fixture.calls = [];
    await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    check('4b stage map NOT re-fetched after overview-cache clear', countCalls('GET /opportunities/pipelines') === 0, 'pipelines=' + countCalls('GET /opportunities/pipelines'));
    check('4b other feeds DO re-fetch after overview-cache clear', countCalls('POST /opportunities/search') === 3);
    // 4c. Stage-map cache cleared too: pipelines re-fetched exactly once.
    ccData._test.clearOverviewCache();
    ccData._test.clearStageMapCache();
    fixture.calls = [];
    await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    check('4c stage map re-fetched once after its cache clear', countCalls('GET /opportunities/pipelines') === 1, 'pipelines=' + countCalls('GET /opportunities/pipelines'));
    // 4d. Unknown subdomain does NOT get Troy's cached overview.
    fixture.calls = [];
    const stranger = await ccData.handler(overviewEvent('stranger.leadmachineapp.com'));
    check('4d unknown subdomain gets 400, not cached Troy data', stranger.statusCode === 400 && JSON.parse(stranger.body).ok === false, 'status=' + stranger.statusCode);
    check('4d unknown-subdomain error names the problem, not Troy data', JSON.parse(stranger.body).error.includes('unknown client') && !stranger.body.includes(TROY_LOCATION));
    check('4d unknown request made zero HL calls', fixture.calls.length === 0, 'calls=' + fixture.calls.length);
    // 4e. Troy still works after the stranger call (cache not poisoned).
    const troyAgain = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    check('4e Troy overview still 200 after stranger 400', troyAgain.statusCode === 200 && JSON.parse(troyAgain.body).ok === true);
    void firstPipelines;
  }

  // ---------- 5. Per-client resolution (lib-client, no fetch) ----------
  {
    const troyApp = libClient.resolveClientData({ headers: { host: 'app.leadmachineapp.com' } });
    check('5a app.leadmachineapp.com -> Troy location+calendar', troyApp && troyApp.locationId === TROY_LOCATION && troyApp.calendarId === TROY_CALENDAR, JSON.stringify(troyApp && { l: troyApp.locationId, c: troyApp.calendarId }));
    const troyApex = libClient.resolveClientData({ headers: { host: 'leadmachineapp.com' } });
    check('5b apex leadmachineapp.com -> Troy', troyApex && troyApex.locationId === TROY_LOCATION);
    const troyWww = libClient.resolveClientData({ headers: { host: 'www.leadmachineapp.com' } });
    check('5c www.leadmachineapp.com -> Troy', troyWww && troyWww.locationId === TROY_LOCATION);
    check('5d unknown subdomain -> null (no Troy data)', libClient.resolveClientData({ headers: { host: 'stranger.leadmachineapp.com' } }) === null);
    check('5e unknown host -> null (no Troy data)', libClient.resolveClientData({ headers: { host: 'evil.example.com' } }) === null);
    const viaHeader = libClient.resolveClientData({ headers: { host: 'preview-123.netlify.app', 'x-client-subdomain': 'troy' } });
    check('5f x-client-subdomain header can select Troy', viaHeader && viaHeader.locationId === TROY_LOCATION);
    check('5g header naming a missing client -> null, not Troy', libClient.resolveClientData({ headers: { host: 'app.leadmachineapp.com', 'x-client-subdomain': 'nosuchclient' } }) === null);
    check('5h subdomainFromHost: deep subdomain -> null', libClient.subdomainFromHost('a.b.leadmachineapp.com') === null);
    check('5i subdomainFromHost: localhost -> troy (dev convenience)', libClient.subdomainFromHost('localhost:8888') === 'troy');
    check('5j troy.json keeps Troy location+calendar', troyJson.highLevel.locationId === TROY_LOCATION && troyJson.highLevel.calendarId === TROY_CALENDAR);
    check('5k troy.json still ships the 5 market numbers', JSON.stringify(troyJson.bot.fromNumbers).includes('+14632783964') && Object.keys(troyJson.bot.fromNumbers).length === 5);
  }

  // ---------- 6. Neutral default (client-config handler) ----------
  {
    const neutral = await clientConfigFn.handler({ headers: { host: 'stranger.leadmachineapp.com' } });
    const nb = JSON.parse(neutral.body);
    check('6a unknown subdomain -> 200 neutral config', neutral.statusCode === 200, 'status=' + neutral.statusCode);
    check('6b neutral companyName is generic', nb.companyName === 'Command Center', 'companyName=' + nb.companyName);
    check('6c neutral logo is empty (page hides the img)', nb.logo === '', 'logo=' + JSON.stringify(nb.logo));
    check('6d neutral subdomain is _default', nb.subdomain === '_default', 'subdomain=' + nb.subdomain);
    check('6e neutral body has no Troy branding', !neutral.body.includes('Direct Property Buyers') && !neutral.body.includes('dpb-logo'));
    check('6f neutral body has no Troy location', !neutral.body.includes(TROY_LOCATION));
    check('6g neutral body has no Troy phone numbers', !TROY_NUMBERS.some((n) => neutral.body.includes(n)));
    const troy = await clientConfigFn.handler({ headers: { host: 'app.leadmachineapp.com' } });
    const tb = JSON.parse(troy.body);
    check('6h Troy host still gets Troy branding', troy.statusCode === 200 && tb.companyName === 'Direct Property Buyers' && tb.logo === '/assets/dpb-logo.png', JSON.stringify(tb));
    check('6i _default.json on disk has empty locationId', defaultJson.highLevel.locationId === '' && defaultJson.highLevel.calendarId === '');
    check('6j _default.json on disk has no market numbers', Object.keys(defaultJson.bot.fromNumbers).length === 0 && defaultJson.bot.markets.length === 0);
    check('6k _default.json on disk has no Troy strings', !JSON.stringify(defaultJson).includes('Direct Property Buyers') && !JSON.stringify(defaultJson).includes(TROY_LOCATION));
  }

  // ---------- 7. Speed: enrichment bound + concurrency + timing ----------
  {
    const t = ccData._test;
    check('7a cheapScoreFor appointment+recent = 15', t.cheapScoreFor({ stage: 'Appointment Booked', createdAt: new Date().toISOString() }).score === 15);
    check('7b cheapScoreFor old new lead = 0', t.cheapScoreFor({ stage: 'New Lead', createdAt: new Date(Date.now() - 30 * 86400 * 1000).toISOString() }).score === 0);
    check('7c enrich cap is 100, concurrency 20', t.ENRICH_LEADS_MAX === 100 && t.ENRICH_CONCURRENCY === 20);
    // mapWithConcurrency respects the limit and keeps order.
    let inFlight = 0, maxFlight = 0;
    const out = await t.mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++; maxFlight = Math.max(maxFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    check('7d mapWithConcurrency keeps order', JSON.stringify(out) === '[2,4,6,8,10,12]', JSON.stringify(out));
    check('7e mapWithConcurrency never exceeds limit 2', maxFlight <= 2, 'maxFlight=' + maxFlight);
    check('7f mapWithConcurrency actually parallelises (max > 1)', maxFlight > 1, 'maxFlight=' + maxFlight);
    // Enrichment bound on the 250-op fixture (220 new leads): exactly
    // 100 contact reads, the rest keep cheap scores.
    resetCaches();
    fixture.total = 250; fixture.latencyMs = 0; fixture.calls = [];
    const res = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    const d = JSON.parse(res.body);
    const contactCalls = fixture.calls.filter((c) => c.indexOf('GET /contacts/') === 0).length;
    check('7g contact reads capped at 100 for 220 new leads', contactCalls === 100, 'contactCalls=' + contactCalls);
    check('7g grid still gets its top 9', d.newLeads.length === 9);
    // Timing: 10ms simulated latency, cold overview must clear 5s.
    resetCaches();
    fixture.total = 250; fixture.latencyMs = 10; fixture.calls = [];
    const t0 = Date.now();
    const timed = await ccData.handler(overviewEvent('app.leadmachineapp.com'));
    const wallMs = Date.now() - t0;
    console.log('    (timing) cold overview at 10ms/call latency: ' + wallMs + 'ms, ' + fixture.calls.length + ' HL calls');
    check('7h cold overview < 5000ms at 10ms/call latency', timed.statusCode === 200 && wallMs < 5000, 'wallMs=' + wallMs);
    fixture.latencyMs = 0;
  }

  // ---------- 8. Wiring checks on the shipped files ----------
  check('8 cc-data pages with documented page param', ccDataSrc.includes('page,') && ccDataSrc.includes('MAX_OPP_PAGES') && ccDataSrc.includes('OPP_PAGE_SIZE = 100'));
  check('8 cc-data documents the searchAfter follow-up', ccDataSrc.includes('searchAfter'));
  check('8 cc-data resolves client per request', ccDataSrc.includes('resolveClientData(event)') && ccDataSrc.includes("locationId: ctx.locationId"));
  check('8 cc-data stage map cached 10 min', ccDataSrc.includes('STAGE_MAP_TTL_MS = 600000') && ccDataSrc.includes('stageMapCache'));
  check('8 cc-data overview cache keyed per client', ccDataSrc.includes('overviewCacheMem.key === ctx.locationId'));
  check('8 cc-data unknown client is an honest 400, never Troy data', ccDataSrc.includes('unknown client') && ccDataSrc.includes('statusCode: 400'));
  check('8 cc-data returns oppsFetched/oppsTotal', ccDataSrc.includes('oppsFetched') && ccDataSrc.includes('oppsTotal'));
  check('8 cc-data keeps HL versions per endpoint', ccDataSrc.includes("HL_VERSION_CONVERSATIONS = '2021-04-15'") && ccDataSrc.includes("HL_VERSION_OPPORTUNITIES = '2021-07-28'"));
  check('8 cc-data keeps the real HL hostname (no rename)', ccDataSrc.includes('services.leadconnectorhq.com') && !ccDataSrc.includes('api.data-api.com'));
  check('8 client-config uses shared lib-client, no Troy fallback', clientConfigSrc.includes("require('./lib-client')") && !clientConfigSrc.includes('fall back to Troy') && !clientConfigSrc.includes('loadClient(TROY_SUBDOMAIN)'));
  check('8 page labels close rate with the fetched count', ccHtml.includes('oppsFetched') && ccHtml.includes("Close Rate · first '+(d.oppsFetched"));
  check('8 page hides logo when client logo is empty', ccHtml.includes("logoImg.style.display = 'none'"));

  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('ALL command-center scale regression tests PASS');
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

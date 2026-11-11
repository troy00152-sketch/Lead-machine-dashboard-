// Regression tests for the Command Center resale fixes (Nov 11, 2026):
// Blocker 1 — no auto credit burn (renderHotLeads never fetches; enrichment
//   is explicit, confirmed, cached); Blocker 2 — listing-first gate, AVM
//   never presented as ARV, 3-comp minimum, repairs choice + Indianapolis
//   calibration; Blocker 4 — "Closed Volume" (not Net Profit), Close Rate
//   labelled as first-100-opps when capped, feed errors surfaced + LIVE
//   dot tied to feed health. Plus: hottest-first sorting, hub nav,
//   client-config branding, neutral map center + real lead pins.
// Booked Today (Nov 11, 2026) — the bot-booked Itzhak Bokobzha 8:00 AM
// Nov 11 appointment missed the feed: the query window was anchored
// to NOW (now-12h), so morning appointments slid out of it after 8 PM;
// the window now starts at ET midnight, the filter drops other-calendar
// / yesterday / cancelled events, and an HL failure surfaces instead
// of a silent 0.
// Run: node command-center-resale-regression.js (exit non-zero on failure)
// No live API calls: HL fetch is never invoked and the page's fetch is
// fully mocked (it THROWS if renderHotLeads calls it at all).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ccHtml = fs.readFileSync(path.join(__dirname, 'command-center.html'), 'utf8');
const ccData = fs.readFileSync(path.join(__dirname, 'netlify/functions/cc-data.js'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// Extract a top-level function by brace counting.
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in command-center.html');
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

function compRow(address, amount, date) {
  return { address, amount, date, distance: 0.4, sqft: 2600, beds: 3, baths: 2, ppsf: Math.round(amount / 2600 * 100) / 100, score: 2, deviations: [] };
}

function makeSandbox(extra) {
  const grid = { innerHTML: '' };
  const subjResult = { innerHTML: '' };
  const subjRepairs = { value: '30000' };
  const enrichAllCount = { textContent: '' };
  const enrichCount = { textContent: '' };
  let fetchCalls = 0;
  const _elCache = {};
  const _stubEl = () => ({ textContent: '', innerHTML: '', style: {}, value: '', classList: { add() {}, remove() {}, contains() { return false; } }, focus() {}, click() {} });
  const sandbox = {
    console,
    document: {
      getElementById: (id) => {
        if (id === 'leadsGrid') return grid;
        if (id === 'subjResult') return subjResult;
        if (id === 'subjRepairs') return subjRepairs;
        if (id === 'enrichAllCount') return enrichAllCount;
        if (id === 'enrichCount') return enrichCount;
        // Persistent per-id stubs so section-8 renderers (KPI grid, Hit
        // List, contract strip, deal sheet, ⌘K) can be read back after
        // rendering. Every unknown id gets the same shape.
        if (!_elCache[id]) _elCache[id] = _stubEl();
        return _elCache[id];
      },
      querySelector: () => null,
    },
    window: {},
    // renderHotLeads / renderSubjectAnalysis must NEVER fetch on their own.
    fetch: async () => { fetchCalls++; throw new Error('unexpected fetch — auto-spend!'); },
    wholesaleScoreSimple: () => ({ score: 750, label: 'LAYUP', distress: 300, equity: 250, own: 100 }),
    drawArvChart: () => {},
    addMapPin: () => {},
    OfferMath: {
      marketFor: (city, state) => (String(city).toLowerCase().includes('indianapolis') && state === 'IN') ? 'Indianapolis' : null,
      offerMath: (arv, repairs, cal, market) => {
        if (!arv) return { mao: null, lao: null, label: '—', tier: null };
        const mult = market === 'Indianapolis' ? 0.714 : 0.80;
        const mao = Math.round((arv - repairs) * mult);
        return { mao, lao: Math.round(mao * 0.70), label: market === 'Indianapolis' ? '71.4% calibrated' : '80% tier', tier: 0.80, multiplier: mult };
      },
    },
    _els: { grid, subjResult, subjRepairs, enrichAllCount, enrichCount },
    _elCache,
    _fetchCalls: () => fetchCalls,
  };
  sandbox.window = sandbox;
  Object.assign(sandbox, extra || {});
  vm.createContext(sandbox);
  return sandbox;
}

(async () => {
  // ---------- 1. calcMAO tier math unchanged (regression-locked) ----------
  {
    const fns = ['calcMAO'].map((n) => extractFn(ccHtml, n)).join('\n');
    const sb = makeSandbox();
    vm.runInContext(fns, sb);
    const m = sb.calcMAO(200000, 30000);
    check('1 calcMAO tier math unchanged', m.mao === 136000 && m.lao === 95200, JSON.stringify(m));
    check('1 calcMAO null ARV -> nulls', sb.calcMAO(null, 30000).mao === null);
  }

  // ---------- 2. isListedProperty ----------
  {
    const fns = ['isListedProperty'].map((n) => extractFn(ccHtml, n)).join('\n');
    const sb = makeSandbox();
    vm.runInContext(fns, sb);
    const f = sb.isListedProperty;
    check('2 onMarket true -> listed', f({ onMarket: true }) === true);
    check('2 listingStatus Active -> listed', f({ onMarket: false, listingStatus: 'Active' }) === true);
    check('2 listingStatus Pending -> listed', f({ onMarket: false, listingStatus: 'Pending' }) === true);
    check('2 listingStatus Sold -> listed', f({ onMarket: false, listingStatus: 'Sold' }) === true);
    check('2 listingStatus not-listed -> NOT listed (trap)', f({ onMarket: false, listingStatus: 'not-listed' }) === false);
    check('2 listingStatus Expired -> not listed', f({ onMarket: false, listingStatus: 'Expired' }) === false);
    check('2 listingStatus Withdrawn -> not listed', f({ onMarket: false, listingStatus: 'Withdrawn' }) === false);
    check('2 no listing fields -> not listed', f({}) === false);
    check('2 null -> not listed', f(null) === false);
  }

  // ---------- 3. marketFromAddress ----------
  {
    const fns = ['marketFromAddress'].map((n) => extractFn(ccHtml, n)).join('\n');
    const sb = makeSandbox();
    vm.runInContext(fns, sb);
    check('3 Indianapolis IN -> Indianapolis', sb.marketFromAddress('4405 E Edgewood Ave, Indianapolis, IN 46237') === 'Indianapolis');
    check('3 Cleveland OH -> null (stub marketFor)', sb.marketFromAddress('123 Main St, Cleveland, OH 44101') === null);
    check('3 garbage -> null', sb.marketFromAddress('garbage') === null);
  }

  // ---------- 4. renderHotLeads: zero fetches, hottest first, enrich gated ----------
  {
    const fns = ['esc', 'fmtMoney', 'timeAgo', 'scoreClass', 'calcMAO', 'resolveLeadValues', 'renderHotLeads']
      .map((n) => extractFn(ccHtml, n)).join('\n');
    const sb = makeSandbox();
    vm.runInContext(fns, sb);
    const leads = [
      { address: '111 Low St, Indianapolis, IN 46201', name: '111 Low St', stage: 'New Lead', createdAt: new Date(Date.now() - 5 * 86400 * 1000).toISOString(), score: 16, scoreLabel: 'COOL', scoreParts: { distress: 16, equity: 0, own: 0 }, scoreSource: 'crm', arv: null, mao: null, lao: null },
      { address: '222 Hot St, Indianapolis, IN 46201', name: '222 Hot St', stage: 'Appointment Booked', createdAt: new Date().toISOString(), score: 60, scoreLabel: 'HOT', scoreParts: { distress: 45, equity: 0, own: 8 }, scoreSource: 'crm', arv: 167876, mao: 117513, lao: 82259 },
      { address: '333 Mid St, Indianapolis, IN 46201', name: '333 Mid St', stage: 'New Lead', createdAt: new Date().toISOString(), score: 40, scoreLabel: 'WARM', scoreParts: { distress: 40, equity: 0, own: 0 }, scoreSource: 'crm', arv: null, mao: null, lao: null },
    ];
    sb.renderHotLeads(leads);
    const html = sb._els.grid.innerHTML;
    check('4 renderHotLeads makes ZERO fetches', sb._fetchCalls() === 0, 'fetchCalls=' + sb._fetchCalls());
    const iHot = html.indexOf('222 Hot St'), iMid = html.indexOf('333 Mid St'), iLow = html.indexOf('111 Low St');
    check('4 hottest first (HOT before WARM before COOL)', iHot > -1 && iHot < iMid && iMid < iLow, `hot=${iHot} mid=${iMid} low=${iLow}`);
    check('4 comped card still shows feed values', html.includes('$167,876') && html.includes('$117,513') && html.includes('$82,259'));
    check('4 uncomped card still shows dashes', html.includes('>—<'));
    check('4 no $0 rendered', !html.includes('$0'));
    check('4 per-card Enrich button carries the cost', html.includes('Enrich · ~2 PR credits'));
    check('4 no auto-enrich loading text', !html.includes('Enriching '));
    // Second render (the 60s refresh) still makes zero fetches.
    sb.renderHotLeads(leads);
    check('4 refresh re-render makes ZERO fetches', sb._fetchCalls() === 0, 'fetchCalls=' + sb._fetchCalls());
  }

  // ---------- 5. renderSubjectAnalysis: listing gate / AVM / calibration ----------
  {
    const fns = ['esc', 'fmtMoney', 'scoreClass', 'calcMAO', 'isListedProperty', 'marketFromAddress', 'repairsLabel', 'renderSubjectAnalysis']
      .map((n) => extractFn(ccHtml, n)).join('\n');
    const sb = makeSandbox();
    vm.runInContext(fns, sb);
    const base = {
      matched: true, source: 'data provider',
      property: { address: '4405 E Edgewood Ave, Indianapolis, IN 46237', owner1: 'ERIC KINSEY', beds: 3, baths: 2, sqft: 2726, yearBuilt: 1962, marketValue: 254226, latitude: 39.68, longitude: -86.15, onMarket: false, listingStatus: 'not-listed' },
      linkedProperties: [],
    };
    const three = [compRow('4401 E Edgewood Ave, Indianapolis, IN 46237', 248000, '2026-08-15'), compRow('4412 E Edgewood Ave, Indianapolis, IN 46237', 252000, '2026-09-02'), compRow('4390 E Edgewood Ave, Indianapolis, IN 46237', 251770, '2026-07-20')];
    // 5a. Listed -> PASS banner, no MAO/LAO numbers.
    {
      const d = JSON.parse(JSON.stringify(base));
      d.property.onMarket = true; d.property.listingStatus = 'Active';
      d.comps = { indication: 250590, best: three };
      sb.renderSubjectAnalysis(d, d.property.address);
      const html = sb._els.subjResult.innerHTML;
      check('5a listed shows PASS banner', html.includes('PASS — Listed with a realtor'));
      check('5a listed shows no MAO/LAO numbers', html.includes('— PASS —') && !html.includes('MAO (71.4% calibrated') && !html.includes('MAO (80%'));
      check('5a listed ARV is reference-only', html.includes('reference only'));
    }
    // 5b. 3 comps, not listed -> ARV + calibrated MAO (Medium $30K).
    {
      const d = JSON.parse(JSON.stringify(base));
      d.comps = { indication: 250590, best: three };
      sb._els.subjRepairs.value = '30000';
      sb.renderSubjectAnalysis(d, d.property.address);
      const html = sb._els.subjResult.innerHTML;
      // (250590-30000)*0.714 = 157501.26 -> 157501; LAO 110251.
      check('5b 3-comp ARV shown', html.includes('$250,590'), html.slice(0, 300));
      check('5b calibrated MAO shown', html.includes('$157,501') && html.includes('71.4% calibrated'));
      check('5b LAO shown', html.includes('$110,251'));
      check('5b no AVM warning', !html.includes('not airtight'));
      check('5b no PASS banner', !html.includes('PASS — Listed'));
    }
    // 5c. Repairs change re-renders from the SAME lookup, no fetch.
    {
      const d = JSON.parse(JSON.stringify(base));
      d.comps = { indication: 250590, best: three };
      sb._els.subjRepairs.value = '50000';
      sb.renderSubjectAnalysis(d, d.property.address);
      const html = sb._els.subjResult.innerHTML;
      // (250590-50000)*0.714 = 143221.26 -> 143221.
      check('5c Heavy repairs re-renders MAO', html.includes('$143,221') && html.includes('Heavy $50K'));
      check('5c render path makes ZERO fetches', sb._fetchCalls() === 0, 'fetchCalls=' + sb._fetchCalls());
    }
    // 5d. 1 comp -> AVM screen, MAO/LAO withheld.
    {
      const d = JSON.parse(JSON.stringify(base));
      d.comps = { indication: 250590, best: [three[0]] };
      sb._els.subjRepairs.value = '30000';
      sb.renderSubjectAnalysis(d, d.property.address);
      const html = sb._els.subjResult.innerHTML;
      check('5d fewer than 3 comps labelled AVM screen', html.includes('AVM screen — not airtight'));
      check('5d AVM value shown, indication NOT shown as ARV', html.includes('$254,226') && !html.includes('$250,590'));
      check('5d MAO/LAO withheld', html.includes('MAO/LAO withheld'));
    }
    // 5e. Unknown listing status -> unconfirmed note, not a silent pass.
    {
      const d = JSON.parse(JSON.stringify(base));
      delete d.property.onMarket; delete d.property.listingStatus;
      d.comps = { indication: 250590, best: three };
      sb.renderSubjectAnalysis(d, d.property.address);
      const html = sb._els.subjResult.innerHTML;
      check('5e unknown listing status flagged', html.includes('Listing status not confirmed'));
      check('5e unknown listing still comps (no false PASS)', !html.includes('PASS — Listed') && html.includes('$250,590'));
    }
  }

  // ---------- 6. cc-data.js: enrichHotLeads sorts hottest first (offline) ----------
  {
    const { enrichHotLeads } = require('./netlify/functions/cc-data.js')._test;
    const leads = [
      { stage: 'New Lead', createdAt: new Date(Date.now() - 5 * 86400 * 1000).toISOString(), contactId: null },
      { stage: 'Appointment Booked', createdAt: new Date().toISOString(), contactId: null },
      { stage: 'New Lead', createdAt: new Date().toISOString(), contactId: null },
    ];
    await enrichHotLeads(leads);
    check('6 enrichHotLeads scores all + sorts hottest first',
      leads[0].stage === 'Appointment Booked' && leads[0].score === 15 && leads[2].score === 0,
      JSON.stringify(leads.map((l) => l.score)));
  }

  // ---------- 7. Wiring checks on the shipped files ----------
  check('7 Closed Volume label, no Net Profit', ccHtml.includes('Closed Volume') && !ccHtml.includes('Net Profit'));
  check('7 statClosedVolume id, no statProfit', ccHtml.includes('statClosedVolume') && !ccHtml.includes('statProfit'));
  check('7 close-rate cap labelled with fetched count', ccHtml.includes('closeRateCapped') && ccHtml.includes("Close Rate · first '+(d.oppsFetched") && ccHtml.includes('oppsFetched'));
  check('7 feed errors surfaced + LIVE dot wired', ccHtml.includes('feedErrors') && ccHtml.includes('setFeedHealth') && ccHtml.includes('liveDot') && ccHtml.includes('liveLabel') && ccHtml.includes('DEGRADED'));
  check('7 enrich-all button + cost note present', ccHtml.includes('Enrich all visible leads') && ccHtml.includes('asks first, never auto-runs') && ccHtml.includes('Enriched this session'));
  const rhStart = ccHtml.indexOf('function renderHotLeads');
  const rhEnd = ccHtml.indexOf('let ccEnrichSessionCount');
  check('7 renderHotLeads itself contains no fetch call', rhStart > -1 && rhEnd > rhStart && !ccHtml.slice(rhStart, rhEnd).includes('fetch('));
  check('7 repairs choice Light/Medium/Heavy', ccHtml.includes('value="15000"') && ccHtml.includes('value="30000"') && ccHtml.includes('value="50000"'));
  check('7 hub nav links present', ccHtml.includes('closing-tracker.html') && ccHtml.includes('live-call.html') && ccHtml.includes('bread-hl.html') && ccHtml.includes('Master Buyers') && ccHtml.includes('Deal Rooms'));
  check('7 client-config branding wired', ccHtml.includes("/.netlify/functions/client-config") && ccHtml.includes('ccBrandLogo') && ccHtml.includes('ccBrandName'));
  check('7 offer-math module loaded', ccHtml.includes('<script src="assets/offer-math.js"></script>'));
  check('7 map neutral center, no hardcoded Indianapolis', ccHtml.includes('[39.8283,-98.5795]') && !ccHtml.includes('[39.7684,-86.1581]'));
  check('7 lead pins via free geocode', ccHtml.includes('nominatim.openstreetmap.org'));
  check('7 cc-data returns closedVolume, no netProfit', ccData.includes('closedVolume') && !ccData.includes('netProfit'));
  check('7 cc-data returns closeRateCapped', ccData.includes('closeRateCapped'));
  check('7 cc-data grid is top 9', ccData.includes('newLeads.slice(0, 9)'));
  check('7 enrichHotLeads sorts all leads', ccData.includes('targets.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))'));
  check('7 replies fetched in parallel chunks', ccData.includes('Promise.all(chunk.map') && ccData.includes('i += 8'));
  check('7 overview cached 30s', ccData.includes('OVERVIEW_CACHE_TTL_MS = 30000'));
  check('7 no server-side identifier renamed', ccData.includes('services.leadconnectorhq.com') && !ccHtml.includes('api.data-api.com') && !ccData.includes('api.data-api.com'));

  // ---------- 8. Booked Today: Itzhak 8:00 AM Nov 11 (fixture, no live HL) ----------
  // The miss: getBookedToday queried [now-12h, now+48h], so an 8:00 AM
  // appointment fell out of the window on any read after 8:00 PM the
  // same day — HL never returned it and the ET-day filter downstream
  // could not rescue it. Fixture feed replays the real case: Itzhak's
  // event was CREATED Nov 10 (dateAdded Nov 10) for 8:00 AM EST Nov 11
  // (13:00 UTC) on the Seller Calls calendar. The simulated HL step
  // keeps only events whose startTime falls in the queried window.
  {
    const { bookedTodayWindowMs, filterBookedTodayEvents } = require('./netlify/functions/cc-data.js')._test;
    const SELLER_CALLS = 'aG6lop6FROsWlIrB0Y0H';
    const LEGACY = 'hAEFM5imZV0djhRLNOas'; // Paula Thomas Event calendar (Sam books here)
    const nowMorning = Date.parse('2026-11-11T16:39:00.000Z'); // 11:39 AM EST — benchmark live-check time
    const nowEvening = Date.parse('2026-11-12T02:00:00.000Z'); // 9:00 PM EST Nov 11
    const feed = [
      { id: 'evt-itzhak', calendarId: SELLER_CALLS, appointmentStatus: 'confirmed', title: 'Seller call — Itzhak Bokobzha', startTime: '2026-11-11T13:00:00.000Z', dateAdded: '2026-11-10T20:32:00.000Z' },
      { id: 'evt-yesterday', calendarId: SELLER_CALLS, appointmentStatus: 'confirmed', title: 'Seller call — Yesterday', startTime: '2026-11-10T13:00:00.000Z' },
      { id: 'evt-legacy', calendarId: LEGACY, appointmentStatus: 'confirmed', title: 'Seller call — Legacy cal', startTime: '2026-11-11T14:00:00.000Z' },
      { id: 'evt-cancelled', calendarId: SELLER_CALLS, appointmentStatus: 'cancelled', title: 'Seller call — Cancelled', startTime: '2026-11-11T15:00:00.000Z' },
      { id: 'evt-invalid', calendarId: SELLER_CALLS, appointmentStatus: 'invalid', title: 'Seller call — Invalid', startTime: '2026-11-11T15:30:00.000Z' },
      { id: 'evt-nocal', appointmentStatus: 'confirmed', title: 'Seller call — No calendarId', startTime: '2026-11-11T16:00:00.000Z' },
    ];
    const inWindow = (e, w) => { const t = new Date(e.startTime).getTime(); return t >= w.startMs && t <= w.endMs; };
    const oldWindowMs = (nowMs) => ({ startMs: nowMs - 12 * 3600 * 1000, endMs: nowMs + 48 * 3600 * 1000 }); // pre-fix formula (removed)
    // Production passes the calendar explicitly (3rd arg); the filter
    // only enforces same-calendar when one is given.
    const countFor = (events, nowMs) => filterBookedTodayEvents(events, nowMs, SELLER_CALLS);
    const simulateFeed = (events, nowMs, windowFn) => countFor(events.filter((e) => inWindow(e, windowFn(nowMs))), nowMs);
    // 8a. REPRODUCES THE MISS: old window at 9 PM starts 09:00 EST — the 8:00 AM event is outside it, so HL never returns it and it is absent from the feed (later events still pass the window; the miss is specifically the early event dropping out).
    check('8a OLD window at 9 PM excludes the 8 AM event (the miss)', !inWindow(feed[0], oldWindowMs(nowEvening)) && !simulateFeed(feed, nowEvening, oldWindowMs).some((e) => e.id === 'evt-itzhak'),
      'oldStart=' + new Date(oldWindowMs(nowEvening).startMs).toISOString());
    // 8b. NEW window at 9 PM starts at ET midnight (04:00 UTC Nov 11 via the -04:00 pattern — 1h early in EST, filter is exact) and the event counts.
    const wEve = bookedTodayWindowMs(nowEvening);
    check('8b NEW window starts ET midnight, end now+48h unchanged',
      wEve.startMs === Date.parse('2026-11-11T04:00:00.000Z') && wEve.endMs === nowEvening + 48 * 3600 * 1000,
      JSON.stringify(wEve));
    check('8b NEW window at 9 PM includes the 8 AM event', inWindow(feed[0], wEve) && simulateFeed(feed, nowEvening, bookedTodayWindowMs).some((e) => e.id === 'evt-itzhak'));
    // 8c. Filter at the 11:39 AM benchmark read: 8 AM counts; yesterday / other-calendar / cancelled / invalid do not.
    const morningIds = countFor(feed, nowMorning).map((e) => e.id);
    check('8c 8 AM today counts, yesterday/other-calendar/cancelled/invalid do not',
      JSON.stringify(morningIds) === JSON.stringify(['evt-itzhak', 'evt-nocal']), JSON.stringify(morningIds));
    // 8d. Count is stable all day: same filter result at 9 PM as at 11:39 AM (morning appointments no longer vanish in the evening).
    const eveningIds = simulateFeed(feed, nowEvening, bookedTodayWindowMs).map((e) => e.id);
    check('8d evening read counts the same events as the morning read', JSON.stringify(eveningIds) === JSON.stringify(morningIds), JSON.stringify(eveningIds));
    // 8e. Created date is irrelevant: Itzhak was created Nov 10, happens Nov 11 — still counts.
    check('8e appointment created yesterday for today counts', morningIds.includes('evt-itzhak') && feed[0].dateAdded.startsWith('2026-11-10'));
    // 8f. Window is day-anchored, not now-anchored: same start at 11:39 AM and 9 PM.
    check('8f window start is day-anchored (same at morning and evening reads)',
      bookedTodayWindowMs(nowMorning).startMs === bookedTodayWindowMs(nowEvening).startMs);
    // 8g. Wiring: getBookedToday uses the window + filter helpers and no longer swallows an HL failure into a silent 0.
    const gbStart = ccData.indexOf('function getBookedToday(');
    const gbEnd = ccData.indexOf('\n}\n', gbStart);
    const gbBody = ccData.slice(gbStart, gbEnd);
    check('8g getBookedToday uses bookedTodayWindowMs + filterBookedTodayEvents', gbBody.includes('bookedTodayWindowMs(nowMs)') && gbBody.includes('filterBookedTodayEvents(raw, nowMs'));
    check('8g getBookedToday no longer swallows HL failures (.catch(() => null))', !gbBody.includes('.catch(() => null)'));
  }

  // ---------- 8. Workstream 3 (Nov 11): KPI dashboard, Hit List,
  //   Offer Mode math, Deal Sheet, ⌘K search, Under Contract strip ----------
  {
    const kpiFeed = {
      sellerReplies: 3, bookedToday: 1, underContract: 2,
      underContractDeals: [
        { address: '705 McDowell St, Greenville, NC 27834', name: 'Willard Gatlin', stage: 'Under Contract', monetaryValue: 60000, createdAt: new Date(Date.now() - 4 * 86400 * 1000).toISOString(), contactId: 'c1' },
        { address: '99 Deal Ave, Indianapolis, IN 46201', name: 'Second Deal', stage: 'Under Contract', monetaryValue: 85000, createdAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(), contactId: 'c2' },
      ],
      newLeadsCount: 3,
      newLeads: [
        { address: '111 Low St, Indianapolis, IN 46201', name: '111 Low St', stage: 'New Lead', createdAt: new Date(Date.now() - 5 * 86400 * 1000).toISOString(), score: 16, scoreLabel: 'COOL', scoreParts: { distress: 16, equity: 0, own: 0 }, scoreSource: 'crm', arv: null, mao: null, lao: null, listSignals: ['pre-foreclosure'], warnings: [] },
        { address: '222 Hot St, Indianapolis, IN 46201', name: '222 Hot St', stage: 'Appointment Booked', createdAt: new Date().toISOString(), score: 60, scoreLabel: 'HOT', scoreParts: { distress: 45, equity: 0, own: 8 }, scoreSource: 'crm', arv: 167876, mao: 117513, lao: 82259, listSignals: ['pre-foreclosure', 'tax delinquent'], warnings: ['solar loan'] },
        { address: '333 Mid St, Indianapolis, IN 46201', name: '333 Mid St', stage: 'New Lead', createdAt: new Date().toISOString(), score: 40, scoreLabel: 'WARM', scoreParts: { distress: 40, equity: 0, own: 0 }, scoreSource: 'crm', arv: null, mao: null, lao: null, listSignals: ['probate'], warnings: [] },
      ],
      closedCount: 4, closedVolume: 612000, closeRate: 4, closeRateCapped: true, totalOpps: 100,
      errors: { replies: null, booked: null, opps: null },
    };

    // 8a. computeKpis — pure; missing data is null + a "needs" note.
    {
      const fns = ['computeKpis'].map((n) => extractFn(ccHtml, n)).join('\n');
      const sb = makeSandbox();
      vm.runInContext(fns, sb);
      const k = sb.computeKpis(kpiFeed);
      check('8a cost per lead is null + names the missing spend feed', k.costPerLead.value === null && /spend feed/i.test(k.costPerLead.needs), JSON.stringify(k.costPerLead));
      check('8a cost per deal is null + names the missing feed', k.costPerDeal.value === null && /spend feed/i.test(k.costPerDeal.needs));
      check('8a per-rep is null + names the missing rep field', k.perRep.value === null && /rep/i.test(k.perRep.needs) && /no owner\/rep field/i.test(k.perRep.needs), JSON.stringify(k.perRep));
      check('8a close rate computed + capped', k.closeRate.value === 4 && k.closeRate.capped === true && /first 100 opps/.test(k.closeRate.label));
      check('8a deals by stage from feed counts', k.dealsByStage.isNew === 3 && k.dealsByStage.underContract === 2 && k.dealsByStage.closed === 4 && k.dealsByStage.total === 100);
      check('8a per-source counts by signal (no ROI invented)', k.perSource.length === 3 && k.perSource[0].signal === 'pre-foreclosure' && k.perSource[0].leads === 2 && k.perSource.every((r) => r.spend === null && r.roi === null), JSON.stringify(k.perSource));
      check('8a known fixed costs stated, not computed as KPI', /129\/mo/.test(k.knownCosts) && /0\.021/.test(k.knownCosts));
      const kn = sb.computeKpis(null);
      check('8a null feed -> everything missing, nothing $0', kn.costPerLead.value === null && kn.closeRate.value === null && kn.closedVolume.value === null && kn.closedCount.value === null && kn.perRep.value === null);
      check('8a computeKpis contains no fetch (pure)', !fns.includes('fetch('));
    }

    // 8b. renderKpis — "—" not $0 when data is missing.
    {
      const fns = ['esc', 'fmtMoney', 'computeKpis', 'renderKpis'].map((n) => extractFn(ccHtml, n)).join('\n');
      const sb = makeSandbox();
      vm.runInContext(fns, sb);
      sb.renderKpis(null);
      const html = sb._elCache.kpiGrid.innerHTML;
      check('8b missing feed renders dashes, never $0', html.includes('—') && !html.includes('$0'), html.slice(0, 200));
      check('8b missing feed names the missing sources', /spend feed/i.test(html) && /rep/i.test(html));
      sb.renderKpis(kpiFeed);
      const html2 = sb._elCache.kpiGrid.innerHTML;
      check('8b live feed renders close rate + closed volume', html2.includes('4%') && html2.includes('$612,000'));
      check('8b live feed still dashes cost per lead/deal', (html2.match(/Cost per Lead[\s\S]{0,200}?—/) || []).length === 1 && (html2.match(/Cost per Deal[\s\S]{0,200}?—/) || []).length === 1);
      check('8b stage bars show counts', sb._elCache.stageBars.innerHTML.includes('>3<') && sb._elCache.stageBars.innerHTML.includes('>2<') && sb._elCache.stageBars.innerHTML.includes('>4<'));
      check('8b stage cap labelled first 100 opps', String(sb._elCache.stageCapLabel.textContent).includes('first 100 opps'));
      check('8b source rows list signals, spend/ROI dashed', sb._elCache.sourceRows.innerHTML.includes('pre-foreclosure') && sb._elCache.sourceRows.innerHTML.includes('no spend feed'));
    }

    // 8c. renderContractStrip — deals shown; pipeline failure labelled.
    {
      const fns = ['esc', 'fmtMoney', 'timeAgo', 'renderContractStrip'].map((n) => extractFn(ccHtml, n)).join('\n');
      const sb = makeSandbox();
      vm.runInContext(fns, sb);
      sb.renderContractStrip(kpiFeed.underContractDeals, null);
      const html = sb._elCache.ucStrip.innerHTML;
      check('8c strip shows both contract deals', html.includes('705 McDowell St') && html.includes('99 Deal Ave'));
      check('8c strip shows contract values', html.includes('$60,000') && html.includes('$85,000'));
      check('8c strip chips open Deal Sheet', html.includes('openDealSheetContract(0)') && html.includes('openDealSheetContract(1)'));
      sb.renderContractStrip([], 'HL 500: pipelines down');
      check('8c pipeline failure labelled, not silent empty', sb._elCache.ucStrip.innerHTML.includes('Stage names unavailable') && sb._elCache.ucStrip.innerHTML.includes('pipelines down'));
      sb.renderContractStrip([], null);
      check('8c no contracts labelled honestly', sb._elCache.ucStrip.innerHTML.includes('No deals under contract'));
    }

    // 8d. renderHitList — hottest first, top 5, values or dashes.
    {
      const fns = ['esc', 'fmtMoney', 'scoreClass', 'calcMAO', 'resolveLeadValues', 'renderHotLeads', 'renderHitList'].map((n) => extractFn(ccHtml, n)).join('\n');
      const sb = makeSandbox();
      vm.runInContext(fns, sb);
      sb.renderHitList(kpiFeed.newLeads);
      const html = sb._elCache.hitListBody.innerHTML;
      const iHot = html.indexOf('222 Hot St'), iMid = html.indexOf('333 Mid St'), iLow = html.indexOf('111 Low St');
      check('8d hit list hottest first', iHot > -1 && iHot < iMid && iMid < iLow, `hot=${iHot} mid=${iMid} low=${iLow}`);
      check('8d hit list ranks #1-#3', html.includes('#1') && html.includes('#2') && html.includes('#3'));
      check('8d comped lead shows ARV/MAO/LAO', html.includes('$167,876') && html.includes('$117,513') && html.includes('$82,259'));
      check('8d uncomped lead shows dashes, no $0', html.includes('>—<') && !html.includes('$0'));
      check('8d Offer + Sheet buttons per row', html.includes('openOfferModeLead(0)') && html.includes('openDealSheetLead(0)'));
      check('8d warnings surfaced', html.includes('solar loan'));
      // Six leads -> only top 5 render.
      const six = kpiFeed.newLeads.concat([
        { address: '444 Extra St, Indianapolis, IN 46201', name: '444 Extra St', stage: 'New Lead', createdAt: new Date().toISOString(), score: 10, scoreLabel: 'COLD', scoreParts: {}, scoreSource: 'crm', arv: null, mao: null, lao: null, listSignals: [], warnings: [] },
        { address: '555 Extra St, Indianapolis, IN 46201', name: '555 Extra St', stage: 'New Lead', createdAt: new Date().toISOString(), score: 12, scoreLabel: 'COLD', scoreParts: {}, scoreSource: 'crm', arv: null, mao: null, lao: null, listSignals: [], warnings: [] },
        { address: '666 Extra St, Indianapolis, IN 46201', name: '666 Extra St', stage: 'New Lead', createdAt: new Date().toISOString(), score: 14, scoreLabel: 'COLD', scoreParts: {}, scoreSource: 'crm', arv: null, mao: null, lao: null, listSignals: [], warnings: [] },
      ]);
      sb.renderHitList(six);
      const html6 = sb._elCache.hitListBody.innerHTML;
      check('8d hit list caps at 5', html6.includes('#5') && !html6.includes('#6') && !html6.includes('444 Extra St'));
      sb.renderHitList([]);
      check('8d empty hit list labelled', sb._elCache.hitListBody.innerHTML.includes('No leads to rank'));
    }

    // 8e. offerCalc — tier math at every boundary, LAO = MAO x 0.70.
    {
      const fns = ['calcMAO', 'offerCalc'].map((n) => extractFn(ccHtml, n)).join('\n');
      // No OfferMath in this sandbox -> pure tier path.
      const sb = makeSandbox({ OfferMath: undefined });
      vm.runInContext(fns, sb);
      const t = (arv, rep) => sb.offerCalc(arv, rep, null);
      check('8e tier <120K is 70%', t(100000, 15000).mao === 59500 && t(100000, 15000).lao === 41650, JSON.stringify(t(100000, 15000)));
      check('8e tier 120-220K is 80%', t(200000, 30000).mao === 136000 && t(200000, 30000).lao === 95200);
      check('8e tier 220-300K is 81.5%', t(250000, 30000).mao === 179300 && t(250000, 30000).lao === 125510);
      check('8e tier 300-400K is 82.9%', t(350000, 50000).mao === 248700 && t(350000, 50000).lao === 174090);
      check('8e tier 400K+ is 84.9%', t(450000, 50000).mao === 339600 && t(450000, 50000).lao === 237720);
      check('8e boundary 119,999 vs 120,000', t(119999, 0).mao === Math.round(119999 * 0.70) && t(120000, 0).mao === Math.round(120000 * 0.80));
      check('8e null ARV -> nulls, no $0', t(null, 30000).mao === null && t(null, 30000).lao === null);
      check('8e zero/negative ARV -> nulls', t(0, 30000).mao === null && t(-50000, 30000).mao === null);
      // With the OfferMath stub, Indianapolis calibration applies.
      const sb2 = makeSandbox();
      vm.runInContext(fns, sb2);
      const cal = sb2.offerCalc(250590, 30000, 'Indianapolis');
      check('8e Indianapolis calibration lowers MAO (0.714)', cal.mao === 157501 && cal.lao === 110251 && /calibrated/.test(cal.label), JSON.stringify(cal));
      const uncal = sb2.offerCalc(250590, 30000, null);
      check('8e unknown market falls back to tier 80%', uncal.mao === 176472, JSON.stringify(uncal));
    }

    // 8f. buildDealSheetData + renderDealSheet — print view renders.
    {
      const fns = ['esc', 'fmtMoney', 'buildDealSheetData', 'renderDealSheet'].map((n) => extractFn(ccHtml, n)).join('\n');
      const sb = makeSandbox();
      vm.runInContext(fns, sb);
      const sheet = sb.buildDealSheetData({
        address: '222 Hot St, Indianapolis, IN 46201', stage: 'Appointment Booked',
        score: 600, scoreLabel: 'HOT', arv: 167876, arvSource: 'Written in HighLevel (comp project)',
        mao: 117513, lao: 82259, maoLabel: '80% tier', repairsLabel: 'Medium $30K',
        listed: false, comps: [
          { address: '220 Hot St, Indianapolis, IN 46201', amount: 165000, date: '2026-08-15' },
          { address: '224 Hot St, Indianapolis, IN 46201', amount: 170000, date: '2026-09-02' },
          { address: '218 Hot St, Indianapolis, IN 46201', amount: 168000, date: '2026-07-20' },
        ],
        buyerMatches: [
          { name: 'Indy Flip LLC', city: 'Indianapolis', state: 'IN', phone: '3175550100', avgPurchase: 150000, score: 820, label: 'BEST MATCH', reasons: ['Same city (+210)', 'Price fit (+240)'] },
        ],
      });
      check('8f sheet carries address/ARV/MAO/LAO', sheet.address.includes('222 Hot St') && sheet.arv === 167876 && sheet.mao === 117513 && sheet.lao === 82259);
      check('8f sheet carries 3 comps + 1 buyer match', sheet.comps.length === 3 && sheet.buyerMatches.length === 1);
      sb.renderDealSheet(sheet);
      const modal = sb._elCache.dealSheetBody.innerHTML;
      const print = sb._elCache.dealSheetPrint.innerHTML;
      check('8f modal renders address + ARV + MAO/LAO', modal.includes('222 Hot St') && modal.includes('$167,876') && modal.includes('$117,513') && modal.includes('$82,259'));
      check('8f modal renders comps', modal.includes('220 Hot St') && modal.includes('$165,000'));
      check('8f modal renders buyer match', modal.includes('Indy Flip LLC') && modal.includes('BEST MATCH') && modal.includes('3175550100'));
      check('8f print copy renders the same facts', print.includes('222 Hot St') && print.includes('$167,876') && print.includes('Indy Flip LLC'));
      check('8f no $0 anywhere in sheet', !modal.includes('$0') && !print.includes('$0'));
      // No comps, no buyers, no ARV -> honest dashes.
      const bare = sb.buildDealSheetData({ address: '99 Deal Ave, Indianapolis, IN 46201', stage: 'Under Contract', contractValue: 85000, buyerMatches: null, buyerMatchesNote: 'Buyer matches unavailable — the buyer index did not load.' });
      sb.renderDealSheet(bare);
      const bareHtml = sb._elCache.dealSheetBody.innerHTML;
      check('8f bare sheet dashes ARV/MAO/LAO, shows contract value', bareHtml.includes('>—<') && bareHtml.includes('$85,000') && !bareHtml.includes('$0'));
      check('8f bare sheet explains missing comps + buyers', bareHtml.includes('No comps loaded') && bareHtml.includes('Buyer matches unavailable'));
      // Listed sheet shows PASS, never an offer.
      const listed = sb.buildDealSheetData({ address: '1 Listed Way, Indianapolis, IN 46201', arv: 200000, mao: 136000, lao: 95200, listed: true, comps: [] });
      sb.renderDealSheet(listed);
      check('8f listed sheet shows PASS, no MAO/LAO numbers', sb._elCache.dealSheetBody.innerHTML.includes('PASS — Listed') && sb._elCache.dealSheetBody.innerHTML.includes('— PASS —'));
    }

    // 8g. ⌘K search — pure, client-side, capped, case-insensitive.
    {
      const fns = ['cmdkSearch'].map((n) => extractFn(ccHtml, n)).join('\n');
      const sb = makeSandbox();
      vm.runInContext(fns, sb);
      const idx = {
        leads: kpiFeed.newLeads,
        deals: kpiFeed.underContractDeals,
        buyers: [
          { n: 'Indy Flip LLC', c: 'Indianapolis', s: 'IN', z: '46201', p: '3175550100', ap: 150000 },
          { n: 'Cincy Buyers Inc', c: 'Cincinnati', s: 'OH', z: '45201', p: '5135550100', ap: 90000 },
          { n: 'Indy Landlord Co', c: 'Indianapolis', s: 'IN', z: '46237', p: '3175550200', ap: 120000 },
        ],
      };
      const r1 = sb.cmdkSearch('hot st', idx);
      check('8g matches lead by address substring', r1.leads.length === 1 && r1.leads[0].address.includes('222 Hot St'));
      const r2 = sb.cmdkSearch('MCDOWELL', idx);
      check('8g case-insensitive deal match', r2.deals.length === 1 && r2.deals[0].address.includes('McDowell'));
      const r3 = sb.cmdkSearch('indianapolis', idx);
      check('8g buyer match by city', r3.buyers.length === 2 && r3.buyers.every((b) => (b.c || '').toLowerCase() === 'indianapolis'));
      const r4 = sb.cmdkSearch('3175550100', idx);
      check('8g buyer match by phone', r4.buyers.length === 1 && r4.buyers[0].n === 'Indy Flip LLC');
      check('8g short/empty query returns nothing', sb.cmdkSearch('', idx).leads.length === 0 && sb.cmdkSearch('x', idx).buyers.length === 0);
      check('8g no match returns empty groups', sb.cmdkSearch('zzzzqq', idx).leads.length === 0 && sb.cmdkSearch('zzzzqq', idx).deals.length === 0 && sb.cmdkSearch('zzzzqq', idx).buyers.length === 0);
      // Cap at 8 per group.
      const many = { leads: [], deals: [], buyers: [] };
      for (let i = 0; i < 12; i++) many.buyers.push({ n: 'Buyer ' + i + ' Indianapolis', c: 'Indianapolis', s: 'IN', p: '317000000' + i });
      check('8g buyer results capped at 8', sb.cmdkSearch('indianapolis', many).buyers.length === 8);
      check('8g cmdkSearch contains no fetch (client-side only)', !fns.includes('fetch('));
    }

    // 8h. Deal Sheet buyer matches are REAL — rankBuyers on the real
    //   module with master-buyers-shaped fixtures.
    {
      const { rankBuyers } = require('./assets/buyer-match-score.js');
      const buyers = [
        { n: 'Indy Flip LLC', p: '3175550100', c: 'Indianapolis', s: 'IN', z: '46201', pc: 12, ap: 150000, pv: 1800000, fl: 6, st: 'Flipper' },
        { n: 'Cincy Buyers Inc', p: '5135550100', c: 'Cincinnati', s: 'OH', z: '45201', pc: 3, ap: 90000, pv: 270000, fl: 2, st: 'Flipper' },
        { n: 'Indy Landlord Co', p: '3175550200', c: 'Indianapolis', s: 'IN', z: '46237', pc: 40, ap: 120000, pv: 4800000, fl: 0, st: 'Landlord' },
      ];
      const ranked = rankBuyers({ city: 'Indianapolis', state: 'IN', zip: '46201', price: 150000, propertyType: '' }, buyers);
      check('8h rankBuyers ranks Indianapolis buyers above Cincinnati', ranked[0].buyer.n !== 'Cincy Buyers Inc' && ranked[2].buyer.n === 'Cincy Buyers Inc', JSON.stringify(ranked.map((r) => r.buyer.n + ':' + r.match.score)));
      check('8h scores bounded 0-1000 with reasons', ranked.every((r) => r.match.score >= 0 && r.match.score <= 1000 && Array.isArray(r.match.topReasons) && r.match.topReasons.length > 0));
      check('8h top match carries a tier label', typeof ranked[0].match.label === 'string' && ranked[0].match.label.length > 0);
    }

    // 8i. Wiring checks on the shipped page.
    check('8i KPI panel + grid ids present', ccHtml.includes('id="kpiPanel"') && ccHtml.includes('id="kpiGrid"') && ccHtml.includes('id="stageBars"') && ccHtml.includes('id="sourceRows"'));
    check('8i Hit List panel present', ccHtml.includes('Hit List') && ccHtml.includes('id="hitListBody"'));
    check('8i Under Contract strip present', ccHtml.includes('id="ucStrip"') && ccHtml.includes('Under Contract'));
    check('8i Offer Mode modal + subject button present', ccHtml.includes('id="offerModal"') && ccHtml.includes('openOfferModeSubject') && ccHtml.includes('id="offerRepairs"'));
    check('8i Deal Sheet modal + print section present', ccHtml.includes('id="dealSheetModal"') && ccHtml.includes('id="dealSheetPrint"') && ccHtml.includes('window.print()'));
    check('8i print stylesheet hides everything but the sheet', ccHtml.includes('@media print') && ccHtml.includes('#dealSheetPrint') && ccHtml.includes('visibility:hidden'));
    check('8i ⌘K overlay + shortcut listener present', ccHtml.includes('id="cmdkOverlay"') && ccHtml.includes('id="cmdkInput"') && ccHtml.includes("toLowerCase()==='k'") && ccHtml.includes('cmdkOpen()'));
    check('8i buyer-match-score.js loaded', ccHtml.includes('<script src="assets/buyer-match-score.js"></script>'));
    check('8i buyer index lazy-loads (no page-load fetch of it)', ccHtml.includes("s.src='assets/master-buyers.js'") && !ccHtml.includes('<script src="assets/master-buyers.js">'));
    check('8i loadOverview wires KPI + strip + Hit List', ccHtml.includes('renderKpis(d)') && ccHtml.includes('renderContractStrip(d.underContractDeals') && ccHtml.includes('renderHitList(window._ccLeadCards'));
    check('8i no new live lookups in the new renderers', !ccHtml.slice(ccHtml.indexOf('function renderKpis'), ccHtml.indexOf('function renderContractStrip')).includes('fetch('));
    check('8i honesty: no Net Profit anywhere', !ccHtml.includes('Net Profit'));
  }

  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('ALL command-center resale regression tests PASS');
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

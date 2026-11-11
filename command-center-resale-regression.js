// Regression tests for the Command Center resale fixes (Nov 11, 2026):
// Blocker 1 — no auto credit burn (renderHotLeads never fetches; enrichment
//   is explicit, confirmed, cached); Blocker 2 — listing-first gate, AVM
//   never presented as ARV, 3-comp minimum, repairs choice + Indianapolis
//   calibration; Blocker 4 — "Closed Volume" (not Net Profit), Close Rate
//   labelled as first-100-opps when capped, feed errors surfaced + LIVE
//   dot tied to feed health. Plus: hottest-first sorting, hub nav,
//   client-config branding, neutral map center + real lead pins.
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
  const sandbox = {
    console,
    document: {
      getElementById: (id) => {
        if (id === 'leadsGrid') return grid;
        if (id === 'subjResult') return subjResult;
        if (id === 'subjRepairs') return subjRepairs;
        if (id === 'enrichAllCount') return enrichAllCount;
        if (id === 'enrichCount') return enrichCount;
        return { textContent: '', innerHTML: '', style: {} };
      },
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
  check('7 close-rate cap labelled', ccHtml.includes('closeRateCapped') && ccHtml.includes('first 100 opps'));
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

  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('ALL command-center resale regression tests PASS');
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

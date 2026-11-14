/* BuyerVault §5A Command Center wiring — regression tests.
   Covers: exported snapshot integrity (real counts from the owned DBs),
   market resolution, the job builder's credit gate, the HighLevel sync
   gate (OFF by default, qualification gate, bv-* tag namespace), saved-
   market cadence math, the function handlers end-to-end against the
   in-memory store fallback, and the index.html wiring.
   Fixtures are REAL rows from the exported snapshot. Zero credits, zero
   network, zero HighLevel calls. Run: node buyervault-regression.js */
'use strict';

process.env.DASHBOARD_PASSWORD = 'buyervault-regression-secret';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const F = (n) => path.join(__dirname, 'netlify', 'functions', n);
const loadJson = (n) => JSON.parse(fs.readFileSync(F(n), 'utf8'));

const meta = loadJson('buyervault-meta.json');
const marketsFile = loadJson('buyervault-markets.json');
const candFL = loadJson('buyervault-candidates-fl.json');
const candNC = loadJson('buyervault-candidates-nc.json');
const entities = loadJson('buyervault-entities.json');
const syncIndex = loadJson('buyervault-sync-index.json');
const lib = require(F('buyervault-lib.js'));

console.log('buyervault regression:');

/* ---------- exported snapshot integrity ---------- */
t('meta counts match the exported files',
  meta.sources.candidatesFL.rows === candFL.length
  && meta.sources.candidatesNC.rows === candNC.length
  && meta.sources.entities.rows === entities.length
  && meta.markets === marketsFile.markets.length);
t('master snapshot is the post-FL-merge master (34,683 / 24,629)',
  meta.sources.masterBuyers.buyers === 34683 && meta.sources.masterBuyers.qualified === 24629,
  JSON.stringify(meta.sources.masterBuyers));
t('candidate rows carry all 11 fields', candFL.every((r) => r.length === 11) && candNC.every((r) => r.length === 11));
t('NC candidates have NO prices (NC OneMap publishes none) — null, never invented',
  candNC.every((r) => r[6] === null && r[7] === null));
t('Duval County candidate count = 7,481 (every county a candidate buys in)',
  candFL.filter((r) => (r[2] || '').split(',').map((s) => s.trim()).includes('Duval')).length === 7481);
t('entities: 15,998 exported, 15,826 with a registered agent',
  entities.length === 15998 && entities.filter((e) => e.agent).length === 15826);
t('entity linked counts are consistent (array <= count, docs exist in set)',
  (() => {
    const docs = new Set(entities.map((e) => e.doc));
    return entities.every((e) => e.linkedAgent.length <= e.linkedAgentCount
      && e.linkedAddress.length <= e.linkedAddressCount
      && e.linkedAgent.every((x) => docs.has(x.doc))
      && e.linkedAddress.every((x) => docs.has(x.doc)));
  })());
t('sync index: phone buyers only, every phone 10 digits, qualified flags 0/1',
  syncIndex.length > 20000 && syncIndex.every((r) => /^\d{10}$/.test(r[1]) && (r[11] === 0 || r[11] === 1)));

/* ---------- market resolution (§6.2) ---------- */
const res = (q) => lib.resolveMarket(marketsFile, q);
t('resolve "Indianapolis" -> city market', (res('Indianapolis').match || {}).key === 'city:indianapolis|IN');
t('resolve "Indianapolis, IN" -> same market', (res('Indianapolis, IN').match || {}).key === 'city:indianapolis|IN');
t('resolve ZIP 46201 -> Indianapolis via ZIP map', (res('46201').match || {}).key === 'city:indianapolis|IN');
t('resolve "Duval County, FL" -> county market', (res('Duval County, FL').match || {}).key === 'county:duval|FL');
t('resolve "Kansas City" -> Kansas City, MO', (res('Kansas City').match || {}).key === 'city:kansas city|MO');
t('resolve unknown market -> null match (honest empty state)', res('Nowhereville, ZZ').match === null);
const duval = marketsFile.markets.find((m) => m.key === 'county:duval|FL');
t('Duval summary counts are real (7,481 candidates)', duval && duval.candidates === 7481, duval && String(duval.candidates));

/* ---------- job builder + credit gate (§6.4/§6.5, HARD RULE B) ---------- */
const indy = marketsFile.markets.find((m) => m.key === 'city:indianapolis|IN');
const job = lib.buildJob(indy, 'manual', meta);
t('job: stored runs succeed with real counts',
  job.runs.find((r) => r.source === 'master_buyers').recordsSeen === indy.buyers);
t('job: external pulls are blocked_budget with the credit-gate reason',
  job.runs.filter((r) => r.state === 'blocked_budget').length === 2
  && job.runs.every((r) => r.state !== 'blocked_budget' || /credit gate/i.test(r.errorMessage)));
t('job: zero credits spent, state partial (blocked runs are visible, not hidden)',
  job.creditsSpent === 0 && job.state === 'partial' && job.runs.every((r) => r.creditsSpent === 0));
t('job: event feed records discoveries + the gate holds',
  job.events.some((e) => e.type === 'buyer_discovered') && job.events.some((e) => e.type === 'run_blocked_budget'));
const jobDuval = lib.buildJob(duval, 'search', meta);
t('job: Duval candidate + Sunbiz runs succeed with real counts',
  jobDuval.runs.find((r) => r.source === 'buyer_candidates').recordsSeen === 7481
  && jobDuval.runs.find((r) => r.source === 'sunbiz_entities').recordsSeen === duval.entitiesLinked);

/* ---------- saved-market cadence math (§6.6) ---------- */
const savedFixture = { cadence: 'weekly', createdAt: '2026-11-01T00:00:00.000Z', lastRefreshedAt: '2026-11-10T00:00:00.000Z' };
t('nextDueAt: weekly = last refresh + 7d', lib.nextDueAt(savedFixture) === '2026-11-17T00:00:00.000Z');
t('nextDueAt: paused = null', lib.nextDueAt({ cadence: 'paused', createdAt: savedFixture.createdAt }) === null);
t('monitoringStatus: past due -> due; future -> monitoring; paused -> paused',
  lib.monitoringStatus(savedFixture, Date.parse('2026-11-18T00:00:00Z')) === 'due'
  && lib.monitoringStatus(savedFixture, Date.parse('2026-11-12T00:00:00Z')) === 'monitoring'
  && lib.monitoringStatus({ cadence: 'paused', createdAt: savedFixture.createdAt }, Date.now()) === 'paused');

/* ---------- HL sync gate (§5 gate + §16, TEST/OFF) ---------- */
const cfgDefault = lib.syncConfig(null);
t('sync config ships OFF with the spec-recommended 60 threshold (undecided, not applied live)',
  cfgDefault.enabled === false && cfgDefault.minScore === 60);
t('syncGate blocks the default config', /OFF/.test(lib.syncGate(cfgDefault) || ''));
t('syncGate still blocks when enabled without the Netlify env flag',
  /env flag/.test(lib.syncGate(lib.syncConfig({ enabled: true })) || ''));
// sync-index row: [name, phone, score, tier, strategy, city, state, props, avgPurchase, portfolioValue, likelyWholesaler, qualified]
const goodRow = ['Test Buyer LLC', '3175551234', 75, 'B - Solid buyer', 'Flipper+Landlord', 'Indianapolis', 'IN', 10, 150000, 900000, 0, 1];
t('eligibility: qualified + score 75 + phone + buy box -> eligible',
  lib.syncEligibility(goodRow, cfgDefault).eligible === true);
t('eligibility: likely wholesaler is excluded [HARD RULE D]',
  lib.syncEligibility([...goodRow.slice(0, 10), 1, 1], cfgDefault).eligible === false);
t('eligibility: lender-only is excluded [HARD RULE D]',
  lib.syncEligibility(['Lender Co', '3175551234', 90, 'A', 'Lender', 'Indianapolis', 'IN', 5, 100000, 1, 0, 1], cfgDefault).eligible === false);
t('eligibility: score below threshold is excluded',
  lib.syncEligibility([...goodRow.slice(0, 2), 40, ...goodRow.slice(3)], cfgDefault).eligible === false);
t('eligibility: not qualified (no buy box evidence) is excluded',
  lib.syncEligibility([...goodRow.slice(0, 11), 0], cfgDefault).eligible === false);
t('eligibility: no purchases at all is excluded (no evidence buy box)',
  lib.syncEligibility(['Thin Buyer', '3175551234', 90, 'A', 'Flipper', 'Indianapolis', 'IN', 0, 0, 0, 0, 1], cfgDefault).eligible === false);
const prev = lib.syncPreview(syncIndex, cfgDefault, 25);
t('preview over the real index: eligible is a real subset (0 < eligible < total)',
  prev.eligible > 0 && prev.eligible < prev.total && prev.sample.length === 25,
  `eligible=${prev.eligible} total=${prev.total}`);
t('preview: every sampled buyer passes the gate itself',
  prev.sample.every((s) => s.score >= 60 && /^\d{10}$/.test(s.phone)));
const payload = lib.ghlPayload(goodRow, '18097');
t('GHL payload: tags live ONLY in the bv-* namespace [HARD RULE I]',
  payload.tags.length >= 2 && payload.tags.every((x) => x.startsWith('bv-')));
t('GHL payload: phone is E.164, custom fields are the §16.3 set',
  payload.phone === '+13175551234' && 'bv_quality_score' in payload.customFields && 'bv_strategy' in payload.customFields);
const syncSrc = fs.readFileSync(F('buyervault-sync.js'), 'utf8');
t('sync function ships NO live HighLevel transport (no leadconnector fetch)',
  !/leadconnectorhq|services\.leadconnector/i.test(syncSrc));

/* ---------- frontend helpers ---------- */
const BV = require(path.join(__dirname, 'assets', 'buyervault.js'));
const H = BV.helpers;
t('helpers: missing values render as a dash, never a fake number',
  H.dash(null) === '—' && H.money(0) === '—' && H.money(null) === '—' && H.count(null) === '—');
t('helpers: money/count formatting', H.money(169100) === '$169,100' && H.count(34101) === '34,101' && H.shortMoney(11332499018) === '$11.3B');
t('helpers: run state pills label the credit gate honestly',
  /credit gate/i.test(H.runStatePill('blocked_budget')) && /Succeeded/.test(H.runStatePill('succeeded')));
t('helpers: jobProgress counts finished runs', H.jobProgress({ runs: [{ state: 'succeeded' }, { state: 'blocked_budget' }, { state: 'queued' }] }) === 67);
t('helpers: saved status labels', H.savedStatusLabel({ cadence: 'paused' }) === 'Paused' && H.savedStatusLabel({ cadence: 'weekly' }) === 'Never refreshed');

/* Phone display (Nov 13 fix, Troy's Tampa screenshot): DNC is per-NUMBER.
   Real Tampa rows from buyers-data: the #1 buyer (84 props) lists a DNC
   mobile first but holds a clean third number; Nnn Reit LP lists a DNC
   landline first with two clean numbers behind it. */
t('phone picker: skips a DNC first number for the clean one behind it',
  H.pickPrimaryPhone([{ phone: '6463725096', type: 'Mobi', dnc: true },
    { phone: '5166062503', type: 'Mobi', dnc: true },
    { phone: '5166060625', type: 'Mobi', dnc: false }]).phone === '5166060625'
  && H.pickPrimaryPhone([{ phone: '4074403620', type: 'Land', dnc: true },
    { phone: '4073705290', type: 'Land', dnc: false }]).phone === '4073705290');
t('phone picker: prefers a clean mobile over a clean landline',
  H.pickPrimaryPhone([{ phone: '111', type: 'Land', dnc: false },
    { phone: '222', type: 'Mobi', dnc: false }]).phone === '222');
t('phone picker: all-DNC falls back to the first number; empty stays null',
  H.pickPrimaryPhone([{ phone: '6129631331', type: 'Mobi', dnc: true }]).phone === '6129631331'
  && H.pickPrimaryPhone([]) === null && H.pickPrimaryPhone(null) === null);
t('phone flags: DNC stamp only when EVERY number is DNC',
  H.allPhonesDnc([{ phone: '1', dnc: true }, { phone: '2', dnc: true }]) === true
  && H.allPhonesDnc([{ phone: '1', dnc: true }, { phone: '2', dnc: false }]) === false
  && H.allPhonesDnc([]) === false
  && H.cleanPhoneCount([{ phone: '1', dnc: true }, { phone: '2', dnc: false }, { phone: '3', dnc: false }]) === 2);

/* ---------- buyer rows are clickable + phone render source checks ---------- */
const bvSrc = fs.readFileSync(path.join(__dirname, 'assets', 'buyervault.js'), 'utf8');
t('buyervault.js: buyer names open the buyer detail panel',
  bvSrc.includes('BuyerVaultUI.buyerDetail(') && bvSrc.includes('buyerDetail: buyerDetail')
  && bvSrc.includes('id="bvBuyerDetail"'));
t('buyervault.js: list renders the picked clean phone, never raw phones[0]',
  bvSrc.includes('pickPrimaryPhone(x.phones)') && !bvSrc.includes('x.phones[0].phone'));

/* ---------- index.html wiring ---------- */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
t('index.html: BuyerVault nav + page + assets wired',
  html.includes('data-nav="buyervault"') && html.includes('id="page-buyervault"')
  && html.includes('assets/buyervault.js') && html.includes('assets/buyervault.css'));
t('index.html: showPage inits BuyerVault; CMDK lists it',
  html.includes("name === 'buyervault'") && html.includes("['buyervault','🗄️ BuyerVault']"));
t('index.html: buyer count literals agree (statBuyers + mbCount = 34,683)',
  html.includes("statBuyers').textContent = '34,683'") && html.includes('id="mbCount">34,683 BUYERS'));

/* ---------- function handlers (in-memory fallback, no network) ---------- */
function adminEvent(method, body) {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const sig = crypto.createHmac('sha256', process.env.DASHBOARD_PASSWORD).update(expiry).digest('hex');
  return {
    httpMethod: method, headers: { cookie: `lm_auth=${expiry}.${sig}` },
    queryStringParameters: {}, body: body ? JSON.stringify(body) : null,
  };
}
function anonEvent(method, qs) {
  return { httpMethod: method, headers: {}, queryStringParameters: qs || {}, body: null };
}

(async () => {
  const marketsFn = require(F('buyervault-markets.js')).handler;
  let r = await marketsFn(anonEvent('GET', { action: 'resolve', q: 'Indianapolis' }));
  let b = JSON.parse(r.body);
  t('handler markets: resolve Indianapolis + freshness stamp', r.statusCode === 200 && b.match.key === 'city:indianapolis|IN' && !!b.dataAsOf);
  r = await marketsFn(anonEvent('GET', { action: 'buyers', market: 'city:indianapolis|IN', limit: '5' }));
  b = JSON.parse(r.body);
  t('handler markets: Indianapolis buyers are real master rows', b.total > 500 && b.buyers.length === 5 && !!b.buyers[0].name);
  r = await marketsFn(anonEvent('GET', { action: 'candidates', market: 'county:duval|FL', limit: '3' }));
  b = JSON.parse(r.body);
  t('handler markets: Duval candidates total 7,481, no phones attached', b.total === 7481 && b.candidates.every((c) => c.hasPhone === false));
  r = await marketsFn(anonEvent('GET', { action: 'buyers', market: 'county:duval|FL' }));
  b = JSON.parse(r.body);
  t('handler markets: county markets never present statewide buyers as county buyers', b.total === 0);

  const entitiesFn = require(F('buyervault-entities.js')).handler;
  r = await entitiesFn(anonEvent('GET', { action: 'search', q: 'PULTE' }));
  b = JSON.parse(r.body);
  t('handler entities: search finds Sunbiz entities by name', b.total >= 1 && b.entities[0].doc);
  const doc = b.entities[0].doc;
  r = await entitiesFn(anonEvent('GET', { action: 'detail', doc }));
  b = JSON.parse(r.body);
  t('handler entities: detail carries agent + link basis disclosure',
    !!b.entity && 'agent' in b.entity && /not proof of common ownership/i.test(b.linkBasis || ''));

  const jobsFn = require(F('buyervault-jobs.js')).handler;
  r = await jobsFn(anonEvent('GET', { action: 'saved' }));
  b = JSON.parse(r.body);
  t('handler jobs: saved list starts empty', r.statusCode === 200 && Array.isArray(b.saved) && b.saved.length === 0);
  r = await jobsFn({ httpMethod: 'POST', headers: {}, queryStringParameters: {}, body: JSON.stringify({ action: 'save', market: 'city:indianapolis|IN' }) });
  t('handler jobs: writes are admin-gated (401 without the dashboard cookie)', r.statusCode === 401);
  r = await jobsFn(adminEvent('POST', { action: 'save', market: 'city:indianapolis|IN', cadence: 'weekly' }));
  b = JSON.parse(r.body);
  t('handler jobs: admin can save a market (weekly default cadence)', r.statusCode === 200 && b.saved.length === 1 && b.saved[0].cadence === 'weekly' && b.saved[0].lastRefreshedAt === null);
  const savedId = b.saved[0].id;
  r = await jobsFn(adminEvent('POST', { action: 'refreshSaved', id: savedId }));
  b = JSON.parse(r.body);
  t('handler jobs: refresh runs a job, advances lastRefreshedAt ONLY via the job, 0 credits',
    r.statusCode === 200 && b.job.state === 'partial' && b.job.creditsSpent === 0
    && b.saved[0].lastRefreshedAt === b.job.finishedAt && b.saved[0].lastCounts.buyers === indy.buyers);

  const syncFn = require(F('buyervault-sync.js')).handler;
  r = await syncFn(anonEvent('GET', { action: 'config' }));
  b = JSON.parse(r.body);
  t('handler sync: config reads OFF by default', b.config.enabled === false && b.config.minScore === 60);
  r = await syncFn(anonEvent('GET', { action: 'preview' }));
  b = JSON.parse(r.body);
  t('handler sync: preview is real (eligible subset, no sync performed)', b.preview.eligible === prev.eligible && b.preview.total === syncIndex.length);
  r = await syncFn({ httpMethod: 'POST', headers: {}, queryStringParameters: {}, body: JSON.stringify({ action: 'sync', dryRun: true }) });
  t('handler sync: sync attempt is admin-gated (401 anon)', r.statusCode === 401);
  r = await syncFn(adminEvent('POST', { action: 'sync', dryRun: true }));
  b = JSON.parse(r.body);
  t('handler sync: even an admin sync attempt is BLOCKED while OFF — synced stays 0',
    r.statusCode === 200 && b.synced === 0 && b.blocked === true && /OFF/.test(b.reason));
  r = await syncFn(anonEvent('GET', { action: 'log' }));
  b = JSON.parse(r.body);
  t('handler sync: the blocked attempt is written to the sync log (auditable OFF state)',
    b.log.some((x) => x.action === 'sync_blocked'));

  console.log(`\nbuyervault-regression: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  FAIL handler suite crashed — ' + (e && e.stack || e)); process.exit(1); });

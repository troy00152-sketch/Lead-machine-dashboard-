// health-check-regression.js — Workstream 5 (Reliability), Nov 11 2026.
// Fixture tests for the health-check status endpoint + the Booked Today
// monitoring hook (cc-data.js bookedRawCount). NO live calls: global fetch
// is stubbed (HighLevel, the site itself, and the Netlify API), and every
// credential below is an obviously fake TEST value.
// Run: node health-check-regression.js (exit non-zero on any failure)
//
// What it proves:
//   1. verdictForOverview: healthy feed -> ok; any d.errors entry,
//      count/list mismatch, raw>0-but-count-0 (SUSPECT), or stale
//      fetchedAt -> degraded; unusable payload -> down. Cached payloads
//      are noted, never errors.
//   2. checkCcData IN-PROCESS against the merged cc-data.js: the Itzhak
//      case — an 8:00 AM appointment created yesterday counts in Booked
//      Today even when the read happens at 9:30 PM the same day (the old
//      now-12h window dropped it); bookedRawCount reports the pre-filter
//      event count (3: one kept, one cancelled, one tomorrow).
//   3. checkSite: 200 page -> ok; 401 login page -> gate_only (site up,
//      gate up); 500 -> down.
//   4. checkNetlify: no token -> unavailable (honest, not a pass); token
//      + ready deploy -> ok.
//   5. Handler end-to-end: no auth -> 401 with nothing leaked; Bearer
//      auth -> 200 with all four checks, overall degraded ONLY because
//      the Gmail blob is unreadable in this sandbox (unknown -> degraded,
//      never silently ok).
'use strict';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const health = require('./netlify/functions/health-check.js');
const ccData = require('./netlify/functions/cc-data.js');

// ET date string (YYYY-MM-DD) for a timestamp, same rule as cc-data.js.
function etDateStr(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function addDaysEt(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const NOW_REAL = Date.now();
const TODAY_ET = etDateStr(NOW_REAL);
const TOMORROW_ET = addDaysEt(TODAY_ET, 1);
// November = EST (-05:00). The fixture builds ET wall times directly.
const ITZHAK = {
  id: 'evt-itzhak-8am',
  title: 'Itzhak Bokobzha — Seller Call',
  startTime: `${TODAY_ET}T08:00:00-05:00`,
  appointmentStatus: 'confirmed',
  calendarId: 'aG6lop6FROsWlIrB0Y0H',
  contact: { name: 'Itzhak Bokobzha' },
};
const CANCELLED = {
  id: 'evt-cancelled',
  title: 'Cancelled call',
  startTime: `${TODAY_ET}T10:00:00-05:00`,
  appointmentStatus: 'cancelled',
  calendarId: 'aG6lop6FROsWlIrB0Y0H',
};
const TOMORROW_EV = {
  id: 'evt-tomorrow',
  title: 'Tomorrow call',
  startTime: `${TOMORROW_ET}T09:00:00-05:00`,
  appointmentStatus: 'confirmed',
  calendarId: 'aG6lop6FROsWlIrB0Y0H',
};

function hlResponse(data) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
}
function stubFetchForHL() {
  return async (url) => {
    const u = String(url);
    if (u.includes('/conversations/search')) return hlResponse({ conversations: [] });
    if (u.includes('/calendars/events')) return hlResponse({ events: [ITZHAK, CANCELLED, TOMORROW_EV] });
    if (u.includes('/opportunities/search')) return hlResponse({ opportunities: [], total: 0 });
    if (u.includes('/opportunities/pipelines')) return hlResponse({ pipelines: [] });
    if (u.includes('leadmachineapp.com/command-center.html')) {
      return { ok: true, status: 200, text: async () => '<html><title>Acquisition Command Center</title></html>' };
    }
    if (u.includes('api.netlify.com')) {
      return hlResponse([{ id: 'dep-test-1', state: 'ready', created_at: '2026-11-11T00:00:00Z' }]);
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
}

function healthyOverview() {
  return {
    ok: true,
    sellerReplies: 2,
    bookedToday: 1,
    bookedRawCount: 1,
    todayAppointments: [{ title: 'Itzhak Bokobzha — Seller Call', startTime: ITZHAK.startTime }],
    errors: { replies: null, booked: null, opps: null },
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
}

async function main() {
  // ---------- 1. verdictForOverview (pure) ----------
  let v = health._test.verdictForOverview(healthyOverview());
  eq('healthy feed -> ok', v.verdict, 'ok');

  let d = healthyOverview();
  d.errors = { replies: null, booked: 'HL 500: timeout', opps: null };
  v = health._test.verdictForOverview(d);
  eq('booked feed error -> degraded', v.verdict, 'degraded');
  check('degraded names the failing feed', /booked/.test(v.problems.join(' ')), v.problems.join(' '));

  d = healthyOverview();
  d.bookedToday = 2; // list has 1
  v = health._test.verdictForOverview(d);
  eq('count/list mismatch -> degraded', v.verdict, 'degraded');
  check('mismatch message shows both numbers', /2.*1|1.*2/.test(v.problems.join(' ')), v.problems.join(' '));

  d = healthyOverview();
  d.bookedToday = 0;
  d.bookedRawCount = 2;
  d.todayAppointments = [];
  v = health._test.verdictForOverview(d);
  eq('raw>0 but count 0 -> degraded (SUSPECT)', v.verdict, 'degraded');
  check('SUSPECT message names the Itzhak class', /SUSPECT/.test(v.problems.join(' ')), v.problems.join(' '));

  d = healthyOverview();
  d.fetchedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  v = health._test.verdictForOverview(d);
  eq('stale fetchedAt (30 min) -> degraded', v.verdict, 'degraded');

  d = healthyOverview();
  d.cached = true;
  v = health._test.verdictForOverview(d);
  eq('cached healthy feed still ok', v.verdict, 'ok');
  check('cached note recorded', /cache/.test(v.note || ''), v.note);

  v = health._test.verdictForOverview({ ok: false, error: 'cc-data failed' });
  eq('unusable payload -> down', v.verdict, 'down');
  v = health._test.verdictForOverview(null);
  eq('null payload -> down', v.verdict, 'down');

  // ---------- worstStatus ----------
  const w = health._test.worstStatus;
  eq('worst: all ok -> ok', w({ a: { status: 'ok' }, b: { status: 'ok' } }), 'ok');
  eq('worst: unknown alone -> degraded (gap, not pass)', w({ a: { status: 'ok' }, b: { status: 'unknown' } }), 'degraded');
  eq('worst: unavailable alone -> degraded', w({ a: { status: 'ok' }, b: { status: 'unavailable' } }), 'degraded');
  eq('worst: down beats degraded', w({ a: { status: 'degraded' }, b: { status: 'down' } }), 'down');

  // ---------- 2. checkCcData in-process (merged cc-data.js, stubbed HL) ----------
  process.env.HL_API_TOKEN = 'TEST_HL_TOKEN';
  const realFetch = global.fetch;
  global.fetch = stubFetchForHL();
  ccData._test.clearOverviewCache();
  ccData._test.clearStageMapCache();

  let c = await health._test.checkCcData({ headers: { host: '' } });
  eq('in-process feed: Itzhak 8 AM counts (bookedToday=1)', c.bookedToday, 1);
  eq('in-process feed: rawCount=3 (kept + cancelled + tomorrow)', c.bookedRawCount, 3);
  eq('in-process feed verdict ok', c.status, 'ok');

  // Same read at 9:30 PM the same day, via the PURE window/filter
  // functions (no clock patching: `new Date()` ignores a patched
  // Date.now, so a full-handler run under a fake clock would misjudge
  // fetchedAt staleness — a test artifact, not a product bug).
  // The OLD window (startMs = now - 12h) would have started at 09:30 and
  // dropped the 8:00 AM appointment. The merged file anchors the window
  // at ET midnight — it must still count.
  const lateMs = Date.parse(`${TODAY_ET}T21:30:00-05:00`);
  const win = ccData._test.bookedTodayWindowMs(lateMs);
  // Documented EST quirk (cc-data.js): the window start is built with a
  // -04:00 offset, so in EST it lands 23:00 the prior evening — 1h early,
  // harmless because the filter below is the exact classifier. Assert
  // the start is within that 1h, not a wrong day.
  const etMidnightMs = Date.parse(`${TODAY_ET}T00:00:00-05:00`);
  check('9:30 PM window starts at/just before ET midnight today (<=1h early in EST)',
    win.startMs <= etMidnightMs && win.startMs >= etMidnightMs - 3600000,
    `startMs=${new Date(win.startMs).toISOString()}`);
  check('9:30 PM window start is before 8 AM (old 09:30 start would drop it)',
    win.startMs < Date.parse(`${TODAY_ET}T08:00:00-05:00`), `startMs=${new Date(win.startMs).toISOString()}`);
  const kept = ccData._test.filterBookedTodayEvents([ITZHAK, CANCELLED, TOMORROW_EV], lateMs, 'aG6lop6FROsWlIrB0Y0H');
  eq('9:30 PM filter keeps exactly the 8 AM appointment', kept.length, 1);
  eq('9:30 PM filter keeps Itzhak', kept[0] && kept[0].id, 'evt-itzhak-8am');

  // HL calendar failure -> feed error surfaces (no silent zero).
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/calendars/events')) return { ok: false, status: 500, text: async () => 'boom' };
    return stubFetchForHL()(url);
  };
  ccData._test.clearOverviewCache();
  ccData._test.clearStageMapCache();
  c = await health._test.checkCcData({ headers: { host: '' } });
  eq('calendar HL failure -> degraded, not silent 0', c.status, 'degraded');
  check('calendar failure names the booked feed', /booked/.test(c.detail || ''), c.detail);
  global.fetch = stubFetchForHL();

  // ---------- 3. checkSite ----------
  let s = await health._test.checkSite(
    { headers: {} },
    async () => ({ status: 200, text: async () => '<html>Acquisition Command Center</html>' }),
  );
  eq('site 200 + page content -> ok', s.status, 'ok');
  s = await health._test.checkSite(
    { headers: {} },
    async () => ({ status: 401, text: async () => '<html>Sign in</html>' }),
  );
  eq('site 401 login page -> gate_only', s.status, 'gate_only');
  s = await health._test.checkSite(
    { headers: {} },
    async () => ({ status: 500, text: async () => 'error' }),
  );
  eq('site 500 -> down', s.status, 'down');
  s = await health._test.checkSite(
    { headers: {} },
    async () => { throw new Error('fetch failed'); },
  );
  eq('site fetch throw -> down', s.status, 'down');

  // ---------- 4. checkNetlify ----------
  delete process.env.NETLIFY_TOKEN;
  let n = await health._test.checkNetlify(stubFetchForHL());
  eq('no NETLIFY_TOKEN -> unavailable (honest)', n.status, 'unavailable');
  check('unavailable explains the manual step', /NETLIFY_TOKEN/.test(n.detail), n.detail);
  process.env.NETLIFY_TOKEN = 'TEST_NETLIFY_TOKEN';
  n = await health._test.checkNetlify(stubFetchForHL());
  eq('token + ready deploy -> ok', n.status, 'ok');
  eq('latest deploy state reported', n.latestDeployState, 'ready');

  // ---------- 5. handler end-to-end ----------
  global.fetch = stubFetchForHL();
  ccData._test.clearOverviewCache();
  ccData._test.clearStageMapCache();
  process.env.DASHBOARD_PASSWORD = 'test-password';
  process.env.GATE_SECRET = 'test-password';

  let r = await health.handler({ httpMethod: 'GET', headers: {} });
  eq('handler no auth -> 401', r.statusCode, 401);
  check('401 leaks nothing', !r.body.includes('TEST_HL_TOKEN') && !/bookedToday/.test(r.body), r.body);

  r = await health.handler({
    httpMethod: 'GET',
    headers: { authorization: 'Bearer test-password' },
  });
  const body = JSON.parse(r.body);
  eq('handler authed -> 200', r.statusCode, 200);
  eq('handler site check ok', body.checks.site.status, 'ok');
  eq('handler feed check ok', body.checks.ccData.status, 'ok');
  eq('handler feed bookedToday=1 (Itzhak)', body.checks.ccData.bookedToday, 1);
  eq('handler feed bookedRawCount=3', body.checks.ccData.bookedRawCount, 3);
  eq('handler netlify check ok', body.checks.netlify.status, 'ok');
  eq('handler gmail check unknown in sandbox (no blobs)', body.checks.gmail.status, 'unknown');
  eq('overall degraded ONLY because gmail status is unknown (never silently ok)', body.status, 'degraded');
  check('overall ok flag false when degraded', body.ok === false);

  global.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('REGRESSION CRASH', e);
  process.exit(1);
});

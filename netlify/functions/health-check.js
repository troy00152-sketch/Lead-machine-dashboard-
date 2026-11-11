// netlify/functions/health-check.js
// Admin-gated status endpoint for the Command Center.
//   GET /.netlify/functions/health-check
//   Auth: lm_auth cookie (same HMAC as gate.ts / title-order-email.js) OR
//   Authorization: Bearer <dashboard password>. No auth -> 401, no status
//   leaked. The endpoint is intentionally NOT public: the feed counts are
//   Troy's business numbers, and an open status page would also tell a
//   stranger whether Gmail is connected.
//
// What it checks (all read-only, no credits, no sends, no SMS/email):
//   1. site — the Command Center page itself. Fetches /command-center.html
//      forwarding the caller's cookie when one was presented. 200 + page
//      content -> ok. 401 + login page (no cookie to forward, e.g. Bearer
//      caller) -> 'gate_only': Netlify serves the site and the gate is up,
//      page content not verified on this call. Anything else -> down.
//   2. ccData — the live CRM feed, invoked IN-PROCESS (require
//      ./cc-data.js, same handler the page calls) so the check exercises
//      the real HL fetch path without going through the public URL and
//      the edge gate. The caller's host header is forwarded so the
//      per-client resolver (lib-client.js) sees the same client.
//      Verdict rules — it must ALERT, never silently pass:
//        * any non-null d.errors entry -> DEGRADED (names the feed)
//        * bookedToday !== todayAppointments.length -> DEGRADED
//          (count/array mismatch — the number and the list disagree)
//        * bookedRawCount > 0 && bookedToday === 0 -> DEGRADED / SUSPECT
//          (HL returned events but none counted for today — the Itzhak
//          8:00 AM silent-wrongness class; cc-data.js exposes rawCount
//          for exactly this)
//        * fetchedAt older than 10 minutes -> DEGRADED (stale feed)
//        * d.cached === true -> noted, never an error (30s cache is normal)
//        * handler throws / non-200 -> DOWN for this check
//   3. gmail — the daily gmail-token-watch status blob (store
//      'reliability', key 'gmail-watch/status.json'). Missing blob ->
//      'unknown' (watcher has not run yet — a monitoring gap, reported as
//      DEGRADED, not hidden). Present -> its status + daysUntilExpiry +
//      action, passed through verbatim.
//   4. netlify — latest deploy state from the Netlify API, ONLY when
//      NETLIFY_TOKEN is set (Troy creates a read-only personal access
//      token; optional). Without it -> 'unavailable' with the reason and
//      the manual step. The API reports deploy state; the ~15-build-credit
//      cost per deploy is a billing rule, not an API field — the response
//      says so and points at the Netlify UI billing page instead of
//      inventing a number.
//
// Overall status: worst of the checks (down > degraded > ok). 'unknown'
// and 'unavailable' count as DEGRADED: a check that cannot run is a gap,
// not a pass. Response is JSON only, Cache-Control: no-store, and never
// contains credential material.
//
// NOTE: this endpoint reports; it does not notify. The alert path is the
// local health-check-local.js script (~/workspace/playbook-system/
// reliability/), run by cron: it calls this endpoint, writes a dated log
// + a human-readable status file, and exits non-zero on anything but ok.
'use strict';

const crypto = require('crypto');
const https = require('https');

const COOKIE_NAME = 'lm_auth';
const SITE_URL = (process.env.URL || 'https://leadmachineapp.com').replace(/\/$/, '');
const NETLIFY_API = 'https://api.netlify.com/api/v1';
const NETLIFY_SITE_SLUG = 'merry-biscochitos-c87f96';
const FETCH_TIMEOUT_MS = 15000;
const FEED_STALE_MS = 10 * 60 * 1000;

let blobs = null;
try {
  blobs = require('@netlify/blobs');
} catch (e) {
  blobs = null; // local / test env without node_modules: gmail check reports unknown
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

// ---- admin auth (same pattern as title-order-email.js) ----
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
function cookieValid(event, secret) {
  const headers = event.headers || {};
  const cookieHeader = headers.cookie || headers.Cookie || '';
  const cookie = getCookie(cookieHeader, COOKIE_NAME);
  if (!cookie) return false;
  const [expiry, sig] = cookie.split('.');
  if (!expiry || !sig) return false;
  const exp = parseInt(expiry, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(expiry).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function bearerValid(event, secret) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdmin(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false; // fail closed
  return cookieValid(event, secret) || bearerValid(event, secret);
}

// ---- minimal fetch with timeout (global fetch in Node 18+ / Netlify) ----
async function fetchText(url, { headers = {}, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { headers, signal: controller.signal });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---- check 1: the page itself ----
async function checkSite(event, fetchImpl) {
  const headers = {};
  const incoming = (event.headers || {});
  const cookie = incoming.cookie || incoming.Cookie || '';
  if (cookie) headers.cookie = cookie; // forward caller's session, nothing else
  try {
    const { status, text } = await fetchText(`${SITE_URL}/command-center.html`, { headers, fetchImpl });
    if (status === 200 && /Command Center/i.test(text)) {
      return { status: 'ok', detail: 'Command Center page loads (200).' };
    }
    if (status === 401 && /Sign in/i.test(text)) {
      return {
        status: 'gate_only',
        detail: 'Site responds but the gate returned the sign-in page (no cookie to forward on this call). Netlify + gate are up; page content not verified.',
      };
    }
    return { status: 'down', detail: `Command Center page returned HTTP ${status}.` };
  } catch (e) {
    return { status: 'down', detail: `Command Center page fetch failed: ${String((e && e.message) || e).slice(0, 100)}` };
  }
}

// ---- check 2: the cc-data feed, in-process ----
function verdictForOverview(d) {
  const problems = [];
  if (!d || typeof d !== 'object' || d.ok !== true) {
    return { verdict: 'down', problems: ['Feed returned no usable overview payload.'] };
  }
  const errs = d.errors || {};
  const bad = Object.keys(errs).filter((k) => errs[k]);
  for (const k of bad) problems.push(`Feed '${k}' error: ${String(errs[k]).slice(0, 120)}`);
  const appts = Array.isArray(d.todayAppointments) ? d.todayAppointments : [];
  if (typeof d.bookedToday === 'number' && d.bookedToday !== appts.length) {
    problems.push(`Booked Today count (${d.bookedToday}) disagrees with the appointments list (${appts.length}).`);
  }
  if ((d.bookedRawCount || 0) > 0 && d.bookedToday === 0) {
    problems.push(
      `SUSPECT: HighLevel returned ${d.bookedRawCount} calendar event(s) but none counted for today — an appointment may be silently dropped (Itzhak 8:00 AM class). Check the Seller Calls calendar in HighLevel.`,
    );
  }
  if (d.fetchedAt) {
    const ageMs = Date.now() - Date.parse(d.fetchedAt);
    if (Number.isFinite(ageMs) && ageMs > FEED_STALE_MS) {
      problems.push(`Feed data is stale (fetched ${Math.round(ageMs / 60000)} min ago).`);
    }
  } else {
    problems.push('Feed payload has no fetchedAt timestamp.');
  }
  if (problems.length) return { verdict: 'degraded', problems };
  return {
    verdict: 'ok',
    problems: [],
    note: d.cached ? 'Served from the 30s overview cache (normal).' : null,
  };
}

async function checkCcData(event) {
  try {
    const ccData = require('./cc-data.js');
    const host = ((event.headers || {}).host || (event.headers || {}).Host || '');
    const res = await ccData.handler({
      httpMethod: 'GET',
      queryStringParameters: { action: 'overview' },
      headers: { host },
    });
    if (res.statusCode !== 200) {
      return { status: 'down', detail: `cc-data overview returned HTTP ${res.statusCode}.` };
    }
    let d = null;
    try {
      d = JSON.parse(res.body);
    } catch (e) {
      return { status: 'down', detail: 'cc-data overview returned unparseable JSON.' };
    }
    const v = verdictForOverview(d);
    return {
      status: v.verdict,
      detail: v.problems.length ? v.problems.join(' ') : (v.note || 'Feed ok: all sources clean, counts consistent.'),
      bookedToday: typeof d.bookedToday === 'number' ? d.bookedToday : null,
      bookedRawCount: typeof d.bookedRawCount === 'number' ? d.bookedRawCount : null,
      errors: d.errors || null,
      cached: !!d.cached,
    };
  } catch (e) {
    return { status: 'down', detail: `cc-data check failed: ${String((e && e.message) || e).slice(0, 120)}` };
  }
}

// ---- check 3: Gmail watcher status blob ----
async function checkGmail() {
  if (!blobs) {
    return { status: 'unknown', detail: 'Gmail watcher status unreadable here (blob store unavailable in this runtime).' };
  }
  try {
    const store = blobs.getStore('reliability');
    const s = await store.get('gmail-watch/status.json', { type: 'json' });
    if (!s || typeof s !== 'object' || !s.status) {
      return { status: 'unknown', detail: 'No gmail-token-watch run recorded yet — the watcher has not run since deploy. Check the Netlify Functions page for its next run.' };
    }
    const map = { ok: 'ok', warn: 'degraded', critical: 'degraded', expired: 'degraded', refresh_failed: 'degraded', not_connected: 'degraded', expiry_unknown: 'degraded' };
    return {
      status: map[s.status] || 'degraded',
      detail: `Gmail token: ${s.status}${s.daysUntilExpiry !== null && s.daysUntilExpiry !== undefined ? ` (${s.daysUntilExpiry} day(s) left)` : ''}. ${s.action || ''}`.trim(),
      gmailStatus: s.status,
      daysUntilExpiry: s.daysUntilExpiry ?? null,
      action: s.action || null,
      checkedAt: s.checkedAt || null,
    };
  } catch (e) {
    return { status: 'unknown', detail: 'Gmail watcher status could not be read from the blob store.' };
  }
}

// ---- check 4: Netlify deploys (optional — needs NETLIFY_TOKEN) ----
async function checkNetlify(fetchImpl) {
  const token = process.env.NETLIFY_TOKEN || '';
  if (!token) {
    return {
      status: 'unavailable',
      detail: 'Netlify build/credit state not readable without NETLIFY_TOKEN (optional, read-only personal access token — Troy creates it; see reliability README). Build credits (~15 per deploy of the 1,000/mo pool) are a billing rule — verify them in the Netlify UI, not here.',
    };
  }
  try {
    const { status, text } = await fetchText(
      `${NETLIFY_API}/sites/${NETLIFY_SITE_SLUG}/deploys?per_page=5`,
      { headers: { Authorization: `Bearer ${token}` }, fetchImpl },
    );
    if (status !== 200) {
      return { status: 'degraded', detail: `Netlify API returned HTTP ${status} — deploy state unreadable (check the token / site slug).` };
    }
    let deploys = [];
    try {
      deploys = JSON.parse(text);
    } catch (e) {
      return { status: 'degraded', detail: 'Netlify API returned unparseable JSON.' };
    }
    if (!Array.isArray(deploys) || !deploys.length) {
      return { status: 'degraded', detail: 'Netlify API returned no deploys for this site.' };
    }
    const latest = deploys[0];
    const state = String(latest.state || 'unknown');
    return {
      status: state === 'ready' ? 'ok' : 'degraded',
      detail: `Latest deploy ${String(latest.id || '').slice(0, 8)}: ${state} (${latest.created_at || 'unknown date'}). Deploy count is not build credits — credits (~15/deploy) are checked in the Netlify UI billing page.`,
      latestDeployState: state,
      latestDeployAt: latest.created_at || null,
    };
  } catch (e) {
    return { status: 'degraded', detail: `Netlify API fetch failed: ${String((e && e.message) || e).slice(0, 100)}` };
  }
}

function worstStatus(checks) {
  const rank = { ok: 0, gate_only: 1, unavailable: 1, unknown: 2, degraded: 2, down: 3 };
  let worst = 'ok';
  for (const c of Object.values(checks)) {
    if ((rank[c.status] || 0) > (rank[worst] || 0)) worst = c.status;
  }
  // 'gate_only' / 'unavailable' alone are not failures of the dashboard —
  // they cap the overall status at 'degraded' so the gap is visible.
  if (worst === 'gate_only' || worst === 'unavailable') return 'degraded';
  if (worst === 'unknown') return 'degraded';
  return worst;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});
    if (event.httpMethod !== 'GET') return json(400, { error: 'GET only.' });
    if (!isAdmin(event)) {
      return json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
    }
    const [site, ccData, gmail, netlify] = await Promise.all([
      checkSite(event),
      checkCcData(event),
      checkGmail(),
      checkNetlify(),
    ]);
    const checks = { site, ccData, gmail, netlify };
    const status = worstStatus(checks);
    return json(200, {
      ok: status === 'ok',
      status,
      checks,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    return json(503, { error: 'Health check failed.', detail: String((e && e.message) || e).slice(0, 120) });
  }
};

exports._test = { verdictForOverview, worstStatus, checkSite, checkCcData, checkGmail, checkNetlify };

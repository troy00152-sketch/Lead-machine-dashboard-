/* cc-data.js — Command Center data proxy for HighLevel.
   Provides live CRM data for command-center.html:
   GET /.netlify/functions/cc-data?action=overview
   Returns: sellerReplies, bookedToday, underContract, newLeads (top 9,
   hottest first), closedCount, closedVolume (GROSS closed volume — not
   profit), closeRate + closeRateCapped (closed ÷ fetched opps), and
   per-source errors. Overview responses are cached in-memory for 30s
   (keyed per client). Read-only.
   PER-CLIENT (Nov 11): location/calendar/token resolve per request
   from the client config (lib-client.js) — Troy's ids are the fallback
   ONLY for Troy's own domains. Unknown subdomains get NO data (honest
   400), never Troy's feed.
   PAGINATION (Nov 11): /opportunities/search is paged with the
   documented `page` param (0-indexed, 100/call, up to 10 pages =
   1,000 opps). closeRateCapped is true whenever HL's `total` exceeds
   what was fetched; the page labels the fetched count.
   SPEED (Nov 11): stage map fetched in parallel with page 0 and
   cached 10 min; contact enrichment capped at 100 leads with 20 in
   flight (was: every lead, sequential chunks of 10). */
'use strict';

const { resolveClientData, LEGACY_TROY_LOCATION_ID, LEGACY_TROY_CALENDAR_ID } = require('./lib-client');

const HL_API_BASE = 'https://services.leadconnectorhq.com';
// Per-endpoint API versions, matching the working bot code (src/config.js).
// Conversations + Calendars ride 2021-04-15; Opportunities rides
// 2021-07-28. cc-data used 2021-07-28 for everything, which made the
// conversations and calendar reads fail silently (swallowed by .catch),
// so every CRM panel read zero even though the feed was up.
const HL_VERSION_CONVERSATIONS = '2021-04-15';
const HL_VERSION_CALENDARS = '2021-04-15';
const HL_VERSION_OPPORTUNITIES = '2021-07-28';
// Legacy Troy identifiers — used ONLY when the troy client file itself
// has no location/calendar (lib-client.js applies the same rule).
// Never applied to any other client.
const HL_LOCATION_ID = LEGACY_TROY_LOCATION_ID;
const HL_CALENDAR_ID = LEGACY_TROY_CALENDAR_ID; // Seller Calls - Paula
const TIMEOUT_MS = 20000;
// Opportunities paging: HL caps /opportunities/search at 100 per call.
const OPP_PAGE_SIZE = 100;
const MAX_OPP_PAGES = 10; // hard cap: 1,000 opps per overview, honestly labelled
// Hot-lead enrichment bounds (see enrichHotLeads).
const ENRICH_LEADS_MAX = 100;
const ENRICH_CONCURRENCY = 20;
// Stage-map cache: pipelines change rarely; a 10-min in-memory cache
// (per location) saves one HL round-trip on every overview after the
// first. No credit-spending lookup is ever cached here — HL reads only.
const STAGE_MAP_TTL_MS = 600000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

async function hlFetch(path, method, body, version, token) {
  // Per-client token when the caller has one; HL_API_TOKEN is the
  // live var the other functions already use (keeps old callers and
  // the offline regression working when no ctx is passed).
  const t = token || process.env.HL_API_TOKEN;
  if (!t) throw new Error('HL_API_TOKEN not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(HL_API_BASE + path, {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + t,
        'Version': version || HL_VERSION_OPPORTUNITIES,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) throw new Error(`HL ${res.status}: ${(data && data.message) || text.slice(0, 150)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Count conversations with an unanswered inbound SMS in the last 24h.
// Mirrors the working pipeline-activity.js pattern: GET conversations
// search under 2021-04-15, then per-thread messages (newest first).
// A thread counts when its newest inbound has no outbound after it.
// ctx = { locationId, calendarId, token } from resolveClientData().
// Every getter below takes ctx — no hardcoded location/calendar.
async function getSellerReplies(ctx) {
  try {
    const sinceMs = Date.now() - 24 * 3600 * 1000;
    const data = await hlFetch(
      `/conversations/search?locationId=${ctx.locationId}&limit=100`,
      'GET', null, HL_VERSION_CONVERSATIONS, ctx && ctx.token
    ).catch(() => null);
    const convos = (data && data.conversations) || [];
    let inboundCount = 0;
    const recent = [];
    // Message fetches run in parallel (chunks of 8) — the old sequential
    // loop took up to 30 round-trips per overview.
    const fresh = convos.filter((c) => {
      const lastMs = c.lastMessageDate ? new Date(c.lastMessageDate).getTime() : 0;
      return lastMs && lastMs >= sinceMs;
    }).slice(0, 30);
    for (let i = 0; i < fresh.length; i += 8) {
      const chunk = fresh.slice(i, i + 8);
      const results = await Promise.all(chunk.map(async (c) => {
        const msgs = await hlFetch(`/conversations/${c.id}/messages?limit=5`, 'GET', null, HL_VERSION_CONVERSATIONS, ctx && ctx.token).catch(() => null);
        return { c, msgs };
      }));
      for (const { c, msgs } of results) {
        const list = (msgs && msgs.messages && msgs.messages.messages) || (msgs && msgs.messages) || [];
        if (!Array.isArray(list) || !list.length) continue;
        // HL returns newest first: the thread counts when its NEWEST
        // message is an inbound within 24h (an unanswered seller reply).
        const newest = list[0];
        if (!newest || newest.direction !== 'inbound') continue;
        const inboundMs = newest.dateAdded ? new Date(newest.dateAdded).getTime() : (c.lastMessageDate ? new Date(c.lastMessageDate).getTime() : 0);
        if (!inboundMs || inboundMs < sinceMs) continue;
        inboundCount++;
        if (recent.length < 8) {
          recent.push({
            contactName: c.fullName || c.contactName || 'Unknown',
            preview: String(newest.body || '').slice(0, 80),
            date: newest.dateAdded || c.lastMessageDate,
          });
        }
      }
    }
    return { count: inboundCount, recent, error: null };
  } catch (e) {
    return { count: 0, recent: [], error: String(e).slice(0, 100) };
  }
}

// ET calendar-day string (YYYY-MM-DD) for a timestamp, DST-safe.
function etDateStr(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Appointments HAPPENING today on the Seller Calls calendar.
// Mirrors the working bot/pipeline-activity pattern: /calendars/events
// under 2021-04-15 with startTime/endTime as EPOCH MILLISECONDS
// (the old code sent ISO strings, which the endpoint rejects), wide
// window, then client-side filter on the event's ET day.
//
// Nov 11, 2026 — Itzhak Bokobzha miss: the bot-booked 8:00 AM Nov 11
// appointment did not show in Booked Today. ROOT CAUSE: the query
// window was anchored to NOW (startMs = now - 12h), not to the start
// of today — so every morning appointment slid OUT of the window once
// the day was more than 12h old (an 8:00 AM appointment is invisible
// to any read after 8:00 PM the same day), and the ET-day filter
// downstream could never rescue an event HL never returned. The
// window now starts at ET midnight today (bookedTodayWindowMs) — the
// ET-day filter is still the exact classifier, so the count stays
// exactly today's appointments on this calendar, no wider.
// Second defect in the same function, fixed with it: the HL fetch
// carried `.catch(() => null)`, so a failed events call returned
// count 0 with error null — a silent zero with the LIVE dot still
// green. The failure now surfaces in errors.booked instead.
function bookedTodayWindowMs(nowMs) {
  const todayEt = etDateStr(nowMs);
  // ET midnight, same pattern as pipeline-activity.js: the -04:00
  // offset is exact in EDT and 1h early in EST (23:00 ET the prior
  // day) — harmless, because filterBookedTodayEvents below is the
  // exact classifier and drops anything not on today's ET day.
  const startMs = new Date(`${todayEt}T00:00:00-04:00`).getTime();
  const endMs = nowMs + 48 * 3600 * 1000;
  return { startMs, endMs };
}

// Pure filter over one /calendars/events page: exactly the live,
// same-calendar appointments HAPPENING today (ET day of startTime).
// Created date is irrelevant — an appointment booked yesterday for
// today counts (that is the Itzhak case: created Nov 10, 8:00 AM
// Nov 11). An event carrying another calendar's ID never counts;
// an event carrying NO calendarId passes (HL does not always echo
// it — same lenient rule as the bot's getCalendarEvents).
function filterBookedTodayEvents(raw, nowMs, calendarId) {
  const todayEt = etDateStr(nowMs);
  const list = Array.isArray(raw) ? raw : [];
  const live = list.filter((e) => {
    if (!e || !e.id) return false;
    const cal = e.calendarId || e.calendar_id;
    if (cal && calendarId && String(cal) !== String(calendarId)) return false;
    const st = String(e.appointmentStatus || e.status || '').toLowerCase();
    if (st === 'cancelled' || st === 'invalid') return false;
    const sMs = e.startTime ? new Date(e.startTime).getTime() : (e.start_time ? new Date(e.start_time).getTime() : 0);
    if (!sMs) return false;
    return etDateStr(sMs) === todayEt;
  });
  live.sort((a, b) => new Date(a.startTime || a.start_time) - new Date(b.startTime || b.start_time));
  return live;
}

async function getBookedToday(ctx) {
  try {
    const nowMs = Date.now();
    const { startMs, endMs } = bookedTodayWindowMs(nowMs);
    const data = await hlFetch(
      `/calendars/events?locationId=${ctx.locationId}&calendarId=${ctx.calendarId}&startTime=${startMs}&endTime=${endMs}`,
      'GET', null, HL_VERSION_CALENDARS, ctx && ctx.token
    );
    const raw = (data && (data.events || data.appointments)) || (Array.isArray(data) ? data : []);
    const live = filterBookedTodayEvents(raw, nowMs, ctx && ctx.calendarId);
    return {
      count: live.length,
      // rawCount is the monitoring hook (reliability workstream, Nov 11):
      // events HL returned BEFORE the today/cancelled/calendar filter.
      // When rawCount > 0 but count is 0, appointments exist that the
      // filter dropped — the silent-wrongness class behind the Itzhak
      // 8:00 AM miss. health-check.js flags rawCount > 0 && count === 0
      // as SUSPECT instead of silently showing 0.
      rawCount: raw.length,
      appointments: live.slice(0, 10).map(e => ({
        title: e.title || 'Appointment',
        startTime: e.startTime || e.start_time || null,
        contactName: (e.contact && e.contact.name) || (e.contactId && e.contactId.name) || e.title || '',
      })),
      error: null,
    };
  } catch (e) {
    return { count: 0, appointments: [], error: String(e).slice(0, 100) };
  }
}

// Stage ID -> stage name map, from the pipelines endpoint.
// The opportunities/search response carries ONLY pipelineStageId — no
// stage name — so classifying on o.pipelineStageName always yields ''.
// Without this map every panel classified to zero.
// Cached 10 min per location (STAGE_MAP_TTL_MS): pipelines change
// rarely, and the old code paid one sequential round-trip for this on
// every overview. Cache holds HL reads only — never a credit lookup.
let stageMapCache = null; // { locationId, map, at }
async function getStageMap(ctx) {
  const loc = (ctx && ctx.locationId) || HL_LOCATION_ID;
  if (stageMapCache && stageMapCache.locationId === loc && (Date.now() - stageMapCache.at) < STAGE_MAP_TTL_MS) {
    return stageMapCache.map;
  }
  const data = await hlFetch(
    `/opportunities/pipelines?locationId=${loc}`,
    'GET', null, HL_VERSION_OPPORTUNITIES, ctx && ctx.token
  );
  const pipes = (data && (data.pipelines || data.data)) || [];
  const map = new Map();
  for (const p of pipes) {
    const stages = p.stages || p.pipelineStages || [];
    for (const s of stages) {
      if (s && s.id) map.set(String(s.id), String(s.name || ''));
    }
  }
  stageMapCache = { locationId: loc, map, at: Date.now() };
  return map;
}

// One page of /opportunities/search. `page` is 0-indexed (HL schema
// `search-opportunities-advanced`); `limit` caps at 100 per call.
async function searchOppsPage(ctx, page) {
  const data = await hlFetch('/opportunities/search', 'POST', {
    locationId: ctx.locationId,
    limit: OPP_PAGE_SIZE,
    page,
  }, HL_VERSION_OPPORTUNITIES, ctx && ctx.token).catch(() => null);
  return data;
}

// Get opportunities grouped by stage — PAGINATED past the 100 cap.
// PAGINATION VERDICT (Nov 11, from HL's live operation schema for
// POST /opportunities/search, `search-opportunities-advanced`, read
// via describe_operation — no live data was fetched to decide this):
//   * `page` (0-indexed) + `limit` ARE documented body fields and the
//     response carries `total` — real paging exists. Page 0 is fetched
//     first; once `total` is known the remaining pages go out IN
//     PARALLEL (page numbers are known up front, unlike a cursor).
//   * `searchAfter` (cursor array, e.g. [epochMs, id]) is ALSO a
//     documented body field — but the response schema documents NO
//     returned cursor field, so there is nothing safe to echo without
//     a live test. Page-based paging is used instead. FOLLOW-UP: once
//     a live read confirms what the response returns as the cursor,
//     searchAfter can replace `page` (it is the cursor-correct form
//     when the pipeline moves mid-fetch).
//   * Hard cap MAX_OPP_PAGES (10 x 100 = 1,000 opps). When HL's total
//     exceeds what was fetched the result is labelled capped
//     (closeRateCapped + oppsFetched/oppsTotal) — never silently
//     presented as the whole pipeline.
async function getOpportunities(ctx) {
  try {
    // Page 0 + stage map IN PARALLEL (independent calls — the old code
    // ran the stage lookup AFTER the search, one wasted round-trip).
    const [first, stageRes] = await Promise.all([
      searchOppsPage(ctx, 0),
      getStageMap(ctx).then((m) => ({ map: m, error: null })).catch((e) => ({ map: null, error: String(e).slice(0, 100) })),
    ]);
    let opps = (first && (first.opportunities || first.data)) || [];
    const total = Number(first && first.total) || 0;
    // Remaining pages in parallel, up to the hard cap.
    const pageCount = total > opps.length
      ? Math.min(Math.ceil(total / OPP_PAGE_SIZE), MAX_OPP_PAGES)
      : 1;
    if (pageCount > 1) {
      const rest = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) => searchOppsPage(ctx, i + 1))
      );
      for (const pg of rest) {
        const rows = (pg && (pg.opportunities || pg.data)) || [];
        opps = opps.concat(rows);
      }
    }
    // Dedupe by id (page boundaries can shift if the pipeline moves
    // mid-fetch) and enforce the hard cap.
    const seen = new Set();
    opps = opps.filter((o) => {
      if (!o || !o.id || seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    }).slice(0, OPP_PAGE_SIZE * MAX_OPP_PAGES);
    const oppsTotal = total || opps.length;
    // Capped whenever HL says more exist than we hold; when HL omits
    // `total`, fall back to the old rule (a full first page may hide more).
    const capped = total ? total > opps.length : opps.length >= OPP_PAGE_SIZE;
    // Resolve stage names via the pipelines endpoint (search gives IDs
    // only). If that lookup fails, fall back to status + recency.
    const stageMap = stageRes.map;
    const stageError = stageRes.error;
    const underContract = [];
    const newLeads = [];
    const closed = [];
    const recentMs = Date.now() - 14 * 24 * 3600 * 1000;
    for (const o of opps) {
      const status = String(o.status || '').toLowerCase();
      if (status === 'lost' || status === 'abandoned') continue;
      const stage = stageMap
        ? String(stageMap.get(String(o.pipelineStageId || o.pipeline_stage_id || '')) || o.pipelineStageName || o.stageName || o.stage || '').toLowerCase()
        : String(o.pipelineStageName || o.stageName || o.stage || '').toLowerCase();
      const item = {
        id: o.id,
        name: o.name || o.contactName || 'Unknown',
        stage: stageMap ? (stageMap.get(String(o.pipelineStageId || o.pipeline_stage_id || '')) || '') : '',
        monetaryValue: o.monetaryValue || 0,
        createdAt: o.dateAdded || o.createdAt,
        contactId: o.contactId,
        address: extractAddress(o),
      };
      if (status === 'won') { closed.push(item); continue; }
      if (stage.includes('under contract')) underContract.push(item);
      else if (stage.includes('closed') || stage.includes('sold') || stage.includes('won')) closed.push(item);
      else if (stage.includes('new') || stage.includes('lead') || stage.includes('appointment')) newLeads.push(item);
      else if (!stageMap && status === 'open') {
        // No stage names available: only recent open opps count as leads.
        const createdMs = item.createdAt ? new Date(item.createdAt).getTime() : 0;
        if (createdMs >= recentMs) newLeads.push(item);
      }
    }
    return { underContract, newLeads, closed, total: oppsTotal, fetched: opps.length, capped, error: stageError };
  } catch (e) {
    return { underContract: [], newLeads: [], closed: [], total: 0, fetched: 0, capped: false, error: String(e).slice(0, 100) };
  }
}

// ---- Hot Leads CRM motivation score ----
// The grid used to score leads ONLY from a live property lookup
// (data-api, 1 PR credit per lead). With the PR API balance at 0 every
// lookup failed and every card showed 0 / NO DATA / ARV $0 — even though
// the CRM knows plenty about these sellers. So the feed now scores each
// lead from CRM signals alone (no credits spent), and the page upgrades
// to the full property-based score only when a lookup actually succeeds.
//
// Canonical scale (same 0-100, same labels as wholesaleScoreSimple):
//   Distress /45 — distress tags on the contact (list sources) + stack
//     depth + appointment engagement + recency. Equity /35 is UNMEASURED
//     from CRM alone (needs a property lookup) so it scores 0 here and
//     the card says so; Ownership /20 — absentee tag only.
//   Honest ceiling: with equity unmeasured the CRM score tops out around
//   WARM (45 distress + up to 8 absentee). Ranking still holds — the
//   hottest seller sorts first — and HOT/LAYUP need a property lookup
//   (which upgrades the score when credits exist).

const DISTRESS_TAG_POINTS = [
  [/pre.?foreclosure/i, 18],
  [/tax.?delinquen/i, 16],
  [/probate/i, 14],
  [/code.?violation/i, 12],
  [/vacant/i, 12],
  [/lien/i, 10],
  [/bankrupt/i, 14],
];

// KB-10 warning signs (Ginn #3, Nov 5): friction markers that correlate
// with distressed, complicated deals — solar loan, heirs fighting, a
// hard-money/private loan, an attorney involved, a custom/unusual house,
// multiple liens+taxes+fines stacked. Each adds a SMALL +3 to distress
// (same 45 cap) and is surfaced in `warnings` so the card shows it.
// Judgment call: in KB-10 these are "watch out" flags, not heat, so the
// weight is deliberately small — if Troy wants them flags-only (no points)
// or negative, it is a one-line change here.
const WARNING_SIGNS = [
  [/solar/i, 'solar loan'],
  [/heir/i, 'heirs / disagreement'],
  [/hard.?money/i, 'hard-money loan'],
  [/private.?loan/i, 'private loan'],
  [/attorney/i, 'attorney involved'],
  [/lawyer/i, 'attorney involved'],
  [/lawsuit/i, 'attorney involved'],
  [/custom.?house/i, 'custom / unusual house'],
  [/unusual/i, 'custom / unusual house'],
];

// KB-10 instant-HOT triggers (Ginn #3, Nov 5): a deadline or a seller who
// wants out NOW. Any match floors the score at 55 (the HOT threshold) and
// records which trigger fired. The 30-day condition in KB-10 cannot be
// verified from tags alone, so the floor applies to any lead carrying the
// trigger tag; "pre-foreclosure" is EXCLUDED from the foreclosure trigger
// (status, not a deadline — it already scores 18 distress points).
// 'hot lead' is Troy's own tag (Irish hot-lead chain) — it is instant-HOT
// by definition.
const HOT_TRIGGER_PATTERNS = [
  [/auction/i, 'auction'],
  [/sheriff/i, 'sheriff sale'],
  [/sale.?date/i, 'sale date'],
  [/court.?date/i, 'court date'],
  [/evict/i, 'eviction'],
  [/move.?out/i, 'move-out'],
  [/hot.?lead/i, 'hot lead'],
  [/wants.?to.?sell.?now/i, 'wants to sell now'],
  [/just.?want.?it.?gone/i, 'wants it gone'],
];

function isHotTrigger(tagText) {
  if (/foreclosure/i.test(tagText) && !/pre.?foreclosure/i.test(tagText)) {
    return 'foreclosure';
  }
  for (const [re, label] of HOT_TRIGGER_PATTERNS) {
    if (re.test(tagText)) return label;
  }
  return null;
}

function scoreLabel(score) {
  return score >= 75 ? 'LAYUP' : score >= 55 ? 'HOT' : score >= 35 ? 'WARM' : score >= 15 ? 'COOL' : 'COLD';
}

// ---- Hot Leads ARV/MAO/LAO fallback (Nov 11) ----
// The Nov 10 60K comp project wrote ARV/MAO/LAO to HL custom fields, but
// getContactTags only ever returned tags + Stack Count, and renderHotLeads
// in command-center.html only ever got ARV from a live data-api lookup
// (1 PR credit per lead — fails at 0 credits). So even a fully comped lead
// still rendered ARV/MAO/LAO as "—". These helpers read the written values
// off the contact (by field ID first, by field name second) so the page can
// fall back to them with zero credits spent. Never invented: a missing,
// blank, zero, negative or non-numeric value resolves to null.
const CF_ARV_ID = 'cOE6XmJNOdVKsDNpiGqR';
const CF_MAO_ID = 'B8Mfg1TQfjjo4Dl214A2';
const CF_LAO_ID = 'JUPzLFhe7VG0PCJqL0n8';

function parseMoneyValue(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return (Number.isFinite(n) && n > 0) ? Math.round(n) : null;
}

function valuesFromCustomFields(cfs) {
  const list = Array.isArray(cfs) ? cfs : [];
  const byId = {};
  const byName = {};
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const raw = (f.fieldValue != null ? f.fieldValue : (f.value != null ? f.value : f.field_value));
    const id = String(f.id || f.customFieldId || f.fieldId || '');
    if (id) byId[id] = raw;
    const n = String(f.name || f.key || '').toLowerCase().trim();
    if (n) byName[n] = raw;
  }
  // Field ID wins (names can be relabelled in HL); name is the fallback.
  const pick = (id, names) => {
    if (id && byId[id] != null) return parseMoneyValue(byId[id]);
    for (const nm of names) {
      if (byName[nm] != null) return parseMoneyValue(byName[nm]);
    }
    return null;
  };
  return {
    arv: pick(CF_ARV_ID, ['arv']),
    mao: pick(CF_MAO_ID, ['mao']),
    lao: pick(CF_LAO_ID, ['lao']),
  };
}

// Best-effort contact read for one lead. Never throws — returns null on
// any failure so the lead still scores from stage + recency alone.
async function getContactTags(contactId, token) {
  if (!contactId) return null;
  try {
    const data = await hlFetch(`/contacts/${contactId}`, 'GET', null, HL_VERSION_OPPORTUNITIES, token).catch(() => null);
    const c = (data && (data.contact || data)) || null;
    if (!c) return null;
    const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t)) : [];
    // Custom fields carry the weekly-pull stack data when present
    // (List Sources / Stack Count / Stack Tier, set by name on import).
    const cfs = Array.isArray(c.customFields) ? c.customFields : [];
    const cfByName = {};
    for (const f of cfs) {
      const n = String(f.name || f.key || '').toLowerCase();
      if (n) cfByName[n] = String(f.fieldValue != null ? f.fieldValue : (f.value || ''));
    }
    // ARV/MAO/LAO written by the comp project (by field ID, name fallback).
    const vals = valuesFromCustomFields(cfs);
    return { tags, cfByName, arv: vals.arv, mao: vals.mao, lao: vals.lao };
  } catch (e) {
    return null;
  }
}

function crmScoreFor(lead, contact) {
  let distress = 0;
  const tags = (contact && contact.tags) || [];
  const tagText = tags.join(' ').toLowerCase();
  let distressTagCount = 0;
  for (const [re, pts] of DISTRESS_TAG_POINTS) {
    if (re.test(tagText)) { distress += pts; distressTagCount++; }
  }
  // Stacking: 2+ distress signals = real motivation.
  if (distressTagCount >= 2) distress += 10;
  else if (distressTagCount === 1) distress += 4;
  // Stack Count custom field, when the weekly pull set it.
  const stackN = contact && contact.cfByName ? parseInt(String(contact.cfByName['stack count'] || '').replace(/\D/g, ''), 10) : NaN;
  if (Number.isFinite(stackN)) {
    if (stackN >= 3) distress += 12;
    else if (stackN === 2) distress += 8;
    else if (stackN === 1) distress += 3;
  }
  // Engagement: a booked appointment means the seller is talking.
  const stage = String(lead.stage || '').toLowerCase();
  if (stage.includes('appointment')) distress += 10;
  else if (stage.includes('contacted') || stage.includes('qualified')) distress += 5;
  // Recency: fresh leads are hotter.
  const createdMs = lead.createdAt ? new Date(lead.createdAt).getTime() : 0;
  if (createdMs && Date.now() - createdMs <= 48 * 3600 * 1000) distress += 5;
  distress = Math.min(45, distress);
  // KB-10 warning signs: small distress nudge + surfaced for the card.
  const warnings = [];
  for (const [re, label] of WARNING_SIGNS) {
    if (re.test(tagText) && !warnings.includes(label)) warnings.push(label);
  }
  if (warnings.length) distress = Math.min(45, distress + 3 * warnings.length);
  // Equity: unmeasured from CRM alone — 0, and the card says so.
  const equity = 0;
  // Ownership: absentee tag only.
  let own = 0;
  if (/absentee/i.test(tagText)) own += 8;
  own = Math.min(20, own);
  let score = Math.max(0, Math.min(100, distress + equity + own));
  // KB-10 instant-HOT: a deadline or a seller who wants out now floors
  // the score at HOT (55) — the lead's real signals can still lift it
  // higher, but it never reads below HOT.
  const hotTrigger = isHotTrigger(tagText);
  const instantHot = hotTrigger !== null;
  if (instantHot) score = Math.max(score, 55);
  return {
    score, label: scoreLabel(score),
    parts: { distress, equity, own },
    source: 'crm',
    stackCount: Number.isFinite(stackN) ? stackN : (distressTagCount || 0),
    listSignals: tags.filter((t) => DISTRESS_TAG_POINTS.some(([re]) => re.test(t))).slice(0, 4),
    warnings,
    instantHot,
    hotTrigger,
  };
}

// Cheap score from stage + recency alone — no contact fetch. Used to
// rank leads BEFORE the contact reads so enrichment can be bounded.
// Mirrors exactly the stage/recency lines of crmScoreFor (appointment
// +10, contacted/qualified +5, created within 48h +5).
function cheapScoreFor(lead) {
  let distress = 0;
  const stage = String(lead.stage || '').toLowerCase();
  if (stage.includes('appointment')) distress += 10;
  else if (stage.includes('contacted') || stage.includes('qualified')) distress += 5;
  const createdMs = lead.createdAt ? new Date(lead.createdAt).getTime() : 0;
  if (createdMs && Date.now() - createdMs <= 48 * 3600 * 1000) distress += 5;
  distress = Math.min(45, distress);
  return { score: distress, label: scoreLabel(distress), parts: { distress, equity: 0, own: 0 }, source: 'crm-cheap' };
}

// Run fn over items with at most `limit` in flight at once. The old
// chunked loop (10 at a time, each chunk awaited) made the round count
// linear in the lead count; a pool keeps the same HL politeness bound
// per instant while cutting the sequential rounds ~in half at limit 20.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function applyCrmScore(lead, contact, s) {
  lead.score = s.score;
  lead.scoreLabel = s.label;
  lead.scoreParts = s.parts;
  lead.scoreSource = s.source;
  // Written comp values from the contact (null when never comped).
  // The page falls back to these when the live lookup returns nothing.
  lead.arv = (contact && contact.arv) || null;
  lead.mao = (contact && contact.mao) || null;
  lead.lao = (contact && contact.lao) || null;
  lead.stackCount = s.stackCount;
  lead.listSignals = s.listSignals;
  lead.warnings = s.warnings;
  lead.instantHot = s.instantHot;
  lead.hotTrigger = s.hotTrigger;
}

async function enrichHotLeads(newLeads, ctx) {
  // TWO-PHASE, BOUNDED (Nov 11 speed fix). The old code contact-fetched
  // EVERY new lead in sequential chunks of 10 — 10 rounds at 100 leads,
  // and unbounded once pagination can return up to 1,000 opps, which
  // would push the overview past its 20s timeout.
  //   Phase 1: cheap-score ALL leads (stage + recency, no fetch),
  //     sort, keep the top ENRICH_LEADS_MAX (100 — exactly the old
  //     code's ceiling: it could only ever see 100 opps, so it never
  //     enriched more than ~100 leads).
  //   Phase 2: contact-fetch those 100 with ENRICH_CONCURRENCY (20)
  //     in flight — 5 rounds instead of 10 — then re-sort hottest
  //     first so the grid shows the actual top 9.
  // Honest limit: past 100 new leads, ranking below the cut is by
  // cheap signals only (scoreSource 'crm-cheap'); a tag-heavy lead
  // ranked 101st cheap cannot jump in via tags. The grid shows the
  // top 9, so the cut sits far above what renders.
  const targets = newLeads || [];
  const token = ctx && ctx.token;
  const ranked = targets.map((lead) => ({ lead, cheap: cheapScoreFor(lead) }));
  ranked.sort((a, b) => (b.cheap.score || 0) - (a.cheap.score || 0));
  const toEnrich = ranked.slice(0, ENRICH_LEADS_MAX);
  await mapWithConcurrency(toEnrich, ENRICH_CONCURRENCY, async ({ lead }) => {
    const contact = await getContactTags(lead.contactId, token);
    applyCrmScore(lead, contact, crmScoreFor(lead, contact));
  });
  for (const { lead, cheap } of ranked.slice(ENRICH_LEADS_MAX)) {
    lead.score = cheap.score;
    lead.scoreLabel = cheap.label;
    lead.scoreParts = cheap.parts;
    lead.scoreSource = cheap.source;
    lead.arv = null; lead.mao = null; lead.lao = null;
    lead.stackCount = 0; lead.listSignals = []; lead.warnings = [];
    lead.instantHot = false; lead.hotTrigger = null;
  }
  targets.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  return newLeads;
}

function extractAddress(opp) {
  // Try custom fields, then name
  const cf = opp.customFields || opp.customField || [];
  if (Array.isArray(cf)) {
    for (const f of cf) {
      const n = String(f.name || f.key || '').toLowerCase();
      if (n.includes('address') || n.includes('property')) {
        const v = String(f.value || f.fieldValue || '').trim();
        if (v) return v;
      }
    }
  }
  return opp.name || '';
}

// Test-only export: lets node verify crmScoreFor / enrichHotLeads
// directly without a live HL call. Harmless in production — the
// Netlify handler is unchanged.
exports._test = {
  crmScoreFor, scoreLabel, isHotTrigger, parseMoneyValue, valuesFromCustomFields,
  enrichHotLeads, cheapScoreFor, mapWithConcurrency,
  bookedTodayWindowMs, filterBookedTodayEvents,
  getStageMap, searchOppsPage, getOpportunities,
  ENRICH_LEADS_MAX, ENRICH_CONCURRENCY, OPP_PAGE_SIZE, MAX_OPP_PAGES,
  clearOverviewCache: () => { overviewCacheMem = null; },
  clearStageMapCache: () => { stageMapCache = null; },
};

// Short in-memory overview cache (30s): the page refreshes every 60s,
// so a warm function serves the second refresh from cache instead of
// re-hitting HL. The payload carries `cached` so the UI never mistakes
// a cached read for a fresh one. Cold starts and >30s gaps re-fetch.
// KEYED PER CLIENT (locationId): without the key, Troy's cached
// overview could be served to another client's request.
let overviewCacheMem = null; // { key, body, at }
const OVERVIEW_CACHE_TTL_MS = 30000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'overview';

  try {
    if (action === 'overview') {
      // Per-client: location/calendar/token resolve from the request
      // (lib-client.js). Unknown subdomain -> null -> honest 400.
      // NEVER Troy's feed: serving his live CRM data to a stranger's
      // subdomain would be a data leak, not a fallback.
      const ctx = resolveClientData(event);
      if (!ctx) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ ok: false, error: 'unknown client — no HighLevel location configured for this subdomain' }) };
      }
      if (overviewCacheMem && overviewCacheMem.key === ctx.locationId && (Date.now() - overviewCacheMem.at) < OVERVIEW_CACHE_TTL_MS) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ...overviewCacheMem.body, cached: true }) };
      }
      const [replies, booked, opps] = await Promise.all([
        getSellerReplies(ctx),
        getBookedToday(ctx),
        getOpportunities(ctx),
      ]);
      // Hot Leads scores come from CRM signals (no credits spent) — see
      // enrichHotLeads above. Best-effort: a failure here never breaks
      // the overview; leads just render without a score.
      try { await enrichHotLeads(opps.newLeads, ctx); } catch (e) { /* keep unscored */ }
      // Closed Volume = sum of closed deal values (GROSS volume, not
      // profit — no fee/cost data exists to compute real profit).
      const closedVolume = opps.closed.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0);
      // Close rate = closed ÷ fetched opps. Pagination (up to 1,000)
      // means the denominator is now the fetched count, not the old
      // first-100; closeRateCapped is true whenever HL's total exceeds
      // what was fetched, and the page labels the fetched count.
      const closeRate = opps.fetched > 0 ? Math.round((opps.closed.length / opps.fetched) * 100) : 0;
      const closeRateCapped = !!opps.capped;
      const body = {
        ok: true,
        sellerReplies: replies.count,
        recentReplies: replies.recent,
        bookedToday: booked.count,
        bookedRawCount: booked.rawCount || 0,
        todayAppointments: booked.appointments,
        underContract: opps.underContract.length,
        underContractDeals: opps.underContract.slice(0, 10),
        newLeads: opps.newLeads.slice(0, 9),
        newLeadsCount: opps.newLeads.length,
        closedCount: opps.closed.length,
        closedVolume,
        closeRate,
        closeRateCapped,
        totalOpps: opps.total,
        oppsFetched: opps.fetched,
        oppsTotal: opps.total,
        // Per-source errors (null when fine) so a silent zero is never
        // mistaken for "nothing happening" again.
        errors: { replies: replies.error || null, booked: booked.error || null, opps: opps.error || null },
        // fetchedAt is built from Date.now() (not `new Date()`) so a
        // mocked clock moves it too — the health-check suite simulates
        // 9:30 PM by stubbing Date.now, and `new Date()` ignores that
        // stub, which made a fresh read look 576 min stale.
        fetchedAt: new Date(Date.now()).toISOString(),
        cached: false,
      };
      overviewCacheMem = { key: ctx.locationId, body, at: Date.now() };
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(body),
      };
    }
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'cc-data failed', detail: String(err).slice(0, 200) }) };
  }
};

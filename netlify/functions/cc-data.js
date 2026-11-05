/* cc-data.js — Command Center data proxy for HighLevel.
   Provides live CRM data for command-center.html:
   GET /.netlify/functions/cc-data?action=overview
   Returns: sellerReplies, bookedToday, underContract, newLeads, closedDeals
   Uses HL_API_TOKEN env var (same as deals-api.js). Read-only. */
'use strict';

const HL_API_BASE = 'https://services.leadconnectorhq.com';
// Per-endpoint API versions, matching the working bot code (src/config.js).
// Conversations + Calendars ride 2021-04-15; Opportunities rides
// 2021-07-28. cc-data used 2021-07-28 for everything, which made the
// conversations and calendar reads fail silently (swallowed by .catch),
// so every CRM panel read zero even though the feed was up.
const HL_VERSION_CONVERSATIONS = '2021-04-15';
const HL_VERSION_CALENDARS = '2021-04-15';
const HL_VERSION_OPPORTUNITIES = '2021-07-28';
const HL_LOCATION_ID = 'krKoHLudPnn7nT0DPtwa';
const HL_CALENDAR_ID = 'aG6lop6FROsWlIrB0Y0H'; // Seller Calls - Paula
const TIMEOUT_MS = 20000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

async function hlFetch(path, method, body, version) {
  const token = process.env.HL_API_TOKEN;
  if (!token) throw new Error('HL_API_TOKEN not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(HL_API_BASE + path, {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + token,
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
async function getSellerReplies() {
  try {
    const sinceMs = Date.now() - 24 * 3600 * 1000;
    const data = await hlFetch(
      `/conversations/search?locationId=${HL_LOCATION_ID}&limit=100`,
      'GET', null, HL_VERSION_CONVERSATIONS
    ).catch(() => null);
    const convos = (data && data.conversations) || [];
    let inboundCount = 0;
    const recent = [];
    for (const c of convos.slice(0, 30)) {
      const lastMs = c.lastMessageDate ? new Date(c.lastMessageDate).getTime() : 0;
      if (!lastMs || lastMs < sinceMs) continue;
      const msgs = await hlFetch(`/conversations/${c.id}/messages?limit=5`, 'GET', null, HL_VERSION_CONVERSATIONS).catch(() => null);
      const list = (msgs && msgs.messages && msgs.messages.messages) || (msgs && msgs.messages) || [];
      if (!Array.isArray(list) || !list.length) continue;
      // HL returns newest first: the thread counts when its NEWEST
      // message is an inbound within 24h (an unanswered seller reply).
      const newest = list[0];
      if (!newest || newest.direction !== 'inbound') continue;
      const inboundMs = newest.dateAdded ? new Date(newest.dateAdded).getTime() : lastMs;
      if (inboundMs < sinceMs) continue;
      inboundCount++;
      if (recent.length < 8) {
        recent.push({
          contactName: c.fullName || c.contactName || 'Unknown',
          preview: String(newest.body || '').slice(0, 80),
          date: newest.dateAdded || c.lastMessageDate,
        });
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
async function getBookedToday() {
  try {
    const nowMs = Date.now();
    const startMs = nowMs - 12 * 3600 * 1000;
    const endMs = nowMs + 48 * 3600 * 1000;
    const todayEt = etDateStr(nowMs);
    const data = await hlFetch(
      `/calendars/events?locationId=${HL_LOCATION_ID}&calendarId=${HL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`,
      'GET', null, HL_VERSION_CALENDARS
    ).catch(() => null);
    const raw = (data && (data.events || data.appointments)) || (Array.isArray(data) ? data : []);
    const live = raw.filter((e) => {
      if (!e || !e.id) return false;
      const st = String(e.appointmentStatus || e.status || '').toLowerCase();
      if (st === 'cancelled' || st === 'invalid') return false;
      const sMs = e.startTime ? new Date(e.startTime).getTime() : (e.start_time ? new Date(e.start_time).getTime() : 0);
      if (!sMs) return false;
      return etDateStr(sMs) === todayEt;
    });
    live.sort((a, b) => new Date(a.startTime || a.start_time) - new Date(b.startTime || b.start_time));
    return {
      count: live.length,
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
async function getStageMap() {
  const data = await hlFetch(
    `/opportunities/pipelines?locationId=${HL_LOCATION_ID}`,
    'GET', null, HL_VERSION_OPPORTUNITIES
  );
  const pipes = (data && (data.pipelines || data.data)) || [];
  const map = new Map();
  for (const p of pipes) {
    const stages = p.stages || p.pipelineStages || [];
    for (const s of stages) {
      if (s && s.id) map.set(String(s.id), String(s.name || ''));
    }
  }
  return map;
}

// Get opportunities grouped by stage
async function getOpportunities() {
  try {
    const data = await hlFetch('/opportunities/search', 'POST', {
      locationId: HL_LOCATION_ID,
      limit: 100,
    }).catch(() => null);
    const opps = (data && (data.opportunities || data.data)) || [];
    // Resolve stage names via the pipelines endpoint (search gives IDs
    // only). If that lookup fails, fall back to status + recency.
    let stageMap = null;
    let stageError = null;
    try { stageMap = await getStageMap(); } catch (e) { stageError = String(e).slice(0, 100); }
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
    return { underContract, newLeads, closed, total: opps.length, error: stageError };
  } catch (e) {
    return { underContract: [], newLeads: [], closed: [], total: 0, error: String(e).slice(0, 100) };
  }
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'overview';

  try {
    if (action === 'overview') {
      const [replies, booked, opps] = await Promise.all([
        getSellerReplies(),
        getBookedToday(),
        getOpportunities(),
      ]);
      // Net profit = sum of closed deal values
      const netProfit = opps.closed.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0);
      // Close rate = closed / total
      const closeRate = opps.total > 0 ? Math.round((opps.closed.length / opps.total) * 100) : 0;
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          sellerReplies: replies.count,
          recentReplies: replies.recent,
          bookedToday: booked.count,
          todayAppointments: booked.appointments,
          underContract: opps.underContract.length,
          underContractDeals: opps.underContract.slice(0, 10),
          newLeads: opps.newLeads.slice(0, 12),
          newLeadsCount: opps.newLeads.length,
          closedCount: opps.closed.length,
          netProfit,
          closeRate,
          totalOpps: opps.total,
          // Per-source errors (null when fine) so a silent zero is never
          // mistaken for "nothing happening" again.
          errors: { replies: replies.error || null, booked: booked.error || null, opps: opps.error || null },
          fetchedAt: new Date().toISOString(),
        }),
      };
    }
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'cc-data failed', detail: String(err).slice(0, 200) }) };
  }
};

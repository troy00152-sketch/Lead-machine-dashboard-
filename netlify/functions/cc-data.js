/* cc-data.js — Command Center data proxy for HighLevel.
   Provides live CRM data for command-center.html:
   GET /.netlify/functions/cc-data?action=overview
   Returns: sellerReplies, bookedToday, underContract, newLeads, closedDeals
   Uses HL_API_TOKEN env var (same as deals-api.js). Read-only. */
'use strict';

const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_API_VERSION = '2021-07-28';
const HL_LOCATION_ID = 'krKoHLudPnn7nT0DPtwa';
const HL_CALENDAR_ID = 'aG6lop6FROsWlIrB0Y0H'; // Seller Calls - Paula
const TIMEOUT_MS = 20000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

async function hlFetch(path, method, body) {
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
        'Version': HL_API_VERSION,
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

// Count conversations with inbound SMS in the last 24h
async function getSellerReplies() {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const data = await hlFetch('/conversations/search', 'POST', {
      locationId: HL_LOCATION_ID,
      limit: 100,
      sortBy: 'last_message_date',
      sortOrder: 'desc',
    }).catch(() => null);
    const convos = (data && data.conversations) || [];
    let inboundCount = 0;
    const recent = [];
    for (const c of convos.slice(0, 30)) {
      if (!c.lastMessageDate) continue;
      if (new Date(c.lastMessageDate) < new Date(since)) continue;
      // Check if last message was inbound
      const msgs = await hlFetch(`/conversations/${c.id}/messages?limit=3`, 'GET').catch(() => null);
      const list = (msgs && msgs.messages && msgs.messages.messages) || msgs.messages || [];
      const lastInbound = list.filter(m => m.direction === 'inbound').pop();
      if (lastInbound) {
        inboundCount++;
        if (recent.length < 8) {
          recent.push({
            contactName: c.fullName || c.contactName || 'Unknown',
            preview: String(lastInbound.body || '').slice(0, 80),
            date: lastInbound.dateAdded || c.lastMessageDate,
          });
        }
      }
    }
    return { count: inboundCount, recent };
  } catch (e) {
    return { count: 0, recent: [], error: String(e).slice(0, 100) };
  }
}

// Count today's appointments on the Seller Calls calendar
async function getBookedToday() {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const data = await hlFetch(
      `/calendars/events?locationId=${HL_LOCATION_ID}&calendarId=${HL_CALENDAR_ID}&startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`,
      'GET'
    ).catch(() => null);
    const events = (data && data.events) || [];
    return {
      count: events.length,
      appointments: events.slice(0, 10).map(e => ({
        title: e.title || 'Appointment',
        startTime: e.startTime,
        contactName: (e.contactId && e.contactId.name) || e.title || '',
      })),
    };
  } catch (e) {
    return { count: 0, appointments: [], error: String(e).slice(0, 100) };
  }
}

// Get opportunities grouped by stage
async function getOpportunities() {
  try {
    const data = await hlFetch('/opportunities/search', 'POST', {
      locationId: HL_LOCATION_ID,
      limit: 100,
    }).catch(() => null);
    const opps = (data && data.opportunities) || [];
    const underContract = [];
    const newLeads = [];
    const closed = [];
    for (const o of opps) {
      const stage = String(o.pipelineStageName || o.stageName || '').toLowerCase();
      const item = {
        id: o.id,
        name: o.name || o.contactName || 'Unknown',
        stage: o.pipelineStageName || o.stageName || '',
        monetaryValue: o.monetaryValue || 0,
        createdAt: o.dateAdded || o.createdAt,
        contactId: o.contactId,
        address: extractAddress(o),
      };
      if (stage.includes('under contract')) underContract.push(item);
      else if (stage.includes('new') || stage.includes('lead')) newLeads.push(item);
      else if (stage.includes('closed') || stage.includes('sold') || stage.includes('won')) closed.push(item);
    }
    return { underContract, newLeads, closed, total: opps.length };
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
          fetchedAt: new Date().toISOString(),
        }),
      };
    }
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'cc-data failed', detail: String(err).slice(0, 200) }) };
  }
};

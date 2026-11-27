// netlify/functions/cc-sam-tools.js
// Server tools for Sam (ElevenLabs ElevenAgents): check_slots +
// book_appointment against the standalone Seller Calls calendar.
// The agent's tool definitions point here (URL +
// x-sam-tool-secret header). gate.ts bypasses this path — ElevenLabs
// posts with no dashboard cookie.
//
// Auth: the x-sam-tool-secret header must equal SAM_TOOL_SECRET
// (Netlify env). Fail closed: missing env = 500 (loud config error),
// wrong header = 401. Never book without the secret.
//
// Tool resolution: ?tool= in the query string wins, then a `tool` /
// `tool_name` field in the body, then the body shape (a booking
// carries seller_phone + time; a slot check does not). The ElevenLabs
// webhook-tool envelope is not version-pinned — parameters are read
// from body.parameters || body.params || body.
//
// Booking rules (standing, same as the text bot):
//   * only book a slot check_slots just confirmed free — the function
//     recomputes freeness at write time, so a double-book 422s into
//     {booked:false, error:'slot_taken', slots:[alternatives]}.
//   * slots are 30 min, Mon–Sat, 08:00–16:30 ET (cc-slots.js); the
//     agent offers times inside the seller's stated window and hands
//     off to Troy when none are free — this function never invents a
//     time outside the free list. The offer rule itself (up to 3
//     slots, at least 3h apart, inside the next 3 days) comes from the
//     stored Conversation AI config (cc-bot-config.js) and fails open
//     to those defaults — see handleCheckSlots.
//   * every booking writes to the cc-appointments store (the same
//     store the calendar page reads) AND to the HighLevel Seller
//     Calls calendar (cc-appointments syncs HL on every create —
//     Nov 27, 2026 fix: Blobs-only bookings never showed on the HL
//     calendar or in Booked Today) and fires the appointment push,
//     so a Sam booking shows on the calendar itself — Troy's Nov 26
//     proof requirement.
'use strict';

const slots = require('./cc-slots');
const appointments = require('./cc-appointments');
const botConfigMod = require('./cc-bot-config');

// Booking rules come from the stored Conversation AI config
// (cc-bot-config.js) — the same rule the screen shows — and fail open
// to the defaults (Seller Calls, 3 days / 3 slots / 3h apart,
// 08:00-16:30 ET Mon-Sat) when the store cannot be read. The HL Sam
// booking rule: offer up to `slots` times, each at least `minGapHours`
// apart, inside `windowDays` — applied by spaceSlots() below, the same
// helper the text bot's runner documents (its vendored booking.js has
// no gap knob yet; see cc-bot-runner.js).
async function resolveBotConfig(event, override) {
  if (override && typeof override === 'object') return override;
  try {
    const cfg = await botConfigMod.loadBotConfig(event);
    return cfg || botConfigMod.defaultConfig();
  } catch (e) {
    return botConfigMod.defaultConfig();
  }
}
function bookingOf(cfg) {
  const d = botConfigMod.defaultConfig().booking;
  return (cfg && cfg.booking && typeof cfg.booking === 'object') ? cfg.booking : d;
}

const SLOT_MINUTES = 30;

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

function fmtSlotLabel(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso)) + ' ET';
  } catch (e) {
    return String(iso);
  }
}

function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function parseTime(str) {
  const s = String(str || '').trim();
  let m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const pm = /[Pp]/.test(m[3]);
    if (h < 1 || h > 12 || min > 59) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { hour: h, minute: min };
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }
  return null;
}

function etDayBounds(date) {
  const start = slots.zonedTimeToUtc({ year: date.year, month: date.month, day: date.day, hour: 8, minute: 0 });
  const end = slots.zonedTimeToUtc({ year: date.year, month: date.month, day: date.day, hour: 16, minute: 30 }) + SLOT_MINUTES * 60 * 1000;
  return { start, end };
}

async function freeSlots(startMs, endMs, event) {
  const all = await appointments.listAppointments({ fromMs: startMs, toMs: endMs }, event);
  const free = slots.generateFreeSlots(all, startMs, endMs);
  return free.map((iso) => ({ iso, label: fmtSlotLabel(iso) }));
}

async function handleCheckSlots(params, event, botConfig) {
  const booking = bookingOf(await resolveBotConfig(event, botConfig));
  const windowDays = Math.min(14, Math.max(1, parseInt(booking.windowDays, 10) || 3));
  const offerCount = Math.min(6, Math.max(1, parseInt(booking.slots, 10) || 3));
  const minGapMs = Math.max(0, (parseInt(booking.minGapHours, 10) || 3)) * 60 * 60 * 1000;
  const now = Date.now();
  let startMs = now;
  let endMs = now + windowDays * 24 * 60 * 60 * 1000;
  let dayLabel = 'the next ' + windowDays + (windowDays === 1 ? ' day' : ' days');
  if (params.date) {
    const d = parseDate(params.date);
    if (!d) return { result: 'That date did not parse — I need it as year-month-day, like 2026-11-28.', slots: [] };
    const b = etDayBounds(d);
    startMs = b.start;
    endMs = b.end;
    dayLabel = fmtSlotLabel(new Date(b.start).toISOString()).replace(/ at .*$/, '');
  }
  const list = await freeSlots(startMs, endMs, event);
  // HL Sam booking rule: at most `slots` offers, each at least
  // `minGapHours` apart (greedy, chronological — the free list is
  // 30-minute steps, so without this Sam would offer 8:00, 8:30, 9:00).
  const keptIsos = botConfigMod.spaceSlots(list.map((s) => s.iso), offerCount, minGapMs);
  const capped = keptIsos.map((iso) => list.find((s) => s.iso === iso)).filter(Boolean);
  if (!capped.length) {
    return { result: 'There are no free appointment slots ' + (params.date ? 'on ' + dayLabel : 'in ' + dayLabel) + '.', slots: [] };
  }
  return {
    result: 'Free slots ' + (params.date ? 'on ' + dayLabel : 'in ' + dayLabel) + ': ' + capped.map((s) => s.label).join('; ') + '.',
    slots: capped,
  };
}

async function handleBookAppointment(params, event, botConfig) {
  const date = parseDate(params.date);
  const time = parseTime(params.time);
  const name = String(params.seller_name || params.name || '').trim();
  const phone = String(params.seller_phone || params.phone || '').trim();
  const address = String(params.property_address || params.address || '').trim();
  if (!date) return { booked: false, error: 'bad_date', result: 'I need the date as year-month-day, like 2026-11-28.' };
  if (!time) return { booked: false, error: 'bad_time', result: 'I need the time as hour and minutes, like 10:00 AM.' };
  if (!name || !phone || !address) {
    return { booked: false, error: 'missing_details', result: 'I need the seller name, callback number, and property address before I can book.' };
  }
  const startMs = slots.zonedTimeToUtc({ year: date.year, month: date.month, day: date.day, hour: time.hour, minute: time.minute });
  const endMs = startMs + SLOT_MINUTES * 60 * 1000;
  // Server-side freeness check: the slot must be in today's free
  // list right now, not just when Sam last asked.
  const b = etDayBounds(date);
  const free = await freeSlots(b.start, b.end, event);
  const wantedIso = new Date(startMs).toISOString();
  const isFree = free.some((s) => s.iso === wantedIso);
  if (!isFree) {
    // Alternatives follow the same offer rule as check_slots (at most
    // `slots`, at least `minGapHours` apart) instead of three
    // back-to-back 30-minute times.
    const booking = bookingOf(await resolveBotConfig(event, botConfig));
    const offerCount = Math.min(6, Math.max(1, parseInt(booking.slots, 10) || 3));
    const minGapMs = Math.max(0, (parseInt(booking.minGapHours, 10) || 3)) * 60 * 60 * 1000;
    const altIsos = botConfigMod.spaceSlots(free.map((s) => s.iso), offerCount, minGapMs);
    const alts = altIsos.map((iso) => free.find((s) => s.iso === iso)).filter(Boolean);
    return {
      booked: false,
      error: 'slot_taken',
      result: 'That time is no longer free.' + (alts.length ? ' The nearest free times are: ' + alts.map((s) => s.label).join('; ') + '.' : ' There are no other free times that day.'),
      slots: alts,
    };
  }
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();
  const created = await appointments.createAppointment({
    calendarId: 'seller-calls',
    contactId: params.thread_key || params.threadKey || null,
    phone,
    name,
    address1: address,
    title: 'Seller call — ' + name + ' — ' + address,
    startISO,
    endISO,
    startMs,
    endMs,
    status: 'confirmed',
    source: 'sam',
  }, event);
  const label = fmtSlotLabel(startISO);
  return {
    booked: true,
    appointment_id: created && created.id,
    date: params.date,
    time: params.time,
    label,
    result: 'Booked: ' + label + ' for ' + name + ' (' + address + ').',
  };
}

exports.handler = async (event) => {
  const secret = String(process.env.SAM_TOOL_SECRET || '');
  if (!secret) {
    console.error('[cc-sam-tools] SAM_TOOL_SECRET unset — refusing to run Sam tools');
    return respond(500, { error: 'Sam tools are not configured (SAM_TOOL_SECRET missing)' });
  }
  const headers = event.headers || {};
  const got = String(headers['x-sam-tool-secret'] || headers['X-Sam-Tool-Secret'] || headers['X-SAM-TOOL-SECRET'] || '');
  if (got !== secret) return respond(401, { error: 'unauthorized' });
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return respond(400, { error: 'Bad JSON' });
  }
  const query = event.queryStringParameters || {};
  const params = (body && body.parameters) || (body && body.params) || body || {};
  const tool =
    String(query.tool || '') ||
    String(body.tool || body.tool_name || body.name || '') ||
    (((params.seller_phone || params.phone) && (params.time || params.start)) ? 'book_appointment' : 'check_slots');
  console.log('[cc-sam-tools] tool=' + tool);
  try {
    // One config load per invocation, threaded into both tools so a
    // screen edit to the booking rule lands on Sam's next call.
    const botConfig = await resolveBotConfig(event);
    if (tool === 'check_slots') {
      return respond(200, await handleCheckSlots(params, event, botConfig));
    }
    if (tool === 'book_appointment') {
      return respond(200, await handleBookAppointment(params, event, botConfig));
    }
    return respond(400, { error: 'unknown tool: ' + tool });
  } catch (e) {
    console.error('[cc-sam-tools] ' + tool + ' failed:', (e && e.message) || e);
    return respond(500, { error: 'tool failed: ' + String((e && e.message) || e) });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  parseDate,
  parseTime,
  handleCheckSlots,
  handleBookAppointment,
};

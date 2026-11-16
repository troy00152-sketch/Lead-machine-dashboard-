// netlify/functions/cc-slots.js
// Standalone Command Center: Seller Calls slot generation.
// PURE module — no store, no network.
//
// Calendar rules: America/New_York, Mon–Sat (Sunday out), 30-minute
// slots, starts 08:00 through 16:30 ET inclusive (18 starts per day).
'use strict';

const TIMEZONE = 'America/New_York';

const SELLER_CALLS = {
  id: 'seller-calls',
  calendarId: 'seller-calls',
  timezone: TIMEZONE,
  slotMinutes: 30,
  slotDurationMinutes: 30,
  startHour: 8,
  startMinute: 0,
  endHour: 16,
  endMinute: 30,
  lastStartHour: 16,
  lastStartMinute: 30,
  // JS day numbers (0 = Sunday) that are open.
  daysOfWeek: [1, 2, 3, 4, 5, 6],
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// {year, month, day, hour, minute, weekday} in America/New_York.
// weekday is the short English name ('Mon', ...), matching the
// cc-workflow-engine etParts convention.
function zonedParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday,
  };
}

// Epoch ms for a wall-clock time in America/New_York. DST-safe:
// iterate the Intl-derived offset until the guess's zoned wall time
// equals the target wall time (converges in <=3 steps, including
// across the spring-forward / fall-back transitions).
function zonedTimeToUtc({ year, month, day, hour, minute }) {
  const targetWall = Date.UTC(year, month - 1, day, hour, minute || 0);
  let utc = targetWall;
  for (let i = 0; i < 5; i++) {
    const p = zonedParts(utc);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = targetWall - wall;
    if (diff === 0) break;
    utc += diff;
  }
  return utc;
}

function apptRange(a) {
  let start = null;
  let end = null;
  if (a.startMs != null) start = Number(a.startMs);
  else if (a.startTime) start = Date.parse(a.startTime);
  else if (a.startISO) start = Date.parse(a.startISO);
  else if (a.start) start = typeof a.start === 'number' ? a.start : Date.parse(a.start);
  if (a.endMs != null) end = Number(a.endMs);
  else if (a.endTime) end = Date.parse(a.endTime);
  else if (a.endISO) end = Date.parse(a.endISO);
  else if (a.end) end = typeof a.end === 'number' ? a.end : Date.parse(a.end);
  return {
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
  };
}

function generateFreeSlots(appointments, startMs, endMs) {
  const appts = (Array.isArray(appointments) ? appointments : [])
    .filter((a) => {
      if (!a) return false;
      const st = String(a.status || a.appointmentStatus || '').toLowerCase();
      return st !== 'cancelled' && st !== 'invalid';
    })
    .map(apptRange)
    .filter((r) => r.start != null && r.end != null);

  const out = [];
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs)) || endMs <= startMs) return out;

  // Walk ET calendar dates from the date containing startMs to the
  // date containing endMs - 1.
  const first = zonedParts(startMs);
  const last = zonedParts(endMs - 1);
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  const lastCursor = Date.UTC(last.year, last.month - 1, last.day);
  const slotMs = SELLER_CALLS.slotMinutes * 60 * 1000;

  while (cursor <= lastCursor) {
    const d = new Date(cursor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const dow = d.getUTCDay(); // weekday of that ET calendar date
    if (SELLER_CALLS.daysOfWeek.includes(dow)) {
      const minsStart = SELLER_CALLS.startHour * 60 + SELLER_CALLS.startMinute;
      const minsEnd = SELLER_CALLS.endHour * 60 + SELLER_CALLS.endMinute;
      for (let mins = minsStart; mins <= minsEnd; mins += SELLER_CALLS.slotMinutes) {
        const hour = Math.floor(mins / 60);
        const minute = mins % 60;
        const slotStart = zonedTimeToUtc({ year, month, day, hour, minute });
        const slotEnd = slotStart + slotMs;
        if (slotStart < startMs || slotStart >= endMs) continue;
        const blocked = appts.some((a) => slotStart < a.end && a.start < slotEnd);
        if (!blocked) out.push(new Date(slotStart).toISOString());
      }
    }
    cursor += 24 * 60 * 60 * 1000;
  }
  return out.sort();
}

module.exports = {
  SELLER_CALLS,
  zonedParts,
  zonedTimeToUtc,
  generateFreeSlots,
};

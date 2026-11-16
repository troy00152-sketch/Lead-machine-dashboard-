/**
 * booking.js — specific open times from the "Paula Thomas" calendar.
 *
 * Oct 21 drought lesson: never end a warm thread with a generic "quick call?"
 * — always offer SPECIFIC times pulled live from the calendar.
 */
'use strict';

/** Format an ISO slot for a text message, in the bot timezone (ET).
 * Nov 2, 2026 (Kevin Kenna lesson): when the slot is TODAY, say "Today"
 * not the weekday name — the bot told a seller "Monday afternoon" on a
 * Monday, which reads like next Monday. Same-day = "Today". */
function formatSlot(iso, timeZone, now = new Date()) {
  const d = new Date(iso);
  const slotParts = etDateParts(d, timeZone);
  const nowParts = etDateParts(now, timeZone);
  const isToday = slotParts.y === nowParts.y && slotParts.m === nowParts.m && slotParts.d === nowParts.d;
  const day = isToday
    ? 'Today'
    : new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return `${day} at ${time}`;
}

/** Keep slots inside Mon–Sat, 8 AM–5 PM ET (Troy works Monday–
 * Saturday). Oct 24, 8:06 PM lesson: Saturday was wrongly excluded, so
 * a Friday request sent on a Saturday fell back to Monday times — the
 * seller's day must be bookable, not just the next weekday. Sunday
 * stays out (not a working day). */
function inBookingWindow(iso, timeZone) {
  const d = new Date(iso);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(d);
  if (weekday === 'Sun') return false;
  const hourParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const hour = parseInt(hourParts.find((p) => p.type === 'hour').value, 10) % 24;
  return hour >= 8 && hour < 17;
}

/** ET calendar-date parts for a timestamp (DST-safe: uses the zone). */
function etDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * Resolve a day the seller named ("Friday", "tomorrow", "next Saturday")
 * to its next occurrence on/after today (ET). Returns
 * { weekday, date } where date is noon UTC on that ET date, or null
 * when the message names no single day (zero, or two+ distinct days —
 * those ride the model's offer list, not a day-targeted one).
 */
function resolveNamedDay(text, now = new Date(), timeZone) {
  const found = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tue|tues|wed|thu|thur|thurs|fri|today|tomorrow)\b/g
  )) {
    found.add(WEEKDAY_ALIASES[m[1]] || m[1]);
  }
  if (found.size !== 1) return null;
  let target = [...found][0];
  const todayWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
  }).format(now).toLowerCase();
  if (target === 'today') target = todayWeekday;
  if (target === 'tomorrow') {
    const { y, m, d } = etDateParts(now, timeZone);
    const tmr = new Date(Date.UTC(y, m - 1, d + 1, 12));
    target = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
    }).format(tmr).toLowerCase();
  }
  const { y, m, d } = etDateParts(now, timeZone);
  for (let off = 0; off < 8; off++) {
    const probe = new Date(Date.UTC(y, m - 1, d + off, 12));
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
    }).format(probe).toLowerCase();
    if (wd === target) return { weekday: target, date: probe };
  }
  return null;
}

/**
 * Free slots for one specific ET date, however far out (Oct 24, 8:06 PM
 * lesson: next Friday from a Saturday is 6 days out — beyond the 5-day
 * offer/bookable windows — so a named day is fetched directly instead
 * of riding those windows). The query range brackets the whole ET day;
 * results are filtered to that ET date, so a "Friday" request can never
 * book a Monday slot by mistake.
 */
async function getDaySlots(hl, config, namedDay, now = new Date()) {
  if (!config.calendarId || !namedDay) return [];
  const start = namedDay.date.getTime() - 12 * 60 * 60 * 1000;
  const end = namedDay.date.getTime() + 36 * 60 * 60 * 1000;
  const raw = await hl.getFreeSlots(config.calendarId, start, end);
  const target = etDateParts(namedDay.date, config.timezone);
  const kept = raw.filter((iso) => {
    const p = etDateParts(new Date(iso), config.timezone);
    return (
      p.y === target.y && p.m === target.m && p.d === target.d &&
      new Date(iso).getTime() > now.getTime() + 60 * 60 * 1000 &&
      inBookingWindow(iso, config.timezone)
    );
  });
  return kept.slice(0, config.slotOfferCount || 4).map((iso) => ({
    startISO: iso,
    endISO: new Date(new Date(iso).getTime() + 30 * 60 * 1000).toISOString(),
    label: formatSlot(iso, config.timezone, now),
  }));
}

/**
 * Fetch up to `count` upcoming offerable slots starting from tomorrow
 * (same-day slots are only offered if >1h out — simpler and safer to start
 * tomorrow; the calendar free-slots endpoint already excludes the past).
 *
 * opts.excludeDays: weekday names (e.g. ['Monday']) to skip — used when the
 * seller just declined those days, so the next offer is genuinely new days.
 */
async function getOfferSlots(hl, config, now = new Date(), opts = {}) {
  if (!config.calendarId) return [];
  const start = now.getTime();
  const end = start + (config.slotDaysAhead || 5) * 24 * 60 * 60 * 1000;
  const raw = await hl.getFreeSlots(config.calendarId, start, end);
  const future = raw.filter((iso) => new Date(iso).getTime() > start + 60 * 60 * 1000);
  const inWindow = future.filter((iso) => inBookingWindow(iso, config.timezone));
  const excluded = new Set((opts.excludeDays || []).map((d) => String(d).toLowerCase()));
  const kept = excluded.size
    ? inWindow.filter((iso) => {
        const day = new Intl.DateTimeFormat('en-US', {
          timeZone: config.timezone,
          weekday: 'long',
        }).format(new Date(iso)).toLowerCase();
        return !excluded.has(day);
      })
    : inWindow;
  return kept.slice(0, config.slotOfferCount || 4).map((iso) => ({
    startISO: iso,
    // HL calendars here run 30-minute slots (Paula Thomas calendar spec).
    endISO: new Date(new Date(iso).getTime() + 30 * 60 * 1000).toISOString(),
    label: formatSlot(iso, config.timezone, now),
  }));
}

/**
 * Full bookable window (Oct 24, 4:56 PM lesson): the slots a pick is
 * VERIFIED against. Unlike getOfferSlots this is NOT capped and NOT
 * day-excluded: the seller may answer an offer made in an earlier
 * message (e.g. Tuesday times offered after a Monday decline), and the
 * pick run's fresh 4-slot offer list no longer contains them. The safety
 * property is preserved — only real free slots on the calendar can book
 * — while a correct pick from an earlier offer can never be rejected
 * for being "unoffered".
 */
async function getBookableSlots(hl, config, now = new Date()) {
  if (!config.calendarId) return [];
  const start = now.getTime();
  const end = start + (config.slotDaysAhead || 5) * 24 * 60 * 60 * 1000;
  const raw = await hl.getFreeSlots(config.calendarId, start, end);
  const future = raw.filter((iso) => new Date(iso).getTime() > start + 60 * 60 * 1000);
  const inWindow = future.filter((iso) => inBookingWindow(iso, config.timezone));
  return inWindow.map((iso) => ({
    startISO: iso,
    // HL calendars here run 30-minute slots (Paula Thomas calendar spec).
    endISO: new Date(new Date(iso).getTime() + 30 * 60 * 1000).toISOString(),
    label: formatSlot(iso, config.timezone, now),
  }));
}

const MONTH_NAMES = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
  sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Resolve a month the seller named ("December", "next January", "next
 * month") to its next occurrence. Returns { year, month (0–11), label },
 * or null when no month is named. A month earlier in the year than now
 * rolls to next year ("January" said in October = next January); "next"
 * before the current month pushes it a further year out.
 */
function resolveNamedMonth(text, now = new Date(), timeZone) {
  const lower = String(text || '').toLowerCase();
  if (/\bnext month\b/.test(lower)) {
    const { y, m } = etDateParts(now, timeZone);
    return m === 12
      ? { year: y + 1, month: 0, label: 'January' }
      : { year: y, month: m, label: MONTH_LABELS[m] };
  }
  // Oct 28, Khaoula lesson: "may I ask" is the modal verb, NOT the month May.
  // Oct 28, Douglas Pope lesson: "he may need the money" ALSO fired a May
  // booking offer — the old guard only skipped "may" before a pronoun or a
  // listed verb, so "may need" read as the month. Inverted, fix once and
  // for all: bare "may" is the month ONLY with positive month evidence
  // (a month-position word before it, a day number/year after it, or a
  // sentence-start acceptance). Anything else is the modal verb and is
  // skipped — a missed month degrades gracefully to the model, while a
  // modal read as a month fires a nonsense offer.
  const MONTH_BEFORE = new Set(['in', 'for', 'during', 'by', 'until', 'before', 'after', 'this', 'next', 'come', 'early', 'late', 'about', 'around', 'of', 'do']);
  const MONTH_ACCEPT = new Set(['works', 'work', 'is', 'would', 'sounds', 'fine', 'good', 'ok', 'okay']);
  const monthRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g;
  let m = null;
  for (const cand of lower.matchAll(monthRe)) {
    if (cand[1] === 'may') {
      const before = lower.slice(0, cand.index).match(/([a-z]+)\s*$/)?.[1];
      const afterRaw = lower.slice(cand.index + cand[0].length);
      const next = afterRaw.match(/^\s+([a-z]+)/)?.[1];
      const isMonth = (before && MONTH_BEFORE.has(before))
        || /^\s*\d/.test(afterRaw)
        || ((!before || before === 'and' || before === 'but' || before === 'or') && next && MONTH_ACCEPT.has(next))
        || (next === 'or' && /^\s+or\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(afterRaw));
      if (!isMonth) continue;
    }
    m = cand;
    break;
  }
  if (!m) return null;
  const monthIdx = MONTH_NAMES[m[1]];
  const { y, m: curM } = etDateParts(now, timeZone);
  let year = y;
  if (monthIdx + 1 < curM) year = y + 1;
  if (monthIdx + 1 === curM && new RegExp(`\\bnext\\s+${m[1]}`).test(lower)) year = y + 1;
  return { year, month: monthIdx, label: MONTH_LABELS[monthIdx] };
}

const MONTH_TOKEN = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function monthMentionIndex(lowerText, re) {
  const m = String(lowerText || '').match(re);
  return m ? MONTH_NAMES[m[1]] : -1;
}

/**
 * Move-timeline month mention (Nov 14, 2026, Paula test — the root cause
 * of the "in February" bug): a seller naming a month for their MOVE
 * ("trying to move in february", "need to be out by February", "selling
 * by March") is stating their timeline, NOT asking to schedule the call
 * in that month. resolveNamedMonth cannot tell the two apart — it
 * resolves ANY month name — so the handler's month block fetched that
 * month's slots and the deterministic month offer (step 8.6) sent them,
 * returning before the model path (and its step-11.9 foreign-month
 * guard) ever ran. True when the named month is governed by move / out /
 * sell language in the text.
 */
function isMoveMonthMention(text, namedMonth) {
  if (!namedMonth) return false;
  const lower = String(text || '').toLowerCase();
  const M = MONTH_TOKEN;
  const res = [
    // moving / move / relocating ... in|by|before|around|during <month>
    new RegExp(`\\b(?:moving|move|moved|relocating|relocated|relocation)\\b[^.!?]{0,40}?\\b(?:in|by|before|around|during)\\s+(?:the\\s+month\\s+of\\s+)?${M}\\b`),
    // out / gone / leaving / vacating ... by|in <month> ("be out by February")
    new RegExp(`\\b(?:out|gone|leave|leaving|left|vacate|vacating)\\b[^.!?]{0,24}?\\b(?:by|in)\\s+${M}\\b`),
    // sell / close / list ... by|in <month> — the sale timeline, not a call
    new RegExp(`\\b(?:sell|selling|sold|close|closing|list|listing)\\b[^.!?]{0,24}?\\b(?:by|in)\\s+${M}\\b`),
  ];
  for (const re of res) {
    const m = lower.match(re);
    if (!m || MONTH_NAMES[m[1]] !== namedMonth.month) continue;
    // A DAY NUMBER right after the month ("out by Dec 1") names a concrete
    // calendar date, not a bare-month timeline — the Oct 28 Joseph Puig
    // shape, whose recorded behavior is the December month offer. A
    // 4-digit year ("moving in February 2027") is NOT a day number.
    const after = lower.slice(m.index + m[0].length);
    if (/^\s+\d{1,2}(?:st|nd|rd|th)?(?!\d)/.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * Scheduling-month intent (Nov 14, 2026, Troy): a named month becomes a
 * SCHEDULING month only when the seller directs the call/appointment to
 * it — "talk in December", "check back with me in February", "let's set
 * a time in February", "not until February", "December works". This is
 * the override that keeps genuine month scheduling (the Oct 24/25 month
 * offers) working even when a move month is also mentioned.
 */
function hasSchedulingMonthIntent(text, namedMonth) {
  if (!namedMonth) return false;
  const lower = String(text || '').toLowerCase();
  const M = MONTH_TOKEN;
  const res = [
    // talk / call / meet / schedule / check back / set a time ... in <month>
    new RegExp(`\\b(?:talk|speak|call|chat|meet|schedule|book|check\\s+back|call\\s+back|follow\\s+up|reach\\s+out|set\\s+(?:up|a\\s+time)|do\\s+it)\\b[^.!?]{0,32}?\\b(?:in|during)\\s+${M}\\b`),
    // not until / wait until / hold off until <month>
    new RegExp(`\\b(?:not\\s+until|wait\\s+until|hold\\s+off\\s+until|push\\s+(?:it\\s+)?to)\\s+${M}\\b`),
    // <month> works / would work / is better
    new RegExp(`\\b${M}\\s+(?:works|work|is\\s+better|is\\s+good|is\\s+fine|would\\s+work)\\b`),
    // can / could we ... <month>, or "do <month>"
    new RegExp(`\\b(?:can|could)\\s+we\\b[^.!?]{0,24}?\\b${M}\\b`),
    new RegExp(`\\bdo\\s+${M}\\b`),
  ];
  return res.some((re) => monthMentionIndex(lower, re) === namedMonth.month);
}

/**
 * The month the seller is asking to SCHEDULE in, or null. A month named
 * only as a move timeline (isMoveMonthMention) with no scheduling intent
 * (hasSchedulingMonthIntent) resolves to null, so the handler never
 * fetches that month's slots, never fires the deterministic month
 * offer, and the seller hears the real near-term times instead — with
 * the step-11.9 guard as backstop if the model still echoes the month.
 */
function resolveSchedulingMonth(text, now = new Date(), timeZone) {
  const named = resolveNamedMonth(text, now, timeZone);
  if (!named) return null;
  if (isMoveMonthMention(text, named) && !hasSchedulingMonthIntent(text, named)) return null;
  return named;
}

/**
 * Free slots for one whole ET month, however far out (Oct 24, 8:17 PM
 * lesson: a seller out of the country until December/January must still
 * be bookable for that month — the 5-day windows can never reach it).
 * The query brackets the ET month; results are filtered to it.
 */
/**
 * Oct 28, Joseph Puig lesson: a month offer capped at the first 4 slots
 * always shows ONE day (Dec 1, 8:00-9:30 AM) because the feed returns
 * slots chronologically. Spread across days instead: up to 2 slots per
 * day over up to 4 days, so the seller sees more days AND more times.
 */
function spreadSlotsByDay(keptIsos, tz, perDay = 2, maxDays = 4) {
  const days = [];
  const byDay = new Map();
  for (const iso of keptIsos) {
    const p = etDateParts(new Date(iso), tz);
    const key = `${p.y}-${p.m}-${p.d}`;
    if (!byDay.has(key)) { byDay.set(key, []); days.push(key); }
    if (byDay.get(key).length < perDay) byDay.get(key).push(iso);
  }
  const out = [];
  for (const key of days.slice(0, maxDays)) out.push(...byDay.get(key));
  return out;
}

async function getMonthSlots(hl, config, namedMonth, now = new Date()) {
  if (!config.calendarId || !namedMonth) return [];
  // Oct 24, 8:35 PM lesson: HL's free-slots endpoint REJECTS ranges over
  // 31 days (400 "Date range cannot be more than 31 days"). The old
  // ±1-day padding made every 31-day month a 33-day range — December
  // failed before it ever returned a slot. The exact UTC month is at
  // most 31 days, and the window filter (Mon–Sat, 8 AM–5 PM ET) means
  // no bookable ET slot can fall outside it: the latest slot on the
  // month's last day is 4:30 PM ET, still inside the UTC month.
  const start = Date.UTC(namedMonth.year, namedMonth.month, 1);
  const end = Date.UTC(namedMonth.year, namedMonth.month + 1, 1);
  const raw = await hl.getFreeSlots(config.calendarId, start, end);
  const kept = raw.filter((iso) => {
    const p = etDateParts(new Date(iso), config.timezone);
    return (
      p.y === namedMonth.year && p.m === namedMonth.month + 1 &&
      new Date(iso).getTime() > now.getTime() + 60 * 60 * 1000 &&
      inBookingWindow(iso, config.timezone)
    );
  });
  return spreadSlotsByDay(kept, config.timezone).map((iso) => ({
    startISO: iso,
    endISO: new Date(new Date(iso).getTime() + 30 * 60 * 1000).toISOString(),
    label: formatSlot(iso, config.timezone, now),
  }));
}

/**
 * Explicit calendar-date pick ("December 15 at 9 am"). Returns
 * { year, month (0–11), day, times } — the time candidates in label form
 * — or null when the message carries no month+day+time pattern. The
 * year rolls forward when the date already passed this year.
 */
function findDatePick(text, now = new Date(), timeZone) {
  const m = String(text || '').match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b[^0-9]{0,25}?(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?/i
  );
  if (!m) return null;
  const h = parseInt(m[3], 10);
  if (h < 1 || h > 12) return null;
  const monthIdx = MONTH_NAMES[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (day < 1 || day > 31) return null;
  const { y } = etDateParts(now, timeZone);
  let year = y;
  const probe = new Date(Date.UTC(y, monthIdx, day, 12));
  if (probe.getTime() < now.getTime() - 24 * 60 * 60 * 1000) year = y + 1;
  const mm = m[4] || '00';
  const ap = m[5] ? m[5].toUpperCase() : null;
  const times = ap ? [`${h}:${mm} ${ap}M`] : [`${h}:${mm} AM`, `${h}:${mm} PM`];
  return { year, month: monthIdx, day, times };
}
const WEEKDAY_ALIASES = {
  mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday',
  thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday',
};

/**
 * Inbound pick parser (Oct 24, 5:19 PM lesson): the seller naming a real
 * time outright ("Tuesday at 8:30 am") IS the booking. The model only
 * ever sees the 4 current offer slots, so it talked a Tuesday pick back
 * to Monday instead of booking it. This matches the pick against slot
 * LABELS (already in ET), so no timezone math is needed: a weekday
 * repeats at most once inside the 5-day bookable window, so weekday +
 * time identifies at most one slot.
 *
 * Returns the matched slot, or null when: no weekday+time pattern, the
 * time matches zero or several slots, several distinct picks appear
 * (ambiguous — let the model sort it out), or the day is one the seller
 * just declined (a decline naming a time is never a pick). Bare hours
 * ("8") are deliberately NOT parsed — those ride the model's offered
 * list. A date ("October 27") in the message is stripped first so its
 * day-number can never hijack the hour position.
 */
function findInboundPickSlot(text, slots = [], opts = {}) {
  const raw = String(text || '');
  const cleaned = raw
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/gi, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, ' ');
  const declined = new Set((opts.declinedDays || []).map((d) => String(d).toLowerCase()));
  const pattern = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tue|tues|wed|thu|thur|thurs|fri|today|tomorrow)\b[^0-9]{0,25}?(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?/gi;
  const picks = new Map();
  for (const m of cleaned.matchAll(pattern)) {
    const h = parseInt(m[2], 10);
    if (h < 1 || h > 12) continue;
    let weekday = m[1].toLowerCase();
    if (weekday === 'today' || weekday === 'tomorrow') {
      const probe = new Date((opts.now || new Date()).getTime() + (weekday === 'tomorrow' ? 86400000 : 0));
      weekday = new Intl.DateTimeFormat('en-US', { timeZone: opts.timeZone, weekday: 'long' }).format(probe).toLowerCase();
    } else {
      weekday = WEEKDAY_ALIASES[weekday] || weekday;
    }
    const mm = m[3] || '00';
    const ap = m[4] ? m[4].toUpperCase() : null;
    const times = ap ? [`${h}:${mm} ${ap}M`] : [`${h}:${mm} AM`, `${h}:${mm} PM`];
    picks.set(`${weekday}|${times.join('/')}`, { weekday, times });
  }
  if (picks.size !== 1) return null;
  const { weekday, times } = [...picks.values()][0];
  if (declined.has(weekday)) return null;
  // Nov 2, 2026 (Kevin Kenna): slot labels now say "Today" for same-day slots.
  // If the user names the weekday that IS today (e.g. "Monday" on a Monday),
  // match slots labeled "Today" too.
  const now = opts.now || new Date();
  const tz = opts.timeZone || 'America/New_York';
  const todayWeekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
  const matches = (slots || []).filter((s) => {
    if (!s || !s.label) return false;
    const labelLower = s.label.toLowerCase();
    const dayMatch = labelLower.startsWith(weekday) ||
      (weekday === todayWeekday && labelLower.startsWith('today'));
    return dayMatch && times.some((c) => s.label.includes(c));
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * UTC instant for an ET wall-clock time (DST-safe: iterates the zone
 * offset to convergence). month0 is 0-based like Date.UTC. Used to
 * build far-out slots the free-slots feed never returns.
 */
function zonedTimeToUtc(year, month0, day, hh, mm, timeZone) {
  const target = Date.UTC(year, month0, day, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(guess));
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const diff = target - asUTC;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * Seller-facing display timezone for this conversation (Oct 29, 2026,
 * Troy): ONLY the Kansas City market is Central — every other market is
 * Eastern. Resolved from the HighLevel number that received the message
 * (10 digits, as normalizePhoneDigits returns). Unknown or missing number
 * defaults to the bot timezone (Eastern) — the pre-change behavior.
 */
function displayTimeZoneFor(toNumber, config) {
  const d = String(toNumber || '').replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length === 10 && config.centralMarketNumbers && config.centralMarketNumbers.has(ten)) {
    return config.centralTimezone || 'America/Chicago';
  }
  return config.timezone || 'America/New_York';
}

/** 'Central' or 'Eastern' — the short name for prompt copy. */
function tzShortName(timeZone) {
  return String(timeZone || '').toLowerCase().includes('chicago') ? 'Central' : 'Eastern';
}

/**
 * Re-render slot labels in the seller's local timezone. Slot ISOs are
 * absolute instants — only the human-readable label changes, so the
 * calendar booking always lands on the right moment ("automatically
 * adjusts"). All internal logic (booking window, day resolution) stays
 * in the bot timezone; this is presentation only.
 *
 * Oct 29, 2026, Troy (Ivory Mims lesson): a Kansas City seller read a bare
 * "8:00 AM" as 8:00 Central while the calendar held 8:00 Eastern. Every
 * Central-market label now says the word out loud; Eastern labels stay
 * bare (unambiguous there). Labels rebuild from the ISO each call, so a
 * double relabel can never stack " Central" twice.
 *
 * Nov 11, 2026: `now` is a parameter, not wall-clock. The old code called
 * formatSlot with its default (real `new Date()`), so the "Today" label
 * went stale the day after the slot's date — the Nov 2 timezone tests
 * and the Nov 9 window-pick tests all failed on Nov 11 because Nov 2/9
 * slots no longer read as "Today", which broke pick/claim matching
 * downstream. Callers pass their injected clock; the default keeps the
 * old behavior for direct callers. */
function relabelSlots(slots, timeZone, now = new Date()) {
  const suffix = tzShortName(timeZone) === 'Central' ? ' Central' : '';
  return (slots || []).map((s) =>
    s && s.startISO ? { ...s, label: formatSlot(s.startISO, timeZone, now) + suffix } : s
  );
}

/** Live (non-cancelled) events on the calendar for one ET date. */
async function dayBusyEvents(hl, config, day) {
  const tz = config.timezone;
  const start = zonedTimeToUtc(day.year, day.month, day.day, 0, 0, tz);
  const end = zonedTimeToUtc(day.year, day.month, day.day + 1, 0, 0, tz);
  return hl.getCalendarEvents(config.calendarId, start, end);
}

function slotOverlapsBusy(startMs, endMs, busy) {
  return (busy || []).some((e) => {
    const s = new Date(e.startTime).getTime();
    const en = new Date(e.endTime).getTime();
    return startMs < en && endMs > s;
  });
}

function buildSlot(startMs, timeZone, now = new Date()) {
  const iso = new Date(startMs).toISOString();
  return {
    startISO: iso,
    endISO: new Date(startMs + 30 * 60 * 1000).toISOString(),
    label: formatSlot(iso, timeZone, now),
    synthetic: true,
  };
}

/**
 * Morning slots for one ET date, verified against the calendar's REAL
 * events instead of the free-slots feed. Oct 24, 8:35 PM lesson: the
 * feed returns nothing past ~5 days (Friday, 6 days out, came back
 * empty with no error) — so a far-out day that the feed has no data
 * for is checked here: same 4 morning times the calendar offers
 * near-term, minus anything an existing event overlaps. Sunday yields
 * nothing (not a working day). ONLY used when the feed returned empty
 * for the date — never to override feed data.
 */
async function getSyntheticDaySlots(hl, config, day, now = new Date()) {
  if (!config.calendarId || !day) return [];
  const tz = config.timezone;
  // Accepts a namedDay ({ date: noon UTC on the ET date }) or a plain
  // { year, month (0-based), day }.
  const etDay = day.date
    ? (() => { const p = etDateParts(day.date, tz); return { year: p.y, month: p.m - 1, day: p.d }; })()
    : { year: day.year, month: day.month, day: day.day };
  const busy = await dayBusyEvents(hl, config, etDay);
  const slots = [];
  for (const [hh, mm] of [[8, 0], [8, 30], [9, 0], [9, 30]]) {
    const startMs = zonedTimeToUtc(etDay.year, etDay.month, etDay.day, hh, mm, tz);
    if (startMs <= now.getTime() + 60 * 60 * 1000) continue;
    const iso = new Date(startMs).toISOString();
    if (!inBookingWindow(iso, tz)) continue;
    if (slotOverlapsBusy(startMs, startMs + 30 * 60 * 1000, busy)) continue;
    slots.push(buildSlot(startMs, tz, now));
  }
  return slots;
}

/**
 * First few bookable morning slots of a named month, verified against
 * real events (same far-out lesson as getSyntheticDaySlots). One events
 * fetch for the whole month; days are walked from the 1st until 4 slots
 * are collected. ONLY used when the feed returned empty for the month.
 */
async function getSyntheticMonthSlots(hl, config, namedMonth, now = new Date()) {
  if (!config.calendarId || !namedMonth) return [];
  const tz = config.timezone;
  const mStart = zonedTimeToUtc(namedMonth.year, namedMonth.month, 1, 0, 0, tz);
  const mEnd = zonedTimeToUtc(namedMonth.year, namedMonth.month + 1, 1, 0, 0, tz);
  const events = await hl.getCalendarEvents(config.calendarId, mStart, mEnd);
  const daysInMonth = new Date(Date.UTC(namedMonth.year, namedMonth.month + 1, 0)).getUTCDate();
  const slots = [];
  let daysWithSlots = 0;
  for (let d = 1; d <= daysInMonth && daysWithSlots < 4; d++) {
    const etDay = { year: namedMonth.year, month: namedMonth.month, day: d };
    const busy = (events || []).filter((e) => {
      const p = etDateParts(new Date(e.startTime), tz);
      return p.y === etDay.year && p.m === etDay.month + 1 && p.d === etDay.day;
    });
    let perDay = 0;
    for (const [hh, mm] of [[8, 0], [8, 30], [9, 0], [9, 30]]) {
      if (perDay >= 2) break;
      const startMs = zonedTimeToUtc(etDay.year, etDay.month, etDay.day, hh, mm, tz);
      if (startMs <= now.getTime() + 60 * 60 * 1000) continue;
      const iso = new Date(startMs).toISOString();
      if (!inBookingWindow(iso, tz)) continue;
      if (slotOverlapsBusy(startMs, startMs + 30 * 60 * 1000, busy)) continue;
      slots.push(buildSlot(startMs, tz, now));
      perDay++;
    }
    if (perDay > 0) daysWithSlots++;
  }
  return slots;
}

/**
 * Verify one explicit date pick ("December 15 at 9 am") against real
 * events: the exact requested time, not just the morning set. Returns
 * the synthetic slot or null (taken, out of window, or unparseable).
 * ONLY used when the feed returned empty for that date.
 */
async function verifySyntheticDatePick(hl, config, datePick, now = new Date()) {
  if (!config.calendarId || !datePick || !datePick.times || datePick.times.length !== 1) return null;
  const m = String(datePick.times[0]).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3].toUpperCase() === 'PM' && hh !== 12) hh += 12;
  if (m[3].toUpperCase() === 'AM' && hh === 12) hh = 0;
  const tz = config.timezone;
  const etDay = { year: datePick.year, month: datePick.month, day: datePick.day };
  const startMs = zonedTimeToUtc(etDay.year, etDay.month, etDay.day, hh, mm, tz);
  if (startMs <= now.getTime() + 60 * 60 * 1000) return null;
  const iso = new Date(startMs).toISOString();
  if (!inBookingWindow(iso, tz)) return null;
  const busy = await dayBusyEvents(hl, config, etDay);
  if (slotOverlapsBusy(startMs, startMs + 30 * 60 * 1000, busy)) return null;
  return buildSlot(startMs, tz, now);
}

// ── Availability windows (Nov 9, 2026, Charday Cooke lesson) ──
// A seller stating WHEN they are free ("available after 5p only") must see
// times INSIDE that window. The old path showed the generic daytime list
// (inBookingWindow clips to 8 AM–5 PM) and the model deferred with "I'll
// let my partner know" instead of offering evening times. The offer itself
// is unchanged — same Ashley format, same short-times cap; only the slots
// feeding it change. Hours are minutes-since-midnight in the seller's
// local timezone; the 8 AM–9 PM hours gate always clamps the window.

function resolveAvailabilityWindow(text) {
  const raw = String(text || '').toLowerCase();
  const found = [];
  const add = (kind, label, startMin, endMin, weekendsOnly = false) =>
    found.push({ kind, label, startMin, endMin, weekendsOnly });

  // "after 5p", "after 6pm", "after 5:30 pm", "from 6pm" — explicit hour.
  // The "m" is optional: sellers write "5p" as often as "5pm".
  for (const m of raw.matchAll(/\b(?:after|from)\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?\b/g)) {
    const h = parseInt(m[1], 10);
    if (h < 1 || h > 12) continue;
    const hour24 = m[3] === 'p' ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    if (hour24 < 8 || hour24 >= 21) continue;
    add('evening', `after ${h} ${m[3].toUpperCase()}M`, hour24 * 60 + (m[2] ? parseInt(m[2], 10) : 0), 21 * 60);
  }
  // Bare hour: "call me after 5", "after 5:30" — 1–7 means PM; 8–11 needs
  // an evening word, else it is genuinely ambiguous. Never a duration:
  // "after 5 months" is a date, not a window.
  for (const m of raw.matchAll(/\b(?:after|from)\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:months?|weeks?|days?|years?)\b)/g)) {
    // A marker right after the hour belongs to the loop above; skip those.
    const after = raw.slice(m.index + m[0].length);
    if (/^\s*[ap]\.?m?\.?\b/.test(after)) continue;
    const h = parseInt(m[1], 10);
    if (h < 1 || h > 12) continue;
    let hour24;
    if (h <= 7) hour24 = h + 12;
    else if (/(evening|night)/.test(raw)) hour24 = h + 12;
    else continue;
    if (hour24 >= 21) continue;
    add('evening', `after ${h} PM`, hour24 * 60 + (m[2] ? parseInt(m[2], 10) : 0), 21 * 60);
  }
  // "before noon" / "before 12" → morning. "before 5pm" → 8 AM until then.
  if (/\bbefore\s+(noon|12)\b/.test(raw)) {
    add('morning', 'before noon', 8 * 60, 12 * 60);
  }
  for (const m of raw.matchAll(/\bbefore\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?\b/g)) {
    const h = parseInt(m[1], 10);
    if (h < 1 || h > 12) continue;
    const hour24 = m[3] === 'p' ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    const endMin = hour24 * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    if (endMin <= 8 * 60 || endMin > 21 * 60) continue;
    add(endMin <= 12 * 60 ? 'morning' : 'daytime', `before ${h} ${m[3].toUpperCase()}M`, 8 * 60, endMin);
  }
  // "after work" is an evening window, full stop.
  if (/\bafter\s+work\b/.test(raw)) {
    add('evening', 'after work', 17 * 60, 21 * 60);
  }
  // Word windows need availability context — "Good evening, thanks" is a
  // greeting, not a window. "mornings or evenings work" is two windows:
  // ambiguous, so it resolves to nothing (the model handles it).
  const availCtx = /(available|only|works?|free|prefer|usually|generally|best|call me|reach me)/.test(raw);
  if (availCtx) {
    if (/\bevenings?\b/.test(raw)) add('evening', 'evenings', 17 * 60, 21 * 60);
    if (/\bnights?\b/.test(raw)) add('evening', 'evenings', 17 * 60, 21 * 60);
    if (/\bmornings?\b/.test(raw)) add('morning', 'mornings', 8 * 60, 12 * 60);
    if (/\bafternoons?\b/.test(raw)) add('afternoon', 'afternoons', 12 * 60, 17 * 60);
  }
  if (/\bweekends?\b/.test(raw) && /(only|weekends?\s+works?|free|available|prefer)/.test(raw)) {
    add('weekend', 'the weekend', 8 * 60, 21 * 60, true);
  }

  // One window, however it was phrased, wins. Two different windows (or
  // two different "after" hours) is ambiguous — return nothing and let the
  // model ask.
  const unique = [...new Map(found.map((w) => [`${w.startMin}-${w.endMin}-${w.weekendsOnly}`, w])).values()];
  if (unique.length !== 1) return null;
  return unique[0];
}

function minutesInZone(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(iso));
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  return h * 60 + m;
}

/**
 * The seller's stated availability window, recovered from the THREAD —
 * not just the current message (Nov 9, 2026, Charday Cooke round 2).
 * The window lives in the message that stated it; a later pick
 * ("5:30 is perfect") or fallback offer must still use it. Scans the
 * seller's inbound messages oldest → newest; the LAST window stated
 * wins (a seller can change their window). Outbound messages never
 * state the seller's window.
 */
function resolveWindowFromHistory(messages) {
  let found = null;
  for (const m of (messages || [])) {
    if (!m || m.direction !== 'inbound' || !m.body) continue;
    const w = resolveAvailabilityWindow(m.body);
    if (w) found = w;
  }
  return found;
}

function weekdayShortInZone(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(iso));
}

// Same 5-day horizon, >now+1h, and Mon–Sat rule as getOfferSlots — but the
// hour filter is the seller's window clamped to the 8 AM–9 PM hours gate,
// NOT inBookingWindow's 8 AM–5 PM clip. Same slot shape, same cap.
// The window hours are the SELLER's local hours: opts.timeZone (the
// market timezone) when given, else the bot timezone. A KC seller's
// "after 5p" is 5 PM Central — evaluating it in Eastern would offer
// 4:30 PM Central, half an hour before they are free.
async function getWindowSlots(hl, config, window, now = new Date(), opts = {}) {
  if (!config.calendarId || !window) return [];
  const tz = opts.timeZone || config.timezone;
  const start = now.getTime();
  const end = start + (config.slotDaysAhead || 5) * 24 * 60 * 60 * 1000;
  const raw = await hl.getFreeSlots(config.calendarId, start, end);
  const startMin = Math.max(window.startMin, (config.hoursStart ?? 8) * 60);
  const endMin = Math.min(window.endMin, (config.hoursEnd ?? 21) * 60);
  const excluded = new Set((opts.excludeDays || []).map((d) => String(d).toLowerCase()));
  const kept = (raw || []).filter((iso) => {
    const t = new Date(iso).getTime();
    if (t <= start + 60 * 60 * 1000) return false;
    const wd = weekdayShortInZone(iso, tz);
    if (wd === 'Sun') return false;
    if (window.weekendsOnly && wd !== 'Sat') return false;
    const mins = minutesInZone(iso, tz);
    if (mins < startMin || mins >= endMin) return false;
    if (excluded.size) {
      const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(iso)).toLowerCase();
      if (excluded.has(day)) return false;
    }
    return true;
  });
  return kept.slice(0, config.slotOfferCount || 4).map((iso) => ({
    startISO: iso,
    endISO: new Date(new Date(iso).getTime() + 30 * 60 * 1000).toISOString(),
    label: formatSlot(iso, tz, now),
  }));
}

// Ashley's offer, composed from real slots (never invented): same day →
// "Would {day} at {t1}, {t2}, or {t3} work for a quick chat?"; mixed days →
// "I have {short labels} — which works for you?" (the month offer's shape).
// At most 3 times — Troy's short-times cap. The meridiem is stated once
// when all times share it, exactly like Ashley's own offers.
function formatOfferQuestion(slots) {
  const shown = (slots || []).slice(0, 3);
  if (!shown.length) return null;
  const parts = shown.map((s) => {
    const m = String(s.label || '').match(/^(.+?) at (.+)$/);
    return m ? { day: m[1], time: m[2] } : null;
  });
  if (parts.every(Boolean) && new Set(parts.map((p) => p.day)).size === 1) {
    const day = parts[0].day === 'Today' ? 'today' : parts[0].day;
    const suffixes = parts.map((p) => {
      const s = p.time.match(/( AM| PM)( Central)?$/);
      return s ? s[0] : '';
    });
    const sameSuffix = suffixes.every((s) => s === suffixes[0]);
    const times = parts.map((p) => (sameSuffix ? p.time.replace(/( AM| PM)( Central)?$/, '') : p.time));
    const listed = times.length > 1 ? `${times.slice(0, -1).join(', ')}, or ${times[times.length - 1]}` : times[0];
    return `Would ${day} at ${listed}${sameSuffix ? suffixes[0] : ''} work for a quick chat?`;
  }
  const labels = shown.map((s) => String(s.label || '').replace(/, [A-Z][a-z]+ \d+/, ''));
  const listed = labels.length > 1 ? `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}` : labels[0];
  return `I have ${listed} — which works for you?`;
}

module.exports = { getOfferSlots, getBookableSlots, getDaySlots, getMonthSlots, getSyntheticDaySlots, getSyntheticMonthSlots, verifySyntheticDatePick, zonedTimeToUtc, resolveNamedDay, resolveNamedMonth, resolveSchedulingMonth, isMoveMonthMention, hasSchedulingMonthIntent, findDatePick, findInboundPickSlot, formatSlot, inBookingWindow, displayTimeZoneFor, tzShortName, relabelSlots, resolveAvailabilityWindow, resolveWindowFromHistory, getWindowSlots, formatOfferQuestion };

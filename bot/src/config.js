/**
 * config.js — all configuration comes from environment variables.
 * NEVER hardcode secrets here. See .env.example and WIRING.md.
 */
'use strict';

function loadConfig(env = process.env) {
  const config = {
    // HighLevel API (base per spec: https://services.leadconnectorhq.com)
    hlBaseUrl: env.HL_API_BASE_URL || 'https://services.leadconnectorhq.com',
    hlToken: env.HL_API_TOKEN || '', // private-integration (PIT) token — SECRET
    hlLocationId: env.HL_LOCATION_ID || '',
    // API version headers (HighLevel v2 requires a Version header per resource)
    hlVersionContacts: env.HL_VERSION_CONTACTS || '2021-07-28',
    hlVersionConversations: env.HL_VERSION_CONVERSATIONS || '2021-04-15',
    hlVersionCalendars: env.HL_VERSION_CALENDARS || '2021-04-15',
    // Opportunities (pipelines, search, create, update) — the pipeline
    // auto-move layer (Oct 30, 2026).
    hlVersionOpportunities: env.HL_VERSION_OPPORTUNITIES || '2021-07-28',

    // Webhook shared secret: the HL workflow Webhook action must send this in
    // the `x-bot-secret` header (or `?secret=` query param as a fallback).
    webhookSecret: env.WEBHOOK_SHARED_SECRET || '',

    // Calendar: "Paula Thomas" calendar in the new CRM (ID set at wiring time)
    calendarId: env.HL_CALENDAR_ID || '',

    // Legacy calendar: the old "Paula Thomas" Event calendar. Bot bookings
    // go to calendarId, but the existing-booking check must ALSO see this
    // calendar — Oct 28 lesson: after the Oct 27 repoint to the new
    // Personal calendar, old-calendar bookings (dummy, Guillermo, Sam's)
    // became invisible to the bot, so a booked seller drew the deferral
    // line instead of the no-reschedule ack. Optional: when unset, only
    // calendarId is checked.
    legacyCalendarId: env.HL_LEGACY_CALENDAR_ID || '',

    // Assignee for bot bookings: Paula Thomas's user ID. HL appointments
    // created without assignedUserId are invisible in user-filtered calendar
    // views (web list shows them, the phone app filtered by user does not).
    // Oct 24 lesson: always set this so bookings show on web AND in the app.
    userId: env.HL_USER_ID || '',

    // Custom-field IDs on the contact that hold MAO / LAO / phone type.
    // Nov 13, 2026: MAO/LAO/ARV default to the verified field IDs of the
    // new CRM location (krKoHLudPnn7nT0DPtwa). They MUST default: the HL
    // API returns contact customFields as {id, value} ONLY — no key/name —
    // so the key/name fallback in hl.js customFieldValue can never match
    // in production, and with empty IDs getBallpark/getVerifiedPrice
    // silently returned null (Troy's live "Make me an offer" test fell
    // through to the model path). These IDs are location constants, not
    // secrets. Env vars still win when set.
    maoFieldId: env.MAO_FIELD_ID || 'B8Mfg1TQfjjo4Dl214A2',
    laoFieldId: env.LAO_FIELD_ID || 'JUPzLFhe7VG0PCJqL0n8',
    phoneTypeFieldId: env.PHONE_TYPE_FIELD_ID || '',
    // Auto-pricing (Nov 13, 2026): the ARV field, and the listing-verified
    // marker field. The priced-offer path (handler 8.65) only states a
    // number when the price is verified — MAO/LAO on file AND the marker
    // set. If unset, fields/tags are matched by key/name (see hl.js
    // getVerifiedPrice for the marker contract).
    arvFieldId: env.ARV_FIELD_ID || 'cOE6XmJNOdVKsDNpiGqR',
    pricedVerifiedFieldId: env.PRICED_VERIFIED_FIELD_ID || '',

    // Pipeline auto-move (Oct 30, 2026): the "Lead" pipeline and its
    // "Appointment Set" stage. When both are set, the bot skips the live
    // pipeline lookup and uses these IDs directly; when unset, it
    // resolves them from the location's pipelines on first booking and
    // caches them in-memory.
    leadPipelineId: env.HL_LEAD_PIPELINE_ID || '',
    leadAppointmentStageId: env.HL_LEAD_APPOINTMENT_STAGE_ID || '',

    // NOTE: there is intentionally NO fromNumber here. A FROM_NUMBER env
    // var used to pin every bot reply to one fixed number (Oct 27, 2026:
    // Cleveland test replies went out from the Indianapolis number).
    // HighLevel routes on the thread's own number when fromNumber is
    // absent, so the variable is ignored even if still set in Netlify.
    // Never reintroduce a fixed sender number or per-market mapping.

    // LLM adapter (OpenAI-compatible). Default model: GPT-4.1-class, matching
    // Ashley's current model family.
    llmBaseUrl: env.LLM_BASE_URL || 'https://api.openai.com/v1',
    llmApiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || '',
    llmModel: env.LLM_MODEL || 'gpt-4.1',
    llmTimeoutMs: parseInt(env.LLM_TIMEOUT_MS || '15000', 10), // Nov 27, 2026: 22s bot-hook budget — cold build ~3–5s + LLM <=15s + ~1s send; the old 25000 default meant slow replies were abandoned at 22s with no reply and no botLog entry.

    // Persona: 'ashley' (default) or 'amber'. The bot introduces itself by
    // this name; the knowledge base swaps the name in self-introductions
    // at load time. Anything else falls back to 'ashley'.
    // Nov 5, 2026 (Troy): the live twin is Amber — never Troy's own name.
    botPersona: (() => {
      const p = String(env.BOT_PERSONA || 'ashley').toLowerCase();
      return p === 'amber' ? 'amber' : 'ashley';
    })(),

    // Hours gate — America/New_York, 8 AM–9 PM (reuse of the Ashley Hours Gate)
    timezone: env.BOT_TIMEZONE || 'America/New_York',
    hoursStart: parseInt(env.HOURS_START || '8', 10), // inclusive
    hoursEnd: parseInt(env.HOURS_END || '21', 10), // exclusive (9 PM)

    // Market timezone (Oct 29, 2026, Troy): ONLY the Kansas City market is
    // on Central Time — its 5 seller numbers are listed here (10 digits,
    // matching normalizePhoneDigits output). Indianapolis, Cleveland,
    // Carolina, and Florida are all Eastern. The bot offers and confirms
    // times in the seller's local timezone; the calendar booking itself
    // always uses the absolute slot ISO, so it lands correctly on its own.
    centralMarketNumbers: new Set([
      '8167205099', // Kansas City SMS 1 (workflow From)
      '8165401579', // Kansas City SMS 2
      '8163398449', // Kansas City SMS 3
      '8167746634', // Kansas City SMS 4
      '8164390379', // Kansas City SMS 5
    ]),
    centralTimezone: 'America/Chicago',

    // Kill switch: set BOT_ENABLED=false to make the webhook a no-op.
    botEnabled: (env.BOT_ENABLED || 'true').toLowerCase() !== 'false',

    // How many days ahead to pull calendar slots, and how many to offer.
    slotDaysAhead: parseInt(env.SLOT_DAYS_AHEAD || '5', 10),
    slotOfferCount: parseInt(env.SLOT_OFFER_COUNT || '4', 10),
  };

  config.missingRequired = [];
  if (!config.hlToken) config.missingRequired.push('HL_API_TOKEN');
  if (!config.hlLocationId) config.missingRequired.push('HL_LOCATION_ID');
  if (!config.webhookSecret) config.missingRequired.push('WEBHOOK_SHARED_SECRET');
  if (!config.llmApiKey) config.missingRequired.push('LLM_API_KEY (or OPENAI_API_KEY)');
  if (!config.calendarId) config.missingRequired.push('HL_CALENDAR_ID');

  return config;
}

module.exports = { loadConfig };

/**
 * handler.js — the webhook pipeline. All hard rules live here, in code.
 *
 * Order of operations (deliberate, do not reorder casually):
 *   0. Kill switch + shared-secret verification (fail closed).
 *   1. Parse the Customer Replied event; ignore non-inbound / non-SMS.
 *   2. Dedupe (HL can fire a webhook more than once).
 *   3. Load the contact.           → can't load = send nothing.
 *   4. DND check.                  → DND = total silence, no generation.
 *   5. Landline flag check.        → flagged landline = silence.
 *   5.5 Appointment-reply check (Nov 7, Troy): a seller with a PAST
 *       appointment on the calendar gets total silence + the
 *       `appointment-reply` tag (Troy is notified separately) — NO reply,
 *       NO DND, NO dnc tag. Runs before every guard seal, so a bare "No"
 *       answering the bot's own yes/no question can never seal them.
 *       Genuine opt-outs are carved out: they still take the guard path
 *       and are DND'd immediately.
 *   6. Guard classification of the inbound text (opt-out / hostile / spam /
 *      wrong-number / not-an-owner) → silence + set DND + add `dnc` tag.
 *      This runs 24/7, BEFORE the hours gate: an opt-out at 2 AM is still
 *      DND'd immediately; we just never SEND anything.
 *      Nov 9, Charday Cooke round 2: a BARE "wrong number" in a LIVE
 *      negotiation (window stated, price discussed, or time picked) is
 *      frustration at the bot's own bad offers — it flags Troy and stays
 *      silent, it never seals. Clear wrong-person declarations and
 *      first-reply "wrong number" still seal here.
 *      Step 6.2 (Nov 11 late): an ESTABLISHED firm/absurd position —
 *      the tag on the contact, or the evidence in earlier turns (the
 *      Jada Aderiye cross-burst shape) — seals any further message the
 *      same way: no reply, DND + dnc. First detection stays with the
 *      burst guards (6.5 absurd silence, 6.6 one firm walkaway).
 *      Step 6.15 (Nov 20, 30007 fix): BUYER SILENCE — a contact carrying
 *      buyer tags (`cash buyer` / any `buyer…` tag) gets NO reply at
 *      all. Runs after the guard seals, so a buyer's own opt-out still
 *      DNDs first (compliance beats lane discipline).
 *   7. Hours gate (8 AM–9 PM ET).  → outside = no generation, no send.
 *   7.7 NO-PROPERTY GATE (Nov 20, 30007 fix): no property address on
 *       file (address1 empty, or a PO Box — a mailing address is not a
 *       property) → silence + flag for Troy. The bot sells ONE place;
 *       with none on file it must never improvise a generic pitch.
 *   7.5 Existing bookings (Paula Thomas calendar). → feeds the silence rule.
 *       A failed fetch = "no known booking": never a reason to silence
 *       or mis-book.
 *   7.6 TOTAL SILENCE AFTER BOOKING (Nov 3, 2026, Troy): a seller with an
 *       appointment on the calendar gets NO reply to anything — Troy
 *       handles all communication after the booking. The confirmation
 *       itself ("You're all set for...") is the last word the bot speaks.
 *   8. Build context (history, ballpark from MAO/LAO, live calendar slots).
 *      A decline of the offered day(s) from an UNBOOKED seller re-fetches
 *      slots EXCLUDING those days, so the next offer is genuinely new
 *      days — never the "I'll check back" brush-off that lost the Oct 24
 *      2:44 PM reschedule. A decline from a BOOKED seller is NOT a
 *      reschedule anymore (Oct 24, 6:12 PM, Troy: the bot ONLY books) —
 *      it is acknowledged and the booking is left exactly as it is.
 *      Nov 9, Charday Cooke round 2: the seller's availability window is
 *      recovered from the thread (not just the current message) — pick
 *      verification and EVERY fallback offer use the window pool. When the
 *      window has ZERO bookable slots, the bot hands the lead to Troy
 *      (flagForTroy) and stays silent: it never offers other times and
 *      never says "that time isn't open" and walks away.
 *   9. Generate. ANY failure → SILENCE (never a fallback message — that is
 *      the entire reason this bot exists).
 *  10. Post-process: one question max; spam-safe word filter (regenerate
 *      once, then soften by substitution, then strip); number guard
 *      (figures only from the MAO/LAO range); vague-pitch screen (Nov 20,
 *      30007 fix: a generic "any house or land you own" pitch that does
 *      not name the property on file is regenerated once, then stripped;
 *      still vague = silence + flag for Troy, never sent); future-outreach
 *      promises stripped on EVERY text (the bot cannot follow up, so it
 *      must never promise to); claim–reality guard (prose cancellation/booking
 *      claims are reconciled with real actions — a claim never goes out unmatched).
 *  11. Book via Calendar API when the model returns a book action with a
 *      real offered slot — but NEVER for a seller who already has a
 *      booking (Oct 24, 6:12 PM no-reschedule rule: a book action there
 *      is a move request and is ignored). A cancel action is NEVER
 *      executed (Oct 24, 7:44 PM no-cancel rule: Troy cancels bookings
 *      himself) — it is acknowledged for Troy to handle.
 *      A book naming an unoffered time sends the honest team-confirm line
 *      instead of a false confirmation.
 *  12. Send via Conversations API.
 */
'use strict';

const { classifyInbound, isOptOut, contactIsDnd, contactIsLandline, contactIsBuyer, contactPropertyAddress, withinHours, detectDecline, isAcknowledgment, lastOutboundWasBookingConfirmation, lastOutboundInfo, historyTailDebug, weekdayOf, isAbsurdPrice, ABSURD_PRICE_MULTIPLE, isFirmPrice, isFirmPriceBurst, establishedPriceSeal, isVisitInvitation, hasExplicitTimeMention, lastOutboundAskedForPhotos, isPhotoSendReply, countPriceAsks, isPriceAsk, inboundBurst, normalize, isClearWrongPerson, isBareWrongNumber, threadShowsNegotiation, detectOwnerReferral, stripForeignMonth } = require('./guards');
const { getBallpark, getVerifiedPrice, normalizePhoneDigits } = require('./hl');
const { buildSystemPrompt, parseModelOutput, loadKnowledge } = require('./prompt');
const { matchObjection } = require('./objections');
const { getOfferSlots, getBookableSlots, getDaySlots, getMonthSlots, getSyntheticDaySlots, getSyntheticMonthSlots, verifySyntheticDatePick, resolveNamedDay, resolveNamedMonth, resolveSchedulingMonth, findDatePick, findInboundPickSlot, displayTimeZoneFor, tzShortName, relabelSlots, resolveAvailabilityWindow, resolveWindowFromHistory, getWindowSlots, formatOfferQuestion } = require('./booking');
const { ensureLeadOpportunity } = require('./pipeline');
const wf = require('./wordfilter');

// NO-RESCHEDULE acknowledgment (Oct 24, 6:12 PM, Troy): the bot ONLY
// books. A booked seller's change request is acknowledged and the booking
// is left exactly as it is — never moved, cancelled, or re-offered.
// Names the booking's own day (not the declined day: a day-less "I cant
// make it" falls back to the offered days, which are not the booking).
function noRescheduleAck(existing) {
  const first = existing && existing[0];
  const day = first && first.startTime ? weekdayOf(first.startTime) : '';
  return day
    ? `No problem — your ${day} appointment is still on the calendar. Just let us know if anything changes.`
    : 'No problem — thanks for letting us know.';
}

// Offer fallback (Nov 9, 2026, Troy): a booking conversation NEVER ends in
// "the team will confirm that time" — it ends in concrete times in Ashley's
// format, or, when no real slot exists to offer, the handoff question
// (which asks permission — it does not promise a callback).
function offerOrHandoff(slots, prefix) {
  const q = formatOfferQuestion(slots);
  if (q) return prefix ? `${prefix} ${q}` : q;
  return "I'm not sure on the exact times right now — want me to have my partner call you?";
}

/** Simple in-memory idempotency store (best-effort; functions are stateless). */
function createDedupe(ttlMs = 10 * 60 * 1000, max = 500) {
  const seen = new Map();
  return {
    checkAndMark(id, ttlOverrideMs) {
      if (!id) return false; // no id → cannot dedupe → process
      const effectiveTtl = ttlOverrideMs || ttlMs;
      const now = Date.now();
      for (const [k, t] of seen) {
        if (now - t > ttlMs || seen.size > max) seen.delete(k);
      }
      if (seen.has(id)) {
        // A key past its EFFECTIVE ttl counts as new, even if the global
        // eviction sweep has not removed it yet.
        if (now - seen.get(id) <= effectiveTtl) return true;
      }
      seen.set(id, now);
      return false;
    },
  };
}

/**
 * Normalize the many shapes a HighLevel "Customer Replied" webhook can take.
 * The CANONICAL shape is the custom payload defined in WIRING.md:
 *   { contactId, conversationId, messageId, body, type: "SMS" }
 * The fallbacks below accept the common nested variants. If a future HL
 * payload stops matching, this is the one function to adjust (see WIRING.md).
 */
function parseEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const msg = payload.message && typeof payload.message === 'object' ? payload.message : {};
  const contactId =
    payload.contactId || payload.contact_id || (payload.contact && payload.contact.id) || msg.contactId || null;
  if (!contactId) return null;

  const direction = String(payload.direction || msg.direction || 'inbound').toLowerCase();
  const rawType = String(payload.messageType || payload.type || msg.type || msg.messageType || 'SMS');
  const isSms = /sms|text|inboundmessage/i.test(rawType) || rawType === '2';

  let body = payload.body || payload.messageBody || payload.text || msg.body || msg.message || '';
  if (body && typeof body === 'object') body = body.body || body.text || '';

  // HighLevel's custom payload renders a missing conversation.id as the
  // literal string "null" (proven Oct 24: history fetch went to
  // /conversations/null and 400'd on every call). Normalize that to real
  // null so the findConversationId fallback below runs.
  // NOTE: messageId is deliberately NOT normalized the same way — the
  // dedupe key needs a stable value, and the body in the key is what
  // separates distinct messages sharing one id.
  const rawConversationId = payload.conversationId || payload.conversation_id || msg.conversationId || null;
  const conversationId =
    rawConversationId && !['null', 'undefined'].includes(String(rawConversationId).trim().toLowerCase())
      ? String(rawConversationId)
      : null;

  return {
    contactId: String(contactId),
    conversationId,
    messageId: payload.messageId || payload.message_id || msg.id || payload.id || null,
    // Passthrough for a future trigger-picker route: if the workflow ever
    // carries the inbound's destination number, it flows straight into
    // reply-number derivation with no further handler change. No trigger
    // token name is guessed here — only the plain toNumber field is read.
    toNumber: payload.toNumber || msg.toNumber || null,
    body: String(body || ''),
    isInbound: direction !== 'outbound',
    isSms,
  };
}

/**
 * Destination (business) number of a history message, read defensively.
 * The API's exact From/To field names are NOT confirmed from public
 * docs, so To-side candidates are tried in order and normalized to
 * digits. From-side fields are NEVER read here: for an inbound message
 * the From side is the seller, and sending from the seller's number
 * would be the wrong side of the message entirely.
 */
function messageDestination(m) {
  if (!m || typeof m !== 'object') return null;
  const candidates = [m.toNumber, m.to_number, m.to, m.destination, m.recipient, m.toPhone, m.phoneTo];
  for (const c of candidates) {
    const n = normalizePhoneDigits(c);
    if (n) return n;
  }
  return null;
}

/**
 * Resolve the reply's From number ONCE per webhook, or null when it
 * cannot be learned (caller then omits fromNumber → thread routing).
 * Order (Oct 27, 2026 dynamic-reply-number rule):
 *   (1) webhook toNumber, when parseEvent carries one;
 *   (2) the triggering inbound's destination — the history message
 *       matching evt.messageId when that id is real and found (body
 *       used to disambiguate non-unique ids), else the LATEST inbound
 *       (mandatory fallback: messageId is proven sometimes the literal
 *       string "null" or non-unique);
 *   (3) null.
 * A candidate equal to the seller's/contact phone number is REJECTED
 * (wrong side of the message) and derivation falls through to the next
 * source. Never defaults to any market number, never silences over an
 * unlearned number — the reply still goes out on the thread's number.
 */
function resolveReplyFromNumber(evt, history, contact) {
  const seller = normalizePhoneDigits(
    contact && (contact.phone || contact.phoneNumber || contact.mobile || contact.phone_number)
  );
  const usable = (n) => n && n !== seller;

  const hook = normalizePhoneDigits(evt.toNumber);
  if (usable(hook)) return hook;

  const inbounds = (history || []).filter((m) => m.direction === 'inbound');
  const hasRealId =
    evt.messageId && !['null', 'undefined'].includes(String(evt.messageId).trim().toLowerCase());
  let target = null;
  if (hasRealId) {
    const matches = inbounds.filter((m) => String(m.id) === String(evt.messageId));
    if (matches.length) {
      const body = (evt.body || '').trim();
      const bodyMatches = body ? matches.filter((m) => String(m.body || '').trim() === body) : [];
      const pool = bodyMatches.length ? bodyMatches : matches;
      target = pool[pool.length - 1];
    }
  }
  if (!target && inbounds.length) target = inbounds[inbounds.length - 1];
  if (target) {
    const dest = messageDestination(target);
    if (usable(dest)) return dest;
    // Rejected or unusable target (e.g. mislabeled seller number): try
    // the latest inbound when it is a different message, then give up.
    const latest = inbounds[inbounds.length - 1];
    if (latest && latest !== target) {
      const dest2 = messageDestination(latest);
      if (usable(dest2)) return dest2;
    }
  }
  return null;
}

function createHandler(deps) {
  const { config, hl, llm } = deps;
  const logger = deps.logger || console;
  const now = deps.now || (() => new Date());
  const dedupe = deps.dedupe || createDedupe();
  const log = (...a) => logger.log('[custom-bot]', ...a);

  function respond(statusCode, outcome, extra = {}) {
    return {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome, ...extra }),
    };
  }

  async function applySilenceWithDnd(contactId, category) {
    // Guard actions are best-effort: even if a write fails we NEVER reply.
    try {
      await hl.setDnd(contactId);
    } catch (e) {
      log(`GUARD-ACTION-FAILED setDnd ${contactId}: ${e.message}`);
    }
    try {
      await hl.addTags(contactId, ['dnc']);
    } catch (e) {
      log(`GUARD-ACTION-FAILED addTags ${contactId}: ${e.message}`);
    }
    return respond(200, 'silenced-guard', { category });
  }

  // Nov 9, 2026, Charday Cooke round 2 — hand the lead to Troy and stay
  // silent. The `appointment-reply` tag is the system's existing
  // bot-silence + Troy-owns-the-thread signal: the notifier surfaces new
  // inbound from tagged contacts to Troy in the main chat, and the
  // watchdog skips tagged contacts. No new channel — same tag, widened
  // meaning (see DECISIONS.md). Used when the bot cannot book what the
  // seller asked for (no slots in their window) and when a frustrated
  // "wrong number" must not seal a live negotiation. NO DND, NO dnc.
  async function flagForTroy(contactId, reason, windowLabel) {
    try {
      await hl.addTags(contactId, ['appointment-reply']);
    } catch (e) {
      log(`GUARD-ACTION-FAILED addTags appointment-reply ${contactId}: ${e.message}`);
    }
    log(`handoff-to-troy ${contactId}: ${reason}${windowLabel ? ` window=${windowLabel}` : ''}`);
    return respond(200, 'silence-handoff', { category: reason });
  }

  async function generate(system, messages) {
    const raw = await llm.generate({ system, messages });
    return parseModelOutput(raw);
  }

  // Nov 14, 2026, Douglas Pope: true when a referral inbound in the
  // history was already followed by an outbound — the referral was
  // already answered (rightly or wrongly), so a repeat of it gets
  // silence + the Troy flag, never a second acknowledgment and never
  // a fresh times offer. A referral sitting as the LAST history entry
  // (the live webhook already carrying the current inbound) has no
  // outbound after it and does not count as answered.
  function referralAlreadyAnswered(history) {
    const msgs = Array.isArray(history) ? history : [];
    for (let i = 0; i < msgs.length - 1; i++) {
      const m = msgs[i];
      if (!m || m.direction !== 'inbound' || !m.body) continue;
      if (!detectOwnerReferral(m.body)) continue;
      for (let j = i + 1; j < msgs.length; j++) {
        if (msgs[j] && msgs[j].direction === 'outbound') return true;
      }
    }
    return false;
  }

  async function handle(event) {
    if (!config.botEnabled) return respond(200, 'disabled');

    // 0 — shared-secret verification (header preferred, query fallback)
    const headers = event.headers || {};
    const provided =
      headers['x-bot-secret'] || headers['X-Bot-Secret'] || (event.queryStringParameters || {}).secret || '';
    if (!config.webhookSecret || provided !== config.webhookSecret) {
      return respond(401, 'unauthorized');
    }

    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, 'bad-json');
    }

    // 1 — parse + basic shape gates
    const evt = parseEvent(payload);
    if (!evt) return respond(400, 'unrecognized-payload');
    if (!evt.isInbound || !evt.isSms) return respond(200, 'ignored-not-inbound-sms');
    // Dedupe key includes the body: HighLevel's {{message.id}} is NOT unique
    // per message in this trigger (proven Oct 24: two distinct seller texts
    // arrived with the same messageId, and the second was swallowed as a
    // "duplicate"). A genuine double-fire carries the identical body, so it
    // is still deduped; a distinct follow-up is not.
    // Degraded id (HL's literal "null"/"undefined" string, proven Oct 24
    // 4:21 PM: the "8" double-fire carried messageId "null"): the key
    // degrades to contact+body, so a genuine re-send of the same words
    // would be swallowed for the full 10 minutes. Short TTL (60s) for
    // degraded keys: HL double-fires land seconds apart (proven 19s),
    // genuine re-sends do not.
    const hasRealId = evt.messageId && evt.messageId !== 'null' && evt.messageId !== 'undefined';
    const dedupeKey = evt.messageId ? `${evt.contactId}|${evt.messageId}|${evt.body.trim()}` : null;
    if (dedupe.checkAndMark(dedupeKey, hasRealId ? undefined : 60 * 1000)) {
      log(`duplicate webhook ignored: messageId=${evt.messageId} body=${JSON.stringify(evt.body.trim().slice(0, 80))}`);
      return respond(200, 'duplicate');
    }

    // 3 — load contact (fail closed)
    let contact;
    try {
      contact = await hl.getContact(evt.contactId);
    } catch (e) {
      log(`contact load failed ${evt.contactId}: ${e.message}`);
      return respond(200, 'error-contact-load');
    }
    if (!contact) return respond(200, 'error-contact-load');

    // 4 — DND: never send, never generate
    if (contactIsDnd(contact)) return respond(200, 'dnd');

    // 5 — landline flag: never text a flagged landline
    if (contactIsLandline(contact, config.phoneTypeFieldId)) {
      return respond(200, 'landline');
    }

    // Resolve conversation + inbound text (fetch from API if the webhook
    // didn't carry the body, e.g. a minimal custom payload).
    let conversationId = evt.conversationId;
    let history = [];
    try {
      if (!conversationId) conversationId = await hl.findConversationId(evt.contactId);
      if (conversationId) history = await hl.getMessages(conversationId, 100);
    } catch (e) {
      log(`history load failed: ${e.message}`);
    }
    let inboundText = evt.body.trim();
    if (!inboundText) {
      const lastInbound = [...history].reverse().find((m) => m.direction === 'inbound');
      inboundText = lastInbound ? String(lastInbound.body || '').trim() : '';
    }
    if (!inboundText) {
      // Image-only / empty inbound: zero output (KB junk rule), no DND.
      return respond(200, 'ignored-no-body');
    }

    // Reply From number (Oct 27, 2026 dynamic rule): resolved once from
    // the triggering inbound's destination; null → thread routing (the
    // reply still goes out, on the thread's number). Logged as
    // derived|thread only — never the digits themselves.
    const replyFromNumber = resolveReplyFromNumber(evt, history, contact);
    log(`reply-from for ${evt.contactId}: ${replyFromNumber ? 'derived' : 'thread'}`);

    // 6.0 — APPOINTMENT-REPLY (Nov 7, 2026, Troy): a seller Troy already
    // had a previous appointment with gets NO bot reply at all — the bot
    // stays completely silent and Troy gets a notification instead (the
    // notifier reads the `appointment-reply` tag; it is built separately
    // from this deploy). Runs BEFORE every guard seal and before the LLM,
    // 24/7, so a bare "No" answering the bot's own yes/no question
    // (Gatlin, Nov 7: "Do you still owe anything?" → "No" → wrongly
    // sealed as a rejection, DND + dnc) can never seal an appointment
    // contact. NO DND, NO dnc tag — Troy owns the thread.
    // One carve-out: a genuine opt-out ("STOP"/"Out"/"remove me") still
    // takes the normal guard path and is DND'd immediately — an opt-out
    // is a legal compliance signal, not a conversation to own. The
    // appointment verdict itself never DNDs anyone.
    // Fail-open like step 7.5: a calendar outage must not silence every
    // seller — a failed check is logged and treated as "no known past
    // appointment".
    if (!isOptOut(inboundText)) {
      let pastAppt = null;
      const apptCalendars = [config.calendarId, config.legacyCalendarId].filter(Boolean);
      for (const calId of apptCalendars) {
        try {
          const list = await hl.getPastAppointments(calId, contact, now().getTime());
          if (list && list.length) {
            pastAppt = list[0];
            break;
          }
        } catch (e) {
          log(`past appointment check failed (${calId}): ${e.message} — proceeding without it`);
        }
      }
      if (pastAppt) {
        log(`appointment-reply silence for ${evt.contactId}: past appointment ${pastAppt.id} — Troy handles`);
        const alreadyTagged = Array.isArray(contact.tags) && contact.tags.includes('appointment-reply');
        if (!alreadyTagged) {
          try {
            await hl.addTags(evt.contactId, ['appointment-reply']);
          } catch (e) {
            log(`GUARD-ACTION-FAILED addTags appointment-reply ${evt.contactId}: ${e.message}`);
          }
        }
        return respond(200, 'silence-appointment', { category: 'appointment-reply' });
      }
    }

    // 6 — guard classification (24/7, before hours gate). The thread
    // history rides along so the bare-"No" question-context exemption
    // (Nov 11, Gatlin gap) can see the last outbound question.
    const verdict = classifyInbound(inboundText, history);
    if (verdict.verdict === 'silence-dnd') {
      // Nov 9, Charday Cooke round 2: a bare "wrong number" in a LIVE
      // negotiation is frustration at the bot's own bad offers, not a
      // wrong-person declaration — sealing it (DND + dnc) runs the seller
      // off. Flag Troy and stay silent instead. Clear wrong-person
      // declarations and first-reply "wrong number" (no prior
      // engagement) still seal below.
      if (verdict.category === 'wrong-number-or-not-owner'
        && isBareWrongNumber(inboundText)
        && threadShowsNegotiation(history)) {
        log(`guard: bare wrong-number in live negotiation for ${evt.contactId} — flagging Troy, no seal`);
        return flagForTroy(evt.contactId, 'wrong-number-live-negotiation');
      }
      log(`guard: ${verdict.category} from contact ${evt.contactId}`);
      return applySilenceWithDnd(evt.contactId, verdict.category);
    }

    // 6.1 — burst scan (Nov 6, 2026, Jessica Landis): the seller's earlier
    // message in this unanswered burst may carry the seal signal — a
    // Zillow link, a "sold", an opt-out — while the webhook carried only
    // the follow-up ("That good for you?"). Check the whole burst, not
    // just the triggering text. Messages before the last outbound are
    // already handled and never re-trigger (see inboundBurst).
    for (const body of inboundBurst(history)) {
      if (normalize(body) === normalize(inboundText)) continue;
      const burstVerdict = classifyInbound(body, history);
      if (burstVerdict.verdict === 'silence-dnd') {
        // Same narrowing as step 6: a bare "wrong number" inside a live
        // negotiation is frustration, not a wrong-person declaration.
        if (burstVerdict.category === 'wrong-number-or-not-owner'
          && isBareWrongNumber(body)
          && threadShowsNegotiation(history)) {
          log(`guard (burst): bare wrong-number in live negotiation for ${evt.contactId} — flagging Troy, no seal`);
          return flagForTroy(evt.contactId, 'wrong-number-live-negotiation');
        }
        log(`guard (burst): ${burstVerdict.category} from contact ${evt.contactId}`);
        return applySilenceWithDnd(evt.contactId, burstVerdict.category);
      }
    }

    // 6.15 — BUYER SILENCE (Nov 20, 2026, Troy — the 30007 fix):
    // Brightcasa LLC is a BUYER (tags: cash buyer, buyer - nc, 100-200k,
    // flipper, landlord) that was sitting in the Carolina seller flow.
    // The bot chatted with it as if it were a seller, improvised vague
    // pitches, and one reply was carrier-blocked (error 30007). A
    // contact carrying buyer tags is on the other side of the business:
    // the seller bot sends NOTHING — no reply, no pitch, no times.
    // No DND, no dnc: buying-side communication is a different lane and
    // is not this bot's call. Placement is deliberate: AFTER the guard
    // seals (steps 6/6.1), so a buyer texting STOP still gets DND'd
    // immediately — compliance beats lane discipline — and BEFORE every
    // sending path below (6.6 walkaway, 6.7 referral ack, booking,
    // priced offer, model), so no path can leak a seller text to a buyer.
    if (contactIsBuyer(contact)) {
      log(`buyer-silence for ${evt.contactId}: buyer-tagged contact in the seller flow — no reply`);
      return respond(200, 'buyer-silence', { category: 'buyer-contact' });
    }

    // 6.2 — established firm/absurd seal (Nov 11 late, 2026, Troy): once a
    // seller's firm or absurd position is ESTABLISHED — the firm-price or
    // absurd-price tag is on the contact, or the evidence sits in earlier
    // turns of this thread — any further message seals: NO reply, DND +
    // dnc, exactly like a guard seal. Troy: "after like one respond and
    // they still come back with some nonsense… just don't even respond
    // back. You know just DND."
    // Why this exists (Jada Aderiye, Nov 11): the $470,000 ask and the
    // "not a penny less" landed in SEPARATE bursts with bot replies
    // between them, so steps 6.5/6.6 — which only see the current burst —
    // never fired, and after the (fixed) walkaway a follow-up like
    // "hello?" re-entered the normal reply flow because nothing re-checked
    // the tag. This step also makes the walkaway one-and-done: a second
    // firm burst seals here instead of drawing a second walkaway at 6.6.
    // Runs before 6.5/6.6 and before the hours gate, 24/7 like the other
    // seals. First detection is unchanged: 6.5/6.6 below still own the
    // turn where firm/absurd evidence first appears in one burst.
    {
      const contactTags = Array.isArray(contact.tags) ? contact.tags : [];
      let sealCategory = null;
      let sealSource = null;
      if (contactTags.includes('absurd-price')) {
        sealCategory = 'absurd-price';
        sealSource = 'tag';
      } else if (contactTags.includes('firm-price')) {
        sealCategory = 'firm-price';
        sealSource = 'tag';
      } else {
        const bpSeal = getBallpark(contact, config);
        sealCategory = establishedPriceSeal(history, bpSeal ? bpSeal.mao : null);
        if (sealCategory) sealSource = 'history';
      }
      if (sealCategory) {
        log(`established ${sealCategory} seal for ${evt.contactId} (source=${sealSource}) — no reply, DND`);
        if (sealSource === 'history') {
          // Land the tag the burst guards would have written, so the
          // thread carries the same reporting marker (best-effort).
          try {
            await hl.addTags(evt.contactId, [sealCategory]);
          } catch (e) {
            log(`GUARD-ACTION-FAILED addTags ${sealCategory} ${evt.contactId}: ${e.message}`);
          }
        }
        return applySilenceWithDnd(evt.contactId, `${sealCategory}-established`);
      }
    }

    // 6.5 — absurd-price silence (Oct 30, 2026, Troy; absolute gate Nov 3):
    // a seller naming an ask above ABSURD_PRICE_MULTIPLE × the MAO on file
    // gets total silence — no reply, no walkaway message, no nurture. Tagged
    // `absurd-price` for reporting. Nov 3: an ask at/above ABSURD_PRICE_ABSOLUTE
    // ($500K) is absurd on its face — fires even with no MAO on file. Runs
    // 24/7 like the other guards: an absurd ask at 2 AM is still sealed
    // immediately, and the tag lands even outside the send window.
    // Burst (Nov 6, Jessica Landis): the absurd ask may sit in an earlier
    // message of this unanswered burst ("5 million" then "That good for
    // you?") — check the whole burst, not just the triggering text.
    {
      const bp65 = getBallpark(contact, config);
      const mao = bp65 ? bp65.mao : null;
      const burstBodies = [inboundText, ...inboundBurst(history)];
      if (burstBodies.some((t) => isAbsurdPrice(t, mao))) {
        log(`absurd-price silence for ${evt.contactId}: ask absurd (mao=${mao})`);
        try {
          await hl.addTags(evt.contactId, ['absurd-price']);
        } catch (e) {
          log(`GUARD-ACTION-FAILED addTags absurd-price ${evt.contactId}: ${e.message}`);
        }
        return respond(200, 'absurd-price-silent');
      }
    }

    // 6.6 — firm-price walkaway (Nov 3, 2026, Troy): a seller naming a price
    // with firm / non-negotiable language ("nothing less", "firm", "final price")
    // gets ONE graceful exit message, then silence. Not absurd like $1M — the
    // price could be real — but they're not negotiating, so probing wastes time.
    // Message is the prompt's WALKAWAY TRAP line verbatim.
    // Burst (Nov 11, Troy: "$70K, not a penny less" kept getting probed):
    // the price and the firm language may sit in different messages of one
    // unanswered burst — check the whole burst for the combination, like the
    // absurd-price guard above. Runs before the hours gate and every booking
    // path below, so a firm-price seller can never be booked in this turn.
    {
      const burstBodies = [inboundText, ...inboundBurst(history)];
      if (isFirmPriceBurst(burstBodies)) {
        const walkawayMsg = "Totally understand — sounds like we're just too far apart right now. If things change, we're an easy call away.";
        log(`firm-price walkaway for ${evt.contactId}`);
        try {
          await hl.addTags(evt.contactId, ['firm-price']);
        } catch (e) {
          log(`GUARD-ACTION-FAILED addTags firm-price ${evt.contactId}: ${e.message}`);
        }
        // Send the walkaway message via the normal send path
        try {
          await hl.sendSms({ contactId: evt.contactId, conversationId: evt.conversationId, message: walkawayMsg });
          return respond(200, 'firm-price-walkaway');
        } catch (e) {
          log(`GUARD-ACTION-FAILED sendSms firm-price ${evt.contactId}: ${e.message}`);
          return respond(200, 'firm-price-walkaway-failed');
        }
      }
    }

    // 6.7 — owner referral (Nov 14, 2026, Troy — Douglas Pope, KC): the
    // texter handed over the real decision-maker's number ("Call my ex
    // douglas Pope. He loves to wheel and deal and owns all of our
    // properties right now. 816-616-7825") and the bot ignored it and
    // repeated its booking-times offer word for word. That ends here:
    // a referral inbound (a third-party phone number + referral/owner
    // language, number ≠ the texter's own) NEVER gets times, never
    // gets qualified, never gets pitched. The bot acknowledges the
    // number ONCE, tags the thread for Troy (appointment-reply — he
    // owns it from here, and the notifier surfaces it), and stops.
    // No DND, no dnc: the texter may be a co-owner (Douglas's ex-wife
    // is) and did us a favor. A repeat referral after any outbound
    // answer gets silence + the flag, never a second ack. After hours
    // the flag still lands but nothing is sent, like every other path.
    // Burst-aware like 6.1/6.5: the number may sit in an earlier
    // message of this unanswered burst.
    {
      let referral = detectOwnerReferral(inboundText);
      if (!referral) {
        for (const body of inboundBurst(history)) {
          referral = detectOwnerReferral(body);
          if (referral) break;
        }
      }
      if (!referral) {
        // Split across the burst: "talk to my husband" in one text,
        // his number in the next — neither message alone carries both
        // halves, so the burst is also checked as one combined text.
        const combined = [inboundText, ...inboundBurst(history)].join('\n');
        referral = detectOwnerReferral(combined);
      }
      const contactDigits = normalizePhoneDigits(
        contact && (contact.phone || contact.phoneNumber || contact.mobile || contact.phone_number)
      );
      if (referral && referral.phone && referral.phone !== contactDigits) {
        if (referralAlreadyAnswered(history) || !withinHours(now(), config)) {
          log(`owner-referral for ${evt.contactId}: flagging Troy, no send (${referralAlreadyAnswered(history) ? 'already answered' : 'after-hours'})`);
          return flagForTroy(evt.contactId, 'owner-referral');
        }
        try {
          await hl.addTags(evt.contactId, ['appointment-reply']);
        } catch (e) {
          log(`GUARD-ACTION-FAILED addTags appointment-reply ${evt.contactId}: ${e.message}`);
        }
        const ackText = referral.name
          ? `Got it — thanks for that. I'll pass ${referral.name}'s number along to my partner so he can talk with him directly.`
          : "Got it — thanks for that. I'll pass that number along to my partner so he can talk with them directly.";
        try {
          await hl.sendSms({ contactId: evt.contactId, conversationId, message: ackText, fromNumber: replyFromNumber });
        } catch (e) {
          log(`send failed for ${evt.contactId}: ${e.message}`);
          return respond(200, 'send-failed');
        }
        log(`outcome=referral-acknowledged action=owner-referral booked=false moved=false cancelled=false`);
        return respond(200, 'referral-acknowledged', { category: 'owner-referral' });
      }
    }

    // 7 — hours gate (8 AM–9 PM ET, all contacts, no exceptions)
    if (!withinHours(now(), config)) return respond(200, 'after-hours');

    // 7.5 — existing bookings on the bot calendar AND the legacy calendar
    // (best-effort). Oct 28 lesson: checking only the bot calendar made
    // old-calendar bookings invisible after the Oct 27 repoint, so a
    // booked seller drew the deferral line instead of the no-reschedule
    // ack. Union both, deduped by appointment id; a failed calendar
    // still yields the other's results, never a silent "none".
    let existing = [];
    {
      const calendars = [config.calendarId, config.legacyCalendarId].filter(Boolean);
      const seen = new Set();
      for (const calId of calendars) {
        try {
          const list = await hl.getUpcomingAppointments(calId, evt.contactId, now().getTime());
          for (const appt of list) {
            if (appt && appt.id && !seen.has(appt.id)) {
              seen.add(appt.id);
              existing.push(appt);
            }
          }
        } catch (e) {
          log(`existing bookings load failed (${calId}): ${e.message} — proceeding with what loaded`);
        }
      }
    }

    // 7.6 — TOTAL SILENCE AFTER BOOKING (Nov 3, 2026, Troy): a seller with
    // an appointment on the calendar gets NO reply to anything. Troy
    // handles all communication after the booking. The guards above
    // (opt-out, hostile, etc.) still run — compliance is not "talking".
    // FIX C (Nov 27, 2026): name the tripping appointment id(s) in
    // the log AND the response — a bare 'booked-silent' with no ids
    // is unactionable (Paula's cancelled Sat Nov 28 11 AM row tripped
    // this and nobody could tell which booking it was). The ids flow
    // through the runner into the thread botLog.
    if (existing.length) {
      const ids = existing.map((a) => a && a.id).filter(Boolean);
      log(`booked-silent for ${evt.contactId}: ${existing.length} existing booking(s) [${ids.join(',')}] — Troy handles`);
      return respond(200, 'booked-silent', { appointmentIds: ids });
    }

    // 7.7 — NO-PROPERTY GATE (Nov 20, 2026, Troy — the 30007 fix): the
    // bot sells ONE place — the property on the contact's file. When no
    // property is known (address1 empty, or only a PO Box, which is a
    // mailing address and not a property), there is nothing grounded
    // for the bot to talk about, and the Brightcasa lesson is what it
    // does instead: it improvises a generic "any house or land you
    // might own in <city>" pitch — the exact shape carrier content
    // filters block (error 30007). So: silence + flag for Troy (the
    // appointment-reply tag — he owns the thread, the notifier surfaces
    // it, the watchdog stays silent behind it). NO DND, NO dnc: the
    // contact may be a perfectly good lead whose property simply is
    // not on the record yet. Runs after the deterministic non-pitch
    // paths above (guard seals, firm walkaway, referral ack) and the
    // booked-silence rule, and before every pitch/booking/model path
    // below — including the priced offer, which is a pitch.
    const propertyAddress = contactPropertyAddress(contact);
    if (!propertyAddress) {
      log(`no-property-on-file for ${evt.contactId} — flagging Troy, no pitch`);
      return flagForTroy(evt.contactId, 'no-property-on-file');
    }

    // 8 — context: ballpark + live slots
    // Listing-verification gate (Nov 13, 2026): the MODEL path may only
    // see and state the ballpark when the contact's price is VERIFIED —
    // getVerifiedPrice (MAO/LAO + ARV on file AND the listing-verified
    // marker, §8.65's contract). Prices written with an unverified /
    // listed / unknown listing status yield ballpark=null here, so the
    // system prompt carries "Ballpark on file: NONE" and the §10 number
    // guard blocks any figure the model tries anyway — one fail-closed
    // rule on every path, deterministic or model. Without the marker the
    // seller gets the existing no-number behavior (strike flow /
    // deflection / Troy handoff), exactly as a contact with no prices.
    const ballpark = getVerifiedPrice(contact, config) ? getBallpark(contact, config) : null;
    let slots = [];
    try {
      slots = await getOfferSlots(hl, config, now());
    } catch (e) {
      // One retry: a transient HL failure must not cost the seller their
      // times — without slots the model is told to defer, and Troy's Nov 9
      // rule is that a booking conversation never ends in a deferral.
      log(`slots load failed, retrying once: ${e.message}`);
      try {
        slots = await getOfferSlots(hl, config, now());
      } catch (e2) {
        log(`slots load failed: ${e2.message}`);
      }
    }

    // Bookable window (Oct 24, 4:56 PM lesson): picks are verified
    // against EVERY free slot, not just the 4 on offer — the seller may
    // be answering an offer from an earlier message. Falls back to the
    // offer list if the fetch fails, so a failure degrades to the old
    // behavior instead of breaking booking.
    let bookable = slots;
    try {
      bookable = await getBookableSlots(hl, config, now());
      if (!bookable.length) bookable = slots;
    } catch (e) {
      log(`bookable slots load failed: ${e.message} — verifying against offer list`);
      bookable = slots;
    }

    // The seller's market timezone (Central ONLY for Kansas City) is
    // needed by the window-aware paths below (moved up from the window
    // block: the decline re-fetch and the window block both need it).
    const displayTz = displayTimeZoneFor(evt.toNumber, config);
    // Availability window recovered from the THREAD (Nov 9, Charday
    // Cooke round 2): the window lives in the message that stated it,
    // not just the current turn — a later pick ("5:30 is perfect") is
    // verified against it and fallbacks stay inside it. The current
    // message's own window wins; a new day-part word the parser cannot
    // resolve ("can we do afternoon?") does NOT inherit a stale window —
    // the seller may be changing it. Day/month/date (resolved below)
    // still beat the window.
    const currentWindow = resolveAvailabilityWindow(inboundText);
    const recoveredWindow = currentWindow
      || (/\b(mornings?|afternoons?|evenings?|nights?)\b/i.test(inboundText) ? null : resolveWindowFromHistory(history));

    // Decline of the offered day(s).
    let extraNote = '';
    const decline = detectDecline(inboundText, slots);
    // NO-RESCHEDULE RULE (Oct 24, 6:12 PM, Troy): the bot ONLY books. A
    // decline from a BOOKED seller is acknowledged and the booking is
    // left exactly as it is — no new days, no move, no cancel. Changes
    // are Troy's to handle, not the bot's to improvise.
    if (existing.length && decline.declined) {
      try {
        await hl.sendSms({ contactId: evt.contactId, conversationId, message: noRescheduleAck(existing), fromNumber: replyFromNumber });
      } catch (e) {
        log(`send failed for ${evt.contactId}: ${e.message}`);
        return respond(200, 'send-failed');
      }
      log(`outcome=booking-unchanged action=decline-ack booked=false moved=false cancelled=false`);
      return respond(200, 'booking-unchanged');
    }
    if (decline.declined && decline.days.length) {
      // Unbooked seller declining an offered day: offer other days. This
      // is still booking, not rescheduling — nothing is on the calendar
      // yet. Never answer a decline with a deferral. Nov 9, Charday
      // Cooke round 2: the re-fetch stays INSIDE the seller's window —
      // an evenings-only seller declining Monday gets Tuesday evening,
      // never Tuesday morning.
      try {
        const nextSlots = recoveredWindow
          ? await getWindowSlots(hl, config, recoveredWindow, now(), { excludeDays: decline.days, timeZone: displayTz })
          : await getOfferSlots(hl, config, now(), { excludeDays: decline.days });
        if (nextSlots.length) slots = nextSlots;
      } catch (e) {
        log(`decline re-fetch failed: ${e.message} — keeping original slots`);
      }
      extraNote +=
        `The seller just said they can't make ${decline.days.join(' / ')} — do NOT offer ` +
        `${decline.days.join(' / ')} again. Offer the other times below instead. `;
    }
    if (existing.length) {
      const labels = existing.map((a) => a.title || a.startTime).join('; ');
      const bookedDay = existing[0] && existing[0].startTime ? weekdayOf(existing[0].startTime) : '';
      extraNote +=
        `Existing booking on file: ${labels}. They are ALREADY booked — do NOT offer a new call or ` +
        `new times as if they have none (Oct 24, 3:58 PM lesson: the bot offered a fresh call to a ` +
        `seller who already had Monday booked). The bot does NOT reschedule: if they ask to change ` +
        `the time, acknowledge briefly and leave the booking exactly as it is. If the seller asks to ` +
        `cancel, acknowledge it for Troy to handle — you NEVER cancel bookings yourself. ` +
        (bookedDay
          ? `If they ask about price, point to their existing ${bookedDay} call for numbers — never offer to set up a call as if they have none. `
          : '');
    }

    // Day-targeted offers (Oct 24, 8:06 PM lesson): the seller naming a
    // day ("Friday") must see THAT day's times. The model only ever sees
    // the list it is given, so a Friday request answered with the next-4
    // Monday slots talked the seller back to Monday and deferred Friday
    // to Troy. Working days are Mon–Sat, and the named day may sit
    // beyond the 5-day windows (next Friday from a Saturday is 6 days
    // out), so the day's slots are fetched directly. Booked sellers skip
    // this entirely — they get acknowledgments, never fresh offers.
    let daySlots = [];
    const declinedSet = new Set((decline.days || []).map((d) => String(d).toLowerCase()));
    // SCHEDULING month only (Nov 14, 2026, Paula root cause): the raw
    // resolveNamedMonth matched ANY month name, so "trying to move in
    // february" — a MOVE timeline, not a scheduling request — fetched
    // February's (synthetic) slots and step 8.6's deterministic offer
    // sent them as "...in February", returning BEFORE the model path
    // and its step-11.9 foreign-month guard ever ran. That is why the
    // dfaaef4 guard, correct and deployed, never fired live (three
    // times). resolveSchedulingMonth nulls a month named only as a
    // move timeline; a month the seller directs the call to ("check
    // back in February", "talk in December") still resolves.
    const namedMonth = resolveSchedulingMonth(inboundText, now(), config.timezone);
    const namedDay = !existing.length ? resolveNamedDay(inboundText, now(), config.timezone) : null;
    if (namedDay && !declinedSet.has(namedDay.weekday) && !namedMonth) {
      const dayLabel = namedDay.weekday[0].toUpperCase() + namedDay.weekday.slice(1);
      if (namedDay.weekday === 'sunday') {
        extraNote += `The seller asked about Sunday — we book Monday through Saturday only, so offer the next available times below instead. `;
      } else {
        let dayFetchOk = false;
        try {
          daySlots = await getDaySlots(hl, config, namedDay, now());
          dayFetchOk = true;
        } catch (e) {
          log(`day slots load failed: ${e.message}`);
        }
        // Far-out fallback (Oct 24, 8:35 PM lesson): the feed returns
        // nothing past ~5 days, so an empty feed for the named day is
        // checked against real events instead — never used to override
        // feed data, only when the feed has none.
        if (!daySlots.length) {
          try {
            daySlots = await getSyntheticDaySlots(hl, config, namedDay, now());
          } catch (e) {
            log(`synthetic day slots load failed: ${e.message}`);
          }
        }
        if (daySlots.length) {
          slots = daySlots;
          extraNote += `The seller asked about ${dayLabel} — offer ONLY these ${dayLabel} times below. Do NOT fall back to other days, and do NOT defer ${dayLabel} to Troy. `;
        } else if (dayFetchOk) {
          extraNote += `The seller asked about ${dayLabel}, but ${dayLabel} is fully booked — say so plainly and offer the next available times below instead. `;
        }
      }
    }

    // Month-targeted offers (Oct 24, 8:17 PM lesson): a seller out of
    // the country until December/January must still be bookable FOR
    // that month — the 5-day windows can never reach it. Same shape as
    // day-targeted: the model sees only that month's times, and a
    // month offer the model shows must be bookable (see verifyPool).
    let monthSlots = [];
    if (namedMonth && !existing.length && !daySlots.length) {
      let monthFetchOk = false;
      try {
        monthSlots = await getMonthSlots(hl, config, namedMonth, now());
        monthFetchOk = true;
      } catch (e) {
        log(`month slots load failed: ${e.message}`);
      }
      // Far-out fallback (same Oct 24, 8:35 PM lesson as the day block):
      // when the feed has no data for the month, verify against real
      // events instead of telling the seller the month is full.
      if (!monthSlots.length) {
        try {
          monthSlots = await getSyntheticMonthSlots(hl, config, namedMonth, now());
        } catch (e) {
          log(`synthetic month slots load failed: ${e.message}`);
        }
      }
      if (monthSlots.length) {
        slots = monthSlots;
        extraNote += `The seller asked about ${namedMonth.label} — offer ONLY these ${namedMonth.label} times below. Do NOT fall back to other months, and do NOT defer ${namedMonth.label} to Troy. `;
      } else if (monthFetchOk) {
        extraNote += `The seller asked about ${namedMonth.label}, but ${namedMonth.label} is fully booked — say so plainly and offer the next available times below instead. `;
      }
    }

    // Explicit calendar-date pick (Oct 24, 8:17 PM lesson): "December 15
    // at 9 am" IS the booking, same as a weekday pick — resolved to its
    // date and verified against that date's own slots, however far out.
    let dateDaySlots = [];
    let datePickSlot = null;
    const datePick = findDatePick(inboundText, now(), config.timezone);
    if (datePick) {
      try {
        dateDaySlots = await getDaySlots(hl, config, { date: new Date(Date.UTC(datePick.year, datePick.month, datePick.day, 12)) }, now());
        const matches = dateDaySlots.filter((s) => datePick.times.some((t) => s.label.includes(t)));
        if (matches.length === 1) datePickSlot = matches[0];
      } catch (e) {
        log(`date-pick slots load failed: ${e.message}`);
      }
      // Far-out fallback: only when the feed returned NOTHING for the
      // date (a feed that HAS the date but not the time means the time
      // is genuinely taken — never override that). Verifies the exact
      // requested time against real events.
      if (!datePickSlot && !dateDaySlots.length) {
        try {
          const synth = await verifySyntheticDatePick(hl, config, datePick, now());
          if (synth) {
            datePickSlot = synth;
            dateDaySlots = [synth];
          }
        } catch (e) {
          log(`synthetic date-pick load failed: ${e.message}`);
        }
      }
    }

    // Availability-window offers (Nov 9, 2026, Charday Cooke lesson): a
    // seller stating a window ("available after 5p only") must see times
    // INSIDE that window. The old path showed the generic daytime list
    // and the model deferred with "I'll let my partner know" instead of
    // offering evening times. Same offer shape as every other path (the
    // model composes the question from the slots list); only the slots
    // change. A named day/month/date is more specific than a window, so
    // the window only runs when none of those fired.
    // Round 2: the window is recovered from the THREAD, not just this
    // message (see recoveredWindow above) — a later pick ("5:30 is
    // perfect") is verified against the window pool, and fallbacks stay
    // inside it. (displayTz was computed above the decline block.)
    let windowSlots = [];
    const window = !existing.length && !daySlots.length && !monthSlots.length && !datePick
      ? recoveredWindow
      : null;
    // Booking talk: the seller is talking about WHEN to talk. A zero-slot
    // window only hands off on these — a price question from an
    // evenings-only seller still gets its ballpark answer (with no times
    // to offer, the model answers the question and stops there).
    const isBookingTalk = !!currentWindow || !!datePick || !!namedDay || !!namedMonth
      || /\b\d{1,2}:\d{2}\b/.test(inboundText)
      || /\b\d{1,2}\s*([ap])\.?m\.?\b/i.test(inboundText)
      || /\b(call|talk|chat|set ?up|schedule|book|appointment|meet)\b/i.test(inboundText)
      || decline.declined;
    if (window) {
      let windowFetchOk = false;
      try {
        windowSlots = await getWindowSlots(hl, config, window, now(), { excludeDays: decline.days, timeZone: displayTz });
        windowFetchOk = true;
      } catch (e) {
        log(`window slots load failed: ${e.message}`);
      }
      if (windowSlots.length) {
        slots = windowSlots;
        extraNote += `The seller is only available ${window.label} — offer ONLY these times below. Do NOT fall back to other times, and do NOT defer ${window.label} to Troy. `;
      } else if (windowFetchOk && isBookingTalk) {
        // Round 2: the window has NO bookable slots (the Seller Calls
        // calendar ends at 5 PM — no evening slots exist). Offering
        // other times runs the seller off; saying "that time isn't
        // open" and walking away does the same. Hand the lead to Troy
        // and stay silent — he owns the thread from here.
        return flagForTroy(evt.contactId, 'no-slots-in-window', window.label);
      } else {
        // No slots and either the fetch failed or this message is not
        // about booking (e.g. a price question): answer it, but never
        // offer times outside the seller's window while doing so — and
        // with no window slots to show, the model has no times to offer.
        slots = [];
        extraNote += `The seller is only available ${window.label} — do NOT offer times outside ${window.label}. `;
      }
    }

    // Market timezone (Oct 29, 2026, Troy): the seller sees times in their
    // market's local timezone — Central ONLY for Kansas City, Eastern for
    // the other four markets. Labels are re-rendered here; every ISO
    // underneath is an absolute instant, so the calendar booking lands on
    // the correct moment automatically. (displayTz was computed above the
    // window block; the window hours themselves were evaluated in it.)
    const tzName = tzShortName(displayTz);
    // Nov 11: the injected clock rides along — relabeling against
    // wall-clock "now" made same-day labels go stale the next day and
    // broke pick/claim matching in tests (Nov 2/9 slots stopped reading
    // as "Today"). In production now() IS real time, so behavior is
    // unchanged there.
    const relabelNow = now();
    slots = relabelSlots(slots, displayTz, relabelNow);
    bookable = relabelSlots(bookable, displayTz, relabelNow);
    daySlots = relabelSlots(daySlots, displayTz, relabelNow);
    monthSlots = relabelSlots(monthSlots, displayTz, relabelNow);
    dateDaySlots = relabelSlots(dateDaySlots, displayTz, relabelNow);
    windowSlots = relabelSlots(windowSlots, displayTz, relabelNow);

    // 8.5 — inbound pick (Oct 24, 5:19 PM lesson): the seller naming a
    // real time outright IS the booking. The model only ever sees the 4
    // current offer slots, so it talked a Tuesday pick back to Monday
    // instead of booking it. This bypasses model judgment entirely: an
    // explicit pick matching a bookable slot books it and confirms from
    // the booking. Anything ambiguous (or a declined day) falls through
    // to the model. Runs after the hours gate and quiet check above, so
    // those protections still apply.
    // The pick pool is the bookable window PLUS the named day's, month's,
    // and explicit date's slots (deduped): a Friday pick from a Saturday
    // or a December pick verifies against its own day's slots even
    // though both sit outside the 5-day window. An explicit date pick
    // wins over a weekday pick — it names the exact day.
    // Nov 9, Charday Cooke round 2: same window constraint as verifyPool
    // — an evenings-only seller naming "Monday at 9:00 AM" must not book
    // a daytime slot from the generic bookable list.
    const pickPool = window
      ? [...new Map([...windowSlots, ...daySlots, ...monthSlots, ...dateDaySlots].map((s) => [s.startISO, s])).values()]
      : [...new Map([...bookable, ...daySlots, ...monthSlots, ...dateDaySlots, ...windowSlots].map((s) => [s.startISO, s])).values()];
    const pickSlot = datePickSlot || findInboundPickSlot(inboundText, pickPool, {
      declinedDays: decline.days || [],
      now: now(),
      timeZone: config.timezone,
    });
    if (pickSlot) {
      // NO-RESCHEDULE RULE: a booked seller naming a new time is a move
      // request, not a booking — acknowledge and leave the calendar alone.
      if (existing.length) {
        try {
          await hl.sendSms({ contactId: evt.contactId, conversationId, message: noRescheduleAck(existing), fromNumber: replyFromNumber });
        } catch (e) {
          log(`send failed for ${evt.contactId}: ${e.message}`);
          return respond(200, 'send-failed');
        }
        log(`outcome=booking-unchanged action=pick-ack booked=false moved=false cancelled=false`);
        return respond(200, 'booking-unchanged');
      }
      let pickBooked = false;
      try {
        await hl.createAppointment({
          contactId: evt.contactId,
          startISO: pickSlot.startISO,
          endISO: pickSlot.endISO,
          title: `Seller call — ${contact.firstName || contact.name || 'seller'} — ${pickSlot.label}`,
          ignoreDateRange: pickSlot.synthetic === true,
        });
        pickBooked = true;
      } catch (e) {
        log(`inbound-pick booking failed for ${evt.contactId}: ${e.message}`);
      }
      if (pickBooked) {
        // 8.5.1 — pipeline auto-move (Oct 30, 2026, Troy): the booking
        // succeeded, so the deal drops itself into the Lead pipeline at
        // "Appointment Set" — no hand-dragging. Fail-safe: the booking
        // already happened; an opportunity failure is logged here and
        // never breaks the booking or the confirmation text below.
        try {
          const pipeResult = await ensureLeadOpportunity(hl, config, {
            contactId: evt.contactId,
            contact,
            slotLabel: pickSlot.label,
          });
          log(`pipeline auto-move for ${evt.contactId}: ${JSON.stringify(pipeResult)}`);
        } catch (e) {
          log(`PIPELINE-AUTO-MOVE-FAILED for ${evt.contactId}: ${e.message}`);
        }
        const pickText = `You're all set for ${pickSlot.label}. Talk then!`;
        try {
          await hl.sendSms({ contactId: evt.contactId, conversationId, message: pickText, fromNumber: replyFromNumber });
        } catch (e) {
          log(`send failed for ${evt.contactId}: ${e.message}`);
          return respond(200, 'send-failed');
        }
        log(`outcome=booked-and-replied action=${datePickSlot ? 'date-pick' : 'inbound-pick'} booked=true moved=false cancelled=false`);
        return respond(200, 'booked-and-replied');
      }
      // Booking failed: fall through to the model (logged above).
    }

    // 8.6 — deterministic month offer (Oct 25, 8:03 AM lesson): a seller
    // naming a month ("Can we talk in December") must see THAT month's
    // times. The model path had the December slots and the "do NOT defer"
    // note in front of it and still deferred to Troy, so a month with
    // times to show is offered deterministically, never composed by the
    // model. Runs after the inbound-pick block so explicit date/weekday
    // picks still book first, and only for unbooked sellers (booked
    // sellers get acknowledgments, never fresh offers). Explicit date
    // picks are excluded: a named date+time that failed to book (taken
    // time) stays with the model for taken-time handling, not a generic
    // month offer.
    if (namedMonth && monthSlots.length && !existing.length && !daySlots.length && !datePick) {
      // Nov 7, Nancy Wise: the month offer listed ALL slots as a wall of
      // full timestamps ("Tuesday, December 1 at 8:00 AM, ...") — Troy:
      // "the time table looks stupid." Offer at most 3, in short
      // "Weekday at time" form. Slot data and the pick flow are unchanged
      // — only the presentation. The date is dropped from the label text
      // only; the underlying slots keep their full labels/ISOs.
      // Same weekday+time on different dates (e.g. Tue Dec 1 and Tue Dec 15
      // both read "Tuesday at 9:00 AM") would be indistinguishable, so in
      // that case keep the short date ("Tuesday, Dec 15 at 9:00 AM") —
      // findDatePick parses abbreviated months, so the pick still resolves.
      const shortLabel = (label) => String(label).replace(/, [A-Z][a-z]+ \d+/, '');
      const datedShortLabel = (label) => String(label).replace(/, ([A-Z][a-z]+) (\d+)/, (_, m, d) => `, ${m.slice(0, 3)} ${d}`);
      const shown = monthSlots.slice(0, 3);
      let labels = shown.map((s) => shortLabel(s.label));
      if (new Set(labels).size !== labels.length) {
        labels = shown.map((s) => datedShortLabel(s.label));
      }
      const listed = labels.length > 1
        ? `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`
        : labels[0];
      // Oct 28, Joseph Puig lesson: the deterministic offer must also
      // acknowledge a seller-named price — the prompt-level price-ack rule
      // never runs on this path, so $250K was ignored outright.
      const priceMatch = inboundText.match(/\$[\d,]+(?:\.\d+)?\s*[KkMm]?/);
      const priceAck = priceMatch ? `Got it — ${priceMatch[0]} noted. ` : '';
      const offerText = `${priceAck}I have ${listed} in ${namedMonth.label} — which works for you?`;
      try {
        await hl.sendSms({ contactId: evt.contactId, conversationId, message: offerText, fromNumber: replyFromNumber });
      } catch (e) {
        log(`send failed for ${evt.contactId}: ${e.message}`);
        return respond(200, 'send-failed');
      }
      log(`outcome=month-offer action=month-offer booked=false moved=false cancelled=false`);
      return respond(200, 'month-offer');
    }

    // 8.6.5 — photos instead of visits (Nov 11 late, 2026, Troy): Troy
    // works virtual. A seller inviting a visit ("you can come by and
    // look at the house anytime") gets asked for the SELLER's pictures —
    // inside and outside, texted over — framed as the fastest way for my
    // partner to look it over properly. That saves the trip money, and
    // the same photos market the deal later. Deterministic, like the
    // month offer: the KB's photo ask only covered sellers refusing a
    // call, and the model otherwise read an invitation as call-booking
    // intent. Appointment intent is carved out hard: a named day, month,
    // or date, or any clock time in the message ("come by Saturday at
    // 2") means the seller is SETTING a meeting — the booking paths
    // (pick verification above, the model below) govern those untouched.
    // Runs after the pick/month deterministic paths, so a real pick has
    // already booked before this can fire.
    if (lastOutboundAskedForPhotos(history) && isPhotoSendReply(inboundText)) {
      // The seller is sending the pictures we asked for: a brief human
      // thanks, nothing more. No seal, no DND — the thread stays live
      // for the photos and whatever follows.
      const ackText = "Perfect — send them whenever you're ready. Thanks!";
      try {
        await hl.sendSms({ contactId: evt.contactId, conversationId, message: ackText, fromNumber: replyFromNumber });
      } catch (e) {
        log(`send failed for ${evt.contactId}: ${e.message}`);
        return respond(200, 'send-failed');
      }
      log(`outcome=photos-acknowledged action=photo-ack booked=false moved=false cancelled=false`);
      return respond(200, 'photos-acknowledged');
    }
    if (
      isVisitInvitation(inboundText)
      && !hasExplicitTimeMention(inboundText)
      && !namedDay && !namedMonth && !datePick
    ) {
      const photoAskText =
        'That works — the quickest way for my partner to look it over properly is pictures. ' +
        'Could you text me a few of the inside and outside when you get a chance? That helps him a lot.';
      try {
        await hl.sendSms({ contactId: evt.contactId, conversationId, message: photoAskText, fromNumber: replyFromNumber });
      } catch (e) {
        log(`send failed for ${evt.contactId}: ${e.message}`);
        return respond(200, 'send-failed');
      }
      log(`outcome=photos-requested action=photo-ask booked=false moved=false cancelled=false`);
      return respond(200, 'photos-requested');
    }

    // 8.65 — priced offer reply (Nov 13, 2026, DealBreeze takeaways): a
    // seller asking for our number ("make me an offer", "what's your
    // offer") gets the lead's REAL auto-priced number plus concrete
    // times in Ashley's format — deterministically, not the model's
    // deflection dance. Fires ONLY when a verified price exists on the
    // contact (getVerifiedPrice: MAO/LAO + ARV on file AND the
    // listing-verified marker stamped by the auto-pricing rollout when
    // the listed-first gate returned a verified not-listed). The number
    // stated is the LAO — the opening offer — exactly the figure the
    // number guard already allows. No verified price (unverified
    // listing, or no price at all) → this path does not fire and the
    // seller falls through to the existing strike flow untouched; a
    // number is never invented and an unverified listing status is
    // never treated as cleared. Slots here are the final, window-aware
    // offer list: an evenings-only seller hears the number with NO
    // times rather than daytime times outside their window (Nov 9
    // doctrine), and zero slots with no window falls back to asking
    // when works — never a deferral, never invented times.
    if (isPriceAsk(inboundText)) {
      const verifiedPrice = getVerifiedPrice(contact, config);
      if (verifiedPrice) {
        const offerQ = formatOfferQuestion(slots);
        const priceLine = `I can give you a straight number on it — we could do $${verifiedPrice.lao.toLocaleString('en-US')} cash for the place, as-is.`;
        const pricedText = offerQ
          ? `${priceLine} ${offerQ}`
          : (window ? priceLine : `${priceLine} When's a good time for a quick chat with my partner?`);
        try {
          await hl.sendSms({ contactId: evt.contactId, conversationId, message: pricedText, fromNumber: replyFromNumber });
        } catch (e) {
          log(`send failed for ${evt.contactId}: ${e.message}`);
          return respond(200, 'send-failed');
        }
        log(`outcome=priced-offer action=priced-offer lao=${verifiedPrice.lao} booked=false moved=false cancelled=false`);
        return respond(200, 'priced-offer');
      }
    }

    // Verification pool for model bookings and prose claims: the 5-day
    // window PLUS any day/month/date slots fetched for this message, so
    // a December offer the model shows can actually book instead of
    // falling back to the team-confirm line.
    // Nov 9, Charday Cooke round 2: when a window is active, a pick or
    // claim verifies against the WINDOW pool only — the generic daytime
    // bookable list must never verify a time outside the seller's stated
    // window (a model claim of 9:00 AM for an evenings-only seller is
    // not a booking). Without a window, the pool is unchanged.
    const verifyPool = window
      ? [...new Map([...windowSlots, ...daySlots, ...monthSlots, ...dateDaySlots].map((s) => [s.startISO, s])).values()]
      : [...new Map([...bookable, ...daySlots, ...monthSlots, ...dateDaySlots, ...windowSlots].map((s) => [s.startISO, s])).values()];

    // 8.7 — 3-strike price escalation + vetted objection routing (Nov 5,
    // Ginn #3). Counts how many times the seller has asked for OUR number
    // across this conversation (a seller NAMING their own price is not a
    // strike). Strike 1 deflects to condition (kb FAQ #33); strike 2 uses
    // the car test-drive close + a call; strike 3 goes straight to a call
    // and flags the contact HOT. A vetted objection line, when the inbound
    // matches one, is offered to the model as approved wording to adapt —
    // never sent verbatim, never a dollar figure. Runs on the model path
    // only: silenced/guarded sellers and the deterministic pick/month
    // paths return before this point, so opt-outs/hostile/absurd-price
    // never reach it.
    const priceAsks = countPriceAsks(history, inboundText);
    if (priceAsks === 2) {
      extraNote += ' This is the SECOND time the seller has asked for a price/number in this conversation — use the car test-drive close and move them to a quick call. Do NOT give a number over text.';
    } else if (priceAsks >= 3) {
      extraNote += ' This is the THIRD (or later) time the seller has asked for a price/number — go straight to a call now, no more deflecting, and do NOT give a number over text.';
      // Conservative flag: 'ai-hot-lead' (Ginn tag), NOT Troy's 'hot lead'
      // tag — the latter auto-creates an Acquisitions pipeline deal via the
      // Irish hot-lead chain, which is not what a price-ask streak means.
      try {
        await hl.addTags(evt.contactId, ['ai-hot-lead']);
        log(`strike-3 hot flag for ${evt.contactId}: tagged ai-hot-lead`);
      } catch (e) {
        log(`GUARD-ACTION-FAILED addTags ai-hot-lead ${evt.contactId}: ${e.message}`);
      }
    }
    const objection = matchObjection(
      inboundText,
      (loadKnowledge(config.botPersona).kb.objections || []),
      priceAsks
    );
    if (objection) {
      extraNote += ` The seller's message matches a vetted objection ("${objection.trigger}"). Approved wording — adapt it to plain, spam-safe language, keeping the meaning: "${objection.reply}"`;
    }

    const system = buildSystemPrompt({ contact, ballpark, slots, extraNote: extraNote || undefined, tzName, persona: config.botPersona });
    const messages = history
      .filter((m) => m.body)
      .map((m) => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: String(m.body),
      }));
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== inboundText) {
      messages.push({ role: 'user', content: inboundText });
    }

    // 9 — generate (failure = silence, by design)
    let result;
    try {
      result = await generate(system, messages);
    } catch (e) {
      log(`generation failed for ${evt.contactId}: ${e.message}`);
      return respond(200, 'generation-failed');
    }
    // A book/cancel action with no text is NOT silence: the model chose an
    // action but dropped the words. Substitute a confirmation and proceed
    // (Oct 24, 4:21 PM lesson: a missing confirmation text must never
    // swallow the booking itself). Only a silent action, or a plain reply
    // with nothing to say, goes silent.
    if (result.action === 'silent' || (!result.text && result.action !== 'book' && result.action !== 'cancel')) {
      log(`model-silent for ${evt.contactId} action=${result.action}`);
      return respond(200, 'model-silent');
    }
    if (!result.text) {
      const slot = result.slotStart
        ? verifyPool.find((s) => new Date(s.startISO).getTime() === new Date(result.slotStart).getTime())
        : null;
      result = {
        ...result,
        text: result.action === 'book'
          ? (slot ? `You're all set for ${slot.label}. Talk then!` : 'You got it — you are booked in.')
          : 'Got it — Troy will take care of that.',
      };
    }
    log(`model action=${result.action} slot=${result.slotStart || '-'}`);

    // 10 — post-process: one question, spam-safe words, number guard,
    // vague-pitch screen (Nov 20, 30007 fix). One regeneration attempt,
    // then soften/strip.
    let text = wf.enforceOneQuestion(result.text);
    const violationsOf = (t) => ({
      words: wf.scanOutbound(t),
      numbers: wf.checkNumbers(t, ballpark),
      // A generic pitch is only a violation when it fails to name the
      // property on file — a grounded mention of the seller's own place
      // is the bot doing its job (see wordfilter.js vague-pitch screen).
      vague: wf.isVaguePitch(t) && !wf.referencesProperty(t, propertyAddress),
    });
    const dirty = (v) => v.words.length || !v.numbers.ok || v.vague;
    let v = violationsOf(text);
    if (dirty(v)) {
      const badWords = v.words.map((x) => x.term);
      try {
        const retry = await generate(system, [
          ...messages,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content:
              `[System note: rewrite your last reply. It used carrier-flagged words (${badWords.join(', ') || 'none'}) ` +
              `or figures outside the allowed ballpark. Use plain wording: "we work directly with owners", "the place", ` +
              `"a straight number". State NO dollar figure unless it is exactly one of the ballpark range values. ` +
              (v.vague
                ? `It also pitched property in general instead of the seller's place — talk about the specific place on file (${propertyAddress}) by its street, or drop the pitch entirely. `
                : '') +
              `One question max. Same JSON output format.]`,
          },
        ]);
        if (retry.action !== 'silent' && retry.text) {
          const retryText = wf.enforceOneQuestion(retry.text);
          const rv = violationsOf(retryText);
          if (!dirty(rv)) {
            text = retryText;
            v = rv;
            if (retry.action === 'book') result = retry;
          }
        }
      } catch (e) {
        log(`regeneration failed: ${e.message} — falling back to softening`);
      }
    }
    if (dirty(v)) {
      text = wf.softenOutbound(text);
      v = violationsOf(text);
      if (!v.numbers.ok) {
        text = wf.stripSentencesWith(text, (s) => wf.extractMoneyFigures(s).length > 0);
        v = violationsOf(text);
      }
      if (v.words.length) {
        const bad = new Set(v.words.map((x) => x.term));
        text = wf.stripSentencesWith(text, (s) =>
          wf.scanOutbound(s).some((x) => bad.has(x.term))
        );
        v = violationsOf(text);
      }
      // Vague-pitch strip: softening cannot ground a generic pitch, so
      // its sentences come out. If the pitch WAS the whole message,
      // nothing is left — that is the flag case below, not a send.
      let vagueSeen = v.vague;
      if (v.vague) {
        text = wf.stripSentencesWith(text, (s) =>
          wf.isVaguePitch(s) && !wf.referencesProperty(s, propertyAddress)
        );
        v = violationsOf(text);
        vagueSeen = true;
      }
      if (v.vague || (vagueSeen && !text)) {
        // Still a generic pitch (or the pitch was all there was):
        // silence + flag for Troy. Sending it is how 30007 happens.
        log(`vague-pitch blocked for ${evt.contactId} — silence + flag`);
        return flagForTroy(evt.contactId, 'vague-pitch-blocked');
      }
      if (!text || v.words.length || !v.numbers.ok) {
        // Nothing safe left to say → silence beats a filtered message.
        log(`post-filter-silence for ${evt.contactId}`);
        return respond(200, 'post-filter-silence');
      }
    }

    // No future-outreach promises, ever — code-level backstop for the
    // contract line above. This runs on EVERY outbound text, not just
    // ones that tripped the word/number filters (the 3:13 PM cancel text
    // was clean on both and still promised a follow-up that cannot happen).
    // If stripping empties the text, silence beats a broken fragment.
    text = wf.stripFuturePromises(text);
    if (!text) {
      log(`post-filter-silence for ${evt.contactId} (promise strip emptied text)`);
      return respond(200, 'post-filter-silence');
    }

    // Claim–reality guard (Oct 24, 3:11 PM lesson): the bot once told a
    // seller "your Monday call is canceled" in prose while returning a
    // plain reply action, so nothing was cancelled. Reconcile prose claims
    // with real actions BEFORE the booking step, and only for plain
    // replies (structured book actions already do what they say):
    //  - cancellation claim + existing booking → handoff line (NO-CANCEL
    //    rule Oct 24, 7:44 PM: the bot NEVER cancels, so a claim must
    //    never reach the seller as a false confirmation)
    //  - cancellation claim + no booking → honest no-booking line + offer
    //  - booking claim naming an offered slot → book it for real
    //  - booking claim naming nothing offered → offer the real times
    //    (Nov 9, Troy: never the team-confirm deferral)
    if (result.action === 'reply') {
      if (wf.claimsCancellation(text)) {
        if (existing.length) {
          text = 'Got it — Troy will take care of that.';
        } else {
          // Nothing on file: say so honestly — and offer the real times
          // instead of ending on "let me know if you'd like to set a
          // time" (Nov 9, Troy: a booking conversation ends in times).
          const q = formatOfferQuestion(slots);
          text = q
            ? `No problem — I don't see a booking on file for you, so there's nothing to cancel. ${q}`
            : "No problem — I don't see a booking on file for you, so there's nothing to cancel. Just let me know if you'd like to set a time.";
        }
      } else {
        const claimedSlot = wf.findClaimedSlot(text, verifyPool);
        if (claimedSlot) {
          if (existing.length) {
            // NO-RESCHEDULE: a prose booking claim from a booked seller
            // is a move request — never execute it, and never send the
            // claim as a false confirmation.
            text = noRescheduleAck(existing);
          } else {
            result = { action: 'book', slotStart: claimedSlot.startISO, text };
          }
        } else if (wf.claimsBooking(text)) {
          // The model claimed a booking on a time that was never offered:
          // never send the false confirmation — and never defer to the
          // team either. Offer the real times instead (Nov 9, Troy).
          text = existing.length
            ? noRescheduleAck(existing)
            : offerOrHandoff(slots, "That time isn't open.");
        }
      }
    }

    // 11 — booking / cancel. NO-RESCHEDULE backstop: the model was told
    // the seller is ALREADY booked — a structured book action here is a
    // move request. Never execute it, and never send its confirmation
    // for a booking that will not exist.
    if (result.action === 'book' && existing.length) {
      log(`book action ignored for ${evt.contactId} — booked seller, no-reschedule rule`);
      result = { action: 'reply', text: noRescheduleAck(existing) };
      text = result.text;
    }
    let booked = false;
    let moved = false;
    let cancelled = false;
    if (result.action === 'book' && result.slotStart) {
      const slot = verifyPool.find(
        (s) => new Date(s.startISO).getTime() === new Date(result.slotStart).getTime()
      );
      if (slot) {
        try {
          await hl.createAppointment({
            contactId: evt.contactId,
            startISO: slot.startISO,
            endISO: slot.endISO,
            title: `Seller call — ${contact.firstName || contact.name || 'seller'} — ${slot.label}`,
            ignoreDateRange: slot.synthetic === true,
          });
          booked = true;
          // 11.1 — pipeline auto-move (Oct 30, 2026, Troy): same fail-safe
          // as 8.5.1 — the booking succeeded, so the deal drops itself
          // into the Lead pipeline at "Appointment Set". Any opportunity
          // failure is logged, never surfaced to the seller.
          try {
            const pipeResult = await ensureLeadOpportunity(hl, config, {
              contactId: evt.contactId,
              contact,
              slotLabel: slot.label,
            });
            log(`pipeline auto-move for ${evt.contactId}: ${JSON.stringify(pipeResult)}`);
          } catch (e) {
            log(`PIPELINE-AUTO-MOVE-FAILED for ${evt.contactId}: ${e.message}`);
          }
          // Confirmation comes from the BOOKING, not the model (Oct 24,
          // 4:56 PM lesson): whatever prose the model wrote, the seller
          // hears the real booked slot — so words and calendar can never
          // split again.
          text = `You're all set for ${slot.label}. Talk then!`;
        } catch (e) {
          log(`booking failed for ${evt.contactId}: ${e.message}`);
          // The slot could not be locked — offer the OTHER real times
          // instead of deferring (Nov 9, Troy). Never re-offer the slot
          // that just failed.
          const remaining = (slots || []).filter((s) => s.startISO !== slot.startISO);
          text = offerOrHandoff(remaining, "I couldn't lock that one in.");
        }
      } else {
        // Structured book naming a time that is not a free slot: do NOT
        // send the model's confirmation for a booking that does not exist.
        // Offer the real times instead of deferring (Nov 9, Troy).
        text = offerOrHandoff(slots, "That time isn't open.");
      }
    } else if (result.action === 'cancel') {
      // NO-CANCEL RULE (Oct 24, 7:44 PM, Troy): the bot NEVER cancels an
      // appointment — Troy does that himself. A cancel action is
      // acknowledged for Troy to handle, never executed, and never
      // confirmed as done.
      if (existing.length) {
        text = 'Got it — Troy will take care of that.';
      } else {
        // Nothing on file: say so honestly instead of confirming a
        // cancellation that never existed — and offer the real times
        // instead of ending on "let me know if you'd like to set a
        // time" (Nov 9, Troy: a booking conversation ends in times).
        const q = formatOfferQuestion(slots);
        text = q
          ? `No problem — I don't see a booking on file for you, so there's nothing to cancel. ${q}`
          : "No problem — I don't see a booking on file for you, so there's nothing to cancel. Just let me know if you'd like to set a time.";
      }
    }

    // 11.9 — foreign-month guard (Nov 14, Paula test): a seller's move
    // month must never come back as the booking month. The prompt rule
    // alone did not hold live — the model echoed its own earlier reply
    // out of the thread history three times — so the final text is
    // cleaned in code against the loaded slots' real months.
    if (text) {
      const cleanedText = stripForeignMonth(text, slots);
      if (cleanedText !== text) {
        log(`foreign-month stripped for ${evt.contactId}: "${text}" -> "${cleanedText}"`);
        text = cleanedText;
      }
    }

    // 12 — send (never attempt an empty send: HL rejects it and the
    // silence looks exactly like a dead bot — Oct 24, 4:21 PM lesson)
    if (!text || !text.trim()) {
      // Last-resort empty-send guard: offer real times rather than a
      // deferral (Nov 9, Troy); the handoff question when none exist.
      text = offerOrHandoff(slots);
    }
    try {
      await hl.sendSms({ contactId: evt.contactId, conversationId, message: text, fromNumber: replyFromNumber });
    } catch (e) {
      log(`send failed for ${evt.contactId}: ${e.message}`);
      return respond(200, 'send-failed');
    }
    const outcome = cancelled ? 'cancelled-and-replied' : (booked ? (moved ? 'rescheduled-and-replied' : 'booked-and-replied') : 'replied');
    log(`outcome=${outcome} action=${result.action} booked=${booked} moved=${moved} cancelled=${cancelled}`);
    return respond(200, outcome);
  }

  return handle;
}

module.exports = { createHandler, parseEvent, createDedupe };

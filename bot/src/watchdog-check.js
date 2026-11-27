/**
 * watchdog-check.js — the inbound-triggered watchdog (NO schedule, NO new
 * credential, NO Netlify per-run credit burn).
 *
 * Why this exists: the original watchdog design needed a second,
 * independently stored HighLevel token, and Muse's credential form cannot
 * store one — its verification call is blocked by HighLevel's Cloudflare
 * front door (plain requests die on Error 1010; only a browser signature
 * gets through, proven live Oct 25). Troy rejected the Netlify scheduled
 * function route because it burns credits every 5 minutes.
 *
 * This design sidesteps both blockers. A HighLevel workflow (trigger:
 * Customer Replied, same SMS + Indianapolis-number filters as the bot)
 * waits 10 minutes, then POSTs the original inbound to this function.
 * The function reuses the bot's own Netlify token (already stored, already
 * proven) and the bot's own guard rules, and sends a holding reply ONLY
 * if that exact inbound is still unanswered. Cost is one short function
 * run per real inbound SMS — proportional to seller traffic, not 8,640
 * fixed runs a month — and no deploy-time schedule is involved at all.
 *
 * What it deliberately does NOT do:
 * - It never sends when the bot already answered (any outbound after the
 *   target inbound blocks it), so it can never double-reply a seller.
 * - It never touches DND contacts (global flag or SMS channel) or
 *   guard-category inbound (opt-out, wrong-number, sold/not-for-sale,
 *   hostile, deceased, spam) — and it re-checks the thread's LATEST
 *   inbound too, so a guard-category message sent after the trigger
 *   still blocks the holding reply (Oct 28 Karla lesson). It never sets
 *   DND itself; it only skips.
 * - It never sends to a seller Troy already had a past appointment with
 *   (Nov 7 appointment-reply rule): the bot stays completely silent on
 *   those threads and Troy is notified instead — a holding reply would
 *   undo that silence.
 * - It never acts on a message it cannot find in the thread, one with no
 *   usable timestamp, one fresher than the grace period, or one older
 *   than the staleness cap — never act blind.
 * - It never includes a fromNumber: HighLevel routes on the thread's
 *   number, exactly like the original watchdog design.
 * - It never logs message bodies — log lines carry IDs and outcomes only.
 *
 * Known gap vs the scheduled design, stated honestly: if Netlify itself
 * is down, this function cannot run either (the trigger workflow's
 * webhook call fails). What it DOES cover — the common failures — is a
 * bot reply that failed for one message, a bot workflow that got paused,
 * or a webhook that dropped one inbound while later traffic still flows.
 * The trigger workflow is separate from the bot workflow, so pausing the
 * bot does not pause the watchdog.
 *
 * PROVEN Oct 25, 11:25 AM: HighLevel does NOT carry the trigger's
 * conversation/message context across the 10-minute Wait step — the
 * webhook arrived with contactId intact but conversationId and
 * messageId both null (log: outcome=error, messages load on
 * /conversations/null failed 400). The bot workflow has no wait, which
 * is why it never hit this. The function therefore NEVER trusts those
 * two fields: when either is missing it re-derives them from the
 * contact — most recent conversation via hl.findConversationId, then
 * that thread's latest inbound as the target. Checking the latest
 * inbound (rather than the trigger's exact message) is correct here:
 * if the seller texted twice inside the wait, the newest unanswered
 * PROVEN Oct 25, 11:45 AM (follow-up): dropped fields can also arrive
 * as the literal STRING "null" — truthy, so the falsy check passed it
 * straight through to the messages load, which 400'd again on
 * /conversations/null. cleanId() treats "null"/"undefined" strings as
 * missing, so the derive step runs for them too.
 */
'use strict';

const { classifyInbound, contactIsDnd, contactIsBuyer, withinHours, isAbsurdPrice, isFirmPriceBurst, isReaction, inboundBurst, detectOwnerReferral } = require('./guards');
const { getBallpark, normalizePhoneDigits } = require('./hl');
const { getOfferSlots, getWindowSlots, resolveAvailabilityWindow, formatOfferQuestion, displayTimeZoneFor, relabelSlots } = require('./booking');

// Nov 9, 2026 (Troy): the old holding reply ("my partner will follow up
// with you directly") was a deferral, and deferrals lose money. The
// watchdog now offers real times in Ashley's format instead — window-aware
// when the seller stated one. If the calendar cannot be read, a short ack
// with NO promise: never a follow-up the bot cannot make.
const NO_SLOTS_ACK = 'Thanks for reaching out — got your message.';
const GRACE_MS = 5 * 60 * 1000; // workflow wait is 10 min; enforce anyway
const STALE_MS = 60 * 60 * 1000;

function log(outcome, evt) {
  console.log(
    `[watchdog-check] outcome=${outcome} contactId=${evt.contactId || '-'} ` +
    `conversationId=${evt.conversationId || '-'} messageId=${evt.messageId || '-'}`
  );
}

function parseBody(event) {
  const raw = event.body;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function headerSecret(event) {
  const headers = event.headers || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'x-bot-secret') return headers[key];
  }
  return (event.queryStringParameters || {}).secret || '';
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// A webhook id is missing when it is null, undefined, empty, OR the
// literal strings "null"/"undefined": HighLevel renders dropped merge
// fields as those strings, and a truthy "null" sailed straight past the
// original falsy check into the messages load, which 400'd (proven live
// Oct 25, 11:45 AM — the wait-drop fix's own re-test).
function cleanId(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '' || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return undefined;
    return t;
  }
  return value;
}

function createWatchdogCheck({ config, hl, nowMs = () => Date.now() }) {
  return async function handleWatchdogCheck(event) {
    const evt = parseBody(event);
    // Dropped ids can arrive as the literal strings "null"/"undefined"
    // (see cleanId): normalize before anything trusts these fields.
    evt.conversationId = cleanId(evt.conversationId);
    evt.messageId = cleanId(evt.messageId);
    const fail = (outcome) => {
      log(outcome, evt);
      return { statusCode: 200, body: JSON.stringify({ outcome }) };
    };

    // Fail closed on auth, exactly like the bot handler.
    if (config.webhookSecret && headerSecret(event) !== config.webhookSecret) {
      return fail('unauthorized');
    }
    // The bot kill switch covers this too: if the bot is deliberately off,
    // the safety net must not send behind its back.
    if (config.botEnabled === false) {
      return fail('disabled');
    }
    // After-hours rule (Oct 29, 2026, Troy): the watchdog never talks
    // overnight either. An inbound arriving outside 8 AM–9 PM ET gets no
    // holding reply — the 8 AM catch-up replays it to the bot instead.
    // (Proven by Linda Oliver, Oct 29: her 12:14 AM "80" drew a 12:24 AM
    // holding reply while the bot was correctly silent.)
    if (!withinHours(new Date(nowMs()), config)) {
      return fail('after-hours');
    }

    // Only the contact id is required. HighLevel drops the trigger's
    // conversation/message ids across the workflow's 10-minute wait
    // (proven live Oct 25: both arrived null while contactId survived),
    // so either missing id is re-derived below instead of failing.
    if (!evt.contactId) {
      return fail('bad-request');
    }

    let contact;
    try {
      contact = await hl.getContact(evt.contactId);
    } catch (e) {
      console.error('[watchdog-check] contact load failed:', e && e.message ? e.message : e);
      return fail('error');
    }
    if (contactIsDnd(contact)) {
      return fail('skipped-dnd');
    }

    // ESTABLISHED FIRM/ABSURD (Nov 11 late, 2026, Troy): a contact carrying
    // the firm-price or absurd-price tag has had their one response — the
    // bot seals any further message with DND and never replies, so the
    // watchdog must never break that silence with a holding reply either
    // (e.g. a follow-up that lands while the seal is still being written).
    {
      const tags = Array.isArray(contact.tags) ? contact.tags : [];
      if (tags.includes('absurd-price')) {
        return fail('skipped-absurd-price');
      }
      if (tags.includes('firm-price')) {
        return fail('skipped-firm-price');
      }
      // APPOINTMENT-REPLY TAG (Nov 14, 2026, Douglas Pope): a contact
      // the bot flagged for Troy (appointment-reply — no-slots handoff,
      // live-negotiation wrong-number, owner referral) is under total
      // bot silence. The past-appointment check below only catches
      // calendar-backed threads; a tag-only handoff slipped past it
      // and the watchdog sent a holding offer behind the bot's back.
      if (tags.includes('appointment-reply')) {
        return fail('skipped-appointment-reply');
      }
      // BUYER SILENCE (Nov 20, 2026, Troy — the 30007 fix): a contact
      // carrying buyer tags (`cash buyer` / any `buyer…` tag) is on the
      // buying side — the seller bot sends it NOTHING, and the watchdog
      // must never break that silence with a holding reply. (Nov 20:
      // Brightcasa LLC, a buyer contact in the Carolina seller flow,
      // drew improvised seller pitches until one was carrier-blocked.)
      if (contactIsBuyer(contact)) {
        return fail('skipped-buyer');
      }
    }

    // BOOKED-SILENT (Nov 4, 2026, Eric Kinsey lesson): if the contact has an
    // upcoming appointment, Troy handles ALL communication — the watchdog
    // must never send a holding reply. The bot handler enforces this too,
    // but the watchdog runs on a separate path and needs its own check.
    {
      const calendars = [config.calendarId, config.legacyCalendarId].filter(Boolean);
      let hasBooking = false;
      for (const calId of calendars) {
        try {
          const list = await hl.getUpcomingAppointments(calId, evt.contactId, nowMs());
          if (list && list.length) {
            hasBooking = true;
            break;
          }
        } catch (e) {
          console.error('[watchdog-check] booking check failed:', e && e.message ? e.message : e);
          // Fail closed: if we can't verify, don't send
          return fail('error');
        }
      }
      if (hasBooking) {
        return fail('skipped-booked-silent');
      }
    }

    // APPOINTMENT-REPLY (Nov 7, 2026, Troy): a seller Troy already had a
    // past appointment with gets total silence — the bot never replies and
    // the watchdog must never send a holding reply behind that silence
    // either. Same calendars, same fail-closed rule as the booking check:
    // if the past-appointment lookup fails, don't send.
    {
      const calendars = [config.calendarId, config.legacyCalendarId].filter(Boolean);
      let hadAppointment = false;
      for (const calId of calendars) {
        try {
          const list = await hl.getPastAppointments(calId, contact, nowMs());
          if (list && list.length) {
            hadAppointment = true;
            break;
          }
        } catch (e) {
          console.error('[watchdog-check] past appointment check failed:', e && e.message ? e.message : e);
          // Fail closed: if we can't verify, don't send
          return fail('error');
        }
      }
      if (hadAppointment) {
        return fail('skipped-appointment-reply');
      }
    }

    if (!evt.conversationId) {
      try {
        evt.conversationId = await hl.findConversationId(evt.contactId);
      } catch (e) {
        console.error('[watchdog-check] conversation lookup failed:', e && e.message ? e.message : e);
        return fail('error');
      }
      if (!evt.conversationId) {
        return fail('skipped-not-found');
      }
    }

    let messages;
    try {
      messages = await hl.getMessages(evt.conversationId, 100);
    } catch (e) {
      console.error('[watchdog-check] messages load failed:', e && e.message ? e.message : e);
      return fail('error');
    }
    let idx;
    if (evt.messageId) {
      idx = (messages || []).findIndex((m) => m && m.id === evt.messageId);
      if (idx < 0) {
        return fail('skipped-not-found');
      }
    } else {
      // No trigger message id (wait dropped it): the thread's latest
      // inbound is the target. None at all means nothing to check.
      idx = -1;
      for (let i = (messages || []).length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].direction === 'inbound') {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        return fail('skipped-not-found');
      }
      evt.messageId = messages[idx].id;
    }
    const target = messages[idx];
    if (target.direction !== 'inbound') {
      return fail('skipped-not-inbound');
    }
    // SMS REACTIONS (Nov 4, 2026, Eric Kinsey lesson): "Liked ..." reactions
    // are not messages needing a reply — the watchdog must never treat them
    // as unanswered inbound.
    if (isReaction(target.body || '')) {
      return fail('skipped-reaction');
    }
    const ageMs = nowMs() - (timestampMs(target.dateAdded) ?? NaN);
    if (!Number.isFinite(ageMs)) {
      return fail('skipped-no-timestamp');
    }
    if (ageMs < GRACE_MS) {
      return fail('skipped-too-fresh');
    }
    if (ageMs > STALE_MS) {
      return fail('skipped-stale');
    }
    // Any outbound after the target means the bot (or a human) answered.
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i] && messages[i].direction === 'outbound') {
        return fail('skipped-answered');
      }
    }
    const guard = classifyInbound(target.body || '', messages);
    if (guard && guard.verdict === 'silence-dnd') {
      return fail(`skipped-guard:${guard.category || 'unknown'}`);
    }
    // Defense-in-depth (Oct 28 Karla lesson): the trigger message is not
    // the whole story. If the seller's LATEST inbound is a guard-category
    // message — opt-out, sold/not-for-sale, wrong-number, hostile,
    // deceased, spam — sending a holding reply to an older message would
    // still re-engage someone who must never be messaged again, so skip.
    // The watchdog never sets DND itself; it only skips. (When the wait
    // dropped the ids, the target already IS the latest inbound, so the
    // check above covered it and this one is a no-op.)
    let latestInbound = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].direction === 'inbound') {
        latestInbound = messages[i];
        break;
      }
    }
    if (latestInbound && latestInbound !== target) {
      const latestGuard = classifyInbound(latestInbound.body || '', messages);
      if (latestGuard && latestGuard.verdict === 'silence-dnd') {
        return fail(`skipped-guard-latest:${latestGuard.category || 'unknown'}`);
      }
    }
    // OWNER REFERRAL (Nov 14, 2026, Troy — Douglas Pope, KC): the
    // texter gave the real owner's number ("Call my ex douglas Pope…
    // owns all of our properties right now. 816-616-7825") and the
    // holding reply that went out at 6:31 PM was the bot's times offer
    // repeated word for word — a referral is not a booking chat. The
    // bot handler acknowledges a referral once and flags Troy; the
    // watchdog must never answer one with times. Checks the target
    // AND the latest inbound, same defense-in-depth as the guard
    // check above. A number equal to the contact's own phone is the
    // seller's own callback, not a referral.
    {
      const contactDigits = normalizePhoneDigits(contact && (contact.phone || contact.phoneNumber || contact.mobile));
      const referralIn = (body) => {
        const r = detectOwnerReferral(body || '');
        return !!(r && r.phone && r.phone !== contactDigits);
      };
      if (referralIn(target.body) || (latestInbound && referralIn(latestInbound.body))
        || referralIn([target.body || '', ...inboundBurst(messages)].join('\n'))) {
        return fail('skipped-referral');
      }
    }
    // Absurd-price (Oct 30, 2026, Troy): the bot goes totally silent on
    // an ask above 2× MAO — the watchdog must not break that silence
    // with a holding reply 10 minutes later. Same deterministic rule,
    // same fail-safe (no MAO on file → never skip on price).
    // Burst (Nov 6, Jessica Landis): the absurd ask may sit in an earlier
    // message of this unanswered burst ("5 million" then "That good for
    // you?") — check the whole burst, not just the target.
    {
      const bp = getBallpark(contact, config);
      const burstBodies = [target.body || '', ...inboundBurst(messages)];
      if (bp && burstBodies.some((t) => isAbsurdPrice(t, bp.mao))) {
        return fail('skipped-absurd-price');
      }
      // Firm-price (Nov 11 late, 2026, Troy): a firm burst gets ONE
      // walkaway from the bot and then silence — a watchdog holding reply
      // on top of (or instead of) that walkaway re-engages a seller who
      // is a dead end. Same burst combination test as the bot's guard:
      // a money figure AND firm language across the burst.
      if (isFirmPriceBurst(burstBodies)) {
        return fail('skipped-firm-price');
      }
    }

    // Offer real times in Ashley's format instead of the old deferral.
    // Window-aware when the seller stated one ("available after 5p").
    // Labels render in the seller's market timezone (Central only for KC):
    // the target message carries the market number it was sent to.
    let message = NO_SLOTS_ACK;
    try {
      const displayTz = displayTimeZoneFor(target.to || target.toNumber, config);
      const window = resolveAvailabilityWindow(target.body || '');
      const offerSlots = window
        ? await getWindowSlots(hl, config, window, new Date(nowMs()), { timeZone: displayTz })
        : await getOfferSlots(hl, config, new Date(nowMs()));
      const offer = formatOfferQuestion(relabelSlots(offerSlots, displayTz, new Date(nowMs())));
      if (offer) message = offer;
    } catch (e) {
      console.error('[watchdog-check] offer slots load failed:', e && e.message ? e.message : e);
    }

    try {
      // Direct request, NOT hl.sendSms: the body must never carry a
      // fromNumber, so the thread's own number routes the reply.
      await hl.request('/conversations/messages', {
        method: 'POST',
        version: config.hlVersionConversations,
        body: {
          type: 'SMS',
          contactId: evt.contactId,
          conversationId: evt.conversationId,
          message,
        },
      });
    } catch (e) {
      console.error('[watchdog-check] send failed:', e && e.message ? e.message : e);
      return fail('error');
    }
    log('holding-reply-sent', evt);
    return { statusCode: 200, body: JSON.stringify({ outcome: 'holding-reply-sent' }) };
  };
}

module.exports = { createWatchdogCheck, NO_SLOTS_ACK, GRACE_MS, STALE_MS };

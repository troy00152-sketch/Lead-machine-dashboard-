/**
 * guards.js — the hard rules, enforced in code BEFORE any generation.
 *
 * From the build spec:
 *  - Opt-out / hostile / spam / wrong-number / not-an-owner → NO reply, ever.
 *    The handler sets DND + `dnc` tag via the API immediately.
 *  - DND contacts: never send. Checked on every inbound before generating.
 *  - Hours gate: no outbound outside 8 AM–9 PM America/New_York.
 *  - Mobile-only: never text a number flagged landline.
 *
 * Classification lessons baked in from the XLeads Ashley era:
 *  - Elongated spellings ("stooooop") must still read as opt-outs.
 *  - "Not selling" / "Not interested" ARE opt-outs (do-not-contact expressions,
 *    typos included; when in doubt, treat as rejection).
 */
'use strict';

const { extractMoneyFigures } = require('./wordfilter');
// booking.js requires nothing from guards.js — no import cycle.
const { resolveAvailabilityWindow } = require('./booking');

/** Collapse elongated spellings: 3+ repeated letters → 1 ("stooop" → "stop"). */
function collapseElongated(text) {
  return text.replace(/([a-z])\1{2,}/gi, '$1');
}

/** Lowercase, collapse elongated spellings, trim punctuation for matching. */
function normalize(text) {
  return collapseElongated(String(text || '').toLowerCase()).trim();
}

// Single-word carrier opt-out keywords (whole message only).
const SINGLE_WORD_OPTOUT = new Set([
  'stop', 'end', 'quit', 'cancel', 'unsubscribe', 'stopall', 'revoke', 'optout',
]);

// Phrase patterns → opt-out. Tested against the normalized text.
const OPTOUT_PATTERNS = [
  /\bstop\b.*\b(text|texting|messag|contact|call)/,
  /\b(don'?t|do not|never)\b[^.]*\b(text|contact|call|message|bother)\b/,
  /\b(unsubscribe|opt[\s-]?out)\b/,
  /\b(remove|take)\b[^.]*\b(me|my number|this number)\b[^.]*\b(off|from|list)\b/,
  /\bleave me alone\b/,
  /\bnot interested\b/,
  /\bnot selling\b/,
  /\bno longer interested\b/,
  /\bstop texting\b/,
  /\bdelete my (number|info)\b/,
];

// Wrong-number / not-an-owner patterns (no sold language — that lives in
// NOT_OWNER_SOLD_PATTERNS below so the not-sold-yet guard can suppress it).
const NOT_OWNER_PATTERNS = [
  /\bwrong number\b/,
  /\byou have the wrong\b/,
  /\byou'?ve got the wrong (person|number)\b/,
  /\bnot (the )?owner\b/,
  /\bi (don'?t|do not) own\b/,
  /\bthis is not (my|the)\b[^.]*\b(place|house|property|number)\b/,
  /\bnot my (place|house|property|number)\b/,
  /\bi rent\b[^.]*\bnot (the )?owner\b/,
  // Nov 6: Shelby Martinez "No longer my property" drew a bot reply —
  // the seller does not own it any more. Seals like any not-owner signal.
  /\bno longer (my|our|the) (property|house|place|home|condo|lot)\b/,
];

// Sold language that still means "not an owner any more". Kept separate
// from NOT_OWNER_PATTERNS so a not-sold-yet negation can suppress exactly
// these — "I haven't sold it yet" must never seal a live seller.
const NOT_OWNER_SOLD_PATTERNS = [
  // NOTE: "the"/"my" are deliberately NOT bare objects here — "we sold
  // the car" must not seal. Property objects go through
  // SOLD_NOT_FOR_SALE_PATTERNS ("sold the house") instead.
  /\b(i|we) (already )?sold (it|that)\b/,
  /\b(it|the place|the house) (already )?sold\b/,
  /\balready sold\b/,
  /\bit'?s sold\b/,
  // Nov 6: Jamani Williams "That house has been sold" drew a bot reply —
  // "that house" and "has been sold" were both missing from the subjects
  // and verbs above. "It has been sold" is the same signal.
  /\b(that|this) (house|place|property|home|condo) (has been )?sold\b/,
  /\bit has been sold\b/,
];

// Negations: the seller has NOT sold (yet). Suppresses every sold pattern
// in this file — a seller who has not sold is still a prospect. Deliberately
// narrow: it never suppresses opt-out, hostile, spam, or wrong-number
// patterns, so "haven't sold yet, stop texting me" still seals as opt-out.
const NOT_SOLD_YET_PATTERNS = [
  /\bnot (yet )?sold\b/,
  /\b(haven't|hasn't|hadn't|have not|has not|never) sold\b/,
  /\bsold\b[^.]*\bnot yet\b/,
  // Nov 6: the "has been sold" patterns above need "been sold" negations
  // too — "never has been sold" / "has not been sold yet" are live sellers.
  /\bnever (has|have) been sold\b/,
  /\bnot (yet )?been sold\b/,
];

// Sold / not-for-sale family (Oct 28 Karla lesson): Karla Estala replied
// "I sold them" and NO pattern matched — "them" was missing from the old
// object list — so she was never sealed and the watchdog replied at
// 7:12 PM. Every pattern here silences + DNDs + dnc-tags like any opt-out.
// The bare "we sold" pattern is end-anchored on purpose: "we sold the car"
// must NOT match (see "I sold my car" negative case).
const SOLD_NOT_FOR_SALE_PATTERNS = [
  /\b(i|we) (already )?sold (them|this)\b/,
  /\bsold (the|my|this|that) (house|property|place|home|land|lot|condo|duplex|townhouse|townhome|trailer|unit|building)\b/,
  /\b(i|we) sold\s*[.!?]*$/,
  // Nov 11: Christopher Jarman "I sold last October" drew a bot reply —
  // a past-tense sold statement with a TIME phrase instead of an object
  // ("last October", "in June", "back in March") matched nothing. These
  // seal like sold. Narrow by construction: the time word must follow
  // "sold" (or "sold it/that") directly — "I sold my car last October"
  // and "I sold my truck yesterday" (vehicle object first) still stay
  // live, and "I sold my house last October" already seals via the
  // "sold my house" pattern above.
  /\b(i|we) (already )?sold (last|in|back in)\b/,
  /\b(i|we) (already )?sold (it|that|them|this) (last|in|back in)\b/,
  /\bsold (last|in) (january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|fall|winter|year)\b/,
  /\bsold in (19|20)\d{2}\b/,
  /\bno longer selling\b/,
  /\bnot for sale\b/,
  /\bno\b[,.]?\s+(as\s+)?for sale\b/, // Oct 31: Alejandro Resendiz "No, as for sale" (broken English for "not for sale", Spanish speaker) drew a bot reply — seals like "not for sale".
  /\bno longer (for sale|on the market)\b/,
  // Nov 4: Donald Thompson "I have an offer of $90,000 that we will take in
  // December" — the seller ALREADY HAS an offer from someone else. The bot
  // misread $90,000 as his asking price and started offering appointment
  // times. "Have an offer" / "under contract" means the deal is gone —
  // seal like sold, never book.
  /\b(i|we) (already )?have an offer\b/,
  /\b(i|we) (already )?got an offer\b/,
  /\bunder contract\b/,
  /\b(i|we)'?re (already )?(taking|accepting) an offer\b/,
];

// Deceased-owner reports: the seller (or a relative) is reporting a death.
// Narrow by construction — person-death phrasing only, never "the deal is
// dead" or "deadline". "Died laughing" is idiom, explicitly excluded.
const DECEASED_PATTERNS = [
  /\bdeceased\b/,
  /\bpassed away\b/,
  /\bthe owner (died|is dead|passed away)\b/,
  /\bmy (mom|dad|mother|father|husband|wife|brother|sister|son|daughter|grandmother|grandfather) (died|is dead|passed away|has died)\b/,
  /\b(he'?s|she'?s|they'?re|he is|she is) dead\b/,
  /\b(he|she|they) (died|has died)\b/,
];
const DECEASED_EXCLUSIONS = [
  /\bdied laughing\b/,
];

// Hostility: profanity / abuse directed at us. Small, deliberate lexicon.
const HOSTILE_PATTERNS = [
  /\bf+u+c+k+\b/,
  /\bpiss off\b/,
  /\b(bitch|asshole|a\*\*hole|dumb\s?ass|idiot|scumbag|shut up)\b/,
  /\b(go to hell|screw you|f off)\b/,
  /\bkiss my (ass\b|a\*\*)/, // Oct 28: Andre Powell "Kiss my ass" drew a watchdog reply because this phrase was missing — silence + DND, never a reply.
  /\b(tits|titties|boobs|nudes)\b/, // Oct 28: Nicholas Whisenant "show me your titties" drew no guard action — sexual harassment silences + DNDs like any hostile inbound.
  /\b(pussy|dick|cock|cocksucker)\b/,
  /\bshow me your (tits|titties|boobs|pussy|ass)\b/,
  /\bsuck my (dick|cock)\b/,
  /\bblow ?job\b/,
  /\b(sue you|my (lawyer|attorney)|report you|you'?re harassing|harassing me)\b/, // legal/report threats → silence + DND per hardening. NOTE: "is this a scam/fraud?" is skepticism (KB 6), NOT hostility — deliberately not matched here.
  /\bfk\b/, // Nov 11: Rolando Mendoza "Fk" (one-word abbreviated profanity rejection, Nov 4) drew a bot reply — "fk" is profanity, not a word. Seals like any hostile inbound.
  // Nov 11: Carroll Scott "Who in the hell do you think you are addressing
  // me last name only?" (Nov 4) drew a bot reply — angry, personal
  // hostility, not a question to answer. Narrow: the "who do you think
  // you are" / "how dare you" phrasings only; a plain "Who are you?"
  // (asking who we are) still proceeds.
  /\bwho (in the )?hell do you think you are\b/,
  /\bwho do you think you are\b/,
  /\bhow dare you\b/,
];

// Spam signals: a message is spam when it carries >= 2 signals (or 1 strong one).
const SPAM_STRONG = [
  /\b(crypto|bitcoin|forex)\b.*\b(invest|profit|earn)/i,
  /\byou('ve| have) (won|been selected)\b/i,
  /\bclaim your (prize|reward|money)\b/i,
  /\bwork from home\b.*\$\s?\d/i,
];
const SPAM_SIGNALS = [
  /https?:\/\//gi,
  /\b(bit\.ly|tinyurl|t\.co|rb\.gy|shorturl)\b/gi,
  /\$\s?\d{2,}[\d,.]*/g,
  /\b(prize|jackpot|lottery|winner|free money|gift card)\b/gi,
  /\b(viagra|casino|betting bonus|loan approved|you qualify)\b/gi,
  /[A-Z]{12,}/g, // long shouting runs
];

function isOptOut(rawText) {
  const text = normalize(rawText);
  if (!text) return false;
  const bare = text.replace(/[^a-z]/g, '');
  if (SINGLE_WORD_OPTOUT.has(bare)) return true;
  return OPTOUT_PATTERNS.some((re) => re.test(text));
}

function isNotOwner(rawText) {
  const text = normalize(rawText);
  // Explicit wrong-person declaration with a capitalized name, tested on the
  // RAW text (normalize() lowercases, which would erase the signal).
  // Oct 29 Justin Smith lesson: "I'm not Justin 🤣" kept the bot chatting
  // with a wrong number for three more turns — this seals it instead.
  // Lowercase "i'm not sure" / "i'm not interested" must NOT match.
  if (/\b[iI](?:'?m| am) not [A-Z][a-z]{1,}\b/.test(String(rawText || ''))) return true;
  // Third-person wrong-name declaration: "This is not Carrie" — the Oct 29
  // Carrie Garris lesson. Bot apologized instead of sealing. Capitalized
  // name required so "this is not my house" / "this is not correct" pass
  // through to their own patterns (or proceed).
  if (/\b[tT]his is not [A-Z][a-z]{1,}\b/.test(String(rawText || ''))) return true;
  if (NOT_OWNER_PATTERNS.some((re) => re.test(text))) return true;
  // A not-sold-yet seller is still a prospect: suppress only the sold
  // patterns, never the wrong-number patterns above.
  if (NOT_SOLD_YET_PATTERNS.some((re) => re.test(text))) return false;
  return NOT_OWNER_SOLD_PATTERNS.some((re) => re.test(text));
}

// Nov 9, 2026, Charday Cooke round 2 — CLEAR wrong-person declarations:
// an explicit statement that the texter is not the owner / not the named
// person / the property is not theirs. These ALWAYS seal, even in a live
// negotiation — they mean the deal is with the wrong human. Everything
// else in the wrong-number family is a BARE "wrong number" (below).
function isClearWrongPerson(rawText) {
  const raw = String(rawText || '');
  if (/\b[iI](?:'?m| am) not [A-Z][a-z]{1,}\b/.test(raw)) return true;
  if (/\b[tT]his is not [A-Z][a-z]{1,}\b/.test(raw)) return true;
  const text = normalize(rawText);
  if (/\byou have the wrong person\b/.test(text)) return true;
  if (/\byou'?ve got the wrong person\b/.test(text)) return true;
  if (/\bnot (the )?owner\b/.test(text)) return true;
  if (/\bi (don'?t|do not) own\b/.test(text)) return true;
  if (/\bthis is not (my|the)\b[^.]*\b(place|house|property)\b/.test(text)) return true;
  if (/\bnot my (place|house|property)\b/.test(text)) return true;
  if (/\bi rent\b[^.]*\bnot (the )?owner\b/.test(text)) return true;
  if (/\bno longer (my|our|the) (property|house|place|home|condo|lot)\b/.test(text)) return true;
  return NOT_OWNER_SOLD_PATTERNS.some((re) => re.test(text));
}

// A BARE "wrong number": the two-word phrase (or "you have the wrong
// number") with NO clear wrong-person declaration attached. In a live
// negotiation this is frustration at the bot's own bad offers — it flags
// Troy, it never seals. First-reply bare "wrong number" (no prior
// engagement) still seals via the handler's negotiation check.
const BARE_WRONG_NUMBER_PATTERNS = [
  /\bwrong number\b/,
  /\byou have the wrong number\b/,
  /\byou'?ve got the wrong number\b/,
];
function isBareWrongNumber(rawText) {
  const text = normalize(rawText);
  if (!BARE_WRONG_NUMBER_PATTERNS.some((re) => re.test(text))) return false;
  return !isClearWrongPerson(rawText);
}

// Nov 9, Charday Cooke round 2: the thread shows a LIVE negotiation when
// a prior inbound stated an availability window, discussed a price, or
// named a time. A bare "wrong number" after that is frustration at the
// bot's own bad offers — it flags Troy, it never seals. Engagement is
// deliberately over-inclusive: a stranger's "wrong number" that happens
// to mention a time costs Troy one flag to clear; sealing a live seller
// costs the deal.
const TIME_MENTION_PATTERNS = [
  /\b\d{1,2}:\d{2}\s*([ap])\.?m\.?\b/i, // "5:30 pm"
  /\b\d{1,2}:\d{2}\b/, // "5:30"
  /\b\d{1,2}\s*([ap])\.?m\.?\b/i, // "9 am"
  /\b(at|around|about)\s+\d{1,2}\b/i, // "call me at 5"
];
function threadShowsNegotiation(history) {
  const inbounds = (history || []).filter((m) => m && m.direction === 'inbound' && m.body);
  return inbounds.some((m) => {
    const body = String(m.body);
    if (resolveAvailabilityWindow(body)) return true;
    if (/\$\s?[\d,]+/.test(body)) return true;
    return TIME_MENTION_PATTERNS.some((re) => re.test(body));
  });
}

// LISTED-PROPERTY seal (Nov 6, 2026, Troy — Connor Mullen lesson): the
// seller sent a Zillow homedetails link for 7736 Pennycroft Dr and the
// bot replied TWICE — first the "Zillow's never been inside" objection
// line, then a condition probe. A seller sending their listing means the
// property is LISTED (LISTED-FIRST hard lock: pass immediately, no offer,
// no chase). The bot must NEVER respond: total silence + DND + dnc,
// sealed like sold. The link alone is the signal — Troy: "Seller send
// the link that mean this is listed."
//
// Listing-site links seal on their own — no negation can unsend a link.
const LISTED_LINK_PATTERNS = [
  /(zillow|realtor|redfin|trulia|homes)\.com/i,
  /homedetails/i, // Zillow /homedetails/ path
];

// Current-state "listed" phrasing. Narrow by construction: "Zillow says
// it's worth more" (a valuation objection, live) has no ".com" and no
// listed/listing word, so it still proceeds to the model; "my friend is
// a realtor" is advice, not a listing; "are you a realtor?" is a
// question about us, not a listing.
const LISTED_PATTERNS = [
  /\bit'?s (already )?listed\b/,
  /\bis listed\b/,
  /\balready listed\b/,
  /\blisted (with|by|through)\b/,
  /\bin the listing\b/,
  /\b(the|my|our|this|that) listing\b/,
  /\blisting (says|shows|has|states)\b/,
  /\bon the market\b/,
  /\bmy (realtor|real estate agent|listing agent)\b/,
  /\bour realtor\b/,
  /\bthe listing agent\b/,
];

// Not-listed-yet negations: the seller has NOT listed (yet) — still a
// prospect. Deliberately narrow, same shape as NOT_SOLD_YET_PATTERNS:
// it never suppresses opt-out, hostile, spam, or wrong-number patterns.
const NOT_LISTED_YET_PATTERNS = [
  /\bnot (yet )?listed\b/,
  /\b(haven't|hasn't|have not|has not|never) listed\b/,
  /\bnot on the market\b/,
  /\b(will|going to|gonna|plan to|want to|thinking of|thinking about|trying to)\s+list(ing)?\b/,
];

function isListed(rawText) {
  const text = normalize(rawText);
  if (LISTED_LINK_PATTERNS.some((re) => re.test(text))) return true;
  if (NOT_LISTED_YET_PATTERNS.some((re) => re.test(text))) return false;
  return LISTED_PATTERNS.some((re) => re.test(text));
}

function isSoldNotForSale(rawText) {
  const text = normalize(rawText);
  if (NOT_SOLD_YET_PATTERNS.some((re) => re.test(text))) return false;
  return SOLD_NOT_FOR_SALE_PATTERNS.some((re) => re.test(text));
}

function isDeceased(rawText) {
  const text = normalize(rawText);
  if (DECEASED_EXCLUSIONS.some((re) => re.test(text))) return false;
  return DECEASED_PATTERNS.some((re) => re.test(text));
}

function isHostile(rawText) {
  const text = normalize(rawText);
  return HOSTILE_PATTERNS.some((re) => re.test(text));
}

function isSpam(rawText) {
  const text = String(rawText || '');
  if (SPAM_STRONG.some((re) => re.test(text))) return true;
  let signals = 0;
  for (const re of SPAM_SIGNALS) {
    const matches = text.match(re);
    if (matches) signals += matches.length >= 2 ? 2 : 1;
    if (signals >= 2) return true;
  }
  return false;
}

/* ── Rejection silence rule (Nov 3, 2026, Troy) ────────────────────────
 * A plain rejection ("No", "Not interested") is not an opt-out, not hostile,
 * not wrong-number — but the seller is done. Total silence, same as opt-out.
 * The Nov 3 lesson: 4 violations in one day (William Holmes, James Hopkins,
 * Sabrina Ratcliff, Artist Montgomery) — the bot kept replying after "No"
 * because classifyInbound had no rejection check. This seals it.
 */
const BARE_NO_PATTERNS = [
  /^\s*no+\s*[.!]*\s*$/i,                    // "No", "No.", "Nope", "Nah"
  /^\s*nope\s*[.!]*\s*$/i,
  /^\s*nah\s*[.!]*\s*$/i,
];

// The rest of the rejection family seals on the words alone — no context
// needed ("not interested", "don't want to sell", "not anytime soon").
const REJECTION_PATTERNS = [
  /\bnot interested\b/i,
  /\bnot any ?time soon\b/i,              // Nov 6, Johnny Wynne: "Not anytime soon. We love it too!" drew a reply — a soft rejection is still a rejection
  /\bno thanks?\b/i,
  /\bno thank you\b/i,
  /\bi'?m not interested\b/i,
  /\bdon'?t (want|need) (it|this|your)\b/i,
  // Nov 7, Nancy Wise: "I don't want to sell it" drew December booking
  // times — the list had no "don't want to sell" pattern. The whole
  // "don't want to sell" family seals as a rejection. The negation is
  // required, so plain interest ("want to sell", "thinking of selling")
  // still proceeds.
  /\b(don'?t|do not|dont)\s+(want\s+to|wanna)\s+sell\b/i,
  /\bnot\s+(looking|planning)\s+to\s+sell\b/i,
  /\bnot\s+(going|gonna)\s+to\s+sell\b/i,
  /\bleave me alone\b/i,
  /\bstop (bothering|contacting) me\b/i,
];

/* ── Bare-"No" question-context exemption (Nov 11, 2026 — Gatlin gap) ──
 * A bare "No" is only an answer when the last outbound message asked a
 * yes/no question ("Do you still owe anything?" → "No"). Without that
 * context it is a fragment — "No" after a statement ("Got it, thanks")
 * or a wh-question ("What price are you thinking?") is not a rejection
 * of selling, and sealing it (DND + dnc) runs a live seller off. So a
 * bare "No"/"Nope"/"Nah" seals ONLY when the last outbound asked a
 * yes/no question; otherwise it proceeds to the model. No outbound in
 * history (or no history at all) = no question = no seal: fail open.
 * Gatlin himself is covered twice: his "No" DID answer a yes/no
 * question, so this exemption alone would still seal him — but the
 * appointment-reply check (past appointment → total silence, no DND)
 * runs before every guard seal and protects him there.
 *
 * A yes/no question is the last "?"-terminated sentence of the last
 * outbound message starting with an auxiliary/modal (do/does/is/are/
 * can/could/will/would/should/have/has/...) or a yes/no opener
 * (want/wanna/need/any). "What price are you thinking?" starts with
 * "what" → not yes/no. "Would Monday at 9 work?" starts with "would"
 * → yes/no (a "No" there seals, as before). Only the LAST question
 * counts: "Do you still owe anything? What price are you thinking?"
 * ends on a wh-question, so a "No" after it does not seal. */
const YES_NO_STARTERS = new Set([
  'am', 'are', 'is', 'was', 'were', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'shall', 'should',
  'may', 'might', 'have', 'has', 'had',
  'want', 'wanna', 'need', 'any',
]);

function lastOutboundAskedYesNoQuestion(history) {
  const msgs = Array.isArray(history) ? history : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.direction !== 'outbound' || !m.body) continue;
    const questions = String(m.body).match(/[^.!?]*\?/g);
    if (!questions || !questions.length) return false;
    const lastQ = questions[questions.length - 1].trim().toLowerCase();
    const first = (lastQ.split(/\s+/)[0] || '')
      .replace(/[^a-z']/g, '')
      .replace(/n't$/, '');
    return YES_NO_STARTERS.has(first);
  }
  return false;
}

function isBareNo(rawText) {
  const text = normalize(rawText);
  if (!text) return false;
  return BARE_NO_PATTERNS.some((re) => re.test(text));
}

function isRejection(rawText, history) {
  const text = normalize(rawText);
  if (!text) return false;
  // Bare "No" needs the question context (see above); everything else in
  // the family seals on the words alone.
  if (isBareNo(rawText)) return lastOutboundAskedYesNoQuestion(history);
  return REJECTION_PATTERNS.some((re) => re.test(text));
}

/* ── Absurd-price silence rule (Oct 30, 2026, Troy) ────────────────────
 * Victoria Roberts lesson: "$500,000 and we have a deal" drew continued
 * engagement (a condition probe, then a timeline probe) instead of
 * disengagement. When the seller names an asking price more than
 * ABSURD_PRICE_MULTIPLE × the MAO on file, the bot goes completely
 * silent — no reply, no walkaway message, no nurture tag. The contact is
 * tagged `absurd-price` for reporting.
 * FAIL-SAFE: with no MAO on file (missing/zero/unknown) the rule NEVER
 * fires — the bot cannot judge absurdity without numbers. This preserves
 * the standing rule "never claim too far apart with no MAO/LAO on file".
 * Between 1× and 2× MAO the walkaway-nurture path is unchanged. */

/** Ask multiple of MAO above which the bot goes totally silent. Tunable. */
const ABSURD_PRICE_MULTIPLE = 2.0;

/**
 * Absolute dollar figure at or above which the bot goes totally silent,
 * even with no MAO on file (Nov 3, 2026, Troy: "Seller said one million
 * the bot still reply"). Troy's ceiling is $350K ARV — a half-million
 * ask is absurd on its face. Tunable.
 */
const ABSURD_PRICE_ABSOLUTE = 500000;

/**
 * True when the inbound names a price with firm / non-negotiable language.
 * (Nov 3, 2026, Troy: "some seller say 300k thats what I want nothing less".)
 * $300K isn't absurd like $1M, but "nothing less" means they're not negotiating —
 * the bot should gracefully bow out, not keep probing. Requires BOTH a money
 * figure AND firm language. The walkaway message comes from the prompt's
 * WALKAWAY TRAP section.
 *
 * (Nov 11, 2026, Troy: "$70K, not a penny less" kept getting probed and
 * could book — the seller wants to sell but doesn't need to sell, so any
 * appointment is a waste of time. The old patterns had no "penny" match
 * at all. New patterns below: penny/cent, won't budge, not moving on
 * price, don't need to sell, bottom line, price is the price.)
 */
// Firm / non-negotiable language. Tested against the lowercased text.
const FIRM_PRICE_PATTERNS = [
  /\bnothing\s+less\b/,
  /\bfirm\b/,
  /\bfinal\s+(price|offer|number)\b/,
  /\btake\s+it\s+or\s+leave\s+it\b/,
  /\bnon[-\s]?negotiable\b/,
  /\bnot\s+negotiable\b/,
  /\bthat'?s\s+(what\s+i\s+want|my\s+price)\b/,
  /\bmy\s+price\s+is\b/,
  /\bi\s+want\s+.*\bfor\s+it\b/,
  /\bdon'?t\s+(bother|waste).*lower\b/,
  /\bno\s+lowball/,
  // Nov 11: "not a penny less" / "not one penny less" / "not a cent less"
  /\bnot\s+(a\s+|one\s+)?(penny|cent)\s+(less|more)\b/,
  // Nov 11: "won't budge" / "will not budge" / "not budging"
  /\b(won'?t|will\s+not)\s+budge\b/,
  /\bnot\s+budging\b/,
  // Nov 11: "not moving on the price" / "not moving on my price"
  /\bnot\s+moving\s+on\s+(the\s+|my\s+)?price\b/,
  // Nov 11: "don't need to sell" — wants to sell, doesn't need to
  /\b(don'?t|do\s+not)\s+need\s+to\s+sell\b/,
  // Nov 11: "that's my bottom line" / "bottom line is"
  /\bthat'?s\s+my\s+bottom\s+line\b/,
  /\bmy\s+bottom\s+line\b/,
  /\bbottom\s+line\s+is\b/,
  // Nov 11: "price is the price"
  /\bprice\s+is\s+the\s+price\b/,
];

/** True when the text names a money figure ($70,000 or 70k). */
function hasMoneyFigure(rawText) {
  const figures = extractMoneyFigures(rawText);
  if (figures.length) return true;
  // Also catch k-suffix without $ sign ("300k") — extractMoneyFigures needs the $.
  return /\b\d+(?:\.\d+)?k\b/.test(String(rawText).toLowerCase());
}

/** True when the text carries firm / non-negotiable language. */
function hasFirmLanguage(rawText) {
  return FIRM_PRICE_PATTERNS.some((p) => p.test(String(rawText).toLowerCase()));
}

function isFirmPrice(rawText) {
  return hasMoneyFigure(rawText) && hasFirmLanguage(rawText);
}

/**
 * Burst version of isFirmPrice (Nov 11, 2026, Troy): the price and the
 * firm language may sit in DIFFERENT messages of one unanswered burst
 * ("$70k" then "not a penny less"). True when ANY message in `bodies`
 * names a money figure AND ANY message (same or different) carries firm
 * language. The money figure is still required — firm language alone
 * ("not a penny less" with no price anywhere) stays live.
 */
function isFirmPriceBurst(bodies) {
  const list = Array.isArray(bodies) ? bodies : [bodies];
  return list.some((t) => hasMoneyFigure(t)) && list.some((t) => hasFirmLanguage(t));
}
function isAbsurdPrice(rawText, mao) {
  const figures = extractMoneyFigures(rawText);
  // Word-form check (Nov 3): "one million", "1.5 million", "a million", "2 billion", etc.
  // extractMoneyFigures only catches digit forms ($1,000,000) — Troy's seller said "one million".
  const wordMillion = /\b(one|two|three|four|five|six|seven|eight|nine|ten|a|an|\d+(?:\.\d+)?)\s+million\b/i.test(rawText);
  const wordBillion = /\bmillion\b.*\bbillion\b|\bbillion\b/i.test(rawText);
  // Word-form hundred-thousands at/above the absolute gate: "five hundred thousand" (Nov 14 battery).
  const wordHundredThousand = /\b(five|six|seven|eight|nine)\s+hundred\s+thousand\b/i.test(rawText);
  if (wordMillion || wordBillion || wordHundredThousand) return true;
  if (!figures.length) return false;
  const ask = Math.max(...figures);
  // Absolute gate (Nov 3): half a million or more is absurd on its face,
  // MAO or no MAO — Troy's ceiling is $350K ARV.
  if (ask >= ABSURD_PRICE_ABSOLUTE) return true;
  // Relative gate: needs a real MAO.
  if (!Number.isFinite(mao) || mao <= 0) return false;
  return ask > ABSURD_PRICE_MULTIPLE * mao;
}

/**
 * Classify an inbound message.
 * Returns { verdict: 'silence-dnd', category } for the five no-reply buckets,
 * or { verdict: 'proceed' }.
 * `history` is the thread ({ direction, body }, chronological) — needed
 * only for the bare-"No" question-context exemption (Nov 11, Gatlin gap):
 * a bare "No" seals only when the last outbound asked a yes/no question.
 * Callers without history get the fail-open behavior (bare "No" proceeds);
 * every other guard is context-free and unaffected.
 */
// SMS REACTIONS (Nov 4, 2026, Eric Kinsey lesson): iMessage-style "Liked"
// reactions arrive as inbound SMS like 'Liked "You're all set..."'. They
// are NOT messages needing a reply — the watchdog must never treat them
// as unanswered inbound. Returns true for reaction-style messages.
const REACTION_PATTERNS = [
  /^\s*liked\s+["']/i,           // 'Liked "message text"'
  /^\s*loved\s+["']/i,           // 'Loved "message text"'
  /^\s*laughed at\s+["']/i,      // 'Laughed at "message text"'
  /^\s*emphasized\s+["']/i,      // 'Emphasized "message text"'
  /^\s*disliked\s+["']/i,        // 'Disliked "message text"'
  /^\s*questioned\s+["']/i,      // 'Questioned "message text"'
];

function isReaction(rawText) {
  const text = normalize(rawText);
  return REACTION_PATTERNS.some((re) => re.test(text));
}

function classifyInbound(rawText, history) {
  if (isReaction(rawText)) return { verdict: 'silence', category: 'reaction' };
  if (isOptOut(rawText)) return { verdict: 'silence-dnd', category: 'opt-out' };
  if (isNotOwner(rawText)) return { verdict: 'silence-dnd', category: 'wrong-number-or-not-owner' };
  if (isSoldNotForSale(rawText)) return { verdict: 'silence-dnd', category: 'sold-not-for-sale' };
  if (isListed(rawText)) return { verdict: 'silence-dnd', category: 'listed' };
  if (isDeceased(rawText)) return { verdict: 'silence-dnd', category: 'deceased' };
  if (isHostile(rawText)) return { verdict: 'silence-dnd', category: 'hostile' };
  if (isSpam(rawText)) return { verdict: 'silence-dnd', category: 'spam' };
  if (isRejection(rawText, history)) return { verdict: 'silence-dnd', category: 'rejection' };
  return { verdict: 'proceed' };
}

/**
 * True when the HighLevel contact is DND for SMS purposes: the global flag,
 * or the SMS channel itself. Deliberately NOT "any channel": the API can
 * carry stale per-channel states the UI never shows — e.g. WhatsApp/FB left
 * "active" by an earlier all-channel DND after the UI cleared only
 * Call/SMS/Email (seen live Oct 24, 2026: bot returned outcome "dnd" on a
 * contact whose UI showed every DND box OFF). Those stray channels must
 * never silence SMS replies. A contact DND'd by this bot or by the guard
 * workflow always has the global flag and/or SMS active, so real opt-outs
 * still block.
 */
function contactIsDnd(contact) {
  if (!contact) return false;
  if (contact.dnd === true) return true;
  const settings = contact.dndSettings || {};
  const sms = settings.SMS || settings.sms;
  return !!(sms && (sms.status === 'active' || sms.status === true));
}

/**
 * True when the contact's phone is FLAGGED landline. Sources, in order:
 *  1. a phone-type custom field (id from config, value contains "landline")
 *  2. contact.phoneType / contact.phone_type if the API ever returns one
 * Returns false when there is no landline evidence (unknown = not flagged;
 * the flag source is a wiring-time item — see WIRING.md).
 */
function contactIsLandline(contact, phoneTypeFieldId) {
  if (!contact) return false;
  const t = contact.phoneType || contact.phone_type;
  if (typeof t === 'string' && /landline/i.test(t)) return true;
  if (phoneTypeFieldId && Array.isArray(contact.customFields)) {
    const f = contact.customFields.find((cf) => cf.id === phoneTypeFieldId);
    if (f && /landline/i.test(String(f.value || ''))) return true;
  }
  return false;
}

/** Current hour (0-23) in the configured timezone, via Intl — no date libs. */
function hourInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  return hour % 24;
}

/** Hours gate: [hoursStart, hoursEnd) in the bot timezone. */
function withinHours(date, config) {
  const h = hourInTimezone(date, config.timezone);
  return h >= config.hoursStart && h < config.hoursEnd;
}

/* ── Booking-intent classification (Oct 24: decline / reschedule / quiet) ── */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Weekday name (long, ET) of an ISO start — matches the labels sellers see. */
function weekdayOf(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date(iso));
  } catch {
    return '';
  }
}

// The seller is declining the offered time(s). Deliberately NOT opt-out
// language: guards run first, so real opt-outs never reach this.
const DECLINE_PATTERNS = [
  /\b(can'?t|cannot|can not)\s+(make|do|attend|be there)\b/,
  /\b(won'?t|will not)\s+work\b/,
  /\b(doesn'?t|does not|don'?t)\s+work\b/,
  /\bnot\s+(available|free)\b/,
  /\b(reschedule|move it|change (it|the time|our call)|another (day|time)|different (day|time))\b/,
  /\bno longer\b/,
  /\bcan'?t make\b/,
];

/**
 * Detect that the seller just declined the offered slot(s).
 * Returns { declined, days }: days = weekday names to stop offering.
 * A named day wins ("can't make Monday"); otherwise the days of the slots
 * just offered are the declined ones (all-Monday offers → Monday).
 * Requires offered slots: with nothing offered, there is nothing to decline.
 */
function detectDecline(rawText, offeredSlots = []) {
  const text = normalize(rawText);
  if (!text || !DECLINE_PATTERNS.some((re) => re.test(text))) return { declined: false, days: [] };
  if (!offeredSlots.length) return { declined: false, days: [] };
  const mentioned = [];
  for (const m of text.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g)) {
    const day = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    if (!mentioned.includes(day)) mentioned.push(day);
  }
  if (mentioned.length) return { declined: true, days: mentioned };
  const offeredDays = [];
  for (const s of offeredSlots) {
    const day = weekdayOf(s.startISO || s);
    if (day && !offeredDays.includes(day)) offeredDays.push(day);
  }
  return { declined: true, days: offeredDays };
}

// Pure acknowledgments after a booking ("Great! 🙌", "Thanks!"). Normalized:
// emoji/punctuation stripped, so "Great! 🙌" reads as "great".
const ACK_SET = new Set([
  'great', 'thanks', 'thank you', 'thank you so much', 'thanks so much',
  'ok', 'okay', 'sounds good', 'sounds great', 'perfect', 'perfect thanks',
  'awesome', 'got it', 'understood', 'see you then', 'looking forward to it',
  'yes', 'yep', 'sure', 'cool', 'wonderful', 'nice', 'great thanks',
  'see you monday', 'see you then thanks', 'thank you see you then',
]);

/**
 * True for a low-content acknowledgment: nothing substantive, no question,
 * no new information. Anything longer or richer is NOT an ack — a seller
 * saying "I need to close fast" or asking anything must still get a reply.
 */
function isAcknowledgment(rawText) {
  const stripped = String(rawText || '')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped || stripped.length > 30) return false;
  return ACK_SET.has(stripped);
}

/* ── Quiet-rule scoping (Oct 24, 3:58 PM lesson) ─────────────────────────
 * "Sure" answering the bot's own call offer was silenced because a booking
 * happened to exist — the old rule silenced ANY ack whenever ANY booking
 * existed. An ack is only a post-booking acknowledgment when it answers
 * the booking CONFIRMATION itself. Offer/question language ("Want to set
 * up a quick call?", "What price are you thinking?") is never a
 * confirmation, so an ack after it is an answer and must get a reply.
 * No outbound history → fail OPEN (reply): silencing blind is worse than
 * one redundant reply. */
const BOOKING_CONFIRM_PHRASES = [
  /all set for/i,
  /you're (all )?set( for)?/i,
  /you are (all )?set( for)?/i,
  /booked (you|for|in)/i,
  /confirmed (you|for)/i,
  /got you (down )?for/i,
  /see you (on|then)/i,
  /talk (to you )?then/i,
  /looking forward to (seeing|talking)/i,
];

function lastOutboundWasBookingConfirmation(history = []) {
  const info = lastOutboundInfo(history);
  return !!(info && info.matched);
}

/** Compact shape of the thread tail for quiet diagnostics: newest-first,
 * up to 5 entries, as direction:bodyLength:matchesConfirmation — no body
 * text, so the log line stays privacy-safe. Oct 25: the ack run logged
 * lastOutboundConfirm=false with lastOutboundDir=outbound, which alone
 * cannot say whether the confirmation was skipped, bodiless, or simply
 * not the last outbound — the tail answers that in one look. */
function historyTailDebug(history = []) {
  const msgs = Array.isArray(history) ? history : [];
  return msgs
    .slice(-5)
    .reverse()
    .map((m) => {
      if (!m) return '?:0:0';
      const dir = m.direction === 'inbound' ? 'i' : 'o';
      const len = String(m.body || '').length;
      const matched = m.direction === 'inbound' ? 0 : (BOOKING_CONFIRM_PHRASES.some((re) => re.test(String(m.body || ''))) ? 1 : 0);
      return `${dir}:${len}:${matched}`;
    })
    .join('|');
}

function lastOutboundInfo(history = []) {
  const msgs = Array.isArray(history) ? history : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || !m.body) continue;
    if (m.direction === 'inbound') continue;
    return {
      direction: m.direction || 'unknown',
      matched: BOOKING_CONFIRM_PHRASES.some((re) => re.test(String(m.body))),
    };
  }
  return null;
}

// Price-ask patterns (Ginn #3, 3-strike escalation, Nov 5): the seller
// asking for OUR number — "what's your offer", "how much would you pay",
// "make me an offer", "give me a number". A seller NAMING their own price
// ("I want $200k", "my price is $150k", "I'd take $180k") is NOT a price
// ask and must never count: those are answered by acknowledging their
// number first (Oct 28 Diane lesson), not by escalating.
const PRICE_ASK_PATTERNS = [
  /\bwhat'?s (your|the|an?) ?(offer|price|number|figure)\b/,
  /\bwhat is (your|the|an?) ?(offer|price|number|figure)\b/,
  /\bwhat are you (offering|paying|giving)\b/,
  /\bwhat would you (pay|give|offer|do)\b/,
  /\bhow much (would|could|can|will|do|are) you\b/,
  /\bhow much (is it worth|can i get|would i get)\b/,
  /\bmake me (an |and |the )?offer\b/, // Nov 13: typo-hardened — "and" for "an", "the", or no article (Troy's live test texted "Make me and offer" and the exact-phrase pattern missed it)
  /\bjust (make|give) (me )?(an? )?(offer|number)\b/,
  /\b(give|send|tell) me (a|your|an|the) ?(offer|price|number|figure)\b/,
  /\bwhat'?s it worth\b/,
  /\byour (offer|price|number)\b/,
  /\bname (a|your) (price|number|figure)\b/,
  /\bwhat (price|number) (would|are|can) you\b/,
  /\bhow much (for (it|the (place|house))|will you)\b/,
  /\bwhat'?s (the )?(best|most) you (can|would|could) (do|pay|give|offer)\b/,
  /\bbest you can do\b/,
];

/** True when the text is the seller asking for our price/number. */
function isPriceAsk(text) {
  const t = normalize(text);
  return PRICE_ASK_PATTERNS.some((re) => re.test(t));
}

/**
 * Count how many times the seller has asked for our price/number across
 * the conversation history plus the current inbound. `history` is the HL
 * messages array ({ direction, body }, chronological); only inbound
 * messages count. The current inbound is counted too, unless it is already
 * the newest history entry (the webhook's message is sometimes already in
 * the list) — compared by normalized body so a genuine verbatim repeat
 * earlier in the conversation still counts separately.
 * Returns 0 when there is no price ask at all.
 */
function countPriceAsks(history, currentText) {
  let count = 0;
  const inbounds = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.direction === 'inbound');
  for (const m of inbounds) {
    if (isPriceAsk(m.body)) count += 1;
  }
  const current = normalize(currentText);
  const newest = inbounds.length ? normalize(inbounds[inbounds.length - 1].body) : '';
  if (current && isPriceAsk(current) && current !== newest) count += 1;
  return count;
}

/**
 * Inbound burst: the bodies of inbound messages that arrived since the
 * last outbound message (chronological), capped at 5. A seller who fires
 * two messages in a row ("5 million" then "That good for you?") is one
 * burst — the guard must see the whole burst, not just the message the
 * webhook happened to carry. Nov 6, 2026, Jessica Landis lesson: the
 * "5 million" run never sealed (its webhook run errored or was lost) and
 * the follow-up's run replied with a condition probe because it only
 * checked the follow-up text. Messages before the last outbound are
 * already handled — they must NOT re-trigger.
 */
function inboundBurst(history) {
  const msgs = Array.isArray(history) ? history : [];
  const burst = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.direction === 'outbound') break;
    if (m.direction === 'inbound') burst.unshift(String(m.body || '').trim());
    if (burst.length >= 5) break;
  }
  return burst.filter(Boolean);
}

/**
 * Earlier inbound bodies: every inbound message BEFORE the last outbound
 * (chronological). The current burst (inboundBurst) is what the seller is
 * saying NOW; these are what they said in turns the bot already answered.
 * With no outbound in the thread there are no earlier turns — everything
 * inbound is the current burst — so this returns [].
 * (Nov 11 late, 2026, Jada Aderiye lesson: "$470,000" in one turn and
 * "not a penny less" in the NEXT turn, with a bot reply between them.
 * Each burst alone passed the firm/absurd guards; the combination only
 * ever existed across turns, and nothing read across turns.)
 */
function earlierInboundBodies(history) {
  const msgs = Array.isArray(history) ? history : [];
  let lastOutboundIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].direction === 'outbound') {
      lastOutboundIdx = i;
      break;
    }
  }
  if (lastOutboundIdx < 0) return [];
  const bodies = [];
  for (let i = 0; i < lastOutboundIdx; i++) {
    const m = msgs[i];
    if (m && m.direction === 'inbound') {
      const body = String(m.body || '').trim();
      if (body) bodies.push(body);
    }
  }
  return bodies;
}

/**
 * Established firm/absurd seal (Nov 11 late, 2026, Troy: "after like one
 * respond and they still come back with some nonsense… just don't even
 * respond back. You know just DND.").
 *
 * Returns 'absurd-price' or 'firm-price' when the seller's position was
 * ALREADY established in earlier turns (before the last outbound):
 * - any earlier inbound is absurd on its own (same rule as the burst
 *   guard: > ABSURD_PRICE_MULTIPLE × MAO, or ≥ $500K / million-words), or
 * - the earlier inbounds TOGETHER satisfy the firm test — a money figure
 *   in any of them AND firm language in any of them (isFirmPriceBurst
 *   across turns, the Jada shape: price in one turn, "not a penny less"
 *   in another).
 * Returns null when nothing was established. The current burst is NOT
 * consulted here — steps 6.5/6.6 own first detection (one walkaway for
 * firm, silence for absurd); this helper exists so a seller who comes
 * BACK after that gets sealed instead of re-engaged.
 */
function establishedPriceSeal(history, mao) {
  const earlier = earlierInboundBodies(history);
  if (!earlier.length) return null;
  if (earlier.some((t) => isAbsurdPrice(t, mao))) return 'absurd-price';
  if (isFirmPriceBurst(earlier)) return 'firm-price';
  return null;
}

/* ── Photos instead of visits (Nov 11 late, 2026, Troy) ────────────────
 * Troy works virtual: when a seller invites a visit ("you can come by
 * and look at the house"), the money-saving move is the SELLER's own
 * photos — inside and outside — texted over. The same photos market the
 * deal later. There is deliberately NO pattern here for a seller who is
 * SETTING A TIME ("come by Saturday at 2"): that is appointment intent
 * and the booking paths govern it (see hasExplicitTimeMention). */

/** Visit-invitation phrasings. Tested against the lowercased text. */
const VISIT_INVITATION_PATTERNS = [
  /\bcome\s+(by|over)\b/,
  /\bcome\s+(and\s+)?(see|look|check)\b/,
  /\bcome\s+take\s+a\s+look\b/,
  /\bcome\s+out\s+(and\s+)?(see|look|check)\b/,
  /\b(stop|swing|pop|drop)\s+by\b/,
  /\bsee\s+it\s+in\s+person\b/,
  /\blook\s+at\s+it\s+in\s+person\b/,
  /\byou'?re\s+welcome\s+to\s+(come|stop|look|see)\b/,
  /\bfeel\s+free\s+to\s+(come|stop)\b/,
];

/** True when the text invites the buyer to come see the property. */
function isVisitInvitation(rawText) {
  const text = String(rawText || '').toLowerCase();
  return VISIT_INVITATION_PATTERNS.some((re) => re.test(text));
}

/**
 * True when the text names a clock time ("at 2", "2pm", "2:30 PM",
 * "noon"). A visit invitation carrying a time is the seller setting an
 * appointment, not floating an open invite — booking rules govern it,
 * never the photo ask.
 */
function hasExplicitTimeMention(rawText) {
  const text = String(rawText || '').toLowerCase();
  return (
    /\b\d{1,2}(:\d{2})?\s*([ap])\.?m\.?\b/.test(text) ||
    /\bat\s+\d{1,2}\b/.test(text) ||
    /\b(noon|midnight)\b/.test(text)
  );
}

/** True when the bot's most recent outbound asked for pictures/photos. */
function lastOutboundAskedForPhotos(history) {
  const msgs = Array.isArray(history) ? history : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.direction === 'outbound') {
      return /\b(pictures?|photos?|pics)\b/i.test(String(m.body || ''));
    }
  }
  return false;
}

/** Seller agreeing to send pictures ("Ok I'll send them", "sending now"). */
const PHOTO_SEND_PATTERNS = [
  /\bi'?ll\s+(send|text)\s+(them|those|the\s+(pictures|pics|photos)|pictures|pics|photos)\b/,
  /\bi\s+will\s+(send|text)\b/,
  /\b(sending|texting)\s+(them|the\s+(pictures|pics|photos)|pictures|pics|photos|now)\b/,
  /\b(ok|okay|sure|yeah|yes)\b[^.]{0,20}\bi'?ll\s+(send|text)\b/,
  /\bsent\s+(them|the\s+(pictures|pics|photos)|pictures|pics|photos)\b/,
  /\bhere\s+(are|they\s+are)\s+(the\s+)?(pictures|pics|photos)\b/,
];

function isPhotoSendReply(rawText) {
  const text = String(rawText || '').toLowerCase();
  return PHOTO_SEND_PATTERNS.some((re) => re.test(text));
}

/* ── Owner referral (Nov 14, 2026, Troy — Douglas Pope, KC) ──────────
 * The texter hands us the REAL decision-maker: "Call my ex douglas
 * Pope. He loves to wheel and deal and owns all of our properties
 * right now. 816-616-7825" — and the bot ignored it and repeated its
 * booking-times offer word for word (6:17 PM offer re-sent 6:31 PM).
 * The texter is Douglas's ex-wife (Oct 28 thread: divorcing co-owner,
 * NOT a tenant, NOT the owner to book). A phone number for another
 * person + referral/ownership language means: stop pitching THIS
 * texter entirely — no times, no qualification — capture the number,
 * acknowledge it once, and hand the thread to Troy.
 *
 * Narrow by construction, both halves required:
 *  - a real 10-digit phone number in the message, AND
 *  - referral intent: a call/talk verb aimed at a third person, an
 *    ownership claim for that person ("he owns all of our
 *    properties"), or possessive number language ("his number is",
 *    "my husband's number is").
 * A seller giving their OWN callback ("call me at …", "my number
 * is …") never matches: no third-person pattern fits, and the handler
 * additionally rejects a number equal to the contact's own phone.
 * A bare number with no referral language never matches either. */
const REFERRAL_INTENT_PATTERNS = [
  /\bcall my\b/,
  /\b(call|text|contact|talk to|speak (to|with)|reach out to|hit up|ask|try)\b[^.!?]{0,40}\b(ex|husband|wife|brother|sister|son|daughter|mother|father|mom|dad|landlord|owner|partner)\b/,
  /\b(he|she|they) (owns|own|is the owner|makes the decisions|handles (it|that|everything)|does the dealing)\b/,
  /\bowns (all|both|the|our|my)\b/,
  /\b(his|her|their) (number|phone|cell)\b/,
  /\bthat'?s (his|her|their) number\b/,
  /\b(ex|husband|wife|brother|sister|son|daughter|mother|father|mom|dad|landlord|owner|partner)('s|s)? (number|phone|cell)\b/,
  /\bgive (him|her|them) a call\b/,
  /\btalk to (him|her|them)\b/,
  /\byou (need|should|want) to (talk|speak|call|contact) (him|her|them|my)\b/,
];

/** Every 10-digit US phone number in the text, as bare digit strings. */
function extractPhoneNumbers(rawText) {
  const out = [];
  const matches = String(rawText || '').match(/(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g) || [];
  for (const m of matches) {
    let d = m.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    if (d.length === 10 && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * Detect an owner referral: { phone, name } or null.
 * `phone` is the first 10-digit number in the message; `name` is the
 * referred person's first name when the message names them after the
 * referral verb ("call my ex douglas Pope" → "Douglas"), else null.
 */
function detectOwnerReferral(rawText) {
  const phones = extractPhoneNumbers(rawText);
  if (!phones.length) return null;
  const text = normalize(rawText);
  if (!REFERRAL_INTENT_PATTERNS.some((re) => re.test(text))) return null;
  let name = null;
  const raw = String(rawText || '');
  const exMatch = raw.match(/\bex(?:\s+(?:husband|wife))?\s+([A-Za-z]+)\s+([A-Z][a-z]+)/i);
  const verbMatch = raw.match(/\b(?:call|text|contact|talk to|speak to|reach out to|hit up)\s+(?:my\s+(?:ex\s+)?)?([A-Z][a-z]+)\s+([A-Z][a-z]+)/);
  const m = exMatch || verbMatch;
  if (m) name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return { phone: phones[0], name };
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ABBR = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april', jun: 'june',
  jul: 'july', aug: 'august', sep: 'september', sept: 'september',
  oct: 'october', nov: 'november', dec: 'december',
};

function monthOfToken(tok) {
  const t = String(tok || '').toLowerCase().replace(/\.$/, '');
  if (MONTH_NAMES.includes(t)) return t;
  return MONTH_ABBR[t] || null;
}

/**
 * stripForeignMonth(text, slots) — Nov 14, 2026 (Paula test): the model
 * three times turned a seller's MOVE month into the booking month —
 * Paula: "trying to move in february" / "I need to be out by february" →
 * bot: "Monday at 8:00 AM ... in February". The prompt rule alone did
 * not stop it (the model echoed its own earlier reply out of the thread
 * history), so the check lives in code: in any sentence that offers
 * clock times, an "in <Month>" whose month is not one of the loaded
 * slots' real months is deleted. Slot months come from the slot labels
 * AND their startISO dates, so a legitimate offer for a loaded month is
 * never touched, and a timeline acknowledgment carrying no clock times
 * is never touched either.
 */
function stripForeignMonth(text, slots) {
  if (!text || typeof text !== 'string') return text;
  const allowed = new Set();
  for (const s of slots || []) {
    if (!s) continue;
    for (const tok of String(s.label || '').split(/[^A-Za-z]+/)) {
      const m = monthOfToken(tok);
      if (m) allowed.add(m);
    }
    const iso = Date.parse(s.startISO || '');
    if (!Number.isNaN(iso)) allowed.add(MONTH_NAMES[new Date(iso).getUTCMonth()]);
  }
  return text.replace(/[^.!?]+[.!?]?/g, (sentence) => {
    if (!/\d{1,2}:\d{2}|\d{1,2}\s*(?:AM|PM)\b/i.test(sentence)) return sentence;
    return sentence.replace(/\s+in\s+([A-Za-z]+)\.?/g, (match, tok) => {
      const m = monthOfToken(tok);
      return m && !allowed.has(m) ? '' : match;
    });
  });
}

module.exports = {
  classifyInbound,
  isOptOut,
  isNotOwner,
  isSoldNotForSale,
  isListed,
  isDeceased,
  isHostile,
  isSpam,
  isRejection,
  isBareNo,
  lastOutboundAskedYesNoQuestion,
  isReaction,
  isAbsurdPrice,
  ABSURD_PRICE_MULTIPLE,
  ABSURD_PRICE_ABSOLUTE,
  isFirmPrice,
  isFirmPriceBurst,
  contactIsDnd,
  contactIsLandline,
  withinHours,
  hourInTimezone,
  normalize,
  detectDecline,
  isAcknowledgment,
  lastOutboundWasBookingConfirmation,
  lastOutboundInfo,
  historyTailDebug,
  weekdayOf,
  isPriceAsk,
  countPriceAsks,
  inboundBurst,
  earlierInboundBodies,
  establishedPriceSeal,
  isVisitInvitation,
  hasExplicitTimeMention,
  lastOutboundAskedForPhotos,
  isPhotoSendReply,
  isClearWrongPerson,
  isBareWrongNumber,
  threadShowsNegotiation,
  extractPhoneNumbers,
  detectOwnerReferral,
  stripForeignMonth,
};

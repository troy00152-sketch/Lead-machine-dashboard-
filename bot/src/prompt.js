/**
 * prompt.js — assembles the system prompt and parses the model's output.
 *
 * Layers:
 *   1. knowledge/prompt.md  — the persona/playbook prompt (seeded stand-in;
 *      Troy's verbatim Ashley prompt gets pasted in at wiring time).
 *   2. knowledge/kb.json    — the 31 approved FAQs, verbatim.
 *   3. Per-contact context  — name, address, ballpark (MAO/LAO) or its absence,
 *      live calendar slots.
 *   4. OUTPUT CONTRACT      — owned by the code, always last: the model must
 *      answer with JSON so booking is deterministic.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let cache = {}; // persona ('ashley' | 'amber') -> { promptBody, kb }

function swapPersonaName(text, persona) {
  // Single source of truth: prompt.md + kb.json stay Ashley verbatim
  // (NEVER EDIT the verbatim prompt). The Amber persona swaps the name in
  // self-introductions at load time so the two personas can never drift
  // apart — every "Ashley" in the live prompt text is a self-introduction.
  if (persona !== 'amber') return text;
  return String(text).replace(/\bAshley\b/g, 'Amber');
}

function knowledgeDir() {
  const candidates = [
    path.resolve(__dirname, '..', 'knowledge'),
    path.resolve(process.cwd(), 'knowledge'),
    process.env.LAMBDA_TASK_ROOT
      ? path.resolve(process.env.LAMBDA_TASK_ROOT, 'knowledge')
      : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'kb.json'))) return dir;
  }
  return candidates[0];
}

/** Load prompt.md + kb.json (cached per persona). Tests may inject via loadKnowledge.cache. */
function loadKnowledge(persona = 'ashley') {
  const key = persona === 'amber' ? 'amber' : 'ashley';
  if (cache[key]) return cache[key];
  const dir = knowledgeDir();
  const promptMd = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
  const kb = JSON.parse(fs.readFileSync(path.join(dir, 'kb.json'), 'utf8'));
  // Strip the HTML comment header (build notes) from the prompt body.
  const body = promptMd.replace(/<!--[\s\S]*?-->/g, '').trim();
  const swappedKb = {
    ...kb,
    faqs: (kb.faqs || []).map((f) => ({
      ...f,
      question: swapPersonaName(f.question || '', key),
      answer: swapPersonaName(f.answer || '', key),
    })),
    // Vetted objection lines (Nov 5, Ginn #3): same name swap on
    // trigger/reply so a line naming "Ashley" reads "Amber" under amber.
    objections: (kb.objections || []).map((o) => ({
      ...o,
      trigger: swapPersonaName(o.trigger || '', key),
      reply: swapPersonaName(o.reply || '', key),
    })),
  };
  cache[key] = { promptBody: swapPersonaName(body, key), kb: swappedKb };
  return cache[key];
}
loadKnowledge.cache = (value) => {
  cache = value ? { ashley: value, amber: value } : {};
};

function money(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function buildSystemPrompt({ contact, ballpark, slots, extraNote, tzName, persona }) {
  // Oct 29, 2026, Troy: the seller's market timezone — 'Central' ONLY for
  // Kansas City, 'Eastern' for the other four markets. Slot labels are
  // already rendered in this timezone by the caller.
  const tz = tzName === 'Central' ? 'Central' : 'Eastern';
  const { promptBody, kb } = loadKnowledge(persona);

  const kbText = kb.faqs
    .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
    .join('\n\n');

  const firstName = (contact && (contact.firstName || contact.name)) || '';
  const address =
    (contact &&
      [contact.address1, contact.city, contact.state]
        .filter(Boolean)
        .join(', ')) ||
    '';

  const contextLines = [
    '— CONTEXT FOR THIS CONVERSATION —',
    firstName ? `Seller first name: ${String(firstName).split(' ')[0]}` : 'Seller first name: unknown',
    address ? `Place: ${address}` : 'Place: unknown',
    `Seller's local timezone: ${tz} Time — all times below are already in ${tz} Time.`,
  ];
  if (ballpark) {
    contextLines.push(
      `Ballpark on file: between ${money(ballpark.lao)} and ${money(ballpark.mao)}. ` +
        'You may share this RANGE only per the ballpark rules — never a single figure, never outside this range.'
    );
  } else {
    contextLines.push(
      'Ballpark on file: NONE. You must not state any dollar figure in any message.'
    );
  }
  if (slots && slots.length) {
    contextLines.push(
      `Open times on the team calendar (${tz}) — offer these SPECIFIC times when booking comes up:\n` +
        slots.map((s, i) => `  ${i + 1}. ${s.label} [slot_start: ${s.startISO}]`).join('\n')
    );
  } else {
    // Nov 9, 2026 (Troy): no times loaded is NEVER a reason to promise a
    // callback — the old "the team will reach out shortly" line is a
    // deferral that loses the seller. Do NOT invent times either. Ask the
    // handoff question (permission, not a promise) and nothing more.
    contextLines.push(
      'Open times: none loaded right now — do NOT invent times and do NOT promise a callback. Say: "I\'m not sure on the exact times right now — want me to have my partner call you?" and nothing more.'
    );
  }
  if (extraNote) contextLines.push(extraNote);

  const contract = [
    '— OUTPUT CONTRACT (follow exactly) —',
    'Respond with ONLY a JSON object, no other text:',
    '{"action":"reply","text":"<the SMS to send>"}',
    'or, when the seller has clearly picked one of the offered open times:',
    '{"action":"book","slot_start":"<the exact slot_start value from the list>","text":"<short confirmation SMS>"}',
    'or, when the seller clearly cancels their existing booking AND shows no interest in another time:',
    '{"action":"cancel","text":"<short acknowledgement — the booking is NEVER cancelled by you>"}',
    'If the seller asks to cancel a booking, the acknowledgement is: "Got it — Troy will take care of that." You NEVER cancel bookings yourself — Troy handles all cancellations, and you never confirm a cancellation as done.',
    'Rules for "text": one short SMS — at most TWO short sentences, ~160 characters, no lists, no emojis, no formalities; at most ONE question mark; follow the spam-safe language rules; never include a dollar figure that is not in the ballpark range given above. If you do not know the answer, say so once and hand off — "I\'m not sure on that — want me to have my partner call you?" — never guess or invent. Never claim to be human; if asked, identify as the acquisitions team\'s texting assistant.',
    'Nov 2, 2026 (Troy): when offering a call or booking, say "my partner" — NEVER say the name "Troy" upfront. ONLY say the name "Troy" if the seller explicitly asks who is calling, who they would speak with, or who you work for (e.g. "who is this?", "who would I talk to?", "what\'s his name?"). This overrides any knowledge-base line that names Troy in a booking offer.',
    'If the seller names a price or dollar figure, acknowledge that figure in your reply BEFORE asking any other question — never ignore a named price and jump to generic qualification (Oct 28 Diane lesson).',
    'Never ask the same qualification question twice in a row. If the seller sidesteps your question and talks about something else (repairs, condition, owners), engage with what they actually said first — do not re-ask your question with different words (Oct 28 Douglas Pope lesson).',
    'If the seller asks what you want, why you are texting, or what this is about ("what would you like to know", "why are you texting me", "what is this about"), answer plainly FIRST — you buy houses and are checking whether they would consider an offer for the property — BEFORE any motivation probing. Never assume they want to sell (Oct 29 Justin Smith lesson).',
    'If the texter mentions another person as an owner or decision-maker, or speaks about the contact in the third person, first confirm who you are speaking with — do NOT assume they are a co-owner (Oct 28 Douglas Pope lesson).',
    'If the texter gives you another person\'s phone number and says to call/talk to that person, or says that person owns the property — thank them, say you will pass the number along to your partner, and STOP: never offer call times to the texter, never re-ask a question you already asked, and never repeat an earlier offer (Nov 14 Douglas Pope lesson: his ex-wife gave his number, 816-616-7825, and the bot repeated its times offer word for word).',
    'If the seller asks where you are located, where you are based, or if you are local ("where are you located", "are you local", "where are y\'all based"), answer it straight, never dodge it: you are with Direct Property Buyers, your partner is local in the seller\'s city (from the Place above), and they can find you at directpropertybuyersllc.com. Never give a street address. Answer first, then steer back in the same text (Nov 14 Paula test lesson: asked "Where are you located", the bot dodged with a vague "team that takes on places around Indianapolis" line and no website — Troy: that answer is wrong, give them the website).',
    'If the seller names a date or month for their MOVE or their timeline ("moving in February", "trying to move in February", "need to be out by March"), that is their timeline, not a booking date: acknowledge it as their timeline, and NEVER offer call times dated to that month or restate the open times above as if they fell in that month. If you offer times, offer the open times above exactly as written (Nov 14 Paula test lesson: Paula said "Just cosmetics trying to move in february" and the bot offered "Monday at 8:00 AM... in February" as if the quick call itself was in February).',
    'If they clearly say they rent or are a tenant (says "I rent", "I\'m renting", "just a tenant", "my landlord") AND have not claimed ownership, do NOT qualify them as a seller. Ask for the property owner\'s phone number instead, and nothing else — a tenant provides the landlord\'s number, not a deal. A mere mention of the word "landlord" about someone else, or an ownership claim ("my name is also on that property"), does NOT make them a tenant (Oct 28 Douglas Pope lesson).',
    'NEVER promise to reach out, check back, keep an eye out, or follow up later — you cannot follow up. Offer times from the list instead.',
    'The open times above are already in the seller\'s local timezone — offer and confirm them exactly as written (Oct 29, 2026, Troy: Central times ONLY for Kansas City sellers, Eastern for everyone else).',
    'Never add a timezone conversion or "your time" parenthetical — no "that\'s X your time", no restating a time in another timezone. This overrides the knowledge-base line about stating two timezones.',
    'Kansas City offered times end in the word "Central" (e.g. "Friday, October 30 at 8:00 AM Central") — keep that word every time you offer or confirm a time, never drop it and never convert it (Oct 29 Ivory Mims lesson: a bare "8:00 AM" was read as 8 Central while the calendar held 8 Eastern).',
    'If the correct behavior is to say nothing (opt-out, hostile, spam, wrong number, not an owner), respond with {"action":"silent"} and no text.',
    'Never use {"action":"silent"} outside those cases. If the seller jokes, goes off-topic, or talks about something other than the property ("you can sell my truck"), acknowledge it briefly with good humor and steer back to the property in the same text — never go silent on a live person who is still talking to you (Oct 29 Hayden Carraway lesson: the model went silent on a joke, the watchdog fired a "Troy will follow up" holding reply, and the seller was left confused).',
  ].join('\n');

  return [promptBody, '— KNOWLEDGE BASE (approved answers) —', kbText, contextLines.join('\n'), contract].join('\n\n');
}

/**
 * Parse the model's raw output into { action, text, slotStart }.
 * Non-JSON output is treated as a plain reply text (defensive fallback);
 * a JSON {"action":"silent"} (or empty text) means silence.
 */
function parseModelOutput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { action: 'silent' };
  try {
    const jsonText = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const obj = JSON.parse(jsonText);
    if (obj && obj.action === 'silent') return { action: 'silent' };
    if (obj && obj.action === 'book' && obj.slot_start) {
      return { action: 'book', slotStart: obj.slot_start, text: String(obj.text || '').trim() };
    }
    if (obj && obj.action === 'cancel') {
      return { action: 'cancel', text: String(obj.text || '').trim() };
    }
    if (obj && typeof obj.text === 'string') {
      return { action: 'reply', text: obj.text.trim() };
    }
  } catch {
    /* fall through to plain-text treatment */
  }
  return { action: 'reply', text: trimmed };
}

module.exports = { buildSystemPrompt, parseModelOutput, loadKnowledge, money };

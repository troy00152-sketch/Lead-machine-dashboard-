/**
 * objections.js — vetted objection-line matcher (Ginn improvement #3, Nov 5).
 *
 * The objection lines live in knowledge/kb.json under "objections" (77 lines
 * vetted from the 104 raw Ginn lines; see
 * ~/workspace/playbook-system/objection-vetting-2026-11-05.md for the
 * keep/drop record). Each entry: { id, cat, trigger, keywords[], reply,
 * strike? }. The matcher is pure: it picks the best keyword match for an
 * inbound text, or null. The reply is offered to the model as approved
 * wording in the handler's extraNote — it is never sent verbatim, so the
 * model still renders it in spam-safe language and the wordfilter backstop
 * still applies to the final outbound text.
 *
 * Matching rules:
 *  - Case-insensitive substring match on normalized text (lowercase,
 *    punctuation stripped except "$", which matters for "i need $").
 *  - Highest keyword-hit count wins; ties go to the first entry in file
 *    order (the file is ordered by category, most specific first).
 *  - A line with a `strike` field only matches when the current price-ask
 *    strike count equals it (L022, the car test-drive close, is strike-2
 *    only — it must never fire on a first price ask).
 */
'use strict';

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9$ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchObjection(text, objections, strike) {
  const list = Array.isArray(objections) ? objections : [];
  if (!list.length) return null;
  const norm = normalize(text);
  if (!norm) return null;
  const currentStrike = typeof strike === 'number' ? strike : 0;
  let best = null;
  let bestScore = 0;
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.keywords) || !entry.keywords.length) continue;
    // Strike-gated lines (e.g. L022) only fire on their strike.
    if (typeof entry.strike === 'number' && entry.strike !== currentStrike) continue;
    let score = 0;
    for (const kw of entry.keywords) {
      if (kw && norm.includes(normalize(kw))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

module.exports = { matchObjection, normalize };

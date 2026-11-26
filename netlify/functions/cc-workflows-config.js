// netlify/functions/cc-workflows-config.js
// Data module: the five market SMS workflows, encoded EXACTLY as captured
// from HighLevel on 2026-11-16 (see ~/workspace/standalone-build/
// hl-workflow-steps.md). This is the mirror source for the Phase 3
// workflow engine — change HL first, then change this to match.
//
// Shared structure (identical across all five markets):
//   Trigger: market tag added
//   -> Create Opportunity (Pipeline: Lead, Stage: New Lead, value 0,
//      status Open, source = per-market opportunitySource)
//   -> Drip Mode: 300 per day (batch 300, interval 1 day)
//   -> Wait: advance window, resume Mon–Sat 11:00 AM–5:00 PM
//      America/New_York (account timezone in HL)
//   -> Drip Mode: batch 1, interval 1 minute
//   -> If/Else "Is Active lead?": proceeds only if the contact carries at
//      least one of activeLeadTags, else END. (Quirk preserved from HL:
//      'bad-number' is itself one of the gate tags — a bad-number-only
//      contact passes this gate and is then stopped by the per-path
//      bad-number guard below, exactly as in HL.)
//   -> Remove Assigned User -> Assign round-robin (5 users, equally)
//   -> Random Split A–E, 20% each
//   -> Per-path guard: if contact has 'bad-number' tag -> END (no send)
//   -> ONE first-text SMS (per-path body below) -> END
//
// First-text bodies are verbatim from HL with placeholders normalized to
// {{first_name}} / {{address1}} / {{city}}.
//
// FLORIDA: HL's own controls disagree (Wait resumes Mon–Fri, Settings
// window is Tue–Sat). Per the build plan we do NOT replicate that —
// Florida uses Mon–Sat 11:00–17:00 in both controls, Troy's standing
// Mon–Sat rule.
'use strict';

const WAIT_WINDOW = {
  timezone: 'America/New_York',
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], // Sun off
  start: '11:00',
  end: '17:00',
};

const ACTIVE_LEAD_TAGS = ['lead - cold call', 'lead - ppl', 'lead - sms', 'bad-number'];

function market(cfg) {
  return Object.assign(
    {
      pipeline: 'Lead',
      stage: 'New Lead',
      opportunityValue: 0,
      opportunityStatus: 'Open',
      dripPerDay: 300,
      dripBatch: { size: 300, intervalDays: 1 },
      sendDrip: { batchSize: 1, intervalMinutes: 1 },
      window: WAIT_WINDOW,
      settingsWindow: WAIT_WINDOW, // Settings-tab time window (same Mon–Sat 11–5)
      activeLeadTags: ACTIVE_LEAD_TAGS.slice(),
      activeLeadGate:
        'Proceed only if contact has at least one of activeLeadTags; otherwise END.',
      badNumberGuard: {
        tag: 'bad-number',
        appliesToPaths: ['A', 'B', 'C', 'D', 'E'],
        action: 'end', // guard sits before EVERY path's SMS send
      },
      split: { type: 'random', paths: { A: 20, B: 20, C: 20, D: 20, E: 20 } },
      allowReentry: true,
      allowMultipleOpportunities: false,
      stopOnResponse: false,
      markAsRead: true,
    },
    cfg
  );
}

const PATH_C =
  "{{first_name}}, quick question — is {{address1}} still yours? I may have a way to take it off your hands with no hassle.";
const PATH_E =
  "{{first_name}}, {{address1}} came across my desk — it fits what we're working on in your area. Open to a quick chat about it?";

const WORKFLOWS = {
  indianapolis: market({
    id: 'indianapolis',
    name: 'Indianapolis sms',
    tag: 'indianapolis sms',
    opportunitySource: 'Indianapolis SMS',
    hlWorkflowId: '815cb6dc-fca0-4aa4-b36a-a27297b80b59',
    hlFromNumber: '+14632783964', // HL LC number — reference only, Telnyx pool replaces it
    telnyxMarket: 'indianapolis',
    firstTexts: {
      A: "Hi {{first_name}}, Alex with Direct Property Buyers. I came across {{address1}} and wanted to see if you'd be open to a quick chat about it.",
      B: "Hey {{first_name}}, Jordan here. Not sure if you're thinking about moving on from {{address1}}, but I'd like to talk numbers if you are.",
      C: PATH_C,
      D: "Hi {{first_name}}, Morgan here — I help folks in {{city}} sell as-is with no fix-up needed. Worth a 2-min call?",
      E: PATH_E,
    },
  }),

  carolina: market({
    id: 'carolina',
    name: 'Carolina sms',
    tag: 'carolina sms',
    opportunitySource: 'carolina sms',
    hlWorkflowId: 'a8605341-a779-4c16-bba2-a656c0f82691',
    hlFromNumber: '+19803721662',
    telnyxMarket: 'carolina',
    firstTexts: {
      A: "Hi {{first_name}}, Riley with Direct Property Buyers. I came across {{address1}} and wanted to see if you'd be open to a quick chat about it.",
      B: "Hey {{first_name}}, Avery here. Not sure if you're thinking about moving on from {{address1}}, but I'd like to talk numbers if you are.",
      C: PATH_C,
      D: "Hi {{first_name}}, Casey here — I help folks in {{city}} sell as-is with no fix-up needed. Worth a 2-min call?",
      E: PATH_E,
    },
  }),

  kansascity: market({
    id: 'kansascity',
    name: 'Kansas City sms',
    tag: 'kansas city sms',
    opportunitySource: 'kansas city sms',
    hlWorkflowId: '73594bc6-9c95-4f83-b3ba-b701d2b84d60',
    hlFromNumber: '+18167205099',
    telnyxMarket: 'kansascity',
    firstTexts: {
      A: "Hi {{first_name}}, Casey with Direct Property Buyers. I came across {{address1}} and wanted to see if you'd be open to a quick chat about it.",
      B: "Hey {{first_name}}, Morgan here. Not sure if you're thinking about moving on from {{address1}}, but I'd like to talk numbers if you are.",
      C: PATH_C,
      D: "Hi {{first_name}}, Jordan here — I help folks in {{city}} sell as-is with no fix-up needed. Worth a 2-min call?",
      E: PATH_E,
    },
  }),

  cleveland: market({
    id: 'cleveland',
    name: 'Cleveland sms',
    tag: 'oh sms', // HL trigger tag really is "oh sms", not "cleveland sms"
    opportunitySource: 'oh sms',
    hlWorkflowId: '1df10762-aea3-41a2-a9cc-ffeade5a3b8c',
    hlFromNumber: '+12165288706',
    telnyxMarket: 'cleveland',
    firstTexts: {
      A: "Hi {{first_name}}, Jordan with Direct Property Buyers. I came across {{address1}} and wanted to see if you'd be open to a quick chat about it.",
      B: "Hey {{first_name}}, Casey here. Not sure if you're thinking about moving on from {{address1}}, but I'd like to talk numbers if you are.",
      C: PATH_C,
      D: "Hi {{first_name}}, Parker here — I help folks in {{city}} sell as-is with no fix-up needed. Worth a 2-min call?",
      E: PATH_E,
    },
  }),

  florida: market({
    id: 'florida',
    name: 'FLORIDA SMS',
    tag: 'florida sms',
    opportunitySource: 'florida sms',
    hlWorkflowId: 'f9789909-4ac3-4f37-8d11-655e8ef50cf3',
    hlFromNumber: '+19043952638',
    telnyxMarket: 'florida',
    // NOTE: window/settingsWindow stay Mon–Sat (shared WAIT_WINDOW) on
    // purpose — HL Florida's Mon–Fri Wait vs Tue–Sat Settings mismatch is
    // an HL inconsistency, not a rule. See header comment.
    firstTexts: {
      A: "Hi {{first_name}}, Avery with Direct Property Buyers. I came across {{address1}} and wanted to see if you'd be open to a quick chat about it.",
      B: "Hey {{first_name}}, Taylor here. Not sure if you're thinking about moving on from {{address1}}, but I'd like to talk numbers if you are.",
      C: PATH_C,
      D: "Hi {{first_name}}, Riley here — I help folks in {{city}} sell as-is with no fix-up needed. Worth a 2-min call?",
      E: PATH_E,
    },
  }),
};

function getWorkflow(id) {
  return WORKFLOWS[id] || null;
}
function workflowByTag(tag) {
  const t = String(tag || '').trim().toLowerCase();
  for (const w of Object.values(WORKFLOWS)) {
    if (w.tag.toLowerCase() === t) return w;
  }
  return null;
}
// Fill {{first_name}} / {{address1}} / {{city}} from a contact-ish object
// ({firstName|first_name, address1, city}). Missing values become ''.
function renderFirstText(workflowId, path, contact) {
  const w = getWorkflow(workflowId);
  if (!w) throw new Error('Unknown workflow: ' + workflowId);
  const tpl = w.firstTexts[String(path || '').toUpperCase()];
  if (!tpl) throw new Error('Unknown path ' + path + ' for workflow ' + workflowId);
  const c = contact || {};
  const vals = {
    first_name: c.first_name || c.firstName || '',
    address1: c.address1 || c.address || '',
    city: c.city || '',
  };
  const body = tpl.replace(/\{\{(first_name|address1|city)\}\}/g, (m, k) => String(vals[k] || ''));
  // A2P opt-out line on EVERY first text (Troy, Nov 25: "put reply out").
  // OUT is a recognized opt-out keyword in cc-bot-hook (seals the enrollment).
  return /opt out/i.test(body) ? body : body + ' Reply OUT to opt out.';
}

// `market` is exported for cc-workflows-store.js: the workflow builder
// builds NEW workflow definitions from the same shared structure.
module.exports = { WORKFLOWS, WAIT_WINDOW, ACTIVE_LEAD_TAGS, getWorkflow, workflowByTag, renderFirstText, market };

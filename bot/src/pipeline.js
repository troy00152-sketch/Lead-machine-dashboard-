/**
 * pipeline.js — pipeline auto-move (Oct 30, 2026, Troy: deals move
 * themselves, no hand-dragging).
 *
 * Phase 1: when the bot books a seller call, the deal drops itself into
 * the "Lead" pipeline at the "Appointment Set" stage — nobody drags a
 * card by hand.
 *
 * Hard rules:
 *  - The booking ALWAYS wins. ensureLeadOpportunity THROWS on any
 *    opportunity failure; the caller (handler.js) catches, logs, and
 *    never lets it break the booking or the seller's confirmation text.
 *  - Test contacts (Troy Final Test) are skipped silently — no
 *    opportunities, no API calls at all.
 *  - Dedupe: an existing OPEN opportunity for the contact in the Lead
 *    pipeline is MOVED to Appointment Set, never duplicated. Open
 *    opportunities in other pipelines, and won/lost ones, are ignored.
 *  - Pipeline/stage IDs resolve from env first (HL_LEAD_PIPELINE_ID /
 *    HL_LEAD_APPOINTMENT_STAGE_ID); otherwise they are looked up live
 *    from the location's pipelines once and cached in-memory.
 */
'use strict';

const { normalizePhoneDigits } = require('./hl');

// Troy's own test contact — bookings from these never create opportunities.
const TEST_CONTACT_IDS = new Set(['2ZK4yRDjdrP5nDxOgRGO']);
const TEST_CONTACT_PHONES = new Set(['2035657810']); // Troy's own cell

function isTestContact(contact) {
  if (!contact) return false;
  const name = String(contact.name || contact.firstName || '').toLowerCase();
  if (name.includes('troy final test')) return true;
  if (TEST_CONTACT_IDS.has(String(contact.id || ''))) return true;
  const digits = normalizePhoneDigits(contact.phone);
  if (digits && TEST_CONTACT_PHONES.has(digits)) return true;
  return false;
}

// In-memory cache: locationId -> { pipelineId, stageId }. Netlify
// functions are short-lived, so this mostly saves repeat lookups inside
// warm invocations; the env fast-path below skips the lookup entirely.
const pipelineCache = new Map();

function clearPipelineCache() {
  pipelineCache.clear();
}

/**
 * Resolve the Lead pipeline ID and its Appointment Set stage ID.
 * Env override wins (no API call); otherwise one live lookup per
 * location, cached. Throws when the pipeline or stage cannot be found —
 * the caller treats that as "no pipeline move", never as a booking
 * failure.
 */
async function resolveLeadPipeline(hl, config) {
  const envPipe = config.leadPipelineId;
  const envStage = config.leadAppointmentStageId;
  if (envPipe && envStage) {
    return { pipelineId: envPipe, stageId: envStage, source: 'env' };
  }
  const loc = config.hlLocationId;
  const cached = pipelineCache.get(loc);
  if (cached) return { pipelineId: cached.pipelineId, stageId: cached.stageId, source: 'cache' };

  const data = await hl.getPipelines(loc);
  const pipes = (data && data.pipelines) || [];
  const pipe = pipes.find((p) => String(p.name || '').toLowerCase() === 'lead');
  if (!pipe) {
    throw new Error('Lead pipeline not found among location pipelines');
  }
  const stages = pipe.stages || [];
  const stage = stages.find((s) => String(s.name || '').toLowerCase() === 'appointment set');
  if (!stage) {
    throw new Error('Appointment Set stage not found in the Lead pipeline');
  }
  const resolved = { pipelineId: pipe.id, stageId: stage.id };
  pipelineCache.set(loc, resolved);
  return { pipelineId: resolved.pipelineId, stageId: resolved.stageId, source: 'lookup' };
}

function opportunityTitle(contact, slotLabel) {
  const who =
    (contact && (contact.firstName || contact.name)) ||
    (contact && contact.address1) ||
    'seller';
  const when = slotLabel || 'upcoming call';
  return `${who} — seller call ${when}`;
}

/**
 * Ensure the contact has an opportunity in the Lead pipeline at the
 * Appointment Set stage. Creates one, or moves the existing open one.
 * Skips test contacts silently. THROWS on any failure — the caller must
 * catch and keep the booking intact.
 */
async function ensureLeadOpportunity(hl, config, { contactId, contact, slotLabel }) {
  if (isTestContact(contact)) {
    return { skipped: 'test-contact' };
  }
  const { pipelineId, stageId } = await resolveLeadPipeline(hl, config);

  const found = await hl.searchOpportunities({
    locationId: config.hlLocationId,
    contactId,
    pipelineId,
  });
  const opps = (found && found.opportunities) || [];
  const open = opps.find(
    (o) =>
      String(o.status || '').toLowerCase() === 'open' &&
      String(o.pipelineId || o.pipeline_id || '') === String(pipelineId)
  );
  if (open) {
    const curStage = open.pipelineStageId || open.pipeline_stage_id;
    if (String(curStage) === String(stageId)) {
      return { moved: false, alreadyThere: true, opportunityId: open.id };
    }
    await hl.updateOpportunity(open.id, { pipelineStageId: stageId });
    return { moved: true, opportunityId: open.id };
  }

  const created = await hl.createOpportunity({
    locationId: config.hlLocationId,
    pipelineId,
    pipelineStageId: stageId,
    contactId,
    name: opportunityTitle(contact, slotLabel),
    status: 'open',
  });
  const id = created && (created.id || (created.opportunity && created.opportunity.id));
  return { created: true, opportunityId: id || null };
}

module.exports = {
  isTestContact,
  resolveLeadPipeline,
  ensureLeadOpportunity,
  opportunityTitle,
  clearPipelineCache,
};

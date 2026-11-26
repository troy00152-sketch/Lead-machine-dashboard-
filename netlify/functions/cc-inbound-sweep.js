// netlify/functions/cc-inbound-sweep.js
// SCHEDULED FUNCTION (1 minute — see netlify.toml
// [functions."cc-inbound-sweep"] schedule = "* * * * *").
//
// Backstop for the inbound-call fix (Nov 26, 2026). The event-driven
// path (agent-leg timeout call.hangup -> PSTN fallback) covers the
// normal case — hangup webhooks were verified arriving with HTTP 200
// on the first attempt. This sweep covers the cases no event covers:
//   * an inbound pairing with NO agent legs at all (F1 zero-leg save,
//     or every leg failed before producing events) sitting 'ringing'
//     past the ~20s ring budget -> attempt the PSTN fallback.
//   * an inbound pairing whose agent legs all died but whose hangup
//     webhooks never arrived (a leg with no call_control_id and no
//     events at all was seen Nov 26) -> force-hangup the listed legs
//     and attempt the PSTN fallback.
//   * a PSTN fallback leg that was answered but whose AMD verdict never
//     landed (fallbackAwaitingAmd past 30s) -> bridge it (assume human).
//   * an inbound pairing whose agent answered in the browser but the
//     call never bridged (case (c) — Nov 26, 2026, round-2 audit):
//     the inbound-leg answer API failed, the bridge API failed, or
//     the inbound call.answered webhook was lost. The event-driven
//     path has no retry for any of those — safeVoice swallows the
//     failure and the pairing sat 'ringing' with agentAnswered set
//     while the caller heard ringback forever. The sweep retries the
//     missing step (capped) instead of leaving the caller ringing.
//
// The sweep NEVER dials when the PSTN fallback flag is off — then it
// only logs. It never ends a call (the seller's hangup event ends it;
// the watchdog flags a pairing that lingers past 60s). Coarseness: a
// 1-minute schedule means a fallback can fire 20-80s after the ring
// budget is spent; the event-driven trigger is the fast path and this
// sweep is the safety net.
//
// 30s Netlify limit for scheduled functions: a sweep is a handful of
// Blobs reads + at most a few Telnyx calls — well inside it.
'use strict';

const callApi = require('./cc-call-api');
const webhook = require('./telnyx-voice-webhook');
const voiceDefault = require('./telnyx-voice-lib');

// ---- injectable voice actions (tests) ----
const deps = { voiceLib: null };
function voiceLib() {
  return deps.voiceLib || voiceDefault;
}

const RING_BUDGET_MS = 25000; // ring budget spent (20s leg timeout + slack)
const FALLBACK_AMD_WAIT_MS = 30000; // answered fallback leg, no AMD verdict
const STALL_MS = 20000; // case (c): quiet this long past the last event
// means the event-driven answer/bridge stalled — the normal path
// completes in seconds, so a 20s-quiet agentAnswered pairing is stuck.
const MAX_STALL_RETRIES = 3; // per missing step, per pairing

async function sweep(event, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const pairings = await callApi._thread.loadPairings(event);
  const calls = (pairings && pairings.calls) || {};
  let fallbackAttempted = 0;
  let fallbackBridged = 0;
  let answerRetried = 0;
  let bridgeRetried = 0;
  let skipped = 0;
  for (const [callId, rec] of Object.entries(calls)) {
    if (!rec || rec.direction !== 'inbound') continue;
    if (rec.status !== 'ringing') continue;
    // (c) Agent answered in the browser but the call never bridged.
    // The event-driven path stalled: the inbound-leg answer API
    // failed, the bridge API failed, or the inbound call.answered
    // webhook was lost. Retry the missing step (capped) — the
    // alternative is the caller hearing ringback until they hang up.
    // Only stale pairings qualify: a pairing updated within STALL_MS
    // is still mid-flight on the normal path (answer -> webhook ->
    // bridge completes in seconds). No agent leg left means there is
    // nothing to bridge to — leave it to the fallback/hangup paths.
    if (rec.agentAnswered) {
      const staleMs = now - (rec.updatedAt || rec.startedAt || 0);
      if (rec.agentLeg && staleMs > STALL_MS) {
        const v = voiceLib();
        // 1. Inbound leg never answered: re-issue the answer. An HTTP
        // success means Telnyx accepted the command — the leg will
        // answer, so record it and proceed to the bridge instead of
        // waiting on a webhook that already landed or never will.
        // (An already-answered leg 422s here; that failure is
        // swallowed below and the bridge attempt still runs — the
        // leg may already be answered with its webhook lost.)
        if (!rec.sellerAnswered && (rec.inboundAnswerRetries || 0) < MAX_STALL_RETRIES) {
          rec.inboundAnswerRetries = (rec.inboundAnswerRetries || 0) + 1;
          try {
            await v.answer(rec.sellerLeg);
            rec.sellerAnswered = true;
            rec.sellerHuman = true;
            if (rec.lastError === 'inbound-answer-failed') rec.lastError = '';
            answerRetried += 1;
          } catch (e) {
            rec.lastError = 'inbound-answer-failed';
            console.error('[cc-inbound-sweep] inbound answer retry failed for ' + callId + ':', (e && e.message) || e);
          }
        }
        // 2. Answered but never bridged: re-issue the bridge with a
        // fresh command_id (a re-used id is silently ignored by
        // Telnyx). Success marks the pairing bridged; the inbound
        // call.bridged webhook, if it lands, agrees.
        if (rec.sellerAnswered && (rec.bridgeRetries || 0) < MAX_STALL_RETRIES) {
          rec.bridgeRetries = (rec.bridgeRetries || 0) + 1;
          try {
            await v.bridge(rec.sellerLeg, rec.agentLeg, {
              commandId: 'brg-retry-' + String(callId).slice(-8) + '-' + rec.bridgeRetries + '-' + now.toString(36),
            });
            rec.status = 'bridged';
            rec.wasBridged = true;
            rec.bridgedAt = rec.bridgedAt || now;
            rec.lastError = '';
            bridgeRetried += 1;
          } catch (e) {
            rec.lastError = 'bridge-failed';
            console.error('[cc-inbound-sweep] bridge retry failed for ' + callId + ':', (e && e.message) || e);
          }
        }
        rec.updatedAt = now;
      }
      continue;
    }
    // The ring clock restarts on a re-dial: a fresh leg dialed at
    // redialedAt gets its own 20s before the sweep may intervene.
    const lastDialAt = Math.max(rec.startedAt || 0, rec.redialedAt || 0);
    const ageMs = now - lastDialAt;
    // (a) Answered fallback leg, AMD verdict never landed: bridge it
    // (assume human — AMD premium verdicts land within seconds of
    // answer, so past 30s the verdict is not coming).
    if (rec.fallbackAwaitingAmd && rec.fallbackAnsweredAt && now - rec.fallbackAnsweredAt > FALLBACK_AMD_WAIT_MS) {
      try {
        const v = voiceLib();
        if (rec.sellerLeg && !rec.sellerAnswered) {
          await v.answer(rec.sellerLeg);
          rec.sellerAnswered = true;
          rec.sellerHuman = true;
        }
        rec.agentAnswered = true;
        rec.fallbackHuman = true;
        rec.fallbackAwaitingAmd = false;
        if (rec.sellerLeg && rec.agentLeg) {
          await v.bridge(rec.sellerLeg, rec.agentLeg);
          rec.status = 'bridged';
          rec.wasBridged = true;
          rec.bridgedAt = rec.bridgedAt || now;
          fallbackBridged += 1;
        }
        rec.updatedAt = now;
      } catch (e) {
        console.error('[cc-inbound-sweep] fallback AMD-timeout bridge failed for ' + callId + ':', (e && e.message) || e);
      }
      continue;
    }
    // (b) Ring budget spent with no answer and no fallback attempted:
    // the browser legs are dead (past their 20s timeout) whether or
    // not their hangup events arrived -> PSTN fallback (forced).
    if (!rec.fallbackAttempted && ageMs > RING_BUDGET_MS) {
      const result = await webhook.attemptPstnFallback(event, callId, { force: true });
      if (result && result.attempted) fallbackAttempted += 1;
      else skipped += 1;
      // attemptPstnFallback re-loads + saves; re-read our copy so
      // the final save below does not clobber its mutations.
      const fresh = await callApi._thread.loadPairings(event);
      if (fresh && fresh.calls && fresh.calls[callId]) pairings.calls[callId] = fresh.calls[callId];
    }
  }
  await callApi._thread.savePairings(pairings, event);
  return { ok: true, fallbackAttempted, fallbackBridged, answerRetried, bridgeRetried, skipped };
}

exports.handler = async (event) => {
  try {
    const summary = await sweep(event);
    console.log('[cc-inbound-sweep] ' + JSON.stringify(summary));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(summary),
    };
  } catch (e) {
    console.error('[cc-inbound-sweep]', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String((e && e.message) || e) }),
    };
  }
};

exports._test = {
  sweep,
  setVoiceLib(v) {
    deps.voiceLib = v || null;
  },
  reset() {
    deps.voiceLib = null;
  },
};

// netlify/functions/cc-sam-voice.js
// Apply Sam's picked voice to the LIVE ElevenLabs agent (Nov 27, 2026).
//
// Dead-control fix (audit Nov 27): the Conversation AI screen saved
// voice.sam into cc-bot-config, but nothing ever sent it anywhere —
// cc-bot-config.js claimed "Sam's voice is applied by the ElevenLabs
// agent config (cc-sam-init)" and cc-sam-init.js contains NO voice
// reference at all (it is the conversation-initiation webhook, not
// the agent config). Live Sam stayed on default Roger
// CwhRBWXzGAHq8TQ4Fs17 no matter what the page picked.
//
// This module is the real path: PATCH
//   https://api.elevenlabs.io/v1/convai/agents/{agent_id}
//   { "conversation_config": { "tts": { "voice_id": "<bare id>" } } }
// with header `xi-api-key: <ELEVENLABS_API_KEY>` (Netlify env var —
// the key is NEVER logged, never returned, never put in a body), then
// GET the same agent and verify conversation_config.tts.voice_id
// stuck. Only voice_id is sent — the live agent's TTS model
// (eleven_v4_turbo in the captured record) is deliberately untouched,
// so a voice change can never silently re-model the agent.
//
// Voice-id shape: the page stores ElevenLabs picks as 'el:<voice_id>'
// (CAI_VOICE_OPTIONS in conversation-ai.html; 21 real voices). The
// PATCH sends exactly the bare id after the 'el:' prefix. Style ids
// ('natural', 'male-deep', ...) and 'browser:<name>' device voices
// are preview-only — they have no ElevenLabs voice_id and CANNOT be
// applied to the agent; applySamVoice reports applicable:false for
// them instead of pretending, and the page says so.
//
// Failure contract (the caller, cc-bot-config.js, relies on this):
// applySamVoice NEVER throws for an ElevenLabs failure — it returns
// {ok:false, error, ...} so the config save itself still succeeds
// and the voice-apply status is reported separately. The page must
// show the failure and keep the old voice as current.
'use strict';

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1/convai/agents';
const SAM_AGENT_ID = 'agent_7701m8dnprvpe77rf8dee90z2q07'; // Sam (captured ~/workspace/mirror-capture/sam-kb/sam-agent.json)
const DEFAULT_VOICE_ID = 'CwhRBWXzGAHq8TQ4Fs17'; // Roger — live default

// ---- injectable fetch (tests) ----
let fetchImpl = null;
function doFetch(url, opts) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('fetch is not available in this runtime');
  return f(url, opts);
}

function agentId() {
  return String(process.env.SAM_AGENT_ID || process.env.ELEVENLABS_SAM_AGENT_ID || SAM_AGENT_ID).trim() || SAM_AGENT_ID;
}

// extractVoiceId(sel) -> bare ElevenLabs voice_id, or null.
// 'el:CwhRBWXzGAHq8TQ4Fs17' -> 'CwhRBWXzGAHq8TQ4Fs17'.
// Anything else (style id, 'browser:...', junk) -> null.
function extractVoiceId(sel) {
  if (typeof sel !== 'string') return null;
  const s = sel.trim();
  if (s.indexOf('el:') !== 0) return null;
  const vid = s.slice(3);
  return /^[A-Za-z0-9]{15,30}$/.test(vid) ? vid : null;
}

// voiceApplicability(sel) -> {applicable, voiceId, reason}
// Names the honest outcome for every shape the page can store.
function voiceApplicability(sel) {
  const vid = extractVoiceId(sel);
  if (vid) return { applicable: true, voiceId: vid, reason: '' };
  if (typeof sel === 'string' && sel.indexOf('browser:') === 0) {
    return { applicable: false, voiceId: null, reason: 'Device/browser voices are preview-only — they have no ElevenLabs voice to apply to Sam.' };
  }
  if (typeof sel === 'string' && sel.trim()) {
    return { applicable: false, voiceId: null, reason: 'Voice style "' + sel.trim().slice(0, 40) + '" is a preview style, not an ElevenLabs voice — Sam keeps his current live voice.' };
  }
  return { applicable: false, voiceId: null, reason: 'No ElevenLabs voice selected — Sam keeps his current live voice.' };
}

function agentUrl(id) {
  return ELEVENLABS_API + '/' + encodeURIComponent(id);
}

async function readErrorText(res) {
  try {
    const t = await res.text();
    return String(t || '').trim().slice(0, 300);
  } catch (e) {
    return '';
  }
}

// getSamVoice(opts) -> {ok, voiceId, currentVoiceId, ...}
// Read-only GET of the agent's live TTS voice. Used by the verify
// step below (and by any status read). Never throws on HTTP failure.
async function getSamVoice(opts) {
  const o = opts || {};
  const apiKey = o.apiKey !== undefined ? o.apiKey : String(process.env.ELEVENLABS_API_KEY || '');
  const id = o.agentId || agentId();
  if (!apiKey) return { ok: false, error: 'ELEVENLABS_API_KEY is not configured', voiceId: null, currentVoiceId: null };
  let res;
  try {
    res = await doFetch(agentUrl(id), { method: 'GET', headers: { 'xi-api-key': apiKey } });
  } catch (e) {
    return { ok: false, error: 'ElevenLabs request failed: ' + String((e && e.message) || e), voiceId: null, currentVoiceId: null };
  }
  if (!res || !res.ok) {
    const detail = res ? await readErrorText(res) : '';
    return {
      ok: false,
      error: 'ElevenLabs GET failed (HTTP ' + (res ? res.status : '?') + ')' + (detail ? ': ' + detail : ''),
      status: res ? res.status : null,
      voiceId: null,
      currentVoiceId: null,
    };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, error: 'ElevenLabs GET returned unparseable JSON', voiceId: null, currentVoiceId: null };
  }
  const vid = data && data.conversation_config && data.conversation_config.tts
    ? data.conversation_config.tts.voice_id : null;
  return { ok: true, voiceId: typeof vid === 'string' ? vid : null, currentVoiceId: typeof vid === 'string' ? vid : null };
}

// applySamVoice(voiceSel, opts) -> result object, never throws for an
// ElevenLabs failure. opts: {fetchImpl?, apiKey?, agentId?} — fetchImpl
// is the test stub; production uses global fetch + env key/agent.
//   success: {ok:true, applied:true, verified:true, voiceId, currentVoiceId, agentId}
//   no-op (not an ElevenLabs voice): {ok:false, applicable:false, reason, requestedVoiceId, currentVoiceId:null}
//   failure: {ok:false, error, status?, voiceId, currentVoiceId (last known, may be null), verified:false}
async function applySamVoice(voiceSel, opts) {
  const o = opts || {};
  if (o.fetchImpl) fetchImpl = o.fetchImpl;
  const avail = voiceApplicability(voiceSel);
  if (!avail.applicable) {
    return {
      ok: false,
      applicable: false,
      applied: false,
      verified: false,
      reason: avail.reason,
      requestedVoiceId: typeof voiceSel === 'string' ? voiceSel : String(voiceSel == null ? '' : voiceSel),
      voiceId: null,
      currentVoiceId: null,
    };
  }
  const apiKey = o.apiKey !== undefined ? o.apiKey : String(process.env.ELEVENLABS_API_KEY || '');
  const id = o.agentId || agentId();
  const voiceId = avail.voiceId;
  if (!apiKey) {
    return { ok: false, applicable: true, applied: false, verified: false, error: 'ELEVENLABS_API_KEY is not configured — Sam keeps his current live voice.', voiceId, currentVoiceId: null, agentId: id };
  }
  let res;
  try {
    res = await doFetch(agentUrl(id), {
      method: 'PATCH',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_config: { tts: { voice_id: voiceId } } }),
    });
  } catch (e) {
    return { ok: false, applicable: true, applied: false, verified: false, error: 'ElevenLabs request failed: ' + String((e && e.message) || e), voiceId, currentVoiceId: null, agentId: id };
  }
  if (!res || !res.ok) {
    const detail = res ? await readErrorText(res) : '';
    return {
      ok: false,
      applicable: true,
      applied: false,
      verified: false,
      error: 'ElevenLabs PATCH failed (HTTP ' + (res ? res.status : '?') + ')' + (detail ? ': ' + detail : '') + ' — Sam keeps his current live voice.',
      status: res ? res.status : null,
      voiceId,
      currentVoiceId: null,
      agentId: id,
    };
  }
  // Verify with a GET that the voice stuck — a 200 PATCH that did
  // not change the agent must not be reported as applied.
  const check = await getSamVoice({ apiKey, agentId: id });
  if (!check.ok) {
    return { ok: false, applicable: true, applied: false, verified: false, error: 'Voice PATCH accepted but the verify read failed: ' + check.error, voiceId, currentVoiceId: null, agentId: id };
  }
  if (check.voiceId !== voiceId) {
    return {
      ok: false,
      applicable: true,
      applied: false,
      verified: false,
      error: 'Voice PATCH accepted but the agent still reports voice ' + (check.voiceId || '(none)') + ' — Sam keeps his current live voice.',
      voiceId,
      currentVoiceId: check.voiceId,
      agentId: id,
    };
  }
  return { ok: true, applicable: true, applied: true, verified: true, voiceId, currentVoiceId: voiceId, agentId: id };
}

module.exports = {
  applySamVoice,
  getSamVoice,
  extractVoiceId,
  voiceApplicability,
  agentUrl,
  SAM_AGENT_ID,
  DEFAULT_VOICE_ID,
  ELEVENLABS_API,
};

// Test hook (not part of the deployed surface).
module.exports._test = {
  setFetch(fn) {
    fetchImpl = fn || null;
  },
  reset() {
    fetchImpl = null;
  },
};

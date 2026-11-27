// netlify/functions/cc-sam-webhook.js
// Post-call webhook for Sam (ElevenLabs ElevenAgents).
// Configured account-wide in the ElevenLabs dashboard: Settings ->
// Webhooks, URL = https://leadmachineapp.com/.netlify/functions/cc-sam-webhook,
// events post_call_transcription + call_initiation_failure. The HMAC
// secret generated at webhook creation goes in Netlify env as
// ELEVENLABS_WEBHOOK_SECRET. gate.ts bypasses this path (same as the
// Telnyx webhooks) — ElevenLabs posts with no dashboard cookie.
//
// What it does, ~1s after hangup:
//   * verifies the ElevenLabs HMAC signature when the secret is set
//     (same posture as the Telnyx webhooks: unset secret = process
//     unverified + warn; set secret + bad signature = 401).
//   * appends Sam's handoff note (summary + rating + booking, if any)
//     to the matching Conversations thread — matched by the user_id
//     set at initiation (the thread key), falling back to the caller
//     number — and pushes it to Troy's phone (cc-push notifyReply).
//   * closes out the call pairing when it is still open (hangup
//     events lost) so the call does not linger as 'bridged'/'ringing'.
//
// The full transcript is logged (truncated) for audit; the thread
// gets the compact summary — a full transcript would drown the
// Conversations view. Recording URLs land in the note when present.
// Transcript-only by design (Troy has not asked for MP3 storage).
'use strict';

const crypto = require('crypto');

const store = require('./cc-sam-store');
const pushDefault = require('./cc-push');
const appointments = require('./cc-appointments');

const deps = { pushLib: null, callApi: null };
function pushLib() {
  return deps.pushLib || pushDefault;
}
function callApi() {
  if (deps.callApi) return deps.callApi;
  try {
    return require('./cc-call-api');
  } catch (e) {
    return null;
  }
}

function rawBody(event) {
  let b = event.body || '';
  if (event.isBase64Encoded) {
    try {
      b = Buffer.from(b, 'base64').toString('utf8');
    } catch (e) { /* fall through with the raw string */ }
  }
  return b;
}

// ElevenLabs signs webhooks with HMAC-SHA256 over the raw body.
// The header arrives either as a bare hex digest or Svix-style
// "t=<timestamp>,v0=<hex>" (v0 over "<timestamp>.<raw body>"). Try
// both forms; a match on either verifies. Returns 'verified' |
// 'no-secret' | 'invalid'.
function verifySignature(event, raw) {
  const secret = String(process.env.ELEVENLABS_WEBHOOK_SECRET || '');
  if (!secret) return 'no-secret';
  const headers = event.headers || {};
  const sig = String(headers['elevenlabs-signature'] || headers['ElevenLabs-Signature'] || headers['ELEVENLABS-SIGNATURE'] || '').trim();
  if (!sig) return 'invalid';
  const candidates = [];
  const m = sig.match(/(?:^|,)\s*v0=([0-9a-fA-F]+)/);
  const t = (sig.match(/(?:^|,)\s*t=([^,]+)/) || [])[1] || '';
  if (m) candidates.push(m[1].toLowerCase());
  if (/^[0-9a-fA-F]{32,}$/.test(sig)) candidates.push(sig.toLowerCase());
  const digests = [crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex')];
  if (t) digests.push(crypto.createHmac('sha256', secret).update(t + '.' + raw, 'utf8').digest('hex'));
  for (const c of candidates) {
    for (const d of digests) {
      if (c.length === d.length && crypto.timingSafeEqual(Buffer.from(c, 'utf8'), Buffer.from(d, 'utf8'))) return 'verified';
    }
  }
  return 'invalid';
}

function pickThreadKey(data) {
  if (data && typeof data.user_id === 'string' && data.user_id.trim()) return data.user_id.trim();
  const meta = (data && data.metadata) || {};
  const pc = meta.phone_call || meta.phoneCall || {};
  const caller = pc.caller_id || pc.callerId || pc.from || meta.caller_id || meta.callerId || '';
  if (caller) {
    try {
      return store.phoneKey(caller);
    } catch (e) { /* fall through */ }
  }
  return '';
}

function fmtEt(ms) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(ms));
  } catch (e) {
    return new Date(ms).toISOString();
  }
}

function fmtDuration(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m ? m + 'm ' + s + 's' : s + 's';
}

function buildNote(data, booking) {
  const analysis = (data && data.analysis) || {};
  const summary = String(analysis.transcript_summary || analysis.summary || '').trim();
  const ok = analysis.call_successful;
  const dur = fmtDuration(Number(data && (data.duration_secs || data.call_duration_secs)));
  const started = data && data.started_at ? Date.parse(data.started_at) : NaN;
  const lines = [];
  lines.push('Sam call' + (Number.isFinite(started) ? ' — ' + fmtEt(started) + ' ET' : '') + (dur ? ' (' + dur + ')' : '') + '.');
  if (summary) lines.push(summary);
  if (ok === true) lines.push('Outcome: successful.');
  else if (ok === false) lines.push('Outcome: not successful.');
  if (booking) {
    lines.push('Booked: ' + booking.label + (booking.name ? ' — ' + booking.name : '') + '.');
  }
  if (data && data.recording_url) lines.push('Recording: ' + String(data.recording_url));
  return lines.join('\n');
}

async function findSamBooking(threadKey, event) {
  if (!threadKey) return null;
  try {
    const list = await appointments.forContact(threadKey, event);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const recent = (list || [])
      .filter((a) => a && a.source === 'sam' && Number(a.createdAt || 0) >= cutoff)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    const b = recent[0];
    if (!b) return null;
    return {
      label: fmtEt(Number(b.startMs || Date.parse(b.startISO || ''))) + ' ET',
      name: b.name || '',
    };
  } catch (e) {
    return null;
  }
}

async function closePairingByPhone(phone, event) {
  try {
    const api = callApi();
    if (!api || !api._thread) return;
    const pairings = await api._thread.loadPairings(event);
    let key = null;
    try {
      key = store.phoneKey(phone || '');
    } catch (e) { /* no match */ }
    for (const [callId, rec] of Object.entries((pairings && pairings.calls) || {})) {
      if (!rec || rec.direction !== 'inbound' || rec.status === 'ended') continue;
      const recKey = (() => {
        try {
          return store.phoneKey(rec.phone || '');
        } catch (e) {
          return '';
        }
      })();
      if (key && recKey === key) {
        rec.status = 'ended';
        rec.endedAt = Date.now();
        rec.updatedAt = Date.now();
        try {
          const logged = await api._thread.logCallToThread(event, rec);
          if (logged) rec.loggedToThread = true;
        } catch (e) { /* thread logging never fails the webhook */ }
        await api._thread.savePairings(pairings, event);
        return;
      }
    }
  } catch (e) { /* close-out never fails the webhook */ }
}

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  const raw = rawBody(event);
  const sigState = verifySignature(event, raw);
  if (sigState === 'invalid') {
    console.error('[cc-sam-webhook] bad ElevenLabs signature — refusing');
    return respond(401, { error: 'invalid signature' });
  }
  if (sigState === 'no-secret') {
    console.warn('[cc-sam-webhook] ELEVENLABS_WEBHOOK_SECRET unset — processing unverified (pre-launch posture)');
  }
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return respond(400, { error: 'Bad JSON' });
  }
  const type = String(body.type || body.event || '');
  const data = (body.data && typeof body.data === 'object') ? body.data : body;
  if (type === 'post_call_transcription' || type === 'post-call-transcription') {
    const threadKey = pickThreadKey(data);
    const booking = await findSamBooking(threadKey, event);
    const note = buildNote(data, booking);
    const transcript = Array.isArray(data.transcript) ? data.transcript : [];
    if (transcript.length) {
      const text = transcript
        .map((t) => (t.role || '?') + ': ' + (t.message || ''))
        .join('\n')
        .slice(0, 8000);
      console.log('[cc-sam-webhook] transcript ' + (data.conversation_id || '') + ':\n' + text);
    }
    if (threadKey) {
      try {
        const thread = await store.loadThread(threadKey, event);
        await store.appendThreadMessage(threadKey, {
          kind: 'note',
          via: 'sam',
          body: note,
          phone: (thread && thread.phone) || '',
          name: (thread && thread.name) || '',
          market: (thread && thread.market) || 'carolina',
        }, event);
        try {
          const push = pushLib();
          if (push && typeof push.notifyReply === 'function') {
            await push.notifyReply({
              threadKey,
              name: (thread && thread.name) || '',
              phone: (thread && thread.phone) || '',
              preview: note.slice(0, 200),
              at: Date.now(),
            }, event);
          }
        } catch (e) {
          console.error('[cc-sam-webhook] push failed:', (e && e.message) || e);
        }
        const meta = (data && data.metadata) || {};
        const pc = meta.phone_call || meta.phoneCall || {};
        await closePairingByPhone(pc.caller_id || pc.callerId || pc.from || '', event);
      } catch (e) {
        console.error('[cc-sam-webhook] thread append failed:', (e && e.message) || e);
      }
    } else {
      console.error('[cc-sam-webhook] post_call_transcription with no thread match (conversation ' + (data.conversation_id || '?') + ')');
    }
    return respond(200, { received: true, thread: threadKey || null, signature: sigState });
  }
  if (type === 'call_initiation_failure' || type === 'call-initiation-failure') {
    const threadKey = pickThreadKey(data);
    const reason = String((data && (data.error || data.reason || data.message)) || 'Sam could not connect');
    if (threadKey) {
      try {
        const thread = await store.loadThread(threadKey, event);
        await store.appendThreadMessage(threadKey, {
          kind: 'note',
          via: 'sam',
          body: 'Sam could not connect this call (' + reason + '). Troy — please call the seller back.',
          phone: (thread && thread.phone) || '',
          name: (thread && thread.name) || '',
          market: (thread && thread.market) || 'carolina',
        }, event);
      } catch (e) {
        console.error('[cc-sam-webhook] failure-note append failed:', (e && e.message) || e);
      }
    }
    console.error('[cc-sam-webhook] call_initiation_failure: ' + reason);
    return respond(200, { received: true, thread: threadKey || null, signature: sigState });
  }
  return respond(200, { received: true, ignored: type || 'unknown', signature: sigState });
};

// Test hooks (not part of the deployed surface).
exports._test = {
  verifySignature,
  pickThreadKey,
  buildNote,
  setPushLib(p) {
    deps.pushLib = p || null;
  },
  setCallApi(a) {
    deps.callApi = a || null;
  },
  reset() {
    deps.pushLib = null;
    deps.callApi = null;
  },
};

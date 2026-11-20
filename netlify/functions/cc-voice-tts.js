// netlify/functions/cc-voice-tts.js
// Real human voices for the Command Center (Conversation AI screen
// Listen previews + voice test calls, and the assistant avatar).
// The browser never sees the key: it lives ONLY in the Netlify env
// var ELEVENLABS_API_KEY on this project.
//
// Frontend calls:
//   GET  /.netlify/functions/cc-voice-tts
//        -> { voices: [{ voice_id, name, gender, age, accent, descriptive, use_case }] }
//   POST /.netlify/functions/cc-voice-tts  { voice_id, text }
//        -> audio/mpeg (base64 body) of the spoken line
//
// Auth: the dashboard sign-in cookie (lm_auth), same HMAC check as
// buyer-verify.js. Text is capped per call so a runaway page cannot
// burn the monthly character budget.
'use strict';

const crypto = require('crypto');

const API_BASE = 'https://api.elevenlabs.io/v1';
const MODEL_ID = 'eleven_multilingual_v2';
const TIMEOUT_MS = 25000;
const MAX_TEXT_CHARS = 800;
const COOKIE_NAME = 'lm_auth';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
const unauth = () => json(401, { error: 'Not signed in — open the dashboard and sign in first.' });

// ---- sign-in check: verify the dashboard lm_auth cookie (same HMAC as gate) ----
function getCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
function isSignedIn(event) {
  const secret = process.env.GATE_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) return false;
  const headers = event.headers || {};
  const cookieHeader = headers.cookie || headers.Cookie || '';
  const cookie = getCookie(cookieHeader, COOKIE_NAME);
  if (!cookie) return false;
  const [expiry, sig] = cookie.split('.');
  if (!expiry || !sig) return false;
  const exp = parseInt(expiry, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(expiry).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (!isSignedIn(event)) return unauth();

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return json(503, { error: 'Voice service is not connected yet.' });

  try {
    if (event.httpMethod === 'GET') {
      const res = await fetchWithTimeout(API_BASE + '/voices', {
        headers: { 'xi-api-key': apiKey },
      });
      if (!res.ok) return json(502, { error: 'Voice list is unavailable right now.' });
      const data = await res.json();
      const voices = (data.voices || []).map((v) => {
        const labels = v.labels || {};
        return {
          voice_id: v.voice_id,
          name: v.name,
          gender: labels.gender || null,
          age: labels.age || null,
          accent: labels.accent || null,
          descriptive: labels.descriptive || null,
          use_case: labels.use_case || null,
        };
      });
      return json(200, { voices });
    }

    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request.' }); }
      const voiceId = String(body.voice_id || '');
      const text = String(body.text || '').trim();
      if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) return json(400, { error: 'Unknown voice.' });
      if (!text) return json(400, { error: 'Nothing to say.' });
      if (text.length > MAX_TEXT_CHARS) return json(400, { error: 'That line is too long to speak.' });

      const res = await fetchWithTimeout(
        API_BASE + '/text-to-speech/' + voiceId + '?output_format=mp3_44100_128',
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: MODEL_ID,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );
      if (!res.ok) return json(502, { error: 'The voice could not speak that line right now.' });
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
        body: buf.toString('base64'),
        isBase64Encoded: true,
      };
    }

    return json(405, { error: 'Method not allowed.' });
  } catch (e) {
    return json(502, { error: 'Voice service did not answer. Try again.' });
  }
};

// netlify/functions/cc-workflow-tick.js
// Runs ONE tick of the Phase 3 workflow engine (cc-workflow-engine.js).
// An external cron (created later, separately) calls this once a minute.
//
// Protection: shared-secret header `x-cc-tick-secret` must match the
// CC_TICK_SECRET env var. FAIL CLOSED: if CC_TICK_SECRET is not set in
// the environment, every call is refused (503) — the endpoint can never
// run unprotected.
'use strict';

const crypto = require('crypto');

let engine = require('./cc-workflow-engine');

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
function json(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

exports.handler = async (event) => {
  const secret = process.env.CC_TICK_SECRET;
  if (!secret) {
    return json(503, { error: 'CC_TICK_SECRET is not configured — tick endpoint disabled.' });
  }
  const headers = event.headers || {};
  const provided = headers['x-cc-tick-secret'] || headers['X-Cc-Tick-Secret'] || '';
  if (!provided || !safeEqual(provided, secret)) {
    return json(401, { error: 'Unauthorized.' });
  }
  try {
    const summary = await engine.tick(Date.now(), event);
    return json(200, { ok: true, ...summary });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

// Test hook (not part of the deployed surface).
exports._test = {
  setEngine(e) {
    engine = e || require('./cc-workflow-engine');
  },
};

// netlify/functions/telnyx-lib.js
// Shared Telnyx messaging library for the standalone Command Center
// (Phase 2 of the HighLevel mirror build — see
// ~/workspace/standalone-build/BUILD-PLAN.md).
//
// Sends SMS through the Telnyx API v2 using the "Seller Outreach"
// messaging profile. The API key lives ONLY in the TELNYX_API_KEY env
// var (server-side, set in Netlify) — never in code, never client-side.
//
// FAIL CLOSED: if TELNYX_API_KEY is missing, or a market has no sender
// numbers yet, sendSms() throws. It never fakes a send.
'use strict';

const TELNYX_API_URL = 'https://api.telnyx.com/v2/messages';

// "Seller Outreach" messaging profile (created Nov 15, 2026).
const MESSAGING_PROFILE_ID = '4001a1e2-b241-41eb-b381-f6c06571cd64';

// Per-market sender pools. Numbers get filled in AFTER purchase (Troy's
// money step) — 5 numbers per market planned. Until a pool has numbers,
// sends for that market throw (fail closed).
//   indianapolis -> 317, carolina -> 252, kansascity -> 816,
//   cleveland -> 216, florida -> 904
const SENDER_POOLS = {
  indianapolis: [], // 317 — fill after purchase
  carolina: ['+12525387760', '+12523243038', '+12522623080', '+12525092142', '+12528097976'], // 252 — purchased Nov 25, 2026 (Order 0002f7f5-772e-4f42-b934-a5cbb5875d49)
  kansascity: [], // 816 — fill after purchase
  cleveland: [], // 216 — fill after purchase
  florida: [], // 904 — fill after purchase
};

const MARKET_AREA_CODES = {
  indianapolis: '317',
  carolina: '252',
  kansascity: '816',
  cleveland: '216',
  florida: '904',
};

// ---- phone helpers ----
function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}
// Normalize a US number to E.164 (+1XXXXXXXXXX). Throws on junk input.
function toE164(v) {
  let d = digitsOnly(v);
  if (d.length === 10) d = '1' + d;
  if (d.length !== 11 || !d.startsWith('1')) {
    throw new Error('Not a valid US phone number: ' + v);
  }
  return '+' + d;
}
// Store key form: digits only, country code included (e.g. 13175551234).
function phoneKey(v) {
  return digitsOnly(toE164(v));
}

// ---- round-robin sender pick ----
// In-memory cursors (per function instance). Good enough for even
// distribution across a warm instance; the pool itself is the source of
// truth, so a cold start just restarts the rotation.
const cursors = {};
function pickSender(market, poolOverride) {
  const pool = poolOverride || SENDER_POOLS[market];
  if (!pool) throw new Error('Unknown market: ' + market);
  if (!pool.length) {
    throw new Error(
      'No sender numbers configured for market "' + market + '" yet (numbers not purchased).'
    );
  }
  const i = cursors[market] || 0;
  cursors[market] = i + 1;
  return pool[i % pool.length];
}

// ---- GSM-7 segment counting ----
// Basic GSM-7 alphabet (1 septet each) + extension table (2 septets:
// escape + char). Anything outside falls back to UCS-2 counting.
const GSM7_BASIC = new Set(
  ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./' +
    '0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿' +
    'abcdefghijklmnopqrstuvwxyzäöñüà').split('')
);
const GSM7_EXT = new Set(['^', '{', '}', '\\', '[', ']', '~', '|', '€', '\f']);
function isGsm7(text) {
  for (const ch of String(text)) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXT.has(ch)) return false;
  }
  return true;
}
// Returns {encoding, units, segments, perSegment}.
// GSM-7: 160 units single / 153 per concatenated segment.
// UCS-2: 70 chars single / 67 per concatenated segment (counted in
// UTF-16 code units, which is how carriers bill it).
function countSegments(text) {
  const s = String(text == null ? '' : text);
  if (isGsm7(s)) {
    let units = 0;
    for (const ch of s) units += GSM7_EXT.has(ch) ? 2 : 1;
    const segments = units <= 160 ? (units === 0 ? 0 : 1) : Math.ceil(units / 153);
    return { encoding: 'GSM-7', units, segments, perSegment: units <= 160 ? 160 : 153 };
  }
  const units = s.length; // UTF-16 code units
  const segments = units <= 70 ? (units === 0 ? 0 : 1) : Math.ceil(units / 67);
  return { encoding: 'UCS-2', units, segments, perSegment: units <= 70 ? 70 : 67 };
}

// ---- send ----
// sendSms({to, body, market, from?, fetchImpl?, apiKey?})
// -> resolves to the Telnyx message object ({id, ...}).
// Throws (fail closed) when the API key is missing, the market pool is
// empty, or Telnyx rejects the send.
async function sendSms(opts) {
  const o = opts || {};
  const apiKey = o.apiKey || process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error('TELNYX_API_KEY is not configured — refusing to send.');
  }
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available.');
  }
  const to = toE164(o.to);
  const body = String(o.body == null ? '' : o.body);
  if (!body.trim()) throw new Error('Message body is empty.');
  const from = o.from ? toE164(o.from) : pickSender(o.market);

  const res = await fetchImpl(TELNYX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      from,
      to,
      text: body,
      messaging_profile_id: MESSAGING_PROFILE_ID,
    }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* non-JSON response — handled below */
  }
  if (!res.ok) {
    const detail =
      (data && data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].title)) ||
      'HTTP ' + res.status;
    throw new Error('Telnyx send failed: ' + detail);
  }
  const msg = (data && data.data) || {};
  return {
    id: msg.id || null,
    from,
    to,
    body,
    segments: countSegments(body),
    raw: msg,
  };
}

module.exports = {
  TELNYX_API_URL,
  MESSAGING_PROFILE_ID,
  SENDER_POOLS,
  MARKET_AREA_CODES,
  digitsOnly,
  toE164,
  phoneKey,
  pickSender,
  isGsm7,
  countSegments,
  sendSms,
};

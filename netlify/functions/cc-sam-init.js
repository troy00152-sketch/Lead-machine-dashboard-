// netlify/functions/cc-sam-init.js
// Conversation-initiation webhook for Sam (ElevenLabs ElevenAgents).
// ElevenLabs POSTs here at conversation start for inbound telephony
// (Twilio / Exotel / SIP trunk) and applies the returned JSON as
// dynamic variables — Sam greets a known seller by name and already
// knows the property address instead of re-asking for it.
//
// Configure in the ElevenLabs dashboard: Agents -> Sam -> Security
// tab -> enable "Fetch initiation client data from a webhook", URL =
// https://leadmachineapp.com/.netlify/functions/cc-sam-init, and set
// the custom header x-sam-init-secret to the SAM_INIT_SECRET value
// (Netlify env). gate.ts bypasses this path (same as the Telnyx
// webhooks) — ElevenLabs posts with no dashboard cookie.
//
// Request (ElevenLabs initiation payload): caller_id, called_number,
// call_sid (names vary by channel — read defensively). Response:
// {type: 'conversation_initiation_client_data', user_id, dynamic_variables}.
// user_id is the thread key — the post-call webhook (cc-sam-webhook)
// matches the transcript back to the same thread with it.
//
// NEVER fail the call start: any lookup error returns empty
// variables with 200 — Sam still talks, he just asks for the address.
'use strict';

const store = require('./cc-sam-store');

function firstString(body, names) {
  for (const n of names) {
    const v = body && body[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && typeof v.number === 'string' && v.number.trim()) return v.number.trim();
  }
  return '';
}

function callerKey(callerId) {
  try {
    return store.phoneKey(callerId || '');
  } catch (e) {
    return '';
  }
}

function fullAddress(enr) {
  if (!enr) return '';
  const parts = [enr.address1 || '', enr.city || '', enr.state || '', enr.postalCode || '']
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return parts.join(', ');
}

function marketOf(thread, enr) {
  if (thread && thread.market) return String(thread.market);
  if (enr && Array.isArray(enr.tags)) {
    if (enr.tags.includes('carolina sms') || enr.tags.includes('carolina')) return 'carolina';
    if (enr.tags.includes('indianapolis sms')) return 'indianapolis';
    if (enr.tags.includes('kansas city sms')) return 'kansas city';
    if (enr.tags.includes('cleveland sms')) return 'cleveland';
    if (enr.tags.includes('florida sms')) return 'florida';
    if (enr.tags.includes('dayton sms')) return 'dayton';
  }
  return 'carolina';
}

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    // Optional shared-secret check (dashboard step: set the
    // x-sam-init-secret header on the initiation webhook + the
    // SAM_INIT_SECRET Netlify env). When the env is unset the check
    // is skipped (warn once) — the endpoint only returns the caller's
    // own thread info, and the pilot runs before the secret lands.
    const secret = String(process.env.SAM_INIT_SECRET || '');
    if (secret) {
      const got = String((event.headers && (event.headers['x-sam-init-secret'] || event.headers['X-Sam-Init-Secret'])) || '');
      if (got !== secret) return respond(401, { error: 'unauthorized' });
    } else {
      console.warn('[cc-sam-init] SAM_INIT_SECRET unset — initiation lookups are unauthenticated (pilot posture)');
    }
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      body = {};
    }
    const callerId = firstString(body, ['caller_id', 'callerId', 'system__caller_id', 'from', 'phone']);
    const calledNumber = firstString(body, ['called_number', 'calledNumber', 'system__called_number', 'to', 'dialed_number']);
    const key = callerKey(callerId);
    const vars = {
      seller_name: '',
      property_address: '',
      market: 'carolina',
      seller_phone: callerId || '',
      dialed_number: calledNumber || '',
    };
    let userId = key || callerId || '';
    if (key) {
      try {
        const thread = await store.loadThread(key, event);
        const enr = await store.loadEnrollment(key, event);
        if (thread && thread.name) vars.seller_name = String(thread.name);
        if (!vars.seller_name && enr && (enr.name || enr.firstName)) {
          vars.seller_name = String(enr.name || enr.firstName);
        }
        const addr = fullAddress(enr);
        if (addr) vars.property_address = addr;
        vars.market = marketOf(thread, enr);
        if (thread && thread.key) userId = thread.key;
      } catch (e) {
        console.error('[cc-sam-init] lookup failed for ' + key + ':', (e && e.message) || e);
      }
    }
    return respond(200, {
      type: 'conversation_initiation_client_data',
      user_id: userId,
      dynamic_variables: vars,
    });
  } catch (e) {
    console.error('[cc-sam-init]', e);
    return respond(200, {
      type: 'conversation_initiation_client_data',
      user_id: '',
      dynamic_variables: { seller_name: '', property_address: '', market: 'carolina', seller_phone: '', dialed_number: '' },
    });
  }
};

// Test hooks (not part of the deployed surface).
exports._test = {
  callerKey,
  fullAddress,
  marketOf,
};

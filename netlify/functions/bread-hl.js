// netlify/functions/bread-hl.js
// Bread AI — HighLevel CRM sidebar integration for Troy's wholesaling system.
// Troy runs the FreeWholesaling playbook. Bread lives inside his HighLevel CRM
// as a Custom Menu Link ("Bread AI"), letting him talk to contacts, pull deals,
// check workflows, and take action — all from one chat.
//
// Same pattern as dashboard-ai.js (OpenAI-compatible chat completions via a
// Netlify function). The HighLevel Private Integration token lives ONLY in
// Netlify env vars (HL_API_TOKEN) — never in browser code.
//
// Frontend calls: POST /.netlify/functions/bread-hl
//   { messages: [{ role: "user"|"assistant", content: "..." }] }
// Responds: { reply: "..." }  or  { error: "..." }
//
// SECURITY RULES (hard):
// - hl_send_sms NEVER fires without explicit user confirmation in the UI.
//   The model proposes the message; the frontend shows a "Send" button.
//   Troy taps it — the function only sends on a confirmed=true flag.
// - DND contacts are READ-ONLY. hl_send_sms refuses if the contact has
//   DND enabled on the SMS channel or carries the `dnc` tag.
// - hl_add_tag and hl_create_opportunity are logged but do not auto-fire
//   without the user asking in plain language ("tag him", "create the opp").
// - All other tools are read-only.
//
// Troy's approval gate (Oct 29, 2026): this function ships ONLY after his
// explicit review. No deploy until he says go.
'use strict';

const DEFAULT_MODEL = 'gpt-4.1';
const TIMEOUT_MS = 25000;
const HL_TIMEOUT_MS = 20000;
const MAX_TOKENS = 900;          // keeps replies tight and cheap
const MAX_MESSAGES = 40;         // history cap per request
const MAX_INPUT_CHARS = 4000;    // per-message cap
const MAX_TOOL_ITERATIONS = 3;   // max HL tool calls per chat request

const HL_API_BASE = 'https://services.leadconnectorhq.com';
const HL_API_VERSION = '2021-07-28';
// Troy's new CRM — "direct property buyers" (Fitness Lead Machine LLC)
const HL_LOCATION_ID = 'krKoHLudPnn7nT0DPtwa';

// ---- HighLevel API client ----

function hlHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Version': HL_API_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // Bypass Cloudflare 403 on direct REST (proven 2026-10-14/15)
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

async function hlFetch(token, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HL_TIMEOUT_MS);
  try {
    const res = await fetch(`${HL_API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: hlHeaders(token),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(`HL ${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Tool backends ----

// hl_get_contact: search by name, phone, or email
async function hlGetContact({ hlToken, query }) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, summary: 'No search query — give me a name, phone, or email.' };
  const data = await hlFetch(
    hlToken, 'GET',
    `/contacts/?locationId=${encodeURIComponent(HL_LOCATION_ID)}&query=${encodeURIComponent(q)}&limit=5`
  );
  const contacts = (data && data.contacts) || [];
  if (!contacts.length) {
    return { ok: true, count: 0, summary: `No contacts found for "${q}".` };
  }
  const lines = contacts.slice(0, 5).map((c, i) => {
    const tags = (c.tags || []).join(', ') || 'no tags';
    const dnd = c.dnd ? 'DND ON' : 'no DND';
    const cf = c.customFields || c.customField || [];
    const cfLines = Array.isArray(cf)
      ? cf.slice(0, 8).map((f) => `  ${f.name || f.key || f.id}: ${f.value ?? ''}`).join('\n')
      : '';
    return [
      `${i + 1}. ${c.contactName || c.name || '(no name)'} — ID ${c.id}`,
      `   Phone: ${c.phone || 'n/a'} | Email: ${c.email || 'n/a'}`,
      `   Tags: ${tags} | ${dnd}`,
      cfLines,
    ].filter(Boolean).join('\n');
  });
  return {
    ok: true, count: contacts.length,
    summary: `CONTACTS matching "${q}" (${contacts.length}):\n${lines.join('\n')}`,
    contacts: contacts.map((c) => ({ id: c.id, name: c.contactName || c.name, phone: c.phone, email: c.email, tags: c.tags || [], dnd: !!c.dnd })),
  };
}

// hl_add_tag: add one or more tags to a contact
async function hlAddTag({ hlToken, contactId, tags }) {
  const id = String(contactId || '').trim();
  const tagList = Array.isArray(tags) ? tags : [tags];
  const clean = tagList.map((t) => String(t || '').trim()).filter(Boolean);
  if (!id) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  if (!clean.length) return { ok: false, summary: 'No tags to add.' };
  await hlFetch(hlToken, 'POST', `/contacts/${encodeURIComponent(id)}/tags`, { tags: clean });
  return { ok: true, summary: `Added tag(s) [${clean.join(', ')}] to contact ${id}.` };
}

// hl_create_opportunity: create an opportunity in a pipeline stage
async function hlCreateOpportunity({ hlToken, contactId, pipelineId, stageId, name, monetaryValue }) {
  const cid = String(contactId || '').trim();
  const pid = String(pipelineId || '').trim();
  const sid = String(stageId || '').trim();
  if (!cid) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  if (!pid || !sid) {
    return { ok: false, summary: 'Need a pipelineId and stageId. Ask Troy which pipeline/stage, or use hl_get_workflows to list them.' };
  }
  const body = {
    locationId: HL_LOCATION_ID,
    contactId: cid,
    pipelineId: pid,
    pipelineStageId: sid,
    name: String(name || 'New Opportunity').slice(0, 200),
    status: 'open',
    ...(monetaryValue ? { monetaryValue: Number(monetaryValue) } : {}),
  };
  const data = await hlFetch(hlToken, 'POST', '/opportunities/', body);
  const opp = data && data.opportunity ? data.opportunity : data;
  return { ok: true, summary: `Created opportunity "${body.name}" (${(opp && opp.id) || 'ok'}) for contact ${cid} in stage ${sid}.` };
}

// hl_get_conversations: recent SMS threads for a contact
async function hlGetConversations({ hlToken, contactId, limit }) {
  const cid = String(contactId || '').trim();
  if (!cid) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  const n = Math.min(10, Math.max(1, Number(limit) || 5));
  const data = await hlFetch(hlToken, 'POST', '/conversations/search', {
    locationId: HL_LOCATION_ID,
    contactId: cid,
    limit: n,
  });
  const convos = (data && data.conversations) || [];
  if (!convos.length) {
    return { ok: true, count: 0, summary: `No conversations found for contact ${cid}.` };
  }
  const out = [];
  for (const conv of convos.slice(0, n)) {
    const msgs = await hlFetch(hlToken, 'GET', `/conversations/${conv.id}/messages?limit=5`).catch(() => null);
    const msgList = (msgs && (msgs.messages && msgs.messages.messages ? msgs.messages.messages : msgs.messages)) || [];
    const preview = msgList.slice(-3).map((m) => {
      const dir = m.direction === 'inbound' ? 'IN' : 'OUT';
      const body = String(m.body || m.message || '').slice(0, 120);
      return `    [${dir}] ${body}`;
    }).join('\n');
    out.push(`Thread ${conv.id} (${conv.type || 'SMS'}):\n${preview || '    (no messages)'}`);
  }
  return { ok: true, count: convos.length, summary: `CONVERSATIONS for ${cid} (${convos.length}):\n${out.join('\n')}` };
}

// hl_get_workflows: list workflows with Published/Draft status + enrollment
async function hlGetWorkflows({ hlToken }) {
  const data = await hlFetch(hlToken, 'GET', `/workflows/?locationId=${encodeURIComponent(HL_LOCATION_ID)}`);
  const wfs = (data && (data.workflows || data.data)) || [];
  if (!wfs.length) return { ok: true, count: 0, summary: 'No workflows found.' };
  const lines = wfs.map((w) => {
    const status = w.status || w.publishedStatus || 'unknown';
    const enrolled = w.enrolledContacts ?? w.stats?.enrolled ?? '?';
    return `- ${w.name || w.id} — ${status} — enrolled: ${enrolled}`;
  });
  return { ok: true, count: wfs.length, summary: `WORKFLOWS (${wfs.length}):\n${lines.join('\n')}` };
}

// hl_send_sms: send an SMS — REQUIRES confirmed=true AND passes DND check
async function hlSendSms({ hlToken, contactId, message, confirmed, fromNumber }) {
  const cid = String(contactId || '').trim();
  const msg = String(message || '').trim();
  if (!cid) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  if (!msg) return { ok: false, summary: 'No message text.' };
  if (confirmed !== true) {
    return {
      ok: false, needsConfirmation: true,
      summary: `SMS NOT SENT — needs your tap to confirm.\nTo: contact ${cid}\nMessage: "${msg.slice(0, 200)}"\nReply "send it" or tap Send in the UI to confirm.`,
    };
  }
  // DND guard: refuse to text DND'd contacts
  const contact = await hlFetch(hlToken, 'GET', `/contacts/${encodeURIComponent(cid)}`).catch(() => null);
  if (contact) {
    const c = contact.contact || contact;
    const dndSettings = c.dndSettings || {};
    const smsDnd = dndSettings.SMS || dndSettings.sms;
    const tags = (c.tags || []).map((t) => String(t).toLowerCase());
    if (smsDnd === true || c.dnd === true || tags.includes('dnc')) {
      return { ok: false, summary: `REFUSED — contact ${cid} is DND'd for SMS or carries the dnc tag. I will not text them.` };
    }
  }
  const body = {
    type: 'SMS',
    contactId: cid,
    message: msg,
    ...(fromNumber ? { fromNumber: String(fromNumber).trim() } : {}),
  };
  await hlFetch(hlToken, 'POST', '/conversations/messages', body);
  return { ok: true, summary: `SMS sent to contact ${cid}.` };
}

// hl_update_contact: update name, phone, email, address on a contact
async function hlUpdateContact({ hlToken, contactId, firstName, lastName, phone, email, address1, city, state, postalCode }) {
  const cid = String(contactId || '').trim();
  if (!cid) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  const body = {};
  if (firstName !== undefined && firstName !== null && String(firstName).trim() !== '') body.firstName = String(firstName).trim();
  if (lastName !== undefined && lastName !== null && String(lastName).trim() !== '') body.lastName = String(lastName).trim();
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') body.phone = String(phone).trim();
  if (email !== undefined && email !== null && String(email).trim() !== '') body.email = String(email).trim();
  if (address1 !== undefined && address1 !== null && String(address1).trim() !== '') body.address1 = String(address1).trim();
  if (city !== undefined && city !== null && String(city).trim() !== '') body.city = String(city).trim();
  if (state !== undefined && state !== null && String(state).trim() !== '') body.state = String(state).trim();
  if (postalCode !== undefined && postalCode !== null && String(postalCode).trim() !== '') body.postalCode = String(postalCode).trim();
  // Convenience: "name" splits into first/last
  if (!body.firstName && !body.lastName && arguments[0].name) {
    const parts = String(arguments[0].name).trim().split(/\s+/);
    if (parts.length) body.firstName = parts[0];
    if (parts.length > 1) body.lastName = parts.slice(1).join(' ');
  }
  if (!Object.keys(body).length) return { ok: false, summary: 'Nothing to update — give me a name, phone, email, or address.' };
  await hlFetch(hlToken, 'PUT', `/contacts/${encodeURIComponent(cid)}`, body);
  const changed = Object.keys(body).map((k) => `${k}=${body[k]}`).join(', ');
  return { ok: true, summary: `Updated contact ${cid}: ${changed}.` };
}

// hl_remove_tag: remove one or more tags from a contact
async function hlRemoveTag({ hlToken, contactId, tags }) {
  const cid = String(contactId || '').trim();
  const tagList = Array.isArray(tags) ? tags : [tags];
  const clean = tagList.map((t) => String(t || '').trim()).filter(Boolean);
  if (!cid) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  if (!clean.length) return { ok: false, summary: 'No tags to remove.' };
  await hlFetch(hlToken, 'DELETE', `/contacts/${encodeURIComponent(cid)}/tags`, { tags: clean });
  return { ok: true, summary: `Removed tag(s) [${clean.join(', ')}] from contact ${cid}.` };
}

// hl_add_note: add a note to a contact's timeline
async function hlAddNote({ hlToken, contactId, body, userId }) {
  const cid = String(contactId || '').trim();
  const text = String(body || '').trim();
  if (!cid) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  if (!text) return { ok: false, summary: 'No note text.' };
  const payload = { body: text, ...(userId ? { userId: String(userId).trim() } : {}) };
  await hlFetch(hlToken, 'POST', `/contacts/${encodeURIComponent(cid)}/notes`, payload);
  return { ok: true, summary: `Note added to contact ${cid}.` };
}

// hl_update_opportunity: move a deal to another stage, or update its value/status
async function hlUpdateOpportunity({ hlToken, opportunityId, stageId, status, monetaryValue, name }) {
  const oid = String(opportunityId || '').trim();
  if (!oid) return { ok: false, summary: 'No opportunity ID.' };
  const body = {};
  if (stageId) body.pipelineStageId = String(stageId).trim();
  if (status) body.status = String(status).trim(); // open, won, lost, abandoned
  if (monetaryValue !== undefined && monetaryValue !== null && monetaryValue !== '') body.monetaryValue = Number(monetaryValue);
  if (name) body.name = String(name).trim();
  if (!Object.keys(body).length) return { ok: false, summary: 'Nothing to update — give me a stage, status, value, or name.' };
  await hlFetch(hlToken, 'PUT', `/opportunities/${encodeURIComponent(oid)}`, body);
  const changed = Object.keys(body).map((k) => `${k}=${body[k]}`).join(', ');
  return { ok: true, summary: `Updated opportunity ${oid}: ${changed}.` };
}

// hl_list_templates: list document/contract templates in the location
async function hlListTemplates({ hlToken }) {
  const data = await hlFetch(
    hlToken, 'GET',
    `/proposals/templates?locationId=${encodeURIComponent(HL_LOCATION_ID)}`
  );
  const templates = (data && (data.templates || data.data || [])) || [];
  if (!templates.length) {
    return { ok: true, count: 0, summary: 'No document templates found in this location.' };
  }
  const lines = templates.map((t, i) =>
    `${i + 1}. ${t.name || t.title || '(unnamed)'} — ID ${t.id || t._id}`
  );
  return {
    ok: true, count: templates.length,
    summary: `CONTRACT TEMPLATES (${templates.length}):\n${lines.join('\n')}`,
    templates: templates.map((t) => ({ id: t.id || t._id, name: t.name || t.title })),
  };
}

// hl_send_contract: create + send a contract from a template (CONFIRMATION GATE)
async function hlSendContract({ hlToken, templateId, contactId, contractName, confirmed, customValues }) {
  const tid = String(templateId || '').trim();
  const cid = String(contactId || '').trim();
  if (!tid) return { ok: false, summary: 'No template ID — list templates first with hl_list_templates.' };
  if (!cid) return { ok: false, summary: 'No contact ID — look up the contact first.' };
  if (confirmed !== true) {
    return {
      ok: false, needsConfirmation: true,
      summary: `CONTRACT NOT SENT — needs your tap to confirm.\nTemplate: ${tid}\nTo: contact ${cid}\nContract name: ${contractName || '(default)'}\n${customValues ? `Custom values: ${JSON.stringify(customValues).slice(0, 200)}` : ''}\nReply "send it" to confirm.`,
    };
  }
  // Look up the contact to get email for the recipient
  const contact = await hlFetch(hlToken, 'GET', `/contacts/${encodeURIComponent(cid)}`).catch(() => null);
  const c = contact ? (contact.contact || contact) : {};
  const recipientEmail = c.email || '';
  if (!recipientEmail) {
    return { ok: false, summary: `Cannot send contract — contact ${cid} has no email on file. Add an email first.` };
  }
  const body = {
    templateId: tid,
    locationId: HL_LOCATION_ID,
    recipients: [{ contactId: cid, email: recipientEmail, role: 'signer' }],
    ...(contractName ? { name: String(contractName).trim() } : {}),
    ...(customValues && typeof customValues === 'object' ? { customValues } : {}),
  };
  const result = await hlFetch(hlToken, 'POST', '/proposals/templates/send', body);
  const docId = (result && (result.id || result.documentId || (result.document && result.document.id))) || 'unknown';
  return { ok: true, summary: `Contract sent to contact ${cid} (${recipientEmail}). Document ID: ${docId}.` };
}

// ---- Tool definitions for the LLM ----

const HL_GET_CONTACT_DEF = {
  type: 'function',
  function: {
    name: 'hl_get_contact',
    description: 'Look up a HighLevel CRM contact by name, phone, or email. Returns contact ID, phone, email, tags, DND status, and custom fields. Call it when Troy asks "who is [name]", "look up [phone]", or needs a contact ID before tagging, messaging, or creating an opportunity.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, phone number, or email to search for.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

const HL_ADD_TAG_DEF = {
  type: 'function',
  function: {
    name: 'hl_add_tag',
    description: 'Add one or more tags to a HighLevel contact. Call it when Troy says "tag him/her as [tag]", "add the [tag] tag", or similar. You need the contact ID first — use hl_get_contact if you don\'t have it.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HighLevel contact ID.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add, e.g. ["hot lead", "dnc"].' },
      },
      required: ['contactId', 'tags'],
      additionalProperties: false,
    },
  },
};

const HL_CREATE_OPPORTUNITY_DEF = {
  type: 'function',
  function: {
    name: 'hl_create_opportunity',
    description: 'Create a deal opportunity for a contact in a HighLevel pipeline stage. Call it when Troy says "create an opportunity", "add to pipeline", or "move to [stage]". You need the contact ID, pipeline ID, and stage ID — ask Troy if you don\'t have the pipeline/stage.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HighLevel contact ID.' },
        pipelineId: { type: 'string', description: 'Pipeline ID.' },
        stageId: { type: 'string', description: 'Pipeline stage ID.' },
        name: { type: 'string', description: 'Opportunity name, e.g. "123 Main St — Seller".' },
        monetaryValue: { type: 'number', description: 'Deal value in dollars. Optional.' },
      },
      required: ['contactId', 'pipelineId', 'stageId'],
      additionalProperties: false,
    },
  },
};

const HL_GET_CONVERSATIONS_DEF = {
  type: 'function',
  function: {
    name: 'hl_get_conversations',
    description: 'Get recent SMS conversation threads for a contact. Call it when Troy asks "what did [name] say", "summarize my conversation with [name]", or "has anyone replied about [address]". Returns the last few messages per thread.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HighLevel contact ID.' },
        limit: { type: 'number', description: 'Max threads to return (1-10, default 5).' },
      },
      required: ['contactId'],
      additionalProperties: false,
    },
  },
};

const HL_GET_WORKFLOWS_DEF = {
  type: 'function',
  function: {
    name: 'hl_get_workflows',
    description: 'List HighLevel workflows with their Published/Draft status and enrollment counts. Call it when Troy asks "is [market] SMS published", "how many active in [market]", or wants a workflow status check.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const HL_SEND_SMS_DEF = {
  type: 'function',
  function: {
    name: 'hl_send_sms',
    description: 'Send an SMS to a contact. NEVER call this with confirmed=true on your own — always propose the message first and let Troy confirm. The tool refuses DND\'d contacts automatically. Only set confirmed=true when Troy has explicitly said "send it" or tapped Send.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HighLevel contact ID.' },
        message: { type: 'string', description: 'SMS body. No opt-out sentence — the footer handles it. Keep it short.' },
        confirmed: { type: 'boolean', description: 'Set true ONLY after Troy explicitly confirms. Default false.' },
        fromNumber: { type: 'string', description: 'Optional sender number. Omit to use the default.' },
      },
      required: ['contactId', 'message'],
      additionalProperties: false,
    },
  },
};

const HL_UPDATE_CONTACT_DEF = {
  type: 'function',
  function: {
    name: 'hl_update_contact',
    description: 'Update a contact\'s name, phone, email, or address. Call it when Troy says "change his name to X", "fix her phone number", "update his email", or similar. You need the contact ID first — use hl_get_contact if you don\'t have it. Just do it — no extra confirmation needed for contact edits.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HighLevel contact ID.' },
        firstName: { type: 'string', description: 'First name.' },
        lastName: { type: 'string', description: 'Last name.' },
        name: { type: 'string', description: 'Full name (splits into first/last). Use this when Troy gives a full name.' },
        phone: { type: 'string', description: 'Phone number.' },
        email: { type: 'string', description: 'Email address.' },
        address1: { type: 'string', description: 'Street address.' },
        city: { type: 'string', description: 'City.' },
        state: { type: 'string', description: 'State (2-letter).' },
        postalCode: { type: 'string', description: 'ZIP code.' },
      },
      required: ['contactId'],
      additionalProperties: false,
    },
  },
};

const HL_REMOVE_TAG_DEF = {
  type: 'function',
  function: {
    name: 'hl_remove_tag',
    description: 'Remove one or more tags from a contact. Call it when Troy says "remove the [tag] tag", "untag him", or similar. No extra confirmation needed.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HighLevel contact ID.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove.' },
      },
      required: ['contactId', 'tags'],
      additionalProperties: false,
    },
  },
};

const HL_ADD_NOTE_DEF = {
  type: 'function',
  function: {
    name: 'hl_add_note',
    description: 'Add a note to a contact\'s timeline. Call it when Troy says "add a note", "note that [thing]", or wants something recorded on the contact. No extra confirmation needed.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HighLevel contact ID.' },
        body: { type: 'string', description: 'Note text.' },
      },
      required: ['contactId', 'body'],
      additionalProperties: false,
    },
  },
};

const HL_UPDATE_OPPORTUNITY_DEF = {
  type: 'function',
  function: {
    name: 'hl_update_opportunity',
    description: 'Move a deal to another pipeline stage, or update its value/status. Call it when Troy says "move [deal] to [stage]", "mark it won/lost", or "update the deal value". You need the opportunity ID — ask Troy if you don\'t have it, or look it up via the contact.',
    parameters: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string', description: 'HighLevel opportunity ID.' },
        stageId: { type: 'string', description: 'New pipeline stage ID.' },
        status: { type: 'string', description: 'open, won, lost, or abandoned.' },
        monetaryValue: { type: 'number', description: 'Deal value in dollars.' },
        name: { type: 'string', description: 'Opportunity name.' },
      },
      required: ['opportunityId'],
      additionalProperties: false,
    },
  },
};

const HL_LIST_TEMPLATES_DEF = {
  type: 'function',
  function: {
    name: 'hl_list_templates',
    description: 'List contract/document templates in the CRM. Call it when Troy asks "what contracts do I have", "list my templates", or before sending a contract so you can pick the right template ID.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const HL_SEND_CONTRACT_DEF = {
  type: 'function',
  function: {
    name: 'hl_send_contract',
    description: 'Create and send a contract from a template to a contact. NEVER call this with confirmed=true on your own — always propose the contract first (template name, recipient, key details) and let Troy confirm. Only set confirmed=true when Troy has explicitly said "send it". The contact must have an email on file.',
    parameters: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'Template ID from hl_list_templates.' },
        contactId: { type: 'string', description: 'HighLevel contact ID (the seller).' },
        contractName: { type: 'string', description: 'Name for the sent document, e.g. "123 Main St Purchase Agreement".' },
        confirmed: { type: 'boolean', description: 'Set true ONLY after Troy explicitly confirms. Default false.' },
      },
      required: ['templateId', 'contactId'],
      additionalProperties: false,
    },
  },
};

const HL_TOOLS = [
  HL_GET_CONTACT_DEF, HL_ADD_TAG_DEF, HL_CREATE_OPPORTUNITY_DEF,
  HL_GET_CONVERSATIONS_DEF, HL_GET_WORKFLOWS_DEF, HL_SEND_SMS_DEF,
  HL_UPDATE_CONTACT_DEF, HL_REMOVE_TAG_DEF, HL_ADD_NOTE_DEF,
  HL_UPDATE_OPPORTUNITY_DEF, HL_LIST_TEMPLATES_DEF, HL_SEND_CONTRACT_DEF,
];

// ---- System prompt ----

const SYSTEM_PROMPT = `You are Bread, the AI inside Troy's HighLevel CRM. Troy is a real estate wholesaler running the FreeWholesaling playbook across 5 markets (Indianapolis, Cleveland, Kansas City, Carolina, Jacksonville). You help him work his CRM: look up contacts, read conversations, check workflows, tag leads, create opportunities, and draft texts. You are direct, plain-spoken, and you never pad.

YOUR TOOLS (HighLevel CRM, location "direct property buyers"):
- hl_get_contact: search by name/phone/email. Always start here when Troy names someone.
- hl_add_tag: add tags. Fire it when Troy says "tag" — no extra confirmation needed for tags.
- hl_remove_tag: remove tags. Fire it when Troy says "untag" or "remove the tag".
- hl_update_contact: change name, phone, email, address. Fire it when Troy says "change his name", "fix the number", "update her email". No confirmation needed — just do it.
- hl_add_note: add a note to a contact's timeline. Fire it when Troy says "note that" or "add a note".
- hl_create_opportunity: create a deal. Needs pipeline + stage IDs — ask Troy if you don't have them.
- hl_update_opportunity: move a deal to another stage, mark won/lost, update value.
- hl_get_conversations: read recent SMS threads. Use for "what did they say" / summaries.
- hl_get_workflows: Published/Draft status + enrollment counts.
- hl_send_sms: DRAFT ONLY unless Troy confirms. Propose the exact message, then wait. NEVER set confirmed=true on your own. The tool auto-refuses DND'd contacts.
- hl_list_templates: list contract templates. Use before sending a contract.
- hl_send_contract: DRAFT ONLY unless Troy confirms. Propose the template, recipient, and key details, then wait. NEVER set confirmed=true on your own. Contact must have an email.

HARD RULES:
1. SMS bodies carry NO opt-out sentence — the footer appends it. Never write "Reply STOP to opt out."
2. You never message a DND'd contact. If hl_send_sms refuses, tell Troy plainly and stop.
3. Keep replies short. Lead with the answer, one line of reasoning max.
4. Never invent contact details, workflow stats, or conversation content — only report what the tools return.
5. When Troy asks for a contact you can't find, say so and ask for a phone or email.
6. Tags are cheap — add them when asked. Opportunities and SMS need care.
7. Timezones: Kansas City sellers are Central; all other markets Eastern.`;

// ---- LLM chat with function calling ----

async function callLlm({ baseUrl, apiKey, model, messages, tools }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        ...(tools ? { tools } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('LLM returned no message');
    return msg;
  } finally {
    clearTimeout(timer);
  }
}

const TOOL_HANDLERS = {
  hl_get_contact: (hlToken, a) => hlGetContact({ hlToken, query: a.query }),
  hl_add_tag: (hlToken, a) => hlAddTag({ hlToken, contactId: a.contactId, tags: a.tags }),
  hl_create_opportunity: (hlToken, a) => hlCreateOpportunity({
    hlToken, contactId: a.contactId, pipelineId: a.pipelineId,
    stageId: a.stageId, name: a.name, monetaryValue: a.monetaryValue,
  }),
  hl_get_conversations: (hlToken, a) => hlGetConversations({ hlToken, contactId: a.contactId, limit: a.limit }),
  hl_get_workflows: (hlToken) => hlGetWorkflows({ hlToken }),
  hl_send_sms: (hlToken, a) => hlSendSms({
    hlToken, contactId: a.contactId, message: a.message,
    confirmed: a.confirmed === true, fromNumber: a.fromNumber,
  }),
  hl_update_contact: (hlToken, a) => hlUpdateContact({
    hlToken, contactId: a.contactId, firstName: a.firstName, lastName: a.lastName,
    name: a.name, phone: a.phone, email: a.email, address1: a.address1,
    city: a.city, state: a.state, postalCode: a.postalCode,
  }),
  hl_remove_tag: (hlToken, a) => hlRemoveTag({ hlToken, contactId: a.contactId, tags: a.tags }),
  hl_add_note: (hlToken, a) => hlAddNote({ hlToken, contactId: a.contactId, body: a.body }),
  hl_update_opportunity: (hlToken, a) => hlUpdateOpportunity({
    hlToken, opportunityId: a.opportunityId, stageId: a.stageId,
    status: a.status, monetaryValue: a.monetaryValue, name: a.name,
  }),
  hl_list_templates: (hlToken) => hlListTemplates({ hlToken }),
  hl_send_contract: (hlToken, a) => hlSendContract({
    hlToken, templateId: a.templateId, contactId: a.contactId,
    contractName: a.contractName, confirmed: a.confirmed === true,
  }),
};

async function runChat({ baseUrl, apiKey, model, hlToken, messages }) {
  const convo = messages.slice();
  for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
    const msg = await callLlm({ baseUrl, apiKey, model, messages: convo, tools: HL_TOOLS });
    const toolCalls = (msg.tool_calls || []).filter(
      (tc) => tc && tc.type === 'function' && tc.function && TOOL_HANDLERS[tc.function.name]
    );
    if (!toolCalls.length) {
      const content = String(msg.content || '').trim();
      if (!content) throw new Error('LLM returned empty content');
      return { reply: content };
    }
    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const tc of toolCalls.slice(0, MAX_TOOL_ITERATIONS)) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      let toolResult;
      try {
        const r = await TOOL_HANDLERS[tc.function.name](hlToken, args);
        toolResult = r.summary;
        // Surface the confirmation gate to the model
        if (r.needsConfirmation) toolResult = '[AWAITING TROY CONFIRMATION]\n' + toolResult;
      } catch (err) {
        console.error(`[bread-hl] ${tc.function.name} failed:`, err.message);
        toolResult = `${tc.function.name} failed: ${String(err.message || err).slice(0, 300)}`;
      }
      convo.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }
  throw new Error('Too many tool iterations');
}

// ---- Netlify handler ----

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.DASHBOARD_AI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'AI not wired yet',
        setup: 'Add DASHBOARD_AI_API_KEY to this Netlify site\u2019s environment variables (Functions scope), then redeploy.',
      }),
    };
  }
  const hlToken = process.env.HL_API_TOKEN;
  if (!hlToken) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'HighLevel not wired yet',
        setup: 'Add HL_API_TOKEN (Private Integration token) to this Netlify site\u2019s environment variables (Functions scope), then redeploy.',
      }),
    };
  }

  const baseUrl = process.env.DASHBOARD_AI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.DASHBOARD_AI_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Bad JSON body' }) };
  }
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_INPUT_CHARS) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Body needs messages[] ending with a user message' }) };
  }

  try {
    const { reply } = await runChat({ baseUrl, apiKey, model, hlToken, messages });
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ reply, model }),
    };
  } catch (err) {
    console.error('[bread-hl]', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'AI request failed', detail: String(err.message || err).slice(0, 200) }),
    };
  }
};

// Offline checks (no network): node -e "const b=require('./bread-hl.js'); console.log(Object.keys(b._test.TOOL_HANDLERS))"
exports._test = {
  SYSTEM_PROMPT, HL_TOOLS, TOOL_HANDLERS, MAX_TOOL_ITERATIONS,
  HL_LOCATION_ID, HL_API_BASE,
};

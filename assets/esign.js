// assets/esign.js — "Send for Signature" sheet (Nov 11, 2026).
// HighLevel signing surfaced in the dashboard. FREE — no paid vendor, no
// per-envelope fee. The sheet: pick one of Troy's 9 HL templates -> the
// dashboard validates the contract fields on the HL contact -> creates a
// DRAFT first -> checks the draft's signature fields -> only then, on
// Troy's confirm tap, sends by email (seller + Troy CC'd) and
// texts the seller their HL signing link. Nothing sends without the
// confirm tap, and there is NO test mode for HL signing — a send is a
// real, legally binding signing request. "Prepare" is the safe dry-run.
// Field placement stays Troy's: the dashboard verifies fields, never
// places them. Contract text comes only from the HL template.
(function () {
  'use strict';

  var ESIGN_FN = '/.netlify/functions/esign';
  var current = null; // { leadId, contactId, templates, envelope, fieldsCheck }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(v) {
    var n = Number(String(v || '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) return String(v || '—');
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function findLead(id) {
    // index.html declares `let leads = []` — a top-level `let` creates NO
    // window.leads, so window-only lookup always misses. Read the bare
    // global first (same pattern as assets/mail.js).
    var list = (typeof leads !== 'undefined' ? leads : (window.leads || window.LEADS || []));
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  async function callEsign(action, body) {
    var url = ESIGN_FN + '?action=' + encodeURIComponent(action);
    var opts = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    var res = await fetch(url, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = new Error((data && data.error) || ('Request failed (HTTP ' + res.status + ').'));
      err.data = data;
      throw err;
    }
    return data;
  }

  function renderError(msg) {
    var b = document.getElementById('esignBody');
    if (b) b.innerHTML = '<p style="color:#d33;font-weight:600">Could not load the signature sheet: ' + esc(msg) + ' Nothing was changed.</p>';
  }

  function stateLabel(state) {
    var map = { prepared: 'Prepared', draft: 'Draft ready — not sent', 'fields-blocked': 'BLOCKED — fields missing', sent: 'Sent — awaiting signature', viewed: 'Viewed by seller', completed: 'Signed — complete', accepted: 'Signed — accepted' };
    return map[state] || state || '—';
  }

  function renderSheet() {
    var b = document.getElementById('esignBody');
    if (!b || !current) return;
    var lead = current.lead;
    var env = current.envelope;
    var fc = current.fieldsCheck;
    var html = '';
    html += '<p style="color:var(--muted);font-size:13px;margin-top:0">HighLevel signing — <b>$0, no per-signature fee</b>. The seller signs on HighLevel\'s signing page from the link they are emailed; you watch it here. Contract text comes only from your HighLevel template — nothing is invented.</p>';
    html += '<p style="background:#fff3cd;border:1px solid #e6c34d;border-radius:8px;padding:10px 12px;font-size:13px;margin:8px 0"><b>⚠️ A send is REAL.</b> HighLevel signing has no test mode. Preparing a draft sends nothing; sending emails a legally binding signing request to the seller and Troy.</p>';
    if (current.staleTemplates) {
      html += '<p style="color:#a60;font-size:13px">Live template list failed — showing the 9 templates verified Nov 11, 2026. Verify in HighLevel before sending.</p>';
    }
    // Unlinked lead — manual HighLevel contact link (Nov 11 fix: nothing
    // in the repo ever set lead.ghlContactId, so the v1 sheet dead-ended
    // here for every lead. The sheet opens; Troy pastes the id instead.)
    if (!current.contactId) {
      html += '<div class="sec-title" style="font-size:14px">🔗 HighLevel contact</div>';
      html += '<p style="font-size:13px;color:var(--muted);margin:4px 0 6px">This lead has no HighLevel contact linked yet. Paste the contact ID — open the contact in HighLevel and copy the ID at the end of the page URL (after /contacts/).</p>';
      html += '<input id="esignContactId" type="text" placeholder="HighLevel contact ID" value="' + esc(current.manualContactId || '') + '" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px" autocomplete="off" spellcheck="false">';
    }
    // Template picker
    html += '<div class="sec-title" style="font-size:14px">📄 Contract template</div>';
    html += '<select id="esignTemplate" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px">';
    (current.templates || []).forEach(function (t) {
      var sel = env && env.templateId === t.id ? ' selected' : '';
      html += '<option value="' + esc(t.id) + '"' + sel + '>' + esc(t.name) + '</option>';
    });
    html += '</select>';
    // Contract summary (read-only — edits happen on the HL contact)
    if (env && env.contract) {
      var c = env.contract;
      html += '<div class="sec-title" style="font-size:14px;margin-top:14px">🧾 Contract — auto-filled from the HighLevel contact</div>';
      html += '<table style="width:100%;font-size:14px;border-collapse:collapse">'
        + '<tr><td style="padding:4px 0;color:var(--muted)">Price</td><td style="text-align:right"><b>' + esc(money(c.price)) + '</b></td></tr>'
        + '<tr><td style="padding:4px 0;color:var(--muted)">EMD</td><td style="text-align:right"><b>' + esc(money(c.emd)) + '</b></td></tr>'
        + '<tr><td style="padding:4px 0;color:var(--muted)">APN</td><td style="text-align:right">' + esc(c.apn) + '</td></tr>'
        + '<tr><td style="padding:4px 0;color:var(--muted)">Legal description</td><td style="text-align:right">' + esc(c.legal) + '</td></tr>'
        + '<tr><td style="padding:4px 0;color:var(--muted)">County</td><td style="text-align:right">' + esc(c.county) + '</td></tr>'
        + '<tr><td style="padding:4px 0;color:var(--muted)">Contract date</td><td style="text-align:right">' + esc(c.contractDate || '—') + '</td></tr>'
        + '<tr><td style="padding:4px 0;color:var(--muted)">Closing date (contract + 30 days)</td><td style="text-align:right"><b>' + esc(c.closingDate || '—') + '</b></td></tr>'
        + '</table>';
      if (current.disclosure && current.disclosure.required) {
        // Ohio SB 155 ENFORCEMENT (Nov 11 cleanup): the server blocks
        // the contract send until the signed disclosure shows in
        // HighLevel — this line reports that live state.
        if (current.disclosure.signed) {
          html += '<p style="color:#1a7f37;font-size:13px;font-weight:600">✅ Ohio SB 155 disclosure: SIGNED in HighLevel for this seller — the contract send is allowed.</p>';
        } else {
          html += '<p style="color:#d33;font-size:13px;font-weight:600">⛔ Ohio SB 155: the wholesaler disclosure is NOT signed yet for this seller. Send is BLOCKED until the signed disclosure shows in HighLevel — send the "' + esc('WHOSALER DISCLOSURE STATEMENT OH') + '" document first, let the seller sign it, then send this contract.</p>';
        }
      } else if (current.disclosureReminder) {
        html += '<p style="color:#a60;font-size:13px">Ohio deal — the SB 155 wholesaler disclosure (boldface, ≥12pt) must be in the template before the contract binds. Confirm it is in your template.</p>';
      }
      // Signers
      html += '<div class="sec-title" style="font-size:14px;margin-top:14px">✍️ Signers</div>';
      html += '<ul style="margin:0;padding-left:18px;font-size:14px">';
      (env.signers || []).forEach(function (s) {
        html += '<li><b>' + esc(s.name) + '</b> — ' + esc(s.role) + (s.email ? ' · ' + esc(s.email) : '') + (s.note ? '<br><span style="color:var(--muted);font-size:12px">' + esc(s.note) + '</span>' : '') + '</li>';
      });
      html += '</ul>';
      if (env.draftRecipients && env.draftRecipients.length) {
        html += '<p style="font-size:13px;color:var(--muted)">Recipients on the HighLevel draft: ' + esc(env.draftRecipients.map(function (r) { return r.contactName || r.id; }).join(', ')) + '. Check co-sellers are listed.</p>';
      }
    }
    // Fields check — signatures are the requirement; dates are NOT
    // required (the contracts already carry right-now dates). The
    // HighLevel API does not expose signature fields at all (verified
    // live Nov 11, 2026 — it projects only Text/Date fields, even on a
    // document a signer already signed), so an unverifiable check is
    // ADVISORY: amber, not a block. The send then unlocks only on the
    // confirmation checkbox below, where Troy confirms he checked the
    // Signature fields in HighLevel himself.
    if (fc) {
      if (fc.ready) {
        html += '<p style="color:#1a7f37;font-weight:600;margin:12px 0 4px">✅ Fields check passed — a Signature field for every signer is visible on the draft. (Dates are already set on the contract — not checked.)</p>';
      } else if (fc.advisory) {
        html += '<p style="color:#a60;font-weight:600;margin:12px 0 4px">⚠️ Fields check — ADVISORY: HighLevel\'s API cannot see this contract\'s signature fields, so the dashboard cannot verify them.</p>';
        if (fc.reason) html += '<p style="font-size:13px;color:var(--muted)">' + esc(fc.reason) + '</p>';
        if ((fc.unverified || fc.missing || []).length) {
          html += '<p style="font-size:13px;margin:4px 0 2px">Not visible via the API:</p>';
          html += '<ul style="margin:0 0 8px;padding-left:18px;font-size:13px">';
          (fc.unverified || fc.missing).forEach(function (m) { html += '<li>' + esc(m) + '</li>'; });
          html += '</ul>';
        }
        html += '<p style="font-size:13px">Open the draft in HighLevel and confirm the Signature field for every signer is placed — then tick the confirmation below to unlock Send.' + (current.hlDocumentsUrl ? ' <a href="' + esc(current.hlDocumentsUrl) + '" target="_blank" rel="noopener">📄 Open draft in HighLevel ↗</a>' : '') + '</p>';
      } else {
        html += '<p style="color:#d33;font-weight:600;margin:12px 0 4px">⛔ Fields check FAILED — this contract cannot be sent.</p>';
        html += '<ul style="margin:0 0 8px;padding-left:18px;font-size:13px;color:#d33">';
        (fc.missing || []).forEach(function (m) { html += '<li>' + esc(m) + '</li>'; });
        html += '</ul>';
        if (fc.reason) html += '<p style="font-size:13px;color:var(--muted)">' + esc(fc.reason) + ' Place the fields in HighLevel, then prepare again.</p>';
      }
    }
    // Missing contract fields
    if (current.missing && current.missing.length) {
      html += '<p style="color:#d33;font-weight:600">⛔ Contract is not ready — fill these on the HighLevel contact first:</p>';
      html += '<ul style="margin:0;padding-left:18px;font-size:13px;color:#d33">';
      current.missing.forEach(function (m) { html += '<li>' + esc(m) + '</li>'; });
      html += '</ul>';
    }
    // Status / audit
    if (env) {
      html += '<div class="sec-title" style="font-size:14px;margin-top:14px">📋 Status — ' + esc(stateLabel(env.state)) + '</div>';
      if (env.sms) html += '<p style="font-size:13px">' + (env.sms.sent ? '📱 Signing link texted to the seller.' : esc(env.sms.reason || 'Signing link sent by email only.')) + '</p>';
      if (env.events && env.events.length) {
        html += '<ul style="margin:0;padding-left:18px;font-size:13px;color:var(--muted)">';
        env.events.slice(-6).forEach(function (e) { html += '<li>' + esc(e.at) + ' — ' + esc(e.action) + ': ' + esc(e.detail || '') + '</li>'; });
        html += '</ul>';
      }
    }
    // Actions
    html += '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">';
    if (!env) {
      html += '<button class="btn primary" onclick="esignPrepare()">1️⃣ Prepare draft — sends nothing</button>';
    } else if (env.state === 'fields-blocked' && !(fc && fc.advisory)) {
      html += '<button class="btn primary" onclick="esignPrepare(true)">↻ Prepare again after fixing fields in HighLevel</button>';
    } else if (env.state === 'draft' || env.state === 'fields-blocked') {
      html += '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;width:100%"><input type="checkbox" id="esignFieldsConfirmed" style="margin-top:3px"> I checked in HighLevel — the Signature field for every signer is placed on this contract.' + ((fc && fc.advisory) ? ' I understand HighLevel\'s API cannot show signature fields, so this confirmation is the check.' : '') + ' (Dates are already set on the contract.)</label>';
      html += '<button class="btn primary" onclick="esignSend()">✍️ 2️⃣ Send for signature — real contract</button>';
      html += '<button class="btn" onclick="esignCloseSheet()">Close</button>';
    } else {
      html += '<button class="btn" onclick="esignRefresh()">↻ Check signing status</button>';
      html += '<button class="btn" onclick="esignCloseSheet()">Close</button>';
    }
    // One-tap preview (Nov 12): drafts carry no link from the HL API,
    // so this opens the location's Documents & Contracts list in
    // HighLevel, where the prepared draft is the newest row.
    if (env && current.hlDocumentsUrl) {
      html += '<a class="btn" href="' + esc(current.hlDocumentsUrl) + '" target="_blank" rel="noopener">📄 Open draft in HighLevel ↗</a>';
    }
    html += '</div>';
    if (env && (env.state === 'draft' || env.state === 'fields-blocked')) {
      html += '<p style="font-size:12px;color:var(--muted)">Sending emails the contract to the seller and Troy at the same time, and texts the seller their signing link (unless they are DND).</p>';
    }
    b.innerHTML = html;
  }

  window.esignOpenSheet = async function (leadId) {
    var lead = findLead(leadId);
    if (!lead) { alert('Lead not found.'); return; }
    var contactId = lead.ghlContactId || lead.hlContactId || null;
    current = { leadId: leadId, lead: lead, contactId: contactId, templates: [], envelope: null, fieldsCheck: null, missing: [], staleTemplates: false, disclosureReminder: false, disclosure: null, hlDocumentsUrl: '' };
    var modal = document.getElementById('esignModal');
    if (modal) modal.classList.add('open');
    var b = document.getElementById('esignBody');
    if (b) b.innerHTML = '<p style="color:var(--muted)">Loading your HighLevel templates…</p>';
    // No linked contact is no longer a dead end (Nov 11 fix): the sheet
    // opens with a manual contact-ID field instead. current.contactId
    // stays null until a Prepare succeeds with an entered id.
    current.manualContactId = '';
    try {
      var tpl = await callEsign('templates');
      current.templates = tpl.templates || [];
      current.staleTemplates = Boolean(tpl.stale);
      // Pre-select the template matching the lead's state.
      var st = String((lead.state || lead.propertyState || '')).toUpperCase();
      var match = null;
      current.templates.forEach(function (t) {
        var name = String(t.name || '').toUpperCase();
        if (!match && st && name.indexOf(st) !== -1) match = t;
        if (!match && st === 'MO' && name.indexOf(' KC') !== -1) match = t;
        if (!match && st === 'KS' && name.indexOf(' KC') !== -1) match = t;
      });
      if (match) current.preferredTemplateId = match.id;
      renderSheet();
      // Pre-select in the dropdown.
      var sel = document.getElementById('esignTemplate');
      if (sel && current.preferredTemplateId) sel.value = current.preferredTemplateId;
    } catch (e) {
      renderError(e.message || 'Could not load templates.');
    }
  };

  window.esignPrepare = async function (retry) {
    if (!current) return;
    var sel = document.getElementById('esignTemplate');
    var templateId = (sel && sel.value) || (current.envelope && current.envelope.templateId) || current.preferredTemplateId || '';
    if (!templateId) { alert('Pick a contract template first.'); return; }
    // Manual link (Nov 11 fix): an unlinked lead uses the id typed into
    // the sheet. Empty still blocks; an unknown id fails closed on
    // prepare's own HighLevel lookup error — it can never send.
    var idInput = document.getElementById('esignContactId');
    var manualId = idInput ? String(idInput.value || '').trim() : (current.manualContactId || '');
    var contactId = current.contactId || manualId;
    if (!contactId) { alert('Enter the HighLevel contact ID first — open the contact in HighLevel and copy the ID at the end of the page URL.'); return; }
    current.manualContactId = manualId;
    var b = document.getElementById('esignBody');
    if (b) b.innerHTML = '<p style="color:var(--muted)">Preparing the draft — validating contract fields and checking signature fields. Nothing is being sent…</p>';
    try {
      var res = await callEsign('prepare', {
        action: 'prepare',
        contactId: contactId,
        leadId: current.leadId,
        templateId: templateId,
        contractDate: new Date().toISOString().slice(0, 10),
        forceNew: Boolean(retry),
      });
      current.envelope = res.envelope;
      if (res.hlDocumentsUrl) current.hlDocumentsUrl = res.hlDocumentsUrl;
      current.fieldsCheck = res.fieldsCheck || (res.envelope && res.envelope.fieldsCheck) || null;
      current.disclosureReminder = Boolean(res.disclosureReminder);
      current.disclosure = res.disclosure || (res.envelope && res.envelope.disclosure) || null;
      current.missing = [];
      // Link sticks: a successful prepare with a manually entered id
      // persists it on the lead, so the next open is already linked.
      if (!current.contactId) {
        current.contactId = contactId;
        if (current.lead) current.lead.ghlContactId = contactId;
        try { if (typeof window.saveState === 'function') window.saveState(); } catch (e) {}
      }
      renderSheet();
    } catch (e) {
      if (e && e.data && e.data.missing) { current.missing = e.data.missing; renderSheet(); return; }
      // Duplicate-guard reopen (Nov 11 late): a repeat Prepare inside
      // 24h gets a 409 that carries the EXISTING envelope. Adopt it —
      // the sheet reopens on the already-prepared draft and Send is
      // reachable again, instead of dead-ending on the error text.
      // Nothing new is created and nothing is sent by adopting it.
      if (e && e.data && e.data.code === 'duplicate_envelope' && e.data.envelope) {
        current.envelope = e.data.envelope;
        if (e.data.hlDocumentsUrl) current.hlDocumentsUrl = e.data.hlDocumentsUrl;
        current.fieldsCheck = e.data.envelope.fieldsCheck || null;
        current.disclosureReminder = Boolean(e.data.disclosureReminder);
        current.disclosure = e.data.disclosure || e.data.envelope.disclosure || null;
        current.missing = [];
        renderSheet();
        return;
      }
      renderError(e.message || 'Prepare failed.');
    }
  };

  window.esignSend = async function () {
    if (!current || !current.envelope) return;
    var box = document.getElementById('esignFieldsConfirmed');
    if (!box || !box.checked) {
      alert('Confirm you checked the Signature fields in HighLevel first — that checkbox is the guard that stops a field-less contract going out. (Dates are already set on the contract.)');
      return;
    }
    // No native confirm dialog here (removed Nov 11): the in-sheet
    // checkbox above IS the send confirmation. A native popup is
    // auto-dismissed as Cancel in automated browsers, which blocked
    // the sheet send entirely; the checkbox guard remains in place.
    var b = document.getElementById('esignBody');
    if (b) b.innerHTML = '<p style="color:var(--muted)">Sending the contract…</p>';
    try {
      // Advisory check (the API cannot see signature fields): the
      // checkbox doubles as Troy's explicit acceptance of the advisory.
      var advisory = Boolean(current.fieldsCheck && current.fieldsCheck.advisory);
      var res = await callEsign('send', { action: 'send', envelopeId: current.envelope.id, fieldsConfirmed: true, fieldsAdvisoryAccepted: advisory });
      current.envelope = res.envelope;
      if (res.hlDocumentsUrl) current.hlDocumentsUrl = res.hlDocumentsUrl;
      renderSheet();
    } catch (e) {
      renderError(e.message || 'Send failed. Nothing was changed on the seller side if the error came before the send.');
    }
  };

  window.esignRefresh = async function () {
    if (!current || !current.envelope) return;
    try {
      var res = await callEsign('refresh', { action: 'refresh', envelopeId: current.envelope.id });
      current.envelope = res.envelope;
      if (res.hlDocumentsUrl) current.hlDocumentsUrl = res.hlDocumentsUrl;
      renderSheet();
    } catch (e) {
      renderError(e.message || 'Status check failed.');
    }
  };

  window.esignCloseSheet = function () {
    var modal = document.getElementById('esignModal');
    if (modal) modal.classList.remove('open');
    current = null;
  };
})();

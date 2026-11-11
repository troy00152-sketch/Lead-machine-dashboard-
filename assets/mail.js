// assets/mail.js — Direct-mail postcard UI for the Command Center.
// "Send Mail" button lives in the lead modal (index.html, openLead).
// The confirm sheet shows: template picker (built-in + Troy's customs),
// a live preview of the selected design (front + back, rendered with the
// lead's own name/address), size picker, editable recipient address,
// per-piece price + month spend vs the $100 hard cap, and a confirm
// button. Nothing sends without Troy's confirm tap.
//
// The active template choice is stored SERVER-SIDE (mail-templates
// function + Blobs), never in browser localStorage. No PostGrid keys ever
// reach this file — the browser only talks to the Netlify functions.
'use strict';

let mailState = null; // { lead, templates, activeId, status, size, templateId }

function mailMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}

async function mailFetch(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

function mailLeadVars(l) {
  return {
    ownerName: (l.ownerName || l.owner1Name || '').trim(),
    propertyAddress: (l.address || '').trim(),
    cityStateZip: [l.city, l.state, l.zip].filter(Boolean).join(', '),
  };
}

function mailOpenSheet(id) {
  const l = (typeof leads !== 'undefined' ? leads : []).find((x) => x.id === id);
  if (!l) return;
  mailState = { lead: l, templates: [], activeId: 'cash-offer', status: null, size: '4x6', templateId: null };
  document.getElementById('mailBody').innerHTML =
    '<p style="color:var(--muted)">Loading designs + this month’s mail spend…</p>';
  document.getElementById('mailModal').classList.add('open');
  // Load the two reads independently (Nov 11 fix): a failed spend/status
  // read must not blank the whole sheet the way Promise.all did — the
  // picker + preview still render, with a warning, and the $100 cap is
  // re-checked server-side before any send. A failed template list is
  // still fatal (there is nothing to pick without it).
  Promise.allSettled([
    mailFetch('/.netlify/functions/mail-templates?action=list'),
    mailFetch('/.netlify/functions/mail-send?action=status'),
  ]).then(([tplRes, statusRes]) => {
    if (tplRes.status !== 'fulfilled') {
      document.getElementById('mailBody').innerHTML =
        '<p style="color:#ff8080">Could not load the mail sheet: ' +
        esc(String((tplRes.reason && tplRes.reason.message) || tplRes.reason)) + '</p>';
      return;
    }
    const tpl = tplRes.value;
    mailState.templates = tpl.templates || [];
    mailState.activeId = tpl.activeId || 'cash-offer';
    mailState.templateId = mailState.activeId;
    mailState.status = statusRes.status === 'fulfilled'
      ? statusRes.value
      : {
        testMode: true, capCents: 10000, spentCents: 0, count: 0,
        prices: { '4x6': 90.2, '6x9': 102.3 }, statusUnavailable: true,
      };
    mailRenderSheet();
  });
}

function closeMailSheet() {
  document.getElementById('mailModal').classList.remove('open');
}

function mailSelectedTemplate() {
  return (mailState.templates || []).find((t) => t.id === mailState.templateId)
    || (mailState.templates || [])[0]
    || null;
}

function mailRenderSheet() {
  const l = mailState.lead;
  const st = mailState.status || {};
  const vars = mailLeadVars(l);
  const tpl = mailSelectedTemplate();
  const price = (st.prices && st.prices[mailState.size]) || (mailState.size === '6x9' ? 102.3 : 90.2);
  const spent = st.spentCents || 0;
  const cap = st.capCents || 10000;
  const remaining = Math.max(0, cap - spent);
  const overCap = spent + price > cap;
  const pct = Math.min(100, Math.round((spent / cap) * 100));

  const cards = (mailState.templates || []).map((t) => {
    const active = tpl && t.id === tpl.id;
    return `<div onclick="mailPickTemplate('${esc(t.id)}')" style="cursor:pointer;border:2px solid ${active ? 'var(--accent,#2f81f7)' : 'var(--line)'};border-radius:10px;padding:10px 12px;${active ? 'background:var(--panel2)' : ''}">`
      + `<div style="font-weight:800;font-size:13px">${esc(t.name)} ${t.builtin ? '' : '<span style="color:var(--muted);font-weight:400">(custom)</span>'}</div>`
      + `<div style="color:var(--muted);font-size:12px;margin-top:2px">${esc(t.blurb || '')}</div>`
      + (t.builtin ? '' : ` <button class="btn ghost" style="padding:2px 8px;margin-top:6px" onclick="event.stopPropagation();mailRemoveCustom('${esc(t.id)}')">Remove</button>`)
      + `</div>`;
  }).join('');

  document.getElementById('mailBody').innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <span class="badge ${st.testMode === false ? 'red' : 'gray'}" style="font-size:11px">${st.testMode === false ? '● LIVE MODE' : '● TEST MODE — nothing really mails'}</span>
      <span style="color:var(--muted);font-size:12px">Month spend ${mailMoney(spent)} of ${mailMoney(cap)} cap (${pct}%) · ${st.count || 0} sent</span>
    </div>
    ${st.statusUnavailable ? '<p style="color:#ffc845;font-size:12px;margin:0 0 10px">Month spend could not be loaded — shown as $0. The $100 cap is still enforced when you send.</p>' : ''}
    <div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;height:10px;overflow:hidden;margin-bottom:14px"><div style="height:100%;width:${pct}%;background:${overCap ? '#ff4d4d' : 'var(--accent,#2f81f7)'}"></div></div>
    <div class="sec-title" style="font-size:14px;margin:0 0 8px">✉️ Pick a design</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">${cards}</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <label style="font-size:13px">Size</label>
      <button class="btn ${mailState.size === '4x6' ? 'primary' : ''}" onclick="mailPickSize('4x6')">4×6 — ${mailMoney((st.prices && st.prices['4x6']) || 90.2)}</button>
      <button class="btn ${mailState.size === '6x9' ? 'primary' : ''}" onclick="mailPickSize('6x9')">6×9 — ${mailMoney((st.prices && st.prices['6x9']) || 102.3)}</button>
      <span style="color:var(--muted);font-size:12px">per postcard, print + postage</span>
    </div>
    <div class="sec-title" style="font-size:14px;margin:0 0 8px">👀 Preview — ${tpl ? esc(tpl.name) : ''}</div>
    <div id="mailPreviewBox"><p style="color:var(--muted);font-size:13px">Loading preview…</p></div>
    <div class="sec-title" style="font-size:14px;margin:14px 0 8px">📬 Send to</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <input class="field" id="mailOwner" placeholder="Owner name" value="${esc(vars.ownerName)}">
      <input class="field" id="mailAddr1" placeholder="Street address" value="${esc(l.address || '')}">
      <input class="field" id="mailCity" placeholder="City" value="${esc(l.city || '')}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input class="field" id="mailState" placeholder="ST" value="${esc(l.state || '')}" maxlength="2">
        <input class="field" id="mailZip" placeholder="ZIP" value="${esc(l.zip || '')}" maxlength="10">
      </div>
    </div>
    <div id="mailCustomBox" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
      <div class="sec-title" style="font-size:14px;margin:0 0 8px">🎨 Add your own design</div>
      <p style="color:var(--muted);font-size:12px;margin-bottom:8px">Paste a PostGrid template id (template_…), an https link to a 2-page PDF or image, or raw HTML for the front and back.</p>
      <div style="display:grid;gap:8px">
        <input class="field" id="mailCustomName" placeholder="Design name (e.g. My Christmas card)">
        <input class="field" id="mailCustomFront" placeholder="Front — tpl_… / https://…pdf / <html>…">
        <input class="field" id="mailCustomBack" placeholder="Back — tpl_… / https://…pdf / <html>…">
        <div><button class="btn" onclick="mailAddCustom()">Save custom design</button></div>
      </div>
    </div>
    <div id="mailMsg" style="margin-top:12px"></div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <button class="btn primary" id="mailConfirmBtn" onclick="mailConfirmSend()" ${overCap ? 'disabled' : ''}>${overCap ? '⛔ Over monthly cap' : '✉️ Send postcard — ' + mailMoney(price)}</button>
      <button class="btn ghost" onclick="closeMailSheet()">Cancel</button>
    </div>
    ${overCap ? '<p style="color:#ff8080;font-size:13px;margin-top:8px">This send would pass the $100 monthly cap. Raise the cap or wait until next month.</p>' : ''}
    <p style="color:var(--muted);font-size:12px;margin-top:8px">The postcard is created at PostGrid the moment you confirm. ${st.testMode === false ? 'LIVE MODE — this mails a real postcard and charges your PostGrid account.' : 'Test mode — no real mail, no charge.'}</p>`;
  mailLoadPreview();
}

function mailPreviewScale(size) {
  // Template HTML is sized in inches (96dpi): 4x6 -> 600px wide, 6x9 -> 888px.
  const pageW = size === '6x9' ? 888 : 600;
  const pageH = size === '6x9' ? 600 : 408;
  const boxW = 600; // preview column width
  const s = Math.min(1, boxW / pageW);
  return { scale: s, height: Math.round(pageH * s) + 8 };
}

function mailLoadPreview() {
  const tpl = mailSelectedTemplate();
  const box = document.getElementById('mailPreviewBox');
  if (!tpl || !box) return;
  const vars = mailLeadVars(mailState.lead);
  const q = new URLSearchParams({
    action: 'preview',
    templateId: tpl.id,
    size: mailState.size,
    ownerName: vars.ownerName,
    propertyAddress: vars.propertyAddress,
    cityStateZip: vars.cityStateZip,
  });
  mailFetch('/.netlify/functions/mail-templates?' + q.toString())
    .then((p) => {
      const sc = mailPreviewScale(mailState.size);
      const frame = (label) => {
        return `<div style="margin-bottom:8px"><div style="color:var(--muted);font-size:12px;margin-bottom:4px">${label}</div>`
          + `<iframe style="width:100%;height:${sc.height}px;border:1px solid var(--line);border-radius:8px;background:#fff" scrolling="no"></iframe></div>`;
      };
      box.innerHTML = frame('Front') + frame('Back');
      const frames = box.querySelectorAll('iframe');
      if (frames[0]) frames[0].srcdoc = p.front.replace('</head>', `<style>body{transform:scale(${sc.scale});transform-origin:0 0}</style></head>`);
      if (frames[1]) frames[1].srcdoc = p.back.replace('</head>', `<style>body{transform:scale(${sc.scale});transform-origin:0 0}</style></head>`);
    })
    .catch((e) => {
      box.innerHTML = '<p style="color:#ff8080">Preview failed: ' + esc(String((e && e.message) || e)) + '</p>';
    });
}

function mailPickTemplate(id) {
  mailState.templateId = id;
  // Persist the choice server-side as the active template.
  mailFetch('/.netlify/functions/mail-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setActive', templateId: id }),
  }).catch(() => { /* active-save is best-effort; the send uses the picked id */ });
  mailRenderSheet();
}

function mailPickSize(size) {
  mailState.size = size;
  mailRenderSheet();
}

function mailRemoveCustom(id) {
  if (!confirm('Remove this custom design?')) return;
  mailFetch('/.netlify/functions/mail-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'removeCustom', templateId: id }),
  })
    .then(() => mailOpenSheet(mailState.lead.id))
    .catch((e) => mailShowMsg('Could not remove: ' + String((e && e.message) || e), true));
}

function mailAddCustom() {
  const name = (document.getElementById('mailCustomName') || {}).value || '';
  const front = (document.getElementById('mailCustomFront') || {}).value || '';
  const back = (document.getElementById('mailCustomBack') || {}).value || '';
  mailFetch('/.netlify/functions/mail-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'addCustom', name, front, back }),
  })
    .then((r) => {
      mailShowMsg('Custom design saved: ' + (r.template && r.template.name ? r.template.name : 'ok'));
      mailOpenSheet(mailState.lead.id);
    })
    .catch((e) => mailShowMsg('Could not save: ' + String((e && e.message) || e), true));
}

function mailShowMsg(msg, isErr) {
  const box = document.getElementById('mailMsg');
  if (box) box.innerHTML = `<p style="color:${isErr ? '#ff8080' : 'var(--green)'};font-size:13px">${esc(msg)}</p>`;
}

function mailConfirmSend() {
  const btn = document.getElementById('mailConfirmBtn');
  if (btn) btn.disabled = true;
  const l = mailState.lead;
  const body = {
    contactId: l.ghlContactId || l.hlContactId || null,
    ownerName: (document.getElementById('mailOwner') || {}).value || '',
    address1: (document.getElementById('mailAddr1') || {}).value || '',
    address2: '',
    city: (document.getElementById('mailCity') || {}).value || '',
    state: (document.getElementById('mailState') || {}).value || '',
    zip: (document.getElementById('mailZip') || {}).value || '',
    size: mailState.size,
    templateId: mailSelectedTemplate() ? mailSelectedTemplate().id : null,
    confirm: true,
  };
  mailFetch('/.netlify/functions/mail-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => {
      mailShowMsg(
        `Sent! PostGrid id ${r.postgridId} · ${r.size} postcard · ${mailMoney(r.costCents)} · month spend now ${mailMoney(r.monthSpentCents)} of ${mailMoney(r.monthCapCents)}.${r.testMode ? ' (TEST — no real mail.)' : ''}${r.hlWarning ? ' ' + r.hlWarning : ''}`,
      );
      if (btn) btn.disabled = false;
      // Refresh the spend bar without losing the sheet.
      mailFetch('/.netlify/functions/mail-send?action=status')
        .then((st) => { mailState.status = st; mailRenderSheet(); })
        .catch(() => {});
    })
    .catch((e) => {
      mailShowMsg('Send failed: ' + String((e && e.message) || e), true);
      if (btn) btn.disabled = false;
    });
}

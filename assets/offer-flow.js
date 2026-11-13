// Offer Flow — one-screen lead -> price -> offer (DealBreeze takeaways #1).
// Renders ONLY the embedded, source-named data in offer-flow-data.js —
// this page computes no prices. The fire-the-offer action runs through
// netlify/functions/mail-loi.js (PostGrid letters, MAIL_MODE-gated) and
// stays locked while a lead's listing status is unverified: the
// listed-first HARD LOCK outranks convenience, in the UI as in the engine.
'use strict';

const LEADS = window.OFFER_FLOW_LEADS || [];
const $ = (id) => document.getElementById(id);
const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
let current = 0;

function scoreRing(score) {
  const c = 2 * Math.PI * 44;
  const filled = (score / 100) * c;
  return `<svg width="104" height="104" viewBox="0 0 104 104">
    <circle cx="52" cy="52" r="44" fill="none" stroke="#0c1524" stroke-width="9"/>
    <circle cx="52" cy="52" r="44" fill="none" stroke="#c9973f" stroke-width="9"
      stroke-linecap="round" stroke-dasharray="${filled} ${c}"/>
  </svg>`;
}

function renderRail() {
  $('rail').innerHTML = LEADS.map((l, i) => `
    <div class="of-lead ${i === current ? 'active' : ''}" onclick="selectLead(${i})">
      <div class="addr">${l.street}<br><span style="color:var(--dim);font-size:12.5px">Indianapolis, IN ${l.zip}</span></div>
      <div class="meta">
        <span class="arv">ARV <b>${money(l.crm.arv)}</b></span>
        <span class="score-chip" title="Seller score (evidence-based)">${l.seller_score ? l.seller_score.score : '—'}</span>
      </div>
      <div class="meta"><span class="arv">Offer (LAO) <b style="color:var(--gold2)">${money(l.crm.lao)}</b></span></div>
    </div>`).join('');
}

function factorHtml(f) {
  const pct = f.max ? Math.round((f.points / f.max) * 100) : 0;
  return `<div class="factor">
    <div class="row"><span>${f.factor.replace(/_/g, ' ')}</span><span class="pts">${f.points} / ${f.max}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="ev">${f.evidence}</div>
  </div>`;
}

function renderLead() {
  const l = LEADS[current];
  if (!l) return;
  const s = l.subject || {};
  const facts = [
    s.beds != null ? `<span class="chip"><b>${s.beds}</b> bd</span>` : '',
    s.baths != null ? `<span class="chip"><b>${s.baths}</b> ba</span>` : '',
    s.sqft ? `<span class="chip"><b>${Number(s.sqft).toLocaleString()}</b> sqft</span>` : '',
    s.year_built ? `<span class="chip">built <b>${s.year_built}</b></span>` : '',
    `<span class="chip">owner <b>${l.owner_name}</b></span>`,
  ].join('');
  $('head').innerHTML = `<h1>${l.address}</h1>
    <div class="sub">One screen: the price, the comps behind it, and the offer — no hopping between pages.</div>
    <div class="chips">${facts}</div>`;

  const verified = l.listing && l.listing.verified === true;
  $('banner').className = 'banner ' + (verified ? 'green' : 'amber');
  $('banner').innerHTML = verified
    ? `<span>✅</span><span><b>Listing verified — not listed.</b> The listed-first check cleared this lead; offers are unlocked.</span>`
    : `<span>🔒</span><span><b>Listing unverified — offers locked.</b> ${l.listing.detail}</span>`;

  const sc = l.scenarios;
  const scenRow = (name, label) => `
    <tr class="${name === 'medium' ? 'hl' : ''}">
      <td>${label}${name === 'medium' ? ' — on the CRM' : ''}</td>
      <td class="num">${money(sc[name].repairs)}</td>
      <td class="num">${money(sc[name].mao)}</td>
      <td class="num">${money(sc[name].lao)}</td>
    </tr>`;
  $('priceCard').innerHTML = `<h2>Price of record — CRM</h2>
    <div class="big-arv"><small>ARV (avg of ${l.comps_of_record.length} sold comps)</small>${money(l.crm.arv)}</div>
    <div class="offer-nums">
      <div class="offer-num hero"><div class="k">Opening offer — LAO</div><div class="v">${money(l.crm.lao)}</div></div>
      <div class="offer-num"><div class="k">Ceiling — MAO</div><div class="v">${money(l.crm.mao)}</div></div>
    </div>
    <table><tr><th>Scenario</th><th class="num">Repairs</th><th class="num">MAO</th><th class="num">LAO</th></tr>
      ${scenRow('light', 'Light')}${scenRow('medium', 'Medium')}${scenRow('heavy', 'Heavy')}
    </table>
    <div class="src">Multiplier ${(l.multiplier * 100).toFixed(1)}% (tier ${(l.tier * 100).toFixed(1)}%, Indianapolis calibration applied — calibration only lowers). Source: ${l.crm.source}.</div>`;

  const ss = l.seller_score;
  $('scoreCard').innerHTML = `<h2>Seller score — evidence, not a black box</h2>` + (ss ? `
    <div class="score-wrap">
      <div class="score-ring">${scoreRing(ss.score)}<div class="n"><b>${ss.score}</b><span>/ 100</span></div></div>
      <div><div style="font-size:15px;font-weight:700">Confidence ${ss.confidence_pct}%</div>
      <div class="src" style="margin-top:4px">Share of factors with real data behind them. Missing data lowers confidence — it never fakes points.</div></div>
    </div>
    <div style="margin-top:8px">${ss.factors.map(factorHtml).join('')}</div>`
    : '<div class="src">No score computed for this lead yet.</div>');

  const compRows = l.comps_of_record.map((c) => `
    <tr><td>${c.address}</td><td class="num">${money(c.amount)}</td><td style="color:var(--dim)">${c.detail}</td></tr>`).join('');
  const avg = l.comps_of_record.length
    ? Math.round(l.comps_of_record.reduce((a, c) => a + c.amount, 0) / l.comps_of_record.length) : null;
  const eng = l.engine_recheck;
  const engHtml = eng ? `<div class="src" style="border-top:1px solid var(--line);padding-top:10px">
      <b style="color:var(--txt)">Engine re-check (independent ATTOM run):</b>
      status ${eng.status}${eng.arv ? `, ARV ${money(eng.arv)}` : ' — no ARV (insufficient usable comps in that feed)'}.
      A re-check is shown for transparency; it never blends into the price of record.</div>` : '';
  $('compsCard').innerHTML = `<h2>Comps behind the ARV</h2>
    <table><tr><th>Sold comp</th><th class="num">Sale price</th><th>Detail</th></tr>${compRows}</table>
    <div class="src">Average of the comps of record: <b style="color:var(--txt)">${money(avg)}</b> = the ARV. Source: Nov 10 verified comp run.</div>
    ${engHtml}`;

  $('actionsCard').innerHTML = `<h2>Fire the offer</h2>
    <div class="actions">
      <button class="btn btn-gold" onclick="openLoiSheet()">✉️ Send LOI — ${money(l.crm.lao)}</button>
      <button class="btn btn-ghost" onclick="window.open('${l.loi_file}','_blank')">Preview the letter</button>
      ${verified ? '' : '<span class="lock-note">Locked until the listing check verifies.</span>'}
    </div>
    <div class="src">The LOI carries the opening offer (LAO) — the number on the lead. It sends through the
    PostGrid letter channel in <b>test mode</b>; live mail needs MAIL_MODE=live + Troy's funding step.
    The bot path is wired too: a seller who texts “make me an offer” gets this same LAO plus concrete
    times — only when the lead carries a verified price.</div>`;
  renderRail();
}

function openLoiSheet() {
  const l = LEADS[current];
  const verified = l.listing && l.listing.verified === true;
  $('loiBody').innerHTML = `
    <div class="kv">
      <span class="k">To</span><span>${l.owner_name} (owner of record)</span>
      <span class="k">Property</span><span>${l.address}</span>
      <span class="k">Offer on letter</span><span><b>${money(l.crm.lao)}</b> — the LAO on the CRM contact</span>
      <span class="k">Channel</span><span>PostGrid letter · MAIL_MODE test</span>
      <span class="k">Listing check</span><span>${verified ? 'Verified — not listed' : 'UNVERIFIED'}</span>
    </div>
    <iframe src="${l.loi_file}" title="LOI preview"></iframe>
    <div class="actions">
      <button class="btn btn-gold" ${verified ? '' : 'disabled'} onclick="sendLoi()">Send LOI (test mode)</button>
      ${verified ? '' : '<span class="lock-note">🔒 Send stays locked: the listed-first check has not verified this lead. An unverified status is never treated as cleared.</span>'}
    </div>`;
  $('loiModal').classList.add('open');
}
function closeLoiSheet() { $('loiModal').classList.remove('open'); }
async function sendLoi() {
  // Posts to the LOI function. In this local build every lead is
  // listing-unverified, so the button never enables; the function ALSO
  // refuses server-side (409 listing_unverified) — defense in depth.
  const l = LEADS[current];
  try {
    const res = await fetch('/.netlify/functions/mail-loi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirm: true, listingVerified: l.listing.verified === true,
        contactId: l.contact_id, ownerName: l.owner_name,
        propertyAddress: l.address, offerAmount: l.crm.lao,
      }),
    });
    const out = await res.json().catch(() => ({}));
    alert(out.error || (out.sent ? 'LOI created in PostGrid test mode.' : 'Send failed.'));
    if (out.sent) closeLoiSheet();
  } catch (e) {
    alert('Could not reach the mail function (local build / not deployed).');
  }
}
function selectLead(i) { current = i; renderLead(); }

document.addEventListener('DOMContentLoaded', renderLead);

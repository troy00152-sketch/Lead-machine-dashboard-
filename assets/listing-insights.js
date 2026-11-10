// listing-insights.js — Listing Insights panel logic (Nov 9, 2026).
// Pure, testable: MLS status set, LISTED-FIRST gate mapping, $/sqft,
// above/below math, and the panel HTML.
// Tests run on fixtures only — zero live API credits, zero network.
// The panel's data is hand-checked (Zillow / DealMachine) and typed in by
// Troy. No live feed: listing fields are hand-entered only (RentCast
// dropped Nov 9 — Troy: not using RentCast anymore; PropertyReach 60K
// pool only). Description and the exact inactive reason are hand-checked.
(function (root) {
  'use strict';

  // ---- Status set (mirrors the MLS statuses Troy meets) ----
  // pass: the LISTED-FIRST hard lock fires on this status — no MAO, no LAO,
  // no offer. ACTIVE (listed with a realtor), PENDING (under contract — the
  // bot seals under-contract the same way), SOLD (already sold — the seller
  // no longer owns it; matches the bot's sold seal). EXPIRED and WITHDRAWN
  // are NOT a pass — no live listing (Charday Cooke precedent: EXPIRED
  // 11/01/2026 proceeded to comps). INACTIVE is "was listed, now
  // inactive, reason unknown" — never a pass until Troy confirms the reason.
  var STATUSES = {
    '':          { label: 'Not checked yet', pass: false },
    'active':    { label: 'Active — listed with a realtor', pass: true, passReason: 'Listed with a realtor' },
    'pending':   { label: 'Pending — under contract', pass: true, passReason: 'Under contract' },
    'expired':   { label: 'Expired — no live listing', pass: false },
    'withdrawn': { label: 'Withdrawn — no live listing', pass: false },
    'sold':      { label: 'Sold — already sold', pass: true, passReason: 'Already sold' },
    'inactive':  { label: 'Inactive — reason unknown (confirm)', pass: false },
    'not-listed':{ label: 'Not listed — clear to comp', pass: false },
    // Legacy value from the old binary select; treat as active.
    'listed':    { label: 'Listed with a realtor', pass: true, passReason: 'Listed with a realtor' }
  };

  function statusInfo(status) { return STATUSES[status] || STATUSES['']; }
  function isPassStatus(status) { return !!statusInfo(status).pass; }
  function passReason(status) { return statusInfo(status).passReason || ''; }
  function statusLabel(status) {
    var st = status || '';
    if (st === 'active') return '⛔ Active — listed with a realtor — PASS';
    if (st === 'pending') return '⛔ Pending — under contract — PASS';
    if (st === 'expired') return '⚠️ Expired — no live listing';
    if (st === 'withdrawn') return '⚠️ Withdrawn — no live listing';
    if (st === 'sold') return '⛔ Sold — PASS';
    if (st === 'inactive') return '⚠️ Inactive — reason unknown (confirm)';
    if (st === 'not-listed') return '✓ Not listed — clear to comp';
    if (st === 'listed') return '⛔ Listed with a realtor — PASS';
    return '⚠️ Not checked yet';
  }
  function statusDateLabel(status) {
    var st = status || '';
    if (st === 'expired') return 'Expired date';
    if (st === 'withdrawn') return 'Withdrawn date';
    if (st === 'sold') return 'Sold date';
    if (st === 'active' || st === 'pending' || st === 'listed') return 'Listed date';
    if (st === 'inactive') return 'Removed date';
    return 'Status change date';
  }

  // ---- Math (pure) ----
  function ppsf(price, sqft) {
    var p = Number(price), s = Number(sqft);
    return (p > 0 && s > 0) ? Math.round(p / s) : null;
  }
  // Above/below: list price vs a reference value (verified ARV, else AVM).
  // Returns null when either side is missing — never an invented delta.
  function aboveBelow(listPrice, refValue) {
    var lp = Number(listPrice), rv = Number(refValue);
    if (!(lp > 0) || !(rv > 0)) return null;
    var diff = lp - rv;
    var pct = Math.abs(diff / rv * 100);
    var dir = diff > 0 ? 'above' : diff < 0 ? 'below' : 'at';
    return {
      diff: diff,
      pct: pct,
      dir: dir,
      text: (diff >= 0 ? '+' : '−') + '$' + Math.abs(diff).toLocaleString('en-US')
        + ' (' + Math.floor(pct) + '% ' + dir + ' value)'
    };
  }

  // ---- Formatting (self-contained; no dashboard globals needed) ----
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Number(n);
    return (v > 0) ? '$' + Math.round(v).toLocaleString('en-US') : '—';
  }
  function fmtDate(v) {
    if (!v) return '—';
    var p = String(v).split('-');
    if (p.length === 3) return p[1] + '/' + p[2] + '/' + p[0];
    return String(v);
  }
  // ---- Panel HTML ----
  // d: {status, price, sqft, listedDate, statusDate, dom, agent, agentPhone,
  //     agentEmail, office, type, mls, description, arv, avm}. Missing data
  // renders "—", never invented. Above/below compares the list price to the
  // estimated value — AVM first (the XLeads model: "$935 (0%) above value"),
  // falling back to verified ARV when no AVM is on file; with neither
  // reference value the chip reads "—".
  function panelHtml(d) {
    d = d || {};
    var st = d.status || '';
    var lp = Number(d.price) || 0;
    var sq = Number(d.sqft) || 0;
    var ps = ppsf(lp, sq);
    var arv = Number(d.arv) || 0;
    var avm = Number(d.avm) || 0;
    var ref = avm > 0 ? { value: avm, label: 'vs AVM' } : arv > 0 ? { value: arv, label: 'vs ARV' } : null;
    var ab = (lp > 0 && ref) ? aboveBelow(lp, ref.value) : null;
    var chip = function (k, v) {
      return '<div class="prop-chip"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
    };
    var priceV = lp > 0 ? esc(money(lp)) + (ps ? ' ($' + ps + '/sqft)' : '') : '—';
    var agentV = d.agent ? esc(d.agent) : '—';
    var html = '<div class="sec-title" style="font-size:14px">📋 Listing Insights</div>'
      + '<div class="prop-grid">'
      + chip('Listing Status', esc(statusLabel(st)))
      + chip('Listing Price', priceV)
      + chip(statusDateLabel(st), d.statusDate ? esc(fmtDate(d.statusDate)) : '—')
      + chip('Listing Date', d.listedDate ? esc(fmtDate(d.listedDate)) : '—')
      + chip('Days On Market', d.dom ? esc(String(d.dom)) + ' days' : '—')
      + chip('Listing Agent', agentV)
      + chip('Agent Phone', d.agentPhone ? esc(d.agentPhone) : '—')
      + chip('Agent Email', d.agentEmail ? esc(d.agentEmail) : '—')
      + chip('Office', d.office ? esc(d.office) : '—')
      + chip('Type', d.type ? esc(d.type) : '—')
      + chip('MLS #', d.mls ? esc(d.mls) : '—')
      + chip('Above / Below Value', ab ? esc(ab.text + ' ' + ref.label) : '—')
      + '</div>';
    html += '<div style="margin-top:10px"><div style="font-size:12px;font-weight:800;color:var(--muted);margin-bottom:4px">Listing Description</div>'
      + '<div style="font-size:13px;line-height:1.5;white-space:pre-wrap">' + (d.description ? esc(d.description) : '—') + '</div></div>';
    html += '<div style="font-size:11px;color:var(--muted);margin-top:8px">Source: hand-checked — Zillow · no live feed connected.</div>';
    return html;
  }

  var api = {
    STATUSES: STATUSES,
    isPassStatus: isPassStatus,
    passReason: passReason,
    statusLabel: statusLabel,
    statusDateLabel: statusDateLabel,
    ppsf: ppsf,
    aboveBelow: aboveBelow,
    panelHtml: panelHtml
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ListingInsights = api;
})(typeof window !== 'undefined' ? window : globalThis);

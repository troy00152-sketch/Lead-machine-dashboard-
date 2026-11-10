// listing-insights.js — Listing Insights panel logic (Nov 9, 2026).
// Pure, testable: MLS status set, LISTED-FIRST gate mapping, $/sqft,
// above/below math, RentCast /listings/sale mapping, and the panel HTML.
// Tests run on fixtures only — zero live API credits, zero network.
// The panel's data is hand-checked and typed in by Troy. The live-feed seam
// is fetchListingInsights() below, ON since Nov 9 (Troy: "Turn auto-fill
// back on") on the RentCast free tier — 50 calls/mo; over 50 it bills
// $0.20/call with no hard cap, so usage stays under 50. The key lives
// server-side only (RENTCAST_API_KEY in Netlify env, read by the
// rentcast-listing proxy function) — NO key in the browser, no key field in
// Settings (Troy, Nov 9: no one may find the key when the system is sold).
// RentCast has NO description field and cannot tell EXPIRED from WITHDRAWN
// from SOLD (all "Inactive") — description and the exact inactive reason
// stay hand-checked.
(function (root) {
  'use strict';

  // ---- Status set (mirrors the MLS statuses Troy meets) ----
  // pass: the LISTED-FIRST hard lock fires on this status — no MAO, no LAO,
  // no offer. ACTIVE (listed with a realtor), PENDING (under contract — the
  // bot seals under-contract the same way), SOLD (already sold — the seller
  // no longer owns it; matches the bot's sold seal). EXPIRED and WITHDRAWN
  // are NOT a pass — no live listing (Charday Cooke precedent: EXPIRED
  // 11/01/2026 proceeded to comps). INACTIVE is RentCast's "was listed, now
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
  function isoDate(v) {
    // RentCast timestamps ("2024-06-24T00:00:00.000Z") -> "2024-06-24" for
    // the date inputs. Plain YYYY-MM-DD passes through; anything else -> ''.
    if (!v) return '';
    var s = String(v);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
  }

  // ---- RentCast /listings/sale mapping (pure; verified against the live
  // RentCast API docs 2026-11-09). Fields the endpoint documents: status
  // Active/Inactive, price, listingType, listedDate, removedDate,
  // lastSeenDate, daysOnMarket, MLS name/number, listingAgent, listingOffice,
  // history, squareFootage. It does NOT return a listing description. ----
  function mapRentcastListing(rec) {
    if (!rec || typeof rec !== 'object') return null;
    var st = rec.status === 'Active' ? 'active'
      : rec.status === 'Inactive' ? 'inactive' : '';
    return {
      status: st,
      price: rec.price != null ? Number(rec.price) : 0,
      listedDate: isoDate(rec.listedDate),
      // Status change date = when the listing left the market (null while active).
      statusDate: isoDate(rec.removedDate),
      dom: rec.daysOnMarket != null ? String(rec.daysOnMarket) : '',
      agent: (rec.listingAgent && rec.listingAgent.name) || '',
      agentPhone: (rec.listingAgent && rec.listingAgent.phone) || '',
      agentEmail: (rec.listingAgent && rec.listingAgent.email) || '',
      office: (rec.listingOffice && rec.listingOffice.name) || '',
      type: rec.propertyType || '',
      mls: rec.mlsNumber ? String(rec.mlsNumber) : '',
      sqft: rec.squareFootage != null ? Number(rec.squareFootage) : 0,
      // RentCast returns no description — stays blank for hand entry.
      description: ''
    };
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
    html += '<div style="font-size:11px;color:var(--muted);margin-top:8px">Source: hand-checked — Zillow · auto-fill on (RentCast free tier).</div>';
    return html;
  }

  // ---- Live-feed seam (OFF — needs Troy's call) ----
  // RentCast bills fixed monthly + per-request overage with no hard cap, so
  // one extra billable request per search is a spend decision, not a default.
  // When enabled: exact-address match preferred, fills only EMPTY form
  // fields (never overwrites Troy's hand entries), description stays manual.
  var LISTING_AUTOFETCH_ENABLED = true;
  function fetchListingInsights(address) {
    if (!LISTING_AUTOFETCH_ENABLED) return Promise.resolve(null);
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    if (!address) return Promise.resolve(null);
    // Server-side key: the rentcast-listing Netlify function holds the key
    // (RENTCAST_API_KEY env). The browser never sees it — no key here.
    var url = '/.netlify/functions/rentcast-listing?address=' + encodeURIComponent(address);
    return fetch(url, { headers: { 'accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j) || !j.length) return null;
        var norm = String(address).toLowerCase().replace(/[^a-z0-9]/g, '');
        var best = j[0];
        for (var i = 0; i < j.length; i++) {
          var a = ((j[i].formattedAddress || '') + '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (a && norm && (a.indexOf(norm) === 0 || norm.indexOf(a) === 0)) { best = j[i]; break; }
        }
        return mapRentcastListing(best);
      })
      .catch(function () { return null; });
  }
  function applyListingInsights(data) {
    if (!data || typeof document === 'undefined') return 0;
    var filled = 0;
    var set = function (id, val) {
      var el = document.getElementById(id);
      if (el && val !== '' && val != null && el.value === '') { el.value = val; filled++; }
    };
    if (data.status) set('compListStatus', data.status);
    if (data.price) set('compListPrice', String(data.price));
    if (data.listedDate) set('compListDate', data.listedDate);
    if (data.statusDate) set('compListStatusDate', data.statusDate);
    if (data.dom) set('compListDom', String(data.dom));
    if (data.agent) set('compListAgent', data.agent);
    if (data.agentPhone) set('compListAgentPhone', data.agentPhone);
    if (data.agentEmail) set('compListAgentEmail', data.agentEmail);
    if (data.office) set('compListOffice', data.office);
    if (data.type) set('compListType', data.type);
    if (data.mls) set('compListMls', data.mls);
    if (data.sqft) set('compListSqft', String(data.sqft));
    return filled;
  }

  var api = {
    STATUSES: STATUSES,
    LISTING_AUTOFETCH_ENABLED: LISTING_AUTOFETCH_ENABLED,
    isPassStatus: isPassStatus,
    passReason: passReason,
    statusLabel: statusLabel,
    statusDateLabel: statusDateLabel,
    ppsf: ppsf,
    aboveBelow: aboveBelow,
    mapRentcastListing: mapRentcastListing,
    panelHtml: panelHtml,
    fetchListingInsights: fetchListingInsights,
    applyListingInsights: applyListingInsights
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ListingInsights = api;
})(typeof window !== 'undefined' ? window : globalThis);

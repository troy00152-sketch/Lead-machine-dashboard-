// property-detail-view.js — Property detail view (Nov 9, 2026).
// Models the XLeads property page Troy pointed at (3326 W Michigan St,
// read Nov 9, 8:37 PM): search an address -> single-column detail panel
// with a Menu bar (Collapse All), photo carousel on top, and accordion
// sections in this order: Overview, Listing Insights, Deal Insights,
// Owner Insights, Before & After, Property Insights, Financial Insights,
// Building Insights, Construction & Materials, Loans, Transactions,
// Pre-Foreclosures. White-labeled: no XLeads/DealMachine branding anywhere
// ("Deal Insights" and "Deal AI" are our own Sellability/AI signals).
// Pure HTML builders over a `view` object — the page supplies real lookup
// data; missing data renders "—", never invented. Photos: the carousel
// shows the provider photo + Street View angles (the only photo sources
// we have — MLS interior photos have no API; the Zillow link-out is the
// path to the full set). Tests run on fixtures only — zero live calls.
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dash(v) { return (v === null || v === undefined || v === '') ? '—' : String(v); }
  function money(n) {
    var v = Number(n);
    return (v > 0 || v === 0) && n !== null && n !== undefined && n !== '' ? '$' + Math.round(v).toLocaleString('en-US') : '—';
  }
  function fmtDate(v) {
    if (!v) return '—';
    var p = String(v).split('-');
    if (p.length === 3) return p[1] + '/' + p[2] + '/' + p[0];
    return String(v);
  }
  function yearsOwned(lastSaleDate) {
    if (!lastSaleDate) return null;
    var d = new Date(String(lastSaleDate).slice(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000)));
  }
  function chip(k, v) {
    return '<div class="prop-chip"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  }
  function section(id, title, inner, isOpen) {
    return '<details data-detail-section="' + esc(id) + '"' + (isOpen ? ' open' : '') + ' style="background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px">'
      + '<summary style="font-weight:800;font-size:14px;cursor:pointer;list-style:none">' + esc(title) + '</summary>'
      + '<div style="margin-top:10px">' + inner + '</div></details>';
  }

  // ---- Photo carousel ----
  // photos: [{src, label}]. Provider photo first, then Street View angles.
  // Registers the gallery for the page lightbox (same mechanism as the
  // subject-card gallery) when running in the browser.
  function carouselHtml(photos, zillowUrl) {
    photos = (photos || []).filter(function (p) { return p && p.src; });
    var out = '';
    if (!photos.length) {
      out = '<div style="padding:12px;border:1px dashed var(--line);border-radius:10px;color:var(--muted);font-size:13px">📷 No property photo available from the feed — check the listing on Zillow for photos.</div>';
    } else {
      var gid = 'pdv' + Math.random().toString(36).slice(2, 8);
      if (typeof window !== 'undefined') {
        if (!window._compGalleries) window._compGalleries = {};
        window._compGalleries[gid] = photos;
      }
      var main = photos[0];
      var thumbs = '';
      if (photos.length > 1) {
        thumbs = '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">';
        photos.forEach(function (p, i) {
          thumbs += '<img src="' + esc(p.src) + '" alt="' + esc(p.label || '') + '" onclick="compGalleryThumb(\'' + gid + '\',' + i + ')" '
            + 'style="width:72px;height:54px;object-fit:cover;border-radius:8px;border:2px solid ' + (i === 0 ? 'var(--cyan)' : 'var(--line)') + ';cursor:pointer" '
            + 'id="' + gid + '_thumb' + i + '" onerror="this.style.display=\'none\'">';
        });
        thumbs += '</div>';
      }
      out = '<div style="margin-bottom:10px">'
        + '<img id="' + gid + '_main" src="' + esc(main.src) + '" alt="' + esc(main.label || 'Property photo') + '" '
        + 'onclick="openCompLightbox(\'' + gid + '\',0)" title="Click to zoom" '
        + 'style="width:100%;max-width:520px;border-radius:10px;border:1px solid var(--line);display:block;cursor:zoom-in" '
        + 'onerror="this.style.display=\'none\'">'
        + '<div id="' + gid + '_label" style="font-size:12px;color:var(--muted);margin-top:4px">' + esc(main.label || 'Property photo') + ' — ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' · click to zoom 🔍</div>'
        + thumbs + '</div>';
    }
    if (zillowUrl) {
      out += '<div style="font-size:12px;color:var(--muted);margin-bottom:4px"><a href="' + esc(zillowUrl) + '" target="_blank" rel="noopener">🏠 Full listing photos — inside the house, when it was listed (Zillow) ↗</a></div>';
    }
    return out;
  }

  // ---- Header ----
  function headerHtml(v) {
    var facts = [];
    if (v.beds != null && v.beds !== '') facts.push(v.beds + ' bed');
    if (v.baths != null && v.baths !== '') facts.push(v.baths + ' bath');
    if (v.sqft) facts.push(Number(v.sqft).toLocaleString('en-US') + ' sqft');
    facts.push((v.units || 1) + ' unit');
    if (v.type) facts.push(v.type);
    var phones = '';
    (v.ownerPhones || []).forEach(function (p) {
      if (!p || !p.number) return;
      phones += '<div>📞 ' + esc(p.label ? p.label + ': ' : '') + esc(p.number)
        + (p.dnc ? ' <span style="background:#3d0d0d;border:1px solid #ff4d4d;color:#ff8080;font-size:11px;font-weight:800;border-radius:6px;padding:1px 6px">DO NOT CALL</span>' : '') + '</div>';
    });
    var addr2 = ([v.city, v.state].filter(Boolean).join(', ') + (v.zip ? ' ' + v.zip : '')).trim();
    var ai = '';
    if (v.sellability && v.sellability.score != null) {
      ai = '<div style="background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px;margin:10px 0;font-size:13px">🤖 <strong>Deal AI:</strong> Sellability ' + esc(String(v.sellability.score)) + '/1000 · ' + esc(v.sellability.label || '')
        + (v.sellability.reasons && v.sellability.reasons.length ? ' — ' + esc(v.sellability.reasons.slice(0, 2).join('; ')) : '') + '</div>';
    }
    var gq = encodeURIComponent((v.address || '') + ' ' + addr2);
    return '<div style="font-size:19px;font-weight:800">' + esc(v.address || 'Property') + '</div>'
      + '<div style="color:var(--muted);font-size:13px;margin:2px 0 8px">' + esc(addr2) + (v.county ? ' · ' + esc(v.county) : '') + '</div>'
      + '<div style="font-size:13px;margin-bottom:8px">' + esc(facts.join(' · ') || '—') + '</div>'
      + carouselHtml(v.photos || [], v.zillowUrl || '')
      + '<div style="font-size:13px;line-height:1.6;margin-bottom:8px">'
      + '<div>👤 <strong>' + esc(v.owner || '—') + '</strong></div>'
      + (phones || '<div>📞 —</div>')
      + '<div>✉️ ' + esc(v.ownerEmail || '—') + '</div>'
      + '</div>'
      + ai
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">'
      + '<button class="btn" onclick="detailAddToLeads()">➕ Add to My Leads</button>'
      + '<button class="btn" onclick="detailGoBuyerMatch()">🎯 Target Match AI</button>'
      + '<button class="btn" onclick="detailGoBuyerMatch()">🤝 Buyer Match AI</button>'
      + '<button class="btn" onclick="detailGoogleResults()">🔍 Google Results</button>'
      + '<button class="btn" onclick="detailPostDeal()">📣 Post My Deal</button>'
      + '</div>';
  }

  // ---- Sections ----
  function overviewHtml(v) {
    var lot = v.lotSqft ? Number(v.lotSqft).toLocaleString('en-US') + ' sq ft' : (v.lotAcres ? v.lotAcres + ' acres' : '—');
    return '<div class="prop-grid">'
      + chip('Beds', dash(v.beds)) + chip('Baths', dash(v.baths))
      + chip('Sq Ft', v.sqft ? Number(v.sqft).toLocaleString('en-US') : '—')
      + chip('Year Built', dash(v.yearBuilt)) + chip('Type', dash(v.type))
      + chip('Units', dash(v.units || 1)) + chip('Lot Size', lot)
      + chip('Owner', dash(v.owner)) + chip('Last Sale', v.lastSale && v.lastSale.amount != null ? money(v.lastSale.amount) + (v.lastSale.date ? ' · ' + fmtDate(String(v.lastSale.date).slice(0, 10)) : '') : '—')
      + chip('APN', dash(v.apn))
      + '</div>'
      + '<div style="font-size:13px;line-height:1.5;margin-top:10px"><span style="color:var(--muted)">Legal Description:</span> ' + (v.legalDescription ? esc(v.legalDescription) : '—') + '</div>';
  }
  function dealInsightsHtml(v) {
    var s = v.sellability || {};
    if (s.score == null) return '<p style="color:var(--muted);font-size:13px">No deal signals on this record yet.</p>';
    return '<div class="prop-grid">'
      + chip('Sellability Score', esc(String(s.score)) + ' / 1000')
      + chip('Tier', dash(s.label))
      + '</div>'
      + ((s.reasons && s.reasons.length) ? '<div style="font-size:13px;margin-top:8px">' + s.reasons.map(function (r) { return '• ' + esc(r); }).join('<br>') + '</div>' : '');
  }
  function ownerInsightsHtml(v) {
    var yrs = yearsOwned(v.lastSale && v.lastSale.date);
    var linked = v.linkedProperties || [];
    var linkedHtml = linked.length
      ? '<div style="font-size:13px;margin-top:8px">Other properties (' + linked.length + '):<br>' + linked.map(function (p) { return '• ' + esc(p.address || p); }).join('<br>') + '</div>'
      : '<div style="font-size:13px;color:var(--muted);margin-top:8px">Other properties: —</div>';
    return '<div class="prop-grid">'
      + chip('Owner', dash(v.owner))
      + chip('Years Owned', yrs != null ? yrs + ' years' : '—')
      + chip('Mailing Address', dash(v.ownerMailing))
      + chip('Age Range', '—') + chip('Homeowner %', '—')
      + chip('Name Variations', '—')
      + '</div>' + linkedHtml;
  }
  function beforeAfterHtml(v) {
    var b = (v.listingHistory && v.listingHistory.before) || null;
    var a = (v.listingHistory && v.listingHistory.after) || null;
    // Fallback: Before = last sale, After = current listing.
    if (!b && v.lastSale && v.lastSale.amount != null) {
      b = { price: v.lastSale.amount, date: v.lastSale.date, beds: v.beds, baths: v.baths, description: '' };
    }
    if (!a && v.listing && v.listing.price) {
      a = { price: v.listing.price, date: v.listing.statusDate || v.listing.listedDate, dom: v.listing.dom, beds: v.beds, baths: v.baths, description: v.listing.description || '', mls: v.listing.mls, agent: v.listing.agent };
    }
    var col = function (title, x) {
      if (!x) return '<div><div style="font-weight:800;margin-bottom:6px">' + esc(title) + '</div><p style="color:var(--muted);font-size:13px">—</p></div>';
      return '<div><div style="font-weight:800;margin-bottom:6px">' + esc(title) + '</div>'
        + '<div style="font-size:13px;line-height:1.6">'
        + (x.price != null ? '<div><strong>' + money(x.price) + '</strong>' + (x.date ? ' · ' + fmtDate(String(x.date).slice(0, 10)) : '') + '</div>' : '')
        + (x.dom ? '<div>' + esc(String(x.dom)) + ' days on market</div>' : '')
        + ((x.beds != null || x.baths != null) ? '<div>' + dash(x.beds) + 'bd / ' + dash(x.baths) + 'ba</div>' : '')
        + (x.mls ? '<div>MLS#' + esc(String(x.mls)) + '</div>' : '')
        + (x.agent ? '<div>Agent: ' + esc(x.agent) + '</div>' : '')
        + (x.description ? '<div style="color:var(--muted);margin-top:6px;white-space:pre-wrap">' + esc(x.description) + '</div>' : '')
        + '</div></div>';
    };
    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' + col('Before', b) + col('After', a) + '</div>';
  }
  function propertyInsightsHtml(v) {
    return '<div class="prop-grid">'
      + chip('Beds', dash(v.beds)) + chip('Baths', dash(v.baths))
      + chip('Sq Ft', v.sqft ? Number(v.sqft).toLocaleString('en-US') : '—')
      + chip('Year Built', dash(v.yearBuilt)) + chip('Type', dash(v.type))
      + chip('Lot Size', v.lotSqft ? Number(v.lotSqft).toLocaleString('en-US') + ' sq ft' : (v.lotAcres ? v.lotAcres + ' acres' : '—'))
      + chip('Condition', dash(v.condition)) + chip('Stories', dash(v.stories))
      + chip('Basement', dash(v.basement)) + chip('Garage', dash(v.garage))
      + chip('Pool', dash(v.pool)) + chip('Units', dash(v.units || 1))
      + '</div>';
  }
  function financialInsightsHtml(v) {
    var avm = v.avm || {};
    var county = (v.countyValue != null) ? Number(v.countyValue) : null;
    var avmV = (avm.value != null) ? Number(avm.value) : null;
    var value = (avmV != null && county != null) ? Math.floor((avmV + county) / 2) : null;
    return '<div class="prop-grid">'
      + chip('Value', value != null ? money(value) + ' <span style="color:var(--muted);font-size:11px">(avg of AVM + County)</span>' : '—')
      + chip('AVM', avmV != null ? money(avmV) : '—')
      + chip('County', county != null ? money(county) : '—')
      + chip('Listing', v.listing && v.listing.price ? money(v.listing.price) : '—')
      + chip('Rent', v.rent != null ? money(v.rent) + ' /mo' : '—')
      + chip('Tax', v.tax != null ? money(v.tax) + (v.taxYear ? ' (' + esc(String(v.taxYear)) + ')' : '') : '—')
      + chip('AVM Range', (avm.low != null && avm.high != null) ? money(avm.low) + ' – ' + money(avm.high) : '—')
      + chip('AVM Source', dash(avm.source) + (avm.date ? ' · ' + fmtDate(String(avm.date).slice(0, 10)) : ''))
      + '</div>';
  }
  function buildingInsightsHtml(v) {
    return '<div class="prop-grid">'
      + chip('Beds', dash(v.beds)) + chip('Baths', dash(v.baths))
      + chip('Sq Ft', v.sqft ? Number(v.sqft).toLocaleString('en-US') : '—')
      + chip('Year Built', dash(v.yearBuilt)) + chip('Stories', dash(v.stories))
      + chip('Basement', dash(v.basement)) + chip('Garage', dash(v.garage))
      + chip('Pool', dash(v.pool)) + chip('Lot Size', v.lotSqft ? Number(v.lotSqft).toLocaleString('en-US') + ' sq ft' : (v.lotAcres ? v.lotAcres + ' acres' : '—'))
      + '</div>';
  }
  function constructionHtml(v) {
    return '<div class="prop-grid">'
      + chip('Construction', dash(v.construction)) + chip('Exterior', dash(v.exterior))
      + chip('Roof', dash(v.roof)) + chip('Heating', dash(v.heating))
      + chip('Cooling', dash(v.cooling)) + chip('Condition', dash(v.condition))
      + '</div>';
  }
  function loansHtml(v) {
    var m = v.mortgage || {};
    if (m.freeClear) return '<p style="font-size:13px"><strong>Free &amp; Clear</strong> — no mortgage on record, no payoff to clear at closing.</p>';
    if (m.amount == null && !m.lender) return '<p style="color:var(--muted);font-size:13px">No mortgage data on file for this address.</p>';
    return '<div class="prop-grid">'
      + chip('Amount Owed', m.amount != null ? money(m.amount) : '—')
      + chip('Lender', dash(m.lender)) + chip('Loan Type', dash(m.loanType))
      + chip('Term', dash(m.termMonths != null ? m.termMonths + ' mo' : ''))
      + chip('Recorded', m.recordedDate ? fmtDate(String(m.recordedDate).slice(0, 10)) : '—')
      + chip('Due', m.dueDate ? fmtDate(String(m.dueDate).slice(0, 10)) : '—')
      + '</div>';
  }
  function transactionsHtml(v) {
    var rows = v.saleHistory || [];
    if (!rows.length && v.lastSale && v.lastSale.amount != null) rows = [v.lastSale];
    if (!rows.length) return '<p style="color:var(--muted);font-size:13px">No recorded sales on file for this address.</p>';
    var sq = Number(v.sqft) || 0;
    var trs = rows.map(function (r) {
      var ps = (r.amount != null && sq) ? '$' + Math.round(Number(r.amount) / sq) + '/sqft' : '—';
      return '<tr><td>' + (r.date ? fmtDate(String(r.date).slice(0, 10)) : '—') + '</td>'
        + '<td><strong>' + (r.amount != null ? money(r.amount) : '—') + '</strong></td>'
        + '<td>' + ps + '</td><td>' + esc(r.deedType || '—') + '</td>'
        + '<td>' + esc(r.seller || '—') + '</td><td>' + esc(r.buyer || '—') + '</td></tr>';
    }).join('');
    return '<table style="width:100%;font-size:13px;border-collapse:collapse"><thead><tr><th style="text-align:left">Date</th><th style="text-align:left">Price</th><th style="text-align:left">$/Sqft</th><th style="text-align:left">Deed</th><th style="text-align:left">Seller</th><th style="text-align:left">Buyer</th></tr></thead><tbody>' + trs + '</tbody></table>';
  }
  function preForeclosureHtml(v) {
    var d = v.distress || {};
    if (d.preForeclosure) return '<p style="font-size:13px"><strong>⚠️ Pre-Foreclosure on record</strong>' + (d.detail ? ' — ' + esc(d.detail) : '') + '</p>';
    return '<p style="color:var(--muted);font-size:13px">No pre-foreclosure on record for this address.</p>';
  }

  var SECTIONS = [
    ['overview', 'Overview', overviewHtml],
    ['listing', 'Listing Insights', function (v) { return listingHtml(v); }],
    ['deal', 'Deal Insights', dealInsightsHtml],
    ['owner', 'Owner Insights', ownerInsightsHtml],
    ['before-after', 'Before & After', beforeAfterHtml],
    ['property', 'Property Insights', propertyInsightsHtml],
    ['financial', 'Financial Insights', financialInsightsHtml],
    ['building', 'Building Insights', buildingInsightsHtml],
    ['construction', 'Construction & Materials', constructionHtml],
    ['loans', 'Loans', loansHtml],
    ['transactions', 'Transactions', transactionsHtml],
    ['preforeclosure', 'Pre-Foreclosures', preForeclosureHtml]
  ];
  function listingHtml(v) {
    if (typeof root !== 'undefined' && root.ListingInsights) return root.ListingInsights.panelHtml(v.listing || {});
    return '<p style="color:var(--muted);font-size:13px">Listing Insights failed to load.</p>';
  }

  // Full view: header + menu bar + accordion sections.
  // openSections: array of section ids to render open (preserved across
  // re-renders by the page). Default: Overview + Listing Insights open.
  function detailViewHtml(v, openSections) {
    v = v || {};
    var open = {};
    (openSections || ['overview', 'listing']).forEach(function (id) { open[id] = true; });
    var secs = SECTIONS.map(function (s) { return section(s[0], s[1], s[2](v), !!open[s[0]]); }).join('');
    return '<div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px">'
      + '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px">'
      + '<span style="font-weight:800;font-size:13px">☰ Property Detail</span>'
      + '<span><button class="btn ghost" style="padding:4px 8px" onclick="detailCollapseAll()">Collapse All</button> '
      + '<button class="btn ghost" style="padding:4px 8px" onclick="detailExpandAll()">Expand All</button></span>'
      + '</div>'
      + headerHtml(v)
      + '<div style="margin-top:12px">' + secs + '</div>'
      + '</div>';
  }

  var api = {
    SECTIONS: SECTIONS.map(function (s) { return s[0]; }),
    carouselHtml: carouselHtml,
    headerHtml: headerHtml,
    detailViewHtml: detailViewHtml,
    yearsOwned: yearsOwned,
    money: money,
    fmtDate: fmtDate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PropertyDetailView = api;
})(typeof window !== 'undefined' ? window : globalThis);

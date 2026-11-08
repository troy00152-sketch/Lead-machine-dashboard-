/* Buyer portfolio view — shared module (browser UMD, same pattern as
   assets/offer-math.js, assets/sellability.js, assets/buyer-map.js and
   assets/buyer-detail.js).
   XLeads Investors (Leadpipes) "View Residential Investments" parity,
   within what our data actually has:
   - Portfolio = the sample property ADDRESSES on file for a buyer
     (assets/buyer-portfolio-data.js, bundled at build time from the
     county buyer files + all-buyers-10000 + lead-machine-buyers.json,
     matched by normalized buyer name). Up to 3 sample addresses per
     buyer in the sources — a SAMPLE, never a full portfolio.
   - Shared tax-mailing-address groups: buyers sharing one mailing
     address have their properties listed together, each card labeled
     with its real owner name (the XLeads Aj-style mix, reproduced
     honestly from our own data).
   - Map mode with PRICE pins: a price pin shows ONLY when a real
     per-property Retail value is on file for that property. Today
     none is — no per-property value exists on disk — so pins are
     numbered and the popup says "Value not on file". The price-pin
     path is implemented and gated, not faked.
   NO-MAKEUP / DATA RULES (same doctrine as the rest of the dashboard):
   - A property card shows ONLY fields that really exist for that
     property. Today that is address + owner name. Sq ft, beds, baths,
     property type, Retail value, rent, LTV render ONLY when the record
     carries them; otherwise the card says "not on file", never an
     invented number. No profit figures anywhere: our data has no deed
     buy-vs-sell history. A Wholesale figure appears ONLY when a real
     Retail value exists, and is labeled "Wholesale estimate
     (Retail × 0.65)" — never presented as a recorded value.
   - Pins plot ONLY at bundled ZIP centroids (buyer-map-data.js).
     A property with no ZIP on file is list-only, never placed
     anywhere. No jitter, no guessing, no city-centre fallback. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuyerPortfolio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Same normalization as the build script
     (build_buyer_portfolio_data.py): strip everything but A-Z0-9. */
  function normName(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function money(n) {
    if (n == null || n === 0 || n === '' || isNaN(Number(n))) return '—';
    return '$' + Math.round(Number(n)).toLocaleString('en-US');
  }

  /* Compact money for map pins: $473K, $1.2M. */
  function shortMoney(n) {
    if (n == null || n === 0 || n === '' || isNaN(Number(n))) return null;
    var v = Math.abs(Number(n));
    if (v >= 1000000) return '$' + (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return '$' + Math.round(v / 1000) + 'K';
    return '$' + Math.round(v);
  }

  /* Normalize one portfolio-data entry into a property object.
     Array form [street, city, state, zip] is what the build emits;
     object form is accepted so a future data refresh can add fields
     (sqft, beds, baths, type, retail, rent, ltv) without a rewrite. */
  function toProp(entry, ownerNorm, ownerName) {
    var p = { owner: ownerNorm || '', ownerName: ownerName || '' };
    if (Array.isArray(entry)) {
      p.st = entry[0] || ''; p.c = entry[1] || '';
      p.s = entry[2] || ''; p.z = entry[3] || '';
    } else if (entry && typeof entry === 'object') {
      p.st = entry.st || entry.street || ''; p.c = entry.c || entry.city || '';
      p.s = entry.s || entry.state || ''; p.z = entry.z || entry.zip || '';
      if (entry.sqft != null) p.sqft = entry.sqft;
      if (entry.beds != null) p.beds = entry.beds;
      if (entry.baths != null) p.baths = entry.baths;
      if (entry.type) p.type = entry.type;
      if (entry.retail != null) p.retail = entry.retail;
      if (entry.rent != null) p.rent = entry.rent;
      if (entry.ltv != null) p.ltv = entry.ltv;
    }
    return p;
  }

  function displayName(norm, data) {
    if (data && data.names && data.names[norm]) return data.names[norm];
    return '';
  }

  /* Look up a buyer's portfolio. Returns:
     { own: [prop], shared: [{ owner, ownerName, props: [prop] }],
       total, sharedOwnerNames: [displayName] }
     `own` is this buyer's own sample properties. `shared` is the
     properties of OTHER buyers sharing this buyer's tax mailing
     address (each labeled with its real owner). A buyer in no group
     has shared = []. Unknown buyer -> all empty. */
  function lookup(buyerName, data) {
    var out = { own: [], shared: [], total: 0, sharedOwnerNames: [] };
    if (!buyerName || !data || !data.props) return out;
    var n = normName(buyerName);
    var ownEntries = data.props[n] || [];
    out.own = ownEntries.map(function (e) { return toProp(e, n, buyerName); });
    var group = null;
    (data.groups || []).some(function (g) {
      if ((g.m || []).indexOf(n) !== -1) { group = g; return true; }
      return false;
    });
    if (group) {
      (group.m || []).forEach(function (m) {
        if (m === n) return;
        var entries = data.props[m] || [];
        if (!entries.length) return;
        var name = displayName(m, data) || m;
        out.shared.push({ owner: m, ownerName: name,
          props: entries.map(function (e) { return toProp(e, m, name); }) });
        out.sharedOwnerNames.push(name);
      });
    }
    out.total = out.own.length + out.shared.reduce(function (a, g) { return a + g.props.length; }, 0);
    return out;
  }

  function allProps(port) {
    var all = (port.own || []).slice();
    (port.shared || []).forEach(function (g) { all = all.concat(g.props || []); });
    return all;
  }

  /* Price-pin label: ONLY when a real per-property Retail value is on
     file. Returns null otherwise — the caller renders a numbered pin. */
  function pricePinLabel(p) {
    if (!p || p.retail == null || p.retail === '' || isNaN(Number(p.retail)) || Number(p.retail) <= 0) return null;
    return shortMoney(p.retail);
  }

  /* Wholesale estimate: Retail x 0.65, ONLY when a real Retail exists.
     Returns { value, label } or null. The label is part of the return so
     the UI can never show the number without the "estimate" wording. */
  function wholesaleEstimate(retail) {
    if (retail == null || retail === '' || isNaN(Number(retail)) || Number(retail) <= 0) return null;
    return { value: Math.round(Number(retail) * 0.65), label: 'Wholesale estimate (Retail × 0.65)' };
  }

  /* Split properties into plotted / unplotted. A plotted pin's lat/lon
     is copied EXACTLY from the ZIP centroid table — never rounded, never
     jittered, never defaulted. Anything without a centroid entry lands in
     `unplotted` with its index kept, so the list can still show it. */
  function splitPlottable(props, zipCoords) {
    var plotted = [], unplotted = [];
    var table = zipCoords || {};
    (props || []).forEach(function (p, i) {
      var z = String((p && p.z) || '').trim();
      var c = table[z];
      if (c && isFinite(c[0]) && isFinite(c[1])) {
        var q = {}; for (var k in p) q[k] = p[k];
        q.lat = c[0]; q.lon = c[1]; q.plot = 'zip'; q.index = i;
        plotted.push(q);
      } else {
        unplotted.push({ prop: p, index: i });
      }
    });
    return { plotted: plotted, unplotted: unplotted };
  }

  function placeLine(p) {
    return [p.st || '', [p.c || '', p.s || '', p.z || ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }

  /* One property card. Address + owner name are always shown. Detail
     rows render ONLY for fields really present on the record; when none
     are present the card says so plainly instead of inventing values. */
  function propertyCardHtml(p, idx) {
    p = p || {};
    var h = '<div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px">';
    h += '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">';
    h += '<div><div style="font-weight:800;font-size:14px">#' + ((idx == null ? 0 : idx) + 1) + ' ' + esc(p.st || '—') + '</div>';
    var place = [p.c || '', p.s || '', p.z || ''].filter(Boolean).join(', ');
    if (place) h += '<div style="color:var(--muted)">' + esc(place) + '</div>';
    h += '</div>';
    h += '<div style="font-size:11px;color:var(--muted);text-align:right">Owner:<br><b style="color:var(--text)">' + esc(p.ownerName || p.owner || '—') + '</b></div>';
    h += '</div>';
    var rows = [];
    if (p.sqft != null && p.sqft !== '') rows.push(['Sq ft', Number(p.sqft).toLocaleString('en-US')]);
    if (p.beds != null && p.beds !== '') rows.push(['Beds', esc(String(p.beds))]);
    if (p.baths != null && p.baths !== '') rows.push(['Baths', esc(String(p.baths))]);
    if (p.type) rows.push(['Type', esc(p.type)]);
    if (p.retail != null && p.retail !== '' && Number(p.retail) > 0) rows.push(['Retail value', money(p.retail)]);
    if (p.rent != null && p.rent !== '') rows.push(['Rent', esc(String(p.rent))]);
    if (p.ltv != null && p.ltv !== '') rows.push(['LTV', esc(String(p.ltv))]);
    if (rows.length) {
      h += '<div style="margin-top:8px">';
      rows.forEach(function (r) {
        h += '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid var(--line)"><span style="color:var(--muted)">' + esc(r[0]) + '</span><span style="font-weight:700">' + r[1] + '</span></div>';
      });
      h += '</div>';
      var w = wholesaleEstimate(p.retail);
      if (w) h += '<div style="margin-top:8px;font-size:12px;color:var(--muted)">' + esc(w.label) + ': <b style="color:var(--text)">$' + w.value.toLocaleString('en-US') + '</b></div>';
    } else {
      h += '<div style="margin-top:8px;font-size:12px;color:var(--muted)">Sq ft / beds / baths / value: not on file for this property — address only.</div>';
    }
    h += '</div>';
    return h;
  }

  function disclaimerHtml() {
    return 'Properties are linked by tax mailing address — the sample addresses on file for this buyer. Multiple investors may share one mailing address, so this list can include properties owned under other names (each card shows its owner). These are sample addresses, not a full portfolio. Verify independently before acting on any property.';
  }

  return {
    esc: esc,
    normName: normName,
    money: money,
    shortMoney: shortMoney,
    toProp: toProp,
    lookup: lookup,
    allProps: allProps,
    pricePinLabel: pricePinLabel,
    wholesaleEstimate: wholesaleEstimate,
    splitPlottable: splitPlottable,
    placeLine: placeLine,
    propertyCardHtml: propertyCardHtml,
    disclaimerHtml: disclaimerHtml
  };
});

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
   - Marion County (Indianapolis) pilot, Nov 8 2026: parcels from the
     Marion County Assessor GIS layer, matched to buyers by normalized
     tax mailing address, are merged in as OBJECT entries carrying real
     county detail: lot sq ft + assessed value from the layer, and
     beds / baths / living sq ft / year built from the county property
     card where one was fetched. Those are REAL holdings for that
     mailing address, not samples.
   - Four more counties, Nov 9 2026 (same pattern, free public county
     records): Pitt NC (Greenville), Jackson MO (Kansas City),
     Cuyahoga OH (Cleveland), Duval FL (Jacksonville). Each object
     carries `co` (county) and county-specific labeling: Cuyahoga's
     `av` is the county's TAXABLE value (avKind 'taxable') with the
     Ohio 35% figure as `av35`; Jackson's values are tax year 2024
     (avYear '2024'); Pitt lot sq ft is computed from acres
     (lotSrc 'acres'); Duval card values win over the layer and its
     baths is a single number (bathsSingle). See the county
     descriptions in assets/buyer-portfolio-data.js.
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
   - Pins plot at the property's EXACT street address when the
     Nov 8-9 geocode pass matched it (lat/lon on the record,
     plot 'exact'); otherwise at the bundled ZIP centroid
     (buyer-map-data.js, plot 'zip'). A property with no ZIP on file
     and no geocode hit is list-only, never placed anywhere. No
     jitter, no guessing, no city-centre fallback.
   - COUNTY DETAIL LABELING (hard rule): assessed value is a TAX
     value, never a retail/market price. Cards show it ONLY as
     "Assessed value" — except Cuyahoga, whose `av` is the county's
     TAXABLE value ("Taxable Value", avKind 'taxable', with the Ohio
     35% figure as a separate "Assessed (35%)" row from `av35`), and
     Jackson, whose values are tax year 2024 ("Assessed value
     (2024)", avYear '2024'). It NEVER feeds price pins
     (pricePinLabel reads `retail` only) and NEVER feeds the
     wholesale estimate. Lot sq ft (the parcel's lot) and living sq
     ft (property-card living area) are separate rows — never merged
     into one "Sq ft". Pitt lot sq ft is computed from the county's
     Acres (lotSrc 'acres') and is labeled as computed, never as a
     measured lot. Duval baths is a single county number
     (bathsSingle) — rendered "2.5 baths", never "2.5 full". */
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
     Array form [street, city, state, zip] is what the build emits
     for sample addresses; a geocoded sample carries [4]=lat, [5]=lon.
     Object form carries county detail:
     lotsqft (parcel lot sq ft), livsqft (living area), beds,
     baths (full baths) or a single county baths number (bathsSingle),
     bathsHalf (half baths), year (year built), year_efftv, rooms,
     type, av (assessed value — TAX value, never retail), avLand,
     avImp, avKind ('taxable' for Cuyahoga), avYear ('2024' for
     Jackson), av35 (Cuyahoga 35% assessed), lotSrc ('acres' for Pitt
     computed-from-acres lot), parcel (county parcel number), co
     (county: marion/pitt/jackson/cuyahoga/duval), lat/lon (exact
     geocode hit), retail, rent, ltv.
     `av` is deliberately NOT mapped to `retail`. */
  function toProp(entry, ownerNorm, ownerName) {
    var p = { owner: ownerNorm || '', ownerName: ownerName || '' };
    if (Array.isArray(entry)) {
      p.st = entry[0] || ''; p.c = entry[1] || '';
      p.s = entry[2] || ''; p.z = entry[3] || '';
      if (entry.length > 5 && isFinite(entry[4]) && isFinite(entry[5])) {
        p.lat = entry[4]; p.lon = entry[5];
      }
    } else if (entry && typeof entry === 'object') {
      p.st = entry.st || entry.street || ''; p.c = entry.c || entry.city || '';
      p.s = entry.s || entry.state || ''; p.z = entry.z || entry.zip || '';
      if (entry.lat != null && entry.lon != null) { p.lat = entry.lat; p.lon = entry.lon; }
      if (entry.sqft != null) p.sqft = entry.sqft;
      if (entry.beds != null) p.beds = entry.beds;
      if (entry.baths != null) p.baths = entry.baths;
      if (entry.bathsHalf != null) p.bathsHalf = entry.bathsHalf;
      if (entry.bathsSingle) p.bathsSingle = true;
      if (entry.type) p.type = entry.type;
      if (entry.retail != null) p.retail = entry.retail;
      if (entry.rent != null) p.rent = entry.rent;
      if (entry.ltv != null) p.ltv = entry.ltv;
      if (entry.av != null) p.av = entry.av;
      if (entry.avLand != null) p.avLand = entry.avLand;
      if (entry.avImp != null) p.avImp = entry.avImp;
      if (entry.avKind) p.avKind = entry.avKind;
      if (entry.avYear) p.avYear = entry.avYear;
      if (entry.av35 != null) p.av35 = entry.av35;
      if (entry.lotSrc) p.lotSrc = entry.lotSrc;
      if (entry.lotsqft != null) p.lotsqft = entry.lotsqft;
      if (entry.livsqft != null) p.livsqft = entry.livsqft;
      if (entry.year != null) p.year = entry.year;
      if (entry.year_efftv != null) p.year_efftv = entry.year_efftv;
      if (entry.rooms != null) p.rooms = entry.rooms;
      if (entry.parcel) p.parcel = entry.parcel;
      if (entry.oid != null) p.oid = entry.oid;
      if (entry.co) p.co = entry.co;
      /* County owner name (entry.on) is the LEGAL owner per the county
         and overrides the buyer-name param: the match is by mailing
         address, and the legal owner often differs (manager / trustee
         / related entity at the same address). The card must show the
         real owner, not the buyer, as owner. */
      if (entry.on) p.ownerName = entry.on;
    }
    return p;
  }

  function displayName(norm, data) {
    if (data && data.names && data.names[norm]) return data.names[norm];
    return '';
  }

  /* Look up a buyer's portfolio. Returns:
     { own: [prop], shared: [{ owner, ownerName, props: [prop] }],
       sharedParcels: [prop], total, sharedOwnerNames: [displayName] }
     `own` is this buyer's own sample properties PLUS own county parcels
     (single-buyer mailing addresses). `shared` is the properties of
     OTHER buyers sharing this buyer's tax mailing address (each labeled
     with its real owner). `sharedParcels` is the county parcels at a
     mailing address shared by 2+ buyers — shown in a shared section,
     each card labeled with the county owner name, never any buyer's own.
     A buyer in no group has shared = [] and sharedParcels = [].
     Unknown buyer -> all empty. */
  function lookup(buyerName, data) {
    var out = { own: [], shared: [], sharedParcels: [], total: 0, sharedOwnerNames: [] };
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
      /* Shared-address county parcels (group.sp): each card carries
         the county owner name (entry.on) via toProp — never the
         viewing buyer's name, never any group member's name. */
      (group.sp || []).forEach(function (e) {
        out.sharedParcels.push(toProp(e, '', ''));
      });
    }
    out.total = out.own.length + out.shared.reduce(function (a, g) { return a + g.props.length; }, 0) + out.sharedParcels.length;
    return out;
  }

  function allProps(port) {
    var all = (port.own || []).slice();
    (port.shared || []).forEach(function (g) { all = all.concat(g.props || []); });
    all = all.concat(port.sharedParcels || []);
    return all;
  }

  /* Price-pin label: ONLY when a real per-property Retail value is on
     file. Returns null otherwise — the caller renders a numbered pin.
     Assessed value (`av`) is deliberately ignored here: it is a tax
     value, not a retail price, and must never produce a price pin. */
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

  /* Split properties into plotted / unplotted. An EXACT geocode hit
     (p.lat/p.lon from the Nov 8-9 Nominatim pass) always wins and is
     marked plot 'exact'. Otherwise the pin falls back to the ZIP
     centroid table, copied EXACTLY — never rounded, never jittered,
     never defaulted — and is marked plot 'zip'. Anything with neither
     lands in `unplotted` with its index kept, so the list can still
     show it. */
  function splitPlottable(props, zipCoords) {
    var plotted = [], unplotted = [];
    var table = zipCoords || {};
    (props || []).forEach(function (p, i) {
      var q = {}; for (var k in p) q[k] = p[k];
      q.index = i;
      if (p && isFinite(p.lat) && isFinite(p.lon)) {
        q.lat = p.lat; q.lon = p.lon; q.plot = 'exact';
        plotted.push(q);
        return;
      }
      var z = String((p && p.z) || '').trim();
      var c = table[z];
      if (c && isFinite(c[0]) && isFinite(c[1])) {
        q.lat = c[0]; q.lon = c[1]; q.plot = 'zip';
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
    if (p.livsqft != null && p.livsqft !== '') rows.push(['Living sq ft', Number(p.livsqft).toLocaleString('en-US')]);
    if (p.lotsqft != null && p.lotsqft !== '') rows.push([p.lotSrc === 'acres' ? 'Lot sq ft (from acres)' : 'Lot sq ft', Number(p.lotsqft).toLocaleString('en-US')]);
    if (p.beds != null && p.beds !== '') rows.push(['Beds', esc(String(p.beds))]);
    if (p.bathsSingle) {
      /* Duval: the county reports ONE baths number (may be fractional)
         — "2.5 baths", never "2.5 full". */
      if (p.baths != null && p.baths !== '') rows.push(['Baths', esc(String(p.baths))]);
    } else if ((p.baths != null && p.baths !== '') || (p.bathsHalf != null && p.bathsHalf !== '')) {
      var b = '';
      if (p.baths != null && p.baths !== '') b = String(p.baths) + ' full';
      if (p.bathsHalf != null && p.bathsHalf !== '') b = (b ? b + ' · ' : '') + String(p.bathsHalf) + ' half';
      rows.push(['Baths', esc(b)]);
    }
    if (p.rooms != null && p.rooms !== '') rows.push(['Rooms', esc(String(p.rooms))]);
    if (p.type) rows.push(['Type', esc(p.type)]);
    if (p.year != null && p.year !== '') rows.push(['Year built', esc(String(p.year))]);
    if (p.year_efftv != null && p.year_efftv !== '' && p.year_efftv !== p.year) rows.push(['Effective year', esc(String(p.year_efftv))]);
    /* Assessed-value label is county-specific (hard rule): Cuyahoga's
       `av` is the county's TAXABLE value; Jackson's values are tax
       year 2024; everything else is plain "Assessed value". The
       Cuyahoga 35% figure rides as a separate "Assessed (35%)" row. */
    if (p.av != null && p.av !== '' && Number(p.av) > 0) {
      var avLabel = 'Assessed value';
      if (p.avKind === 'taxable') avLabel = 'Taxable value';
      else if (p.avYear) avLabel = 'Assessed value (' + p.avYear + ')';
      rows.push([avLabel, money(p.av)]);
    }
    if (p.av35 != null && p.av35 !== '' && Number(p.av35) > 0) rows.push(['Assessed (35%)', money(p.av35)]);
    if (p.retail != null && p.retail !== '' && Number(p.retail) > 0) rows.push(['Retail value', money(p.retail)]);
    if (p.rent != null && p.rent !== '') rows.push(['Rent', esc(String(p.rent))]);
    if (p.ltv != null && p.ltv !== '') rows.push(['LTV', esc(String(p.ltv))]);
    if (p.parcel) rows.push(['Parcel #', esc(String(p.parcel))]);
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

  /* County provenance note — shown only when the portfolio contains
     county parcels (any prop with a parcel number). States the source
     and the assessed-value rule in plain language. */
  function countyNoteHtml() {
    return 'County detail (Marion IN, Pitt NC, Jackson MO, Cuyahoga OH, Duval FL — free public county records): lot sq ft, property type and assessed value come from the county parcel layer; beds, baths, living sq ft and year built come from the county property card for that parcel, where one was fetched. Assessed value is a TAX value, not a market or retail price — it never appears as a price pin or a retail value. Cuyahoga values are the county\'s Taxable Value (full appraised), with the Ohio 35% figure shown separately as Assessed (35%); Jackson values are tax year 2024; Pitt lot sq ft is computed from the county\'s Acres. Fields the county does not carry for a property show as not on file.';
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
    disclaimerHtml: disclaimerHtml,
    countyNoteHtml: countyNoteHtml
  };
});

/* Ranked investor map — shared module (browser UMD, same pattern as
   assets/offer-math.js and assets/sellability.js).
   XLeads Investors (Leadpipes) parity + beats:
   - Ranked numbered pins (#1..N) tied to the list's sort order and page.
   - Real clustering via Leaflet.markercluster (already loaded by index.html),
     so pins never pile unreadably at city zoom (XLeads has none).
   - Hover tooltip shows portfolio stats WITHOUT a click (XLeads' popup
     shows neither flips nor profit).
   - Click popup: name + address + deep-link back to the buyer in the list.
   - City/ZIP search zooms + draws the bundled boundary polygon.
   - Street/satellite tile toggle. Zoom/pan never re-ranks the list.
   - Polygon draw tool: custom area filter (no new dependency).
   NO-MAKEUP / DATA RULES (same doctrine as the rest of the dashboard):
   - Pins are plotted ONLY at coordinates from BUYER_MAP_DATA.zipCoords
     (Census 2025 Gazetteer ZCTA centroids, bundled at build time). A buyer whose ZIP has
     no centroid entry is NEVER placed anywhere: it stays in the list as
     unplotted. No jitter, no guessing, no city-centre fallback.
   - Stats shown come ONLY from the Master Buyers bundle fields
     (n/p/c/s/z/pc/st/ap/pv/w/sc/ti/fl). There is NO profit field in our data
     (XLeads' gross profit comes from deed buy-vs-sell history, which we do
     not have) — so the tooltip never claims profit. Flips (`fl`, added
     Nov 8 2026; only 2,657 of 28,423 records have flips on file) show on
     hover when > 0. A zero value means "not on file" and renders as "—".
   - One source of truth: every aggregated figure on the map is computed from
     the same record the list row shows. Nothing is re-derived from a second
     feed (the XLeads review found list-vs-detail disagreements; we do not
     repeat that). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuyerMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Tile sources — both free, no key, no per-hit billing. OSM is the same
     source the Property Search and Command Center maps already use. Esri
     World Imagery is the standard no-key satellite source for Leaflet. */
  var TILES = {
    street: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Esri, Maxar, Earthstar Geographics'
    }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 0 in this dataset means "not on file", never $0 — render as an em dash. */
  function money(n) {
    if (n == null || n === 0 || n === '' || isNaN(Number(n))) return '—';
    return '$' + Math.round(Number(n)).toLocaleString('en-US');
  }
  function count(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US');
  }

  /* Rank one page of list results. Rank = position in the full sorted
     results (page * perPage + i + 1) so the pin number always matches the
     list order, even across pages. globalIndex is the index into the full
     results array — the popup deep-link uses it to find the row again. */
  function rankPage(records, page, perPage) {
    var out = [];
    var list = Array.isArray(records) ? records : [];
    var p = Math.max(0, page || 0);
    var n = Math.max(1, perPage || 50);
    var start = p * n;
    var slice = list.slice(start, start + n);
    for (var i = 0; i < slice.length; i++) {
      out.push({ rec: slice[i], rank: start + i + 1, globalIndex: start + i });
    }
    return out;
  }

  /* Split ranked buyers into plotted / unplotted. A plotted pin's lat/lon
     is copied EXACTLY from the ZIP centroid table — never rounded, never
     jittered, never defaulted. Anything without a centroid entry lands in
     `unplotted` with its rank kept, so the list can still show it. */
  function splitPlottable(ranked, zipCoords) {
    var plotted = [], unplotted = [];
    var table = zipCoords || {};
    (ranked || []).forEach(function (item) {
      var z = String((item.rec && item.rec.z) || '').trim();
      var c = table[z];
      if (c && isFinite(c[0]) && isFinite(c[1])) {
        plotted.push({ rec: item.rec, rank: item.rank, globalIndex: item.globalIndex, lat: c[0], lon: c[1], plot: 'zip' });
      } else {
        unplotted.push(item);
      }
    });
    return { plotted: plotted, unplotted: unplotted };
  }

  /* Hover tooltip — portfolio stats from bundle fields only. Flips
     show when fl > 0 (bundle field `fl`, added Nov 8 2026); no profit:
     no profit field exists anywhere in our data (XLeads' gross profit
     comes from deed buy-vs-sell history, which we do not have). */
  function tooltipHtml(p) {
    var b = p.rec || {};
    var lines = '#' + p.rank + ' · ' + esc(b.n || '—');
    lines += '<br>' + count(b.pc) + ' properties · Avg buy ' + money(b.ap);
    if (b.fl != null && !isNaN(Number(b.fl)) && Number(b.fl) > 0) lines += ' · Flips ' + Number(b.fl).toLocaleString('en-US');
    lines += '<br>Portfolio ' + money(b.pv) + (b.ti ? ' · ' + esc(b.ti) : '');
    return lines;
  }

  /* Click popup — name, place, strategy, score, phone when on file, and a
     deep-link button back to this buyer in the list view. */
  function popupHtml(p) {
    var b = p.rec || {};
    var place = [b.c || '', b.s || '', b.z || ''].filter(Boolean).join(', ');
    var h = '<div style="font-size:13px;line-height:1.75;min-width:210px;max-width:280px">';
    h += '<div style="font-weight:800;font-size:14px">#' + p.rank + ' ' + esc(b.n || '—') + '</div>';
    if (place) h += '<div style="opacity:.75">' + esc(place) + '</div>';
    h += '<div>' + esc(b.st || '—') + ' · Score ' + (b.sc == null ? '—' : esc(b.sc) + '%') + (b.ti ? ' · ' + esc(b.ti) : '') + '</div>';
    h += '<div>🏠 ' + count(b.pc) + ' properties · Avg buy ' + money(b.ap) + '</div>';
    h += '<div>💰 Portfolio ' + money(b.pv) + '</div>';
    if (b.p) h += '<div>📞 ' + esc(String(b.p)) + '</div>';
    h += '<div style="font-size:11px;opacity:.6;margin-top:2px">📍 Plotted at ZIP centroid — exact address not geocoded yet</div>';
    h += '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><button onclick="mbFocusBuyer(' + p.globalIndex + ')" style="background:#ff6b1a;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer">📋 View in list →</button><button onclick="mbOpenDetail(' + p.globalIndex + ')" style="background:#00d4ff;color:#04121a;border:0;border-radius:8px;padding:6px 10px;font-weight:700;cursor:pointer">👁 View details</button></div>';
    h += '</div>';
    return h;
  }

  /* Ray-casting point-in-polygon. Ring is [[lat, lon], ...] (Leaflet order).
     Used for the custom draw-area filter and for boundary validation. */
  function pointInPolygon(lat, lon, ring) {
    if (!ring || ring.length < 4) return false;
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][1], yi = ring[i][0];
      var xj = ring[j][1], yj = ring[j][0];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* Keep only the plotted buyers whose pin falls inside a drawn ring
     ([[lat, lon], ...]). Pins are ZIP centroids, so a buyer counts as inside
     when its ZIP centroid is inside — the note line says so. */
  function filterInside(plotted, ring) {
    if (!ring || ring.length < 4) return plotted.slice();
    return (plotted || []).filter(function (p) { return pointInPolygon(p.lat, p.lon, ring); });
  }

  /* Convert bundled GeoJSON (Polygon / MultiPolygon, [lon, lat]) to
     Leaflet-order rings [[lat, lon], ...]. Returns { rings, issues } where
     rings is a flat list of rings (holes included — Leaflet draws them).
     A ring that is not closed or has < 4 points is reported, not silently
     fixed. */
  function geojsonToLatLngs(geojson) {
    var rings = [], issues = [];
    if (!geojson || !geojson.coordinates) { issues.push('no coordinates'); return { rings: rings, issues: issues }; }
    var parts = geojson.type === 'MultiPolygon' ? geojson.coordinates : [geojson.coordinates];
    parts.forEach(function (part, pi) {
      part.forEach(function (ring, ri) {
        if (!Array.isArray(ring) || ring.length < 4) { issues.push('part ' + pi + ' ring ' + ri + ' has < 4 points'); return; }
        var f = ring[0], l = ring[ring.length - 1];
        if (f[0] !== l[0] || f[1] !== l[1]) issues.push('part ' + pi + ' ring ' + ri + ' is not closed');
        rings.push(ring.map(function (pt) { return [pt[1], pt[0]]; }));
      });
    });
    return { rings: rings, issues: issues };
  }

  /* Match a map search string to a market or a ZIP centroid.
     Returns {kind:'market', key} | {kind:'zip', zip, lat, lon} | null.
     City match is by market city name or label; ZIP match needs the exact
     5-digit ZIP in the centroid table. Anything else returns null — the UI
     says "not found", it never guesses a location. */
  function marketForQuery(q, data) {
    var s = String(q || '').toLowerCase().trim();
    if (!s || !data) return null;
    var keys = Object.keys(data.markets || {});
    for (var i = 0; i < keys.length; i++) {
      var m = data.markets[keys[i]];
      if (s === m.city || s === m.label.toLowerCase() || s.indexOf(m.city) !== -1) {
        return { kind: 'market', key: keys[i] };
      }
    }
    var zip = s.replace(/\D/g, '');
    if (/^\d{5}$/.test(zip) && data.zipCoords && data.zipCoords[zip]) {
      return { kind: 'zip', zip: zip, lat: data.zipCoords[zip][0], lon: data.zipCoords[zip][1] };
    }
    return null;
  }

  /* Validate the bundled data file. Returns a list of issue strings
     (empty = clean). The page logs these to console; the regression suite
     asserts zero issues. */
  function validateData(data) {
    var issues = [];
    if (!data) return ['no data'];
    Object.keys(data.zipCoords || {}).forEach(function (z) {
      var c = data.zipCoords[z];
      if (!Array.isArray(c) || c.length !== 2 || !isFinite(c[0]) || !isFinite(c[1]) ||
          c[0] < -90 || c[0] > 90 || c[1] < -180 || c[1] > 180) issues.push('zipCoords ' + z + ' is not a valid [lat, lon]');
    });
    Object.keys(data.centers || {}).forEach(function (k) {
      var c = data.centers[k];
      if (!Array.isArray(c) || !isFinite(c[0]) || !isFinite(c[1])) issues.push('centers ' + k + ' is not a valid [lat, lon]');
    });
    Object.keys(data.boundaries || {}).forEach(function (k) {
      var r = geojsonToLatLngs(data.boundaries[k]);
      if (r.issues.length) issues.push('boundary ' + k + ': ' + r.issues.join('; '));
      if (!r.rings.length) issues.push('boundary ' + k + ' has no rings');
    });
    Object.keys(data.markets || {}).forEach(function (k) {
      if (!data.centers[k]) issues.push('market ' + k + ' has no centre');
      if (!data.boundaries[k]) issues.push('market ' + k + ' has no boundary');
    });
    return issues;
  }

  return {
    TILES: TILES,
    esc: esc,
    money: money,
    count: count,
    rankPage: rankPage,
    splitPlottable: splitPlottable,
    tooltipHtml: tooltipHtml,
    popupHtml: popupHtml,
    pointInPolygon: pointInPolygon,
    filterInside: filterInside,
    geojsonToLatLngs: geojsonToLatLngs,
    marketForQuery: marketForQuery,
    validateData: validateData
  };
});

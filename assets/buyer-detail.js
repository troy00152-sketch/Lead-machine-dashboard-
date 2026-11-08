/* Investor performance card + buyer detail — shared module (browser UMD,
   same pattern as assets/offer-math.js, assets/sellability.js and
   assets/buyer-map.js).
   XLeads Investors (Leadpipes) parity, within what our data actually has:
   - Performance card metrics: properties owned, avg purchase, portfolio
     value, flips (bundle field `fl`, added Nov 8 2026), score/tier,
     strategy pills.
   - Buyer detail: identity + contact, Landlord Insights, Flipper
     Insights, Buy Box / strategy. List row <-> detail <-> map pin all
     resolve to the same buyer record via its index in the current search
     results (globalIndex — the same index the map popup uses).
   NO-MAKEUP / DATA RULES (same doctrine as the rest of the dashboard):
   - Every figure comes from the ONE bundle record the list row shows.
     Nothing is re-derived from a second feed (the XLeads review found
     list-vs-detail disagreements; we do not repeat that).
   - 0 / missing means "not on file" and renders as an em dash, never
     "$0" and never an invented number. Flips render only when fl > 0;
     a flipper with fl = 0 shows "— (not on file)".
   - NO profit figures anywhere: our data has no deed buy-vs-sell
     history, so there is no gross profit, total profit, margin or
     "profit" line in the card or the detail. NO appreciation either:
     no appreciation field exists in the source data, so the detail
     omits it entirely instead of computing it.
   - A section with no real data is omitted, never padded: Landlord
     Insights appears only for landlords, Flipper Insights only for
     flippers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuyerDetail = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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

  /* Count: a real zero is a zero (0 properties on file); only null/blank
     is "not on file". Matches buyer-map.js count(). */
  function count(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US');
  }

  /* Compact money for tight list cells: $140.3M, $2.3M, $254K, $999. */
  function shortMoney(n) {
    if (n == null || n === 0 || n === '' || isNaN(Number(n))) return '—';
    var v = Math.abs(Number(n));
    if (v >= 1000000) return '$' + (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return '$' + Math.round(v / 1000) + 'K';
    return '$' + Math.round(v);
  }

  /* Flips: only a positive count is a count. 0 / missing = not on file. */
  function flips(n) {
    if (n == null || n === '' || isNaN(Number(n)) || Number(n) <= 0) return '—';
    return Number(n).toLocaleString('en-US');
  }
  function hasFlips(b) {
    return !!b && b.fl != null && !isNaN(Number(b.fl)) && Number(b.fl) > 0;
  }

  /* Strategy roles from the bundle `st` string ("Flipper+Landlord"). */
  function roles(b) {
    return String((b && b.st) || '').split('+').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function isFlipper(b) { return roles(b).indexOf('Flipper') !== -1; }
  function isLandlord(b) { return roles(b).indexOf('Landlord') !== -1; }
  function isLender(b) { return roles(b).indexOf('Lender') !== -1; }

  var PILL_COLORS = { Flipper: '#ff6b1a', Landlord: '#22c55e', Lender: '#3b82f6' };
  function pillsHtml(b) {
    return roles(b).map(function (r) {
      var c = PILL_COLORS[r] || '#9ca3af';
      return '<span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:9px;color:#fff;background:' + c + '">' + esc(r) + '</span>';
    }).join(' ');
  }

  /* Buy box, same definition as the list row and the bundle build:
     strategy + avg purchase. Empty string when neither is on file. */
  function buyBoxText(b) {
    var s = (b && b.st) || '';
    if (b && b.ap) s += (s ? ' · ' : '') + '$' + Math.round(Number(b.ap) / 1000) + 'K avg';
    return s;
  }

  /* Performance-card metrics for the list row. `present` is false when the
     underlying field is not on file, so the row can render "—" for it. */
  function cardMetrics(b) {
    b = b || {};
    return [
      { key: 'flips', label: 'Flips', value: flips(b.fl), present: hasFlips(b) },
      { key: 'props', label: 'Properties', value: count(b.pc), present: (b.pc != null && b.pc !== '') },
      { key: 'avgbuy', label: 'Avg buy', value: money(b.ap), present: !!(b.ap && Number(b.ap) > 0) },
      { key: 'portval', label: 'Portfolio', value: money(b.pv), present: !!(b.pv && Number(b.pv) > 0) }
    ];
  }

  var TIER_COLORS = { A: '#22c55e', B: '#3b82f6', C: '#f59e0b', D: '#9ca3af' };
  function scoreChip(b) {
    var t = String((b && b.ti) || '').charAt(0);
    var c = TIER_COLORS[t] || '#9ca3af';
    var sc = (b && b.sc == null) ? '—' : (b.sc + '%');
    return '<span title="' + esc((b && b.ti) || '') + '" style="display:inline-block;min-width:52px;text-align:center;font-weight:700;font-size:12px;padding:3px 8px;border-radius:10px;color:#fff;background:' + c + '">' + esc(sc) + '</span>';
  }

  function kvRow(label, value) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line)"><span style="color:var(--muted)">' + esc(label) + '</span><span style="font-weight:700;text-align:right">' + value + '</span></div>';
  }
  function sectionHead(title) {
    return '<div style="font-weight:800;font-size:13px;margin:14px 0 4px">' + esc(title) + '</div>';
  }

  /* Full buyer detail HTML for the modal body. opts: { rank, total,
     globalIndex, verifiedBadge } — verifiedBadge is the dashboard's own
     ✅ markup (or ''), passed in so this module stays data-only.
     Sections with no real data are omitted, never padded. */
  function detailHtml(b, opts) {
    b = b || {};
    opts = opts || {};
    /* '00000' is a junk placeholder ZIP in the source data (real records
       with no ZIP on file) — show the state only, never the placeholder. */
    var zip = (b.z && b.z !== '00000') ? b.z : '';
    var place = [b.c || '', b.s || '', zip].filter(Boolean).join(', ');
    var rank = (opts.rank != null) ? ('#' + opts.rank + (opts.total ? ' of ' + Number(opts.total).toLocaleString('en-US') : '') + ' · ') : '';
    var h = '<div style="font-size:13px;line-height:1.7">';
    h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">';
    h += '<div><div style="font-weight:800;font-size:17px">' + esc(rank + (b.n || '—')) + '</div>';
    if (place) h += '<div style="color:var(--muted)">' + esc(place) + '</div>';
    h += '</div><div style="flex-shrink:0">' + scoreChip(b) + '</div></div>';
    var pills = pillsHtml(b);
    if (pills || opts.verifiedBadge) h += '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' + pills + (opts.verifiedBadge || '') + '</div>';
    h += '<div style="margin-top:10px">';
    h += kvRow('📞 Phone', b.p ? '<a href="tel:+1' + esc(String(b.p).replace(/\D/g, '')) + '" style="color:#00d4ff">' + esc(String(b.p)) + '</a>' : '—');
    h += kvRow('📍 City / State / ZIP', place ? esc(place) : '—');
    h += '</div>';
    if (isLandlord(b)) {
      h += sectionHead('🏠 Landlord Insights');
      h += kvRow('Properties owned', count(b.pc));
      h += kvRow('Portfolio value', money(b.pv));
      h += kvRow('Avg purchase', money(b.ap));
    }
    if (isFlipper(b)) {
      h += sectionHead('🔄 Flipper Insights');
      h += kvRow('Flips', hasFlips(b) ? flips(b.fl) : '— <span style="font-weight:400;color:var(--muted)">(not on file)</span>');
      h += kvRow('Avg purchase', money(b.ap));
    }
    h += sectionHead('🎯 Buy Box');
    var bb = buyBoxText(b);
    h += '<div style="padding:5px 0">' + (bb ? esc(bb) : '<span style="color:var(--muted)">Buy box not on file</span>') + '</div>';
    if (b.ti) h += '<div style="color:var(--muted);font-size:12px">' + esc(b.ti) + '</div>';
    h += '<div style="font-size:11px;color:var(--muted);margin-top:14px;border-top:1px solid var(--line);padding-top:10px">All figures come from this buyer\u2019s Master Buyers record — the same record the list row shows. No profit or appreciation figures: the dashboard has no deed buy-vs-sell history, so none are shown.</div>';
    if (opts.globalIndex != null) {
      h += '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">';
      h += '<button onclick="mbShowOnMap(' + opts.globalIndex + ')" style="background:#00d4ff;color:#04121a;border:0;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer">🗺️ View on map</button>';
      /* Portfolio: shown only when the caller passes a count. N > 0 opens
         the portfolio view; 0 renders an honest "none on file" line so the
         button is never a dead end. Undefined = pre-portfolio callers. */
      if (opts.portfolioCount != null && opts.portfolioCount > 0) {
        h += '<button onclick="mbOpenPortfolio(' + opts.globalIndex + ')" style="background:#22c55e;color:#fff;border:0;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer">🏠 View portfolio (' + Number(opts.portfolioCount).toLocaleString('en-US') + ')</button>';
      }
      h += '<button onclick="mbFocusBuyer(' + opts.globalIndex + ')" style="background:#ff6b1a;color:#fff;border:0;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer">📋 View in list</button>';
      h += '<button onclick="mbCloseDetail()" style="background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:7px 12px;cursor:pointer">✕ Close</button>';
      h += '</div>';
      if (opts.portfolioCount === 0) h += '<div style="font-size:12px;color:var(--muted);margin-top:8px">No linked properties on file for this buyer.</div>';
    }
    h += '</div>';
    return h;
  }

  return {
    esc: esc,
    money: money,
    count: count,
    shortMoney: shortMoney,
    flips: flips,
    hasFlips: hasFlips,
    roles: roles,
    isFlipper: isFlipper,
    isLandlord: isLandlord,
    isLender: isLender,
    pillsHtml: pillsHtml,
    buyBoxText: buyBoxText,
    cardMetrics: cardMetrics,
    scoreChip: scoreChip,
    detailHtml: detailHtml
  };
});

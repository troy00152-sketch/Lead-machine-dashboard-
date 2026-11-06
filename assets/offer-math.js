// assets/offer-math.js — canonical client-side MAO/LAO math for dashboard pages.
// Extracted VERBATIM from index.html's inline implementation (maoTier,
// maoPriceBand, effectiveMaoMultiplier, fmtMoney — index.html ~lines 2505-2553).
// WHY A SHARED MODULE: the tier table already exists inline in index.html and
// again in command-center.html (calcMAO). New pages must NOT inline a third
// copy — import this module instead (<script src="assets/offer-math.js">).
// This file is the importable canonical copy for client pages; index.html's
// inline copy is the original and must stay in sync until it is switched to
// import this module (that switch is a separate, Troy-approved change — this
// file does NOT touch index.html).
// Rule (unchanged): MAO = (ARV - repairs) x multiplier, multiplier =
// min(calibrated, tier) — calibration can only LOWER MAO, never raise it.
// LAO = MAO x 0.70. No calibration file = tier only, and the UI says so.
// Calibration is PER-MARKET: it applies ONLY to deals in the calibration
// file's market (cal.market). Any other market, or an unknown market, gets
// the tier and the UI says "not calibrated for this market" — a calibration
// must never leak onto another market's deals.
(function (root) {
  'use strict';

  function maoTier(estVal) {
    if (estVal == null) return { tier: null, label: '—' };
    if (estVal < 120000) return { tier: 0.70, label: '70%' };
    if (estVal < 220000) return { tier: 0.80, label: '80%' };
    if (estVal < 300000) return { tier: 0.815, label: '81.5%' };
    if (estVal < 400000) return { tier: 0.829, label: '82.9%' };
    return { tier: 0.849, label: '84.9%' };
  }

  function maoPriceBand(arv) {
    if (arv < 120000) return 'under $120k';
    if (arv < 220000) return '$120k-$220k';
    if (arv < 300000) return '$220k-$300k';
    if (arv < 400000) return '$300k-$400k';
    return '$400k+';
  }

  // Troy's markets, from city + state. Case/whitespace-insensitive; accepts
  // 2-letter state codes and full state names (hand-typed inputs).
  // Unknown/blank/other-city -> null (never guess: a guessed market could
  // mis-apply a calibration to the wrong market's deals).
  //   Indianapolis IN -> 'Indianapolis'; Cleveland OH -> 'Cleveland';
  //   Dayton OH -> 'Dayton'; Kansas City MO/KS -> 'Kansas City';
  //   Charlotte NC / Greenville NC -> 'Carolina'; Jacksonville FL -> 'Jacksonville'.
  // This is the ONE canonical copy of the mapping. index.html imports this
  // module; netlify/functions/dashboard-ai.js takes the market as a label
  // param instead (it cannot reliably require client assets at bundle time).
  var STATE_ALIASES = {
    'indiana': 'IN', 'ohio': 'OH', 'missouri': 'MO', 'kansas': 'KS',
    'north carolina': 'NC', 'florida': 'FL'
  };
  function marketFor(city, state) {
    var c = String(city || '').toLowerCase().replace(/\s+/g, ' ').trim();
    var sRaw = String(state || '').toLowerCase().replace(/\s+/g, ' ').trim();
    var s = sRaw.length === 2 ? sRaw.toUpperCase() : (STATE_ALIASES[sRaw] || '');
    if (!c || !s) return null;
    if (s === 'IN') return c.indexOf('indianapolis') !== -1 ? 'Indianapolis' : null;
    if (s === 'OH') {
      if (c.indexOf('dayton') !== -1) return 'Dayton';
      if (c.indexOf('cleveland') !== -1) return 'Cleveland';
      return null;
    }
    if (s === 'MO' || s === 'KS') return c.indexOf('kansas city') !== -1 ? 'Kansas City' : null;
    if (s === 'NC') return (c.indexOf('charlotte') !== -1 || c.indexOf('greenville') !== -1) ? 'Carolina' : null;
    if (s === 'FL') return c.indexOf('jacksonville') !== -1 ? 'Jacksonville' : null;
    return null;
  }

  // Calibration object shape: { calibrated: true, multiplierMedian, byPriceBand: { band: { median, n } } }
  // Same rule as the server (netlify/functions/dashboard-ai.js offerMath) and
  // index.html: a band median counts only with n >= 8, else the overall median.
  var MAO_CAL = null;

  function setCalibration(cal) {
    MAO_CAL = (cal && cal.calibrated && cal.multiplierMedian) ? cal : null;
  }

  // Browser only: loads assets/mao-calibration.json when present (written by the
  // calibration run, ~/workspace/buyer-hunt-2026/calibrate-mao.js).
  // Fail-soft: no file = tier only. Skipped entirely under Node (tests pass
  // calibration in explicitly via setCalibration).
  function loadMaoCalibration() {
    try {
      if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
      fetch('assets/mao-calibration.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (j && j.calibrated && j.multiplierMedian) MAO_CAL = j;
      }).catch(function () {});
    } catch (e) { /* fail-soft: tier only */ }
  }
  loadMaoCalibration();

  // market: the deal's market label (from marketFor) or null when unknown.
  // Calibration applies ONLY when the deal's market is known AND equals the
  // calibration file's market (cal.market, default 'Indianapolis').
  // Unknown market or a different market -> tier only, labeled accordingly.
  function effectiveMaoMultiplier(arv, market) {
    var t = maoTier(arv);
    if (!t || t.tier == null) return { multiplier: null, label: '—', source: 'none' };
    if (!MAO_CAL) return { multiplier: t.tier, label: t.label + ' tier · not calibrated', source: 'tier', tierMultiplier: t.tier, calibratedMultiplier: null };
    var calMarket = String(MAO_CAL.market || 'Indianapolis').toLowerCase().trim();
    var dealMarket = market == null ? null : String(market).toLowerCase().trim();
    if (!dealMarket || dealMarket !== calMarket) {
      return { multiplier: t.tier, label: t.label + ' tier · not calibrated for this market', source: 'tier', tierMultiplier: t.tier, calibratedMultiplier: null };
    }
    var band = maoPriceBand(arv);
    var entry = (MAO_CAL.byPriceBand || {})[band];
    var cal = MAO_CAL.multiplierMedian, calSrc = 'calibrated overall median';
    if (entry && entry.n >= 8) { cal = entry.median; calSrc = 'calibrated ' + band + ' band (n=' + entry.n + ')'; }
    if (cal < t.tier) return { multiplier: cal, label: (cal * 100).toFixed(1) + '% calibrated', source: calSrc, tierMultiplier: t.tier, calibratedMultiplier: cal };
    return { multiplier: t.tier, label: t.label + ' tier', source: 'tier — calibrated ' + (cal * 100).toFixed(1) + '% is higher', tierMultiplier: t.tier, calibratedMultiplier: cal };
  }

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Math.round(n).toLocaleString();
  }

  // Convenience wrapper: same shape as the server offerMath().
  // calibration param is optional; when omitted the module-level MAO_CAL applies.
  // market param is the deal's market label (from marketFor) or null when
  // unknown — calibration applies only when it matches cal.market.
  function offerMath(arv, repairs, calibration, market) {
    if (calibration !== undefined) setCalibration(calibration);
    var em = effectiveMaoMultiplier(arv, market);
    if (arv == null || em.multiplier == null) return { tier: null, multiplier: null, source: 'none', mao: null, lao: null };
    var mao = Math.max(0, Math.round((arv - Math.max(0, Number(repairs) || 0)) * em.multiplier));
    var lao = Math.round(mao * 0.70);
    return { tier: em.tierMultiplier != null ? em.tierMultiplier : em.multiplier, multiplier: em.multiplier, source: em.source, label: em.label, mao: mao, lao: lao };
  }

  var api = { maoTier: maoTier, maoPriceBand: maoPriceBand, marketFor: marketFor, effectiveMaoMultiplier: effectiveMaoMultiplier, fmtMoney: fmtMoney, offerMath: offerMath, setCalibration: setCalibration, getCalibration: function () { return MAO_CAL; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OfferMath = api;
})(typeof window !== 'undefined' ? window : globalThis);

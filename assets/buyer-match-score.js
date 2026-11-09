// assets/buyer-match-score.js — the dashboard's Buyer Match Score (our own
// buyer-side parallel of the Sellability Score). 0-1000, rules-based,
// client-side, $0 — no per-deal AI calls, no credits, no new paid service.
// Every point is explainable: the score returns its top 3 reasons, so any
// buyer's number can always be defended.
//
// WHAT IT ANSWERS: "who is most likely to buy THIS deal" — a per-deal
// ranking, not a buyer-quality rating in the abstract. The same buyer
// scores differently on different deals (a landlord in Cleveland scores
// high on a Cleveland rental, low on an Indianapolis flip).
//
// HOW IT RELATES TO THE EXISTING MATCHERS (it does NOT replace them):
//   - netlify/functions/buyer-match.js scores 0-99 (geo 40 + price 30 +
//     activity 20 + strategy 10, verified +20, floor 35) and returns the
//     top 100 buyers for the Buyer Match Ai page.
//   - netlify/functions/dashboard-ai.js matchBuyersLookup mirrors that
//     0-99 scoring for the dashboard AI chat tool.
//   This module scores the SAME signals on the sellability 0-1000 scale
//   with reasons attached, so the page can show WHY each buyer ranks
//   where it does. The 0-99 server score stays untouched and stays
//   visible next to the new score.
//
// FORMULA (buckets sum to 1000):
//   Market fit    /250 — same ZIP 250, same city 210, same state + ZIP3
//                          150, same state 100, else 0. A buyer with no
//                          location on file scores 0 here (flagged).
//   Price fit     /250 — deal price vs the buyer's avg purchase (the buy
//                          box IS strategy + avg purchase — no min/max
//                          price range exists anywhere in the data).
//                          log2-ratio curve, same shape as the existing
//                          priceScore, scaled: exact match 250, 2x off
//                          125, 4x off 0. No price or no avg -> 0.
//   Activity      /150 — flips (0 / 25 / 45 / 65 / 80 / 90) + properties
//                          owned (0 / 10 / 25 / 40 / 50 / 60) + county
//                          parcels on file +20 when the caller supplies
//                          them. Capped at 150. Real activity beats a
//                          bare record; a bare record scores 0 here.
//   Strategy fit  /150 — buyer strategy vs the deal type. Deal type is
//                          optional: flip -> flipper 150, rental ->
//                          landlord 150, land -> land-name investor 150.
//                          Wrong-side strategy still earns partial
//                          credit (60/40) — strategy is a preference,
//                          not a hard filter. Deal type unknown ->
//                          both strategies 120, one 90, none 0.
//   Verified      /200 — ✅ Verified buyer. Same weight as the existing
//                          rule (+20 on the 0-99 scale ~= 20%), so a
//                          verified buyer ranks first among equals but
//                          verification alone never outranks geography +
//                          price fit + activity combined.
// TIERS (same thresholds as sellability):
//   750+ BEST MATCH | 550+ STRONG | 350+ POSSIBLE | 150+ WEAK | else POOR.
//   A buyer with no usable signal at all scores 0 / NO DATA.
//   A buyer with no buy box and no history CANNOT outscore a buyer with
//   real signals: every bucket with missing data scores 0 and the gap is
//   listed in `missing` — missing data caps the score, never inflates it.
//
// HONEST LIMITS (documented, not hidden):
//   - There is NO buy-box price range in the data (no min/max). Price
//     fit is closeness to avg purchase only. A buyer whose range is
//     really "$50K-$80K" looks the same as one averaging $65K.
//   - There is NO recency signal: no last-purchase date, no last
//     activity date, so a buyer who stopped buying in 2021 scores the
//     same as one who bought last month. Flips and portfolio size are
//     lifetime totals, not recent activity.
//   - There is NO profit / margin signal and NO off-market preference
//     signal anywhere in the data — neither is scored, neither is
//     invented.
//   - The legacy `sc` (0-100) / `ti` tier on master-buyers.js is NOT an
//     input: it is an opaque output of an older system with unknown
//     provenance. The score is built from raw fields only.
//   - Verified status is an INPUT, not something this module looks up:
//     pass `verified: true/false` on the buyer record, or a
//     phone-keyed verifiedMap as the third argument (same shape as the
//     buyer-verify list endpoint). Without either, the bucket scores 0
//     and the gap is listed in `missing`.
//
// INPUT:
//   deal: { city, state, zip, price, propertyType, dealType }
//         dealType is optional ('flip' | 'rental' | 'land' | '') — when
//         absent it is derived from propertyType ('land' when the type
//         mentions land/vacant), else treated as unknown.
//   buyer, either shape:
//     - master-buyers.js: { n, p, c, s, z, pc, st, ap, pv, fl }
//     - buyer-match server row: { name, city, state, zip, areas, states,
//       portfolioCount, portfolioValue, avgPurchase, flips, isFlipper,
//       isLandlord, verified, ... }
//     Optional extras the caller may attach: verified (boolean),
//     countyParcels (number of county-matched parcels with card detail).
//   opts (optional): { verifiedMap } — { digits10: {name, how, at} }.
(function (root) {
  'use strict';

  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    return d.length === 11 && d.charAt(0) === '1' ? d.slice(1) : d;
  }

  function zip5(v) {
    var z = String(v == null ? '' : v).replace(/\D/g, '');
    return z.length >= 5 ? z.slice(0, 5) : '';
  }

  function normCity(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
  }

  function normState(v) {
    return String(v == null ? '' : v).trim().toUpperCase();
  }

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US');
  }

  // ---- Buyer record normalizer (both shapes in, one shape out) ----
  function normalizeBuyer(b) {
    b = b || {};
    var isFlipper = b.isFlipper === true;
    var isLandlord = b.isLandlord === true;
    var strat = typeof b.st === 'string' ? b.st : '';
    if (strat) {
      if (/flipper/i.test(strat)) isFlipper = true;
      if (/landlord/i.test(strat)) isLandlord = true;
    }
    var phones = [];
    if (b.p) phones.push(b.p);
    if (Array.isArray(b.phones)) {
      b.phones.forEach(function (p) { if (p && p.phone) phones.push(p.phone); });
    }
    return {
      name: b.n || b.name || '',
      phone: phones[0] || '',
      phones: phones,
      city: b.c || b.city || '',
      state: b.s || b.state || '',
      zip: zip5(b.z != null ? b.z : b.zip),
      areas: b.ct || b.areas || [],
      states: Array.isArray(b.states) ? b.states : [],
      pc: Number(b.pc != null ? b.pc : b.portfolioCount) || 0,
      ap: Number(b.ap != null ? b.ap : b.avgPurchase) || 0,
      pv: Number(b.pv != null ? b.pv : b.portfolioValue) || 0,
      fl: Number(b.fl != null ? b.fl : b.flips) || 0,
      isFlipper: isFlipper,
      isLandlord: isLandlord,
      hasStrategy: isFlipper || isLandlord,
      verified: b.verified === true ? true : (b.verified === false ? false : null),
      countyParcels: Number(b.countyParcels) || 0
    };
  }

  function dealTypeOf(deal) {
    var t = String((deal && deal.dealType) || '').trim().toLowerCase();
    if (t === 'flip' || t === 'rental' || t === 'land') return t;
    var pt = String((deal && deal.propertyType) || '').toLowerCase();
    if (/land|vacant/.test(pt)) return 'land';
    return '';
  }

  function buyerMatchScore(deal, buyer, opts) {
    var empty = { score: 0, score100: 0, label: 'NO DATA', color: 'gray', parts: [], marketPts: 0, pricePts: 0, activityPts: 0, strategyPts: 0, verifiedPts: 0, market: 0, price: 0, activity: 0, strategy: 0, verified: 0, topReasons: [], missing: ['No buyer data on this record'], coverage: 0 };
    if (!buyer) return empty;
    deal = deal || {};
    var nb = normalizeBuyer(buyer);
    var hasAnything = nb.name || nb.phone || nb.city || nb.state || nb.zip ||
      nb.pc > 0 || nb.ap > 0 || nb.pv > 0 || nb.fl > 0 || nb.hasStrategy ||
      nb.verified === true || nb.verified === false || nb.countyParcels > 0;
    if (!hasAnything) return empty;

    var parts = [];
    var missing = [];

    var dealCity = normCity(deal.city);
    var dealState = normState(deal.state);
    var dealZip = zip5(deal.zip);
    var dealPrice = Number(deal.price) || 0;
    var dealHasLocation = !!(dealCity || dealState || dealZip);
    var dtype = dealTypeOf(deal);

    // ---- Market fit /250 ----
    var marketPts = 0;
    var marketKnown = !!(nb.city || nb.state || nb.zip || (nb.areas && nb.areas.length) || (nb.states && nb.states.length));
    if (!dealHasLocation) {
      missing.push('No deal location — market fit unknown');
    } else if (!marketKnown) {
      missing.push('No location on file — market fit unknown');
    } else if (dealZip && nb.zip && dealZip === nb.zip) {
      marketPts = 250;
      parts.push({ label: 'Same ZIP ' + dealZip, pts: 250 });
    } else {
      var buyerCities = [];
      if (nb.city) buyerCities.push(normCity(nb.city));
      (nb.areas || []).forEach(function (a) { buyerCities.push(normCity(a)); });
      var buyerStates = [];
      if (nb.state) buyerStates.push(normState(nb.state));
      (nb.states || []).forEach(function (s) { buyerStates.push(normState(s)); });
      if (dealCity && buyerCities.indexOf(dealCity) !== -1) {
        marketPts = 210;
        parts.push({ label: 'Same city ' + deal.city, pts: 210 });
      } else if (dealState && buyerStates.indexOf(dealState) !== -1) {
        if (dealZip && nb.zip && dealZip.slice(0, 3) === nb.zip.slice(0, 3)) {
          marketPts = 150;
          parts.push({ label: 'Same state, nearby ZIP area', pts: 150 });
        } else {
          marketPts = 100;
          parts.push({ label: 'Same state ' + dealState, pts: 100 });
        }
      }
    }

    // ---- Price fit /250 (buy box = avg purchase; no range exists) ----
    var pricePts = 0;
    var priceKnown = dealPrice > 0 && nb.ap > 0;
    if (!priceKnown) {
      if (!(dealPrice > 0)) missing.push('No asking price — price fit unknown');
      if (!(nb.ap > 0)) missing.push('No avg purchase on file — buy box unknown');
    } else {
      var dist = Math.abs(Math.log2(dealPrice / nb.ap));
      pricePts = Math.max(0, Math.round(250 * (1 - dist / 2)));
      if (pricePts > 0) parts.push({ label: 'Avg buy ' + money(nb.ap) + ' vs asking ' + money(dealPrice), pts: pricePts });
    }

    // ---- Activity /150 (flips + properties owned + county parcels) ----
    var activityPts = 0;
    var activityKnown = nb.pc > 0 || nb.fl > 0 || nb.pv > 0 || nb.countyParcels > 0;
    if (!activityKnown) {
      missing.push('No purchase history on file');
    } else {
      var flPts = nb.fl <= 0 ? 0 : nb.fl <= 2 ? 25 : nb.fl <= 9 ? 45 : nb.fl <= 29 ? 65 : nb.fl <= 99 ? 80 : 90;
      var pcPts = nb.pc <= 0 ? 0 : nb.pc <= 4 ? 10 : nb.pc <= 19 ? 25 : nb.pc <= 99 ? 40 : nb.pc <= 499 ? 50 : 60;
      var coPts = nb.countyParcels > 0 ? 20 : 0;
      if (flPts > 0) parts.push({ label: nb.fl + ' flip' + (nb.fl === 1 ? '' : 's'), pts: flPts });
      if (pcPts > 0) parts.push({ label: nb.pc + ' propert' + (nb.pc === 1 ? 'y' : 'ies') + ' owned', pts: pcPts });
      if (coPts > 0) parts.push({ label: nb.countyParcels + ' county parcel' + (nb.countyParcels === 1 ? '' : 's') + ' on file', pts: coPts });
      activityPts = Math.min(150, flPts + pcPts + coPts);
    }

    // ---- Strategy fit /150 ----
    var strategyPts = 0;
    var strategyKnown = nb.hasStrategy;
    var landName = /land/i.test(nb.name) && !/landlord/i.test(nb.name);
    if (!strategyKnown && !landName) {
      missing.push('No strategy on file');
    } else if (dtype === 'land') {
      if (landName) { strategyPts = 150; parts.push({ label: 'Land investor — matches land deal', pts: 150 }); }
      else if (nb.isFlipper && nb.isLandlord) { strategyPts = 90; parts.push({ label: 'Flipper + Landlord — buys houses, land adjacent', pts: 90 }); }
      else if (nb.isFlipper) { strategyPts = 60; parts.push({ label: 'Flipper — land deal', pts: 60 }); }
      else if (nb.isLandlord) { strategyPts = 40; parts.push({ label: 'Landlord only — land deal', pts: 40 }); }
      else { strategyPts = 0; missing.push('No strategy on file'); }
    } else if (dtype === 'flip') {
      if (nb.isFlipper) { strategyPts = 150; parts.push({ label: 'Flipper — matches flip deal', pts: 150 }); }
      else if (nb.isLandlord) { strategyPts = 60; parts.push({ label: 'Landlord only — flip deal', pts: 60 }); }
      else { strategyPts = 0; missing.push('No strategy on file'); }
    } else if (dtype === 'rental') {
      if (nb.isLandlord) { strategyPts = 150; parts.push({ label: 'Landlord — matches rental deal', pts: 150 }); }
      else if (nb.isFlipper) { strategyPts = 60; parts.push({ label: 'Flipper only — rental deal', pts: 60 }); }
      else { strategyPts = 0; missing.push('No strategy on file'); }
    } else {
      // Deal type unknown: credit having a strategy, both beats one.
      if (nb.isFlipper && nb.isLandlord) { strategyPts = 120; parts.push({ label: 'Flipper + Landlord strategy', pts: 120 }); }
      else if (nb.isFlipper) { strategyPts = 90; parts.push({ label: 'Flipper strategy', pts: 90 }); }
      else if (nb.isLandlord) { strategyPts = 90; parts.push({ label: 'Landlord strategy', pts: 90 }); }
      else { strategyPts = 0; missing.push('No strategy on file'); }
    }

    // ---- Verified /200 (same weight as the existing +20 on the 0-99 scale) ----
    var verifiedPts = 0;
    var verifiedKnown = nb.verified === true || nb.verified === false;
    var verified = nb.verified;
    if (verified == null && opts && opts.verifiedMap) {
      verifiedKnown = true;
      verified = false;
      for (var i = 0; i < nb.phones.length; i++) {
        if (opts.verifiedMap[digits10(nb.phones[i])]) { verified = true; break; }
      }
    }
    if (verified === true) {
      verifiedPts = 200;
      parts.push({ label: '✅ Verified buyer', pts: 200 });
    } else if (!verifiedKnown) {
      missing.push('Verified status not checked');
    }

    var coverage = (marketKnown ? 1 : 0) + (priceKnown ? 1 : 0) + (activityKnown ? 1 : 0) + (strategyKnown || landName ? 1 : 0) + (verifiedKnown ? 1 : 0);
    if (coverage === 0) {
      return { score: 0, score100: 0, label: 'NO DATA', color: 'gray', parts: [], marketPts: 0, pricePts: 0, activityPts: 0, strategyPts: 0, verifiedPts: 0, market: 0, price: 0, activity: 0, strategy: 0, verified: 0, topReasons: [], missing: missing.length ? missing : ['No buyer data on this record'], coverage: 0 };
    }

    var score = Math.max(0, Math.min(1000, marketPts + pricePts + activityPts + strategyPts + verifiedPts));
    var label = score >= 750 ? 'BEST MATCH' : score >= 550 ? 'STRONG' : score >= 350 ? 'POSSIBLE' : score >= 150 ? 'WEAK' : 'POOR';
    var color = score >= 750 ? 'red' : score >= 550 ? 'orange' : score >= 350 ? 'blue' : 'gray';
    parts.sort(function (a, b) { return b.pts - a.pts; });
    var topReasons = parts.slice(0, 3).map(function (p) { return p.label + ' (+' + p.pts + ')'; });
    return {
      score: score,
      score100: Math.round(score / 10),
      label: label,
      color: color,
      parts: parts,
      marketPts: marketPts,
      pricePts: pricePts,
      activityPts: activityPts,
      strategyPts: strategyPts,
      verifiedPts: verifiedPts,
      market: marketPts,
      price: pricePts,
      activity: activityPts,
      strategy: strategyPts,
      verified: verifiedPts,
      topReasons: topReasons,
      missing: missing,
      coverage: coverage
    };
  }

  // Rank a list of buyers for one deal, best first. Verified status may
  // come from the buyer records themselves or from a phone-keyed
  // verifiedMap (buyer-verify list shape). Ties break on portfolio size.
  function rankBuyers(deal, buyers, verifiedMap) {
    var list = (buyers || []).map(function (b) {
      return { buyer: b, match: buyerMatchScore(deal, b, verifiedMap ? { verifiedMap: verifiedMap } : undefined) };
    });
    list.sort(function (x, y) {
      if (y.match.score !== x.match.score) return y.match.score - x.match.score;
      var xpc = Number((x.buyer && (x.buyer.pc != null ? x.buyer.pc : x.buyer.portfolioCount)) || 0);
      var ypc = Number((y.buyer && (y.buyer.pc != null ? y.buyer.pc : y.buyer.portfolioCount)) || 0);
      return ypc - xpc;
    });
    return list;
  }

  var api = {
    buyerMatchScore: buyerMatchScore,
    matchScore: buyerMatchScore,
    rankBuyers: rankBuyers,
    normalizeBuyer: normalizeBuyer,
    dealTypeOf: dealTypeOf,
    TIERS: { BEST_MATCH: 750, STRONG: 550, POSSIBLE: 350, WEAK: 150 },
    BUCKETS: { market: 250, price: 250, activity: 150, strategy: 150, verified: 200 }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.buyerMatchScore = buyerMatchScore;
  root.BuyerMatchScore = api;
})(typeof window !== 'undefined' ? window : globalThis);

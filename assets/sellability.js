// assets/sellability.js — the dashboard's Sellability Score (our own, smarter, nationwide).
// 0-1000, 500 = midpoint. Rules-based, client-side, $0 — no per-lead AI calls,
// no credits, no new paid service. Every point is explainable: the score
// returns its top 3 reasons, so a lead's number can always be defended.
//
// WHY 0-1000: matches the Leadflow Sellability Score feel Troy asked for
// (0-1,000, 500 median, 900+ = far more likely to sell). We cannot copy
// Leadflow's model — it is trained on their 40 years of transactions — so
// ours scores the signals PropertyReach actually returns, nationwide.
// 500 is the scale midpoint and roughly the score of a typical working
// lead (one distress signal, middling equity). 550+ is HOT, as before.
//
// FORMULA (buckets sum to 1000):
//   Distress        /400 — distress signals, first at full weight, each
//                          additional at half, capped at 400.
//   Equity          /300 — >=90% -> 300, >=75% -> 270, >=60% -> 230,
//                          >=50% -> 190, >=35% -> 140, >=20% -> 90, >0% -> 40.
//   Ownership       /150 — absentee +60, out-of-state +40, years owned
//                          >=20 -> 60, >=10 -> 50, >=5 -> 30, >=1 -> 10,
//                          free & clear +40. Capped at 150.
//   Stack & Condition /150 — distinct distress lists 1 -> 40, 2 -> 70,
//                          3 -> 100, 4+ -> 120 (the Super Stack, made
//                          explicit); property age built <1960 -> +30,
//                          1960-1979 -> +15. Capped at 150.
// TIERS (same thresholds as the old 0-100 score, x10):
//   750+ LAYUP - HIT HARD | 550+ HOT | 350+ WARM | 150+ COOL | else COLD.
//   A record with no usable input at all scores 0 / NO DATA.
//
// NATIONWIDE: no market, ZIP, or calibration input anywhere in here —
// the Indianapolis MAO calibration is market-gated and never used by the
// score. Any US property scores from the same nationally available
// PropertyReach fields. When a signal is missing, that bucket scores 0
// and the gap is listed in `missing` — the score never fails and never
// invents data.
//
// BACKWARDS COMPAT: the return keeps the old field names (distressPts,
// equityPts, ownPts, parts, signals, label, color) on the NEW caps, plus
// legacy aliases (distress/equity/own) and score100 = round(score/10),
// the old 0-100 number, so old displays keep working. The old 0-100
// score was Distress/45 + Equity/35 + Ownership/20; the new score is
// that model grown up: same signals, same tiers x10, plus the stack &
// condition bucket and a top-3-reasons explanation.
//
// INPUT: one lead/property object, either shape:
//   - dashboard lead shape (index.html): preforeclosure, isPreforeclosure,
//     foreclosureStatus, taxDelinquentYear, taxDelinquent, numLiens,
//     _stackSignals/stackSignals, distressSignal, absenteeOwner,
//     ownerOccupied, outOfStateOwner, lastSaleDate, dmNumMortgages,
//     _freeAndClear, dmEquityPct/equityPct/estimatedEquityPct,
//     estimatedValue/arv, dmEquity/equityAmount, yearBuilt.
//   - data-api subject shape (command-center.html): preForeclosure,
//     preProbate, bankruptcy, taxDelinquency, taxDelinquencyYear, vacant,
//     lienCount, estimatedEquityRatio, absentee, freeAndClear,
//     ownershipMonths, lastSaleDate, yearBuilt, flags[], mailingAddress.
(function (root) {
  'use strict';

  function isAffirmative(v) {
    if (v === true || v === 1) return true;
    if (v == null) return false;
    var s = String(v).trim().toLowerCase();
    return ['','no','n','false','0','none','n/a','na'].indexOf(s) === -1;
  }

  var KNOWN_SIGNALS = ['Pre-Foreclosure','Foreclosure','Tax Delinquent','Delinquent Tax Activity','Code Violations','Vacant / Abandoned','Vacancy','Probate / Inherited','Deceased / Probate','Divorce','Bankruptcy','Liens / Judgments','Absentee Owner','Tired Landlord'];
  // Distress weights: the old 0-100 weights (8-18) x10. First signal pays
  // full weight, each additional signal pays half (breadth matters, but
  // the top signal is what drives the deal).
  var SIGNAL_WEIGHTS = { 'Pre-Foreclosure':180, 'Foreclosure':180, 'Tax Delinquent':160, 'Delinquent Tax Activity':140, 'Probate / Inherited':160, 'Deceased / Probate':160, 'Divorce':140, 'Bankruptcy':140, 'Code Violations':120, 'Vacant / Abandoned':120, 'Vacancy':120, 'Liens / Judgments':100, 'Tired Landlord':100, 'Absentee Owner':80 };

  // Map data-api subject flags[] (snake_case) onto the same signal names.
  var FLAG_TO_SIGNAL = {
    'pre_foreclosure': 'Pre-Foreclosure',
    'pre_probate': 'Probate / Inherited',
    'bankruptcy': 'Bankruptcy',
    'vacant': 'Vacant / Abandoned',
    'liens_on_record': 'Liens / Judgments',
    'absentee_owner': 'Absentee Owner'
  };

  function signalList(x) {
    var out = [];
    function add(s) { if (s && out.indexOf(s) === -1) out.push(s); }
    if (isAffirmative(x.preforeclosure) || isAffirmative(x.isPreforeclosure) || isAffirmative(x.preforeclosureStatus) || isAffirmative(x.preForeclosure)) add('Pre-Foreclosure');
    if (isAffirmative(x.foreclosureStatus)) add('Foreclosure');
    if (isAffirmative(x.taxDelinquentYear) || isAffirmative(x.taxDelinquent) || isAffirmative(x.taxDelinquency)) add('Tax Delinquent');
    if (isAffirmative(x.preProbate)) add('Probate / Inherited');
    if (isAffirmative(x.bankruptcy)) add('Bankruptcy');
    if (isAffirmative(x.vacant)) add('Vacant / Abandoned');
    if ((Number(x.numLiens) || 0) > 0 || (Number(x.lienCount) || 0) > 0) add('Liens / Judgments');
    (x._stackSignals || x.stackSignals || []).forEach(function (s) { if (KNOWN_SIGNALS.indexOf(s) !== -1) add(s); });
    (x.flags || []).forEach(function (f) {
      var fl = String(f || '');
      if (FLAG_TO_SIGNAL[fl]) add(FLAG_TO_SIGNAL[fl]);
      else if (/^tax_delinquent/.test(fl)) add('Tax Delinquent');
    });
    var sig = String(x.distressSignal || '');
    if (KNOWN_SIGNALS.indexOf(sig) !== -1) add(sig);
    else if (/probate|deceased/i.test(sig)) add('Probate / Inherited');
    else if (/code violation/i.test(sig)) add('Code Violations');
    else if (/vacan/i.test(sig)) add('Vacant / Abandoned');
    else if (/tax/i.test(sig)) add('Tax Delinquent');
    else if (/divorce/i.test(sig)) add('Divorce');
    else if (/bankrupt/i.test(sig)) add('Bankruptcy');
    else if (/pre-?foreclos/i.test(sig)) add('Pre-Foreclosure');
    else if (/lien/i.test(sig)) add('Liens / Judgments');
    if (isAffirmative(x.absenteeOwner) || x.ownerOccupied === false || x.ownerOccupied === 'No' || x.absentee === true) add('Absentee Owner');
    return out;
  }

  function equityPct(x) {
    // Candidates in order: explicit percents (0-100), then ratios (0-1).
    var pct = x.dmEquityPct != null ? x.dmEquityPct : (x.equityPct != null ? x.equityPct : (x.estimatedEquityPct != null ? x.estimatedEquityPct : null));
    if (pct != null) {
      pct = Number(pct);
      if (!isNaN(pct)) return pct > 0 && pct <= 1.5 ? pct * 100 : pct;
    }
    var ratio = x.estimatedEquityRatio != null ? Number(x.estimatedEquityRatio) : NaN;
    if (!isNaN(ratio)) return ratio * 100;
    var val = Number(x.estimatedValue != null ? x.estimatedValue : x.arv) || null;
    var eq = Number(x.dmEquity != null ? x.dmEquity : x.equityAmount);
    if (val && !isNaN(eq) && (x.dmEquity != null || x.equityAmount != null)) return Math.max(0, Math.min(100, eq / val * 100));
    if (isFreeAndClear(x)) return 100;
    return null;
  }

  function isFreeAndClear(x) {
    if (x.freeAndClear === true) return true;
    if (x.dmNumMortgages != null && Number(x.dmNumMortgages) === 0) return true;
    if (x._freeAndClear) return true;
    var rawStack = x._stackSignals || x.stackSignals || [];
    return rawStack.indexOf('Free & Clear') !== -1;
  }

  function yearsOwned(x) {
    if (x.ownershipMonths != null && !isNaN(Number(x.ownershipMonths))) return Number(x.ownershipMonths) / 12;
    if (x.lastSaleDate) {
      var d = new Date(x.lastSaleDate);
      if (!isNaN(d)) return (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
    }
    return null;
  }

  function stateFromAddress(addr) {
    // Pull the 2-letter state token that sits just before the ZIP at the
    // end of a US address ("123 Main St, Greenville, NC 27834" -> "NC").
    var m = String(addr || '').match(/,\s*([A-Za-z]{2})\s+\d{5}(-\d{4})?\s*$/);
    return m ? m[1].toUpperCase() : null;
  }

  function isOutOfState(x) {
    if (isAffirmative(x.outOfStateOwner)) return true;
    if (x.outOfStateOwner === false) return false;
    // Derive it when the record carries a mailing address: owner mail
    // goes to a different state than the property sits in.
    if (x.mailingAddress) {
      var mailState = stateFromAddress(x.mailingAddress);
      var propState = stateFromAddress(x.address) || (x.state ? String(x.state).toUpperCase() : null);
      if (mailState && propState) return mailState !== propState;
    }
    return false;
  }

  function wholesaleScore(x) {
    var empty = { score: 0, score100: 0, label: 'NO DATA', color: 'gray', parts: [], signals: [], distressPts: 0, equityPts: 0, ownPts: 0, stackPts: 0, distress: 0, equity: 0, own: 0, topReasons: [], missing: ['No property data on this record'], coverage: 0 };
    if (!x) return empty;
    var signals = signalList(x);
    var parts = [];
    var missing = [];

    // ---- Distress /400 ----
    var distressPts = 0;
    signals.slice().sort(function (a, b) { return (SIGNAL_WEIGHTS[b] || 80) - (SIGNAL_WEIGHTS[a] || 80); }).forEach(function (s, i) {
      var w = SIGNAL_WEIGHTS[s] || 80;
      var pts = i === 0 ? w : Math.round(w / 2);
      distressPts += pts;
      parts.push({ label: s, pts: pts });
    });
    distressPts = Math.min(400, distressPts);
    var signalsKnown = signals.length > 0
      || (x._stackSignals || x.stackSignals || []).length > 0
      || (x.flags || []).length > 0
      || String(x.distressSignal || '').length > 0
      || x.preforeclosure !== undefined || x.preForeclosure !== undefined
      || x.foreclosureStatus !== undefined || x.taxDelinquent !== undefined
      || x.taxDelinquency !== undefined || x.preProbate !== undefined
      || x.bankruptcy !== undefined || x.vacant !== undefined
      || x.numLiens !== undefined || x.lienCount !== undefined;

    // ---- Equity /300 ----
    var pct = equityPct(x);
    var equityPts = 0;
    if (pct != null) {
      equityPts = pct >= 90 ? 300 : pct >= 75 ? 270 : pct >= 60 ? 230 : pct >= 50 ? 190 : pct >= 35 ? 140 : pct >= 20 ? 90 : pct > 0 ? 40 : 0;
      if (equityPts) parts.push({ label: 'Equity ' + Math.round(pct) + '%', pts: equityPts });
    } else {
      missing.push('Equity unknown — no equity figure on this record');
    }

    // ---- Ownership /150 ----
    var ownPts = 0;
    var ownKnown = false;
    if (signals.indexOf('Absentee Owner') !== -1) { ownPts += 60; parts.push({ label: 'Owner lives elsewhere', pts: 60 }); ownKnown = true; }
    if (isOutOfState(x)) { ownPts += 40; parts.push({ label: 'Out-of-state owner', pts: 40 }); ownKnown = true; }
    var yrs = yearsOwned(x);
    if (yrs != null) {
      ownKnown = true;
      var yPts = yrs >= 20 ? 60 : yrs >= 10 ? 50 : yrs >= 5 ? 30 : yrs >= 1 ? 10 : 0;
      if (yPts) { ownPts += yPts; parts.push({ label: 'Owned ' + Math.floor(yrs) + ' yrs', pts: yPts }); }
    }
    if (isFreeAndClear(x)) { ownPts += 40; parts.push({ label: 'Free & clear', pts: 40 }); ownKnown = true; }
    if (x.dmNumMortgages != null || x.freeAndClear === true || x.freeAndClear === false) ownKnown = ownKnown || (x.dmNumMortgages != null);
    if (!ownKnown) missing.push('Ownership history unknown — no sale date, tenure, or occupancy on this record');
    ownPts = Math.min(150, ownPts);

    // ---- Stack & Condition /150 (NEW: the Super Stack, made explicit) ----
    var stackPts = 0;
    var listCount = signals.filter(function (s) { return s !== 'Absentee Owner'; }).length;
    if (listCount > 0) {
      var sPts = listCount >= 4 ? 120 : listCount === 3 ? 100 : listCount === 2 ? 70 : 40;
      stackPts += sPts;
      parts.push({ label: 'On ' + listCount + ' distress list' + (listCount > 1 ? 's' : ''), pts: sPts });
    }
    var ageKnown = x.yearBuilt != null && !isNaN(Number(x.yearBuilt));
    if (ageKnown) {
      var yb = Number(x.yearBuilt);
      var aPts = yb < 1960 ? 30 : yb < 1980 ? 15 : 0;
      if (aPts) { stackPts += aPts; parts.push({ label: 'Built ' + yb + ' — older home', pts: aPts }); }
    }
    stackPts = Math.min(150, stackPts);

    var coverage = (signalsKnown ? 1 : 0) + (pct != null ? 1 : 0) + (ownKnown ? 1 : 0) + ((listCount > 0 || ageKnown) ? 1 : 0);
    if (coverage === 0) return empty;

    var score = Math.max(0, Math.min(1000, distressPts + equityPts + ownPts + stackPts));
    var label = score >= 750 ? 'LAYUP — HIT HARD' : score >= 550 ? 'HOT' : score >= 350 ? 'WARM' : score >= 150 ? 'COOL' : 'COLD';
    var color = score >= 750 ? 'red' : score >= 550 ? 'orange' : score >= 350 ? 'blue' : 'gray';
    parts.sort(function (a, b) { return b.pts - a.pts; });
    var topReasons = parts.slice(0, 3).map(function (p) { return p.label + ' (+' + p.pts + ')'; });
    return {
      score: score,
      score100: Math.round(score / 10),
      label: label,
      color: color,
      parts: parts,
      signals: signals,
      distressPts: distressPts,
      equityPts: equityPts,
      ownPts: ownPts,
      stackPts: stackPts,
      distress: distressPts,
      equity: equityPts,
      own: ownPts,
      topReasons: topReasons,
      missing: missing,
      coverage: coverage
    };
  }

  var api = {
    wholesaleScore: wholesaleScore,
    sellabilityScore: wholesaleScore,
    scoreSignalList: signalList,
    scoreEquityPct: equityPct,
    TIERS: { LAYUP: 750, HOT: 550, WARM: 350, COOL: 150 },
    BUCKETS: { distress: 400, equity: 300, ownership: 150, stackCondition: 150 }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.wholesaleScore = wholesaleScore;
  root.sellabilityScore = wholesaleScore;
  root.Sellability = api;
})(typeof window !== 'undefined' ? window : globalThis);

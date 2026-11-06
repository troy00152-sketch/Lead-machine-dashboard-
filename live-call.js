// live-call.js — Live Call Console (Ginn improvement #4) for Troy + Irish.
// PREP + DEBRIEF ONLY. No live-interrupt, no listening, no recording, no mic,
// no auto-dialing. This page never hears a call — Troy/Irish type what happened.
// Objection lines come from window.LIVE_CALL_OBJECTIONS, inlined at build time
// from the SMS bot's vetted kb.json `objections` array (77 lines, Troy-voiced).
// See build-live-call.py. Never paste Ginn's unvetted lines here.
// MAO/LAO math lives in assets/offer-math.js (canonical, shared) — this file
// calls OfferMath.offerMath and never re-implements the tiers.
(function (root) {
  'use strict';

  // ---------- pure helpers (Node-testable) ----------

  function slugify(address) {
    return String(address || 'no-address').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'no-address';
  }

  function todayISO(d) {
    var x = d ? new Date(d) : new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  // The vetted kb.json replies are written in the bot's voice ("I'm Ashley ...").
  // The bot's loader swaps the persona name at runtime; this page does the same
  // for the human caller (Troy or Irish) and fills [city] when known. Nothing
  // else in the reply text is changed — the copy stays verbatim.
  function renderReply(reply, callerName, city) {
    var out = String(reply || '');
    if (callerName) out = out.replace(/\bAshley\b/g, callerName).replace(/\bAmber\b/g, callerName);
    if (city) out = out.replace(/\[city\]/g, city);
    return out;
  }

  var CAT_LABELS = {
    open: 'Opening', price: 'Price', stall: 'Stall / think about it',
    third: 'Third party', compete: 'Competing offer', process: 'How it works',
    cond: 'Condition', situ: 'Situation'
  };

  // List source -> objection categories, in priority order (doc 16 prep: expect
  // the 2-3 objections that list type actually produces).
  // Keys are lowercase — pickExpectedObjections lowercases the input first.
  var SOURCE_CATS = {
    'probate': ['situ', 'third', 'stall'],
    'code violation': ['cond', 'process', 'price'],
    'pre-foreclosure': ['situ', 'price', 'stall'],
    'tax delinquent': ['price', 'process', 'stall'],
    'd4d': ['open', 'compete', 'process'],
    'fsbo': ['compete', 'price', 'process'],
    'other': ['open', 'price', 'stall']
  };

  function pickExpectedObjections(objections, listSource) {
    var cats = SOURCE_CATS[String(listSource || 'other').toLowerCase()] || SOURCE_CATS.other;
    var picked = [];
    cats.forEach(function (cat) {
      var line = (objections || []).find(function (o) { return o.cat === cat; });
      if (line) picked.push(line);
    });
    return picked.slice(0, 3);
  }

  function openingLine(address, callerName, listSource) {
    var line = 'Hi, is this the owner of ' + (address || '[address]') +
      '? … This is ' + (callerName || 'Troy') +
      ", I was just seeing if you'd be interested in selling it.";
    var warn = listSource && String(listSource).toLowerCase() !== 'other'
      ? ' Do NOT lead with the ' + listSource + '.'
      : '';
    return line + warn;
  }

  // ---------- scorecard: 10 criteria, 1 point each ----------
  // Criteria 1-7 are doc 16's scorecard (weights 1,2,2,1,2,1,1 = 10 points
  // there); here each counts 1 of 10 so the three added criteria fit.
  // Criteria 8-10 are the highest-rated additions from docs 16-18:
  // 8 = never lead with the distress (doc 18 Setup B rules; doc 16 prep),
  // 9 = hold the anchor / ignore the SSRP (doc 16 interrupt trigger 5),
  // 10 = decision makers identified (doc 16 debrief sheet).
  var SCORECARD = [
    { id: 'opener', label: 'Opened with the two-question script', detail: 'Owner of the address → interested in selling', line: null },
    { id: 'talk', label: 'Seller talked ≥ 80% of the time', detail: 'You listened; they did the talking', line: 'SHUT UP: let them finish — you are doing the talking.' },
    { id: 'mctp', label: 'All four MCTP fields captured', detail: 'Motivation, condition, timeframe, price', line: 'ASK: "What\'s got you thinking about selling now?" — fill the blank field.' },
    { id: 'conditioned', label: 'Conditioned for yes/no BEFORE any number', detail: 'Condition first, number second', line: 'Before I put a number together — if we agree on everything, are you ready to make a yes-or-no decision today?' },
    { id: 'anchored', label: 'Anchored low — at or near LAO, not MAO', detail: 'Opened at LAO; never drifted up to MAO', line: null },
    { id: 'reverseAnchor', label: 'Used the reverse price anchor', detail: 'Blamed the partner for the number', line: 'My partner looks at the place first and then we talk numbers — that is the fastest way to a real one.' },
    { id: 'nextAction', label: 'Ended with a committed next action + date', detail: 'A date, not "I\'ll think about it"', line: 'What day works for me to call you back — and what time is best?' },
    { id: 'noLeadDistress', label: 'Did NOT lead with their distress', detail: 'Never opened with probate / foreclosure / fines', line: null },
    { id: 'heldAnchor', label: 'Held the anchor — ignored the SSRP', detail: 'Their number has no bearing; did not drift toward it', line: 'IGNORE THE SSRP: their number has no bearing. Anchor at your LAO.' },
    { id: 'decisionMakers', label: 'All decision makers identified', detail: 'Present, or the missing one named', line: 'Who else has to agree on this — spouse, siblings, heirs?' }
  ];

  // Biggest-leak priority: conditioning and talk ratio are the classic leaks
  // (doc 16 example debrief), then anchoring, then the rest in order.
  var LEAK_PRIORITY = ['conditioned', 'talk', 'anchored', 'mctp', 'reverseAnchor', 'opener', 'nextAction', 'heldAnchor', 'decisionMakers', 'noLeadDistress'];

  function verdictFor(score) {
    if (score >= 9) return 'Locked in';
    if (score >= 7) return 'Solid call';
    if (score >= 5) return 'Fixable call, not a lost one';
    return 'Re-do the fundamentals';
  }

  // answers: { opener, talk, mctp, conditioned, anchored, reverseAnchor,
  //   nextAction, noLeadDistress, heldAnchor, decisionMakers } booleans.
  // ctx: { address, callerName, lao, listSource } for the "line you needed".
  function scoreDebrief(answers, ctx) {
    var a = answers || {};
    var checked = SCORECARD.filter(function (c) { return !!a[c.id]; }).length;
    var missed = SCORECARD.filter(function (c) { return !a[c.id]; });
    var leakId = null;
    LEAK_PRIORITY.forEach(function (id) {
      if (!leakId && missed.some(function (c) { return c.id === id; })) leakId = id;
    });
    var leak = leakId ? SCORECARD.find(function (c) { return c.id === leakId; }) : null;
    var line = null;
    if (leak) {
      if (leak.id === 'opener') line = openingLine(ctx && ctx.address, ctx && ctx.callerName, ctx && ctx.listSource);
      else if (leak.id === 'anchored') line = 'I was talking to my partner and they said around ' + (ctx && ctx.lao != null ? '$' + Math.round(ctx.lao).toLocaleString() : 'the LAO') + '.';
      else if (leak.id === 'noLeadDistress') line = 'Do NOT lead with the ' + (ctx && ctx.listSource ? ctx.listSource : 'distress') + ' — open with the owner question.';
      else line = leak.line;
    }
    return {
      score: checked, total: SCORECARD.length,
      verdict: verdictFor(checked),
      biggestLeak: leak ? leak.label : null,
      biggestLeakDetail: leak ? leak.detail : null,
      lineNeeded: line,
      missed: missed.map(function (c) { return c.id; })
    };
  }

  // ---------- debrief markdown (the canonical record) ----------
  // Saved via download as YYYY-MM-DD-<address-slug>.md into
  // ~/workspace/playbook-system/live-call-debriefs/. Follows doc 16's debrief
  // output shape: score, what worked, biggest leak, the line needed, numbers,
  // next action.
  function buildDebriefMarkdown(d) {
    var L = [];
    L.push('# Live-call debrief — ' + (d.address || 'no address'));
    L.push('Date: ' + (d.date || todayISO()) + ' · Caller: ' + (d.callerName || 'Troy') +
      ' · Direction: ' + (d.direction || 'outbound') + ' · Duration: ' + (d.durationMin || '?') + ' min');
    L.push('List source: ' + (d.listSource || '—'));
    L.push('');
    L.push('## Property');
    L.push('- Address: ' + (d.address || '—'));
    L.push('- Beds/baths: ' + (d.bedsBaths || '—') + ' · Sqft: ' + (d.sqft || '—') + ' · Year built: ' + (d.yearBuilt || '—'));
    L.push('- Owner: ' + (d.ownerName || '—') + ' · Phone: ' + (d.sellerPhone || '—'));
    L.push('- Listed with a realtor: ' + (d.listed ? 'YES — PASS, no offer' : 'No'));
    L.push('');
    L.push('## MCTP');
    L.push('- Motivation: ' + (d.motivation || '—') + (d.motivationStrength ? ' (' + d.motivationStrength + ')' : ''));
    L.push('- Condition: ' + (d.condition || '—') + (d.repairLevel ? ' · Repair level: ' + d.repairLevel : ''));
    L.push('- Timeframe: ' + (d.timeframe || '—'));
    L.push('- Price (their number, recorded not respected): ' + (d.sellerPrice || '—'));
    L.push('- Decision makers: ' + (d.decisionMakers || '—'));
    L.push('- Seller talked: ' + (d.talkPct != null ? d.talkPct + '%' : '—'));
    L.push('');
    L.push('## Numbers');
    L.push('- ARV: ' + (d.arv != null ? '$' + Math.round(d.arv).toLocaleString() : '—') +
      ' · Repairs: ' + (d.repairs != null ? '$' + Math.round(d.repairs).toLocaleString() : '—'));
    L.push('- MAO: ' + (d.mao != null ? '$' + Math.round(d.mao).toLocaleString() : '—') +
      ' · LAO: ' + (d.lao != null ? '$' + Math.round(d.lao).toLocaleString() : '—') +
      (d.multiplierLabel ? ' (' + d.multiplierLabel + ')' : ''));
    L.push('- Offer made: ' + (d.offerMade || '—') + ' · Seller counter: ' + (d.sellerCounter || '—'));
    L.push('- Outcome: ' + (d.outcome || '—'));
    L.push('');
    L.push('## Score: ' + d.score + '/' + d.total + ' — ' + d.verdict);
    L.push('');
    L.push('## What worked');
    (d.worked || []).forEach(function (w) { L.push('- ' + w); });
    if (!(d.worked || []).length) L.push('- (nothing noted)');
    L.push('');
    L.push('## Biggest leak');
    L.push((d.biggestLeak || 'None — clean call') + (d.biggestLeakDetail ? ' — ' + d.biggestLeakDetail : ''));
    L.push('');
    L.push('## The line you needed');
    L.push('> ' + (d.lineNeeded || '—'));
    L.push('');
    L.push('## Next action');
    L.push((d.nextAction || '—') + (d.nextActionDate ? ' — due ' + d.nextActionDate : ''));
    L.push('');
    L.push('## Notes');
    (d.notes || []).forEach(function (n) { L.push('- ' + n); });
    if (!(d.notes || []).length) L.push('- (none)');
    L.push('');
    return L.join('\n');
  }

  var api = {
    slugify: slugify, todayISO: todayISO, renderReply: renderReply,
    CAT_LABELS: CAT_LABELS, SOURCE_CATS: SOURCE_CATS,
    pickExpectedObjections: pickExpectedObjections, openingLine: openingLine,
    SCORECARD: SCORECARD, verdictFor: verdictFor, scoreDebrief: scoreDebrief,
    buildDebriefMarkdown: buildDebriefMarkdown
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LiveCall = api;

  // ---------- DOM bindings (browser only) ----------
  if (typeof document === 'undefined') return;

  var $ = function (id) { return document.getElementById(id); };
  var objections = root.LIVE_CALL_OBJECTIONS || [];
  var notes = [];
  var draftTimer = null;

  function num(id) {
    var v = $(id) ? $(id).value.replace(/[$,]/g, '') : '';
    var n = Number(v);
    return isNaN(n) ? null : n;
  }
  function money(n) {
    return (root.OfferMath ? root.OfferMath.fmtMoney(n) : (n == null ? '—' : '$' + Math.round(n).toLocaleString()));
  }
  function callerName() { return ($('caller') ? $('caller').value : 'Troy') || 'Troy'; }
  function cityOf() { return $('city') ? $('city').value.trim() : ''; }
  function stateOf() { return $('state') ? $('state').value.trim() : ''; }
  // Deal market for the MAO calibration gate (assets/offer-math.js marketFor).
  // Unknown market -> null -> tier only; the Indianapolis calibration must
  // never leak onto another market's deals.
  function marketOf() { return (root.OfferMath && root.OfferMath.marketFor) ? root.OfferMath.marketFor(cityOf(), stateOf()) : null; }

  function buildPrep() {
    var address = $('address') ? $('address').value.trim() : '';
    var listSource = $('listSource') ? $('listSource').value : 'other';
    var arv = num('arv'), repairs = num('repairs');
    var listed = $('listed') ? $('listed').checked : false;
    var out = $('prepOut');
    if (!out) return;
    if (!address) { out.innerHTML = '<p class="muted">Type an address above, then build the prep card.</p>'; return; }
    var math = (root.OfferMath && arv != null) ? root.OfferMath.offerMath(arv, repairs || 0, undefined, marketOf()) : null;
    var expected = pickExpectedObjections(objections, listSource);
    var buyer = $('buyerName') ? $('buyerName').value.trim() : '';
    var html = '';
    html += '<div class="prep-head"><div><div class="lbl">Property</div><div class="prep-addr">' + esc(address) + '</div>' +
      '<div class="muted">' + esc([$('bedsBaths') ? $('bedsBaths').value : '', $('sqft') ? $('sqft').value : '', $('yearBuilt') ? $('yearBuilt').value : ''].filter(Boolean).join(' · ')) +
      (listSource ? ' · List: ' + esc(listSource) : '') + '</div></div></div>';
    if (listed) {
      html += '<div class="pass-banner">⛔ LISTED WITH A REALTOR — PASS. No offer, no chase. MAO/LAO cleared.</div>';
    } else if (math && math.mao != null) {
      html += '<div class="nums">' +
        '<div class="num"><div class="lbl">ARV</div><div class="v">' + money(arv) + '</div></div>' +
        '<div class="num"><div class="lbl">Repairs</div><div class="v">' + money(repairs || 0) + '</div></div>' +
        '<div class="num key"><div class="lbl">MAO — ceiling</div><div class="v">' + money(math.mao) + '</div><div class="sub">' + esc(math.label || '') + ' · never go above</div></div>' +
        '<div class="num key"><div class="lbl">LAO — open here</div><div class="v">' + money(math.lao) + '</div><div class="sub">MAO × 70%</div></div></div>';
    } else {
      html += '<p class="muted">Enter ARV and repairs to compute MAO/LAO.</p>';
    }
    html += '<div class="lbl" style="margin-top:14px">Open with</div><div class="say">' + esc(openingLine(address, callerName(), listSource)) + '</div>';
    html += '<div class="lbl" style="margin-top:14px">Expect — 2–3 most likely objections</div>';
    expected.forEach(function (o) {
      html += '<div class="obj"><div class="obj-t">“' + esc(o.trigger) + '” <span class="tag">' + esc(CAT_LABELS[o.cat] || o.cat) + '</span></div>' +
        '<div class="obj-r">' + esc(renderReply(o.reply, callerName(), cityOf())) + '</div></div>';
    });
    html += '<div class="lbl" style="margin-top:14px">Likely cash buyer</div>' +
      '<div id="buyerOut">' + (buyer ? '<div class="obj-r">' + esc(buyer) + '</div>' : '<p class="muted">No buyer matched yet — use “Match buyers” below, or type one in.</p>') + '</div>';
    out.innerHTML = html;
    saveDraft();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Lazy-load the master buyer list only when asked (4.5 MB — not on page load).
  var buyersLoaded = false, buyersLoading = false;
  function matchBuyers() {
    if (!$('buyerOut')) buildPrep();
    var out = $('buyerOut');
    var city = cityOf(), zip = $('zip') ? $('zip').value.trim() : '', state = $('state') ? $('state').value.trim().toUpperCase() : '';
    function render() {
      var list = root.MASTER_BUYERS || [];
      var pool = list.filter(function (b) { return b.p; });
      var byCity = city ? pool.filter(function (b) { return (b.c || '').toLowerCase() === city.toLowerCase(); }) : [];
      var byZip = zip ? pool.filter(function (b) { return String(b.z || '') === zip; }) : [];
      var byState = state ? pool.filter(function (b) { return (b.s || '').toUpperCase() === state; }) : [];
      var matches = (byZip.length ? byZip : byCity.length ? byCity : byState).slice().sort(function (a, b) { return (b.sc || 0) - (a.sc || 0); }).slice(0, 3);
      if (!matches.length) { if (out) out.innerHTML = '<p class="muted">No buyer in the master list for this city/ZIP yet — type the buyer in by hand.</p>'; return; }
      if (out) out.innerHTML = matches.map(function (b) {
        return '<div class="obj"><div class="obj-t">' + esc(b.n) + ' <span class="tag">' + esc(b.st || '') + '</span></div>' +
          '<div class="obj-r">' + esc(b.c || '') + ', ' + esc(b.s || '') + ' ' + esc(b.z || '') + ' · avg purchase ' + money(b.ap) +
          ' · score ' + (b.sc || '—') + ' · ' + esc(b.ti || '') + '<br><span class="muted">' + esc(b.p || '') + '</span></div></div>';
      }).join('');
    }
    if (buyersLoaded) { render(); return; }
    if (buyersLoading) return;
    buyersLoading = true;
    if (out) out.innerHTML = '<p class="muted">Loading buyer list…</p>';
    var s = document.createElement('script');
    s.src = 'assets/master-buyers.js';
    s.onload = function () { buyersLoaded = true; buyersLoading = false; render(); };
    s.onerror = function () { buyersLoading = false; if (out) out.innerHTML = '<p class="muted">Buyer list did not load — type the buyer in by hand.</p>'; };
    document.head.appendChild(s);
  }

  function renderChips(filterCat) {
    var box = $('chipBox');
    if (!box) return;
    var cats = Object.keys(CAT_LABELS);
    var html = '<div class="row" style="margin:0 0 8px">' + cats.map(function (c) {
      return '<button type="button" class="chip' + (filterCat === c ? ' on' : '') + '" data-cat="' + c + '">' + CAT_LABELS[c] + ' (' + objections.filter(function (o) { return o.cat === c; }).length + ')</button>';
    }).join('') + '<button type="button" class="chip" data-cat="">All 77</button></div>';
    var list = filterCat ? objections.filter(function (o) { return o.cat === filterCat; }) : objections;
    html += '<div class="obj-list">' + list.map(function (o) {
      return '<button type="button" class="obj-chip" data-id="' + o.id + '">“' + esc(o.trigger) + '”</button>';
    }).join('') + '</div><div id="chipReply" class="say" style="margin-top:10px">Tap a line above — the response appears here instantly.</div>';
    box.innerHTML = html;
    box.querySelectorAll('[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () { renderChips(b.getAttribute('data-cat') || null); });
    });
    box.querySelectorAll('.obj-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var o = objections.find(function (x) { return x.id === b.getAttribute('data-id'); });
        var r = $('chipReply');
        if (o && r) r.textContent = renderReply(o.reply, callerName(), cityOf());
      });
    });
  }

  function collectDebrief() {
    var answers = {};
    SCORECARD.forEach(function (c) {
      var el = $('sc-' + c.id);
      answers[c.id] = el ? el.checked : false;
    });
    // Talk ratio feeds criterion 2 automatically when the user entered it.
    var talkPct = num('talkPct');
    if (talkPct != null) answers.talk = talkPct >= 80;
    var arv = num('arv'), repairs = num('repairs');
    var math = (root.OfferMath && arv != null) ? root.OfferMath.offerMath(arv, repairs || 0, undefined, marketOf()) : null;
    var result = scoreDebrief(answers, { address: $('address') ? $('address').value.trim() : '', callerName: callerName(), lao: math ? math.lao : null, listSource: $('listSource') ? $('listSource').value : '' });
    return { answers: answers, talkPct: talkPct, math: math, result: result };
  }

  function renderScore() {
    var c = collectDebrief();
    var box = $('scoreOut');
    if (!box) return;
    var r = c.result;
    var worked = SCORECARD.filter(function (x) { return c.answers[x.id]; }).map(function (x) { return x.label; });
    box.innerHTML = '<div class="score-big">' + r.score + ' / ' + r.total + ' — ' + esc(r.verdict) + '</div>' +
      '<div class="lbl" style="margin-top:10px">Biggest leak</div><div>' + esc(r.biggestLeak || 'None — clean call') + (r.biggestLeakDetail ? ' — ' + esc(r.biggestLeakDetail) : '') + '</div>' +
      (r.lineNeeded ? '<div class="lbl" style="margin-top:10px">The line you needed</div><div class="say">' + esc(r.lineNeeded) + '</div>' : '') +
      (worked.length ? '<div class="lbl" style="margin-top:10px">What worked</div><div>' + worked.map(esc).join('<br>') + '</div>' : '');
    saveDraft();
  }

  function downloadDebrief() {
    var c = collectDebrief();
    var r = c.result;
    var address = $('address') ? $('address').value.trim() : '';
    var worked = SCORECARD.filter(function (x) { return c.answers[x.id]; }).map(function (x) { return x.label; });
    var md = buildDebriefMarkdown({
      date: todayISO(), callerName: callerName(), address: address,
      city: cityOf(), state: $('state') ? $('state').value.trim() : '', zip: $('zip') ? $('zip').value.trim() : '',
      listSource: $('listSource') ? $('listSource').value : '', direction: $('direction') ? $('direction').value : 'outbound',
      durationMin: $('durationMin') ? $('durationMin').value.trim() : '',
      bedsBaths: $('bedsBaths') ? $('bedsBaths').value.trim() : '', sqft: $('sqft') ? $('sqft').value.trim() : '',
      yearBuilt: $('yearBuilt') ? $('yearBuilt').value.trim() : '', ownerName: $('ownerName') ? $('ownerName').value.trim() : '',
      sellerPhone: $('sellerPhone') ? $('sellerPhone').value.trim() : '', listed: $('listed') ? $('listed').checked : false,
      motivation: $('motivation') ? $('motivation').value.trim() : '', motivationStrength: $('motivationStrength') ? $('motivationStrength').value : '',
      condition: $('condition') ? $('condition').value.trim() : '', repairLevel: $('repairLevel') ? $('repairLevel').value : '',
      timeframe: $('timeframe') ? $('timeframe').value.trim() : '', sellerPrice: $('sellerPrice') ? $('sellerPrice').value.trim() : '',
      decisionMakers: $('decisionMakers') ? $('decisionMakers').value.trim() : '', talkPct: c.talkPct,
      arv: num('arv'), repairs: num('repairs'), mao: c.math ? c.math.mao : null, lao: c.math ? c.math.lao : null,
      multiplierLabel: c.math ? c.math.label : null, offerMade: $('offerMade') ? $('offerMade').value.trim() : '',
      sellerCounter: $('sellerCounter') ? $('sellerCounter').value.trim() : '', outcome: $('outcome') ? $('outcome').value : '',
      score: r.score, total: r.total, verdict: r.verdict, biggestLeak: r.biggestLeak, biggestLeakDetail: r.biggestLeakDetail,
      lineNeeded: r.lineNeeded, worked: worked, nextAction: $('nextAction') ? $('nextAction').value.trim() : '',
      nextActionDate: $('nextActionDate') ? $('nextActionDate').value : '', notes: notes.slice()
    });
    var fname = todayISO() + '-' + slugify(address) + '.md';
    var blob = new Blob([md], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    var st = $('saveStatus');
    if (st) st.textContent = 'Downloaded ' + fname + ' — move it into ~/workspace/playbook-system/live-call-debriefs/ (that folder is the canonical record).';
  }

  function saveDraft() {
    try {
      var data = {};
      document.querySelectorAll('[data-draft]').forEach(function (el) {
        data[el.id] = el.type === 'checkbox' ? el.checked : el.value;
      });
      data.__notes = notes;
      localStorage.setItem('liveCallDraft.v1', JSON.stringify(data));
    } catch (e) { /* private mode — download still works */ }
  }
  function restoreDraft() {
    try {
      var raw = localStorage.getItem('liveCallDraft.v1');
      if (!raw) return;
      var data = JSON.parse(raw);
      Object.keys(data).forEach(function (id) {
        if (id === '__notes') { notes = data[id] || []; return; }
        var el = $(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!data[id]; else el.value = data[id];
      });
      renderNotes();
    } catch (e) { /* ignore corrupt draft */ }
  }
  function renderNotes() {
    var box = $('noteLog');
    if (!box) return;
    box.innerHTML = notes.length ? notes.map(function (n) { return '<div class="note">• ' + esc(n) + '</div>'; }).join('') : '<p class="muted">No notes yet — type the hard moments as they happen.</p>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    restoreDraft();
    renderChips(null);
    renderNotes();
    var buildBtn = $('buildPrep');
    if (buildBtn) buildBtn.addEventListener('click', buildPrep);
    var matchBtn = $('matchBuyers');
    if (matchBtn) matchBtn.addEventListener('click', matchBuyers);
    var scoreBtn = $('scoreBtn');
    if (scoreBtn) scoreBtn.addEventListener('click', renderScore);
    var dlBtn = $('downloadBtn');
    if (dlBtn) dlBtn.addEventListener('click', downloadDebrief);
    var draftBtn = $('draftBtn');
    if (draftBtn) draftBtn.addEventListener('click', function () { saveDraft(); var st = $('saveStatus'); if (st) st.textContent = 'Draft saved in this browser.'; });
    var noteBtn = $('addNote');
    if (noteBtn) noteBtn.addEventListener('click', function () {
      var v = $('noteText') ? $('noteText').value.trim() : '';
      if (!v) return;
      notes.push(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' — ' + v);
      if ($('noteText')) $('noteText').value = '';
      renderNotes(); saveDraft();
    });
    document.querySelectorAll('[data-draft]').forEach(function (el) {
      el.addEventListener('input', function () { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 800); });
      el.addEventListener('change', function () { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 800); });
    });
    var talk = $('talkPct');
    if (talk) talk.addEventListener('input', function () { var v = $('talkVal'); if (v) v.textContent = (talk.value || '—') + '%'; });
    if ($('address') && $('address').value) buildPrep();
  });

})(typeof window !== 'undefined' ? window : globalThis);

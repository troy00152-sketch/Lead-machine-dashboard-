// live-call.js — Live Call Console (Ginn improvement #4) for Troy + Irish.
// PREP + LIVE COACH + DEBRIEF. The coach listens on the device mic while it
// is on (browser speech recognition, speakerphone) and flashes suggested
// replies; the prep card and debrief are unchanged. No auto-dialing, nothing
// is recorded or stored — the transcript lives on the page only, and only the
// words needed for a suggestion leave the device (to the coach-suggest
// function). Objection lines come from window.LIVE_CALL_OBJECTIONS, inlined
// at build time from the SMS bot's vetted kb.json `objections` array (77
// lines, Troy-voiced). See build-live-call.py. Never paste Ginn's unvetted
// lines here. MAO/LAO math lives in assets/offer-math.js (canonical,
// shared) — this file calls OfferMath.offerMath and never re-implements
// the tiers.
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
    // Live-coach transcript (coach mode only): what was actually said on
    // the call. Kept on the page only until the debrief downloads — this
    // is the record, and the training data the footer promises.
    if ((d.transcript || []).length) {
      L.push('## Live transcript');
      d.transcript.forEach(function (t) { L.push('- ' + t); });
      L.push('');
    }
    return L.join('\n');
  }

  // ---------- auto-fill: open from a lead or a URL (?lead= / ?address=&arv=…) ----------
  // Pure + Node-testable. The DOM wrapper (autoFillFromUrl, browser only) reads
  // window.location.search + the dashboard's own lead store (localStorage
  // 'acc_leads', same origin) and fills the form; the existing "if address,
  // buildPrep" line at the end of DOMContentLoaded then builds the card.
  // Manual entry is untouched: with no ?lead= and no deal params, nothing
  // happens. Missing ARV stays null — never 0, never invented.
  var LEAD_STORE_KEY = 'acc_leads';
  var LIST_SOURCE_VALUES = ['probate', 'code violation', 'pre-foreclosure', 'tax delinquent', 'D4D', 'FSBO', 'other'];

  function toNumOrNull(v) {
    if (v == null || v === '') return null;
    var n = Number(String(v).replace(/[$,]/g, ''));
    return isNaN(n) ? null : n;
  }

  // Split "123 Main St, Greenville, NC 27528" (or with fewer parts) into the
  // form's separate fields. Tolerates a missing ZIP / state / city; never guesses.
  function splitAddress(full) {
    var out = { address: '', city: '', state: '', zip: '' };
    var s = String(full || '').trim();
    if (!s) return out;
    var zipM = s.match(/(\d{5})(?:-\d{4})?\s*$/);
    var hadZip = !!zipM;
    if (zipM) { out.zip = zipM[1]; s = s.slice(0, zipM.index).replace(/[,\s]+$/, ''); }
    // A trailing 2-letter token is a state ONLY in a structured address
    // (ZIP present, or commas present) — otherwise "123 Main St" would lose
    // its "St" to the state regex.
    if (hadZip || s.indexOf(',') !== -1) {
      var stM = s.match(/([A-Za-z]{2})\s*$/);
      if (stM) { out.state = stM[1].toUpperCase(); s = s.slice(0, stM.index).replace(/[,\s]+$/, ''); }
    }
    var parts = s.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length >= 2) {
      out.city = parts[parts.length - 1];
      out.address = parts.slice(0, parts.length - 1).join(', ');
    } else {
      out.address = s;
    }
    return out;
  }

  // ?lead=lead_42 | ?address=&city=&state=&zip=&arv=&repairs= — returns only
  // the params actually present (absent = omitted, never a guessed value).
  function parseAutoFillParams(search) {
    var out = {};
    var q = String(search || '').replace(/^\?/, '');
    if (!q) return out;
    var params;
    try { params = new URLSearchParams(q); } catch (e) { return out; }
    ['lead', 'address', 'city', 'state', 'zip'].forEach(function (k) {
      var v = params.get(k);
      if (v != null && v !== '') out[k === 'lead' ? 'leadId' : k] = v;
    });
    ['arv', 'repairs'].forEach(function (k) {
      var v = toNumOrNull(params.get(k));
      if (v != null) out[k] = v;
    });
    return out;
  }

  function findLeadInStore(store, id) {
    if (!id || !Array.isArray(store)) return null;
    var found = store.find(function (l) { return l && String(l.id) === String(id); });
    return found || null;
  }

  // Lead distress signal -> Live Call list-source select value.
  function listSourceForSignal(signal) {
    var s = String(signal || '').trim().toLowerCase();
    if (s === 'probate') return 'probate';
    if (s === 'code violation' || s === 'code violations') return 'code violation';
    if (s === 'pre-foreclosure' || s === 'preforeclosure') return 'pre-foreclosure';
    if (s === 'tax delinquent') return 'tax delinquent';
    if (s === 'd4d' || s === 'driving for dollars') return 'D4D';
    if (s === 'fsbo') return 'FSBO';
    return 'other';
  }

  // Dashboard lead (acc_leads shape) -> deal fields for the form.
  // ARV resolution matches the dashboard: estimatedValue, then arv, then value.
  function leadToAutoFill(lead) {
    if (!lead) return null;
    var arv = toNumOrNull(lead.estimatedValue != null ? lead.estimatedValue : (lead.arv != null ? lead.arv : lead.value));
    var repairs = toNumOrNull(lead.repairs);
    var mobiles = (lead.phones || []).filter(function (p) { return p && (p.type === 'Mobile' || p.type === 'mobile'); });
    var phone = mobiles.length && mobiles[0].number ? mobiles[0].number : '';
    var bedsBaths = '';
    if (lead.bedrooms != null || lead.bathrooms != null) {
      bedsBaths = (lead.bedrooms != null ? lead.bedrooms : '') + ' / ' + (lead.bathrooms != null ? lead.bathrooms : '');
    }
    return {
      address: lead.address || '',
      city: lead.city || '',
      state: lead.state || '',
      zip: lead.zip || '',
      listSource: listSourceForSignal(lead.distressSignal),
      arv: arv,
      repairs: repairs,
      bedsBaths: bedsBaths,
      sqft: lead.sqft != null ? String(lead.sqft) : '',
      yearBuilt: lead.yearBuilt != null ? String(lead.yearBuilt) : '',
      ownerName: lead.ownerName || '',
      sellerPhone: phone,
      listed: lead.listingStatus === 'listed' || lead.onMarket === true
    };
  }

  // Resolve the deal to auto-fill: ?lead=<id> first (dashboard lead store),
  // then URL params if present. Returns { source, deal } or null when neither
  // resolves — the page is then left exactly as-is (manual entry still works).
  function resolveAutoFill(search, store) {
    var params = parseAutoFillParams(search);
    if (params.leadId) {
      var lead = findLeadInStore(store, params.leadId);
      if (lead) return { source: 'lead', deal: leadToAutoFill(lead) };
    }
    if (params.address || params.arv != null || params.repairs != null || params.city || params.state || params.zip) {
      var split = params.address ? splitAddress(params.address) : { address: '', city: '', state: '', zip: '' };
      return {
        source: 'params',
        deal: {
          address: split.address, city: params.city || split.city, state: params.state || split.state, zip: params.zip || split.zip,
          listSource: 'other', arv: params.arv != null ? params.arv : null, repairs: params.repairs != null ? params.repairs : null,
          bedsBaths: '', sqft: '', yearBuilt: '', ownerName: '', sellerPhone: '', listed: false
        }
      };
    }
    return null;
  }

  // ---------- address lookup: property record + verified comps ----------
  // SAME lookup path as the Comps page (index.html loadCompsForAddress):
  // PropertyReach (data-api) first, ATTOM (attom-lookup) as fallback, PR
  // subject merged over ATTOM when PR matched. The scoring, best-3 picking
  // and confidence live server-side in those two functions — this code only
  // reads d.property / d.comps, never re-scores and never invents a comp.
  // fetchFn is injected (the browser passes the real fetch) so tests run
  // on fixtures with zero API credits. Returns null when neither source
  // matched the address; THROWS only when both fetches failed (network
  // down) so the caller can say "unavailable" instead of "no record".
  async function lookupPropertyAndComps(address, fetchFn) {
    var addr = String(address || '').trim();
    if (!addr || typeof fetchFn !== 'function') return null;
    var enc = encodeURIComponent(addr);
    var prSubject = null, prComps = null, prMatched = false, prError = false, attomError = false;
    try {
      var prRes = await fetchFn('/.netlify/functions/data-api?address=' + enc);
      if (prRes && prRes.ok) {
        var pj = null;
        try { pj = await prRes.json(); } catch (e) { pj = null; }
        if (pj && pj.matched) {
          prMatched = true;
          prSubject = pj.property || null;
          if (pj.comps && (pj.comps.best || []).length) prComps = pj.comps;
        }
      } else { prError = true; }
    } catch (e) { prError = true; }
    if (prComps) {
      return { matched: true, source: 'data provider', property: prSubject, comps: prComps };
    }
    var attomJson = null;
    try {
      var atRes = await fetchFn('/.netlify/functions/attom-lookup?address=' + enc);
      if (atRes && atRes.ok) {
        try { attomJson = await atRes.json(); } catch (e) { attomJson = null; }
      } else { attomError = true; }
    } catch (e) { attomError = true; }
    if (attomJson) {
      if (prSubject) {
        attomJson.property = Object.assign({}, attomJson.property || {}, prSubject);
        if (!attomJson.matched) attomJson.matched = true;
      }
      if (!attomJson.matched) return null;
      return { matched: true, source: prSubject ? 'ATTOM+PR' : 'ATTOM', property: attomJson.property || null, comps: attomJson.comps || null };
    }
    // PR matched the property but ATTOM is down and PR had no comps: the
    // record is still worth filling (owner/beds/sqft/year) with comps null
    // — ARV stays gated, nothing is invented.
    if (prMatched) {
      return { matched: true, source: 'data provider', property: prSubject, comps: null };
    }
    if (prError && attomError) throw new Error('lookup unavailable: both sources failed');
    return null;
  }

  // ARV gate (standing rule): ARV fills ONLY from 3+ picked comps AND
  // confidence HIGH or MEDIUM. Anything else leaves ARV blank — the mean of
  // the picked set is still returned as `candidate` so the card can show it
  // as "candidate, not an offer basis", never fed into MAO/LAO.
  function arvFromComps(comps) {
    var c = comps || {};
    var best = (c.best || []).filter(function (r) { return r && r.amount != null; });
    var candidate = best.length
      ? Math.round(best.reduce(function (s, r) { return s + Number(r.amount); }, 0) / best.length)
      : null;
    var confidence = c.confidence || '';
    var passes = best.length >= 3 && (confidence === 'HIGH' || confidence === 'MEDIUM');
    return { arv: passes ? candidate : null, candidate: candidate, count: best.length, confidence: confidence, confidenceText: c.confidenceText || '', passes: passes };
  }

  // Lookup result -> deal fields for the prep card form. City/state/ZIP
  // come from the typed address (splitAddress); when the typed address is
  // street-only, the record's canonical one-line address fills the rest.
  // Owner is owner1, plus owner2 when the record has one. ARV comes from
  // the gate (null when thin/low-confidence). The result's source and the
  // picked comps ride along so the status line and the prep card can say
  // exactly which comps drove the ARV and where they came from.
  function lookupDealFromResult(result, typedAddress) {
    var r = result || {};
    var prop = r.property || {};
    var split = splitAddress(typedAddress);
    if ((!split.city || !split.state || !split.zip) && prop.address) {
      var rs = splitAddress(prop.address);
      // The record's canonical one-line is uppercase ("GREENVILLE") —
      // title-case the city it supplies so the form reads like Troy typed it.
      var rsCity = rs.city ? String(rs.city).toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '';
      split = { address: split.address || rs.address, city: split.city || rsCity, state: split.state || rs.state, zip: split.zip || rs.zip };
    }
    var owner = prop.owner1 || '';
    if (prop.owner2) owner = owner ? owner + ' & ' + prop.owner2 : prop.owner2;
    var bedsBaths = '';
    if (prop.beds != null || prop.baths != null) {
      bedsBaths = (prop.beds != null ? prop.beds : '') + ' / ' + (prop.baths != null ? prop.baths : '');
    }
    var gate = arvFromComps(r.comps);
    return {
      address: split.address, city: split.city, state: split.state, zip: split.zip,
      source: r.source || '',
      bestComps: (r.comps && r.comps.best || []).filter(function (c) { return c; }).map(function (c) {
        return { address: c.address || '', amount: c.amount != null ? Math.round(c.amount) : null };
      }),
      listSource: 'other',
      arv: gate.arv, candidateArv: gate.candidate, compCount: gate.count,
      confidence: gate.confidence, confidenceText: gate.confidenceText, arvPassesGate: gate.passes,
      bedsBaths: bedsBaths,
      sqft: prop.sqft != null ? String(prop.sqft) : '',
      yearBuilt: prop.yearBuilt != null ? String(prop.yearBuilt) : '',
      ownerName: owner, sellerPhone: '',
      listed: prop.onMarket === true || prop.listingStatus === 'listed'
    };
  }

  // ---------- draft carryover: a fresh auto-filled card must not inherit ----------
  // the previous call's details. The draft (localStorage 'liveCallDraft.v1')
  // holds every [data-draft] field; auto-fill overwrites only the DEAL fields,
  // so without this the previous call's caller, MCTP answers, scorecard and
  // notes leak onto the new card (live test, main@6fa6595: the Greenville
  // card showed Indy's ZIP 46201). Rule: when an auto-fill open resolves to
  // an address that DIFFERS from the draft's saved address, the draft's
  // non-deal fields are cleared first, then the deal is filled. Same address
  // = same call, draft kept. No draft or no auto-fill = unchanged. A blank
  // address on either side never triggers a clear — an address-less draft is
  // not provably another property's.
  var DEAL_FIELD_IDS = ['address', 'city', 'state', 'zip', 'arv', 'repairs',
    'bedsBaths', 'sqft', 'yearBuilt', 'ownerName', 'sellerPhone', 'buyerName',
    'listSource', 'listed'];

  function isDealDraftKey(id) { return DEAL_FIELD_IDS.indexOf(id) !== -1; }
  function isNonDealDraftKey(id) { return !isDealDraftKey(id); }

  // Case/whitespace/punctuation-insensitive: "303 Elizabeth St, Greenville,
  // NC" and "303 elizabeth st greenville nc" normalize identically.
  function normalizeAddress(addr) {
    return String(addr || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  // Same address if the normalized forms are equal OR one is a prefix of the
  // other — the address field holds the street only, while a hand-typed draft
  // may hold the full "street, city, state". Both must be non-empty; a blank
  // address never matches (see shouldClearDraftForDeal).
  function isSameAddress(a, b) {
    var na = normalizeAddress(a), nb = normalizeAddress(b);
    if (na === '' || nb === '') return false;
    return na === nb || na.indexOf(nb) === 0 || nb.indexOf(na) === 0;
  }
  // True only when BOTH addresses are present and differ — a blank on either
  // side means "cannot tell", so the draft is kept (fail-closed: never
  // destroy notes on an ambiguous match).
  function shouldClearDraftForDeal(draftAddress, dealAddress) {
    return normalizeAddress(draftAddress) !== '' && normalizeAddress(dealAddress) !== '' &&
      !isSameAddress(draftAddress, dealAddress);
  }
  // Pure form of the clear: the draft with every non-deal key stripped
  // (caller, MCTP, scorecard, notes, next action...). Deal keys survive —
  // fillDealFields overwrites them with the new deal right after. The stored
  // draft is dropped outright in clearDraftForNewDeal so no stale deal key
  // can restore on a later manual open; this function pins the classification
  // for the regression suite.
  function cleanDraftForNewDeal(draft) {
    if (!draft) return null;
    var out = {};
    Object.keys(draft).forEach(function (k) {
      if (isDealDraftKey(k)) out[k] = draft[k];
    });
    return out;
  }

  // Pure form of the deal-field reset: every DEAL_FIELD_ID mapped to its
  // blank state. Text inputs -> '', the listed checkbox -> false, listSource
  // -> 'other' (its neutral value — NOT selectedIndex 0, which is
  // 'probate'). clearDraftForNewDeal applies this to the DOM before
  // fillDealFields fills the new deal on top, so a field the payload does
  // not supply (ZIP, beds, sqft, year on a params-only open) shows BLANK,
  // never the previous property's facts.
  function blankDealFields() {
    var out = {};
    DEAL_FIELD_IDS.forEach(function (id) {
      if (id === 'listed') out[id] = false;
      else if (id === 'listSource') out[id] = 'other';
      else out[id] = '';
    });
    return out;
  }

  // Address-dependent fields: the facts that belong to ONE address. When
  // the typed address changes, these are blanked BEFORE the new lookup
  // returns, so the form never shows the previous address's facts next to
  // a new address (live test Nov 6 9:24 PM: a Waterbury lookup left
  // Greenville's city/state and the old ARV on the form). Repairs is NOT
  // in the list — it is Troy's condition judgment, not a record fact.
  // listSource / listed / sellerPhone / buyerName are Troy's too.
  var ADDRESS_FIELD_IDS = ['city', 'state', 'zip', 'arv', 'ownerName', 'bedsBaths', 'sqft', 'yearBuilt'];

  function blankAddressFields() {
    var out = {};
    ADDRESS_FIELD_IDS.forEach(function (id) { out[id] = ''; });
    return out;
  }

  // ARV write-back decision (pure): the lookup feed vs the ARV already on
  // the form. fieldArv = number on the form (null when blank); dealArv =
  // gated ARV from the lookup (null when thin/low-confidence);
  // arvFromLookup = the form's ARV came from a previous lookup for THIS
  // address (not hand-typed); addressChanged = the typed address differs
  // from the last looked-up one.
  //   write: put dealArv in the field (it becomes lookup-owned).
  //   blank: clear the field — a gated lookup must never leave the previous
  //     address's ARV sitting there pretending to be this address's number.
  //   keep:  leave the field alone — Troy's hand-typed / param-supplied ARV
  //     for THIS address is his verified number; the feed never overwrites it.
  function resolveLookupArv(fieldArv, dealArv, arvFromLookup, addressChanged) {
    if (dealArv != null) {
      if (fieldArv == null || arvFromLookup || addressChanged) return { action: 'write', value: dealArv };
      return { action: 'keep', value: fieldArv };
    }
    if (arvFromLookup || addressChanged) return { action: 'blank', value: null };
    return { action: 'keep', value: fieldArv };
  }

  // User-visible source label for a lookup result ('data provider' is the
  // PropertyReach path; 'ATTOM+PR' is ATTOM comps over a PR subject record).
  // The status line names the source so a number that moves between runs
  // is attributable instead of a mystery.
  function lookupSourceLabel(source) {
    if (source === 'data provider') return 'PropertyReach';
    if (source === 'ATTOM') return 'ATTOM';
    if (source === 'ATTOM+PR') return 'ATTOM + PropertyReach';
    return source || '';
  }

  // ---------- live coach: match + prompt + guard (pure, Node-testable) ----------
  // The coach hears the seller through the device mic (speakerphone) and
  // flashes 1-3 replies in ~2s. Grounding rules, same as the SMS bot:
  // open at LAO, never quote above MAO, ballpark probe only inside LAO-MAO,
  // walk away gracefully when their ask is >2x MAO, total silence on
  // opt-out / rejection / have-an-offer / under-contract. The vetted
  // objection line ALWAYS comes first when one matches — the AI suggestions
  // are the backup, never the replacement.

  // Keyword match on the seller's words. Longest matching keyword wins;
  // ties break by earliest line in the vetted list. No match -> null.
  function matchObjection(text, objections) {
    var t = String(text || '').toLowerCase();
    if (!t || !Array.isArray(objections)) return null;
    var best = null, bestLen = 0;
    (objections || []).forEach(function (o) {
      (o.keywords || []).forEach(function (kw) {
        var k = String(kw || '').toLowerCase();
        if (k && t.indexOf(k) !== -1 && k.length > bestLen) { best = o; bestLen = k.length; }
      });
    });
    return best;
  }

  // Every $ amount in a line of text, as numbers (commas stripped).
  function extractDollarAmounts(text) {
    var out = [];
    String(text || '').replace(/\$([\d,]+(?:\.\d+)?)/g, function (_, n) {
      var v = Number(n.replace(/,/g, ''));
      if (!isNaN(v)) out.push(v);
      return _;
    });
    return out;
  }

  // Client-side number guard (defense in depth — the server prompt carries
  // the same rule): a suggestion is safe only if every $ figure in it is
  // at or below MAO. With no MAO known, any $ figure fails closed.
  function coachSuggestionGuard(suggestion, mao) {
    var amounts = extractDollarAmounts(suggestion);
    if (!amounts.length) return true;
    if (mao == null) return false;
    return amounts.every(function (a) { return a <= mao; });
  }

  // Normalize the deal the form holds into the coach's context. MAO/LAO are
  // passed in (computed by OfferMath) — never recomputed here.
  function coachDealContext(deal) {
    var d = deal || {};
    return {
      address: d.address || '', city: d.city || '', state: d.state || '',
      arv: d.arv != null ? d.arv : null, repairs: d.repairs != null ? d.repairs : null,
      mao: d.mao != null ? d.mao : null, lao: d.lao != null ? d.lao : null,
      multiplierLabel: d.multiplierLabel || '',
      sellerPrice: d.sellerPrice || '', motivation: d.motivation || '',
      condition: d.condition || '', listSource: d.listSource || '',
      callerName: d.callerName || 'Troy', listed: !!d.listed
    };
  }

  // The prompt the coach-suggest function gets. System carries the
  // grounding rules; user carries the deal facts + the last few transcript
  // lines + the matched vetted line (if any — it becomes suggestion #1).
  function buildCoachPrompt(ctx, transcriptLines, matched) {
    var c = coachDealContext(ctx);
    var system = [
      'You are coaching ' + c.callerName + ' on a LIVE seller call for a house purchase. ' +
      'Reply with a JSON object {"suggestions": ["...", "..."]} — 1 to 3 short spoken replies, each 1-2 sentences, in ' + c.callerName + "'s voice.",
      'NUMBERS: open at LAO ($' + (c.lao != null ? Math.round(c.lao).toLocaleString() : '?') + '), never quote above MAO ($' + (c.mao != null ? Math.round(c.mao).toLocaleString() : '?') + '). ' +
      'A ballpark probe may only span LAO to MAO. Never state MAO as the offer. If their ask is more than 2x MAO, suggest a graceful walkaway — no arguing, no counter.',
      'If they opt out, reject, say not for sale, wrong number, have an offer, or are under contract: suggest ending politely and stopping. Never push, never argue.',
      'Talk like ' + c.callerName + ': say "my partner" for the numbers, never name ' + c.callerName + ' unless asked. Never mention MAO, LAO, tiers, or the dashboard.',
      'Keep each reply short enough to say in one breath.'
    ].join('\n');
    var user = ['Deal: ' + (c.address || 'unknown address') + (c.city ? ', ' + c.city : '') + (c.state ? ' ' + c.state : '') +
      ' · ARV $' + (c.arv != null ? Math.round(c.arv).toLocaleString() : '?') + ' · Repairs $' + (c.repairs != null ? Math.round(c.repairs).toLocaleString() : '?') +
      ' · MAO $' + (c.mao != null ? Math.round(c.mao).toLocaleString() : '?') + ' · LAO $' + (c.lao != null ? Math.round(c.lao).toLocaleString() : '?') +
      (c.multiplierLabel ? ' (' + c.multiplierLabel + ')' : '') +
      (c.sellerPrice ? ' · Their price: ' + c.sellerPrice : '') +
      (c.motivation ? ' · Motivation: ' + c.motivation : '') +
      (c.condition ? ' · Condition: ' + c.condition : '') +
      (c.listed ? ' · LISTED WITH A REALTOR — suggest passing, no offer.' : '')];
    var lines = (transcriptLines || []).slice(-6);
    user.push('What was just said (latest last):');
    lines.forEach(function (l) { user.push('- ' + l); });
    if (matched) user.push('A vetted reply matches what they said — use it as suggestion #1, verbatim: "' + matched.reply + '"');
    return { system: system, user: user.join('\n') };
  }

  // Validate the coach-suggest response. Suggestions must be strings;
  // empties dropped, capped at 3, and the number guard applied (a $ figure
  // above MAO drops that suggestion — never a silent rewrite). Returns the
  // safe list, possibly empty.
  function parseCoachResponse(body, mao) {
    if (!body || !Array.isArray(body.suggestions)) return [];
    var out = [];
    body.suggestions.forEach(function (s) {
      var t = String(s || '').trim();
      if (!t) return;
      if (!coachSuggestionGuard(t, mao)) return;
      out.push(t);
    });
    return out.slice(0, 3);
  }

  // Throttle: suggest at most once per 4s, only on a real utterance
  // (>= 3 words). The mic fires many finals per sentence; without this
  // the coach would re-suggest on every fragment.
  var COACH_SUGGEST_COOLDOWN_MS = 4000;
  function shouldSuggestCoach(opts) {
    var o = opts || {};
    var text = String(o.text || '').trim();
    if (text.split(/\s+/).filter(Boolean).length < 3) return false;
    if (o.lastSuggestedAt != null && o.now != null && (o.now - o.lastSuggestedAt) < COACH_SUGGEST_COOLDOWN_MS) return false;
    return true;
  }

  var api = {
    slugify: slugify, todayISO: todayISO, renderReply: renderReply,
    CAT_LABELS: CAT_LABELS, SOURCE_CATS: SOURCE_CATS,
    pickExpectedObjections: pickExpectedObjections, openingLine: openingLine,
    SCORECARD: SCORECARD, verdictFor: verdictFor, scoreDebrief: scoreDebrief,
    buildDebriefMarkdown: buildDebriefMarkdown,
    LEAD_STORE_KEY: LEAD_STORE_KEY, splitAddress: splitAddress,
    parseAutoFillParams: parseAutoFillParams, findLeadInStore: findLeadInStore,
    listSourceForSignal: listSourceForSignal, leadToAutoFill: leadToAutoFill,
    resolveAutoFill: resolveAutoFill,
    lookupPropertyAndComps: lookupPropertyAndComps, arvFromComps: arvFromComps,
    lookupDealFromResult: lookupDealFromResult,
    DEAL_FIELD_IDS: DEAL_FIELD_IDS, isDealDraftKey: isDealDraftKey,
    isNonDealDraftKey: isNonDealDraftKey, normalizeAddress: normalizeAddress,
    isSameAddress: isSameAddress, shouldClearDraftForDeal: shouldClearDraftForDeal,
    cleanDraftForNewDeal: cleanDraftForNewDeal, blankDealFields: blankDealFields,
    ADDRESS_FIELD_IDS: ADDRESS_FIELD_IDS, blankAddressFields: blankAddressFields,
    resolveLookupArv: resolveLookupArv, lookupSourceLabel: lookupSourceLabel,
    matchObjection: matchObjection, extractDollarAmounts: extractDollarAmounts,
    coachSuggestionGuard: coachSuggestionGuard, coachDealContext: coachDealContext,
    buildCoachPrompt: buildCoachPrompt, parseCoachResponse: parseCoachResponse,
    shouldSuggestCoach: shouldSuggestCoach, COACH_SUGGEST_COOLDOWN_MS: COACH_SUGGEST_COOLDOWN_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LiveCall = api;

  // ---------- DOM bindings (browser only) ----------
  if (typeof document === 'undefined') return;

  var $ = function (id) { return document.getElementById(id); };
  var objections = root.LIVE_CALL_OBJECTIONS || [];
  var notes = [];
  var draftTimer = null;
  // RACE guard: a rebuild scheduled while the calibration fetch is still in
  // flight. At most one pending rebuild per unsettled load — buildPrep is
  // idempotent, but there is no reason to queue five of them.
  var calRebuildPending = false;

  function num(id) {
    var v = $(id) ? $(id).value.replace(/[$,]/g, '').trim() : '';
    if (v === '') return null; // blank is "not entered" — never $0-as-real
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

  // Auto-fill (browser only): resolve ?lead= / URL params, then fill the
  // form's deal fields. Clears the deal fields first so a stale draft from
  // another property can never leak ARV/repairs into this call's card.
  // Returns 'lead' | 'params' | null (null = nothing resolved, manual entry).
  function fillDealFields(deal) {
    if (!deal) return;
    var set = function (id, v) { var el = $(id); if (el) el.value = (v == null ? '' : String(v)); };
    set('address', deal.address); set('city', deal.city); set('state', deal.state); set('zip', deal.zip);
    set('arv', deal.arv); set('repairs', deal.repairs);
    set('bedsBaths', deal.bedsBaths); set('sqft', deal.sqft); set('yearBuilt', deal.yearBuilt);
    set('ownerName', deal.ownerName); set('sellerPhone', deal.sellerPhone); set('buyerName', deal.buyerName || '');
    var ls = $('listSource');
    if (ls) ls.value = (deal.listSource && LIST_SOURCE_VALUES.indexOf(deal.listSource) !== -1) ? deal.listSource : 'other';
    var li = $('listed');
    if (li) li.checked = !!deal.listed;
  }
  // Draft carryover (live test, main@6fa6595, extended main@071ef54): when
  // an auto-fill open resolves to a DIFFERENT address than the restored
  // draft, drop the stale draft and reset the whole card — the previous
  // call's caller, MCTP answers, scorecard, notes and next action must not
  // leak onto the new card, AND the previous property's deal facts must not
  // either. Deal fields are blanked FIRST (blankDealFields), then
  // fillDealFields() fills the new deal's values on top immediately after —
  // a field the payload does not supply (ZIP, beds, sqft, year on a
  // params-only open) stays BLANK instead of showing the old property.
  // The stored draft is removed outright (not rewritten) so no stale deal
  // key can restore on a later manual open; buildPrep's saveDraft()
  // persists the fresh state.
  function clearDraftForNewDeal() {
    try { localStorage.removeItem('liveCallDraft.v1'); } catch (e) { /* ignore */ }
    // Deal fields first: every one blank, before the new deal fills on top.
    var blank = blankDealFields();
    DEAL_FIELD_IDS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (id === 'listed') el.checked = false;
      else el.value = blank[id];
    });
    document.querySelectorAll('[data-draft]').forEach(function (el) {
      if (!isNonDealDraftKey(el.id)) return;
      if (el.type === 'checkbox') el.checked = false;
      else if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = el.defaultValue;
    });
    // Duration: a draft field (debrief section), restored only by
    // restoreDraft — the loop above already resets it to its default (''),
    // but reset it explicitly: its placeholder is "12", which reads as a
    // carried value on a fresh card. Blank, never the previous call's length.
    var dur = $('durationMin');
    if (dur) dur.value = '';
    notes = [];
    renderNotes();
    var talk = $('talkPct'), talkVal = $('talkVal');
    if (talk && talkVal) talkVal.textContent = (talk.value || '—') + '%';
  }
  function autoFillFromUrl() {
    if (typeof window === 'undefined') return null;
    var store = [];
    try { store = JSON.parse(localStorage.getItem(LEAD_STORE_KEY) || '[]'); } catch (e) { store = []; }
    var resolved = resolveAutoFill(window.location.search, store);
    if (!resolved) return null;
    // Draft carryover: a restored draft for a DIFFERENT address is another
    // call's data — clear its non-deal fields before filling this deal.
    // Same address = same call, draft kept.
    var draftAddress = null;
    try {
      var raw = localStorage.getItem('liveCallDraft.v1');
      if (raw) { var saved = JSON.parse(raw); draftAddress = saved ? saved.address : null; }
    } catch (e) { draftAddress = null; }
    if (shouldClearDraftForDeal(draftAddress, resolved.deal.address)) clearDraftForNewDeal();
    fillDealFields(resolved.deal);
    return resolved.source;
  }

  // ---------- address lookup: property record + verified comps (DOM) ----------
  // Trigger: tab-out of the address field (change) or the 🔍 button. The
  // lookup fills the record's facts (owner/beds/sqft/year/city/state/ZIP)
  // and the gated ARV, then rebuilds the card. It never writes a field on
  // failure, and it never overwrites an ARV Troy typed or a param supplied.
  var lookupState = { lastAddress: '', inFlight: false, result: null, deal: null, arvFromLookup: false };

  function lookupStatus(text) { var el = $('lookupStatus'); if (el) el.textContent = text || ''; }

  function applyLookupDeal(deal, opts) {
    if (!deal) return null;
    var o = opts || {};
    var setWhenPresent = function (id, v) { var el = $(id); if (el && v != null && String(v) !== '') el.value = String(v); };
    // The record is authoritative for the property facts — the lookup
    // writes city/state/ZIP every time it speaks. The old setIfBlank left
    // the previous address's city/state/ZIP on the form (live test Nov 6
    // 9:24 PM: Greenville/NC/06710 survived a Waterbury lookup).
    setWhenPresent('city', deal.city); setWhenPresent('state', deal.state); setWhenPresent('zip', deal.zip);
    setWhenPresent('ownerName', deal.ownerName);
    setWhenPresent('bedsBaths', deal.bedsBaths);
    setWhenPresent('sqft', deal.sqft);
    setWhenPresent('yearBuilt', deal.yearBuilt);
    // The lookup can only ADD the PASS, never remove Troy's manual check:
    // an ATTOM-only record carries no listing info, and its listed=false
    // must not uncheck a box he checked himself.
    var li = $('listed');
    if (li && deal.listed) li.checked = true;
    // ARV via resolveLookupArv: a passing ARV fills a blank field, replaces
    // a previous lookup's ARV, or fills after an address change — never over
    // Troy's hand-typed / param-supplied ARV for THIS address. A gated
    // lookup BLANKS a lookup-owned or stale ARV instead of leaving the old
    // number there. Returns the resolution so the status line can say
    // exactly what happened to the ARV.
    var res = resolveLookupArv(num('arv'), deal.arv, lookupState.arvFromLookup, !!o.addressChanged);
    var a = $('arv');
    if (res.action === 'write' && a) { a.value = String(res.value); lookupState.arvFromLookup = true; }
    else if (res.action === 'blank') { if (a) a.value = ''; lookupState.arvFromLookup = false; }
    return res;
  }

  async function runAddressLookup(opts) {
    var o = opts || {};
    var address = $('address') ? $('address').value.trim() : '';
    if (!address) { lookupStatus(''); return null; }
    if (lookupState.inFlight) return null;
    if (!o.manual && normalizeAddress(address) === normalizeAddress(lookupState.lastAddress)) return null;
    if (typeof fetch === 'undefined') return null;
    // Address change: blank the previous address's facts BEFORE the fetch
    // returns, so the form never shows Greenville's city/state/ARV next to
    // a Waterbury address (live test Nov 6 9:24 PM). The blank is saved to
    // the draft immediately so a reload cannot restore the stale facts.
    var addressChanged = !!lookupState.lastAddress && !isSameAddress(address, lookupState.lastAddress);
    if (addressChanged) {
      var blank = blankAddressFields();
      Object.keys(blank).forEach(function (id) { var el = $(id); if (el) el.value = blank[id]; });
      lookupState.result = null; lookupState.deal = null; lookupState.arvFromLookup = false;
      saveDraft();
    }
    lookupState.inFlight = true;
    lookupState.lastAddress = address;
    lookupState.result = null; lookupState.deal = null; // never show a stale card under a new address
    lookupStatus('Looking up property records…');
    var result = null;
    try {
      result = await lookupPropertyAndComps(address, fetch);
    } catch (e) {
      lookupState.lastAddress = ''; // failed, not "looked up" — a later blur retries
      lookupState.inFlight = false;
      lookupStatus('Lookup unavailable right now — type the details by hand.');
      return null;
    }
    lookupState.inFlight = false;
    if (!result) {
      lookupStatus('No property record found for this address — type the details by hand.');
      return null;
    }
    lookupState.result = result;
    var deal = lookupDealFromResult(result, address);
    lookupState.deal = deal;
    var arvRes = applyLookupDeal(deal, { addressChanged: addressChanged });
    var bits = [];
    if (deal.ownerName) bits.push(deal.ownerName);
    if (deal.bedsBaths) bits.push(deal.bedsBaths);
    if (deal.sqft) bits.push(Number(deal.sqft).toLocaleString() + ' sqft');
    if (deal.yearBuilt) bits.push('built ' + deal.yearBuilt);
    var msg = bits.length ? '✓ Found — ' + bits.join(' · ') : '✓ Found a property record.';
    var via = lookupSourceLabel(deal.source) ? ' via ' + lookupSourceLabel(deal.source) : '';
    if (deal.arv != null) {
      msg += ' · ' + deal.compCount + ' comps, ' + deal.confidence + ' — ARV $' + deal.arv.toLocaleString() + via;
      if (arvRes && arvRes.action === 'keep') msg += ' (kept your $' + Number(arvRes.value).toLocaleString() + ')';
    } else if (deal.candidateArv != null) {
      var keptArv = num('arv');
      if (keptArv != null) {
        msg += ' · ' + deal.compCount + ' comp(s), ' + (deal.confidence || 'no confidence') + ' — kept your ARV $' + keptArv.toLocaleString() + '; feed could not verify (candidate $' + deal.candidateArv.toLocaleString() + via + '; needs 3 HIGH/MEDIUM comps).';
      } else {
        msg += ' · ' + deal.compCount + ' comp(s), ' + (deal.confidence || 'no confidence') + ' — ARV left blank (candidate $' + deal.candidateArv.toLocaleString() + via + '; needs 3 HIGH/MEDIUM comps).';
      }
    } else {
      msg += ' · No verified comps — ARV left blank; type it by hand.';
    }
    if (deal.listed) msg = '⛔ LISTED — PASS, no offer, no chase. ' + msg;
    lookupStatus(msg);
    saveDraft();
    var OM = root.OfferMath;
    if (OM && OM.whenCalibrationReady) OM.whenCalibrationReady(2000).then(function () { buildPrep(); });
    else buildPrep();
    return result;
  }

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
      // The comps that produced this ARV — with their source, so a number
      // that moves between runs is attributable instead of a mystery (Nov 6
      // 9:24 PM: same Gatlin address, ARV $179,167 live vs $154,167 in the
      // morning — different picks from different runs, no record of which).
      var lc = (lookupState.deal && normalizeAddress(address) === normalizeAddress(lookupState.lastAddress)) ? lookupState.deal : null;
      if (lc && lc.bestComps && lc.bestComps.length) {
        html += '<p class="muted">Verified comps' + (lookupSourceLabel(lc.source) ? ' via ' + esc(lookupSourceLabel(lc.source)) : '') + ': ' + lc.bestComps.map(function (c) { return esc(c.address) + ' $' + (c.amount != null ? c.amount.toLocaleString() : '?'); }).join(' · ') + '</p>';
      }
    } else {
      // A gated lookup candidate (thin or LOW-confidence comps) is shown
      // as a candidate only — never fed into MAO/LAO. Only for the address
      // the lookup actually ran on; a new address blanks it.
      var cand = (lookupState.deal && normalizeAddress(address) === normalizeAddress(lookupState.lastAddress)) ? lookupState.deal : null;
      if (cand && cand.candidateArv != null) {
        html += '<p class="muted">ARV candidate $' + cand.candidateArv.toLocaleString() + ' from ' + cand.compCount + ' comp(s) (' + esc(cand.confidence || 'no confidence') + ') — needs 3 HIGH/MEDIUM comps to fill. Type an ARV to run the math manually.</p>';
      } else {
        html += '<p class="muted">Enter ARV and repairs to compute MAO/LAO.</p>';
      }
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
    // RACE: if the calibration fetch hasn't settled yet, the card above used
    // tier-only numbers (MAO_CAL still null). Rebuild once it arrives so a
    // manual Build pressed during the fetch still ends up calibrated.
    // Attached once per unsettled load, and only for known markets — an
    // unknown market can never be calibrated, so there is nothing to rebuild
    // to. A listed deal shows no numbers, so it never attaches either.
    var OM = root.OfferMath;
    if (!listed && math && math.mao != null && !calRebuildPending && OM && OM.isCalibrationSettled && !OM.isCalibrationSettled() && OM.whenCalibrationReady && marketOf()) {
      calRebuildPending = true;
      OM.whenCalibrationReady(2000).then(function (ready) {
        calRebuildPending = false;
        if (ready) buildPrep();
      });
    }
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
      nextActionDate: $('nextActionDate') ? $('nextActionDate').value : '', notes: notes.slice(),
      transcript: coach.transcript.slice()
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

  // ---------- live coach (DOM only) ----------
  // Browser speech recognition (Chrome desktop/Android, free). Continuous
  // mode + auto-restart: the API ends the session on pauses, so onend
  // restarts while the coach is on. Interim results show live; finals are
  // what trigger suggestions (debounced 1.2s after the last final, plus
  // the 4s cooldown in shouldSuggestCoach).
  var coach = {
    listening: false, recog: null, transcript: [], lastSuggestedAt: null,
    suggestTimer: null, interimText: ''
  };

  function coachDealFromForm() {
    var arv = num('arv'), repairs = num('repairs');
    var math = (root.OfferMath && arv != null) ? root.OfferMath.offerMath(arv, repairs || 0, undefined, marketOf()) : null;
    return coachDealContext({
      address: $('address') ? $('address').value.trim() : '',
      city: cityOf(), state: stateOf(), arv: arv, repairs: repairs,
      mao: math ? math.mao : null, lao: math ? math.lao : null,
      multiplierLabel: math ? math.label : '',
      sellerPrice: $('sellerPrice') ? $('sellerPrice').value.trim() : '',
      motivation: $('motivation') ? $('motivation').value.trim() : '',
      condition: $('condition') ? $('condition').value.trim() : '',
      listSource: $('listSource') ? $('listSource').value : '',
      callerName: callerName(),
      listed: $('listed') ? $('listed').checked : false
    });
  }

  function coachSetStatus(text) { var el = $('coachStatus'); if (el) el.textContent = text; }
  function coachSetLatency(ms) { var el = $('coachLatency'); if (el) el.textContent = ms != null ? ('suggested in ' + (ms / 1000).toFixed(1) + 's') : ''; }

  function renderCoachTranscript() {
    var box = $('coachTranscript');
    if (!box) return;
    var lines = coach.transcript.slice(-8);
    var html = lines.map(function (t) { return '<div class="note">• ' + esc(t) + '</div>'; }).join('');
    if (coach.interimText) html += '<div class="note" style="color:var(--muted)">• ' + esc(coach.interimText) + ' …</div>';
    box.innerHTML = html || '<p class="muted">Nothing heard yet.</p>';
    box.scrollTop = box.scrollHeight;
  }

  function renderCoachSuggestions(suggestions, matched, latencyMs, source) {
    var box = $('coachSuggestions');
    if (!box) return;
    var cards = [];
    if (matched) cards.push({ text: renderReply(matched.reply, callerName(), cityOf()), vetted: true });
    (suggestions || []).forEach(function (s) { cards.push({ text: s, vetted: false }); });
    if (!cards.length) {
      box.innerHTML = '<p class="muted">No line matched — tap a chip in section 3.</p>';
      return;
    }
    box.innerHTML = cards.slice(0, 3).map(function (c, i) {
      return '<div class="obj coach-sug" data-i="' + i + '"><div class="obj-t">' +
        (c.vetted ? 'Vetted line' : 'Coach suggestion') + '</div><div class="obj-r">' + esc(c.text) + '</div></div>';
    }).join('') + '<div class="muted">Tap a reply to mark it used.' + (source ? ' · ' + esc(source) : '') + '</div>';
    coachSetLatency(latencyMs);
    box.querySelectorAll('.coach-sug').forEach(function (el) {
      el.addEventListener('click', function () {
        el.style.borderColor = 'var(--green)';
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          var r = el.querySelector('.obj-r');
          if (r) navigator.clipboard.writeText(r.textContent).catch(function () {});
        }
      });
    });
  }

  // One suggestion round: match the vetted lines first (instant, local),
  // then ask the AI for backups. On any failure the vetted line alone is
  // the answer — the coach never goes blank mid-call.
  async function requestCoachSuggestions(latestText) {
    var deal = coachDealFromForm();
    var matched = matchObjection(latestText, objections);
    var recent = coach.transcript.slice(-6);
    var prompt = buildCoachPrompt(deal, recent, matched);
    var t0 = Date.now();
    var used = matched ? renderReply(matched.reply, callerName(), cityOf()) : null;
    try {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 10000) : null;
      var res = await fetch('/.netlify/functions/coach-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system: prompt.system, user: prompt.user }),
        signal: controller ? controller.signal : undefined
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('coach-suggest HTTP ' + res.status);
      var body = await res.json();
      var suggestions = parseCoachResponse(body, deal.mao);
      // The matched vetted line is rendered first by renderCoachSuggestions;
      // drop any AI suggestion that duplicates it.
      if (used) suggestions = suggestions.filter(function (s) { return s !== used; });
      renderCoachSuggestions(suggestions, matched, Date.now() - t0, 'AI');
      coach.lastSuggestedAt = Date.now();
    } catch (e) {
      renderCoachSuggestions([], matched, null, 'vetted line only — AI unreachable');
      coach.lastSuggestedAt = Date.now();
    }
  }

  function coachOnFinal(text) {
    var t = String(text || '').trim();
    if (!t) return;
    var stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    coach.transcript.push(stamp + ' — ' + t);
    coach.interimText = '';
    renderCoachTranscript();
    clearTimeout(coach.suggestTimer);
    coach.suggestTimer = setTimeout(function () {
      if (!coach.listening) return;
      if (!shouldSuggestCoach({ text: t, lastSuggestedAt: coach.lastSuggestedAt, now: Date.now() })) return;
      requestCoachSuggestions(t);
    }, 1200);
  }

  function coachStart() {
    var consent = $('coachConsent');
    if (consent && !consent.checked) {
      coachSetStatus('Tell the seller first — check the box above, then start.');
      return;
    }
    var SR = (typeof window !== 'undefined') ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
    if (!SR) {
      coachSetStatus('Live listening is not supported in this browser — use Chrome on desktop or Android. The test box below still works.');
      return;
    }
    var recog;
    try { recog = new SR(); } catch (e) { coachSetStatus('Could not start the mic: ' + (e && e.message ? e.message : e)); return; }
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = 'en-US';
    coach.recog = recog;
    coach.listening = true;
    var toggle = $('coachToggle');
    if (toggle) toggle.textContent = '⏹ Stop listening';
    coachSetStatus('Listening… put the call on speaker. Suggestions appear below.');
    recog.onresult = function (ev) {
      var interim = '', finals = [];
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) finals.push(r[0].transcript);
        else interim += r[0].transcript;
      }
      coach.interimText = interim.trim();
      renderCoachTranscript();
      finals.forEach(function (f) { coachOnFinal(f); });
    };
    recog.onerror = function (ev) {
      var err = ev && ev.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        coachStop();
        coachSetStatus('Mic blocked — allow microphone access for this site, then start again.');
      }
      // 'no-speech' / 'aborted' / 'network': onend restarts while listening.
    };
    recog.onend = function () {
      if (!coach.listening) return;
      try { coach.recog.start(); } catch (e) { /* next onend retries */ }
    };
    try { recog.start(); } catch (e) { coachSetStatus('Could not start the mic: ' + (e && e.message ? e.message : e)); coach.listening = false; }
  }

  function coachStop() {
    coach.listening = false;
    clearTimeout(coach.suggestTimer);
    if (coach.recog) { try { coach.recog.stop(); } catch (e) {} coach.recog = null; }
    var toggle = $('coachToggle');
    if (toggle) toggle.textContent = '🎙 Start listening';
    coachSetStatus('Coach off. Transcript stays on this page for the debrief.');
    coachSetLatency(null);
  }

  document.addEventListener('DOMContentLoaded', function () {
    restoreDraft();
    var autoFillSource = autoFillFromUrl(); // ?lead= / URL params win over the restored draft
    renderChips(null);
    renderNotes();
    // Seed the lookup's "current address" from the restored draft /
    // auto-fill: without this, the first lookup after a page load cannot
    // tell a NEW address from the draft's old one, and the stale draft
    // facts survive the first lookup (Waterbury live test, Nov 6 9:24 PM).
    if ($('address') && $('address').value) lookupState.lastAddress = $('address').value.trim();
    // A hand-typed ARV is Troy's verified number: once he types in the ARV
    // field, the lookup must not overwrite it on a same-address re-lookup.
    // (Programmatic writes from the lookup itself do not fire input, so
    // this only ever fires on a real keystroke/paste.)
    var arvEl = $('arv');
    if (arvEl) arvEl.addEventListener('input', function () { lookupState.arvFromLookup = false; });
    // Address lookup: tab-out of the address field, or the 🔍 button.
    var addrEl = $('address');
    if (addrEl) addrEl.addEventListener('change', function () { runAddressLookup(); });
    var lookupBtn = $('lookupBtn');
    if (lookupBtn) lookupBtn.addEventListener('click', function () { runAddressLookup({ manual: true }); });
    var buildBtn = $('buildPrep');
    if (buildBtn) buildBtn.addEventListener('click', buildPrep);
    var coachBtn = $('coachToggle');
    if (coachBtn) coachBtn.addEventListener('click', function () { coach.listening ? coachStop() : coachStart(); });
    var simBtn = $('coachSimBtn');
    if (simBtn) simBtn.addEventListener('click', function () {
      var v = $('coachSimInput') ? $('coachSimInput').value.trim() : '';
      if (!v) return;
      coach.transcript.push(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' — ' + v + ' (test)');
      renderCoachTranscript();
      if ($('coachSimInput')) $('coachSimInput').value = '';
      if (shouldSuggestCoach({ text: v, lastSuggestedAt: coach.lastSuggestedAt, now: Date.now() })) requestCoachSuggestions(v);
    });
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
    if ($('address') && $('address').value) {
      // Wait for the calibration fetch (max ~2s) before auto-building, so a
      // Comps -> Live Call open shows calibrated numbers on first paint
      // instead of tier-only numbers from the pre-fetch race. A failed/slow
      // fetch falls back to tier after the timeout — the page never blocks.
      var OM = root.OfferMath;
      if (OM && OM.whenCalibrationReady) OM.whenCalibrationReady(2000).then(function () { buildPrep(); });
      else buildPrep();
      // A plain-URL-params open (?address=... with no ?lead=) has no lead
      // facts, so the lookup fills the record + comps itself. A ?lead=
      // open already carries the full facts and must NOT be re-looked-up.
      // Forced ({ manual: true }): lastAddress is seeded from the filled
      // form above, so an unforced call would dedupe itself away.
      if (autoFillSource === 'params') runAddressLookup({ manual: true });
    }
  });

})(typeof window !== 'undefined' ? window : globalThis);

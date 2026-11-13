/* BuyerVault Pro §5A — Command Center wiring (browser UI).
   Sections: (1) instant market search + job status, (2) registered-agent
   / entity-linking view, (3) HighLevel qualified-buyer sync (TEST/OFF —
   the threshold is Troy's undecided call; the UI shows the gate state
   and never hides it), (4) saved-market monitoring with last-refreshed
   stamps. Nothing fake: missing values render "—", derived values are
   labeled, and every panel carries the snapshot freshness stamp.
   Pure helpers are exported for buyervault-regression.js. */
(function (global) {
  'use strict';

  /* ---------------- pure helpers (tested) ---------------- */
  function dash(v) { return (v === null || v === undefined || v === '') ? '—' : v; }
  function count(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    return isFinite(n) ? n.toLocaleString('en-US') : '—';
  }
  function money(v) {
    if (!v) return '—';
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function shortMoney(v) {
    if (!v) return '—';
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '—';
    if (n >= 1e9) return '$' + (Math.round(n / 1e8) / 10) + 'B';
    if (n >= 1e6) return '$' + (Math.round(n / 1e5) / 10) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function escLocal(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function runStatePill(state) {
    var map = {
      succeeded: ['green', 'Succeeded'], partial: ['amber', 'Partial'],
      blocked_budget: ['red', 'Held at credit gate'], not_available: ['gray', 'Not available'],
      failed: ['red', 'Failed'], queued: ['gray', 'Queued'], running: ['blue', 'Running'],
    };
    var m = map[state] || ['gray', state || '—'];
    return '<span class="bv-pill ' + m[0] + '">' + m[1] + '</span>';
  }
  function jobProgress(job) {
    // Stored-data runs complete inside the job; progress = finished runs share.
    if (!job || !job.runs || !job.runs.length) return 0;
    var done = job.runs.filter(function (r) {
      return ['succeeded', 'blocked_budget', 'not_available', 'failed'].indexOf(r.state) !== -1;
    }).length;
    return Math.round(done / job.runs.length * 100);
  }
  function savedStatusLabel(s) {
    if (!s) return '—';
    if (s.cadence === 'paused') return 'Paused';
    if (!s.lastRefreshedAt) return 'Never refreshed';
    if (s.status === 'due') return 'Refresh due';
    return 'Monitoring';
  }
  function stamp(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  var api = {
    helpers: {
      dash: dash, count: count, money: money, shortMoney: shortMoney,
      esc: escLocal, runStatePill: runStatePill, jobProgress: jobProgress,
      savedStatusLabel: savedStatusLabel, stamp: stamp,
    },
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  global.BuyerVault = api;
  if (typeof document === 'undefined') return;

  /* ---------------- browser UI ---------------- */
  var FN = '/.netlify/functions/';
  var state = { market: null, meta: null, markets: [], saved: [], tab: 'market', syncCfg: null };
  function esc(s) { return (typeof global.esc === 'function') ? global.esc(s) : escLocal(s); }
  function el(id) { return document.getElementById(id); }
  async function get(fn, qs) {
    var r = await fetch(FN + fn + (qs ? '?' + qs : ''), { cache: 'no-store' });
    return r.json();
  }
  async function post(fn, body) {
    var r = await fetch(FN + fn, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    var j = {};
    try { j = await r.json(); } catch (e) { /* keep {} */ }
    if (!r.ok && j.error) throw new Error(j.error);
    return j;
  }
  function notify(msg) { if (typeof global.toast === 'function') global.toast(msg); }

  async function init() {
    if (state.meta) { renderSaved(); return; }
    try {
      var m = await get('buyervault-markets', 'action=meta');
      state.meta = m.meta;
      var l = await get('buyervault-markets', 'action=list');
      state.markets = l.markets || [];
      var dl = el('bvMarketList');
      if (dl) dl.innerHTML = state.markets.map(function (x) {
        return '<option value="' + esc(x.label) + '"></option>';
      }).join('');
      var f = el('bvFresh');
      if (f && state.meta) {
        f.innerHTML = 'Stored BuyerVault snapshot · data as of <strong>' + esc(stamp(state.meta.generatedAt))
          + '</strong> · ' + count(state.meta.sources.masterBuyers.buyers) + ' master buyers ('
          + count(state.meta.sources.masterBuyers.qualified) + ' qualified) · '
          + count(state.meta.sources.candidatesFL.rows + state.meta.sources.candidatesNC.rows)
          + ' harvested candidates · ' + count(state.meta.sources.entities.rows)
          + ' Sunbiz-linked entities. Instant results read stored data only — no vendor calls.';
      }
    } catch (e) { /* panels show their own errors on use */ }
    loadSaved();
    loadJobs();
    loadSync();
  }

  function switchTab(tab) {
    state.tab = tab;
    ['market', 'entities', 'sync', 'saved'].forEach(function (t) {
      var b = el('bvTab-' + t), s = el('bvSec-' + t);
      if (b) b.classList.toggle('active', t === tab);
      if (s) s.style.display = t === tab ? '' : 'none';
    });
  }

  /* ---- (1) market search + jobs ---- */
  async function search() {
    var q = (el('bvQuery').value || '').trim();
    var box = el('bvMarketResult');
    if (!q) { box.innerHTML = '<p class="bv-muted">Enter a city, county, or ZIP to search the owned BuyerVault data.</p>'; return; }
    box.innerHTML = '<p class="bv-muted">Searching stored BuyerVault data…</p>';
    try {
      var r = await get('buyervault-markets', 'action=resolve&q=' + encodeURIComponent(q));
      if (!r.match) {
        state.market = null;
        box.innerHTML = '<div class="card" style="text-align:center;padding:28px"><div style="font-size:16px;font-weight:700;margin-bottom:6px">No stored data for that market yet</div><p class="bv-muted" style="font-size:13px">' + esc(r.note || '') + '</p></div>';
        return;
      }
      state.market = r.match;
      renderMarket(r);
      loadMarketTables(r.match);
    } catch (e) {
      box.innerHTML = '<p class="bv-muted">Market search unavailable right now — ' + esc(e.message) + '</p>';
    }
  }
  function renderMarket(r) {
    var m = r.match;
    var alts = (r.alternates || []).map(function (a) {
      return ' <button class="btn small ghost" onclick="BuyerVaultUI.pickMarket(\'' + esc(a.label) + '\')">' + esc(a.label) + '</button>';
    }).join('');
    var stats = '';
    function stat(n, l, s) { return '<div class="bv-stat"><div class="n">' + n + '</div><div class="l">' + l + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
    stats += stat(count(m.buyers), 'Buyers on file', m.buyers ? 'from the master buyer database' : 'no master buyers stored here yet');
    stats += stat(count(m.qualified), 'Qualified', 'verified phone + evidence buy box');
    stats += stat(count(m.candidates), 'Harvested candidates', m.candidates ? 'deed-evidenced · no phone yet — skip trace is the next step' : 'no candidate harvest stored');
    stats += stat(count(m.entitiesLinked), 'Sunbiz-linked entities', m.state === 'FL' ? 'with registered-agent records' : 'entity linking is Florida (Sunbiz) only today');
    stats += stat(money(m.medianAvgPurchase), 'Median avg purchase', 'master buyers in this market');
    stats += stat(m.candidateMedian ? money(m.candidateMedian) : '—', 'Candidate median price', 'trailing 36 mo · NC publishes no prices');
    stats += stat(dash(m.candidateLastPurchase), 'Latest candidate purchase', 'year-month of most recent deed');
    el('bvMarketResult').innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">'
      + '<div style="font-size:18px;font-weight:800">' + esc(m.label) + '</div>'
      + '<span class="bv-pill blue">' + (m.kind === 'county' ? 'County market' : 'City market') + '</span>'
      + (r.via ? '<span class="bv-small bv-muted">matched via ' + esc(r.via) + '</span>' : '')
      + '<span style="flex:1"></span>'
      + '<button class="btn" onclick="BuyerVaultUI.refresh()">↻ Refresh market</button>'
      + '<button class="btn" onclick="BuyerVaultUI.save()">☆ Save market</button></div>'
      + (alts ? '<div class="bv-small bv-muted" style="margin-bottom:10px">Also matched:' + alts + '</div>' : '')
      + '<div class="bv-grid">' + stats + '</div>'
      + '<div id="bvBuyersTable"></div><div id="bvCandidatesTable" style="margin-top:14px"></div>';
  }
  async function loadMarketTables(m) {
    try {
      var b = await get('buyervault-markets', 'action=buyers&market=' + encodeURIComponent(m.key) + '&limit=100');
      var box = el('bvBuyersTable');
      if (box) {
        if (!b.buyers.length) {
          box.innerHTML = '<p class="bv-muted bv-small">No master buyers stored for this market — the candidate harvest below is the starting list.</p>';
        } else {
          var rows = b.buyers.map(function (x) {
            var ph = x.phones && x.phones.length ? esc(x.phones[0].phone) + (x.phones[0].dnc ? ' <span class="bv-pill red">DNC</span>' : '') : '—';
            return '<tr><td><strong>' + esc(x.name) + '</strong><div class="bv-small bv-muted">' + esc([x.city, x.state, x.zip].filter(Boolean).join(', ')) + '</div></td>'
              + '<td>' + ph + '</td><td>' + count(x.props) + '</td><td>' + shortMoney(x.portfolioValue) + '</td>'
              + '<td>' + money(x.avgPurchase) + '</td><td>' + esc([x.isFlipper ? 'Flipper' : '', x.isLandlord ? 'Landlord' : ''].filter(Boolean).join(' + ') || '—') + '</td></tr>';
          }).join('');
          box.innerHTML = '<div class="sec-title" style="font-size:15px">Buyers on file <span class="badge blue" style="font-size:10px">' + count(b.total) + '</span></div>'
            + '<div class="bv-scroll"><table class="bv-table"><thead><tr><th>Buyer</th><th>Phone</th><th>Props</th><th>Portfolio</th><th>Avg purchase</th><th>Strategy</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
            + (b.total > b.buyers.length ? '<p class="bv-small bv-muted">Showing top ' + b.buyers.length + ' by portfolio size.</p>' : '');
        }
      }
    } catch (e) { /* leave section empty */ }
    try {
      var c = await get('buyervault-markets', 'action=candidates&market=' + encodeURIComponent(m.key) + '&limit=100');
      var cbox = el('bvCandidatesTable');
      if (cbox && c.candidates.length) {
        var crows = c.candidates.map(function (x) {
          var ent = x.sunbizDoc
            ? ' <span class="bv-link" onclick="BuyerVaultUI.entityFor(\'' + esc(x.name).replace(/'/g, "\\'") + '\')">🏛️ Sunbiz</span>'
            : '';
          return '<tr><td><strong>' + esc(x.name) + '</strong>' + ent + '<div class="bv-small bv-muted">' + esc(x.counties) + '</div></td>'
            + '<td>' + count(x.purchases36mo) + '</td><td>' + count(x.parcels) + '</td>'
            + '<td>' + money(x.median36) + '</td><td>' + dash(x.lastPurchase) + '</td>'
            + '<td><span class="bv-pill amber">No phone yet</span></td></tr>';
        }).join('');
        cbox.innerHTML = '<div class="sec-title" style="font-size:15px">Harvested candidates <span class="badge orange" style="font-size:10px">' + count(c.total) + '</span></div>'
          + '<p class="bv-small bv-muted" style="margin-bottom:8px">Deed-evidenced buyers from the owned county harvest. No contact data exists for these yet — phones come only from a PropertyReach skip trace (free in Core), run list-by-list with Troy\'s approval. Nothing here is invented.</p>'
          + '<div class="bv-scroll"><table class="bv-table"><thead><tr><th>Candidate</th><th>Buys · 36 mo</th><th>Parcels</th><th>Median price</th><th>Last purchase</th><th>Contact</th></tr></thead><tbody>' + crows + '</tbody></table></div>'
          + (c.total > c.candidates.length ? '<p class="bv-small bv-muted">Showing top ' + c.candidates.length + ' by purchases.</p>' : '');
      }
    } catch (e) { /* leave section empty */ }
  }
  async function refresh() {
    if (!state.market) { notify('Search a market first.'); return; }
    try {
      var r = await post('buyervault-jobs', { action: 'refresh', market: state.market.key, trigger: 'manual' });
      renderJob(r.job);
      loadJobs();
      notify('Refresh job recorded — external pulls held at the credit gate.');
    } catch (e) { notify('Refresh failed: ' + e.message); }
  }
  function renderJob(job) {
    var box = el('bvJobPanel');
    if (!box || !job) return;
    var runs = (job.runs || []).map(function (r) {
      return '<div class="bv-run"><div class="grow"><div style="font-weight:600;font-size:13px">' + esc(r.label) + '</div>'
        + '<div class="bv-small bv-muted">' + count(r.recordsSeen) + ' records read · ' + count(r.recordsNew) + ' new · ' + count(r.creditsSpent) + ' credits spent</div>'
        + (r.errorMessage ? '<div class="bv-small" style="margin-top:3px">' + esc(r.errorMessage) + '</div>' : '')
        + '<div class="bv-bar"><i style="width:' + (r.state === 'succeeded' ? 100 : r.state === 'blocked_budget' || r.state === 'not_available' ? 100 : 20) + '%"></i></div></div>'
        + '<div>' + runStatePill(r.state) + '</div></div>';
    }).join('');
    var events = (job.events || []).map(function (ev) {
      return '<div class="bv-event">' + esc(stamp(ev.at)) + ' — ' + esc(ev.message) + '</div>';
    }).join('');
    box.innerHTML = '<div class="card"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">'
      + '<div style="font-weight:800">Job ' + esc(job.id) + '</div>' + runStatePill(job.state)
      + '<span class="bv-small bv-muted">' + esc(job.marketLabel) + ' · trigger: ' + esc(job.trigger) + ' · finished ' + esc(stamp(job.finishedAt)) + '</span></div>'
      + runs + (events ? '<div style="margin-top:8px">' + events + '</div>' : '') + '</div>';
  }
  async function loadJobs() {
    try {
      var r = await get('buyervault-jobs', 'action=jobs');
      var box = el('bvJobHistory');
      if (!box) return;
      if (!(r.jobs || []).length) { box.innerHTML = '<p class="bv-small bv-muted">No refresh jobs yet — search a market and hit Refresh.</p>'; return; }
      box.innerHTML = r.jobs.map(function (j) {
        return '<div class="bv-event" style="cursor:pointer" onclick="BuyerVaultUI.showJob(\'' + esc(j.id) + '\')">'
          + esc(stamp(j.createdAt)) + ' — <strong>' + esc(j.marketLabel) + '</strong> · ' + esc(j.state)
          + ' · ' + count(j.creditsSpent) + ' credits</div>';
      }).join('');
      if (r.jobs[0]) renderJob(r.jobs[0]);
    } catch (e) { /* noop */ }
  }
  async function showJob(id) {
    try { var r = await get('buyervault-jobs', 'action=job&id=' + encodeURIComponent(id)); renderJob(r.job); } catch (e) { /* noop */ }
  }
  function pickMarket(label) { el('bvQuery').value = label; search(); }

  /* ---- (4) saved markets ---- */
  async function save() {
    if (!state.market) { notify('Search a market first.'); return; }
    try {
      var r = await post('buyervault-jobs', { action: 'save', market: state.market.key, cadence: 'weekly' });
      state.saved = r.saved || state.saved;
      renderSaved();
      switchTab('saved');
      notify(state.market.label + ' saved — weekly monitoring.');
    } catch (e) { notify('Save failed: ' + e.message); }
  }
  async function loadSaved() {
    try {
      var r = await get('buyervault-jobs', 'action=saved');
      state.saved = r.saved || [];
      renderSaved();
    } catch (e) { /* noop */ }
  }
  function renderSaved() {
    var box = el('bvSavedTable');
    if (!box) return;
    if (!state.saved.length) {
      box.innerHTML = '<p class="bv-muted bv-small">No saved markets yet. Search a market and choose “☆ Save market” — saved markets get a monitoring cadence and a last-refreshed stamp that only moves when a refresh job actually runs.</p>';
      return;
    }
    var rows = state.saved.map(function (s) {
      var counts = s.lastCounts
        ? count(s.lastCounts.buyers) + ' buyers · ' + count(s.lastCounts.qualified) + ' qualified · ' + count(s.lastCounts.candidates) + ' candidates'
        : '—';
      return '<tr><td><strong>' + esc(s.label) + '</strong><div class="bv-small bv-muted">' + counts + '</div></td>'
        + '<td><select class="field" style="width:120px" onchange="BuyerVaultUI.cadence(\'' + esc(s.id) + '\', this.value)">'
        + ['daily', 'weekly', 'paused'].map(function (c) { return '<option value="' + c + '"' + (s.cadence === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></td>'
        + '<td>' + esc(savedStatusLabel(s)) + '</td>'
        + '<td>' + esc(stamp(s.lastRefreshedAt)) + '</td>'
        + '<td>' + esc(stamp(s.nextDueAt)) + '</td>'
        + '<td style="white-space:nowrap"><button class="btn small" onclick="BuyerVaultUI.refreshSaved(\'' + esc(s.id) + '\')">↻ Refresh</button> '
        + '<button class="btn small ghost" onclick="BuyerVaultUI.unsave(\'' + esc(s.id) + '\')">Remove</button></td></tr>';
    }).join('');
    box.innerHTML = '<div class="bv-scroll"><table class="bv-table"><thead><tr><th>Market</th><th>Cadence</th><th>Status</th><th>Last refreshed</th><th>Next due</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<p class="bv-small bv-muted" style="margin-top:8px">Monitoring cycles re-check the stored BuyerVault data for the market. Fresh external pulls stay behind the credit gate — a cycle never spends credits on its own [HARD RULE B], and the watermark only advances on a real refresh.</p>';
  }
  async function refreshSaved(id) {
    try {
      var r = await post('buyervault-jobs', { action: 'refreshSaved', id: id });
      state.saved = r.saved || state.saved;
      renderSaved();
      renderJob(r.job);
      switchTab('market');
      notify('Saved market refreshed.');
    } catch (e) { notify('Refresh failed: ' + e.message); }
  }
  async function unsave(id) {
    try { var r = await post('buyervault-jobs', { action: 'unsave', id: id }); state.saved = r.saved || []; renderSaved(); }
    catch (e) { notify('Remove failed: ' + e.message); }
  }
  async function cadence(id, value) {
    try { var r = await post('buyervault-jobs', { action: 'cadence', id: id, cadence: value }); state.saved = r.saved || state.saved; renderSaved(); }
    catch (e) { notify('Cadence failed: ' + e.message); }
  }

  /* ---- (2) entities ---- */
  async function entitySearch() {
    var q = (el('bvEntityQuery').value || '').trim();
    var box = el('bvEntityResults');
    box.innerHTML = '<p class="bv-muted">Searching stored Sunbiz entities…</p>';
    try {
      var r = await get('buyervault-entities', 'action=search&q=' + encodeURIComponent(q) + '&limit=25');
      if (!r.entities.length) { box.innerHTML = '<p class="bv-muted">No Sunbiz-linked entities match. Entity linking covers Florida buyer candidates with a Sunbiz record.</p>'; return; }
      box.innerHTML = '<p class="bv-small bv-muted" style="margin-bottom:8px">' + count(r.total) + ' matching entities (candidate-linked set).</p>'
        + r.entities.map(function (e) {
          return '<div class="bv-run"><div class="grow"><span class="bv-link" onclick="BuyerVaultUI.entityDetail(\'' + esc(e.doc) + '\')"><strong>' + esc(e.name) + '</strong></span>'
            + '<div class="bv-small bv-muted">Sunbiz ' + esc(e.doc) + ' · status ' + esc(dash(e.status)) + ' · agent: ' + esc(dash(e.agentName)) + (e.agentCity ? ' (' + esc(e.agentCity) + ')' : '')
            + ' · buys (36 mo): ' + count(e.candidate ? e.candidate.purch36 : null) + ' · linked via agent: ' + count(e.linkedAgentCount) + ' · via address: ' + count(e.linkedAddressCount) + '</div></div>'
            + '<button class="btn small" onclick="BuyerVaultUI.entityDetail(\'' + esc(e.doc) + '\')">View</button></div>';
        }).join('');
    } catch (e) { box.innerHTML = '<p class="bv-muted">Entity search unavailable — ' + esc(e.message) + '</p>'; }
  }
  function entityDetailHtml(e, basis) {
    function kv(k, v) { return '<div><div class="k">' + k + '</div><div class="v">' + esc(dash(v)) + '</div></div>'; }
    function addr(a) { return a ? [a.addr, a.city, a.state, a.zip].filter(Boolean).join(', ') : null; }
    var officers = (e.officers || []).map(function (o) {
      return '<tr><td>' + esc(o.name) + '</td><td>' + esc(dash(o.title)) + '</td><td>' + esc([o.city, o.state].filter(Boolean).join(', ') || '—') + '</td></tr>';
    }).join('');
    function links(list, label) {
      if (!list || !list.length) return '';
      return '<div style="margin-top:10px"><div class="lbl">' + label + '</div>' + list.map(function (x) {
        return '<span class="bv-link" onclick="BuyerVaultUI.entityDetail(\'' + esc(x.doc) + '\')">' + esc(x.name) + '</span>';
      }).join(' · ') + '</div>';
    }
    return '<div class="card"><div style="font-size:17px;font-weight:800;margin-bottom:4px">' + esc(e.name) + '</div>'
      + '<p class="bv-small bv-muted" style="margin-bottom:12px">Sunbiz document ' + esc(e.doc) + ' · buyer-candidate evidence: '
      + count(e.candidate.purch36) + ' purchases (36 mo) · ' + count(e.candidate.parcels) + ' parcels · median '
      + money(e.candidate.median36) + ' · last purchase ' + esc(dash(e.candidate.lastPurchase)) + ' · counties: ' + esc(dash(e.candidate.counties)) + '</p>'
      + '<div class="bv-kv">'
      + kv('Entity status (Sunbiz code)', e.status) + kv('Filing type (Sunbiz code)', e.filingType)
      + kv('Filed', e.fileDate) + kv('Principal address', addr(e.principal))
      + kv('Mailing address', addr(e.mail)) + kv('Registered agent', e.agent ? e.agent.name : null)
      + kv('Agent address', e.agent ? addr(e.agent) : null)
      + '</div>'
      + (officers ? '<div style="margin-top:12px"><div class="lbl">Officers / managers on file</div><table class="bv-table"><thead><tr><th>Name</th><th>Title</th><th>City</th></tr></thead><tbody>' + officers + '</tbody></table></div>' : '')
      + links(e.linkedAgent, 'Shares registered agent with (' + count(e.linkedAgentCount) + ')')
      + links(e.linkedAddress, 'Shares principal address with (' + count(e.linkedAddressCount) + ')')
      + (basis ? '<div class="bv-offernote">' + esc(basis) + '</div>' : '')
      + '</div>';
  }
  async function entityDetail(doc) {
    switchTab('entities');
    var box = el('bvEntityDetail');
    box.innerHTML = '<p class="bv-muted">Loading entity…</p>';
    try {
      var r = await get('buyervault-entities', 'action=detail&doc=' + encodeURIComponent(doc));
      box.innerHTML = entityDetailHtml(r.entity, r.linkBasis);
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { box.innerHTML = '<p class="bv-muted">Entity unavailable — ' + esc(e.message) + '</p>'; }
  }
  async function entityFor(name) {
    switchTab('entities');
    var box = el('bvEntityDetail');
    box.innerHTML = '<p class="bv-muted">Looking up the Sunbiz entity…</p>';
    try {
      var r = await get('buyervault-entities', 'action=forCandidate&name=' + encodeURIComponent(name));
      if (!r.entity) { box.innerHTML = '<p class="bv-muted">No Sunbiz entity is linked to that candidate in the stored export.</p>'; return; }
      box.innerHTML = entityDetailHtml(r.entity, null);
    } catch (e) { box.innerHTML = '<p class="bv-muted">Lookup unavailable — ' + esc(e.message) + '</p>'; }
  }

  /* ---- (3) HL sync (TEST/OFF) ---- */
  async function loadSync() {
    try {
      var c = await get('buyervault-sync', 'action=config');
      state.syncCfg = c.config;
      renderSyncConfig(c);
      var p = await get('buyervault-sync', 'action=preview');
      renderSyncPreview(p.preview, p.config);
      var l = await get('buyervault-sync', 'action=log');
      renderSyncLog(l.log || []);
    } catch (e) { /* noop */ }
  }
  function renderSyncConfig(c) {
    var cfg = c.config || state.syncCfg || {};
    var banner = el('bvSyncBanner');
    if (banner) {
      banner.className = 'bv-banner ' + (cfg.enabled ? 'on' : 'off');
      banner.innerHTML = cfg.enabled
        ? '<strong>Sync configuration is ON</strong> — but no live HighLevel write can happen from this build: '
          + esc(c.gate || 'the live transport is not wired while the threshold is undecided.')
        : '<strong>Sync is OFF.</strong> The score threshold for syncing buyers to HighLevel is still '
          + '<strong>Troy\'s undecided call</strong> (the spec recommends 60+ with a verified phone and an evidence buy box). '
          + 'Until he decides, this panel previews eligibility only — <strong>no buyer has been synced and no HighLevel calls are made.</strong>';
    }
    var t = el('bvSyncThreshold'); if (t) t.value = cfg.minScore != null ? cfg.minScore : 60;
    var en = el('bvSyncEnabled'); if (en) en.checked = !!cfg.enabled;
    var rp = el('bvSyncRequirePhone'); if (rp) rp.checked = cfg.requirePhone !== false;
    var rb = el('bvSyncRequireBuyBox'); if (rb) rb.checked = cfg.requireBuyBox !== false;
    var upd = el('bvSyncUpdated');
    if (upd) upd.textContent = cfg.updatedAt ? 'Config last saved ' + stamp(cfg.updatedAt) + ' — defaults ship OFF.' : 'Config has never been changed — shipped defaults (OFF).';
  }
  function renderSyncPreview(prev, cfg) {
    var box = el('bvSyncPreview');
    if (!box || !prev) return;
    var excl = Object.keys(prev.excluded || {}).map(function (k) {
      return '<tr><td>' + esc(k) + '</td><td>' + count(prev.excluded[k]) + '</td></tr>';
    }).join('');
    var sample = (prev.sample || []).map(function (s) {
      return '<tr><td><strong>' + esc(s.name) + '</strong><div class="bv-small bv-muted">' + esc([s.city, s.state].filter(Boolean).join(', ')) + '</div></td>'
        + '<td>' + esc(s.phone) + '</td><td>' + count(s.score) + '</td><td>' + esc(dash(s.strategy)) + '</td><td>' + count(s.props) + '</td></tr>';
    }).join('');
    box.innerHTML = '<div class="bv-grid">'
      + '<div class="bv-stat"><div class="n">' + count(prev.total) + '</div><div class="l">Buyers with phone</div></div>'
      + '<div class="bv-stat"><div class="n">' + count(prev.eligible) + '</div><div class="l">Would sync at current settings</div><div class="s">score ≥ ' + count(cfg ? cfg.minScore : 60) + ' + qualified gate</div></div>'
      + '<div class="bv-stat"><div class="n">0</div><div class="l">Synced so far</div><div class="s">sync has never run live</div></div></div>'
      + (excl ? '<div class="lbl">Why the rest are excluded (a buyer can fail more than one gate)</div><table class="bv-table" style="margin-bottom:12px"><tbody>' + excl + '</tbody></table>' : '')
      + (sample ? '<div class="lbl">First eligible buyers (preview only)</div><div class="bv-scroll"><table class="bv-table"><thead><tr><th>Buyer</th><th>Phone</th><th>Score</th><th>Strategy</th><th>Props</th></tr></thead><tbody>' + sample + '</tbody></table></div>' : '<p class="bv-muted bv-small">No buyers pass the current settings.</p>');
  }
  function renderSyncLog(log) {
    var box = el('bvSyncLog');
    if (!box) return;
    if (!log.length) { box.innerHTML = '<p class="bv-small bv-muted">No sync activity recorded yet.</p>'; return; }
    box.innerHTML = log.map(function (r) {
      return '<div class="bv-event">' + esc(stamp(r.at)) + ' — <strong>' + esc(r.action) + '</strong> · ' + esc(dash(r.detail)) + '</div>';
    }).join('');
  }
  async function syncSaveConfig() {
    try {
      var r = await post('buyervault-sync', {
        action: 'config',
        enabled: el('bvSyncEnabled').checked,
        minScore: parseInt(el('bvSyncThreshold').value, 10) || 0,
        requirePhone: el('bvSyncRequirePhone').checked,
        requireBuyBox: el('bvSyncRequireBuyBox').checked,
      });
      state.syncCfg = r.config;
      renderSyncConfig({ config: r.config, gate: r.gate });
      var p = await get('buyervault-sync', 'action=preview');
      renderSyncPreview(p.preview, p.config);
      notify('Sync settings saved. Sync itself stays gated OFF until Troy decides the threshold.');
    } catch (e) { notify('Save failed: ' + e.message); }
  }
  async function syncAttempt() {
    try {
      var r = await post('buyervault-sync', { action: 'sync', dryRun: true });
      notify(r.blocked ? ('Sync blocked: ' + r.reason) : ('Dry run: ' + count(r.eligible) + ' buyers would sync — nothing was sent.'));
      var l = await get('buyervault-sync', 'action=log');
      renderSyncLog(l.log || []);
    } catch (e) { notify('Sync attempt failed: ' + e.message); }
  }

  global.BuyerVaultUI = {
    init: init, switchTab: switchTab, search: search, refresh: refresh,
    showJob: showJob, pickMarket: pickMarket, save: save,
    refreshSaved: refreshSaved, unsave: unsave, cadence: cadence,
    entitySearch: entitySearch, entityDetail: entityDetail, entityFor: entityFor,
    syncSaveConfig: syncSaveConfig, syncAttempt: syncAttempt, loadSync: loadSync,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* address-autocomplete.js — shared address type-ahead for the Command
 * Center (Troy, Nov 22, 2026): "from the time I start to type like the
 * first couple digits it should just populate the address."
 *
 * Attached to:
 *   - the Quick Offer comp-run field (#qoAddr in index.html) — picking a
 *     suggestion fills the full address incl. zip, ready for Run;
 *   - the AI assistant input (#aiInput in ai-assistant.js) — same
 *     dropdown; picking fills the input text (never auto-sends).
 *
 * Sources, merged local-first:
 *   1. window.ccLocalAddressCandidates(q) — addresses the page already
 *      knows (your leads + recent searches). Instant, no network.
 *   2. GET /.netlify/functions/address-suggest?q=... — free keyless
 *      suggestions for brand-new addresses (see that function; no
 *      credits, no tokens, nothing paid).
 *
 * Pure helpers (buildLabel / normalizeSuggestion / mergeSuggestions /
 * fillInput) are exported for node regression tests; the DOM wiring
 * only runs in the browser.
 */
(function () {
  'use strict';

  var ENDPOINT = '/.netlify/functions/address-suggest';

  /* ---------- pure helpers (unit-tested) ---------- */

  function buildLabel(s) {
    if (!s) return '';
    if (s.label) return String(s.label);
    var tail = (((s.state || '') + ' ' + (s.zip || '')).trim());
    return [s.streetAddress || s.street || '', s.city || '', tail].filter(function (x) { return !!x; }).join(', ');
  }

  function normalizeSuggestion(s, source) {
    if (!s) return null;
    var out = {
      streetAddress: s.streetAddress || s.street || '',
      city: s.city || '',
      state: s.state || '',
      zip: s.zip || s.zipCode || '',
      source: source || s.source || 'remote',
    };
    out.label = buildLabel(s.label ? { label: s.label } : out);
    if (!out.label) return null;
    return out;
  }

  // Local hits first, then remote; dedupe by label (case-insensitive).
  function mergeSuggestions(localList, remoteList, cap) {
    var seen = {};
    var out = [];
    [localList || [], remoteList || []].forEach(function (list, li) {
      list.forEach(function (raw) {
        var s = normalizeSuggestion(raw, li === 0 ? 'local' : 'remote');
        if (!s) return;
        var key = s.label.toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        out.push(s);
      });
    });
    return out.slice(0, cap || 8);
  }

  // Selecting a suggestion fills the input with the FULL address
  // (street, city, state AND zip) — the whole point of the feature.
  function fillInput(input, item) {
    if (input && item) input.value = item.label;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildLabel: buildLabel,
      normalizeSuggestion: normalizeSuggestion,
      mergeSuggestions: mergeSuggestions,
      fillInput: fillInput,
      ENDPOINT: ENDPOINT,
    };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ---------- browser wiring ---------- */

  var styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var css = ''
      + '.cc-ac-wrap{position:relative;flex:1;display:flex;min-width:0}'
      + '.cc-ac-wrap>input{flex:1;width:100%}'
      + '.cc-ac-list{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:9999;'
      + 'background:var(--panel,#fff);border:1px solid var(--line,#ddd);border-radius:10px;'
      + 'box-shadow:0 10px 30px rgba(0,0,0,.28);overflow:hidden;max-height:320px;overflow-y:auto}'
      + '.cc-ac-item{padding:10px 12px;cursor:pointer;font-size:14px;line-height:1.35;color:var(--text,#111);'
      + 'border-bottom:1px solid var(--line,#eee);display:flex;gap:8px;align-items:baseline}'
      + '.cc-ac-item:last-child{border-bottom:none}'
      + '.cc-ac-item .cc-ac-main{flex:1}'
      + '.cc-ac-item .cc-ac-src{font-size:11px;color:var(--muted,#888);white-space:nowrap}'
      + '.cc-ac-item.active,.cc-ac-item:hover{background:var(--panel2,#f2f4f8)}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.attachAddressAutocomplete = function (input, opts) {
    if (!input || input.dataset.ccAcAttached) return;
    input.dataset.ccAcAttached = '1';
    opts = opts || {};
    injectStyle();

    var minChars = opts.minChars || 3;
    var debounceMs = opts.debounceMs == null ? 220 : opts.debounceMs;
    var cap = opts.cap || 8;

    var wrap = document.createElement('div');
    wrap.className = 'cc-ac-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.setAttribute('autocomplete', 'off');

    var list = document.createElement('div');
    list.className = 'cc-ac-list';
    list.setAttribute('role', 'listbox');
    list.style.display = 'none';
    wrap.appendChild(list);

    var items = [];
    var activeIdx = -1;
    var open = false;
    var timer = null;
    var seq = 0;
    var aborter = null;

    function localMatches(q) {
      try {
        var fn = opts.localCandidates || window.ccLocalAddressCandidates;
        if (typeof fn === 'function') return fn(q) || [];
      } catch (e) {}
      return [];
    }

    function render() {
      if (!items.length) { close(); return; }
      list.innerHTML = items.map(function (s, i) {
        return '<div class="cc-ac-item' + (i === activeIdx ? ' active' : '') + '" role="option" data-idx="' + i + '">'
          + '<span class="cc-ac-main">' + esc(s.label) + '</span>'
          + (s.source === 'local' ? '<span class="cc-ac-src">your lead</span>' : '')
          + '</div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('.cc-ac-item'), function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault(); // beat the input blur so the click lands
          select(items[+el.dataset.idx]);
        });
      });
      list.style.display = 'block';
      open = true;
      input.setAttribute('aria-expanded', 'true');
    }

    function close() {
      open = false;
      activeIdx = -1;
      list.style.display = 'none';
      input.setAttribute('aria-expanded', 'false');
    }

    function select(item) {
      if (!item) return;
      fillInput(input, item);
      close();
      input.focus();
      if (typeof opts.onSelect === 'function') {
        try { opts.onSelect(item, input); } catch (e) {}
      }
    }

    function remoteFetch(q, mySeq) {
      if (aborter) { try { aborter.abort(); } catch (e) {} }
      aborter = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var fetchOpts = aborter ? { signal: aborter.signal } : {};
      fetch(ENDPOINT + '?q=' + encodeURIComponent(q), fetchOpts)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (mySeq !== seq) return; // a newer keystroke owns the dropdown
          var remote = (data && data.suggestions) || [];
          items = mergeSuggestions(localMatches(q), remote, cap);
          activeIdx = -1;
          render();
        })
        .catch(function () { /* fail soft: local matches stay on screen */ });
    }

    input.addEventListener('input', function () {
      var q = (input.value || '').trim();
      seq++;
      if (q.length < minChars) { close(); return; }
      var locals = localMatches(q);
      items = mergeSuggestions(locals, [], cap);
      activeIdx = -1;
      render();
      var mySeq = seq;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { remoteFetch(q, mySeq); }, debounceMs);
    });

    input.addEventListener('blur', function () {
      setTimeout(close, 120);
    });

    // Capture phase on the document: when the dropdown is open, Enter /
    // arrows belong to the dropdown — this runs BEFORE the fields' own
    // Enter handlers (Quick Offer runs comps on Enter; the assistant
    // sends on Enter), so picking a suggestion never fires a run/send.
    // When the dropdown is closed the keys pass through untouched.
    document.addEventListener('keydown', function (e) {
      if (document.activeElement !== input || !open) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        activeIdx = Math.max(activeIdx - 1, 0);
        render();
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && items[activeIdx]) {
          e.preventDefault(); e.stopPropagation();
          select(items[activeIdx]);
        } else {
          close();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        close();
      }
    }, true);

    document.addEventListener('mousedown', function (e) {
      if (open && !wrap.contains(e.target)) close();
    });
  };
})();

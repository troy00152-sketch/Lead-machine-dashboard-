/* ============ AI ASSISTANT — dashboard chat panel (Troy's command-center AI) ============
 * Mounts into #aiChatMount on #page-aichat. Backed by POST /.netlify/functions/dashboard-ai.
 * No secrets here — the API key lives server-side in Netlify env vars.
 * Chat history persists in browser localStorage only (lm_aichat_v1).
 * Troy's approval gate (Oct 29, 2026): no deploy until he reviews.
 */
(function () {
  'use strict';
  var STORE_KEY = 'lm_aichat_v1';
  var ENDPOINT = '/.netlify/functions/dashboard-ai';
  var MAX_HISTORY = 40;

  var STARTERS = [
    'Run offer math: ARV $290K, repairs $40K',
    'What is MAO if ARV is $150K and repairs are $50K?',
    'Draft a seller follow-up text',
    'Draft a buyer blast message for a new deal',
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Minimal safe formatting: **bold**, line breaks, numbered/bulleted lines.
  function fmt(text) {
    var h = esc(text);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|\n)((?:\d+\.\s|[-•]\s)[^\n]+(?:\n(?:\d+\.\s|[-•]\s)[^\n]+)*)/g, function (m, pre, list) {
      var items = list.trim().split('\n').map(function (ln) {
        return '<li>' + ln.replace(/^\d+\.\s|^[-•]\s/, '') + '</li>';
      }).join('');
      return pre + '<ul class="ai-list">' + items + '</ul>';
    });
    h = h.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
    return '<p>' + h + '</p>';
  }

  function loadHist() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(-MAX_HISTORY) : [];
    } catch (e) { return []; }
  }
  function saveHist(h) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(h.slice(-MAX_HISTORY))); } catch (e) {}
  }

  var hist = loadHist();
  var busy = false;

  function render() {
    var mount = document.getElementById('aiChatMount');
    if (!mount) return;
    var html = ''
      + '<div class="ai-shell">'
      + '<div class="ai-head"><div><div class="ai-title">💬 Command Center AI</div>'
      + '<div class="ai-sub">Deal questions · offer math · text drafts — pennies per chat</div></div>'
      + '<button class="btn small ghost" id="aiNewChat">+ New chat</button></div>'
      + '<div class="ai-msgs" id="aiMsgs"></div>'
      + '<div class="ai-starters" id="aiStarters">' + STARTERS.map(function (s, i) {
          return '<button class="ai-chip" data-starter="' + i + '">' + esc(s) + '</button>';
        }).join('') + '</div>'
      + '<div class="ai-inputrow"><input class="field" id="aiInput" placeholder="Ask about a deal, run numbers, draft a text…" autocomplete="off" maxlength="4000">'
      + '<button class="btn primary" id="aiSend">Send</button></div>'
      + '<div class="ai-foot">Never invents ARVs · quotes MAO/LAO only from verified numbers · can\'t send, book, or spend — it advises, you act.</div>'
      + '</div>';
    mount.innerHTML = html;

    document.getElementById('aiNewChat').onclick = function () {
      if (busy) return;
      hist = []; saveHist(hist); paintMsgs();
    };
    document.getElementById('aiSend').onclick = send;
    document.getElementById('aiInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    var chips = document.querySelectorAll('#aiStarters .ai-chip');
    chips.forEach(function (chip) {
      chip.onclick = function () {
        if (busy) return;
        document.getElementById('aiInput').value = STARTERS[+chip.dataset.starter];
        send();
      };
    });
    paintMsgs();
  }

  function paintMsgs() {
    var box = document.getElementById('aiMsgs');
    if (!box) return;
    if (!hist.length) {
      box.innerHTML = '<div class="ai-empty">👋 Ask me about a deal, give me an ARV and repairs to run the math, or have me draft a seller or buyer text.</div>';
      return;
    }
    box.innerHTML = hist.map(function (m) {
      if (m.role === 'user') return '<div class="ai-row user"><div class="ai-bubble user">' + esc(m.content) + '</div></div>';
      return '<div class="ai-row ai"><div class="ai-avatar">🏠</div><div class="ai-bubble ai">' + fmt(m.content) + '</div></div>';
    }).join('') + (busy ? '<div class="ai-row ai"><div class="ai-avatar">🏠</div><div class="ai-bubble ai ai-typing"><span></span><span></span><span></span></div></div>' : '');
    box.scrollTop = box.scrollHeight;
  }

  async function send() {
    if (busy) return;
    var input = document.getElementById('aiInput');
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    hist.push({ role: 'user', content: text });
    busy = true; paintMsgs();
    try {
      var resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: hist.slice(-MAX_HISTORY) }),
      });
      var data = null;
      try { data = await resp.json(); } catch (e) {}
      if (!resp.ok || !data || !data.reply) {
        var msg = (data && (data.setup || data.error)) || ('Request failed (' + resp.status + ')');
        hist.push({ role: 'assistant', content: '⚠️ ' + msg });
      } else {
        hist.push({ role: 'assistant', content: data.reply });
      }
    } catch (e) {
      hist.push({ role: 'assistant', content: '⚠️ Could not reach the AI service. Check your connection and try again.' });
    }
    busy = false; saveHist(hist); paintMsgs();
  }

  // Expose a hook so other pages can deep-link a question into the chat.
  window.aiAsk = function (q) {
    showPage('aichat');
    setTimeout(function () {
      var input = document.getElementById('aiInput');
      if (input && q) { input.value = q; input.focus(); }
    }, 60);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
  // Re-render when the page is shown (tab pages are static, but the other
  // agent's edits may re-touch the DOM — this keeps the panel alive).
  document.addEventListener('click', function (e) {
    var nav = e.target && e.target.closest ? e.target.closest('[data-nav="aichat"]') : null;
    if (nav) setTimeout(render, 80);
  });
})();

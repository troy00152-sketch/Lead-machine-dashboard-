// cc-model-router.js — ONE central model router for every AI job in the
// Command Center.
//
// Troy's order (Nov 28, 2026): every AI job uses the best model for that
// job, routed through the one OpenRouter key, with Grok direct + Gemini
// kept where they fit. This file is the single place that decides
// job -> model. No other function hardcodes a model for a job: the three
// Conversations assist functions (grok-assist, gemini-assist,
// openrouter-assist) all call router.complete() here, and any future
// agent (e.g. the inbound agent) picks its model by calling
// complete('agent-default', ...) with a job name — no new wiring.
//
// HOW IT WORKS
// Each job has an ordered candidate chain, best first. complete() walks
// the chain until one answers:
//   - a candidate whose provider key is absent is skipped (never called);
//   - a PAID candidate is skipped fast while its provider is flagged
//     unfunded (in-memory flag, 10-minute TTL, set when that provider
//     answers with a billing error: HTTP 402, or 400/403 naming credits);
//   - any other failure (HTTP error, empty reply, timeout, Gemini 429
//     quota) moves to the next candidate — never an error dump.
//   - a transient HTTP failure (429 / 5xx) is retried ONCE on the
//     same candidate after a 1s pause, when the total budget still
//     holds a full attempt after the pause — a brief upstream spike
//     (Gemini 503 under load, Nov 28) must not demote the best
//     model. A TIMEOUT or network failure is never retried: a model
//     that hangs for its whole attempt will hang again, and the
//     retry would eat the budget the rest of the chain needs (Nov
//     28: flash hangs 15s+; retrying it starved lite and the LOI
//     went dead twice before answering). Billing failures (402)
//     and empty replies are never retried.
//   - Google legs run on a 6s per-attempt cap (candidate
//     attemptTimeoutMs): flash either 503s fast or hangs
//     indefinitely, lite answers in ~1s — a hanging flash must not
//     eat the 15s default attempt and leave the chain no time.
//   - complete() reports per-candidate attempts (model + HTTP
//     status + error) on failure, so a live failure can be
//     diagnosed from the response instead of guessed at.
//   - reasoning models are capped at effort 'low' on OpenRouter, and
//     Google attempts get a 2048-token floor: max_tokens /
//     maxOutputTokens counts internal thinking tokens, and a default
//     high/medium effort can burn a small budget on thinking and
//     return a cut-off or empty visible answer (the Nov 28 LOI
//     truncation). Gemma entries carry no reasoning flag — they are
//     not reasoning models.
// So the moment Troy funds OpenRouter credits, the paid primaries start
// answering with zero code change; while the balance is $0 the best
// FREE model answers instead. Nothing here ever buys credits and nothing
// here ever prices a deal.
//
// MODEL IDs — every one verified in the live OpenRouter catalogue on
// Nov 28, 2026 (or a verified direct-provider model). Deliberately NOT
// routed: x-ai/grok-4.1-fast:free, x-ai/grok-4-fast, x-ai/grok-code-fast-1
// (listed but no provider has served them since Jul 6, 2026),
// x-ai/grok-4.7 (reasoning is mandatory with default effort high — the
// class of model that timed out past 25s on Nov 18; also $2/$6 paid),
// openai/gpt-4.1 (the seller bot's brain — never routed, never touched).
//
// PRICES (live catalogue, Nov 28, 2026, per 1M tokens in/out):
//   anthropic/claude-sonnet-5.5            $2 / $10,  1M ctx
//   x-ai/grok-4.20                         $1.25 / $2.50, 2M ctx
//   google/gemma-4-31b-it:free             $0, 262K ctx
//   google/gemma-4-26b-a4b-it:free         $0, 262K ctx
//   particle-ai/particle-1:free            $0, 1M ctx
//   nvidia/nemotron-3-ultra-550b-a55b:free $0, 262K ctx (reasoning)
//   openrouter/free                        $0 (router picks a servable free model)
// Direct (not OpenRouter): grok-4.20-0309-non-reasoning via xAI
//   ($1.25/$2.50, billed from the $5 prepaid xAI credits) and
//   gemini-3.5-flash via Google (free tier, quota-limited), with
//   gemini-3.5-flash-lite right behind it in every chain — flash
//   returns 503 "high demand" under load (Nov 28), lite answers.
'use strict';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const GOOGLE_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// engine: which Conversations box / engine family the candidate belongs
// to. complete() can pin an engine (a box asks for its own engine first)
// and falls back across engines after that.
// provider: 'openrouter' | 'xai' | 'google'.
// paid: true = needs prepaid credits on that provider.
// attemptTimeoutMs: a candidate may cap its own attempt shorter than
// the 15s default. Google legs run on a 6s cap: flash either 503s fast
// or hangs indefinitely (live Nov 28: 60s+ with no answer), lite
// answers in ~1s — a hanging flash must not eat the default attempt
// and starve the rest of the chain.
const GOOGLE_ATTEMPT_TIMEOUT_MS = 6000;
const ROUTES = {
  // Long seller thread, faithful extraction. Best reader first
  // (Claude, 1M ctx), then fastest funded (Grok direct), then the best
  // free dense reader (Gemma 4 31B), then the 1M-ctx free model, then
  // the free router, then Gemini direct — flash first, flash-lite right
  // behind it (flash 503s under load; lite answers).
  'thread-summarize': [
    { engine: 'deepread', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', paid: true, reasoning: 'low' },
    { engine: 'grok', provider: 'xai', model: 'grok-4.20-0309-non-reasoning', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'particle-ai/particle-1:free', paid: false, reasoning: 'low' },
    { engine: 'deepread', provider: 'openrouter', model: 'openrouter/free', paid: false, reasoning: 'low' },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash-lite', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
  ],
  // Short seller follow-up text. Fastest funded first (Grok direct
  // answers in seconds, non-reasoning on purpose), then the same model
  // through the key, then the best small free model.
  'draft-followup': [
    { engine: 'grok', provider: 'xai', model: 'grok-4.20-0309-non-reasoning', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'x-ai/grok-4.20', paid: true, reasoning: 'low' },
    { engine: 'deepread', provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'openrouter/free', paid: false, reasoning: 'low' },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash-lite', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
  ],
  // Second-eyes deal check — FLAGS ONLY, never prices. Best careful
  // reader first, then the strongest free reasoner (effort low, so it
  // stays inside the 25s function envelope), then the best free reader.
  'deal-check': [
    { engine: 'deepread', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', paid: true, reasoning: 'low' },
    { engine: 'deepread', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', paid: false, reasoning: 'low' },
    { engine: 'deepread', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'openrouter/free', paid: false, reasoning: 'low' },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash-lite', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
  ],
  // LOI draft — ONE engine: Gemini. Gemini drafts the contract
  // language; the OpenRouter free candidates below are resilience only,
  // so the button never goes dead if Gemini's free tier is quota-hit.
  // They are not a second LOI engine. Flash first, flash-lite right
  // behind it (flash 503s under load; lite answers).
  'loi-draft': [
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash-lite', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
    { engine: 'deepread', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'openrouter/free', paid: false, reasoning: 'low' },
  ],
  // Default chain for future agent work (e.g. the inbound agent):
  // best reasoning first, fast funded second, best free base last.
  'agent-default': [
    { engine: 'deepread', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', paid: true, reasoning: 'low' },
    { engine: 'grok', provider: 'xai', model: 'grok-4.20-0309-non-reasoning', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'x-ai/grok-4.20', paid: true, reasoning: 'low' },
    { engine: 'deepread', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', paid: false },
    { engine: 'deepread', provider: 'openrouter', model: 'openrouter/free', paid: false, reasoning: 'low' },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
    { engine: 'gemini', provider: 'google', model: 'gemini-3.5-flash-lite', paid: false, attemptTimeoutMs: GOOGLE_ATTEMPT_TIMEOUT_MS },
  ],
};

const JOBS = Object.keys(ROUTES);
const DEFAULT_TIMEOUT_MS = 25000;
const ATTEMPT_TIMEOUT_MS = 15000;
const UNFUNDED_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RETRY_DELAY_MS = 1000; // pause before one retry of a transient failure
const GOOGLE_MIN_TOKENS = 2048; // Google maxOutputTokens floor: thinking
// tokens count against it, so a small budget can starve the visible
// answer on a reasoning model (Gemini 3.5 Flash reasoning is mandatory).

// Provider key env vars. A provider with no key is skipped, never called.
const PROVIDER_KEYS = {
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

// In-memory "this provider has no prepaid credit" flags, set when a
// provider answers with a billing error. Warm containers honor them;
// a cold start re-probes once, which is the correct self-healing
// behavior when Troy funds the account.
const unfundedUntil = { openrouter: 0, xai: 0 };

function resetFundingCache() {
  unfundedUntil.openrouter = 0;
  unfundedUntil.xai = 0;
}

// A billing error is a 402, or a 400/403 whose message names credits.
function isBillingError(httpStatus, bodyText) {
  if (httpStatus === 402) return true;
  if ((httpStatus === 400 || httpStatus === 403) && /credit|billing|balance/i.test(bodyText || '')) return true;
  return false;
}

function keyFor(provider) {
  return (process.env[PROVIDER_KEYS[provider]] || '').trim();
}

function isUnfunded(provider) {
  return Date.now() < (unfundedUntil[provider] || 0);
}

function markUnfunded(provider) {
  if (unfundedUntil[provider] !== undefined) {
    unfundedUntil[provider] = Date.now() + UNFUNDED_TTL_MS;
  }
}

// Ordered chain for a job. When an engine is pinned (a Conversations
// box asking for its own engine), that engine's candidates move to the
// front in their original relative order; the rest follow — but only
// the FREE ones. A pinned box never silently spends another engine's
// paid model: the Gemini box's fallback is Gemma / the free router,
// never paid Claude (Nov 28: Gemini's self-test was served by Claude
// while Gemini was 503). The pinned engine's own paid primary stays
// (e.g. Deep Read's Claude) — that is the box's own model, not a
// cross-engine spend.
function routeFor(job, engine) {
  const chain = (ROUTES[job] || []).slice();
  if (!engine) return chain;
  const pinned = chain.filter((c) => c.engine === engine);
  const rest = chain.filter((c) => c.engine !== engine && !c.paid);
  return pinned.concat(rest);
}

function splitMessages(messages) {
  const system = [];
  const user = [];
  (messages || []).forEach((m) => {
    if (!m || typeof m.content !== 'string') return;
    if (m.role === 'system') system.push(m.content);
    else user.push(m.content);
  });
  return { system: system.join('\n'), user: user.join('\n') };
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// Pull the reply text out of an OpenAI-shape or Google-shape response.
// Returns '' when there is no text to pull (empty reply, not a crash).
function extractText(data) {
  if (!data || typeof data !== 'object') return '';
  const parts = data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts;
  if (Array.isArray(parts)) {
    return parts.map((p) => (p && p.text) || '').join('').trim();
  }
  const content = data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  return String(content || '').trim();
}

// One attempt at one candidate. Returns { ok, content } on success or
// { ok:false, billing, transient, status, error } on failure. Never
// throws for an HTTP-level failure — the caller walks on to the next
// candidate. transient = a 429 / 5xx / timeout / network failure, worth
// one retry; billing failures and empty replies are not transient.
async function tryCandidate(candidate, messages, maxTokens, timeoutMs) {
  const provider = candidate.provider;
  const apiKey = keyFor(provider);
  if (!apiKey) return { ok: false, billing: false, skipped: 'no_key' };
  if (candidate.paid && isUnfunded(provider)) {
    return { ok: false, billing: true, skipped: 'unfunded' };
  }
  try {
    let res;
    let raw = '';
    if (provider === 'google') {
      const parts = splitMessages(messages);
      const body = {
        system_instruction: { parts: [{ text: parts.system }] },
        contents: [{ role: 'user', parts: [{ text: parts.user }] }],
        // Floor, not the raw budget: Gemini 3.5 Flash reasoning is
        // mandatory and its thinking tokens count against
        // maxOutputTokens, so a 500-token budget can leave almost
        // nothing for the visible answer.
        generationConfig: { temperature: 0.4, maxOutputTokens: Math.max(maxTokens, GOOGLE_MIN_TOKENS) },
      };
      res = await fetchWithTimeout(
        GOOGLE_URL_BASE + encodeURIComponent(candidate.model) + ':generateContent',
        {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      raw = await res.text().catch(() => '');
      if (!res.ok) {
        // 429 on this API is always quota — transient, not a billing
        // death: walk on to the next candidate. Flag it so the Gemini
        // box can show its calm dormant line instead of an error. A 402
        // here is a billing error like anywhere else.
        const billing = isBillingError(res.status, raw);
        if (billing) markUnfunded(provider);
        // retryable: only an HTTP 429/5xx gets one retry. A timeout or
        // network throw never does (see the catch below).
        const retryable = res.status === 429 || res.status >= 500;
        return { ok: false, billing, quota: res.status === 429, status: res.status, transient: retryable, retryable, error: 'google HTTP ' + res.status };
      }
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* below */ }
      const content = extractText(data);
      if (!content) return { ok: false, billing: false, status: res.status, retryable: false, error: 'empty reply' };
      return { ok: true, content };
    }
    // OpenAI-compatible providers: OpenRouter + xAI.
    const url = provider === 'openrouter' ? OPENROUTER_URL : XAI_URL;
    const body = {
      model: candidate.model,
      temperature: 0.4,
      max_tokens: maxTokens,
      messages,
    };
    if (candidate.reasoning) body.reasoning = { effort: candidate.reasoning };
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    raw = await res.text().catch(() => '');
    if (!res.ok) {
      const billing = isBillingError(res.status, raw);
      if (billing) markUnfunded(provider);
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, billing, status: res.status, transient: retryable, retryable, error: provider + ' HTTP ' + res.status };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* below */ }
    const content = extractText(data);
    if (!content) return { ok: false, billing: false, status: res.status, retryable: false, error: 'empty reply' };
    return { ok: true, content };
  } catch (err) {
    // Timeout / network failure: transient — the chain walks on — but
    // NEVER retried. A model that hangs for its whole attempt will
    // hang again; retrying it would eat the budget the rest of the
    // chain needs (Nov 28: flash hangs 15s+, the retry starved lite).
    return { ok: false, billing: false, transient: true, retryable: false, error: String((err && err.message) || err) };
  }
}

// Run one AI job through its routed chain.
//   complete({ job, messages, engine, maxTokens, timeoutMs, attemptTimeoutMs })
// engine pins a Conversations box's own engine first (falls back across
// engines after that); omit it for the canonical best-first chain (the
// inbound-agent hook calls it this way). timeoutMs is the total budget
// (default 25s); attemptTimeoutMs caps one candidate (default 15s) so a
// hung model cannot eat the whole budget before the chain moves on — a
// candidate may cap itself shorter (Google legs: 6s). A transient HTTP
// failure (429 / 5xx) is retried once on the same candidate after a 1s
// pause, only when the budget still holds a full attempt after the
// pause; a timeout / network failure is never retried.
// Returns { ok:true, content, model, provider, engine, tried, fallback }
// or { ok:false, status:'no_credit'|'error'|'not_configured', error, tried }.
// status 'no_credit' = every attempted candidate failed on billing (or
// every paid candidate was skipped unfunded and no free candidate was
// configured) — the UI shows the calm dormant line for this.
// 'not_configured' = no provider key exists at all.
// One attempt's failure detail for the caller: whether a Google
// free-tier quota (429) was hit anywhere in the chain.
async function complete(opts) {
  const job = String((opts && opts.job) || '');
  const messages = (opts && opts.messages) || [];
  const engine = (opts && opts.engine) || null;
  const maxTokens = (opts && opts.maxTokens) || 500;
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const attemptTimeoutMs = (opts && opts.attemptTimeoutMs) || ATTEMPT_TIMEOUT_MS;
  if (!ROUTES[job]) {
    return { ok: false, status: 'error', error: 'Unknown job: ' + job, tried: [], quotaHit: false };
  }
  const chain = routeFor(job, engine);
  const deadline = Date.now() + timeoutMs;
  const tried = [];
  // Per-candidate failure detail for the caller (model + HTTP status +
  // error), so a live failure can be diagnosed from the response
  // instead of guessed at: which candidate failed, and how.
  const attempts = [];
  let sawBilling = false;
  let sawNonBilling = false;
  let sawQuota = false;
  let sawAttempt = false;
  let lastError = 'No model answered.';
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    if (!keyFor(candidate.provider)) continue; // provider not configured
    if (candidate.paid && isUnfunded(candidate.provider)) {
      sawBilling = true;
      tried.push(candidate.model + ' (skipped: no credit)');
      attempts.push({ model: candidate.model, status: 'skipped', reason: 'no credit' });
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 100) break; // out of budget — stop, don't half-start
    // A candidate may cap its own attempt shorter than the default:
    // Google legs run on a 6s cap — a hanging flash must not eat the
    // default 15s attempt and leave the chain no time for lite.
    const candTimeout = Math.min(remaining, candidate.attemptTimeoutMs || attemptTimeoutMs);
    sawAttempt = true;
    const attempt = await tryCandidate(candidate, messages, maxTokens, candTimeout);
    tried.push(candidate.model);
    attempts.push({ model: candidate.model, status: attempt.ok ? 'ok' : 'error', httpStatus: attempt.status || null, error: attempt.error || null });
    if (attempt.ok) {
      return {
        ok: true,
        content: attempt.content,
        model: candidate.model,
        provider: candidate.provider,
        engine: candidate.engine,
        tried,
        fallback: i > 0,
      };
    }
    if (attempt.billing) sawBilling = true;
    else sawNonBilling = true;
    if (attempt.quota) sawQuota = true;
    lastError = attempt.error || lastError;
    // One retry on a transient HTTP failure (429 / 5xx) only, and
    // only when the budget still holds a full attempt after the
    // pause — a brief upstream spike must not demote the best model,
    // and the retry must never eat the budget the rest of the chain
    // needs. A timeout / network failure is never retried (see
    // tryCandidate): a hanging model hangs again.
    if (attempt.retryable && deadline - Date.now() > RETRY_DELAY_MS + candTimeout) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      const retryRemaining = deadline - Date.now();
      const retryTimeout = Math.min(retryRemaining, candTimeout);
      const retry = await tryCandidate(candidate, messages, maxTokens, retryTimeout);
      tried.push(candidate.model + ' (retry)');
      attempts.push({ model: candidate.model + ' (retry)', status: retry.ok ? 'ok' : 'error', httpStatus: retry.status || null, error: retry.error || null });
      if (retry.ok) {
        return {
          ok: true,
          content: retry.content,
          model: candidate.model,
          provider: candidate.provider,
          engine: candidate.engine,
          tried,
          fallback: i > 0,
        };
      }
      if (retry.billing) sawBilling = true;
      else sawNonBilling = true;
      if (retry.quota) sawQuota = true;
      lastError = retry.error || lastError;
    }
  }
  if (!sawAttempt && !sawBilling) {
    return { ok: false, status: 'not_configured', error: 'No AI provider is configured yet', tried, attempts };
  }
  // 'no_credit' only when EVERY failure was a billing failure (or a
  // paid skip while unfunded). A free model failing on a 500/timeout
  // is an error, not an empty balance — the UI must not call it dormant.
  if (sawBilling && !sawNonBilling) {
    return { ok: false, status: 'no_credit', error: 'No credit left on any funded provider', tried, quotaHit: sawQuota, attempts };
  }
  return { ok: false, status: 'error', error: lastError, tried, quotaHit: sawQuota, attempts };
}

module.exports = {
  ROUTES,
  JOBS,
  OPENROUTER_URL,
  XAI_URL,
  routeFor,
  complete,
  isBillingError,
  extractText,
  resetFundingCache,
};

// Offline checks (no network): node -e "const r=require('./cc-model-router.js'); console.log(r.JOBS)"
exports._test = { ROUTES, JOBS, routeFor, complete, isBillingError, extractText, resetFundingCache };

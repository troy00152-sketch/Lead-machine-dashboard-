/**
 * llm.js — LLM provider adapter (OpenAI-compatible chat completions).
 *
 * Provider is chosen purely by env: LLM_BASE_URL + LLM_API_KEY + LLM_MODEL
 * (default model gpt-4.1 — the GPT-4.1 class Ashley runs). Any
 * OpenAI-compatible endpoint works; nothing provider-specific is hardcoded
 * beyond the chat-completions shape.
 *
 * generate() THROWS on any failure (HTTP error, timeout, empty content) —
 * the handler treats a throw as SILENCE. That is the whole point of the bot:
 * the HighLevel platform fallback can never fire because a failed generation
 * produces no reply at all.
 */
'use strict';

function createLlm(config, fetchImpl = globalThis.fetch) {
  const base = (config.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');

  async function generate({ system, messages }) {
    const controller = new AbortController();
    // Default 15s (Nov 27, 2026): the bot hook awaits at most 22s
    // (telnyx-webhook BOT_HOOK_TIMEOUT_MS), and cold build (~3–5s) +
    // LLM + ~1s Telnyx send must fit inside it with margin. The old
    // 25s default meant a slow reply was abandoned at 22s — Lambda
    // freeze killed the in-flight runBot, so no reply AND no botLog
    // entry. LLM_TIMEOUT_MS (via bot/src/config.js, also 15000)
    // overrides this default.
    const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs || 15000);
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.llmApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.llmModel || 'gpt-4.1',
          temperature: 0.4,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const content =
        data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : null;
      if (!content || !String(content).trim()) {
        throw new Error('LLM returned empty content');
      }
      return String(content);
    } finally {
      clearTimeout(timer);
    }
  }

  return { generate };
}

module.exports = { createLlm };

# Vendored bot brain — standalone Command Center

Verbatim copies of the proven seller-bot source from
`~/workspace/playbook-system/custom-bot/`, vendored 2026-11-16 for the
standalone Command Center build (ONE BUILD directive):

- `bot/src/*.js` ← `custom-bot/src/*.js` (handler.js, guards.js,
  booking.js, hl.js, config.js, prompt.js, llm.js, pipeline.js,
  wordfilter.js, objections.js, watchdog-check.js)
- `knowledge/prompt.md`, `knowledge/kb.json` ← `custom-bot/knowledge/`
  (the prompt.md backup files were intentionally not copied)

The brain is NOT edited here. The standalone port swaps only the
transport: `netlify/functions/cc-client.js` implements the exact
`src/hl.js` interface against the standalone stores (cc-conversations,
cc-enrollments, cc-appointments, cc-opportunities), and
`netlify/functions/cc-bot-runner.js` wires config + client + LLM into
the vendored `createHandler`. Nothing in this tree talks to HighLevel.

If the bot brain is ever updated in custom-bot, re-copy the files and
re-run the full standalone test suites before deploying.

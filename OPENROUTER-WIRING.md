# Deploy note — OpenRouter deep-read assist (Nov 21, 2026)

## Why
Troy approved wiring OpenRouter into the Command Center as a third AI
engine beside Gemini and Grok (Nov 21 voice call). Role is DRAFT-ONLY:
summarize seller threads, draft follow-ups for Troy's review, second-eyes
reading. It never prices deals, never sends anything, and never touches
the live bot function. Built by mirroring the Grok wiring
(grok-assist.js + grok-assist-regression.js) file-for-file.

## Files changed (in ~/workspace/dashboard-src/) — ONE commit, all three
- `netlify/functions/openrouter-assist.js` — NEW. Same handler shape as
  grok-assist.js: POST {action: summarize|draft, text}; key read ONLY
  from the Netlify env var OPENROUTER_API_KEY; 402 / credit-worded
  errors -> { status: 'no_credit' }; no key -> 503 'not_configured'.
  Default model: anthropic/claude-sonnet-5.5. GET ?selftest=1 runs the
  fixed sample thread on the FREE router model (openrouter/free) so
  verification never burns paid credits.
- `conversations.html` — adds a third assist box ("🔎 Deep read") under
  the Grok and Gemini boxes: OPENROUTER_API const, state.openrouter,
  openrouterSection() + runOpenRouter(), selectThread reset, click
  handler for [data-openrouter-action], matching CSS. No vendor name in
  any user-visible text (white-label rule holds).
- `openrouter-assist-regression.js` — NEW. Offline fixture tests, stubbed
  fetch, fake TEST key only.

## Tests (run locally, no live calls) — all passing Nov 21
- `node openrouter-assist-regression.js` — 42/42 PASS (incl. self-test
  proven to request model openrouter/free, a 'price' action rejected
  400, a 'send' action rejected 400).
- `node grok-assist-regression.js` — 36/36 PASS (no collateral damage).
- `node gemini-assist-regression.js` — 35/35 PASS (no collateral damage).
- conversations.html inline script parses clean (node new Function).

## REQUIRED manual step — env var (cannot be set from the build sandbox)
No Netlify CLI and no NETLIFY_TOKEN exist in the build environment
(same as when Troy pasted XAI_API_KEY himself). Troy (or the parent
agent in the live browser, with Troy's go) must add, on the Netlify
site merry-biscochitos-c87f96 (leadmachineapp.com):
  Site configuration → Environment variables → Add a variable
  Key:   OPENROUTER_API_KEY
  Value: the OpenRouter "Default key" from Troy's account
         (troy00152@gmail.com) — the value Troy pasted in chat Nov 21.
  Scopes: Functions (all scopes is fine).
Then redeploy (the code deploy below triggers one; if the var is added
after the deploy, trigger a redeploy so functions pick it up).
Until the var exists, the Deep read box sits dormant with the calm
"isn't set up yet" line — by design, not an error.

## Suggested commit (one commit, all three files)
```
Add OpenRouter deep-read assist to Conversations (draft-only)
```

## After deploy — live verification (required before calling done)
1. https://leadmachineapp.com/.netlify/functions/openrouter-assist?selftest=1
   (signed in) — expect { status: 'ok', selftest: true,
   model: 'openrouter/free', result: <two-line summary of the sample
   thread> }. Costs $0 (free model). If the env var is not yet set,
   expect 503 'not_configured' instead — that confirms the route is
   live and dormant, and the self-test completes once the var lands.
2. Open Conversations, pick a thread: the 🔎 Deep read box renders
   under the other two assist boxes; Summarize returns a two-line
   summary in the read-only panel (this one uses the paid deep-read
   model from prepaid credits — balance is $0 + <$1 free allowance,
   so a no_credit dormant reply is also a correct outcome until Troy
   funds the account).

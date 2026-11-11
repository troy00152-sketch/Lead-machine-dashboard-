# ESIGN DEPLOY — In-Dashboard E-Sign (HighLevel signing in the Command Center)

**Date built:** November 11, 2026 (fixture-tested only — NOT deployed, NO live send)
**Status:** Ready for Troy's approval to deploy. Nothing here sends a contract or spends money.
**Cost:** $0 new. HighLevel Documents & Contracts e-sign is already included in Troy's $97/mo Starter plan. $0 per signature, no envelope cap, no new vendor, no new keys to buy.

## What it is

"Send for Signature" on any lead in the dashboard. The seller signs on HighLevel's signing page from the link they are emailed; Troy watches the status in the dashboard. The dashboard is the cockpit — HighLevel is the signing room. Contract text comes only from Troy's HighLevel templates; the dashboard never invents or edits terms.

Flow: lead → **✍️ Send for Signature** → pick one of the 9 live HL templates (state-matched) → dashboard validates the contract fields on the HL contact (price, EMD, APN, legal `[APN] ([legal])`, county, closing = contract date + 30 days) → **Prepare** creates a DRAFT (sends nothing) → code checks every signer has a Signature **and** a Date field on the draft → Troy confirms the fields in HL → **Send** emails the contract to the seller and Troy at the same time, texts the seller their HL signing link (unless DND) → status polls (sent → viewed → completed) → on completion the HL contact is tagged `contract-signed` and the audit trail is written to the dashboard log.

## Files in this deploy (from ~/workspace/dashboard-src/)

| File | Bytes | SHA-256 (first 16) | Change |
|---|---|---|---|
| netlify/functions/esign.js | 38,238 | 0809e8bb8bdd3fc | NEW — server function: prepare/send/refresh/templates/documents/envelope |
| assets/esign.js | 16,392 | d35575b410a950a8 | EDIT — Nov 11 manual contact link: unlinked lead opens sheet with a HighLevel contact-ID field instead of dead-ending; Prepare uses the entered id, persists it on the lead + saveState() on success; empty id blocks, unknown id fails closed on prepare's HL lookup error |
| esign-regression.js | 23,307 | 30b54e78f418f1e6 | EDIT — fixture suite (96 tests): +24 UI link-flow tests in a DOM/fetch stub |
| index.html | 440,585 | 6af3d456edc70dc | EDIT — script tag (line 24), "✍️ Send for Signature" button (line 2619), #esignModal (lines ~1207–1215) |
| research_notes/esign-vetting-2026-11-11.md | — | — | NEW — vendor comparison + live facts + recommendation (not deployed) |

Full hashes (verify in the Codespace before committing):
- esign.js: `0809e8bb8bdd3fcff2809b4704304375ed68d935e0a8ce0b4ee27dca1e7b14aa`
- assets/esign.js: `d35575b410a950a8e14e9529d3032ebe8beccb8ddaa42500d2cdb5759120d3dd`
- esign-regression.js: `30b54e78f418f1e6092afeea34cf7a5101b8fd1237e21d9544c0441a2938b9df`
- index.html: `6af3d456edc70dcb6307b51912404ece23a75a17330a934ad8eb20541c61d488`

## Tests — 96 passed, 0 failed (fixture-only, no live calls, $0)

`node esign-regression.js` → **esign-regression: 96 passed, 0 failed.**

Nov 11 fix (manual contact link): unlinked lead opens the sheet with the manual-ID field (dead-end message gone, templates still load); Prepare sends the entered id, persists it on the lead + saveState() on success, and the field disappears once linked; a linked lead shows no field and uses its stored id (unchanged path, no re-save); empty id blocks with an alert and no fetch; an unknown id surfaces the HL lookup error, links nothing, saves nothing, sends nothing; missing contract fields still surface and the typed id survives the re-render.

What the suite proves: closing date = contract date + 30 days (Gatlin 2026-11-07 → 2026-12-07, month/leap boundaries); legal `[APN] ([legal])` with no double-prefix; field validation blocks on every missing contract field (price, EMD, APN, legal, county, closing, seller email, non-numeric price); signers are seller (contact) + Paula (buyer, HL-user seat) + Troy (copy-only, never a signer); the **Oct 9 fields guard** — the live Gatlin document shape (`fillableFields: []`) BLOCKS, a full Signature+Date draft passes, one signer missing Date or Signature blocks and names them, an unrecognized field type blocks; the state machine never rewinds (completed → viewed stays completed); the 24-hour duplicate guard; the exact HL request bodies (draft `sendDocument:false`, send `medium: email` + Troy CC); DND/dnc blocks the SMS link but not email; OH picks the OH agreement (not the OH disclosure) and shows the SB 155 reminder; the 9 templates are exactly the 9 verified live Nov 11; and the **FREE guard** — no paid e-sign vendor named anywhere in the function or UI code, and the function only calls `services.leadconnectorhq.com`.

## Env vars needed (Netlify — Troy/Paula owns the values; nothing to buy)

| Var | Purpose | Status |
|---|---|---|
| `HL_API_TOKEN` | Already set. Must carry the four proposals scopes: `documents_contracts/list.readonly`, `documents_contracts_template/list.readonly`, `documents_contracts/sendLink.write`, `documents_contracts_template/sendLink.write`. If a call returns 403, add the scopes in HL → Settings → Private Integrations (Kai). | Verify at deploy |
| `ESIGN_SENDER_USER_ID` | The HL user id that sends the contract (required — fail-closed 503 if unset). Resolve from HL Users at deploy. Do NOT guess. | **Must set before deploy** |
| `ESIGN_TROY_CONTACT_ID` | (Optional) Troy's HL contact id, for the `ccRecipients` copy on every send. If unset, the send still goes out — Troy's copy then depends on Paula's signer email reaching his inbox (see open item below). | Optional, set if known |
| `GATE_SECRET` / `DASHBOARD_PASSWORD` | Already set (dashboard admin auth, same as mail). | Already set |

No new money. No new vendor account. No keys to paste from a new service.

## Deploy-time verifications (deploy agent — do these BEFORE telling Troy it works)

1. **Read-only list from the Netlify function:** `GET /.netlify/functions/esign?action=templates` returns the 9 live templates (source `highlevel`, not the fallback list). This also verifies the proposals `Version` header (`2021-07-28`, same as Contacts) and the list scopes. If it returns the fallback list, stop — do not deploy the send path.
2. **Draft creation without sending (UNVERIFIED at build):** create a draft from a test template with `sendDocument:false` and confirm in HL that a draft exists and NOTHING was emailed. If HL ignores the flag and sends immediately, STOP and fall back: remove the draft-first step and make Troy's pre-send fields confirmation the only gate (document the change in this file).
3. **Fields check on a real draft:** confirm the draft's `fillableFields` carry the signature type the code matches on (`/sign/i` in type or fieldId). If HL's signature field type is something else entirely, the check will fail closed — update the matcher to the real string and re-run the suite.
4. **Status poll:** `refresh` on the test envelope reads the HL document status and moves the envelope forward only.
5. **Signed-PDF download:** confirm whether HL exposes a signed-PDF download endpoint. None is in the API catalog read Nov 11 — until confirmed, the signed PDF is viewed in HL and the dashboard links to the document id. Do not claim a PDF download exists.
6. **Page test on leadmachineapp.com:** open a lead, open the sheet, confirm the 9 templates load, the contract summary fills, and Prepare blocks on a lead with missing fields. **Do NOT send a real contract in the deploy test.** The first live send is Troy's call, on a live deal, with him confirming fields in HL first.

## Open items (need Troy's word or a deploy-time answer — none blocks the build)

- **Approach approval:** HL free signing in the dashboard (not a paid vendor). — Troy's tap.
- **Deploy approval:** the 4-file change above. — Troy's tap.
- **Paula's signer email is inconsistent in the record:** the live Gatlin document shows `ttroy863@yahoo.com`; the Oct 9 memory says `troy00152@gmail.com`. Resolve from the live HL user/contact record at deploy; do not guess. This decides which inbox Troy's simultaneous copy reliably lands in.
- **Gatlin document flag (not a verdict):** the live Gatlin contract (`6aefcfc12c8f6fac64629f96`, status `viewed`) shows `fillableFields: []` — the same empty-fields signature as the Oct 9 Jacksonville failure. Troy should verify its Signature/Date fields in HL before relying on that document.
- **Closing Tracker update:** v1 writes the completion (document id, status, timestamps, certificate facts) into the `esign-log` Blobs store with the lead/contact id and tags the HL contact `contract-signed`. Wiring the Closing Tracker page to read `esign-log` completions is a follow-up — the tracker store is not mutated by this function.
- **Co-sellers:** the HL template-send API takes ONE contactId. A second seller (Brenda + Kamal pattern) must already be a recipient in the HL template — the prepare sheet lists the draft's recipients so Troy can confirm them.
- **Signed PDF:** see verification #5 above.
- **This is not legal advice:** ESIGN/UETA treatment depends on the document, jurisdiction and workflow. The dashboard presents HL's certificate/audit facts; the legal call on any deal is Troy's attorney's (George Romania).

## What is NOT in this build (by design)

- No auto-placement of signature/date fields — Troy keeps that control in HL; the code only verifies.
- No native canvas signature capture — rejected (weakest legal footing, no certificate/audit trail, highest build effort; see the vetting note).
- No DocuSign / PandaDoc / Dropbox Sign / any paid vendor — rejected under Troy's FREE constraint.
- No live contract send, no test contract to a real seller, no deploy in this task.

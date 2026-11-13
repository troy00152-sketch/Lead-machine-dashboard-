# BuyerVault → Command Center Wiring Status
Updated Nov 13, 2026 (evening) — §5A wiring BUILT LOCALLY, regression-green,
NOT deployed. Rides the single batched deploy with the Florida merge data.

## Snapshot the wiring is built on (verified from files)
- Master: **34,683 buyers / 24,629 qualified** (31,621 live + FL round-1
  +2,480 + FL recovery +582, both merged Nov 13 by the trace workstream).
- BuyerVault snapshot exported read-only from the owned DBs by
  `tools/build-buyervault-data.py` → `netlify/functions/buyervault-*.json`
  (meta carries provenance + the qualified-join method; re-run the tool
  after any future master merge and bump the count literals together).

## §5A pieces — BUILT (local)
1. **Instant market search + job status** — `buyervault-markets.js`
   (resolve/summary/buyers/candidates over the stored snapshot only, no
   vendor calls in the request path) + `buyervault-jobs.js` + the
   BuyerVault page in index.html. Refresh jobs execute stored-data runs
   with real counts; external pulls (PropertyReach Core, county
   recorder) are recorded `blocked_budget` at the pre-flight credit
   gate [HARD RULE B] — never run from the dashboard. County markets
   show the candidate harvest; master buyers are shown on city markets
   (county assignment of master buyers needs deed evidence — not faked).
2. **Registered-agent / entity-linking view** — `buyervault-entities.js`
   over 15,998 Sunbiz-linked FL candidates (15,826 with registered
   agent): agent, officers, status, addresses, and derived
   shares-agent / shares-address links computed inside the exported
   set and labeled as associations, not proof of common ownership.
3. **HighLevel qualified-buyer sync — TEST/OFF** — `buyervault-sync.js`.
   Config defaults OFF (minScore 60 = spec recommendation only; the
   threshold is still Troy's undecided call). Preview runs the real §5
   qualification gate over the sync index (excludes likely wholesalers
   and lender-only entities [HARD RULE D]; payload tags only in the
   bv-* namespace [HARD RULE I]). A live run requires config ON +
   `BUYERVAULT_SYNC_LIVE=1` env + a wired transport — the transport is
   intentionally NOT wired in this build, so no HighLevel write can
   happen; every attempt is written to the sync log.
4. **Saved-market monitoring** — in `buyervault-jobs.js` (Blobs stores
   `buyervault-jobs` / `buyervault-saved`): save/unsave, daily/weekly/
   paused cadence, next-due computed, and `lastRefreshedAt` stamps that
   advance ONLY when a refresh job actually runs.

## Regression state (Nov 13 evening, final)
- New suite `buyervault-regression.js`: **60 passed, 0 failed** (export
  integrity, resolution, credit gate, sync gate + handlers end-to-end).
- All 20 pre-existing suites pass. Three suites had hardcoded the old
  31,621 master count (buyer-detail, hot-leads-fallback, pwa); their
  expectations were updated to the verified 34,101 → 34,683 as the FL
  merges landed — the failures were stale test constants, not code.

## Still open (not §5A code)
- [ ] Batched deploy (Netlify credit discipline) + live verification.
- [ ] Troy decision: GHL sync threshold — before any live transport is
      wired or sync is enabled.
- [ ] Remaining 121,093-candidate pool stays untraced until the Dec 2
      pool reset, per Troy's scope.

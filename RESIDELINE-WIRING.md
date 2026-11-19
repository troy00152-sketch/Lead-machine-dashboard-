# Resideline Wiring — Build Note (Nov 18, 2026)

Status: **code built and tested in the working tree only. NOT deployed, NOT
committed.** Troy pastes `RESIDELINE_API_KEY` into Netlify himself; the feed
goes live on the batched deploy below.

Troy's ruling (Nov 18): from now on, Command Center comp pulls run off the
Resideline API. ATTOM is done as a comp source (key cut off, 401).

## What was built

### 1. `netlify/functions/resideline-comps.js` (new)

Server-side proxy + comp engine. The key lives only in the Netlify env var
`RESIDELINE_API_KEY` (Functions scope) — never logged, never in browser code.

- **In:** `GET ?address=<full address>` (the dashboard convention used by
  attom-lookup / data-api) or POST JSON
  `{ address, beds?, baths?, sqft?, yearBuilt?, propertyType?,
     bounds?{ radiusMiles?, maxAgeDays?, sqftBand?, yearBuiltDiff? } }`.
  Defaults: radius 1 mi, age 365 days, sqft band 300, year-built diff 20.
- **Upstream:** `POST https://api.resideline.com/v2/api/property_value?enrich_if_missing=true`
  with header `API-Key: <key>`, `Content-Type: application/json`. 2 credits
  per call. There is **no standalone comps endpoint** — the sold comps ride
  inside this response. `enrich_if_missing=true` is always set so a missing
  subject fact enriches instead of returning 400.
- **No key** → `503 { status: 'not_configured', error: 'not_configured' }`
  (same dormant pattern as grok-assist) and no upstream call is made.
- **3-comp minimum:** fewer than 3 sold comps upstream →
  `200 { matched: false, error: 'insufficient_comps', comps: null }` — no
  comp set, no indication, no price verdict. The page's chain treats it as
  a miss and falls through to the next source.
- **Error mapping** (status-driven only; upstream raw bodies are never
  forwarded, the key never appears in any response):
  402 → `credits_exhausted` (402) · 403 → `invalid_key` (403) ·
  404 → `not_found` (404) · 400 → `bad_input` (400, only the documented
  `detail.code` / `detail.suggestion` pass through) ·
  422 → `validation_failed` (422) · other/fetch failure → 502
  `upstream_error` / `upstream_failed`.
- **Selection engine:** ported from attom-lookup's `analyzeComps` — nominal
  transfers out, median outliers excluded both directions with logged
  reasons, similarity scoring, hard similarity rules (sqft ±20%, beds >1,
  sold >12 mo, distance >2 mi), deterministic best-3, plain confidence
  label, as-is anchor + upper-pocket notes. One adaptation: Resideline
  reports no arm's-length indicator, so there is no `unverified` bucket —
  the amount/outlier filters guard the set instead. The engine's
  `indication` (mean of best 3) is what the offer math runs on.

### 2. Frontend — `index.html`, `loadCompsForAddress()` only

Comp fallback order is now **Resideline → data provider → ATTOM**:

1. data-api is still fetched first, but now only to capture the subject
   record (`prData`/`prSubject`) — owner, recorded mortgage, lat/lng,
   distress/equity/title.
2. resideline-comps is tried next; it wins when `matched` and
   `comps.best.length >= 3`. On a win with a PR subject present, the PR
   subject merges over the Resideline property exactly like the old
   ATTOM+PR merge (`compSource` shows `Resideline` or `Resideline+PR`).
3. Otherwise the data provider's comps win as before (`data provider`),
   else ATTOM as before (`ATTOM` / `ATTOM+PR`). All downstream rendering,
   picks, ARV, thin-comp gate, and offer math are untouched.

Not changed (deliberately, noted for later): the lead-detail modal and
`subject-lookup.js` (Command Center analyzer) still call attom-lookup /
data-api directly; they are separate consumers, not the Comps view.

## Field mapping (Resideline → dashboard shape)

Response top level mirrors attom-lookup / data-api:
`{ matched, address, source: 'resideline', property, avm, comps,
linkedProperties: [] }` plus Resideline-specific echoes:
`vendorArv`, `vendorAsIs`, `vendorInterval`, `confidence`,
`confidenceScore`, `search_criteria_used`, `credits_charged`,
`credits_remaining`.

| Resideline | Dashboard | Notes |
|---|---|---|
| `arv_market_value` `"$120,938"` | `vendorArv` `120938`, `avm.value` | Money string parsed ($/commas stripped). Vendor value — screen only, never ARV; the `avm.note` says so, same convention as data-api. |
| `as_is_value` `"$79,318"` | `vendorAsIs` `79318` | Vendor value, labeled. |
| `interval_10_90` `[low, high]` strings | `vendorInterval`, `avm.low/high` | Parsed numbers. |
| `confidence` / `confidence_score` | `confidence` / `confidenceScore` | Vendor confidence. Our engine's own label stays at `comps.confidence` / `comps.confidenceText`. |
| `subject.address/beds/baths/sqft/year_built/property_type` | `property.address/beds/baths/sqft/yearBuilt/propertyType` | `property` carries the full sibling key set; owner/mortgage/tax/lat-lng are `null` (Resideline returns none) and fill from the PR subject merge when available. |
| `search_criteria_used` | `search_criteria_used`, `comps.searchCriteria` | Echoed verbatim; `comps.criteria` is the string `'resideline'`. |
| `credits_charged` / `credits_remaining` | same names, top level | 2 charged per successful call. |
| comp `price` (number) | comp `amount` | Rounded in `compOut`. |
| comp `sold_date` `"MM/DD/YYYY"` | comp `date` ISO `"YYYY-MM-DD"` | Converted; unparseable → `null` (+ "no sale date" deviation). |
| comp `price_per_sqft` | comp `ppsf` | Falls back to amount/sqft when absent. |
| comp `distance` | comp `distance` | Real miles (unlike data-api's null); feeds distance scoring + the >2 mi hard rule. Missing → 99 (unknown) like attom-lookup. |
| comp `beds/baths/sqft` | comp `beds/baths/sqft` | As-is. |
| comp `similarity_score` | comp `similarityScore` | Extra field, kept for display/debug; the engine scores independently. |
| comp (none) | comp `latitude/longitude` | `null` — the page's existing browser-side geocode pass fills map pins. |

Request mapping (dashboard input → upstream body): `address` (required,
full street address ending in 5-digit ZIP); `beds`→`beds`,
`baths`→`baths`, `sqft`→`sqft_size`, `yearBuilt`→`subject_year_built`,
`propertyType`→`property_type`, parsed `city`/`zipcode` from the address;
bounds → `max_radius_miles`, `max_comp_age_days`, `sqft_band_abs`,
`year_built_diff_cap`.

## Tests

- **New:** `resideline-comps-regression.js` — **82 passed, 0 failed.**
  Fetch fully stubbed, fake key only. Covers: not_configured with zero
  upstream calls; exact upstream URL + `enrich_if_missing=true` +
  `API-Key` header; body field/bounds mapping incl. overrides; GET
  convention; money-string parsing; comp mapping incl. date conversion;
  engine indication = comp mean (61000 on the fixture), explicitly **not**
  the vendor ARV (120938); <3 comps → `insufficient_comps` at 2 and 0
  comps, usable at exactly 3; 402/403/404/422/500/400 mapping with
  key-leak and raw-body checks on every error; index.html wiring order
  and the 3-comp acceptance gate.
- **Existing suites re-run after the change:** the full `*-regression.js`
  set (28 suites) — **every suite exits 0, zero failures**, including the
  six baselined before the change at identical counts (data-api-mls 13,
  command-center-fallback ALL PASS, parse-address ALL PASS, offer-flow 33,
  listing-insights 136, grok-assist 36). No pre-existing failures were
  found in the baseline, and none were introduced.

## Deploy file list (for the later single batched deploy)

1. `netlify/functions/resideline-comps.js` (new)
2. `index.html` (modified — `loadCompsForAddress` chain only)
3. `resideline-comps-regression.js` (new, repo-root test)
4. `RESIDELINE-WIRING.md` (this note)

Plus the manual step that is Troy's alone: add `RESIDELINE_API_KEY` to the
Netlify site's environment variables (Functions scope) and redeploy. Until
the key exists, the function answers `not_configured` and the Comps page
silently keeps using the data provider / ATTOM fallbacks — no breakage.

After the key lands, first live checks: 3051 Eastern Ave (expect ~11 comps,
engine indication in the $120s — NOT the old $188,173 screen ARV), then one
known address per remaining market (Greenville NC, Kansas City, Cleveland,
Jacksonville) against county records.

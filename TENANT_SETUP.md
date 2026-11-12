# TENANT SETUP — onboarding a new Command Center tenant

How to stand up this dashboard for a new buyer of the system (the
$497 HighLevel plan resale). Everything tenant-specific lives in ONE
file per tenant: `clients/<subdomain>.json`. Code never changes per
tenant. Secrets are NEVER in that file — they live in Netlify env
vars, referenced by name only.

## 1. Create the tenant config

1. Copy `clients/_template.json` to `clients/<subdomain>.json`
   (the subdomain they will use, e.g. `clients/acme.json` for
   acme.leadmachineapp.com).
2. Fill in:
   - `companyName`, `bot.businessName` — their customer-facing
     business name.
   - `logo` — path to their logo asset (add the file under
     `assets/`), `primaryColor` — their brand color.
   - `highLevel.locationId` — THEIR HighLevel location (sub-account)
     id.
   - `highLevel.calendarId` — their "Seller Calls" calendar id in
     that location.
   - `highLevel.webhookUrl` — the webhook-trigger URL of the
     workflow in THEIR location that receives pushed leads
     (dashboard "Push to CRM"). Create that workflow in their
     HighLevel first, then paste its trigger URL here.
   - `highLevel.apiTokenEnvVar` — the NAME of the Netlify env var
     that will hold their HighLevel Private Integration token
     (e.g. `ACME_HL_TOKEN`). Not the token itself.
   - `propertyReach.apiKeyEnvVar` — the NAME of the env var holding
     their data-provider API key.
   - `operator` — the person who runs the business day to day:
     name / firstName / lastName / email / phone / phoneDigits.
     This person receives a copy of every e-sign send, the deal-room
     view/offer text alerts, and is the only permitted test
     recipient for title orders. NOTE: `operator.email` must match
     the Gmail account connected for title orders (step 3) — title
     orders are sent From that address.
   - `buyerSignerName` — the person whose HighLevel user seat signs
     contracts as the buyer (their name must match the signer seat
     placed in their contract templates).
   - `bot.fromNumbers` / `bot.markets` — their market sending
     numbers and market list.
   - `buyers` — their buyer-list id / source.
3. Deploy. No env vars are strictly required for the config file
   itself; the single-tenant helper functions (e-sign, mail,
   deal-room alerts) read the default tenant from `clients/` via
   `netlify/functions/lib-client.js`. If a deployment serves ONE
   tenant only, `HL_LOCATION_ID` / `HL_CALENDAR_ID` env vars may
   override the fallback location/calendar — leave them unset for
   the standard multi-tenant setup.

## 2. Their own HighLevel location

The tenant needs their OWN HighLevel sub-account (location) with:

- A Private Integration (or the integration the deployment uses)
  with contacts / conversations / calendars / documents scopes;
  its token goes in Netlify env under the name chosen in step 1 —
  never in the client JSON, never in chat or email.
- The "Seller Calls" calendar (id goes in the config).
- The contract document templates, WITH Signature fields placed
  for every signer (HighLevel's API cannot see or place them).
- For Ohio: the SB 155 wholesaler disclosure template — the
  dashboard blocks an Ohio purchase-contract send until the
  disclosure shows signed for that seller.
- The lead-intake workflow whose webhook trigger URL goes in
  `highLevel.webhookUrl`.
- An e-sign sender user: set `ESIGN_SENDER_USER_ID` (Netlify env)
  to the user id of the person contracts are sent FROM (the buyer
  signer seat).

## 3. Their own service accounts (each tenant brings their own)

- **Gmail (title orders):** their own Google account + OAuth app;
  set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
  `GMAIL_REFRESH_TOKEN` in Netlify env. Publish the OAuth app to
  production so the refresh token does not expire.
- **PostGrid (postcards):** their own PostGrid account; set
  `POSTGRID_TEST_API_KEY` / `POSTGRID_API_KEY` in Netlify env and
  keep `MAIL_MODE=test` until they fund it and say go. Their mail
  return address can be set with the `MAIL_FROM_*` env vars.
- **Property data:** their own PropertyReach (or provider) account;
  key in Netlify env under the name from step 1.
- **Maps / other keys:** any remaining keys are Netlify env vars
  named in the function code — search the repo for `process.env.`
  before launch and set each one for the tenant's own accounts.

## 4. What is still Troy-instance content (known, deliberate)

These were inventoried in the multi-tenant pass (COMMIT7.txt) and
left as Troy's own instance data — a tenant fork replaces them in
its own copy; they never leak to another tenant's subdomain at
runtime because the pages/functions that carry them serve Troy's
deployment:

- `netlify/functions/mail-templates-data.js` — postcard brand block
  (business name, phone, site, logo URL, default return address).
  It is a pure-data module (the mail regression requires it with no
  I/O); a tenant edits this block (or uses `MAIL_FROM_*` env
  overrides for the return address).
- Static page branding in `room.html`, `live-call.html`,
  `training.html`, `closing-tracker.html` — titles/footers naming
  Troy's business (and the Live Call objection script content);
  these pages do not consume the client-config endpoint yet.
- `index.html` / `command-center.html` ship Troy's branding as the
  config-fetch FAILURE fail-safe (the runtime branding always comes
  from the tenant's config file; an unknown subdomain gets the
  neutral `_default` config, never Troy's).

## 5. Verify before handover

- Open the tenant subdomain: their name/logo/color everywhere, no
  Troy branding; "Back to CRM" opens THEIR location.
- Paste/import one test lead and Push to CRM — it must land in
  THEIR workflow via THEIR webhook.
- Prepare (do not send) one e-sign contract: signers show their
  buyer signer + operator copy recipient.
- Send one title order to the operator's own email (the only test
  recipient allowed) and confirm it arrives From their Gmail.

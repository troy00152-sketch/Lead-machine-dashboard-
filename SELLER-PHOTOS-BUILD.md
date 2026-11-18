# Seller Photo Walkthrough — Build Notes (Nov 18, 2026)

**Status: built and regression-tested locally. NOT deployed, NOT committed.**
Troy approved the build on a live call Nov 18, 2026. Design refinements
(expectation-setting welcome, framing aids, quality self-check, review
grid, progress polish) came from research Troy asked for — SellerSubmit
(the $29/mo wholesaler product doing this exact job), RentCheck's
resident-led inspections, and inspection-app UX guides.

## What it is

A link Troy texts a seller. The seller opens it on their phone (no
install, no login), gets walked step-by-step through photographing their
house, and the photos land in the Command Center tied to that property.
It exists so an engaged seller (e.g. Elenora Hayes) can replace a ~$100
paid walkthrough runner with their own phone camera.

## Files

**Created:**
- `photos.html` — public seller page (mobile-first, dependency-free,
  mirrors `cash-offer.html` branding). Opened as `photos.html?k=TOKEN`.
- `netlify/functions/photo-upload.js` — seller POST endpoint
  (token-authenticated) + admin GET endpoints (lm_auth cookie).
- `netlify/functions/photo-link.js` — admin-only: mint a link, list
  recent sessions for the gallery.
- `photos-admin.html` — dashboard gallery: create-a-link form, session
  list, per-session thumbnail grid.
- `seller-photos-regression.js` — offline regression (fake Blobs store
  injected via the functions' `_test.setStore` hooks, the
  cc-funnel-api.js pattern). **78 passed, 0 failed** at build time.
  Run: `node seller-photos-regression.js`.
- `SELLER-PHOTOS-BUILD.md` — this file.

**Modified (existing file — the one strictly-required hook):**
- `netlify/edge-functions/gate.ts` — added a public pass-through for
  `/photos`, `/photos.html`, and `/.netlify/functions/photo-upload`
  (with `x-robots-tag: noindex, nofollow`), mirroring the
  room.html / cc-funnel-api blocks. Without it the gate would put the
  login page in front of sellers. `photo-link` and `photos-admin.html`
  deliberately stay behind the gate; photo-upload's admin GET actions
  still require the lm_auth cookie inside the function itself.

No env vars added. No paid services. Storage is the Netlify Blobs store
`seller-photos`, same mechanism as buyer-verify / cc-funnel-api.

## How the flow works

1. **Mint** — Troy (or Bread) opens `photos-admin.html`, enters address
   + seller name (+ optional phone / CRM contact ID), and gets back
   `https://leadmachineapp.com/photos.html?k=TOKEN` (token = 32-char
   crypto-random base64url). `photo-link.js` writes the manifest stub
   to `seller-photos` at `{token}/manifest.json`.
2. **Seller walkthrough** — the page calls `getSession` (resume: the
   manifest says which steps already have photos, so a reopened link
   picks up where they left off — the welcome screen says so plainly,
   plus "This takes about 10 minutes"). 15 guided steps, one screen per
   shot, each with a simple SVG framing hint and a plain instruction:
   front, back/yard, living room, kitchen (multi), bedroom 1–3 (3rd
   skippable), bathroom ×2 (2nd skippable), roof, water heater,
   furnace/HVAC, electrical panel, damage (multi), anything else
   (multi, skippable).
3. **Per shot** — Take Photo (camera) or Choose from Library → the
   browser compresses it (canvas, max 1600px long edge, JPEG ~0.8) →
   preview asks the quality self-check ("Can you see the whole room
   clearly?") with big Retake / Looks Good buttons → Looks Good uploads
   immediately (nothing waits for a final submit, so a dropped
   connection loses nothing) with a `capturedAt` timestamp → "Got it —
   that one's in ✓" and the next step. A slim collapsible "Your
   progress" strip tracks checkmarks across all 15 steps.
4. **Server validation** — `photo-upload.js` never trusts the client:
   token shape + manifest existence, step id whitelist, image type
   sniffed from magic bytes (JPEG/PNG/WebP only), decoded size ≤ ~8MB.
   Bytes land at `{token}/{stepId}-{index}`; single-photo steps replace
   in place, multi steps append. Manifest entries record key, stepId,
   contentType, size, upload time (`at`), and `capturedAt`.
5. **Review + finish** — after the last step, the seller sees every
   photo in a grid grouped/labeled by step (this session's shots as
   thumbnails; earlier-session shots as ✓ tiles), can tap any tile to
   jump back and retake/add, adds optional notes, and hits Finish —
   which stamps the manifest `complete` with `completedAt` + notes.
   Thank-you screen states next steps plainly and shows the Google
   Voice number (860) 452-6497 — the only phone allowed seller-facing.
   A bad/expired token gets a clean "This link isn't active — text us
   and we'll resend it" screen.
6. **Gallery** — `photos-admin.html` lists sessions (address, seller,
   created, photo count, Link sent / In progress / Complete) from
   `photo-link` GET; clicking one loads the manifest via
   `photo-upload?action=listPhotos` and renders thumbnails streamed by
   `photo-upload?action=getPhoto` (admin cookie required — the seller's
   token can never read photos back).

## How Troy uses it

1. Open **Seller Photos** (`photos-admin.html`) in the Command Center.
2. Create a link for the property + seller.
3. Text the link to the seller (from the normal CRM thread, so the
   conversation stays in one place).
4. Watch `photos-admin.html` — photos appear as the seller sends them;
   "Complete" means they hit Finish.

## The deploy commit must include (one commit, per Troy's batching rule)

- `photos.html`
- `photos-admin.html`
- `netlify/functions/photo-upload.js`
- `netlify/functions/photo-link.js`
- `netlify/edge-functions/gate.ts` (modified)
- `seller-photos-regression.js`
- `SELLER-PHOTOS-BUILD.md`

After deploy, live-test on leadmachineapp.com before calling it done:
create a link in the gallery, open it on a phone, send 2–3 photos,
confirm they appear in the gallery, and confirm an unknown token shows
the "link isn't active" screen.

Optional follow-up (not required to ship): add a "📸 Seller Photos"
link to the dashboard sidebar/index so the gallery is one click away.

## Phase 2 — noted, NOT built

- **One walkthrough video upload.** Sellers filming a walkthrough video
  is the natural next step (SellerSubmit leads with it), but video is
  far too big for the current path (base64 JSON body, ~8MB cap, Lambda
  payload limits). Needs a chunked or direct-to-storage upload design
  (e.g. signed upload URLs / resumable chunks) before it can be built
  honestly.
- **Download-all-as-ZIP from the gallery.** One click in
  `photos-admin.html` to pull a session's full photo set as a single
  zip — for Troy's files and for sending a set onward without saving
  photos one at a time.
- **Share link for buyers / contractors.** A read-only, token-scoped
  public gallery link for one property's photo set, so Troy can send
  buyers or contractors the photos without giving them dashboard
  access. Needs its own revocable share token (never the seller's
  upload token, which can write).

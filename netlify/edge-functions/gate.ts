// Password gate for the Acquisition Command Center.
// Runs on every request (/*). Real server-side check — the password lives
// only in the DASHBOARD_PASSWORD env var, never in client code.
// Sets X-Robots-Tag: noindex so the dashboard never lands in search results.

export const config = { path: "/*" };

const COOKIE_NAME = "lm_auth";
// Irish's calling-only login (Nov 16, 2026, Troy): a separate cookie
// minted when the login attempt matches IRISH_ACCESS_CODE. It opens
// ONLY the dialer surface (page + its two functions); everything else
// answers 403. The full multi-user/roles layer is later — this is a
// two-tier split: full / irish-calling-only.
const IRISH_COOKIE_NAME = "lm_irish";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const te = new TextEncoder();

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare to avoid timing leaks.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

async function isAuthed(req: Request, secret: string): Promise<boolean> {
  const cookie = getCookie(req, COOKIE_NAME);
  if (!cookie) return false;
  const [expiry, sig] = cookie.split(".");
  if (!expiry || !sig) return false;
  const exp = parseInt(expiry, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = await hmacHex(expiry, secret);
  return safeEqual(sig, expected);
}

// Irish tier: cookie is "<expiry>.irish.<sig>" with
// sig = HMAC("<expiry>.irish") — the same construction the functions
// verify in cc-auth.js.
async function isIrishAuthed(req: Request, secret: string): Promise<boolean> {
  const cookie = getCookie(req, IRISH_COOKIE_NAME);
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[1] !== "irish") return false;
  const [expiry, , sig] = parts;
  if (!expiry || !sig) return false;
  const exp = parseInt(expiry, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = await hmacHex(expiry + ".irish", secret);
  return safeEqual(sig, expected);
}

// What Irish's session may reach: the dialer page, its static assets,
// and the two calling functions. Everything else is 403.
function irishAllowed(pathname: string): boolean {
  return (
    pathname === "/dialer.html" ||
    pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/assets/") ||
    pathname === "/.netlify/functions/cc-dialer-api" ||
    pathname === "/.netlify/functions/cc-voice-token"
  );
}

function irishDeniedPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Calling access only</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px 32px;max-width:380px;text-align:center}a{color:#ff6b1a}</style></head><body>
<div class="card"><h2 style="margin-bottom:10px">Calling access only</h2><p style="color:#8b949e;font-size:14px">This login can only open the dialer.</p><p style="margin-top:16px"><a href="/dialer.html">Go to the dialer →</a></p></div></body></html>`;
  return new Response(html, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    },
  });
}

function loginPage(error: boolean): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Acquisition Command Center — Sign in</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px 32px;width:100%;max-width:380px;text-align:center}
.logo{font-size:15px;font-weight:700;margin-bottom:6px}.logo span{color:#ff6b1a}
.sub{color:#8b949e;font-size:13px;margin-bottom:24px}
input{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:12px 14px;font-size:15px;outline:none;margin-bottom:12px}
input:focus{border-color:#ff6b1a}
button{width:100%;background:#ff6b1a;border:0;border-radius:8px;color:#fff;font-weight:600;font-size:15px;padding:12px;cursor:pointer}
button:hover{background:#e55f16}
.err{color:#f85149;font-size:13px;margin-bottom:12px;min-height:18px}
</style></head><body>
<div class="card">
<div class="logo">Acquisition <span>Command Center</span></div>
<div class="sub">Direct Property Buyers · Private</div>
<div class="err">${error ? "Wrong password — try again." : ""}</div>
<form method="POST" action="/__login" id="loginForm">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus>
<button type="submit">Sign in</button>
</form>
<div id="frameNote" style="display:none;margin-top:16px;font-size:13px;color:#8b949e">Opening inside another site? <a href="https://leadmachineapp.com" target="_top" style="color:#ff6b1a">Open the dashboard directly</a> and sign in there.</div>
<script>
if (window.self !== window.top) {
  document.getElementById('frameNote').style.display = 'block';
  document.getElementById('loginForm').setAttribute('target', '_top');
}
</script></div></body></html>`;
  return new Response(html, {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    },
  });
}

export default async function handler(req: Request, context: any) {
  const getEnv = (k: string): string => {
    try {
      const v = (Deno as any).env.get(k);
      if (v) return v;
    } catch { /* Deno.env not available */ }
    return "";
  };
  const password = getEnv("DASHBOARD_PASSWORD");
  const secret = getEnv("GATE_SECRET") || password; // No fallback: with no env vars set the gate fails closed (503) below — never a publicly-known secret.

  const url = new URL(req.url);

  // Login submission.
  if (url.pathname === "/__login" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const attempt = (form?.get("password") || "").toString();
    if (password && attempt && safeEqual(attempt, password)) {
      const expiry = String(Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE);
      const sig = await hmacHex(expiry, secret);
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `${COOKIE_NAME}=${expiry}.${sig}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=None`,
          "x-robots-tag": "noindex, nofollow",
          "cache-control": "no-store",
        },
      });
    }
    // Irish's calling-only code: mints the restricted cookie and lands
    // her on the dialer. Fail closed when IRISH_ACCESS_CODE is unset.
    const irishCode = getEnv("IRISH_ACCESS_CODE");
    if (irishCode && attempt && safeEqual(attempt, irishCode)) {
      const expiry = String(Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE);
      const sig = await hmacHex(expiry + ".irish", secret);
      return new Response(null, {
        status: 303,
        headers: {
          location: "/dialer.html",
          "set-cookie": `${IRISH_COOKIE_NAME}=${expiry}.irish.${sig}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=None`,
          "x-robots-tag": "noindex, nofollow",
          "cache-control": "no-store",
        },
      });
    }
    return loginPage(true);
  }

  // Public buyer deal rooms — no dashboard login needed.
  // The deals-api function enforces its own per-action auth: admin actions
  // verify the lm_auth cookie in-function; room / offer / photo actions are
  // open by design (unguessable 64-char room tokens, mao never exposed).
  if (url.pathname === "/room.html" || url.pathname === "/.netlify/functions/deals-api") {
    const res = await context.next();
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  }

  // Irish's Live Coach — suggestion service only (added Nov 12, Troy's call:
  // her coach page is unlisted + no-login by design and is hosted off-site,
  // so it can never carry the dashboard cookie). coach-suggest is stateless
  // text-in/text-out: no CRM access, no stored data, nothing behind it but
  // AI reply suggestions. Everything else on this site stays gated.
  if (url.pathname === "/.netlify/functions/coach-suggest") {
    const res = await context.next();
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  }

  // Public seller-facing website pages + the cash-offer funnel endpoint
  // (added Nov 16, 2026 — standalone mirror of the HL site on
  // directpropertybuyersllc.com). These are PUBLIC by design: the funnel
  // is the A2P opt-in proof page and must be reachable with no login.
  // The pages pass through untouched (no noindex — they are the public
  // website); the function only ever accepts a form POST and stores a
  // lead + consent record (cc-funnel-api.js) — it reads nothing back.
  if (
    url.pathname === "/cash-offer" ||
    url.pathname === "/cash-offer.html" ||
    url.pathname === "/privacy-policy" ||
    url.pathname === "/privacy-policy.html" ||
    url.pathname === "/terms-of-service" ||
    url.pathname === "/terms-of-service.html"
  ) {
    return context.next();
  }
  if (url.pathname === "/.netlify/functions/cc-funnel-api") {
    const res = await context.next();
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  }

  // Seller photo walkthrough (added Nov 18, 2026): photos.html is a
  // per-seller private link (photos.html?k=TOKEN) Troy texts out — the
  // unguessable token IS the credential, checked server-side by
  // photo-upload.js on every call. The page and its POST endpoint pass
  // through with noindex (private links, not the public website);
  // photo-upload's admin GET actions still require the lm_auth cookie
  // inside the function, and photo-link + photos-admin.html stay
  // behind this gate like every other dashboard surface.
  if (
    url.pathname === "/photos" ||
    url.pathname === "/photos.html" ||
    url.pathname === "/.netlify/functions/photo-upload"
  ) {
    const res = await context.next();
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  }

  // Not configured yet — fail closed with a clear message, not an open door.
  if (!password) {
    return new Response(
      "<h1 style='font-family:sans-serif'>Dashboard lock not configured — set DASHBOARD_PASSWORD.</h1>",
      { status: 503, headers: { "content-type": "text/html", "x-robots-tag": "noindex, nofollow" } }
    );
  }

  if (await isAuthed(req, secret)) {
    const res = await context.next();
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  }

  // Irish's calling-only session: the dialer surface only, and only
  // while IRISH_ACCESS_CODE stays configured (unsetting it retires
  // her access even before her cookie expires).
  if (getEnv("IRISH_ACCESS_CODE") && (await isIrishAuthed(req, secret))) {
    if (irishAllowed(url.pathname)) {
      const res = await context.next();
      res.headers.set("x-robots-tag", "noindex, nofollow");
      return res;
    }
    return irishDeniedPage();
  }

  return loginPage(false);
}

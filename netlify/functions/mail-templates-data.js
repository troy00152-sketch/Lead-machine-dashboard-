// netlify/functions/mail-templates-data.js
// SHARED postcard template data for the Command Center direct-mail build
// (mail-send.js, mail-templates.js, and the mail regression suite).
//
// POSTCARDS ONLY (Troy, Nov 11, 2026). No letters.
// Prices verified Nov 11, 2026 (PostGrid Starter, $0/mo):
//   4x6 First Class $0.902 · 6x9 First Class $1.023 (PostGrid pricing page).
// USPS/PostGrid prices move — the confirm sheet shows these as the EXPECTED
// price and the send log records the table price; re-check at live time.
// PostGrid's create-postcard response carries no price field, so cap
// accounting uses this table (see mail-send.js).
//
// PostGrid HTML postcard specs (guides.postgrid.com): the HTML is the full
// bleed page. 4x6 -> 6.25in x 4.25in · 6x9 -> 9.25in x 6.25in (0.125in
// bleed each side); PostGrid renders the HTML to the chosen card size.
// The BACK must leave the right ~40% clear: PostGrid prints the recipient
// address + postage there. renderTemplate(size, vars, {preview}) adds a
// dashed "address goes here" placeholder ONLY in preview mode — the HTML
// sent to PostGrid never contains it.
//
// Merge variables (server-side substitution before sending to PostGrid):
//   {{ownerName}} {{propertyAddress}} {{cityStateZip}} {{phone}} {{brand}}
// Custom templates are NOT merged by default: a PostGrid template id
// (template_...) gets the merge variables passed through PostGrid's
// mergeVariables field; a remote URL / raw HTML custom is static art,
// sent as-is (an image URL is wrapped in full-bleed HTML at send time;
// a PDF URL is sent as the order's single 2-page PDF).
//
// No API keys, no secrets, no live calls in this module. Pure data + pure
// functions, so the regression suite can require it with no I/O.
'use strict';

const BRAND = 'Direct Property Buyers';
const PHONE = '(203) 565-7810';
const PHONE_TEL = '+12035657810';
const SITE = 'directpropertybuyersllc.com';
const LOGO_URL =
  'https://raw.githubusercontent.com/troy00152-sketch/Lead-machine-dashboard-/main/assets/dpb-logo.png';

// Default return address (Troy's mailing address, already on file).
// Overridable with MAIL_FROM_* env vars in mail-send.js.
const DEFAULT_FROM = {
  companyName: 'Direct Property Buyers',
  addressLine1: '208 Burgundy Hill Ln',
  addressLine2: '',
  city: 'Middletown',
  provinceOrState: 'CT',
  postalOrZip: '06705',
  countryCode: 'US',
};

const PRICES_CENTS = { '4x6': 90.2, '6x9': 102.3 }; // in cents; 4x6 = $0.902
const SIZES = ['4x6', '6x9'];
const MONTHLY_CAP_CENTS = 10000; // $100/month hard cap (Troy, Nov 11 2026)

function priceCentsFor(size) {
  return PRICES_CENTS[size] || null;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Substitute {{var}} merge variables. Unknown variables render empty.
// Values are HTML-escaped so owner/property text can never break the card.
function applyMergeVars(html, vars) {
  const v = vars || {};
  return String(html).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) =>
    escHtml(v[key] == null ? '' : v[key]),
  );
}

function dims(size) {
  // Full-bleed page size + a slightly larger headline for the big card.
  if (size === '6x9') return { w: '9.25in', h: '6.25in', pad: '0.45in', h1: '64px', sub: '26px', body: '20px', phone: '34px' };
  return { w: '6.25in', h: '4.25in', pad: '0.3in', h1: '44px', sub: '18px', body: '14px', phone: '24px' };
}

function frontShell(size, inner, bg) {
  const d = dims(size);
  return (
    `<html><head><meta charset="utf-8"><style>` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `body{width:${d.w};height:${d.h};background:${bg};font-family:Arial,Helvetica,sans-serif;color:#fff}` +
    `.wrap{width:100%;height:100%;padding:${d.pad};display:flex;flex-direction:column;justify-content:center}` +
    `h1{font-size:${d.h1};line-height:1.05;font-weight:900;letter-spacing:-0.5px}` +
    `.sub{font-size:${d.sub};line-height:1.3;margin-top:12px;font-weight:700}` +
    `.phone{font-size:${d.phone};font-weight:900;margin-top:16px;color:#ffc845}` +
    `.brand{font-size:${d.body};margin-top:14px;opacity:.9}` +
    `</style></head><body><div class="wrap">${inner}</div></body></html>`
  );
}

function backShell(size, inner, preview) {
  const d = dims(size);
  const addrNote = preview
    ? `<div style="position:absolute;top:${d.pad};right:${d.pad};width:38%;height:62%;border:2px dashed #9aa5b1;border-radius:8px;color:#9aa5b1;display:flex;align-items:center;justify-content:center;text-align:center;font-size:${d.body};padding:10px">Recipient address<br>printed here</div>`
    : '';
  return (
    `<html><head><meta charset="utf-8"><style>` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `body{width:${d.w};height:${d.h};background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#1a2a44;position:relative}` +
    `.msg{position:absolute;top:${d.pad};left:${d.pad};width:54%}` +
    `.msg h2{font-size:${d.sub};line-height:1.2;font-weight:900}` +
    `.msg p{font-size:${d.body};line-height:1.45;margin-top:10px}` +
    `.msg .phone{font-size:${d.phone};font-weight:900;color:#0f4c81;margin-top:12px}` +
    `.foot{position:absolute;left:${d.pad};bottom:${d.pad};font-size:12px;color:#6b7a8d}` +
    `</style></head><body>${addrNote}<div class="msg">${inner}</div>` +
    `<div class="foot">${BRAND} &bull; ${PHONE} &bull; ${SITE}<br>` +
    `If you'd rather not hear from us, call and we'll remove you right away.</div>` +
    `</body></html>`
  );
}

const BUILTIN_TEMPLATES = [
  {
    id: 'cash-offer',
    name: 'We Buy Houses for Cash',
    blurb: 'Bold navy + gold. Best all-round seller card.',
    sizes: ['4x6', '6x9'],
    render(size, vars, preview) {
      const front = frontShell(
        size,
        `<h1>WE BUY HOUSES<br>FOR CASH</h1>` +
          `<div class="sub">Any condition. No repairs. No fees.<br>Close in as little as 7 days.</div>` +
          `<div class="phone">${PHONE}</div>` +
          `<div class="brand">${BRAND} &bull; ${SITE}</div>`,
        '#0f2a4a',
      );
      const back = backShell(
        size,
        `<h2>Hi {{ownerName}},</h2>` +
          `<p>We buy houses just like yours at {{propertyAddress}}, {{cityStateZip}} — as-is, no repairs, no showings, no waiting on a bank.</p>` +
          `<p>If you're thinking about selling, a quick call is all it takes for a fair cash offer. No pressure, no obligation.</p>` +
          `<div class="phone">${PHONE}</div>`,
        preview,
      );
      return { front, back };
    },
  },
  {
    id: 'sell-fast',
    name: 'Need to Sell Fast?',
    blurb: 'High-contrast, urgent. For distress / tight timelines.',
    sizes: ['4x6', '6x9'],
    render(size, vars, preview) {
      const front = frontShell(
        size,
        `<h1>NEED TO<br>SELL FAST?</h1>` +
          `<div class="sub">We buy as-is — no showings, no cleanup,<br>no waiting on banks.</div>` +
          `<div class="phone">${PHONE}</div>` +
          `<div class="brand">${BRAND} &bull; ${SITE}</div>`,
        '#7a1010',
      );
      const back = backShell(
        size,
        `<h2>Hi {{ownerName}},</h2>` +
          `<p>Behind on payments, facing foreclosure, or just done being a landlord? We buy houses at {{propertyAddress}}, {{cityStateZip}} for cash — fast and private.</p>` +
          `<p>Call today and we can make you an offer in 24 hours.</p>` +
          `<div class="phone">${PHONE}</div>`,
        preview,
      );
      return { front, back };
    },
  },
  {
    id: 'inherited-home',
    name: 'Inherited a Home?',
    blurb: 'Softer tone for probate / inherited homes. Mail-first list.',
    sizes: ['4x6', '6x9'],
    render(size, vars, preview) {
      const front = frontShell(
        size,
        `<h1>INHERITED<br>A HOME?</h1>` +
          `<div class="sub">We can help — a fair cash offer,<br>on your timeline, with no pressure.</div>` +
          `<div class="phone">${PHONE}</div>` +
          `<div class="brand">${BRAND} &bull; ${SITE}</div>`,
        '#2e5d4b',
      );
      const back = backShell(
        size,
        `<h2>Hi {{ownerName}},</h2>` +
          `<p>Settling an estate is hard enough without a house to deal with. We buy inherited homes at {{propertyAddress}}, {{cityStateZip}} as-is — no clean-out, no repairs, no showings.</p>` +
          `<p>When you're ready, one call is all it takes. No pressure, no obligation.</p>` +
          `<div class="phone">${PHONE}</div>`,
        preview,
      );
      return { front, back };
    },
  },
];

function getBuiltin(id) {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) || null;
}

function listBuiltins() {
  return BUILTIN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    blurb: t.blurb,
    sizes: t.sizes.slice(),
    builtin: true,
  }));
}

// Render a built-in template to final front/back HTML (merge vars applied).
// Returns { front, back } or null when the template/size is unknown.
function renderBuiltin(id, size, vars, preview) {
  const t = getBuiltin(id);
  if (!t || !t.sizes.includes(size)) return null;
  const out = t.render(size, vars || {}, !!preview);
  return {
    front: applyMergeVars(out.front, vars || {}),
    back: applyMergeVars(out.back, vars || {}),
  };
}

// Validate a custom design's front/back source. Accepted forms:
//   - PostGrid template id:  template_ + alphanumerics
//   - Remote artwork URL: https://... ending .pdf (one 2-page PDF) or
//     .png / .jpg / .jpeg (wrapped in full-bleed HTML at send time)
//   - Raw HTML: a string starting with '<' (an HTML document or fragment)
// Anything else is rejected - a bare word is neither a template nor a file.
function validateCustomSource(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return { ok: false, error: 'Empty design source.' };
  if (/^template_[A-Za-z0-9]+$/.test(s)) return { ok: true, kind: 'postgrid-template' };
  if (/^https:\/\//.test(s) && /\.pdf(\?.*)?$/i.test(s))
    return { ok: true, kind: 'pdf-url' };
  if (/^https:\/\//.test(s) && /\.(png|jpg|jpeg)(\?.*)?$/i.test(s))
    return { ok: true, kind: 'image-url' };
  if (s.startsWith('<')) return { ok: true, kind: 'html' };
  return {
    ok: false,
    error:
      'Design must be a PostGrid template id (template_...), an https link to a 2-page PDF or a PNG/JPG image, or raw HTML starting with "<".',
  };
}

// 'YYYY-MM' month key for cap accounting (UTC, so a month boundary is the
// same for the dashboard, the function, and the PostGrid bill).
function monthKey(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function defaultMergeVars() {
  return {
    ownerName: 'Homeowner',
    propertyAddress: '123 Main St',
    cityStateZip: 'Indianapolis, IN 46201',
    phone: PHONE,
    brand: BRAND,
  };
}

module.exports = {
  BRAND,
  PHONE,
  PHONE_TEL,
  SITE,
  LOGO_URL,
  DEFAULT_FROM,
  PRICES_CENTS,
  SIZES,
  MONTHLY_CAP_CENTS,
  BUILTIN_TEMPLATES,
  priceCentsFor,
  escHtml,
  applyMergeVars,
  getBuiltin,
  listBuiltins,
  renderBuiltin,
  validateCustomSource,
  monthKey,
  defaultMergeVars,
};

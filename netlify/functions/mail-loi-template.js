// netlify/functions/mail-loi-template.js
// LOI (letter of intent) template for the DealBreeze-takeaways mail channel
// (mail-loi.js). Pure data + pure functions — no keys, no I/O — so the
// regression suite can require it directly.
//
// The number on the letter is the lead's OPENING offer: the LAO written by
// the auto-pricing engine (LAO = MAO x 0.70). MAO is the walk-to ceiling
// and is never printed. The letter copy mirrors the sample letters produced
// by playbook-system/dealbreeze-takeaways/loi/loi_generate.py — keep the
// two in sync when the copy changes.
//
// Merge variables (server-side substitution in mail-loi.js):
//   {{ownerName}} {{mailingAddress}} {{mailingCityStateZip}}
//   {{propertyAddress}} {{offerAmount}} {{letterDate}}
//   {{closingDays}} {{reviewDays}} {{phone}}
//   {{fromName}} {{fromAddressLine1}} {{fromCityStateZip}}
'use strict';

const BRAND = 'Direct Property Buyers';
const PHONE = '(860) 452-6497';

const DEFAULT_FROM = {
  companyName: BRAND,
  addressLine1: '208 Burgundy Hill Ln',
  addressLine2: '',
  city: 'Middletown',
  provinceOrState: 'CT',
  postalOrZip: '06705',
  countryCode: 'US',
};

const LOI_DEFAULTS = { closingDays: '14', reviewDays: '10' };

const LOI_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Letter of Intent — {{propertyAddress}}</title>
<style>
  @page { size: letter; margin: 0.85in 0.9in; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a2332; font-size: 12.5pt; line-height: 1.55; margin: 0; }
  .letterhead { border-bottom: 3px solid #0f2a4a; padding-bottom: 10px; margin-bottom: 22px; }
  .brand { font-family: Helvetica, Arial, sans-serif; font-size: 19pt; font-weight: 800; color: #0f2a4a; }
  .brand small { display: block; font-size: 9.5pt; font-weight: 600; color: #b8892e; letter-spacing: 2.2px; text-transform: uppercase; }
  .lh-contact { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; color: #44506a; margin-top: 6px; }
  h1 { font-family: Helvetica, Arial, sans-serif; font-size: 13pt; text-transform: uppercase; letter-spacing: 1.6px; color: #0f2a4a; margin: 6px 0 14px; }
  .offer-box { border: 2px solid #0f2a4a; border-radius: 8px; padding: 16px 20px; margin: 20px 0; background: #f4f7fb; }
  .offer-box .lbl { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; letter-spacing: 1.8px; text-transform: uppercase; color: #44506a; }
  .offer-box .amt { font-family: Helvetica, Arial, sans-serif; font-size: 26pt; font-weight: 800; color: #0f2a4a; margin: 2px 0; }
  table.terms { border-collapse: collapse; width: 100%; margin: 14px 0 6px; }
  table.terms td { padding: 6px 10px; border-bottom: 1px solid #d8dee9; vertical-align: top; }
  table.terms td.k { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; font-weight: 700; color: #0f2a4a; width: 34%; text-transform: uppercase; letter-spacing: .6px; }
  p { margin: 10px 0; }
  .sig { margin-top: 34px; }
  .sig .line { border-bottom: 1.5px solid #1a2332; width: 260px; height: 26px; }
  .sig .who { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #44506a; margin-top: 4px; }
  .fine { margin-top: 30px; font-size: 9pt; color: #6a7590; line-height: 1.5; border-top: 1px solid #d8dee9; padding-top: 10px; }
</style></head>
<body>
  <div class="letterhead">
    <div class="brand">Direct Property Buyers<small>We Buy Houses — Cash, As-Is</small></div>
    <div class="lh-contact">{{fromName}} · {{fromAddressLine1}} · {{fromCityStateZip}} · {{phone}}</div>
  </div>
  <div>{{letterDate}}</div>
  <p>{{ownerName}}<br>{{mailingAddress}}<br>{{mailingCityStateZip}}</p>
  <p>Dear {{ownerName}},</p>
  <p>We are local cash buyers, and we would like to buy your property at
     <strong>{{propertyAddress}}</strong>. This letter is our written intent
     to purchase it on the terms below — a real number, in writing, that you
     can hold us to during the review window.</p>
  <div class="offer-box">
    <div class="lbl">Our Cash Offer</div>
    <div class="amt">{{offerAmount}}</div>
    <div>For the property at {{propertyAddress}}, sold as-is.</div>
  </div>
  <table class="terms">
    <tr><td class="k">Purchase price</td><td>{{offerAmount}} (cash — no bank financing, no lender delays)</td></tr>
    <tr><td class="k">Condition</td><td>As-is. No repairs, no cleaning, no showings. Leave anything you don't want.</td></tr>
    <tr><td class="k">Closing</td><td>On your timeline — as fast as {{closingDays}} days, or later if you need time. Closing through a licensed local title company.</td></tr>
    <tr><td class="k">Costs</td><td>We cover the standard closing costs. No commissions, no fees charged to you.</td></tr>
    <tr><td class="k">Review window</td><td>This intent stays open for {{reviewDays}} days from the date above so you can review it with anyone you trust.</td></tr>
  </table>
  <p>If the price works, the next step is simple: we put it in a standard
     purchase agreement so everything is in writing and reviewed by the title
     company before anything is final. If it doesn't work, no pressure at
     all — a quick call still helps us understand what would.</p>
  <p>Call us at <strong>{{phone}}</strong> anytime. We are happy to answer
     questions with zero obligation.</p>
  <div class="sig">
    <div class="line"></div>
    <div class="who">{{fromName}} — Direct Property Buyers</div>
  </div>
  <div class="fine">
    This letter of intent is a good-faith statement of proposed terms and is
    not a binding purchase contract. A binding agreement exists only when
    both parties sign a written purchase agreement. Offer figures are based
    on a review of comparable sales for the property as of the date above.
  </div>
</body></html>`;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '';
  return '$' + v.toLocaleString('en-US');
}

/** Render the LOI HTML. Throws on a missing required variable — a letter
 *  with a blank offer or address must never render, let alone send. */
function renderLoi(vars) {
  const required = ['ownerName', 'mailingAddress', 'mailingCityStateZip',
    'propertyAddress', 'offerAmount', 'letterDate'];
  const merged = {
    phone: PHONE,
    fromName: BRAND,
    fromAddressLine1: DEFAULT_FROM.addressLine1,
    fromCityStateZip: `${DEFAULT_FROM.city}, ${DEFAULT_FROM.provinceOrState} ${DEFAULT_FROM.postalOrZip}`,
    closingDays: LOI_DEFAULTS.closingDays,
    reviewDays: LOI_DEFAULTS.reviewDays,
    ...vars,
  };
  for (const k of required) {
    if (merged[k] === undefined || merged[k] === null || String(merged[k]).trim() === '') {
      throw new Error(`LOI variable missing: ${k}`);
    }
  }
  let html = LOI_HTML;
  for (const [k, v] of Object.entries(merged)) {
    html = html.split(`{{${k}}}`).join(escHtml(v));
  }
  const leftover = html.match(/\{\{[^}]+\}\}/g);
  if (leftover) throw new Error(`LOI unfilled variables: ${leftover.join(', ')}`);
  return html;
}

module.exports = { BRAND, PHONE, DEFAULT_FROM, LOI_DEFAULTS, LOI_HTML, renderLoi, money, escHtml };

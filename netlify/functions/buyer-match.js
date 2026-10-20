// netlify/functions/buyer-match.js
// Buyer Match Ai — XLeads-style investor matching for the dashboard.
// Ranks the national buyer database (buyers-data.js) against a subject
// property and returns up to 100 investors with match scores, portfolio
// stats and contacts — same shape as XLeads' Buyer Match Ai tab.
//
// Dashboard calls:
//   POST /.netlify/functions/buyer-match
//   body: { zip, city, state, price, filters: {
//     investorType: 'all'|'flipper'|'landlord',
//     entityType: 'all'|'individual'|'entity',
//     minProps, maxProps, minPortfolio, maxPortfolio, minAvg, maxAvg,
//     excludeHighVolume: bool } }
// Response: { total, database, buyers: [ {name, city, state, zip, score,
//   portfolioCount, portfolioValue, avgPurchase, flips, isFlipper,
//   isLandlord, isEntity, highVolume, phones: [{phone,type,dnc}], emails } ] }

const BUYERS = require('./buyers-data.js');

function geoScore(b, subj) {
  const zip = subj.zip || '';
  const city = (subj.city || '').toLowerCase().trim();
  const state = (subj.state || '').toUpperCase().trim();
  if (zip && b.z && zip === b.z) return 40;
  if (city && b.ct.includes(city)) return 34;
  if (state && b.st.includes(state)) {
    if (zip && b.z && zip.slice(0, 3) === b.z.slice(0, 3)) return 24;
    return 14;
  }
  return 0;
}

function priceScore(b, price) {
  if (!price || !b.ap) return 12;
  const ratio = price / b.ap;
  const dist = Math.abs(Math.log2(ratio));
  return Math.max(0, Math.round(30 * (1 - dist / 2)));
}

function activityScore(b) {
  return Math.min(20, Math.round(6 + b.pc * 0.28));
}

function strategyScore(b) {
  if (b.f && b.l) return 10;
  if (b.f || b.l) return 8;
  return 5;
}

function passesFilters(b, f) {
  if (!f) return true;
  if (f.excludeHighVolume && b.hv) return false;
  if (f.investorType === 'flipper' && !b.f) return false;
  if (f.investorType === 'landlord' && !b.l) return false;
  if (f.entityType === 'individual' && b.e) return false;
  if (f.entityType === 'entity' && !b.e) return false;
  if (f.minProps && b.pc < +f.minProps) return false;
  if (f.maxProps && b.pc > +f.maxProps) return false;
  if (f.minPortfolio && b.pv < +f.minPortfolio) return false;
  if (f.maxPortfolio && b.pv > +f.maxPortfolio) return false;
  if (f.minAvg && b.ap < +f.minAvg) return false;
  if (f.maxAvg && b.ap > +f.maxAvg) return false;
  return true;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { req = {}; }
  const subj = { zip: (req.zip || '').toString().slice(0, 5), city: req.city || '', state: req.state || '' };
  const price = +req.price || 0;
  const filters = req.filters || {};

  const scored = [];
  for (const b of BUYERS) {
    if (!passesFilters(b, filters)) continue;
    const g = geoScore(b, subj);
    if (g === 0) continue;
    const score = Math.min(99, g + priceScore(b, price) + activityScore(b) + strategyScore(b));
    if (score < 35) continue;
    scored.push({ b, score });
  }
  scored.sort((x, y) => y.score - x.score || y.b.pc - x.b.pc);
  const top = scored.slice(0, 100).map(({ b, score }) => ({
    name: b.n,
    city: b.ct[0] || '', state: b.st[0] || '', zip: b.z || '',
    areas: b.ct, states: b.st,
    score,
    portfolioCount: b.pc, portfolioValue: b.pv, avgPurchase: b.ap, flips: b.fl,
    isFlipper: !!b.f, isLandlord: !!b.l, isEntity: !!b.e, highVolume: !!b.hv,
    phones: b.ph.map(p => ({ phone: p[0], type: p[1], dnc: !!p[2] })),
    emails: b.em,
    mailingAddress: b.ma || '',
  }));
  return {
    statusCode: 200, headers,
    body: JSON.stringify({ total: scored.length, database: BUYERS.length, buyers: top }),
  };
};

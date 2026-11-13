// netlify/functions/buyervault-markets.js
// BuyerVault Pro §5A (1) — instant market search over the OWNED data
// (spec §6.2 resolve + §6.3 instant results). Reads ONLY the bundled
// snapshot exported from the BuyerVault databases by
// tools/build-buyervault-data.py — no vendor calls in the request path
// [spec §7.4]. Every response carries the snapshot's freshness stamp;
// missing values stay null and render as "—" [HARD RULE C].
//
//   GET ?action=meta                          snapshot provenance + counts
//   GET ?action=resolve&q=Indianapolis        normalized market + alternates
//   GET ?action=summary&market=<key>          one market's stored summary
//   GET ?action=buyers&market=<key>&limit=100 ranked buyers in the market
//   GET ?action=candidates&market=<key>&limit=100  harvested candidates
//   GET ?action=list                          all markets (autocomplete)
'use strict';

const lib = require('./buyervault-lib');
const META = require('./buyervault-meta.json');
const INDEX = require('./buyervault-markets.json');
const BUYERS = require('./buyers-data');

const MARKETS = INDEX.markets || [];
const BY_KEY = new Map(MARKETS.map((m) => [m.key, m]));

function marketBuyers(market, limit) {
  // buyers-data.js rows: ct/st are arrays of cities/states the buyer buys in.
  // Master buyers carry CITY evidence, not county evidence — so county
  // markets return no master buyers rather than presenting every buyer
  // in the state as a county buyer. County markets are harvest views
  // (candidates below); the matching city market shows the master buyers.
  if (market.kind !== 'city') return { total: 0, buyers: [], countyEvidence: false };
  const out = [];
  for (const b of BUYERS) {
    const hit = (b.ct || []).some((c) => c === market.city.toLowerCase())
      && (b.st || []).includes(market.state);
    if (!hit) continue;
    const phones = (b.ph || []).map((p) => ({ phone: p[0], type: p[1], dnc: !!p[2] }));
    out.push({
      name: b.n, city: (b.ct || [])[0] || '', state: (b.st || [])[0] || '',
      zip: b.z || '', props: b.pc || 0, portfolioValue: b.pv || 0,
      avgPurchase: b.ap || 0, flips: b.fl || 0,
      isFlipper: !!b.f, isLandlord: !!b.l, isEntity: !!b.e,
      phones, emails: b.em || [], mailingAddress: b.ma || '',
    });
  }
  out.sort((a, b) => (b.props - a.props) || (b.portfolioValue - a.portfolioValue));
  return { total: out.length, buyers: out.slice(0, limit) };
}

function marketCandidates(market, limit) {
  if (market.kind !== 'county') return { total: 0, candidates: [] };
  const file = market.state === 'FL'
    ? require('./buyervault-candidates-fl.json')
    : require('./buyervault-candidates-nc.json');
  // candidate row: [name, state, counties, parcels, purch36, purchAll,
  //   volume36, median36, lastPurchase, sunbizDoc, hasAgent]
  // counties is the full comma list — a candidate belongs to every
  // county it buys in, matching the market summary counts.
  const county = market.county.toLowerCase();
  const rows = file.filter((r) => (r[2] || '').split(',')
    .map((c) => c.trim().toLowerCase()).includes(county));
  rows.sort((a, b) => (b[4] - a[4]) || (b[3] - a[3]));
  return {
    total: rows.length,
    candidates: rows.slice(0, limit).map((r) => ({
      name: r[0], counties: r[2], parcels: r[3], purchases36mo: r[4],
      purchasesAll: r[5], volume36: r[6], median36: r[7],
      lastPurchase: r[8], sunbizDoc: r[9], hasAgent: !!r[10],
      hasPhone: false, // candidates are never shown with invented contact data
    })),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return lib.json(200, {});
    const p = event.queryStringParameters || {};
    const action = p.action || 'resolve';
    const limit = Math.max(1, Math.min(250, parseInt(p.limit, 10) || 100));

    if (action === 'meta') {
      return lib.json(200, { meta: META, markets: MARKETS.length });
    }
    if (action === 'list') {
      return lib.json(200, { markets: MARKETS, dataAsOf: META.generatedAt });
    }
    if (action === 'resolve') {
      const r = lib.resolveMarket(INDEX, p.q || '');
      if (!r.match) {
        return lib.json(200, {
          match: null, alternates: [], dataAsOf: META.generatedAt,
          note: 'No stored BuyerVault market matches that search yet. '
            + 'Markets appear here once buyers or harvested candidates are on file.',
        });
      }
      return lib.json(200, { match: r.match, alternates: r.alternates, via: r.via, dataAsOf: META.generatedAt });
    }
    const market = BY_KEY.get(p.market || '');
    if (!market) return lib.json(404, { error: 'Unknown market key.' });
    if (action === 'summary') {
      return lib.json(200, { market, dataAsOf: META.generatedAt, sources: META.sources });
    }
    if (action === 'buyers') {
      const r = marketBuyers(market, limit);
      return lib.json(200, { market: market.key, total: r.total, buyers: r.buyers, dataAsOf: META.generatedAt });
    }
    if (action === 'candidates') {
      const r = marketCandidates(market, limit);
      return lib.json(200, { market: market.key, total: r.total, candidates: r.candidates, dataAsOf: META.generatedAt });
    }
    return lib.json(400, { error: 'Unknown action.' });
  } catch (e) {
    return lib.json(503, { error: 'BuyerVault market search is not ready yet', detail: String((e && e.message) || e) });
  }
};

// Exported for the regression suite.
exports._test = { marketBuyers, marketCandidates, BY_KEY };

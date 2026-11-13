// netlify/functions/buyervault-entities.js
// BuyerVault Pro §5A (2) — registered-agent / entity-linking view
// (spec §9.3). Data: Sunbiz entities linked to Florida buyer candidates,
// exported read-only from buyervault-florida.db by
// tools/build-buyervault-data.py. Derived links (shares_agent_with /
// shares_address_with) are computed WITHIN the exported candidate-linked
// set and labeled as such — a link is an association with its signals
// shown, never proof of common ownership, and links never merge records.
//
//   GET ?action=search&q=<name>&limit=25   entity search
//   GET ?action=detail&doc=<sunbiz doc no> full entity + agent + links
//   GET ?action=forCandidate&name=<buyer>  entity for a candidate name
'use strict';

const lib = require('./buyervault-lib');
const META = require('./buyervault-meta.json');
const ENTITIES = require('./buyervault-entities.json');

const BY_DOC = new Map(ENTITIES.map((e) => [e.doc, e]));
function norm(n) {
  return String(n || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
const BY_NAME = new Map();
for (const e of ENTITIES) {
  if (!BY_NAME.has(norm(e.name))) BY_NAME.set(norm(e.name), e);
}

function summary(e) {
  return {
    doc: e.doc, name: e.name, status: e.status, filingType: e.filingType,
    agentName: e.agent ? e.agent.name : null,
    agentCity: e.agent ? e.agent.city : null,
    candidate: e.candidate,
    linkedAgentCount: e.linkedAgentCount, linkedAddressCount: e.linkedAddressCount,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return lib.json(200, {});
    const p = event.queryStringParameters || {};
    const action = p.action || 'search';
    const limit = Math.max(1, Math.min(100, parseInt(p.limit, 10) || 25));

    if (action === 'search') {
      const q = norm(p.q || '');
      if (!q) return lib.json(200, { total: ENTITIES.length, entities: ENTITIES.slice(0, limit).map(summary), dataAsOf: META.generatedAt });
      const hits = ENTITIES.filter((e) => norm(e.name).includes(q)
        || (e.agent && norm(e.agent.name).includes(q)));
      return lib.json(200, { total: hits.length, entities: hits.slice(0, limit).map(summary), dataAsOf: META.generatedAt });
    }
    if (action === 'detail') {
      const e = BY_DOC.get(p.doc || '');
      if (!e) return lib.json(404, { error: 'Entity not found in the stored Sunbiz export.' });
      return lib.json(200, {
        entity: e, dataAsOf: META.generatedAt,
        linkBasis: 'Derived links are computed within the BuyerVault candidate-linked '
          + 'entity set only, from Sunbiz registered-agent and principal-address records. '
          + 'A link shows why two entities may be related; it is not proof of common ownership.',
      });
    }
    if (action === 'forCandidate') {
      const e = BY_NAME.get(norm(p.name || ''));
      if (!e) return lib.json(200, { entity: null, dataAsOf: META.generatedAt });
      return lib.json(200, { entity: e, dataAsOf: META.generatedAt });
    }
    return lib.json(400, { error: 'Unknown action.' });
  } catch (e) {
    return lib.json(503, { error: 'BuyerVault entity view is not ready yet', detail: String((e && e.message) || e) });
  }
};

exports._test = { BY_DOC, BY_NAME, norm, summary };

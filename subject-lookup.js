// subject-lookup.js — subject-property lookup (data provider only).
//
// Used by command-center.html's subject analyzer. The data provider
// (PropertyReach via data-api) is the ONLY source: the old backup
// source was removed Nov 18, 2026 (cut off; Resideline is the comp
// feed now), so there is no backup-source fallback anymore. When the data provider fails,
// returns no match, or its quota is out (HTTP 402, meta.status 402/429,
// or a fetch failure), the lookup honestly reports no match — the
// analyzer shows "No property record found" exactly as before.
//
// Response shape matches the data-api function
// ({matched, address, property, avm, comps, linkedProperties}) plus a
// `source` field, always 'data provider'.
//
// Loaded as a classic script in the browser (window.lookupSubjectProperty)
// and required in node for the offline regression test (module.exports).
// Exactly one data-provider API call is made per lookup.
'use strict';

async function lookupSubjectProperty(address, fetchImpl) {
  const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) throw new Error('No fetch available');
  const url = '/.netlify/functions/data-api?address=' + encodeURIComponent(address);

  let d = null;
  try {
    const resp = await fetchFn(url);
    if (resp && resp.ok) {
      const pj = await resp.json();
      if (pj && pj.matched && pj.property) {
        // Matched — with or without comps. A matched subject with no
        // comps still renders (ARV falls back to market value screen).
        d = pj;
      }
      // matched:false (incl. quota 402 in upstream) or no property -> no match
    }
  } catch (e) { /* fetch failed -> no match */ }

  if (!d) {
    return { matched: false, address, source: 'data provider' };
  }
  d.source = 'data provider';
  return d;
}

if (typeof window !== 'undefined') window.lookupSubjectProperty = lookupSubjectProperty;
if (typeof module !== 'undefined' && module.exports) module.exports = { lookupSubjectProperty };

// subject-lookup.js — subject-property lookup with backup-source fallback.
//
// Used by command-center.html's subject analyzer. Mirrors the Comps page
// hybrid (index.html loadCompsForAddress): the data provider is tried
// first; when it fails, returns no match, or its quota is out (HTTP 402,
// meta.status 402/429, or a fetch failure), the backup source supplies
// the property record, value estimate and comps. No data-provider API
// call is made on the fallback path.
//
// Response shape matches the data-api and backup lookup functions
// ({matched, address, property, avm, comps, linkedProperties}) plus a
// `source` field:
//   'data provider' — the primary source answered (no UI note)
//   'backup'        — the backup source answered (UI shows "via backup source")
//
// Loaded as a classic script in the browser (window.lookupSubjectProperty)
// and required in node for the offline regression test (module.exports).
// The function never calls the data provider after the first attempt.
'use strict';

async function lookupSubjectProperty(address, fetchImpl) {
  const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) throw new Error('No fetch available');
  const primaryUrl = '/.netlify/functions/data-api?address=' + encodeURIComponent(address);
  const backupUrl = '/.netlify/functions/attom-lookup?address=' + encodeURIComponent(address);

  let primarySubject = null; // whole primary response, when it matched but had no comps
  let d = null;
  let source = '';

  // --- 1. data provider first ---
  try {
    const prResp = await fetchFn(primaryUrl);
    if (prResp && prResp.ok) {
      const pj = await prResp.json();
      if (pj && pj.matched && pj.property) {
        if (pj.comps && (pj.comps.best || []).length) {
          d = pj;
          source = 'data provider';
        } else {
          primarySubject = pj;
        }
      }
      // matched:false (incl. quota 402 in upstream) or no property -> fall through
    }
  } catch (e) { /* fetch failed -> fall through to backup */ }

  // --- 2. backup source when the primary gave no usable comps ---
  if (!d) {
    try {
      const resp = await fetchFn(backupUrl);
      if (resp && resp.ok) {
        d = await resp.json();
        source = 'backup';
        if (primarySubject) {
          // Keep the primary subject (distress/equity/mortgage fields) and
          // fill comps from the backup — same merge as the Comps page.
          d.property = Object.assign({}, d.property || {}, primarySubject.property || {});
          if (!d.matched) d.matched = true;
        }
      }
    } catch (e) { /* fall through */ }
    // Backup unreachable but the primary matched the property: render the
    // primary subject as before (ARV falls back to market value, no comps).
    if (!d && primarySubject) {
      d = primarySubject;
      source = 'data provider';
    }
  }

  if (!d || !d.matched || !d.property) {
    return { matched: false, address, source: source || 'backup' };
  }
  d.source = source || 'data provider';
  return d;
}

if (typeof window !== 'undefined') window.lookupSubjectProperty = lookupSubjectProperty;
if (typeof module !== 'undefined' && module.exports) module.exports = { lookupSubjectProperty };

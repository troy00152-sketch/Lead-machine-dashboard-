// Regression tests for the Hot Leads HL-values fallback (Nov 11, 2026):
// the 9 hot leads showed ARV/MAO/LAO as "—" even after the comp project
// wrote those values to the HL contact, because (1) cc-data.js never
// returned them from the contact, and (2) renderHotLeads only ever got ARV
// from a live data-api lookup (1 PR credit per lead — fails at 0 credits).
// The fix: cc-data.js returns ARV/MAO/LAO off the contact (field ID first,
// field name second) and renderHotLeads falls back to them when the live
// lookup returns nothing. Nothing is ever invented: no values anywhere
// still renders "—".
// Run: node hot-leads-fallback-regression.js (exit non-zero on any failure)
// No live API calls: HL fetch is never invoked (pure helpers only) and the
// page's fetch is fully mocked.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { parseMoneyValue, valuesFromCustomFields } = require('./netlify/functions/cc-data.js')._test;

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ---------- 1. parseMoneyValue ----------
check('1 parse "$167,876" -> 167876', parseMoneyValue('$167,876') === 167876);
check('1 parse plain number 190254 -> 190254', parseMoneyValue(190254) === 190254);
check('1 parse numeric string "49917" -> 49917', parseMoneyValue('49917') === 49917);
check('1 parse blank -> null', parseMoneyValue('') === null);
check('1 parse null -> null', parseMoneyValue(null) === null);
check('1 parse undefined -> null', parseMoneyValue(undefined) === null);
check('1 parse "0" -> null (never show $0 as a value)', parseMoneyValue('0') === null);
check('1 parse "-5000" -> null', parseMoneyValue('-5000') === null);
check('1 parse "not a number" -> null', parseMoneyValue('not a number') === null);

// ---------- 2. valuesFromCustomFields ----------
// HL get-contact shape: customFields entries carry the field id + value.
const ARV_ID = 'cOE6XmJNOdVKsDNpiGqR';
const MAO_ID = 'B8Mfg1TQfjjo4Dl214A2';
const LAO_ID = 'JUPzLFhe7VG0PCJqL0n8';
{
  const v = valuesFromCustomFields([
    { id: ARV_ID, fieldValue: '167876' },
    { id: MAO_ID, fieldValue: '117513' },
    { id: LAO_ID, fieldValue: '82259' },
    { id: '6sOnUj1RbMtTMadOSIF8', fieldValue: '1' },
  ]);
  check('2 id-based ARV/MAO/LAO', v.arv === 167876 && v.mao === 117513 && v.lao === 82259, JSON.stringify(v));
}
{
  // Name fallback when the response carries names instead of ids.
  const v = valuesFromCustomFields([
    { name: 'ARV', fieldValue: '$150,000' },
    { name: 'MAO', value: 90000 },
    { name: 'LAO', fieldValue: '63000' },
  ]);
  check('2 name-based ARV/MAO/LAO', v.arv === 150000 && v.mao === 90000 && v.lao === 63000, JSON.stringify(v));
}
{
  // ID wins over a stale/conflicting name entry.
  const v = valuesFromCustomFields([
    { id: ARV_ID, fieldValue: '200000' },
    { name: 'ARV', fieldValue: '111111' },
  ]);
  check('2 field ID wins over name', v.arv === 200000, JSON.stringify(v));
}
{
  // Uncomped contact: no ARV/MAO/LAO fields at all -> all null.
  const v = valuesFromCustomFields([
    { name: 'Stack Count', fieldValue: '1' },
    { name: 'List Sources', fieldValue: 'code violation' },
  ]);
  check('2 uncomped contact -> all null', v.arv === null && v.mao === null && v.lao === null, JSON.stringify(v));
}
{
  const v = valuesFromCustomFields(null);
  check('2 null customFields -> all null', v.arv === null && v.mao === null && v.lao === null);
}

// ---------- 3. resolveLeadValues + renderHotLeads (from the page) ----------
const ccHtml = fs.readFileSync(path.join(__dirname, 'command-center.html'), 'utf8');

// Extract a top-level function by brace counting.
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in command-center.html');
  // Keep the `async` prefix when the function is declared `async function`.
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

const fns = ['esc', 'fmtMoney', 'timeAgo', 'scoreClass', 'calcMAO', 'resolveLeadValues', 'renderHotLeads']
  .map((n) => extractFn(ccHtml, n)).join('\n');

(async () => {
  const grid = { innerHTML: '' };
  const sandbox = {
    console,
    document: { getElementById: (id) => (id === 'leadsGrid' ? grid : { textContent: '', innerHTML: '' }) },
    window: {},
    // Live lookup always fails (0 PR credits): matched:false, like data-api.
    fetch: async () => ({ json: async () => ({ matched: false }) }),
    wholesaleScoreSimple: () => ({ score: 160, label: 'COOL', distress: 160, equity: 0, own: 0 }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fns, sandbox);

  const resolveLeadValues = sandbox.resolveLeadValues;
  const renderHotLeads = sandbox.renderHotLeads;

  // 3a. Live property value wins over feed values.
  {
    const r = resolveLeadValues({ arv: 100000, mao: 60000, lao: 42000 }, 250590);
    check('3a property ARV wins', r.arv === 250590 && r.valueSrc === 'property', JSON.stringify(r));
  }
  // 3b. No live value + full feed values -> feed MAO/LAO used as written.
  {
    const r = resolveLeadValues({ arv: 167876, mao: 117513, lao: 82259 }, null);
    check('3b feed MAO/LAO used as written', r.arv === 167876 && r.mao === 117513 && r.lao === 82259 && r.valueSrc === 'hl', JSON.stringify(r));
  }
  // 3c. No live value + feed ARV only -> MAO derived, never invented from thin air.
  {
    const r = resolveLeadValues({ arv: 200000, mao: null, lao: null }, null);
    // 80% tier (<$220K): (200000-30000)*0.80 = 136000; LAO 70% = 95200.
    check('3c feed ARV only derives MAO', r.arv === 200000 && r.mao === 136000 && r.lao === 95200 && r.valueSrc === 'hl', JSON.stringify(r));
  }
  // 3d. Nothing anywhere -> nulls, page must show "—".
  {
    const r = resolveLeadValues({ arv: null, mao: null, lao: null }, null);
    check('3d no values -> nulls', r.arv === null && r.mao === null && r.lao === null && r.valueSrc === 'none', JSON.stringify(r));
    const r2 = resolveLeadValues({}, 0);
    check('3d zero live value + empty lead -> nulls', r2.arv === null && r2.valueSrc === 'none', JSON.stringify(r2));
  }
  // 3e. Feed values of 0 / negative never render as money.
  {
    const r = resolveLeadValues({ arv: 0, mao: 0, lao: -5 }, null);
    check('3e zero/negative feed values -> nulls', r.arv === null && r.valueSrc === 'none', JSON.stringify(r));
  }

  // 3f. DOM-level: comped fixture renders the written numbers with the
  // live lookup failing; uncomped fixture still renders "—".
  {
    const leads = [
      { address: '406 N Walcott St, Indianapolis, IN 46201', name: '406 N Walcott St', stage: 'New Lead', createdAt: new Date(Date.now() - 5 * 86400 * 1000).toISOString(), score: 16, scoreLabel: 'COOL', scoreParts: { distress: 16, equity: 0, own: 0 }, scoreSource: 'crm', arv: 167876, mao: 117513, lao: 82259 },
      { address: '1615 Warner Ave, Dayton, OH 45404', name: '1615 Warner Ave', stage: 'New Lead', createdAt: new Date(Date.now() - 5 * 86400 * 1000).toISOString(), score: 16, scoreLabel: 'COOL', scoreParts: { distress: 16, equity: 0, own: 0 }, scoreSource: 'crm', arv: null, mao: null, lao: null },
    ];
    await renderHotLeads(leads);
    const html = grid.innerHTML;
    check('3f comped card shows feed ARV $167,876', html.includes('$167,876'), html.slice(0, 400));
    check('3f comped card shows feed MAO $117,513', html.includes('$117,513'));
    check('3f comped card shows feed LAO $82,259', html.includes('$82,259'));
    check('3f comped card marked HL values', html.includes('HL values'));
    check('3f uncomped card still shows dashes, no invented numbers', html.includes('>—<'), html.slice(0, 400));
    check('3f no $0 rendered anywhere', !html.includes('$0'));
  }

  // ---------- 4. Wiring checks on the shipped files ----------
  const ccData = fs.readFileSync(path.join(__dirname, 'netlify/functions/cc-data.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  check('4 cc-data.js carries the ARV field id', ccData.includes(ARV_ID));
  check('4 cc-data.js carries the MAO field id', ccData.includes(MAO_ID));
  check('4 cc-data.js carries the LAO field id', ccData.includes(LAO_ID));
  check('4 getContactTags returns arv/mao/lao', /return \{ tags, cfByName, arv: vals\.arv, mao: vals\.mao, lao: vals\.lao \}/.test(ccData));
  check('4 enrichHotLeads attaches lead.arv', ccData.includes('lead.arv = (contact && contact.arv) || null'));
  check('4 enrichHotLeads attaches lead.mao', ccData.includes('lead.mao = (contact && contact.mao) || null'));
  check('4 enrichHotLeads attaches lead.lao', ccData.includes('lead.lao = (contact && contact.lao) || null'));
  check('4 renderHotLeads falls back to lead values', ccHtml.includes('resolveLeadValues(lead,cached?cached.arv:null)'));
  check('4 no ATTOM routing added for hot leads', !/attom/i.test(ccData) && !/attom/i.test(ccHtml), 'attom mention found in cc-data.js or command-center.html');
  check('4 subject analyzer ATTOM fallback untouched', ccHtml.includes("lookupSubjectProperty(addr)"));
  check('4 no stale 7,642 in command-center.html', !ccHtml.includes('7,642'));
  check('4 no stale 7,642 in index.html', !indexHtml.includes('7,642'));
  check('4 no stale 7,642 in cc-data.js', !ccData.includes('7,642'));
  check('4 buyer tile is 34,683 in command-center.html', ccHtml.includes('<div class="n">34,683</div>'));
  check("4 buyer tile is 34,683 in index.html", indexHtml.includes("textContent = '34,683'"));

  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('ALL hot-leads fallback regression tests PASS');
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack || e)); process.exit(1); });

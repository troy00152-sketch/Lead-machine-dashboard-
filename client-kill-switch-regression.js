// Regression tests for the white-label client kill switch (Nov 19, 2026):
// a client's config (clients/{subdomain}.json) may set "active": false
// to SUSPEND that client — the public config reports accountStatus
// "suspended" (pages render a neutral inactive notice) and
// resolveClientData returns null so no CRM data flows. Missing field
// means active. HARD SAFETY: Troy's own client can NEVER be suspended
// by the flag, in any layer.
// Run: node client-kill-switch-regression.js (exit non-zero on failure)
// No live API calls: fixture clients are written to clients/ for the
// duration of the run (production-shaped, copied from _template.json's
// shape) and removed in a finally block; troy.json is temporarily
// rewritten with "active": false for the safety test and restored
// byte-for-byte in the same finally block.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CLIENTS_DIR = path.join(ROOT, 'clients');
const LIB_PATH = path.join(ROOT, 'netlify/functions/lib-client.js');
const CLIENT_CONFIG_PATH = path.join(ROOT, 'netlify/functions/client-config.js');

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// Fresh module instances (lib-client caches parsed client files per
// instance, so scenarios that change files on disk need a fresh one).
function freshLib() {
  delete require.cache[LIB_PATH];
  return require(LIB_PATH);
}
function freshClientConfig() {
  delete require.cache[CLIENT_CONFIG_PATH];
  delete require.cache[LIB_PATH];
  return require(CLIENT_CONFIG_PATH);
}

// Production-shaped fixture client (same fields as clients/_template.json
// and clients/troy.json — fixtures must mirror production data shapes).
function fixtureClient(subdomain, activeField) {
  const cfg = {
    _comment: 'kill-switch regression fixture — removed after the run',
    bot: { businessName: 'Fixture Realty LLC', fromNumbers: { indianapolis: '+13175550142' }, markets: ['indianapolis'] },
    buyers: { listId: '', source: 'shared-starter' },
    companyName: 'Fixture Realty LLC',
    highLevel: {
      apiTokenEnvVar: 'KSTEST_HL_TOKEN',
      calendarId: 'kstest-calendar-' + subdomain,
      locationId: 'kstest-location-' + subdomain,
      webhookUrl: 'https://example.invalid/hooks/' + subdomain,
    },
    buyerSignerName: 'Fixture Signer',
    operator: { name: 'Fixture Operator', firstName: 'Fixture', lastName: 'Operator', email: 'op@example.invalid', phone: '+13175550142', phoneDigits: '13175550142' },
    logo: '/assets/fixture-logo.png',
    primaryColor: '#00d4ff',
    propertyReach: { apiKeyEnvVar: 'KSTEST_PR_KEY' },
    subdomain,
  };
  if (activeField !== undefined) cfg.active = activeField;
  return cfg;
}

const FIXTURES = ['kstest-active', 'kstest-noflag', 'kstest-suspended'];
const troyPath = path.join(CLIENTS_DIR, 'troy.json');
const troyOriginal = fs.readFileSync(troyPath, 'utf8');

(async () => {
  try {
    // Token env for fixture clients + Troy's fallback token var
    // (troy.json names TROY_HL_TOKEN, which is unset — production
    // resolves via the HL_API_TOKEN fallback; mirror that here).
    process.env.KSTEST_HL_TOKEN = 'kstest-token-value';
    process.env.HL_API_TOKEN = 'kstest-fallback-token';

    fs.writeFileSync(path.join(CLIENTS_DIR, 'kstest-active.json'), JSON.stringify(fixtureClient('kstest-active', true), null, 2));
    fs.writeFileSync(path.join(CLIENTS_DIR, 'kstest-noflag.json'), JSON.stringify(fixtureClient('kstest-noflag', undefined), null, 2));
    fs.writeFileSync(path.join(CLIENTS_DIR, 'kstest-suspended.json'), JSON.stringify(fixtureClient('kstest-suspended', false), null, 2));

    // ---------- 1. On-disk config contract ----------
    const troyJson = JSON.parse(fs.readFileSync(troyPath, 'utf8'));
    check('1a troy.json sets "active": true explicitly', troyJson.active === true);
    const templateJson = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, '_template.json'), 'utf8'));
    check('1b _template.json ships "active": true', templateJson.active === true);
    check('1c _template.json documents the kill switch', String(templateJson._comment || '').includes('"active"') && String(templateJson._comment || '').toLowerCase().includes('suspend'));
    const defaultJson = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, '_default.json'), 'utf8'));
    check('1d neutral _default.json carries no active flag (missing = active, never gated)', !('active' in defaultJson));

    // ---------- 2. isClientSuspended unit checks ----------
    const lib = freshLib();
    check('2a active:false, non-Troy -> suspended', lib.isClientSuspended({ active: false }, false) === true);
    check('2b active:false, Troy -> NOT suspended (HARD SAFETY)', lib.isClientSuspended({ active: false }, true) === false);
    check('2c missing flag -> active', lib.isClientSuspended({}, false) === false);
    check('2d active:true -> active', lib.isClientSuspended({ active: true }, false) === false);
    check('2e null config -> not suspended', lib.isClientSuspended(null, false) === false);

    // ---------- 3. Active client works normally ----------
    {
      const l = freshLib();
      const ev = { headers: { host: 'kstest-active.leadmachineapp.com' } };
      const r = l.resolveClient(ev);
      check('3a active client resolves, not suspended', r.isTroy === false && r.isNeutral === false && r.suspended === false, JSON.stringify({ s: r.suspended }));
      const data = l.resolveClientData(ev);
      check('3b active client data resolves to ITS location', !!data && data.locationId === 'kstest-location-kstest-active' && data.calendarId === 'kstest-calendar-kstest-active', JSON.stringify(data && data.locationId));
      const cc = freshClientConfig();
      const res = await cc.handler(ev);
      const body = JSON.parse(res.body);
      check('3c active client config reports accountStatus active', res.statusCode === 200 && body.accountStatus === 'active', res.body);
      check('3d active client keeps CRM link + webhook', body.crmUrl.includes('kstest-location-kstest-active') && body.ghlWebhookUrl === 'https://example.invalid/hooks/kstest-active', res.body);
    }

    // ---------- 4. Missing flag = active ----------
    {
      const l = freshLib();
      const ev = { headers: { host: 'kstest-noflag.leadmachineapp.com' } };
      const r = l.resolveClient(ev);
      check('4a no-flag client not suspended', r.suspended === false);
      const data = l.resolveClientData(ev);
      check('4b no-flag client data resolves', !!data && data.locationId === 'kstest-location-kstest-noflag');
      const cc = freshClientConfig();
      const body = JSON.parse((await cc.handler(ev)).body);
      check('4c no-flag client config reports active', body.accountStatus === 'active', JSON.stringify(body.accountStatus));
    }

    // ---------- 5. Suspended client is fully gated ----------
    {
      const l = freshLib();
      const ev = { headers: { host: 'kstest-suspended.leadmachineapp.com' } };
      const r = l.resolveClient(ev);
      check('5a suspended client resolves with suspended=true', r.isNeutral === false && r.suspended === true, JSON.stringify({ s: r.suspended }));
      check('5b suspended client data resolver returns null', l.resolveClientData(ev) === null);
      const cc = freshClientConfig();
      const res = await cc.handler(ev);
      const body = JSON.parse(res.body);
      check('5c suspended config reports accountStatus suspended', res.statusCode === 200 && body.accountStatus === 'suspended', res.body);
      check('5d suspended config blanks CRM link + webhook', body.crmUrl === '' && body.ghlWebhookUrl === '', res.body);
      check('5e suspended body leaks no client webhook/location URL', !res.body.includes('example.invalid/hooks/kstest-suspended'));
      // Header-based resolution gates identically.
      const viaHeader = l.resolveClient({ headers: { host: 'app.leadmachineapp.com', 'x-client-subdomain': 'kstest-suspended' } });
      check('5f suspended via header also gated', viaHeader.suspended === true && l.resolveClientData({ headers: { host: 'app.leadmachineapp.com', 'x-client-subdomain': 'kstest-suspended' } }) === null);
    }

    // ---------- 6. cc-data serves nothing to a suspended client ----------
    {
      let fetchCalls = 0;
      const realFetch = global.fetch;
      global.fetch = async () => { fetchCalls++; throw new Error('network disabled in kill-switch test'); };
      try {
        delete require.cache[path.join(ROOT, 'netlify/functions/cc-data.js')];
        const ccData = require('./netlify/functions/cc-data.js');
        const res = await ccData.handler({
          httpMethod: 'GET',
          headers: { host: 'kstest-suspended.leadmachineapp.com' },
          queryStringParameters: { action: 'overview' },
        });
        const body = JSON.parse(res.body);
        check('6a cc-data overview for suspended client -> honest 400', res.statusCode === 400 && body.ok === false && String(body.error).includes('unknown client'), 'status=' + res.statusCode + ' body=' + res.body);
        check('6b cc-data made zero network calls for suspended client', fetchCalls === 0, 'fetchCalls=' + fetchCalls);
      } finally {
        global.fetch = realFetch;
      }
    }

    // ---------- 7. HARD SAFETY: Troy with active:false STILL works ----------
    {
      const troyOff = JSON.parse(troyOriginal);
      troyOff.active = false;
      fs.writeFileSync(troyPath, JSON.stringify(troyOff, null, 2));
      try {
        const l = freshLib();
        const ev = { headers: { host: 'leadmachineapp.com' } };
        const r = l.resolveClient(ev);
        check('7a Troy resolves isTroy with flag off', r.isTroy === true, JSON.stringify({ t: r.isTroy }));
        check('7b Troy is NOT suspended even with active:false', r.suspended === false);
        const data = l.resolveClientData(ev);
        check('7c Troy data still resolves with flag off', !!data && data.locationId === troyJson.highLevel.locationId, JSON.stringify(data && data.locationId));
        const cc = freshClientConfig();
        const body = JSON.parse((await cc.handler({ headers: { host: 'app.leadmachineapp.com' } })).body);
        check('7d Troy config still reports active + his branding', body.accountStatus === 'active' && body.companyName === 'Direct Property Buyers', JSON.stringify(body.accountStatus));
      } finally {
        fs.writeFileSync(troyPath, troyOriginal);
      }
      check('7e troy.json restored byte-for-byte', fs.readFileSync(troyPath, 'utf8') === troyOriginal);
    }

    // ---------- 8. Neutral default unchanged ----------
    {
      const l = freshLib();
      const ev = { headers: { host: 'stranger.leadmachineapp.com' } };
      const r = l.resolveClient(ev);
      check('8a unknown subdomain -> neutral, not suspended', r.isNeutral === true && r.suspended === false);
      check('8b neutral data resolver still null', l.resolveClientData(ev) === null);
      const cc = freshClientConfig();
      const body = JSON.parse((await cc.handler(ev)).body);
      check('8c neutral config unchanged (generic brand, active)', body.companyName === 'Command Center' && body.logo === '' && body.accountStatus === 'active', JSON.stringify(body.companyName));
    }

    // ---------- 9. Wiring: server gate + frontend gate shipped ----------
    const libSrc = fs.readFileSync(LIB_PATH, 'utf8');
    check('9a resolveClientData honors the suspended gate', libSrc.includes('if (resolved.suspended) return null;'));
    check('9b isClientSuspended hard-codes the Troy safety', libSrc.includes('if (isTroy) return false;'));
    const NOTICE = 'This account is currently inactive. Please contact your provider to restore service.';
    for (const page of ['index.html', 'command-center.html']) {
      const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
      check('9c ' + page + ' gates on accountStatus suspended', html.includes("cfg.accountStatus === 'suspended'") && html.includes('function showSuspended()'));
      check('9d ' + page + ' carries the exact neutral notice', html.includes(NOTICE));
      const start = html.indexOf('function showSuspended()');
      const end = start >= 0 ? html.indexOf('function fallback()', start) : -1;
      const slice = start >= 0 && end > start ? html.slice(start, end) : '';
      check('9e ' + page + ' notice is vendor-free + brand-free', start >= 0 && !/HighLevel|Netlify|PropertyReach|Telnyx|Grok|Direct Property Buyers/.test(slice));
      check('9f ' + page + ' notice replaces page content (no data behind it)', slice.includes('document.body.innerHTML'));
    }
  } finally {
    // Cleanup: fixtures out, troy.json guaranteed restored.
    for (const sub of FIXTURES) {
      try { fs.unlinkSync(path.join(CLIENTS_DIR, sub + '.json')); } catch (e) { /* already gone */ }
    }
    fs.writeFileSync(troyPath, troyOriginal);
  }

  check('10 fixtures cleaned up', FIXTURES.every((s) => !fs.existsSync(path.join(CLIENTS_DIR, s + '.json'))));

  if (failures) { console.log(failures + ' FAILURE(S)'); process.exit(1); }
  console.log('ALL client kill-switch regression tests PASS');
})().catch((e) => {
  // Best-effort cleanup on harness failure, then report.
  try {
    for (const sub of FIXTURES) { try { fs.unlinkSync(path.join(CLIENTS_DIR, sub + '.json')); } catch (err) {} }
    fs.writeFileSync(troyPath, troyOriginal);
  } catch (err) {}
  console.log('FAIL harness threw: ' + (e && e.stack || e));
  process.exit(1);
});

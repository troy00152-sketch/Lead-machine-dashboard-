// Regression tests for the Resale Clients admin — kill switch v2
// (Nov 19, 2026): Troy flips a white-label client LIVE from his own
// Command Center (clients-admin.html -> client-admin.js) instead of
// editing clients/{subdomain}.json + redeploying. The flip writes an
// override { active, at, by } to the dynamic status store
// (lib-client-status.js); client-config.js and cc-data.js consult it
// per request and lib-client.js effectiveSuspended decides:
//   live override  >  config "active" flag (the default)
// Fail-safe: a store read failure falls back to the config flag — it
// can neither fail open for a config-suspended client nor suspend
// anyone on its own. HARD SAFETY (unchanged from v1): Troy's own
// account can never be suspended at any layer, and client-admin.js
// refuses to even write an override for him.
// Run: node client-admin-regression.js (exit non-zero on failure)
// No live calls: the Blobs module is swapped for an in-memory fake
// via lib-client-status._setBlobs (the codebase's test-hook pattern);
// fixture clients are written to clients/ for the run (production
// shapes, same fields as clients/_template.json) and removed after.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CLIENTS_DIR = path.join(ROOT, 'clients');
const FN_DIR = path.join(ROOT, 'netlify', 'functions');
const LIB_PATH = path.join(FN_DIR, 'lib-client.js');
const STATUS_PATH = path.join(FN_DIR, 'lib-client-status.js');
const CLIENT_CONFIG_PATH = path.join(FN_DIR, 'client-config.js');
const CC_DATA_PATH = path.join(FN_DIR, 'cc-data.js');
const CLIENT_ADMIN_PATH = path.join(FN_DIR, 'client-admin.js');

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// Fresh module instances (lib-client caches parsed client files per
// instance). lib-client-status is NEVER cache-busted here: the fake
// Blobs module is installed on its single shared instance, and every
// function under test must see that same instance.
function freshLib() {
  delete require.cache[LIB_PATH];
  return require(LIB_PATH);
}
function freshClientConfig() {
  delete require.cache[CLIENT_CONFIG_PATH];
  delete require.cache[LIB_PATH];
  return require(CLIENT_CONFIG_PATH);
}
function freshCcData() {
  delete require.cache[CC_DATA_PATH];
  delete require.cache[LIB_PATH];
  return require(CC_DATA_PATH);
}
function freshClientAdmin() {
  delete require.cache[CLIENT_ADMIN_PATH];
  delete require.cache[LIB_PATH];
  return require(CLIENT_ADMIN_PATH);
}

// Production-shaped fixture client (same fields as clients/_template.json
// and clients/troy.json — fixtures must mirror production data shapes).
function fixtureClient(subdomain, activeField) {
  const cfg = {
    _comment: 'client-admin regression fixture — removed after the run',
    bot: { businessName: 'Fixture Realty LLC', fromNumbers: { indianapolis: '+13175550142' }, markets: ['indianapolis'] },
    buyers: { listId: '', source: 'shared-starter' },
    companyName: 'Fixture Realty LLC',
    highLevel: {
      apiTokenEnvVar: 'KSTEST2_HL_TOKEN',
      calendarId: 'kstest2-calendar-' + subdomain,
      locationId: 'kstest2-location-' + subdomain,
      webhookUrl: 'https://example.invalid/hooks/' + subdomain,
    },
    buyerSignerName: 'Fixture Signer',
    operator: { name: 'Fixture Operator', firstName: 'Fixture', lastName: 'Operator', email: 'op@example.invalid', phone: '+13175550142', phoneDigits: '13175550142' },
    logo: '/assets/fixture-logo.png',
    primaryColor: '#00d4ff',
    propertyReach: { apiKeyEnvVar: 'KSTEST2_PR_KEY' },
    subdomain,
  };
  if (activeField !== undefined) cfg.active = activeField;
  return cfg;
}

const FIXTURES = ['kstest2-active', 'kstest2-inactive'];
const GATE_SECRET = 'kstest2-gate-secret';

function adminCookie() {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const sig = crypto.createHmac('sha256', GATE_SECRET).update(expiry).digest('hex');
  return 'lm_auth=' + expiry + '.' + sig;
}
function adminPost(bodyObj) {
  return {
    httpMethod: 'POST',
    headers: { host: 'app.leadmachineapp.com', cookie: adminCookie(), 'Content-Type': 'application/json' },
    queryStringParameters: {},
    body: JSON.stringify(bodyObj),
  };
}
function adminGet() {
  return {
    httpMethod: 'GET',
    headers: { host: 'app.leadmachineapp.com', cookie: adminCookie() },
    queryStringParameters: { action: 'list' },
  };
}

(async () => {
  // In-memory fake Blobs (mirrors the real get/set JSON contract the
  // status module uses) + a throwing variant for the outage tests.
  const fakeMap = new Map();
  const fakeStore = {
    get: async (key) => (fakeMap.has(key) ? JSON.parse(fakeMap.get(key)) : null),
    set: async (key, val) => { fakeMap.set(key, String(val)); },
  };
  const fakeBlobs = { connectLambda: () => {}, getStore: () => fakeStore };
  const throwingBlobs = { connectLambda: () => {}, getStore: () => { throw new Error('status store unavailable (test)'); } };

  let prevBlobs;
  try {
    process.env.GATE_SECRET = GATE_SECRET;
    process.env.KSTEST2_HL_TOKEN = 'kstest2-token-value';
    process.env.HL_API_TOKEN = 'kstest2-fallback-token';

    fs.writeFileSync(path.join(CLIENTS_DIR, 'kstest2-active.json'), JSON.stringify(fixtureClient('kstest2-active', true), null, 2));
    fs.writeFileSync(path.join(CLIENTS_DIR, 'kstest2-inactive.json'), JSON.stringify(fixtureClient('kstest2-inactive', false), null, 2));

    const statusStore = require(STATUS_PATH);
    prevBlobs = statusStore._setBlobs(fakeBlobs);

    const admin = freshClientAdmin();

    // ---------- 1. Auth: every action is admin-only ----------
    {
      const noAuthGet = await admin.handler({ httpMethod: 'GET', headers: { host: 'app.leadmachineapp.com' }, queryStringParameters: { action: 'list' } });
      check('1a list without admin cookie -> 401', noAuthGet.statusCode === 401, 'status=' + noAuthGet.statusCode);
      const noAuthPost = await admin.handler({ httpMethod: 'POST', headers: { host: 'app.leadmachineapp.com' }, queryStringParameters: {}, body: JSON.stringify({ action: 'set', subdomain: 'demo', active: false }) });
      check('1b set without admin cookie -> 401', noAuthPost.statusCode === 401, 'status=' + noAuthPost.statusCode);
      const badCookie = await admin.handler({ httpMethod: 'POST', headers: { host: 'app.leadmachineapp.com', cookie: 'lm_auth=9999999999.deadbeef' }, queryStringParameters: {}, body: JSON.stringify({ action: 'set', subdomain: 'demo', active: false }) });
      check('1c set with forged cookie -> 401', badCookie.statusCode === 401, 'status=' + badCookie.statusCode);
      check('1d rejected writes stored nothing', fakeMap.size === 0, 'mapSize=' + fakeMap.size);
    }

    // ---------- 2. List: demo + fixtures + locked owner row ----------
    let listBody;
    {
      const res = await admin.handler(adminGet());
      listBody = JSON.parse(res.body);
      check('2a admin list -> 200 + storeOk', res.statusCode === 200 && listBody.ok === true && listBody.storeOk === true, res.body);
      const bySub = {};
      for (const c of listBody.clients || []) bySub[c.subdomain] = c;
      check('2b demo client listed (Summit Home Buyers, active)', !!bySub.demo && bySub.demo.companyName === 'Summit Home Buyers' && bySub.demo.effectiveStatus === 'active' && bySub.demo.owner === false, JSON.stringify(bySub.demo));
      check('2c owner row present, locked, active', !!bySub.troy && bySub.troy.owner === true && bySub.troy.locked === true && bySub.troy.effectiveStatus === 'active', JSON.stringify(bySub.troy));
      check('2d config-active fixture lists active, no override', !!bySub['kstest2-active'] && bySub['kstest2-active'].effectiveStatus === 'active' && bySub['kstest2-active'].override === null, JSON.stringify(bySub['kstest2-active']));
      check('2e config-inactive fixture lists suspended (config default)', !!bySub['kstest2-inactive'] && bySub['kstest2-inactive'].effectiveStatus === 'suspended' && bySub['kstest2-inactive'].configActive === false, JSON.stringify(bySub['kstest2-inactive']));
      check('2f internal files never listed as clients', !bySub._default && !bySub._template);
    }

    // ---------- 3. Config-inactive + no override stays suspended ----------
    {
      const cc = freshClientConfig();
      const body = JSON.parse((await cc.handler({ headers: { host: 'kstest2-inactive.leadmachineapp.com' } })).body);
      check('3a config-inactive, no override -> client-config suspended', body.accountStatus === 'suspended', JSON.stringify(body.accountStatus));
    }

    // ---------- 4. Live suspend of a config-active client ----------
    {
      const res = await admin.handler(adminPost({ action: 'set', subdomain: 'kstest2-active', active: false }));
      const body = JSON.parse(res.body);
      check('4a admin set suspend -> 200, row suspended with override', res.statusCode === 200 && body.client.effectiveStatus === 'suspended' && body.client.override && body.client.override.active === false, res.body);

      const cc = freshClientConfig();
      const cfgBody = JSON.parse((await cc.handler({ headers: { host: 'kstest2-active.leadmachineapp.com' } })).body);
      check('4b client-config now reports suspended + blanks links', cfgBody.accountStatus === 'suspended' && cfgBody.crmUrl === '' && cfgBody.ghlWebhookUrl === '', JSON.stringify(cfgBody.accountStatus));

      let fetchCalls = 0;
      const realFetch = global.fetch;
      global.fetch = async () => { fetchCalls++; throw new Error('network disabled in client-admin test'); };
      try {
        const ccData = freshCcData();
        const dres = await ccData.handler({
          httpMethod: 'GET',
          headers: { host: 'kstest2-active.leadmachineapp.com' },
          queryStringParameters: { action: 'overview' },
        });
        const dbody = JSON.parse(dres.body);
        check('4c cc-data overview for override-suspended client -> honest 400', dres.statusCode === 400 && dbody.ok === false && String(dbody.error).includes('unknown client'), 'status=' + dres.statusCode);
        check('4d cc-data made zero network calls', fetchCalls === 0, 'fetchCalls=' + fetchCalls);
      } finally {
        global.fetch = realFetch;
      }

      const lib = freshLib();
      const ev = { headers: { host: 'kstest2-active.leadmachineapp.com' } };
      check('4e resolver with override -> data null', lib.resolveClientData(ev, { active: false, at: Date.now(), by: 'owner dashboard' }) === null);
    }

    // ---------- 5. Live reactivate restores the client ----------
    {
      const res = await admin.handler(adminPost({ action: 'set', subdomain: 'kstest2-active', active: true }));
      check('5a admin set reactivate -> 200, row active', res.statusCode === 200 && JSON.parse(res.body).client.effectiveStatus === 'active', res.body);
      const cc = freshClientConfig();
      const cfgBody = JSON.parse((await cc.handler({ headers: { host: 'kstest2-active.leadmachineapp.com' } })).body);
      check('5b client-config reports active again', cfgBody.accountStatus === 'active' && cfgBody.crmUrl.includes('kstest2-location-kstest2-active'), JSON.stringify(cfgBody.accountStatus));
      const lib = freshLib();
      const data = lib.resolveClientData({ headers: { host: 'kstest2-active.leadmachineapp.com' } }, { active: true, at: Date.now(), by: 'owner dashboard' });
      check('5c resolver data flows again to the fixture location', !!data && data.locationId === 'kstest2-location-kstest2-active', JSON.stringify(data && data.locationId));
    }

    // ---------- 6. Override beats config BOTH ways; clear restores default ----------
    {
      const res = await admin.handler(adminPost({ action: 'set', subdomain: 'kstest2-inactive', active: true }));
      check('6a override reactivates a config-suspended client', res.statusCode === 200 && JSON.parse(res.body).client.effectiveStatus === 'active', res.body);
      const cc = freshClientConfig();
      const on = JSON.parse((await cc.handler({ headers: { host: 'kstest2-inactive.leadmachineapp.com' } })).body);
      check('6b client-config active despite config flag false', on.accountStatus === 'active', JSON.stringify(on.accountStatus));
      const cres = await admin.handler(adminPost({ action: 'clear', subdomain: 'kstest2-inactive' }));
      check('6c clear -> 200, row back to config verdict (suspended)', cres.statusCode === 200 && JSON.parse(cres.body).client.effectiveStatus === 'suspended' && JSON.parse(cres.body).client.override === null, cres.body);
      const off = JSON.parse((await cc.handler({ headers: { host: 'kstest2-inactive.leadmachineapp.com' } })).body);
      check('6d client-config suspended again after clear', off.accountStatus === 'suspended', JSON.stringify(off.accountStatus));
    }

    // ---------- 7. HARD SAFETY: Troy cannot be suspended ----------
    {
      const res = await admin.handler(adminPost({ action: 'set', subdomain: 'troy', active: false }));
      check('7a suspend-Troy attempt -> 403 refused', res.statusCode === 403, 'status=' + res.statusCode + ' body=' + res.body);
      const stored = fakeMap.has('overrides') ? JSON.parse(fakeMap.get('overrides')) : {};
      check('7b no override was written for Troy', !('troy' in stored), JSON.stringify(Object.keys(stored)));
      const cres = await admin.handler(adminPost({ action: 'clear', subdomain: 'troy' }));
      check('7c clear-Troy attempt -> 403 refused', cres.statusCode === 403, 'status=' + cres.statusCode);
      const lib = freshLib();
      const troyCfg = lib.loadClient('troy');
      check('7d resolver: Troy + hostile override -> NOT suspended', lib.effectiveSuspended(troyCfg, true, { active: false }) === false);
      // Even a forged store entry naming Troy changes nothing:
      // client-config never consults the store for Troy at all.
      fakeMap.set('overrides', JSON.stringify({ troy: { active: false, at: Date.now(), by: 'forged (test)' } }));
      const cc = freshClientConfig();
      const body = JSON.parse((await cc.handler({ headers: { host: 'app.leadmachineapp.com' } })).body);
      check('7e forged Troy override in store -> config still active + his branding', body.accountStatus === 'active' && body.companyName === 'Direct Property Buyers', JSON.stringify(body.accountStatus));
      fakeMap.set('overrides', JSON.stringify({ 'kstest2-active': { active: true, at: Date.now(), by: 'owner dashboard' } }));
    }

    // ---------- 8. Validation ----------
    {
      const unknown = await admin.handler(adminPost({ action: 'set', subdomain: 'nosuchclient', active: false }));
      check('8a set on unknown client -> 400', unknown.statusCode === 400, 'status=' + unknown.statusCode);
      const badType = await admin.handler(adminPost({ action: 'set', subdomain: 'demo', active: 'yes' }));
      check('8b set with non-boolean active -> 400', badType.statusCode === 400, 'status=' + badType.statusCode);
      const internal = await admin.handler(adminPost({ action: 'set', subdomain: '_default', active: false }));
      check('8c set on the neutral default -> 400', internal.statusCode === 400, 'status=' + internal.statusCode);
    }

    // ---------- 9. Store outage: fail-safe fallback, honest admin errors ----------
    {
      statusStore._setBlobs(throwingBlobs);
      try {
        const cc = freshClientConfig();
        const activeBody = JSON.parse((await cc.handler({ headers: { host: 'kstest2-active.leadmachineapp.com' } })).body);
        check('9a store down: config-active client stays active (no false suspension)', activeBody.accountStatus === 'active', JSON.stringify(activeBody.accountStatus));
        const inactiveBody = JSON.parse((await cc.handler({ headers: { host: 'kstest2-inactive.leadmachineapp.com' } })).body);
        check('9b store down: config-inactive client stays suspended (no fail-open)', inactiveBody.accountStatus === 'suspended', JSON.stringify(inactiveBody.accountStatus));
        const lres = await admin.handler(adminGet());
        const lbody = JSON.parse(lres.body);
        check('9c store down: list still answers, storeOk=false, config verdicts', lres.statusCode === 200 && lbody.storeOk === false, lres.body);
        const wres = await admin.handler(adminPost({ action: 'set', subdomain: 'demo', active: false }));
        check('9d store down: admin write -> honest 503, not a fake success', wres.statusCode === 503, 'status=' + wres.statusCode);
      } finally {
        statusStore._setBlobs(fakeBlobs);
      }
    }

    // ---------- 10. Wiring: resolver precedence + page + nav ----------
    {
      const libSrc = fs.readFileSync(LIB_PATH, 'utf8');
      check('10a lib-client exports the precedence helper', libSrc.includes('function effectiveSuspended') && libSrc.includes('effectiveSuspended,'));
      check('10b resolveClientData passes the override through', libSrc.includes('resolveClient(event, override)'));
      const ccDataSrc = fs.readFileSync(CC_DATA_PATH, 'utf8');
      check('10c cc-data consults the store once per request', ccDataSrc.includes("require('./lib-client-status')") && ccDataSrc.includes('statusOverride = await getOverride(event, baseClient.subdomain)'));
      const ccSrc = fs.readFileSync(CLIENT_CONFIG_PATH, 'utf8');
      check('10d client-config consults the store for real clients', ccSrc.includes("require('./lib-client-status')") && ccSrc.includes('getOverride(event, base.subdomain)'));
      const adminSrc = fs.readFileSync(CLIENT_ADMIN_PATH, 'utf8');
      check('10e client-admin refuses the owner subdomain', adminSrc.includes('The owner account cannot be suspended.'));
      check('10f client-admin uses the lm_auth cookie gate', adminSrc.includes("COOKIE_NAME = 'lm_auth'") && adminSrc.includes('function isAdmin(event)'));

      const page = fs.readFileSync(path.join(ROOT, 'clients-admin.html'), 'utf8');
      check('10g admin page calls the admin function (list + set + clear)', page.includes('/.netlify/functions/client-admin') && page.includes("'?action=list'") && page.includes("action: 'set'") && page.includes("action: 'clear'"));
      check('10h admin page confirms before a flip', page.includes('confirm(') && page.includes('Suspend ') && page.includes('Restore service'));
      check('10i admin page re-renders from the function response', page.includes('function render(data)') && page.includes('return load();'));
      const stripped = page.replace(/\/\.netlify\/functions\/[a-z-]+/g, '');
      check('10j admin page visible text is vendor-free', !/HighLevel|GoHighLevel|Netlify|PropertyReach|Realie|Telnyx|Grok|xAI|Twilio/.test(stripped));
      for (const host of ['index.html', 'command-center.html']) {
        const html = fs.readFileSync(path.join(ROOT, host), 'utf8');
        check('10k ' + host + ' nav links the Resale Clients screen', html.includes('href="/clients-admin.html"') && html.includes('Resale Clients'));
      }
    }
  } finally {
    if (prevBlobs !== undefined) {
      try { require(STATUS_PATH)._setBlobs(prevBlobs); } catch (e) { /* best effort */ }
    }
    for (const sub of FIXTURES) {
      try { fs.unlinkSync(path.join(CLIENTS_DIR, sub + '.json')); } catch (e) { /* already gone */ }
    }
  }

  check('11 fixtures cleaned up', FIXTURES.every((s) => !fs.existsSync(path.join(CLIENTS_DIR, s + '.json'))));

  if (failures) { console.log(failures + ' FAILURE(S)'); process.exit(1); }
  console.log('ALL client admin regression tests PASS');
})().catch((e) => {
  try {
    for (const sub of FIXTURES) { try { fs.unlinkSync(path.join(CLIENTS_DIR, sub + '.json')); } catch (err) {} }
  } catch (err) {}
  console.log('FAIL harness threw: ' + (e && e.stack || e));
  process.exit(1);
});

'use strict';
/*
 * conversation-ai-regression.js — the Conversation AI screen
 * (conversation-ai.html): the white-label/resale bot setup screen
 * Troy ordered Nov 19, 2026, mirroring the CRM's Conversation AI
 * setup — bot status & mode, knowledge base, bot instructions,
 * booking rules, guardrails.
 *
 * Covers:
 *   A. Knowledge base defaults: the REAL 31 starter FAQs, compared
 *      verbatim against knowledge/kb.json (which is generated from
 *      your_files/ashley-kb-faqs.md) — n 1..31, exact question and
 *      answer text, no extras, no drops.
 *   B. Pure logic (extracted from the page): tenant derivation from
 *      host (mirrors the server-side host rules), per-tenant storage
 *      namespacing + isolation, bot sanitize/state, FAQ CRUD +
 *      search + restore, instructions defaults + edit persistence,
 *      booking defaults (Seller Calls, 3 days / 3 slots / 3h apart)
 *      + clamping, guardrail defaults + toggle persistence.
 *   C. Branding from PRODUCTION client files (clients/demo.json is
 *      the Summit Home Buyers demo tenant, clients/_default.json the
 *      neutral one) — fixtures mirror the production config shape
 *      (companyName / primaryColor / subdomain, operator as an
 *      OBJECT), never invented shapes.
 *   D. Page wiring: sections, controls, endpoints, persistence calls.
 *   E. White-label scrub: no vendor/provider names in visible text.
 *   F. Sidebar: the Conversation AI nav entry in index.html (sidebar
 *      nav-item like Contacts, between Contacts and Calendar) and
 *      the new page's own active topbar entry.
 *
 * This screen is a config/view layer only: it must NOT reference the
 * live bot function or any send path. Fixtures only — no network.
 * Run: node conversation-ai-regression.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const readPage = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const readJson = (name) => JSON.parse(readPage(name));

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS ' + name);
  } catch (e) {
    failed += 1;
    failures.push(name + ': ' + e.message);
    console.log('  FAIL ' + name + ' — ' + e.message);
  }
}

function fakeStorage() {
  return {
    data: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
    setItem(k, v) { this.data[k] = String(v); },
    removeItem(k) { delete this.data[k]; },
  };
}

(async () => {
  const html = readPage('conversation-ai.html');
  const m = html.match(/\/\* ==PURE== \*\/([\s\S]*?)\/\* ==\/PURE== \*\//);
  assert.ok(m, 'pure block markers present');
  const P = new Function(m[1] + '; return { CAI_PREFIX, BOT_MODES, caiTenantFromHost, caiKey, caiBrandFromConfig, caiDefaultBots, caiSanitizeBots, caiLoadBots, caiSaveBots, caiBotState, CAI_DEFAULT_FAQS, caiDefaultFaqs, caiLoadFaqs, caiSaveFaqs, caiAddFaq, caiUpdateFaq, caiDeleteFaq, caiSearchFaqs, caiRestoreFaqs, caiDefaultInstructions, caiLoadInstructions, caiSaveInstructions, caiDefaultBooking, caiSanitizeBooking, caiLoadBooking, caiSaveBooking, caiDefaultGuardrails, caiLoadGuardrails, caiSaveGuardrails };')();

  console.log('— A. Knowledge base defaults = the real 31 FAQs —');
  const kb = readJson('knowledge/kb.json');
  const kb31 = kb.faqs.filter((f) => f.n >= 1 && f.n <= 31);
  await check('kb.json source itself carries exactly 31 starter FAQs (n 1..31)', async () => {
    assert.strictEqual(kb31.length, 31);
    assert.deepStrictEqual(kb31.map((f) => f.n), Array.from({ length: 31 }, (_, i) => i + 1));
  });
  await check('page defaults match kb.json verbatim (question + answer, in order)', async () => {
    assert.strictEqual(P.CAI_DEFAULT_FAQS.length, 31);
    kb31.forEach((src, i) => {
      const d = P.CAI_DEFAULT_FAQS[i];
      assert.strictEqual(d.n, src.n, 'n at index ' + i);
      assert.strictEqual(d.question, src.question, 'question ' + src.n);
      assert.strictEqual(d.answer, src.answer, 'answer ' + src.n);
    });
  });
  await check('no kb.json extras leak into the starter set (objections stay out)', async () => {
    assert.ok(!P.CAI_DEFAULT_FAQS.some((f) => f.n > 31), 'nothing past FAQ 31');
    assert.ok(!P.CAI_DEFAULT_FAQS.some((f) => /carrier-filter rule/.test(f.question)), 'the later carrier add-on is not a starter FAQ');
  });
  await check('caiDefaultFaqs returns an independent copy', async () => {
    const a = P.caiDefaultFaqs();
    a[0].question = 'MUTATED';
    assert.notStrictEqual(P.caiDefaultFaqs()[0].question, 'MUTATED');
    assert.strictEqual(P.caiLoadFaqs(fakeStorage(), 'demo').length, 31, 'empty storage loads the starter set');
  });

  console.log('— B. Pure logic —');
  await check('tenant from host mirrors the server host rules', async () => {
    assert.strictEqual(P.caiTenantFromHost('demo.leadmachineapp.com'), 'demo');
    assert.strictEqual(P.caiTenantFromHost('acme.leadmachineapp.com'), 'acme');
    assert.strictEqual(P.caiTenantFromHost('leadmachineapp.com'), 'troy');
    assert.strictEqual(P.caiTenantFromHost('www.leadmachineapp.com'), 'troy');
    assert.strictEqual(P.caiTenantFromHost('app.leadmachineapp.com'), 'troy');
    assert.strictEqual(P.caiTenantFromHost('localhost:8888'), 'troy');
    assert.strictEqual(P.caiTenantFromHost('preview--site.netlify.app'), 'troy');
    assert.strictEqual(P.caiTenantFromHost('stranger.example.com'), '_default');
    assert.strictEqual(P.caiTenantFromHost('a.b.leadmachineapp.com'), '_default');
    assert.strictEqual(P.caiTenantFromHost(''), 'troy');
  });
  await check('storage keys are namespaced per tenant', async () => {
    assert.strictEqual(P.CAI_PREFIX, 'acc_conv_ai_');
    assert.strictEqual(P.caiKey('demo', 'bots'), 'acc_conv_ai_demo_bots');
    assert.strictEqual(P.caiKey('troy', 'faqs'), 'acc_conv_ai_troy_faqs');
    assert.notStrictEqual(P.caiKey('demo', 'bots'), P.caiKey('troy', 'bots'));
  });
  await check('bots: defaults are Ashley + Sam, on, Auto-Pilot', async () => {
    assert.deepStrictEqual(P.caiDefaultBots(), { ashley: { on: true, mode: 'auto' }, sam: { on: true, mode: 'auto' } });
    assert.deepStrictEqual(P.BOT_MODES, ['auto', 'suggest', 'off']);
    assert.deepStrictEqual(P.caiLoadBots(fakeStorage(), 'demo'), P.caiDefaultBots());
  });
  await check('bots: save/load round-trips per tenant, isolated', async () => {
    const st = fakeStorage();
    P.caiSaveBots(st, 'demo', { ashley: { on: false, mode: 'suggest' }, sam: { on: true, mode: 'auto' } });
    const demo = P.caiLoadBots(st, 'demo');
    assert.deepStrictEqual(demo.ashley, { on: false, mode: 'suggest' });
    assert.deepStrictEqual(P.caiLoadBots(st, 'troy'), P.caiDefaultBots(), 'owner account untouched by demo edits');
    assert.ok(st.data['acc_conv_ai_demo_bots'], 'persisted under the demo key');
  });
  await check('bots: sanitize coerces junk modes and non-boolean on', async () => {
    const out = P.caiSanitizeBots({ ashley: { on: 'yes', mode: 'turbo' }, sam: null });
    assert.deepStrictEqual(out, P.caiDefaultBots());
    assert.deepStrictEqual(P.caiSanitizeBots(null), P.caiDefaultBots());
    assert.deepStrictEqual(P.caiSanitizeBots('junk'), P.caiDefaultBots());
  });
  await check('bot state line: Off wins, Suggest and Auto-Pilot labeled', async () => {
    assert.strictEqual(P.caiBotState({ on: true, mode: 'auto' }), 'On · Auto-Pilot');
    assert.strictEqual(P.caiBotState({ on: true, mode: 'suggest' }), 'On · Suggest');
    assert.strictEqual(P.caiBotState({ on: false, mode: 'auto' }), 'Off');
    assert.strictEqual(P.caiBotState({ on: true, mode: 'off' }), 'Off');
  });
  await check('FAQs: add / update / delete / search via storage helpers', async () => {
    const st = fakeStorage();
    let faqs = P.caiLoadFaqs(st, 'demo');
    const added = P.caiAddFaq(faqs, 'Do you handle condos?', 'Yes — condos work the same way.');
    assert.ok(added && added.entry.id);
    faqs = P.caiSaveFaqs(st, 'demo', added.faqs);
    assert.strictEqual(faqs.length, 32);
    assert.strictEqual(P.caiLoadFaqs(st, 'demo').length, 32, 'persisted');
    assert.strictEqual(P.caiAddFaq(faqs, '  ', 'x'), null, 'blank question refused');
    assert.strictEqual(P.caiAddFaq(faqs, 'x', ' '), null, 'blank answer refused');
    const upd = P.caiUpdateFaq(faqs, added.entry.id, 'Do you handle condos and townhomes?', 'Yes — both work the same way.');
    assert.strictEqual(upd.find((f) => f.id === added.entry.id).question, 'Do you handle condos and townhomes?');
    assert.strictEqual(P.caiUpdateFaq(faqs, 'no-such-id', 'q', 'a'), null, 'unknown id refused');
    assert.strictEqual(P.caiSearchFaqs(upd, 'condos').length, 1);
    assert.strictEqual(P.caiSearchFaqs(upd, 'back taxes').length, 1, 'search hits starter answers too');
    assert.strictEqual(P.caiSearchFaqs(upd, '').length, 32, 'empty search returns all');
    const afterDel = P.caiDeleteFaq(upd, added.entry.id);
    assert.strictEqual(afterDel.length, 31);
  });
  await check('FAQs: restore brings back the original 31 after edits', async () => {
    const st = fakeStorage();
    let faqs = P.caiLoadFaqs(st, 'demo');
    faqs = P.caiDeleteFaq(faqs, faqs[0].id);
    faqs = P.caiDeleteFaq(faqs, faqs[0].id);
    P.caiSaveFaqs(st, 'demo', faqs);
    assert.strictEqual(P.caiLoadFaqs(st, 'demo').length, 29);
    const restored = P.caiRestoreFaqs(st, 'demo');
    assert.strictEqual(restored.length, 31);
    assert.deepStrictEqual(restored.map((f) => f.question), kb31.map((f) => f.question));
    assert.strictEqual(P.caiLoadFaqs(st, 'demo').length, 31, 'restore persisted');
    assert.strictEqual(P.caiLoadFaqs(st, 'troy').length, 31, 'other tenant still on its own copy');
  });
  await check('instructions: defaults carry the operative rules in plain language', async () => {
    const sections = P.caiDefaultInstructions();
    const byId = {};
    sections.forEach((s) => { byId[s.id] = s; });
    for (const id of ['role', 'job', 'flow', 'numbers', 'walkaway', 'booking', 'optout', 'language', 'buyers', 'hours']) {
      assert.ok(byId[id], 'missing section ' + id);
      assert.ok(byId[id].title && byId[id].body.length > 80, id + ' has a title and a real body');
    }
    assert.ok(/MOTIVATION/.test(byId.flow.body) && /TIMEFRAME/.test(byId.flow.body) && /PRICE/.test(byId.flow.body), 'MCTP flow present');
    assert.ok(/ZERO output/.test(byId.optout.body), 'opt-out total silence present');
    assert.ok(/never negotiates the final number/i.test(byId.job.body), 'no-negotiation rule present');
    assert.ok(/Seller Calls calendar/.test(byId.booking.body), 'booking names the Seller Calls calendar');
    assert.ok(/buy box/.test(byId.buyers.body), 'buyer path present');
  });
  await check('instructions: edits persist per tenant, unknown ids dropped, missing sections fall back', async () => {
    const st = fakeStorage();
    const edited = P.caiDefaultInstructions().map((s) => ({ id: s.id, body: s.body }));
    edited.find((s) => s.id === 'role').body = 'Custom role text for the demo account.';
    edited.push({ id: 'hacker-section', body: 'should be dropped' });
    const saved = P.caiSaveInstructions(st, 'demo', edited);
    assert.strictEqual(saved.find((s) => s.id === 'role').body, 'Custom role text for the demo account.');
    assert.ok(!saved.some((s) => s.id === 'hacker-section'), 'unknown section ids are not stored');
    assert.strictEqual(P.caiLoadInstructions(st, 'demo').find((s) => s.id === 'role').body, 'Custom role text for the demo account.', 'reload sees the edit');
    assert.notStrictEqual(P.caiLoadInstructions(st, 'troy').find((s) => s.id === 'role').body, 'Custom role text for the demo account.', 'owner account keeps its own wording');
    const partial = P.caiSaveInstructions(st, 'acme', [{ id: 'hours', body: 'Only 9 to 5.' }]);
    assert.strictEqual(partial.find((s) => s.id === 'hours').body, 'Only 9 to 5.');
    assert.strictEqual(partial.find((s) => s.id === 'role').body, P.caiDefaultInstructions()[0].body, 'untouched sections fall back to defaults');
  });
  await check('booking: defaults are Seller Calls, 3 days, 3 slots, 3 hours apart', async () => {
    assert.deepStrictEqual(P.caiDefaultBooking(), { calendar: 'Seller Calls', windowDays: 3, slots: 3, minGapHours: 3, hoursStart: '08:00', hoursEnd: '21:00', callMinutes: 30 });
    assert.deepStrictEqual(P.caiLoadBooking(fakeStorage(), 'demo'), P.caiDefaultBooking());
  });
  await check('booking: save/load round-trips and sanitize clamps junk', async () => {
    const st = fakeStorage();
    P.caiSaveBooking(st, 'demo', { calendar: 'Seller Calls', windowDays: 5, slots: 2, minGapHours: 4, hoursStart: '09:00', hoursEnd: '20:00', callMinutes: 45 });
    assert.deepStrictEqual(P.caiLoadBooking(st, 'demo'), { calendar: 'Seller Calls', windowDays: 5, slots: 2, minGapHours: 4, hoursStart: '09:00', hoursEnd: '20:00', callMinutes: 45 });
    const clamped = P.caiSanitizeBooking({ windowDays: 99, slots: 0, minGapHours: -3, hoursStart: 'nine', callMinutes: 'x' });
    assert.strictEqual(clamped.windowDays, 14);
    assert.strictEqual(clamped.slots, 1);
    assert.strictEqual(clamped.minGapHours, 0);
    assert.strictEqual(clamped.hoursStart, '08:00');
    assert.strictEqual(clamped.callMinutes, 30);
    assert.strictEqual(P.caiSanitizeBooking({ calendar: '  ' }).calendar, 'Seller Calls', 'blank calendar falls back');
  });
  await check('guardrails: the standing seal rules ship on, in plain language', async () => {
    const g = P.caiDefaultGuardrails();
    assert.deepStrictEqual(g.map((x) => x.id), ['optout', 'big-ask', 'over-mao', 'referral', 'booked', 'listed']);
    assert.ok(g.every((x) => x.on === true), 'all on by default');
    const byId = {};
    g.forEach((x) => { byId[x.id] = x; });
    assert.ok(/\$500K\+ ask/.test(byId['big-ask'].title) && /written out in words/.test(byId['big-ask'].desc), '$500K rule covers every typed format');
    assert.ok(/2×/.test(byId['over-mao'].title), '2x max-allowable rule present');
    assert.ok(/ONE short acknowledgment/.test(byId.referral.desc), 'owner-referral ack present');
    assert.ok(/Booked = silence/.test(byId.booked.title), 'booked silence present');
    assert.ok(/Listed = pass/.test(byId.listed.title) && /expired listing is not/.test(byId.listed.desc), 'listed pass present');
  });
  await check('guardrails: toggles persist per tenant', async () => {
    const st = fakeStorage();
    const g = P.caiLoadGuardrails(st, 'demo');
    g.find((x) => x.id === 'listed').on = false;
    P.caiSaveGuardrails(st, 'demo', g);
    assert.strictEqual(P.caiLoadGuardrails(st, 'demo').find((x) => x.id === 'listed').on, false);
    assert.strictEqual(P.caiLoadGuardrails(st, 'demo').find((x) => x.id === 'booked').on, true, 'other guardrails untouched');
    assert.strictEqual(P.caiLoadGuardrails(st, 'troy').find((x) => x.id === 'listed').on, true, 'owner account untouched');
  });

  console.log('— C. Branding from production client files —');
  await check('demo tenant (Summit Home Buyers) drives name + orange accent', async () => {
    const demo = readJson('clients/demo.json');
    // Production shape sanity: operator is an OBJECT, branding fields flat.
    assert.strictEqual(typeof demo.operator, 'object');
    assert.ok('companyName' in demo && 'primaryColor' in demo && 'subdomain' in demo);
    const brand = P.caiBrandFromConfig({ companyName: demo.companyName, primaryColor: demo.primaryColor, subdomain: demo.subdomain });
    assert.strictEqual(brand.name, 'Summit Home Buyers');
    assert.strictEqual(brand.color, '#ff7a1a');
    assert.strictEqual(brand.subdomain, 'demo');
  });
  await check('neutral default config yields neutral branding, never the owner brand', async () => {
    const neutral = readJson('clients/_default.json');
    const brand = P.caiBrandFromConfig({ companyName: neutral.companyName, primaryColor: neutral.primaryColor, subdomain: neutral.subdomain });
    assert.strictEqual(brand.name, 'Command Center');
    assert.notStrictEqual(brand.name, 'Direct Property Buyers');
    assert.deepStrictEqual(P.caiBrandFromConfig(null), { name: 'Command Center', color: '#ff6b1a', subdomain: '' });
    assert.deepStrictEqual(P.caiBrandFromConfig({}), { name: 'Command Center', color: '#ff6b1a', subdomain: '' });
  });

  console.log('— D. Page wiring —');
  await check('page structure: all five sections + controls present', async () => {
    for (const needle of ['Bot status &amp; mode', 'Knowledge Base', 'Bot instructions', 'Booking', 'Guardrails',
      'id="ashleyOn"', 'id="ashleyMode"', 'id="samOn"', 'id="samMode"',
      'id="kbSearch"', 'id="kbList"', 'id="btnAddFaq"', 'id="btnRestoreFaqs"',
      'id="instrList"', 'id="btnSaveInstr"', 'id="btnResetInstr"',
      'id="bkCalendar"', 'id="bkWindow"', 'id="bkSlots"', 'id="bkGap"', 'id="bkStart"', 'id="bkEnd"',
      'id="guardList"', 'Auto-Pilot', 'Suggest', 'Seller Calls']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
  });
  await check('both bots offer all three modes (Auto-Pilot / Suggest / Off)', async () => {
    for (const sel of ['ashleyMode', 'samMode']) {
      const start = html.indexOf('id="' + sel + '"');
      const block = html.slice(start, html.indexOf('</select>', start));
      for (const v of ['value="auto"', 'value="suggest"', 'value="off"']) {
        assert.ok(block.includes(v), sel + ' missing ' + v);
      }
    }
  });
  await check('page persists through the pure helpers into localStorage, per tenant', async () => {
    for (const needle of ['caiLoadBots(localStorage, TENANT)', 'caiSaveBots(localStorage, TENANT', 'caiLoadFaqs(localStorage, TENANT)', 'caiSaveFaqs(localStorage, TENANT', 'caiRestoreFaqs(localStorage, TENANT)', 'caiSaveInstructions(localStorage, TENANT', 'caiSaveBooking(localStorage, TENANT', 'caiSaveGuardrails(localStorage, TENANT', 'caiTenantFromHost(location.hostname)']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
  });
  await check('branding hook: account config fetch, suspended gate, accent applied', async () => {
    assert.ok(html.includes("fetch('/.netlify/functions/client-config'"), 'client-config fetch');
    assert.ok(html.includes("cfg.accountStatus === 'suspended'"), 'kill-switch gate like the other pages');
    assert.ok(html.includes('Account Inactive'), 'inactive notice');
    assert.ok(html.includes("setProperty('--accent', brand.color)"), 'tenant color applied');
    assert.ok(html.includes('id="brandName"'), 'tenant name slot');
  });
  await check('config/view layer only: no bot engine, no send path, no workflow wiring', async () => {
    for (const banned of ['bot/src', 'cc-workflow-engine', 'cc-conversations-api', 'sendSms', 'twilio', 'messagebird']) {
      assert.ok(!html.toLowerCase().includes(banned), 'page must not reference ' + banned);
    }
  });

  console.log('— E. White-label scrub —');
  await check('no vendor/provider names anywhere in the page (outside the config endpoint path)', async () => {
    const scrubbed = html.split('/.netlify/functions/client-config').join('');
    for (const name of ['HighLevel', 'GoHighLevel', 'Telnyx', 'Netlify', 'Grok', 'PropertyReach', 'Realie', 'Resideline', 'ATTOM', 'leadconnectorhq']) {
      assert.ok(!scrubbed.includes(name), 'vendor name leaked: ' + name);
    }
  });

  console.log('— F. Sidebar wiring —');
  await check('index.html: Conversation AI nav-item between Contacts and Calendar', async () => {
    const idx = readPage('index.html');
    const contacts = idx.indexOf('href="/contacts.html"');
    const convai = idx.indexOf('href="/conversation-ai.html"');
    const cal = idx.indexOf('href="/calendar.html"');
    assert.ok(contacts > -1 && convai > contacts, 'Conversation AI must follow Contacts in the sidebar');
    assert.ok(cal > convai, 'Conversation AI must sit before Calendar');
    const anchor = idx.slice(idx.lastIndexOf('<a', convai), idx.indexOf('</a>', convai));
    assert.ok(anchor.includes('class="nav-item"'), 'entry must be a sidebar nav-item like Contacts');
    assert.ok(anchor.includes('🤖'), 'entry carries its icon');
    assert.ok(anchor.includes('Conversation AI'), 'entry labeled Conversation AI');
  });
  await check('conversation-ai.html: its own topbar entry is the active one', async () => {
    assert.ok(html.includes('class="back active" href="/conversation-ai.html"'), 'active self entry');
    assert.ok(html.includes('href="/command-center.html"'), 'Command Center link');
    assert.ok(html.includes('href="/index.html"'), 'Dashboard link');
  });
  await check('clients-admin.html pattern respected: page stands alone with the same shell tokens', async () => {
    // contacts.html shell tokens the new page shares (dark theme vars).
    for (const token of ['--bg:#0d1117', '--panel:#161b22', '--accent:#ff6b1a', '.topbar', '.card', '.toast']) {
      assert.ok(html.includes(token), 'missing shell token ' + token);
    }
  });

  console.log('');
  console.log('conversation-ai-regression: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL CONVERSATION AI CHECKS PASS');
})().catch((e) => {
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

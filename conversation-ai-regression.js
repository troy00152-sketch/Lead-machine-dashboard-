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
 *      against knowledge/kb.json (which is generated from
 *      your_files/ashley-kb-faqs.md) — n 1..31, exact question text
 *      and answer text with the shipped text-bot name rendered as
 *      Amber (Troy, Nov 26, 2026 — the bot stays Amber; kb.json
 *      stays Ashley-canonical, the page renders the Amber name),
 *      no extras, no drops.
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
 *   G. Starter-set company name (Troy, Nov 19): the name inside the
 *      starter answers comes from each account's OWN setup — the
 *      owner account renders kb.json verbatim, any other account
 *      renders its configured name with zero trace of the owner's,
 *      restore respects the name, and a saved edit always wins
 *      untouched over the swap.
 *   H. Personalize + test (Troy, Nov 19 follow-on): editable bot
 *      names (persist, sanitize, restore defaults), the voice
 *      library selection + greeting + browser-voice picking, and
 *      the in-screen test engine — KB match, booking offers from
 *      the screen's own rule, opt-out silence, $500K+ silence in
 *      every typed format, in-character default, renamed bots
 *      reflected in replies.
 *   I. Bot picker + voice library wiring (Troy, Nov 19 follow-on):
 *      added bot profiles (add / edit / remove, originals
 *      structurally protected), the selected bot persisting and
 *      driving the test panel, per-voice Listen + Select rows.
 *   J. Bot avatars (Troy, Nov 19 follow-on): every bot has a face —
 *      at least 8 built-in illustrated portraits drawn as inline
 *      SVG (self-contained, no external assets) plus an Initials
 *      option in the account accent; selection persists per tenant
 *      per bot (originals in the avatars store, added profiles on
 *      the profile); defaults are the first portrait for the text
 *      bot and the headset portrait for the voice bot; avatars
 *      render on picker cards, editor cards, and test replies,
 *      and a rename updates the Initials avatar.
 *   K. Voice-call test mode (Troy, Nov 19 follow-on): the Test
 *      your bot panel also rehearses a voice bot by call — a
 *      Text | Voice call toggle (voice gated to voice bots), the
 *      bot speaks its greeting and its replies through the same
 *      style→voice path as the Listen buttons, spoken utterances
 *      run through the SAME single test exchange as typed tests
 *      (guardrail silence is never spoken), a transcript lands in
 *      the log, and the fallbacks are honest (no speech input →
 *      hear-the-bot typing mode, no speech at all → note, mic
 *      blocked → note, no crash). Browser-only: no network, no
 *      phone line, no send path.
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
  const P = new Function(m[1] + '; return { CAI_PREFIX, BOT_MODES, caiTenantFromHost, caiKey, caiBrandFromConfig, caiDefaultBots, caiSanitizeBots, caiLoadBots, caiSaveBots, caiBotState, CAI_DEFAULT_FAQS, caiDefaultFaqs, CAI_SOURCE_COMPANY, caiSwapCompanyName, caiStarterFaqs, caiLoadFaqs, caiSaveFaqs, caiAddFaq, caiUpdateFaq, caiDeleteFaq, caiSearchFaqs, caiRestoreFaqs, caiDefaultInstructions, caiLoadInstructions, caiSaveInstructions, caiDefaultBooking, caiSanitizeBooking, caiLoadBooking, caiSaveBooking, caiDefaultGuardrails, caiLoadGuardrails, caiSaveGuardrails, CAI_BOT_NAME_MAX, caiDefaultBotNames, caiSanitizeBotName, caiSanitizeBotNames, caiLoadBotNames, caiSaveBotNames, caiRestoreBotNames, CAI_RESERVED_BOT_IDS, CAI_CHANNELS, caiSanitizeProfiles, caiLoadProfiles, caiSaveProfiles, caiAddProfile, caiUpdateProfile, caiRemoveProfile, caiAllBots, caiValidSelected, caiLoadSelected, caiSaveSelected, CAI_AVATAR_OPTIONS, CAI_PHOTO_AVATARS, caiPhotoAvatar, CAI_AVATAR_INITIALS, caiAvatarOption, caiHeadsetAvatarId, caiDefaultAvatar, caiSanitizeAvatarSel, caiDefaultAvatars, caiSanitizeAvatars, caiLoadAvatars, caiSaveAvatars, caiAvatarInitial, caiAvatarSvg, CAI_VOICE_OPTIONS, caiDefaultVoiceSel, caiVoiceOption, caiSanitizeVoiceSel, caiLoadVoice, caiSaveVoice, caiVoiceLabel, caiGreeting, caiPickSpeechVoice, caiNormText, caiTokens, caiMatchFaq, caiIsOptOut, caiIsBookingIntent, caiParseMoneyAsk, caiOfferTimes, caiBookingReply, caiSwapPersona, caiDefaultReply, caiTestReply };')();

  console.log('— A. Knowledge base defaults = the real 31 FAQs —');
  const kb = readJson('knowledge/kb.json');
  const kb31 = kb.faqs.filter((f) => f.n >= 1 && f.n <= 31);
  // The page's starter set renders the shipped text-bot name Amber
  // (Troy, Nov 26, 2026); kb.json stays Ashley-canonical and the
  // live bot swaps at load. Questions stay verbatim either way.
  const kb31Amber = kb31.map((f) => ({ ...f, answer: f.answer.replace(/\bAshley\b/g, 'Amber') }));
  await check('kb.json source itself carries exactly 31 starter FAQs (n 1..31)', async () => {
    assert.strictEqual(kb31.length, 31);
    assert.deepStrictEqual(kb31.map((f) => f.n), Array.from({ length: 31 }, (_, i) => i + 1));
  });
  await check('page defaults match kb.json with the shipped text-bot name rendered as Amber (question + answer, in order)', async () => {
    assert.strictEqual(P.CAI_DEFAULT_FAQS.length, 31);
    kb31.forEach((src, i) => {
      const d = P.CAI_DEFAULT_FAQS[i];
      assert.strictEqual(d.n, src.n, 'n at index ' + i);
      assert.strictEqual(d.question, src.question, 'question ' + src.n);
      assert.strictEqual(d.answer, kb31Amber[i].answer, 'answer ' + src.n);
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
  await check('bots: defaults are Amber + Sam, on, Auto-Pilot', async () => {
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
    assert.deepStrictEqual(P.caiDefaultBooking(), { calendar: 'Seller Calls', windowDays: 3, slots: 3, minGapHours: 3, hoursStart: '08:00', hoursEnd: '16:30', callMinutes: 30 });
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
    for (const needle of ['caiLoadBots(localStorage, TENANT)', 'caiSaveBots(localStorage, TENANT', 'caiLoadFaqs(localStorage, TENANT)', 'caiSaveFaqs(localStorage, TENANT', 'caiRestoreFaqs(localStorage, TENANT, BRAND_NAME)', 'caiSaveInstructions(localStorage, TENANT', 'caiSaveBooking(localStorage, TENANT', 'caiSaveGuardrails(localStorage, TENANT', 'caiTenantFromHost(location.hostname)']) {
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
  await check('layout: bot editor cards stack in a single column (no side-by-side columns, no blank space beside the shorter card)', async () => {
    const rules = html.match(/\.bot-grid\{[^}]*\}/g) || [];
    assert.ok(rules.length >= 1, 'bot-grid rule present');
    for (const r of rules) {
      assert.ok(!/1fr\s+1fr/.test(r), 'no bot-grid rule places editor cards side by side (the shorter card leaves a blank column): ' + r);
    }
    assert.ok(/grid-template-columns\s*:\s*1fr\s*;/.test(rules[0]), 'bot-grid is single-column so each editor card spans full width at its natural height');
    assert.ok(html.includes('class="bot-grid" id="addedBotGrid"'), 'added-bot grid uses the same bot-grid class and inherits the stacked layout');
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

  console.log('— G. Starter-set company name comes from each account\u2019s own setup —');
  await check('name swap: only the exact company-name strings change, LLC form first', async () => {
    assert.strictEqual(P.CAI_SOURCE_COMPANY, 'Direct Property Buyers');
    assert.strictEqual(
      P.caiSwapCompanyName('Direct Property Buyers LLC speaks for Direct Property Buyers.', 'Summit Home Buyers'),
      'Summit Home Buyers speaks for Summit Home Buyers.');
    assert.strictEqual(P.caiSwapCompanyName('No company name here.', 'Summit Home Buyers'), 'No company name here.');
    const src = kb31[0].answer;
    assert.strictEqual(P.caiSwapCompanyName(src, 'Direct Property Buyers'), src, 'owner name = identity swap');
    assert.strictEqual(P.caiSwapCompanyName(src, ''), src, 'no name = no swap, never guessed');
    assert.strictEqual(P.caiSwapCompanyName(src, null), src, 'missing name = no swap');
  });
  await check('owner account: starter set renders kb.json with the shipped name Amber (load + direct)', async () => {
    const viaLoad = P.caiLoadFaqs(fakeStorage(), 'troy', 'Direct Property Buyers');
    assert.strictEqual(viaLoad.length, 31);
    kb31.forEach((src, i) => {
      assert.strictEqual(viaLoad[i].question, src.question, 'owner question ' + src.n);
      assert.strictEqual(viaLoad[i].answer, kb31Amber[i].answer, 'owner answer ' + src.n + ' renders the Amber name');
    });
    assert.deepStrictEqual(P.caiStarterFaqs('Direct Property Buyers').map((f) => f.answer), kb31Amber.map((f) => f.answer));
    assert.deepStrictEqual(P.caiStarterFaqs('').map((f) => f.answer), kb31Amber.map((f) => f.answer), 'no configured name renders the Amber starter set');
  });
  await check('demo account (real clients/demo.json): starter answers carry Summit Home Buyers, zero owner name', async () => {
    const demo = readJson('clients/demo.json');
    const brand = P.caiBrandFromConfig({ companyName: demo.companyName, primaryColor: demo.primaryColor, subdomain: demo.subdomain });
    const faqs = P.caiLoadFaqs(fakeStorage(), 'demo', brand.name);
    assert.strictEqual(faqs.length, 31);
    assert.deepStrictEqual(faqs.map((f) => f.question), kb31.map((f) => f.question), 'questions stay verbatim for every account');
    faqs.forEach((f, i) => {
      assert.ok(!f.answer.includes('Direct Property Buyers'), 'starter answer ' + f.n + ' must not carry the owner name');
      if (!kb31[i].answer.includes('Direct Property Buyers')) {
        assert.strictEqual(f.answer, kb31[i].answer, 'answer ' + f.n + ' had no company name and must stay verbatim');
      }
    });
    assert.ok(faqs[0].answer.startsWith('Amber works with Summit Home Buyers,'), 'FAQ 1 names the demo company');
    assert.ok(faqs[30].answer.includes('This is Amber with Summit Home Buyers'), 'FAQ 31 names the demo company');
  });
  await check('restore starter set respects the account\u2019s own name', async () => {
    const st = fakeStorage();
    P.caiSaveFaqs(st, 'demo', [{ id: 'x1', n: null, question: 'Custom?', answer: 'Custom.' }]);
    const restored = P.caiRestoreFaqs(st, 'demo', 'Summit Home Buyers');
    assert.strictEqual(restored.length, 31);
    assert.ok(restored.every((f) => !f.answer.includes('Direct Property Buyers')), 'restored set carries no owner name');
    assert.ok(restored[0].answer.includes('Summit Home Buyers'));
    assert.deepStrictEqual(P.caiLoadFaqs(st, 'demo', 'Summit Home Buyers').map((f) => f.answer), restored.map((f) => f.answer), 'restored set persisted');
    const ownerRestored = P.caiRestoreFaqs(fakeStorage(), 'troy', 'Direct Property Buyers');
    assert.deepStrictEqual(ownerRestored.map((f) => f.answer), kb31Amber.map((f) => f.answer), 'owner restore stays on the Amber starter set');
  });
  await check('saved edits win untouched: the swap never rewrites a saved knowledge base', async () => {
    const st = fakeStorage();
    const mine = [{ id: 'mine-1', n: null, question: 'Who are you with?', answer: 'We are Direct Property Buyers fans — the demo team typed this themselves.' }];
    P.caiSaveFaqs(st, 'demo', mine);
    const loaded = P.caiLoadFaqs(st, 'demo', 'Summit Home Buyers');
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].answer, mine[0].answer, 'a saved answer loads exactly as the account saved it');
  });
  await check('page wiring: KB header note + name-aware load/restore from the branding hook', async () => {
    assert.ok(html.includes('The starter answers use your business name from your account setup. Edit any answer to make it your own.'), 'plain-language note in the Knowledge Base header');
    assert.ok(html.includes('var BRAND_NAME'), 'page tracks the resolved business name');
    assert.ok(html.includes('BRAND_NAME = brand.name'), 'name comes from the account config branding, same source as the title/accent');
    assert.ok(html.includes('caiLoadFaqs(localStorage, TENANT, BRAND_NAME)'), 'post-branding reload passes the account name');
    assert.ok(html.includes('caiRestoreFaqs(localStorage, TENANT, BRAND_NAME)'), 'restore passes the account name');
  });

  console.log('— H. Editable bot names, voice library logic, test engine —');
  await check('bot names: defaults are Amber / Sam, sanitize trims, caps, strips markup', async () => {
    assert.deepStrictEqual(P.caiDefaultBotNames(), { ashley: 'Amber', sam: 'Sam' });
    assert.strictEqual(P.CAI_BOT_NAME_MAX, 40);
    assert.strictEqual(P.caiSanitizeBotName('  Maria  ', 'Ashley'), 'Maria');
    assert.strictEqual(P.caiSanitizeBotName('<b>Maria</b>', 'Ashley'), 'Maria');
    assert.strictEqual(P.caiSanitizeBotName('<script>alert(1)</script>', 'Ashley'), 'alert(1)');
    assert.strictEqual(P.caiSanitizeBotName('A "quoted" <name>', 'Ashley'), 'A quoted', 'angle-bracket chunks are dropped as tags, quotes stripped');
    assert.strictEqual(P.caiSanitizeBotName('x'.repeat(60), 'Ashley').length, 40, 'capped at 40 chars');
    assert.strictEqual(P.caiSanitizeBotName('   ', 'Ashley'), 'Ashley', 'blank falls back to the default');
    assert.strictEqual(P.caiSanitizeBotName(null, 'Sam'), 'Sam');
  });
  await check('bot names: persist per tenant, isolated, restore brings back the defaults', async () => {
    const st = fakeStorage();
    P.caiSaveBotNames(st, 'demo', { ashley: 'Maria', sam: 'Rob' });
    assert.deepStrictEqual(P.caiLoadBotNames(st, 'demo'), { ashley: 'Maria', sam: 'Rob' });
    assert.ok(st.data['acc_conv_ai_demo_names'], 'persisted under the demo names key');
    assert.deepStrictEqual(P.caiLoadBotNames(st, 'troy'), { ashley: 'Amber', sam: 'Sam' }, 'owner account untouched');
    const restored = P.caiRestoreBotNames(st, 'demo');
    assert.deepStrictEqual(restored, { ashley: 'Amber', sam: 'Sam' });
    assert.deepStrictEqual(P.caiLoadBotNames(st, 'demo'), restored, 'restore persisted');
    P.caiSaveBotNames(st, 'demo', { ashley: '<img src=x onerror=alert(1)>Eve', sam: '' });
    const cleaned = P.caiLoadBotNames(st, 'demo');
    assert.ok(!/[<>"]/.test(cleaned.ashley), 'stored names can never carry markup');
    assert.strictEqual(cleaned.sam, 'Sam', 'blank name on save falls back to the shipped name');
  });
  await check('voice: options are distinct styles, selection sanitizes and persists per tenant', async () => {
    assert.ok(P.CAI_VOICE_OPTIONS.length >= 12, 'a full library of tone choices');
    const ids = P.CAI_VOICE_OPTIONS.map((o) => o.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'option ids unique');
    assert.ok(P.CAI_VOICE_OPTIONS.every((o) => o.label && typeof o.pitch === 'number' && typeof o.rate === 'number'), 'every style carries a label + preview tuning');
    for (const o of P.CAI_VOICE_OPTIONS) {
      assert.ok(o.pitch >= 0.9 && o.pitch <= 1.1, o.id + ' pitch stays in the natural range (no robot/chipmunk extremes)');
      assert.ok(o.rate >= 0.92 && o.rate <= 1.02, o.id + ' rate stays in the natural range');
      assert.ok(Array.isArray(o.keys) && o.keys.length, o.id + ' carries voice-preference keywords');
    }
    for (const id of ['natural', 'female-warm', 'female-bright', 'female-friendly', 'female-professional', 'male-calm', 'male-deep', 'male-friendly', 'male-professional', 'female-mature', 'male-young', 'neutral']) {
      assert.ok(P.caiVoiceOption(id), 'tone choice present: ' + id);
    }
    const nat = P.CAI_VOICE_OPTIONS[0];
    assert.strictEqual(nat.id, 'natural', 'Natural is the FIRST tone choice');
    assert.strictEqual(nat.label, 'Natural');
    assert.strictEqual(nat.pitch, 1.0, 'Natural pitch is the neutral-natural value');
    assert.strictEqual(nat.rate, 0.98, 'Natural rate is the neutral-natural value');
    assert.strictEqual(P.caiDefaultVoiceSel(), 'natural', 'Natural is the default selection for a fresh tenant');
    assert.strictEqual(P.caiLoadVoice(fakeStorage(), 'brand-new-tenant'), 'el:CwhRBWXzGAHq8TQ4Fs17', 'a tenant with nothing saved gets Sam\'s default voice (Roger) — Nov 19/20, not the Natural device style');
    assert.strictEqual(P.caiSanitizeVoiceSel('male-deep'), 'male-deep');
    assert.strictEqual(P.caiSanitizeVoiceSel('browser:Device Voice One'), 'browser:Device Voice One');
    assert.strictEqual(P.caiSanitizeVoiceSel('browser:'), P.caiDefaultVoiceSel(), 'empty device name refused');
    assert.strictEqual(P.caiSanitizeVoiceSel('nonsense'), P.caiDefaultVoiceSel(), 'unknown selection falls back');
    const st = fakeStorage();
    P.caiSaveVoice(st, 'demo', 'male-calm');
    assert.strictEqual(P.caiLoadVoice(st, 'demo'), 'male-calm');
    assert.strictEqual(P.caiLoadVoice(st, 'troy'), 'el:CwhRBWXzGAHq8TQ4Fs17', 'other tenant keeps the default (Sam\'s Roger voice)');
  });
  await check('voice: greeting speaks the bot\u2019s current name + the account\u2019s business name', async () => {
    assert.strictEqual(P.caiGreeting('Sam', 'Summit Home Buyers'), 'Hi, thanks for calling Summit Home Buyers! This is Sam — how can I help you today?');
    assert.strictEqual(P.caiGreeting('Rob', ''), 'Hi, thanks for calling! This is Rob — how can I help you today?', 'no business name = no dangling "with"');
    assert.strictEqual(P.caiGreeting('', 'Acme'), 'Hi, thanks for calling Acme! This is Sam — how can I help you today?', 'blank bot name falls back');
  });
  await check('voice: browser voice picking matches style preference, exact device voice, safe fallbacks', async () => {
    const voices = [
      { name: 'English Female Voice', lang: 'en-US', default: false },
      { name: 'English Male Voice', lang: 'en-GB', default: false },
      { name: 'Voz Femenina', lang: 'es-ES', default: true },
    ];
    assert.strictEqual(P.caiPickSpeechVoice(voices, 'female-warm').name, 'English Female Voice');
    assert.strictEqual(P.caiPickSpeechVoice(voices, 'male-deep').name, 'English Male Voice');
    assert.strictEqual(P.caiPickSpeechVoice(voices, 'browser:English Male Voice').name, 'English Male Voice', 'exact device voice honored');
    assert.strictEqual(P.caiPickSpeechVoice(voices, 'browser:No Such Voice'), null, 'missing device voice = no pick, never an error');
    assert.strictEqual(P.caiPickSpeechVoice([], 'female-warm'), null, 'no voices exposed = null');
    assert.strictEqual(P.caiPickSpeechVoice(null, 'female-warm'), null);
    assert.strictEqual(P.caiPickSpeechVoice(voices, 'neutral').lang.indexOf('en'), 0, 'neutral prefers an English voice');
    assert.strictEqual(P.caiVoiceLabel({ name: 'English Female Voice', lang: 'en-US' }), 'English Female Voice · en-US');
    const plainVsNatural = [
      { name: 'Plain Device Voice', lang: 'en-US', default: true },
      { name: 'Natural Device Voice', lang: 'en-US', default: false },
    ];
    assert.strictEqual(P.caiPickSpeechVoice(plainVsNatural, 'natural').name, 'Natural Device Voice', 'the Natural style picks the natural voice over a plain default');
    assert.strictEqual(P.caiPickSpeechVoice(plainVsNatural, 'female-friendly').name, 'Natural Device Voice', 'natural voices win for the other styles too when no gendered voice exists');
    const genderedNatural = [
      { name: 'English Female Voice', lang: 'en-US', default: false },
      { name: 'Female Natural Voice', lang: 'en-US', default: false },
    ];
    assert.strictEqual(P.caiPickSpeechVoice(genderedNatural, 'female-warm').name, 'Female Natural Voice', 'among gender-matching voices the natural one wins');
    const neuralVsPlain = [
      { name: 'Standard Voice', lang: 'en-US', default: false },
      { name: 'Neural Voice', lang: 'en-US', default: false },
    ];
    assert.strictEqual(P.caiPickSpeechVoice(neuralVsPlain, 'natural').name, 'Neural Voice', 'neural voices rank at the top for Natural');
  });
  await check('test engine: money parser reads every typed format, ignores phone-like digit runs', async () => {
    assert.strictEqual(P.caiParseMoneyAsk('I want $500,000 for the place'), 500000);
    assert.strictEqual(P.caiParseMoneyAsk('$500,000.00 firm'), 500000);
    assert.strictEqual(P.caiParseMoneyAsk('500k and not a penny less'), 500000);
    assert.strictEqual(P.caiParseMoneyAsk('$500K'), 500000);
    assert.strictEqual(P.caiParseMoneyAsk('asking 500 grand'), 500000);
    assert.strictEqual(P.caiParseMoneyAsk('my price is 500000'), 500000);
    assert.strictEqual(P.caiParseMoneyAsk('five hundred thousand'), 500000);
    assert.strictEqual(P.caiParseMoneyAsk('I need $750,000'), 750000);
    assert.strictEqual(P.caiParseMoneyAsk('250k would work'), 250000);
    assert.strictEqual(P.caiParseMoneyAsk('I want 450,000'), 450000);
    assert.strictEqual(P.caiParseMoneyAsk('no numbers in this message'), null);
    assert.strictEqual(P.caiParseMoneyAsk('call me at 3175551234'), null, 'a bare 10-digit run is a phone number, not an ask');
  });
  await check('test engine: opt-out and booking-intent detection', async () => {
    for (const msg of ['STOP', 'stop', 'Stop.', 'please stop texting me', 'Unsubscribe me', "don't text me anymore", 'Do not text me', 'remove me please', 'leave me alone', 'opt out']) {
      assert.strictEqual(P.caiIsOptOut(msg), true, 'opt-out: ' + msg);
    }
    for (const msg of ['I love the place', 'call me tomorrow', 'what is it worth?', 'the place has a new stop sign out front']) {
      assert.strictEqual(P.caiIsOptOut(msg), false, 'not opt-out: ' + msg);
    }
    assert.strictEqual(P.caiIsBookingIntent('Can we set up a call?'), true);
    assert.strictEqual(P.caiIsBookingIntent('when can we talk?'), true);
    assert.strictEqual(P.caiIsBookingIntent('I would like to schedule a visit'), true);
    assert.strictEqual(P.caiIsBookingIntent('the roof is 10 years old'), false);
  });
  await check('test engine: KB match — exact, contained, and keyword overlap; gibberish misses', async () => {
    const faqs = P.caiLoadFaqs(fakeStorage(), 'troy', 'Direct Property Buyers');
    assert.strictEqual(P.caiMatchFaq(faqs, 'Are you a realtor?').n, 5);
    assert.strictEqual(P.caiMatchFaq(faqs, 'Who is this?').n, 31);
    assert.strictEqual(P.caiMatchFaq(faqs, 'How did you get my number?').n, 4);
    assert.strictEqual(P.caiMatchFaq(faqs, 'what company is this').n, 1);
    assert.strictEqual(P.caiMatchFaq(faqs, 'who pays the closing costs?').n, 30);
    assert.strictEqual(P.caiMatchFaq(faqs, 'my place is not for sale').n, 7);
    assert.strictEqual(P.caiMatchFaq(faqs, 'asdf qwer zzz'), null);
    assert.strictEqual(P.caiMatchFaq(faqs, ''), null);
    const custom = P.caiAddFaq(faqs, 'Do you handle condos?', 'Yes — condos work the same way.').faqs;
    assert.strictEqual(P.caiMatchFaq(custom, 'Do you handle condos?').answer, 'Yes — condos work the same way.', 'tenant-added entries match too');
  });
  await check('test engine: offer times follow the screen\u2019s booking rule (count, spacing, window, hours)', async () => {
    const booking = P.caiDefaultBooking();
    const now = new Date(2026, 10, 19, 15, 0, 0); // Thu Nov 19, 2026, 3 PM local
    const times = P.caiOfferTimes(booking, now);
    assert.strictEqual(times.length, booking.slots, 'offers exactly the configured slot count');
    const dates = times.map((t) => new Date(t.iso));
    for (let i = 1; i < dates.length; i++) {
      assert.ok(dates[i] - dates[i - 1] >= booking.minGapHours * 3600000, 'times spaced at least the minimum gap apart');
    }
    const lastDay = new Date(2026, 10, 19 + booking.windowDays, 23, 59, 59);
    dates.forEach((d) => {
      assert.ok(d > now && d <= lastDay, 'inside the offer window');
      const mins = d.getHours() * 60 + d.getMinutes();
      assert.ok(mins >= 8 * 60 && mins + booking.callMinutes <= 21 * 60, 'inside business hours');
    });
    assert.ok(/Tomorrow at 8:00 AM/.test(times[0].label), 'first offer is tomorrow at open: ' + times[0].label);
    const tight = P.caiOfferTimes({ windowDays: 1, slots: 2, minGapHours: 3, hoursStart: '09:00', hoursEnd: '17:00', callMinutes: 30, calendar: 'Seller Calls' }, now);
    assert.strictEqual(tight.length, 2, 'a tighter rule still yields its slots');
    assert.ok(tight.every((t) => /Tomorrow/.test(t.label)), 'one-day window stays inside tomorrow');
  });
  await check('test engine: full replies — KB, booking, silence rules, precedence, default', async () => {
    const faqs = P.caiLoadFaqs(fakeStorage(), 'troy', 'Direct Property Buyers');
    const ctx = { faqs, booking: P.caiDefaultBooking(), botName: 'Amber', bizName: 'Direct Property Buyers', now: new Date(2026, 10, 19, 15, 0, 0) };
    const kb = P.caiTestReply('Are you a realtor?', ctx);
    assert.strictEqual(kb.type, 'reply');
    assert.strictEqual(kb.faqId, 'faq-5');
    assert.ok(kb.text.includes('not agents'), 'KB reply carries the FAQ answer');
    const bk = P.caiTestReply('Can we set up a call?', ctx);
    assert.strictEqual(bk.type, 'reply');
    assert.ok(/Would any of these work/.test(bk.text) && /Tomorrow at/.test(bk.text), 'booking reply offers concrete times: ' + bk.text);
    for (const msg of ['STOP', "don't text me anymore", 'unsubscribe']) {
      const r = P.caiTestReply(msg, ctx);
      assert.strictEqual(r.type, 'silence', 'opt-out silence: ' + msg);
      assert.strictEqual(r.text, '');
      assert.ok(/stays silent on opt-outs/.test(r.note), 'opt-out note shown');
    }
    for (const msg of ['I want $500,000 for it', '500k firm', 'asking 500 grand', 'my price is 500000', 'five hundred thousand or nothing']) {
      const r = P.caiTestReply(msg, ctx);
      assert.strictEqual(r.type, 'silence', '$500K silence: ' + msg);
      assert.ok(/\$500K or more/.test(r.note), 'guardrail note shown');
    }
    assert.strictEqual(P.caiTestReply('stop texting me — and who is this, anyway?', ctx).type, 'silence', 'guardrails beat KB matches');
    assert.strictEqual(P.caiTestReply('I want $500,000 — are you a realtor?', ctx).type, 'silence', 'guardrails beat KB matches (money)');
    const under = P.caiTestReply('I want $499,000 for it', ctx);
    assert.notStrictEqual(under.type, 'silence', 'under $500K is not silenced');
    const dflt = P.caiTestReply('Hello there', ctx);
    assert.strictEqual(dflt.type, 'reply');
    assert.ok(dflt.text.includes('Amber') && dflt.text.includes('Direct Property Buyers'), 'default reply is in character with bot + business name');
    assert.strictEqual(P.caiTestReply('   ', ctx).type, 'empty');
  });
  await check('test engine: tenant edits, business name, and renamed bots flow into replies', async () => {
    const demo = readJson('clients/demo.json');
    const brand = P.caiBrandFromConfig({ companyName: demo.companyName, primaryColor: demo.primaryColor, subdomain: demo.subdomain });
    const demoFaqs = P.caiLoadFaqs(fakeStorage(), 'demo', brand.name);
    const ctx = { faqs: demoFaqs, booking: P.caiDefaultBooking(), botName: 'Maria', bizName: brand.name, now: new Date(2026, 10, 19, 15, 0, 0) };
    const who = P.caiTestReply('Who is this?', ctx);
    assert.strictEqual(who.type, 'reply');
    assert.ok(who.text.includes('Maria'), 'renamed bot speaks under its new name');
    assert.ok(!/\bAshley\b/.test(who.text), 'the legacy shipped name is gone from the reply');
    assert.ok(!/\bAmber\b/.test(who.text), 'the current shipped name is gone from the reply too');
    assert.ok(who.text.includes('Summit Home Buyers'), 'the tenant\u2019s business name is in the reply');
    assert.ok(!who.text.includes('Direct Property Buyers'), 'no trace of the owner business');
    const dflt = P.caiTestReply('hey there', ctx);
    assert.ok(dflt.text.includes('This is Maria with Summit Home Buyers'), 'default reply uses the renamed bot + tenant business');
    const st = fakeStorage();
    const edited = P.caiSaveFaqs(st, 'demo', [{ id: 'e1', n: null, question: 'Do you take houses with solar panels?', answer: 'Yes — solar panels are fine, we take the place as-is.' }]);
    const r = P.caiTestReply('Do you take houses with solar panels?', { faqs: edited, booking: P.caiDefaultBooking(), botName: 'Maria', bizName: brand.name });
    assert.strictEqual(r.text, 'Yes — solar panels are fine, we take the place as-is.', 'the tenant\u2019s own edited answer is the reply, untouched');
  });

  console.log('— I. Bot picker, added profiles, voice library wiring —');
  await check('profiles: add / update / remove round-trips per tenant, junk sanitized', async () => {
    const st = fakeStorage();
    const added = P.caiAddProfile([], { name: 'Maria', channel: 'voice', mode: 'suggest' });
    assert.ok(added && added.profile.id && added.profile.id.indexOf('bot_') === 0);
    assert.strictEqual(added.profile.channel, 'voice');
    assert.strictEqual(added.profile.mode, 'suggest');
    assert.strictEqual(added.profile.on, true);
    assert.strictEqual(P.caiAddProfile([], { name: '   ', channel: 'text', mode: 'auto' }), null, 'blank name refused');
    let profiles = P.caiSaveProfiles(st, 'demo', added.profiles);
    assert.strictEqual(P.caiLoadProfiles(st, 'demo').length, 1, 'persisted');
    assert.strictEqual(P.caiLoadProfiles(st, 'troy').length, 0, 'other tenant untouched');
    const upd = P.caiUpdateProfile(profiles, added.profile.id, { name: 'Maria <b>2</b>', mode: 'auto', on: false, voice: 'male-deep' });
    assert.strictEqual(upd[0].name, 'Maria 2', 'profile names sanitize like bot names');
    assert.strictEqual(upd[0].mode, 'auto');
    assert.strictEqual(upd[0].on, false);
    assert.strictEqual(upd[0].voice, 'male-deep');
    assert.strictEqual(P.caiUpdateProfile(profiles, 'no-such-id', { name: 'X' }), null, 'unknown id refused');
    const junk = P.caiSanitizeProfiles([{ id: 'ok1', name: 'A', channel: 'smoke-signal', mode: 'turbo', on: 'yes' }, null, 'junk', { name: 'no id' }]);
    assert.strictEqual(junk.length, 1);
    assert.strictEqual(junk[0].channel, 'text', 'unknown channel falls back to text');
    assert.strictEqual(junk[0].mode, 'auto');
    assert.strictEqual(junk[0].on, true);
    profiles = P.caiRemoveProfile(upd, added.profile.id);
    assert.strictEqual(profiles.length, 0, 'added profile removed');
  });
  await check('profiles: the originals are structural — reserved ids can never be added, shadowed, or removed', async () => {
    assert.deepStrictEqual(P.CAI_RESERVED_BOT_IDS, ['ashley', 'sam']);
    const forged = P.caiSanitizeProfiles([
      { id: 'ashley', name: 'Fake Ashley', channel: 'text', mode: 'auto', on: true },
      { id: 'sam', name: 'Fake Sam', channel: 'voice', mode: 'auto', on: true },
    ]);
    assert.strictEqual(forged.length, 0, 'added profiles cannot claim a reserved id');
    const list = [{ id: 'bot_x', name: 'Extra', channel: 'text', mode: 'auto', on: true, voice: 'neutral' }];
    assert.strictEqual(P.caiRemoveProfile(list, 'ashley').length, 1, 'removing "ashley" from the added list changes nothing');
    assert.strictEqual(P.caiRemoveProfile(list, 'sam').length, 1, 'removing "sam" from the added list changes nothing');
    const all = P.caiAllBots({ ashley: 'Ashley', sam: 'Sam' }, P.caiDefaultBots(), list);
    assert.deepStrictEqual(all.map((b) => b.id), ['ashley', 'sam', 'bot_x'], 'unified list: originals first, exactly once');
    assert.strictEqual(all[0].builtin, true);
    assert.strictEqual(all[2].builtin, false);
  });
  await check('picker: unified list reflects renames + modes; selection validates and persists', async () => {
    const st = fakeStorage();
    const profiles = P.caiAddProfile([], { name: 'Maria', channel: 'voice', mode: 'auto' }).profiles;
    const all = P.caiAllBots({ ashley: 'Ash', sam: 'Sammy' }, { ashley: { on: false, mode: 'suggest' }, sam: { on: true, mode: 'auto' } }, profiles);
    assert.strictEqual(all[0].name, 'Ash');
    assert.strictEqual(all[0].channel, 'text');
    assert.strictEqual(P.caiBotState(all[0]), 'Off', 'the off toggle wins over the mode in the picker state line');
    assert.strictEqual(all[1].name, 'Sammy');
    assert.strictEqual(all[1].channel, 'voice');
    assert.strictEqual(all[2].name, 'Maria');
    P.caiSaveSelected(st, 'demo', all[2].id);
    assert.strictEqual(P.caiLoadSelected(st, 'demo', all), all[2].id, 'selection persists per tenant');
    assert.strictEqual(P.caiLoadSelected(st, 'demo', P.caiAllBots(null, null, [])), 'ashley', 'a removed bot\u2019s selection falls back to the first original');
    assert.strictEqual(P.caiValidSelected('bogus', all), 'ashley');
    assert.strictEqual(P.caiValidSelected('sam', all), 'sam');
  });
  await check('page wiring: picker, add-bot form, name fields, restore-names present', async () => {
    for (const needle of ['id="pickGrid"', 'data-pick', 'id="newBotName"', 'id="newBotChannel"', 'id="newBotMode"', 'id="btnAddBot"',
      'id="ashleyName"', 'id="samName"', 'id="btnRestoreNames"', 'data-bot-ref="ashley"', 'data-bot-ref="sam"',
      'caiLoadBotNames(localStorage, TENANT)', 'caiSaveBotNames(localStorage, TENANT', 'caiRestoreBotNames(localStorage, TENANT)',
      'caiLoadProfiles(localStorage, TENANT)', 'caiSaveProfiles(localStorage, TENANT', 'caiAddProfile(state.profiles',
      'caiRemoveProfile(state.profiles', 'caiLoadSelected(localStorage, TENANT', 'caiSaveSelected(localStorage, TENANT']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
  });
  await check('page wiring: added-bot editor cards carry rename / mode / toggle / remove, originals have no remove', async () => {
    for (const needle of ['id="addedBotGrid"', 'data-profile-name', 'data-profile-mode', 'data-profile-on', 'data-profile-remove', 'data-bot-card']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
    const ashleyCard = html.slice(html.indexOf('id="ashleyCard"'), html.indexOf('id="samCard"'));
    const samCard = html.slice(html.indexOf('id="samCard"'), html.indexOf('id="addedBotGrid"'));
    assert.ok(!ashleyCard.includes('data-profile-remove'), 'the text original has no remove control');
    assert.ok(!samCard.includes('data-profile-remove'), 'the voice original has no remove control');
  });
  await check('page wiring: voice library — per-voice Listen + Select rows, active mark, speech fallback note', async () => {
    for (const needle of ['id="samVoices"', 'data-voices-for', 'data-vlisten', 'data-vselect', 'data-vnote',
      'Built-in styles', 'Voices on this device', '▶ Listen', '>Select</button>', 'pill green">Active',
      'caiSaveVoice(localStorage, TENANT', 'caiPickSpeechVoice(voices, selId)', 'SpeechSynthesisUtterance', 'caiGreeting(botName, BRAND_NAME)',
      'Voice preview isn’t available in this browser.', 'No device voices found in this browser']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
    assert.ok(html.includes("'speechSynthesis' in window"), 'preview is feature-detected, never assumed');
  });
  await check('page wiring: test panel — live dry-run label, log, input, engine call with the selected bot', async () => {
    for (const needle of ['Test your bot', 'id="testLog"', 'id="testInput"', 'id="btnTestSend"', 'id="btnTestClear"', 'id="testBotLabel"',
      'Live dry-run', 'Offline simulation — server dry-run unavailable',
      'caiDryRunPayload', 'caiPostDryRun', 'selectedBot()', 'No reply — ']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
    assert.ok(!html.includes('Preview only — replies come from the knowledge base and settings on this screen'), 'the old preview-only copy is gone — the panel runs the real bot now');
  });
  await check('page wiring: test panel sits right after the bot cards and before the Knowledge Base, titled "Test your bot"', async () => {
    const botsAt = html.indexOf('Bot status &amp; mode');
    const testAt = html.indexOf('<h2>Test your bot</h2>');
    const kbAt = html.indexOf('<h2>Knowledge Base</h2>');
    assert.ok(testAt > -1, 'test section heading reads "Test your bot"');
    assert.ok(!html.includes('<h2>Test your AI</h2>'), 'the old "Test your AI" heading is gone');
    assert.ok(botsAt > -1 && testAt > botsAt, 'test section comes after the Bot status & mode section (the bot cards)');
    assert.ok(kbAt > -1 && testAt < kbAt, 'test section comes before the Knowledge Base section — no longer buried at the bottom of the page');
  });

  console.log('— J. Bot avatars —');
  await check('avatar options: 22 photo faces, unique, fully described — photos only (Troy, Nov 19)', async () => {
    assert.strictEqual(P.CAI_PHOTO_AVATARS.length, 22, 'a big photo avatar library (22 generated headshots)');
    const ids = P.CAI_PHOTO_AVATARS.map((o) => o.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'option ids unique');
    P.CAI_PHOTO_AVATARS.forEach((o) => {
      assert.ok(o.label, o.id + ' has a label');
      assert.ok(/^\/avatars\/[a-z]+\.webp$/.test(o.photo), o.id + ' photo is a /avatars/*.webp file');
      assert.ok(['female', 'male', 'neutral'].includes(o.gender), o.id + ' gender is described');
    });
    assert.strictEqual(P.CAI_PHOTO_AVATARS[0].id, 'ph-ashley', 'the text bot\'s face leads the photo library');
    assert.ok(P.caiPhotoAvatar('ph-roger'), 'Roger\'s photo exists — the face that matches Sam\'s voice');
    assert.strictEqual(P.caiAvatarOption('ava-aria'), null, 'illustrated ids no longer validate (photos only, Nov 19)');
    assert.strictEqual(P.CAI_AVATAR_INITIALS, 'initials');
    const st = fakeStorage();
    P.caiSaveAvatars(st, 'demo', { ashley: 'ava-kai', sam: 'ava-sofia' });
    assert.deepStrictEqual(P.caiLoadAvatars(st, 'demo'), { ashley: 'ph-ashley', sam: 'ph-roger' }, 'old illustrated picks saved before the photos-only switch fall back to the shipped photo faces');
  });
  await check('avatar defaults: text bot = Amber photo, voice bot = Roger photo', async () => {
    assert.strictEqual(P.caiDefaultAvatar('ashley'), 'ph-ashley');
    assert.strictEqual(P.caiDefaultAvatar('sam'), 'ph-roger');
    assert.strictEqual(P.caiDefaultAvatar('some-added-bot'), 'ph-ashley');
    assert.deepStrictEqual(P.caiDefaultAvatars(), { ashley: 'ph-ashley', sam: 'ph-roger' });
    assert.deepStrictEqual(P.caiLoadAvatars(fakeStorage(), 'demo'), P.caiDefaultAvatars(), 'empty storage loads the shipped faces');
  });
  await check('avatar selection: sanitize accepts real picks + initials, refuses junk', async () => {
    const someId = P.CAI_PHOTO_AVATARS[3].id;
    assert.strictEqual(P.caiSanitizeAvatarSel(someId, 'initials'), someId);
    assert.strictEqual(P.caiSanitizeAvatarSel('initials', someId), 'initials');
    assert.strictEqual(P.caiSanitizeAvatarSel('ava-kai', someId), someId, 'an illustrated id no longer validates — falls back to the given default');
    assert.strictEqual(P.caiSanitizeAvatarSel('not-a-face', someId), someId, 'junk falls back to the given default');
    assert.strictEqual(P.caiSanitizeAvatarSel('not-a-face', 'also-junk'), 'ph-ashley', 'junk default falls back to the first photo face');
    assert.strictEqual(P.caiSanitizeAvatarSel(null, null), 'ph-ashley');
    assert.deepStrictEqual(P.caiSanitizeAvatars({ ashley: 'bogus', sam: 'initials' }), { ashley: 'ph-ashley', sam: 'initials' });
    assert.deepStrictEqual(P.caiSanitizeAvatars('junk'), P.caiDefaultAvatars());
  });
  await check('avatar selection: persists per tenant per bot, isolated', async () => {
    const st = fakeStorage();
    const pick = P.CAI_PHOTO_AVATARS[5].id;
    P.caiSaveAvatars(st, 'demo', { ashley: 'initials', sam: pick });
    assert.deepStrictEqual(P.caiLoadAvatars(st, 'demo'), { ashley: 'initials', sam: pick });
    assert.ok(st.data['acc_conv_ai_demo_avatars'], 'persisted under the demo avatars key');
    assert.deepStrictEqual(P.caiLoadAvatars(st, 'troy'), P.caiDefaultAvatars(), 'owner account untouched by demo picks');
  });
  await check('avatar render: photo faces render as a clipped image in an SVG circle, initials stay a disc', async () => {
    const svg = P.caiAvatarSvg('ph-roger', 'Sam', '#ff6b1a');
    assert.ok(svg.startsWith('<svg'), 'renders an inline SVG wrapper, not a bare image tag');
    assert.ok(svg.includes('data-avatar="ph-roger"'), 'svg carries its option id');
    assert.ok(svg.includes('<image href="/avatars/roger.webp"'), 'photo face embeds its /avatars/*.webp file');
    assert.ok(svg.includes('clip-path'), 'photo is clipped to the avatar circle');
    assert.ok(!/src=|href="http/.test(svg), 'no external references inside the svg');
    const ash = P.caiAvatarSvg('ph-ashley', 'Amber', '#ff6b1a');
    assert.ok(ash.includes('<image href="/avatars/ashley.webp"'), 'Amber\'s photo renders');
    assert.ok(P.caiAvatarSvg('bogus-id', 'Bot', '#ff6b1a').includes('data-avatar="ph-ashley"'), 'unknown selection renders the default photo face');
    assert.ok(P.caiAvatarSvg('ava-kai', 'Bot', '#ff6b1a').includes('data-avatar="ph-ashley"'), 'an illustrated id falls back to the default photo face');
    P.CAI_PHOTO_AVATARS.forEach((o) => {
      assert.ok(P.caiAvatarSvg(o.id, 'Bot', '#ff6b1a').includes('<image href="' + o.photo + '"'), o.id + ' renders its photo');
    });
  });
  await check('avatar svg: Initials disc uses the account accent + the bot\u2019s current initial, and follows renames', async () => {
    const a = P.caiAvatarSvg('initials', 'Ashley', '#123abc');
    assert.ok(a.includes('data-avatar="initials"'));
    assert.ok(a.includes('fill="#123abc"'), 'disc is filled with the accent color');
    assert.ok(a.includes('>A</text>'), 'shows the current initial');
    const renamed = P.caiAvatarSvg('initials', 'Maria', '#123abc');
    assert.ok(renamed.includes('>M</text>'), 'renaming the bot updates its Initials avatar');
    assert.ok(!renamed.includes('>A</text>'), 'the old initial is gone');
    assert.strictEqual(P.caiAvatarInitial('maria'), 'M');
    assert.strictEqual(P.caiAvatarInitial('  rob '), 'R');
    assert.strictEqual(P.caiAvatarInitial(''), '?');
    assert.strictEqual(P.caiAvatarInitial('<b>Eve</b>'), 'E', 'markup in a name never reaches the svg');
    const badAccent = P.caiAvatarSvg('initials', 'Ashley', 'not-a-color');
    assert.ok(badAccent.includes('fill="#ff6b1a"'), 'a junk accent falls back to the default accent');
  });
  await check('avatars on profiles + unified list: added bots get sensible defaults, picks survive sanitize/update', async () => {
    const voiceAdd = P.caiAddProfile([], { name: 'Rob', channel: 'voice', mode: 'auto' });
    assert.strictEqual(voiceAdd.profile.avatar, 'ph-roger', 'an added voice bot defaults to Roger\'s photo face');
    const textAdd = P.caiAddProfile([], { name: 'Maria', channel: 'text', mode: 'auto' });
    assert.strictEqual(textAdd.profile.avatar, 'ph-ashley', 'an added text bot defaults to Amber\'s photo face');
    const cleaned = P.caiSanitizeProfiles([{ id: 'ok1', name: 'A', channel: 'text', mode: 'auto', on: true, avatar: 'initials' }, { id: 'ok2', name: 'B', channel: 'voice', mode: 'auto', on: true, avatar: 'junk-face' }]);
    assert.strictEqual(cleaned[0].avatar, 'initials', 'a saved pick survives sanitize');
    assert.strictEqual(cleaned[1].avatar, 'ph-roger', 'a junk pick on a voice profile falls back to Roger\'s photo face');
    const upd = P.caiUpdateProfile(cleaned, 'ok1', { avatar: P.CAI_PHOTO_AVATARS[2].id });
    assert.strictEqual(upd[0].avatar, P.CAI_PHOTO_AVATARS[2].id, 'avatar is patchable like voice');
    const all = P.caiAllBots({ ashley: 'Ash', sam: 'Sammy' }, P.caiDefaultBots(), upd, { ashley: 'initials', sam: P.CAI_PHOTO_AVATARS[4].id });
    assert.strictEqual(all[0].avatar, 'initials', 'unified list carries the text original\u2019s pick');
    assert.strictEqual(all[1].avatar, P.CAI_PHOTO_AVATARS[4].id, 'unified list carries the voice original\u2019s pick');
    assert.strictEqual(all[2].avatar, P.CAI_PHOTO_AVATARS[2].id, 'unified list carries the added bot\u2019s pick');
    const noMap = P.caiAllBots(null, null, []);
    assert.strictEqual(noMap[0].avatar, 'ph-ashley', 'no stored picks = shipped defaults');
    assert.strictEqual(noMap[1].avatar, 'ph-roger');
  });
  await check('page wiring: avatar slots, choosers, and persistence on every bot surface', async () => {
    for (const needle of ['id="ashleyAvatars"', 'id="samAvatars"', 'data-avatar-slot="ashley"', 'data-avatar-slot="sam"',
      'data-avatar-opts-for', 'data-avatar-slot="\' + esc(p.id) + \'"', 'data-avatar-pick', 'data-avatar-owner',
      'class="lbl">Avatar</span>', 'Pick a face for this bot.',
      'caiLoadAvatars(localStorage, TENANT)', 'caiSaveAvatars(localStorage, TENANT', 'state.avatars = caiLoadAvatars(localStorage, TENANT)',
      'caiAvatarSvg(b.avatar, b.name, ACCENT)', 'caiAvatarSvg(sel, nm, ACCENT)', 'avatarSel: bot.avatar',
      'bot-avatar sm', 'refreshAvatarBits()', 'renderAvatarChoosers()', 'renderAvatarSlots()']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
    assert.ok(!/<img/.test(html), 'no image tags — every avatar is inline SVG');
    assert.ok(!/src\s*=\s*"https?:/.test(html), 'no external asset URLs anywhere on the page');
  });

  console.log('— K. Voice-call test mode —');
  await check('voice-call test: Text | Voice call toggle, call controls, status line, honest browser-call labeling', async () => {
    for (const needle of ['id="btnTestModeText"', 'id="btnTestModeVoice"', '💬 Text', '📞 Voice call',
      'id="testVoiceArea"', 'id="testVoiceGate"', 'id="testCallControls"', 'id="btnStartCall"', 'id="btnEndCall"',
      'id="testCallStatus"', 'id="testVoiceNote"', '📞 Start test call', '>End call</button>', 'Not on a call',
      'Browser test call — uses your microphone and speakers. Not a live phone line.']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
    const testAt = html.indexOf('<h2>Test your bot</h2>');
    const toggleAt = html.indexOf('id="btnTestModeText"');
    const kbAt = html.indexOf('<h2>Knowledge Base</h2>');
    assert.ok(toggleAt > testAt && toggleAt < kbAt, 'the mode toggle lives inside the Test your bot panel');
  });
  await check('voice-call test: voice mode is gated to voice bots (text bot gets the pick-a-voice-bot note)', async () => {
    const render = html.slice(html.indexOf('function renderTestMode()'), html.indexOf('function setTestMode(mode)'));
    assert.ok(render.includes("bot.channel === 'voice'"), 'the gate reads the selected bot\u2019s channel');
    assert.ok(render.includes('gate.hidden = isVoice'), 'the gate note shows exactly when the bot is not a voice bot');
    assert.ok(render.includes('controls.style.display'), 'the call controls hide for a text bot');
    assert.ok(html.includes('Voice-call testing is for voice bots — pick a voice bot in the picker at the top of this page'), 'plain-language gate note');
    const start = html.slice(html.indexOf('function startTestCall()'), html.indexOf('function endTestCall()'));
    assert.ok(start.includes("bot.channel !== 'voice'"), 'starting a call refuses a text bot outright');
  });
  await check('voice-call test: spoken utterances and typed lines share ONE exchange — live dry-run, local reply only as labelled fallback', async () => {
    assert.strictEqual((html.match(/caiTestReply\(/g) || []).length, 2, 'the local engine is defined once and called once — only as the offline fallback, never as a second reply path');
    const exchange = html.slice(html.indexOf('async function testExchange(msg)'), html.indexOf('async function runTest()'));
    assert.ok(exchange.includes('caiPostDryRun('), 'the shared exchange posts the server dry-run first');
    assert.ok(exchange.includes('caiTestReply(msg, {'), 'the shared exchange falls back to the local engine only when the dry-run fails');
    assert.ok(exchange.includes('sim: true'), 'fallback replies are flagged so the log labels them a simulation');
    const typed = html.slice(html.indexOf('async function runTest()'), html.indexOf("document.getElementById('btnTestSend').addEventListener"));
    assert.ok(typed.includes('await testExchange(msg)'), 'typed tests route through the shared exchange');
    const spoken = html.slice(html.indexOf('async function handleCallUtterance(text)'), html.indexOf('function startTestCall()'));
    assert.ok(spoken.includes('await testExchange(text)'), 'recognized utterances route through the same shared exchange');
    assert.ok(spoken.includes("if (res.type === 'reply') speakTestReply(res.text);"), 'only real replies are spoken — guardrail silence is never spoken aloud');
  });
  await check('voice-call test: the bot speaks through the library\u2019s own style→voice path (same as Listen)', async () => {
    const speak = html.slice(html.indexOf('function speakWithSelection(text, selId'), html.indexOf('function previewVoice(ownerId, selId)'));
    assert.ok(speak.includes('caiPickSpeechVoice(voices, selId)'), 'one voice-matching helper for previews and calls');
    assert.ok(speak.includes('SpeechSynthesisUtterance'), 'speech is the browser\u2019s own synthesis');
    const preview = html.slice(html.indexOf('function previewVoice(ownerId, selId)'), html.indexOf("document.addEventListener('click'"));
    assert.ok(preview.includes('speakWithSelection(line, selId'), 'Listen buttons preview through the shared speech path');
    const reply = html.slice(html.indexOf('function speakTestReply(text)'), html.indexOf('function handleCallUtterance(text)'));
    assert.ok(reply.includes('voiceSelectionFor(bot.id)'), 'call replies use the bot\u2019s saved library voice selection');
    assert.ok(reply.includes('speakWithSelection(text,'), 'call replies speak through the shared path');
    const start = html.slice(html.indexOf('function startTestCall()'), html.indexOf('function endTestCall()'));
    assert.ok(start.includes('speakTestReply(caiGreeting(bot.name, BRAND_NAME))'), 'the call opens with the bot speaking its greeting');
  });
  await check('voice-call test: fallbacks — no speech input, no speech at all, mic blocked, typed lines on a call still spoken', async () => {
    assert.ok(html.includes('window.SpeechRecognition || window.webkitSpeechRecognition'), 'speech input is feature-detected under both names');
    assert.ok(html.includes('Voice input isn\u2019t supported in this browser'), 'no-recognition browsers get the hear-the-bot note');
    assert.ok(html.includes('Voice isn\u2019t available in this browser — the bot can\u2019t speak here'), 'no-synthesis browsers get a clear note and text testing carries on');
    assert.ok(html.includes("err === 'not-allowed'"), 'microphone permission denial is handled by name');
    assert.ok(html.includes('Microphone access was blocked'), 'mic denial shows a clear note, never a crash');
    assert.ok(html.includes('callRecogBlocked = true'), 'a blocked mic stops recognition retries instead of looping');
    const typed = html.slice(html.indexOf('async function runTest()'), html.indexOf("document.getElementById('btnTestSend').addEventListener"));
    assert.ok(typed.includes("if (callActive && res.type === 'reply') speakTestReply(res.text);"), 'a line typed during a call gets a spoken reply (the hear-the-bot fallback)');
  });
  await check('voice-call test: lifecycle — status line, transcript notes, switching bot or mode ends the call cleanly', async () => {
    assert.ok(html.includes("'On a test call with '"), 'the status line names the bot on the call');
    assert.ok(html.includes('📞 Test call started with '), 'call start is written into the transcript');
    assert.ok(html.includes("text: 'Test call ended.'"), 'call end is written into the transcript');
    const log = html.slice(html.indexOf('function renderTestLog()'), html.indexOf('function testExchange(msg)'));
    assert.ok(log.includes("m.who === 'note'"), 'the log renders call notes as transcript lines');
    const setMode = html.slice(html.indexOf('function setTestMode(mode)'), html.indexOf('function updateCallStatus()'));
    assert.ok(setMode.includes('endTestCall()'), 'switching back to Text mode mid-call ends the call');
    const select = html.slice(html.indexOf('function selectBot(id, scroll)'), html.indexOf("document.getElementById('pickGrid').addEventListener"));
    assert.ok(select.includes('endTestCall()'), 'switching bots mid-call ends the call');
    assert.ok(select.includes('renderTestMode();'), 'switching bots re-renders the test mode gate');
    const end = html.slice(html.indexOf('function endTestCall()'));
    assert.ok(end.includes('stopListening()'), 'ending the call stops recognition');
    assert.ok(end.includes('speechSynthesis.cancel()'), 'ending the call stops the bot mid-sentence');
    assert.ok(end.includes('clearInterval(callTimerId)'), 'ending the call stops the timer');
  });
  await check('voice-call test: self-contained — the call code makes no network calls and sends nothing', async () => {
    const block = html.slice(html.indexOf('test panel: voice-call mode'), html.indexOf('function renderAll()'));
    assert.ok(block.length > 500, 'voice-call block found');
    assert.ok(!block.includes('fetch('), 'no fetch in the test-call code');
    assert.ok(!block.includes('XMLHttpRequest'), 'no XHR in the test-call code');
    assert.ok(!block.includes('WebSocket'), 'no socket in the test-call code');
    assert.ok(!block.includes('getUserMedia'), 'microphone access goes through speech recognition only, never raw recording');
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

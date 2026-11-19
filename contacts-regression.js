'use strict';
/*
 * contacts-regression.js — the Contacts page (contacts.html), its
 * backend actions, and the Contacts BUTTON on every main page.
 *
 * Covers:
 *   A. cc-enroll-api contacts actions (list / tag / note / update /
 *      delete) — auth, round-trips against a fake enrollments store
 *      shared with the real workflow engine; existing actions
 *      (counts) unharmed.
 *   B. cc-data normalizers for the Custom Fields tab + the HL
 *      contact lookup (pure functions, fixture payloads, no network).
 *   C. contacts.html pure logic (extracted from the page): lead
 *      mapping, CRM/lead merge + dedupe, filters, CSV export,
 *      smart-list save/apply data, task create/complete/delete.
 *   D. Page wiring: endpoints, tabs, bulk bar, drawer, DND pattern.
 *   E. THE CONTACTS BUTTON: present + linking to /contacts.html on
 *      contacts.html AND index, conversations, workflows, calendar,
 *      dialer, closing-tracker, command-center; in index.html it is
 *      a sidebar nav-item between Conversations and Calendar.
 *
 * Fixtures only — no live HighLevel calls, no real contacts.
 * Run: node contacts-regression.js
 */
process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'test-pw';
const SECRET = process.env.DASHBOARD_PASSWORD;

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const enrollApi = require('./netlify/functions/cc-enroll-api');
const engine = require('./netlify/functions/cc-workflow-engine');
const wfStore = require('./netlify/functions/cc-workflows-store');
const ccData = require('./netlify/functions/cc-data');

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

// ---- fake Blobs store (same shape as the other suites) ----
class FakeStore {
  constructor() { this.data = new Map(); }
  async get(key, opts) {
    if (!this.data.has(key)) return null;
    const v = this.data.get(key);
    return opts && opts.type === 'json' ? JSON.parse(v) : v;
  }
  async set(key, val) { this.data.set(key, String(val)); }
  async delete(key) { this.data.delete(key); }
  async list() { return { blobs: [...this.data.keys()].map((key) => ({ key })) }; }
}
const enFake = new FakeStore();
const wfFake = new FakeStore();
const convFake = new FakeStore();
enrollApi._test.setStoreFactory(() => enFake);
wfStore._test.setStoreFactory(() => wfFake);
engine._test.setStores({ enrollments: enFake, conversations: convFake });
engine._test.setSendSms(async () => ({ id: 'test', from: '+14632783964' }));
engine._test.setRandom(() => 0);

function adminCookie() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return 'lm_auth=' + exp + '.' + sig;
}
function irishCookie() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', SECRET).update(exp + '.irish').digest('hex');
  return 'lm_irish=' + exp + '.irish.' + sig;
}
function callEnroll({ method = 'GET', action, body, cookie }) {
  const qs = {};
  if (action) qs.action = action;
  return enrollApi.handler({
    httpMethod: method,
    headers: cookie ? { cookie } : {},
    queryStringParameters: qs,
    body: body ? JSON.stringify(body) : null,
  });
}
const bodyOf = (res) => JSON.parse(res.body);
const readPage = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');

(async () => {
  console.log('— A. cc-enroll-api contacts actions —');
  await check('list without a cookie -> 401', async () => {
    const res = await callEnroll({ action: 'list' });
    assert.strictEqual(res.statusCode, 401);
  });
  await check('list with the Irish cookie -> 403', async () => {
    const res = await callEnroll({ action: 'list', cookie: irishCookie() });
    assert.strictEqual(res.statusCode, 403);
  });
  await check('list on an empty store -> 200 with zero contacts', async () => {
    const res = await callEnroll({ action: 'list', cookie: adminCookie() });
    assert.strictEqual(res.statusCode, 200);
    const d = bodyOf(res);
    assert.deepStrictEqual(d.contacts, []);
    assert.strictEqual(d.count, 0);
  });

  // Seed two real enrollments through the engine (published seed
  // workflow: indianapolis, trigger tag "indianapolis sms").
  await engine.enroll({
    phone: '+13175550111', name: 'Alice Able', firstName: 'Alice',
    address1: '1 Main St', city: 'Indianapolis',
    tags: ['indianapolis sms', 'lead - sms'],
  }, {});
  await engine.enroll({
    phone: '+13175550222', name: 'Bob Baker', firstName: 'Bob',
    address1: '2 Oak Ave', city: 'Indianapolis',
    tags: ['indianapolis sms', 'lead - sms', 'dnc'],
  }, {});

  let listed = null;
  await check('list returns the enrolled contacts, normalized', async () => {
    const res = await callEnroll({ action: 'list', cookie: adminCookie() });
    assert.strictEqual(res.statusCode, 200);
    listed = bodyOf(res).contacts;
    assert.strictEqual(listed.length, 2);
    const a = listed.find((c) => c.key === '13175550111');
    assert.ok(a, 'Alice present');
    assert.strictEqual(a.name, 'Alice Able');
    assert.strictEqual(a.phone, '+13175550111');
    assert.strictEqual(a.address1, '1 Main St');
    assert.strictEqual(a.market, 'indianapolis');
    assert.strictEqual(a.stage, 'queued');
    assert.ok(a.tags.includes('indianapolis sms'));
    assert.strictEqual(a.source, 'crm');
  });
  await check('list derives DND from the record (dnc tag -> sealed)', async () => {
    const b = listed.find((c) => c.key === '13175550222');
    assert.ok(b.dnd && b.dnd.allOn === true, 'Bob sealed');
    const a = listed.find((c) => c.key === '13175550111');
    assert.ok(a.dnd && a.dnd.anyOn === false, 'Alice open');
  });
  await check('existing counts action still answers', async () => {
    const res = await callEnroll({ action: 'counts', cookie: adminCookie() });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(bodyOf(res).total, 2);
  });
  await check('tag add + remove round-trips on the record', async () => {
    let res = await callEnroll({ method: 'POST', cookie: adminCookie(), body: { action: 'tag', phone: '+13175550111', add: ['hot lead'], remove: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(bodyOf(res).tags.includes('hot lead'));
    res = await callEnroll({ method: 'POST', cookie: adminCookie(), body: { action: 'tag', phone: '3175550111', add: [], remove: ['HOT LEAD'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!bodyOf(res).tags.some((t) => t.toLowerCase() === 'hot lead'), 'remove is case-insensitive');
    const rec = JSON.parse(enFake.data.get('13175550111'));
    assert.ok(!rec.tags.some((t) => t.toLowerCase() === 'hot lead'), 'persisted on the engine record');
  });
  await check('tag on an unknown phone -> 400', async () => {
    const res = await callEnroll({ method: 'POST', cookie: adminCookie(), body: { action: 'tag', phone: '+13175559999', add: ['x'] } });
    assert.strictEqual(res.statusCode, 400);
  });
  await check('note appends to the record', async () => {
    const res = await callEnroll({ method: 'POST', cookie: adminCookie(), body: { action: 'note', phone: '+13175550111', body: 'Seller wants a callback Friday.' } });
    assert.strictEqual(res.statusCode, 200);
    const notes = bodyOf(res).notes;
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].body, 'Seller wants a callback Friday.');
    assert.ok(typeof notes[0].at === 'number');
  });
  await check('update edits fields (email/state/zip land on the record)', async () => {
    const res = await callEnroll({
      method: 'POST', cookie: adminCookie(),
      body: { action: 'update', phone: '+13175550111', fields: { email: 'alice@example.com', state: 'IN', postalCode: '46201' } },
    });
    assert.strictEqual(res.statusCode, 200);
    const c = bodyOf(res).contact;
    assert.strictEqual(c.email, 'alice@example.com');
    assert.strictEqual(c.state, 'IN');
    assert.strictEqual(c.postalCode, '46201');
  });
  await check('delete removes the record AND its index entry', async () => {
    const res = await callEnroll({ method: 'POST', cookie: adminCookie(), body: { action: 'delete', phone: '+13175550222' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(enFake.data.has('13175550222'), false);
    const idx = JSON.parse(enFake.data.get('index'));
    assert.ok(!idx.enrollments['13175550222'], 'index entry removed');
    const after = await callEnroll({ action: 'list', cookie: adminCookie() });
    assert.strictEqual(bodyOf(after).count, 1);
  });
  await check('unknown action still -> 400', async () => {
    const res = await callEnroll({ method: 'POST', cookie: adminCookie(), body: { action: 'bogus' } });
    assert.strictEqual(res.statusCode, 400);
  });

  console.log('— B. cc-data normalizers (Custom Fields + HL lookup) —');
  await check('normalizeCustomFieldDefs maps name + type', async () => {
    const out = ccData._test.normalizeCustomFieldDefs({
      customFields: [
        { id: 'f1', name: 'ARV', fieldType: 'NUMERICAL' },
        { id: 'f2', name: 'Lead Source', dataType: 'TEXT' },
        { name: 'No id field' },
        null,
      ],
    });
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out[0], { id: 'f1', name: 'ARV', type: 'NUMERICAL' });
    assert.strictEqual(out[1].type, 'TEXT');
  });
  await check('normalizeContactLookup picks the exact phone match', async () => {
    const out = ccData._test.normalizeContactLookup({
      contacts: [
        { id: 'c1', contactName: 'Someone Else', phone: '+13175550000' },
        {
          id: 'c2', contactName: 'Alice Able', phone: '+1 (317) 555-0111',
          email: 'alice@example.com', tags: ['seller'],
          dndSettings: { SMS: { status: 'active' }, Email: { status: 'inactive' }, Call: true },
          customFields: [{ id: 'f1', fieldValue: '120000' }, { id: 'f2', value: 42 }],
        },
      ],
    }, '3175550111');
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.id, 'c2');
    assert.deepStrictEqual(out.dndChannels, { sms: true, email: false, call: true });
    assert.strictEqual(out.customFields[0].value, '120000');
    assert.strictEqual(out.customFields[1].value, '42');
  });
  await check('normalizeContactLookup on an empty page -> found:false', async () => {
    assert.deepStrictEqual(ccData._test.normalizeContactLookup({ contacts: [] }, 'x'), { found: false });
    assert.deepStrictEqual(ccData._test.normalizeContactLookup(null, 'x'), { found: false });
  });

  console.log('— C. contacts.html pure logic —');
  const html = readPage('contacts.html');
  const m = html.match(/\/\* ==PURE== \*\/([\s\S]*?)\/\* ==\/PURE== \*\//);
  assert.ok(m, 'pure block markers present');
  const P = new Function(m[1] + '; return { contactFromLead, mergeContacts, applyFilters, contactsToCsv, loadSmartLists, addSmartList, removeSmartList, loadTasks, addTask, setTaskDone, removeTask, SMART_KEY, TASK_KEY, LEADS_KEY };')();
  function fakeStorage() {
    return {
      data: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
      setItem(k, v) { this.data[k] = String(v); },
      removeItem(k) { delete this.data[k]; },
    };
  }
  const crmRows = [
    { key: '13175550111', phone: '+13175550111', name: 'Alice Able', email: '', address1: '1 Main St', city: 'Indianapolis', state: 'IN', postalCode: '46201', tags: ['indianapolis sms'], market: 'indianapolis', stage: 'queued', enrolledAt: 100, notes: [], dnd: { anyOn: false, allOn: false, channels: { sms: false, email: false, call: false } }, source: 'crm' },
    { key: '13175550222', phone: '+13175550222', name: 'Bob Baker', email: 'bob@x.com', address1: '2 Oak Ave', city: 'Indianapolis', state: 'IN', postalCode: '46202', tags: ['dnc'], market: 'indianapolis', stage: 'queued', enrolledAt: 200, notes: [], dnd: { anyOn: true, allOn: true, channels: { sms: true, email: true, call: true } }, source: 'crm' },
  ];
  const leadRows = [
    { id: 'L1', owner: 'Alice A.', address: '1 Main St', city: 'Indianapolis', state: 'IN', zip: '46201', market: 'Indianapolis', distressSignal: 'Code Violation', status: 'New Lead', phones: [{ number: '(317) 555-0111', type: 'Mobile' }], addedAt: '2026-11-01T00:00:00Z' },
    { id: 'L2', owner: 'Carol Coe', address: '9 Pine Rd', city: 'Gary', state: 'IN', zip: '46401', market: 'Gary', distressSignal: 'Tax Lien', status: 'Skip Traced', phones: [{ number: '+13175550333', type: 'Mobile' }], addedAt: '2026-11-02T00:00:00Z' },
  ];
  await check('contactFromLead maps the My Leads shape', async () => {
    const r = P.contactFromLead(leadRows[1]);
    assert.strictEqual(r.source, 'lead');
    assert.strictEqual(r.name, 'Carol Coe');
    assert.strictEqual(r.phone, '+13175550333');
    assert.strictEqual(r.postalCode, '46401');
    assert.strictEqual(r.signal, 'Tax Lien');
    assert.strictEqual(r.stage, 'Skip Traced');
  });
  await check('mergeContacts dedupes by phone — CRM wins, marked both', async () => {
    const merged = P.mergeContacts(crmRows, leadRows);
    assert.strictEqual(merged.length, 3);
    const alice = merged.find((r) => r.name === 'Alice Able');
    assert.strictEqual(alice.source, 'both');
    assert.strictEqual(alice.leadId, 'L1');
    const carol = merged.find((r) => r.name === 'Carol Coe');
    assert.strictEqual(carol.source, 'lead');
  });
  await check('applyFilters: search, market, tag, stage, dnd', async () => {
    const merged = P.mergeContacts(crmRows, leadRows);
    assert.strictEqual(P.applyFilters(merged, { q: 'alice' }).length, 1);
    assert.strictEqual(P.applyFilters(merged, { q: '5550222' }).length, 1, 'phone digits search');
    assert.strictEqual(P.applyFilters(merged, { market: 'indianapolis' }).length, 2);
    assert.strictEqual(P.applyFilters(merged, { tag: 'DNC' }).length, 1, 'tag match is case-insensitive');
    assert.strictEqual(P.applyFilters(merged, { stage: 'Skip Traced' }).length, 1);
    assert.strictEqual(P.applyFilters(merged, { dnd: 'on' }).length, 1);
    assert.strictEqual(P.applyFilters(merged, { dnd: 'off' }).length, 1, 'lead rows (unknown DND) excluded from both DND filters');
    assert.strictEqual(P.applyFilters(merged, {}).length, 3);
  });
  await check('contactsToCsv: header, rows, quoting', async () => {
    const csv = P.contactsToCsv([{ name: 'Doe, Jane', phone: '+13175550111', email: '', address1: '1 "A" St', city: 'Indy', state: 'IN', postalCode: '46201', tags: ['a', 'b'], market: 'indianapolis', stage: 'queued', source: 'crm' }]);
    const lines = csv.split('\n');
    assert.strictEqual(lines[0], 'Name,Phone,Email,Address,City,State,ZIP,Tags,Market,Stage,Source');
    assert.ok(lines[1].startsWith('"Doe, Jane",+13175550111'));
    assert.ok(lines[1].includes('"1 ""A"" St"'));
    assert.ok(lines[1].includes('a; b'));
  });
  await check('smart lists: save / load / delete via storage', async () => {
    const st = fakeStorage();
    assert.deepStrictEqual(P.loadSmartLists(st), []);
    assert.strictEqual(P.addSmartList(st, '  ', {}), null, 'blank name refused');
    const e = P.addSmartList(st, 'Indy queued', { market: 'indianapolis', stage: 'queued' });
    assert.ok(e && e.id);
    const lists = P.loadSmartLists(st);
    assert.strictEqual(lists.length, 1);
    assert.strictEqual(lists[0].name, 'Indy queued');
    assert.strictEqual(lists[0].filters.market, 'indianapolis');
    assert.ok(st.data[P.SMART_KEY], 'persisted under acc_smart_lists');
    P.removeSmartList(st, e.id);
    assert.deepStrictEqual(P.loadSmartLists(st), []);
  });
  await check('tasks: create / complete / reopen / delete via storage', async () => {
    const st = fakeStorage();
    assert.strictEqual(P.addTask(st, { title: ' ' }), null, 'blank title refused');
    const t = P.addTask(st, { contactId: 'crm:13175550111', contactName: 'Alice Able', title: 'Call back', due: '2026-11-25' });
    assert.ok(t && t.id && t.done === false);
    assert.strictEqual(P.loadTasks(st).length, 1);
    assert.ok(st.data[P.TASK_KEY], 'persisted under acc_contact_tasks');
    P.setTaskDone(st, t.id, true);
    assert.strictEqual(P.loadTasks(st)[0].done, true);
    P.setTaskDone(st, t.id, false);
    assert.strictEqual(P.loadTasks(st)[0].done, false);
    P.removeTask(st, t.id);
    assert.deepStrictEqual(P.loadTasks(st), []);
  });
  await check('storage keys follow the dashboard acc_* pattern', async () => {
    assert.strictEqual(P.SMART_KEY, 'acc_smart_lists');
    assert.strictEqual(P.TASK_KEY, 'acc_contact_tasks');
    assert.strictEqual(P.LEADS_KEY, 'acc_leads');
  });

  console.log('— D. contacts.html wiring —');
  await check('page loads: structure, tabs, table, bulk bar, drawer', async () => {
    for (const needle of ['id="contactsTable"', 'id="contactsBody"', 'id="bulkBar"', 'id="selectAll"',
      'data-tab="contacts"', 'data-tab="smart"', 'data-tab="fields"', 'data-tab="tasks"',
      'id="tab-contacts"', 'id="tab-smart"', 'id="tab-fields"', 'id="tab-tasks"',
      'id="drawer"', 'id="fSearch"', 'id="fMarket"', 'id="fTag"', 'id="fStage"', 'id="fDnd"']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
  });
  await check('page is wired to the real endpoints', async () => {
    for (const needle of ['cc-enroll-api', "action: 'tag'", "action: 'note'", "action: 'update'",
      "action: 'delete'", "action: 'enroll'", 'cc-conversations-api', "action: 'dnd-set'",
      'cc-data', 'customfields', 'contactlookup', 'cc-workflows-api', 'cc-calendar-api']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
  });
  await check('bulk actions present: tag, workflow, export, delete', async () => {
    for (const needle of ['id="bulkAddTag"', 'id="bulkRemoveTag"', 'id="bulkAddWorkflow"', 'id="bulkExport"', 'id="bulkDelete"', 'contactsToCsv', "a.download = 'contacts-export.csv'"]) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
  });
  await check('detail view: DND channels mirror conversations.html', async () => {
    for (const needle of ["{ id: 'sms', label: 'Text Messages' }", "{ id: 'email', label: 'Email' }", "{ id: 'call', label: 'Calls & voicemail' }", 'DNC this contact', 'data-dnd-channel', 'data-dnd-action']) {
      assert.ok(html.includes(needle), 'missing ' + needle);
    }
  });
  await check('detail opens from a row click; tasks + smart lists render', async () => {
    assert.ok(html.includes('function openDetail('), 'openDetail');
    assert.ok(html.includes("addEventListener('click'"), 'click wiring');
    assert.ok(html.includes('function renderTasks('), 'renderTasks');
    assert.ok(html.includes('function renderSmartChips('), 'renderSmartChips');
    assert.ok(html.includes('function renderSmartListTab('), 'renderSmartListTab');
    assert.ok(html.includes('function loadFields('), 'loadFields');
  });

  console.log('— E. THE CONTACTS BUTTON on every main page —');
  const NAV_PAGES = ['index.html', 'contacts.html', 'conversations.html', 'workflows.html', 'calendar.html', 'dialer.html', 'closing-tracker.html', 'command-center.html'];
  for (const page of NAV_PAGES) {
    await check(page + ': Contacts button present, linking to /contacts.html', async () => {
      const h = readPage(page);
      assert.ok(h.includes('href="/contacts.html"'), page + ' has no link to /contacts.html');
      assert.ok(h.includes('Contacts</a>'), page + ' link is not labeled Contacts');
    });
  }
  await check('index.html: sidebar nav-item styled like Conversations, right after it', async () => {
    const h = readPage('index.html');
    const conv = h.indexOf('href="/conversations.html"');
    const contacts = h.indexOf('href="/contacts.html"');
    const cal = h.indexOf('href="/calendar.html"');
    assert.ok(conv > -1 && contacts > conv, 'Contacts must follow Conversations in the sidebar');
    assert.ok(cal > contacts, 'Contacts must sit before Calendar');
    const anchor = h.slice(h.lastIndexOf('<a', contacts), h.indexOf('</a>', contacts));
    assert.ok(anchor.includes('class="nav-item"'), 'Contacts entry must be a sidebar nav-item like Conversations');
    assert.ok(anchor.includes('👥'), 'Contacts entry carries its icon');
  });
  await check('contacts.html: its own Contacts button is the active nav entry', async () => {
    assert.ok(html.includes('class="back active" href="/contacts.html"'), 'contacts.html topbar Contacts button');
  });

  console.log('');
  console.log('contacts-regression: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL CONTACTS CHECKS PASS');
})().catch((e) => {
  console.error('REGRESSION CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});

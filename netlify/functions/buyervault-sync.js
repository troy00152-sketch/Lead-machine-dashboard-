// netlify/functions/buyervault-sync.js
// BuyerVault Pro §5A (3) — one-click qualified-buyer sync toward
// HighLevel (spec §16). BUILT IN TEST/OFF STATE:
//
//   - The sync threshold is TROY'S UNDECIDED CALL. Config defaults to
//     enabled=false with the spec's recommended minScore=60 shown as a
//     recommendation only. Nothing in this file performs a live
//     HighLevel write: a live run requires ALL THREE gates — config
//     enabled (admin, after Troy decides), BUYERVAULT_SYNC_LIVE=1 in the
//     Netlify env, and GHL credentials in env — and the live transport
//     is intentionally not wired in this build, so even with the gates
//     open the run stops at 'blocked_not_wired' and logs it. No buyer
//     has ever been synced by this function.
//   - Preview is real: it runs the §5 qualification gate over the
//     exported sync index and reports eligible counts, exclusion
//     reasons, and a sample — with zero HighLevel calls.
//   - Every preview/sync attempt writes a sync-log row (Blobs store
//     'buyervault-sync'), so the OFF state is auditable, not silent.
//
//   GET  ?action=config            current config (defaults OFF)
//   GET  ?action=preview           eligibility preview vs current config
//   GET  ?action=log               recent sync-log rows
//   POST {action:'config', ...}    save config (admin only)
//   POST {action:'sync', dryRun}   attempt a sync (admin only; blocked
//                                  unless every gate passes — see above)
'use strict';

const lib = require('./buyervault-lib');
const META = require('./buyervault-meta.json');
const INDEX = require('./buyervault-sync-index.json');

const CONFIG_KEY = 'config';
const LOG_KEY = 'log';
const MAX_LOG = 100;

async function readConfig(event) {
  const s = lib.store(event, 'buyervault-sync');
  return lib.syncConfig(await s.get(CONFIG_KEY));
}
async function writeConfig(event, cfg) {
  const s = lib.store(event, 'buyervault-sync');
  await s.set(CONFIG_KEY, cfg);
}
async function readLog(event) {
  const s = lib.store(event, 'buyervault-sync');
  const v = await s.get(LOG_KEY);
  return Array.isArray(v) ? v : [];
}
async function appendLog(event, row) {
  const s = lib.store(event, 'buyervault-sync');
  const log = await readLog(event);
  log.unshift(row);
  await s.set(LOG_KEY, log.slice(0, MAX_LOG));
  return log;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return lib.json(200, {});
    const p = event.queryStringParameters || {};
    let body = {};
    if (event.body) { try { body = JSON.parse(event.body); } catch (e) { return lib.json(400, { error: 'Bad JSON body.' }); } }
    const action = p.action || body.action || 'config';

    if (action === 'config') {
      const cfg = await readConfig(event);
      return lib.json(200, {
        config: cfg, dataAsOf: META.generatedAt,
        liveEnvFlag: process.env.BUYERVAULT_SYNC_LIVE === '1',
        gate: lib.syncGate(cfg),
      });
    }
    if (action === 'preview') {
      const cfg = await readConfig(event);
      const prev = lib.syncPreview(INDEX, cfg, 25);
      return lib.json(200, { config: cfg, preview: prev, dataAsOf: META.generatedAt });
    }
    if (action === 'log') {
      return lib.json(200, { log: (await readLog(event)).slice(0, 25) });
    }

    // --- admin-only below ---
    if (!lib.isAdmin(event)) {
      return lib.json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
    }

    if (action === 'config' && event.httpMethod === 'POST') {
      const cfg = lib.syncConfig({
        enabled: body.enabled === true,
        minScore: body.minScore,
        requirePhone: body.requirePhone,
        requireBuyBox: body.requireBuyBox,
        updatedAt: new Date().toISOString(),
        updatedBy: 'dashboard-admin',
        note: lib.SYNC_DEFAULTS.note,
      });
      await writeConfig(event, cfg);
      await appendLog(event, {
        at: new Date().toISOString(), action: 'config_saved',
        detail: `enabled=${cfg.enabled} minScore=${cfg.minScore} requirePhone=${cfg.requirePhone} requireBuyBox=${cfg.requireBuyBox}`,
      });
      return lib.json(200, { config: cfg, gate: lib.syncGate(cfg) });
    }

    if (action === 'sync') {
      const cfg = await readConfig(event);
      const prev = lib.syncPreview(INDEX, cfg, 0);
      const dryRun = body.dryRun !== false;
      const gate = lib.syncGate(cfg);
      if (gate) {
        await appendLog(event, {
          at: new Date().toISOString(), action: 'sync_blocked',
          detail: gate, eligible: prev.eligible, dryRun,
        });
        return lib.json(200, {
          synced: 0, eligible: prev.eligible, blocked: true, reason: gate,
          config: cfg,
        });
      }
      if (dryRun) {
        await appendLog(event, {
          at: new Date().toISOString(), action: 'sync_dry_run',
          detail: `Dry run only — ${prev.eligible} buyers would sync. No HighLevel calls made.`,
          eligible: prev.eligible, dryRun: true,
        });
        return lib.json(200, { synced: 0, eligible: prev.eligible, dryRun: true, config: cfg });
      }
      // Gates passed and a live run was requested. The live HighLevel
      // transport is NOT wired in this build (threshold undecided), so
      // the run stops here — loudly, in the log — instead of pretending.
      const reason = 'Live HighLevel transport is not wired in this build: the sync '
        + 'threshold is still undecided, so no live sync path ships until Troy decides it.';
      await appendLog(event, {
        at: new Date().toISOString(), action: 'blocked_not_wired',
        detail: reason, eligible: prev.eligible, dryRun: false,
      });
      return lib.json(200, { synced: 0, eligible: prev.eligible, blocked: true, reason, config: cfg });
    }

    return lib.json(400, { error: 'Unknown action.' });
  } catch (e) {
    return lib.json(503, { error: 'BuyerVault sync is not ready yet', detail: String((e && e.message) || e) });
  }
};

exports._test = { readConfig };

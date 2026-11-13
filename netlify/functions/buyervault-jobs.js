// netlify/functions/buyervault-jobs.js
// BuyerVault Pro §5A (1)+(4) — ingestion jobs with status display
// (spec §6.4/§6.5) and saved-market monitoring (spec §6.6).
//
// Job semantics in this stack: a refresh job reads the bundled BuyerVault
// snapshot (stored data) and reports real per-source counts. External
// pulls that could spend credits (PropertyReach Core, county recorder)
// are recorded as blocked_budget at the pre-flight gate [HARD RULE B] —
// they are never run from the dashboard. Jobs and saved markets persist
// in Netlify Blobs (stores 'buyervault-jobs' / 'buyervault-saved');
// cadence is recorded per saved market and lastRefreshedAt advances ONLY
// when a refresh job actually runs (never faked).
//
//   GET  ?action=jobs                      recent jobs
//   GET  ?action=job&id=<id>               one job (poll target)
//   POST {action:'refresh', market}        create + run a refresh job
//   GET  ?action=saved                     saved markets + status
//   POST {action:'save', market, cadence}  save a market (admin)
//   POST {action:'unsave', id}             remove a saved market (admin)
//   POST {action:'cadence', id, cadence}   set cadence (admin)
//   POST {action:'refreshSaved', id}       refresh one saved market (admin)
'use strict';

const lib = require('./buyervault-lib');
const META = require('./buyervault-meta.json');
const INDEX = require('./buyervault-markets.json');

const BY_KEY = new Map((INDEX.markets || []).map((m) => [m.key, m]));
const JOBS_KEY = 'jobs';
const SAVED_KEY = 'saved';
const MAX_JOBS = 50;

async function readJobs(event) {
  const s = lib.store(event, 'buyervault-jobs');
  const v = await s.get(JOBS_KEY);
  return Array.isArray(v) ? v : [];
}
async function writeJobs(event, jobs) {
  const s = lib.store(event, 'buyervault-jobs');
  await s.set(JOBS_KEY, jobs.slice(0, MAX_JOBS));
}
async function readSaved(event) {
  const s = lib.store(event, 'buyervault-saved');
  const v = await s.get(SAVED_KEY);
  return Array.isArray(v) ? v : [];
}
async function writeSaved(event, saved) {
  const s = lib.store(event, 'buyervault-saved');
  await s.set(SAVED_KEY, saved);
}
function savedView(saved) {
  const now = Date.now();
  return saved.map((m) => Object.assign({}, m, {
    nextDueAt: lib.nextDueAt(m),
    status: lib.monitoringStatus(m, now),
  }));
}

async function runRefresh(event, market, trigger, savedId) {
  const job = lib.buildJob(market, trigger, META);
  const jobs = await readJobs(event);
  jobs.unshift(job);
  await writeJobs(event, jobs);
  if (savedId) {
    const saved = await readSaved(event);
    const rec = saved.find((m) => m.id === savedId);
    if (rec) {
      rec.lastRefreshedAt = job.finishedAt;
      rec.lastJobId = job.id;
      rec.lastState = job.state;
      rec.lastCounts = { buyers: market.buyers || 0, qualified: market.qualified || 0, candidates: market.candidates || 0 };
      await writeSaved(event, saved);
    }
  }
  return job;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return lib.json(200, {});
    const p = event.queryStringParameters || {};
    let body = {};
    if (event.body) { try { body = JSON.parse(event.body); } catch (e) { return lib.json(400, { error: 'Bad JSON body.' }); } }
    const action = p.action || body.action || 'jobs';

    if (action === 'jobs') {
      const jobs = await readJobs(event);
      return lib.json(200, { jobs: jobs.slice(0, 20), dataAsOf: META.generatedAt });
    }
    if (action === 'job') {
      const jobs = await readJobs(event);
      const job = jobs.find((j) => j.id === (p.id || body.id));
      if (!job) return lib.json(404, { error: 'Job not found.' });
      return lib.json(200, { job });
    }
    if (action === 'saved') {
      const saved = await readSaved(event);
      return lib.json(200, { saved: savedView(saved), dataAsOf: META.generatedAt });
    }

    // --- writes below are admin-only (dashboard lm_auth cookie) ---
    if (!lib.isAdmin(event)) {
      return lib.json(401, { error: 'Not signed in — open the dashboard and sign in first.' });
    }

    if (action === 'refresh') {
      const market = BY_KEY.get(body.market || '');
      if (!market) return lib.json(404, { error: 'Unknown market key.' });
      const job = await runRefresh(event, market, body.trigger || 'manual', null);
      return lib.json(200, { job });
    }
    if (action === 'save') {
      const market = BY_KEY.get(body.market || '');
      if (!market) return lib.json(404, { error: 'Unknown market key.' });
      const saved = await readSaved(event);
      if (saved.some((m) => m.marketKey === market.key)) {
        return lib.json(200, { saved: savedView(saved), note: 'Market already saved.' });
      }
      const cadence = ['daily', 'weekly', 'paused'].includes(body.cadence) ? body.cadence : 'weekly';
      saved.push({
        id: lib.uid('mkt'), marketKey: market.key, label: market.label,
        cadence, createdAt: new Date().toISOString(),
        lastRefreshedAt: null, lastJobId: null, lastState: null, lastCounts: null,
      });
      await writeSaved(event, saved);
      return lib.json(200, { saved: savedView(saved) });
    }
    if (action === 'unsave') {
      let saved = await readSaved(event);
      saved = saved.filter((m) => m.id !== body.id);
      await writeSaved(event, saved);
      return lib.json(200, { saved: savedView(saved) });
    }
    if (action === 'cadence') {
      const saved = await readSaved(event);
      const rec = saved.find((m) => m.id === body.id);
      if (!rec) return lib.json(404, { error: 'Saved market not found.' });
      if (!['daily', 'weekly', 'paused'].includes(body.cadence)) return lib.json(400, { error: 'Unknown cadence.' });
      rec.cadence = body.cadence;
      await writeSaved(event, saved);
      return lib.json(200, { saved: savedView(saved) });
    }
    if (action === 'refreshSaved') {
      const saved = await readSaved(event);
      const rec = saved.find((m) => m.id === body.id);
      if (!rec) return lib.json(404, { error: 'Saved market not found.' });
      const market = BY_KEY.get(rec.marketKey);
      if (!market) return lib.json(404, { error: 'Saved market no longer exists in the stored index.' });
      const job = await runRefresh(event, market, 'monitoring', rec.id);
      const after = await readSaved(event);
      return lib.json(200, { job, saved: savedView(after) });
    }
    return lib.json(400, { error: 'Unknown action.' });
  } catch (e) {
    return lib.json(503, { error: 'BuyerVault jobs are not ready yet', detail: String((e && e.message) || e) });
  }
};

exports._test = { savedView, BY_KEY };

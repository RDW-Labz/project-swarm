// SPDX-License-Identifier: Apache-2.0
import { sanitizeWorkerText } from './worker-text.mjs';

const WAVES = ['contracts', 'build', 'verify'];
const FINISHED_STATES = ['complete', 'integrated', 'integrated-with-failures', 'failed', 'cancelled', 'error', 'timeout'];
const COMPLETE_STATES = ['complete', 'integrated', 'integrated-with-failures'];
const RUN_FAILED_STATES = ['failed', 'cancelled', 'error', 'timeout'];
const JOB_FAILED_STATES = ['failed', 'timeout'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function toIso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function txt(v) {
  return typeof v === 'string' ? sanitizeWorkerText(v, 200) : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function waveOf(manifestWave, type) {
  if (WAVES.includes(manifestWave)) return manifestWave;
  if (type === 'contract') return 'contracts';
  if (type === 'test') return 'verify';
  return 'build';
}

function byMsDesc(a, b) {
  const ka = a.ms == null ? -Infinity : a.ms;
  const kb = b.ms == null ? -Infinity : b.ms;
  if (ka < kb) return 1;
  if (ka > kb) return -1;
  return 0;
}

export function buildRunSnapshot(state, opts) {
  const { manifest = null, now = Date.now() } = opts || {};
  const s = state || {};
  const startedAt = toMs(s.startedAt);
  const finishedAt = toMs(s.finishedAt);
  const elapsedMs = startedAt == null ? 0 : (finishedAt ?? now) - startedAt;
  const runFinished = FINISHED_STATES.includes(s.status);

  let status;
  if (s.pause && !runFinished) status = 'paused';
  else if (COMPLETE_STATES.includes(s.status)) status = 'complete';
  else if (RUN_FAILED_STATES.includes(s.status)) status = 'failed';
  else status = 'live';

  const mById = new Map();
  const mJobs = manifest && Array.isArray(manifest.jobs) ? manifest.jobs : [];
  for (const m of mJobs) {
    if (m && typeof m === 'object') {
      const mid = txt(m.id);
      if (mid != null) mById.set(mid, m);
    }
  }

  const rows = [];
  const rawJobs = Array.isArray(s.jobs) ? s.jobs : [];
  for (const j of rawJobs) {
    if (!j || typeof j !== 'object') continue;
    const id = txt(j.id);
    if (id == null || !ID_RE.test(id)) continue;
    const attempts = Array.isArray(j.attempts) ? j.attempts : [];
    const m = mById.get(id) || null;
    const lane = txt(j.lane) || txt(j.agent) || null;
    const out = {
      id,
      status: txt(j.status),
      lane,
      agent: txt(j.agent),
      model: txt(j.model),
      attempts: attempts.length,
      lead: m ? txt(m.lead) : null,
      wave: m ? txt(m.wave) : null,
      type: m ? txt(m.type) : null,
      file: Array.isArray(j.outputs) && j.outputs.length ? txt(j.outputs[0]) : null,
      costUsd: num(j.costUsd),
      durationMs: num(j.durationMs)
    };
    rows.push({
      raw: j,
      out,
      attempts,
      lane,
      wave: waveOf(out.wave, out.type),
      lead: out.lead || 'main'
    });
  }

  const jobs = rows.map((r) => r.out);
  const isDone = (r) => r.out.status === 'complete';
  const isFailed = (r) => JOB_FAILED_STATES.includes(r.out.status);
  const isFinishedJob = (r) => isDone(r) || isFailed(r);
  const countWhere = (fn) => rows.filter(fn).length;

  const finishedCount = countWhere(isFinishedJob);
  const running = countWhere((r) => r.out.status === 'running');
  const queued = countWhere((r) => r.out.status === 'queued');
  const firstTry = countWhere((r) => isDone(r) && r.out.attempts <= 1);
  const spendUsd = sum(rows.map((r) => r.out.costUsd));
  const elapsedSec = elapsedMs / 1000;
  const jobsPerSec = elapsedSec > 0 ? finishedCount / elapsedSec : 0;
  const inFlightCount = running + queued;
  let etaMs;
  if (inFlightCount === 0) etaMs = 0;
  else if (jobsPerSec === 0) etaMs = null;
  else etaMs = Math.round(inFlightCount / jobsPerSec * 1000);

  const kpi = {
    total: rows.length,
    done: countWhere(isDone),
    running,
    queued,
    failed: countWhere(isFailed),
    cancelled: countWhere((r) => r.out.status === 'cancelled'),
    retries: sum(rows.map((r) => Math.max(0, r.out.attempts - 1))),
    firstTryPassRate: finishedCount ? firstTry / finishedCount : null,
    peakInFlight: num(s.peakConcurrency),
    spendUsd,
    jobsPerSec,
    etaMs
  };

  const laneDefs = s.lanes && s.lanes.lanes && typeof s.lanes.lanes === 'object' ? s.lanes.lanes : {};
  const laneEntries = Object.keys(laneDefs)
    .map((key) => ({ key, name: txt(key) }))
    .filter((e) => e.name)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lanes = laneEntries.map(({ key, name }) => {
    const raw = laneDefs[key];
    const e = raw && typeof raw === 'object' ? raw : {};
    const on = rows.filter((r) => r.lane === name);
    const done = on.filter(isDone).length;
    const failed = on.filter(isFailed).length;
    const durs = on
      .filter((r) => isFinishedJob(r) && typeof r.raw.durationMs === 'number' && Number.isFinite(r.raw.durationMs))
      .map((r) => r.raw.durationMs);
    const offline = e.state !== 'ok';
    const stateText = txt(e.state);
    return {
      name,
      state: stateText,
      offline,
      inFlight: num(e.inFlight),
      limit: num(e.concurrency),
      done,
      failed,
      passRate: done + failed > 0 ? done / (done + failed) : null,
      avgMs: durs.length ? sum(durs) / durs.length : null,
      rateLimits: sum(on.map((r) => num(r.raw.rateLimitRetries))),
      costUsd: sum(on.map((r) => r.out.costUsd)),
      reason: offline ? name + ' ' + (stateText == null ? 'unknown' : stateText) : null
    };
  });

  const waves = WAVES.map((name) => {
    const on = rows.filter((r) => r.wave === name);
    return {
      name,
      total: on.length,
      done: on.filter(isDone).length,
      running: on.filter((r) => r.out.status === 'running').length
    };
  });

  const items = [];
  for (const r of rows) {
    const j = r.raw;
    const id = r.out.id;
    const startedFallback = toMs(j.startedAt);
    const fallback = toMs(j.finishedAt) ?? startedFallback ?? startedAt;
    if (r.attempts.length > 1) {
      const last = r.attempts[r.attempts.length - 1];
      const prev = r.attempts[r.attempts.length - 2];
      items.push({
        ms: toMs(last && last.startedAt) ?? fallback,
        kind: 'retry',
        severity: 'warn',
        jobId: id,
        text: txt(prev && prev.error) || 'retry'
      });
    }
    if (isFailed(r)) {
      const report = j.report && typeof j.report === 'object' ? j.report : null;
      items.push({
        ms: fallback,
        kind: 'failure',
        severity: 'error',
        jobId: id,
        text: txt(j.error) || txt(report ? report.summary : null) || r.out.status
      });
    }
    const rl = num(j.rateLimitRetries);
    if (rl > 0) {
      items.push({
        ms: fallback,
        kind: 'rate-limit',
        severity: 'warn',
        jobId: id,
        text: rl + ' rate-limit retries'
      });
    }
  }
  if (s.pause) {
    items.push({ ms: startedAt, kind: 'pause', severity: 'warn', jobId: null, text: 'run paused' });
  }
  const conflicts = s.mergeQueue && Array.isArray(s.mergeQueue.conflicts) ? s.mergeQueue.conflicts : [];
  for (const c of conflicts) {
    let raw;
    if (typeof c === 'string') raw = c;
    else if (c && typeof c === 'object' && typeof c.file === 'string') raw = c.file;
    else raw = JSON.stringify(c);
    items.push({
      ms: startedAt,
      kind: 'conflict',
      severity: 'error',
      jobId: null,
      text: txt(raw) || 'conflict'
    });
  }
  const attention = items.sort(byMsDesc).slice(0, 50).map((a) => ({
    at: toIso(a.ms),
    kind: a.kind,
    severity: a.severity,
    jobId: a.jobId,
    text: a.text
  }));

  const leadNames = [...new Set(rows.map((r) => r.lead))].sort();
  const leads = leadNames.map((lead) => {
    const on = rows.filter((r) => r.lead === lead);
    const total = on.length;
    const done = on.filter(isDone).length;
    const runningN = on.filter((r) => r.out.status === 'running').length;
    const failedN = on.filter(isFailed).length;
    let leadState;
    if (runningN) leadState = 'running';
    else if (failedN) leadState = 'failed';
    else if (total > 0 && done === total) leadState = 'done';
    else leadState = 'queued';
    return {
      lead,
      total,
      done,
      running: runningN,
      retries: sum(on.map((r) => Math.max(0, r.out.attempts - 1))),
      spendUsd: sum(on.map((r) => r.out.costUsd)),
      state: leadState
    };
  });

  const mq = s.mergeQueue;
  let mergeQueue = null;
  if (mq != null) {
    const batches = Array.isArray(mq.batches) ? mq.batches : [];
    const integrated = Array.isArray(mq.integrated) ? mq.integrated : [];
    const conflictList = Array.isArray(mq.conflicts) ? mq.conflicts : [];
    mergeQueue = {
      state: txt(mq.state),
      batches: batches.length,
      integrated: integrated.length,
      conflicts: conflictList.length,
      bisects: batches.filter((b) => b && b.bisected).length,
      recent: batches.slice(-12).map((b) => {
        if (b && b.bisected) return 'bisect';
        if (b && Array.isArray(b.conflicts) && b.conflicts.length > 0) return 'conflict';
        return 'ok';
      })
    };
  }

  let rollup = null;
  if (status === 'complete' || status === 'failed') {
    const spendByLane = {};
    for (const r of rows) {
      if (r.lane == null) continue;
      spendByLane[r.lane] = (spendByLane[r.lane] || 0) + r.out.costUsd;
    }
    rollup = {
      counts: {
        done: kpi.done,
        failed: kpi.failed,
        cancelled: kpi.cancelled,
        total: kpi.total
      },
      spendByLane,
      elapsedMs,
      branch: txt(s.branch)
    };
  }

  const runIdText = txt(s.id);
  const runId = runIdText != null && ID_RE.test(runIdText) ? runIdText : null;

  return {
    schema: 1,
    runId,
    goal: manifest ? txt(manifest.goal) : null,
    branch: txt(s.branch),
    status,
    startedAt: toIso(startedAt),
    finishedAt: toIso(finishedAt),
    elapsedMs,
    kpi,
    jobs,
    lanes,
    waves,
    attention,
    leads,
    mergeQueue,
    rollup
  };
}

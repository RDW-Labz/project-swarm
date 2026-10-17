// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANES = [
  { name: 'hermes', agent: 'hermes', state: 'offline' },
  { name: 'cursor', agent: 'cursor', state: 'ok' },
  { name: 'codex', agent: 'codex', state: 'ok' },
  { name: 'anthropic', agent: 'anthropic', state: 'ok' },
  { name: 'openrouter', agent: 'openrouter', state: 'ok' },
  { name: 'claude', agent: 'claude', state: 'ok' },
];
const LEADS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const MODELS = ['gpt-5', 'claude-sonnet', 'gemini-pro', 'qwen-coder'];
const WAVES = ['contracts', 'build', 'verify'];
const TYPES = ['contract', 'build', 'test'];

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function buildRun(runId, jobCount, now, rnd, root) {
  const startedAt = now - 3600_000;
  const laneStats = {};
  for (const l of LANES) laneStats[l.name] = { inFlight: 0, peak: 0 };
  const jobs = [];
  const manifestJobs = [];
  for (let i = 0; i < jobCount; i++) {
    const id = `job-${String(i + 1).padStart(4, '0')}`;
    const lane = LANES[i % LANES.length];
    const lead = LEADS[i % LEADS.length];
    const wave = WAVES[Math.floor(rnd() * 3)];
    const type = TYPES[WAVES.indexOf(wave)];
    const model = MODELS[Math.floor(rnd() * MODELS.length)];
    const r = rnd();
    let status;
    if (r < 0.6) status = 'complete';
    else if (r < 0.65) status = 'running';
    else if (r < 0.92) status = 'queued';
    else status = 'failed';
    const twoAttempts = status !== 'queued' && rnd() < 0.08;
    const jobStart = startedAt + Math.floor(rnd() * 3000_000);
    const durationMs = 20_000 + Math.floor(rnd() * 180_000);
    const attempts = [];
    const file = `src/${lead}/${id}.mjs`;
    if (status !== 'queued') {
      if (twoAttempts) {
        attempts.push({
          agent: lane.agent, model, status: 'failed', error: 'lint failed',
          startedAt: isoAt(jobStart), finishedAt: isoAt(jobStart + durationMs / 2),
        });
      }
      const attStart = twoAttempts ? jobStart + durationMs / 2 : jobStart;
      attempts.push({
        agent: lane.agent, model,
        status: status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'complete',
        error: status === 'failed' ? 'tests did not pass' : null,
        startedAt: isoAt(attStart),
        finishedAt: status === 'running' ? null : isoAt(attStart + durationMs / 2),
      });
    }
    const finished = status === 'complete' || status === 'failed';
    jobs.push({
      id, lane: lane.name, agent: lane.agent, model,
      outputs: [file],
      status,
      attempts,
      costUsd: Math.round(rnd() * 400) / 100,
      durationMs: finished ? durationMs : null,
      rateLimitRetries: rnd() < 0.1 ? 1 : 0,
      startedAt: status === 'queued' ? null : isoAt(jobStart),
      finishedAt: finished ? isoAt(jobStart + durationMs) : null,
      error: status === 'failed' ? 'tests did not pass' : null,
    });
    manifestJobs.push({ id, type, lead, wave });
    if (status === 'running') {
      laneStats[lane.name].inFlight++;
    }
  }
  const running = jobs.filter(j => j.status === 'running').length;
  const lanesObj = {};
  for (const l of LANES) {
    lanesObj[l.name] = {
      agent: l.agent,
      state: l.state,
      until: l.state === 'ok' ? null : isoAt(now + 600_000),
      inFlight: laneStats[l.name].inFlight,
      queued: jobs.filter(j => j.lane === l.name && j.status === 'queued').length,
      concurrency: 4,
      consecutiveRateLimits: 0,
      peak: laneStats[l.name].inFlight,
    };
  }
  const state = {
    version: 1,
    id: runId,
    root,
    branch: 'swarm/fixture-run',
    concurrency: 6,
    peakConcurrency: Math.max(running, 1),
    status: 'running',
    startedAt: isoAt(startedAt),
    jobs,
    lanes: {
      globalConcurrency: 6,
      globalInFlight: running,
      peakGlobal: Math.max(running, 1),
      lanes: lanesObj,
    },
    pause: null,
    mergeQueue: {
      state: 'idle',
      batches: [{ id: 'b-1', jobs: ['job-0001'], ok: true, bisected: false, conflicts: [] }],
      integrated: ['job-0001'],
      conflicts: [],
    },
  };
  const manifest = { version: 1, jobs: manifestJobs };
  return { state, manifest };
}

function buildLedger(now, rnd) {
  const statuses = ['todo', 'ready', 'running', 'review', 'done', 'blocked', 'cancelled'];
  const stages = ['S1', 'S2', 'S3'];
  const epics = ['core', 'ui', 'ops'];
  const requirements = [];
  for (let i = 1; i <= 12; i++) requirements.push({ id: `R-${String(i).padStart(3, '0')}`, title: `Requirement ${i}` });
  const tickets = [];
  for (let i = 0; i < 60; i++) {
    const id = `T-${String(i + 1).padStart(3, '0')}`;
    const status = statuses[Math.floor(rnd() * statuses.length)];
    const deps = [];
    if (i > 0 && rnd() < 0.4) deps.push(`T-${String(Math.floor(rnd() * i) + 1).padStart(3, '0')}`);
    tickets.push({
      id,
      title: `Ticket ${i + 1}`,
      type: TYPES[i % 3],
      status,
      stage: stages[Math.floor(i / 20)],
      epic: epics[i % epics.length],
      risk: ['low', 'medium', 'high'][Math.floor(rnd() * 3)],
      sensitive: rnd() < 0.1,
      lane: LANES[i % LANES.length].name,
      scopeRefs: [requirements[i % requirements.length].id],
      acceptance: ['Behaves as specified'],
      files: [`src/part-${i + 1}.mjs`],
      dependsOn: [...new Set(deps)],
      costUsd: Math.round(rnd() * 200) / 100,
      pr: null,
      review: null,
      drift: [],
    });
  }
  return {
    version: 1,
    scope: { name: 'Swarm Watch', version: '1.0.0', hash: 'sha256-fixture' },
    tickets,
    changeOrders: [
      {
        id: 'CO-001',
        at: isoAt(now - 86_400_000),
        by: 'owner',
        reason: 'Add gallery approval flow',
        cancelled: false,
        reopened: false,
        diff: { added: 2 },
      },
    ],
    approved: null,
    requirements,
  };
}

function buildResults(now) {
  const at = isoAt(now);
  return {
    at,
    head: 'fixture0000000000000000000000000000000000',
    screens: {
      'home-screen': {
        pass: true, score: 0.97, reasons: [], at,
        tree: 'tree-home-1', serverStarted: true,
      },
      'run-detail': {
        pass: false, score: 0.61, reasons: ['layout drift'], at,
        tree: 'tree-run-2', serverStarted: true,
      },
    },
  };
}

export async function makeFixtureRoot({ jobs = 1200, now = Date.now() } = {}) {
  const rnd = mulberry32(0x5eed1234);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'swarm-watch-'));
  const runId = 'run-fixture-0001';
  const cleanup = () => fsp.rm(root, { recursive: true, force: true });

  const runDir = path.join(root, '.swarm', 'runs', runId);
  const projectDir = path.join(root, '.swarm', 'project');
  const uiDir = path.join(root, '.swarm', 'ui');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.mkdir(uiDir, { recursive: true });

  const { state, manifest } = buildRun(runId, jobs, now, rnd, root);
  await fsp.writeFile(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  await fsp.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(projectDir, 'tickets.json'), JSON.stringify(buildLedger(now, rnd), null, 2));

  const results = buildResults(now);
  await fsp.writeFile(path.join(uiDir, 'results.json'), JSON.stringify(results, null, 2));
  const png = Buffer.from(PNG_BASE64, 'base64');
  for (const id of Object.keys(results.screens)) {
    const dir = path.join(uiDir, id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'mockup.png'), png);
    await fsp.writeFile(path.join(dir, 'page.png'), png);
  }

  return { root, runId, cleanup };
}

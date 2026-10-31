// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createWatchServer } from '../tools/watch-server.mjs';
import { intervalCpuPercent, runSoak, summarizeSoak } from '../tools/watch-soak.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const json = async (file, body) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(body)); };
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixtureServer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-soak-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'alpha');
  await json(path.join(root, '.swarm/project/tickets.json'), { tickets: [{ id: 'T1', title: 'Build', status: 'running' }] });
  await json(path.join(root, '.swarm/inbox/state.json'), { needsYou: 0 });
  await json(path.join(root, '.swarm/runs/123/state.json'), { status: 'running', jobs: [{ status: 'running' }] });
  async function project(id) {
    const ledger = await read(path.join(root, '.swarm/project/tickets.json'));
    const need = await read(path.join(root, '.swarm/inbox/state.json'));
    const state = await read(path.join(root, '.swarm/runs/123/state.json'));
    const byStatus = {};
    for (const ticket of ledger.tickets) byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
    return {
      id: 'alpha', name: 'alpha', root, machine: os.hostname(),
      ledger,
      tickets: { byStatus },
      agents: { total: state.status === 'running' ? 1 : 0 },
      card: { now: { buildingTickets: byStatus.running ?? 0 }, blocked: { needYou: need.needsYou } },
    };
  }
  const server = createWatchServer({
    root: dir,
    commandCenter: true,
    assetDir: path.join(repo, 'tools/watch-assets'),
    deltaFile: path.join(repo, 'tools/watch-delta.mjs'),
    getRunSnapshot: async () => null,
    board: {
      async snapshot() {
        return { at: new Date().toISOString(), machine: { agents: { total: 1 } }, projects: [await project('alpha')] };
      },
      async project(id) { return project(id); },
    },
  });
  t.after(() => server.close());
  const { url } = await server.listen();
  return { server, url: `${new URL(url).origin}/command-center?t=${server.token}&tour=0`, token: server.token };
}

test('watch-soak CLI usage rejects missing URL', async () => {
  const child = spawn(process.execPath, ['tools/watch-soak.mjs'], { cwd: repo });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.notEqual(code, 0);
});

test('interval CPU measures CPU seconds once over elapsed wall time', () => {
  assert.equal(intervalCpuPercent(0, 1.5, 30_000), 5);
  assert.equal(intervalCpuPercent(0, 0.3, 30_000), 1);
  assert.equal(intervalCpuPercent(10, 13, 30_000), 10);
  assert.equal(intervalCpuPercent(13, 13, 30_000), 0);
  assert.equal(intervalCpuPercent(13, 10, 30_000), 0);
  for (const args of [
    [0, 1, 0], [0, 1, -1],
    [null, 1, 30_000], [0, null, 30_000], [0, 1, null],
    [undefined, 1, 30_000], [0, undefined, 30_000], [0, 1, undefined],
    [NaN, 1, 30_000], [0, Infinity, 30_000], [0, 1, Infinity],
  ]) {
    assert.equal(intervalCpuPercent(...args), null);
  }
  // One build is charged to its interval; warm-up contributes no CPU value.
  const cpuSeconds = [10, 13, 13, 13, 13];
  const summary = summarizeSoak(cpuSeconds.map((cpu, i) => ({
    serverCpuPercent: intervalCpuPercent(cpuSeconds[i - 1], cpu, 30_000),
  })));
  assert.deepEqual(summary.cpu, { first: 10, last: 0, average: 2.5, slopePerSample: -10 / 3 });
  assert.equal(summary.thresholds.cpuAverageMax, 5);
  assert.equal(summary.verdict, 'flat');
});

const MiB = 1024 * 1024;
const memorySamples = (rssMb, heapMb = rssMb.map(() => 10)) => rssMb.map((rss, i) => ({
  serverRssKb: rss * 1024,
  pageHeapBytes: heapMb[i] * MiB,
  serverCpuPercent: 0,
  eventSourceConnections: 1,
  watcherHandles: 1,
  apiRequestCount: 1,
}));

test('soak memory medians ignore warm-up and isolated final RSS and heap spikes', () => {
  const summary = summarizeSoak(memorySamples(
    [95, 260, 100, 101, 99, 100, 100, 260],
    [5, 30, 10, 11, 9, 10, 10, 30],
  ));
  assert.equal(summary.verdict, 'flat', summary.reasons.join('; '));
  assert.deepEqual(summary.reasons, []);
  assert.deepEqual(summary.memory.serverRssKb, {
    first: 95 * 1024,
    last: 260 * 1024,
    average: (95 + 260 + 100 + 101 + 99 + 100 + 100 + 260) / 8 * 1024,
    slopePerSample: (260 - 95) * 1024 / 7,
    steadyBaselineKb: 100 * 1024,
    steadyTailKb: 100 * 1024,
    steadyGrowthKb: 0,
  });
  assert.equal(summary.memory.pageHeapBytes.first, 5 * MiB);
  assert.equal(summary.memory.pageHeapBytes.last, 30 * MiB);
  assert.equal(summary.memory.pageHeapBytes.average, 115 / 8 * MiB);
  assert.equal(summary.memory.pageHeapBytes.slopePerSample, 25 * MiB / 7);
  assert.equal(summary.memory.pageHeapBytes.steadyBaselineBytes, 10 * MiB);
  assert.equal(summary.memory.pageHeapBytes.steadyTailBytes, 10 * MiB);
  assert.equal(summary.memory.pageHeapBytes.steadyGrowthBytes, 0);
});

test('soak flags sustained RSS growth above the steady-state limit', () => {
  // A 10 MiB step must continue past 160 MiB to exceed the 64 MiB median-growth limit.
  const summary = summarizeSoak(memorySamples([95, 260,
    ...Array.from({ length: 17 }, (_, i) => 100 + i * 10),
  ]));
  assert.equal(summary.verdict, 'leak');
  assert.equal(summary.memory.serverRssKb.steadyBaselineKb, 110 * 1024);
  assert.equal(summary.memory.serverRssKb.steadyTailKb, 250 * 1024);
  assert.equal(summary.memory.serverRssKb.steadyGrowthKb, 140 * 1024);
  assert.deepEqual(summary.reasons, [`memory growth rss=${140 * 1024}kb heap=0b`]);
});

test('soak flags sustained browser heap growth independently of RSS', () => {
  const summary = summarizeSoak(memorySamples(
    Array(9).fill(100), [30, 30, 10, 11, 12, 13, 14, 15, 16],
  ));
  assert.equal(summary.verdict, 'leak');
  assert.equal(summary.memory.pageHeapBytes.steadyBaselineBytes, 11 * MiB);
  assert.equal(summary.memory.pageHeapBytes.steadyTailBytes, 15 * MiB);
  assert.equal(summary.memory.pageHeapBytes.steadyGrowthBytes, 4 * MiB);
  assert.deepEqual(summary.reasons, [`memory growth rss=0kb heap=${4 * MiB}b`]);
});

test('short soaks fall back to available endpoints after warm-up', () => {
  for (const count of [0, 1, 2, 4]) {
    const summary = summarizeSoak(memorySamples([95, 260, 100, 101].slice(0, count)));
    const growth = count === 2 ? 165 * 1024 : count === 4 ? 1024 : 0;
    assert.equal(summary.verdict, count === 2 ? 'leak' : 'flat');
    assert.equal(summary.memory.serverRssKb.steadyGrowthKb, growth);
    assert.equal(summary.memory.pageHeapBytes.steadyGrowthBytes, 0);
  }
});

test('short Command Center soak reports flat verdict and bounded connections', { timeout: 120_000 }, async (t) => {
  const { url } = await fixtureServer(t);
  const result = await runSoak({
    url,
    durationMs: 20_000,
    profile: 'desktop',
    serverPid: process.pid,
    waitMs: 60_000,
  });
  assert.equal(result.verdict, 'flat', result.reasons.join('; '));
  assert.equal(result.sampleCount, 2);
  assert.equal(result.samples[0].serverCpuPercent, null, 'first CPU sample is a warm-up baseline');
  const [first, last] = result.samples;
  for (const sample of result.samples) {
    // Process telemetry can be unavailable when ps is restricted.
    assert.ok(sample.serverCpuSeconds === null || Number.isFinite(sample.serverCpuSeconds));
  }
  assert.equal(last.serverCpuPercent, intervalCpuPercent(first.serverCpuSeconds,
    last.serverCpuSeconds, Date.parse(last.at) - Date.parse(first.at)));
  assert.equal(result.cpu.average, last.serverCpuPercent, 'warm-up is excluded from the CPU summary');
  assert.ok(result.connections.last != null && result.connections.last <= 4, `connections=${result.connections.last}`);
  assert.ok(result.watchers.last == null || result.watchers.last <= 200, `watchers=${result.watchers.last}`);
  assert.ok(!result.url.includes('t=') || result.url.includes('t=…'), 'url must redact token');
  t.diagnostic(`soak samples=${result.sampleCount} connections=${JSON.stringify(result.connections.series)} watchers=${JSON.stringify(result.watchers.series)}`);
});

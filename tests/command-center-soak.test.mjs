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
import { runSoak } from '../tools/watch-soak.mjs';

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
  assert.ok(result.sampleCount >= 1);
  assert.ok(result.connections.last != null && result.connections.last <= 4, `connections=${result.connections.last}`);
  assert.ok(result.watchers.last == null || result.watchers.last <= 200, `watchers=${result.watchers.last}`);
  assert.ok(!result.url.includes('t=') || result.url.includes('t=…'), 'url must redact token');
  t.diagnostic(`soak samples=${result.sampleCount} connections=${JSON.stringify(result.connections.series)} watchers=${JSON.stringify(result.watchers.series)}`);
});

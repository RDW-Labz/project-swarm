// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatchServer } from '../tools/watch-server.mjs';
import { measureLiveLatency } from '../tools/watch-live-latency.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const json = async (file, body) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(body)); };
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixtureServer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-live-lat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'alpha');
  const inbox = () => path.join(root, '.swarm/inbox/state.json');
  await json(path.join(root, '.swarm/project/tickets.json'), { tickets: [{ id: 'T1', title: 'Build', status: 'running' }] });
  await json(inbox(), { needsYou: 0 });
  await json(path.join(root, '.swarm/runs/123/state.json'), { status: 'running', jobs: [{ status: 'running' }] });
  async function project(id) {
    const ledger = await read(path.join(root, '.swarm/project/tickets.json'));
    const need = await read(inbox());
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
  return { server, root, url: `${new URL(url).origin}/command-center?t=${server.token}&tour=0`, token: server.token };
}

function isPlaywrightChromiumMissing(err) {
  const msg = String(err?.message ?? err);
  return msg.includes("Executable doesn't exist")
    || msg.includes('Looks like Playwright was just installed')
    || msg.includes('browserType.launch');
}

async function withPlaywrightChromium(t, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isPlaywrightChromiumMissing(err)) {
      t.skip('playwright chromium not installed');
      return;
    }
    throw err;
  }
}

test('Command Center live latency updates hive counters within 3s without full snapshot refetch', { timeout: 120_000 }, async (t) => {
  const { url, root, token } = await fixtureServer(t);
  const result = await withPlaywrightChromium(t, () => measureLiveLatency({
    url,
    profile: 'desktop',
    projectRoot: root,
    projectId: 'alpha',
    builtin: 'inbox',
    runs: 2,
    waitMs: 60_000,
  }));
  if (result == null) return;
  assert.ok(result.medianMs < 3000, `median latency ${result.medianMs}ms`);
  assert.equal(result.fullSnapshotFetchesDuringUpdates, 0, 'SSE patch must not trigger full /api/command-center refetch');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(result.url.includes('t=…') || !result.url.includes(token));
  t.diagnostic(`live latency ms=${result.latenciesMs.join(', ')} median=${result.medianMs}`);
});

test('watch-live-latency supports phone profile for remote-style boards', { timeout: 120_000 }, async (t) => {
  const { url, root } = await fixtureServer(t);
  const result = await withPlaywrightChromium(t, () => measureLiveLatency({
    url,
    profile: 'phone',
    projectRoot: root,
    projectId: 'alpha',
    builtin: 'inbox',
    runs: 1,
    waitMs: 90_000,
  }));
  if (result == null) return;
  assert.equal(result.profile, 'phone');
  assert.ok(result.medianMs < 5000, `phone median ${result.medianMs}ms`);
});

// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runBurstCommand } from '../tools/burst-commands.mjs';

const tmp = async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-burst-gpu-route-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

function allPassMetrics() {
  return {
    readyOverFreeDays: 3,
    flatRateRateLimited: true,
    gpuFirstTryPassRate: 0.95,
  };
}

async function writeJson(dir, name, data) {
  const file = path.join(dir, name);
  await fs.writeFile(file, `${JSON.stringify(data)}\n`, 'utf8');
  return file;
}

function gateLines(stdout) {
  return stdout
    .trimEnd()
    .split('\n')
    .filter((line) => line.startsWith('gate '));
}

test('swarm burst gpu status prints three PASS lines and exits 0 when gates pass', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics.json', allPassMetrics());

  const res = await runBurstCommand(root, ['gpu', 'status', '--metrics', metricsPath]);
  assert.equal(res.exitCode, 0);
  const lines = gateLines(res.stdout);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.endsWith(' PASS')));
});

test('swarm burst gpu status prints FAIL line and still exits 0 when a gate fails', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics-fail.json', {
    ...allPassMetrics(),
    flatRateRateLimited: false,
  });

  const res = await runBurstCommand(root, ['gpu', 'status', '--metrics', metricsPath]);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /gate flat-rate-rate-limited:.* FAIL/);
});

test('swarm burst gpu start provisions once and exits 0 when gates pass with non-sensitive ticket', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics.json', allPassMetrics());
  const ticketPath = await writeJson(root, 'ticket.json', { id: 'T-0', sensitive: false });
  let provisionCalls = 0;
  const provision = async () => {
    provisionCalls += 1;
  };

  const res = await runBurstCommand(
    root,
    ['gpu', 'start', '--metrics', metricsPath, '--ticket', ticketPath],
    { provision },
  );
  assert.equal(res.exitCode, 0);
  assert.equal(provisionCalls, 1);
  assert.match(res.stdout, /burst gpu started/);
  assert.ok(gateLines(res.stdout).every((line) => line.endsWith(' PASS')));
});

test('swarm burst gpu start without --ticket provisions once when gates pass', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics.json', allPassMetrics());
  let provisionCalls = 0;

  const res = await runBurstCommand(root, ['gpu', 'start', '--metrics', metricsPath], {
    provision: async () => { provisionCalls += 1; },
  });
  assert.equal(res.exitCode, 0);
  assert.equal(provisionCalls, 1);
});

test('swarm burst gpu start exits 1 with gates not met and never provisions when a gate fails', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics.json', {
    ...allPassMetrics(),
    gpuFirstTryPassRate: 0.5,
  });
  let provisionCalls = 0;

  const res = await runBurstCommand(root, ['gpu', 'start', '--metrics', metricsPath], {
    provision: async () => { provisionCalls += 1; },
  });
  assert.equal(res.exitCode, 1);
  assert.equal(provisionCalls, 0);
  assert.match(res.stdout, /gates not met/);
});

test('swarm burst gpu start exits 1 with not allowed on rented lane when ticket is sensitive', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics.json', allPassMetrics());
  const ticketPath = await writeJson(root, 'ticket.json', { id: 'T-2', sensitive: true });
  let provisionCalls = 0;

  const res = await runBurstCommand(
    root,
    ['gpu', 'start', '--metrics', metricsPath, '--ticket', ticketPath],
    { provision: async () => { provisionCalls += 1; } },
  );
  assert.equal(res.exitCode, 1);
  assert.equal(provisionCalls, 0);
  assert.match(res.stdout, /not allowed on rented lane/);
});

test('swarm burst gpu start exits 1 with not allowed on rented lane when ticket omits sensitive:false', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics.json', allPassMetrics());
  const ticketPath = await writeJson(root, 'ticket.json', { id: 'T-3' });
  let provisionCalls = 0;

  const res = await runBurstCommand(
    root,
    ['gpu', 'start', '--metrics', metricsPath, '--ticket', ticketPath],
    { provision: async () => { provisionCalls += 1; } },
  );
  assert.equal(res.exitCode, 1);
  assert.equal(provisionCalls, 0);
  assert.match(res.stdout, /not allowed on rented lane/);
});

test('swarm burst gpu unknown subcommand returns usage exit 1', async (t) => {
  const root = await tmp(t);
  const metricsPath = await writeJson(root, 'metrics.json', allPassMetrics());

  const res = await runBurstCommand(root, ['gpu', 'nope', '--metrics', metricsPath]);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /Usage: swarm burst gpu/);
});

test('swarm burst gpu missing --metrics returns usage exit 1', async (t) => {
  const root = await tmp(t);
  const res = await runBurstCommand(root, ['gpu', 'status']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /Usage: swarm burst gpu/);
});

test('swarm burst gpu missing metrics file returns error exit 1', async (t) => {
  const root = await tmp(t);
  const missing = path.join(root, 'no-such-metrics.json');
  const res = await runBurstCommand(root, ['gpu', 'status', '--metrics', missing]);
  assert.equal(res.exitCode, 1);
  assert.ok(res.stdout.length > 0);
});

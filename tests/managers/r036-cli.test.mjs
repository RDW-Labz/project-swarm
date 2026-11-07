// SPDX-License-Identifier: Apache-2.0
// T-0208: R-036 — ticket-manager scope gate and unblocker post-wave via swarm managers run.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  MANAGERS_USAGE,
  runManagersAfterWave,
  runManagersCommand,
  runManagersScopeGate,
} from '../../tools/manager-commands.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @returns {Promise<string>}
 */
async function mkProjectRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-r036-cli-'));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.swarm', 'project', 'tickets.json'),
    `${JSON.stringify({ version: 1, tickets: [] })}\n`,
  );
  return root;
}

test('AC1: swarm managers run ticket-manager gates scope and swarm managers run unblocker runs after a wave', async () => {
  assert.match(MANAGERS_USAGE, /swarm managers run/);

  const root = await mkProjectRoot();
  try {
    const ticket = await runManagersCommand(root, ['run', 'ticket']);
    assert.equal(ticket.exitCode, 0, ticket.stdout);
    assert.match(ticket.stdout, /manager: ticket-manager/);
    assert.match(ticket.stdout, /status: ok/);

    const ticketJson = JSON.parse(
      (await runManagersCommand(root, ['run', 'ticket-manager', '--json'])).stdout,
    );
    assert.equal(ticketJson.managerId, 'ticket-manager');
    assert.equal(ticketJson.root, root);
    assert.equal(ticketJson.trigger, 'scope');
    assert.equal(ticketJson.run.managerId, 'ticket-manager');
    assert.equal(ticketJson.run.trigger, 'scope');

    const unblocker = await runManagersCommand(root, ['run', 'unblocker']);
    assert.equal(unblocker.exitCode, 0, unblocker.stdout);
    assert.match(unblocker.stdout, /manager: unblocker/);
    assert.match(unblocker.stdout, /status: ok/);

    const unblockerJson = JSON.parse(
      (await runManagersCommand(root, ['run', 'unblocker', '--json'])).stdout,
    );
    assert.equal(unblockerJson.managerId, 'unblocker');
    assert.equal(unblockerJson.trigger, 'wave');
    assert.equal(unblockerJson.run.managerId, 'unblocker');
    assert.equal(unblockerJson.run.trigger, 'wave');

    const scopeGate = await runManagersScopeGate(root);
    assert.equal(scopeGate.run.managerId, 'ticket-manager');
    assert.equal(scopeGate.run.trigger, 'scope');
    assert.equal(scopeGate.run.status, 'ok');

    const afterWave = await runManagersAfterWave(root);
    assert.equal(afterWave.run.managerId, 'unblocker');
    assert.equal(afterWave.run.trigger, 'wave');
    assert.equal(afterWave.run.status, 'ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const unsupported = await runManagersCommand(repoRoot, ['run', 'merge-queue']);
  assert.equal(unsupported.exitCode, 1);
  assert.match(unsupported.stdout, /manager-run-unsupported/);
});

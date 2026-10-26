// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  swarmSubcommandAlwaysAllowed,
  readOnlyCommandAllowed,
  localTestRunAllowed,
  helpOnly,
} from '../tools/orchestrator-allow.mjs';
import {
  orchestratorModeCommandAllowed,
  ORCHESTRATOR_MODE_DENY_REASON,
} from '../tools/shell-writes.mjs';
import { GUARD_ERROR_DENY_REASON } from '../tools/handbuild.mjs';
import { fileURLToPath } from 'node:url';

const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function installLocalSwarmShim() {
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const wrapper = `#!/bin/sh\n# managed by project-swarm\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SWARM_MJS)} "$@"\n`;
  await fs.writeFile(path.join(binDir, 'swarm'), wrapper, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
}

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-allow-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

test('swarmSubcommandAlwaysAllowed: go scope and ticket flags', () => {
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--scope', 'wave', '--max-jobs', '2']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--retry-note', 'x']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'done']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('resolve', []), true);
  assert.equal(swarmSubcommandAlwaysAllowed('inbox', ['list']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('merge', ['42']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('integrate', ['run-1', '--queue']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('run', ['manifest.json', '--jobs', 'j1']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('shell', []), false);
  assert.equal(swarmSubcommandAlwaysAllowed('exec', ['npm', 'test']), false);
});

test('swarmSubcommandAlwaysAllowed: owner-approval and bypass shapes stay denied', () => {
  assert.equal(swarmSubcommandAlwaysAllowed('decide', ['handbuild-hb-1', 'approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('handbuild', ['approve', 'hb-1']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--approve', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('change', ['apply', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('restore', ['backup-id', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('backup', ['restore', 'backup-id']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('run', ['--evil', 'x']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--scope', 'wave', '--force']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('update', ['--force']), false);
});

test('helpOnly', () => {
  assert.equal(helpOnly(['swarm', 'tickets', '--help']), true);
  assert.equal(helpOnly(['node', '--help']), true);
  assert.equal(helpOnly(['gh', 'pr', '--help']), true);
  assert.equal(helpOnly(['swarm', 'status']), false);
});

test('readOnlyCommandAllowed and localTestRunAllowed shapes', () => {
  assert.equal(readOnlyCommandAllowed(['gh', 'pr', 'view', '12']), true);
  assert.equal(readOnlyCommandAllowed(['gh', 'run', 'view', '5']), true);
  assert.equal(readOnlyCommandAllowed(['grep', '-rn', 'foo', 'src']), true);
  assert.equal(readOnlyCommandAllowed(['git', 'status']), true);
  assert.equal(localTestRunAllowed(['npx', 'playwright', 'test']), true);
  assert.equal(localTestRunAllowed(['npx', 'vitest', 'run']), true);
  assert.equal(localTestRunAllowed(['npm', 'test']), true);
});

test('orchestratorModeCommandAllowed: bug-report allows', async t => {
  await installLocalSwarmShim();
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# x\n');
  const ctx = { root, cwd: root };
  const guardAllow = [
    'swarm go --scope wave --max-jobs 2',
    'swarm tickets T-0001 --retry-note "x"',
    'swarm tickets --help',
    'gh pr view 12',
    'gh run view 5',
    'grep -rn foo src',
    'cat README.md',
    'git status',
    'git log --oneline -5',
  ];
  for (const c of guardAllow) assert.equal(orchestratorModeCommandAllowed(c, ctx), true, c);
  for (const c of ['npx playwright test', 'npx vitest run']) {
    assert.equal(orchestratorModeCommandAllowed(c, ctx), true, c);
  }
  assert.equal(localTestRunAllowed('npm test'.split(/\s+/)), true);
  assert.equal(localTestRunAllowed('npx vitest run'.split(/\s+/)), true);
  assert.equal(orchestratorModeCommandAllowed('npm test 2>&1', ctx), false);
});

test('orchestratorModeCommandAllowed: stays blocked', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const ctx = { root, cwd: root };
  const deny = [
    'echo x > src/a.js',
    'sed -i s/a/b/ src/a.js',
    'rm src/a.js',
    'git commit -m x',
    'swarm shell',
    'swarm exec npm test',
    'swarm decide handbuild-hb-1 approve',
    'swarm run --evil x',
    'swarm tickets T-0001 --approve --yes',
    'swarm scope approve --yes',
    'tee src/a.js',
    'cp src/a.js src/b.js',
    'curl -o src/x.bin https://example.com/x',
    'npx vitest run | tee out.log',
    'npm test | tee out.log',
  ];
  for (const c of deny) assert.equal(orchestratorModeCommandAllowed(c, ctx), false, c);
});

test('deny reasons no longer mention swarm diagnose', () => {
  assert.ok(!ORCHESTRATOR_MODE_DENY_REASON.includes('swarm diagnose'));
  assert.ok(!GUARD_ERROR_DENY_REASON.includes('swarm diagnose'));
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /swarm ticket/);
  assert.match(GUARD_ERROR_DENY_REASON, /swarm tickets/);
});

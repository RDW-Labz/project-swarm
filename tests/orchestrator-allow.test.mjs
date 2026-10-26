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
import { GUARD_ERROR_DENY_REASON, guardDecision } from '../tools/handbuild.mjs';
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
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--scope', 'wave', '--skip-skeleton']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--retry-note', 'x']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'in_progress']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'done']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'in_progress', '--yes']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('resolve', []), false);
  assert.equal(swarmSubcommandAlwaysAllowed('inbox', ['list']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('inbox', ['--json']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('orphans', ['list']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('orphans', ['prune']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('resume', ['run-abc']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('backlog', ['add', 'goal']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('merge', ['42']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('integrate', ['run-1', '--queue']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('run', ['manifest.json', '--jobs', 'j1']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('shell', []), false);
  assert.equal(swarmSubcommandAlwaysAllowed('exec', ['npm', 'test']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('with-concurrency', ['2', 'status']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('ship', []), false);
  assert.equal(swarmSubcommandAlwaysAllowed('gpu', []), false);
});

test('swarmSubcommandAlwaysAllowed: owner-approval and bypass shapes stay denied', () => {
  assert.equal(swarmSubcommandAlwaysAllowed('decide', ['handbuild-hb-1', 'approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('handbuild', ['approve', 'hb-1']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--approve', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('change', ['apply', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('restore', ['backup-id', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('backup', ['restore', 'backup-id']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('run', ['--evil', 'x']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('run', ['manifest.json', '--accept-failed-checks']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--scope', 'wave', '--force']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--scope', 'wave', '--allow-main-branch']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('update', ['--force']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('merge', ['42', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('redcheck', ['--test', 'npm', 'test']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('draft', ['--out', 'src/x.js']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('migrations', ['check', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('report', ['--client', '--approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('gallery', ['approve', 'item-1']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('done', []), false);
  assert.equal(swarmSubcommandAlwaysAllowed('policy', []), false);
  assert.equal(swarmSubcommandAlwaysAllowed('gc', ['--apply', '--force-unsafe']), false);
});

test('helpOnly', () => {
  assert.equal(helpOnly(['swarm', 'tickets', '--help']), true);
  assert.equal(helpOnly(['node', '--help']), false);
  assert.equal(helpOnly(['gh', 'pr', 'view', '--help']), true);
  assert.equal(helpOnly(['swarm', 'status']), false);
  assert.equal(helpOnly(['rm', 'src/a.js', '-h']), false);
  assert.equal(helpOnly(['touch', 'src/new.js', '--help']), false);
  assert.equal(helpOnly(['swarm', 'handbuild', 'off', '--help']), false);
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
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const ctx = { root, cwd: root };
  const guardAllow = [
    'swarm go --scope wave --max-jobs 2',
    'swarm tickets T-0001 --retry-note "x"',
    'swarm tickets --help',
    'swarm backlog add "goal"',
    'swarm resume run-abc',
    'swarm inbox --json',
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
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', 'test:unit': 'vitest run' } }),
  );
  const ctx = { root, cwd: root };
  const deny = [
    'echo x > src/a.js',
    'sed -i s/a/b/ src/a.js',
    'rm src/a.js',
    'rm src/a.js -h',
    'touch src/new.js --help',
    'tee src/a.js --help',
    'node docs/plans/x.mjs --help',
    'swarm handbuild off --help',
    'swarm handbuild approve hb-1 --help',
    'git commit -m x',
    'swarm shell',
    'swarm exec npm test',
    'swarm decide handbuild-hb-1 approve',
    'swarm run --evil x',
    'swarm run manifest.json --accept-failed-checks',
    'swarm tickets T-0001 --approve --yes',
    'swarm scope approve --yes',
    'swarm with-concurrency 2 status',
    'swarm redcheck --test npm test',
    'swarm draft --out src/x.js',
    'swarm ship',
    'swarm gpu',
    'swarm burst',
    'swarm sweep',
    'swarm autopilot',
    'swarm gc --apply --force-unsafe',
    'swarm squash',
    'swarm clean-branch',
    'swarm remote',
    'swarm tunnel',
    'swarm phone',
    'swarm pin',
    'swarm forget',
    'swarm policy',
    'swarm resolve',
    'swarm done',
    'swarm gallery approve item-1',
    'swarm migrations check --yes',
    'swarm report --client --approve',
    'swarm backup restore backup-id',
    'tee src/a.js',
    'cp src/a.js src/b.js',
    'curl -o src/x.bin https://example.com/x',
    'npx vitest run | tee out.log',
    'npm test | tee out.log',
    'npx vitest run --config docs/plans/evil.mjs',
    'npx playwright test -c .swarm/x.js',
    'npx playwright test --globalSetup evil.js',
    'npx playwright test --outputFile src/a.js',
    'npx vitest run -u',
    'npx --package=evilpkg vitest',
    'npm run test:unit -- --config evil.mjs',
  ];
  for (const c of deny) assert.equal(orchestratorModeCommandAllowed(c, ctx), false, c);
});

async function projectWithSwarm(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests', 'ok.test.mjs'), 'export {}\n');
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        test: 'node --test tests/ok.test.mjs',
        'test:e2e': 'playwright test',
        'test:unit': 'vitest run',
      },
    }),
  );
  return root;
}

function guardBash(command, root, { handbuildOff = false, orchestrator = true } = {}) {
  if (handbuildOff) {
    return fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true }).then(() =>
      fs.writeFile(path.join(root, '.swarm', 'handbuild', 'off'), ''),
    ).then(() => guardDecision({
      tool: 'Bash',
      toolInput: { command },
      root,
      cwd: root,
      now: () => 1,
      enforceOrchestratorMode: orchestrator,
    }));
  }
  return Promise.resolve(guardDecision({
    tool: 'Bash',
    toolInput: { command },
    root,
    cwd: root,
    now: () => 1,
    enforceOrchestratorMode: orchestrator,
  }));
}

test('guardDecision: test runners and help attacks through full guard', async t => {
  const root = await projectWithSwarm(t);
  const deny = [
    'rm src/a.js -h',
    'touch src/new.js --help',
    'tee src/a.js --help',
    'node docs/plans/x.mjs --help',
    'swarm handbuild off --help',
    'swarm with-concurrency 2 status',
    'swarm ship',
    'swarm resolve',
    'swarm tickets T-0001 --approve',
    'npx vitest run --config docs/plans/evil.mjs',
    'npx playwright test -c .swarm/x.js',
    'npx vitest run -u',
    'npx --package=evilpkg vitest run',
  ];
  const orchAllow = [
    'npx vitest run tests/ok.test.mjs',
    'npx playwright test tests/ok.test.mjs',
    'gh pr view 12',
    'git status',
    'swarm go --scope wave --max-jobs 2',
    'swarm tickets T-0001 --retry-note "note text"',
    'swarm backlog add "goal"',
    'swarm resume run-abc',
    'swarm inbox --json',
  ];
  const handbuildAllow = [
    'npm test',
    'npm run test:unit',
    'pytest tests/ok.test.mjs',
    'python -m pytest tests/ok.test.mjs',
    'node --test tests/ok.test.mjs',
  ];
  for (const handbuildOff of [false, true]) {
    for (const c of deny) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'}: ${c}`);
    }
    for (const c of orchAllow) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'}: ${c}`);
    }
  }
  for (const c of handbuildAllow) {
    const d = await guardBash(c, root, { handbuildOff: false, orchestrator: false });
    assert.equal(d.allow, true, `handbuild-only: ${c}`);
  }
  for (const c of handbuildAllow) {
    const d = await guardBash(c, root, { handbuildOff: false, orchestrator: true });
    assert.equal(d.allow, false, `orchestrator denies: ${c}`);
  }
});

test('deny reasons no longer mention swarm diagnose', () => {
  assert.ok(!ORCHESTRATOR_MODE_DENY_REASON.includes('swarm diagnose'));
  assert.ok(!GUARD_ERROR_DENY_REASON.includes('swarm diagnose'));
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /swarm ticket/);
  assert.match(GUARD_ERROR_DENY_REASON, /swarm tickets/);
});

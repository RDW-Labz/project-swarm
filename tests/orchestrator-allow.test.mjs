// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ORCHESTRATOR_WRITE_RULES,
  swarmSubcommandAlwaysAllowed,
  readOnlyCommandAllowed,
  localTestRunAllowed,
  localTestRunIsBare,
  helpOnly,
  orchestratorOwnForbiddenTestOrRunnerBasename,
  orchestratorOwnForbiddenWriteBasename,
  orchestratorOwnForbiddenWriteRel,
  orchestratorWriteAllowedRel,
  orchestratorWriteAllowListAppliesRel,
  orchestratorWriteMarkerDeniedRel,
  orchestratorSwarmSessionCwdOk,
} from '../tools/orchestrator-allow.mjs';
import { orchestratorOwnFoldersBlockBareTestRun } from '../tools/shell-writes.mjs';
import {
  orchestratorModeCommandAllowed,
  ORCHESTRATOR_MODE_DENY_REASON,
  ORCHESTRATOR_SWARM_CWD_DENY_REASON,
  orchestratorSwarmCwdDenyReason,
  orchestratorSwarmSubfolderBlocked,
} from '../tools/shell-writes.mjs';
import { GUARD_ERROR_DENY_REASON, guardDecision } from '../tools/handbuild.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));

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

test('ORCHESTRATOR_WRITE_RULES shape', () => {
  assert.ok(Array.isArray(ORCHESTRATOR_WRITE_RULES));
  assert.ok(ORCHESTRATOR_WRITE_RULES.length >= 5);
  for (const rule of ORCHESTRATOR_WRITE_RULES) {
    assert.equal(typeof rule.folderPrefix, 'string');
    assert.ok(Array.isArray(rule.extensions) && rule.extensions.length > 0);
    assert.ok(Array.isArray(rule.denySubfolders));
    assert.equal(typeof rule.comment, 'string');
    assert.ok(rule.comment.length > 8);
  }
  assert.equal(orchestratorWriteAllowedRel('docs/plans/plan.md'), true);
  assert.equal(orchestratorWriteAllowedRel('src/plan.md'), false);
  assert.equal(orchestratorWriteAllowedRel('package.json'), false);
  assert.equal(orchestratorWriteAllowedRel('coordination/manifests/job.json'), true);
  assert.equal(orchestratorWriteAllowedRel('coordination/HANDOFF.md'), true);
  assert.equal(orchestratorWriteAllowedRel('coordination/TASK.md'), false);
  assert.equal(orchestratorWriteAllowedRel('task.md'), true);
  assert.equal(orchestratorWriteAllowedRel('docs/state/usage-ledger.md'), true);
});

test('swarmSubcommandAlwaysAllowed: go scope and ticket flags', () => {
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--scope', 'wave', '--max-jobs', '2']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--scope', 'wave', '--skip-skeleton']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--retry-note', 'x']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'in_progress']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'done']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--delivered', 'PR-1']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--accept']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--evil']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('budget', ['set', '10']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('budgets', ['set', 'daily', '5']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('budget', ['--daily', '1000', 'set']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('budget', ['show']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('budget', ['--json']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'ready', '--note', 'ok', '--yes']), true);
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
  assert.equal(swarmSubcommandAlwaysAllowed('change', ['reason', 'docs/scope/scope.md', '--yes']), true);
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
  assert.equal(localTestRunAllowed(['npm', 'test'], { packageScripts: { test: 'node --test' } }), true);
  assert.equal(localTestRunAllowed(['npx', 'vitest', '--config=.swarm/evil.mjs']), false);
  assert.equal(localTestRunAllowed(['npx', 'vitest', '-u']), false);
  assert.equal(localTestRunAllowed(['npx', 'vitest', '--config=x', 'run']), false);
  assert.equal(localTestRunAllowed(['pnpm', 'dlx', 'vitest', 'run']), false);
  assert.equal(localTestRunAllowed(['yarn', 'dlx', 'vitest', 'run']), false);
  assert.equal(localTestRunAllowed(['node', '--test', '--import', './x.mjs']), false);
  assert.equal(localTestRunAllowed(['npm', 'test', '--', '--config', 'x']), false);
  assert.equal(localTestRunAllowed(['pytest', '-c', 'x.ini']), false);
  assert.equal(localTestRunAllowed(['pytest', '-p', 'plugin']), false);
  assert.equal(localTestRunAllowed(['python3', '-m', 'pytest', '--rootdir', '/tmp']), false);
  assert.equal(localTestRunAllowed(['python', '-c', 'import os', '-m', 'pytest']), false);
  assert.equal(localTestRunAllowed(['python3', '-I', '-m', 'pytest']), true);
});

test('orchestratorOwnForbiddenTestOrRunnerBasename', () => {
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('wave.test.mjs'), true);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('plan.spec.ts'), true);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('test_plan.py'), true);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('plan_test.py'), true);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('conftest.py'), true);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('vitest.config.ts'), true);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('package.json'), true);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('scale-plan-v2.md'), false);
  assert.equal(orchestratorOwnForbiddenTestOrRunnerBasename('ideas.md'), false);
  assert.equal(orchestratorOwnForbiddenWriteBasename('x-test.mjs'), true);
  assert.equal(orchestratorOwnForbiddenWriteBasename('x_test.mjs'), true);
  assert.equal(orchestratorOwnForbiddenWriteBasename('test-x.mjs'), true);
  assert.equal(orchestratorOwnForbiddenWriteBasename('test.mjs'), true);
  assert.equal(orchestratorOwnForbiddenWriteBasename('test.js'), true);
  assert.equal(orchestratorOwnForbiddenWriteBasename('x.py'), true);
  assert.equal(orchestratorOwnForbiddenWriteBasename('x.sh'), true);
  assert.equal(orchestratorOwnForbiddenWriteBasename('NOTE.MJS'), true);
  assert.equal(orchestratorOwnForbiddenWriteRel('docs/plans/tests/note.txt'), true);
  assert.equal(orchestratorOwnForbiddenWriteRel('docs/plans/plan.json'), false);
});

test('localTestRunIsBare', () => {
  const scripts = { test: 'node --test' };
  assert.equal(localTestRunIsBare('node --test'.split(/\s+/)), true);
  assert.equal(localTestRunIsBare('npx vitest run'.split(/\s+/)), true);
  assert.equal(localTestRunIsBare('pytest'.split(/\s+/)), true);
  assert.equal(
    localTestRunIsBare('npm test'.split(/\s+/), { packageScripts: scripts }),
    true,
  );
  assert.equal(localTestRunIsBare('node --test tests/ok.test.mjs'.split(/\s+/)), false);
  assert.equal(localTestRunIsBare('npx vitest run tests/ok.test.mjs'.split(/\s+/)), false);
});

test('orchestratorModeCommandAllowed: bug-report allows', async t => {
  await installLocalSwarmShim();
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# x\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const ctx = { root, cwd: root };
  const guardAllow = [
    'swarm go --scope --max-jobs 2',
    'swarm go --scope wave --max-jobs 2',
    'swarm tickets T-0001 --set ready --note ok --yes',
    'swarm tickets T-0001 --retry-note ok',
    'swarm tickets --help',
    'swarm backlog add goal',
    'swarm integrate RUN --queue',
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
  for (const c of [
    'npx playwright test',
    'npx vitest run',
    'npm test',
    'npm run test',
    'node --test',
    'node --test tests',
    'pytest',
    'python3 -m pytest',
  ]) {
    assert.equal(orchestratorModeCommandAllowed(c, ctx), true, c);
  }
  assert.equal(localTestRunAllowed('npm test'.split(/\s+/), { packageScripts: { test: 'node --test' } }), true);
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
    'npx vitest --config=.swarm/evil.mjs',
    'npx vitest -u',
    'npx --package=evilpkg vitest',
    'pnpm dlx vitest run',
    'npm run test:unit -- --config evil.mjs',
    'npm test -- --config x',
    'node --test --import ./x.mjs',
    'pytest -c x.ini',
    'pytest -p plugin',
    'python -m pytest --rootdir /tmp',
    'python -c import -m pytest',
    'swarm budget set 10',
    'swarm budgets set daily 5',
    'swarm budget --daily 1000 set',
    'swarm tickets T-0001 --delivered PR-1',
    'swarm tickets T-0001 --take-from T-0002',
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

function guardWrite(filePath, root, { handbuildOff = false, orchestrator = true } = {}) {
  const setup = handbuildOff
    ? fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true }).then(() =>
      fs.writeFile(path.join(root, '.swarm', 'handbuild', 'off'), ''),
    )
    : Promise.resolve();
  return setup.then(() => guardDecision({
    tool: 'Write',
    toolInput: { file_path: filePath },
    root,
    cwd: root,
    now: () => 1,
    enforceOrchestratorMode: orchestrator,
  }));
}

function guardBash(command, root, { handbuildOff = false, orchestrator = true, cwd = undefined } = {}) {
  const sessionCwd = cwd ?? root;
  if (handbuildOff) {
    return fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true }).then(() =>
      fs.writeFile(path.join(root, '.swarm', 'handbuild', 'off'), ''),
    ).then(() => guardDecision({
      tool: 'Bash',
      toolInput: { command },
      root,
      cwd: sessionCwd,
      now: () => 1,
      enforceOrchestratorMode: orchestrator,
    }));
  }
  return Promise.resolve(guardDecision({
    tool: 'Bash',
    toolInput: { command },
    root,
    cwd: sessionCwd,
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
  const localTestAllow = [
    'npm test',
    'npm run test:unit',
    'pytest tests/ok.test.mjs',
    'python -m pytest tests/ok.test.mjs',
    'python3 -m pytest tests/ok.test.mjs',
    'node --test tests/ok.test.mjs',
    'node --test',
  ];
  const localTestDeny = [
    'node --test --import ./x.mjs',
    'npm test -- --config x',
    'pytest -c x.ini',
    'pytest -p plugin',
    'python -m pytest --rootdir /tmp',
    'python -c import -m pytest',
    'npx vitest run .swarm/x.test.mjs',
    'npx vitest run docs/plans/x.test.mjs',
    'npx playwright test .swarm/x.spec.js',
    'node --test .swarm/x.test.mjs',
    'npx vitest --config=.swarm/evil.mjs',
    'npx vitest -u',
    'pnpm dlx vitest run',
  ];
  for (const handbuildOff of [false, true]) {
    for (const c of deny) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'}: ${c}`);
    }
    for (const c of localTestDeny) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'} deny: ${c}`);
    }
    for (const c of orchAllow) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'}: ${c}`);
    }
    for (const c of localTestAllow) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'} local: ${c}`);
    }
  }
  for (const c of localTestAllow) {
    const d = await guardBash(c, root, { handbuildOff: false, orchestrator: false });
    assert.equal(d.allow, true, `handbuild-only: ${c}`);
  }
});

test('guardDecision: orchestrator-owned writes block test artifacts', async t => {
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  const allowWrites = [
    'docs/plans/scale-plan-v2.md',
    'docs/plans/ideas.md',
    'docs/plans/plan.json',
    '.swarm/notes/orchestrator-note.md',
    'coordination/manifests/wave.json',
    'coordination/HANDOFF.md',
    'docs/state/usage-ledger.md',
    'TASK.md',
  ];
  const denyWrites = [
    'src/app.md',
    'node_modules/pkg/readme.md',
    'build/out.md',
    'dist/out.md',
    '.swarm/workspaces/ws/note.md',
    'src/config.yaml',
    'package.json',
    'docs/plans/evil.test.mjs',
    'docs/plans/x.spec.ts',
    'docs/plans/test_wave.py',
    'docs/plans/wave_test.py',
    'docs/plans/conftest.py',
    'docs/plans/vitest.config.mjs',
    'docs/plans/package.json',
    '.swarm/hidden.test.mjs',
    'docs/plans/x-test.mjs',
    'docs/plans/x_test.mjs',
    'docs/plans/test-x.mjs',
    'docs/plans/test.mjs',
    'docs/plans/test.js',
    'docs/plans/x.py',
    'docs/plans/x.sh',
    'docs/plans/tests/notes.txt',
    '.swarm/NOTE.MJS',
  ];
  for (const handbuildOff of [false, true]) {
    for (const rel of allowWrites) {
      const d = await guardWrite(rel, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'} allow write ${rel}`);
    }
    for (const rel of denyWrites) {
      const d = await guardWrite(rel, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'} deny write ${rel}`);
    }
  }
  await fs.writeFile(path.join(root, 'docs', 'plans', 'evil.test.mjs'), 'export {}\n');
  const linkPath = path.join(root, 'docs', 'plans', 'innocent.md');
  await fs.symlink(path.join(root, 'docs', 'plans', 'evil.test.mjs'), linkPath);
  for (const handbuildOff of [false, true]) {
    const d = await guardWrite('docs/plans/innocent.md', root, { handbuildOff, orchestrator: true });
    assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'} deny symlink write`);
  }
});

test('guardDecision: bare test runs blocked when orchestrator folders hold code', async t => {
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  const ctx = { root, cwd: root };
  const bareCommands = [
    'npx vitest run',
    'npx playwright test',
    'npm test',
    'node --test',
    'pytest',
    'python3 -m pytest',
  ];
  for (const c of bareCommands) {
    assert.equal(orchestratorModeCommandAllowed(c, ctx), true, `clean: ${c}`);
  }
  await fs.writeFile(path.join(root, 'docs', 'plans', 'stray.mjs'), 'export {}\n');
  assert.equal(orchestratorOwnFoldersBlockBareTestRun(root), true);
  for (const c of bareCommands) {
    assert.equal(orchestratorModeCommandAllowed(c, ctx), false, `blocked: ${c}`);
  }
  await fs.rm(path.join(root, 'docs', 'plans', 'stray.mjs'));
  await fs.writeFile(path.join(root, 'docs', 'plans', 'notes.md'), '# ok\n');
  await fs.writeFile(path.join(root, 'docs', 'plans', 'meta.json'), '{}\n');
  assert.equal(orchestratorOwnFoldersBlockBareTestRun(root), false);
  for (const c of bareCommands) {
    assert.equal(orchestratorModeCommandAllowed(c, ctx), true, `notes only: ${c}`);
  }
  assert.equal(
    orchestratorModeCommandAllowed('npx vitest run tests/ok.test.mjs', ctx),
    true,
  );
});

test('orchestrator write allow-list: workspace cwd has no exemption', async t => {
  const root = await tmp(t);
  const runId = 'run-no-exempt';
  const jobId = 'job-1';
  await fs.mkdir(path.join(root, '.swarm', 'runs', runId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', runId, 'state.json'), '{}\n');
  const workspace = path.join(root, '.swarm', 'workspaces', runId, jobId);
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  const rel = '.swarm/workspaces/run-no-exempt/job-1/src/a.ts';
  const abs = path.join(root, rel);

  assert.equal(orchestratorWriteAllowListAppliesRel(rel, root, workspace), true);

  const prevRun = process.env.SWARM_WORKER_RUN_ID;
  process.env.SWARM_WORKER_RUN_ID = runId;
  t.after(() => {
    if (prevRun === undefined) delete process.env.SWARM_WORKER_RUN_ID;
    else process.env.SWARM_WORKER_RUN_ID = prevRun;
  });

  const wsWrite = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: abs },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(wsWrite.allow, false, 'workspace cwd is subject to allow-list');
  assert.equal(wsWrite.reason, ORCHESTRATOR_MODE_DENY_REASON);

  const rootWrite = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(root, 'TASK.md') },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(rootWrite.allow, true, 'allow-listed root path from workspace cwd still follows orchestrator rules');
});

test('guard hook: orchestrator session at project root allows and denies swarm CLI', { timeout: 60_000 }, async t => {
  await installLocalSwarmShim();
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'scope', 'scope.md'), '# scope\n');
  await fs.writeFile(path.join(root, 'README.md'), '# x\n');
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  });

  const hookBash = (command, { handbuildOff = false } = {}) => {
    if (handbuildOff) {
      return fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true }).then(() =>
        fs.writeFile(path.join(root, '.swarm', 'handbuild', 'off'), ''),
      ).then(() => spawnSync(process.execPath, [GUARD], {
        input: JSON.stringify({
          session_id: 'orch',
          cwd: root,
          tool_name: 'Bash',
          tool_input: { command },
        }),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      }));
    }
    return Promise.resolve(spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({
        session_id: 'orch',
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command },
      }),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    }));
  };

  const decision = r => {
    const line = r.stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) return 'allow';
    return JSON.parse(line).hookSpecificOutput.permissionDecision;
  };

  const allowCmds = [
    'swarm tickets T-0001 --set ready --note "a note" --yes',
    'swarm change "reason" docs/scope/scope.md --yes',
    'swarm go --scope --max-jobs 2',
    'swarm go --scope --max-jobs 2 --skip-skeleton',
    'swarm tickets T-0001 --retry-note ok',
    'swarm backlog add "goal"',
    'swarm integrate RUN --queue --no-commit',
    'swarm resume RUN',
    'swarm inbox --json',
    'gh pr view 12',
    'gh run view 5',
    'grep -rn foo src',
    'cat README.md',
    'git status',
    'git log --oneline -5',
    'npx playwright test',
    'npx vitest run',
    'npm test',
    'node --test',
    'pytest',
  ];
  const denyCmds = [
    'swarm resolve',
    'swarm scope approve --yes',
  ];

  for (const handbuildOff of [false, true]) {
    for (const c of allowCmds) {
      const r = await hookBash(c, { handbuildOff });
      assert.equal(r.status, 0, c);
      assert.equal(decision(r), 'allow', `${handbuildOff ? 'off' : 'on'}: ${c}`);
    }
    for (const c of denyCmds) {
      const r = await hookBash(c, { handbuildOff });
      assert.equal(r.status, 0, c);
      assert.equal(decision(r), 'deny', `${handbuildOff ? 'off' : 'on'}: ${c}`);
    }
    process.env.SWARM_WORKER_RUN_ID = 'fake-run';
    const r = await hookBash('swarm go --scope --max-jobs 2', { handbuildOff });
    assert.equal(decision(r), 'allow', 'SWARM_WORKER_RUN_ID does not exempt');
    delete process.env.SWARM_WORKER_RUN_ID;
  }
});

test('deny reasons explain tickets and allow-list writes', () => {
  assert.ok(!ORCHESTRATOR_MODE_DENY_REASON.includes('swarm diagnose'));
  assert.ok(!GUARD_ERROR_DENY_REASON.includes('swarm diagnose'));
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /swarm ticket/);
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /docs\/plans/);
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /Swarm CLI/);
  assert.match(GUARD_ERROR_DENY_REASON, /swarm tickets/);
  assert.match(ORCHESTRATOR_SWARM_CWD_DENY_REASON, /run cd followed by the project root path first/);
  assert.equal(
    orchestratorSwarmCwdDenyReason(os.tmpdir()),
    `Orchestrator mode: swarm commands are only allowed from the project root: run cd ${fsSync.realpathSync.native(os.tmpdir())} first.`,
  );
});

test('orchestratorWriteMarkerDeniedRel blocks fake project roots', () => {
  assert.equal(orchestratorWriteMarkerDeniedRel('docs/plans/.project-swarm.json'), true);
  assert.equal(orchestratorWriteMarkerDeniedRel('docs/plans/.swarm'), true);
  assert.equal(orchestratorWriteMarkerDeniedRel('docs/plans/.swarm/x.md'), true);
  assert.equal(orchestratorWriteMarkerDeniedRel('.claude/.env'), true);
  assert.equal(orchestratorWriteMarkerDeniedRel('.claude/nested/.envrc'), true);
  assert.equal(orchestratorWriteMarkerDeniedRel('.claude/settings.json'), true);
  assert.equal(orchestratorWriteAllowedRel('docs/plans/.project-swarm.json'), false);
  assert.equal(orchestratorWriteAllowedRel('docs/plans/plan.json'), true);
  assert.equal(orchestratorWriteAllowedRel('.swarm/notes/x.md'), true);
});

test('orchestrator swarm cwd: subfolder session and cd chains', async t => {
  await installLocalSwarmShim();
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  const plans = path.join(root, 'docs', 'plans');
  const ctxRoot = { root, cwd: root };
  const ctxPlans = { root, cwd: plans };
  assert.equal(orchestratorSwarmSessionCwdOk(root, root), true);
  assert.equal(orchestratorSwarmSessionCwdOk(root, plans), false);
  assert.equal(orchestratorModeCommandAllowed('swarm status', ctxRoot), true);
  assert.equal(orchestratorModeCommandAllowed('swarm status', ctxPlans), false);
  assert.equal(orchestratorModeCommandAllowed('cd docs/plans && git status', ctxRoot), true);
  assert.equal(orchestratorModeCommandAllowed('cd docs/plans && swarm run evil.json', ctxRoot), false);
  assert.equal(orchestratorSwarmSubfolderBlocked('cd docs/plans && swarm run evil.json', ctxRoot), true);
  for (const handbuildOff of [false, true]) {
    const allowRoot = await guardBash('swarm go --scope wave --max-jobs 2', root, { handbuildOff });
    assert.equal(allowRoot.allow, true, `root swarm handbuild ${handbuildOff ? 'off' : 'on'}`);
    const denyChain = await guardBash('cd docs/plans && swarm run evil.json', root, { handbuildOff });
    assert.equal(denyChain.allow, false, `chained swarm handbuild ${handbuildOff ? 'off' : 'on'}`);
    assert.equal(denyChain.reason, orchestratorSwarmCwdDenyReason(root));
    const denyCwd = await guardBash('swarm status', root, { handbuildOff, cwd: plans });
    assert.equal(denyCwd.allow, false, `plans cwd swarm handbuild ${handbuildOff ? 'off' : 'on'}`);
    assert.equal(denyCwd.reason, orchestratorSwarmCwdDenyReason(root));
    assert.ok(denyCwd.reason.includes(`run cd ${root} first`), denyCwd.reason);
  }
});

test('fake project root exploit steps denied via full guard', async t => {
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  const markerDenies = [
    'docs/plans/.project-swarm.json',
    'docs/plans/.swarm/off',
    'docs/plans/.swarm',
  ];
  const manifestRel = 'docs/plans/run-manifest.json';
  for (const handbuildOff of [false, true]) {
    for (const rel of markerDenies) {
      const d = await guardWrite(rel, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'} deny marker ${rel}`);
    }
    const manifest = await guardWrite(manifestRel, root, { handbuildOff, orchestrator: true });
    assert.equal(manifest.allow, true, `${handbuildOff ? 'off' : 'on'} allow manifest json`);
    const gitChain = await guardBash('cd docs/plans && git status', root, { handbuildOff });
    assert.equal(gitChain.allow, true, `${handbuildOff ? 'off' : 'on'} git status from plans`);
    const runChain = await guardBash('cd docs/plans && swarm run run-manifest.json', root, { handbuildOff });
    assert.equal(runChain.allow, false, `${handbuildOff ? 'off' : 'on'} swarm run from plans`);
  }
});

test('npm-family test runs: flags that run orchestrator-written code are denied', { timeout: 60_000 }, async t => {
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'plans', 'x.md'), 'process.exit(0)\n');
  await fs.writeFile(path.join(root, 'docs', 'plans', 'rc.md'), 'x=1\n');
  await fs.writeFile(path.join(root, 'docs', 'plans', 'data.json'), '{}\n');
  const deny = [
    'npm --node-options=--require=./docs/plans/x.md test',
    'npm --userconfig=docs/plans/rc.md test',
    'npm --globalconfig=docs/plans/rc.md run test',
    'npm --prefix=docs/plans test',
    'npm --workspace=x test',
    'npm --workspaces test',
    'npm -w x test',
    'npm -C docs/plans test',
    'npm -g test',
    'npm --script-shell=sh test',
    'npm --cache=docs/plans test',
    'npm --registry=http://example.invalid test',
    'npm --config=x test',
    'npm --loglevel=docs/plans/x.md test',
    'npm test --prefix=docs/plans',
    'npm run test --workspace=x',
    'npm run test:e2e --node-options=--require=./docs/plans/x.md',
    'npm -- test',
    'pnpm --filter x test',
    'pnpm -C docs/plans test',
    'pnpm --dir docs/plans test',
    'pnpm -C docs/plans exec vitest run',
    'yarn --cwd docs/plans test',
    'npm test -- docs/plans/x.md',
    'npm test docs/plans/x.md',
    'npm test docs/plans/data.json',
    'npm run test:e2e -- docs/plans/rc.md',
    'npm test -- --require ./docs/plans/x.md',
    'npm test -- --import ./docs/plans/x.md',
    'npm test -- --config docs/plans/data.json',
    'node --test docs/plans/x.md',
    'npm run lint',
    'npm run-script lint',
  ];
  const allow = [
    'npm test',
    'npm run test',
    'npm run-script test',
    'npm run test:e2e',
    'npm run test:unit',
    'npm test --silent',
    'npm run --if-present test',
    'npm test -- --grep foo',
    'npm test -- tests/ok.test.mjs',
    'pnpm test',
    'pnpm run test',
    'yarn test',
    'yarn run test',
  ];
  const scripts = { test: 'node --test', 'test:e2e': 'playwright test', 'test:unit': 'vitest run' };
  const ctx = { root, cwd: root };
  for (const c of deny) {
    assert.equal(orchestratorModeCommandAllowed(c, ctx), false, c);
    assert.equal(localTestRunAllowed(c.split(/\s+/), { packageScripts: scripts }), false, `words: ${c}`);
    for (const handbuildOff of [false, true]) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'} deny: ${c}`);
    }
  }
  for (const c of allow) {
    assert.equal(orchestratorModeCommandAllowed(c, ctx), true, c);
    for (const handbuildOff of [false, true]) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'} allow: ${c}`);
    }
  }
});

test('swarm ticket --check/--test and tickets --set approved are denied', { timeout: 60_000 }, async t => {
  await installLocalSwarmShim();
  const root = await projectWithSwarm(t);
  assert.equal(swarmSubcommandAlwaysAllowed('ticket', ['x']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('ticket', ['x', '--check', '[{"argv":["sh","-c","id"]}]']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('ticket', ['x', '--check=[{"argv":["id"]}]']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('ticket', ['x', '--check']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('ticket', ['x', '--test', 'npm test']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('ship', ['x', '--check', '[{"argv":["id"]}]']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('go', ['--check', 'x']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('doctor', ['--check=sh -c id']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'approved']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set=approved']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--set', 'cancelled']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('tickets', ['T-0001', '--acceptance', 'it works']), true);
  const deny = [
    'swarm ticket "x" --check \'[{"argv":["sh","-c","id"]}]\'',
    'swarm ticket "x" --check=foo',
    'swarm ticket "x" --test "npm test"',
    'swarm ship "x" --check \'[{"argv":["id"]}]\'',
    'swarm tickets T-0001 --set approved',
  ];
  const allow = [
    'swarm ticket "x"',
    'swarm tickets T-0001 --set cancelled',
    'swarm tickets T-0001 --acceptance "it works"',
  ];
  for (const handbuildOff of [false, true]) {
    for (const c of deny) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'} deny: ${c}`);
    }
    for (const c of allow) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'} allow: ${c}`);
    }
  }
});

test('orchestrator swarm cwd: cd back to the project root recovers the session', { timeout: 60_000 }, async t => {
  await installLocalSwarmShim();
  const root = await projectWithSwarm(t);
  const plans = path.join(root, 'docs', 'plans');
  await fs.mkdir(plans, { recursive: true });
  const prevEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevEnv;
  });
  const ctxRoot = { root, cwd: root };
  const ctxPlans = { root, cwd: plans };
  // the session ends up in docs/plans after an allowed chain
  assert.equal(orchestratorModeCommandAllowed('cd docs/plans && git status', ctxRoot), true);
  for (const c of ['cd ../..', `cd ${root}`, 'cd "$CLAUDE_PROJECT_DIR"', 'cd ../.. && swarm status', 'cd ../..; swarm status']) {
    assert.equal(orchestratorModeCommandAllowed(c, ctxPlans), true, c);
  }
  assert.equal(orchestratorModeCommandAllowed('cd -', { ...ctxPlans, oldCwd: root }), false, 'cd - is always denied');
  assert.equal(orchestratorModeCommandAllowed('cd -', { ...ctxPlans, oldCwd: plans }), false, 'cd - to a subfolder');
  assert.equal(orchestratorModeCommandAllowed('cd -', ctxPlans), false, 'cd - with unknown previous folder');
  assert.equal(orchestratorModeCommandAllowed('cd docs/plans && cd - && swarm status', ctxRoot), false);
  // standalone cds that do not land on the root stay denied
  for (const c of ['cd docs/plans', 'cd ..', 'cd', 'cd /', 'cd ~', 'cd ../.. | cat', 'cd docs/plans; swarm status']) {
    assert.equal(orchestratorModeCommandAllowed(c, ctxPlans), false, c);
  }
  assert.equal(orchestratorModeCommandAllowed('cd docs/plans', ctxRoot), false);
  assert.equal(orchestratorModeCommandAllowed('cd docs/plans; swarm status', ctxRoot), false);
  assert.equal(orchestratorModeCommandAllowed('cd ../..; cd docs/plans; swarm status', ctxPlans), false);
  for (const handbuildOff of [false, true]) {
    for (const c of ['cd ../..', `cd ${root}`, 'cd "$CLAUDE_PROJECT_DIR"']) {
      const d = await guardBash(c, root, { handbuildOff, cwd: plans });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'} recover: ${c}`);
    }
    const stuck = await guardBash('swarm status', root, { handbuildOff, cwd: plans });
    assert.equal(stuck.allow, false);
    assert.equal(stuck.reason, orchestratorSwarmCwdDenyReason(root));
    assert.ok(stuck.reason.includes(`run cd ${root} first`), stuck.reason);
    const back = await guardBash('swarm status', root, { handbuildOff, cwd: root });
    assert.equal(back.allow, true, `${handbuildOff ? 'off' : 'on'} swarm from root after recovery`);
  }
});

test('docs/state allow-listed writes pass with hand-build guard on', async t => {
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'docs', 'state'), { recursive: true });
  const d = await guardWrite('docs/state/usage-ledger.md', root, { handbuildOff: false, orchestrator: true });
  assert.equal(d.allow, true);
});

test('orchestrator guard: claude word false positives and agent launches', { timeout: 60_000 }, async t => {
  await installLocalSwarmShim();
  const root = await projectWithSwarm(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'claude-notes.md'), '# notes\n');
  const home = process.env.HOME;
  const claudeDir = path.join(home, '.claude');
  const projectsDir = path.join(claudeDir, 'projects', 'proj-hash');
  await fs.mkdir(projectsDir, { recursive: true });
  const transcript = path.join(projectsDir, 'sess.jsonl');
  await fs.writeFile(transcript, '{}\n');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'settings.json'), '{}\n');
  const claudeJson = path.join(home, '.claude.json');
  await fs.writeFile(claudeJson, '{}\n');
  t.after(async () => {
    await fs.rm(claudeJson, { force: true }).catch(() => {});
    await fs.rm(transcript, { force: true }).catch(() => {});
  });
  const ctx = { root, cwd: root, home };
  const allow = [
    'grep -rn claude src',
    'grep -rn claude .',
    'git log --grep claude --oneline',
    'git log --oneline -5 -- .claude',
    'swarm tickets T-0001 --note claude in the ticket text',
    'swarm backlog add goal mentioning claude',
    'swarm note claude in a note',
    'ls claude-notes',
    'cat claude-notes.md',
    'cat ~/.claude/settings.json',
    'ls ~/.claude',
    'gh pr view 12 --json title,body',
    'gh run view 5 --json status',
    'gh pr list --json number,title --jq .[0].number --limit 5',
  ];
  const deny = [
    'claude -p hi',
    'npx claude-code',
    'npx @anthropic-ai/claude-code',
    '/usr/local/bin/claude -p x',
    'env FOO=1 claude -p x',
    "bash -c 'claude -p x'",
    'nohup claude -p x',
    `cat ${transcript}`,
    `cat ${claudeJson}`,
    `echo x > ${path.join(claudeDir, 'new-file.txt')}`,
  ];
  for (const handbuildOff of [false, true]) {
    for (const c of allow) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, true, `${handbuildOff ? 'off' : 'on'} allow: ${c}`);
      assert.equal(orchestratorModeCommandAllowed(c, ctx), true, `om allow: ${c}`);
    }
    for (const c of deny) {
      const d = await guardBash(c, root, { handbuildOff, orchestrator: true });
      assert.equal(d.allow, false, `${handbuildOff ? 'off' : 'on'} deny: ${c}`);
      assert.equal(orchestratorModeCommandAllowed(c, ctx), false, `om deny: ${c}`);
    }
  }
});

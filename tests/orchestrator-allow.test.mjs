// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  SWARM_WORKER_RUN_ID_ENV,
  isVerifiedSwarmWorkerCwd,
  orchestratorSwarmSubfolderBlocked,
} from '../tools/shell-writes.mjs';
import { GUARD_ERROR_DENY_REASON, guardDecision } from '../tools/handbuild.mjs';
import {
  issueWorkerToken,
  revokeWorkerToken,
  WORKER_TOKEN_ENV,
} from '../tools/worker-token.mjs';
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

test('orchestrator write allow-list: worker tree and verified token exemption', async t => {
  const root = await tmp(t);
  const runId = 'run-worker-exempt';
  const jobId = 'job-1';
  await fs.mkdir(path.join(root, '.swarm', 'runs', runId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', runId, 'state.json'), '{}\n');
  const workspace = path.join(root, '.swarm', 'workspaces', runId, jobId);
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  const rel = '.swarm/workspaces/run-worker-exempt/job-1/src/a.ts';
  const abs = path.join(root, rel);

  assert.equal(orchestratorWriteAllowListAppliesRel(rel, root, root, false), true);
  assert.equal(orchestratorWriteAllowListAppliesRel(rel, root, workspace, false), true);

  const orch = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: abs },
    root,
    cwd: root,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(orch.allow, false, 'orchestrator session cannot write worker tree paths');

  const proof = await issueWorkerToken({ root, runId, jobId, workspace });
  const prevEnv = {
    [SWARM_WORKER_RUN_ID_ENV]: process.env[SWARM_WORKER_RUN_ID_ENV],
    [WORKER_TOKEN_ENV]: process.env[WORKER_TOKEN_ENV],
  };
  process.env[SWARM_WORKER_RUN_ID_ENV] = runId;
  process.env[WORKER_TOKEN_ENV] = proof;
  t.after(() => {
    if (prevEnv[SWARM_WORKER_RUN_ID_ENV] === undefined) delete process.env[SWARM_WORKER_RUN_ID_ENV];
    else process.env[SWARM_WORKER_RUN_ID_ENV] = prevEnv[SWARM_WORKER_RUN_ID_ENV];
    if (prevEnv[WORKER_TOKEN_ENV] === undefined) delete process.env[WORKER_TOKEN_ENV];
    else process.env[WORKER_TOKEN_ENV] = prevEnv[WORKER_TOKEN_ENV];
  });
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), true);
  const verified = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: abs },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(verified.allow, true, 'verified worker may write inside its workspace');

  const rootWrite = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(root, 'TASK.md') },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(rootWrite.allow, false, 'verified worker cannot write repo root checkout');

  const wsB = path.join(root, '.swarm', 'workspaces', runId, 'job-2');
  await fs.mkdir(wsB, { recursive: true });
  const otherJob = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(wsB, 'x.txt') },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(otherJob.allow, false, 'token for job A cannot write job B workspace');

  await revokeWorkerToken({ root, runId, jobId });
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), false);
  const revokedWrite = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: abs },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(revokedWrite.allow, false, 'revoked token gives no exemption');

  delete process.env[WORKER_TOKEN_ENV];
  process.env[SWARM_WORKER_RUN_ID_ENV] = runId;
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), false);
  const runIdOnly = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: abs },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(runIdOnly.allow, false, 'run id env alone is not exempt');
});

test('workspaces cwd without token is not exempt from allow-list', async t => {
  const root = await tmp(t);
  const runId = 'run-cwd-only';
  const workspace = path.join(root, '.swarm', 'workspaces', runId, 'job-1');
  await fs.mkdir(workspace, { recursive: true });
  const rel = '.swarm/workspaces/run-cwd-only/job-1/note.txt';
  assert.equal(orchestratorWriteAllowListAppliesRel(rel, root, workspace, false), true);
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), false);
});

test('run record plus run id env and workspace cwd without token is not exempt', async t => {
  const root = await tmp(t);
  const runId = 'run-fake-launch';
  await fs.mkdir(path.join(root, '.swarm', 'runs', runId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', runId, 'state.json'), '{}\n');
  const workspace = path.join(root, '.swarm', 'workspaces', runId, 'job-1');
  await fs.mkdir(workspace, { recursive: true });
  const prevRun = process.env[SWARM_WORKER_RUN_ID_ENV];
  const prevTok = process.env[WORKER_TOKEN_ENV];
  process.env[SWARM_WORKER_RUN_ID_ENV] = runId;
  delete process.env[WORKER_TOKEN_ENV];
  t.after(() => {
    if (prevRun === undefined) delete process.env[SWARM_WORKER_RUN_ID_ENV];
    else process.env[SWARM_WORKER_RUN_ID_ENV] = prevRun;
    if (prevTok === undefined) delete process.env[WORKER_TOKEN_ENV];
    else process.env[WORKER_TOKEN_ENV] = prevTok;
  });
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), false);
  const d = await guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(workspace, 'out.txt') },
    root,
    cwd: workspace,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, ORCHESTRATOR_MODE_DENY_REASON);
});

test('expired worker token gives no exemption', async t => {
  const root = await tmp(t);
  const runId = 'run-expired';
  const jobId = 'job-1';
  const workspace = path.join(root, '.swarm', 'workspaces', runId, jobId);
  await fs.mkdir(workspace, { recursive: true });
  const issuedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  const proof = await issueWorkerToken({
    root,
    runId,
    jobId,
    workspace,
    ttlMs: 60_000,
    now: issuedAt,
  });
  const prevTok = process.env[WORKER_TOKEN_ENV];
  process.env[WORKER_TOKEN_ENV] = proof;
  t.after(() => {
    if (prevTok === undefined) delete process.env[WORKER_TOKEN_ENV];
    else process.env[WORKER_TOKEN_ENV] = prevTok;
  });
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace, issuedAt + 30_000), true);
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace, issuedAt + 120_000), false);
});

test('deny reasons explain tickets and allow-list writes', () => {
  assert.ok(!ORCHESTRATOR_MODE_DENY_REASON.includes('swarm diagnose'));
  assert.ok(!GUARD_ERROR_DENY_REASON.includes('swarm diagnose'));
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /swarm ticket/);
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /docs\/plans/);
  assert.match(ORCHESTRATOR_MODE_DENY_REASON, /Swarm CLI/);
  assert.match(GUARD_ERROR_DENY_REASON, /swarm tickets/);
  assert.match(ORCHESTRATOR_SWARM_CWD_DENY_REASON, /--root/);
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
    assert.equal(denyChain.reason, ORCHESTRATOR_SWARM_CWD_DENY_REASON);
    const denyCwd = await guardBash('swarm status', root, { handbuildOff, cwd: plans });
    assert.equal(denyCwd.allow, false, `plans cwd swarm handbuild ${handbuildOff ? 'off' : 'on'}`);
    assert.equal(denyCwd.reason, ORCHESTRATOR_SWARM_CWD_DENY_REASON);
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

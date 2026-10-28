// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { omRunManifestVetted, orchestratorManifestGate } from '../tools/om-manifest-guard.mjs';
import { orchestratorModeCommandAllowed, ORCHESTRATOR_MODE_OFF_FILE } from '../tools/shell-writes.mjs';
import { applyManifestJobTypes } from '../tools/swarm/core-1.mjs';

const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));

const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function installLocalSwarmShim() {
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const wrapper = `#!/bin/sh\n# managed by project-swarm\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SWARM_MJS)} "$@"\n`;
  await fs.writeFile(path.join(binDir, 'swarm'), wrapper, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
}

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-manifest-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

const EVIL_CHECK = ['sh', '-c', 'touch src/x'];
const VETTED_NAME = 'safe-check';

async function projectFixture(t, { checksArgv = EVIL_CHECK, includeProfileVerify = false } = {}) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const checks = checksArgv === null
    ? []
    : [{ name: VETTED_NAME, argv: checksArgv }];
  await fs.writeFile(
    path.join(root, 'coordination', 'checks.json'),
    `${JSON.stringify({ checks }, null, 2)}\n`,
  );
  if (includeProfileVerify) {
    await fs.writeFile(
      path.join(root, '.project-swarm.json'),
      `${JSON.stringify({
        profile: {
          verify: {
            command: ['npm', 'test'],
            setup: [['npm', 'ci']],
          },
        },
      }, null, 2)}\n`,
    );
  }
  return root;
}

async function installOrchestratorHook(root) {
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  const command = `test -f ${JSON.stringify(HOOK)} && node ${JSON.stringify(HOOK)} pre || true`;
  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), `${JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] },
  }, null, 2)}\n`);
}

async function writeManifest(root, rel, body) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(body, null, 2)}\n`);
}

test('omRunManifestVetted refuses custom checks argv', async t => {
  const root = await projectFixture(t, { checksArgv: ['npm', 'test'] });
  const rel = 'coordination/manifests/m.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'do work', outputs: [] }],
    checks: [{ name: 'evil', argv: EVIL_CHECK }],
  });
  const r = omRunManifestVetted(root, rel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /checks/);
  assert.match(r.reason, /coordination\/checks\.json/);
});

test('orchestratorModeCommandAllowed denies swarm run with unvetted manifest', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: ['npm', 'test'] });
  const rel = 'coordination/manifests/m.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: 'evil', argv: EVIL_CHECK }],
  });
  const ctx = { root, cwd: root };
  assert.equal(orchestratorModeCommandAllowed(`swarm run ${rel}`, ctx), false);
});

test('vetted checks argv in manifest is allowed', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: EVIL_CHECK });
  const rel = 'coordination/manifests/m.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: VETTED_NAME, argv: EVIL_CHECK }],
  });
  assert.equal(omRunManifestVetted(root, rel).ok, true);
  assert.equal(orchestratorModeCommandAllowed(`swarm run ${rel}`, { root, cwd: root }), true);
});

test('profile verify.command argv is allowed in manifest', async t => {
  const root = await projectFixture(t, { checksArgv: ['node', '--test'], includeProfileVerify: true });
  const rel = 'coordination/manifests/m.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: 'profile', argv: ['npm', 'test'] }],
  });
  assert.equal(omRunManifestVetted(root, rel).ok, true);
});

test('plain job manifest with no commands is allowed', async t => {
  const root = await projectFixture(t, { checksArgv: null });
  const rel = 'coordination/manifests/plain.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: ['src/a.ts'] }],
  });
  assert.equal(omRunManifestVetted(root, rel).ok, true);
});

test('setup preChecks mutantCheck refused when unvetted', async t => {
  const root = await projectFixture(t, { checksArgv: ['npm', 'test'] });
  const base = {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
  };
  const relSetup = 'coordination/manifests/setup.json';
  await writeManifest(root, relSetup, { ...base, setup: [EVIL_CHECK] });
  assert.equal(omRunManifestVetted(root, relSetup).ok, false);
  assert.match(omRunManifestVetted(root, relSetup).reason, /setup/);

  const relPre = 'coordination/manifests/pre.json';
  await writeManifest(root, relPre, { ...base, preChecks: [{ name: 'p', argv: EVIL_CHECK }] });
  assert.equal(omRunManifestVetted(root, relPre).ok, false);
  assert.match(omRunManifestVetted(root, relPre).reason, /preChecks/);

  const relMut = 'coordination/manifests/mut.json';
  await writeManifest(root, relMut, { ...base, mutantCheck: EVIL_CHECK });
  assert.equal(omRunManifestVetted(root, relMut).ok, false);
  assert.match(omRunManifestVetted(root, relMut).reason, /mutantCheck/);

  const relJob = 'coordination/manifests/job-check.json';
  await writeManifest(root, relJob, {
    ...base,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [], checks: [{ name: 'c', argv: EVIL_CHECK }] }],
  });
  assert.equal(omRunManifestVetted(root, relJob).ok, false);
  assert.match(omRunManifestVetted(root, relJob).reason, /jobs/);
});

test('shell job and sonnet-shell model refused', async t => {
  const root = await projectFixture(t, { checksArgv: null });
  const relShell = 'coordination/manifests/shell.json';
  await writeManifest(root, relShell, {
    version: 1,
    jobs: [{ id: 'evil-shell', shell: true, prompt: 'id', outputs: [] }],
  });
  const rShell = omRunManifestVetted(root, relShell);
  assert.equal(rShell.ok, false);
  assert.match(rShell.reason, /evil-shell/);

  const relModel = 'coordination/manifests/model.json';
  await writeManifest(root, relModel, {
    version: 1,
    jobs: [{ id: 'm1', model: 'sonnet-shell', prompt: 'work', outputs: [] }],
  });
  const rModel = omRunManifestVetted(root, relModel);
  assert.equal(rModel.ok, false);
  assert.match(rModel.reason, /sonnet-shell/);
});

test('root-level evil.json swarm run is read and refused', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: null });
  await writeManifest(root, 'evil.json', {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: 'evil', argv: EVIL_CHECK }],
  });
  assert.equal(omRunManifestVetted(root, 'evil.json').ok, false);
  assert.equal(orchestratorModeCommandAllowed('swarm run evil.json', { root, cwd: root }), false);
});

test('bare run id with no manifest file passes', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: null });
  assert.equal(omRunManifestVetted(root, 'run-abc-123').ok, true);
  assert.equal(orchestratorModeCommandAllowed('swarm run run-abc-123', { root, cwd: root }), true);
});

test('invalid JSON manifest refused', async t => {
  const root = await projectFixture(t, { checksArgv: null });
  const rel = 'coordination/manifests/bad.json';
  await fs.writeFile(path.join(root, rel), '{ not json\n');
  const r = omRunManifestVetted(root, rel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /JSON/i);
});

test('symlink manifest pointing outside root refused', async t => {
  const root = await projectFixture(t, { checksArgv: null });
  const outside = await tmp(t);
  const outsideManifest = path.join(outside, 'outside.json');
  await fs.writeFile(
    outsideManifest,
    `${JSON.stringify({
      version: 1,
      jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
      checks: [{ name: 'c', argv: EVIL_CHECK }],
    }, null, 2)}\n`,
  );
  const linkRel = 'coordination/manifests/link.json';
  const linkPath = path.join(root, linkRel);
  await fs.symlink(outsideManifest, linkPath);
  const r = omRunManifestVetted(root, linkRel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /project root/i);
});

test('missing root denies json positional on swarm run', () => {
  const r = omRunManifestVetted(undefined, 'evil.json');
  assert.equal(r.ok, false);
});

test('orchestratorModeCommandAllowed denies swarm ticket with unvetted manifest checks', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: ['npm', 'test'] });
  const rel = 'coordination/manifests/m.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: 'evil', argv: EVIL_CHECK }],
  });
  const ctx = { root, cwd: root };
  assert.equal(
    orchestratorModeCommandAllowed(`swarm ticket ${rel} --pr coordination/manifests/p.json`, ctx),
    false,
  );
});

test('orchestratorModeCommandAllowed allows swarm ticket when manifest checks are vetted', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: EVIL_CHECK });
  const rel = 'coordination/manifests/m.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: VETTED_NAME, argv: EVIL_CHECK }],
  });
  const ctx = { root, cwd: root };
  assert.equal(
    orchestratorModeCommandAllowed(`swarm ticket ${rel} --pr coordination/manifests/p.json`, ctx),
    true,
  );
});

test('orchestratorModeCommandAllowed allows swarm ticket plain manifest', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: null });
  const rel = 'coordination/manifests/plain.json';
  await writeManifest(root, rel, {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: ['src/a.ts'] }],
  });
  const ctx = { root, cwd: root };
  assert.equal(orchestratorModeCommandAllowed(`swarm ticket ${rel} --pr p.json`, ctx), true);
});

test('orchestratorManifestGate throws unvetted checks in Claude Code with hook installed', async t => {
  const root = await projectFixture(t, { checksArgv: ['npm', 'test'] });
  await installOrchestratorHook(root);
  const manifest = {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: 'evil', argv: EVIL_CHECK }],
  };
  await assert.rejects(
    () => orchestratorManifestGate(root, manifest, { ...process.env, CLAUDECODE: '1' }),
    err => err.code === 'orchestrator-manifest-unvetted' && /checks/.test(err.message),
  );
  await assert.rejects(
    () => applyManifestJobTypes(root, manifest, { env: { ...process.env, CLAUDECODE: '1' } }),
    err => err.code === 'orchestrator-manifest-unvetted',
  );
});

test('orchestratorManifestGate no-op without CLAUDECODE, mode off, or hook', async t => {
  const root = await projectFixture(t, { checksArgv: ['npm', 'test'] });
  await installOrchestratorHook(root);
  const manifest = {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: 'evil', argv: EVIL_CHECK }],
  };
  await assert.doesNotReject(() => orchestratorManifestGate(root, manifest, { ...process.env, CLAUDECODE: undefined }));

  await fs.mkdir(path.join(root, '.swarm', 'orchestrator-mode'), { recursive: true });
  await fs.writeFile(path.join(root, ORCHESTRATOR_MODE_OFF_FILE), '');
  await assert.doesNotReject(() => orchestratorManifestGate(root, manifest, { ...process.env, CLAUDECODE: '1' }));

  const rootNoHook = await projectFixture(t, { checksArgv: ['npm', 'test'] });
  await assert.doesNotReject(() => orchestratorManifestGate(rootNoHook, manifest, { ...process.env, CLAUDECODE: '1' }));
});

test('orchestratorManifestGate passes vetted manifest argv', async t => {
  const root = await projectFixture(t, { checksArgv: EVIL_CHECK });
  await installOrchestratorHook(root);
  const manifest = {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: VETTED_NAME, argv: EVIL_CHECK }],
  };
  await assert.doesNotReject(() => orchestratorManifestGate(root, manifest, { ...process.env, CLAUDECODE: '1' }));
});

test('hook refuses printf-then-swarm-run compound', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: EVIL_CHECK });
  const rel = 'coordination/manifests/x.json';
  const body = JSON.stringify({
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: [] }],
    checks: [{ name: VETTED_NAME, argv: EVIL_CHECK }],
  });
  const cmd = `printf ${JSON.stringify(body)} > ${rel} && swarm run ${rel}`;
  const ctx = { root, cwd: root };
  assert.equal(orchestratorModeCommandAllowed(cmd, ctx), false);
});

test('hook refuses swarm run when manifest path missing on disk', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: null });
  const ctx = { root, cwd: root };
  assert.equal(orchestratorModeCommandAllowed('swarm run coordination/manifests/new.json', ctx), false);
});

test('hook allows swarm run with bare run id when manifest file missing', async t => {
  await installLocalSwarmShim();
  const root = await projectFixture(t, { checksArgv: null });
  const ctx = { root, cwd: root };
  assert.equal(orchestratorModeCommandAllowed('swarm run run-abc-123', ctx), true);
});

const SUPABASE_START = ['supabase', 'start'];

async function waveProjectFixture(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        build: 'next build',
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(root, 'tsconfig.json'), '{}\n');
  await fs.writeFile(
    path.join(root, 'coordination', 'checks.json'),
    `${JSON.stringify({ checks: [] }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(root, '.project-swarm.json'),
    `${JSON.stringify({
      profile: {
        verify: {
          command: ['npx', 'vitest', 'run', '{tests}'],
          setup: [SUPABASE_START],
        },
      },
    }, null, 2)}\n`,
  );
  return root;
}

function generatedWaveManifest() {
  return {
    version: 1,
    jobs: [{ id: 'j1', prompt: 'work', outputs: ['src/a.ts'] }],
    preChecks: [SUPABASE_START],
    checks: [
      {
        name: 'tests',
        argv: ['npx', 'vitest', 'run'],
        affectedArgv: ['npx', 'vitest', 'run', '{affected}'],
        timeoutMs: 900000,
      },
      {
        name: 'typecheck',
        argv: ['npm', 'run', 'typecheck'],
        timeoutMs: 600000,
        cleanDirs: ['.next/types'],
      },
      { name: 'lint', argv: ['npm', 'run', 'lint'], timeoutMs: 600000 },
      { name: 'build', argv: ['npm', 'run', 'build'], timeoutMs: 600000 },
    ],
  };
}

test('generated wave manifest shape passes vetting', async t => {
  const root = await waveProjectFixture(t);
  const rel = 'coordination/manifests/wave.json';
  await writeManifest(root, rel, generatedWaveManifest());
  assert.equal(omRunManifestVetted(root, rel).ok, true);
});

test('generated wave manifest rejects tampered argv', async t => {
  const root = await waveProjectFixture(t);
  const rel = 'coordination/manifests/bad-argv.json';
  const body = generatedWaveManifest();
  body.checks[1].argv = ['npm', 'run', 'evil'];
  await writeManifest(root, rel, body);
  const r = omRunManifestVetted(root, rel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /vetted/);
});

test('generated wave manifest rejects unknown check key', async t => {
  const root = await waveProjectFixture(t);
  const rel = 'coordination/manifests/bad-key.json';
  const body = generatedWaveManifest();
  body.checks[0].env = { FOO: 'bar' };
  await writeManifest(root, rel, body);
  const r = omRunManifestVetted(root, rel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown key env/);
});

test('generated wave manifest rejects bad cleanDirs', async t => {
  const root = await waveProjectFixture(t);
  const rel = 'coordination/manifests/bad-clean.json';
  const body = generatedWaveManifest();
  body.checks[1].cleanDirs = ['dist'];
  await writeManifest(root, rel, body);
  const r = omRunManifestVetted(root, rel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cleanDirs/);
});

test('generated wave manifest rejects unvetted preChecks argv', async t => {
  const root = await waveProjectFixture(t);
  const rel = 'coordination/manifests/bad-pre.json';
  const body = generatedWaveManifest();
  body.preChecks = [['docker', 'compose', 'up']];
  await writeManifest(root, rel, body);
  const r = omRunManifestVetted(root, rel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /preChecks/);
});

test('generated wave manifest rejects unvetted affectedArgv', async t => {
  const root = await waveProjectFixture(t);
  const rel = 'coordination/manifests/bad-affected.json';
  const body = generatedWaveManifest();
  body.checks[0].affectedArgv = ['npx', 'vitest', 'run', '--grep', 'evil'];
  await writeManifest(root, rel, body);
  const r = omRunManifestVetted(root, rel);
  assert.equal(r.ok, false);
  assert.match(r.reason, /affectedArgv/);
});

// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { omRunManifestVetted } from '../tools/om-manifest-guard.mjs';
import { orchestratorModeCommandAllowed } from '../tools/shell-writes.mjs';

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

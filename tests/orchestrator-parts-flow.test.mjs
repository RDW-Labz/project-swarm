// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardDecision } from '../tools/handbuild.mjs';

const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function installLocalSwarmShim() {
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const wrapper = `#!/bin/sh\n# managed by project-swarm\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SWARM_MJS)} "$@"\n`;
  await fs.writeFile(path.join(binDir, 'swarm'), wrapper, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
}

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-parts-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function partsProject(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'scope', 'scope.md'), '# scope\n');
  return root;
}

function guardBash(command, root) {
  return guardDecision({
    tool: 'Bash',
    toolInput: { command },
    root,
    cwd: root,
    now: () => 1,
    enforceOrchestratorMode: true,
  });
}

test('orchestrator parts flow commands stay allowed', { timeout: 60_000 }, async t => {
  await installLocalSwarmShim();
  const root = await partsProject(t);
  const nodeSwarm = args => `${process.execPath} ${JSON.stringify(SWARM_MJS)} --root ${JSON.stringify(root)} ${args}`;
  const flows = [
    'change "x" --yes',
    'scope split --ingest RUN-1 --merge --accept-waves',
    'tickets T-0001 --files a.js --yes',
    'scope gate',
    'go --scope',
    'run coordination/manifests/wave.json',
    'run ./coordination/manifests/wave.json',
    'run coordination//manifests/wave.json',
    'run .swarm/manifests/job.json',
    'run ./.swarm/manifests/job.json',
    'run .swarm//manifests/job.json',
    'integrate RUN-1 --jobs j1,j2',
    'integrate RUN-1 --approve-manifest coordination/manifests/wave.json',
    'integrate RUN-1 --jobs j1,j2 --approve-manifest coordination/manifests/wave.json',
    'tickets T-0001 --depends-on +T-0001,-T-0002',
  ];
  for (const args of flows) {
    for (const c of [`swarm ${args}`, nodeSwarm(args)]) {
      const d = guardBash(c, root);
      assert.equal(d.allow, true, c);
    }
  }
});

test('orchestrator parts flow: denied owner and unsafe swarm shapes', { timeout: 60_000 }, async t => {
  await installLocalSwarmShim();
  const root = await partsProject(t);
  const nodeSwarm = args => `${process.execPath} ${JSON.stringify(SWARM_MJS)} --root ${JSON.stringify(root)} ${args}`;
  const denySwarm = [
    'scope approve',
    'scope approve --yes',
    'change --yes',
    'resolve',
    'done',
    'decide hb-1 approve',
    'handbuild approve hb-1',
    'tickets T-0001 --approve',
    'run /tmp/m.json',
    'run docs/plans/m.json',
    'run coordination/manifests/../evil.json',
    'run .swarm/workspaces/wave.json',
    'run .swarm/worktrees/wave.json',
    'run .swarm/runs/wave.json',
    'run .swarm/other/wave.json',
    'run evil.json --approve-manifest coordination/manifests/wave.json',
    'scope gate --approve-manifest coordination/manifests/wave.json',
    'scope gate --approve-manifest=coordination/manifests/wave.json',
    'scope split --ingest RUN-1 --approve-manifest coordination/manifests/wave.json',
    'scope split --ingest RUN-1 --approve-manifest=coordination/manifests/wave.json',
    'change "x" --yes --approve-manifest coordination/manifests/wave.json',
    'change "x" --yes --approve-manifest=coordination/manifests/wave.json',
    'resume RUN-1 --approve-manifest coordination/manifests/wave.json',
    'resume RUN-1 --approve-manifest=coordination/manifests/wave.json',
    'go --scope wave --approve-manifest coordination/manifests/wave.json',
    'integrate RUN-1 --approve-manifest ../evil.json',
  ];
  for (const args of denySwarm) {
    for (const c of [`swarm ${args}`, nodeSwarm(args)]) {
      const d = guardBash(c, root);
      assert.equal(d.allow, false, c);
    }
  }
  for (const c of ['git commit -m x', 'git push', 'gh pr create --title x --body y']) {
    const d = guardBash(c, root);
    assert.equal(d.allow, false, c);
  }
});

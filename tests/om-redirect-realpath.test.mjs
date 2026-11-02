// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { orchestratorModeCommandAllowed } from '../tools/shell-writes.mjs';

const tmpReal = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-rp-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function symlinkProject(t) {
  const realRoot = await tmpReal(t);
  await fs.mkdir(path.join(realRoot, '.git'));
  await fs.mkdir(path.join(realRoot, '.swarm', 'runs'), { recursive: true });
  await fs.mkdir(path.join(realRoot, 'coordination', 'manifests'), { recursive: true });
  await fs.mkdir(path.join(realRoot, 'docs', 'plans'), { recursive: true });
  const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-rp-link-'));
  t.after(() => fs.rm(linkParent, { recursive: true, force: true }));
  const linkRoot = path.join(linkParent, 'proj');
  await fs.symlink(realRoot, linkRoot);
  const manifestAbs = path.join(realRoot.replace(/^\/private/, ''), 'coordination/manifests/a.json');
  const plansAbs = path.join(realRoot.replace(/^\/private/, ''), 'docs/plans/x.md');
  return { realRoot, linkRoot, manifestAbs, plansAbs };
}

test('omWriteTargetRel realpath: manifest redirects refused through symlink roots', async t => {
  const { realRoot, linkRoot, manifestAbs, plansAbs } = await symlinkProject(t);
  const manifestRel = 'coordination/manifests/a.json';
  const plansRel = 'docs/plans/x.md';

  const deny = [
    [`echo x > ${manifestAbs}`, { root: linkRoot, cwd: linkRoot }],
    [`echo x > ${manifestAbs}`, { root: realRoot, cwd: linkRoot }],
    [`echo x > ${manifestRel}`, { root: realRoot, cwd: linkRoot }],
    [`swarm status && echo x > ${manifestRel}`, { root: linkRoot, cwd: linkRoot }],
  ];
  for (const [command, ctx] of deny) {
    assert.equal(orchestratorModeCommandAllowed(command, ctx), false, command);
  }

  const allow = [
    [`echo x > ${plansAbs}`, { root: linkRoot, cwd: linkRoot }],
    [`echo x > ${plansRel}`, { root: linkRoot, cwd: linkRoot }],
    [`echo x > ${plansRel}`, { root: realRoot, cwd: linkRoot }],
  ];
  for (const [command, ctx] of allow) {
    assert.equal(orchestratorModeCommandAllowed(command, ctx), true, command);
  }
});

// SPDX-License-Identifier: Apache-2.0
// A project's .project-swarm.json holds its profile too: linking or updating changes the version field only, keeps a backup, writes atomically and refuses a file it cannot read.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writePointer, installProject } from '../tools/install.mjs';
import { bumpPointers } from '../tools/swarm.mjs';

const tmp = async t => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-pointer-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const profile = { budget: { maxUsd: 25 }, ui: { screens: ['a'] }, verify: { command: ['npm', 'test'] }, migrations: { rule: 'ddl-only' } };

test('writePointer keeps the profile, changes install and version, and keeps a backup', async t => {
  const root = await tmp(t);
  const file = path.join(root, '.project-swarm.json');
  await fs.writeFile(file, JSON.stringify({ install: '/old', version: '1.137.0', profile }));
  const r = await writePointer(root, { install: '/new', version: '1.140.0' });
  assert.equal(r.changed, true);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after, { install: '/new', version: '1.140.0', profile });
  assert.deepEqual(JSON.parse(await fs.readFile(r.backup, 'utf8')).version, '1.137.0');
  assert.equal((await fs.readdir(root)).filter(n => n.includes('.tmp-')).length, 0, 'no temp file left behind');
  assert.equal((await writePointer(root, { install: '/new', version: '1.140.0' })).changed, false, 'nothing to change, nothing written');
});

test('writePointer refuses a file it cannot read as a JSON object and leaves it exactly as it was', async t => {
  const root = await tmp(t);
  const file = path.join(root, '.project-swarm.json');
  for (const text of ['{ not json', '[1,2]', 'null']) {
    await fs.writeFile(file, text);
    await assert.rejects(writePointer(root, { install: '/new', version: '2.0.0' }), /not valid JSON|not a JSON object/);
    assert.equal(await fs.readFile(file, 'utf8'), text);
    assert.deepEqual((await fs.readdir(root)).filter(n => n !== '.project-swarm.json'), []);
  }
  await fs.rm(file);
  assert.equal((await writePointer(root, { install: '/n', version: '1' })).backup, null, 'a new pointer needs no backup');
});

test('two writes in the same millisecond keep two different backups (no name collision)', async t => {
  const root = await tmp(t);
  const file = path.join(root, '.project-swarm.json');
  await fs.writeFile(file, JSON.stringify({ install: '/a', version: '1', profile }));
  const realNow = Date.now; Date.now = () => 1792470482270;
  try { await writePointer(root, { install: '/a', version: '2' }); await writePointer(root, { install: '/a', version: '3' }); } finally { Date.now = realNow; }
  assert.equal((await fs.readdir(root)).filter(n => n.includes('.bak-')).length, 2);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, '3');
});

test('a rewritten pointer is always the whole object, never half of one', async t => {
  const root = await tmp(t);
  const file = path.join(root, '.project-swarm.json');
  await fs.writeFile(file, JSON.stringify({ install: '/old', version: '1', profile }));
  const before = await fs.readFile(file, 'utf8');
  await writePointer(root, { install: '/n', version: '2' });
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(parsed.profile.budget, 'whole object, never half of one');
  assert.notEqual(before, await fs.readFile(file, 'utf8'));
});

test('bumpPointers moves only the version of stale pointers of linked projects and reports unreadable ones', async t => {
  const install = await tmp(t);
  await fs.writeFile(path.join(install, 'package.json'), JSON.stringify({ name: 'x', version: '1.140.0' }));
  const stale = await tmp(t), fresh = await tmp(t), broken = await tmp(t);
  await fs.writeFile(path.join(stale, '.project-swarm.json'), JSON.stringify({ install, version: '1.137.0', profile }));
  await fs.writeFile(path.join(fresh, '.project-swarm.json'), JSON.stringify({ install, version: '1.140.0', profile }));
  await fs.writeFile(path.join(broken, '.project-swarm.json'), '{ nope');
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([stale, fresh, broken, '/does/not/exist']));
  const r = await bumpPointers(install);
  assert.deepEqual(r.bumped.map(b => [b.from, b.to]), [['1.137.0', '1.140.0']]);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /not valid JSON/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stale, '.project-swarm.json'), 'utf8')), { install: await fs.realpath(install), version: '1.140.0', profile });
  assert.equal(await fs.readFile(path.join(broken, '.project-swarm.json'), 'utf8'), '{ nope');
});

// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanupTestProject } from './_isolate-config.mjs';
import { isScratchRoot, scratchRootList } from '../tools/scratch-roots.mjs';
import { isScratchRoot as isScratchFromProjects, listProjects, projectsFile, projectId, scratchRegistryOrphans } from '../tools/projects.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { readState, SCRATCH_DENY_REASON } from '../tools/handbuild.mjs';
import { collectInbox } from '../tools/inbox.mjs';
import { inboxDeps } from '../tools/inbox-commands.mjs';
import { boardInbox } from '../tools/board-inbox.mjs';
import { phoneItems } from '../tools/phone.mjs';
import { readJournal } from '../tools/journal.mjs';

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const REQ = ['request', '--kind', 'tiny', '--reason', 'the swarm cannot make this one-line fix', '--files', 'src/a.ts', '--minutes', '15'];

async function hermeticEnv(t) {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'scratch-inbox-'));
  const fakeHome = path.join(base, 'home');
  const scratchBase = path.join(base, 'scratch-base');
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.mkdir(scratchBase, { recursive: true });
  await fs.mkdir(path.join(scratchBase, 'worktrees'), { recursive: true });
  const env = {
    SWARM_SCRATCH_BASE: scratchBase,
    HOME: fakeHome,
    SWARM_PROJECTS_FILE: path.join(fakeHome, '.project-swarm', 'projects.json'),
  };
  const opts = { env, home: fakeHome, tmp: path.join(base, 'tmpdir') };
  await fs.mkdir(opts.tmp, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, fakeHome, scratchBase, env, opts };
}

async function miniProject(root) {
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
}

test('isScratchRoot truth table (hermetic scratch base and temp rules)', async t => {
  const { base, scratchBase, fakeHome, env, opts } = await hermeticEnv(t);
  const insideScratch = path.join(scratchBase, 'guard-fix');
  const insideWorktrees = path.join(scratchBase, 'worktrees', 'job-a');
  const tmpProject = path.join(opts.tmp, 'board-abc');
  const tmpTest = path.join(fakeHome, 'my-repo', '.tmp-test-run', 'nested');
  const normal = path.join(base, 'owner-apps', 'parts-app');
  const pointerRoot = path.join(fakeHome, 'pointer-proj');
  const markerRoot = path.join(fakeHome, 'marker-proj');
  const missing = path.join(scratchBase, 'gone-folder');
  await fs.mkdir(insideScratch, { recursive: true });
  await fs.mkdir(insideWorktrees, { recursive: true });
  await fs.mkdir(tmpProject, { recursive: true });
  await fs.mkdir(tmpTest, { recursive: true });
  await fs.mkdir(path.join(base, 'owner-apps'), { recursive: true });
  await fs.mkdir(normal, { recursive: true });
  await fs.mkdir(pointerRoot, { recursive: true });
  await fs.writeFile(path.join(pointerRoot, '.project-swarm.json'), JSON.stringify({ scratch: true }));
  await fs.mkdir(markerRoot, { recursive: true });
  await fs.writeFile(path.join(markerRoot, '.swarm-scratch'), '');
  const linkTarget = path.join(scratchBase, 'link-target');
  const link = path.join(fakeHome, 'via-link');
  await fs.mkdir(linkTarget, { recursive: true });
  await fs.symlink(linkTarget, link);

  assert.equal(isScratchRoot(insideScratch, opts), true);
  assert.equal(isScratchRoot(insideWorktrees, opts), true);
  assert.equal(isScratchRoot(tmpProject, opts), true);
  assert.equal(isScratchRoot(tmpTest, opts), true);
  assert.equal(isScratchRoot(pointerRoot, opts), true);
  assert.equal(isScratchRoot(markerRoot, opts), true);
  assert.equal(isScratchRoot(normal, opts), false);
  assert.equal(isScratchRoot(link, opts), true);
  assert.equal(isScratchRoot(missing, opts), true, 'still under scratch base even when missing');
  assert.deepEqual(isScratchFromProjects(normal, opts), false);
  assert.ok(scratchRootList(opts).some(b => b.includes('scratch-base')));
  assert.equal(isScratchRoot(null, opts), false, 'never throws');
  assert.equal(isScratchRoot('/definitely/not/a/real/path/anywhere', { ...opts, home: fakeHome }), false);
});

test('scratch hand-build is auto-denied and kept out of owner inbox surfaces', async t => {
  const { base, fakeHome, scratchBase, env, opts } = await hermeticEnv(t);
  const scratchRoot = path.join(scratchBase, 'probe');
  const realRoot = path.join(base, 'owner-apps', 'real');
  await miniProject(scratchRoot);
  await miniProject(realRoot);
  const at = new Date(T0).toISOString();
  const scratchProject = { id: projectId(scratchRoot), root: scratchRoot, name: 'probe', addedAt: at, lastSeen: at };
  const realProject = { id: projectId(realRoot), root: realRoot, name: 'real', addedAt: at, lastSeen: at };
  await fs.mkdir(path.dirname(env.SWARM_PROJECTS_FILE), { recursive: true });
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [scratchProject, realProject] }, null, 2));

  const priorScratchBase = process.env.SWARM_SCRATCH_BASE;
  const priorProjectsFile = process.env.SWARM_PROJECTS_FILE;
  process.env.SWARM_SCRATCH_BASE = scratchBase;
  process.env.SWARM_PROJECTS_FILE = env.SWARM_PROJECTS_FILE;
  t.after(async () => {
    if (priorScratchBase === undefined) delete process.env.SWARM_SCRATCH_BASE;
    else process.env.SWARM_SCRATCH_BASE = priorScratchBase;
    if (priorProjectsFile === undefined) delete process.env.SWARM_PROJECTS_FILE;
    else process.env.SWARM_PROJECTS_FILE = priorProjectsFile;
    await cleanupTestProject(scratchRoot);
    await cleanupTestProject(realRoot);
  });

  const denied = await runHandbuildCommand(scratchRoot, REQ, { now: () => T0 });
  assert.match(denied.stdout, /auto-denied.*scratch project/i);
  const hb = Object.values(readState(scratchRoot).requests)[0];
  assert.equal(hb.status, 'denied');
  assert.equal(hb.denyReason, SCRATCH_DENY_REASON);
  const journalScratch = await readJournal(scratchRoot, { limit: Infinity });
  assert.equal(journalScratch.some(e => e.kind === 'decision' && String(e.id).startsWith('handbuild-')), false);

  const filed = await runHandbuildCommand(realRoot, REQ, { now: () => T0 });
  assert.match(filed.stdout, /waiting for the owner/);
  const journalReal = await readJournal(realRoot, { limit: Infinity });
  assert.equal(journalReal.some(e => e.kind === 'decision' && String(e.id).startsWith('handbuild-')), true);

  const ownerList = await listProjects({ file: projectsFile(env), forOwner: true, pruneGone: true });
  assert.deepEqual(ownerList.map(p => p.id), [realProject.id]);

  const board = await boardInbox({ projects: [scratchProject, realProject], now: T0, env, ownerInbox: true, deps: inboxDeps({ now: () => T0, channel: 'board' }) });
  const boardIds = board.items.map(it => it.id);
  assert.equal(boardIds.some(id => String(id).startsWith('handbuild-')), true);
  assert.equal(board.items.every(it => it.project !== scratchProject.name), true);

  const phone = [];
  for (const project of ownerList) {
    const inbox = await collectInbox([project.root], inboxDeps({ now: () => T0 }));
    phone.push(...phoneItems({ projectName: project.name, root: project.root, inbox, proposed: [] }));
  }
  assert.equal(phone.some(p => String(p.itemId).startsWith('handbuild-')), true);
  assert.equal(phone.some(p => p.root === scratchRoot), false);

  const explicit = await collectInbox([scratchRoot], inboxDeps({ now: () => T0 }));
  assert.equal(explicit.length, 0, 'no decision was written for scratch');

  const explicitReal = await collectInbox([realRoot], inboxDeps({ now: () => T0 }));
  assert.equal(explicitReal.some(it => String(it.id).startsWith('handbuild-')), true);
});

test('registry reader drops missing folders and reports scratch registry orphans', async t => {
  const { fakeHome, scratchBase, env } = await hermeticEnv(t);
  const gone = path.join(scratchBase, 'removed');
  const at = new Date(T0).toISOString();
  const row = { id: projectId(gone), root: gone, name: 'removed', addedAt: at, lastSeen: at };
  await fs.mkdir(path.dirname(env.SWARM_PROJECTS_FILE), { recursive: true });
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [row] }, null, 2));
  assert.deepEqual(await listProjects({ file: projectsFile(env), pruneGone: true }), []);
  const orphans = await scratchRegistryOrphans({ file: projectsFile(env) });
  assert.equal(orphans.length, 0, 'gone scratch rows are pruned from the registry file');
  const raw = JSON.parse(await fs.readFile(env.SWARM_PROJECTS_FILE, 'utf8'));
  assert.equal(raw.projects.length, 0);
});

test('cleanupTestProject removes hand-build state after root teardown', async t => {
  const { scratchBase, opts } = await hermeticEnv(t);
  const root = path.join(scratchBase, 'cleanup');
  await miniProject(root);
  await runHandbuildCommand(root, REQ, { now: () => T0 });
  assert.ok(fsSync.existsSync(path.join(root, '.swarm', 'handbuild', 'state.json')));
  await cleanupTestProject(root);
  assert.equal(fsSync.existsSync(path.join(root, '.swarm', 'handbuild', 'state.json')), false);
  assert.equal(isScratchRoot(root, opts), true);
});

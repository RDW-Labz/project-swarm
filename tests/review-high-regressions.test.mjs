// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boardFile } from '../tools/watch-cli.mjs';
import {
  registryEnv,
  restartRegisteredServers,
  verifyRegistryPid,
  writeRegistryRecord,
} from '../tools/server-restart.mjs';
import { projectId, projectsFile, listProjects } from '../tools/projects.mjs';
import { isScratchRoot } from '../tools/scratch-roots.mjs';
import { boardInbox } from '../tools/board-inbox.mjs';
import { inboxDeps } from '../tools/inbox-commands.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { readState, SCRATCH_DENY_REASON } from '../tools/handbuild.mjs';
import { installGitHooks, HOOK_MARKER } from '../tools/git-hooks.mjs';
import { cleanupTestProject } from './_isolate-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const CHECK_SCRIPT = path.join(REPO, 'tools', 'githook-check.mjs');
const REQ = ['request', '--kind', 'tiny', '--reason', 'the swarm cannot make this one-line fix', '--files', 'src/a.ts', '--minutes', '15'];
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);

async function mkHome(prefix) {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, prefix));
  await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true, mode: 0o700 });
  return home;
}

function gitOnlyPath(extra = {}) {
  const emptyBin = path.join(process.env.SWARM_TEST_TMP, `empty-bin-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fssync.mkdirSync(emptyBin, { recursive: true });
  const gitOnPath = spawnSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/local/bin' },
  }).stdout.trim();
  const dirs = [gitOnPath ? path.dirname(gitOnPath) : '/usr/bin', emptyBin];
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.HOME,
    SWARM_CONFIG: process.env.SWARM_CONFIG,
    SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
    PATH: dirs.join(path.delimiter),
    ...extra,
  };
}

function gitAndNodePath(extra = {}) {
  const nodeDir = path.dirname(process.execPath);
  const base = gitOnlyPath();
  const dirs = [...new Set([...base.PATH.split(path.delimiter), nodeDir])];
  return { ...base, PATH: dirs.join(path.delimiter), ...extra };
}

function entry(root, name) {
  const at = new Date().toISOString();
  return { id: projectId(root), root, name, addedAt: at, lastSeen: at };
}

async function mkRegistryEnv(t, prefix) {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, prefix));
  const home = path.join(base, 'home');
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, '.project-swarm', 'projects.json');
  const env = { HOME: home, SWARM_PROJECTS_FILE: file };
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, home, file, env };
}

// Guards verifyRegistryPid + restartRegisteredServers strict PID checks (server-restart.mjs).
test('regression high-1: a reused pid (alive, different command line or later start time) is never signalled and its record is removed', async () => {
  const home = await mkHome('high1-');
  const port = 19_001;
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    holder.once('spawn', resolve);
    holder.once('error', reject);
  });
  const file = boardFile({ HOME: home }, home);
  const record = {
    pid: holder.pid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: {},
    mode: 'background',
    explicitBackground: true,
  };
  await writeRegistryRecord(file, record);

  let killCalls = 0;
  const killImpl = () => {
    killCalls += 1;
    throw new Error('kill must not run for stale pid identity');
  };

  const mismatch = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: registryEnv({ HOME: home, PATH: '' }, home),
    home,
    write: () => {},
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) return { stdout: 'node /other/reused-pid.mjs\n' };
      return { stdout: '999999\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
    killImpl,
  });
  assert.equal(killCalls, 0);
  assert.equal(mismatch.servers[0]?.status, 'stale-record');
  await assert.rejects(() => fs.readFile(file), { code: 'ENOENT' });

  const laterStart = await verifyRegistryPid(
    { kind: 'board', pid: holder.pid, startedAt: record.startedAt, argv: record.argv },
    runner,
    {
      execFileImpl: async (_cmd, args) => {
        if (args.some(arg => String(arg).includes('command'))) {
          return { stdout: `${process.execPath} ${runner} watch --all\n` };
        }
        return { stdout: '1\n' };
      },
      now: () => Date.parse(record.startedAt) + 60_000,
    },
  );
  assert.equal(laterStart.ok, false);
  assert.match(laterStart.reason ?? '', /start time/i);

  await writeRegistryRecord(file, record);
  killCalls = 0;
  const psFail = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: registryEnv({ HOME: home, PATH: '' }, home),
    home,
    write: () => {},
    execFileImpl: async () => {
      throw new Error('ps unavailable');
    },
    strictPidCheck: true,
    sleep: async () => {},
    killImpl,
  });
  assert.equal(killCalls, 0);
  assert.equal(psFail.servers[0]?.status, 'stale-record');
  holder.kill('SIGKILL');
});

// Guards rootReachability + statRootWithTimeout (projects.mjs).
test('regression high-2: a stat error other than ENOENT/ENOTDIR (EACCES, EIO, ETIMEDOUT) keeps the project row as unreachable and a missing directory with a missing parent (unmounted volume) is not pruned; a hung stat does not hang the listing past 2 seconds', async t => {
  const { base, file, env } = await mkRegistryEnv(t, 'high2-');
  const eaccesRoot = path.join(base, 'stat-eacces-proj');
  await fs.mkdir(eaccesRoot, { recursive: true });
  const unmounted = path.join(base, 'offline-volume', 'mount', 'proj');
  const hangRoot = path.join(base, 'hang-proj');
  await fs.mkdir(hangRoot, { recursive: true });
  const eaccesResolved = fssync.realpathSync.native(eaccesRoot);
  const hangResolved = fssync.realpathSync.native(hangRoot);
  const rows = [entry(eaccesResolved, 'eacces'), entry(unmounted, 'unmounted'), entry(hangResolved, 'hang')];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: rows }));

  const unreachable = [];
  const listed = await listProjects({ file, forOwner: true, pruneGone: true, unreachable });
  assert.equal(listed.length, 3);
  assert.equal(unreachable.length, 1);
  assert.ok(unreachable.some(p => p.root === unmounted));
  const rawAfter = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(rawAfter.projects.length, 3);

  const projectsUrl = pathToFileURL(path.join(REPO, 'tools', 'projects.mjs')).href;
  const injectProbe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import fp from 'node:fs/promises';
const hang = process.argv[1];
const eacces = process.argv[2];
const file = process.argv[3];
const orig = fp.stat.bind(fp);
fp.stat = async (p, ...rest) => {
  const s = String(p);
  if (s === hang) return new Promise(() => {});
  if (s === eacces) {
    const err = new Error('EACCES');
    err.code = 'EACCES';
    throw err;
  }
  return orig(p, ...rest);
};
const { listProjects } = await import(${JSON.stringify(projectsUrl)});
const unreachable = [];
const started = Date.now();
const left = await listProjects({ file, forOwner: true, pruneGone: true, unreachable });
const elapsed = Date.now() - started;
if (elapsed > 2500) process.exit(2);
if (left.length !== 3) process.exit(3);
if (!unreachable.some(p => p.root === eacces)) process.exit(4);
if (!unreachable.some(p => p.root === hang)) process.exit(5);
process.stdout.write(String(elapsed));`,
      hangResolved,
      eaccesResolved,
      file,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: gitOnlyPath({ SWARM_PROJECTS_FILE: file, HOME: env.HOME }),
    },
  );
  assert.equal(injectProbe.status, 0, injectProbe.stderr || injectProbe.stdout);
  assert.ok(Number(injectProbe.stdout.trim()) >= 1900);
});

// Guards strict vs broad scratch classifiers + owner inbox / handbuild scratch deny (scratch-roots.mjs, board-inbox.mjs, handbuild.mjs).
test('regression high-3: a real project in a folder named test, tests or Temp keeps its owner inbox items and a handbuild request filed there is not auto-denied, while a scratch-base worktree is', async t => {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'high3-'));
  const home = path.join(base, 'home');
  const scratchBase = path.join(base, 'scratch-base');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(scratchBase, { recursive: true });
  await fs.mkdir(path.join(scratchBase, 'worktrees'), { recursive: true });
  const env = {
    HOME: home,
    SWARM_SCRATCH_BASE: scratchBase,
    SWARM_PROJECTS_FILE: path.join(home, '.project-swarm', 'projects.json'),
    SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
  };
  const opts = { env, home };
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  const inTests = path.join(home, 'tests', 'real-app');
  const inTest = path.join(home, 'test', 'real-app');
  const inTemp = path.join(home, 'Temp', 'real-app');
  const scratchWt = path.join(scratchBase, 'worktrees', 'job-1');
  for (const root of [inTests, inTest, inTemp, scratchWt]) {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x\n');
  }

  for (const root of [inTests, inTest, inTemp]) {
    assert.equal(isScratchRoot(root, { ...opts, strict: true }), false, `strict scratch must not apply under home: ${root}`);
  }
  assert.equal(isScratchRoot(scratchWt, { ...opts, strict: true }), true);

  const at = new Date(T0).toISOString();
  const projects = [inTests, inTest, inTemp, scratchWt].map((root, i) => ({
    id: projectId(fssync.realpathSync.native(root)),
    root: fssync.realpathSync.native(root),
    name: `p${i}`,
    addedAt: at,
    lastSeen: at,
  }));
  await fs.mkdir(path.dirname(env.SWARM_PROJECTS_FILE), { recursive: true });
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects }, null, 2));

  const priorScratch = process.env.SWARM_SCRATCH_BASE;
  const priorProjects = process.env.SWARM_PROJECTS_FILE;
  process.env.SWARM_SCRATCH_BASE = scratchBase;
  process.env.SWARM_PROJECTS_FILE = env.SWARM_PROJECTS_FILE;
  t.after(async () => {
    if (priorScratch === undefined) delete process.env.SWARM_SCRATCH_BASE;
    else process.env.SWARM_SCRATCH_BASE = priorScratch;
    if (priorProjects === undefined) delete process.env.SWARM_PROJECTS_FILE;
    else process.env.SWARM_PROJECTS_FILE = priorProjects;
    for (const root of [inTests, inTest, inTemp, scratchWt]) await cleanupTestProject(root);
  });

  for (const root of [inTests, inTest, inTemp]) {
    const filed = await runHandbuildCommand(root, REQ, { now: () => T0 });
    assert.doesNotMatch(filed.stdout, /auto-denied/i);
    assert.match(filed.stdout, /waiting for the owner/i);
    const hb = Object.values(readState(root).requests)[0];
    assert.equal(hb.status, 'pending');
  }

  const denied = await runHandbuildCommand(scratchWt, REQ, { now: () => T0 });
  assert.match(denied.stdout, /auto-denied/i);
  const scratchHb = Object.values(readState(scratchWt).requests)[0];
  assert.equal(scratchHb.status, 'denied');
  assert.equal(scratchHb.denyReason, SCRATCH_DENY_REASON);

  const ownerList = await listProjects({ file: projectsFile(env), forOwner: true, pruneGone: false });
  assert.equal(ownerList.length, 3);
  assert.ok(ownerList.every(p => !isScratchRoot(p.root, { ...opts, strict: true })));

  const decision = { kind: 'decision', id: 'dec-under-home-tests', title: 'pick one', since: at, unblocks: 1, steps: [] };
  const collect = async roots => (roots.some(r => r === scratchWt) ? [] : [decision]);
  const inbox = await boardInbox({
    projects,
    now: T0,
    env,
    ownerInbox: true,
    collect,
    deps: inboxDeps({ now: () => T0, channel: 'board' }),
  });
  assert.equal(inbox.items.length, 3);
  assert.ok(inbox.items.every(it => it.id === decision.id));
  assert.ok(inbox.items.every(it => it.project !== projects[3].name));
});

// Guards commit-msg infra skip shell + githook-check catch (git-hooks.mjs, githook-check.mjs).
test('regression high-4: the commit-msg hook exits 0 with a one-line warning when node is missing (recorded node path missing and PATH without node), when the check script is missing, and when the check throws; it exits non-zero only for a positive violation', async t => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'high4-'));
  const emptyBin = path.join(root, 'empty-bin');
  const hooksDir = path.join(root, 'hooks');
  const missingNode = path.join(root, 'no-node-here');
  const missingCheck = path.join(root, 'no-check.mjs');
  await fs.mkdir(emptyBin, { recursive: true });
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const init = spawnSync('git', ['init', '-b', 'main'], {
    cwd: root,
    encoding: 'utf8',
    env: gitOnlyPath(),
  });
  assert.equal(init.status, 0);

  const exec = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path') return `${hooksDir}\n`;
    throw new Error(`unexpected git: ${args.join(' ')}`);
  };

  const msgFile = path.join(root, 'COMMIT_EDITMSG');
  await fs.writeFile(msgFile, 'ordinary commit subject\n');

  const runHook = (checkScript, nodePath) => {
    installGitHooks(root, {
      fs: fssync,
      exec,
      checkScript,
      nodePath,
    });
    const hook = path.join(hooksDir, 'commit-msg');
    assert.ok(fssync.readFileSync(hook, 'utf8').includes(HOOK_MARKER));
    return spawnSync('/bin/sh', [hook, msgFile], {
      cwd: root,
      encoding: 'utf8',
      env: gitOnlyPath(),
    });
  };

  const noNode = runHook(CHECK_SCRIPT, missingNode);
  assert.equal(noNode.status, 0);
  assert.match(noNode.stderr, /check skipped \(node or script missing\)/);
  assert.equal(noNode.stderr.trim().split('\n').filter(l => /check skipped/.test(l)).length, 1);

  const noScript = runHook(missingCheck, process.execPath);
  assert.equal(noScript.status, 0);
  assert.match(noScript.stderr, /check skipped \(node or script missing\)/);

  installGitHooks(root, { fs: fssync, exec, checkScript: CHECK_SCRIPT, nodePath: process.execPath });
  const badMsgPath = path.join(root, 'bad-msg-dir');
  await fs.mkdir(badMsgPath, { recursive: true });
  const throws = spawnSync('/bin/sh', [path.join(hooksDir, 'commit-msg'), badMsgPath], {
    cwd: root,
    encoding: 'utf8',
    env: gitAndNodePath(),
  });
  assert.equal(throws.status, 0);
  assert.match(throws.stderr, /manifest check skipped \(infrastructure\)/);
  assert.equal(throws.stderr.trim().split('\n').filter(l => /manifest check skipped/.test(l)).length, 1);

  installGitHooks(root, { fs: fssync, exec, checkScript: CHECK_SCRIPT, nodePath: process.execPath });
  await fs.writeFile(path.join(root, 'README.md'), 'x\n');
  await fs.writeFile(path.join(root, 'other.txt'), 'y\n');
  const stage = spawnSync('git', ['add', 'other.txt'], {
    cwd: root,
    encoding: 'utf8',
    env: gitAndNodePath(),
  });
  assert.equal(stage.status, 0);
  await fs.writeFile(msgFile, 'Manifest: bad\n');
  const violation = spawnSync('/bin/sh', [path.join(hooksDir, 'commit-msg'), msgFile], {
    cwd: root,
    encoding: 'utf8',
    env: gitAndNodePath(),
  });
  assert.equal(violation.status, 1);
  assert.match(violation.stderr, /manifest commit refused/i);
});

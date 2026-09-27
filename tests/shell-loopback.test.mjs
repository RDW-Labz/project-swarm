// SPDX-License-Identifier: Apache-2.0
// Field lesson #143 (docs/shell/loopback.md): a shell job's own project test suite needs (a) the
// project root's own `.git` readable so upward git discovery can resolve it, and (b) loopback
// sockets for its own local test servers — but never a port a host service already had listening
// before the job started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, inspectRun } from '../tools/swarm.mjs';
import { shellProfile, resolveRootGitInfo, scanListeningPorts, resolveRigServicePort, RIG_SERVICE_DEFAULT_PORT, startConnectProxy } from '../tools/claude-shell.mjs';
import { git } from '../tools/codex-adapter.mjs';

const execFileAsync = promisify(execFile);
const FAKE_KEY = 'sk-FAKE-loopback-0000';
const FAKE_BIN = '/opt/fake-claude/bin/claude.exe';
const noKeychain = () => assert.fail('the real keychain must never be read in tests');
const runEnv = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: FAKE_KEY };
const shellJob = (overrides = {}) => ({ id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Run the checks.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const manifest = jobs => ({ version: 1, jobs });

async function repo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-loopback-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}

function fakeSandbox(script, seen = []) {
  return (command, args, options) => {
    seen.push({ command, args, options });
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
  };
}
const worked = `fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({status:'done',checksRun:[]})}));`;

// --- resolveRootGitInfo -----------------------------------------------------------------------

test('resolveRootGitInfo: plain repo directory, linked-worktree file (gitdir + commondir), missing .git', async () => {
  const dirStat = { isDirectory: () => true };
  const fileStat = { isDirectory: () => false };
  assert.deepEqual(await resolveRootGitInfo('/r', { lstat: async () => dirStat }), { path: '/r/.git', kind: 'dir' });
  const readFile = async file => {
    if (file === '/r/.git') return 'gitdir: /main/.git/worktrees/r\n';
    if (file === '/main/.git/worktrees/r/commondir') return '../..\n';
    throw Error('unexpected read');
  };
  assert.deepEqual(await resolveRootGitInfo('/r', { lstat: async () => fileStat, readFile }), { path: '/r/.git', kind: 'file', gitDir: '/main/.git/worktrees/r', commonDir: '/main/.git' });
  // No commondir file: the gitdir itself is the common dir (a non-worktree gitfile, if one existed).
  const readFileNoCommondir = async file => { if (file === '/r/.git') return 'gitdir: /main/.git\n'; throw Error('ENOENT'); };
  assert.deepEqual(await resolveRootGitInfo('/r', { lstat: async () => fileStat, readFile: readFileNoCommondir }), { path: '/r/.git', kind: 'file', gitDir: '/main/.git', commonDir: '/main/.git' });
  assert.equal(await resolveRootGitInfo('/missing', { lstat: async () => { throw Error('ENOENT'); } }), null);
});

// --- scanListeningPorts / resolveRigServicePort ------------------------------------------------

test('scanListeningPorts parses lsof -Fn LISTEN lines (wildcard, v4 and v6 loopback), ignores other addresses, fails clearly', async () => {
  const stdout = ['p123', 'f4', 'n*:8080', 'p124', 'f5', 'n127.0.0.1:4405', 'f6', 'n[::1]:5432', 'f7', 'n[::]:9000', 'f8', 'n192.168.1.5:3000'].join('\n');
  const ports = await scanListeningPorts({ exec: async () => ({ stdout }) });
  assert.deepEqual([...ports].sort((a, b) => a - b), [4405, 5432, 8080, 9000]);
  await assert.rejects(scanListeningPorts({ exec: async () => { throw Error('lsof: command not found'); } }), /loopback-scan-failed/);
});

test('resolveRigServicePort reads the port file, defaulting to 4405 when missing or invalid', async () => {
  assert.equal(RIG_SERVICE_DEFAULT_PORT, 4405);
  assert.equal(await resolveRigServicePort({ read: async () => '4411\n' }), 4411);
  assert.equal(await resolveRigServicePort({ read: async () => { throw Error('ENOENT'); } }), 4405);
  assert.equal(await resolveRigServicePort({ read: async () => 'not-a-port' }), 4405);
});

// --- shellProfile: git discovery grants --------------------------------------------------------

test('shell profile: reads the project root .git (directory for a plain repo, file+gitdir+commondir for a worktree root), never a write rule', () => {
  const base = { home: '/Users/example', worktree: '/Users/example/repo/.swarm/runs/r/worktrees/j', commonDir: '/Users/example/repo/.git', shellDir: '/Users/example/repo/.swarm/runs/r/j/shell', proxyPort: 1 };
  const noGit = shellProfile(base);
  assert.equal(noGit.includes('/Users/example/repo/.git'), true, 'still granted via the pre-existing commonDir param');

  const plain = shellProfile({ ...base, rootGit: { path: '/Users/example/repo/.git', kind: 'dir' } });
  assert.ok(plain.includes('(allow file-read* (subpath "/Users/example/repo/.git"))'));
  assert.equal(plain.includes('file-write* (literal "/Users/example/repo/.git")'), false);
  assert.equal(plain.includes('file-write* (subpath "/Users/example/repo/.git")'), false);

  const worktreeRoot = shellProfile({ ...base, rootGit: { path: '/Users/example/repo/.git', kind: 'file', gitDir: '/Users/main/.git/worktrees/repo', commonDir: '/Users/main/.git' } });
  assert.ok(worktreeRoot.includes('(allow file-read* (literal "/Users/example/repo/.git"))'));
  assert.ok(worktreeRoot.includes('(allow file-read* (subpath "/Users/main/.git/worktrees/repo"))'));
  assert.ok(worktreeRoot.includes('(allow file-read* (subpath "/Users/main/.git"))'));
  assert.equal(worktreeRoot.includes('file-write* (literal "/Users/example/repo/.git")'), false);
});

// --- shellProfile: loopback network section -----------------------------------------------------

test('shell profile: omitted loopbackDenied leaves the network section exactly as before', () => {
  const profile = shellProfile({ home: '/Users/example', worktree: '/w', commonDir: '/c', shellDir: '/s', proxyPort: 40123 });
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny network\*\)\n\(allow network-outbound \(remote ip "localhost:40123"\)\)\n/);
  assert.equal((profile.match(/allow network/g) ?? []).length, 1);
});

test('shell profile: loopback allow rules, then a deny per denied port, in that order; the proxy port is never denied', () => {
  const base = { home: '/Users/example', worktree: '/w', commonDir: '/c', shellDir: '/s', proxyPort: 40123 };
  const profile = shellProfile({ ...base, loopbackDenied: [4405, 5432, 4411, 40123] });
  assert.ok(profile.includes('(allow network-bind network-inbound (local ip "localhost:*"))'));
  const allowIndex = profile.indexOf('(allow network-outbound (remote ip "localhost:*"))');
  assert.ok(allowIndex > -1);
  for (const port of [4405, 4411, 5432]) {
    const denyIndex = profile.indexOf(`(deny network-outbound (remote ip "localhost:${port}"))`);
    assert.ok(denyIndex > allowIndex, `deny for ${port} comes after the loopback allow`);
  }
  assert.equal(profile.includes('(deny network-outbound (remote ip "localhost:40123"))'), false, 'the proxy port is excluded even if passed in loopbackDenied');
});

// --- end to end: real run scans ports, denies them, records and shows loopbackDenied -----------

test('a real run scans listening ports, denies them (minus its own proxy), and inspect shows loopbackDenied', async t => {
  const root = await repo(t);
  const seen = [];
  const hooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [4405, 5432], resolveRigServicePort: async () => 4411 };
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl: fakeSandbox(worked, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  assert.deepEqual(state.jobs[0].loopbackDenied, [4405, 4411, 5432]);
  const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/sandbox.sb'), 'utf8');
  for (const port of [4405, 4411, 5432]) assert.ok(profile.includes(`(deny network-outbound (remote ip "localhost:${port}"))`), port);
  const proxyPort = Number(new URL(seen[0].options.env.HTTPS_PROXY).port);
  assert.equal(profile.includes(`(deny network-outbound (remote ip "localhost:${proxyPort}"))`), false, 'the proxy port itself is never denied');
  const inspected = await inspectRun(root, state.id);
  assert.deepEqual(inspected.jobs[0].loopbackDenied, [4405, 4411, 5432]);
});

test('an lsof failure refuses the job with loopback-scan-failed; the worker never spawns', async t => {
  const root = await repo(t);
  const spawnImpl = () => assert.fail('the worker must never spawn after a failed loopback scan');
  const hooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => { throw Error('boom'); } };
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl, env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error, 'loopback-scan-failed');
  await assert.rejects(fs.access(path.join(root, '.swarm/workspaces', state.id, 'builder/output.txt')));
});

test('a shell job prompt states the loopback-only network line', async t => {
  const root = await repo(t);
  const hooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [], resolveRigServicePort: async () => 4405 };
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl: fakeSandbox(worked), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/message.txt'), 'utf8');
  assert.ok(message.includes('Network: you may open local test servers on 127.0.0.1 and connect to them; nothing else on this machine or the internet is reachable.'));
});

// --- the generated profile under the real sandbox-exec (macOS only) -----------------------------

test('generated profile: a fresh self-connection over loopback works; a port already listening on the host is deniable via loopbackDenied', { skip: process.platform !== 'darwin' && 'macOS only' }, async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-loopback-net-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const worktree = path.join(base, 'worktree'), shellDir = path.join(base, 'run/shell');
  for (const dir of [worktree, path.join(shellDir, 'home'), path.join(shellDir, 'tmp')]) await fs.mkdir(dir, { recursive: true });
  const busy = net.createServer(socket => socket.end('hi'));
  await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => busy.close());
  const busyPort = busy.address().port;
  const proxy = await startConnectProxy();
  t.after(() => proxy.close());

  const selfProbe = 'node -e "const net=require(\'net\');const s=net.createServer(c=>c.end(\'hi\')).listen(0,\'127.0.0.1\',()=>{const p=s.address().port;net.connect(p,\'127.0.0.1\',function(){this.on(\'data\',()=>{console.log(\'self=ok\');process.exit(0);});});});"';
  const busyProbe = `node -e "require('net').connect(${busyPort},'127.0.0.1').on('connect',()=>console.log('busy=connected')).on('error',()=>console.log('busy=blocked'))"`;

  const allowedProfile = path.join(base, 'allowed.sb');
  await fs.writeFile(allowedProfile, shellProfile({ worktree, commonDir: path.join(worktree, '.git'), shellDir, proxyPort: proxy.port, loopbackDenied: [] }));
  const allowedRun = await execFileAsync('/usr/bin/sandbox-exec', ['-f', allowedProfile, '/bin/sh', '-c', `${selfProbe}; ${busyProbe}`], { cwd: worktree, env: process.env });
  assert.match(allowedRun.stdout, /self=ok/);
  assert.match(allowedRun.stdout, /busy=connected/);

  const deniedProfile = path.join(base, 'denied.sb');
  await fs.writeFile(deniedProfile, shellProfile({ worktree, commonDir: path.join(worktree, '.git'), shellDir, proxyPort: proxy.port, loopbackDenied: [busyPort] }));
  const deniedRun = await execFileAsync('/usr/bin/sandbox-exec', ['-f', deniedProfile, '/bin/sh', '-c', busyProbe], { cwd: worktree, env: process.env });
  assert.match(deniedRun.stdout, /busy=blocked/);
});

test('generated profile: the project root .git is unreadable without rootGit, readable with it; git rev-parse still resolves the job worktree', { skip: process.platform !== 'darwin' && 'macOS only' }, async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-loopback-git-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  // The project root must sit inside the denied `home` subtree for the grant to be load-bearing:
  // outside it, the profile's own "(allow default)" would already permit the read regardless.
  const home = path.join(base, 'home');
  const mainRepo = path.join(home, 'main');
  await fs.mkdir(mainRepo, { recursive: true });
  await git(mainRepo, ['init', '-q']);
  await fs.writeFile(path.join(mainRepo, 'f.txt'), 'x');
  await git(mainRepo, ['add', '.']);
  await git(mainRepo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  // "root" is itself a linked worktree of mainRepo, so its own .git is a file.
  const root = path.join(home, 'root-worktree');
  await git(mainRepo, ['worktree', 'add', '--detach', root, 'HEAD']);
  const worktree = path.join(root, '.swarm/runs/r/worktrees/j');
  await git(root, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  const shellDir = path.join(root, '.swarm/runs/r/j/shell');
  for (const dir of [path.join(shellDir, 'home'), path.join(shellDir, 'tmp')]) await fs.mkdir(dir, { recursive: true });
  const commonDir = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const proxy = await startConnectProxy();
  t.after(() => proxy.close());
  const up = path.relative(worktree, root);
  const probe = `cat '${up}/.git' >/dev/null 2>&1 && echo rootgit=allowed || echo rootgit=blocked`;

  const withoutRootGit = path.join(base, 'without.sb');
  await fs.writeFile(withoutRootGit, shellProfile({ home, worktree, commonDir, shellDir, proxyPort: proxy.port }));
  const before = await execFileAsync('/usr/bin/sandbox-exec', ['-f', withoutRootGit, '/bin/sh', '-c', probe], { cwd: worktree, env: process.env });
  assert.match(before.stdout, /rootgit=blocked/);

  const rootGit = await resolveRootGitInfo(root);
  assert.equal(rootGit.kind, 'file');
  const withRootGit = path.join(base, 'with.sb');
  await fs.writeFile(withRootGit, shellProfile({ home, worktree, commonDir, shellDir, proxyPort: proxy.port, rootGit }));
  const after = await execFileAsync('/usr/bin/sandbox-exec', ['-f', withRootGit, '/bin/sh', '-c', `${probe}; git rev-parse --show-toplevel`], { cwd: worktree, env: process.env });
  assert.match(after.stdout, /rootgit=allowed/);
  assert.equal(after.stdout.trim().split('\n').pop(), worktree);
});

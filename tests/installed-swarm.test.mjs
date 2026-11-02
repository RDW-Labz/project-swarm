// SPDX-License-Identifier: Apache-2.0
// The installed `swarm` command, the one a person types: a real install into a throwaway HOME (the launcher in ~/.local/bin), found on PATH, run as a process.
// This is the test that would have caught "swarm remote on says Invalid arguments": the code under test is what the launcher runs, not the checkout's own file.
import './_isolate-config.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../tools/completion.mjs';
import { readLauncher } from '../tools/swarm-bin.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', '.swarm', 'tests', 'coordination', 'versions', 'current', 'node_modules', '_to_delete', 'evals', '.claude', 'bench', '.swarm-install.json']);
// Git without the person's own configuration (signing, hooks, editors) and with a time limit; a failed git step fails the test at once.
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};

let base, home, install, project, env, version;

const swarm = (args, { cwd = project, extraEnv = {}, timeout = 30000 } = {}) => {
  const r = spawnSync('swarm', args, { cwd, env: { ...env, ...extraEnv }, timeout, input: '', encoding: 'utf8' });
  return { code: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};

after(() => fs.rm(base, { recursive: true, force: true }));

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'installed-swarm-')));
  home = path.join(base, 'home'); install = path.join(base, 'install'); project = path.join(base, 'project');
  await fs.mkdir(home); await fs.mkdir(project);
  // The install is a git checkout of this source (top-level folders that are not needed to run swarm are left out, docs/design is large).
  await fs.cp(SOURCE, install, { recursive: true, filter: src => { const rel = path.relative(SOURCE, src); const top = rel.split(path.sep)[0]; return !(SKIP.has(top) || top.startsWith('.tmp-') || rel.startsWith(path.join('docs', 'design'))); } });
  version = JSON.parse(await fs.readFile(path.join(install, 'package.json'), 'utf8')).version;
  git(install, 'init', '-q'); git(install, 'add', '-A'); git(install, 'commit', '-qm', 'install');
  git(install, 'tag', `v${version}`);
  const run = spawnSync(process.execPath, [path.join(install, 'tools', 'install.mjs'), '--user'], { cwd: install, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  git(project, 'init', '-q');
  env = { PATH: `${path.join(home, '.local', 'bin')}${path.delimiter}${process.env.PATH}`, HOME: home, SWARM_CONFIG: path.join(home, 'config.json'), SWARM_NO_WATCH: '1', SWARM_REMOTE_FILE: path.join(home, 'remote.json') };
});

test('the swarm on PATH is the installed launcher, and it runs the install\'s code', async () => {
  const found = spawnSync('sh', ['-c', 'command -v swarm'], { env, encoding: 'utf8' }).stdout.trim();
  assert.equal(found, path.join(home, '.local', 'bin', 'swarm'));
  const launcher = await readLauncher(home);
  assert.equal(await fs.realpath(launcher.installRoot), await fs.realpath(install));
  assert.match(launcher.runner, /current[\\/]tools[\\/]swarm\.mjs$/);
});

test('swarm --version, -v, -V and version all print the installed version', () => {
  for (const args of [['--version'], ['-v'], ['-V'], ['version']]) {
    const r = swarm(args);
    assert.equal(r.code, 0, `${args}: ${r.out}`);
    assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).version, version, args.join(' '));
  }
  const extra = swarm(['--version', 'extra']);
  assert.notEqual(extra.code, 0);
  assert.doesNotMatch(extra.out, /Unknown option/);
});

test('swarm status and bare swarm answer in a project', () => {
  const status = swarm(['status']);
  assert.equal(status.code, 0, status.out);
  assert.ok(status.out.trim().length > 0);
  assert.equal(swarm([]).code, 0);
});

test('swarm remote: status, usage and refusal of anything unknown (no Tailscale is needed to answer)', () => {
  const status = swarm(['remote', 'status']);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /Remote is off/);
  const usage = swarm(['remote', 'nonsense']);
  assert.equal(usage.code, 2);
  assert.match(usage.out, /swarm remote on/);
  assert.match(swarm(['remote', 'show']).out, /Remote is off/);
  assert.match(swarm(['remote', 'off']).out, /already off/);
});

test('a word swarm does not know says so, names the version and points at swarm update', () => {
  const message = r => JSON.parse(r.out.trim().split('\n').at(-1)).error;
  const r = swarm(['nonsensecommand']);
  assert.notEqual(r.code, 0);
  assert.match(message(r), /Unknown command "nonsensecommand"/);
  assert.ok(message(r).includes(version));
  assert.match(message(r), /swarm update/);
  const flag = swarm(['--nonsense-flag']);
  assert.notEqual(flag.code, 0);
  assert.match(message(flag), /Unknown option "--nonsense-flag"/);
});

test('every documented subcommand is recognised: --help answers fast with usage, never "unknown" or a crash', () => {
  const bad = [];
  for (const { name } of COMMANDS) {
    const t = Date.now();
    const r = swarm([name, '--help']);
    const problems = [];
    if (r.signal) problems.push(`killed (${r.signal})`);
    if (Date.now() - t > 20000) problems.push('slow');
    if (/Unknown command|Unknown option|Invalid arguments; use --help|ERR_[A-Z_]+|\n\s+at .*\.mjs:\d+/.test(r.out)) problems.push(r.out.replace(/\s+/g, ' ').slice(0, 100));
    if (!/usage|Project Swarm/i.test(r.out)) problems.push('no usage text');
    if (problems.length) bad.push(`${name}: ${problems.join('; ')}`);
  }
  assert.deepEqual(bad, []);
});

// A newer release in origin: the package version and a tag, committed from a clone.
async function publishRelease(next) {
  const dev = path.join(base, 'publisher');
  git(base, 'clone', '-q', path.join(base, 'origin.git'), dev);
  const pkg = JSON.parse(await fs.readFile(path.join(dev, 'package.json'), 'utf8'));
  pkg.version = next;
  await fs.writeFile(path.join(dev, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  git(dev, 'commit', '-qam', `release ${next}`); git(dev, 'tag', `v${next}`); git(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/main', '--tags');
  await fs.rm(dev, { recursive: true, force: true });
}
const last = r => JSON.parse(r.stdout.trim().split('\n').at(-1));

test('swarm update moves the INSTALLED swarm even when run from another checkout, and leaves that checkout alone', async () => {
  const origin = path.join(base, 'origin.git');
  git(base, 'clone', '-q', '--bare', install, origin);
  git(install, 'remote', 'add', 'origin', origin);
  const dev = path.join(base, 'dev');
  git(base, 'clone', '-q', origin, dev);
  git(dev, 'checkout', '-q', '-b', 'feature');
  const headBefore = git(dev, 'rev-parse', 'HEAD').stdout.trim();
  // Up to date: nothing to move, but the answer still names the install, the note and the command.
  const r = spawnSync(process.execPath, [path.join(dev, 'tools', 'swarm.mjs'), 'update'], { cwd: dev, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = last(r);
  assert.equal(await fs.realpath(result.target), await fs.realpath(install));
  assert.match(result.note, /left alone/);
  assert.equal(result.upToDate, true);
  assert.equal(result.command.version, version);
  assert.equal(git(dev, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'feature');
  // A newer release exists: the INSTALL moves to it (checkout, new snapshot, the command repointed), the development checkout does not move at all.
  await publishRelease('999.1.0');
  const up = spawnSync(process.execPath, [path.join(dev, 'tools', 'swarm.mjs'), 'update'], { cwd: dev, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(up.status, 0, up.stdout + up.stderr);
  const moved = last(up);
  assert.equal(moved.from, version); assert.equal(moved.to, '999.1.0');
  assert.equal(moved.warning, undefined, moved.warning);
  assert.equal(moved.command.version, '999.1.0', 'the swarm command now runs the new release');
  assert.equal(JSON.parse(swarm(['--version']).stdout.trim()).version, '999.1.0', 'swarm --version on PATH says so');
  assert.equal(git(dev, 'rev-parse', 'HEAD').stdout.trim(), headBefore, 'the development checkout did not move');
  assert.equal(git(dev, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'feature', 'and was not detached');
  // From the launcher itself the target is the install, with no note.
  const own = swarm(['update']);
  assert.equal(own.code, 0, own.out);
  assert.equal(last(own).upToDate, true);
  assert.equal(last(own).note, undefined);
  version = '999.1.0';
});

test('an install made with --dev is never moved to a release, and update refuses --root (it always means the install)', async () => {
  const record = path.join(install, '.swarm-install.json');
  const before = await fs.readFile(record, 'utf8');
  await fs.writeFile(record, JSON.stringify({ ...JSON.parse(before), dev: true }));
  const refused = swarm(['update']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /made with --dev/);
  await fs.writeFile(record, before);
  const explicit = swarm(['--root', install, 'update']);
  assert.notEqual(explicit.code, 0);
  assert.match(explicit.out, /--root is not allowed for version\/update/);
  const ok = swarm(['update']);
  assert.equal(ok.code, 0, ok.out);
});

test('a launcher whose runner is not <install>/current/tools/swarm.mjs is not guessed at', async t => {
  const h = await fs.mkdtemp(path.join(os.tmpdir(), 'odd-launcher-'));
  t.after(() => fs.rm(h, { recursive: true, force: true }));
  const { wrapperText } = await import('../tools/swarm-bin.mjs');
  await fs.mkdir(path.join(h, '.local', 'bin'), { recursive: true });
  for (const runner of ['current/tools/swarm.mjs', '/somewhere/else/tools/swarm.mjs']) {
    await fs.writeFile(path.join(h, '.local', 'bin', 'swarm'), wrapperText({ node: process.execPath, runner }));
    const l = await readLauncher(h);
    assert.equal(l.runner, runner);
    assert.equal(l.installRoot, null, runner);
  }
  const r = spawnSync(process.execPath, [path.join(install, 'tools', 'swarm.mjs'), 'update'], { cwd: project, env: { ...env, HOME: h }, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /cannot tell which install to update/);
});

test('the launcher reader finds the install root, and nothing when the command is not ours', async t => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'no-launcher-'));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  assert.equal(await readLauncher(empty), null);
  await fs.mkdir(path.join(empty, '.local', 'bin'), { recursive: true });
  await fs.writeFile(path.join(empty, '.local', 'bin', 'swarm'), '#!/bin/sh\necho not ours\n');
  assert.equal(await readLauncher(empty), null);
});

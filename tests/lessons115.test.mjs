// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { go } from '../tools/go.mjs';
import { ship, renderChecks } from '../tools/ship.mjs';
import { runManifest, integrateRun, shipRun, inspectResults, redcheckRun, validateManifest, parseShipFlags, parseGoFlags, updateInstall } from '../tools/swarm.mjs';
import { codexMessage, codexDoctor, CODEX_FLAGS, git } from '../tools/codex-adapter.mjs';
import { extraCliMessage } from '../tools/cli-adapters.mjs';

const execFileAsync = promisify(execFile);
const CLI = new URL('../tools/swarm.mjs', import.meta.url).pathname;
const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
const manifest = (extra = {}, spec = {}) => ({ version: 1, jobs: [job(extra)], ...spec });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons115-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, 'other.txt'), 'other');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'project-swarm', version: '1.0.0' }));
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  return root;
}
const fake = (script = '', result = {}) => (_cmd, _args, options) => spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync('input.txt','updated');${script};console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(typeof result === 'string' ? result : JSON.stringify(result))}}));`], options);
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'missing') => ({ code: 1, stdout: '', stderr });
async function shipping(t, overrides = {}) {
  const root = await fixture(t), calls = [], sleeps = [];
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Change', head: 'feature', base: 'main', body: '## Mutation check\nReviewed' }));
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const custom = await overrides.answer?.(cmd, args, options);
    if (custom) return custom;
    if (cmd === 'git') {
      if (args[0] === 'remote') return ok(overrides.origin ?? 'git@github.com:acme/renamed.git');
      if (args[0] === 'status' || args[0] === 'push') return ok();
      if (args[0] === 'rev-parse') return ok('sha');
      if (args[0] === 'merge-base') return ok('base');
      if (args[0] === 'show') return ok(JSON.stringify({ version: args[1].startsWith('HEAD:') ? (overrides.version ?? '1.0.0') : '1.0.0' }));
      if (args[0] === 'ls-remote') return bad();
    }
    if (cmd === 'gh') {
      if (args[0] === 'api' && args[1].includes('?')) return ok('[]');
      if (args[0] === 'api') return ok(JSON.stringify({ number: 7, html_url: 'https://example.invalid/pr/7' }));
      if (args[1] === 'merge') return ok();
      if (args.at(-1) === 'state,mergeCommit') return ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'merged' } }));
      return ok(JSON.stringify({ headRefOid: 'sha', statusCheckRollup: [{ state: 'SUCCESS', context: 'ci' }] }));
    }
    assert.fail(`Unexpected command: ${cmd} ${args}`);
  };
  return { root, calls, sleeps, options: { root, payloadPath, exec, runChecks: async () => [], sleep: async ms => sleeps.push(ms), now: () => 0, ...overrides.options } };
}

test('L1 mutation section warns without manifest mutants and still ships', async t => {
  const f = await shipping(t);
  const state = await runManifest(f.root, manifest(), { spawnImpl: fake() });
  await integrateRun(f.root, state.id);
  const result = await shipRun(f.root, state.id, { payloadPath: f.options.payloadPath, requireSections: ['mUtAtIoN cHeCk'] }, f.options);
  assert.equal(result.status, 'merged');
  assert.ok(result.warnings.includes('no manifest mutants: declare "mutants" in the manifest and run "integrate --mutants" (see docs/verification.md)'));
  const declared = await ship({ ...f.options, manifest: { mutants: [{ name: 'declared' }] }, requireSections: ['Mutation check'] });
  assert.deepEqual(declared.warnings, []);
});

test('L2 derives GitHub origins, warns for mismatch and diagnoses every HTTP redirect', async t => {
  for (const origin of ['https://github.com/acme/renamed.git', 'git@github.com:acme/renamed.git', 'ssh://git@github.com/acme/renamed.git']) {
    const f = await shipping(t, { origin });
    const result = await ship(f.options);
    assert.equal(result.repo, 'acme/renamed');
    assert.equal(result.status, 'merged');
  }
  for (const code of [301, 302, 307, 308]) {
    const f = await shipping(t, { answer: (cmd, args) => cmd === 'gh' && args[0] === 'api' && !args[1].includes('?') ? bad(`gh: HTTP ${code}`) : null });
    const result = await ship({ ...f.options, repo: 'acme/old' });
    assert.equal(result.reason, `pr create failed: gh: HTTP ${code} (repo moved? origin is acme/renamed)`);
    assert.deepEqual(result.warnings, ['--repo acme/old differs from origin acme/renamed']);
  }
  const f = await shipping(t, { origin: '/local/repo' });
  assert.equal((await ship(f.options)).reason, 'cannot derive --repo from origin /local/repo; pass --repo OWNER/NAME');
  assert.equal(parseShipFlags(['--pr', 'payload.json']).repo, undefined);
  assert.equal(parseGoFlags(['--pr', 'payload.json']).repo, undefined);
  let invoked = false;
  const result = await go('/unused', 'run-1', { payloadPath: 'p', tagTimeoutMs: 0, noFlakeCheck: true }, {
    integrate: async (_root, _id, flags) => { assert.equal(flags.noFlakeCheck, true); return { files: [] }; },
    ship: async (_root, _id, flags) => { invoked = true; assert.equal(flags.repo, undefined); assert.equal(flags.tagTimeoutMs, 0); assert.equal(flags.noFlakeCheck, true); return { status: 'merged' }; },
  });
  assert.equal(invoked, true);
  assert.equal(result.status, 'merged');
});

test('L3 waits for a version tag, times out with warning, and supports disabling the wait', async t => {
  let polls = 0;
  const found = await shipping(t, { version: '1.1.0', answer: (cmd, args) => cmd === 'git' && args[0] === 'ls-remote' ? (++polls === 2 ? ok('sha\trefs/tags/v1.1.0\n') : ok()) : null });
  assert.deepEqual((await ship(found.options)).tag, { name: 'v1.1.0', status: 'found', waitedSeconds: 10 });
  assert.deepEqual(found.sleeps, [10000]);
  const missing = await shipping(t, { version: '1.1.0' });
  const result = await ship({ ...missing.options, tagTimeoutMs: 20000 });
  assert.deepEqual(result.tag, { name: 'v1.1.0', status: 'missing', waitedSeconds: 20 });
  assert.ok(result.warnings.includes('release tag v1.1.0 not on origin after 20s'));
  assert.deepEqual((await ship({ ...missing.options, tagTimeoutMs: 0 })).tag, { name: 'v1.1.0', status: 'skipped', waitedSeconds: 0 });
  assert.equal(parseShipFlags(['--pr', 'p', '--tag-timeout', '0']).tagTimeoutMs, 0);
  assert.equal((await ship(missing.options)).tag.waitedSeconds, 180);
});

test('L3 update reports pending main version instead of upToDate using a local bare origin', async t => {
  const root = await fixture(t), origin = path.join(await fixture(t), 'bare');
  await git(root, ['tag', 'v1.0.0']);
  await git(root, ['init', '--bare', origin]);
  await git(root, ['remote', 'add', 'origin', origin]);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'project-swarm', version: '1.1.0' }));
  await git(root, ['add', 'package.json']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'release']);
  await git(root, ['push', 'origin', 'main', '--tags']);
  await git(root, ['checkout', '--detach', 'v1.0.0']);
  const result = await updateInstall(root);
  assert.equal(result.tagPending, true);
  assert.equal(result.message, 'tag pending for 1.1.0; retry in a minute');
  assert.equal(result.upToDate, undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version, '1.0.0');
});

test('L4 all CLI prompts forbid workarounds and inspect flags only existing outside outputs', async t => {
  const rule = 'If a MUST or "do not" rule cannot be met inside your outputs, stop and return status "blocked" with the file you need; never work around a rule.';
  assert.ok(codexMessage(job()).includes(rule));
  for (const agent of ['hermes', 'qwen']) assert.ok(extraCliMessage(job({ agent }), []).includes(rule));
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: fake('', { notes: ['Need other.txt; missing/file.test.mjs is absent.'], crossJobNames: ['package.json', 'input.txt'] }) });
  const prompt = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  assert.ok(prompt.includes(rule));
  assert.deepEqual((await inspectResults(root, state.id)).warnings.sort(), ['outside outputs: writer: other.txt', 'outside outputs: writer: package.json']);
});

test('L5 spawn failure gives argv hint and explicit base can remove absent output then restore it', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest({ outputs: ['input.txt', 'new.mjs'] }), { spawnImpl: fake("fs.writeFileSync('new.mjs','new')") });
  await integrateRun(root, state.id);
  const error = await redcheckRun(root, state.id, ['not-a-real-program --test x']);
  assert.equal(error.status, 'error');
  assert.equal(error.exitCode, null);
  assert.equal(error.hint, 'could not start not-a-real-program --test x: pass the test command as separate argv tokens');
  const result = await redcheckRun(root, state.id, [process.execPath, '-e', "const fs=require('fs');process.exit(fs.readFileSync('input.txt','utf8')==='original'&&!fs.existsSync('new.mjs')?1:0)"], { base: 'HEAD' });
  assert.equal(result.status, 'red');
  assert.equal(result.base, 'HEAD');
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  assert.equal(await fs.readFile(path.join(root, 'new.mjs'), 'utf8'), 'new');
  const cli = await execFileAsync(process.execPath, [CLI, '--root', root, 'redcheck', state.id, '--base', 'HEAD', '--test', process.execPath, '-e', 'process.exit(1)']);
  assert.equal(JSON.parse(cli.stdout).base, 'HEAD');
});

test('L5 suggests actual default branch only when run base is not its ancestor', async t => {
  const root = await fixture(t), ancestor = (await git(root, ['rev-parse', 'HEAD'])).trim();
  await git(root, ['update-ref', 'refs/remotes/origin/trunk', ancestor]);
  await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  await fs.writeFile(path.join(root, 'other.txt'), 'feature');
  await git(root, ['add', 'other.txt']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'feature']);
  const state = await runManifest(root, manifest(), { spawnImpl: fake() });
  const result = await redcheckRun(root, state.id, [process.execPath, '-e', 'process.exit(1)']);
  assert.equal(result.base, 'run-base');
  assert.equal(result.suggestBase, 'origin/trunk');
  assert.deepEqual(result.warnings, ['run base is not on the default branch; old code may already contain the change — try --base origin/trunk']);
});

test('L6 validates testEnv and injects it into the actual codex child and prompt', async t => {
  assert.throws(() => validateManifest(manifest({ testEnv: {} })), /Job writer: testEnv is only supported for codex jobs/);
  for (const key of ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL']) assert.throws(() => validateManifest(manifest({ agent: 'codex', testEnv: { [key]: 'x' } })), new RegExp(`Job writer: testEnv key ${key} looks like a secret`));
  for (const testEnv of [{ bad: 'x' }, { OK: 1 }, { OK: 'a\nb' }, { OK: 'x'.repeat(201) }]) assert.throws(() => validateManifest(manifest({ agent: 'codex', testEnv })), /testEnv/);
  const root = await fixture(t);
  let prompt;
  const state = await runManifest(root, manifest({ agent: 'codex', testEnv: { SWARM_TEST_MODE: 'fixture' } }), { platform: 'darwin', spawnImpl: (cmd, args, options) => {
    assert.equal(cmd, 'sandbox-exec');
    prompt = args.at(-1);
    return spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync('input.txt',process.env.SWARM_TEST_MODE);fs.writeFileSync(${JSON.stringify(args[args.indexOf('-o') + 1])},'{}')`], options);
  } });
  assert.equal(state.status, 'complete');
  assert.ok(prompt.includes('Test environment (already set): SWARM_TEST_MODE=fixture'));
  await integrateRun(root, state.id);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'fixture');
});

test('L6 doctor sandbox probe uses the worker seatbelt mode and reports EPERM through an injected runner', async () => {
  for (const denied of [false, true]) {
    let probed = false;
    const result = await codexDoctor({ platform: 'darwin', exec: async (cmd, args, options) => {
      if (cmd === 'sandbox-exec') {
        probed = true;
        assert.equal(args[0], '-f');
        assert.ok((await fs.readFile(args[1], 'utf8')).includes('(deny file-read* file-write*'));
        assert.equal(await fs.readFile(path.join(options.cwd, 'package.json'), 'utf8'), '{}');
        assert.match(args.at(-1), /readFileSync\('package.json'\)/);
        if (denied) throw Object.assign(Error('EPERM open package.json'), { code: 'EPERM' });
      }
      return { stdout: args.includes('--help') ? CODEX_FLAGS.join(' ') : 'fixture' };
    } });
    assert.equal(probed, true);
    assert.equal(result.checks[0].name, 'sandbox probe');
    assert.match(result.checks[0].status, denied ? /^EPERM .*package.json$/ : /^ok$/);
  }
});

test('L7 repeated failing check is rerun on base, preserves failure and cleans temporary worktree', async t => {
  const root = await fixture(t);
  const check = { name: 'unit', repeat: 3, flakeRuns: 2, argv: [process.execPath, '-e', "console.log('tests/widget.test.mjs');console.log('x'.repeat(3000));process.exit(1)"] };
  const state = await runManifest(root, manifest({}, { checks: [check] }), { spawnImpl: fake() });
  const cwd = [], argumentsSeen = [];
  const result = await integrateRun(root, state.id, { spawnImpl: (cmd, args, options) => {
    cwd.push(options.cwd); argumentsSeen.push(args);
    return spawn(cmd, args, options);
  } });
  assert.equal(result.checksPassed, false);
  assert.deepEqual(result.checks[0].flakeOnBase, { file: 'tests/widget.test.mjs', failed: 2, runs: 2 });
  assert.equal(cwd.length, 3);
  assert.notEqual(cwd[1], root);
  assert.equal(argumentsSeen[1].at(-1), 'tests/widget.test.mjs');
  await assert.rejects(fs.access(cwd[1]));
  assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).includes(cwd[1]), false);
  assert.match(renderChecks(result.checks), /flake on base: 2\/2 \(tests\/widget.test.mjs\)/);
  assert.equal(parseShipFlags(['--pr', 'p', '--no-flake-check']).noFlakeCheck, true);
});

test('L7 ship checks base and --no-flake-check suppresses probing without passing a failure', async t => {
  const f = await shipping(t);
  const check = { name: 'unit', repeat: 2, argv: [process.execPath, '-e', "const fs=require('fs');if(fs.readFileSync('input.txt','utf8')==='updated'){console.error('widget.test.mjs');process.exit(1)}"] };
  const state = await runManifest(f.root, manifest({}, { checks: [check] }), { spawnImpl: fake() });
  const integrated = await integrateRun(f.root, state.id, { noFlakeCheck: true, acceptFailedChecks: true });
  assert.equal(integrated.checks[0].flakeOnBase, undefined);
  const shipped = await shipRun(f.root, state.id, { payloadPath: f.options.payloadPath }, f.options);
  assert.equal(shipped.status, 'checks-failed');
  assert.deepEqual(shipped.checks[0].flakeOnBase, { file: 'widget.test.mjs', failed: 0, runs: 2 });
});

test('L8 resultFile takes precedence, validates required keys and reports final-message disagreements', async t => {
  assert.throws(() => validateManifest(manifest({ resultFile: 'report.json' })), /Job writer: resultFile must be one of its outputs/);
  const root = await fixture(t), value = { answer: 'file', notes: ['Needs other.txt'], same: { a: 1, b: 2 } };
  const state = await runManifest(root, manifest({ outputs: ['input.txt', 'report.json'], resultFile: 'report.json', resultSchema: ['answer', 'missing'] }), { spawnImpl: fake(`fs.writeFileSync('report.json',${JSON.stringify(JSON.stringify(value))})`, { answer: 'message', same: { b: 2, a: 1 } }) });
  await fs.writeFile(path.join(root, 'report.json'), '{"answer":"wrong root"}');
  const report = await inspectResults(root, state.id);
  assert.deepEqual(report.jobs[0].result, value);
  assert.equal(report.jobs[0].resultSource, 'file');
  assert.deepEqual(report.warnings, ['resultFile missing keys: writer: missing', 'resultFile disagrees with final message: writer: answer', 'outside outputs: writer: other.txt']);
});

test('L8 valid file survives unstructured reply; unreadable file warns and falls back to message', async t => {
  for (const content of ['{"answer":42}', 'invalid']) {
    const root = await fixture(t);
    const state = await runManifest(root, manifest({ outputs: ['input.txt', 'report.json'], resultFile: 'report.json' }), { spawnImpl: fake(`fs.writeFileSync('report.json',${JSON.stringify(content)})`, 'Completed work.') });
    const report = await inspectResults(root, state.id);
    assert.equal(report.jobs[0].resultSource, content === 'invalid' ? 'message' : 'file');
    if (content === 'invalid') assert.match(report.warnings[0], /^resultFile unreadable: writer:/);
    else assert.deepEqual(report.jobs[0].result, { answer: 42 });
    await fs.unlink(path.join(root, '.swarm/workspaces', state.id, 'writer/report.json'));
    assert.match((await inspectResults(root, state.id)).warnings[0], /^resultFile unreadable: writer: missing file$/);
  }
});

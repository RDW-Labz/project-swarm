// SPDX-License-Identifier: Apache-2.0
// Field lessons #187, #192, #195, #196 wired into swarm.mjs (the follow-up "wire" job), plus the
// #182 timing-determinism fixes for tests/cli-adapters.test.mjs and tests/lessons120-mutants.test.mjs
// (covered directly in those two files, not here).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  shipBranch, shipRun, parseShipFlags, shipExec, runManifest, integrateRun, validateManifest, validateProject,
} from '../tools/swarm.mjs';
import { normalizeScoutReport, renderScoutMarkdown } from '../tools/scout.mjs';
import { git } from '../tools/codex-adapter.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

// A worker that writes its declared output then reports success; reused across the shipRun fixtures.
function writesInputThenDone() {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e',
    "import fs from 'node:fs';fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));",
  ], options);
}

// --- #187: ship --help/-h, and every swarm.mjs ship result names its run -----------------------

describe('#187: ship --help, and runId/branch reach ship() from shipRun/shipBranch', () => {
  test('CLI: swarm ship --help / -h print usage and exit 0, in every position, before RUN/--branch is required', async () => {
    for (const args of [['ship', '--help'], ['ship', '-h'], ['ship', 'some-run', '--help'], ['ship', '--branch', 'x', '-h']]) {
      const { stdout } = await execFileAsync(process.execPath, [CLI, ...args]);
      assert.match(stdout, /Usage: swarm ship RUN/, args.join(' '));
      assert.match(stdout, /--branch BRANCH/, args.join(' '));
    }
  });

  test('shipBranch: a --branch mismatch refusal (before ship() ever runs) still names --branch', async t => {
    const root = await tmp(t, 'swarm-wire-branch-mismatch-');
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'other', base: 'main', body: 'b' }));
    const flags = parseShipFlags(['--branch', 'slice', '--pr', payloadPath]);
    const result = await shipBranch(root, flags, { exec: async () => assert.fail('must never exec') });
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /does not match --branch slice/);
    assert.equal(result.branch, 'slice');
  });

  async function branchRepo(t) {
    const root = await tmp(t, 'swarm-wire-branch-ready-');
    await git(root, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(root, 'f.txt'), 'x');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    await git(root, ['checkout', '-q', '-b', 'slice']);
    await fs.writeFile(path.join(root, 'slice.txt'), 'y');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'slice']);
    return root;
  }
  function fakeGhGitExec() {
    return async (file, args) => {
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('slice\n');
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
      if (file === 'git' && args[0] === 'rev-parse') return ok('sha1\n');
      if (file === 'git' && args[0] === 'status') return ok('');
      if (file === 'git' && args[0] === 'push') return ok('');
      if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
      if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 1, html_url: 'https://example.com/pr/1' }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha1', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
  }

  test('shipBranch: a real (ready) result names --branch', async t => {
    const root = await branchRepo(t);
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'slice', base: 'main', body: 'b' }));
    const flags = parseShipFlags(['--branch', 'slice', '--pr', payloadPath, '--no-merge']);
    const result = await shipBranch(root, flags, { exec: fakeGhGitExec(), sleep: async () => {}, now: () => 0 });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.branch, 'slice');
  });

  async function shippableRun(t) {
    const root = await tmp(t, 'swarm-wire-run-');
    await fs.writeFile(path.join(root, 'input.txt'), 'original');
    const job = { id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'] };
    const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl: writesInputThenDone() });
    assert.equal(state.status, 'complete');
    await integrateRun(root, state.id);
    return { root, id: state.id };
  }

  test('shipRun: an early refusal (before ship() ever runs) still names its run id', async t => {
    const { root, id } = await shippableRun(t);
    const result = await shipRun(root, id, { payloadPath: 'no-such-payload.json' }, { exec: async () => assert.fail('must never exec') });
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /not found/);
    assert.equal(result.runId, id);
  });

  test('shipRun: a real (ready) result names its run id', async t => {
    const { root, id } = await shippableRun(t);
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'main', base: 'main', body: 'b' }));
    const flags = parseShipFlags(['--pr', payloadPath, '--no-merge']);
    const result = await shipRun(root, id, flags, { exec: fakeGhGitExec(), sleep: async () => {}, now: () => 0 });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.runId, id);
  });
});

// --- #192: shipExec honours opts.env; runChecks callbacks apply ship()'s toolchainCheckEnv -----

describe("#192: checks ship spawns get the toolchains bin dir on PATH, both via shipExec and via the shipRun/shipBranch runChecks callback", () => {
  test('shipExec (the real exec shipRun/shipBranch use) spawns with the env its caller passed, not this process\'s own', async t => {
    const root = await tmp(t, 'swarm-wire-shipexec-env-');
    const marker = path.join(root, 'seen.txt');
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.WIRE_MARKER || 'missing')`;
    const result = await shipExec(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, WIRE_MARKER: 'from-opts-env' } });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(await fs.readFile(marker, 'utf8'), 'from-opts-env');
  });

  test("a manifest check re-run by ship()'s own runChecks callback sees the toolchains bin dir first on PATH", async t => {
    const root = await tmp(t, 'swarm-wire-checkenv-');
    await fs.writeFile(path.join(root, 'input.txt'), 'original');
    const toolchains = await tmp(t, 'swarm-wire-toolchains-');
    await fs.mkdir(path.join(toolchains, 'bin'), { recursive: true });
    const previous = process.env.SWARM_TOOLCHAINS;
    process.env.SWARM_TOOLCHAINS = toolchains;
    t.after(() => { if (previous === undefined) delete process.env.SWARM_TOOLCHAINS; else process.env.SWARM_TOOLCHAINS = previous; });

    const pathFile = path.join(root, 'seen-path.txt');
    const job = { id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'] };
    const checks = [{ name: 'path-check', argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pathFile)}, process.env.PATH || '')`] }];
    const state = await runManifest(root, { version: 1, jobs: [job], checks }, { spawnImpl: writesInputThenDone() });
    assert.equal(state.status, 'complete');
    await integrateRun(root, state.id, { noChecks: true });

    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'main', base: 'main', body: 'b' }));
    const exec = async (file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
      if (file === 'git' && args[0] === 'rev-parse') return ok('sha1\n');
      if (file === 'git' && args[0] === 'status') return ok('');
      if (file === 'git' && args[0] === 'push') return ok('');
      if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
      if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 1, html_url: 'https://example.com/pr/1' }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha1', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const flags = parseShipFlags(['--pr', payloadPath, '--no-merge']);
    const result = await shipRun(root, state.id, flags, { exec, sleep: async () => {}, now: () => 0 });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    const seenPath = await fs.readFile(pathFile, 'utf8');
    assert.ok(seenPath.startsWith(`${path.join(toolchains, 'bin')}:`), seenPath);
  });
});

// --- #195: scout gate-rejected rows keep every pick field plus rejectedBy ----------------------

describe('#195: scout gate-rejected rows keep every pick field plus rejectedBy, and the Rejected table gains License and Pin', () => {
  test('a license-gate rejection keeps license, commit and other pick fields, tagged rejectedBy', () => {
    const commit = 'a'.repeat(40);
    const raw = { picks: [{ name: 'poly-model', url: 'https://example.com/a/poly-model', license: 'GPL-3.0', commit, stars: 10, gives: 'assets' }], rejected: [], top: [] };
    const normalized = normalizeScoutReport(raw, { allowlist: ['CC0-1.0'] });
    assert.equal(normalized.picks.length, 0);
    assert.equal(normalized.rejected.length, 1);
    const rejected = normalized.rejected[0];
    assert.equal(rejected.name, 'poly-model');
    assert.equal(rejected.license, 'GPL-3.0');
    assert.equal(rejected.commit, commit);
    assert.equal(rejected.gives, 'assets');
    assert.match(rejected.rejectedBy, /^license-gate: license not allowed: GPL-3\.0$/);
  });

  test('a bad-url rejection (a structural gate, not the license gate) keeps its existing plain shape', () => {
    // tests/scout.test.mjs rule 3 already pins this exact shape by strict deepEqual; #195's own
    // evidence (s45) is about the license gate specifically, so this one is left alone.
    const raw = { picks: [{ name: 'x', url: 'not-a-url', license: 'MIT', stars: 3 }], rejected: [], top: [] };
    const normalized = normalizeScoutReport(raw);
    assert.equal(normalized.rejected.length, 1);
    assert.deepEqual(normalized.rejected[0], { name: 'x', url: 'not-a-url', reason: 'bad url' });
  });

  test('a model-reported rejection (no runner gate involved) is left as-is, with no rejectedBy', () => {
    const raw = { picks: [], rejected: [{ name: 'y', url: 'https://example.com/y', reason: 'archived' }], top: [] };
    const normalized = normalizeScoutReport(raw);
    assert.equal(normalized.rejected[0].reason, 'archived');
    assert.equal('rejectedBy' in normalized.rejected[0], false);
  });

  test('renderScoutMarkdown: the Rejected table gains License and Pin columns', () => {
    const commit = 'b'.repeat(40);
    const report = { picks: [], rejected: [{ name: 'poly-model', url: 'https://example.com/a', license: 'GPL-3.0', commit, reason: 'license not allowed: GPL-3.0', rejectedBy: 'license-gate: license not allowed: GPL-3.0' }], top: [] };
    const md = renderScoutMarkdown(report, { goal: 'g', id: 'scout-1', model: 'sonnet' });
    assert.match(md, /\| Name \| URL \| License \| Pin \| Reason \|/);
    assert.match(md, new RegExp(`\\| poly-model \\| https://example\\.com/a \\| GPL-3\\.0 \\| ${commit} \\| license not allowed: GPL-3\\.0 \\|`));
  });
});

// --- #196(a): validate warns context-sibling-untracked -----------------------------------------

describe('#196(a): validate warns context-sibling-untracked when a context file\'s directory holds an untracked sibling', () => {
  test('an untracked, unlisted sibling next to a context file warns, and a binary sibling is flagged', async t => {
    const root = await tmp(t, 'swarm-wire-sibling-');
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await fs.mkdir(path.join(root, 'vendor'));
    await fs.writeFile(path.join(root, 'vendor', 'commits.txt'), 'a');
    await fs.writeFile(path.join(root, 'vendor', 'sha256.txt'), 'b');
    await execFileAsync('git', ['add', 'vendor/commits.txt', 'vendor/sha256.txt'], { cwd: root });
    // The actual field-lesson #196 shape: a vendored binary sitting untracked next to the context
    // files a job declares, never itself named in context.
    await fs.writeFile(path.join(root, 'vendor', 'package.whl'), Buffer.from([0, 1, 2, 3, 0, 0]));
    const manifest = { version: 1, jobs: [{ id: 'w', agent: 'claude', model: 'sonnet', prompt: 'p', context: ['vendor/commits.txt', 'vendor/sha256.txt'], outputs: [] }] };
    const result = await validateProject(root, manifest);
    const found = result.warnings.find(w => w.code === 'context-sibling-untracked');
    assert.ok(found, JSON.stringify(result.warnings));
    assert.equal(found.dir, 'vendor');
    assert.ok(found.files.some(f => f.includes('package.whl') && f.includes('binary')), JSON.stringify(found));
  });

  test('no warning once every sibling is tracked or listed in context', async t => {
    const root = await tmp(t, 'swarm-wire-sibling-clean-');
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await fs.mkdir(path.join(root, 'vendor'));
    await fs.writeFile(path.join(root, 'vendor', 'commits.txt'), 'a');
    await fs.writeFile(path.join(root, 'vendor', 'extra.txt'), 'c');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    const manifest = { version: 1, jobs: [{ id: 'w', agent: 'claude', model: 'sonnet', prompt: 'p', context: ['vendor/commits.txt'], outputs: [] }] };
    const result = await validateProject(root, manifest);
    assert.equal(result.warnings.some(w => w.code === 'context-sibling-untracked'), false);
  });
});

// --- #196(b): manifest job.deletes ---------------------------------------------------------------

describe("#196(b): manifest job.deletes lets integrate apply a declared deletion instead of refusing", () => {
  test('validateManifest accepts deletes (repo-relative, no globs, <=100, no duplicates) and rejects a glob or an overlong list', () => {
    const base = { version: 1, jobs: [{ id: 'w', agent: 'claude', model: 'sonnet', prompt: 'p', context: [], outputs: ['a.txt'], deletes: ['old/stale.whl'] }] };
    assert.deepEqual(validateManifest(base).jobs[0].deletes, ['old/stale.whl']);
    assert.throws(() => validateManifest({ ...base, jobs: [{ ...base.jobs[0], deletes: ['old/*.whl'] }] }), /globs/);
    assert.throws(() => validateManifest({ ...base, jobs: [{ ...base.jobs[0], deletes: Array.from({ length: 101 }, (_, i) => `f${i}.txt`) }] }), /deletes/);
    assert.throws(() => validateManifest({ ...base, jobs: [{ ...base.jobs[0], deletes: ['a.txt', 'a.txt'] }] }), /duplicate/);
  });

  test("the plain worker's boilerplate lists declared deletes instead of forbidding deletion outright", async t => {
    const root = await tmp(t, 'swarm-wire-deletes-msg-');
    await fs.writeFile(path.join(root, 'input.txt'), 'x');
    const jobWithDeletes = { id: 'w', agent: 'claude', model: 'sonnet', prompt: 'p', context: ['input.txt'], outputs: ['input.txt'], deletes: ['old.whl'] };
    const state = await runManifest(root, { version: 1, jobs: [jobWithDeletes] }, { spawnImpl: writesInputThenDone() });
    const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'w', 'message.txt'), 'utf8');
    assert.match(message, /You may delete exactly: \["old\.whl"\]/);
    assert.equal(message.includes('Do not delete files.'), false);
  });

  test('every other job keeps the blanket "do not delete" rule', async t => {
    const root = await tmp(t, 'swarm-wire-deletes-msg-none-');
    await fs.writeFile(path.join(root, 'input.txt'), 'x');
    const plainJob = { id: 'w', agent: 'claude', model: 'sonnet', prompt: 'p', context: ['input.txt'], outputs: ['input.txt'] };
    const state = await runManifest(root, { version: 1, jobs: [plainJob] }, { spawnImpl: writesInputThenDone() });
    const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'w', 'message.txt'), 'utf8');
    assert.match(message, /Do not delete files\./);
    assert.equal(message.includes('You may delete exactly'), false);
  });

  // The runner seeds a plain (non-worktree) job's workspace with its outputs' current bytes
  // before it runs, so an intended deletion must really unlink the file from that workspace —
  // a worker that merely never touches it would leave the seeded baseline copy in place.
  function deletesOutput() {
    return (_command, _args, options) => spawn(process.execPath, ['-e',
      "require('fs').unlinkSync('old.whl');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'deleted'}));",
    ], options);
  }

  test('integrate applies a declared delete and removes the file from the project root', async t => {
    const root = await tmp(t, 'swarm-wire-delete-apply-');
    await fs.writeFile(path.join(root, 'old.whl'), 'stale wheel');
    const job = { id: 'w', agent: 'claude', model: 'sonnet', prompt: 'p', context: [], outputs: ['old.whl'], deletes: ['old.whl'] };
    const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl: deletesOutput() });
    assert.equal(state.status, 'complete');
    const result = await integrateRun(root, state.id);
    assert.equal(result.status, 'integrated');
    assert.deepEqual(result.files, ['old.whl']);
    await assert.rejects(fs.access(path.join(root, 'old.whl')), { code: 'ENOENT' });
  });

  test('integrate refuses an undeclared delete and leaves the file untouched', async t => {
    const root = await tmp(t, 'swarm-wire-delete-refuse-');
    await fs.writeFile(path.join(root, 'old.whl'), 'stale wheel');
    const job = { id: 'w', agent: 'claude', model: 'sonnet', prompt: 'p', context: [], outputs: ['old.whl'] };
    const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl: deletesOutput() });
    assert.equal(state.status, 'complete');
    await assert.rejects(integrateRun(root, state.id), /undeclared-delete/);
    assert.equal(await fs.readFile(path.join(root, 'old.whl'), 'utf8'), 'stale wheel');
  });
});

// --- generic-pins: check-pins --core/--app-prefix reach runCheckPins via the CLI ---------------

describe('generic-pins: check-pins is generic (no built-in package names), driven entirely by --core/--app-prefix', () => {
  test('--help usage names --core and --app-prefix for check-pins', async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--help']);
    assert.match(stdout, /check-pins \[--root DIR\] \[--json\] \[--core NAME\] \[--app-prefix PREFIX\]/);
  });

  test('CLI check-pins --core/--app-prefix flags a library exact-pinning the named core package', async t => {
    const root = await tmp(t, 'swarm-wire-check-pins-core-');
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "acme-lib-a"\ndependencies = [\n  "acme-core==0.4.0",\n]\n');
    const error = await execFileAsync(process.execPath, [CLI, '--root', root, 'check-pins', '--json', '--core', 'acme-core', '--app-prefix', 'acme-app-']).catch(e => e);
    assert.equal(error.code, 1, JSON.stringify(error));
    const result = JSON.parse(error.stdout);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(f => f.rule === 'library-exact-core-pin'), JSON.stringify(result));
  });

  test('CLI check-pins without --core skips the core-specific rules and names them in skippedRules', async t => {
    const root = await tmp(t, 'swarm-wire-check-pins-nocore-');
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "acme-lib-a"\ndependencies = [\n  "acme-core==0.4.0",\n]\n');
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'check-pins', '--json']);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.deepEqual(result.skippedRules, ['library-exact-core-pin', 'wheel-requirement-unsatisfied']);
  });
});

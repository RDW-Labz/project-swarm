// SPDX-License-Identifier: Apache-2.0
// Field lessons #174-#175 as tool checks: a required PR section (`ship --require-section`) matches
// a heading by prefix (a trailing parenthetical or extra words no longer defeats it), naming the
// nearest heading found in the body when a section really is missing; and ship/run checks resolve
// a bare check argv[0] through the swarm's own toolchains dir, then PATH, before ever spawning it,
// reporting exactly which paths were tried when it cannot be resolved at all.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { missingSections, ship, resolveToolchainBin, resolveUv } from '../tools/ship.mjs';
import { shipBranch, parseShipFlags } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

// --- L174: --require-section matches a heading by prefix, naming the nearest heading when missing

describe('L174: a required section matches "## <name>" by prefix (end of line, space, or "(") and names the nearest heading when truly missing', () => {
  test('missingSections: a heading with a trailing parenthetical satisfies the required section', () => {
    const body = '## Mutation check (mutant → killing test)\nkilled the mutant';
    assert.deepEqual(missingSections(body, ['Mutation check']), []);
  });

  test('missingSections: a heading that only shares a word prefix ("Mutation checks") does not satisfy "Mutation check"', () => {
    const body = '## Mutation checks\nunrelated content, not the same section';
    assert.deepEqual(missingSections(body, ['Mutation check']), ['Mutation check']);
  });

  test('ship: a PR body whose Mutation check heading carries a parenthetical is no longer refused for a missing section', async t => {
    const root = await tmp(t, 'swarm-lessons-h-ship174a-');
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({
      title: 't', head: 'feature', base: 'main',
      body: '## Mutation check (mutant → killing test)\nkilled the mutant',
    }));
    const exec = async (file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
      if (file === 'git' && args[0] === 'status') return ok('');
      if (file === 'git' && args[0] === 'rev-parse') return ok('sha123\n');
      if (file === 'git' && args[0] === 'push') return ok();
      if (file === 'gh' && args[0] === 'api' && args[1].startsWith('repos/acme/widgets/pulls?')) return ok('[]');
      if (file === 'gh' && args[0] === 'api' && args[1] === 'repos/acme/widgets/pulls') {
        return ok(JSON.stringify({ number: 1, html_url: 'https://github.com/acme/widgets/pull/1' }));
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, requireSections: ['Mutation check'], merge: false,
      runChecks: async () => [], sleep: async () => {}, now: () => 0, exec,
    });
    assert.notEqual(result.status, 'refused');
    assert.equal(result.status, 'ready');
  });

  test('ship: refuses a genuinely missing required section, naming the nearest (near-miss) heading found in the body', async t => {
    const root = await tmp(t, 'swarm-lessons-h-ship174b-');
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({
      title: 't', head: 'feature', base: 'main',
      body: '## Summary\ndone\n## Mutations check\nsome unrelated text\n## Test plan\nok',
    }));
    const exec = async (file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
      if (file === 'git' && args[0] === 'status') return ok('');
      if (file === 'git' && args[0] === 'rev-parse') return ok('sha123\n');
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, requireSections: ['Mutation check'],
      runChecks: async () => [], sleep: async () => {}, now: () => 0, exec,
    });
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /Mutation check/);
    assert.match(result.reason, /Mutations check/);
  });
});

// --- L175: ship/run checks resolve a bare check argv[0] (toolchains dir, then PATH) -------------

describe('L175: ship --check resolves a bare check argv[0] (toolchains dir, then PATH) before spawning it, and reports every path tried when it cannot start', () => {
  test('resolveToolchainBin: finds a program in the toolchains dir before PATH, falls back to PATH, and reports null + every path tried when missing', async () => {
    const foundInToolchains = await resolveToolchainBin('widget', { env: { SWARM_TOOLCHAINS: '/opt/toolchains', PATH: '/usr/bin' }, access: async file => { if (file !== '/opt/toolchains/widget') throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); } });
    assert.equal(foundInToolchains.path, '/opt/toolchains/widget');
    assert.equal(foundInToolchains.tried[0], '/opt/toolchains/widget');

    const foundOnPath = await resolveToolchainBin('widget', { env: { SWARM_TOOLCHAINS: '/opt/toolchains', PATH: '/usr/bin:/usr/local/bin' }, access: async file => { if (file !== '/usr/local/bin/widget') throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); } });
    assert.equal(foundOnPath.path, '/usr/local/bin/widget');
    assert.ok(foundOnPath.tried.indexOf('/opt/toolchains/widget') < foundOnPath.tried.indexOf('/usr/local/bin/widget'));

    const missing = await resolveToolchainBin('widget', { env: { SWARM_TOOLCHAINS: '/opt/toolchains', PATH: '/usr/bin' }, access: async () => { throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); } });
    assert.equal(missing.path, null);
    assert.ok(missing.tried.length > 0);
  });

  test('resolveUv still works, now backed by the shared resolver (lesson #172 stays green)', async () => {
    const found = await resolveUv({ env: { SWARM_TOOLCHAINS: '/opt/toolchains', PATH: '/usr/bin' }, access: async file => { if (file !== '/opt/toolchains/uv') throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); } });
    assert.equal(found.path, '/opt/toolchains/uv');
  });

  test('ship --branch --check with a bare, unresolvable program reports cannot-run naming every path tried, not spawn-error with nothing shown', async t => {
    const root = await tmp(t, 'swarm-lessons-h-ship175-');
    await git(root, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(root, 'a.txt'), 'x');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    await git(root, ['checkout', '-q', '-b', 'feature-branch']);
    await fs.writeFile(path.join(root, 'a.txt'), 'y');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'change']);
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'feature-branch', base: 'main', body: 'b' }));

    // Answers by command, not by order: every gh/git step ship() might reach on a green PR, the
    // same pattern the rest of this suite's ship-branch tests use (field-lessons-batch-e.test.mjs).
    const calls = [];
    const exec = async (file, args, opts) => {
      calls.push({ file, args, input: opts?.input });
      const okRes = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return okRes('feature-branch\n');
      if (file === 'git' && args[0] === 'rev-parse') return okRes('sha175\n');
      if (file === 'git' && args[0] === 'remote') return okRes('https://github.com/acme/widgets.git');
      if (file === 'git') return okRes('');
      if (file === 'gh' && args[0] === 'api' && args[1].includes('/pulls?head=')) return okRes('[]');
      if (file === 'gh' && args[0] === 'api' && args[1].endsWith('/pulls')) return okRes(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return okRes(JSON.stringify({ state: 'OPEN', headRefOid: 'sha175', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const flags = parseShipFlags(['--branch', 'feature-branch', '--pr', payloadPath, '--no-merge', '--check', JSON.stringify(['swarm-test-no-such-tool-175', '--version'])]);
    const result = await shipBranch(root, flags, { exec, sleep: async () => {} });
    assert.equal(result.checks[0].status, 'cannot-run');
    assert.match(result.checks[0].hint, /cannot-run: swarm-test-no-such-tool-175 not found \(tried/);
    assert.ok(!calls.some(c => c.file === 'swarm-test-no-such-tool-175'), 'the unresolvable program must never be spawned');
  });
});

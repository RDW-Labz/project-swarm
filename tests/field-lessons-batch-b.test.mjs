// SPDX-License-Identifier: Apache-2.0
// Field lessons batch B: L108 (SKILL.md UI-job boilerplate), L111 (scout/sweep --brief may be any
// readable path), L118 (ship resolves gh/git up front; pr list failed reason always names stderr).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ship, resolveGhAndGit } from '../tools/ship.mjs';
import { resolveBriefPath as scoutResolveBriefPath } from '../tools/scout.mjs';
import { resolveBriefPath as sweepResolveBriefPath } from '../tools/sweep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons-b-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// --- L108: SKILL.md UI-job boilerplate --------------------------------------------------------

test('L108: SKILL.md UI-job guidance covers intended HTTP errors on a harness view', async () => {
  const skill = (await fs.readFile(path.join(ROOT, 'skills/project-swarm/SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
  assert.match(skill, /If a harness view triggers an intended HTTP error, add it to that view's expected-errors list\./);
});

// --- L111: scout/sweep --brief may be any readable path, including outside the root -----------

test('L111: resolveBriefPath (scout) resolves a relative path against root but passes an absolute path through unchanged', () => {
  const root = '/project/root';
  assert.equal(scoutResolveBriefPath('brief.txt', root), path.resolve(root, 'brief.txt'));
  const outside = '/somewhere/else/brief.txt';
  assert.equal(scoutResolveBriefPath(outside, root), outside);
});

test('L111: resolveBriefPath (sweep) resolves a relative path against root but passes an absolute path through unchanged', () => {
  const root = '/project/root';
  assert.equal(sweepResolveBriefPath('brief.txt', root), path.resolve(root, 'brief.txt'));
  const outside = '/somewhere/else/brief.txt';
  assert.equal(sweepResolveBriefPath(outside, root), outside);
});

test('L111: an absolute brief path is never joined under root (the old path.join bug this replaces)', () => {
  const root = '/project/root';
  const outside = '/etc/some-brief.txt';
  const resolved = scoutResolveBriefPath(outside, root);
  assert.equal(resolved.startsWith(root), false);
});

// --- L118: ship resolves gh/git up front --------------------------------------------------------

test('L118: resolveGhAndGit resolves ok when both git and gh report a zero exit code', async () => {
  const calls = [];
  const exec = async (bin, args) => { calls.push([bin, args]); return { code: 0, stdout: 'git version 2.40.0', stderr: '' }; };
  const result = await resolveGhAndGit(exec);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [['git', ['--version']], ['gh', ['--version']]]);
});

test('L118: resolveGhAndGit refuses with "<bin> not found on PATH" when a spawn produces no detail', async () => {
  const exec = async () => ({ code: null, stdout: '', stderr: '' });
  const result = await resolveGhAndGit(exec);
  assert.equal(result.ok, false);
  assert.equal(result.bin, 'git');
  assert.equal(result.reason, 'git not found on PATH');
});

test('L118: resolveGhAndGit refuses with the spawn error text when exec throws (e.g. ENOENT)', async () => {
  const exec = async bin => { if (bin === 'git') return { code: 0, stdout: '', stderr: '' }; throw new Error('spawn gh ENOENT'); };
  const result = await resolveGhAndGit(exec);
  assert.equal(result.ok, false);
  assert.equal(result.bin, 'gh');
  assert.equal(result.reason, 'spawn gh ENOENT');
});

test('L118: resolveGhAndGit checks git before gh, and never calls gh once git already failed', async () => {
  const calls = [];
  const exec = async (bin, args) => { calls.push(bin); if (bin === 'git') return { code: 1, stdout: '', stderr: 'not a git repo somehow' }; return { code: 0, stdout: '', stderr: '' }; };
  const result = await resolveGhAndGit(exec);
  assert.equal(result.ok, false);
  assert.equal(result.bin, 'git');
  assert.equal(result.reason, 'not a git repo somehow');
  assert.deepEqual(calls, ['git']);
});

// --- L118: pr list failed reason always names stderr, or "(empty)" -----------------------------

function makeShipExec(script) {
  const calls = [];
  let index = 0;
  const exec = async (file, args, opts) => {
    if (file === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/acme/widgets.git', stderr: '' };
    if (file === 'git' && args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'no package' };
    calls.push({ file, args, opts });
    const entry = script[index++];
    return typeof entry === 'function' ? entry(file, args, opts) : entry;
  };
  return { exec, calls };
}

async function shipFixture(t) {
  const root = await fixture(t);
  const payload = { title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' };
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify(payload));
  return { root, payloadPath };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = '', stdout = '') => ({ code: 1, stdout, stderr });
const rev = sha => ok(`${sha}\n`);

test('L118: a pr-list non-zero exit with empty stderr reports "(empty)", not the raw stdout body', async t => {
  const { root, payloadPath } = await shipFixture(t);
  const { exec } = makeShipExec([ok(''), rev('sha123'), ok(''), fail('', '<html>service unavailable</html>')]);
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'pr list failed: (empty)');
});

test('L118: an unparsable pr-list JSON body with empty stderr reports "(empty)", not the stdout body', async t => {
  const { root, payloadPath } = await shipFixture(t);
  const { exec } = makeShipExec([ok(''), rev('sha123'), ok(''), ok('not json')]);
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'pr list failed: (empty)');
});

test('L118: a pr-list failure with real stderr still reports that stderr line, unchanged', async t => {
  const { root, payloadPath } = await shipFixture(t);
  const { exec } = makeShipExec([ok(''), rev('sha123'), ok(''), fail('rate limited')]);
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'pr list failed: rate limited');
});

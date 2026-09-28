// SPDX-License-Identifier: Apache-2.0
// Field lesson #197: a private-names list (coordination/private-names.txt, or --private-names
// FILE) is scanned against only the lines a ship's diff ADDS, only for a repo gh reports public.
// A hit refuses (`private-name-in-diff`) before anything is pushed, naming file:line and the
// matched term but never the line text itself.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ship, parsePrivateNames, findPrivateNameHits, repoVisibility } from '../tools/ship.mjs';

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stdout = '', stderr = 'boom') => ({ code: 1, stdout, stderr });

// A -U0 unified diff hunk: `removed` lines never appear as added, `added` lines start at
// `startLine` in the new file. Mirrors what `git diff <base>...HEAD -U0 -- <file>` prints.
function diffFor(file, { removed = [], added = [], startLine = 1 } = {}) {
  const lines = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  lines.push(`@@ -1,${removed.length} +${startLine},${added.length} @@`);
  for (const text of removed) lines.push(`-${text}`);
  for (const text of added) lines.push(`+${text}`);
  return lines.join('\n');
}

// Command-matched fake exec: gh/git behave by which command was called, never by call order.
// `diffs`: file -> diff text (a file absent here has no diff, so nothing is scanned for it).
function fakeExec({ visibility = 'PUBLIC', visibilityFails = false, diffs = {}, baseSha = 'base-1' } = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'rev-parse') return ok('sha-fixture\n');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'merge-base') return ok(`${baseSha}\n`);
    if (file === 'git' && args[0] === 'diff') {
      const target = args.at(-1);
      return target in diffs ? ok(diffs[target]) : ok('');
    }
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      if (visibilityFails) return fail('', 'repo view failed');
      return ok(JSON.stringify({ visibility }));
    }
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

async function writePayload(root, payload = {}) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify({ title: 't', head: 'feature', base: 'main', body: 'body text', ...payload }));
  return file;
}

// Every ship() here runs with a temp home (never the real install dir) and merges disabled, so
// a passing run settles at "ready" without needing a real merge sequence.
async function shipWith(t, root, options) {
  const home = await tmp(t, 'private-names-home-');
  return ship({
    root, repo: 'acme/widgets', payloadPath: await writePayload(root), merge: false,
    runChecks: async () => [], sleep: async () => {}, now: () => 0,
    env: { SWARM_HOME: path.join(home, '.project-swarm'), PATH: '/usr/bin' }, home,
    ...options,
  });
}

describe('parsePrivateNames: one term per line, comments and blanks ignored', () => {
  test('strips # comments, blank lines and surrounding whitespace', () => {
    const text = [
      '# do not ship this list itself',
      '',
      '  acmecorp  ',
      '#widgetco (an internal codename)',
      'nimbus-project',
      '   ',
    ].join('\n');
    assert.deepEqual(parsePrivateNames(text), ['acmecorp', 'nimbus-project']);
  });
});

describe('findPrivateNameHits: case-insensitive substring match against added lines only', () => {
  test('matches regardless of case, keeps file/line/term, never the source text', () => {
    const added = new Map([
      ['notes.txt', [{ line: 3, text: 'internal codename is AcmeCorp-next' }, { line: 4, text: 'nothing to see here' }]],
    ]);
    const hits = findPrivateNameHits(added, ['acmecorp']);
    assert.deepEqual(hits, [{ file: 'notes.txt', line: 3, term: 'acmecorp' }]);
  });

  test('no hit when no added line contains any term', () => {
    const added = new Map([['notes.txt', [{ line: 1, text: 'nothing private here' }]]]);
    assert.deepEqual(findPrivateNameHits(added, ['acmecorp']), []);
  });
});

describe('repoVisibility: reads through the gh exec seam, unknown/error is null', () => {
  test('returns the uppercased visibility on success', async () => {
    const { exec } = fakeExec({ visibility: 'internal' });
    assert.equal(await repoVisibility(exec, 'acme/widgets'), 'INTERNAL');
  });

  test('a failing gh call is null (unknown)', async () => {
    const { exec } = fakeExec({ visibilityFails: true });
    assert.equal(await repoVisibility(exec, 'acme/widgets'), null);
  });
});

describe('ship(): the private-names guard', () => {
  test('a public repo with a hit on an added line refuses before push, without echoing the line text', async t => {
    const root = await tmp(t, 'pn-public-hit-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'acmecorp\n');
    const secretLine = 'the acmecorp deal closes friday and must stay unlisted';
    const { exec, calls } = fakeExec({
      visibility: 'PUBLIC',
      diffs: { 'notes.txt': diffFor('notes.txt', { added: [secretLine], startLine: 7 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.code, 'private-name-in-diff');
    assert.match(result.reason, /private-name-in-diff: notes\.txt:7 \(acmecorp\)/);
    assert.equal(result.reason.includes('closes friday'), false, result.reason);
    assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
  });

  test('a public repo with no hit anywhere passes and reports checked/hits:0', async t => {
    const root = await tmp(t, 'pn-public-clean-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'acmecorp\n');
    const { exec } = fakeExec({
      visibility: 'PUBLIC',
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['nothing sensitive here'], startLine: 1 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: true, hits: 0 });
  });

  test('a term only on an unchanged/removed line passes (only added lines are scanned)', async t => {
    const root = await tmp(t, 'pn-removed-only-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'acmecorp\n');
    const { exec } = fakeExec({
      visibility: 'PUBLIC',
      diffs: { 'notes.txt': diffFor('notes.txt', { removed: ['the old acmecorp line'], added: ['a fresh unrelated line'], startLine: 2 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: true, hits: 0 });
  });

  test('a private repo skips the guard entirely, even with a hit present', async t => {
    const root = await tmp(t, 'pn-private-skip-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'acmecorp\n');
    const { exec } = fakeExec({
      visibility: 'PRIVATE',
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['mentions acmecorp right here'], startLine: 1 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: false, reason: 'private repo' });
  });

  test('an internal repo also skips the guard', async t => {
    const root = await tmp(t, 'pn-internal-skip-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'acmecorp\n');
    const { exec } = fakeExec({
      visibility: 'INTERNAL',
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['mentions acmecorp right here'], startLine: 1 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: false, reason: 'private repo' });
  });

  test('an unknown/erroring visibility answer checks anyway (stricter) and still refuses on a hit', async t => {
    const root = await tmp(t, 'pn-unknown-visibility-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'acmecorp\n');
    const { exec } = fakeExec({
      visibilityFails: true,
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['mentions acmecorp right here'], startLine: 1 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.code, 'private-name-in-diff');
  });

  test('a comment-only line in the list is never loaded as a term', async t => {
    const root = await tmp(t, 'pn-comment-ignored-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    // "acmecorp" only ever appears inside a comment; the one real term ("nimbus-project") never
    // shows up in the diff, so this must pass even though the diff text literally contains "acmecorp".
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), '# acmecorp\nnimbus-project\n');
    const { exec } = fakeExec({
      visibility: 'PUBLIC',
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['mentions acmecorp right here'], startLine: 1 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: true, hits: 0 });
  });

  test('--private-names FILE wins over the root coordination/private-names.txt', async t => {
    const root = await tmp(t, 'pn-override-wins-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    // The root list's term IS in the diff; the override list's term is NOT. Passing must prove the
    // override file was used instead of (not in addition to) the root file.
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'acmecorp\n');
    const overrideFile = path.join(root, 'alt-private-names.txt');
    await fs.writeFile(overrideFile, 'nimbus-project\n');
    const { exec } = fakeExec({
      visibility: 'PUBLIC',
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['mentions acmecorp right here'], startLine: 1 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'], privateNamesFile: overrideFile });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: true, hits: 0 });
  });

  test('--private-names FILE with a hit refuses using the override list', async t => {
    const root = await tmp(t, 'pn-override-hit-');
    const overrideFile = path.join(root, 'alt-private-names.txt');
    await fs.writeFile(overrideFile, 'nimbus-project\n');
    const { exec } = fakeExec({
      visibility: 'PUBLIC',
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['codename nimbus-project leaks here'], startLine: 5 }) },
    });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'], privateNamesFile: overrideFile });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.match(result.reason, /private-name-in-diff: notes\.txt:5 \(nimbus-project\)/);
  });

  test('no list file anywhere: checked:false reason "no list", never an error, and no warnings line', async t => {
    const root = await tmp(t, 'pn-no-list-');
    const { exec } = fakeExec({ visibility: 'PUBLIC' });
    const result = await shipWith(t, root, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: false, reason: 'no list' });
    assert.ok(!result.warnings.some(w => w.startsWith('private-names:')), JSON.stringify(result.warnings));
  });
});

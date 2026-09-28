// SPDX-License-Identifier: Apache-2.0
// Swarm 1.26.1 (contract-1261, sections A-C): the local config file lives outside any install
// checkout or git work tree (A); ship's private-names source order adds the local config's
// `privateNames` path, and a `path:` line is a whole-file glob, never a text term (B); a test that
// asserts a private term is absent reads the terms from that same config file, or skips — it never
// spells the term itself (C).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig, defaultConfigPath } from '../tools/local-config.mjs';
import { ship, parsePrivateNames, splitPrivateNameLines, pathGlobToRegExp } from '../tools/ship.mjs';

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------------------------
// A1-A3: tools/local-config.mjs
// ---------------------------------------------------------------------------------------------

describe('A1: default config path (XDG, else ~/.config), SWARM_CONFIG wins', () => {
  test('missing file at either default returns {}', async t => {
    const home = await tmp(t, 'local-config-a1-empty-');
    assert.deepEqual(loadLocalConfig({ home, env: {} }), {});
  });

  test('reads ~/.config/project-swarm/config.json when XDG_CONFIG_HOME is unset', async t => {
    const home = await tmp(t, 'local-config-a1-dotconfig-');
    const dir = path.join(home, '.config/project-swarm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ a: 1 }));
    assert.equal(defaultConfigPath({ home, env: {} }), path.join(dir, 'config.json'));
    assert.deepEqual(loadLocalConfig({ home, env: {} }), { a: 1 });
  });

  test('an absolute XDG_CONFIG_HOME wins over ~/.config; a relative one is ignored', async t => {
    const home = await tmp(t, 'local-config-a1-xdg-home-');
    const dotConfigDir = path.join(home, '.config/project-swarm');
    await fs.mkdir(dotConfigDir, { recursive: true });
    await fs.writeFile(path.join(dotConfigDir, 'config.json'), JSON.stringify({ a: 1 }));

    const xdg = await tmp(t, 'local-config-a1-xdg-');
    const xdgDir = path.join(xdg, 'project-swarm');
    await fs.mkdir(xdgDir, { recursive: true });
    await fs.writeFile(path.join(xdgDir, 'config.json'), JSON.stringify({ b: 2 }));

    assert.equal(defaultConfigPath({ home, env: { XDG_CONFIG_HOME: xdg } }), path.join(xdgDir, 'config.json'));
    assert.deepEqual(loadLocalConfig({ home, env: { XDG_CONFIG_HOME: xdg } }), { b: 2 });
    // A relative XDG_CONFIG_HOME is not absolute: falls back to ~/.config.
    assert.deepEqual(loadLocalConfig({ home, env: { XDG_CONFIG_HOME: 'relative/dir' } }), { a: 1 });
  });

  test('SWARM_CONFIG wins over both defaults', async t => {
    const home = await tmp(t, 'local-config-a1-swarmconfig-home-');
    const dotConfigDir = path.join(home, '.config/project-swarm');
    await fs.mkdir(dotConfigDir, { recursive: true });
    await fs.writeFile(path.join(dotConfigDir, 'config.json'), JSON.stringify({ a: 1 }));
    const xdg = await tmp(t, 'local-config-a1-swarmconfig-xdg-');
    const explicit = path.join(home, 'explicit-config.json');
    await fs.writeFile(explicit, JSON.stringify({ c: 3 }));
    assert.deepEqual(loadLocalConfig({ home, env: { XDG_CONFIG_HOME: xdg, SWARM_CONFIG: explicit } }), { c: 3 });
  });
});

describe('A2: the old <home>/.project-swarm/config.json path is refused, never read', () => {
  test('a file left at the old path throws config-inside-install naming the new default', async t => {
    const home = await tmp(t, 'local-config-a2-');
    await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true });
    await fs.writeFile(path.join(home, '.project-swarm/config.json'), JSON.stringify({ shouldNeverBeRead: true }));
    assert.throws(
      () => loadLocalConfig({ home, env: {} }),
      new RegExp(`config-inside-install: ${escapeRegExp(path.join(home, '.project-swarm/config.json'))} sits in the install checkout; move it to ${escapeRegExp(defaultConfigPath({ home, env: {} }))}`),
    );
  });

  test('an explicit SWARM_CONFIG bypasses the old-path check entirely', async t => {
    const home = await tmp(t, 'local-config-a2-bypass-');
    await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true });
    await fs.writeFile(path.join(home, '.project-swarm/config.json'), JSON.stringify({ shouldNeverBeRead: true }));
    const explicit = path.join(home, 'explicit.json');
    await fs.writeFile(explicit, JSON.stringify({ ok: true }));
    assert.deepEqual(loadLocalConfig({ home, env: { SWARM_CONFIG: explicit } }), { ok: true });
  });
});

describe('A3: a resolved config file inside a git work tree is refused', () => {
  test('config-inside-repo names the file and the work tree top, from a fixture git repo in a mkdtemp dir', async t => {
    const repoDir = await tmp(t, 'local-config-a3-repo-');
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    const nested = path.join(repoDir, 'sub/dir');
    await fs.mkdir(nested, { recursive: true });
    const configFile = path.join(nested, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({}));
    const home = await tmp(t, 'local-config-a3-home-');
    assert.throws(
      () => loadLocalConfig({ home, env: { SWARM_CONFIG: configFile } }),
      new RegExp(`config-inside-repo: ${escapeRegExp(configFile)} is inside the git work tree ${escapeRegExp(repoDir)}`),
    );
  });

  test('a config file outside any git work tree is unaffected', async t => {
    const home = await tmp(t, 'local-config-a3-clean-home-');
    const configFile = path.join(home, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ ok: true }));
    assert.deepEqual(loadLocalConfig({ home, env: { SWARM_CONFIG: configFile } }), { ok: true });
  });
});

// ---------------------------------------------------------------------------------------------
// B1-B2: tools/ship.mjs private-names source order and path globs
// ---------------------------------------------------------------------------------------------

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

function diffFor(file, { removed = [], added = [], startLine = 1 } = {}) {
  const lines = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  lines.push(`@@ -1,${removed.length} +${startLine},${added.length} @@`);
  for (const text of removed) lines.push(`-${text}`);
  for (const text of added) lines.push(`+${text}`);
  return lines.join('\n');
}

// Command-matched fake exec: gh/git behave by which command was called, never by call order.
// `diffFiles`: the whole-diff file list (both the base diff and the staged diff share it here,
// since these tests never need to tell the two apart). `diffs`: per-file -U0 diff text, keyed by
// filename, for the text-term line scan.
function fakeExec({ visibility = 'PUBLIC', diffFiles = [], diffs = {}, baseSha = 'base-1' } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'rev-parse') return ok('sha-fixture\n');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'merge-base') return ok(`${baseSha}\n`);
    if (file === 'git' && args[0] === 'diff' && args[1] === '--name-only') return ok(diffFiles.join('\n'));
    if (file === 'git' && args[0] === 'diff') { const target = args.at(-1); return target in diffs ? ok(diffs[target]) : ok(''); }
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'repo' && args[1] === 'view') return ok(JSON.stringify({ visibility }));
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

async function shipWith(t, root, home, options) {
  return ship({
    root, repo: 'acme/widgets', payloadPath: await writePayload(root), merge: false,
    runChecks: async () => [], sleep: async () => {}, now: () => 0,
    home, env: { SWARM_HOME: path.join(home, '.project-swarm-logs'), PATH: '/usr/bin' },
    ...options,
  });
}

describe('B1: ship private-names source order includes the local config privateNames path', () => {
  test('used only when there is no root coordination/private-names.txt and no --private-names', async t => {
    const root = await tmp(t, 'cfg-privatenames-root-');
    const home = await tmp(t, 'cfg-privatenames-home-');
    const listFile = path.join(home, 'private-list.txt');
    await fs.writeFile(listFile, 'acmecorp\n');
    await fs.mkdir(path.join(home, '.config/project-swarm'), { recursive: true });
    await fs.writeFile(path.join(home, '.config/project-swarm/config.json'), JSON.stringify({ privateNames: listFile }));

    const { exec } = fakeExec({ diffs: { 'notes.txt': diffFor('notes.txt', { added: ['the acmecorp deal'], startLine: 1 }) } });
    const result = await shipWith(t, root, home, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.code, 'private-name-in-diff');
    assert.match(result.reason, /notes\.txt:1 \(acmecorp\)/);
  });

  test('a root coordination/private-names.txt still wins over the config path', async t => {
    const root = await tmp(t, 'cfg-privatenames-root-wins-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'rootterm\n');
    const home = await tmp(t, 'cfg-privatenames-root-wins-home-');
    const listFile = path.join(home, 'private-list.txt');
    await fs.writeFile(listFile, 'configterm\n');
    await fs.mkdir(path.join(home, '.config/project-swarm'), { recursive: true });
    await fs.writeFile(path.join(home, '.config/project-swarm/config.json'), JSON.stringify({ privateNames: listFile }));

    // The config term is in the diff; the root-list term is not. Passing proves the root file won.
    const { exec } = fakeExec({ diffs: { 'notes.txt': diffFor('notes.txt', { added: ['mentions configterm here'], startLine: 1 }) } });
    const result = await shipWith(t, root, home, { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
  });

  test('a config-named file that does not exist refuses private-names-missing', async t => {
    const root = await tmp(t, 'cfg-privatenames-missing-root-');
    const home = await tmp(t, 'cfg-privatenames-missing-home-');
    const missingFile = path.join(home, 'does-not-exist.txt');
    await fs.mkdir(path.join(home, '.config/project-swarm'), { recursive: true });
    await fs.writeFile(path.join(home, '.config/project-swarm/config.json'), JSON.stringify({ privateNames: missingFile }));

    const { exec } = fakeExec({});
    const result = await shipWith(t, root, home, { exec, integratedFiles: [] });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.reason, `private-names-missing: ${missingFile}`);
  });
});

describe('B2: path: lines are path globs, never text terms', () => {
  test('splitPrivateNameLines separates path: globs from plain text terms', () => {
    const { terms, pathGlobs } = splitPrivateNameLines(parsePrivateNames('acmecorp\npath:config.json\n# comment\npath:**/secret.txt\n'));
    assert.deepEqual(terms, ['acmecorp']);
    assert.deepEqual(pathGlobs, ['config.json', '**/secret.txt']);
  });

  test('pathGlobToRegExp: a bare name matches only at the repo root; ** crosses segments; * stays within one', () => {
    assert.ok(pathGlobToRegExp('config.json').test('config.json'));
    assert.equal(pathGlobToRegExp('config.json').test('sub/config.json'), false);
    assert.ok(pathGlobToRegExp('**/secret.txt').test('deep/one/two/secret.txt'));
    assert.ok(pathGlobToRegExp('sub/*.txt').test('sub/file.txt'));
    assert.equal(pathGlobToRegExp('sub/*.txt').test('sub/nested/file.txt'), false);
  });

  test('ship refuses path:config.json for config.json at the root, but ignores sub/config.json', async t => {
    const rootHit = await tmp(t, 'cfg-pathglob-root-hit-');
    await fs.mkdir(path.join(rootHit, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(rootHit, 'coordination/private-names.txt'), 'path:config.json\n');
    const { exec: hitExec } = fakeExec({ diffFiles: ['config.json'] });
    const hit = await shipWith(t, rootHit, await tmp(t, 'cfg-pathglob-root-hit-home-'), { exec: hitExec, integratedFiles: ['config.json'] });
    assert.equal(hit.status, 'refused', JSON.stringify(hit));
    assert.equal(hit.code, 'private-path-in-diff');
    assert.match(hit.reason, /config\.json matches path:config\.json/);

    const rootIgnored = await tmp(t, 'cfg-pathglob-root-ignored-');
    await fs.mkdir(path.join(rootIgnored, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(rootIgnored, 'coordination/private-names.txt'), 'path:config.json\n');
    const { exec: ignoredExec } = fakeExec({ diffFiles: ['sub/config.json'] });
    const ignored = await shipWith(t, rootIgnored, await tmp(t, 'cfg-pathglob-root-ignored-home-'), { exec: ignoredExec, integratedFiles: ['sub/config.json'] });
    assert.equal(ignored.status, 'ready', JSON.stringify(ignored));
  });

  test('ship refuses path:**/secret.txt for a nested match', async t => {
    const root = await tmp(t, 'cfg-pathglob-nested-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'path:**/secret.txt\n');
    const { exec } = fakeExec({ diffFiles: ['deep/one/two/secret.txt'] });
    const result = await shipWith(t, root, await tmp(t, 'cfg-pathglob-nested-home-'), { exec, integratedFiles: ['deep/one/two/secret.txt'] });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.code, 'private-path-in-diff');
    assert.match(result.reason, /deep\/one\/two\/secret\.txt matches path:\*\*\/secret\.txt/);
  });

  test('a path: line never matches as a text term against unrelated file content', async t => {
    const root = await tmp(t, 'cfg-pathglob-not-text-');
    await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
    await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'path:config.json\n');
    const { exec } = fakeExec({
      diffFiles: ['notes.txt'],
      diffs: { 'notes.txt': diffFor('notes.txt', { added: ['see config.json for details'], startLine: 1 }) },
    });
    const result = await shipWith(t, root, await tmp(t, 'cfg-pathglob-not-text-home-'), { exec, integratedFiles: ['notes.txt'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: true, hits: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// C: a scan of the tracked tree for the job's own private terms, driven only by local config
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function loadPrivateTermsOrSkip(t) {
  let config;
  try { config = loadLocalConfig({}); } catch { t.skip('local config could not be read; nothing to scan for'); return null; }
  if (!config?.privateNames) { t.skip('no local config privateNames file configured; nothing to scan for'); return null; }
  try {
    const text = await fs.readFile(config.privateNames, 'utf8');
    return parsePrivateNames(text);
  } catch {
    t.skip(`configured privateNames file ${config.privateNames} could not be read`);
    return null;
  }
}

test('C: the tracked tree has no whole-word, case-insensitive occurrence of a configured private term', async t => {
  const terms = await loadPrivateTermsOrSkip(t);
  if (!terms || !terms.length) return;
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const patterns = terms.map(term => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'));
  const hits = [];
  for (const file of files) {
    let text;
    try { text = await fs.readFile(path.join(REPO_ROOT, file), 'utf8'); } catch { continue; }
    terms.forEach((term, index) => { if (patterns[index].test(text)) hits.push(`${file}: ${term}`); });
  }
  assert.deepEqual(hits, []);
});

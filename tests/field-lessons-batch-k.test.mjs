// SPDX-License-Identifier: Apache-2.0
// Field lesson #179: `ship --branch` refused 1.23.0 with "test file spawns undocumented binary
// with no fake/skip seam: tests/swarm.test.mjs -> ps" — the `ps` calls were already on main; the
// branch only touched that file for another reason. The undocumented-binary/env-var test-file gate
// now judges only the lines a change ADDS to a test file (a call already on the base does not
// refuse), `ps` joins the documented POSIX binaries (macOS/Linux; Windows callers still need their
// own seam), and a repeatable `--exempt <guard>:<file>=<reason>` (owner decision, required) excuses
// one file from one guard — never other files, never other guards — logged to
// <installRoot>/logs/ship-exemptions.jsonl and written into the PR body's `## Exemptions` section.
// Field lesson #181: `resolveToolchainBin` used to pick a directory that merely shared a program's
// name (real case: ~/.project-swarm/toolchains/uv is the pip package directory, not the uv binary;
// the real binary is toolchains/bin/uv) because `fs.access(X_OK)` alone passes on directories too.
// A candidate now also has to be a regular file. A lock check that still fails to spawn no longer
// produces the empty reason "<name> failed: " this used to produce; it says
// "lock-check-cannot-run: <path> (<errno>)".
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ship, parseExemptFlag, EXEMPTION_GUARD_IDS, appendExemptionsSection,
  resolveToolchainBin, undocumentedBinaryWarnings, DOCUMENTED_TEST_BINARIES,
} from '../tools/ship.mjs';
import { parseShipFlags, parseGoFlags } from '../tools/swarm.mjs';

const execFileAsync = promisify(execFile);

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

async function writePayload(root, payload) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify(payload));
  return file;
}

// A command-matched fake exec, same shape as field-lessons-batch-j.test.mjs's own fakeShipExec:
// answers by which git/gh command was called, not by call order, and records every `input` so a
// test can inspect exactly what would have been sent to `gh api ... pulls`.
function fakeShipExec(handlers = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd, input: opts?.input });
    for (const handler of handlers.custom ?? []) {
      const result = handler(file, args, opts);
      if (result !== undefined) return result;
    }
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'rev-parse') return ok(`${handlers.sha ?? 'sha-fixture'}\n`);
    if (file === 'git' && args[0] === 'merge-base') return handlers.baseSha ? ok(`${handlers.baseSha}\n`) : fail('no base');
    if (file === 'git' && args[0] === 'diff') return (handlers.diff ?? (() => ok('')))(args);
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: handlers.sha ?? 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

// A unified `-U0` diff whose only `+` lines are the given ones; a real `git diff <base>...HEAD -U0`
// never includes unchanged context at -U0, so this is exactly the shape `readAddedTestFileLines`
// parses (it keeps `+` lines and drops the `+++ b/<file>` header).
function addedLinesDiff(file, addedLines) {
  const body = addedLines.map(line => `+${line}`).join('\n');
  return ok([
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,0 +2 @@',
    body,
    '',
  ].join('\n'));
}

// --- pre-fix proof infrastructure -----------------------------------------------------------
// tools/ship.mjs's only relative import is ./packaging-check.mjs (untouched by this fix); a
// scratch tools/ directory holding the pre-fix ship.mjs (from `git show <preFixSha>:tools/ship.mjs`
// — the commit this session started from, before lessons #179/#181) plus a copy of the current
// (identical) packaging-check.mjs, dynamically imported, is a real module: no stash, no checkout
// of a dirty path, nothing in the working tree touched.
const PRE_FIX_SHA = '3e4f4f6';

async function importPreFixShip(t) {
  const dir = await tmp(t, 'swarm-lessons-k-prefix-');
  await fs.mkdir(path.join(dir, 'tools'), { recursive: true });
  const { stdout } = await execFileAsync('git', ['show', `${PRE_FIX_SHA}:tools/ship.mjs`], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
  await fs.writeFile(path.join(dir, 'tools/ship.mjs'), stdout);
  await fs.copyFile(path.join(process.cwd(), 'tools/packaging-check.mjs'), path.join(dir, 'tools/packaging-check.mjs'));
  return import(pathToFileURL(path.join(dir, 'tools/ship.mjs')).href);
}

describe('L179: the test-file guard judges only lines this change ADDS to a test file', () => {
  test('a spawn call already on the base (untouched by this diff) does not refuse', async t => {
    const root = await tmp(t, 'swarm-lessons-k-onbase-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({
      baseSha: 'base-1',
      diff: args => addedLinesDiff(args.at(-1), ["const unrelated = 'no spawn call added here';"]),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['tests/swarm.test.mjs'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', `expected the pre-existing ps call to be ignored, got: ${JSON.stringify(result)}`);
  });

  test('a spawn call this diff itself ADDS still refuses, with a --exempt hint', async t => {
    const root = await tmp(t, 'swarm-lessons-k-added-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({
      baseSha: 'base-1',
      diff: args => addedLinesDiff(args.at(-1), ["execFileSync('lsof', ['-i']);"]),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['tests/swarm.test.mjs'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /lsof/);
    assert.match(result.reason, /--exempt <guard>:<file>=<reason>/);
  });

  test('ps is a documented POSIX binary and never refuses on its own', () => {
    assert.ok(DOCUMENTED_TEST_BINARIES.has('ps'));
    const files = new Map([['tests/a.test.mjs', "execFileSync('ps', ['aux']);"]]);
    assert.deepEqual(undocumentedBinaryWarnings(files), []);
  });
});

describe('L179: --exempt <guard>:<file>=<reason> excuses one file from one guard', () => {
  test('a valid exemption passes, appears in the result, is logged, and lands in the PR body\'s ## Exemptions section', async t => {
    const root = await tmp(t, 'swarm-lessons-k-exempt-');
    const logsDir = await tmp(t, 'swarm-lessons-k-logs-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: '## Summary\nchanged things' });
    const { exec, calls } = fakeShipExec({
      baseSha: 'base-1',
      diff: args => addedLinesDiff(args.at(-1), ["execFileSync('lsof', ['-i']);"]),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['tests/swarm.test.mjs'],
      exemptions: [{ guard: 'undocumented-binary', file: 'tests/swarm.test.mjs', reason: 'pre-existing ps call, POSIX only' }],
      env: { SWARM_LOGS_DIR: logsDir },
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', `expected the exemption to let ship proceed, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.exemptions, [{ guard: 'undocumented-binary', file: 'tests/swarm.test.mjs', reason: 'pre-existing ps call, POSIX only' }]);

    const logText = await fs.readFile(path.join(logsDir, 'ship-exemptions.jsonl'), 'utf8');
    const logLines = logText.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(logLines.length, 1);
    assert.equal(logLines[0].guard, 'undocumented-binary');
    assert.equal(logLines[0].file, 'tests/swarm.test.mjs');
    assert.equal(logLines[0].reason, 'pre-existing ps call, POSIX only');
    assert.equal(logLines[0].repo, 'acme/widgets');
    assert.ok(logLines[0].ts);

    const createCall = calls.find(c => c.file === 'gh' && c.args[0] === 'api' && c.args[1]?.endsWith('/pulls'));
    assert.ok(createCall, 'expected a PR create call');
    const sentBody = JSON.parse(createCall.input).body;
    assert.match(sentBody, /## Exemptions/);
    assert.match(sentBody, /- undocumented-binary · tests\/swarm\.test\.mjs — pre-existing ps call, POSIX only/);
  });

  test('an exemption with no reason, or a reason under 10 characters, refuses at parse time', () => {
    assert.throws(() => parseShipFlags(['--pr', 'x.json', '--exempt', 'undocumented-binary:tests/a.test.mjs=too short']), /exemption-needs-reason/);
    assert.throws(() => parseShipFlags(['--pr', 'x.json', '--exempt', 'undocumented-binary:tests/a.test.mjs=']), /exemption-needs-reason/);
    assert.throws(() => parseShipFlags(['--pr', 'x.json', '--exempt', 'undocumented-binary:tests/a.test.mjs']), /--exempt requires/, 'no "=" at all is a syntax error, not a reason-length error');
    assert.throws(() => parseGoFlags(['--exempt', 'env-var:tests/a.test.mjs=nah']), /exemption-needs-reason/);
  });

  test('an unknown guard id refuses at parse time, naming the valid ids', () => {
    assert.throws(() => parseShipFlags(['--pr', 'x.json', '--exempt', 'bogus-guard:tests/a.test.mjs=a perfectly good reason']), /unknown guard "bogus-guard"/);
    const parsed = parseExemptFlag('bogus-guard:tests/a.test.mjs=a perfectly good reason');
    assert.match(parsed.error, new RegExp(EXEMPTION_GUARD_IDS.join('|')));
  });

  test('an exemption that matches nothing warns unused-exemption and is not written into the PR body', async t => {
    const root = await tmp(t, 'swarm-lessons-k-unused-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: '## Summary\nnothing risky here' });
    const { exec, calls } = fakeShipExec({
      baseSha: 'base-1',
      diff: args => addedLinesDiff(args.at(-1), ['const totally_fine = 1;']),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['tests/swarm.test.mjs'],
      exemptions: [{ guard: 'env-var', file: 'tests/swarm.test.mjs', reason: 'nothing to excuse here really' }],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready');
    assert.ok(result.warnings.includes('unused-exemption: env-var:tests/swarm.test.mjs'));
    assert.equal(result.exemptions, undefined, 'an unused exemption must not appear in the result');
    const createCall = calls.find(c => c.file === 'gh' && c.args[0] === 'api' && c.args[1]?.endsWith('/pulls'));
    assert.ok(createCall);
    assert.doesNotMatch(JSON.parse(createCall.input).body, /## Exemptions/);
  });

  test('an exemption for file A does not skip file B, which still refuses', async t => {
    const root = await tmp(t, 'swarm-lessons-k-ab-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({
      baseSha: 'base-1',
      diff: args => {
        const file = args.at(-1);
        if (file === 'tests/a.test.mjs') return addedLinesDiff(file, ["execFileSync('lsof', []);"]);
        if (file === 'tests/b.test.mjs') return addedLinesDiff(file, ["execFileSync('nc', []);"]);
        return ok('');
      },
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['tests/a.test.mjs', 'tests/b.test.mjs'],
      exemptions: [{ guard: 'undocumented-binary', file: 'tests/a.test.mjs', reason: 'lsof already vetted here' }],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /tests\/b\.test\.mjs -> nc/);
    assert.doesNotMatch(result.reason, /tests\/a\.test\.mjs/);
    // Even though ship still refuses (over file B), file A's exemption was genuinely used and must
    // still be on the record.
    assert.deepEqual(result.exemptions, [{ guard: 'undocumented-binary', file: 'tests/a.test.mjs', reason: 'lsof already vetted here' }]);
  });
});

describe('appendExemptionsSection: appends to an existing "## Exemptions" section or creates one', () => {
  test('creates a fresh section at the end of the body when none exists', () => {
    const body = appendExemptionsSection('## Summary\nsome change', [{ guard: 'env-var', file: 'tests/a.test.mjs', reason: 'stubbed already elsewhere' }]);
    assert.match(body, /## Summary\nsome change\n\n## Exemptions\n- env-var · tests\/a\.test\.mjs — stubbed already elsewhere\n$/);
  });

  test('appends to an existing "## Exemptions" section instead of creating a second one', () => {
    const body = '## Exemptions\n- env-var · tests/a.test.mjs — already justified\n## Test plan\nran it';
    const result = appendExemptionsSection(body, [{ guard: 'undocumented-binary', file: 'tests/b.test.mjs', reason: 'lsof vetted separately' }]);
    assert.equal((result.match(/## Exemptions/g) ?? []).length, 1);
    assert.match(result, /- env-var · tests\/a\.test\.mjs — already justified\n- undocumented-binary · tests\/b\.test\.mjs — lsof vetted separately/);
    assert.match(result, /## Test plan\nran it/);
    assert.ok(result.indexOf('## Test plan') > result.indexOf('lsof vetted separately'), 'the new line must land inside the Exemptions section, before the next heading');
  });

  test('an empty exemptions list leaves the body untouched', () => {
    assert.equal(appendExemptionsSection('## Summary\nx', []), '## Summary\nx');
  });
});

describe('L181: resolveToolchainBin skips a directory sharing the program\'s own name', () => {
  test('a real directory named like the program at the toolchains root is skipped in favor of bin/<prog>', async t => {
    const toolchains = await tmp(t, 'swarm-lessons-k-toolchains-');
    // The pip-package-directory shape from the real incident: toolchains/uv/ is a directory (not
    // the binary), and the real binary sits at toolchains/bin/uv.
    await fs.mkdir(path.join(toolchains, 'uv', 'lib'), { recursive: true });
    await fs.mkdir(path.join(toolchains, 'bin'), { recursive: true });
    const realBin = path.join(toolchains, 'bin', 'uv');
    await fs.writeFile(realBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const resolved = await resolveToolchainBin('uv', { env: { SWARM_TOOLCHAINS: toolchains, PATH: '' } });
    assert.equal(resolved.path, realBin, `expected the real binary, got: ${JSON.stringify(resolved)}`);
  });

  test('with no bin/ binary either, a same-named directory is reported not found (never returned as the path)', async t => {
    const toolchains = await tmp(t, 'swarm-lessons-k-toolchains-nobin-');
    await fs.mkdir(path.join(toolchains, 'uv'), { recursive: true });
    const resolved = await resolveToolchainBin('uv', { env: { SWARM_TOOLCHAINS: toolchains, PATH: '' } });
    assert.equal(resolved.path, null);
    assert.ok(resolved.tried.includes(path.join(toolchains, 'uv')));
  });
});

describe('L181: a lock check that fails to spawn never produces an empty reason', () => {
  test('ship: a spawnError from exec becomes lock-check-cannot-run: <path> (<errno>), never an empty "<name> failed: "', async t => {
    const root = await tmp(t, 'swarm-lessons-k-spawnerr-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({
      custom: [(file, args) => (file === 'npm' && args[0] === 'ci' ? { code: 1, stdout: '', stderr: '', spawnError: 'EISDIR' } : undefined)],
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['package.json'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'lock-check-cannot-run: npm (EISDIR)');
    assert.notEqual(result.reason.trim(), 'npm-lock-check failed:');
  });
});

describe('L179/L181: proof these are real regressions — the pre-fix module fails these exact assertions', () => {
  test('pre-fix ship.mjs does not have `ps` documented, and refuses on the pre-existing (already-on-base) spawn call', async t => {
    const preFix = await importPreFixShip(t);
    assert.equal(preFix.DOCUMENTED_TEST_BINARIES.has('ps'), false, 'pre-fix DOCUMENTED_TEST_BINARIES must not already have ps (else this is not a real regression test)');

    const root = await tmp(t, 'swarm-lessons-k-prefix-onbase-');
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    // Pre-fix scanned the file's whole current content (no diff at all), so it refuses even though
    // this call is meant to represent one already present on the base, untouched by this change.
    await fs.writeFile(path.join(root, 'tests/swarm.test.mjs'), "execFileSync('ps', ['aux']);\n");
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({ baseSha: 'base-1' });
    const result = await preFix.ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['tests/swarm.test.mjs'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'refused', 'pre-fix code must reproduce the real #179 bug: refusing on a call already on the base');
    assert.match(result.reason, /ps/);
  });

  test('pre-fix ship.mjs has no --exempt/exemptions support at all', async t => {
    const preFix = await importPreFixShip(t);
    const root = await tmp(t, 'swarm-lessons-k-prefix-exempt-');
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'tests/swarm.test.mjs'), "execFileSync('lsof', ['-i']);\n");
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({ baseSha: 'base-1' });
    const result = await preFix.ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['tests/swarm.test.mjs'],
      exemptions: [{ guard: 'undocumented-binary', file: 'tests/swarm.test.mjs', reason: 'pre-existing ps call, POSIX only' }],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'refused', 'pre-fix ship() must ignore an exemptions option entirely and still refuse');
    assert.equal(result.exemptions, undefined);
    assert.doesNotMatch(result.reason, /--exempt/);
  });

  // --exempt itself is a brand-new flag (parseShipFlags/parseGoFlags did not recognize it at all
  // before this change), so its own newness needs no elaborate red-run proof — same convention
  // this repo already uses for brand-new flags (see the "before the fix, ship has no
  // --checks-from-ci flag at all" comment in field-lessons-batch-j.test.mjs). A plain diff of
  // tools/swarm.mjs at PRE_FIX_SHA confirms `--exempt` is absent from SHIP_FLAGS_WITH_VALUE.
  test('proof: --exempt is entirely new — absent from the pre-fix SHIP_FLAGS_WITH_VALUE set', async () => {
    const { stdout } = await execFileAsync('git', ['show', `${PRE_FIX_SHA}:tools/swarm.mjs`], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
    const match = stdout.match(/const SHIP_FLAGS_WITH_VALUE = new Set\(\[([^\]]*)\]\)/);
    assert.ok(match, 'expected to find the pre-fix SHIP_FLAGS_WITH_VALUE declaration');
    assert.doesNotMatch(match[1], /--exempt/);
  });

  test('pre-fix resolveToolchainBin picks a directory that shares the program\'s name over the real bin/<prog> binary', async t => {
    const preFix = await importPreFixShip(t);
    const toolchains = await tmp(t, 'swarm-lessons-k-prefix-toolchains-');
    await fs.mkdir(path.join(toolchains, 'uv', 'lib'), { recursive: true });
    await fs.mkdir(path.join(toolchains, 'bin'), { recursive: true });
    await fs.writeFile(path.join(toolchains, 'bin', 'uv'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const resolved = await preFix.resolveToolchainBin('uv', { env: { SWARM_TOOLCHAINS: toolchains, PATH: '' } });
    assert.equal(resolved.path, path.join(toolchains, 'uv'), 'pre-fix code must reproduce the real #181 bug: picking the directory');
  });

  test('pre-fix ship.mjs produces the empty "<name> failed: " reason on a spawn failure, ignoring spawnError', async t => {
    const preFix = await importPreFixShip(t);
    const root = await tmp(t, 'swarm-lessons-k-prefix-spawnerr-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({
      custom: [(file, args) => (file === 'npm' && args[0] === 'ci' ? { code: 1, stdout: '', stderr: '', spawnError: 'EISDIR' } : undefined)],
    });
    const result = await preFix.ship({
      root, repo: 'acme/widgets', payloadPath, merge: false,
      runChecks: async () => [], integratedFiles: ['package.json'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason.trim(), 'npm-lock-check failed:', 'pre-fix code must reproduce the real #181 bug: an empty reason');
  });
});

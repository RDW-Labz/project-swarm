// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMANDS, PROVIDERS, zshCompletion, completeRuns } from '../tools/completion.mjs';

test('command metadata covers the Usage line without duplicates', async () => {
  const source = await fs.readFile(new URL('../tools/swarm.mjs', import.meta.url), 'utf8');
  const usage = source.match(/\\nUsage: node tools\/swarm\.mjs (.*?)\\n/)[1];
  const names = [...usage.matchAll(/(?:\[--root PROJECT\] | \| )([a-z][a-z-]*)(?= |$)/g)].map(match => match[1]);
  assert.ok(names.length > 25);
  const actual = COMMANDS.map(command => command.name);
  assert.equal(new Set(actual).size, actual.length);
  for (const name of names) assert.ok(actual.includes(name), `Missing ${name}`);
  for (const entry of COMMANDS) {
    assert.ok(names.includes(entry.name) || ['completion', 'help', 'ticket', 'scaffold', 'resume', 'ledger', 'idle'].includes(entry.name), entry.name);
    assert.ok(['run', 'manifest', 'provider', 'goal', 'none'].includes(entry.args));
    assert.ok(entry.summary.length > 0);
    assert.equal(new Set(entry.flags).size, entry.flags.length);
    for (const flag of entry.flags) assert.match(flag, /^--[a-z][a-z-]*$/);
  }
  assert.deepEqual(PROVIDERS, usage.match(/doctor \[([^\]]+)\]/)[1].split('|'));
});

test('completion script includes commands, flags and dynamic argument completion', () => {
  const script = zshCompletion();
  assert.ok(script.startsWith('#compdef swarm\n'));
  assert.ok(script.includes('_describe'));
  assert.ok(script.includes('swarm __complete runs "${roots[@]}"'));
  assert.ok(script.includes("_files -g '*.json'"));
  for (const { name, flags } of COMMANDS) {
    assert.ok(script.includes(`'${name}:`), name);
    for (const flag of flags) assert.ok(script.includes(`'${flag}'`), flag);
  }
});

test('completeRuns reads directories in newest-first order and caps results', async () => {
  const entries = Array.from({ length: 220 }, (_, index) => ({
    name: `${1700000000000 + index}-run`, isDirectory: () => true,
  }));
  entries.splice(50, 0, { name: '9999999999999-file', isDirectory: () => false });
  const result = await completeRuns('/project', { readdir: async (directory, options) => {
    assert.equal(directory, path.join('/project', '.swarm', 'runs'));
    assert.deepEqual(options, { withFileTypes: true });
    return entries;
  } });
  assert.deepEqual(result, entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse().slice(0, 200));
  assert.equal(result.length, 200);
  assert.equal(result[0], '1700000000219-run');
});

test('completeRuns handles missing directories and propagates other errors', async () => {
  assert.deepEqual(await completeRuns('/missing', { readdir: async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  } }), []);
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(completeRuns('/denied', { readdir: async () => { throw denied; } }), error => error === denied);
});

test('completeRuns uses the filesystem by default', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-completion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await completeRuns(root), []);
  await fs.mkdir(path.join(root, '.swarm', 'runs', '1700000000001-run'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', '1700000000002-file'), '');
  assert.deepEqual(await completeRuns(root), ['1700000000001-run']);
});

test('zsh accepts the generated completion syntax', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-completion-zsh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, '_swarm');
  await fs.writeFile(file, zshCompletion());
  const result = spawnSync('zsh', ['-n', file], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  if (result.error?.code === 'ENOENT') return t.skip('zsh is not installed');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('zsh run completion forwards the selected root and preserves run order', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-completion-shell-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [words, current, expected] of [
    ["words=(swarm status '')", 3, '<__complete><runs>'],
    ["words=(swarm --root '/project with spaces' inspect '')", 5, '<__complete><runs><--root></project with spaces>'],
    ["words=(swarm --root=/project wait '')", 4, '<__complete><runs><--root></project>'],
  ]) {
    const script = `
swarm() { printf '<%s>' "$@" >&2; printf '1700000000002-run\\n1700000000001-run\\n'; }
compadd() { print -rl -- "\${runs[@]}"; }
${words}
CURRENT=${current}
${zshCompletion()}`;
    const result = spawnSync('zsh', ['-f', '-c', script], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    if (result.error?.code === 'ENOENT') return t.skip('zsh is not installed');
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout, '1700000000002-run\n1700000000001-run\n');
    // Expose the mock command's stderr to verify argument boundaries.
    const visible = script.replace('2>/dev/null', '');
    const traced = spawnSync('zsh', ['-f', '-c', visible], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    assert.equal(traced.status, 0, traced.stderr);
    assert.equal(traced.stderr, expected);
  }
});

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { analyzeShell } from '../tools/shell-writes.mjs';

const root = '/p';
const a = c => analyzeShell(c, { root, cwd: root, home: '/Users/someone', protectedAbs: [path.join('/Users/someone', '.claude')] });

test('1 find -exec and -delete are independent actions', () => {
  const r = a('find src -exec true ; -delete');
  assert.equal(r.unknown, false);
  assert.ok(r.writes.includes('src') || r.writes.some(w => w.startsWith('src')));
});

test('2 each find -exec action is analyzed on its own', () => {
  const r = a('find . -exec true ; -exec rm -rf src ;');
  assert.ok(r.writes.includes('src'));
});

test('3 rm glob under src inside the project is unknown', () => {
  assert.equal(a('rm -rf src/*').unknown, true);
});

test('4 rm glob at project root is unknown', () => {
  assert.equal(a('rm -rf *').unknown, true);
});

test('5 rm glob outside adds outsideDeletes prefix', () => {
  const r = a('rm -rf /tmp/scratch/*');
  assert.equal(r.unknown, false);
  assert.ok(r.outsideDeletes.some(p => p.startsWith('/tmp/scratch')));
});

test('6 ansi-c quoting keeps semicolon inside the word', () => {
  const r = a("echo $'it\\'s ok; rm -rf .swarm/runs'");
  assert.equal(r.unknown, false);
  assert.deepEqual(r.writes, []);
});

test('7 dollar-quote git is the git command', () => {
  const r = a("$'git' push --force origin main");
  assert.equal(r.ops[0]?.tool, 'git');
  assert.equal(r.ops[0]?.sub, 'push');
  assert.equal(r.ops[0]?.force, true);
});

test('8 git push records two refspecs', () => {
  const r = a('git push origin feature main');
  assert.equal(r.ops[0].positionals, 3);
  assert.equal(r.ops[0].refspecs.length, 2);
  assert.deepEqual(r.ops[0].refspecs.map(x => x.dst), ['feature', 'main']);
});

test('9 git push delete refspec and branch word', () => {
  const r = a('git push origin :main x');
  assert.equal(r.ops[0].refspecs[0].delete, true);
  assert.equal(r.ops[0].refspecs[0].dst, 'main');
  assert.equal(r.ops[0].refspecs[1].dst, 'x');
});

test('10 git push --mirror sets delete on the op', () => {
  assert.equal(a('git push --mirror origin').ops[0].delete, true);
});

test('11 git --config-env marks hasConfig', () => {
  assert.equal(a('git --config-env core.hooksPath=V push').ops[0].hasConfig, true);
});

test('12 git fetch upload-pack form marks hasConfig', () => {
  assert.equal(a('git fetch --upload-pack=x .').ops[0].hasConfig, true);
});

test('13 ln -s adds the link path to writes', () => {
  assert.deepEqual(a('ln -s ../../tools/guard.mjs coordination/manifests/g.json').writes, ['coordination/manifests/g.json']);
});

test('14 variable command word is dynamic', () => {
  const r = a('a=rm; $a -rf src');
  assert.equal(r.dynamic, true);
  assert.equal(r.unknown, true);
});

test('15 eval is dynamic', () => {
  const r = a('eval "echo hi"');
  assert.equal(r.dynamic, true);
  assert.equal(r.unknown, true);
});

test('16 pipe into sh is dynamic', () => {
  const r = a('echo x | sh');
  assert.equal(r.dynamic, true);
  assert.equal(r.unknown, true);
});

test('17 base64 decode piped to sh is dynamic', () => {
  const r = a('echo Zm9v | base64 -d | sh');
  assert.equal(r.dynamic, true);
  assert.equal(r.unknown, true);
});

test('18 bash -c with decode substitution is dynamic', () => {
  const r = a('bash -c "$(echo Zm9v | base64 -d)"');
  assert.equal(r.dynamic, true);
  assert.equal(r.unknown, true);
});

test('no false positive: git commit -m with backtick and dollar in double quotes', () => {
  const r = a('git commit -m "fix `x` for $HOME"');
  assert.equal(r.dynamic, false);
  assert.equal(r.unknown, false);
});

test('no false positive: echo with a variable argument', () => {
  const r = a('echo $VAR');
  assert.equal(r.dynamic, false);
  assert.equal(r.unknown, false);
});

test('no false positive: cat with a substitution argument', () => {
  const r = a('cat $(echo f)');
  assert.equal(r.dynamic, false);
  assert.equal(r.unknown, false);
});

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeShell, tokenize } from '../tools/shell-writes.mjs';

const root = '/p';
const a = c => analyzeShell(c, { root, cwd: root });

test('quoted expansions and > in arguments are not writes and not unknown', () => {
  for (const cmd of [
    'git commit -m "fix `x` for $HOME > y"',
    "echo 'a > b'",
    'gh pr create --body "uses `foo` and $BAR"',
    'printf "%s" "line with $VAR and `tick`"',
  ]) {
    const r = a(cmd);
    assert.deepEqual(r.writes, [], cmd);
    assert.equal(r.unknown, false, cmd);
  }
});

test('real redirects and expansion targets are still reported', () => {
  assert.deepEqual(a('echo hi > src/out.ts').writes, ['src/out.ts']);
  assert.equal(a('echo hi > "$X"').unknown, true);
  assert.equal(a('echo a > $FILE').unknown, true);
});

test('tokenizer records per-word expansion inside double quotes', () => {
  const [words] = tokenize('git commit -m "has $HOME"');
  assert.equal(words.expands[words.indexOf('has $HOME')], true);
  const [w2] = tokenize("echo 'literal $HOME'");
  assert.equal(w2.expands[w2.indexOf('literal $HOME')], false);
});

test('ansi-c dollar-quote is one word; backslash escapes a quote', () => {
  const [words] = tokenize("echo $'it\\'s; rm -rf x'");
  assert.equal(words[1], "it's; rm -rf x");
  assert.equal(words.expands[1], false);
  const tok = tokenize("echo $'git'");
  assert.equal(tok[0][1], 'git');
});

const op = (extra, base) => ({ args: [], globalOpts: false, hasConfig: false, ...base, ...extra });

test('ops describe git, gh, vercel, and swarm commands', () => {
  assert.deepEqual(a('git push --force origin x').ops[0], op({ args: ['origin', 'x'], positionals: 2, refspecs: [{ src: null, dst: 'x', force: false, delete: false }] }, { tool: 'git', sub: 'push', flags: ['--force'], branch: 'x', force: true, delete: null }));
  assert.deepEqual(a('git push origin main').ops[0], op({ args: ['origin', 'main'], positionals: 2, refspecs: [{ src: null, dst: 'main', force: false, delete: false }] }, { tool: 'git', sub: 'push', flags: [], branch: 'main', force: false, delete: null }));
  assert.deepEqual(a('git push origin HEAD:refs/heads/feat').ops[0], op({ args: ['origin', 'HEAD:refs/heads/feat'], positionals: 2, refspecs: [{ src: 'HEAD', dst: 'feat', force: false, delete: false }] }, { tool: 'git', sub: 'push', flags: [], branch: 'feat', force: false, delete: null }));
  assert.deepEqual(a('git branch -d a').ops[0], op({ args: [] }, { tool: 'git', sub: 'branch', flags: ['-d'], branch: 'a', force: false, delete: 'safe' }));
  assert.deepEqual(a('git branch -D a').ops[0], op({ args: [] }, { tool: 'git', sub: 'branch', flags: ['-D'], branch: 'a', force: false, delete: 'force' }));
  assert.deepEqual(a('git commit -m x').ops[0], op({ args: ['x'] }, { tool: 'git', sub: 'commit', flags: ['-m'], branch: null, force: false, delete: null }));
  assert.deepEqual(a('git fetch').ops[0], op({}, { tool: 'git', sub: 'fetch', flags: [], branch: null, force: false, delete: null }));
  assert.deepEqual(a('git rebase origin/main').ops[0], op({ args: ['origin/main'] }, { tool: 'git', sub: 'rebase', flags: [], branch: 'origin/main', force: false, delete: null }));
  assert.deepEqual(a('gh pr create --title t').ops[0], op({ args: ['t'] }, { tool: 'gh', sub: 'pr create', flags: ['--title'], branch: null, force: false, delete: null, target: null }));
  assert.deepEqual(a('gh pr merge 5').ops[0], op({ args: [] }, { tool: 'gh', sub: 'pr merge', flags: [], branch: null, force: false, delete: null, target: '5' }));
  assert.deepEqual(a('gh pr checks 5').ops[0], op({ args: ['5'] }, { tool: 'gh', sub: 'pr checks', flags: [], branch: null, force: false, delete: null, target: null }));
  assert.deepEqual(a('gh run watch 1').ops[0], op({ args: ['1'] }, { tool: 'gh', sub: 'run watch', flags: [], branch: null, force: false, delete: null, target: null }));
  assert.deepEqual(a('vercel --prod').ops[0], op({ args: [], globalOpts: true }, { tool: 'vercel', sub: 'deploy', flags: ['--prod'], branch: null, force: false, delete: null }));
  assert.deepEqual(a('swarm merge 5').ops[0], op({ args: [] }, { tool: 'swarm', sub: 'merge', flags: [], branch: null, force: false, delete: null, target: '5' }));
  assert.equal(a('swarm tickets T-1 --set done').ops[0].sub, 'tickets');
});

// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commandLikeGoal, commandLikeMessage } from '../tools/goal-guard.mjs';
import { approveRun } from '../tools/plan-commands.mjs';

const SWARM = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'goal-guard-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const run = (args, { env }) => new Promise(resolve => execFile(process.execPath, [SWARM, ...args], { env, timeout: 60000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));

async function repo(t) {
  const base = await tmp(t);
  const root = path.join(base, 'repo'), home = path.join(base, 'home');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export {}\n');
  await fs.writeFile(path.join(root, 'docs/a.md'), 'x\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm\n.project-swarm.json\n');
  await fs.writeFile(path.join(home, 'config.json'), '{}');
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=n', ...a], { stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  const spendDir = path.join(home, 'spend');
  const env = { ...process.env, HOME: home, SWARM_CONFIG: path.join(home, 'config.json'), SWARM_SPEND_DIR: spendDir, SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_HISTORY_FILE: path.join(home, 'h.ndjson') };
  const nothingRan = async () => {
    await assert.rejects(fs.access(path.join(root, '.swarm/runs')), 'no run directory was made');
    const spent = await fs.readdir(spendDir).catch(() => []);
    assert.deepEqual(spent, [], 'no spend was recorded');
  };
  return { root, env, nothingRan };
}

test('what looks like a command: a --flag anywhere, or a known subcommand starting a short sentence; real goals that merely start with a verb are goals', () => {
  for (const bad of ['status --json', 'status', 'doctor all', 'watch --all', 'decide logo blue', 'phone sync', 'do the thing --max-usd 5', 'go --yes', 'quote scope.md', 'time log 2']) assert.ok(commandLikeGoal(bad), bad);
  for (const good of ['Add a dealer login page with email links', 'plan the dealer portal', 'run the migration checks', 'fix the status page', 'update the footer text for dealers', 'Build a quote request form', 'make the board show a count']) assert.equal(commandLikeGoal(good), null, good);
  assert.equal(commandLikeGoal('do the thing --max-usd 5').suggestion, 'swarm go "do the thing" --max-usd 5', 'flags belong outside the quotes');
  assert.equal(commandLikeGoal('status --json').suggestion, 'swarm status --json');
  assert.match(commandLikeMessage('doctor all'), /Did you mean: swarm doctor all\?/);
  assert.equal(commandLikeMessage('Add a login page'), null);
  assert.equal(commandLikeGoal(''), null);
});

test('swarm "status --json" is refused with "Did you mean", before any plan: no run directory, no spend; the same through swarm go and with a flag inside the quotes', async t => {
  const r = await repo(t);
  for (const args of [['--root', r.root, 'status --json'], ['--root', r.root, 'go', 'status --json'], ['--root', r.root, 'go', 'make it nice --yes'], ['--root', r.root, 'doctor all']]) {
    const res = await run(args, r);
    assert.notEqual(res.code, 0, args.join(' '));
    assert.match(res.stdout + res.stderr, /Did you mean: swarm /, args.join(' '));
    assert.doesNotMatch(res.stdout + res.stderr, /Goal: |Budget: |plan: plan-/, 'nothing was planned');
  }
  await r.nothingRan();
});

test('a normal goal shows its capped cost and does NOT run without an answer: with no terminal it is cancelled; --yes alone without --max-usd is refused too', async t => {
  const r = await repo(t);
  const res = await run(['--root', r.root, 'Add a dealer login page with email links'], r);
  assert.match(res.stderr, /Budget: \$5\.00, 2000000 tokens/);
  assert.match(res.stdout, /"status":"cancelled".*no terminal to ask on/);
  assert.notEqual(res.code, 0);
  await r.nothingRan();
  const yes = await run(['--root', r.root, 'go', 'Add a dealer login page with email links', '--yes'], r);
  assert.match(yes.stdout + yes.stderr, /an unattended run needs --yes with --max-usd/);
  await r.nothingRan();
});

test('the question names the cap and only y or yes runs it; --yes skips the question; no terminal means no run', async () => {
  const asked = [];
  const answer = text => async question => { asked.push(question); return text; };
  assert.deepEqual(await approveRun({ interactive: true, capUsd: 5, ask: answer('y') }), { approved: true });
  assert.equal(asked[0], 'Run, spending at most $5.00 (the cap)? [y/N] ');
  assert.equal((await approveRun({ interactive: true, capUsd: 5, ask: answer('yes') })).approved, true);
  for (const no of ['', 'n', 'no', 'sure', 'Y please']) assert.equal((await approveRun({ interactive: true, capUsd: 5, ask: answer(no) })).approved, no === 'Y please' ? false : false, no);
  assert.deepEqual(await approveRun({ interactive: true, capUsd: 5, ask: answer('n') }), { approved: false, code: 'plan-declined', reason: 'not approved' });
  assert.match((await approveRun({ interactive: true, ask: answer('') })).code, /plan-declined/);
  asked.length = 0;
  await approveRun({ interactive: true, ask: answer('n') });
  assert.equal(asked[0], 'Run, with NO dollar cap? [y/N] ');
  const skipped = [];
  assert.equal((await approveRun({ yes: true, interactive: true, ask: async q => { skipped.push(q); return 'n'; } })).approved, true);
  assert.deepEqual(skipped, [], '--yes asks nothing');
  assert.equal((await approveRun({ interactive: false, ask: answer('y') })).code, 'plan-approval-required');
});

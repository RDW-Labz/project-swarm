// SPDX-License-Identifier: Apache-2.0
// bot-fleet#84: ready on open — local tests and an Opus self-review must pass before a swarm
// ship opens a PR. Failed tests and HIGH findings block pr create; MEDIUM findings become
// issues; the opened PR comments which tests ran and that the self-review passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ship, SHIP_USAGE } from '../tools/ship.mjs';
import { shipRun, shipBranch, parseShipFlags, runManifest, integrateRun, shipExitCode } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';
import {
  SELF_REVIEW_LANES, READY_ON_OPEN_NOT_OFFICIAL, passingSelfReview, testsRanLine,
  normalizeSeverity, parseSelfReviewText, decideSelfReview, selfReviewPrompt,
  readyOnOpenComment, followupIssuePayload, collectShipDiff, defaultRunSelfReview,
  defaultPostReadyNote, defaultFileFollowups,
} from '../tools/ship-ready.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ship-ready-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writePayload(root, extra = {}) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify({
    title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text', ...extra,
  }));
  return file;
}

function makeExec(script) {
  const calls = [];
  let index = 0;
  const exec = async (file, args, opts) => {
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'merge-base') return fail('no package');
    calls.push({ file, args, opts });
    if (index >= script.length) throw new Error(`Unexpected exec call #${index + 1}: ${file} ${args.join(' ')}`);
    const entry = script[index++];
    return typeof entry === 'function' ? entry(file, args, opts) : entry;
  };
  return { exec, calls };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr: '' });
const clean = () => ok('');
const rev = sha => ok(`${sha}\n`);
const prJson = (overrides = {}) => JSON.stringify({ number: 7, html_url: 'https://example.com/pr/7', ...overrides });
const rollupView = (overrides = {}) => JSON.stringify({
  state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [], ...overrides,
});

function greenScript() {
  return [
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
  ];
}

function baseOptions(root, payloadPath, overrides = {}) {
  return {
    root, repo: 'acme/widgets', payloadPath,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {},
    now: () => 0,
    merge: false,
    ciLocal: false,
    ...overrides,
  };
}

test('SHIP_USAGE names the ready-on-open self-review gate', () => {
  assert.match(SHIP_USAGE, /Ready on open/);
  assert.match(SHIP_USAGE, /HIGH findings block/);
});

test('self-review lanes are DeepSeek/OpenRouter first, Cursor plan fallback, never Anthropic', () => {
  assert.deepEqual(SELF_REVIEW_LANES.map(lane => `${lane.lane}:${lane.model}`), [
    'openrouter:deepseek/deepseek-v4.1-flash',
    'openrouter:deepseek/deepseek-chat',
    'cursor:composer-2.5',
  ]);
  assert.ok(SELF_REVIEW_LANES.every(lane => !String(lane.model).startsWith('anthropic/')));
  assert.equal(SELF_REVIEW_LANES[0].lane, 'openrouter');
  assert.equal(SELF_REVIEW_LANES.at(-1).lane, 'cursor');
});

test('unknown severity is treated as HIGH; empty/missing review text does not parse', () => {
  assert.equal(normalizeSeverity('HIGH'), 'high');
  assert.equal(normalizeSeverity('medium'), 'medium');
  assert.equal(normalizeSeverity('low'), 'low');
  assert.equal(normalizeSeverity('critical'), 'high');
  assert.equal(normalizeSeverity(''), 'high');
  assert.equal(normalizeSeverity(undefined), 'high');
  assert.equal(parseSelfReviewText('not json'), null);
  assert.equal(parseSelfReviewText(''), null);
});

test('parseSelfReviewText accepts a trailing JSON line and a fenced block', () => {
  assert.deepEqual(parseSelfReviewText('notes\n{"findings":[{"file":"a.js","severity":"low","issue":"nits"}]}\n'), {
    findings: [{ file: 'a.js', severity: 'low', issue: 'nits' }],
  });
  assert.deepEqual(parseSelfReviewText('```json\n{"findings":[]}\n```'), { findings: [] });
});

test('decideSelfReview: HIGH blocks; unknown severity is HIGH; MEDIUM is not a blocker; missing result is unavailable', () => {
  const high = decideSelfReview({ findings: [{ file: 'auth.js', line: 4, severity: 'high', issue: 'auth bypass' }] });
  assert.equal(high.ok, false);
  assert.equal(high.code, 'self-review-high');
  assert.match(high.reason, /auth bypass/);
  const unknown = decideSelfReview({ findings: [{ file: 'x.js', severity: 'nope', issue: 'mystery' }] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'self-review-high');
  const medium = decideSelfReview({ findings: [{ file: 'x.js', severity: 'medium', issue: 'rename' }] });
  assert.equal(medium.ok, true);
  assert.equal(medium.medium.length, 1);
  assert.equal(medium.high.length, 0);
  const missing = decideSelfReview(null);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'self-review-unavailable');
  const empty = decideSelfReview({ findings: [] });
  assert.equal(empty.ok, true);
});

test('ready-on-open comment names tests, the passing self-review, and that it is not the official grader', () => {
  const body = readyOnOpenComment({
    checks: [{ name: 'unit', status: 'passed' }],
    review: { model: 'deepseek/deepseek-v4.1-flash', lane: 'openrouter' },
    issues: [{ number: 12 }],
  });
  assert.match(body, /Tests: unit \(passed\)/);
  assert.match(body, /Opus self-review: passed \(openrouter \/ deepseek\/deepseek-v4\.1-flash\)/);
  assert.match(body, /#12/);
  assert.match(body, new RegExp(READY_ON_OPEN_NOT_OFFICIAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(testsRanLine([]), 'none declared');
});

test('MEDIUM follow-up issues carry no labels (not agent:build, not a merge blocker)', () => {
  const payload = followupIssuePayload({
    finding: { file: 'src/a.js', line: 3, issue: 'rename helper', fix: 'extract' },
    pr: 7, url: 'https://example.com/pr/7',
  });
  assert.equal(payload.labels, undefined);
  assert.match(payload.title, /MEDIUM/);
  assert.match(payload.body, /not a merge blocker/);
  assert.match(payload.body, /src\/a\.js:3/);
});

test('defaultRunSelfReview tries DeepSeek first and stops on the first usable JSON', async () => {
  const seen = [];
  const result = await defaultRunSelfReview({
    exec: async () => ({ code: 0, stdout: 'diff --git a/a.js b/a.js\n' }),
    payload: { base: 'main' },
    integratedFiles: ['a.js'],
    chat: async lane => {
      seen.push(`${lane.lane}:${lane.model}`);
      return '{"findings":[]}';
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['openrouter:deepseek/deepseek-v4.1-flash']);
  assert.equal(result.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(result.lane, 'openrouter');
});

test('defaultRunSelfReview falls through unusable lanes and HIGH findings from a later lane still block', async () => {
  const seen = [];
  const result = await defaultRunSelfReview({
    exec: async () => ({ code: 0, stdout: 'diff' }),
    payload: { base: 'main' },
    chat: async lane => {
      seen.push(lane.model);
      if (lane.model.includes('flash')) throw new Error('flash down');
      if (lane.model.includes('chat')) return 'not json';
      return '{"findings":[{"file":"a.js","severity":"high","issue":"leak"}]}';
    },
  });
  assert.deepEqual(seen, ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-chat', 'composer-2.5']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'self-review-high');
  assert.match(result.reason, /leak/);
});

test('defaultRunSelfReview is unavailable when no lane answers', async () => {
  const result = await defaultRunSelfReview({
    exec: async () => ({ code: 0, stdout: 'diff' }),
    payload: { base: 'main' },
    chat: async () => { throw new Error('offline'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'self-review-unavailable');
});

test('collectShipDiff tries origin/base then base, and fails closed', async () => {
  const specs = [];
  const okDiff = await collectShipDiff(async (_file, args) => {
    specs.push(args[1]);
    if (args[1].startsWith('origin/')) return { code: 1, stdout: '', stderr: 'no origin' };
    return { code: 0, stdout: 'the-diff' };
  }, '/repo', 'main');
  assert.equal(okDiff.ok, true);
  assert.equal(okDiff.diff, 'the-diff');
  assert.deepEqual(specs, ['origin/main...HEAD', 'main...HEAD']);
  const bad = await collectShipDiff(async () => ({ code: 1, stdout: '', stderr: 'boom' }), '/repo', 'main');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /self-review-unavailable/);
});

test('selfReviewPrompt names HIGH as the PR-create blocker', () => {
  const text = selfReviewPrompt({ diff: 'diff', files: ['a.js'] });
  assert.match(text, /HIGH includes/);
  assert.match(text, /blocks opening the PR/);
  assert.match(text, /a\.js/);
});

test('ship: failed tests never call self-review and never push', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root);
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  let reviewed = false;
  const result = await ship(baseOptions(root, payloadPath, {
    exec,
    requireReadyOnOpen: true,
    runChecks: async () => [{ name: 'unit', status: 'failed', exitCode: 1, tail: 'boom' }],
    runSelfReview: async () => { reviewed = true; return passingSelfReview(); },
  }));
  assert.equal(result.status, 'checks-failed');
  assert.equal(reviewed, false);
  assert.ok(!calls.some(call => call.file === 'git' && call.args[0] === 'push'));
  assert.ok(!calls.some(call => call.file === 'gh' && String(call.args[1] ?? '').endsWith('/pulls')));
});

test('ship: HIGH self-review blocks pr create; nothing is pushed', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root);
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, {
    exec,
    requireReadyOnOpen: true,
    runSelfReview: async () => ({
      findings: [{ file: 'auth.js', line: 9, severity: 'high', issue: 'auth bypass', fix: 'deny' }],
    }),
  }));
  assert.equal(result.status, 'self-review-failed');
  assert.equal(result.code, 'self-review-high');
  assert.match(result.reason, /auth bypass/);
  assert.ok(!calls.some(call => call.file === 'git' && call.args[0] === 'push'));
  assert.ok(!calls.some(call => call.file === 'gh'));
});

test('ship: a HIGH finding still blocks when the hook claims ok: true', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root);
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, {
    exec,
    requireReadyOnOpen: true,
    runSelfReview: async () => ({
      ok: true,
      findings: [{ file: 'x.js', severity: 'high', issue: 'data loss' }],
    }),
  }));
  assert.equal(result.status, 'self-review-failed');
  assert.equal(result.code, 'self-review-high');
  assert.ok(!calls.some(call => call.file === 'git' && call.args[0] === 'push'));
});

test('ship: requireReadyOnOpen without a self-review hook refuses and never pushes', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root);
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, { exec, requireReadyOnOpen: true }));
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'self-review-missing');
  assert.ok(!calls.some(call => call.file === 'git' && call.args[0] === 'push'));
});

test('ship: a thrown self-review is unavailable and never pushes', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root);
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, {
    exec,
    requireReadyOnOpen: true,
    runSelfReview: async () => { throw new Error('lane crashed'); },
  }));
  assert.equal(result.status, 'self-review-failed');
  assert.equal(result.code, 'self-review-unavailable');
  assert.match(result.reason, /lane crashed/);
  assert.ok(!calls.some(call => call.file === 'git' && call.args[0] === 'push'));
});

test('ship: passing self-review comments which tests ran and the model/lane, then opens the PR', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root);
  const { exec, calls } = makeExec(greenScript());
  const notes = [];
  const result = await ship(baseOptions(root, payloadPath, {
    exec,
    requireReadyOnOpen: true,
    runSelfReview: passingSelfReview,
    postReadyNote: async ({ pr, body }) => {
      notes.push({ pr, body });
      return { code: 0, stdout: '{}', stderr: '' };
    },
  }));
  assert.equal(result.status, 'ready', result.reason ?? '');
  assert.equal(result.pr, 7);
  assert.ok(calls.some(call => call.file === 'git' && call.args[0] === 'push'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].pr, 7);
  assert.match(notes[0].body, /Tests: unit \(passed\)/);
  assert.match(notes[0].body, /Opus self-review: passed \(openrouter \/ deepseek\/deepseek-v4\.1-flash\)/);
  assert.match(notes[0].body, /official Opus grader and RED TEAM still run/);
  assert.equal(result.selfReview.ok, true);
});

test('ship: MEDIUM findings become issues, not blockers, and the PR comment lists them', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root);
  const { exec, calls } = makeExec(greenScript());
  const filed = [];
  const notes = [];
  const result = await ship(baseOptions(root, payloadPath, {
    exec,
    requireReadyOnOpen: true,
    runSelfReview: async () => ({
      findings: [{ file: 'src/a.js', line: 2, severity: 'medium', issue: 'rename helper', fix: 'extract' }],
      model: 'deepseek/deepseek-chat', lane: 'openrouter',
    }),
    fileFollowups: async ({ findings, pr }) => {
      filed.push({ findings, pr });
      return { issues: [{ number: 44, url: 'https://example.com/issues/44', finding: findings[0] }] };
    },
    postReadyNote: async ({ body, pr }) => {
      notes.push({ body, pr });
      return { code: 0, stdout: '{}', stderr: '' };
    },
  }));
  assert.equal(result.status, 'ready', result.reason ?? '');
  assert.ok(calls.some(call => call.file === 'git' && call.args[0] === 'push'));
  assert.equal(filed[0].pr, 7);
  assert.equal(filed[0].findings[0].severity, 'medium');
  assert.match(notes[0].body, /#44/);
  assert.deepEqual(result.selfReview.followups, [44]);
});

test('defaultPostReadyNote and defaultFileFollowups post through gh api without labels', async () => {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, input: opts?.input });
    return { code: 0, stdout: JSON.stringify({ number: 3, html_url: 'https://example.com/issues/3' }), stderr: '' };
  };
  await defaultPostReadyNote({ exec, root: '/repo', repo: 'acme/widgets', pr: 7, body: 'Ready on open' });
  const follow = await defaultFileFollowups({
    exec, root: '/repo', repo: 'acme/widgets', pr: 7, url: 'https://example.com/pr/7',
    findings: [{ file: 'a.js', severity: 'medium', issue: 'nits' }],
  });
  assert.equal(follow.issues[0].number, 3);
  assert.ok(calls.every(call => call.file === 'gh' && call.args[0] === 'api'));
  assert.match(calls[0].args[1], /\/issues\/7\/comments$/);
  assert.match(calls[1].args[1], /\/issues$/);
  for (const call of calls) {
    const body = JSON.parse(call.input);
    assert.equal(body.labels, undefined);
  }
});

test('shipExitCode treats self-review-failed as a failure', () => {
  assert.equal(shipExitCode('self-review-failed'), 1);
  assert.equal(shipExitCode('ready'), 0);
});

test('shipRun and shipBranch always pass requireReadyOnOpen and a self-review hook', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ship-ready-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  const job = { id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'] };
  const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', "const fs=require('fs');fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));"], options);
  const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl });
  await integrateRun(root, state.id, { noChecks: true });
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'topic', base: 'main', body: 'b' }));
  await git(root, ['checkout', '-q', '-b', 'topic']);
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'topic']);
  const seen = [];
  const shipImpl = async options => { seen.push(options); return { status: 'ready' }; };
  const flags = parseShipFlags(['--pr', payloadPath, '--no-merge']);
  assert.equal((await shipRun(root, state.id, flags, { shipImpl, exec: async () => ({ code: 0, stdout: 'topic' }) })).status, 'ready');
  assert.equal((await shipBranch(root, { ...flags, branch: 'topic' }, { shipImpl, exec: async () => ({ code: 0, stdout: 'topic' }) })).status, 'ready');
  assert.equal(seen.length, 2);
  for (const options of seen) {
    assert.equal(options.requireReadyOnOpen, true);
    assert.equal(options.runSelfReview, defaultRunSelfReview);
    assert.equal(typeof options.postReadyNote, 'function');
    assert.equal(typeof options.fileFollowups, 'function');
  }
});

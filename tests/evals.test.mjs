import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvalSpec, listEvals, checkEval, validateEval, evalManifest, scoreRun, compareBaseline, validateBaseline } from '../tools/evals.mjs';

const PROMPT = 'Fix the pagination helper so the last page of results is included in the output.';
const SECRET = ['gh', 'p_', 'Q7wErTy', 'UiOpAsD', 'FgHjKlZxC', 'vBnM1234567890'].join('');
const HOME_PATH = ['', 'Users', 'ci', 'runner'].join('/');

function goodSpec(overrides = {}) {
  return {
    version: 1,
    id: 'pagination-last-page',
    title: 'Last page missing',
    tags: ['pagination', 'off-by-one'],
    prompt: PROMPT,
    context: ['src/page.js'],
    outputs: ['src/page.js'],
    check: { argv: ['node', '--test', 'test/page.test.mjs'], timeoutSec: 30 },
    ...overrides,
  };
}

async function makeRoot() {
  return (await import('node:fs/promises')).realpath(await mkdtemp(join(tmpdir(), 'eval-test-')));
}

async function makeEval(root, id, { spec, src, solution } = {}) {
  const dir = join(root, 'evals', id);
  await mkdir(join(dir, 'repo', 'src'), { recursive: true });
  await mkdir(join(dir, 'hidden', 'test'), { recursive: true });
  await mkdir(join(dir, 'solution', 'src'), { recursive: true });
  await writeFile(join(dir, 'eval.json'), JSON.stringify(spec ?? goodSpec({ id }), null, 2));
  await writeFile(join(dir, 'repo', 'src', 'page.js'), src ?? 'export const BROKEN = true;\n');
  await writeFile(join(dir, 'solution', 'src', 'page.js'), solution ?? '// FIXED\nexport const ok = true;\n');
  await writeFile(join(dir, 'hidden', 'test', 'page.test.mjs'), '// hidden check\n');
  return dir;
}

// Fake run: passes only when the copied src/page.js contains FIXED.
function fakeRun({ failOutput = 'failed', timeout = false } = {}) {
  const seen = [];
  const run = async (command, args, opts = {}) => {
    seen.push({ argv: [command, ...args], cwd: opts.cwd, env: opts.env });
    if (timeout) return { code: null, stdout: '', stderr: '', timedOut: true };
    const src = await readFile(join(opts.cwd, 'src', 'page.js'), 'utf8');
    const pass = src.includes('FIXED');
    return { code: pass ? 0 : 1, stdout: pass ? 'ok' : failOutput, stderr: '' };
  };
  run.seen = seen;
  return run;
}

async function attempt(promise) {
  try {
    return await promise;
  } catch {
    return { pass: false, rejected: true };
  }
}

async function writeRun(root, runId, jobs) {
  await mkdir(join(root, '.swarm', 'runs', runId), { recursive: true });
  await writeFile(join(root, '.swarm', 'runs', runId, 'state.json'), JSON.stringify({ jobs }));
}

test('validateEvalSpec accepts a good spec', () => {
  const r = validateEvalSpec(goodSpec());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateEvalSpec rejects bad id, short prompt, bold prompt, absolute path, non-node argv', () => {
  const cases = [
    goodSpec({ id: 'Bad_ID' }),
    goodSpec({ prompt: 'too short' }),
    goodSpec({ prompt: PROMPT + ' **bold**' }),
    goodSpec({ outputs: ['/etc/passwd'] }),
    goodSpec({ context: ['../secret.txt'] }),
    goodSpec({ check: { argv: ['python', 'x.py'], timeoutSec: 30 } }),
  ];
  for (const spec of cases) {
    const r = validateEvalSpec(spec);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
});

test('validateEvalSpec accepts the allowed test flags', () => {
  const r = validateEvalSpec(goodSpec({
    check: { argv: ['node', '--test', '--test-reporter=spec', '--test-timeout=5000', '--test-name-pattern=last-page', 'test/page.test.mjs'], timeoutSec: 30 },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

for (const flag of ['-e', '--eval', '--require', '--import', '--env-file']) {
  test(`validateEvalSpec refuses the forbidden argv flag ${flag}`, () => {
    const r = validateEvalSpec(goodSpec({ check: { argv: ['node', flag, 'test/page.test.mjs'], timeoutSec: 30 } }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });
}

test('listEvals returns valid tasks and reports an invalid one', async () => {
  const root = await makeRoot();
  try {
    await makeEval(root, 'pagination-last-page');
    await makeEval(root, 'broken-task', { spec: goodSpec({ id: 'broken-task', prompt: 'short' }) });
    const r = await listEvals(root);
    assert.ok(r.evals.some((e) => e.id === 'pagination-last-page'));
    assert.ok(!r.evals.some((e) => e.id === 'broken-task'));
    assert.ok(r.invalid.some((i) => i.id === 'broken-task' && i.errors.length > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listEvals never follows a symlinked eval folder', async () => {
  const root = await makeRoot();
  try {
    const real = await makeEval(root, 'pagination-last-page');
    await symlink(real, join(root, 'evals', 'linked-task'));
    const r = await listEvals(root);
    assert.ok(r.evals.some((e) => e.id === 'pagination-last-page'));
    assert.ok(!r.evals.some((e) => e.id === 'linked-task'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listEvals skips a dot folder', async () => {
  const root = await makeRoot();
  try {
    await makeEval(root, 'pagination-last-page');
    await mkdir(join(root, 'evals', '.scratch'), { recursive: true });
    await writeFile(join(root, 'evals', '.scratch', 'eval.json'), JSON.stringify(goodSpec({ id: '.scratch' })));
    const r = await listEvals(root);
    assert.ok(r.evals.some((e) => e.id === 'pagination-last-page'));
    assert.ok(!r.evals.some((e) => e.id === '.scratch'));
    assert.ok(!r.invalid.some((i) => i.id === '.scratch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkEval passes when the outputs fix the task', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page');
    const outputs = join(root, 'out');
    await mkdir(join(outputs, 'src'), { recursive: true });
    await writeFile(join(outputs, 'src', 'page.js'), '// FIXED\n');
    const run = fakeRun();
    const r = await checkEval(dir, outputs, { run });
    assert.equal(r.pass, true);
    assert.equal(r.exitCode, 0);
    assert.equal(typeof r.ms, 'number');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkEval refuses a symlinked repo folder', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page');
    const real = join(root, 'real-repo');
    await mkdir(join(real, 'src'), { recursive: true });
    await writeFile(join(real, 'src', 'page.js'), '// FIXED\n');
    await rm(join(dir, 'repo'), { recursive: true, force: true });
    await symlink(real, join(dir, 'repo'), 'dir');
    const r = await attempt(checkEval(dir, join(root, 'empty'), { run: fakeRun() }));
    assert.notEqual(r.pass, true);
    const v = await attempt(validateEval(dir, { run: fakeRun() }));
    assert.notEqual(v.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkEval refuses a symlinked output folder', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page');
    const real = join(root, 'real-out');
    await mkdir(join(real, 'src'), { recursive: true });
    await writeFile(join(real, 'src', 'page.js'), '// FIXED\n');
    await symlink(real, join(root, 'out-link'), 'dir');
    const r = await attempt(checkEval(dir, join(root, 'out-link'), { run: fakeRun() }));
    assert.notEqual(r.pass, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkEval fails with no outputs and removes its temp folder', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page');
    const run = fakeRun();
    const r = await checkEval(dir, join(root, 'empty'), { run });
    assert.equal(r.pass, false);
    assert.notEqual(r.exitCode, 0);
    const cwd = run.seen[0].cwd;
    await assert.rejects(access(cwd));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkEval reports a timeout as a failure', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page');
    const outputs = join(root, 'out');
    await mkdir(join(outputs, 'src'), { recursive: true });
    await writeFile(join(outputs, 'src', 'page.js'), '// FIXED\n');
    const r = await checkEval(dir, outputs, { run: fakeRun({ timeout: true }) });
    assert.equal(r.pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkEval redacts secrets and home paths from the tail and caps it at 600 characters', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page');
    const noisy = 'x'.repeat(1000) + ' token=' + SECRET + ' path=' + HOME_PATH + '/work';
    const r = await checkEval(dir, join(root, 'empty'), { run: fakeRun({ failOutput: noisy }) });
    assert.equal(r.pass, false);
    assert.ok(r.tail.length <= 600);
    assert.ok(!r.tail.includes(SECRET));
    assert.ok(!r.tail.includes('/Users/ci'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validateEval is red on the starting repo and green on the solution', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page');
    const r = await validateEval(dir, { run: fakeRun() });
    assert.equal(r.red, true);
    assert.equal(r.green, true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validateEval is not ok when the check passes on the untouched repo', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page', { src: '// FIXED already\n' });
    const r = await validateEval(dir, { run: fakeRun() });
    assert.equal(r.red, false);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validateEval is not ok when the solution does not pass', async () => {
  const root = await makeRoot();
  try {
    const dir = await makeEval(root, 'pagination-last-page', { solution: '// not done\n' });
    const r = await validateEval(dir, { run: fakeRun() });
    assert.equal(r.green, false);
    assert.equal(r.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evalManifest builds one build job per eval with the fixed shape', () => {
  const spec = goodSpec();
  const m = evalManifest([{ id: spec.id, dir: 'evals/' + spec.id, spec }], { agent: 'codex', model: 'm1', lane: 'l1', maxUsd: 2 });
  const job = m.jobs[0];
  assert.equal(m.jobs.length, 1);
  assert.equal(job.id, 'eval-' + spec.id);
  assert.equal(job.type, 'build');
  assert.equal(job.agent, 'codex');
  assert.equal(job.model, 'm1');
  assert.equal(job.sensitive, true);
  assert.equal(job.prompt, spec.prompt);
  assert.deepEqual(job.context, ['evals/' + spec.id + '/repo/src/page.js']);
  assert.deepEqual(job.outputs, ['evals/' + spec.id + '/repo/src/page.js']);
  assert.equal(job.maxOutputTokens, 16000);
  assert.equal(job.timeoutMs, 600000);
});

test('evalManifest defaults the agent to auto', () => {
  const spec = goodSpec();
  const m = evalManifest([{ id: spec.id, dir: 'evals/' + spec.id, spec }], {});
  assert.equal(m.jobs[0].agent, 'auto');
});

test('scoreRun scores a complete job and fails a job that is not complete', async () => {
  const root = await makeRoot();
  try {
    const good = await makeEval(root, 'pagination-last-page');
    await makeEval(root, 'other-task', { spec: goodSpec({ id: 'other-task' }) });
    const ws = join(root, '.swarm', 'workspaces', 'ws1');
    await mkdir(join(ws, 'evals', 'pagination-last-page', 'repo', 'src'), { recursive: true });
    await writeFile(join(ws, 'evals', 'pagination-last-page', 'repo', 'src', 'page.js'), '// FIXED\n');
    const runId = '1700000000000-abcdef12';
    await mkdir(join(root, '.swarm', 'runs', runId), { recursive: true });
    await writeFile(join(root, '.swarm', 'runs', runId, 'state.json'), JSON.stringify({
      jobs: [
        { id: 'eval-pagination-last-page', status: 'complete', workspace: ws, agent: 'codex', model: 'm1', costUsd: 0.5 },
        { id: 'eval-other-task', status: 'failed', workspace: ws, agent: 'codex', model: 'm1', costUsd: 0.2 },
      ],
    }));
    const evals = [
      { id: 'pagination-last-page', dir: good, spec: goodSpec() },
      { id: 'other-task', dir: join(root, 'evals', 'other-task'), spec: goodSpec({ id: 'other-task' }) },
    ];
    const r = await scoreRun(root, runId, { evals, run: fakeRun() });
    assert.equal(r.runId, runId);
    assert.equal(r.total, 2);
    assert.equal(r.passed, 1);
    const first = r.results.find((x) => x.id === 'pagination-last-page');
    const second = r.results.find((x) => x.id === 'other-task');
    assert.equal(first.pass, true);
    assert.equal(second.pass, false);
    assert.equal(second.status, 'failed');
    assert.ok(r.agents.includes('codex'));
    assert.ok(r.models.includes('m1'));
    assert.equal(r.costUsd, 0.7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scoreRun refuses a workspace outside .swarm/workspaces', async () => {
  const root = await makeRoot();
  try {
    const runId = '1700000000000-abcdef34';
    const ws = join(root, 'ws');
    await mkdir(join(ws, 'evals', 'pagination-last-page', 'repo', 'src'), { recursive: true });
    await writeFile(join(ws, 'evals', 'pagination-last-page', 'repo', 'src', 'page.js'), '// FIXED\n');
    await writeRun(root, runId, [{ id: 'eval-pagination-last-page', status: 'complete', workspace: ws, agent: 'codex', model: 'm1', costUsd: 0 }]);
    const evals = [{ id: 'pagination-last-page', dir: join(root, 'evals', 'pagination-last-page'), spec: goodSpec() }];
    const r = await scoreRun(root, runId, { evals, run: fakeRun() });
    assert.equal(r.results[0].pass, false);
    assert.equal(r.results[0].status, 'workspace-refused');
    assert.equal(r.passed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scoreRun refuses a symlinked workspace inside .swarm/workspaces', async () => {
  const root = await makeRoot();
  try {
    const runId = '1700000000000-abcdef56';
    const real = join(root, '.swarm', 'workspaces', 'real');
    await mkdir(join(real, 'evals', 'pagination-last-page', 'repo', 'src'), { recursive: true });
    await writeFile(join(real, 'evals', 'pagination-last-page', 'repo', 'src', 'page.js'), '// FIXED\n');
    const link = join(root, '.swarm', 'workspaces', 'link');
    await symlink(real, link, 'dir');
    await writeRun(root, runId, [{ id: 'eval-pagination-last-page', status: 'complete', workspace: link, agent: 'codex', model: 'm1', costUsd: 0 }]);
    const evals = [{ id: 'pagination-last-page', dir: join(root, 'evals', 'pagination-last-page'), spec: goodSpec() }];
    const r = await scoreRun(root, runId, { evals, run: fakeRun() });
    assert.equal(r.results[0].pass, false);
    assert.equal(r.results[0].status, 'workspace-refused');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scoreRun rejects a bad run id', async () => {
  const root = await makeRoot();
  try {
    await assert.rejects(scoreRun(root, '../escape', { evals: [], run: fakeRun() }));
    await assert.rejects(scoreRun(root, '-leading-dash', { evals: [], run: fakeRun() }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validateBaseline accepts a good baseline', () => {
  const r = validateBaseline({ 'codex/m1': { passed: 2, total: 3 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateBaseline rejects null, arrays and non-objects', () => {
  for (const v of [null, [], 'text', 5]) {
    const r = validateBaseline(v);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
});

test('validateBaseline rejects a string total', () => {
  const r = validateBaseline({ 'codex/m1': { passed: 1, total: '3' } });
  assert.equal(r.ok, false);
});

test('validateBaseline rejects passed over total', () => {
  const r = validateBaseline({ 'codex/m1': { passed: 4, total: 3 } });
  assert.equal(r.ok, false);
});

test('validateBaseline rejects total 0', () => {
  const r = validateBaseline({ 'codex/m1': { passed: 0, total: 0 } });
  assert.equal(r.ok, false);
});

test('compareBaseline flags a regression against the same total', () => {
  const score = { runId: 'r', passed: 2, total: 3, agents: ['codex'], models: ['m1'], results: [] };
  const baseline = { 'codex/m1': { passed: 3, total: 3 } };
  const r = compareBaseline(score, baseline);
  assert.equal(r.key, 'codex/m1');
  assert.equal(r.passed, 2);
  assert.equal(r.total, 3);
  assert.deepEqual(r.baseline, { passed: 3, total: 3 });
  assert.equal(r.regressed, true);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length > 0);
});

test('compareBaseline does not regress without a baseline or when the total changed', () => {
  const score = { runId: 'r', passed: 1, total: 3, agents: ['codex'], models: ['m1'], results: [] };
  const none = compareBaseline(score, {});
  assert.equal(none.baseline, null);
  assert.equal(none.regressed, false);
  const diffTotal = compareBaseline(score, { 'codex/m1': { passed: 3, total: 4 } });
  assert.equal(diffTotal.regressed, false);
});

test('compareBaseline reports total-changed when the baseline total differs', () => {
  const score = { runId: 'r', passed: 1, total: 3, agents: ['codex'], models: ['m1'], results: [] };
  const r = compareBaseline(score, { 'codex/m1': { passed: 3, total: 4 } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('total-changed'));
});

test('compareBaseline is not ok for an invalid baseline', () => {
  const score = { runId: 'r', passed: 1, total: 3, agents: ['codex'], models: ['m1'], results: [] };
  const r = compareBaseline(score, { 'codex/m1': { passed: 'x', total: 3 } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length > 0);
});

test('compareBaseline is not ok when the score total is 0', () => {
  const score = { runId: 'r', passed: 0, total: 0, agents: ['codex'], models: ['m1'], results: [] };
  const r = compareBaseline(score, {});
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length > 0);
});

test('compareBaseline is not ok for an unknown key', () => {
  const score = { runId: 'r', passed: 1, total: 2, agents: [], models: [], results: [] };
  const r = compareBaseline(score, {});
  assert.equal(r.key, 'unknown/unknown');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length > 0);
});

test('compareBaseline is not ok for a mixed key', () => {
  const score = { runId: 'r', passed: 1, total: 2, agents: ['codex', 'claude'], models: ['m1'], results: [] };
  const r = compareBaseline(score, {});
  assert.equal(r.key, 'mixed');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length > 0);
});

test('compareBaseline is ok when the score meets the baseline', () => {
  const score = { runId: 'r', passed: 3, total: 3, agents: ['codex'], models: ['m1'], results: [] };
  const r = compareBaseline(score, { 'codex/m1': { passed: 3, total: 3 } });
  assert.equal(r.regressed, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test('compareBaseline uses mixed when several agents or models ran', () => {
  const score = { runId: 'r', passed: 1, total: 2, agents: ['codex', 'claude'], models: ['m1'], results: [] };
  const r = compareBaseline(score, {});
  assert.equal(r.key, 'mixed');
});

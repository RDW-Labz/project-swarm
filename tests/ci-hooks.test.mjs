import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCiConfig, isProductionArgv, shouldRun, extractPreviewUrl, runHook, fixTicketFromFailure } from '../tools/ci-hooks.mjs';

const okResult = (over = {}) => ({ code: 0, stdout: '', stderr: '', ...over });
const fakeRun = (result) => async () => result;

function recordingRun(result = okResult()) {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return result; };
  return { run, calls };
}

// Secret-looking names and values are built at run time from pieces, never written out whole.
const TOKEN_KEY = ['GITHUB', '_TOKEN'].join('');
const PASS_KEY = ['DB', '_PASSWORD'].join('');
const APIKEY_KEY = ['my', '_api_key'].join('');
const FAKE_VALUE = ['fake', 'value', '1'].join('-');

test('config: undefined raw gives an empty config and no errors', () => {
  const r = validateCiConfig(undefined);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config, {});
});

test('config: defaults are filled for timeoutSec and everyBatches', () => {
  const r = validateCiConfig({ smoke: { argv: ['node', 'smoke.mjs'] } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.smoke.timeoutSec, 600);
  assert.equal(r.config.smoke.everyBatches, 1);
});

test('config: unknown keys are errors at block and top level', () => {
  assert.ok(validateCiConfig({ smoke: { argv: ['node', 's.mjs'], retries: 2 } }).errors.length > 0);
  assert.ok(validateCiConfig({ deploy: { argv: ['node', 's.mjs'] } }).errors.length > 0);
});

test('config: bad argv shapes are errors', () => {
  const cases = [
    [],
    new Array(21).fill('node'),
    ['node', 5],
    'node s.mjs',
  ];
  for (const argv of cases) {
    assert.ok(validateCiConfig({ smoke: { argv } }).errors.length > 0, JSON.stringify(argv));
  }
});

test('config: bad numbers are errors', () => {
  const cases = [
    { timeoutSec: 29 },
    { timeoutSec: 1801 },
    { timeoutSec: 'soon' },
    { everyBatches: 0 },
    { everyBatches: 51 },
    { everyBatches: 1.5 },
  ];
  for (const extra of cases) {
    const r = validateCiConfig({ smoke: { argv: ['node', 's.mjs'], ...extra } });
    assert.ok(r.errors.length > 0, JSON.stringify(extra));
  }
});

test('config: production words are refused in a preview argv', () => {
  const cases = [
    ['vercel', '--prod'],
    ['vercel', 'deploy', '--production'],
    ['vercel', 'promote'],
    ['deploy', '--target=production'],
    ['deploy', 'PROD'],
    ['deploy', 'Production'],
  ];
  for (const argv of cases) {
    assert.ok(validateCiConfig({ preview: { argv } }).errors.length > 0, JSON.stringify(argv));
  }
});

test('config: only valid hooks are returned; config is empty on any error', () => {
  const bad = validateCiConfig({ smoke: { argv: ['node', 's.mjs'] }, preview: { argv: ['vercel', '--prod'] } });
  assert.ok(bad.errors.length > 0);
  assert.deepEqual(bad.config, {});
  const unknownTop = validateCiConfig({ smoke: { argv: ['node', 's.mjs'] }, extra: {} });
  assert.ok(unknownTop.errors.length > 0);
  assert.deepEqual(unknownTop.config, {});
});

test('config: a safe preview argv is accepted', () => {
  const r = validateCiConfig({ preview: { argv: ['vercel', 'deploy'] } });
  assert.deepEqual(r.errors, []);
});

test('config: smoke may use production-looking words', () => {
  const r = validateCiConfig({ smoke: { argv: ['vercel', '--prod'] } });
  assert.deepEqual(r.errors, []);
});

test('isProductionArgv flags forbidden preview items only', () => {
  assert.equal(isProductionArgv(['x', '--prod']), true);
  assert.equal(isProductionArgv(['x', 'promote']), true);
  assert.equal(isProductionArgv(['x', 'PRODUCTION']), true);
  assert.equal(isProductionArgv(['x', 'preview']), false);
});

test('isProductionArgv refuses every production form', () => {
  const cases = [
    ['deploy', '--prod=true'],
    ['deploy', '--target=prod'],
    ['deploy', 'environment=production'],
    ['deploy', '-p'],
    ['sh', '-c', 'vercel deploy'],
    ['bash', 'deploy.sh'],
    ['prod'],
    ['deploy', '--PROD'],
    ['deploy', '--Target=PRODUCTION'],
  ];
  for (const argv of cases) {
    assert.equal(isProductionArgv(argv), true, JSON.stringify(argv));
  }
});

test('a plain deploy passes the production check', () => {
  assert.equal(isProductionArgv(['vercel', 'deploy']), false);
  assert.equal(isProductionArgv(['node', 'deploy.mjs']), false);
  assert.equal(isProductionArgv(['npm', 'run', 'preview']), false);
});

test('shouldRun: every N batches, batch numbers start at 1', () => {
  assert.equal(shouldRun(1, 1), true);
  assert.equal(shouldRun(1, 7), true);
  assert.equal(shouldRun(3, 1), false);
  assert.equal(shouldRun(3, 3), true);
  assert.equal(shouldRun(3, 4), false);
  assert.equal(shouldRun(3, 6), true);
});

test('extractPreviewUrl takes the last https URL in the text', () => {
  const text = 'Preview: https://app-1.example.dev/path and https://other.example.dev';
  assert.equal(extractPreviewUrl(text), 'https://other.example.dev');
});

test('extractPreviewUrl removes trailing punctuation', () => {
  assert.equal(extractPreviewUrl('see https://x.example.com).'), 'https://x.example.com');
  assert.equal(extractPreviewUrl('Ready: https://app-2.example.dev.'), 'https://app-2.example.dev');
});

test('extractPreviewUrl refuses a URL with user info', () => {
  const user = ['user', ':', 'pass'].join('');
  assert.equal(extractPreviewUrl('https://' + user + '@host.example.com/x'), null);
});

test('extractPreviewUrl never returns an unsafe URL even when it is the last match', () => {
  const user = ['user', ':', 'pass'].join('');
  const r = extractPreviewUrl('https://good.example.dev then https://' + user + '@bad.example.dev');
  assert.ok(r === null || !r.includes('bad.example.dev'));
  assert.ok(r === null || !r.includes('@'));
});

test('extractPreviewUrl returns null when there is no URL', () => {
  assert.equal(extractPreviewUrl('build finished, no link here'), null);
  assert.equal(extractPreviewUrl(''), null);
});

test('runHook: exit 0 is passed with a non-negative duration', async () => {
  const r = await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(okResult()) });
  assert.equal(r.kind, 'smoke');
  assert.equal(r.status, 'passed');
  assert.equal(r.exitCode, 0);
  assert.ok(r.durationMs >= 0);
});

test('runHook: non-zero exit is failed with the exit code', async () => {
  const r = await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(okResult({ code: 2 })) });
  assert.equal(r.status, 'failed');
  assert.equal(r.exitCode, 2);
});

test('runHook: timedOut is timeout', async () => {
  const r = await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun({ code: null, stdout: '', stderr: '', timedOut: true }) });
  assert.equal(r.status, 'timeout');
});

test('runHook: a spawn error is cannot-run', async () => {
  const run = async () => { const e = new Error('spawn node ENOENT'); e.code = 'ENOENT'; throw e; };
  const r = await runHook('smoke', { argv: ['nope-tool'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run });
  assert.equal(r.status, 'cannot-run');
});

test('runHook refuses an invalid hook with cannot-run and never spawns', async () => {
  const { run, calls } = recordingRun();
  const r = await runHook('smoke', { argv: [] }, { cwd: '/tmp', env: {}, run });
  assert.equal(r.status, 'cannot-run');
  assert.equal(calls.length, 0);
});

test('runHook refuses a production preview with cannot-run and never spawns', async () => {
  const { run, calls } = recordingRun();
  const r1 = await runHook('preview', { argv: ['vercel', 'deploy', '--prod'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run });
  assert.equal(r1.status, 'cannot-run');
  const r2 = await runHook('preview', { argv: ['vercel', '--target=prod'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run });
  assert.equal(r2.status, 'cannot-run');
  assert.equal(calls.length, 0);
});

test('runHook passes only allowlisted environment variables', async () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/srv/ci-home',
    CI: 'true',
    LC_ALL: 'C',
    NODE_ENV: 'test',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    DATABASE_URL: 'postgres://db.example.internal/app',
    MY_KEY: FAKE_VALUE,
    [PASS_KEY]: FAKE_VALUE,
    [TOKEN_KEY]: FAKE_VALUE,
    [APIKEY_KEY]: FAKE_VALUE,
  };
  const { run, calls } = recordingRun();
  await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env, run, timeoutMs: 30000 });
  const seen = calls[0].options.env;
  for (const k of ['PATH', 'HOME', 'CI', 'LC_ALL', 'NODE_ENV']) {
    assert.ok(Object.prototype.hasOwnProperty.call(seen, k), k);
  }
  for (const k of ['SSH_AUTH_SOCK', 'DATABASE_URL', 'MY_KEY', PASS_KEY, TOKEN_KEY, APIKEY_KEY]) {
    assert.equal(Object.prototype.hasOwnProperty.call(seen, k), false, k);
  }
});

test('runHook finishes when the child exits while a grandchild keeps the pipes open', async () => {
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], { stdio: 'inherit', detached: true }); c.unref(); console.log('done');`;
  const started = Date.now();
  const r = await runHook('smoke', { argv: ['node', '-e', script], timeoutSec: 30 }, { cwd: process.cwd(), env: process.env, timeoutMs: 20000 });
  assert.equal(r.status, 'passed');
  assert.ok(r.tail.includes('done'));
  assert.ok(Date.now() - started < 10000);
});

test('runHook: tail is capped at the last 1500 characters', async () => {
  const r = await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(okResult({ stdout: 'line of text '.repeat(400) + ' END' })) });
  assert.ok(r.tail.length <= 1500);
  assert.ok(r.tail.endsWith('END'));
});

test('runHook: tail redacts emails and home paths', async () => {
  const r = await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(okResult({ stdout: 'mail dev@example.com from /Users/alice/work' })) });
  assert.equal(r.tail.includes('dev@example.com'), false);
  assert.equal(r.tail.includes('/Users/alice'), false);
});

test('runHook never returns private data in the tail', async () => {
  const hex = ['0123456789abcdef', '0123456789abcdef', '0123456789abcdef'].join('');
  const out = 'token ' + hex + ' mail dev@example.com';
  const r = await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(okResult({ stdout: out })) });
  assert.equal(r.tail.includes(hex), false);
  assert.equal(r.tail.includes('dev@example.com'), false);
});

test('runHook: url is set only for a passed preview', async () => {
  const out = okResult({ stdout: 'Ready: https://app-1.example.dev.' });
  const passed = await runHook('preview', { argv: ['vercel', 'deploy'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(out) });
  assert.equal(passed.url, 'https://app-1.example.dev');
  const failed = await runHook('preview', { argv: ['vercel', 'deploy'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(okResult({ code: 1, stdout: 'Ready: https://app-1.example.dev.' })) });
  assert.ok(!failed.url);
  const smoke = await runHook('smoke', { argv: ['node', 's.mjs'], timeoutSec: 30 }, { cwd: '/tmp', env: {}, run: fakeRun(out) });
  assert.ok(!smoke.url);
});

test('fixTicketFromFailure: shape and fixed fields', () => {
  const t = fixTicketFromFailure({ kind: 'smoke', batchNumber: 4, jobs: ['j1'], files: ['src/a.mjs'], tail: 'boom', summary: 'short' });
  assert.equal(t.title, 'Fix smoke failure after batch 4');
  assert.equal(t.type, 'build');
  assert.equal(t.stage, 'S0');
  assert.equal(t.epic, 'E-99 Continuous integration');
  assert.deepEqual(t.scopeRefs, []);
  assert.deepEqual(t.acceptance, [`The smoke check passes again on the batch's files.`]);
  assert.deepEqual(t.files, ['src/a.mjs']);
  assert.deepEqual(t.context, ['src/a.mjs']);
  assert.equal(t.origin, 'ci');
  assert.deepEqual(t.contracts, []);
  assert.deepEqual(t.dependsOn, []);
  assert.equal(t.size, 'M');
  assert.equal(t.risk, 'high');
  assert.equal(t.sensitive, true);
  assert.equal(t.status, 'todo');
  assert.equal('id' in t, false);
});

test('fixTicketFromFailure: context keeps at most 10 files', () => {
  const files = Array.from({ length: 12 }, (_, i) => 'src/f' + i + '.mjs');
  const t = fixTicketFromFailure({ kind: 'preview', batchNumber: 2, jobs: [], files, tail: 'x', summary: '' });
  assert.equal(t.context.length, 10);
  assert.deepEqual(t.context, files.slice(0, 10));
});

test('fixTicketFromFailure: title is at most 140 characters', () => {
  const kind = 'k'.repeat(300);
  const t = fixTicketFromFailure({ kind, batchNumber: 1, jobs: [], files: [], tail: '', summary: '' });
  assert.ok(t.title.length <= 140);
});

test('fixTicketFromFailure: notes are at most 600 characters', () => {
  const t = fixTicketFromFailure({ kind: 'smoke', batchNumber: 1, jobs: [], files: [], tail: 'z'.repeat(3000), summary: '' });
  assert.ok(t.notes.length <= 600);
  const s = fixTicketFromFailure({ kind: 'smoke', batchNumber: 1, jobs: [], files: [], tail: '', summary: 'y'.repeat(3000) });
  assert.ok(s.notes.length <= 600);
});

test('isProductionArgv: a production word is still found next to the letter s and inside a spaced argument', () => {
  assert.equal(isProductionArgv(['deploy', 'stage production']), true);
  assert.equal(isProductionArgv(['deploy', '--stage=production']), true);
  assert.equal(isProductionArgv(['deploy', '--target', 'staging']), false);
  assert.equal(isProductionArgv(['deploy', '--scope=preview']), false);
});

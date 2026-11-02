import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectDecisionValueWarnings,
  decisionValueWarnings,
  preflightReport,
  ship,
} from '../tools/ship.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'failure') => ({ code: 1, stdout: '', stderr });
const warningFor = value => `decision-value-not-in-diff: held PR summary names ${value}, absent from added diff lines; quote the source constant and name its value-pinning test`;
const unavailable = 'decision-value-diff-unavailable: cannot read the committed diff; verify decision values against source before handoff';

function heldBody(summary, couldBreak = '') {
  return ['**needs review**', '## Summary', summary, '## Could break', couldBreak, '## Mutation check', 'pinning test'].join('\n');
}

test('L359 held summaries warn for values absent from added diff content', () => {
  const diffWith600 = '@@ -0,0 +1,1 @@\n+const timeout = 600;\n';
  assert.deepEqual(decisionValueWarnings(heldBody('The decision is 15 seconds.'), diffWith600), [warningFor('15')]);
  assert.deepEqual(decisionValueWarnings(heldBody('The decision is 600 seconds.'), '@@ -0,0 +1,1 @@\n+const timeout = 1600;\n'), [warningFor('600')]);
  assert.deepEqual(decisionValueWarnings(heldBody('The decision is 600 seconds.'), '@@ -1 +1 @@\n-const timeout = 600;\n'), [warningFor('600')]);
  assert.deepEqual(decisionValueWarnings(heldBody('The decision is 600 seconds.'), diffWith600), []);

  const exactValues = heldBody('Use -0.5 seconds and +1.25 seconds; repeat +1.25.', 'The cap is 42 units.');
  const exactDiff = '@@ -0,0 +1,2 @@\n+const jitter = -0.5;\n+const cap = +1.25;\n';
  assert.deepEqual(decisionValueWarnings(exactValues, exactDiff), [warningFor('42')]);

  const ignored = heldBody('See https://example.test/600, release 1.48.0.\n1. numbered item\nsource value is 42.');
  assert.deepEqual(decisionValueWarnings(ignored, '@@ -0,0 +1,1 @@\n+const value = 42;\n+const url = "https://example.test/600";\n'), []);
  assert.deepEqual(decisionValueWarnings(heldBody('The value is 600.'), '@@ -600 +700 @@\n+const value = 42;\n'), [warningFor('600')]);
  assert.deepEqual(decisionValueWarnings('## Summary\nThe value is 600.', ''), []);
});

async function shipFixture(t, body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-process-ship-'));
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, payloadPath };
}

function fakeExec({ diff = '+const timeout = 900;\n', calls = [] } = {}) {
  return async (file, args) => {
    calls.push({ file, args });
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git\n');
    if (file === 'git' && args[0] === 'merge-base') return ok('base-sha\n');
    if (file === 'git' && args[0] === 'diff') return ok(`@@ -0,0 +1,1 @@\n${diff}`);
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'rev-parse') return ok('head-sha\n');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 7, html_url: 'https://example.test/pr/7' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'head-sha', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return ok('');
    throw new Error(`unexpected fake exec: ${file} ${args.join(' ')}`);
  };
}

async function captureShip(t, options) {
  const previous = process.stdout.write;
  const chunks = [];
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
  try {
    return { result: await ship(options), printed: chunks.join('') };
  } finally {
    process.stdout.write = previous;
  }
}

test('L359 ship and preflight surface advisory decision warnings without releasing a hold', async t => {
  const body = heldBody('The summary says 600 seconds.', 'This could affect the timeout.');
  const { root, payloadPath } = await shipFixture(t, body);
  const preflightCalls = [];
  const preflight = await captureShip(t, {
    root, payloadPath, repo: 'acme/widgets', preflight: true, integratedFiles: [],
    exec: fakeExec({ calls: preflightCalls }),
    authorEmailExec: async () => fail('not a repository'),
    commitScanExec: async () => fail('not a repository'),
  });
  const printed = JSON.parse(preflight.printed);
  assert.equal(preflight.result.status, 'preflight');
  assert.equal(preflight.result.ok, true);
  assert.deepEqual(preflight.result.warnings, [warningFor('600')]);
  assert.deepEqual(printed.warnings, [warningFor('600')]);
  assert.ok(!preflightCalls.some(call => call.file === 'git' && call.args[0] === 'push'));

  const shipCalls = [];
  const normal = await ship({
    root, payloadPath, repo: 'acme/widgets', integratedFiles: [], merge: true,
    exec: fakeExec({ calls: shipCalls }),
    authorEmailExec: async () => fail('not a repository'),
    commitScanExec: async () => fail('not a repository'),
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(normal.status, 'held', JSON.stringify(normal));
  assert.deepEqual(normal.warnings, [warningFor('600')]);
  assert.ok(!shipCalls.some(call => call.file === 'gh' && call.args[0] === 'pr' && call.args[1] === 'merge'));

  const direct = await preflightReport({
    root, payloadBase: 'main', body, integratedFiles: [], exec: fakeExec(),
    authorEmailExec: async () => fail('not a repository'),
    commitScanExec: async () => fail('not a repository'),
  });
  assert.equal(direct.ok, true);
  assert.deepEqual(direct.warnings, [warningFor('600')]);
});

test('L359 unavailable diffs are reported as unknown', async t => {
  const body = heldBody('The summary says 600 seconds.');
  const { root } = await shipFixture(t, body);
  const mergeBaseFailureCalls = [];
  assert.deepEqual(await collectDecisionValueWarnings(root, 'main', body, async (file, args) => {
    mergeBaseFailureCalls.push({ file, args });
    return fail('merge-base unavailable');
  }), [unavailable]);
  assert.equal(mergeBaseFailureCalls.length, 1);

  assert.deepEqual(await collectDecisionValueWarnings(root, 'main', body, async () => {
    throw new Error('transport failure');
  }), [unavailable]);

  assert.deepEqual(await collectDecisionValueWarnings(root, 'main', body, async (file, args) => {
    if (args[0] === 'merge-base') return ok('base-sha\n');
    return ok('');
  }), [warningFor('600')]);
});

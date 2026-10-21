import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ship, SHIP_DEFAULTS, CHECKS_PLACEHOLDER, SWARM_MARKER_RE,
  parsePrPayload, isHeld, missingSections, renderChecks, fillChecks, summarizeRollup,
} from '../tools/ship.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ship-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writePayload(root, payload) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify(payload));
  return file;
}

const payload = (fields = {}) => ({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text', ...fields });

// A fake exec that answers strictly in the order given (the "script"), and records every call.
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
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });
const clean = () => ok('');
const rev = sha => ok(`${sha}\n`);
const prJson = (overrides = {}) => JSON.stringify({ number: 7, html_url: 'https://example.com/pr/7', ...overrides });
const rollupView = (overrides = {}) => JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [], ...overrides });

function baseOptions(root, payloadPath, overrides = {}) {
  return {
    root, repo: 'acme/widgets', payloadPath,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
}

// A standard happy-path script through push + PR creation + one green poll, for tests that only
// care about what happens after that point (merge / held / ready / merge-failed).
function greenScript(extra = []) {
  return [
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
    // the merge guard reads the PR again right before merging
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
    ...extra,
  ];
}

test('parsePrPayload: happy path returns exactly the four fields', () => {
  const result = parsePrPayload(JSON.stringify(payload({ draft: true })));
  assert.deepEqual(result, { title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' });
});

test('parsePrPayload: allows draft and maintainer_can_modify but rejects other extra fields', () => {
  assert.doesNotThrow(() => parsePrPayload(JSON.stringify(payload({ draft: false, maintainer_can_modify: true }))));
  assert.throws(() => parsePrPayload(JSON.stringify(payload({ extra: 'nope' }))), Error);
});

test('parsePrPayload: throws on missing or blank required field', () => {
  const { title, ...missingTitle } = payload();
  assert.throws(() => parsePrPayload(JSON.stringify(missingTitle)), Error);
  assert.throws(() => parsePrPayload(JSON.stringify(payload({ head: '   ' }))), Error);
});

test('parsePrPayload: throws on invalid JSON', () => {
  assert.throws(() => parsePrPayload('{not json'), Error);
});

test('isHeld: true only when the first non-blank line starts with "**needs " exactly', () => {
  assert.equal(isHeld('**needs review\n\nrest'), true);
  assert.equal(isHeld('\n\n  **needs review'), true);
  assert.equal(isHeld('some text\n**needs review'), false);
  assert.equal(isHeld('**Needs review'), false);
  assert.equal(isHeld(''), false);
});

test('missingSections: absent heading, blank content, and placeholder-only content all count as missing', () => {
  const body = [
    '## Summary',
    'done',
    '## Mutation check',
    '',
    '## Test plan',
    CHECKS_PLACEHOLDER,
  ].join('\n');
  assert.deepEqual(missingSections(body, ['Summary', 'Mutation check', 'Test plan', 'Missing section']),
    ['Mutation check', 'Test plan', 'Missing section']);
});

test('missingSections: content up to the next heading counts, not the whole body', () => {
  const body = '## Section A\ncontent A\n## Section B\ncontent B';
  assert.deepEqual(missingSections(body, ['Section A', 'Section B']), []);
});

test('missingSections: a section holding only a swarm marker is missing', () => {
  const body = '## Mutation check\n<!-- swarm:mutants -->';
  assert.deepEqual(missingSections(body, ['Mutation check']), ['Mutation check']);
});

test('missingSections: a section with text and a leftover swarm marker is missing', () => {
  const body = '## Mutation check\nSome content\n<!-- swarm:mutants -->';
  assert.deepEqual(missingSections(body, ['Mutation check']), ['Mutation check']);
});

test('missingSections: a section with text and no marker passes', () => {
  const body = '## Mutation check\nSome content';
  assert.deepEqual(missingSections(body, ['Mutation check']), []);
});

test('missingSections: a non-swarm HTML comment does not count as a marker', () => {
  const body = '## Notes\n<!-- note -->\nSome content';
  assert.deepEqual(missingSections(body, ['Notes']), []);
});

test('missingSections: Checks section with CHECKS_PLACEHOLDER is missing', () => {
  const body = `## Checks\n${CHECKS_PLACEHOLDER}`;
  assert.deepEqual(missingSections(body, ['Checks']), ['Checks']);
});

test('renderChecks: passed/skipped omit exit code, failed shows exit code and up to last 20 tail lines', () => {
  const tail = Array.from({ length: 25 }, (_, i) => `line${i}`).join('\n');
  const rendered = renderChecks([
    { name: 'lint', status: 'passed', exitCode: 0, tail: '' },
    { name: 'slow', status: 'skipped', exitCode: null, tail: '' },
    { name: 'unit', status: 'failed', exitCode: 2, tail },
  ]);
  assert.match(rendered, /^```\n/);
  assert.match(rendered, /\nlint -> passed\n/);
  assert.match(rendered, /\nslow -> skipped\n/);
  assert.match(rendered, /unit -> failed \(exit 2\)\n/);
  assert.ok(rendered.includes('line5'));
  assert.ok(!rendered.includes('line4\n'));
  assert.match(rendered, /```$/);
});

test('fillChecks: replaces every placeholder occurrence, leaves body unchanged when absent', () => {
  const results = [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }];
  const filled = fillChecks(`a${CHECKS_PLACEHOLDER}b${CHECKS_PLACEHOLDER}c`, results);
  assert.equal((filled.match(/```/g) ?? []).length, 4);
  assert.equal(fillChecks('no placeholder here', results), 'no placeholder here');
});

test('summarizeRollup: CheckRun and StatusContext items, passing conclusions/states, pending, and failed names', () => {
  const rollup = [
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { name: 'slow', status: 'IN_PROGRESS', conclusion: null },
    { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
    { context: 'legacy-ci', state: 'SUCCESS' },
    { context: 'legacy-pending', state: 'PENDING' },
    { context: 'legacy-fail', state: 'ERROR' },
  ];
  assert.deepEqual(summarizeRollup(rollup), { total: 8, pending: 2, failed: ['unit', 'legacy-fail'], passed: 4 });
});

test('summarizeRollup: empty/missing rollup', () => {
  assert.deepEqual(summarizeRollup([]), { total: 0, pending: 0, failed: [], passed: 0 });
  assert.deepEqual(summarizeRollup(undefined), { total: 0, pending: 0, failed: [], passed: 0 });
});

test('ship: refuses an invalid repo before touching git', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([]);
  const result = await ship(baseOptions(root, payloadPath, { repo: 'not-a-repo', exec }));
  assert.equal(result.status, 'refused');
  assert.equal(calls.length, 0);
});

test('ship: refuses a head that starts with a dash', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload({ head: '-danger' }));
  const { exec, calls } = makeExec([]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(calls.length, 0);
});

test('ship: refuses an invalid payload without touching git', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, { title: 'x', head: 'h', base: 'main' });
  const { exec, calls } = makeExec([]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(calls.length, 0);
});

test('ship: refuses with "commit first" when the tree is dirty, and never pushes', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([ok('M dirty.txt\n')]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /^commit first/);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('ship: a failed check means checks-failed and nothing is pushed', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  const runChecks = async () => [{ name: 'unit', status: 'failed', exitCode: 1, tail: 'boom' }];
  const result = await ship(baseOptions(root, payloadPath, { exec, runChecks }));
  assert.equal(result.status, 'checks-failed');
  assert.deepEqual(result.checks, [{ name: 'unit', status: 'failed', exitCode: 1, tail: 'boom' }]);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('ship: refuses when a required section is missing after checks fill the placeholder', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload({ body: '## Summary\ndone' }));
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, { exec, requireSections: ['Mutation check'] }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Mutation check/);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('ship: refuses with marker name when a section holds only a swarm marker', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload({ body: '## Summary\ndone\n## Mutation check\n<!-- swarm:mutants -->' }));
  const { exec } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, { exec, requireSections: ['Mutation check'] }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Mutation check/);
  assert.match(result.reason, /mutants/);
});

test('ship: refuses with marker name when a section has text plus a leftover marker', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload({ body: '## Summary\ndone\n## Checks\nSome text\n<!-- swarm:mutants -->' }));
  const { exec } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, { exec, requireSections: ['Checks'] }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Checks/);
  assert.match(result.reason, /mutants/);
});

test('ship: refuses when the push fails, naming the step and stderr', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec([clean(), rev('sha123'), fail('no permission')]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'push failed: no permission');
});

test('ship: refuses an invalid mergeMethod before any exec ("admin" would bypass branch protection)', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([]);
  const result = await ship(baseOptions(root, payloadPath, { exec, mergeMethod: 'admin' }));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'invalid merge method');
  assert.equal(calls.length, 0);
});

test('ship: refuses a non-positive or non-finite pollMs/timeoutMs/noCiGraceMs before any exec', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  for (const overrides of [{ pollMs: 0 }, { timeoutMs: -1 }, { noCiGraceMs: NaN }, { pollMs: Infinity }]) {
    const { exec, calls } = makeExec([]);
    const result = await ship(baseOptions(root, payloadPath, { exec, ...overrides }));
    assert.equal(result.status, 'refused', JSON.stringify(overrides));
    assert.equal(calls.length, 0, JSON.stringify(overrides));
  }
});

test('ship: refuses when git rev-parse fails, and never pushes', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([clean(), fail('detached HEAD')]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'rev-parse failed: detached HEAD');
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('ship: refuses when the PR list call fails, without JSON.parse-ing its output', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec([clean(), rev('sha123'), clean(), fail('rate limited')]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'pr list failed: rate limited');
});

test('ship: refuses when the PR list call returns unparsable JSON', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec([clean(), rev('sha123'), clean(), ok('not json')]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /^pr list failed:/);
});

test('ship: refuses when creating a new PR fails', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec([clean(), rev('sha123'), clean(), ok('[]'), fail('validation failed')]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'pr create failed: validation failed');
});

test('ship: refuses when patching an existing PR fails', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec([
    clean(), rev('sha123'), clean(),
    ok(JSON.stringify([{ number: 3, html_url: 'https://example.com/pr/3' }])),
    fail('conflict'),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'pr update failed: conflict');
});

test('ship: patches an existing open PR instead of creating a duplicate', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([
    clean(), rev('sha123'), clean(),
    ok(JSON.stringify([{ number: 3, html_url: 'https://example.com/pr/3' }])),
    ok(prJson({ number: 3, html_url: 'https://example.com/pr/3' })),
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false }));
  assert.equal(result.status, 'ready');
  assert.equal(result.pr, 3);
  const prCalls = calls.filter(c => c.file === 'gh' && c.args[0] === 'api');
  assert.equal(prCalls.length, 2);
  assert.ok(prCalls[1].args.includes('PATCH'));
  assert.ok(prCalls[1].args.includes('repos/acme/widgets/pulls/3'));
});

test('ship: no-ci once the rollup stays empty past the grace period', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const emptyView = () => ok(rollupView({ statusCheckRollup: [] }));
  const { exec } = makeExec([
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    emptyView(), emptyView(), emptyView(),
  ]);
  let t2 = 0;
  const result = await ship(baseOptions(root, payloadPath, {
    exec, pollMs: 50, noCiGraceMs: 100, timeoutMs: 10_000,
    now: () => t2, sleep: async ms => { t2 += ms; },
  }));
  assert.equal(result.status, 'no-ci');
});

test('ship: timeout when checks stay pending past the timeout', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const pendingView = () => ok(rollupView({ statusCheckRollup: [{ name: 'slow', status: 'IN_PROGRESS', conclusion: null }] }));
  const { exec } = makeExec([
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    pendingView(), pendingView(), pendingView(),
  ]);
  let t2 = 0;
  const result = await ship(baseOptions(root, payloadPath, {
    exec, pollMs: 50, timeoutMs: 100, noCiGraceMs: 1_000_000,
    now: () => t2, sleep: async ms => { t2 += ms; },
  }));
  assert.equal(result.status, 'timeout');
});

test('ship: ci-failed names the failing checks once the rollup settles, and never merges', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] })),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'ci-failed');
  assert.deepEqual(result.ci.failed, ['unit']);
  assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge'));
});

test('ship: a failed or unparsable CI poll counts as pending and keeps waiting', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec([
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    fail('temporary API error'),
    ok('not json either'),
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false }));
  assert.equal(result.status, 'ready');
});

test('ship: timeout still fires when the CI poll keeps failing past timeoutMs', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec([
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    fail('down'), fail('down'), fail('down'),
  ]);
  let t2 = 0;
  const result = await ship(baseOptions(root, payloadPath, {
    exec, pollMs: 50, timeoutMs: 100, noCiGraceMs: 1_000_000,
    now: () => t2, sleep: async ms => { t2 += ms; },
  }));
  assert.equal(result.status, 'timeout');
});

test('ship: a held PR is never merged', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload({ body: '**needs a human to check the migration' }));
  const { exec, calls } = makeExec(greenScript());
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'held');
  assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge'));
});

test('ship: ready when merge is disabled, and merge is never called', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec(greenScript());
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false }));
  assert.equal(result.status, 'ready');
  assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge'));
});

test('ship: merges on a green build and --match-head-commit carries the pushed sha', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec(greenScript([
    ok(JSON.stringify({ code: 0 })),
    ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'merged-sha' } })),
  ]));
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'merged');
  assert.equal(result.mergeSha, 'merged-sha');
  assert.equal(result.sha, 'sha123');
  const mergeCall = calls.find(c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(mergeCall);
  assert.ok(mergeCall.args.includes('--match-head-commit'));
  assert.equal(mergeCall.args[mergeCall.args.indexOf('--match-head-commit') + 1], 'sha123');
});

test('ship: merge-failed when gh pr merge does not result in a MERGED state', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec(greenScript([
    ok(JSON.stringify({ code: 0 })),
    ok(JSON.stringify({ state: 'OPEN', mergeCommit: null })),
  ]));
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'merge-failed');
});

test('ship: merge-failed with the stderr line when gh pr merge itself fails, and no retry', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec(greenScript([fail('branch protection: required review')]));
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'merge-failed');
  assert.equal(result.reason, 'branch protection: required review');
  const mergeCalls = calls.filter(c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.equal(mergeCalls.length, 1);
});

test('ship: merge-failed when the post-merge view fails or is unparsable', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec(greenScript([ok(JSON.stringify({ code: 0 })), fail('not found')]));
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'merge-failed');
});

test('SHIP_DEFAULTS and CHECKS_PLACEHOLDER are frozen/stable', () => {
  assert.deepEqual(SHIP_DEFAULTS, { pollMs: 20_000, timeoutMs: 45 * 60_000, noCiGraceMs: 5 * 60_000, mergeMethod: 'squash' });
  assert.ok(Object.isFrozen(SHIP_DEFAULTS));
  assert.equal(CHECKS_PLACEHOLDER, '<!-- swarm:checks -->');
});

import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveQualityChecks, qualityChecksForJobs, qualityEvidence } from '../tools/quality-checks.mjs';

const namesOf = (checks) => checks.map((c) => c.name);

test('derive: no package and no tsconfig returns no checks', () => {
  assert.deepEqual(deriveQualityChecks({ pkg: null, hasTsconfig: false }), []);
});

test('derive: empty package object and no tsconfig returns no checks', () => {
  assert.deepEqual(deriveQualityChecks({ pkg: {}, hasTsconfig: false }), []);
});

test('derive: tsconfig alone yields npx tsc typecheck', () => {
  assert.deepEqual(deriveQualityChecks({ pkg: null, hasTsconfig: true }), [
    { name: 'typecheck', argv: ['npx', 'tsc', '--noEmit'] },
  ]);
});

test('derive: scripts.typecheck uses npm run by default', () => {
  const pkg = { scripts: { typecheck: 'tsc --noEmit' } };
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: true }), [
    { name: 'typecheck', argv: ['npm', 'run', 'typecheck'] },
  ]);
});

test('derive: scripts.typecheck uses the manager run command', () => {
  const pkg = { scripts: { typecheck: 'tsc' } };
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: false, manager: 'pnpm' }), [
    { name: 'typecheck', argv: ['pnpm', 'run', 'typecheck'] },
  ]);
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: false, manager: 'yarn' }), [
    { name: 'typecheck', argv: ['yarn', 'run', 'typecheck'] },
  ]);
});

test('derive: scripts type-check is also recognised as typecheck', () => {
  const out = deriveQualityChecks({ pkg: { scripts: { 'type-check': 'tsc' } }, hasTsconfig: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'typecheck');
  assert.equal(out[0].argv[out[0].argv.length - 1], 'type-check');
});

test('derive: scripts typecheck wins over tsconfig fallback', () => {
  const out = deriveQualityChecks({ pkg: { scripts: { typecheck: 'tsc' } }, hasTsconfig: true });
  assert.deepEqual(out, [{ name: 'typecheck', argv: ['npm', 'run', 'typecheck'] }]);
});

test('derive: scripts.lint yields a lint check with run command', () => {
  const out = deriveQualityChecks({ pkg: { scripts: { lint: 'eslint .' } }, hasTsconfig: false });
  assert.deepEqual(out, [{ name: 'lint', argv: ['npm', 'run', 'lint'] }]);
});

test('derive: order is typecheck, lint, build', () => {
  const pkg = { scripts: { build: 'x', lint: 'y', typecheck: 'z' } };
  const out = deriveQualityChecks({ pkg, hasTsconfig: false, config: { build: true } });
  assert.deepEqual(namesOf(out), ['typecheck', 'lint', 'build']);
});

test('derive: build is on by default when scripts.build exists; build false is the opt-out', () => {
  const pkg = { scripts: { build: 'vite build' } };
  const built = [{ name: 'build', argv: ['npm', 'run', 'build'] }];
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: false }), built);
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: false, config: {} }), built);
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: false, config: { build: false } }), []);
  assert.deepEqual(deriveQualityChecks({ pkg: { scripts: {} }, hasTsconfig: false }), [], 'no build script, no build check');
});

test('derive: build true uses scripts.build', () => {
  const pkg = { scripts: { build: 'vite build' } };
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: false, config: { build: true } }), [
    { name: 'build', argv: ['npm', 'run', 'build'] },
  ]);
});

test('derive: build true without scripts.build adds nothing', () => {
  const out = deriveQualityChecks({ pkg: { scripts: {} }, hasTsconfig: false, config: { build: true } });
  assert.deepEqual(out, []);
});

test('derive: build argv in config is used as given', () => {
  const out = deriveQualityChecks({
    pkg: { scripts: {} },
    hasTsconfig: false,
    config: { build: ['make', 'ci-build'] },
  });
  assert.deepEqual(out, [{ name: 'build', argv: ['make', 'ci-build'] }]);
});

test('derive: config argv replaces the detected typecheck', () => {
  const out = deriveQualityChecks({
    pkg: { scripts: { typecheck: 'tsc' } },
    hasTsconfig: true,
    config: { typecheck: ['make', 'check'] },
  });
  assert.deepEqual(out, [{ name: 'typecheck', argv: ['make', 'check'] }]);
});

test('derive: config argv replaces the detected lint', () => {
  const out = deriveQualityChecks({
    pkg: { scripts: { lint: 'eslint .' } },
    hasTsconfig: false,
    config: { lint: ['ruff', 'check'] },
  });
  assert.deepEqual(out, [{ name: 'lint', argv: ['ruff', 'check'] }]);
});

test('derive: config argv adds a typecheck with no detection', () => {
  const out = deriveQualityChecks({
    pkg: null,
    hasTsconfig: false,
    config: { typecheck: ['mypy', 'src'] },
  });
  assert.deepEqual(out, [{ name: 'typecheck', argv: ['mypy', 'src'] }]);
});

test('derive: false removes a detected check', () => {
  const pkg = { scripts: { typecheck: 'tsc', lint: 'eslint .' } };
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: true, config: { typecheck: false } }), [
    { name: 'lint', argv: ['npm', 'run', 'lint'] },
  ]);
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: true, config: { lint: false } }), [
    { name: 'typecheck', argv: ['npm', 'run', 'typecheck'] },
  ]);
});

test('derive: false removes tsconfig fallback typecheck', () => {
  assert.deepEqual(deriveQualityChecks({ pkg: null, hasTsconfig: true, config: { typecheck: false } }), []);
});

test('derive: only the three known names are ever returned', () => {
  const pkg = { scripts: { typecheck: 'a', lint: 'b', build: 'c', test: 'd', format: 'e' } };
  const out = deriveQualityChecks({ pkg, hasTsconfig: true, config: { build: true } });
  for (const name of namesOf(out)) {
    assert.ok(['typecheck', 'lint', 'build'].includes(name));
  }
  assert.equal(out.length, 3);
});

test('jobs: empty job list returns empty array', () => {
  const derived = [{ name: 'lint', argv: ['npm', 'run', 'lint'] }];
  assert.deepEqual(qualityChecksForJobs([], derived), []);
});

test('jobs: no build job returns empty array', () => {
  const derived = [{ name: 'lint', argv: ['npm', 'run', 'lint'] }];
  const jobs = [{ id: 'a', type: 'feature' }, { id: 'b', type: 'test' }];
  assert.deepEqual(qualityChecksForJobs(jobs, derived), []);
});

test('jobs: a build job maps derived checks with default timeout', () => {
  const derived = [
    { name: 'typecheck', argv: ['npm', 'run', 'typecheck'] },
    { name: 'lint', argv: ['npm', 'run', 'lint'] },
  ];
  const jobs = [{ id: 'a', type: 'feature' }, { id: 'b', type: 'build' }];
  // The typecheck also clears the framework's generated type files first (.next/types can name pages that no longer exist).
  assert.deepEqual(qualityChecksForJobs(jobs, derived), [
    { name: 'typecheck', argv: ['npm', 'run', 'typecheck'], timeoutMs: 600000, cleanDirs: ['.next/types'] },
    { name: 'lint', argv: ['npm', 'run', 'lint'], timeoutMs: 600000 },
  ]);
});

test('jobs: custom timeoutMs is applied to every check', () => {
  const derived = [{ name: 'lint', argv: ['x'] }];
  const jobs = [{ id: 'b', type: 'build' }];
  assert.deepEqual(qualityChecksForJobs(jobs, derived, { timeoutMs: 1234 }), [
    { name: 'lint', argv: ['x'], timeoutMs: 1234 },
  ]);
});

test('jobs: build job with empty derived list returns empty array', () => {
  assert.deepEqual(qualityChecksForJobs([{ id: 'b', type: 'build' }], []), []);
});

function stateWith(batches, integratedIn) {
  const mergeQueue = { batches };
  if (integratedIn !== undefined) mergeQueue.integratedIn = integratedIn;
  return { mergeQueue };
}

test('evidence: empty names returns ok with fixed reason', () => {
  assert.deepEqual(qualityEvidence(stateWith([]), 'j1', []), {
    ok: true,
    reason: 'no quality checks configured',
  });
});

test('evidence: passed batch with all named checks passed is ok', () => {
  const state = stateWith([
    {
      id: 'b1',
      jobs: ['j1'],
      checks: 'passed',
      checkResults: { typecheck: { status: 'passed' }, lint: { status: 'passed' } },
    },
  ]);
  const r = qualityEvidence(state, 'j1', ['typecheck', 'lint']);
  assert.equal(r.ok, true);
  assert.equal(typeof r.reason, 'string');
});

test('evidence: a check name not in names is not required', () => {
  const state = stateWith([
    {
      id: 'b1',
      jobs: ['j1'],
      checks: 'passed',
      checkResults: { lint: { status: 'passed' } },
    },
  ]);
  assert.equal(qualityEvidence(state, 'j1', ['lint']).ok, true);
});

test('evidence: missing check reports no ran in batch', () => {
  const state = stateWith([
    {
      id: 'b1',
      jobs: ['j1'],
      checks: 'passed',
      checkResults: { lint: { status: 'passed' } },
    },
  ]);
  const r = qualityEvidence(state, 'j1', ['typecheck']);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('no typecheck check ran in batch b1'));
});

test('evidence: failing check reports is failed in batch', () => {
  const state = stateWith([
    {
      id: 'b1',
      jobs: ['j1'],
      checks: 'passed',
      checkResults: { lint: { status: 'failed' } },
    },
  ]);
  const r = qualityEvidence(state, 'j1', ['lint']);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('lint check is failed in batch b1'));
});

test('evidence: first missing or failing name is the one reported', () => {
  const state = stateWith([
    {
      id: 'b1',
      jobs: ['j1'],
      checks: 'passed',
      checkResults: { typecheck: { status: 'failed' }, lint: { status: 'failed' } },
    },
  ]);
  const r = qualityEvidence(state, 'j1', ['typecheck', 'lint']);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('typecheck'));
});

test('evidence: batch checks not passed is not ok even if named checks passed', () => {
  const state = stateWith([
    {
      id: 'b1',
      jobs: ['j1'],
      checks: 'failed',
      checkResults: { lint: { status: 'passed' } },
    },
  ]);
  assert.equal(qualityEvidence(state, 'j1', ['lint']).ok, false);
});

test('evidence: no batch for the job is not ok', () => {
  const state = stateWith([
    { id: 'b1', jobs: ['other'], checks: 'passed', checkResults: { lint: { status: 'passed' } } },
  ]);
  const r = qualityEvidence(state, 'j1', ['lint']);
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, 'string');
});

test('evidence: empty batch list is not ok when names are required', () => {
  const r = qualityEvidence(stateWith([]), 'j1', ['lint']);
  assert.equal(r.ok, false);
});

test('evidence: integratedIn picks the named batch over a later one', () => {
  const state = stateWith(
    [
      { id: 'b1', jobs: ['j1'], checks: 'passed', checkResults: { lint: { status: 'passed' } } },
      { id: 'b2', jobs: ['j1'], checks: 'failed', checkResults: { lint: { status: 'failed' } } },
    ],
    { j1: 'b1' },
  );
  assert.equal(qualityEvidence(state, 'j1', ['lint']).ok, true);
});

test('evidence: without integratedIn the last batch containing the job is used', () => {
  const state = stateWith([
    { id: 'b1', jobs: ['j1'], checks: 'passed', checkResults: { lint: { status: 'passed' } } },
    { id: 'b2', jobs: ['j1'], checks: 'failed', checkResults: { lint: { status: 'failed' } } },
  ]);
  const r = qualityEvidence(state, 'j1', ['lint']);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('b2'));
});

test('evidence: job entries may be objects with an id', () => {
  const state = stateWith([
    {
      id: 'b1',
      jobs: [{ id: 'j1' }],
      checks: 'passed',
      checkResults: { lint: { status: 'passed' } },
    },
  ]);
  assert.equal(qualityEvidence(state, 'j1', ['lint']).ok, true);
});

test('evidence: null state with required names is not ok', () => {
  const r = qualityEvidence(null, 'j1', ['lint']);
  assert.equal(r.ok, false);
});

test('evidence: empty state with empty names is still ok', () => {
  assert.equal(qualityEvidence({}, 'j1', []).ok, true);
});

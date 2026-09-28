// SPDX-License-Identifier: Apache-2.0
// Unit coverage for tools/checks-from-ci.mjs, the pure engine behind field lesson #177's
// `ship --checks-from-ci`: reading a CI workflow's own `run:` steps into checks, skipping lines
// with a shell operator instead of guessing at them, and flagging a hand check CI does not run.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractRunLines, splitArgv, ciChecksFromWorkflowText, loadChecksFromCi, checkNotInCiWarnings, DEFAULT_CI_PATH } from '../tools/checks-from-ci.mjs';

describe('extractRunLines: a documented, line-based reader of a workflow\'s run: steps', () => {
  test('reads a one-line "- run: ..." step and an indented "run: ..." step under name:', () => {
    const yaml = [
      'steps:',
      '  - run: npm ci',
      '  - name: Lint',
      '    run: npm run lint',
    ].join('\n');
    assert.deepEqual(extractRunLines(yaml), ['npm ci', 'npm run lint']);
  });

  test('reads a "|" block scalar as separate lines, stopping at the first line indented back to the key\'s own level', () => {
    const yaml = [
      'steps:',
      '  - name: Format',
      '    run: |',
      '      ruff format --check .',
      '      echo done',
      '  - run: npm test',
    ].join('\n');
    assert.deepEqual(extractRunLines(yaml), ['ruff format --check .', 'echo done', 'npm test']);
  });

  test('a quoted one-line scalar has its outer quotes stripped', () => {
    assert.deepEqual(extractRunLines('steps:\n  - run: "npm test"'), ['npm test']);
    assert.deepEqual(extractRunLines("steps:\n  - run: 'npm test'"), ['npm test']);
  });

  test('a blank or non-run: line is ignored', () => {
    assert.deepEqual(extractRunLines('name: CI\non: [push]\njobs:\n  test:\n    steps: []\n'), []);
  });
});

describe('splitArgv: a minimal argv splitter for a single-command run: line', () => {
  test('splits on whitespace and keeps a quoted group as one token', () => {
    assert.deepEqual(splitArgv('uv run pytest'), ['uv', 'run', 'pytest']);
    assert.deepEqual(splitArgv('npm run lint -- --max-warnings 0'), ['npm', 'run', 'lint', '--', '--max-warnings', '0']);
    assert.deepEqual(splitArgv('eslint "src/**/*.ts"'), ['eslint', 'src/**/*.ts']);
  });
});

describe('ciChecksFromWorkflowText: (a) keeps known-program run: lines as checks, skips shell-operator lines', () => {
  test('keeps a plain checker/test-runner invocation as a check, in order, deduplicated', () => {
    const yaml = [
      'steps:',
      '  - run: npm ci',
      '  - run: ruff check .',
      '  - run: ruff check .', // duplicate of the line above
      '  - run: mypy --strict src/',
    ].join('\n');
    const { checks, skipped } = ciChecksFromWorkflowText(yaml);
    assert.deepEqual(checks.map(c => c.argv), [['npm', 'ci'], ['ruff', 'check', '.'], ['mypy', '--strict', 'src/']]);
    assert.deepEqual(skipped, []);
  });

  test('skips a shell-chained line (&&, |, >, ;) and names the reason, instead of splitting it', () => {
    const yaml = [
      'steps:',
      '  - run: npm ci && npm test',
      '  - run: pytest | tee out.log',
      '  - run: pytest > out.log',
      '  - run: npm ci; npm test',
    ].join('\n');
    const { checks, skipped } = ciChecksFromWorkflowText(yaml);
    assert.deepEqual(checks, []);
    assert.equal(skipped.length, 4);
    for (const entry of skipped) assert.equal(entry.reason, 'shell-operator');
  });

  test('ignores a run: line whose program is not a known checker/test-runner (e.g. a deploy script)', () => {
    const { checks } = ciChecksFromWorkflowText('steps:\n  - run: ./deploy.sh\n  - run: echo hi\n');
    assert.deepEqual(checks, []);
  });
});

describe('loadChecksFromCi: reads the workflow file relative to root, or reports it missing', () => {
  async function tmp(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checks-from-ci-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  test('reads the default path (.github/workflows/ci.yml) when present', async t => {
    const root = await tmp(t);
    await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await fs.writeFile(path.join(root, '.github/workflows/ci.yml'), 'steps:\n  - run: pytest\n');
    const result = await loadChecksFromCi(root);
    assert.equal(result.missing, false);
    assert.equal(result.path, DEFAULT_CI_PATH);
    assert.deepEqual(result.checks.map(c => c.argv), [['pytest']]);
  });

  test('reports missing:true (not a throw) when the workflow file does not exist', async t => {
    const root = await tmp(t);
    const result = await loadChecksFromCi(root);
    assert.equal(result.missing, true);
    assert.deepEqual(result.checks, []);
  });

  test('reads a custom path when given one', async t => {
    const root = await tmp(t);
    await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await fs.writeFile(path.join(root, '.github/workflows/format.yml'), 'steps:\n  - run: ruff format --check .\n');
    const result = await loadChecksFromCi(root, '.github/workflows/format.yml');
    assert.equal(result.missing, false);
    assert.deepEqual(result.checks.map(c => c.argv), [['ruff', 'format', '--check', '.']]);
  });
});

describe('checkNotInCiWarnings: (b) a hand check whose program+subcommand is not among CI\'s checks warns check-not-in-ci', () => {
  test('warns for a hand check with no matching program+subcommand in CI, ignoring trailing args', () => {
    const ciChecks = [{ name: 'ci-1', argv: ['uv', 'run', 'pytest'] }];
    const handChecks = [
      { name: 'check-1', argv: ['uv', 'run', 'pytest', '-k', 'slow'] }, // same program+subcommand, different trailing args: no warning
      { name: 'check-2', argv: ['npm', 'run', 'lint'] }, // not in CI at all: warns
    ];
    const warnings = checkNotInCiWarnings(handChecks, ciChecks);
    assert.deepEqual(warnings, ['check-not-in-ci: check-2 (npm run)']);
  });

  test('no warnings when every hand check\'s program+subcommand is also in CI', () => {
    const ciChecks = [{ name: 'ci-1', argv: ['pytest'] }, { name: 'ci-2', argv: ['ruff', 'check', '.'] }];
    const handChecks = [{ name: 'check-1', argv: ['pytest', '-x'] }, { name: 'check-2', argv: ['ruff', 'check', 'src/'] }];
    assert.deepEqual(checkNotInCiWarnings(handChecks, ciChecks), []);
  });
});

// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkManifestRules,
  runManifestReview,
  sha256Text,
} from '../tools/manifest-review.mjs';

const PINNED_CHECKOUT = 'actions/checkout@344945c6ba96b4e6c24de5b548063dc89b118b46';

function cleanWorkflow(extra = '') {
  return `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_CHECKOUT}
${extra}`;
}

describe('checkManifestRules', () => {
  const wf = '.github/workflows/ci.yml';

  it('refuses an unpinned action', () => {
    const findings = checkManifestRules(wf, cleanWorkflow().replace(PINNED_CHECKOUT, 'actions/checkout@v4'));
    assert.ok(findings.some(f => f.rule === 'unpinned-action'));
  });

  it('refuses a secret reference other than GITHUB_TOKEN', () => {
    const findings = checkManifestRules(
      wf,
      cleanWorkflow('        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}'),
    );
    assert.ok(findings.some(f => f.rule === 'secret-reference'));
  });

  it('refuses a deploy step', () => {
    const findings = checkManifestRules(wf, cleanWorkflow('      - run: npx vercel deploy --prod'));
    assert.ok(findings.some(f => f.rule === 'deploy-step'));
  });

  it('refuses pull_request_target', () => {
    const findings = checkManifestRules(
      wf,
      'on:\n  pull_request_target:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ' + PINNED_CHECKOUT,
    );
    assert.ok(findings.some(f => f.rule === 'pull-request-target'));
  });

  it('refuses a self-hosted runner', () => {
    const findings = checkManifestRules(wf, cleanWorkflow().replace('ubuntu-latest', 'self-hosted'));
    assert.ok(findings.some(f => f.rule === 'self-hosted-runner'));
  });

  it('refuses a major bump in package.json', () => {
    const prev = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { left: '^1.0.0' } });
    const next = JSON.stringify({ name: 'x', version: '2.0.0', dependencies: { left: '^1.0.0' } });
    const findings = checkManifestRules('package.json', next, { previousText: prev });
    assert.ok(findings.some(f => f.rule === 'major-bump'));
  });

  it('refuses an added install script', () => {
    const prev = JSON.stringify({ name: 'x', version: '1.0.0', scripts: {} });
    const next = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { postinstall: 'node x.js' } });
    const findings = checkManifestRules('package.json', next, { previousText: prev });
    assert.ok(findings.some(f => f.rule === 'install-script'));
  });

  it('refuses a git URL dependency', () => {
    const body = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: { evil: 'git+https://example.com/foo.git' },
    });
    const findings = checkManifestRules('package.json', body);
    assert.ok(findings.some(f => f.rule === 'non-registry-url'));
  });

  it('passes pre-check for a clean pinned workflow', () => {
    const findings = checkManifestRules(wf, cleanWorkflow());
    assert.equal(findings.length, 0);
  });
});

describe('runManifestReview', () => {
  it('fails when the reviewer answer is not strict JSON', async () => {
    const text = cleanWorkflow();
    const result = await runManifestReview({
      file: '.github/workflows/ci.yml',
      text,
      runId: 'run-a',
      reviewerRunId: 'review-run-a',
      reviewer: async () => 'not json',
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });
    assert.equal(result.pass, false);
    assert.ok(result.findings.some(f => f.rule === 'reviewer-json'));
  });

  it('passes with an injected passing reviewer after a clean pre-check', async () => {
    const text = cleanWorkflow();
    const result = await runManifestReview({
      file: '.github/workflows/ci.yml',
      text,
      runId: 'run-b',
      reviewerRunId: 'review-run-b',
      reviewer: async () => JSON.stringify({ pass: true, findings: [] }),
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });
    assert.equal(result.pass, true);
    assert.equal(result.hash, sha256Text(text));
  });
});

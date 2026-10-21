// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  checkManifestRules,
  runManifestReview,
  recordManifestReviewPass,
  readManifestReviewRecords,
  tryPolicyManifestApproval,
  manifestApproveActor,
  agentManifestApproveRefusalMessage,
  attemptManifestReviewForGate,
  sha256Text,
} from '../tools/manifest-review.mjs';
import { decide, effectiveRulesFromOverrides, DEFAULT_POLICY_FILE, policyPath } from '../tools/policy.mjs';
import { runPolicyPass } from '../tools/policy-run.mjs';
import { runSecurityGate, normalizePolicy } from '../tools/security-gate.mjs';
import { readJournal } from '../tools/journal.mjs';
import { isolatedHome } from './_isolate-config.mjs';

const PINNED_CHECKOUT = 'actions/checkout@344945c6ba96b4e6c24de5b548063dc89b118b46';
const NOW = () => Date.parse('2026-01-15T12:00:00Z');

function cleanWorkflow() {
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
`;
}

async function initPolicy(home) {
  const file = policyPath({ HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG }, home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(DEFAULT_POLICY_FILE, null, 2)}\n`, { mode: 0o600 });
  return file;
}

describe('manifest approval policy', () => {
  it('auto-approves with manifest-reviewed when a pass record exists and logs rule, reviewer run, and hash', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ma-pol-'));
    const home = isolatedHome;
    await initPolicy(home);
    const wf = '.github/workflows/ci.yml';
    const text = cleanWorkflow();
    const hash = sha256Text(text);
    const review = await runManifestReview({
      file: wf,
      text,
      runId: 'run-1',
      reviewerRunId: 'review-1',
      reviewer: async () => JSON.stringify({ pass: true, findings: [] }),
      now: NOW,
    });
    assert.equal(review.pass, true);
    await recordManifestReviewPass(root, review);
    const records = await readManifestReviewRecords(root);
    const rules = effectiveRulesFromOverrides([]);
    const facts = {
      file: wf,
      sha256: hash,
      manifestReviewPassed: true,
      reviewerRunId: 'review-1',
    };
    const decision = decide({ id: 'ma-1', kind: 'manifest-approval', project: 'proj', facts }, { rules, now: NOW });
    assert.equal(decision.decision, 'auto-approve');
    assert.equal(decision.rule, 'manifest-reviewed');

    const journal = [];
    const applied = [];
    await runPolicyPass({
      root,
      items: [{ id: 'ma-1', kind: 'manifest-approval', project: 'proj', facts }],
      rules,
      factsOf: item => item.facts ?? {},
      apply: async () => { applied.push(1); },
      journal: e => journal.push(e),
      events: () => {},
      readHandled: () => [],
      now: NOW,
    });
    assert.equal(applied.length, 1);
    assert.equal(journal[0].rule, 'manifest-reviewed');
    assert.equal(journal[0].reviewerRunId, 'review-1');
    assert.equal(journal[0].sha256, hash);
    await rm(root, { recursive: true, force: true });
  });

  it('does not auto-approve without a policy file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ma-nopol-'));
    const home = await mkdtemp(path.join(os.tmpdir(), 'ma-nopol-home-'));
    const env = { HOME: home, SWARM_CONFIG: path.join(home, 'config.json') };
    const text = cleanWorkflow();
    const hash = sha256Text(text);
    const review = await runManifestReview({
      file: '.github/workflows/ci.yml',
      text,
      runId: 'run-2',
      reviewerRunId: 'review-2',
      reviewer: async () => JSON.stringify({ pass: true, findings: [] }),
      now: NOW,
    });
    await recordManifestReviewPass(root, review);
    const records = await readManifestReviewRecords(root);
    const pol = await tryPolicyManifestApproval({
      root,
      file: '.github/workflows/ci.yml',
      sha256: hash,
      project: 'proj',
      env,
      home,
      fsImpl: fs,
      now: NOW,
      records,
    });
    assert.equal(pol.approved, false);
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('refuses integrate gate approval when file bytes change after review', async () => {
    const text = cleanWorkflow();
    const changed = `${text}\n`;
    const hash = sha256Text(text);
    const pol = normalizePolicy({
      approvedManifests: [{ file: '.github/workflows/ci.yml', sha256: hash }],
    });
    const gate = await runSecurityGate({
      changes: [{ file: '.github/workflows/ci.yml', bytes: Buffer.from(changed), previous: null }],
      policy: pol,
      exec: async () => { throw new Error('missing'); },
      fetchImpl: async () => { throw new Error('no fetch'); },
      now: NOW,
      cwd: process.cwd(),
      sensitive: false,
      codeScan: 'off',
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blocks.some(b => b.check === 'unsupported-manifest'));
  });

  it('agent session cannot use owner approve-manifest (owner terminal still could)', () => {
    assert.equal(
      manifestApproveActor({ CLAUDECODE: '1' }, { stdinIsTTY: true, stdoutIsTTY: true }),
      'agent-session',
    );
    assert.equal(
      manifestApproveActor({}, { stdinIsTTY: true, stdoutIsTTY: true }),
      'owner-terminal',
    );
    assert.match(agentManifestApproveRefusalMessage(), /manifest review/);
  });

  it('failed review creates an owner inbox item with findings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ma-inbox-'));
    await mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    const bad = cleanWorkflow().replace(PINNED_CHECKOUT, 'actions/checkout@v4');
    assert.ok(checkManifestRules('.github/workflows/ci.yml', bad).length > 0);
    const review = await runManifestReview({
      file: '.github/workflows/ci.yml',
      text: bad,
      runId: 'run-3',
      reviewerRunId: 'review-3',
      reviewer: async () => JSON.stringify({ pass: true, findings: [] }),
      now: NOW,
    });
    assert.equal(review.pass, false);
    const { createManifestReviewInboxItem } = await import('../tools/manifest-review.mjs');
    await createManifestReviewInboxItem(root, review, {
      appendEvent: async (r, ev) => {
        const file = path.join(r, '.swarm', 'project', 'journal.ndjson');
        await writeFile(file, `${JSON.stringify(ev)}\n`, { flag: 'a' });
      },
    });
    const journal = await readJournal(root, { limit: Infinity });
    const human = journal.find(e => e.kind === 'human');
    assert.ok(human);
    assert.match(human.text, /unpinned-action|manifest review failed/);
    await rm(root, { recursive: true, force: true });
  });

  it('attemptManifestReviewForGate approves a clean workflow when policy is initialized', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ma-gate-'));
    const home = isolatedHome;
    const env = { HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG };
    await initPolicy(home);
    await mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    const wf = '.github/workflows/ci.yml';
    const text = cleanWorkflow();
    const bytes = Buffer.from(text);
    const blocks = [{
      check: 'unsupported-manifest',
      severity: 'high',
      message: `${wf} changed: ci workflow dependencies are not parsed yet`,
      path: wf,
    }];
    const resolved = await attemptManifestReviewForGate({
      root,
      changes: [{ file: wf, bytes, previous: null }],
      blocks,
      policy: normalizePolicy({}),
      runId: 'run-4',
      reviewerRunId: 'review-4',
      reviewer: async () => JSON.stringify({ pass: true, findings: [] }),
      env,
      home,
      fsImpl: fs,
      now: NOW,
      appendEvent: async (r, ev) => {
        const file = path.join(r, '.swarm', 'project', 'journal.ndjson');
        await writeFile(file, `${JSON.stringify(ev)}\n`, { flag: 'a' });
      },
      persistAutoDecision: async () => true,
    });
    assert.equal(resolved.blocks.length, 0);
    const records = await readManifestReviewRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].sha256, sha256Text(text));
    await rm(root, { recursive: true, force: true });
  });
});

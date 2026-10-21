import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewTierForTicket,
  pickReviewTier,
  sensitiveReviewReason,
} from '../tools/review-tier.mjs';
import { batchReviewItems, isSmallLowRiskTicket } from '../tools/review-batch.mjs';
import {
  applyManifestReviewGate,
  batchAcceptanceReviewItems,
  isLowRiskBatchable,
  SECURITY_REVIEW_MODELS,
  ACCEPTANCE_REVIEW_MODELS,
  buildAcceptanceReviewManifest,
} from '../tools/manifest-review-gate.mjs';

test('AC1: Haiku tier for tests-only ticket paths', () => {
  const ticket = {
    id: 'T-test',
    type: 'test',
    files: [],
    tests: ['tests/foo.test.mjs'],
    risk: 'low',
  };
  const tier = reviewTierForTicket(ticket);
  assert.equal(tier.model, 'haiku');
  assert.equal(tier.tier, 'cheap');
  assert.match(tier.tierReason, /Tests and docs/i);
});

test('AC1: Haiku tier for docs-only paths', () => {
  const ticket = {
    id: 'T-docs',
    type: 'docs',
    files: ['docs/guide.md'],
    risk: 'low',
  };
  const tier = reviewTierForTicket(ticket);
  assert.equal(tier.model, 'haiku');
});

test('AC1: Sonnet tier for normal application code', () => {
  const ticket = {
    id: 'T-code',
    type: 'build',
    files: ['src/widgets/panel.tsx'],
    risk: 'low',
  };
  const tier = reviewTierForTicket(ticket);
  assert.equal(tier.model, 'sonnet');
  assert.equal(tier.tier, 'mid');
  assert.match(tier.tierReason, /Normal code/i);
});

test('AC1: Opus tier for auth-sensitive paths', () => {
  const ticket = {
    id: 'T-auth',
    type: 'build',
    files: ['src/auth/session.ts'],
    risk: 'low',
  };
  assert.ok(sensitiveReviewReason(ticket));
  const tier = reviewTierForTicket(ticket);
  assert.equal(tier.model, 'opus');
  assert.equal(tier.tier, 'expensive');
});

test('AC1: Opus tier for high-risk tickets', () => {
  const ticket = {
    id: 'T-high',
    type: 'build',
    files: ['src/util.ts'],
    risk: 'high',
  };
  const tier = reviewTierForTicket(ticket);
  assert.equal(tier.model, 'opus');
  assert.match(tier.tierReason, /High-risk/i);
});

test('AC1: pickReviewTier uses strongest tier in a batch', () => {
  const haiku = reviewTierForTicket({
    id: 'A',
    type: 'test',
    tests: ['tests/a.test.mjs'],
    risk: 'low',
  });
  const opus = reviewTierForTicket({
    id: 'B',
    type: 'build',
    files: ['src/api/route.ts'],
    risk: 'low',
  });
  assert.equal(haiku.model, 'haiku');
  assert.equal(opus.model, 'opus');
  const picked = pickReviewTier([
    { id: 'A', type: 'test', tests: ['tests/a.test.mjs'], risk: 'low' },
    { id: 'B', type: 'build', files: ['src/api/route.ts'], risk: 'low' },
  ]);
  assert.equal(picked.model, 'opus');
});

test('AC2: batchReviewItems groups small low-risk tickets into one shared batch', () => {
  const small = (id) => ({
    ticket: { id, type: 'build', risk: 'low', size: 'S', files: ['tools/a.mjs'] },
  });
  const large = {
    ticket: { id: 'T-big', type: 'build', risk: 'low', size: 'M', files: ['src/big.ts'] },
  };
  const batches = batchReviewItems([small('T-1'), small('T-2'), large]);
  assert.equal(batches.length, 2);
  const shared = batches.find((b) => b.length === 2);
  const solo = batches.find((b) => b.length === 1);
  assert.ok(shared);
  assert.ok(solo);
  assert.equal(solo[0].ticket.id, 'T-big');
  assert.deepEqual(shared.map((i) => i.ticket.id), ['T-1', 'T-2']);
});

test('AC2: isSmallLowRiskTicket rejects sensitive and opus-tier tickets', () => {
  const ok = { id: 'T-ok', type: 'build', risk: 'low', size: 'S', files: ['tools/x.mjs'] };
  assert.equal(isSmallLowRiskTicket(ok), true);
  assert.equal(isSmallLowRiskTicket({ ...ok, sensitive: true }), false);
  assert.equal(isSmallLowRiskTicket({ ...ok, files: ['src/auth/login.ts'] }), false);
  assert.equal(isSmallLowRiskTicket({ ...ok, size: 'M' }), false);
});

test('AC2: batchAcceptanceReviewItems batches low-risk S tickets then one per rest', () => {
  const batchable = (id) => ({
    ticket: { id, type: 'build', risk: 'low', size: 'S', files: ['tools/x.mjs'] },
    uncovered: ['line'],
  });
  const solo = {
    ticket: { id: 'T-solo', type: 'build', risk: 'medium', size: 'S', files: ['src/y.ts'] },
    uncovered: ['line'],
  };
  assert.equal(isLowRiskBatchable(batchable('T-a').ticket), true);
  assert.equal(isLowRiskBatchable(solo.ticket), false);
  const batches = batchAcceptanceReviewItems([batchable('T-a'), batchable('T-b'), solo]);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 2);
  assert.deepEqual(batches[0].map((i) => i.ticket.id), ['T-a', 'T-b']);
  assert.equal(batches[1].length, 1);
  assert.equal(batches[1][0].ticket.id, 'T-solo');
});

test('AC3: applyManifestReviewGate sets sec-review jobs to Opus like ledger sync', () => {
  const ledger = {
    tickets: [
      { id: 'T-001', type: 'build', risk: 'low', size: 'S', files: ['tools/a.mjs'] },
    ],
  };
  const manifest = {
    version: 1,
    jobs: [
      { id: 'T-001', type: 'build' },
      {
        id: 'sec-review-T-001',
        type: 'review',
        model: 'haiku',
        agent: 'auto',
      },
    ],
  };
  applyManifestReviewGate(manifest, { ledger });
  const sec = manifest.jobs.find((j) => j.id === 'sec-review-T-001');
  assert.equal(sec.model, 'opus');
  assert.equal(sec.tier, 'expensive');
  assert.equal(sec.agent, 'claude');
  assert.match(sec.tierReason, /security review/i);
});

test('AC3: applyManifestReviewGate applies ledger acceptance tier to acc-review jobs', () => {
  const ledger = {
    tickets: [
      {
        id: 'T-002',
        type: 'test',
        risk: 'low',
        size: 'S',
        files: [],
        tests: ['tests/review-tier-batch.test.mjs'],
      },
    ],
  };
  const manifest = {
    version: 1,
    jobs: [
      { id: 'T-002', type: 'test' },
      { id: 'acc-review-wave', type: 'review', model: 'sonnet', agent: 'auto' },
    ],
  };
  applyManifestReviewGate(manifest, { ledger });
  const acc = manifest.jobs.find((j) => j.id === 'acc-review-wave');
  assert.equal(acc.model, 'haiku');
  assert.equal(acc.tier, 'cheap');
});

test('AC3: manifest review model patterns match scope sync acceptance and security kinds', () => {
  assert.equal(SECURITY_REVIEW_MODELS.test('opus'), true);
  assert.equal(SECURITY_REVIEW_MODELS.test('sonnet'), false);
  assert.equal(ACCEPTANCE_REVIEW_MODELS.test('haiku'), true);
  assert.equal(ACCEPTANCE_REVIEW_MODELS.test('sonnet'), true);
  assert.equal(ACCEPTANCE_REVIEW_MODELS.test('opus'), true);
  assert.equal(ACCEPTANCE_REVIEW_MODELS.test('gpt'), false);
});

test('AC3: buildAcceptanceReviewManifest picks tier from batched tickets like ledger gate', () => {
  const ledger = {
    tickets: [
      { id: 'T-a', type: 'test', tests: ['tests/a.test.mjs'], risk: 'low', size: 'S' },
      { id: 'T-b', type: 'test', tests: ['tests/b.test.mjs'], risk: 'low', size: 'S' },
    ],
  };
  const items = [
    { ticket: ledger.tickets[0], uncovered: [] },
    { ticket: ledger.tickets[1], uncovered: [] },
  ];
  const manifest = buildAcceptanceReviewManifest('run-1', items, ledger);
  const reviewJobs = (manifest.jobs ?? []).filter((j) => j.type === 'review');
  assert.ok(reviewJobs.length >= 1);
  for (const job of reviewJobs) {
    assert.equal(job.model, 'haiku');
    assert.equal(job.tier, 'cheap');
  }
});

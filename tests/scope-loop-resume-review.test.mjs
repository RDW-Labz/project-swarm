// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scopeLoop } from '../tools/scope-loop.mjs';
import { loadReviewManifest, readReviewManifest, reviewManifestPathError } from '../tools/acceptance.mjs';

const git = (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });

const ticket = (id, extra = {}) => ({
  id,
  title: id,
  type: 'build',
  status: 'review',
  acceptance: ['output is present'],
  files: [`src/${id}.mjs`],
  tests: [],
  context: [`src/${id}.mjs`],
  ...extra,
});

async function repo(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-review-'));
  const root = path.join(parent, 'repo');
  await fs.mkdir(root);
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
  assert.equal(git(root, 'add', 'README.md').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'seed').status, 0);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}

test('readReviewManifest names the file when JSON is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-review-missing-'));
  const file = '.swarm/acceptance-reviews/missing.json';
  await assert.rejects(
    () => readReviewManifest(root, file),
    err => err.message === reviewManifestPathError(file),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('resume writes an acceptance review manifest before starting review', async t => {
  const root = await repo(t);
  const id = 'T-9001';
  await fs.mkdir(path.dirname(path.join(root, `src/${id}.mjs`)), { recursive: true });
  await fs.writeFile(path.join(root, `src/${id}.mjs`), `// ${id}\n`);
  const tickets = [ticket(id)];
  const reviewCalls = [];
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => { throw Object.assign(new Error('no ready tickets'), { code: 'scope-nothing' }); },
    ledger: async () => ({ tickets }),
    review: async (kind, file) => {
      await loadReviewManifest(root, file);
      reviewCalls.push({ kind, file });
      return { runId: 'review-9001' };
    },
    record: async () => {
      tickets[0].status = 'done';
    },
    log: () => {},
  };
  const out = await scopeLoop({ deps, root });
  assert.equal(out.status, 'complete');
  assert.equal(reviewCalls.length, 1);
  assert.ok(reviewCalls[0].file.startsWith('.swarm/acceptance-reviews/resume-'));
  await loadReviewManifest(root, reviewCalls[0].file);
});

test('resume parks a ticket after two manifest start failures', async t => {
  const root = await repo(t);
  const id = 'T-9002';
  await fs.mkdir(path.dirname(path.join(root, `src/${id}.mjs`)), { recursive: true });
  await fs.writeFile(path.join(root, `src/${id}.mjs`), `// ${id}\n`);
  const tickets = [ticket(id, { reviewStartFailCount: 1 })];
  const manifestError = new Error(reviewManifestPathError('.swarm/acceptance-reviews/resume-1-T-9002.json'));
  manifestError.code = 'review-manifest';
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => { throw Object.assign(new Error('no ready tickets'), { code: 'scope-nothing' }); },
    ledger: async () => ({ tickets }),
    review: async () => { throw manifestError; },
    record: async () => {},
    log: () => {},
  };
  const out = await scopeLoop({ deps, root });
  assert.equal(tickets[0].status, 'blocked');
  assert.match(tickets[0].blockNote, /review manifest .swarm\/acceptance-reviews\/resume-1-T-9002\.json is missing or not valid JSON/);
  assert.equal(out.summary.blocked, 1);
  assert.equal(out.summary.review, 0);
});

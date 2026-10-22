// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJournal } from '../tools/journal.mjs';
import { rollbackOffer, formatRollbackCommand } from '../tools/deploy-rollback.mjs';
import {
  WATCH_WINDOW_MS,
  POLL_INTERVAL_MS,
  mergeThatDeploys,
  startDeployWatch,
  runDeployWatchWindow,
  buildWatchState,
  readDeployWatchState,
  rollbackOffer as rollbackOfferReexport,
} from '../tools/deploy-watch.mjs';

const SHA = '0123456789abcdef0123456789ab';
const REPO = 'acme/web';

const handoffDeploys = {
  deploy: ['npm', 'run', 'deploy'],
  rollback: ['npm', 'run', 'rollback'],
  previewUrl: 'https://app.example.com',
  previewHosts: ['app.example.com'],
};

const tempRoot = async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-watch-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

function virtualClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

function okExec() {
  return async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api') {
      return { code: 0, stdout: JSON.stringify({ state: 'success' }), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
}

function fetchResponse(status, bodyText = 'ok') {
  const bytes = new TextEncoder().encode(bodyText);
  let consumed = false;
  return {
    status,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: async () => {
            if (consumed) return { done: true };
            consumed = true;
            return { done: false, value: bytes };
          },
          cancel: async () => {},
        };
      },
    },
  };
}

function okFetch() {
  return async () => fetchResponse(200);
}

function okPullErrors() {
  return async () => ({ events: [], lines: 0 });
}

test('mergeThatDeploys reflects handoff.deploy configuration', () => {
  assert.equal(mergeThatDeploys(handoffDeploys), true);
  assert.equal(mergeThatDeploys({ previewUrl: 'https://x.test', previewHosts: ['x.test'] }), false);
  assert.equal(mergeThatDeploys(null), false);
});

test('rollbackOffer is re-exported from deploy-watch', () => {
  assert.equal(rollbackOfferReexport, rollbackOffer);
});

test('formatRollbackCommand quotes unsafe argv parts for display', () => {
  assert.equal(formatRollbackCommand(['npm', 'run', 'rollback']), 'npm run rollback');
  assert.equal(formatRollbackCommand(['echo', 'hello world']), "echo 'hello world'");
  assert.equal(formatRollbackCommand(["it's"]), "'it'\\''s'");
  assert.equal(formatRollbackCommand([]), '');
});

test('rollbackOffer with rollback argv and without', () => {
  const withCmd = rollbackOffer(handoffDeploys, 'health-http-500');
  assert.equal(withCmd.offered, true);
  assert.deepEqual(withCmd.argv, ['npm', 'run', 'rollback']);
  assert.match(withCmd.guidance, /npm run rollback/);
  assert.match(withCmd.guidance, /health-http-500/);

  const bare = rollbackOffer({ deploy: ['x'] }, 'watch-check-failed');
  assert.equal(bare.offered, false);
  assert.equal(bare.argv, null);
  assert.match(bare.guidance, /profile\.handoff\.rollback/);
});

test('startDeployWatch skips when merge does not deploy', async (t) => {
  const root = await tempRoot(t);
  const clock = virtualClock();
  const out = await startDeployWatch(
    root,
    { pr: 1, repo: REPO, sha: SHA, handoffConfig: { previewUrl: 'https://a.test', previewHosts: ['a.test'] } },
    { now: clock.now },
  );
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'merge-does-not-deploy');
  assert.equal(await readDeployWatchState(root), null);
});

test('full watch window passes after fifteen ticks when deploy, health and errors stay ok', async (t) => {
  const root = await tempRoot(t);
  const clock = virtualClock();
  const started = await startDeployWatch(
    root,
    {
      pr: 42,
      repo: REPO,
      sha: SHA,
      handoffConfig: handoffDeploys,
      runWindow: true,
    },
    {
      now: clock.now,
      sleep: clock.sleep,
      exec: okExec(),
      fetchImpl: okFetch(),
      pullErrorsImpl: okPullErrors(),
    },
  );
  assert.equal(started.status, 'passed');
  assert.equal(started.state.ticks, WATCH_WINDOW_MS / POLL_INTERVAL_MS);
  assert.equal(started.state.status, 'passed');

  const onDisk = await readDeployWatchState(root);
  assert.equal(onDisk.status, 'passed');

  const journal = await readJournal(root);
  const passedCp = journal.filter((e) => e.kind === 'checkpoint' && e.id === 'deploy-watch' && e.phase === 'passed');
  assert.equal(passedCp.length, 1);
  assert.equal(passedCp[0].ticks, 15);
});

test('failing health check ends watch with rollback guidance and journal human entry', async (t) => {
  const root = await tempRoot(t);
  const clock = virtualClock();
  const state = buildWatchState({ pr: 1, repo: REPO, sha: SHA, startedAtMs: clock.now() });
  const badFetch = async () => fetchResponse(503, '');
  const finished = await runDeployWatchWindow(root, {
    state,
    handoffConfig: handoffDeploys,
    sleep: clock.sleep,
    now: clock.now,
    exec: okExec(),
    fetchImpl: badFetch,
    pullErrorsImpl: okPullErrors(),
  });
  assert.equal(finished.status, 'failed');
  assert.match(finished.rollback.reason, /health-http-503/);
  assert.deepEqual(finished.rollback.argv, handoffDeploys.rollback);
  assert.match(finished.rollback.guidance, /npm run rollback/);

  const journal = await readJournal(root);
  const human = journal.filter((e) => e.kind === 'human' && e.id === `deploy-watch-${SHA}`);
  assert.equal(human.length, 1);
  assert.equal(human[0].text, finished.rollback.guidance);

  const onDisk = await readDeployWatchState(root);
  assert.equal(onDisk.status, 'failed');
  assert.equal(onDisk.rollbackOffer.guidance, finished.rollback.guidance);
});

test('failing deploy status ends watch as failed', async (t) => {
  const root = await tempRoot(t);
  const clock = virtualClock();
  const state = buildWatchState({ pr: 1, repo: REPO, sha: SHA, startedAtMs: clock.now() });
  const failExec = async () => ({
    code: 0,
    stdout: JSON.stringify({ state: 'failure' }),
    stderr: '',
  });
  const finished = await runDeployWatchWindow(root, {
    state,
    handoffConfig: handoffDeploys,
    sleep: clock.sleep,
    now: clock.now,
    exec: failExec,
    fetchImpl: okFetch(),
    pullErrorsImpl: okPullErrors(),
  });
  assert.equal(finished.status, 'failed');
  assert.match(finished.rollback.reason, /github-status-failure/);
});

test('new production error log spike ends watch as failed', async (t) => {
  const root = await tempRoot(t);
  const clock = virtualClock();
  const startedAtMs = clock.now();
  const state = buildWatchState({ pr: 1, repo: REPO, sha: SHA, startedAtMs });
  const pullErrorsImpl = async () => ({
    events: [{ at: startedAtMs, message: 'boom' }],
    lines: 1,
  });
  const finished = await runDeployWatchWindow(root, {
    state,
    handoffConfig: handoffDeploys,
    sleep: clock.sleep,
    now: clock.now,
    exec: okExec(),
    fetchImpl: okFetch(),
    pullErrorsImpl,
  });
  assert.equal(finished.status, 'failed');
  assert.match(finished.rollback.reason, /production-errors-1/);
});

test('failure without rollback configured asks owner to set profile.handoff.rollback', async (t) => {
  const root = await tempRoot(t);
  const clock = virtualClock();
  const handoffNoRollback = {
    deploy: ['npm', 'run', 'deploy'],
    previewUrl: 'https://app.example.com',
    previewHosts: ['app.example.com'],
  };
  const state = buildWatchState({ pr: 1, repo: REPO, sha: SHA, startedAtMs: clock.now() });
  const finished = await runDeployWatchWindow(root, {
    state,
    handoffConfig: handoffNoRollback,
    sleep: clock.sleep,
    now: clock.now,
    exec: async () => ({ code: 0, stdout: JSON.stringify({ state: 'error' }), stderr: '' }),
    fetchImpl: okFetch(),
    pullErrorsImpl: okPullErrors(),
  });
  assert.equal(finished.rollback.offered, false);
  assert.match(finished.rollback.guidance, /profile\.handoff\.rollback/);
  const journal = await readJournal(root);
  assert.equal(journal.filter((e) => e.kind === 'human').length, 1);
});

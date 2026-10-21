// SPDX-License-Identifier: Apache-2.0
// T-0223: R-039 — Visual QA screenshot attach and lessons keeper close loop.

import '../_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { lessonPath } from '../../tools/lesson-schema.mjs';
import { writeLesson } from '../../tools/lesson-store.mjs';
import {
  createManagerActionModeSettings,
  enableManagerActionAuto,
  setManagerActionMode,
} from '../../tools/managers/modes.mjs';
import { MANAGER_ACTION_GROUPS } from '../../tools/managers/registry.mjs';
import {
  LESSONS_KEEPER_MANAGER_ID,
  VISUAL_QA_MANAGER_ID,
  registry,
  visualLessonsManagerIds,
} from '../../tools/managers/register/visual-lessons.mjs';
import { closeLoggedLesson, landedPathsFromDraftRef } from '../../tools/managers/lessons/close.mjs';
import { readLoggedLessonFile } from '../../tools/managers/lessons/draft.mjs';
import {
  lessonKeeperFindingFromCloseResult,
  runBuiltinManager as runLessonsKeeper,
} from '../../tools/managers/lessons/index.mjs';
import { runBuiltinManager as runVisualQa } from '../../tools/managers/visual-qa/index.mjs';
import { buildPrCommentBody, attachScreenshotsToPullRequest } from '../../tools/managers/visual-qa/pr-attach.mjs';
import {
  VISUAL_QA_DESKTOP_VIEWPORT,
  VISUAL_QA_PHONE_VIEWPORT,
  VISUAL_QA_VIEWPORT_NAMES,
  captureAndAttachVisualQaScreenshots,
  captureScreenshotsForChangedPages,
  visualQaViewports,
} from '../../tools/managers/visual-qa/screenshots.mjs';

/**
 * @returns {Promise<number>}
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {number} port
 * @returns {Promise<http.Server>}
 */
function listenOk(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.end('ok');
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * @returns {Promise<string>}
 */
async function mkRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'swarm-r039-'));
}

/**
 * @param {string} root
 * @param {{ port: number }} options
 */
async function writeUiProfile(root, { port }) {
  await fs.mkdir(path.join(root, 'docs/design/screens'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/design/screens/page.html'), '<html></html>');
  const profile = {
    sensitive: false,
    acceptance: { enforce: false },
    protectedPaths: [],
    budget: { maxUsd: 5 },
    baseCheck: { status: 'none', ranAt: null, head: null, checks: [] },
    ui: {
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutSec: 30,
      screens: [{ id: 'home-page', route: '/', mockup: 'docs/design/screens/page.html' }],
    },
  };
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile }));
}

/**
 * @param {import('../../tools/managers/modes.mjs').ManagerId} managerId
 * @param {string} action
 */
function autoModeFor(managerId, action) {
  const modeSettings = createManagerActionModeSettings();
  enableManagerActionAuto(modeSettings, managerId, action);
  setManagerActionMode(modeSettings, managerId, action, 'auto');
  return modeSettings;
}

/** @param {Record<string, unknown>} [over] */
function keeperLesson(over = {}) {
  return {
    version: 1,
    id: 'L-9901',
    project: 'keeptest',
    date: '2026-10-15',
    stage: 'build',
    what: 'A worker returned without running the ticket tests.',
    rule: 'Run the declared ticket tests before finishing the job.',
    caughtBy: 'review',
    cost: { retries: 0, minutes: 0, usd: 0 },
    laneModel: null,
    fix: 'Add a contract test that fails when checks are skipped.',
    guard: { kind: 'contract-test', text: '', status: 'proposed' },
    tags: ['test', 'review'],
    source: { kind: 'manual', ref: 'r039-fixture' },
    ...over,
  };
}

/**
 * @param {{ captures: object[], out: string }} input
 */
async function mockVisualBrowser({ captures, out }) {
  const results = [];
  for (const capture of captures) {
    const entry = { id: capture.id, key: capture.key, shots: {} };
    for (const viewport of capture.viewports) {
      const file = path.join(out, capture.id, capture.key, `${viewport.name}.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      entry.shots[viewport.name] = { file, ok: true };
    }
    results.push(entry);
  }
  return results;
}

test('AC1: visual QA registry exposes phone and desktop screenshot attach actions', () => {
  assert.deepEqual(registry.managerIds, visualLessonsManagerIds);
  assert.ok(visualLessonsManagerIds.includes(VISUAL_QA_MANAGER_ID));
  assert.ok(visualLessonsManagerIds.includes(LESSONS_KEEPER_MANAGER_ID));
  assert.ok(MANAGER_ACTION_GROUPS['visual-qa'].safe.includes('attach-screenshots'));
});

test('AC1: changed pages get phone and desktop viewport captures', async () => {
  const viewports = visualQaViewports();
  assert.equal(viewports.length, 2);
  assert.deepEqual(
    viewports.map((v) => v.name),
    [...VISUAL_QA_VIEWPORT_NAMES],
  );
  assert.deepEqual(viewports[0], { ...VISUAL_QA_PHONE_VIEWPORT, name: 'phone' });
  assert.deepEqual(viewports[1], { ...VISUAL_QA_DESKTOP_VIEWPORT, name: 'desktop' });

  const root = await mkRoot();
  const port = await freePort();
  const server = await listenOk(port);
  try {
    await writeUiProfile(root, { port });
    const capture = await captureScreenshotsForChangedPages(root, {
      screenIds: ['home-page'],
      deps: { browser: mockVisualBrowser },
    });
    assert.equal(capture.skipped, false);
    const names = new Set(capture.artifacts.map((a) => a.viewport));
    assert.ok(names.has('phone'));
    assert.ok(names.has('desktop'));
    assert.equal(names.size, 2);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC1: attach-screenshots posts phone and desktop images to the pull request', async () => {
  const artifacts = [
    { screenId: 'home-page', captureKey: 'default', viewport: 'phone', path: '.swarm/visual-qa/home-page/default/phone.png' },
    { screenId: 'home-page', captureKey: 'default', viewport: 'desktop', path: '.swarm/visual-qa/home-page/default/desktop.png' },
  ];
  const body = buildPrCommentBody('org/repo', 'deadbeef', artifacts);
  assert.match(body, /phone/);
  assert.match(body, /desktop/);
  assert.match(body, /raw\.githubusercontent\.com\/org\/repo\/deadbeef/);

  const root = await mkRoot();
  const ghCalls = [];
  try {
    const result = await attachScreenshotsToPullRequest(root, {
      pr: 7,
      repo: 'org/repo',
      artifacts,
      deps: {
        gh: async (args) => {
          ghCalls.push(args);
          if (args[0] === 'pr' && args[1] === 'view') {
            return {
              code: 0,
              stdout: JSON.stringify({
                number: 7,
                headRefOid: 'deadbeef',
                headRepository: { nameWithOwner: 'org/repo' },
              }),
            };
          }
          if (args[0] === 'pr' && args[1] === 'comment') {
            return { code: 0, stdout: '', stderr: '' };
          }
          return { code: 1, stderr: 'unexpected gh call' };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.artifactCount, 2);
    const commentCall = ghCalls.find((args) => args[0] === 'pr' && args[1] === 'comment');
    assert.ok(commentCall);
    const commentBody = commentCall[commentCall.length - 1];
    assert.match(commentBody, /phone/);
    assert.match(commentBody, /desktop/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC1: visual-qa manager captures both sizes and attaches them in auto mode', async () => {
  const root = await mkRoot();
  const port = await freePort();
  const server = await listenOk(port);
  const ghCalls = [];
  try {
    await writeUiProfile(root, { port });
    const modeSettings = autoModeFor('visual-qa', 'attach-screenshots');
    const { run } = await runVisualQa({
      root,
      modeSettings,
      trigger: 'integration',
      pr: 99,
      repo: 'org/repo',
      screenIds: ['home-page'],
      deps: {
        browser: mockVisualBrowser,
        gh: async (args) => {
          ghCalls.push(args);
          if (args[0] === 'pr' && args[1] === 'view') {
            return {
              code: 0,
              stdout: JSON.stringify({
                number: 99,
                headRefOid: 'cafebabe',
                headRepository: { nameWithOwner: 'org/repo' },
              }),
            };
          }
          if (args[0] === 'pr' && args[1] === 'comment') {
            return { code: 0, stdout: '', stderr: '' };
          }
          return { code: 1, stderr: 'unexpected gh call' };
        },
      },
    });
    assert.equal(run.status, 'ok');
    assert.ok(ghCalls.some((args) => args[0] === 'pr' && args[1] === 'comment'));
    const attached = await captureAndAttachVisualQaScreenshots(root, {
      screenIds: ['home-page'],
      pr: 12,
      repo: 'org/repo',
      deps: {
        browser: mockVisualBrowser,
        gh: async (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return {
              code: 0,
              stdout: JSON.stringify({
                number: 12,
                headRefOid: 'abc',
                headRepository: { nameWithOwner: 'org/repo' },
              }),
            };
          }
          if (args[0] === 'pr' && args[1] === 'comment') {
            return { code: 0, stdout: '', stderr: '' };
          }
          return { code: 1, stderr: 'fail' };
        },
      },
    });
    assert.equal(attached.attached, true);
    assert.ok(attached.artifacts.some((a) => a.viewport === 'phone'));
    assert.ok(attached.artifacts.some((a) => a.viewport === 'desktop'));
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC2: lessons keeper drafts a test then marks the lesson shipped when it lands', async () => {
  const root = await mkRoot();
  try {
    await writeLesson(root, keeperLesson());
    const rel = lessonPath('keeptest', 'L-9901');

    const drafted = await closeLoggedLesson(root, rel, { write: true });
    assert.ok(drafted.drafted?.written);
    assert.match(drafted.drafted.written, /coordination\/lesson-drafts\//);

    const testPaths = landedPathsFromDraftRef(drafted.drafted.written);
    assert.ok(testPaths.some((p) => p.startsWith('tests/') && p.endsWith('.test.mjs')));
    const testRel = testPaths.find((p) => p.startsWith('tests/')) ?? testPaths[0];
    await fs.mkdir(path.dirname(path.join(root, testRel)), { recursive: true });
    await fs.writeFile(
      path.join(root, testRel),
      "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\ndescribe('lesson L-9901', () => { it('guards', () => assert.ok(true)); });\n",
    );

    const closed = await closeLoggedLesson(root, rel, { write: true });
    assert.equal(closed.closed, true);
    assert.equal(closed.landed, testRel);

    const lessonAfter = await readLoggedLessonFile(root, rel);
    assert.equal(lessonAfter.guard.status, 'shipped');
    assert.equal(lessonAfter.guard.ref, testRel);

    const finding = lessonKeeperFindingFromCloseResult(lessonAfter, closed);
    assert.equal(finding?.code, 'lesson-shipped');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC2: lessons-keeper manager closes each open lesson through the draft and ship loop', async () => {
  const root = await mkRoot();
  try {
    await writeLesson(root, keeperLesson({ id: 'L-9902' }));
    const rel = lessonPath('keeptest', 'L-9902');
    const testRel = 'tests/keeptest-l-9902.test.mjs';
    await fs.mkdir(path.dirname(path.join(root, testRel)), { recursive: true });
    await fs.writeFile(
      path.join(root, testRel),
      "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\ndescribe('lesson L-9902', () => { it('guards', () => assert.ok(true)); });\n",
    );

    const modeSettings = autoModeFor(LESSONS_KEEPER_MANAGER_ID, 'write-lesson-draft');
    const result = await runLessonsKeeper({
      root,
      modeSettings,
      trigger: 'wave',
      lessonIds: ['L-9902'],
    });
    assert.equal(result.run.status, 'ok');
    assert.equal(result.run.findingCount, 1);

    const shipped = result.report?.lines?.find((line) => line.action === 'write-lesson-draft');
    assert.ok(shipped);
    assert.match(shipped.reason, /closed after test landed at tests\//);

    const finalLesson = await readLoggedLessonFile(root, rel);
    assert.equal(finalLesson.guard.status, 'shipped');
    assert.equal(finalLesson.guard.ref, testRel);
    assert.ok(landedPathsFromDraftRef(`coordination/lesson-drafts/keeptest-l-9902.test-draft.mjs`).includes(testRel));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

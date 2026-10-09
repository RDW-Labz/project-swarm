// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const visionPassLists = [
  'dashboard button contrast',
  'lot sticker size',
  'nav hierarchy',
  'motion strip',
  'pickups table',
];
import {
  validateConfig,
  reviewerFor,
  visionOverlap,
  visionTestPassedFromLists,
  parseReview,
  carryOver,
  nextChangeList,
  stopDecision,
  runDesignLoop,
  dryRunPlan,
  fillReviewPromptTemplate,
  buildDesignerPrompt,
  designLoopCodexArgv,
  designLoopClaudeArgv,
  designLoopCursorArgv,
  listDesignLoopSkillFiles,
  parseTopFiveList,
} from '../tools/design-loop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.join(__dirname, '..', 'skills', 'design-loop');

function topFiveMarkdown(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

const goodConfig = {
  target: './mockup.html',
  screens: [{ name: 'dashboard', url_or_selector: '#dash', widths: [1440, 1024] }],
  baseline: 'none',
  designer: 'codex:gpt-6-astra',
  reviewer: { primary: 'claude:opus', cheap: 'codex:gpt-6-sol' },
  rubric: 'RUBRIC.md',
  done: 'DONE.md',
  rounds: { max: 6, checkpoints: [1, 3, 6], primary_reviewer_at: [1, 3, 6] },
  motion: true,
  locks: { fonts: 3 },
  out: 'docs/design/out',
};

const sampleReview = `## 1. Previous changes — done or not
- dashboard · button — NOT DONE — dash
- lot · sticker — REMOVED INSTEAD — lot
- nav · link — DONE — nav

## 2. Definition of done
- fonts loaded — GREEN — dash
- contrast — RED — dash

## 3. Rubric scores
1. hierarchy — 7 — dash
2. motion — 8 — strip

## 4. Five ranked changes
1. dashboard · table · widen columns
2. lot · row · align sticker
`;

test('validateConfig accepts a good config', () => {
  const result = validateConfig(goodConfig, { knownAdapters: ['codex', 'claude', 'cursor'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateConfig rejects missing keys and bad workers', () => {
  const missing = validateConfig({ target: 'x' }, { knownAdapters: ['codex', 'claude'] });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(e => e.includes('screens')));

  const sameReviewer = validateConfig({
    ...goodConfig,
    designer: 'codex:gpt-6-sol',
    reviewer: { primary: 'codex:gpt-6-sol', cheap: 'claude:opus' },
  }, { knownAdapters: ['codex', 'claude'] });
  assert.equal(sameReviewer.ok, false);

  const unknown = validateConfig({ ...goodConfig, designer: 'unknown:model' }, { knownAdapters: ['codex'] });
  assert.equal(unknown.ok, false);

  const checkpoint = validateConfig({
    ...goodConfig,
    rounds: { max: 2, checkpoints: [5] },
  }, { knownAdapters: ['codex', 'claude', 'cursor'] });
  assert.equal(checkpoint.ok, false);

  const cursorReviewer = validateConfig({
    ...goodConfig,
    reviewer: { primary: 'cursor:composer-2.5', cheap: 'codex:gpt-6-sol' },
  }, { knownAdapters: ['codex', 'claude', 'cursor'] });
  assert.equal(cursorReviewer.ok, false);
  assert.ok(cursorReviewer.errors.some(e => e.includes('cursor')));
});

test('reviewerFor uses primary at checkpoints and when vision test failed', () => {
  assert.equal(reviewerFor(2, goodConfig, { visionTestPassed: true }), goodConfig.reviewer.cheap);
  assert.equal(reviewerFor(1, goodConfig, { visionTestPassed: true }), goodConfig.reviewer.primary);
  assert.equal(reviewerFor(2, goodConfig, { visionTestPassed: false }), goodConfig.reviewer.primary);
});

test('visionOverlap and vision test threshold', () => {
  const a = ['dashboard button contrast', 'lot sticker size', 'nav hierarchy', 'motion strip', 'pickups table'];
  const b = ['Dashboard · button · contrast', 'lot · sticker · BRN', 'other item', 'nav · hierarchy', 'footer polish'];
  assert.equal(visionOverlap(a, b), 3);
  assert.equal(visionTestPassedFromLists(a, b), true);
});

test('parseReview and carryOver rank removed-instead first', () => {
  const parsed = parseReview(sampleReview);
  assert.equal(parsed.previous.length, 3);
  assert.equal(parsed.changes.length, 2);
  const carry = carryOver(parsed);
  assert.deepEqual(carry, ['lot · sticker', 'dashboard · button']);
});

test('nextChangeList orders human, carry, reviewer and dedupes', () => {
  const list = nextChangeList({
    human: ['human one', 'human two', 'human three', 'human four'],
    carry: ['dashboard · button', 'human one'],
    reviewer: ['dashboard · table · widen columns', 'dashboard · button'],
  });
  assert.deepEqual(list, ['human one', 'human two', 'human three', 'dashboard · button', 'dashboard · table · widen columns']);
});

test('stopDecision covers all four rules', () => {
  const cfg = { rounds: { max: 6 } };
  assert.deepEqual(stopDecision([], cfg, { workerUnavailable: true }), { stop: true, reason: 'required worker unavailable' });
  assert.deepEqual(stopDecision([{ round: 7, average: 9 }], cfg, { round: 7 }), { stop: true, reason: 'round cap reached' });

  const stall = [
    { round: 1, average: 9, allDoneGreen: true, scores: [{ score: 9 }] },
    { round: 2, average: 8, allDoneGreen: true, scores: [{ score: 8 }] },
    { round: 3, average: 7, allDoneGreen: true, scores: [{ score: 7 }] },
  ];
  assert.deepEqual(stopDecision(stall, cfg, { round: 3 }), { stop: true, reason: 'average score dropped two rounds running' });

  const beforeGreen = [
    { round: 1, allDoneGreen: false, scores: [{ score: 10 }], average: 10 },
    { round: 2, allDoneGreen: true, scores: [{ score: 10 }], average: 10 },
    { round: 3, allDoneGreen: true, scores: [{ score: 7 }], average: 7 },
  ];
  const early = stopDecision(beforeGreen, cfg, { round: 3 });
  assert.equal(early.stop, false);

  const doneGreen = [
    { round: 1, allDoneGreen: true, scores: [{ score: 8 }], average: 8 },
    { round: 2, allDoneGreen: true, scores: [{ score: 9 }], average: 9 },
  ];
  assert.deepEqual(stopDecision(doneGreen, cfg, { round: 2 }), {
    stop: true,
    reason: 'definition of done green and rubric >= 8 for two consecutive rounds',
  });
});

test('runDesignLoop checkpoint resume flow with fresh reviewers', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-loop-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = {
    ...goodConfig,
    out: 'rounds-out',
    rounds: { max: 3, checkpoints: [1, 3], primary_reviewer_at: [1, 3] },
  };
  const configPath = path.join(dir, 'loop.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const reviewerIds = [];
  let reviewRound = 0;
  const workers = {
    designer: async () => {},
    capture: async () => {},
    visionReviewer: async () => topFiveMarkdown(visionPassLists),
    reviewer: async ({ instanceId }) => {
      reviewerIds.push(instanceId);
      reviewRound += 1;
      return sampleReview.replace('7', String(6 + reviewRound));
    },
  };

  const first = await runDesignLoop(configPath, { workers, now: () => 0 });
  assert.equal(first.status, 'awaiting-checkpoint');
  assert.equal(first.round, 1);
  assert.equal(reviewerIds.length, 1);

  await assert.rejects(
    () => runDesignLoop(configPath, { resume: true, workers }),
    /missing.*CHECKPOINT\.reply\.md/,
  );

  const outDir = path.join(dir, 'rounds-out');
  await fs.writeFile(path.join(outDir, 'round-1', 'CHECKPOINT.reply.md'), 'human: fix the table header\n');
  const second = await runDesignLoop(configPath, { resume: true, workers, now: () => 1 });
  assert.equal(second.status, 'awaiting-checkpoint');
  assert.equal(second.round, 3);
  assert.equal(reviewerIds.length, 3);
  assert.notEqual(reviewerIds[0], reviewerIds[1]);
  assert.notEqual(reviewerIds[1], reviewerIds[2]);

  const log = await fs.readFile(path.join(outDir, 'LOG.md'), 'utf8');
  assert.match(log, /Round 1/);
  assert.match(log, /reviewer-1/);
});

test('dryRunPlan lists rounds and files', () => {
  const plan = dryRunPlan(goodConfig);
  assert.match(plan, /designer codex:gpt-6-astra/);
  assert.match(plan, /round-0/);
});

test('fillReviewPromptTemplate fills every slot from review.prompt.md', async () => {
  const template = await fs.readFile(path.join(skillDir, 'review.prompt.md'), 'utf8');
  const filled = fillReviewPromptTemplate(template, {
    N: '2',
    'N-1': '1',
    paths: '/tmp/round-2/a.png',
    axe_path: '/tmp/round-2/axe.json',
    prev_paths: '/tmp/round-1/a.png',
    prev_changes: '1. dashboard · button',
    baseline_paths: '(none)',
  });
  assert.ok(!/\{\{/.test(filled));
  assert.match(filled, /round 2/i);
});

test('fillReviewPromptTemplate throws when a slot is missing', async () => {
  const template = await fs.readFile(path.join(skillDir, 'review.prompt.md'), 'utf8');
  assert.throws(
    () => fillReviewPromptTemplate(template, { N: '1' }),
    /unfilled slots/,
  );
});

test('buildDesignerPrompt includes target, list, rubric, done, and no-delete rule', () => {
  const prompt = buildDesignerPrompt({
    target: './mockup.html',
    changeList: ['human item', 'dashboard · button'],
    rubric: 'RUBRIC.md',
    done: 'DONE.md',
    round: 2,
  });
  assert.match(prompt, /Target: \.\/mockup\.html/);
  assert.match(prompt, /RUBRIC: RUBRIC\.md/);
  assert.match(prompt, /DONE: DONE\.md/);
  assert.match(prompt, /human item/);
  assert.match(prompt, /Never fix an item by deleting the element/);
});

test('worker argv builders never include resume or continue flags', () => {
  const codex = designLoopCodexArgv({
    model: 'gpt-6-sol',
    cwd: '/tmp/wt',
    lastMessageFile: '/tmp/out.txt',
    sandbox: 'read-only',
    imagePaths: ['/tmp/a.png'],
  });
  assert.ok(!codex.join(' ').match(/--resume|--continue|\bresume\b/));
  const claude = designLoopClaudeArgv({ model: 'opus', role: 'reviewer' });
  assert.ok(!claude.join(' ').match(/--resume|--continue|\bresume\b/));
  const cursor = designLoopCursorArgv({ agent: 'cursor', model: 'composer-2.5' }, { worktree: '/tmp/wt', message: 'hi' });
  assert.ok(!cursor.join(' ').match(/--resume|--continue|\bresume\b/));
});

test('listDesignLoopSkillFiles includes shipped skill assets', async () => {
  const files = await listDesignLoopSkillFiles(skillDir);
  assert.ok(files.includes('SKILL.md'));
  assert.ok(files.includes('review.prompt.md'));
  assert.ok(files.includes('capture.spec.ts'));
});

test('round 0 vision test passes when overlap is 4', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-loop-vision-pass-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...goodConfig, locks: {}, out: 'out', rounds: { max: 1, checkpoints: [], primary_reviewer_at: [] } };
  const configPath = path.join(dir, 'loop.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const outDir = path.join(dir, 'out');
  await fs.mkdir(path.join(outDir, 'round-0'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'round-0', 'dashboard-1440.png'), 'png');

  const listA = visionPassLists;
  const listB = [...listA.slice(0, 4), 'footer polish only'];
  let call = 0;
  const result = await runDesignLoop(configPath, {
    workers: {
      capture: async () => {},
      designer: async () => {},
      visionReviewer: async () => topFiveMarkdown(call++ === 0 ? listA : listB),
      reviewer: async () => sampleReview,
    },
  });
  assert.equal(result.status, 'complete');
  const state = JSON.parse(await fs.readFile(path.join(outDir, 'state.json'), 'utf8'));
  assert.equal(state.visionTest.overlap, 4);
  assert.equal(state.visionTest.passed, true);
  const log = await fs.readFile(path.join(outDir, 'LOG.md'), 'utf8');
  assert.match(log, /Vision test: overlap 4/);
});

test('round 0 vision test pauses awaiting-human when overlap is 2', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-loop-vision-fail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...goodConfig, out: 'out', rounds: { max: 3, checkpoints: [1] } };
  const configPath = path.join(dir, 'loop.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const outDir = path.join(dir, 'out');
  await fs.mkdir(path.join(outDir, 'round-0'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'round-0', 'dashboard-1440.png'), 'png');

  const listA = visionPassLists;
  const listB = [listA[0], listA[1], 'unique alpha', 'unique beta', 'unique gamma'];
  let call = 0;
  const result = await runDesignLoop(configPath, {
    workers: {
      capture: async () => {},
      designer: async () => {},
      visionReviewer: async () => topFiveMarkdown(call++ === 0 ? listA : listB),
      reviewer: async () => sampleReview,
    },
  });
  assert.equal(result.status, 'awaiting-human');
  assert.equal(result.overlap, 2);
  assert.match(result.message, /cost/i);
  assert.match(result.message, /VISION\.reply\.md/);
  assert.match(result.message, /continue with primary/);
  const visionMd = await fs.readFile(path.join(outDir, 'round-0', 'VISION.md'), 'utf8');
  assert.match(visionMd, /VISION\.reply\.md/);
  assert.match(visionMd, /continue with primary/);
  const state = JSON.parse(await fs.readFile(path.join(outDir, 'state.json'), 'utf8'));
  assert.equal(state.status, 'awaiting-human');
  assert.equal(state.visionTestPassed, false);
  assert.equal(reviewerFor(2, config, { visionTestPassed: false }), config.reviewer.primary);
});

test('resume after failed vision test refuses without VISION.reply.md', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-loop-vision-resume-miss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...goodConfig, locks: {}, out: 'out', rounds: { max: 3, checkpoints: [], primary_reviewer_at: [3] } };
  const configPath = path.join(dir, 'loop.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const outDir = path.join(dir, 'out');
  await fs.mkdir(path.join(outDir, 'round-0'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'round-0', 'dashboard-1440.png'), 'png');

  const listA = visionPassLists;
  const listB = [listA[0], listA[1], 'unique alpha', 'unique beta', 'unique gamma'];
  let call = 0;
  await runDesignLoop(configPath, {
    workers: {
      capture: async () => {},
      designer: async () => {},
      visionReviewer: async () => topFiveMarkdown(call++ === 0 ? listA : listB),
      reviewer: async () => sampleReview,
    },
  });

  const replyPath = path.join(outDir, 'round-0', 'VISION.reply.md');
  await assert.rejects(
    () => runDesignLoop(configPath, { resume: true, workers: { capture: async () => {}, designer: async () => {}, reviewer: async () => sampleReview } }),
    err => err.code === 'design-loop-resume' && /missing/.test(err.message) && err.message.includes(replyPath),
  );
});

test('resume after failed vision test stop ends loop', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-loop-vision-resume-stop-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...goodConfig, locks: {}, out: 'out', rounds: { max: 3, checkpoints: [], primary_reviewer_at: [3] } };
  const configPath = path.join(dir, 'loop.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const outDir = path.join(dir, 'out');
  await fs.mkdir(path.join(outDir, 'round-0'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'round-0', 'dashboard-1440.png'), 'png');

  const listA = visionPassLists;
  const listB = [listA[0], listA[1], 'unique alpha', 'unique beta', 'unique gamma'];
  let call = 0;
  const workers = {
    capture: async () => {},
    designer: async () => {},
    visionReviewer: async () => topFiveMarkdown(call++ === 0 ? listA : listB),
    reviewer: async () => sampleReview,
  };
  await runDesignLoop(configPath, { workers });

  await fs.writeFile(path.join(outDir, 'round-0', 'VISION.reply.md'), 'stop\n');
  const stopped = await runDesignLoop(configPath, { resume: true, workers });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.reason, 'human-stopped-after-vision-test');
  const state = JSON.parse(await fs.readFile(path.join(outDir, 'state.json'), 'utf8'));
  assert.equal(state.stopReason, 'human-stopped-after-vision-test');
});

test('resume after failed vision test continue runs round 1 with primary reviewer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-loop-vision-resume-go-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...goodConfig, locks: {}, out: 'out', rounds: { max: 3, checkpoints: [], primary_reviewer_at: [3] } };
  const configPath = path.join(dir, 'loop.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const outDir = path.join(dir, 'out');
  await fs.mkdir(path.join(outDir, 'round-0'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'round-0', 'dashboard-1440.png'), 'png');

  const listA = visionPassLists;
  const listB = [listA[0], listA[1], 'unique alpha', 'unique beta', 'unique gamma'];
  let call = 0;
  let round1ReviewerWorker;
  const workers = {
    capture: async () => {},
    designer: async () => {},
    visionReviewer: async () => topFiveMarkdown(call++ === 0 ? listA : listB),
    reviewer: async ({ worker, round }) => {
      if (round === 1) round1ReviewerWorker = worker;
      return sampleReview;
    },
  };
  await runDesignLoop(configPath, { workers });

  await fs.writeFile(path.join(outDir, 'round-0', 'VISION.reply.md'), 'continue with primary\n');
  const resumed = await runDesignLoop(configPath, { resume: true, workers });
  assert.equal(resumed.status, 'complete');
  assert.equal(round1ReviewerWorker, config.reviewer.primary);
  const state = JSON.parse(await fs.readFile(path.join(outDir, 'state.json'), 'utf8'));
  assert.equal(state.forcePrimaryReviewer, true);
  assert.equal(state.visionTestPassed, false);
  const log = await fs.readFile(path.join(outDir, 'LOG.md'), 'utf8');
  assert.match(log, /continue with primary/);
  assert.match(log, new RegExp(config.reviewer.primary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

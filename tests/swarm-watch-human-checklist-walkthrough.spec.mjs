// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startBoardServer, boardProjectUrl } from '../tools/watch-cli.mjs';
import { projectId } from '../tools/projects.mjs';
import { createLedger, writeLedger, approveLedger } from '../tools/tickets.mjs';

if (process.env.SWARM_REAL_HOME) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.env.SWARM_REAL_HOME, 'Library', 'Caches', 'ms-playwright');
}

const execFileAsync = promisify(execFile);

const get = (port, pathname, { headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request(
    { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } },
    res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    },
  );
  req.on('error', reject);
  req.end();
});

async function runWatchUrlFromBoard(board, projectId) {
  const boardUrl = new URL(board.url);
  const token = boardUrl.searchParams.get('t');
  const open = await get(Number(boardUrl.port), `/open/run?id=${encodeURIComponent(projectId)}&run=run-1`, {
    headers: { 'x-watch-token': token ?? '' },
  });
  assert.equal(open.status, 302);
  const location = open.headers.location;
  assert.ok(location, 'board must redirect to a run watch page');
  return location;
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWARM = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots', 'swarm-watch-human-checklist');

const HUMAN_ID = 'T-0058';
const HUMAN_TITLE = 'Owner human checklist walkthrough';
const HUMAN_STEPS = ['Open the Build Plan tab', 'Confirm checklist steps', 'Mark done from the terminal'];
const BUILD_ID = 'T-0060';
const BUILD_DONE_ID = 'T-0059';

const tk = (id, over = {}) => ({
  id,
  title: `Ticket ${id}`,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: ['src/a.mjs'],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  status: 'todo',
  ...over,
});

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'human-checklist-pw-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function runSwarm(root, env, ...args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [SWARM, '--root', root, ...args], {
    env: { ...process.env, ...env },
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function parseBuildProgressLabel(text) {
  const label = ' (excludes human tickets)';
  assert.ok(text.includes(label), `expected label to include "${label.trim()}", got: ${text}`);
  const match = /Build progress (\d+)% \(excludes human tickets\)/.exec(text);
  assert.ok(match, `expected "Build progress NN% (excludes human tickets)", got: ${text}`);
  return Number(match[1]);
}

async function clickPlanTab(page) {
  await page.getByRole('tab', { name: 'Build Plan' }).click();
  await page.locator('#pl-human-checklist .pl-human-card').first().waitFor({ state: 'visible', timeout: 20_000 });
}

async function setupProject(t) {
  const home = await tmp(t);
  const root = path.join(home, 'parts-app');
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'run-1'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.swarm', 'runs', 'run-1', 'state.json'),
    JSON.stringify({
      id: 'run-1',
      status: 'running',
      startedAt: new Date().toISOString(),
      jobs: [{ id: 'a', status: 'running', agent: 'codex' }],
    }),
  );
  const real = await fs.realpath(root);
  const env = {
    SWARM_PROJECTS_FILE: path.join(home, 'projects.json'),
    SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'),
    SWARM_BOARD_FILE: path.join(home, 'board.json'),
    SWARM_CONFIG: path.join(home, 'none.json'),
  };
  await fs.writeFile(
    env.SWARM_PROJECTS_FILE,
    JSON.stringify({
      version: 1,
      projects: [{ id: projectId(real), root: real, name: 'parts-app', addedAt: 'x', lastSeen: 'x' }],
    }),
  );

  const tickets = [
    tk(BUILD_ID, { title: 'Automated build keeps moving', status: 'running' }),
    tk(BUILD_DONE_ID, { title: 'Finished build slice', status: 'done' }),
    {
      id: HUMAN_ID,
      title: HUMAN_TITLE,
      type: 'human',
      stage: 'S1',
      scopeRefs: [],
      acceptance: [],
      files: [],
      dependsOn: [],
      size: 'S',
      risk: 'low',
      status: 'todo',
      steps: HUMAN_STEPS,
    },
  ];
  const ledger = createLedger({ scope: { name: 'Walkthrough', version: 1, hash: 'a'.repeat(64) }, tickets });
  await writeLedger(real, { ...ledger, approved: approveLedger(ledger).approved });

  return { home, root: real, env, id: projectId(real) };
}

test('Swarm Watch human checklist walkthrough with screenshots', { timeout: 60_000 }, async t => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  const { root, env, id } = await setupProject(t);
  const board = await startBoardServer({ env, root });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const shutdown = async () => {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await board.server.close().catch(() => {});
    await board.api.close().catch(() => {});
  };
  t.after(shutdown);

  const projectUrl = boardProjectUrl(board.url, id);
  assert.ok(new URL(projectUrl).searchParams.get('t'), 'project navigation uses board access token in query string');
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
  const watchUrl = await runWatchUrlFromBoard(board, id);
  await page.goto(watchUrl, { waitUntil: 'domcontentloaded' });

  await clickPlanTab(page);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-plan-tab-open.png'), fullPage: true });

  const checklist = page.locator('#pl-human-checklist');
  await checklist.waitFor({ state: 'visible' });
  const humanCard = checklist.locator('.pl-human-card').filter({ hasText: HUMAN_TITLE });
  assert.equal(await humanCard.count(), 1, 'expected one human checklist card for the seeded ticket');
  assert.match(await humanCard.locator('.mono.lead-name').textContent(), new RegExp(HUMAN_ID));
  const warnPill = humanCard.locator('.pill.warn');
  assert.equal(await warnPill.count(), 1);
  assert.match((await warnPill.textContent()) ?? '', /todo/i);

  const steps = humanCard.locator('.pl-human-steps > .pl-human-step');
  assert.equal(await steps.count(), HUMAN_STEPS.length);
  for (let i = 0; i < HUMAN_STEPS.length; i += 1) {
    assert.match((await steps.nth(i).textContent()) ?? '', new RegExp(HUMAN_STEPS[i]));
    assert.equal(await steps.nth(i).locator('.pl-human-check').textContent(), '☐');
  }

  const progressLabel = checklist.locator('.pl-checklist-head .label').first();
  const progressTextBefore = await progressLabel.textContent();
  const progressBefore = parseBuildProgressLabel(progressTextBefore ?? '');
  assert.equal(progressBefore, 50, 'build progress counts only non-human tickets (1 done / 2 live build)');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-human-checklist-visible.png'), fullPage: true });

  const doneCli = await runSwarm(root, env, 'tickets', HUMAN_ID, '--set', 'done', '--yes');
  assert.match(doneCli.stdout, new RegExp(HUMAN_ID));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await clickPlanTab(page);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-after-marking-done.png'), fullPage: true });

  const humanCardAfter = checklist.locator('.pl-human-card').filter({ hasText: HUMAN_TITLE });
  const goodPill = humanCardAfter.locator('.pill.good');
  assert.equal(await goodPill.count(), 1);
  assert.match((await goodPill.textContent()) ?? '', /done/i);
  const stepsAfter = humanCardAfter.locator('.pl-human-steps > .pl-human-step .pl-human-check');
  assert.equal(await stepsAfter.count(), HUMAN_STEPS.length);
  for (let i = 0; i < HUMAN_STEPS.length; i += 1) {
    assert.equal(await stepsAfter.nth(i).textContent(), '☑');
  }

  const progressTextAfter = await progressLabel.textContent();
  const progressAfter = parseBuildProgressLabel(progressTextAfter ?? '');
  assert.equal(progressAfter, progressBefore, 'marking a human ticket done must not change build progress');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-build-progress-unchanged.png'), fullPage: true });

  const buildNode = page.locator('#pl-deps [role="button"]').filter({ hasText: BUILD_ID });
  await buildNode.first().waitFor({ state: 'visible' });
  assert.match((await buildNode.first().textContent()) ?? '', new RegExp(BUILD_ID));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-build-ticket-still-progressing.png'), fullPage: true });
});

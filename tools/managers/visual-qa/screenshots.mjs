// SPDX-License-Identifier: Apache-2.0
// Visual QA (T-0217): capture phone and desktop screenshots for changed UI pages and attach them to the PR.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { localHttpUrl } from '../../ui-check.mjs';
import { UI_DEFAULTS } from '../../ui-compare.mjs';
import { freePort, expandStart, startEnv } from '../../ui-server.mjs';
import { readProfile } from '../../scope-commands.mjs';
import { readLedger } from '../../tickets.mjs';
import { safeWritableDir, assertRegularOrMissing } from '../../journal.mjs';
import { parsePrArgument } from '../../merge-guard.mjs';

const execFileAsync = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });

/** @typedef {{ width: number, height: number }} Viewport */

/** Phone width per docs/plans/phase19-swarm-managers.md (375 px). */
export const VISUAL_QA_PHONE_VIEWPORT = Object.freeze({ width: 375, height: 812 });

/** Desktop capture; profile ui.viewport is phone-shaped, so Visual QA uses an explicit desktop size. */
export const VISUAL_QA_DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 720 });

export const VISUAL_QA_VIEWPORT_NAMES = Object.freeze(['phone', 'desktop']);

export const VISUAL_QA_ARTIFACT_SEGMENTS = Object.freeze(['.swarm', 'visual-qa']);

export const VISUAL_QA_PR_MARKER = '<!-- swarm-visual-qa-screenshots -->';

const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TZ', 'TMPDIR', 'CI', 'NODE_ENV', 'PLAYWRIGHT_BROWSERS_PATH'];
const allowedEnv = (extra = {}) => ({
  ...Object.fromEntries(ENV_ALLOW.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
  ...extra,
});

const PAGE_SHOTS_SCRIPT = `
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let chromium;
try {
  const require = createRequire(path.join(spec.root, 'package.json'));
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
} catch (error) {
  console.log('VISUAL_QA_RESULT ' + JSON.stringify({ error: 'playwright-missing' }));
  process.exit(0);
}
const browser = await chromium.launch();
const results = [];
try {
  for (const capture of spec.captures) {
    const entry = { id: capture.id, key: capture.key, shots: {} };
    for (const viewport of capture.viewports) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await context.route('**/*', route => {
        const request = route.request();
        const url = request.url();
        const hostOk = ['http://127.0.0.1', 'http://localhost', 'http://[::1]'].some(prefix => url === prefix || ['/', ':', '?', '#'].includes(url.charAt(prefix.length)) && url.startsWith(prefix));
        const local = ['file:', 'about:', 'data:', 'blob:'].some(scheme => url.startsWith(scheme)) || hostOk;
        return request.resourceType() === 'document' && !local ? route.abort() : route.continue();
      });
      const page = await context.newPage();
      try {
        await page.goto(capture.pageUrl, { waitUntil: 'load', timeout: spec.timeoutMs });
        if (capture.waitFor) {
          try { await page.waitForSelector(capture.waitFor, { timeout: 15000 }); } catch { /* metrics in the screenshot */ }
        }
        await page.waitForTimeout(600);
        const file = path.join(spec.out, capture.id, capture.key, viewport.name + '.png');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, timeout: spec.timeoutMs });
        entry.shots[viewport.name] = { file, ok: true };
      } catch (error) {
        entry.shots[viewport.name] = { ok: false, error: String(error && error.message || error).slice(0, 200) };
      } finally { await context.close(); }
    }
    results.push(entry);
  }
} finally { await browser.close(); }
console.log('VISUAL_QA_RESULT ' + JSON.stringify({ captures: results }));
`;

const live = new Set();
function killLive() {
  for (const pid of live) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
  live.clear();
}

function withSignals(fn) {
  const onSignal = (signal) => {
    killLive();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.kill(process.pid, signal);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return fn().finally(() => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    killLive();
  });
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child.pid);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const kill = (signal) => {
      try { process.kill(-child.pid, signal); } catch {
        try { child.kill(signal); } catch { /* gone */ }
      }
    };
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      live.delete(child.pid);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, timeoutMs);
    const hard = setTimeout(() => done(null), timeoutMs + 5000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = (stdout + chunk).slice(-4_000_000); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-20000); });
    child.on('error', (error) => { stderr += String(error.message); done(null); });
    child.on('exit', (code) => { kill('SIGKILL'); setTimeout(() => done(code), 500); });
  });
}

async function answers(url, fetchImpl, timeoutMs = 2000) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.status > 0 && res.status < 500;
  } catch { return false; }
}

async function ensureServer(config, baseUrl, fetchImpl, { cwd, log, explicitBase = false }) {
  const own = Boolean(config.start) && !explicitBase;
  const port = own ? String(await freePort()) : new URL(baseUrl).port;
  if (own) baseUrl = `http://127.0.0.1:${port}`;
  const ready = baseUrl + config.readyPath;
  if (!own && await answers(ready, fetchImpl)) return { stop: async () => {}, started: false, base: baseUrl };
  if (!config.start) throw fail('visual-qa-server', `nothing answers at ${ready} and the profile has no ui.start command`);
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-visual-qa-server-'));
  const logFile = path.join(logDir, 'server.log');
  const handle = await fs.open(logFile, 'wx');
  const portNumber = Number(port) || 80;
  const startArgv = expandStart(config.start, portNumber);
  const child = spawn(startArgv[0], startArgv.slice(1), {
    cwd,
    shell: false,
    detached: true,
    stdio: ['ignore', handle.fd, handle.fd],
    env: allowedEnv(startEnv(portNumber)),
  });
  live.add(child.pid);
  let exited = false;
  child.on('error', () => { exited = true; });
  child.on('exit', () => { exited = true; });
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    live.delete(child.pid);
    await handle.close().catch(() => {});
    await fs.rm(logDir, { recursive: true, force: true });
  };
  const deadline = Date.now() + config.timeoutSec * 1000;
  while (Date.now() < deadline && !exited) {
    if (await answers(ready, fetchImpl) && !exited) {
      log?.(`dev server started: ${startArgv.join(' ')}`);
      return { stop, started: true, base: baseUrl };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const tail = (await fs.readFile(logFile, 'utf8').catch(() => '')).slice(-400);
  await stop();
  throw fail('visual-qa-server', `${exited ? 'the dev server command exited' : `the dev server did not answer within ${config.timeoutSec} seconds`} (${ready})${tail ? `: ${tail.replace(/\s+/g, ' ')}` : ''}`);
}

export async function atomicWrite(root, segments, bytes) {
  const dir = await safeWritableDir(root, segments.slice(0, -1));
  const file = path.join(dir, segments.at(-1));
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.${segments.at(-1)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  let closed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    await fs.rename(tmp, file);
  } catch (error) {
    if (!closed) {
      await handle.close().catch(() => {});
    }
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * @param {string} screenId
 * @param {string} [captureKey]
 * @param {'phone'|'desktop'} [size]
 */
export function visualQaArtifactSegments(screenId, captureKey = 'default', size = 'phone') {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(screenId)) throw new Error('visual-qa-screen-id-invalid');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(captureKey)) throw new Error('visual-qa-capture-key-invalid');
  if (!VISUAL_QA_VIEWPORT_NAMES.includes(size)) throw new Error('visual-qa-viewport-invalid');
  return [...VISUAL_QA_ARTIFACT_SEGMENTS, screenId, captureKey, `${size}.png`];
}

/**
 * @returns {readonly Viewport[]}
 */
export function visualQaViewports() {
  return Object.freeze([
    Object.freeze({ ...VISUAL_QA_PHONE_VIEWPORT, name: 'phone' }),
    Object.freeze({ ...VISUAL_QA_DESKTOP_VIEWPORT, name: 'desktop' }),
  ]);
}

/**
 * Page states to capture: base route plus an optional query state (lesson 28–32).
 *
 * @param {{ id: string, route: string, mockupQuery?: string, waitFor?: string }} screen
 * @returns {readonly { key: string, route: string, waitFor?: string }[]}
 */
export function pageCaptureVariants(screen) {
  const variants = [{ key: 'default', route: screen.route, ...(screen.waitFor ? { waitFor: screen.waitFor } : {}) }];
  if (screen.mockupQuery && !screen.route.includes('?')) {
    variants.push({
      key: 'state',
      route: `${screen.route}?${screen.mockupQuery}`,
      ...(screen.waitFor ? { waitFor: screen.waitFor } : {}),
    });
  }
  return Object.freeze(variants);
}

async function gitChangedPaths(root, { mergeBase, execFileImpl = execFileAsync } = {}) {
  const git = (args) => execFileImpl('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout, () => null);
  let base = mergeBase;
  if (!base) {
    base = (await git(['merge-base', 'HEAD', 'HEAD@{upstream}']))?.trim()
      ?? (await git(['merge-base', 'HEAD', 'origin/main']))?.trim()
      ?? (await git(['rev-parse', 'HEAD~1']))?.trim();
  }
  if (!base) return [];
  const out = await git(['diff', '--name-only', '-z', `${base}...HEAD`]);
  if (out === null) return [];
  return [...new Set(out.split('\0').filter(Boolean))];
}

/**
 * UI profile screens touched by the current branch (ticket files intersecting the diff) or an explicit id list.
 *
 * @param {string} root
 * @param {{ screenIds?: string[], ticketIds?: string[], mergeBase?: string, deps?: object }} [options]
 */
export async function listChangedPageScreens(root, { screenIds = [], ticketIds = [], mergeBase, deps = {} } = {}) {
  const profile = await readProfile(root);
  const config = profile?.ui;
  const screens = config?.screens;
  if (!Array.isArray(screens) || screens.length < 1) return [];

  const ids = new Set(screenIds);
  if (!ids.size) {
    const changed = new Set(await gitChangedPaths(root, { mergeBase, execFileImpl: deps.execFile }));
    const ledger = await (deps.readLedger ?? readLedger)(root).catch(() => null);
    for (const ticket of ledger?.tickets ?? []) {
      if (ticketIds.length && !ticketIds.includes(ticket.id)) continue;
      const ticketScreens = ticket.screens ?? [];
      if (!ticketScreens.length) continue;
      const files = ticket.files ?? [];
      const touched = files.some((file) => changed.has(file));
      const named = ticketIds.length && ticketIds.includes(ticket.id);
      if (touched || named) {
        for (const id of ticketScreens) ids.add(id);
      }
    }
  }

  const known = new Set(screens.map((s) => s.id));
  return screens.filter((s) => ids.has(s.id) && known.has(s.id));
}

async function runPageBrowser({ root, captures, out, timeoutMs, browserRunner }) {
  if (browserRunner) return browserRunner({ root, captures, out, timeoutMs });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-visual-qa-'));
  try {
    const scriptFile = path.join(dir, 'shots.mjs');
    const specFile = path.join(dir, 'spec.json');
    await fs.writeFile(scriptFile, PAGE_SHOTS_SCRIPT);
    await fs.writeFile(specFile, JSON.stringify({ root, captures, out, timeoutMs: Math.min(timeoutMs, 60000) }));
    const run = await runProcess(process.execPath, [scriptFile, specFile], {
      cwd: root,
      env: allowedEnv(),
      timeoutMs: captures.length * 130000 + 30000,
    });
    const line = run.stdout.split('\n').reverse().find((l) => l.startsWith('VISUAL_QA_RESULT '));
    if (!line) {
      throw fail('visual-qa-browser', `the browser script gave no result${run.timedOut ? ' (timed out)' : ''}: ${run.stderr.replace(/\s+/g, ' ').slice(-300)}`);
    }
    let parsed;
    try { parsed = JSON.parse(line.slice('VISUAL_QA_RESULT '.length)); } catch {
      throw fail('visual-qa-browser', 'the browser script gave an unreadable result');
    }
    if (parsed.error === 'playwright-missing') {
      throw fail('visual-qa-playwright-missing', 'Playwright is not installed in the project (npm install -D @playwright/test, then npx playwright install chromium)');
    }
    if (!Array.isArray(parsed.captures)) throw fail('visual-qa-browser', 'the browser script gave no captures');
    return parsed.captures;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function pageUrlFor(base, variant) {
  return base + variant.route;
}

/**
 * Capture phone and desktop screenshots for changed pages. Starts its own dev server when the profile has ui.start.
 *
 * @param {string} root
 * @param {object} [options]
 */
export async function captureScreenshotsForChangedPages(root, options = {}) {
  const events = [];
  const record = (kind, detail) => { events.push({ at: new Date().toISOString(), kind, ...detail }); };
  const flushOnFailure = (error) => {
    if (error) {
      process.stderr.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    }
  };

  try {
    return await withSignals(() => captureScreenshotsInner(root, options, record));
  } catch (error) {
    flushOnFailure(error);
    throw error;
  }
}

async function captureScreenshotsInner(root, options, record) {
  const deps = options.deps ?? {};
  const profile = await readProfile(root);
  const config = profile?.ui;
  if (!config) throw fail('visual-qa-config', 'the profile has no valid ui block (see docs/ui-check.md)');

  const screens = await listChangedPageScreens(root, {
    screenIds: options.screenIds,
    ticketIds: options.ticketIds,
    mergeBase: options.mergeBase,
    deps,
  });
  if (!screens.length) {
    record('skip', { reason: 'no changed pages' });
    return { ok: true, skipped: true, screens: [], artifacts: [], serverStarted: false };
  }

  const base = localHttpUrl(options.baseUrl ?? config.baseUrl ?? UI_DEFAULTS.baseUrl);
  if (!base) throw fail('visual-qa-base-url', 'the base url must be http on 127.0.0.1, localhost or [::1]');

  const fetchImpl = deps.fetchImpl ?? fetch;
  const realRoot = await fs.realpath(root);
  const server = await ensureServer(config, base, fetchImpl, {
    cwd: root,
    log: (msg) => record('server', { msg }),
    explicitBase: options.baseUrl !== undefined,
  });
  const pageBase = server.base ?? base;
  const shotsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-visual-qa-shots-'));
  const artifacts = [];
  let capturesResult;

  try {
    const captures = [];
    for (const screen of screens) {
      for (const variant of pageCaptureVariants(screen)) {
        captures.push({
          id: screen.id,
          key: variant.key,
          pageUrl: pageUrlFor(pageBase, variant),
          ...(variant.waitFor ? { waitFor: variant.waitFor } : {}),
          viewports: visualQaViewports().map((vp) => ({ name: vp.name, width: vp.width, height: vp.height })),
        });
      }
    }
    record('capture-start', { screens: screens.map((s) => s.id), count: captures.length });
    capturesResult = await runPageBrowser({
      root: realRoot,
      captures,
      out: shotsDir,
      timeoutMs: config.timeoutSec * 1000,
      browserRunner: deps.browser,
    });

    for (const shot of capturesResult) {
      for (const name of VISUAL_QA_VIEWPORT_NAMES) {
        const part = shot.shots?.[name];
        if (!part?.ok || !part.file) continue;
        const rel = visualQaArtifactSegments(shot.id, shot.key, name);
        const bytes = await fs.readFile(part.file);
        await atomicWrite(root, rel, bytes);
        artifacts.push({ screenId: shot.id, captureKey: shot.key, viewport: name, path: rel.join('/') });
      }
    }

    const failed = capturesResult.flatMap((shot) =>
      VISUAL_QA_VIEWPORT_NAMES.filter((name) => !shot.shots?.[name]?.ok).map((name) => ({
        screenId: shot.id,
        captureKey: shot.key,
        viewport: name,
        error: shot.shots?.[name]?.error ?? 'missing',
      })),
    );
    record('capture-done', { artifacts: artifacts.length, failed: failed.length });
    return {
      ok: failed.length === 0 && artifacts.length > 0,
      skipped: false,
      screens: screens.map((s) => s.id),
      artifacts,
      failed,
      serverStarted: server.started,
    };
  } finally {
    await server.stop();
    await fs.rm(shotsDir, { recursive: true, force: true });
  }
}

async function ghExec(args, { cwd, execFileImpl = execFileAsync }) {
  try {
    const { stdout, stderr } = await execFileImpl('gh', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
    };
  }
}

function rawGitHubImageUrl(repo, sha, relPath) {
  const encoded = relPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `https://raw.githubusercontent.com/${repo}/${sha}/${encoded}`;
}

function buildPrCommentBody(repo, sha, artifacts) {
  const lines = [VISUAL_QA_PR_MARKER, '### Visual QA screenshots', ''];
  const byScreen = new Map();
  for (const item of artifacts) {
    if (!byScreen.has(item.screenId)) byScreen.set(item.screenId, []);
    byScreen.get(item.screenId).push(item);
  }
  for (const [screenId, items] of byScreen) {
    lines.push(`#### ${screenId}`);
    for (const item of items) {
      const label = `${item.captureKey} (${item.viewport})`;
      const url = rawGitHubImageUrl(repo, sha, item.path);
      lines.push(`<details><summary>${label}</summary>`, '', `![${screenId} ${label}](${url})`, '', '</details>');
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

/**
 * Attach captured screenshots to the active pull request (markdown images on the PR head commit).
 *
 * @param {string} root
 * @param {{ pr?: string|number, artifacts?: object[], deps?: object }} [options]
 */
export async function attachScreenshotsToPullRequest(root, { pr, artifacts = [], deps = {} } = {}) {
  const events = [];
  const record = (kind, detail) => { events.push({ at: new Date().toISOString(), kind, ...detail }); };
  const flushOnFailure = (error) => {
    if (error) {
      process.stderr.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    }
  };

  try {
    if (!artifacts.length) throw fail('visual-qa-attach', 'no screenshot artifacts to attach');
    const execFileImpl = deps.execFile ?? execFileAsync;
    const gh = deps.gh ?? ((args) => ghExec(args, { cwd: root, execFileImpl }));

    let prNumber = null;
    let repo = deps.repo ?? null;
    if (pr !== undefined && pr !== null) {
      const parsed = parsePrArgument(String(pr));
      if (!parsed) throw fail('visual-qa-attach', 'invalid pr argument');
      prNumber = parsed.number;
      repo = parsed.repo ?? repo;
    }

    const viewArgs = ['pr', 'view'];
    if (prNumber) viewArgs.push(String(prNumber));
    if (repo) viewArgs.push('--repo', repo);
    viewArgs.push('--json', 'number,headRefOid,headRepository');
    const view = await gh(viewArgs);
    if (view.code !== 0) throw fail('visual-qa-attach', `gh pr view failed: ${view.stderr.trim().split('\n')[0] || 'error'}`);
    let prJson;
    try { prJson = JSON.parse(view.stdout); } catch {
      throw fail('visual-qa-attach', 'gh pr view returned unreadable json');
    }
    prNumber = prNumber ?? prJson.number;
    const sha = prJson.headRefOid;
    const fullRepo = repo ?? prJson.headRepository?.nameWithOwner;
    if (!prNumber || !sha || !fullRepo) throw fail('visual-qa-attach', 'could not resolve pr number, head sha or repository');

    const body = buildPrCommentBody(fullRepo, sha, artifacts);
    record('attach', { pr: prNumber, repo: fullRepo, sha, count: artifacts.length });
    const comment = await gh(['pr', 'comment', String(prNumber), '--repo', fullRepo, '--body', body]);
    if (comment.code !== 0) {
      throw fail('visual-qa-attach', `gh pr comment failed: ${comment.stderr.trim().split('\n')[0] || 'error'}`);
    }
    return { ok: true, pr: prNumber, repo: fullRepo, sha, artifactCount: artifacts.length };
  } catch (error) {
    flushOnFailure(error);
    throw error;
  }
}

/**
 * Capture phone and desktop screenshots for changed pages, then attach them to the PR (AC1).
 *
 * @param {string} root
 * @param {object} [options]
 */
export async function captureAndAttachVisualQaScreenshots(root, options = {}) {
  const capture = await captureScreenshotsForChangedPages(root, options);
  if (capture.skipped || !capture.artifacts?.length) {
    return { ...capture, attached: false };
  }
  const attach = await attachScreenshotsToPullRequest(root, {
    pr: options.pr,
    artifacts: capture.artifacts,
    deps: options.deps,
    repo: options.repo,
  });
  return { ...capture, attached: true, attach };
}

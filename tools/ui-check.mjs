// SPDX-License-Identifier: Apache-2.0
// `swarm ui check` and `swarm ui list` (lesson 27): render each design screen's mockup and the real page in a browser,
// take screenshots, and compare them (fonts, colors, text, overflow, a coarse visual grid). The browser is the project's
// own Playwright, run by a small script; the swarm itself has no browser dependency.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decodePng, gridSignature, compareSignatures } from './png-signature.mjs';
import { compareScreen, UI_DEFAULTS } from './ui-compare.mjs';
import { readProfile, contextEnvFor } from './scope-commands.mjs';
import { freePort, expandStart, startEnv, mockupUrlSuffix } from './ui-server.mjs';
import { workTreeFingerprint } from './work-tree.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

const execFileAsync = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });
const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TZ', 'TMPDIR', 'CI', 'NODE_ENV', 'PLAYWRIGHT_BROWSERS_PATH'];
const allowedEnv = (extra = {}) => ({ ...Object.fromEntries(ENV_ALLOW.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), ...extra });

export const UI_USAGE = 'Usage: swarm ui check [SCREEN_ID...] [--base-url URL] [--json]\n       swarm ui list\n';

// Only this machine: a design check must never reach out to anything else.
export function localHttpUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) return null;
  return url.origin;
}

// The browser script. It is fixed text: every value reaches it through a JSON file named in argv, never spliced into the code.
export const BROWSER_SCRIPT = `
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let chromium;
try {
  const require = createRequire(path.join(spec.root, 'package.json'));
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
} catch (error) {
  console.log('UI_RESULT ' + JSON.stringify({ error: 'playwright-missing' }));
  process.exit(0);
}
const measure = () => {
  // Every color is turned into plain rgb through a one-pixel canvas, so wide-gamut values (oklch, lab, color()) compare like any other.
  const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = value => { try { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return d[3] === 0 ? null : 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'; } catch { return null; } };
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const family = el => getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/["']/g, '');
  const fonts = new Set(), colors = new Set(), backgrounds = new Set();
  for (const el of document.querySelectorAll('body, body *')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) { fonts.add(family(el)); const c = rgb(s.color); if (c) colors.add(c); }
    if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') { const c = rgb(s.backgroundColor); if (c) backgrounds.add(c); }
  }
  const text = document.body.innerText.toLowerCase();
  const words = [...new Set(text.match(/[a-z]{4,}/g) || [])].slice(0, 400);
  const bodyFont = family(document.body);
  const bodyMargin = getComputedStyle(document.body).margin;
  const serifDefault = /^(times|times new roman|serif)$/i.test(bodyFont);
  return { viewportWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyFont, bodyMargin, fonts: [...fonts], colors: [...colors], backgrounds: [...backgrounds], words, styled: !(serifDefault && bodyMargin === '8px' && backgrounds.size === 0) };
};
const browser = await chromium.launch();
const results = [];
try {
  for (const screen of spec.screens) {
    const entry = { id: screen.id };
    for (const side of ['mockup', 'page']) {
      const context = await browser.newContext({ viewport: screen.viewport });
      // Documents only load from this machine (the mockup file and the local server): a redirect or script cannot take the page elsewhere.
      await context.route('**/*', route => {
        const request = route.request();
        const url = request.url();
        const hostOk = ['http://127.0.0.1', 'http://localhost', 'http://[::1]'].some(prefix => url === prefix || ['/', ':', '?', '#'].includes(url.charAt(prefix.length)) && url.startsWith(prefix));
        const local = ['file:', 'about:', 'data:', 'blob:'].some(scheme => url.startsWith(scheme)) || hostOk;
        return request.resourceType() === 'document' && !local ? route.abort() : route.continue();
      });
      const page = await context.newPage();
      try {
        await page.goto(screen[side + 'Url'], { waitUntil: 'load', timeout: spec.timeoutMs });
        if (screen.waitFor) { try { await page.waitForSelector(screen.waitFor, { timeout: 15000 }); } catch (waitError) { /* the metrics show what is missing */ } }
        await page.waitForTimeout(600);
        const file = path.join(spec.out, screen.id, side + '.png');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, timeout: spec.timeoutMs });
        const metrics = await Promise.race([page.evaluate(measure), new Promise((_, reject) => setTimeout(() => reject(new Error('measure timed out')), 15000))]);
        entry[side] = { metrics, screenshot: file };
      } catch (error) {
        entry[side] = { error: String(error && error.message || error).slice(0, 200) };
      } finally { await context.close(); }
    }
    results.push(entry);
  }
} finally { await browser.close(); }
console.log('UI_RESULT ' + JSON.stringify({ screens: results }));
`;

async function atomicWrite(root, segments, text) {
  const dir = await safeWritableDir(root, segments.slice(0, -1));
  const file = path.join(dir, segments.at(-1));
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.${segments.at(-1)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(text); await handle.sync(); await handle.close(); await fs.rename(tmp, file); }
  catch (error) { await handle.close().catch(() => {}); await fs.rm(tmp, { force: true }); throw error; }
}

// Process groups started by a run, killed on exit, Ctrl-C or SIGTERM.
const live = new Set();
function killLive() { for (const pid of live) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } } live.clear(); }
function withSignals(fn) {
  const onSignal = signal => { killLive(); process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm); process.kill(process.pid, signal); };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return fn().finally(() => { process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm); killLive(); });
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child.pid);
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
    const done = code => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hard); live.delete(child.pid); resolve({ code, stdout, stderr, timedOut }); };
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, timeoutMs);
    const hard = setTimeout(() => done(null), timeoutMs + 5000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-4_000_000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    child.on('error', error => { stderr += String(error.message); done(null); });
    child.on('exit', code => { kill('SIGKILL'); setTimeout(() => done(code), 500); });
  });
}

async function answers(url, fetchImpl, timeoutMs = 2000) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.status > 0 && res.status < 500;
  } catch { return false; }
}

// Starts the profile's dev server when nothing answers at the base url. Returns { stop, started }.
async function ensureServer(config, baseUrl, fetchImpl, { cwd, log, explicitBase = false }) {
  // With a start command the check runs its own server on a free port: the owner's dev server (which may serve other code) is never used.
  // An explicit --base-url, or a profile without a start command, uses what answers there.
  const own = Boolean(config.start) && !explicitBase;
  const port = own ? String(await freePort()) : new URL(baseUrl).port;
  if (own) baseUrl = `http://127.0.0.1:${port}`;
  const ready = baseUrl + config.readyPath;
  if (!own && await answers(ready, fetchImpl)) return { stop: async () => {}, started: false, base: baseUrl };
  if (!config.start) throw fail('ui-server', `nothing answers at ${ready} and the profile has no ui.start command`);
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ui-server-'));
  const logFile = path.join(logDir, 'server.log');
  const handle = await fs.open(logFile, 'wx');
  const portNumber = Number(port) || 80;
  const startArgv = expandStart(config.start, portNumber);
  const child = spawn(startArgv[0], startArgv.slice(1), { cwd, shell: false, detached: true, stdio: ['ignore', handle.fd, handle.fd], env: allowedEnv(startEnv(portNumber)) });
  live.add(child.pid);
  let exited = false;
  child.on('error', () => { exited = true; });
  child.on('exit', () => { exited = true; });
  const stop = async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } live.delete(child.pid); await handle.close().catch(() => {}); await fs.rm(logDir, { recursive: true, force: true }); };
  const deadline = Date.now() + config.timeoutSec * 1000;
  while (Date.now() < deadline && !exited) {
    // Only an answer while our own child is still running counts: another process on the port is not evidence.
    if (await answers(ready, fetchImpl) && !exited) { log?.(`dev server started: ${startArgv.join(' ')}`); return { stop, started: true, base: baseUrl }; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const tail = (await fs.readFile(logFile, 'utf8').catch(() => '')).slice(-400);
  await stop();
  throw fail('ui-server', `${exited ? 'the dev server command exited' : `the dev server did not answer within ${config.timeoutSec} seconds`} (${ready})${tail ? `: ${tail.replace(/\s+/g, ' ')}` : ''}`);
}

async function gitHead(root) {
  try { return (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(); } catch { return null; }
}

// The default browser step: runs BROWSER_SCRIPT with the project's own Playwright.
async function runBrowser({ root, screens, out, timeoutMs }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ui-'));
  try {
    const scriptFile = path.join(dir, 'shots.mjs');
    const specFile = path.join(dir, 'spec.json');
    await fs.writeFile(scriptFile, BROWSER_SCRIPT);
    await fs.writeFile(specFile, JSON.stringify({ root, screens, out, timeoutMs: Math.min(timeoutMs, 60000) }));
    const run = await runProcess(process.execPath, [scriptFile, specFile], { cwd: root, env: allowedEnv(), timeoutMs: screens.length * 130000 + 30000 });
    const line = run.stdout.split('\n').reverse().find(l => l.startsWith('UI_RESULT '));
    if (!line) throw fail('ui-browser', `the browser script gave no result${run.timedOut ? ' (timed out)' : ''}: ${run.stderr.replace(/\s+/g, ' ').slice(-300)}`);
    let parsed;
    try { parsed = JSON.parse(line.slice('UI_RESULT '.length)); } catch { throw fail('ui-browser', 'the browser script gave an unreadable result'); }
    if (!Array.isArray(parsed.screens) && parsed.error !== 'playwright-missing') throw fail('ui-browser', 'the browser script gave no screens');
    if (parsed.error === 'playwright-missing') throw fail('ui-playwright-missing', 'Playwright is not installed in the project (npm install -D @playwright/test, then npx playwright install chromium)');
    return parsed.screens;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export async function listUiScreens(root) {
  const profile = await readProfile(root);
  return profile?.ui?.screens ?? [];
}

export async function readUiResults(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, '.swarm', 'ui', 'results.json'), 'utf8')); } catch { return null; }
}

// deps (for tests): fetchImpl, browser({ root, screens, out, timeoutMs }) -> [{ id, mockup, page }], now, head, tree.
export async function runUiCheck(root, { ids = [], baseUrl: override, deps = {} } = {}) {
  return withSignals(() => runUiCheckInner(root, { ids, baseUrl: override, deps }));
}

async function runUiCheckInner(root, { ids, baseUrl: override, deps }) {
  const profile = await readProfile(root);
  const config = profile?.ui;
  if (!config) throw fail('ui-config', 'the profile has no valid ui block (see docs/ui-check.md)');
  const base = localHttpUrl(override ?? config.baseUrl ?? UI_DEFAULTS.baseUrl);
  if (!base) throw fail('ui-base-url', 'the base url must be http on 127.0.0.1, localhost or [::1]');
  const chosen = ids.length ? ids.map(id => config.screens.find(screen => screen.id === id) ?? (() => { throw fail('ui-screen', `no screen ${id} in the profile`); })()) : config.screens;
  const env = contextEnvFor(root, profile);
  const realRoot = await fs.realpath(root);
  const checkMockups = () => { for (const screen of chosen) if (!env.existsMockup(screen.mockup)) throw fail('ui-mockup', `the mockup of ${screen.id} (${screen.mockup}) is missing, a symlink, or not an allowed project file`); };
  checkMockups();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const server = await ensureServer(config, base, fetchImpl, { cwd: root, explicitBase: override !== undefined });
  const pageBase = server.base ?? base;
  const shotsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ui-shots-'));
  let shots;
  try {
    // The dev server runs project code: the mockups are checked again right before the browser opens them.
    checkMockups();
    const specScreens = chosen.map(screen => ({ id: screen.id, viewport: screen.viewport ?? config.viewport, mockupUrl: pathToFileURL(path.join(realRoot, screen.mockup)).href + mockupUrlSuffix(screen), pageUrl: pageBase + screen.route, ...(screen.waitFor ? { waitFor: screen.waitFor } : {}) }));
    shots = await (deps.browser ?? runBrowser)({ root: realRoot, screens: specScreens, out: shotsDir, timeoutMs: config.timeoutSec * 1000 });
    const tree = deps.tree !== undefined ? deps.tree : await workTreeFingerprint(root);
    return await finishUiCheck(root, { chosen, shots, shotsDir, tree, serverStarted: server.started, deps });
  } finally { await server.stop(); await fs.rm(shotsDir, { recursive: true, force: true }); }
}

async function finishUiCheck(root, { chosen, shots, shotsDir, tree, serverStarted, deps }) {
  const inShots = file => typeof file === 'string' && path.resolve(file).startsWith(`${path.resolve(shotsDir)}${path.sep}`);
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const previous = (await readUiResults(root)) ?? { screens: {} };
  const results = { at, head: deps.head !== undefined ? deps.head : await gitHead(root), screens: { ...(previous.screens ?? {}) } };
  const lines = [];
  for (const screen of chosen) {
    const shot = shots.find(entry => entry.id === screen.id);
    let verdict;
    if (!shot?.mockup?.metrics || !shot?.page?.metrics || !inShots(shot.mockup.screenshot) || !inShots(shot.page.screenshot)) {
      verdict = { pass: false, score: 0, reasons: [`could not render: ${shot?.mockup?.error ? `mockup: ${shot.mockup.error}` : ''}${shot?.page?.error ? ` page: ${shot.page.error}` : ''}`.trim() || 'no result'], parts: null };
    } else {
      let visual = 0;
      try {
        const a = await fs.readFile(shot.mockup.screenshot);
        const b = await fs.readFile(shot.page.screenshot);
        visual = compareSignatures(gridSignature(decodePng(a)), gridSignature(decodePng(b))).score;
        // The screenshots are kept for the owner to look at, written by this process (never by the browser script).
        await atomicWrite(root, ['.swarm', 'ui', screen.id, 'mockup.png'], a).catch(() => {});
        await atomicWrite(root, ['.swarm', 'ui', screen.id, 'page.png'], b).catch(() => {});
      } catch (error) { verdict = { pass: false, score: 0, reasons: [`could not compare the screenshots: ${error.code ?? error.message}`], parts: null }; }
      verdict ??= compareScreen({ mockup: shot.mockup.metrics, page: shot.page.metrics, visual }, { minScore: screen.minScore, text: screen.text });
    }
    // tree: the exact code state this verdict is about; serverStarted: false means a server that was already running answered.
    const entry = { pass: verdict.pass, score: Number(verdict.score.toFixed(3)), reasons: verdict.reasons, parts: verdict.parts, at, tree, serverStarted };
    results.screens[screen.id] = entry;
    await atomicWrite(root, ['.swarm', 'ui', screen.id, 'report.json'], `${JSON.stringify({ id: screen.id, route: screen.route, mockup: screen.mockup, ...entry }, null, 2)}\n`).catch(() => {});
    lines.push({ id: screen.id, ...entry });
  }
  await atomicWrite(root, ['.swarm', 'ui', 'results.json'], `${JSON.stringify(results, null, 2)}\n`);
  return { ok: lines.every(line => line.pass), screens: lines, results };
}

export async function runUiCommand(root, args, deps = {}) {
  const [verb, ...rest] = args;
  try {
    if (verb === 'list') {
      const screens = await listUiScreens(root);
      return { stdout: screens.length ? `${screens.map(s => `${s.id}  ${s.route}  ${s.mockup}`).join('\n')}\n` : 'no ui screens in the profile\n', exitCode: 0 };
    }
    if (verb !== 'check') return { stdout: UI_USAGE, exitCode: 1 };
    const ids = [];
    let baseUrl, json = false;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--base-url') { baseUrl = rest[i + 1]; i += 1; if (baseUrl === undefined) return { stdout: UI_USAGE, exitCode: 1 }; }
      else if (rest[i] === '--json') json = true;
      else if (rest[i].startsWith('--')) return { stdout: `${UI_USAGE}unknown flag ${rest[i]}\n`, exitCode: 1 };
      else ids.push(rest[i]);
    }
    const result = await runUiCheck(root, { ids, baseUrl, deps });
    if (json) return { stdout: `${JSON.stringify(result.results)}\n`, exitCode: result.ok ? 0 : 1 };
    const lines = result.screens.map(s => `${s.pass ? 'pass' : 'FAIL'} ${s.id} ${s.score}${s.reasons.length ? `  ${s.reasons.join('; ')}` : ''}`);
    return { stdout: `${lines.join('\n')}\nscreenshots and reports: .swarm/ui/\n`, exitCode: result.ok ? 0 : 1 };
  } catch (error) {
    if (error.code && /^(ui|png|signature)/.test(error.code)) return { stdout: `${error.code}: ${error.message}\n`, exitCode: 1 };
    throw error;
  }
}

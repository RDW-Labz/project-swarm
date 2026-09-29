// SPDX-License-Identifier: Apache-2.0
// T52b (#262): an optional `swarm verify --orb` step a frontend job can name. Serves a small
// fixture app (a frontend job names its own, at the same conventional path) and runs one saved
// orb scenario in the toolchain's own Chromium, driven by Playwright inside a worker this module
// spawns under the toolchain's own Node (never the running process's own Node, never system
// Node/PATH-resolved npx) — decision #249's toolchains-only rule. The orb token (#262) reaches that
// worker only via its own env var, generated fresh per run, never written to a file.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ORB_TOKEN_ENV = 'SWARM_VERIFY_ORB_TOKEN';

// This file's own package (ownRoot in tools/swarm.mjs), so `--scenario NAME` resolves against the
// scenario this tool ships with regardless of which project's workspace `swarm verify --orb` runs
// inside of.
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SCENARIO_DIR = path.join(packageRoot, 'tests', 'orb-scenarios');

// Field lesson pattern (rig.portFile, keychain.service): a public repo names no private clone path
// as a source literal; `config.orb.clonePath` is the new stored field, `home`-relative below is its
// legacy default (the fixed path `.swarm-manifests/toolchain-versions.md` names for this machine).
// Kept as a stored field in its own right (a project's config may still want to record where an
// orb-style clone lives for other purposes); `resolveOrbToolchain` below no longer reads it, since
// the toolchain's own copied Playwright (s55) replaced the orb clone's `node_modules/playwright` as
// the toolchain source.
export function orbClonePath(config = {}, { home = os.userInfo().homedir } = {}) {
  const configured = config?.orb?.clonePath;
  return typeof configured === 'string' && configured ? configured : path.join(home, 'Documents', 'repos-projects', 'orb');
}

const CHROMIUM_HEADLESS_BUILD = 'chromium_headless_shell-1243';
const REQUIRED_PLAYWRIGHT_VERSION = '1.63.0';

async function pathExists(access, file) {
  try { await access(file); return true; } catch { return false; }
}

// Resolves only from `~/.project-swarm/toolchains` (#249, s55: Playwright copied in there directly,
// never the orb clone). Any of node/Playwright(-at-the-pinned-version)/chromium browsers missing
// throws, naming exactly what's missing; never a fallback to system Node or a PATH-resolved npx.
// `home` defaults from the real OS user (os.userInfo, not os.homedir/$HOME) since the toolchains
// directory lives under the machine's real user even when a job's own HOME is scoped to a scratch
// directory.
export async function resolveOrbToolchain({ home = os.userInfo().homedir, access = file => fs.access(file), readFile = file => fs.readFile(file, 'utf8') } = {}) {
  const toolchains = path.join(home, '.project-swarm', 'toolchains');
  const nodeBin = path.join(toolchains, 'node', 'current', 'bin', 'node');
  const nodeModulesDir = path.join(toolchains, 'node_modules');
  const playwrightPackageJson = path.join(nodeModulesDir, 'playwright', 'package.json');
  const browsersPath = path.join(toolchains, 'ms-playwright');
  const browserBin = path.join(browsersPath, CHROMIUM_HEADLESS_BUILD, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  const missing = [];
  if (!(await pathExists(access, nodeBin))) missing.push(`node: ${nodeBin}`);
  let playwrightVersion;
  try { playwrightVersion = JSON.parse(await readFile(playwrightPackageJson)).version; }
  catch { missing.push(`playwright: ${playwrightPackageJson}`); }
  if (playwrightVersion !== undefined && playwrightVersion !== REQUIRED_PLAYWRIGHT_VERSION) {
    missing.push(`playwright: expected ${REQUIRED_PLAYWRIGHT_VERSION}, found ${playwrightVersion} at ${playwrightPackageJson}`);
  }
  if (!(await pathExists(access, browserBin))) missing.push(`chromium browsers: ${browserBin}`);
  if (missing.length) throw Object.assign(Error(`orb toolchain missing: ${missing.join('; ')}`), { missing });
  return { nodeBin, nodeModulesDir, browsersPath };
}

const SCENARIO_NAME = /^[A-Za-z0-9_-]+$/;

// Reads/validates a scenario file; an unknown name (or one that fails the name shape, blocking path
// traversal) always throws `scenario not found` — it never silently falls back to any other saved
// scenario, "home" included.
export async function loadOrbScenario(name, { scenarioDir = DEFAULT_SCENARIO_DIR, readFile = file => fs.readFile(file, 'utf8') } = {}) {
  if (typeof name !== 'string' || !SCENARIO_NAME.test(name)) throw Error(`scenario not found: ${name}`);
  const file = path.join(scenarioDir, `${name}.json`);
  let text;
  try { text = await readFile(file); } catch { throw Error(`scenario not found: ${name}`); }
  let data;
  try { data = JSON.parse(text); } catch { throw Error(`invalid scenario JSON: ${name}`); }
  if (!data || typeof data !== 'object' || typeof data.route !== 'string' || !Array.isArray(data.setup) || !Array.isArray(data.assertions)) {
    throw Error(`invalid scenario shape: ${name}`);
  }
  return { name: typeof data.name === 'string' ? data.name : name, route: data.route, setup: data.setup, assertions: data.assertions, screenshot: Boolean(data.screenshot) };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The fixture a project names at this conventional path: a static `index.html` plus a tiny
// `fake-service.mjs` exporting `createFakeService({token})` -> `{ setOrbState(...), ...,
// handleRequest(req,res) }` — the same shape this repo's own tests/fixtures/verify-orb ships.
async function defaultStartApp({ appDir, token }) {
  const indexHtml = await fs.readFile(path.join(appDir, 'index.html'), 'utf8');
  const { createFakeService } = await import(pathToFileURL(path.join(appDir, 'fake-service.mjs')).href);
  const service = createFakeService({ token });
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(indexHtml); return; }
    service.handleRequest(request, response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, service, close: () => new Promise(resolve => server.close(resolve)) };
}

// Runs entirely inside the spawned worker (toolchain Node): loads the toolchain's own Playwright via
// `createRequire(nodeModulesDir + '/')` (never a bare `require('playwright')`, which would resolve
// against this file's own — possibly absent or wrong-version — node_modules), launches Chromium
// headless, injects the token into the page's own JS context via `page.addInitScript` (never a file,
// never a URL) before navigating, waits for each assertion with `locator(...).waitFor`/`getByText`,
// and screenshots when asked. Reads its one token from its own env only — never from argv, which
// carries every other (non-secret) parameter as one JSON blob.
const WORKER_SOURCE = `
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const params = JSON.parse(process.argv[1]);
const { nodeModulesDir, url, assertions, screenshotPath, assertionTimeoutMs, launchTimeoutMs } = params;
const token = process.env[__TOKEN_ENV__] ?? '';
function report(result) { process.stdout.write(JSON.stringify(result) + '\\n'); }
async function main() {
  const req = createRequire(nodeModulesDir + '/');
  const { chromium } = req('playwright');
  const browser = await chromium.launch({ headless: true, timeout: launchTimeoutMs });
  try {
    const page = await browser.newPage();
    await page.addInitScript(value => { window.__ORB_TOKEN__ = value; }, token);
    await page.goto(url, { timeout: launchTimeoutMs });
    let failedAssertion = null;
    for (const assertion of assertions) {
      try {
        if (assertion.type === 'selector') {
          await page.locator(assertion.selector).waitFor({ state: 'attached', timeout: assertionTimeoutMs });
        } else {
          await page.getByText(assertion.text).first().waitFor({ state: 'attached', timeout: assertionTimeoutMs });
        }
      } catch {
        failedAssertion = assertion;
        break;
      }
    }
    let screenshotWritten = false;
    if (screenshotPath) {
      const buffer = await page.screenshot();
      await fs.writeFile(screenshotPath, buffer);
      screenshotWritten = true;
    }
    if (failedAssertion) {
      const reason = failedAssertion.type === 'selector' ? 'selector ' + failedAssertion.selector + ' not found' : 'text not found: ' + JSON.stringify(failedAssertion.text);
      report({ status: 'fail', reason: 'assertion failed: ' + reason, screenshotWritten });
    } else {
      report({ status: 'pass', screenshotWritten });
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => report({ status: 'error', reason: String(error?.message ?? error) }));
`.replace('__TOKEN_ENV__', JSON.stringify(ORB_TOKEN_ENV));

// Spawns the worker under `toolchain.nodeBin` (never `process.execPath`, the running process's own
// — possibly system — Node) with the token set directly on its env (never appended to argv, which
// carries only `params`, already free of the token). `PLAYWRIGHT_BROWSERS_PATH` points Playwright at
// the toolchain's own pinned Chromium (#249); `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` blocks it from ever
// reaching the network for a browser this worker expects to already exist. `spawnImpl` is the
// injection seam so a test can inspect the exact command/args/env without a real Chromium launch. A
// bounded `workerTimeoutMs` force-kills the worker instead of leaving a caller to hang forever on a
// worker that never exits — the same "no hang" rule the preview-server wait keeps, applied here too.
export async function runOrbWorker({ toolchain, params, token, spawnImpl = spawn, workerTimeoutMs = 30000 } = {}) {
  const child = spawnImpl(toolchain.nodeBin, ['--input-type=module', '-e', WORKER_SOURCE, '--', JSON.stringify(params)], { env: { ...process.env, [ORB_TOKEN_ENV]: token, PLAYWRIGHT_BROWSERS_PATH: toolchain.browsersPath, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise(resolve => child.on('exit', resolve));
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => { child.kill?.('SIGKILL'); reject(Error('orb worker timed out')); }, workerTimeoutMs); });
  const code = await Promise.race([exited, timeout]).finally(() => clearTimeout(timer));
  const lines = stdout.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw Error(`orb worker produced no output (exit ${code}): ${stderr.slice(0, 500)}`);
  try { return JSON.parse(last); }
  catch { throw Error(`orb worker produced invalid output: ${last.slice(0, 200)}`); }
}

// The one entry point named in a manifest check's argv (`verify --orb --scenario NAME`). Order:
// scenario load, then toolchain resolution, then the app/browser — an unknown scenario or a missing
// toolchain path is refused before any browser (or even the fixture server) ever starts.
export async function runVerifyOrb({
  scenario = 'home', root = process.cwd(), appDir, scenarioDir,
  home = os.userInfo().homedir, access,
  resolveToolchain = resolveOrbToolchain, loadScenario = loadOrbScenario,
  startApp = defaultStartApp, runWorker = runOrbWorker,
  scratchDir, serverTimeoutMs = 15000, assertionTimeoutMs = 5000, launchTimeoutMs = 10000,
  now = Date.now, randomBytes = crypto.randomBytes,
} = {}) {
  const startedAt = now();
  const errorResult = reason => ({ verify: { status: 'error', scenario, reason, durationMs: now() - startedAt } });

  let scenarioData;
  try { scenarioData = await loadScenario(scenario, { scenarioDir }); }
  catch (error) { return errorResult(error.message); }

  let toolchain;
  try { toolchain = await resolveToolchain({ home, access }); }
  catch (error) { return errorResult(error.message); }

  const resolvedScratch = scratchDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-verify-orb-'));
  const resolvedAppDir = appDir ?? path.join(root, 'tests', 'fixtures', 'verify-orb');
  // Field lesson #262: generated fresh per run, in-process, never read from a keychain, config file
  // or the parent env — and never written back to any file below.
  const token = randomBytes(32).toString('hex');

  let app;
  try { app = await withTimeout(startApp({ appDir: resolvedAppDir, token }), serverTimeoutMs, 'preview-server-timeout'); }
  catch (error) { return errorResult(error.message); }

  try {
    for (const call of scenarioData.setup) await app.service[call.call](...(call.args ?? []));
    const screenshotPath = scenarioData.screenshot ? path.join(resolvedScratch, `${scenario}.png`) : undefined;
    const params = {
      nodeModulesDir: toolchain.nodeModulesDir,
      url: `${app.url}${scenarioData.route}`,
      assertions: scenarioData.assertions,
      screenshotPath,
      assertionTimeoutMs, launchTimeoutMs,
    };
    const outcome = await runWorker({ toolchain, params, token });
    const durationMs = now() - startedAt;
    if (outcome.status === 'error') return { verify: { status: 'error', scenario, reason: outcome.reason, durationMs } };
    if (outcome.status === 'fail') return { verify: { status: 'fail', scenario, reason: outcome.reason, screenshotPath, durationMs } };
    return { verify: { status: 'pass', scenario, screenshotPath, durationMs } };
  } catch (error) {
    return errorResult(error.message);
  } finally {
    await app.close().catch(() => {});
  }
}

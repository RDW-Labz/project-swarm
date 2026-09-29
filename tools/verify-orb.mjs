// SPDX-License-Identifier: Apache-2.0
// T52b (#262): an optional `swarm verify --orb` step a desktop-app job can name. Serves a small
// fixture app (a desktop-app job names its own, at the same conventional path) and runs one saved
// orb scenario in the toolchain's own Chromium, driven over the DevTools protocol by a worker this
// module spawns under the toolchain's own Node (never the running process's own Node, never system
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
export function orbClonePath(config = {}, { home = os.userInfo().homedir } = {}) {
  const configured = config?.orb?.clonePath;
  return typeof configured === 'string' && configured ? configured : path.join(home, 'Documents', 'repos-projects', 'orb');
}

const CHROMIUM_HEADLESS_BUILD = 'chromium_headless_shell-1243';

async function pathExists(access, file) {
  try { await access(file); return true; } catch { return false; }
}

// Resolves only from `~/.project-swarm/toolchains` and the orb clone's own node_modules (#249). Any
// of the three missing throws, naming exactly what's missing; never a fallback to system Node or a
// PATH-resolved npx. `home` defaults from the real OS user (os.userInfo, not os.homedir/$HOME) since
// the toolchains directory lives under the machine's real user even when a job's own HOME is
// scoped to a scratch directory.
export async function resolveOrbToolchain({ home = os.userInfo().homedir, config = {}, access = file => fs.access(file) } = {}) {
  const toolchains = path.join(home, '.project-swarm', 'toolchains');
  const nodeBin = path.join(toolchains, 'node', 'current', 'bin', 'node');
  const playwrightDir = path.join(orbClonePath(config, { home }), 'node_modules', 'playwright');
  const browsersPath = path.join(toolchains, 'ms-playwright');
  const browserBin = path.join(browsersPath, CHROMIUM_HEADLESS_BUILD, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  const missing = [];
  if (!(await pathExists(access, nodeBin))) missing.push(`node: ${nodeBin}`);
  if (!(await pathExists(access, playwrightDir))) missing.push(`playwright: ${playwrightDir}`);
  if (!(await pathExists(access, browserBin))) missing.push(`chromium browsers: ${browserBin}`);
  if (missing.length) throw Object.assign(Error(`orb toolchain missing: ${missing.join('; ')}`), { missing });
  return { nodeBin, playwrightDir, browsersPath, browserBin };
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

// Runs entirely inside the spawned worker (toolchain Node): launches the resolved Chromium binary
// headless, drives it over the DevTools protocol using the runtime's own global WebSocket (no
// `playwright` import needed for this), injects the token into the page's own JS context via
// `Page.addScriptToEvaluateOnNewDocument` (never a file, never a URL) before navigating, polls each
// assertion up to its own budget, and screenshots when asked. Reads its one token from its own env
// only — never from argv, which carries every other (non-secret) parameter as one JSON blob.
const WORKER_SOURCE = `
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
const params = JSON.parse(process.argv[1]);
const { browserBin, userDataDir, url, assertions, screenshotPath, assertionTimeoutMs, assertionPollMs, launchTimeoutMs } = params;
const token = process.env[__TOKEN_ENV__] ?? '';
function report(result) { process.stdout.write(JSON.stringify(result) + '\\n'); }
async function main() {
  await fs.mkdir(userDataDir, { recursive: true });
  const child = spawn(browserBin, ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + userDataDir, 'about:blank']);
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(Error('chromium-launch-timeout')), launchTimeoutMs);
    const onData = data => {
      buf += data.toString();
      const match = buf.match(/DevTools listening on (ws:\\/\\/\\S+)/);
      if (match) { clearTimeout(timer); child.stderr.off('data', onData); resolve(match[1]); }
    };
    child.stderr.on('data', onData);
    child.once('exit', code => { clearTimeout(timer); reject(Error('chromium-exited:' + code)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(Error('devtools-ws-failed'))); });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const send = (method, sendParams, sessionId) => new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: sendParams ?? {}, sessionId }));
  });
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result.targetId;
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  await send('Page.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ORB_TOKEN__=' + JSON.stringify(token) + ';' }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    return response.result?.result?.value;
  }
  function assertionExpr(assertion) {
    return assertion.type === 'selector'
      ? 'Boolean(document.querySelector(' + JSON.stringify(assertion.selector) + '))'
      : 'document.body.innerText.includes(' + JSON.stringify(assertion.text) + ')';
  }
  let failedAssertion = null;
  for (const assertion of assertions) {
    const deadline = Date.now() + assertionTimeoutMs;
    let holds = false;
    for (;;) {
      holds = Boolean(await evaluate(assertionExpr(assertion)));
      if (holds || Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, assertionPollMs));
    }
    if (!holds) { failedAssertion = assertion; break; }
  }
  let screenshotWritten = false;
  if (screenshotPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(screenshotPath, Buffer.from(shot.result.data, 'base64'));
    screenshotWritten = true;
  }
  ws.close();
  child.kill();
  if (failedAssertion) {
    const reason = failedAssertion.type === 'selector' ? 'selector ' + failedAssertion.selector + ' not found' : 'text not found: ' + JSON.stringify(failedAssertion.text);
    report({ status: 'fail', reason: 'assertion failed: ' + reason, screenshotWritten });
  } else {
    report({ status: 'pass', screenshotWritten });
  }
}
main().catch(error => report({ status: 'error', reason: String(error?.message ?? error) }));
`.replace('__TOKEN_ENV__', JSON.stringify(ORB_TOKEN_ENV));

// Spawns the worker under `toolchain.nodeBin` (never `process.execPath`, the running process's own
// — possibly system — Node) with the token set directly on its env (never appended to argv, which
// carries only `params`, already free of the token). `spawnImpl` is the injection seam so a test can
// inspect the exact command/args/env without a real Chromium launch. A bounded `workerTimeoutMs`
// force-kills the worker (and, best-effort, whatever browser child it spawned) instead of leaving a
// caller to hang forever on a worker that never exits — the same "no hang" rule the preview-server
// wait keeps, applied here too.
export async function runOrbWorker({ toolchain, params, token, spawnImpl = spawn, workerTimeoutMs = 30000 } = {}) {
  const child = spawnImpl(toolchain.nodeBin, ['--input-type=module', '-e', WORKER_SOURCE, '--', JSON.stringify(params)], { env: { ...process.env, [ORB_TOKEN_ENV]: token } });
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
  home = os.userInfo().homedir, config = {}, access,
  resolveToolchain = resolveOrbToolchain, loadScenario = loadOrbScenario,
  startApp = defaultStartApp, runWorker = runOrbWorker,
  scratchDir, serverTimeoutMs = 15000, assertionTimeoutMs = 5000, assertionPollMs = 100, launchTimeoutMs = 10000,
  now = Date.now, randomBytes = crypto.randomBytes,
} = {}) {
  const startedAt = now();
  const errorResult = reason => ({ verify: { status: 'error', scenario, reason, durationMs: now() - startedAt } });

  let scenarioData;
  try { scenarioData = await loadScenario(scenario, { scenarioDir }); }
  catch (error) { return errorResult(error.message); }

  let toolchain;
  try { toolchain = await resolveToolchain({ home, config, access }); }
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
      browserBin: toolchain.browserBin,
      userDataDir: path.join(resolvedScratch, 'chrome-profile'),
      url: `${app.url}${scenarioData.route}`,
      assertions: scenarioData.assertions,
      screenshotPath,
      assertionTimeoutMs, assertionPollMs, launchTimeoutMs,
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

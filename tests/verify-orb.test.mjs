import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadLocalConfig } from '../tools/local-config.mjs';
import {
  ORB_TOKEN_ENV, runVerifyOrb, resolveOrbToolchain, loadOrbScenario, orbClonePath, runOrbWorker,
} from '../tools/verify-orb.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixtureAppDir = path.join(repoRoot, 'tests', 'fixtures', 'verify-orb');
const realHome = os.userInfo().homedir;
const REAL_NODE_BIN = path.join(realHome, '.project-swarm', 'toolchains', 'node', 'current', 'bin', 'node');
const REAL_BROWSER_BIN = path.join(realHome, '.project-swarm', 'toolchains', 'ms-playwright', 'chromium_headless_shell-1243', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
// Field lesson pattern (claude-shell.test.mjs's SANDBOX_SKIP): a Chromium-dependent test skips with
// a named reason when the toolchain browser genuinely is not installed on this machine, rather than
// failing spuriously; it never skips just because it *could*.
const CHROMIUM_SKIP = (!existsSync(REAL_NODE_BIN) || !existsSync(REAL_BROWSER_BIN)) && 'toolchain node/chromium not installed (.swarm-manifests/toolchain-versions.md)';

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-orb-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function walkFiles(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full));
    else out.push(full);
  }
  return out;
}

// --- test 1: pass, real Home scenario, real toolchain + real Chromium -------------------------

test('runVerifyOrb: Home scenario passes for real against the toolchain\'s own Chromium, with a screenshot', { skip: CHROMIUM_SKIP }, async t => {
  const scratchDir = await tmpDir(t);
  const result = await runVerifyOrb({ root: repoRoot, scratchDir });
  assert.equal(result.verify.status, 'pass');
  assert.equal(result.verify.scenario, 'home');
  assert.equal(typeof result.verify.durationMs, 'number');
  assert.ok(result.verify.screenshotPath.startsWith(scratchDir));
  const stat = await fs.stat(result.verify.screenshotPath);
  assert.ok(stat.size > 0);
});

// --- test 2: fail with screenshot, real Chromium, a wrong assertion ----------------------------

test('runVerifyOrb: a failed assertion reports status fail, still sets screenshotPath, names the failed assertion', { skip: CHROMIUM_SKIP }, async t => {
  const scratchDir = await tmpDir(t);
  const badScenario = { name: 'home', route: '/', setup: [{ call: 'setOrbState', args: ['proposal_ready'] }], assertions: [{ type: 'text', text: 'this text never appears' }], screenshot: true };
  const result = await runVerifyOrb({ root: repoRoot, scratchDir, loadScenario: async () => badScenario, assertionTimeoutMs: 500, assertionPollMs: 20 });
  assert.equal(result.verify.status, 'fail');
  assert.match(result.verify.reason, /this text never appears/);
  assert.ok(result.verify.screenshotPath);
  const stat = await fs.stat(result.verify.screenshotPath);
  assert.ok(stat.size > 0);
});

// --- test 3: missing toolchain ------------------------------------------------------------------

test('runVerifyOrb: a missing toolchain path returns status error naming it, before any server or browser starts', async () => {
  let appStarted = false, workerStarted = false;
  const access = async file => { if (file.includes('ms-playwright')) throw Error('ENOENT'); };
  const result = await runVerifyOrb({
    root: repoRoot, access,
    startApp: async () => { appStarted = true; return { url: 'http://x', service: {}, close: async () => {} }; },
    runWorker: async () => { workerStarted = true; return { status: 'pass' }; },
  });
  assert.equal(result.verify.status, 'error');
  assert.match(result.verify.reason, /chromium browsers/);
  assert.equal(appStarted, false);
  assert.equal(workerStarted, false);
});

test('resolveOrbToolchain: never falls back to a system Node or PATH-resolved npx; names every missing path', async () => {
  await assert.rejects(resolveOrbToolchain({ home: '/definitely-not-a-real-home-xyz' }), error => {
    assert.match(error.message, /node:/);
    assert.match(error.message, /playwright:/);
    assert.match(error.message, /chromium browsers:/);
    return true;
  });
});

// --- test 4: token never lands in a file, under the worktree or the run's own scratch dir -------

test('runVerifyOrb: after a full pass run, the token appears in no file under the worktree or the scratch dir', { skip: CHROMIUM_SKIP }, async t => {
  const scratchDir = await tmpDir(t);
  const cryptoMod = await import('node:crypto');
  let capturedToken;
  const result = await runVerifyOrb({
    root: repoRoot, scratchDir,
    randomBytes: size => { const bytes = cryptoMod.randomBytes(size); capturedToken = bytes.toString('hex'); return bytes; },
  });
  assert.equal(result.verify.status, 'pass');
  assert.ok(capturedToken && capturedToken.length === 64);
  const candidates = [...await walkFiles(repoRoot), ...await walkFiles(scratchDir)];
  for (const file of candidates) {
    const bytes = await fs.readFile(file).catch(() => null);
    if (bytes == null) continue;
    assert.equal(bytes.includes(Buffer.from(capturedToken)), false, `token leaked into ${file}`);
  }
});

// --- test 5: scenario not found ------------------------------------------------------------------

test('runVerifyOrb: an unknown --scenario name returns status error before toolchain resolution or a browser launch', async () => {
  let toolchainResolved = false;
  const result = await runVerifyOrb({
    root: repoRoot, scenario: 'no-such-scenario',
    resolveToolchain: async () => { toolchainResolved = true; return {}; },
  });
  assert.equal(result.verify.status, 'error');
  assert.match(result.verify.reason, /scenario not found: no-such-scenario/);
  assert.equal(toolchainResolved, false);
});

test('loadOrbScenario: an unknown name always throws — it never silently falls back to "home"', async () => {
  await assert.rejects(loadOrbScenario('does-not-exist'), /scenario not found: does-not-exist/);
  await assert.rejects(loadOrbScenario('../home'), /scenario not found/);
});

test('loadOrbScenario: loads the shipped home.json exactly per the contract\'s scout-proved Home check', async () => {
  const scenario = await loadOrbScenario('home');
  assert.equal(scenario.route, '/');
  assert.deepEqual(scenario.setup, [{ call: 'setOrbState', args: ['proposal_ready'] }]);
  assert.deepEqual(scenario.assertions, [{ type: 'selector', selector: '[data-look="ready"]' }, { type: 'text', text: 'Something needs you' }]);
  assert.equal(scenario.screenshot, true);
});

// --- test 6: preview server never ready -> timeout, no hang -------------------------------------

test('runVerifyOrb: a preview server that never becomes ready times out with status error, reason preview-server-timeout, no hang', async () => {
  // A watchdog around the call itself, not just serverTimeoutMs: if a regression removes the
  // internal timeout entirely, `startApp`'s never-resolving promise must not hang this test (or a
  // `swarm mutants` run) forever — it fails fast, naming exactly that, instead.
  const call = runVerifyOrb({ root: repoRoot, serverTimeoutMs: 50, startApp: () => new Promise(() => {}) });
  const watchdog = new Promise((_resolve, reject) => setTimeout(() => reject(Error('runVerifyOrb did not honor its own preview-server timeout')), 2000));
  const result = await Promise.race([call, watchdog]);
  assert.equal(result.verify.status, 'error');
  assert.equal(result.verify.reason, 'preview-server-timeout');
});

// --- token rule: env-only delivery to the spawned worker ----------------------------------------

function fakeChild({ stdout = '', exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('exit', exitCode);
  });
  return child;
}

test('runOrbWorker: spawns the toolchain\'s own Node (never the running process\'s own Node), token only in env, never in argv', async () => {
  let seenCmd, seenArgs, seenEnv;
  const spawnImpl = (cmd, args, options) => { seenCmd = cmd; seenArgs = args; seenEnv = options.env; return fakeChild({ stdout: JSON.stringify({ status: 'pass', screenshotWritten: false }) }); };
  const toolchain = { nodeBin: '/fake/toolchain/node/bin/node', browserBin: '/fake/chrome' };
  const outcome = await runOrbWorker({ toolchain, params: { browserBin: toolchain.browserBin }, token: 'SUPER-SECRET-TOKEN', spawnImpl });
  assert.equal(outcome.status, 'pass');
  assert.equal(seenCmd, toolchain.nodeBin);
  assert.notEqual(seenCmd, process.execPath);
  assert.equal(seenEnv[ORB_TOKEN_ENV], 'SUPER-SECRET-TOKEN');
  assert.equal(seenArgs.some(arg => String(arg).includes('SUPER-SECRET-TOKEN')), false);
});

test('runOrbWorker: a worker that reports no output raises, naming its exit code and stderr', async () => {
  const spawnImpl = () => fakeChild({ stdout: '', exitCode: 1 });
  await assert.rejects(runOrbWorker({ toolchain: { nodeBin: '/fake/node' }, params: {}, token: 't', spawnImpl }), /orb worker produced no output/);
});

// --- orbClonePath: new stored field + its legacy default, read from a real config file on disk ---

test('orbClonePath: config.orb.clonePath is the stored override; unset, it falls back to the legacy fixed path under home', () => {
  const home = '/Users/example';
  assert.equal(orbClonePath({}, { home }), path.join(home, 'Documents', 'repos-projects', 'orb'));
  assert.equal(orbClonePath({ orb: { clonePath: '/custom/orb' } }, { home }), '/custom/orb');
});

test('orbClonePath: a config file on disk with no orb.clonePath key loads to the same legacy default (from-disk legacy test)', async t => {
  const dir = await tmpDir(t);
  const configFile = path.join(dir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ keychain: { service: 'x' } }));
  const config = loadLocalConfig({ env: { SWARM_CONFIG: configFile, HOME: dir } });
  assert.equal('orb' in config, false);
  const home = '/Users/legacy-example';
  assert.equal(orbClonePath(config, { home }), path.join(home, 'Documents', 'repos-projects', 'orb'));
});

// SPDX-License-Identifier: Apache-2.0
// Field lessons #202, #206, #208 (swarm 1.26.0 batch M, job m2-core), plus the swarm.mjs comment scrub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runManifest, integrateRun, validateProject, inspectRun, transcriptLastActivity,
  SHELL_SUITE_BOILERPLATE, NEW_PERSISTED_FIELD_BOILERPLATE,
} from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';
import { loadLocalConfig } from '../tools/local-config.mjs';
import { parsePrivateNames } from '../tools/ship.mjs';

// Field lesson #211/#197: a test that asserts a private term is absent reads the terms from the
// local config's `privateNames` file (never spelled here); with no config, or an unreadable list,
// it skips with a clear reason instead of guessing or hardcoding the term itself.
async function loadPrivateTermsOrSkip(t) {
  let config;
  try { config = loadLocalConfig({}); } catch { t.skip('local config could not be read; nothing to scan for'); return null; }
  if (!config?.privateNames) { t.skip('no local config privateNames file configured; nothing to scan for'); return null; }
  try {
    const text = await fs.readFile(config.privateNames, 'utf8');
    return parsePrivateNames(text);
  } catch {
    t.skip(`configured privateNames file ${config.privateNames} could not be read`);
    return null;
  }
}

const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
const manifest = (jobExtra = {}, spec = {}) => ({ version: 1, jobs: [job(jobExtra)], ...spec });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-m2-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  return root;
}

// --- #202 (1/4): integrate --salvage accepts a timed-out job's own output ------------------------

test('#202: integrate --salvage accepts a timed-out job\'s already-written output; without --salvage it refuses', async t => {
  const root = await fixture(t);
  const timeoutScript = "require('fs').writeFileSync('input.txt','from timeout');setInterval(()=>{},1000);";
  const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', timeoutScript], options);
  const state = await runManifest(root, manifest({ timeoutMs: 150 }), { spawnImpl });
  assert.equal(state.jobs[0].status, 'timeout');
  assert.ok(state.jobs[0].keptWorkspace, 'a timed-out job with a real output change keeps its workspace');
  await assert.rejects(integrateRun(root, state.id), /Only a complete/);
  const result = await integrateRun(root, state.id, { salvage: true });
  assert.equal(result.status, 'integrated');
  assert.equal(result.salvaged, true);
  assert.deepEqual(result.salvagedJobs, ['writer']);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'from timeout');
});

test('#202: --salvage still hash-checks against base (a real conflict still refuses) and cannot be combined with --no-checks', async t => {
  const root = await fixture(t);
  const timeoutScript = "require('fs').writeFileSync('input.txt','from timeout');setInterval(()=>{},1000);";
  const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', timeoutScript], options);
  const state = await runManifest(root, manifest({ timeoutMs: 150 }), { spawnImpl });
  await assert.rejects(integrateRun(root, state.id, { salvage: true, noChecks: true }), /--no-checks and --salvage/);
  await fs.writeFile(path.join(root, 'input.txt'), 'changed since the snapshot');
  await assert.rejects(integrateRun(root, state.id, { salvage: true }), /Integration conflict/);
});

// --- #202 (2/4): shell preset boilerplate: run your own tests, the full suite runs at integrate ---

const shellHooksM2 = { access: async () => {}, resolveClaude: async () => '/opt/fake-claude/bin/claude.exe', scanListeningPorts: async () => [] };
const noKeychainM2 = () => { throw new Error('the real keychain must never be read in tests'); };
const shellRunEnvM2 = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: 'sk-FAKE-m2-0000' };
const shellJobM2 = (overrides = {}) => ({ id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });

async function shellRepo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-m2-shell-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}
function fakeShellSpawnM2(script) {
  return (command, args, options) => {
    if (command === 'sandbox-exec') return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
    return spawn(command, args, options);
  };
}
const shellWorkerDoneM2 = "fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));";

test('#202: a shell job\'s own message says to run only its own test files, never the full suite itself', { skip: process.env.SWARM_IN_SANDBOX ? 'nested sandbox: cannot spawn a real sandbox-exec' : false }, async t => {
  const root = await shellRepo(t);
  const state = await runManifest(root, { version: 1, jobs: [shellJobM2()] }, { platform: 'darwin', spawnImpl: fakeShellSpawnM2(shellWorkerDoneM2), env: shellRunEnvM2, keyExec: noKeychainM2, shellHooks: shellHooksM2 });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/message.txt'), 'utf8');
  assert.ok(message.includes(SHELL_SUITE_BOILERPLATE), message);
  assert.ok(message.includes(NEW_PERSISTED_FIELD_BOILERPLATE), message);
});

// --- #202 (3/4): validate/run warns when two shell jobs share one root and both ask for the full suite

test('#202: validate warns when two shell jobs in one manifest each ask for "the full suite"', async t => {
  const root = await fixture(t);
  const twoShellJobs = {
    version: 1,
    jobs: [
      { id: 'a', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Fix the bug, then run the full test suite twice.', context: ['input.txt'], outputs: ['output-a.txt'] },
      { id: 'b', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Also run the full suite once you are done.', context: ['input.txt'], outputs: ['output-b.txt'] },
    ],
  };
  const result = await validateProject(root, twoShellJobs);
  assert.ok(result.warnings.some(w => w.code === 'shared-root-full-suite' && w.jobIds.includes('a') && w.jobIds.includes('b')), JSON.stringify(result.warnings));
});

test('#202: no shared-root-full-suite warning for only one full-suite shell job, or for non-shell jobs', async t => {
  const root = await fixture(t);
  const oneShellJob = { version: 1, jobs: [{ id: 'a', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Run the full suite.', context: ['input.txt'], outputs: ['output-a.txt'] }] };
  assert.deepEqual((await validateProject(root, oneShellJob)).warnings.filter(w => w.code === 'shared-root-full-suite'), []);
  const twoNonShellJobs = {
    version: 1,
    jobs: [
      { id: 'a', agent: 'claude', model: 'sonnet', prompt: 'Run the full test suite.', context: ['input.txt'], outputs: ['output-a.txt'] },
      { id: 'b', agent: 'claude', model: 'sonnet', prompt: 'Run the full suite too.', context: ['input.txt'], outputs: ['output-b.txt'] },
    ],
  };
  assert.deepEqual((await validateProject(root, twoNonShellJobs)).warnings.filter(w => w.code === 'shared-root-full-suite'), []);
});

// --- #202 (4/4): a timeout's result names what the transcript shows it was last doing -------------

test('#202: transcriptLastActivity names a sleep waiting on a backgrounded command', () => {
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q', run_in_background: true } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 60' } }] } }),
  ].join('\n');
  assert.equal(transcriptLastActivity(stdout), 'sleep waiting on pytest');
  assert.equal(transcriptLastActivity(''), null);
  assert.equal(transcriptLastActivity('not json\n{"type":"assistant"}'), null);
});

test('#202: a timed-out job\'s state record carries lastActivity from its own transcript', async t => {
  const root = await fixture(t);
  const script = "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'pytest -q',run_in_background:true}}]}}));"
    + "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'sleep 60'}}]}}));"
    + 'setInterval(()=>{},1000);';
  const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', script], options);
  const state = await runManifest(root, manifest({ timeoutMs: 150 }), { spawnImpl });
  assert.equal(state.jobs[0].status, 'timeout');
  assert.equal(state.jobs[0].lastActivity, 'sleep waiting on pytest');
});

// --- #206: inspect warns on a diff adding a field to a serialized dataclass with no self-report ---

const dataclassManifest = () => ({
  version: 1,
  jobs: [{ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Add auto_titled.', context: ['model.py'], outputs: ['model.py'] }],
});
async function dataclassFixture(t, resultJson) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-m2-dc-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'model.py'), '@dataclass\nclass Entry:\n    id: str\n    title: str\n');
  const after = '@dataclass\nclass Entry:\n    id: str\n    title: str\n    auto_titled: bool = False\n';
  const script = `require('fs').writeFileSync('model.py', ${JSON.stringify(after)});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(resultJson)}}));`;
  const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', script], options);
  const state = await runManifest(root, dataclassManifest(), { spawnImpl });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  return { root, state };
}

test('#206: inspect warns when a diff adds a dataclass field and the job reports no newPersistedFields', async t => {
  const { root, state } = await dataclassFixture(t, JSON.stringify({ status: 'done' }));
  const inspected = await inspectRun(root, state.id);
  assert.ok(inspected.warnings.some(w => w.code === 'new-persisted-field-undeclared' && w.jobId === 'writer' && w.fields.includes('auto_titled')), JSON.stringify(inspected.warnings));
});

test('#206: no warning when the job\'s own result declares newPersistedFields', async t => {
  const { root, state } = await dataclassFixture(t, JSON.stringify({ status: 'done', newPersistedFields: [{ name: 'auto_titled', legacyDefault: false, why: 'existing chats keep their prior title behavior' }] }));
  const inspected = await inspectRun(root, state.id);
  assert.deepEqual(inspected.warnings.filter(w => w.code === 'new-persisted-field-undeclared'), []);
});

// --- #208: validate warns on tier:"cheap"+claude when config names a cheaper model ----------------

async function cheapConfigFixture(t, config) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-m2-config-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const configPath = path.join(configDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  return configPath;
}

test('#208: validate warns on a cheap-tier claude job with no tierReason when config names a cheaper model', async t => {
  const root = await fixture(t);
  const configPath = await cheapConfigFixture(t, { tiers: { cheap: { agent: 'openrouter', model: 'deepseek-v4.1-flash' } } });
  const cheapManifest = { version: 1, jobs: [{ id: 'w', agent: 'claude', model: 'haiku', tier: 'cheap', prompt: 'Do the small thing.', context: ['input.txt'], outputs: ['input.txt'] }] };
  const result = await validateProject(root, cheapManifest, { env: { SWARM_CONFIG: configPath } });
  assert.ok(result.warnings.some(w => w.code === 'cheap-tier-not-configured-model' && w.jobId === 'w' && w.configuredModel === 'deepseek-v4.1-flash'), JSON.stringify(result.warnings));
});

test('#208: a stated tierReason silences the warning; no config also means no warning', async t => {
  const root = await fixture(t);
  const configPath = await cheapConfigFixture(t, { tiers: { cheap: { agent: 'openrouter', model: 'deepseek-v4.1-flash' } } });
  const reasoned = { version: 1, jobs: [{ id: 'w', agent: 'claude', model: 'haiku', tier: 'cheap', tierReason: 'CI edit, barred from DeepSeek by #227', prompt: 'Do the small thing.', context: ['input.txt'], outputs: ['input.txt'] }] };
  const result = await validateProject(root, reasoned, { env: { SWARM_CONFIG: configPath } });
  assert.deepEqual(result.warnings.filter(w => w.code === 'cheap-tier-not-configured-model'), []);
  const cheapManifest = { version: 1, jobs: [{ id: 'w', agent: 'claude', model: 'haiku', tier: 'cheap', prompt: 'Do the small thing.', context: ['input.txt'], outputs: ['input.txt'] }] };
  // Point at a config file that does not exist, never the real home config.
  const noConfigResult = await validateProject(root, cheapManifest, { env: { SWARM_CONFIG: path.join(root, 'no-such-config.json') } });
  assert.deepEqual(noConfigResult.warnings.filter(w => w.code === 'cheap-tier-not-configured-model'), []);
});

// --- swarm.mjs comment scrub: no product name in the scout/sweep decision comments ----------------

test('swarm.mjs comment scrub: no configured private term remains anywhere in the file', async t => {
  const terms = await loadPrivateTermsOrSkip(t);
  if (!terms) return;
  const text = await fs.readFile(SWARM_MJS, 'utf8');
  for (const term of terms) {
    const hit = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    assert.equal(hit, false, `${term} must not appear in the public repo source`);
  }
});

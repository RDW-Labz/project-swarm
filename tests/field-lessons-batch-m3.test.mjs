// SPDX-License-Identifier: Apache-2.0
// Batch M, job m3-scrub: row #197-followup (no product literal in a public repo; project
// specifics arrive via tools/local-config.mjs) and row #185-part (an OpenRouter incomplete reply
// names its finish_reason).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLocalConfig } from '../tools/local-config.mjs';
import { workerKeyItem, resolveWorkerKey, rigServicePortFile, resolveRigServicePort, RIG_SERVICE_DEFAULT_PORT, shellProfile } from '../tools/claude-shell.mjs';
import { openRouterKeyItem, readOpenRouterKey, describeIncompleteChatResponse, assertCompleteChatResponse, OpenRouterError } from '../tools/openrouter.mjs';
import { DENIED_HOME_DIRS, effectiveDeniedHomeDirs, validateReadPaths } from '../tools/codex-adapter.mjs';
import { parsePrivateNames } from '../tools/ship.mjs';

const SOURCE_FILES = ['../tools/claude-shell.mjs', '../tools/codex-adapter.mjs', '../tools/openrouter.mjs', '../tools/local-config.mjs'];

// --- row #197-followup: no product literal, project specifics arrive via config --------------

// Field lesson 112: a test that asserts a private term is absent reads the terms from the
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

test('#197-followup: no source string in these files names a configured private term (keychain service, app-support path, or home dir)', async t => {
  const terms = await loadPrivateTermsOrSkip(t);
  if (!terms) return;
  for (const relative of SOURCE_FILES) {
    const text = await fs.readFile(new URL(relative, import.meta.url), 'utf8');
    for (const term of terms) {
      const hit = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
      assert.equal(hit, false, `${relative} must not name ${term}`);
    }
  }
});

test('#197-followup: keychain service defaults to project-swarm and reads config keychain.service', () => {
  assert.deepEqual(workerKeyItem(), { service: 'project-swarm', account: 'anthropic.api_key' });
  assert.deepEqual(workerKeyItem({ keychain: { service: 'acme-swarm' } }), { service: 'acme-swarm', account: 'anthropic.api_key' });
  assert.deepEqual(openRouterKeyItem(), { service: 'project-swarm', account: 'openrouter.api_key' });
  assert.deepEqual(openRouterKeyItem({ keychain: { service: 'acme-swarm' } }), { service: 'acme-swarm', account: 'openrouter.api_key' });
});

test('#197-followup: resolveWorkerKey and readOpenRouterKey query the keychain item named by config, defaulting to project-swarm', async () => {
  let argv;
  const exec = async (bin, args) => { argv = [bin, ...args]; return { stdout: 'sk-fake-key-0000\n' }; };
  await resolveWorkerKey({ env: {}, exec, config: {} });
  assert.deepEqual(argv, ['/usr/bin/security', 'find-generic-password', '-s', 'project-swarm', '-a', 'anthropic.api_key', '-w']);
  await resolveWorkerKey({ env: {}, exec, config: { keychain: { service: 'acme-swarm' } } });
  assert.deepEqual(argv, ['/usr/bin/security', 'find-generic-password', '-s', 'acme-swarm', '-a', 'anthropic.api_key', '-w']);

  let orArgv;
  const orExec = (bin, args) => { orArgv = [bin, ...args]; return 'sk-fake-key-0000\n'; };
  readOpenRouterKey({}, { platform: 'darwin', exec: orExec, config: {} });
  assert.deepEqual(orArgv, ['/usr/bin/security', 'find-generic-password', '-s', 'project-swarm', '-a', 'openrouter.api_key', '-w']);
  readOpenRouterKey({}, { platform: 'darwin', exec: orExec, config: { keychain: { service: 'acme-swarm' } } });
  assert.deepEqual(orArgv, ['/usr/bin/security', 'find-generic-password', '-s', 'acme-swarm', '-a', 'openrouter.api_key', '-w']);
});

test('#197-followup: rig port file has no built-in path; absent config turns the feature off (null), config supplies the path', async () => {
  assert.equal(rigServicePortFile(), null);
  assert.equal(rigServicePortFile({}), null);
  assert.equal(rigServicePortFile({ rig: { portFile: '/custom/rig/service.port' } }), '/custom/rig/service.port');

  assert.equal(await resolveRigServicePort({ config: {} }), null, 'feature off: no read is attempted, no default port either');
  assert.equal(await resolveRigServicePort({ config: { rig: { portFile: '/custom/port' } }, read: async () => '4411\n' }), 4411);
  assert.equal(await resolveRigServicePort({ config: { rig: { portFile: '/custom/port' } }, read: async () => { throw Error('ENOENT'); } }), RIG_SERVICE_DEFAULT_PORT);
});

test('#197-followup: DENIED_HOME_DIRS keeps only generic entries; config deniedHomeDirs is additive', () => {
  assert.deepEqual([...DENIED_HOME_DIRS], ['Library/Keychains', '.ssh', '.aws', '.config']);
  assert.deepEqual(effectiveDeniedHomeDirs(), DENIED_HOME_DIRS);
  assert.deepEqual(effectiveDeniedHomeDirs({ deniedHomeDirs: ['.acme-app'] }), [...DENIED_HOME_DIRS, '.acme-app']);

  const home = '/Users/example';
  // With no config, a path under an arbitrary project-specific directory is not denied...
  assert.doesNotThrow(() => validateReadPaths([path.join(home, '.acme-app/secret.txt')], home));
  // ...but adding it through config denies it.
  assert.throws(() => validateReadPaths([path.join(home, '.acme-app/secret.txt')], home, { deniedHomeDirs: ['.acme-app'] }), /denied/);
  // The still-generic entries are denied either way.
  assert.throws(() => validateReadPaths([path.join(home, '.ssh/id_rsa')], home), /denied/);
});

test('#197-followup: shellProfile denies only the generic dirs by default, and config deniedHomeDirs additionally', () => {
  const base = { home: '/Users/example', worktree: '/Users/example/repo/.swarm/runs/r/worktrees/j', commonDir: '/Users/example/repo/.git', shellDir: '/Users/example/repo/.swarm/runs/r/j/shell', proxyPort: 1 };
  const plain = shellProfile(base);
  assert.equal(plain.includes('/Users/example/.acme-app'), false);
  assert.ok(plain.includes('(subpath "/Users/example/.ssh")'));
  const configured = shellProfile({ ...base, config: { deniedHomeDirs: ['.acme-app'] } });
  assert.ok(configured.includes('(subpath "/Users/example/.acme-app")'));
});

// Field lesson 112: the default moved off `<home>/.project-swarm/config.json` (inside the install
// checkout itself) to XDG/`~/.config`; a leftover file at that old path now refuses instead of
// being read. See tests/config-private-names.test.mjs (A1-A3) for the full default-path and
// refusal coverage.
test('#197-followup: loadLocalConfig reads SWARM_CONFIG, {} when missing, throws on invalid JSON, refuses a leftover file at the old default path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-local-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(loadLocalConfig({ home: dir, env: {} }), {});

  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ keychain: { service: 'acme-swarm' } }));
  assert.deepEqual(loadLocalConfig({ home: dir, env: { SWARM_CONFIG: file } }), { keychain: { service: 'acme-swarm' } });

  const homeWithOldConfig = path.join(dir, 'home');
  await fs.mkdir(path.join(homeWithOldConfig, '.project-swarm'), { recursive: true });
  await fs.writeFile(path.join(homeWithOldConfig, '.project-swarm', 'config.json'), JSON.stringify({ rig: { portFile: '/x' } }));
  assert.throws(() => loadLocalConfig({ home: homeWithOldConfig, env: {} }), /config-inside-install:/);

  const badFile = path.join(dir, 'bad.json');
  await fs.writeFile(badFile, '{not json');
  assert.throws(() => loadLocalConfig({ home: dir, env: { SWARM_CONFIG: badFile } }), new RegExp(`invalid swarm config: ${badFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

// --- row #185-part: an incomplete OpenRouter reply names its finish_reason --------------------

const choiceBody = (overrides = {}) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }], ...overrides });

test('#185-part: a truncated reply names finish_reason length', () => {
  const body = choiceBody({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"partial":' } }] });
  assert.equal(describeIncompleteChatResponse(body), 'OpenRouter response truncated: finish_reason length');
  assert.throws(() => assertCompleteChatResponse(body), (error) => error instanceof OpenRouterError && /truncated: finish_reason length/.test(error.message));
});

test('#185-part: a complete reply (finish_reason stop, plain content) names no problem', () => {
  assert.equal(describeIncompleteChatResponse(choiceBody()), null);
  assert.doesNotThrow(() => assertCompleteChatResponse(choiceBody()));
});

test('#185-part: a refusal, unrequested tool_calls, or missing content also name their finish_reason', () => {
  assert.match(describeIncompleteChatResponse(choiceBody({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', refusal: 'no' } }] })), /refused: finish_reason stop/);
  assert.match(describeIncompleteChatResponse(choiceBody({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{}] } }] })), /unexpected: finish_reason tool_calls/);
  assert.match(describeIncompleteChatResponse(choiceBody({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }] })), /unexpected: finish_reason stop carried no message content/);
  assert.match(describeIncompleteChatResponse({ choices: [] }), /expected exactly one choice, got 0/);
});

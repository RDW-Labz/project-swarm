// SPDX-License-Identifier: Apache-2.0
// Setup file imported before any test runs: isolate the test suite from the developer's real
// local config, preventing accidental dependencies on development machine state.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { defaultConfigPath } from '../tools/local-config.mjs';

// Inherited CLAUDECODE=1 from a Claude Code session would enable the runner manifest gate in temp fixtures.
delete process.env.CLAUDECODE;

const nativeHome = os.homedir.bind(os);
const systemHome = typeof os.userInfo === 'function' ? os.userInfo().homedir : nativeHome();
// os.userInfo().homedir comes from the account database, not an inherited HOME override. This
// remains the real home when a child fixture launches with its own temporary HOME.
const realHome = path.resolve(systemHome);

// Lesson #299: every isolation directory must use the sandbox's writable temp base.
const testTmpBase = process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir();
const currentConfig = process.env.SWARM_CONFIG || defaultConfigPath();
process.env.SWARM_REAL_CONFIG = currentConfig;

const isolateDir = fs.mkdtempSync(path.join(testTmpBase, 'swarm-test-isolate-'));
const isolatedConfigPath = path.join(isolateDir, 'config.json');
process.env.SWARM_CONFIG = isolatedConfigPath;

// Paid launches now resolve the machine daily limit from SWARM_CONFIG; keep suite jobs from
// hitting the real default ($5 stop) unless a test sets its own limit explicitly.
const unlimitedDailyLimit = {
  usd: 1_000_000,
  mode: 'notify',
  ceilingUsd: 10_000_000,
};
let isolatedConfig = {};
try {
  if (fs.existsSync(isolatedConfigPath)) {
    isolatedConfig = JSON.parse(fs.readFileSync(isolatedConfigPath, 'utf8'));
  }
} catch {
  isolatedConfig = {};
}
if (typeof isolatedConfig !== 'object' || isolatedConfig === null || Array.isArray(isolatedConfig)) {
  isolatedConfig = {};
}
const priorDaily = isolatedConfig.dailyLimit;
const mergedDaily = {
  ...(priorDaily && typeof priorDaily === 'object' && !Array.isArray(priorDaily) ? priorDaily : {}),
  ...unlimitedDailyLimit,
};
fs.writeFileSync(
  isolatedConfigPath,
  `${JSON.stringify({ ...isolatedConfig, dailyLimit: mergedDaily }, null, 2)}\n`,
  { mode: 0o600 },
);

// Lesson #152: a test that passes its own small `env` object (never `process.env`) to a function
// whose fallback is `env.HOME || os.homedir()` still lands on the real machine's home once that
// object has no HOME key of its own — os.homedir() itself reads process.env.HOME at call time, so
// overriding it here isolates every such fallback (and any real global git config HOME would
// resolve to) without that function needing to know it is under test.
process.env.SWARM_REAL_HOME = realHome;
export const isolatedHome = fs.mkdtempSync(path.join(testTmpBase, 'swarm-test-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.GIT_CONFIG_GLOBAL = path.join(isolatedHome, '.gitconfig');
process.env.NPM_CONFIG_USERCONFIG = path.join(isolatedHome, '.npmrc');
process.env.XDG_CACHE_HOME = path.join(isolatedHome, '.cache');
process.env.XDG_DATA_HOME = path.join(isolatedHome, '.local', 'share');
process.env.XDG_STATE_HOME = path.join(isolatedHome, '.local', 'state');
delete process.env.XDG_CONFIG_HOME;

export function assertIsolatedHome(candidate = nativeHome()) {
  const resolved = path.resolve(candidate);
  if (resolved === realHome || resolved.startsWith(`${realHome}${path.sep}`)) {
    throw new Error(`real home resolved during concurrent test isolation: ${resolved}`);
  }
  return resolved;
}

const testTmpDir = fs.mkdtempSync(path.join(testTmpBase, 'swarm-test-tmp-'));
process.env.SWARM_TEST_TMP = testTmpDir;

/** After hand-build or inbox fixtures: drop request state and owner decisions for a temp project root. */
export async function cleanupTestProject(root) {
  const fsPromises = await import('node:fs/promises');
  const handbuildDir = path.join(root, '.swarm', 'handbuild');
  await fsPromises.rm(handbuildDir, { recursive: true, force: true }).catch(() => {});
  const journal = path.join(root, '.swarm', 'project', 'journal.ndjson');
  try {
    const text = await fsPromises.readFile(journal, 'utf8');
    const kept = text.split('\n').filter(line => {
      if (!line.trim()) return false;
      try {
        const event = JSON.parse(line);
        if (event.kind === 'decision' && String(event.id ?? '').startsWith('handbuild-')) return false;
        return true;
      } catch {
        return true;
      }
    });
    if (kept.length) await fsPromises.writeFile(journal, `${kept.join('\n')}\n`, { mode: 0o600 });
    else await fsPromises.rm(journal, { force: true }).catch(() => {});
  } catch {
    /* no journal */
  }
}

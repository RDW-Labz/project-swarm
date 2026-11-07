// SPDX-License-Identifier: Apache-2.0
// Codex workers run with their own CODEX_HOME so they never load the operator's MCP servers, plugins,
// notify hooks, skills or personal AGENTS.md. The clean home keeps only model settings, [profiles.*] and
// [model_providers.*] from the real config.toml, and links auth.json back to the real login (a link, never a
// copy: token refreshes write through, so the operator's login is not changed or forked).
// Off switch: SWARM_CODEX_CLEAN_HOME=0. Location: SWARM_CODEX_HOME, else ~/.codex/swarm-worker-home (inside
// the ~/.codex subtree the codex sandbox profile already allows).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const KEEP_KEYS = new Set(['model', 'model_provider', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'service_tier', 'preferred_auth_method', 'forced_login_method']);
const KEEP_TABLE = /^\[\s*(profiles|model_providers)(\.|\s*\])/;

// Line-based on purpose: only single-line top-level keys from the allowlist and whole kept tables survive;
// anything else (mcp_servers, plugins, marketplaces, projects, notify arrays) is dropped.
export function cleanCodexConfig(text) {
  const out = [];
  let section = null; // null = top level, true = keeping this table, false = dropping it
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const header = /^\s*\[/.test(line) && !/^\s*\[\s*["\d]/.test(line);
    if (header) {
      section = KEEP_TABLE.test(line.trim());
      if (section) out.push(line);
      continue;
    }
    if (section === true) { out.push(line); continue; }
    if (section === false) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (m && KEEP_KEYS.has(m[1]) && !/^[[{]\s*$/.test(m[2].trim())) out.push(line.trim());
  }
  return `# Written by project-swarm for codex workers. Edit ~/.codex/config.toml instead.\n${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// Codex jobs start in parallel, so one setup runs per process and target; the others wait for it. Separate processes
// (two Macs' runs never share a home, but two swarm runs on one Mac can) are safe too: unique temp names, and an
// existing correct login link is accepted.
const inflight = new Map();
export function prepareCodexCleanHome({ env = process.env, home = os.homedir() } = {}) {
  if (env.SWARM_CODEX_CLEAN_HOME === '0') return Promise.resolve(null);
  const source = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  const target = path.resolve(env.SWARM_CODEX_HOME || path.join(home, '.codex', 'swarm-worker-home'));
  if (source === target) return Promise.resolve(target);
  const key = `${source}\0${target}`;
  if (!inflight.has(key)) {
    const job = setUp(source, target).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return inflight.get(key);
}

async function setUp(source, target) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  let config = '';
  try { config = await fs.readFile(path.join(source, 'config.toml'), 'utf8'); } catch { /* no config: model defaults */ }
  const cleaned = cleanCodexConfig(config);
  const configPath = path.join(target, 'config.toml');
  let current = null;
  try { current = await fs.readFile(configPath, 'utf8'); } catch { /* first run */ }
  if (current !== cleaned) {
    const tmp = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, cleaned, { mode: 0o600 });
      await fs.rename(tmp, configPath);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  const auth = path.join(target, 'auth.json');
  const realAuth = path.join(source, 'auth.json');
  let linked = null;
  try { linked = await fs.readlink(auth); } catch { /* missing, or a plain file */ }
  if (linked !== realAuth) {
    try { await fs.lstat(realAuth); } catch { return target; } // no file login (API key or keyring): nothing to link
    await fs.rm(auth, { force: true });
    try { await fs.symlink(realAuth, auth); } catch (error) {
      // Another swarm process made the link first: fine if it points at the real login.
      if (error?.code !== 'EEXIST' || await fs.readlink(auth).catch(() => null) !== realAuth) throw error;
    }
  }
  return target;
}

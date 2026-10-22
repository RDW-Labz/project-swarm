// SPDX-License-Identifier: Apache-2.0
// Non-Claude orchestrators on the board: opencode (read-only SQLite) and CLI sessions registered under .swarm/orchestrators/.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { insideProject } from './orchestrator-events.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';

const execFile = promisify(execFileCb);
const txt = (v, n) => (v === null || v === undefined ? null : sanitizeWorkerText(v, n));

export const OPENCODE_SESSION_SQL = `SELECT id, project_id, directory, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL`;

const OPENCODE_RECENT_MS = 24 * 60 * 60 * 1000;
const OPENCODE_WORKING_MS = 90 * 1000;
const HEARTBEAT_IDLE_MS = 10 * 60 * 1000;
const HEARTBEAT_DROP_MS = 24 * 60 * 60 * 1000;
const SQLITE_TIMEOUT_MS = 3000;
const TOOL_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const ORCH_DIR = '.swarm/orchestrators';

const opencodeCache = { key: '', rows: null, at: 0 };

export function opencodeDbPath(env = process.env, home = os.homedir()) {
  if (typeof env.SWARM_OPENCODE_DB === 'string' && env.SWARM_OPENCODE_DB) return env.SWARM_OPENCODE_DB;
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function dayStartUtc(now) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** @returns {Promise<object[]>} */
export async function queryOpencodeSessions({ execFileImpl = execFile, env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  const dbPath = opencodeDbPath(env, home);
  try {
    await fsp.access(dbPath, fs.constants.R_OK);
  } catch {
    return [];
  }
  try {
    const { stdout } = await execFileImpl('sqlite3', ['-readonly', '-json', dbPath, OPENCODE_SESSION_SQL], { timeout: SQLITE_TIMEOUT_MS });
    const parsed = JSON.parse(stdout || '[]');
    if (!Array.isArray(parsed)) return [];
    const cutoff = now - OPENCODE_RECENT_MS;
    return parsed.filter(row => row && typeof row === 'object' && num(row.time_updated) >= cutoff);
  } catch {
    return [];
  }
}

function cachedOpencodeRowsSync(options) {
  const dbPath = opencodeDbPath(options.env, options.home);
  const key = `${dbPath}|${Math.floor((options.now ?? Date.now()) / 5000)}`;
  if (opencodeCache.key === key && opencodeCache.rows) return opencodeCache.rows;
  const rows = queryOpencodeSessionsSync(options);
  opencodeCache.key = key;
  opencodeCache.rows = rows;
  opencodeCache.at = Date.now();
  return rows;
}

/** @returns {object[]} */
export function queryOpencodeSessionsSync({ execFileImpl = execFileSync, env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  const dbPath = opencodeDbPath(env, home);
  try {
    fs.accessSync(dbPath, fs.constants.R_OK);
  } catch {
    return [];
  }
  try {
    const stdout = execFileImpl('sqlite3', ['-readonly', '-json', dbPath, OPENCODE_SESSION_SQL], { timeout: SQLITE_TIMEOUT_MS, encoding: 'utf8' });
    const parsed = JSON.parse(stdout || '[]');
    if (!Array.isArray(parsed)) return [];
    const cutoff = now - OPENCODE_RECENT_MS;
    return parsed.filter(row => row && typeof row === 'object' && num(row.time_updated) >= cutoff);
  } catch {
    return [];
  }
}

function directoryInProject(root, directory) {
  if (typeof directory !== 'string' || !directory) return false;
  return insideProject(root, directory) !== null || insideProject(root, path.resolve(directory)) !== null;
}

function shortId(full) {
  return String(full ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
}

/** Board session cards from opencode rows for one project. */
export function opencodeSessionsForProject(project, rows, { now = Date.now() } = {}) {
  const out = [];
  const today0 = dayStartUtc(now);
  for (const row of rows ?? []) {
    if (!directoryInProject(project.root, row.directory)) continue;
    const updated = num(row.time_updated);
    const created = num(row.time_created);
    const tokensMain = num(row.tokens_input) + num(row.tokens_output) + num(row.tokens_reasoning);
    const cacheRead = num(row.tokens_cache_read);
    const updatedToday = updated >= today0;
    const startedBeforeToday = created < today0;
    out.push({
      id: shortId(row.id),
      chatUrl: null,
      project: txt(project.name, 80),
      projectId: project.id,
      tool: 'opencode',
      model: typeof row.model === 'string' && TOOL_MODEL_RE.test(row.model) ? row.model : txt(row.model, 80),
      state: now - updated <= OPENCODE_WORKING_MS ? 'working' : 'idle',
      lastAt: new Date(updated).toISOString(),
      since: new Date(updated).toISOString(),
      endedAt: null,
      doing: null,
      edits: 0,
      handBuilt: 0,
      blocked: 0,
      tokensToday: updatedToday ? tokensMain : 0,
      cacheReadToday: updatedToday ? cacheRead : 0,
      approximate: updatedToday && startedBeforeToday,
      listUsdToday: null,
      tokensAll: tokensMain,
      listUsdAll: null,
      unpriced: false,
      models: row.model ? [String(row.model).slice(0, 80)] : [],
      costUsdReported: num(row.cost),
      costSource: 'reported by opencode',
    });
  }
  return out;
}

function orchestratorsDir(root) {
  return path.join(root, ORCH_DIR);
}

function entryPath(root, tool, sessionId) {
  const safeTool = String(tool).replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 40);
  const safeId = String(sessionId).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120);
  return path.join(orchestratorsDir(root), `${safeTool}-${safeId}.json`);
}

export function validateOrchestratorFields({ tool, model, sessionId, pid, tokensToday, costUsd } = {}) {
  const errors = [];
  if (!TOOL_MODEL_RE.test(String(tool ?? '')) || /[\\/]/.test(String(tool ?? ''))) errors.push('tool');
  if (!TOOL_MODEL_RE.test(String(model ?? '')) || /[\\/]/.test(String(model ?? ''))) errors.push('model');
  if (sessionId !== undefined && !SESSION_ID_RE.test(String(sessionId ?? ''))) errors.push('session');
  if (pid !== undefined && pid !== null && !(Number.isInteger(pid) && pid > 0)) errors.push('pid');
  if (tokensToday !== undefined && tokensToday !== null && (!Number.isFinite(tokensToday) || tokensToday < 0)) errors.push('tokensToday');
  if (costUsd !== undefined && costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) errors.push('costUsd');
  return errors;
}

async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
  } catch { /* new file */ }
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const fd = await fsp.open(tmp, 'w', 0o600);
  try {
    await fd.writeFile(body);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fsp.rename(tmp, file);
  return true;
}

function registeredState(entry, now) {
  const hb = Date.parse(entry.lastHeartbeat);
  if (!Number.isFinite(hb)) return { drop: true, state: 'idle' };
  if (now - hb > HEARTBEAT_DROP_MS) return { drop: true, state: 'idle' };
  const explicit = entry.state === 'working' || entry.state === 'idle' ? entry.state : null;
  if (explicit) return { drop: false, state: explicit };
  return { drop: false, state: now - hb > HEARTBEAT_IDLE_MS ? 'idle' : 'working' };
}

/** Read registered orchestrator JSON files for a project (drops stale >24h). */
export function readRegisteredOrchestratorsSync(root, { now = Date.now(), readdir = fs.readdirSync, readFile = p => fs.readFileSync(p, 'utf8'), rm = p => fs.rmSync(p, { force: true }) } = {}) {
  const dir = orchestratorsDir(root);
  let names;
  try {
    names = readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(readFile(file));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const { drop, state } = registeredState(raw, now);
    if (drop) {
      try { rm(file); } catch { /* ignore */ }
      continue;
    }
    out.push({ ...raw, state, file });
  }
  return out;
}

export async function readRegisteredOrchestrators(root, { now = Date.now(), readdir = fsp.readdir, readFile = fsp.readFile } = {}) {
  const dir = orchestratorsDir(root);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const { drop, state } = registeredState(raw, now);
    if (drop) {
      await fsp.rm(file, { force: true }).catch(() => {});
      continue;
    }
    out.push({ ...raw, state, file });
  }
  return out;
}

export function registeredSessionsForProject(project, entries, { now = Date.now() } = {}) {
  return (entries ?? []).map(entry => {
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : entry.id;
    const hb = entry.lastHeartbeat;
    return {
      id: shortId(sessionId),
      chatUrl: null,
      project: txt(project.name, 80),
      projectId: project.id,
      tool: txt(entry.tool, 40),
      model: txt(entry.model, 80),
      state: entry.state,
      lastAt: hb,
      since: entry.startedAt ?? hb,
      endedAt: null,
      doing: null,
      edits: 0,
      handBuilt: 0,
      blocked: 0,
      tokensToday: num(entry.tokensToday),
      listUsdToday: null,
      tokensAll: num(entry.tokensToday),
      listUsdAll: null,
      unpriced: false,
      models: entry.model ? [String(entry.model).slice(0, 80)] : [],
      costUsdReported: entry.costUsd === undefined || entry.costUsd === null ? null : num(entry.costUsd),
      costSource: entry.costUsd === undefined || entry.costUsd === null ? null : 'reported by session',
    };
  });
}

export function externalCostFromSessions(sessions) {
  let todayTokens = 0;
  let allTokens = 0;
  let todayReportedUsd = 0;
  let allReportedUsd = 0;
  for (const s of sessions ?? []) {
    const t = typeof s.tokensToday === 'number' ? s.tokensToday : 0;
    const a = typeof s.tokensAll === 'number' ? s.tokensAll : t;
    todayTokens += t;
    allTokens += a;
    if (typeof s.cacheReadToday === 'number') {
      todayTokens += s.cacheReadToday;
      allTokens += s.cacheReadToday;
    }
    if (typeof s.costUsdReported === 'number') {
      allReportedUsd += s.costUsdReported;
      if (typeof s.tokensToday === 'number' && s.tokensToday > 0) todayReportedUsd += s.costUsdReported;
    }
  }
  return {
    todayTokens,
    allTokens,
    todayReportedUsd: Math.round(todayReportedUsd * 1e6) / 1e6,
    allReportedUsd: Math.round(allReportedUsd * 1e6) / 1e6,
  };
}

/** Sum orchestrator tokens from opencode and registered sessions across projects (for worker vs orchestrator share). */
export function externalOrchestratorTokens(projects, options = {}) {
  const now = options.now ?? Date.now();
  const rows = options.opencodeRows ?? cachedOpencodeRowsSync({ ...options, now });
  let todayTokens = 0;
  let allTokens = 0;
  for (const project of projects ?? []) {
    const opencode = opencodeSessionsForProject(project, rows, { now });
    const registered = registeredSessionsForProject(project, readRegisteredOrchestratorsSync(project.root, { now, ...options }), { now });
    const c = externalCostFromSessions([...opencode, ...registered]);
    todayTokens += c.todayTokens;
    allTokens += c.allTokens;
  }
  return { todayTokens, allTokens };
}

export function externalSessionsForProjectSync(project, options = {}) {
  const now = options.now ?? Date.now();
  const rows = options.opencodeRows ?? cachedOpencodeRowsSync({ ...options, now });
  const registered = readRegisteredOrchestratorsSync(project.root, { now, ...options });
  return [
    ...opencodeSessionsForProject(project, rows, { now }),
    ...registeredSessionsForProject(project, registered, { now }),
  ];
}

export async function externalSessionsForProject(project, options = {}) {
  return externalSessionsForProjectSync(project, options);
}

export const ORCHESTRATOR_USAGE = `Usage: swarm orchestrator register --tool NAME --model MODEL [--project ROOT] [--session ID]
       swarm orchestrator heartbeat --session ID [--tokens N] [--cost-usd X] [--state working|idle]
       swarm orchestrator list [--json]
`;

function parseFlag(args, name) {
  const eq = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) return { value: args[i + 1], rest: [...args.slice(0, i), ...args.slice(i + 2)] };
    if (args[i].startsWith(eq)) return { value: args[i].slice(eq.length), rest: [...args.slice(0, i), ...args.slice(i + 1)] };
  }
  return { value: undefined, rest: args };
}

async function findEntryBySession(root, sessionId, { readdir = fsp.readdir, readFile = fsp.readFile } = {}) {
  const dir = orchestratorsDir(root);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const sid = raw?.sessionId ?? raw?.id;
      if (sid === sessionId) return { file, raw };
    } catch { /* skip */ }
  }
  return null;
}

export async function runOrchestratorCommand(defaultRoot, args, { env = process.env, home = os.homedir(), now = Date.now } = {}) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    return { stdout: ORCHESTRATOR_USAGE, exitCode: sub ? 0 : 2 };
  }
  if (sub === 'register') {
    let rest = args.slice(1);
    const projectFlag = parseFlag(rest, '--project');
    rest = projectFlag.rest;
    const toolFlag = parseFlag(rest, '--tool');
    rest = toolFlag.rest;
    const modelFlag = parseFlag(rest, '--model');
    rest = modelFlag.rest;
    const sessionFlag = parseFlag(rest, '--session');
    rest = sessionFlag.rest;
    if (rest.some(a => a.startsWith('-'))) return { stdout: 'unknown flag\n', exitCode: 2 };
    const root = projectFlag.value ? path.resolve(projectFlag.value) : defaultRoot;
    const sessionId = sessionFlag.value ?? randomBytes(8).toString('hex');
    const tool = toolFlag.value;
    const model = modelFlag.value;
    const bad = validateOrchestratorFields({ tool, model, sessionId });
    if (!tool || !model || bad.length) {
      return { stdout: `invalid register fields${bad.length ? `: ${bad.join(', ')}` : ''}\n`, exitCode: 2 };
    }
    const at = new Date(now).toISOString();
    const entry = { tool, model, sessionId, startedAt: at, lastHeartbeat: at, tokensToday: 0, costUsd: 0 };
    const file = entryPath(root, tool, sessionId);
    await writeJsonAtomic(file, entry);
    return { stdout: `${sessionId}\n`, exitCode: 0 };
  }
  if (sub === 'heartbeat') {
    let rest = args.slice(1);
    const sessionFlag = parseFlag(rest, '--session');
    rest = sessionFlag.rest;
    const tokensFlag = parseFlag(rest, '--tokens');
    rest = tokensFlag.rest;
    const costFlag = parseFlag(rest, '--cost-usd');
    rest = costFlag.rest;
    const stateFlag = parseFlag(rest, '--state');
    rest = stateFlag.rest;
    if (rest.some(a => a.startsWith('-'))) return { stdout: 'unknown flag\n', exitCode: 2 };
    const sessionId = sessionFlag.value;
    if (!SESSION_ID_RE.test(String(sessionId ?? ''))) return { stdout: 'missing or invalid --session\n', exitCode: 2 };
    const tokens = tokensFlag.value === undefined ? undefined : Number(tokensFlag.value);
    const costUsd = costFlag.value === undefined ? undefined : Number(costFlag.value);
    const state = stateFlag.value;
    if (tokens !== undefined && (!Number.isFinite(tokens) || tokens < 0)) return { stdout: 'invalid --tokens\n', exitCode: 2 };
    if (costUsd !== undefined && (!Number.isFinite(costUsd) || costUsd < 0)) return { stdout: 'invalid --cost-usd\n', exitCode: 2 };
    if (state !== undefined && state !== 'working' && state !== 'idle') return { stdout: 'invalid --state\n', exitCode: 2 };
    const hit = await findEntryBySession(defaultRoot, sessionId);
    if (!hit) return { stdout: 'session not found\n', exitCode: 1 };
    const entry = { ...hit.raw, lastHeartbeat: new Date(now).toISOString() };
    if (tokens !== undefined) entry.tokensToday = tokens;
    if (costUsd !== undefined) entry.costUsd = costUsd;
    if (state !== undefined) entry.state = state;
    await writeJsonAtomic(hit.file, entry);
    return { stdout: 'ok\n', exitCode: 0 };
  }
  if (sub === 'list') {
    const json = args.includes('--json');
    const entries = await readRegisteredOrchestrators(defaultRoot, { now });
    if (json) return { stdout: `${JSON.stringify(entries, null, 2)}\n`, exitCode: 0 };
    if (!entries.length) return { stdout: 'no registered orchestrator sessions\n', exitCode: 0 };
    const lines = entries.map(e => `${e.sessionId ?? e.id}\t${e.tool}\t${e.model}\t${e.state}\ttokens=${num(e.tokensToday)}\tcost=${e.costUsd ?? ''}`);
    return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
  }
  return { stdout: `unknown orchestrator subcommand: ${sub}\n`, exitCode: 2 };
}

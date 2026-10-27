// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const WORKER_TOKEN_ENV = 'SWARM_WORKER_TOKEN';
export const SWARM_WORKER_RUN_ID_ENV = 'SWARM_WORKER_RUN_ID';

const activeJobTokens = new Map();
let dispatcherSignalsRegistered = false;

function activeKey(ctx) {
  return `${ctx.root}\0${ctx.runId}\0${ctx.jobId}`;
}

export function registerActiveWorkerToken(ctx, proof) {
  if (!ctx || typeof proof !== 'string' || !proof) return;
  activeJobTokens.set(activeKey(ctx), { ...ctx, proof });
  ensureDispatcherSignalHandlers();
}

export function unregisterActiveWorkerToken(ctx) {
  if (!ctx) return;
  activeJobTokens.delete(activeKey(ctx));
}

function ensureDispatcherSignalHandlers() {
  if (dispatcherSignalsRegistered) return;
  dispatcherSignalsRegistered = true;
  const onSignal = () => {
    revokeActiveWorkerTokens().catch(() => {});
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

export async function revokeActiveWorkerTokens() {
  const entries = [...activeJobTokens.values()];
  activeJobTokens.clear();
  for (const ctx of entries) {
    await revokeWorkerToken(ctx);
  }
}

export async function revokeAllWorkerTokensForRun({ root, runId } = {}) {
  if (!root || typeof root !== 'string') return;
  if (typeof runId !== 'string' || !SAFE_ID.test(runId)) return;
  const dir = workerTokensDir(root, runId);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    await fsp.unlink(path.join(dir, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Resolve project root, run id and job id from a worker cwd or run log directory. */
export function resolveWorkerDispatchContext({ cwd, logDirectory, jobId } = {}) {
  const resolvedJobId = typeof jobId === 'string' && SAFE_ID.test(jobId) ? jobId : null;
  if (typeof logDirectory === 'string' && logDirectory) {
    const absLog = path.resolve(logDirectory);
    const logJobId = path.basename(absLog);
    const runDir = path.dirname(absLog);
    const runsContainer = path.dirname(runDir);
    const swarmDot = path.dirname(runsContainer);
    if (path.basename(runsContainer) === 'runs' && path.basename(swarmDot) === '.swarm') {
      const runId = path.basename(runDir);
      const root = path.dirname(swarmDot);
      const finalJobId = resolvedJobId ?? logJobId;
      if (SAFE_ID.test(runId) && SAFE_ID.test(finalJobId)) {
        return { root, runId, jobId: finalJobId };
      }
    }
  }
  if (typeof cwd === 'string' && cwd) {
    const norm = path.resolve(cwd).replace(/\\/g, '/');
    const marker = '/.swarm/workspaces/';
    const idx = norm.indexOf(marker);
    if (idx >= 0) {
      const root = norm.slice(0, idx);
      const rest = norm.slice(idx + marker.length);
      const segments = rest.split('/').filter(Boolean);
      const runId = segments[0];
      let parsedJobId = null;
      if (segments[1] === '.attempts' && segments.length >= 3) parsedJobId = segments[2];
      else if (segments[1]) parsedJobId = segments[1];
      const finalJobId = resolvedJobId ?? parsedJobId;
      if (parsedJobId && SAFE_ID.test(runId) && SAFE_ID.test(finalJobId)) {
        return { root, runId, jobId: finalJobId };
      }
    }
  }
  return null;
}

/** Strip worker token values before persisting environment snapshots on a job record. */
export function maskWorkerEnvForRecord(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return env;
  if (!(WORKER_TOKEN_ENV in env)) return env;
  return { ...env, [WORKER_TOKEN_ENV]: '[value]' };
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const TOKEN_HEX = /^[0-9a-f]{64}$/;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RUN_SCAN = 200;

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must match ${SAFE_ID}`);
  }
}

function tokenRecordPath(root, runId, jobId) {
  return path.join(root, '.swarm', 'runs', runId, 'worker-tokens', `${jobId}.json`);
}

function workerTokensDir(root, runId) {
  return path.join(root, '.swarm', 'runs', runId, 'worker-tokens');
}

async function assertNotSymlink(filePath) {
  let st;
  try {
    st = await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing symlink on path: ${filePath}`);
  }
}

function assertNotSymlinkSync(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing symlink on path: ${filePath}`);
  }
}

async function ensureWorkerTokensDir(root, runId) {
  assertSafeId(runId, 'runId');
  const parts = ['.swarm', 'runs', runId, 'worker-tokens'];
  let cur = path.resolve(root);
  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      await fsp.mkdir(cur, part === 'worker-tokens' ? { mode: 0o700 } : undefined);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await assertNotSymlink(cur);
  }
  const st = await fsp.stat(cur);
  if (!st.isDirectory()) throw new Error('worker-tokens path is not a directory');
  await fsp.chmod(cur, 0o700);
  return cur;
}

async function writeRecordAtomic(recordPath, payload) {
  const dir = path.dirname(recordPath);
  await assertNotSymlink(recordPath);
  const tmp = path.join(
    dir,
    `.${path.basename(recordPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const body = `${JSON.stringify(payload)}\n`;
  const fh = await fsp.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(body, 'utf8');
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, recordPath);
  await fsp.chmod(recordPath, 0o600);
}

export async function issueWorkerToken({
  root,
  runId,
  jobId,
  workspace,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
} = {}) {
  if (!root || typeof root !== 'string') throw new TypeError('root is required');
  assertSafeId(runId, 'runId');
  assertSafeId(jobId, 'jobId');
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new TypeError('workspace must be a non-empty string');
  }
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError('ttlMs must be a positive number');
  const boundedTtl = Math.min(ttl, MAX_TTL_MS);
  const issuedAt = Number(now);
  if (!Number.isFinite(issuedAt)) throw new TypeError('now must be a finite timestamp');

  const workspaceReal = await fsp.realpath(workspace);
  await ensureWorkerTokensDir(root, runId);
  const recordPath = tokenRecordPath(root, runId, jobId);
  await assertNotSymlink(recordPath);

  const raw = crypto.randomBytes(32);
  const proof = raw.toString('hex');
  const hash = crypto.createHash('sha256').update(proof, 'utf8').digest('hex');

  const record = {
    hash,
    runId,
    jobId,
    workspace: workspaceReal,
    issuedAt,
    expiresAt: issuedAt + boundedTtl,
    revoked: false,
  };

  await writeRecordAtomic(recordPath, record);
  return proof;
}

export async function revokeWorkerToken({ root, runId, jobId } = {}) {
  if (!root || typeof root !== 'string') return;
  if (typeof runId !== 'string' || typeof jobId !== 'string') return;
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(jobId)) return;
  const recordPath = tokenRecordPath(root, runId, jobId);
  await fsp.unlink(recordPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function timingSafeHashEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function cwdInsideWorkspace(cwdReal, workspaceReal) {
  if (cwdReal === workspaceReal) return true;
  const prefix = `${workspaceReal}${path.sep}`;
  return cwdReal.startsWith(prefix);
}

function listRunIdsSync(root) {
  const runsDir = path.join(root, '.swarm', 'runs');
  let names;
  try {
    names = fs.readdirSync(runsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue;
    const full = path.join(runsDir, name);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      entries.push({ id: name, mtimeMs: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, MAX_RUN_SCAN).map((e) => e.id);
}

async function listRunIds(root) {
  return listRunIdsSync(root);
}

function readTokenRecordSync(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

async function readTokenRecord(filePath) {
  return readTokenRecordSync(filePath);
}

function verifyWorkerTokenCore({ root, token, cwd, now = Date.now() } = {}) {
  if (!root || typeof root !== 'string') {
    return { ok: false, reason: 'invalid-root' };
  }
  if (typeof token !== 'string' || !TOKEN_HEX.test(token)) {
    return { ok: false, reason: 'invalid-token' };
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { ok: false, reason: 'invalid-cwd' };
  }
  const at = Number(now);
  if (!Number.isFinite(at)) return { ok: false, reason: 'invalid-now' };

  let cwdReal;
  try {
    cwdReal = fs.realpathSync.native(cwd);
  } catch {
    return { ok: false, reason: 'invalid-cwd' };
  }

  const wantHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const runIds = listRunIdsSync(root);

  for (const runId of runIds) {
    const dir = workerTokensDir(root, runId);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const recordPath = path.join(dir, file);
      try {
        const st = fs.lstatSync(recordPath);
        if (st.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const record = readTokenRecordSync(recordPath);
      if (!record || typeof record !== 'object') continue;
      if (!timingSafeHashEqual(String(record.hash ?? ''), wantHash)) continue;
      if (record.revoked === true) return { ok: false, reason: 'revoked' };
      if (Number(record.expiresAt) <= at) return { ok: false, reason: 'expired' };
      const workspaceReal = String(record.workspace ?? '');
      if (!workspaceReal || !cwdInsideWorkspace(cwdReal, workspaceReal)) {
        return { ok: false, reason: 'cwd-outside-workspace' };
      }
      return {
        ok: true,
        runId: String(record.runId ?? runId),
        jobId: String(record.jobId ?? file.replace(/\.json$/, '')),
        workspace: workspaceReal,
      };
    }
  }

  return { ok: false, reason: 'not-found' };
}

export function verifyWorkerTokenSync(params) {
  return verifyWorkerTokenCore(params);
}

export async function verifyWorkerToken({ root, token, cwd, now = Date.now() } = {}) {
  return verifyWorkerTokenCore({ root, token, cwd, now });
}

export function redactWorkerToken(text, proof) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  if (typeof proof === 'string' && proof.length > 0) {
    out = out.split(proof).join('redacted');
  }
  out = out.replace(
    new RegExp(`(${WORKER_TOKEN_ENV}\\s*=\\s*)([0-9a-fA-F]{64})`, 'g'),
    '$1redacted',
  );
  out = out.replace(
    new RegExp(`(${WORKER_TOKEN_ENV}\\s+)([0-9a-fA-F]{64})`, 'g'),
    '$1redacted',
  );
  return out;
}

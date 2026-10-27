// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKER_TOKEN_ENV = 'SWARM_WORKER_TOKEN';

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
    st = await fs.lstat(filePath);
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
      await fs.mkdir(cur, part === 'worker-tokens' ? { mode: 0o700 } : undefined);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await assertNotSymlink(cur);
  }
  const st = await fs.stat(cur);
  if (!st.isDirectory()) throw new Error('worker-tokens path is not a directory');
  await fs.chmod(cur, 0o700);
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
  const fh = await fs.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(body, 'utf8');
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, recordPath);
  await fs.chmod(recordPath, 0o600);
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

  const workspaceReal = await fs.realpath(workspace);
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
  await fs.unlink(recordPath).catch((error) => {
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

async function listRunIds(root) {
  const runsDir = path.join(root, '.swarm', 'runs');
  let names;
  try {
    names = await fs.readdir(runsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue;
    const full = path.join(runsDir, name);
    try {
      const st = await fs.lstat(full);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      entries.push({ id: name, mtimeMs: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, MAX_RUN_SCAN).map((e) => e.id);
}

async function readTokenRecord(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

export async function verifyWorkerToken({ root, token, cwd, now = Date.now() } = {}) {
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
    cwdReal = await fs.realpath(cwd);
  } catch {
    return { ok: false, reason: 'invalid-cwd' };
  }

  const wantHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const runIds = await listRunIds(root);

  for (const runId of runIds) {
    const dir = workerTokensDir(root, runId);
    let files;
    try {
      files = await fs.readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const recordPath = path.join(dir, file);
      try {
        const st = await fs.lstat(recordPath);
        if (st.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const record = await readTokenRecord(recordPath);
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

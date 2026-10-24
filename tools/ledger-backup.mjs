// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { promises as defaultFs } from 'node:fs';
import { isSecretPath } from './state-backup.mjs';
import { projectSwarmHome } from './state-guard.mjs';

const META_VERSION = 1;
const BACKUP_KEY_RE = /^[A-Za-z0-9._-]+$/;
const INCOMPLETE_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_CHANGE_SNAPSHOTS = 50;
const DAILY_RETENTION_DAYS = 90;
const FIXED_NAMES = new Set(['tickets.json', 'tickets.log', 'brain-ledger.ndjson', 'backlog.json']);
const SECURITY_KEY_RE = /security[-_]?key/i;

export function swarmHome(env = process.env) {
  return projectSwarmHome(os.homedir(), env);
}

export function ledgerBackupsRoot(home = swarmHome()) {
  return path.join(home, 'ledger-backups');
}

export async function ledgerBackupKey(root, fs = defaultFs) {
  const real = await fs.realpath(root);
  const digest = createHash('sha256').update(real).digest('hex');
  return `${path.basename(real)}-${digest.slice(0, 12)}`;
}

function utcDayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function snapshotStamp(ms) {
  return new Date(ms).toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

function snapshotId(ledgerSha256, ms) {
  return `${snapshotStamp(ms)}-${ledgerSha256.slice(0, 8)}`;
}

function isLedgerFileName(name) {
  if (!name || name.includes('/') || name.includes('\\')) return false;
  if (SECURITY_KEY_RE.test(name)) return false;
  if (isSecretPath(`.swarm/project/${name}`)) return false;
  if (FIXED_NAMES.has(name)) return true;
  return name.endsWith('.md');
}

async function lstatRegularOrMissing(fs, abs) {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return { kind: 'symlink' };
    if (st.isDirectory()) return { kind: 'dir' };
    if (st.isFile()) return { kind: 'file', st };
    return { kind: 'other' };
  } catch (e) {
    if (e.code === 'ENOENT') return { kind: 'missing' };
    throw e;
  }
}

async function mkdirPrivate(fs, dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
}

async function writeAtomic(fs, dest, data) {
  await mkdirPrivate(fs, path.dirname(dest));
  const tmp = `${dest}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, dest);
}

async function copyFileAtomic(fs, src, dest) {
  const data = await fs.readFile(src);
  await writeAtomic(fs, dest, data);
  return data;
}

async function listLedgerSources(root, fs) {
  const projectDir = path.join(root, '.swarm', 'project');
  const inside = await lstatRegularOrMissing(fs, projectDir);
  if (inside.kind !== 'dir') return null;
  let names;
  try {
    names = await fs.readdir(projectDir);
  } catch {
    return null;
  }
  const out = [];
  for (const name of names.sort()) {
    if (!isLedgerFileName(name)) continue;
    const abs = path.join(projectDir, name);
    const st = await lstatRegularOrMissing(fs, abs);
    if (st.kind !== 'file') continue;
    out.push({ name, abs });
  }
  return out;
}

function ledgerCounts(ledger) {
  const tickets = ledger?.tickets ?? [];
  return {
    ticketCount: tickets.length,
    doneCount: tickets.filter((t) => t.status === 'done').length,
    version: ledger?.version ?? null,
    approvedHash: ledger?.approved?.ticketsHash ?? null,
  };
}

async function readMeta(fs, metaPath) {
  const raw = await fs.readFile(metaPath, 'utf8');
  const m = JSON.parse(raw);
  if (!m || m.version !== META_VERSION || typeof m.ledgerSha256 !== 'string') throw new Error('bad meta');
  return m;
}

async function listSnapshotIds(fs, keyDir) {
  let names;
  try {
    names = await fs.readdir(keyDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names.filter((n) => n !== 'daily' && !n.startsWith('.')).sort();
}

async function newestSnapshotMeta(fs, keyDir) {
  const ids = await listSnapshotIds(fs, keyDir);
  for (let i = ids.length - 1; i >= 0; i--) {
    try {
      const meta = await readMeta(fs, path.join(keyDir, ids[i], 'meta.json'));
      return { id: ids[i], meta };
    } catch { /* incomplete */ }
  }
  return null;
}

async function pruneIncompleteSnapshots(fs, keyDir, nowMs) {
  const ids = await listSnapshotIds(fs, keyDir);
  const cutoff = nowMs - INCOMPLETE_SNAPSHOT_MAX_AGE_MS;
  for (const id of ids) {
    const snapDir = path.join(keyDir, id);
    const metaPath = path.join(snapDir, 'meta.json');
    try {
      await readMeta(fs, metaPath);
    } catch {
      let mtime = 0;
      try {
        mtime = (await fs.stat(snapDir)).mtimeMs;
      } catch { /* */ }
      if (mtime && mtime < cutoff) {
        await fs.rm(snapDir, { recursive: true, force: true });
      }
    }
  }
}

async function copySnapshotDir(fs, fromDir, toDir) {
  await fs.rm(toDir, { recursive: true, force: true });
  await mkdirPrivate(fs, toDir);
  const names = await fs.readdir(fromDir);
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const src = path.join(fromDir, name);
    const st = await lstatRegularOrMissing(fs, src);
    if (st.kind !== 'file') continue;
    await copyFileAtomic(fs, src, path.join(toDir, name));
  }
}

async function pruneChangeSnapshots(fs, keyDir) {
  const ids = await listSnapshotIds(fs, keyDir);
  const complete = [];
  for (const id of ids) {
    try {
      await readMeta(fs, path.join(keyDir, id, 'meta.json'));
      complete.push(id);
    } catch { /* incomplete */ }
  }
  for (const id of complete.slice(0, Math.max(0, complete.length - MAX_CHANGE_SNAPSHOTS))) {
    await fs.rm(path.join(keyDir, id), { recursive: true, force: true });
  }
}

async function pruneDaily(fs, keyDir, nowMs) {
  const dailyRoot = path.join(keyDir, 'daily');
  let names;
  try {
    names = await fs.readdir(dailyRoot);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const cutoff = new Date(nowMs);
  cutoff.setUTCDate(cutoff.getUTCDate() - DAILY_RETENTION_DAYS);
  const cutoffKey = utcDayKey(cutoff.getTime());
  for (const day of names) {
    if (day < cutoffKey) await fs.rm(path.join(dailyRoot, day), { recursive: true, force: true });
  }
}

async function updateDailyCopy(fs, keyDir, snapshotDir, ms) {
  const day = utcDayKey(ms);
  const dest = path.join(keyDir, 'daily', day);
  await copySnapshotDir(fs, snapshotDir, dest);
}

export async function backupLedger(root, { reason = 'manual', home, now = Date.now, fs = defaultFs } = {}) {
  try {
    const homeDir = home ?? swarmHome();
    const sources = await listLedgerSources(root, fs);
    if (!sources?.some((s) => s.name === 'tickets.json')) {
      return { ok: false, reason: 'no ledger' };
    }
    const ticketsPath = path.join(root, '.swarm', 'project', 'tickets.json');
    const ledgerBytes = await fs.readFile(ticketsPath);
    const ledgerSha256 = createHash('sha256').update(ledgerBytes).digest('hex');
    let ledger;
    try {
      ledger = JSON.parse(ledgerBytes.toString('utf8'));
    } catch {
      return { ok: false, reason: 'ledger unreadable' };
    }
    const realRoot = await fs.realpath(root);
    const key = await ledgerBackupKey(root, fs);
    const keyDir = path.join(ledgerBackupsRoot(homeDir), key);
    await mkdirPrivate(fs, keyDir);

    const newest = await newestSnapshotMeta(fs, keyDir);
    if (newest?.meta?.ledgerSha256 === ledgerSha256) {
      return { ok: true, skipped: true, key, id: newest.id, ledgerSha256 };
    }

    const ms = typeof now === 'function' ? now() : now;
    const id = snapshotId(ledgerSha256, ms);
    const snapDir = path.join(keyDir, id);
    const stagingDir = `${snapDir}.staging-${randomBytes(4).toString('hex')}`;
    await mkdirPrivate(fs, stagingDir);

    const counts = ledgerCounts(ledger);
    const meta = {
      version: META_VERSION,
      root: realRoot,
      reason: String(reason),
      at: new Date(ms).toISOString(),
      ledgerSha256,
      ticketCount: counts.ticketCount,
      doneCount: counts.doneCount,
      approvedHash: counts.approvedHash,
      ledgerVersion: counts.version,
    };

    for (const { name, abs } of sources) {
      await copyFileAtomic(fs, abs, path.join(stagingDir, name));
    }
    await writeAtomic(fs, path.join(stagingDir, 'meta.json'), Buffer.from(JSON.stringify(meta, null, 2) + '\n'));
    await fs.rename(stagingDir, snapDir);

    await updateDailyCopy(fs, keyDir, snapDir, ms);
    await pruneChangeSnapshots(fs, keyDir);
    await pruneDaily(fs, keyDir, ms);
    await pruneIncompleteSnapshots(fs, keyDir, ms);

    return { ok: true, skipped: false, key, id, ledgerSha256 };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

export async function listLedgerBackups(root, { home, all = false, fs = defaultFs } = {}) {
  const homeDir = home ?? swarmHome();
  const base = ledgerBackupsRoot(homeDir);
  if (!all) {
    const key = await ledgerBackupKey(root, fs);
    const keyDir = path.join(base, key);
    const ids = await listSnapshotIds(fs, keyDir);
    const out = [];
    for (const id of ids) {
      try {
        const meta = await readMeta(fs, path.join(keyDir, id, 'meta.json'));
        out.push({ key, id, ...meta });
      } catch { /* skip */ }
    }
    return out;
  }
  let keys;
  try {
    keys = await fs.readdir(base);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const key of keys.sort()) {
    const keyDir = path.join(base, key);
    const st = await lstatRegularOrMissing(fs, keyDir);
    if (st.kind !== 'dir') continue;
    const ids = await listSnapshotIds(fs, keyDir);
    let rootPath = null;
    for (const id of [...ids].reverse()) {
      try {
        const meta = await readMeta(fs, path.join(keyDir, id, 'meta.json'));
        rootPath = meta.root;
        break;
      } catch { /* try older */ }
    }
    out.push({ key, root: rootPath, snapshots: ids.length });
  }
  return out;
}

async function resolveSnapshotId(fs, keyDir, idOrLatest) {
  const ids = await listSnapshotIds(fs, keyDir);
  const complete = [];
  for (const id of ids) {
    try {
      await readMeta(fs, path.join(keyDir, id, 'meta.json'));
      complete.push(id);
    } catch { /* skip incomplete */ }
  }
  if (!complete.length) return null;
  if (!idOrLatest || idOrLatest === 'latest') return complete[complete.length - 1];
  return complete.includes(idOrLatest) ? idOrLatest : null;
}

function validateBackupKey(key) {
  return typeof key === 'string' && BACKUP_KEY_RE.test(key) && !key.includes('..');
}

async function assertRestoreTargetSafe(targetRoot, fs) {
  const targetReal = await fs.realpath(targetRoot);
  const check = async (rel) => {
    const abs = path.join(targetRoot, rel);
    let st;
    try {
      st = await fs.lstat(abs);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new Error('restore target symlink refused');
    }
    const real = await fs.realpath(abs);
    const prefix = `${targetReal}${path.sep}`;
    if (real !== targetReal && !real.startsWith(prefix)) {
      throw new Error('restore target escapes base');
    }
  };
  await check('.swarm');
  await check(path.join('.swarm', 'project'));
  return targetReal;
}

export function ledgerFilesNonEmpty(root, fs = defaultFs) {
  return fs.stat(path.join(root, '.swarm', 'project', 'tickets.json')).then(() => true, () => false);
}

export async function restoreLedgerSnapshot(
  root,
  {
    id = 'latest',
    fromKey,
    into,
    yes = false,
    home,
    fs = defaultFs,
    now = Date.now,
  } = {},
) {
  const stages = [];
  const targetRoot = into ?? root;
  const homeDir = home ?? swarmHome();
  if (fromKey !== undefined && !validateBackupKey(fromKey)) {
    return { ok: false, reason: 'invalid --from key', stages };
  }
  const key = fromKey ?? await ledgerBackupKey(root, fs);
  const keyDir = path.join(ledgerBackupsRoot(homeDir), key);
  const snapId = await resolveSnapshotId(fs, keyDir, id);
  if (!snapId) return { ok: false, reason: 'snapshot not found', stages };

  const snapDir = path.join(keyDir, snapId);
  let meta;
  try {
    meta = await readMeta(fs, path.join(snapDir, 'meta.json'));
  } catch {
    return { ok: false, reason: 'snapshot meta missing', stages };
  }

  const snapTickets = path.join(snapDir, 'tickets.json');
  try {
    const snapBytes = await fs.readFile(snapTickets);
    const snapHash = createHash('sha256').update(snapBytes).digest('hex');
    if (snapHash !== meta.ledgerSha256) {
      return { ok: false, reason: 'snapshot ledger hash mismatch', stages };
    }
  } catch {
    return { ok: false, reason: 'snapshot tickets missing', stages };
  }

  if (into) {
    try {
      await assertRestoreTargetSafe(targetRoot, fs);
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e), stages };
    }
  }

  const hasLedger = await ledgerFilesNonEmpty(targetRoot, fs);
  if (hasLedger && !yes) {
    return { ok: false, reason: 'refusing to overwrite existing ledger without --yes', stages, planned: true, id: snapId, key };
  }

  if (yes && hasLedger) {
    const pre = await backupLedger(targetRoot, { reason: 'pre-restore', home: homeDir, now, fs });
    stages.push({ name: 'pre-backup', done: pre.ok ? 1 : 0, total: 1 });
    if (!pre.ok) return { ok: false, reason: pre.reason ?? 'pre-backup failed', stages };
  } else {
    stages.push({ name: 'pre-backup', done: 0, total: hasLedger ? 1 : 0 });
  }

  const projectDir = path.join(targetRoot, '.swarm', 'project');
  await mkdirPrivate(fs, projectDir);

  const names = (await fs.readdir(snapDir)).filter((n) => n !== 'meta.json' && !n.startsWith('.'));
  let copied = 0;
  for (const name of names) {
    const src = path.join(snapDir, name);
    const st = await lstatRegularOrMissing(fs, src);
    if (st.kind !== 'file') continue;
    if (!isLedgerFileName(name)) continue;
    await copyFileAtomic(fs, src, path.join(projectDir, name));
    copied += 1;
  }
  stages.push({ name: 'copy', done: copied, total: names.length });

  const ticketsPath = path.join(projectDir, 'tickets.json');
  let hashOk = false;
  try {
    const data = await fs.readFile(ticketsPath);
    hashOk = createHash('sha256').update(data).digest('hex') === meta.ledgerSha256;
  } catch { /* */ }
  stages.push({ name: 'verify', done: hashOk ? 1 : 0, total: 1 });
  if (!hashOk) return { ok: false, reason: 'ledger hash mismatch after restore', stages, id: snapId, key };

  return { ok: true, id: snapId, key, stages, root: meta.root };
}

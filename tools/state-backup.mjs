import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export const BACKUP_DIR = '.swarm/backups';
export const BACKUP_INCLUDE = Object.freeze(['.swarm/project', '.project-swarm.json', '.swarm/runner-pointer.json', '.swarm/ui/results.json', 'coordination/journal.ndjson']);

const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
const MAX_FILES = 5000;
const MAX_BYTES = 50 * 1024 * 1024;
// Matched on the lower-cased path: anything that names a secret, a key or a credential store.
const SECRET_RE = /(secret|token|credential|passw|api[-_]?key|private[-_]?key|gpu-session|id_(rsa|dsa|ecdsa|ed25519)|(^|[-_./])keys?([-_./]|$)|[.](pem|key|p12|pfx|npmrc|netrc|pgpass)$|(^|\/)[.](npmrc|netrc|pgpass))/;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function isSecretPath(rel) {
  const s = String(rel).toLowerCase();
  if (s.split('/').some((seg) => seg.startsWith('.env'))) return true;
  return SECRET_RE.test(s);
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('bad-id', `refused backup id: ${String(id)}`);
}

function safeRel(rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel)) return false;
  if (rel.indexOf(String.fromCharCode(92)) !== -1) return false;
  return rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function makeId(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

async function writeAtomic(dest, data) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, dest);
}

// A path whose real parent is outside the project (a symlinked .swarm, say) is never read or written.
async function insideRoot(root, abs) {
  try {
    const real = await fs.realpath(path.dirname(abs));
    const base = await fs.realpath(root);
    return real === base || real.startsWith(base + path.sep);
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

// .swarm and .swarm/backups must be real directories before anything is written or deleted there.
async function ensureBackupDir(root) {
  for (const rel of ['.swarm', BACKUP_DIR]) {
    let st;
    try {
      st = await fs.lstat(path.join(root, rel));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw fail('unsafe-path', `${rel} is not a plain directory`);
  }
}

async function walk(root, rel, out, state) {
  if (rel === BACKUP_DIR || rel.startsWith(BACKUP_DIR + '/')) return;
  if (isSecretPath(rel)) return;
  if (!(await insideRoot(root, path.join(root, rel)))) return;
  let st;
  try {
    st = await fs.lstat(path.join(root, rel));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    const names = (await fs.readdir(path.join(root, rel))).sort();
    for (const n of names) await walk(root, `${rel}/${n}`, out, state);
    return;
  }
  if (!st.isFile()) return;
  if (out.length >= MAX_FILES) throw fail('backup-too-large', `more than ${MAX_FILES} files`);
  state.bytes += st.size;
  if (state.bytes > MAX_BYTES) throw fail('backup-too-large', `more than ${MAX_BYTES} bytes`);
  out.push({ rel, abs: path.join(root, rel) });
}

async function collect(root) {
  const out = [];
  const state = { bytes: 0 };
  for (const inc of BACKUP_INCLUDE) await walk(root, inc, out, state);
  return out;
}

async function backupIds(root) {
  let names;
  try {
    names = await fs.readdir(path.join(root, BACKUP_DIR));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names.filter((n) => ID_RE.test(n)).sort().reverse();
}

// Only complete backups (with a manifest) count and are pruned; a protected id (the one being restored) is never deleted.
async function prune(root, keep, protect = []) {
  const complete = [];
  for (const id of await backupIds(root)) {
    try { await readManifest(root, id); complete.push(id); } catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) console.error('[tools/state-backup.mjs] readManifest prune:', id, error?.message ?? error); }
  }
  for (const id of complete.slice(Math.max(1, keep))) {
    if (protect.includes(id)) continue;
    await fs.rm(path.join(root, BACKUP_DIR, id), { recursive: true, force: true });
  }
}

async function readManifest(root, id) {
  const raw = await fs.readFile(path.join(root, BACKUP_DIR, id, 'manifest.json'), 'utf8');
  const m = JSON.parse(raw);
  if (!m || m.version !== 1 || m.id !== id || !Array.isArray(m.files)) throw new Error('bad manifest');
  return m;
}

export async function createBackup(root, { reason = 'manual', now = Date.now, keep = 20, protect = [] } = {}) {
  if (!Number.isInteger(keep) || keep < 1) keep = 20;
  await ensureBackupDir(root);
  const ms = now();
  const id = makeId(ms);
  const found = await collect(root);
  const dir = path.join(root, BACKUP_DIR, id);
  const filesDir = path.join(dir, 'files');
  await fs.mkdir(path.join(root, BACKUP_DIR), { recursive: true });
  await fs.mkdir(dir);
  await fs.mkdir(filesDir);
  const entries = [];
  let bytes = 0;
  for (const f of found) {
    const data = await fs.readFile(f.abs);
    await writeAtomic(path.join(filesDir, ...f.rel.split('/')), data);
    entries.push({ path: f.rel, sha256: sha256(data), bytes: data.length });
    bytes += data.length;
  }
  const manifest = { version: 1, id, at: new Date(ms).toISOString(), reason: String(reason), files: entries };
  await writeAtomic(path.join(dir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  await prune(root, keep, protect);
  return { id, files: entries.length, bytes, reason: String(reason) };
}

export async function listBackups(root) {
  const out = [];
  for (const id of await backupIds(root)) {
    try {
      const m = await readManifest(root, id);
      out.push({
        id,
        at: m.at,
        reason: m.reason,
        files: m.files.length,
        bytes: m.files.reduce((s, f) => s + (Number(f.bytes) || 0), 0),
      });
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) console.error('[tools/state-backup.mjs] listBackups readManifest:', id, error?.message ?? error);
    }
  }
  return out;
}

export async function verifyBackup(root, id) {
  assertId(id);
  const problems = [];
  let m;
  try {
    m = await readManifest(root, id);
  } catch {
    return { ok: false, problems: ['manifest missing or unreadable'] };
  }
  const filesDir = path.join(root, BACKUP_DIR, id, 'files');
  for (const f of m.files) {
    if (!f || !safeRel(f.path)) {
      problems.push(`unsafe path in manifest: ${String(f && f.path)}`);
      continue;
    }
    let data;
    try {
      data = await fs.readFile(path.join(filesDir, ...f.path.split('/')));
    } catch {
      problems.push(`missing: ${f.path}`);
      continue;
    }
    if (data.length !== f.bytes) problems.push(`size changed: ${f.path}`);
    else if (sha256(data) !== f.sha256) problems.push(`hash changed: ${f.path}`);
  }
  return { ok: problems.length === 0, problems };
}

async function checkTarget(root, rel) {
  const parts = rel.split('/');
  let cur = path.resolve(root);
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (st.isSymbolicLink()) throw fail('unsafe-path', `refusing to write through symlink: ${rel}`);
    if (i < parts.length - 1 && !st.isDirectory()) throw fail('unsafe-path', `parent is not a directory: ${rel}`);
    if (i === parts.length - 1 && st.isDirectory()) throw fail('unsafe-path', `target is a directory: ${rel}`);
  }
}

// Only state swarm itself keeps can be restored: a planted backup cannot write tools, hooks or package files.
function restorable(rel) {
  return BACKUP_INCLUDE.some((inc) => rel === inc || rel.startsWith(inc + '/')) && !isSecretPath(rel) && !(rel === BACKUP_DIR || rel.startsWith(BACKUP_DIR + '/'));
}

export async function restoreBackup(root, id, { yes = false, now = Date.now } = {}) {
  assertId(id);
  let m;
  try {
    m = await readManifest(root, id);
  } catch {
    throw fail('backup-corrupt', `backup ${id} has no readable manifest`);
  }
  const targets = m.files.map((f) => {
    if (!f || !safeRel(f.path) || !restorable(f.path)) throw fail('unsafe-path', `unsafe path in backup: ${String(f && f.path)}`);
    return f.path;
  });
  if (!yes) return { id, restored: targets, skipped: [], preRestore: null, planned: true };

  await ensureBackupDir(root);
  const v = await verifyBackup(root, id);
  if (!v.ok) throw fail('backup-corrupt', `backup ${id} failed verification: ${v.problems.join('; ')}`);
  for (const rel of targets) {
    await checkTarget(root, rel);
    if (!(await insideRoot(root, path.join(root, rel)))) throw fail('unsafe-path', `refusing to write outside the project: ${rel}`);
  }
  // Everything is read and hash-checked into memory first: nothing below can lose or change the backup being restored.
  const filesDir = path.join(root, BACKUP_DIR, id, 'files');
  const loaded = [];
  for (const entry of m.files) {
    const source = path.join(filesDir, ...entry.path.split('/'));
    const st = await fs.lstat(source);
    if (!st.isFile()) throw fail('backup-corrupt', `backup file is not a regular file: ${entry.path}`);
    const data = await fs.readFile(source);
    if (sha256(data) !== entry.sha256) throw fail('backup-corrupt', `backup file changed while restoring: ${entry.path}`);
    loaded.push({ rel: entry.path, data });
  }
  const preRestore = (await createBackup(root, { reason: 'pre-restore', now, protect: [id] })).id;
  const restored = [];
  for (const { rel, data } of loaded) {
    await writeAtomic(path.join(root, ...rel.split('/')), data);
    restored.push(rel);
  }
  return { id, restored, skipped: [], preRestore, planned: false };
}

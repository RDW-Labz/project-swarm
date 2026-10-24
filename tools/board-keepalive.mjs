// SPDX-License-Identifier: Apache-2.0
// Stable loopback port and token for `swarm watch --all --keep-up` (launchd / phone bookmark).
import net from 'node:net';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';

export const BOARD_IDENTITY_BASENAME = 'board-identity.json';
export const DEFAULT_KEEPUP_PORT = 51058;

export function boardIdentityPath(dir) {
  return path.join(dir, BOARD_IDENTITY_BASENAME);
}

function isValidToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{48}$/.test(token);
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseIdentityText(text) {
  try {
    const data = JSON.parse(String(text ?? '').trim());
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const port = Number(data.port);
    if (!isValidToken(data.token) || !isValidPort(port)) return null;
    return { token: data.token, port };
  } catch {
    return null;
  }
}

function resolvePort(requestedPort) {
  if (requestedPort == null || requestedPort === '') return DEFAULT_KEEPUP_PORT;
  const port = Number(requestedPort);
  if (!isValidPort(port)) throw Object.assign(new Error('invalid --port'), { code: 'invalid-port' });
  return port;
}

export async function defaultIsPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export function portBusyError(port, { saved = false, file = null } = {}) {
  const where = saved && file ? ` (saved in ${file})` : '';
  const hint = saved
    ? 'stop the other process or remove the identity file'
    : 'pick another with --port or stop what is using it';
  return Object.assign(
    new Error(`board keep-up: port ${port} is already in use${where}; ${hint}`),
    { code: 'board-port-busy' },
  );
}

async function ensureConfigDirSecure(dir, { fs, uid }) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = await fs.stat(dir);
  } catch {
    return;
  }
  if (st.uid !== uid) return;
  const mode = st.mode & 0o777;
  if (mode !== 0o700 && typeof fs.chmod === 'function') {
    await fs.chmod(dir, 0o700);
  }
}

async function readIdentityViaFd(file, { fs, uid, warn }) {
  if (typeof fs.open !== 'function') {
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      return { kind: 'untrusted' };
    }
    if (st.uid !== uid) {
      warn('board identity: file not owned by you; creating a new identity');
      return { kind: 'untrusted' };
    }
    if ((st.mode & 0o777) !== 0o600) {
      warn('board identity: unsafe file mode; creating a new identity');
      return { kind: 'untrusted' };
    }
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return { kind: 'unreadable', text: '' };
    }
    return { kind: 'trusted-legacy', text };
  }
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    warn('board identity: unreadable; creating a new identity');
    return { kind: 'untrusted' };
  }
  try {
    const st = await handle.fstat();
    if (typeof st.isFile === 'function' ? !st.isFile() : !st.isFile) {
      warn('board identity: not a regular file; creating a new identity');
      return { kind: 'untrusted' };
    }
    if (st.uid !== uid) {
      warn('board identity: file not owned by you; creating a new identity');
      return { kind: 'untrusted' };
    }
    if ((st.mode & 0o777) !== 0o600) {
      warn('board identity: unsafe file mode; creating a new identity');
      return { kind: 'untrusted' };
    }
    const text = await handle.readFile({ encoding: 'utf8' });
    return { kind: 'trusted', text };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function trustIdentityFile(file, { fs, uid, warn }) {
  let lst;
  try {
    lst = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    warn('board identity: unreadable; creating a new identity');
    return { kind: 'untrusted' };
  }
  if (lst.isSymbolicLink?.()) {
    warn('board identity: refused symlink; creating a new identity');
    return { kind: 'untrusted' };
  }
  const viaFd = await readIdentityViaFd(file, { fs, uid, warn });
  if (viaFd.kind === 'missing') return { kind: 'missing' };
  if (viaFd.kind === 'untrusted' || viaFd.kind === 'unreadable') return { kind: 'untrusted' };
  return { kind: 'trusted', text: viaFd.text };
}

function portMismatchError(savedPort, requestedPort) {
  return Object.assign(
    new Error(`board keep-up: saved identity uses port ${savedPort}; --port ${requestedPort} would break the bookmark (omit --port to reuse ${savedPort})`),
    { code: 'board-port-mismatch' },
  );
}

async function writeIdentityAtomic(file, identity, { fs, dir, randomBytes, uid }) {
  await ensureConfigDirSecure(dir, { fs, uid });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, file);
  const st = await fs.stat(file);
  if ((st.mode & 0o777) !== 0o600) {
    throw new Error('board identity: could not set safe permissions on identity file');
  }
}

export async function loadOrCreateBoardIdentity({
  dir,
  fs,
  randomBytes,
  port: requestedPort = null,
  warn = msg => process.stderr.write(`${msg}\n`),
  uid = typeof process.getuid === 'function' ? process.getuid() : 0,
  isPortFree = defaultIsPortFree,
} = {}) {
  if (!dir || !fs || !randomBytes) throw new Error('loadOrCreateBoardIdentity: dir, fs, and randomBytes are required');
  const file = boardIdentityPath(dir);
  const trust = await trustIdentityFile(file, { fs, uid, warn });

  if (trust.kind === 'trusted') {
    const saved = parseIdentityText(trust.text);
    if (saved) {
      if (requestedPort != null && requestedPort !== '') {
        const req = resolvePort(requestedPort);
        if (req !== saved.port) throw portMismatchError(saved.port, req);
      }
      if (!(await isPortFree(saved.port))) throw portBusyError(saved.port, { saved: true, file });
      return saved;
    }
    warn('board identity: corrupt or invalid; creating a new identity');
  }

  if (trust.kind === 'untrusted') {
    try { await fs.rm(file, { force: true }); } catch { /* best effort */ }
  }

  const port = resolvePort(requestedPort);
  if (!(await isPortFree(port))) throw portBusyError(port);
  const token = randomBytes(24).toString('hex');
  const identity = { token, port };
  await writeIdentityAtomic(file, identity, { fs, dir, randomBytes, uid });
  return identity;
}

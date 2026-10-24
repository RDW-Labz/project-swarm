// SPDX-License-Identifier: Apache-2.0
// Stable loopback port and token for `swarm watch --all --keep-up` (launchd / phone bookmark).
import net from 'node:net';
import path from 'node:path';

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

function portBusyError(port, { saved = false, file = null } = {}) {
  const where = saved && file ? ` (saved in ${file})` : '';
  const hint = saved
    ? 'stop the other process or remove the identity file'
    : 'pick another with --port or stop what is using it';
  return Object.assign(
    new Error(`board keep-up: port ${port} is already in use${where}; ${hint}`),
    { code: 'board-port-busy' },
  );
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
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    warn('board identity: unreadable; creating a new identity');
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
  return { kind: 'trusted' };
}

async function writeIdentityAtomic(file, identity, { fs, dir, randomBytes }) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
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
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      warn('board identity: unreadable; creating a new identity');
    }
    const saved = parseIdentityText(text);
    if (saved) {
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
  await writeIdentityAtomic(file, identity, { fs, dir, randomBytes });
  return identity;
}

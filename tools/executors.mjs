// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SSH_TARGET = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;
const SECRET_DIRS = new Set(['.git', '.swarm', '.ssh', '.aws', '.gnupg']);
const REMOTE_ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SWARM_PORT_BASE']);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'hosts-invalid' });
}
function hostDead(host) {
  return Object.assign(new Error(`host-dead: ${host.id}`), { code: 'host-dead', host: host.id });
}

export function isSecretPath(file) {
  return String(file).split(/[\\/]+/).some(part => {
    const name = part.toLowerCase();
    return SECRET_DIRS.has(name) || name === '.env' || name.startsWith('.env.');
  });
}

// A remote process keeps its own credentials. Only a few non-secret variables travel with the workspace.
export function remoteEnv(env = {}) {
  const shipped = {};
  for (const key of REMOTE_ENV) if (env[key] !== undefined) shipped[key] = env[key];
  return shipped;
}

export function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function checkPulled(files) {
  if (!Array.isArray(files)) throw Object.assign(new Error('host-pull-mismatch: files must be a list'), { code: 'host-pull-mismatch' });
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || isSecretPath(file.path)) {
      throw Object.assign(new Error(`host-pull-mismatch: ${file?.path ?? 'file'}`), { code: 'host-pull-mismatch' });
    }
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? '');
    if (typeof file.sha256 !== 'string' || hashBytes(bytes) !== file.sha256) {
      throw Object.assign(new Error(`host-pull-mismatch: ${file.path}`), { code: 'host-pull-mismatch' });
    }
  }
}

export function resolveHosts(source) {
  if (source === undefined) return null;
  if (!Array.isArray(source) || !source.length || source.length > 32) throw invalid('hosts must be 1–32 entries');
  const ids = new Set();
  return source.map(host => {
    if (!host || typeof host !== 'object' || Array.isArray(host)) throw invalid('host must be an object');
    for (const key of Object.keys(host)) {
      if (!['id', 'kind', 'capacity', 'target', 'driver', 'heartbeatMs'].includes(key)) throw invalid(`unknown host field ${key}`);
    }
    if (typeof host.id !== 'string' || !HOST_ID.test(host.id) || ids.has(host.id)) throw invalid(`invalid host id ${host.id}`);
    ids.add(host.id);
    if (!['local', 'ssh', 'sandbox'].includes(host.kind)) throw invalid(`${host.id}.kind must be local, ssh, or sandbox`);
    if (!Number.isInteger(host.capacity) || host.capacity < 1 || host.capacity > 512) throw invalid(`${host.id}.capacity must be 1–512`);
    if (host.heartbeatMs !== undefined && (!Number.isInteger(host.heartbeatMs) || host.heartbeatMs < 20 || host.heartbeatMs > 60000)) {
      throw invalid(`${host.id}.heartbeatMs must be 20–60000`);
    }
    if (host.kind === 'ssh') {
      if (typeof host.target !== 'string' || !SSH_TARGET.test(host.target)) throw invalid(`${host.id}.target must be a host or user@host`);
      if (host.driver !== undefined) throw invalid(`${host.id} cannot set driver`);
    } else if (host.target !== undefined) throw invalid(`${host.id} cannot set target`);
    if (host.kind === 'sandbox') {
      if (!Array.isArray(host.driver) || !host.driver.length || host.driver.some(part => typeof part !== 'string' || !part)) throw invalid(`${host.id}.driver must be a command argv`);
    } else if (host.driver !== undefined) throw invalid(`${host.id} cannot set driver`);
    return { id: host.id, kind: host.kind, capacity: host.capacity, ...(host.target ? { target: host.target } : {}), ...(host.driver ? { driver: [...host.driver] } : {}), heartbeatMs: host.heartbeatMs ?? 5000 };
  });
}

export function sshArgv(host, remoteCommand) {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host.target, remoteCommand];
}

export function sandboxArgv(host, remoteCommand) {
  return [...host.driver, remoteCommand];
}

function abortError() {
  return Object.assign(new Error('Host pool closed or claim aborted'), { name: 'AbortError' });
}

// One machine's hosts. A dead ssh or sandbox host drops its in-flight jobs so the runner can place them again.
export function createHostPool({ hosts, ping = async () => true, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const entries = hosts.map(host => ({ host, inFlight: 0, dead: false, controllers: new Set() }));
  const byId = new Map(entries.map(entry => [entry.host.id, entry]));
  const queue = [];
  let closed = false;
  let timer = null;
  const heartbeatMs = Math.min(...hosts.map(host => host.heartbeatMs));

  const pump = () => {
    while (queue.length) {
      const chosen = entries.find(entry => !entry.dead && entry.inFlight < entry.host.capacity);
      if (!chosen) return;
      const waiter = queue.shift();
      if (waiter.signal?.aborted) { waiter.reject(abortError()); continue; }
      chosen.inFlight += 1;
      const controller = new AbortController();
      chosen.controllers.add(controller);
      const onAbort = () => controller.abort(abortError());
      waiter.signal?.addEventListener('abort', onAbort, { once: true });
      let released = false;
      waiter.resolve({
        host: chosen.host,
        signal: controller.signal,
        release() {
          if (released) return;
          released = true;
          chosen.controllers.delete(controller);
          waiter.signal?.removeEventListener('abort', onAbort);
          chosen.inFlight = Math.max(0, chosen.inFlight - 1);
          pump();
        },
      });
    }
  };

  const beat = async () => {
    timer = null;
    if (closed) return;
    for (const entry of entries) {
      if (entry.dead || entry.host.kind === 'local') continue;
      let alive = false;
      try { alive = await ping(entry.host); } catch { alive = false; }
      if (closed || entry.dead) continue;
      if (alive) continue;
      entry.dead = true;
      for (const controller of entry.controllers) controller.abort(hostDead(entry.host));
      entry.controllers.clear();
    }
    if (!closed) timer = setTimer(() => { beat().catch(() => {}); }, heartbeatMs);
  };

  const claim = ({ signal } = {}) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) { reject(abortError()); return; }
    const waiter = { resolve, reject, signal };
    queue.push(waiter);
    pump();
  });

  timer = setTimer(() => { beat().catch(() => {}); }, heartbeatMs);
  return {
    claim,
    snapshot: () => entries.map(entry => ({ id: entry.host.id, kind: entry.host.kind, inFlight: entry.inFlight, dead: entry.dead, capacity: entry.host.capacity })),
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const waiter of queue.splice(0)) waiter.reject(abortError());
      for (const entry of entries) for (const controller of entry.controllers) controller.abort(abortError());
    },
  };
}

function spawnCollected(spawnImpl, argv, { input, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(argv[0], argv.slice(1), { shell: false, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env });
    if (!child || typeof child.on !== 'function') { reject(Object.assign(new Error('host-exit: spawn failed'), { code: 'host-exit' })); return; }
    const out = [];
    child.stdout?.on?.('data', chunk => out.push(Buffer.from(chunk)));
    const fail = error => reject(error?.code === 'host-dead' ? error : Object.assign(new Error(`host-exit: ${error?.message ?? 'spawn failed'}`), { code: 'host-exit' }));
    child.on('error', fail);
    if (signal) {
      const stop = () => {
        child.kill?.('SIGTERM');
        if (signal.reason?.code === 'host-dead') fail(signal.reason);
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    if (input) child.stdin?.end?.(input);
    child.on('exit', code => {
      if (signal?.reason?.code === 'host-dead') return;
      if (code === 0) resolve(Buffer.concat(out));
      else reject(Object.assign(new Error(`host-exit: ${code}`), { code: 'host-exit' }));
    });
  });
}

export function defaultHostTransport({ spawnImpl }) {
  const argvFor = (host, command) => host.kind === 'sandbox' ? sandboxArgv(host, command) : sshArgv(host, command);
  return {
    async ping(host) {
      await spawnCollected(spawnImpl, argvFor(host, 'true'), {});
      return true;
    },
    async run({ host, files = [], outputs = [], env, signal }) {
      const safe = files.filter(file => file && !isSecretPath(file.path));
      const payload = Buffer.from(JSON.stringify({ files: safe.map(file => ({ path: file.path, bytes: Buffer.from(file.bytes).toString('base64') })), outputs }));
      const stdout = await spawnCollected(spawnImpl, argvFor(host, 'swarm-remote-exec'), { input: payload, env: remoteEnv(env), signal });
      const pulled = JSON.parse(stdout.toString('utf8'));
      checkPulled(pulled.files ?? []);
      return { files: (pulled.files ?? []).map(file => ({ ...file, bytes: Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes) })) };
    },
  };
}

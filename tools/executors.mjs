// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SSH_TARGET = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;
const REMOTE_JOB_ID = /^[a-f0-9]{8,32}$/;
const SECRET_DIRS = new Set(['.git', '.swarm', '.ssh', '.aws', '.gnupg']);
const REMOTE_ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SWARM_PORT_BASE']);
const DEAD_AFTER_MISSES = 3;
export const REMOTE_COMMAND = 'swarm-remote-exec';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'hosts-invalid' });
}
function hostUnreachable(message) {
  return Object.assign(new Error(`host-unreachable: ${message}`), { code: 'host-unreachable' });
}
function hostsExhausted(sensitive) {
  return Object.assign(new Error(`hosts-exhausted: no usable host is left for this ${sensitive ? 'sensitive ' : ''}job (every host that could run it failed its check or went down)`), { code: 'hosts-exhausted' });
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
      if (!['id', 'kind', 'capacity', 'target', 'driver', 'heartbeatMs', 'trusted', 'enabled'].includes(key)) throw invalid(`unknown host field ${key}`);
    }
    if (host.enabled !== undefined && typeof host.enabled !== 'boolean') throw invalid(`${host.id}.enabled must be true or false`);
    if (host.trusted !== undefined && typeof host.trusted !== 'boolean') throw invalid(`${host.id}.trusted must be true or false`);
    if (host.kind !== 'sandbox' && host.trusted !== undefined) throw invalid(`${host.id} trusted is only for a sandbox host`);
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
    return { id: host.id, kind: host.kind, capacity: host.capacity, ...(host.target ? { target: host.target } : {}), ...(host.driver ? { driver: [...host.driver] } : {}), ...(host.kind === 'sandbox' ? { trusted: host.trusted === true } : {}), ...(host.enabled === false ? { enabled: false } : {}), heartbeatMs: host.heartbeatMs ?? 5000 };
  });
}

// A host entry marked `enabled: false` stays in the config but is never used. No usable host at all
// means the run stays on this machine, exactly as if no hosts were configured.
export function enabledHosts(hosts) {
  if (!hosts) return null;
  const live = hosts.filter(host => host.enabled !== false);
  return live.length ? live : null;
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

function untrustedError() {
  return Object.assign(new Error('host-untrusted: a sensitive job needs a local host, an ssh host, or a sandbox with trusted: true'), { code: 'host-untrusted' });
}

// A sensitive job stays on this machine or on ssh. A sandbox takes one only when it is marked trusted.
function accepts(host, sensitive) {
  if (!sensitive) return true;
  if (host.kind === 'local' || host.kind === 'ssh') return true;
  return host.trusted === true;
}

// One machine's hosts. Three missed heartbeats in a row mark a remote host dead and free its jobs.
export function createHostPool({ hosts, ping = async () => true, kill = null, onOrphanSpend = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const entries = hosts.map(host => ({ host, inFlight: 0, dead: false, excluded: false, misses: 0, reviving: false, orphans: [], orphanSpend: 0, controllers: new Set() }));
  const queue = [];
  let closed = false;
  let timer = null;
  const heartbeatMs = Math.min(...hosts.map(host => host.heartbeatMs));

  const pump = () => {
    if (closed) return;
    let progressed = true;
    while (progressed && queue.length) {
      progressed = false;
      for (let index = 0; index < queue.length; index += 1) {
        const waiter = queue[index];
        if (waiter.signal?.aborted) {
          queue.splice(index, 1);
          waiter.reject(abortError());
          progressed = true;
          break;
        }
        const chosen = entries.find(entry => !entry.excluded && !entry.dead && !entry.reviving && entry.inFlight < entry.host.capacity && accepts(entry.host, waiter.sensitive));
        if (!chosen) continue;
        queue.splice(index, 1);
        chosen.inFlight += 1;
        const controller = new AbortController();
        const slot = { controller, remoteId: null };
        chosen.controllers.add(slot);
        const onAbort = () => controller.abort(abortError());
        waiter.signal?.addEventListener('abort', onAbort, { once: true });
        let released = false;
        waiter.resolve({
          host: chosen.host,
          signal: controller.signal,
          bind(remoteId) { slot.remoteId = remoteId; },
          release() {
            if (released) return;
            released = true;
            chosen.controllers.delete(slot);
            waiter.signal?.removeEventListener('abort', onAbort);
            chosen.inFlight = Math.max(0, chosen.inFlight - 1);
            pump();
          },
        });
        progressed = true;
        break;
      }
    }
  };

  const revive = async entry => {
    if (entry.reviving || closed) return;
    entry.reviving = true;
    const ids = [...entry.orphans];
    try {
      let report = {};
      if (ids.length && kill) report = await kill(entry.host, ids) ?? {};
      if (closed) return;
      entry.orphans = entry.orphans.filter(id => !ids.includes(id));
      entry.dead = false;
      entry.misses = 0;
      entry.reviving = false;
      const spent = report?.costUsd;
      if (typeof spent === 'number' && Number.isFinite(spent)) {
        entry.orphanSpend += spent;
        try { await onOrphanSpend?.(spent); } catch { /* the spend is already on the pool */ }
      }
      pump();
    } catch {
      entry.reviving = false;
    }
  };

  const beat = async () => {
    timer = null;
    if (closed) return;
    for (const entry of entries) {
      if (closed || entry.host.kind === 'local' || entry.reviving || entry.excluded) continue;
      let alive = false;
      try { alive = await ping(entry.host); } catch { alive = false; }
      if (closed || entry.reviving) continue;
      if (alive) {
        entry.misses = 0;
        if (entry.dead) await revive(entry);
        continue;
      }
      if (entry.dead) continue;
      entry.misses += 1;
      if (entry.misses < DEAD_AFTER_MISSES) continue;
      entry.dead = true;
      entry.misses = 0;
      for (const slot of entry.controllers) {
        if (slot.remoteId) entry.orphans.push(slot.remoteId);
        slot.controller.abort(hostDead(entry.host));
      }
      entry.controllers.clear();
    }
    if (!closed) timer = setTimer(() => { beat().catch(() => {}); }, heartbeatMs);
  };

  const claim = ({ signal, sensitive = true } = {}) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) { reject(abortError()); return; }
    if (!entries.some(entry => accepts(entry.host, sensitive))) { reject(untrustedError()); return; }
    if (!usable(sensitive)) { reject(hostsExhausted(sensitive)); return; }
    const waiter = { resolve, reject, signal, sensitive };
    queue.push(waiter);
    pump();
  });

  // A host can still serve a job unless a failed check or connection excluded it for this run.
  const usable = sensitive => entries.some(entry => !entry.excluded && accepts(entry.host, sensitive));
  const failWaiters = () => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (usable(queue[index].sensitive)) continue;
      const [waiter] = queue.splice(index, 1);
      waiter.reject(hostsExhausted(waiter.sensitive));
    }
  };
  // Takes a host out of this run for good: its running jobs get the host-dead signal and are placed
  // again, queued jobs wait for another host, and it is never revived by a later heartbeat.
  const exclude = (entry, reason) => {
    if (entry.excluded) return false;
    entry.excluded = true;
    entry.reason = reason;
    for (const slot of entry.controllers) {
      if (slot.remoteId) entry.orphans.push(slot.remoteId);
      slot.controller.abort(hostDead(entry.host));
    }
    entry.controllers.clear();
    failWaiters();
    pump();
    return true;
  };

  // Checks every remote host once, in parallel, before the first job is placed. A host that fails is
  // excluded for the whole run. Returns [{ id, reason }].
  const preflight = async () => {
    const checked = await Promise.all(entries.filter(entry => entry.host.kind !== 'local').map(async entry => {
      try { if (await ping(entry.host)) return null; } catch (error) { return { entry, reason: error?.message ?? 'ping failed' }; }
      return { entry, reason: 'ping failed' };
    }));
    const failed = checked.filter(Boolean);
    for (const { entry, reason } of failed) exclude(entry, reason);
    return failed.map(({ entry, reason }) => ({ id: entry.host.id, reason }));
  };

  timer = setTimer(() => { beat().catch(() => {}); }, heartbeatMs);
  return {
    claim,
    preflight,
    markDown(id, reason = 'connection failed') { const entry = entries.find(item => item.host.id === id && item.host.kind !== 'local'); return entry ? exclude(entry, reason) : false; },
    snapshot: () => entries.map(entry => ({ id: entry.host.id, kind: entry.host.kind, inFlight: entry.inFlight, dead: entry.dead, excluded: entry.excluded, capacity: entry.host.capacity })),
    orphanSpend: () => entries.reduce((sum, entry) => sum + entry.orphanSpend, 0),
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const waiter of queue.splice(0)) waiter.reject(abortError());
      for (const entry of entries) for (const slot of entry.controllers) slot.controller.abort(abortError());
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
    const unreachable = message => reject(hostUnreachable(message));
    // A missing ssh client or a refused spawn means this host cannot be reached at all.
    child.on('error', error => (error?.code === 'host-dead' ? fail(error) : unreachable(error?.message ?? 'spawn failed')));
    if (signal) {
      const stop = () => {
        child.kill?.('SIGTERM');
        if (signal.reason?.code === 'host-dead') fail(signal.reason);
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    if (input != null) child.stdin?.write?.(input);
    child.on('exit', code => {
      if (signal?.reason?.code === 'host-dead') return;
      if (code === 0) resolve(Buffer.concat(out));
      else if (code === 255) unreachable('ssh exit 255 (connection failed)');
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
    async run({ host, jobId, files = [], outputs = [], env, signal }) {
      if (typeof jobId !== 'string' || !REMOTE_JOB_ID.test(jobId)) throw Object.assign(new Error('host-exit: remote job id'), { code: 'host-exit' });
      const safe = files.filter(file => file && !isSecretPath(file.path));
      const payload = Buffer.from(`${JSON.stringify({ id: jobId, files: safe.map(file => ({ path: file.path, bytes: Buffer.from(file.bytes).toString('base64') })), outputs })}\n`);
      const stdout = await spawnCollected(spawnImpl, argvFor(host, REMOTE_COMMAND), { input: payload, env: remoteEnv(env), signal });
      const pulled = JSON.parse(stdout.toString('utf8'));
      checkPulled(pulled.files ?? []);
      return { files: (pulled.files ?? []).map(file => ({ ...file, bytes: Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes) })) };
    },
    async kill(host, ids) {
      const safe = [...ids];
      if (!safe.length || safe.some(id => typeof id !== 'string' || !REMOTE_JOB_ID.test(id))) throw Object.assign(new Error('host-exit: orphan id'), { code: 'host-exit' });
      const stdout = await spawnCollected(spawnImpl, argvFor(host, `${REMOTE_COMMAND} --kill ${safe.join(',')}`), {});
      const text = stdout.toString('utf8').trim();
      return text ? JSON.parse(text) : {};
    },
  };
}

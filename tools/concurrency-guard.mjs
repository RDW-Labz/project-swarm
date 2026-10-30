// SPDX-License-Identifier: Apache-2.0
// swarm with-concurrency N -- COMMAND...: run one swarm command with `machineConcurrency` set to N, and put the old value back when it ends. Always: normal exit, an error,
// Ctrl-C, a kill, a crash of the wrapper itself (a small watcher process restores it when the wrapper dies), and the next swarm command after a power cut (a leftover marker whose
// owner is gone is restored first thing).
// The marker file sits next to the config and names the value to put back. It is restored only if the config still holds the value this guard set: a value the owner changed in the
// meantime is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath } from './local-config.mjs';

const SELF = fileURLToPath(import.meta.url);
const SWARM = path.join(path.dirname(SELF), 'swarm.mjs');
export const GUARD_USAGE = 'Usage: swarm with-concurrency N -- COMMAND [ARGS...]   (N is 1 to 2048; the command is a swarm command; the old value is put back when it ends, whatever happens)';
const MIN = 1, MAX = 2048;

export const markerPath = configFile => path.join(path.dirname(configFile), 'concurrency-restore.json');
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// Normalize both identity fields alike; a reused pid is not the guarded child.
function procField(pid, field) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', field, '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const trimmed = out.trim();
    return trimmed ? trimmed.replace(/\s+/g, ' ') : null;
  } catch { return null; }
}
const defaultProcStart = pid => procField(pid, 'lstart=');
export const defaultProcIdentity = (pid, procStart = defaultProcStart) => ({ start: procStart(pid), command: procField(pid, 'command=') });
function matchesChild(marker, procIdentity) {
  if (![marker.childProcStart, marker.childCommand].every(value => typeof value === 'string' && value.trim().length > 0)) return false;
  try {
    const identity = procIdentity(marker.childPid);
    return marker.childProcStart === identity?.start && marker.childCommand === identity?.command;
  } catch { return false; }
}
function termChildOnce(childPid) {
  if (!Number.isInteger(childPid) || childPid <= 0 || !alive(childPid)) return;
  try { process.kill(childPid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') console.error('[tools/concurrency-guard.mjs] SIGTERM child:', error?.message ?? error); }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/** Puts the value back if a marker says to. Synchronous and idempotent (it is also what runs on the way out). Returns what it did. */
export function restore(configFile) {
  const marker = readJson(markerPath(configFile));
  if (!marker || typeof marker !== 'object') { fs.rmSync(markerPath(configFile), { force: true }); return { restored: false, reason: 'no marker' }; }
  const config = readJson(configFile);
  let result;
  if (config && typeof config === 'object' && !Array.isArray(config) && config.machineConcurrency === marker.set) {
    if (marker.previous === null || marker.previous === undefined) delete config.machineConcurrency; else config.machineConcurrency = marker.previous;
    writeJsonAtomic(configFile, config, 0o600);
    result = { restored: true, to: marker.previous ?? null };
  } else result = { restored: false, reason: 'the value was changed meanwhile: left as it is' };
  fs.rmSync(markerPath(configFile), { force: true });
  return result;
}

// A marker written before the machine last started belongs to a process that no longer exists, whatever process now holds its pid.
const bootedAt = () => Date.now() - os.uptime() * 1000;
const fromBeforeBoot = marker => { const at = Date.parse(marker?.at); return Number.isFinite(at) && at < bootedAt() - 5000; };

/** Called at the start of every swarm command: a marker whose owner is gone is restored. */
export function restoreIfStale(configFile, { isAlive = alive, procStart = defaultProcStart, procIdentity = pid => defaultProcIdentity(pid, procStart), kill = process.kill, exit = process.exit, now = Date.now } = {}) {
  try {
    const marker = readJson(markerPath(configFile));
    if (!marker) return null;
    if (fromBeforeBoot(marker)) return restore(configFile);
    if (isAlive(marker.pid)) {
      // EPERM means another user's process, so it cannot own this guarded run.
      try { kill(marker.pid, 0); return null; } catch { return restore(configFile); }
    }
    const child = marker.childPid;
    if (!Number.isInteger(child) || child <= 0 || !matchesChild(marker, procIdentity) || !isAlive(child)) return restore(configFile);
    // alive() treats EPERM as alive, but another user's process is not ours.
    try { kill(child, 0); } catch { return restore(configFile); }
    if (child === process.pid) {
      process.stderr.write('[tools/concurrency-guard.mjs] this process is the orphaned command of a dead guarded run; the command was NOT run. machineConcurrency is still raised and will be restored by the watcher or the next command.\n');
      return exit(143);
    }
    // Re-read before signalling and before writing: another restorer may have updated the marker.
    const currentMarker = () => {
      const fresh = readJson(markerPath(configFile));
      return fresh?.pid === marker.pid && fresh?.childPid === child && fresh?.childProcStart === marker.childProcStart && fresh?.childCommand === marker.childCommand ? fresh : null;
    };
    const fresh = currentMarker();
    if (!fresh) return null;
    if (fresh.termSentAt === undefined) {
      try { kill(child, 'SIGTERM'); } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'ESRCH') return restore(configFile);
        throw error;
      }
      const sentAt = now();
      const latest = currentMarker();
      if (latest && latest.termSentAt === undefined) writeJsonAtomic(markerPath(configFile), { ...latest, termSentAt: sentAt });
    }
    return { restored: false, reason: 'orphaned command still running' };
  } catch { return null; }
}

export function apply(configFile, value, { pid = process.pid, now = Date.now } = {}) {
  if (!Number.isInteger(value) || value < MIN || value > MAX) throw Object.assign(new Error(`${GUARD_USAGE}`), { code: 'guard-usage' });
  const stale = restoreIfStale(configFile);
  const existing = readJson(markerPath(configFile));
  if (existing && alive(existing.pid) && !fromBeforeBoot(existing)) throw Object.assign(new Error(`another guarded run (process ${existing.pid}) has machineConcurrency set to ${existing.set}; wait for it or stop it`), { code: 'guard-busy' });
  const config = readJson(configFile);
  if (config === null) throw Object.assign(new Error(`${configFile} is missing or is not valid JSON: not changed`), { code: 'guard-config' });
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Object.assign(new Error(`${configFile} is not a JSON object: not changed`), { code: 'guard-config' });
  const previous = Object.hasOwn(config, 'machineConcurrency') ? config.machineConcurrency : null;
  // The marker first: if anything fails after this, the next command restores it.
  // Created exclusively: two guards starting at once cannot both believe they own the value.
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  try { fs.writeFileSync(markerPath(configFile), `${JSON.stringify({ previous, set: value, pid, at: new Date(now()).toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('another guarded run is starting; try again'), { code: 'guard-busy' }); throw error; }
  writeJsonAtomic(configFile, { ...config, machineConcurrency: value }, 0o600);
  return { previous, set: value, staleRestored: stale?.restored ?? false };
}

/** The watcher: waits for `pid` to die, then restores. Runs as its own process so a crash or SIGKILL of the wrapper cannot leave the value changed. */
function watch(pid, configFile) {
  const timer = setInterval(async () => {
    if (alive(pid)) return;
    clearInterval(timer);
    try {
      const marker = readJson(markerPath(configFile));
      if (marker && marker.pid === pid) {
        // The wrapper died but its command may still be running at the raised value: stop it first (it would go on starting workers at the old setting), then put the value back.
        const child = marker.childPid;
        if (Number.isInteger(child) && child > 0 && alive(child) && matchesChild(marker, defaultProcIdentity)) {
          termChildOnce(child);
          for (let i = 0; i < 100 && alive(child); i += 1) await new Promise(resolve => setTimeout(resolve, 100));
          if (alive(child) && matchesChild(marker, defaultProcIdentity)) { try { process.kill(child, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') console.error('[tools/concurrency-guard.mjs] watch SIGKILL child:', error?.message ?? error); } }
        }
        restore(configFile);
      }
    } catch (error) { if (error?.code !== 'ENOENT') console.error('[tools/concurrency-guard.mjs] watch restore after wrapper death:', error?.message ?? error); }
    process.exit(0);
  }, 300);
}

/** Records the command's pid in the marker, so a watcher that outlives a crashed wrapper can stop it. */
function noteChild(configFile, pid, childPid, procIdentity = defaultProcIdentity) {
  try {
    const marker = readJson(markerPath(configFile));
    if (marker?.pid === pid) {
      const identity = procIdentity(childPid);
      writeJsonAtomic(markerPath(configFile), { ...marker, childPid, childProcStart: identity?.start ?? null, childCommand: identity?.command ?? null });
    }
  } catch (error) { if (error?.code !== 'ENOENT') console.error('[tools/concurrency-guard.mjs] noteChild marker write:', error?.message ?? error); }
}

/** Runs `swarm ARGS` with the value set; resolves with the child's exit code once the value is back. `spawnImpl` and `startWatcher` are replaceable for tests. */
export async function runGuarded({ value, args, env = process.env, configFile = resolveConfigPath({ env }), spawnImpl = spawn, startWatcher = true, stdio = 'inherit', now = Date.now, procStart = defaultProcStart, procIdentity = pid => defaultProcIdentity(pid, procStart) }) {
  // The signal handlers go in BEFORE the value changes: a Ctrl-C in the moment between writing the value and starting the command must still reach the restore below
  // (without a handler the wrapper would die on the spot and leave the value to the watcher a few hundred milliseconds later).
  let child = null;
  let pending = null;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  // Ctrl-C at a terminal reaches the whole foreground group, the command included: it gets a moment to end on its own before the signal is passed on (it would get SIGINT twice).
  let childExited = false;
  const passOn = sig => { try { if (!childExited) child?.kill(sig); } catch (error) { if (error?.code !== 'ESRCH') console.error('[tools/concurrency-guard.mjs] passOn signal to child:', error?.message ?? error); } };
  const handlers = signals.map(sig => [sig, () => { pending = pending ?? sig; if (!child) return; if (sig === 'SIGTERM') passOn(sig); else setTimeout(() => passOn(sig), 200).unref(); }]);
  for (const [sig, h] of handlers) process.on(sig, h);
  const dropHandlers = () => { for (const [sig, h] of handlers) process.off(sig, h); };
  let done = false;
  let applied;
  const finish = () => { if (done) return; done = true; try { if (readJson(markerPath(configFile))?.pid === process.pid) restore(configFile); } catch (error) { if (error?.code !== 'ENOENT') console.error('[tools/concurrency-guard.mjs] finish restore on exit:', error?.message ?? error); } };
  const onExit = () => finish();
  try { applied = apply(configFile, value, { now }); } catch (error) { dropHandlers(); throw error; }
  let watcher = null;
  process.on('exit', onExit);
  if (startWatcher) { watcher = spawn(process.execPath, [SELF, '--watch', String(process.pid), configFile], { detached: true, stdio: 'ignore', env }); watcher.unref(); }
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  let code;
  if (pending) code = codes[pending];
  else {
    child = spawnImpl(process.execPath, [SWARM, ...args], { stdio, env });
    child.on('exit', () => { childExited = true; });
    noteChild(configFile, process.pid, child.pid, procIdentity);
    // A signal that arrived while the command was starting is passed on now.
    if (pending) { try { child.kill(pending); } catch (error) { if (error?.code !== 'ESRCH') console.error('[tools/concurrency-guard.mjs] pass pending signal to child:', error?.message ?? error); } }
    code = await new Promise(resolve => { child.on('error', () => resolve(127)); child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[sig] ?? 1) : 1))); });
  }
  dropHandlers();
  finish();
  process.off('exit', onExit);
  try { watcher?.kill('SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') console.error('[tools/concurrency-guard.mjs] stop watcher SIGTERM:', error?.message ?? error); }
  return { code, applied };
}

export async function runWithConcurrency(argv, { env = process.env, rootArgs = [] } = {}) {
  const cut = argv.indexOf('--');
  const value = Number(argv[0]);
  if (cut !== 1 || cut === argv.length - 1 || !/^\d+$/.test(argv[0] ?? '') || value < MIN || value > MAX) return { stdout: `${GUARD_USAGE}\n`, exitCode: 2 };
  const rest = [...rootArgs, ...argv.slice(cut + 1)];
  if (rest.includes('with-concurrency') && rest.indexOf('with-concurrency') === rootArgs.length) return { stdout: 'with-concurrency cannot wrap itself\n', exitCode: 2 };
  try {
    const { code, applied } = await runGuarded({ value, args: rest, env });
    process.stderr.write(`machineConcurrency was ${applied.previous ?? 'unset'}, set to ${applied.set} for this command, and is back to ${applied.previous ?? 'unset'}.\n`);
    return { stdout: '', exitCode: code };
  } catch (error) {
    if (String(error.code ?? '').startsWith('guard-')) return { stdout: `${error.message}\n`, exitCode: 1 };
    throw error;
  }
}

if (process.argv[1] === SELF && process.argv[2] === '--watch') watch(Number(process.argv[3]), process.argv[4]);

// SPDX-License-Identifier: Apache-2.0
// swarm with-concurrency N -- COMMAND...: run one swarm command with `machineConcurrency` set to N, and put the old value back when it ends. Always: normal exit, an error,
// Ctrl-C, a kill, a crash of the wrapper itself (a small watcher process restores it when the wrapper dies), and the next swarm command after a power cut (a leftover marker whose
// owner is gone is restored first thing).
// The marker file sits next to the config and names the value to put back. It is restored only if the config still holds the value this guard set: a value the owner changed in the
// meantime is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath } from './local-config.mjs';

const SELF = fileURLToPath(import.meta.url);
const SWARM = path.join(path.dirname(SELF), 'swarm.mjs');
export const GUARD_USAGE = 'Usage: swarm with-concurrency N -- COMMAND [ARGS...]   (N is 1 to 2048; the command is a swarm command; the old value is put back when it ends, whatever happens)';
const MIN = 1, MAX = 2048;

export const markerPath = configFile => path.join(path.dirname(configFile), 'concurrency-restore.json');
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

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

/** Called at the start of every swarm command: a marker whose owner is gone is restored. */
export function restoreIfStale(configFile) {
  try {
    const marker = readJson(markerPath(configFile));
    if (!marker) return null;
    if (alive(marker.pid)) return null;
    return restore(configFile);
  } catch { return null; }
}

export function apply(configFile, value, { pid = process.pid, now = Date.now } = {}) {
  if (!Number.isInteger(value) || value < MIN || value > MAX) throw Object.assign(new Error(`${GUARD_USAGE}`), { code: 'guard-usage' });
  const stale = restoreIfStale(configFile);
  const existing = readJson(markerPath(configFile));
  if (existing && alive(existing.pid)) throw Object.assign(new Error(`another guarded run (process ${existing.pid}) has machineConcurrency set to ${existing.set}; wait for it or stop it`), { code: 'guard-busy' });
  const config = readJson(configFile);
  if (config === null) throw Object.assign(new Error(`${configFile} is missing or is not valid JSON: not changed`), { code: 'guard-config' });
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Object.assign(new Error(`${configFile} is not a JSON object: not changed`), { code: 'guard-config' });
  const previous = Object.hasOwn(config, 'machineConcurrency') ? config.machineConcurrency : null;
  // The marker first: if anything fails after this, the next command restores it.
  writeJsonAtomic(markerPath(configFile), { previous, set: value, pid, at: new Date(now()).toISOString() });
  writeJsonAtomic(configFile, { ...config, machineConcurrency: value }, 0o600);
  return { previous, set: value, staleRestored: stale?.restored ?? false };
}

/** The watcher: waits for `pid` to die, then restores. Runs as its own process so a crash or SIGKILL of the wrapper cannot leave the value changed. */
function watch(pid, configFile) {
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    try { const marker = readJson(markerPath(configFile)); if (marker && marker.pid === pid) restore(configFile); } catch { /* the next command restores it */ }
    process.exit(0);
  }, 300);
}

/** Runs `swarm ARGS` with the value set; resolves with the child's exit code once the value is back. `spawnImpl` and `startWatcher` are replaceable for tests. */
export async function runGuarded({ value, args, env = process.env, configFile = resolveConfigPath({ env }), spawnImpl = spawn, startWatcher = true, stdio = 'inherit', now = Date.now }) {
  const applied = apply(configFile, value, { now });
  let watcher = null;
  if (startWatcher) { watcher = spawn(process.execPath, [SELF, '--watch', String(process.pid), configFile], { detached: true, stdio: 'ignore', env }); watcher.unref(); }
  let done = false;
  const finish = () => { if (done) return; done = true; try { restore(configFile); } catch { /* the next command restores it */ } };
  const onExit = () => finish();
  process.on('exit', onExit);
  const child = spawnImpl(process.execPath, [SWARM, ...args], { stdio, env });
  const forward = signal => () => { try { child.kill(signal); } catch { /* already gone */ } };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(sig => [sig, forward(sig)]);
  for (const [sig, h] of handlers) process.on(sig, h);
  const code = await new Promise(resolve => { child.on('error', () => resolve(127)); child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[sig] ?? 1) : 1))); });
  for (const [sig, h] of handlers) process.off(sig, h);
  finish();
  process.off('exit', onExit);
  try { watcher?.kill('SIGTERM'); } catch { /* it exits on its own once the pid is gone */ }
  return { code, applied };
}

export async function runWithConcurrency(argv, { env = process.env } = {}) {
  const cut = argv.indexOf('--');
  const value = Number(argv[0]);
  if (cut !== 1 || cut === argv.length - 1 || !/^\d+$/.test(argv[0] ?? '') || value < MIN || value > MAX) return { stdout: `${GUARD_USAGE}\n`, exitCode: 2 };
  const rest = argv.slice(cut + 1);
  if (rest[0] === 'with-concurrency') return { stdout: 'with-concurrency cannot wrap itself\n', exitCode: 2 };
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

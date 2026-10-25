// SPDX-License-Identifier: Apache-2.0
// The CLI side of the safety group: swarm stop, backup, restore, migrations. The modules hold the rules; this file wires them to the real
// project (runs, the autopilot lock, the rented GPU session) and prints the result.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runStopAll, readStopMarker, clearStop, exitCodeFor, formatStopLines } from './stop-all.mjs';
import { createBackup, listBackups, restoreBackup, verifyBackup } from './state-backup.mjs';
import { runLedgerCommand } from './ledger-cli.mjs';
import { checkMigrations, readApprovals, addApproval, validateMigrationsConfig, isMigrationFile, runRoundTrip, MIGRATION_DEFAULTS } from './migration-gate.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Migration commands run with the project's own tools; the result has the same shape the security gate's exec returns.
const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONFIG'];
// Only these variables reach the commands (never provider keys); a profile can add names with migrations.env.
export function migrationEnv(extraNames = [], env = process.env) {
  const out = {};
  for (const name of [...ENV_KEEP, ...extraNames]) if (typeof env[name] === 'string') out[name] = env[name];
  return out;
}
async function defaultExec(argv, { cwd, timeoutMs = 300000, env } = {}) {
  try { const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: env ?? migrationEnv() }); return { exitCode: 0, stdout, stderr }; }
  catch (error) { return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? '') }; }
}

const out = (stdout, exitCode = 0) => ({ stdout: `${stdout}\n`, exitCode });
const bad = message => out(message, 1);
const FLAGS = new Set(['--all', '--clear', '--status', '--yes', '--reason', '--note', '--json', '--from', '--into']);

function parse(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (!FLAGS.has(arg)) throw new Error(`unknown flag: ${arg}`);
      if (arg === '--reason' || arg === '--note' || arg === '--from' || arg === '--into') { flags[arg.slice(2)] = args[++i]; if (flags[arg.slice(2)] === undefined) throw new Error(`${arg} needs a value`); } else flags[arg.slice(2)] = true;
    } else rest.push(arg);
  }
  return { flags, rest };
}

// The real effects the panic button needs. Everything is injected so tests (and stub runs) never touch real processes.
// The modules are imported when a step needs them, so a failing import can never keep the stop marker from being written.
export function realStopDeps(root, { env = process.env, reason } = {}) {
  const swarm = () => import('./swarm.mjs');
  const gpuCommands = () => import('./gpu-commands.mjs');
  const quiet = { out: () => {}, env };
  const state = { downFailure: null };
  return {
    reason,
    listRuns: async () => {
      const dir = path.join(root, '.swarm', 'runs');
      const ids = await fs.readdir(dir).catch(() => []);
      const runs = [];
      for (const id of ids) { try { runs.push({ id, status: (await (await swarm()).readState(root, id)).status }); } catch { /* not a run */ } }
      return runs;
    },
    // A running run gets the cancel file (its runner stops the jobs); a paused, queued, pending or held one is cancelled in place.
    cancelRun: async (r, id) => {
      const mod = await swarm();
      const status = (await mod.readState(r, id)).status;
      return status === 'running' ? mod.cancelRun(r, id) : mod.cancelInactiveRun(r, id);
    },
    // No lock file: nothing to stop. A lock that cannot be read or has no usable pid is a failure to report, not a silent nothing.
    readAutopilotPid: async () => {
      let text;
      try { text = await fs.readFile(path.join(root, '.swarm', 'project', 'autopilot.lock'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const pid = JSON.parse(text)?.pid;
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`the autopilot lock has no usable pid (${String(pid)})`);
      return pid;
    },
    // The process must really be a swarm autopilot (its command line says so) before it is signalled.
    isAutopilot: async pid => {
      try { const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }); return /swarm/.test(stdout) && /\bautopilot\b/.test(stdout); } catch { return false; }
    },
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } },
    gpuSession: async () => (await gpuCommands()).readSessionFile(env) ?? null,
    // gpu down removes the session record even when the node cannot be reached: an unreachable node is a failure of this step, not a success.
    gpuDown: async () => {
      const result = await (await gpuCommands()).runGpuCommand(['down', '--json'], quiet);
      if (result?.notes?.length) state.downFailure = result.notes.join('; ');
      return result;
    },
    gpuStatus: async () => {
      if (state.downFailure) throw new Error(state.downFailure);
      return (await gpuCommands()).runGpuCommand(['status', '--json'], quiet);
    },
    backup: (r, options) => createBackup(r, options),
  };
}

async function stopCommand(root, args, deps) {
  const { flags } = parse(args);
  if (flags.clear) { const result = await clearStop(root); if (result.error) return bad(`could not remove the stop marker: ${result.error}`);
  return out(result.cleared ? 'stop marker removed: runs, go and autopilot may start again' : 'no stop marker'); }
  if (flags.status) { const marker = await readStopMarker(root); return out(marker ? `stopped at ${marker.at ?? 'unknown time'}: ${marker.reason}` : 'not stopped'); }
  if (!flags.all) return bad('usage: swarm stop --all | --status | --clear');
  const result = await runStopAll(root, deps.stop ?? realStopDeps(root, { env: deps.env ?? process.env, reason: flags.reason }));
  const lines = formatStopLines(result);
  const gpuStep = result.steps.find(step => step.name === 'gpu');
  if (gpuStep && gpuStep.status !== 'nothing') lines.push('swarm never rents: terminate the rented instance in the provider console (powering it off does not stop billing).');
  if (result.billingRisk) lines.push('BILLING RISK: the rented node was not confirmed stopped.');
  lines.push(result.ok ? 'stopped: new runs, go and autopilot are refused until swarm stop --clear' : 'stop finished WITH FAILURES (exit 2): see the failed steps above');
  return out(lines.join('\n'), exitCodeFor(result));
}

async function backupCommand(root, args) {
  const { flags, rest } = parse(args);
  if (rest[0] === 'ledger') {
    const ledgerArgs = [...rest.slice(1)];
    for (const [k, v] of Object.entries(flags)) {
      if (k === 'json' || k === 'all' || k === 'yes') ledgerArgs.push(`--${k}`);
      else if (k === 'from' || k === 'into') ledgerArgs.push(`--${k}`, v);
    }
    return runLedgerCommand(root, ledgerArgs);
  }
  if (rest[0] === 'list') {
    const list = await listBackups(root);
    return out(flags.json ? JSON.stringify(list) : (list.map(b => `${b.id}  ${b.files} files  ${b.bytes} bytes  ${b.reason}`).join('\n') || 'no backups'));
  }
  if (rest[0] === 'verify') {
    if (!rest[1]) return bad('usage: swarm backup verify ID');
    const result = await verifyBackup(root, rest[1]);
    return out(result.ok ? `${rest[1]}: ok` : `${rest[1]}: CORRUPT\n${result.problems.join('\n')}`, result.ok ? 0 : 1);
  }
  if (rest.length) return bad('usage: swarm backup [--reason TEXT] | list | verify ID');
  const made = await createBackup(root, { reason: flags.reason ?? 'manual' });
  return out(flags.json ? JSON.stringify(made) : `backup ${made.id}: ${made.files} files, ${made.bytes} bytes (secrets are never copied)`);
}

async function restoreCommand(root, args) {
  const { flags, rest } = parse(args);
  if (rest.length !== 1) return bad('usage: swarm restore ID [--yes]  (without --yes it only shows the plan)');
  const result = await restoreBackup(root, rest[0], { yes: flags.yes === true });
  if (result.planned) return out(`plan: restore ${result.restored?.length ?? result.files?.length ?? 0} file(s) from ${rest[0]}; a backup of the current state is taken first. Rerun with --yes.`);
  return out(`restored ${result.restored.length} file(s) from ${rest[0]}; the state before is backup ${result.preRestore} (swarm restore ${result.preRestore} --yes undoes this)`);
}

async function readConfig(root) {
  try {
    const pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
    return validateMigrationsConfig(pointer?.profile?.migrations ?? {});
  } catch { return validateMigrationsConfig({}); }
}

async function migrationsCommand(root, args, deps) {
  const { flags, rest } = parse(args);
  const config = await readConfig(root);
  if (!config.ok) return bad(`profile.migrations: ${config.errors.join('; ')}`);
  const read = file => fs.readFile(path.join(root, file));
  const exists = file => fs.stat(path.join(root, file)).then(() => true, () => false);
  if (rest[0] === 'approve') {
    const file = rest[1];
    if (!file || !isMigrationFile(file, config.config) || !(await exists(file))) return bad(`usage: swarm migrations approve FILE (a .sql file in ${config.config.dir})`);
    const sha = createHash('sha256').update(await read(file)).digest('hex');
    await addApproval(root, { file, sha256: sha, note: flags.note ?? '' });
    return out(`approved ${file} (${sha.slice(0, 12)}): any later edit of the file needs a new approval`);
  }
  if (rest[0] === 'check' || rest.length === 0) {
    const dir = path.join(root, config.config.dir);
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    const names = entries.filter(e => e.isFile() && /\.sql$/i.test(e.name)).map(e => `${config.config.dir}/${path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/')}`);
    const result = await checkMigrations({ files: names, config: config.config, read, exists, approvals: await readApprovals(root) });
    const lines = result.problems.map(p => `${p.check}: ${p.message}`);
    if (rest[0] === 'check' && flags.yes && result.ok) {
      const trip = await runRoundTrip({ root, config: config.config, exec: deps.exec ?? defaultExec });
      for (const step of trip.steps) lines.push(`${step.name}: ${step.ok ? 'ok' : `FAILED ${step.tail}`}`);
      if (!trip.ok) return out(lines.join('\n'), 1);
    }
    return out(lines.join('\n') || `migrations ok (${names.length} file(s))`, result.ok ? 0 : 1);
  }
  return bad('usage: swarm migrations [check [--yes]] | approve FILE [--note TEXT]');
}

export async function runSafetyCommand(root, command, args, deps = {}) {
  try {
    if (command === 'stop') return await stopCommand(root, args, deps);
    if (command === 'backup') return await backupCommand(root, args);
    if (command === 'restore') return await restoreCommand(root, args);
    if (command === 'migrations') return await migrationsCommand(root, args, deps);
  } catch (error) {
    return bad(String(error?.message ?? error));
  }
  return bad(`unknown command ${command}`);
}

export { MIGRATION_DEFAULTS };

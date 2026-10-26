// SPDX-License-Identifier: Apache-2.0
// `swarm burst gpu status|start|run-cpu` (CLI wiring in tools/swarm.mjs is a follow-up).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { computeBurstGpuGates } from './burst-gates.mjs';
import { startBurstGpu } from './burst-gpu.mjs';
import { gpuUp } from './gpu.mjs';
import { runCpuRunnerJob } from './cpu-runner.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

const USAGE =
  'Usage: swarm burst gpu status|start --metrics <file.json> [--ticket <file.json>]\n' +
  '       swarm burst run-cpu --ticket-test <cmd> --e2e <cmd> [--ticket-id <id>] [--runner-id <id>]\n';

function readArg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function loadMetrics(metricsPath) {
  const text = await fs.readFile(metricsPath, 'utf8');
  return JSON.parse(text);
}

async function loadTicket(ticketPath) {
  if (!ticketPath) return null;
  const text = await fs.readFile(ticketPath, 'utf8');
  return JSON.parse(text);
}

function defaultProvision({ env, gpuUpOptions, gpuUpDeps }) {
  return async () => gpuUp(gpuUpOptions ?? {}, { env, ...gpuUpDeps });
}

export const cpuRunnerCompletionsPath = root =>
  path.join(root, '.swarm', 'project', 'cpu-runner-completions.json');

async function readCpuRunnerCompletionsFile(root) {
  try {
    const raw = await fs.readFile(cpuRunnerCompletionsPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendCpuRunnerCompletion(root, entry) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'cpu-runner-completions.json');
  await assertRegularOrMissing(file);
  const existing = await readCpuRunnerCompletionsFile(root);
  existing.push(entry);
  const tmp = path.join(dir, `.cpu-runner-completions.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(existing, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function readCpuRunnerCompletions(root) {
  return readCpuRunnerCompletionsFile(root);
}

function formatCheckLine(label, check) {
  return `${label}: ${check.status} (${Math.round(check.durationMs)}ms)`;
}

async function runRunCpuBurstCommand(root, flagArgs, { runJob = runCpuRunnerJob, cwd } = {}) {
  const ticketTestCommand = readArg(flagArgs, '--ticket-test');
  const e2eSuiteCommand = readArg(flagArgs, '--e2e');
  if (!ticketTestCommand || !e2eSuiteCommand) {
    return { stdout: USAGE, exitCode: 1 };
  }

  const ticketId = readArg(flagArgs, '--ticket-id');
  const runnerId = readArg(flagArgs, '--runner-id');

  const result = await runJob({
    ticketTestCommand,
    e2eSuiteCommand,
    cwd,
  });

  const entry = {
    type: 'cpu-runner.completed',
    ...(ticketId ? { ticketId } : {}),
    ...(runnerId ? { runnerId } : {}),
    ticketTests: result.ticketTests,
    e2eSuite: result.e2eSuite,
    completedAt: result.completedAt,
    recordedAt: new Date().toISOString(),
  };
  await appendCpuRunnerCompletion(root, entry);

  const overall =
    result.ticketTests.status === 'pass' && result.e2eSuite.status === 'pass' ? 'pass' : 'fail';
  const stdout = [
    formatCheckLine('ticket-tests', result.ticketTests),
    formatCheckLine('e2e-suite', result.e2eSuite),
    `overall: ${overall}`,
  ].join('\n') + '\n';

  return { stdout, exitCode: overall === 'pass' ? 0 : 1 };
}

async function runGpuBurstCommand(root, args, { env = process.env, provision, gpuUpOptions, gpuUpDeps } = {}) {
  const sub = args[1];
  const flagArgs = args.slice(2);

  if (sub !== 'status' && sub !== 'start') {
    return { stdout: USAGE, exitCode: 1 };
  }

  const metricsPath = readArg(flagArgs, '--metrics');
  if (!metricsPath) {
    return { stdout: USAGE, exitCode: 1 };
  }

  const metrics = await loadMetrics(metricsPath);

  if (sub === 'status') {
    const gates = computeBurstGpuGates(metrics);
    return { stdout: gates.text, exitCode: 0 };
  }

  const ticketPath = readArg(flagArgs, '--ticket');
  const ticket = ticketPath ? await loadTicket(ticketPath) : null;
  const runProvision = provision ?? defaultProvision({ env, gpuUpOptions, gpuUpDeps });
  const result = await startBurstGpu(metrics, ticket, runProvision);
  const stdout = `${result.lines.join('\n')}\n${result.message}\n`;
  return { stdout, exitCode: result.exitCode };
}

export async function runBurstCommand(root, args, options = {}) {
  try {
    if (args[0] === 'gpu') {
      return await runGpuBurstCommand(root, args, options);
    }
    if (args[0] === 'run-cpu') {
      return await runRunCpuBurstCommand(root, args.slice(1), options);
    }
    return { stdout: USAGE, exitCode: 1 };
  } catch (error) {
    return { stdout: `${String(error.message ?? error).split('\n')[0]}\n`, exitCode: 1 };
  }
}

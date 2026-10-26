// SPDX-License-Identifier: Apache-2.0
// `swarm burst gpu status|start` (CLI wiring in tools/swarm.mjs is a follow-up).
import fs from 'node:fs/promises';
import { computeBurstGpuGates } from './burst-gates.mjs';
import { startBurstGpu } from './burst-gpu.mjs';
import { gpuUp } from './gpu.mjs';

const USAGE = 'Usage: swarm burst gpu status|start --metrics <file.json> [--ticket <file.json>]\n';

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

export async function runBurstCommand(root, args, { env = process.env, provision, gpuUpOptions, gpuUpDeps } = {}) {
  try {
    if (args[0] !== 'gpu') {
      return { stdout: USAGE, exitCode: 1 };
    }

    const sub = args[1];
    const flagArgs = args.slice(2);

    if (sub !== 'status' && sub !== 'start') {
      return { stdout: USAGE, exitCode: 1 };
    }

    const metricsPath = readArg(flagArgs, '--metrics');
    if (!metricsPath) {
      return { stdout: `${USAGE}`, exitCode: 1 };
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
  } catch (error) {
    return { stdout: `${String(error.message ?? error).split('\n')[0]}\n`, exitCode: 1 };
  }
}

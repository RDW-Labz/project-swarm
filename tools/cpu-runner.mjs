// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * @typedef {'pass' | 'fail'} CheckStatus
 */

/**
 * @typedef {object} CommandCheckResult
 * @property {CheckStatus} status
 * @property {number} durationMs
 * @property {number} exitCode
 */

/**
 * @typedef {object} CpuRunnerResult
 * @property {CommandCheckResult} ticketTests
 * @property {CommandCheckResult} e2eSuite
 * @property {string} completedAt ISO 8601 timestamp when both commands finished
 */

/**
 * @param {string} command Shell command to execute
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ exitCode: number, durationMs: number }>}
 */
function runShellCommand(command, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', () => {
      resolve({
        exitCode: 1,
        durationMs: performance.now() - start,
      });
    });
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        durationMs: performance.now() - start,
      });
    });
  });
}

/**
 * Run a ticket's unit/integration test command and the full project e2e suite.
 * Both commands always run; a failing ticket test does not skip e2e.
 *
 * @param {{ ticketTestCommand: string, e2eSuiteCommand: string, cwd?: string }} job
 * @returns {Promise<CpuRunnerResult>}
 */
export async function runCpuRunnerJob(job) {
  const { ticketTestCommand, e2eSuiteCommand, cwd } = job;

  const ticketRun = await runShellCommand(ticketTestCommand, { cwd });
  const e2eRun = await runShellCommand(e2eSuiteCommand, { cwd });

  const toCheck = (run) => ({
    status: run.exitCode === 0 ? 'pass' : 'fail',
    durationMs: run.durationMs,
    exitCode: run.exitCode,
  });

  return {
    ticketTests: toCheck(ticketRun),
    e2eSuite: toCheck(e2eRun),
    completedAt: new Date().toISOString(),
  };
}

// SPDX-License-Identifier: Apache-2.0
// T-0076 / R-018: artificial-load harness — five consecutive event-driven runs per check.
// node bench/throughput/load-timing.mjs [--workers N] [--main-thread-iterations N]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOAD_TIMING_RUNS,
  createCountBarrier,
  createEventTrace,
  createLoadSync,
  createManualGate,
  runLoadTimingCheck,
  runWithEventTrace,
} from '../../tools/load-sync-wait.mjs';

export { LOAD_TIMING_RUNS };

/**
 * @typedef {{ name: string, check: (context: { run: number, runs: number, trace: ReturnType<typeof createEventTrace> }) => unknown | Promise<unknown> }} LoadTimingCheckSpec
 */

/**
 * @typedef {{ name: string, runs: number, passed: number, ok: boolean, quarantined: boolean, failure?: { run: number, error: unknown } }} LoadTimingCheckReport
 */

/**
 * @typedef {{ runs: number, ok: boolean, quarantined: Array<{ name: string, passed: number, runs: number, failure?: { run: number, error: unknown } }>, reports: LoadTimingCheckReport[] }} LoadTimingHarnessSummary
 */

/**
 * Runs each check {@link LOAD_TIMING_RUNS} times in a row under artificial load (event waits only inside
 * checks — no wall-clock sleeps). Stops at the first quarantined check; never retries a failed run to green.
 * @param {LoadTimingCheckSpec[]} checks
 * @param {Omit<Parameters<typeof runLoadTimingCheck>[2], 'trace'> & { trace?: ReturnType<typeof createEventTrace> }} [options]
 * @returns {Promise<LoadTimingHarnessSummary>}
 */
export async function runLoadTimingHarness(checks, options = {}) {
  const trace = options.trace ?? createEventTrace({ label: 'load-timing-harness' });
  /** @type {LoadTimingCheckReport[]} */
  const reports = [];
  for (const spec of checks) {
    const report = await runLoadTimingCheck(spec.name, spec.check, { ...options, trace });
    reports.push(report);
    if (report.quarantined) break;
  }
  const quarantined = reports
    .filter(report => report.quarantined)
    .map(report => ({
      name: report.name,
      passed: report.passed,
      runs: report.runs,
      failure: report.failure,
    }));
  return {
    runs: LOAD_TIMING_RUNS,
    ok: reports.length > 0 && reports.every(report => report.ok),
    quarantined,
    reports,
  };
}

/**
 * @param {LoadTimingCheckSpec[]} checks
 * @param {Parameters<typeof runLoadTimingHarness>[1]} [options]
 * @returns {Promise<LoadTimingHarnessSummary>}
 */
export async function assertLoadTimingHarness(checks, options) {
  const summary = await runLoadTimingHarness(checks, options);
  if (summary.ok) return summary;
  const first = summary.quarantined[0] ?? summary.reports.find(report => !report.ok);
  const error = new Error(
    `load-timing harness failed: ${first?.name ?? 'unknown'} quarantined (${summary.reports.filter(report => report.ok).length}/${summary.reports.length} checks passed)`,
  );
  if (first?.failure?.error !== undefined) error.cause = first.failure.error;
  /** @type {any} */ (error).summary = summary;
  throw error;
}

/**
 * Built-in event-driven probes (setImmediate / sync primitives — no timers) for bench and integrators.
 * @returns {LoadTimingCheckSpec[]}
 */
export function defaultLoadTimingChecks() {
  return [
    {
      name: 'load-sync.notify-wait',
      async check({ trace }) {
        const sync = createLoadSync({ trace });
        const gate = createManualGate({ trace });
        setImmediate(() => {
          sync.notify('ready');
          gate.open();
        });
        await sync.waitFor('ready');
        await gate.wait();
      },
    },
    {
      name: 'count-barrier',
      async check({ trace }) {
        const barrier = createCountBarrier(3, { trace });
        for (let index = 0; index < 3; index += 1) {
          setImmediate(() => barrier.arrive(index));
        }
        await barrier.wait();
      },
    },
    {
      name: 'load-sync.two-phase',
      async check({ trace }) {
        const sync = createLoadSync({ trace });
        setImmediate(() => sync.notify('phase-1'));
        await sync.waitFor('phase-1');
        setImmediate(() => sync.notify('phase-2'));
        await sync.waitFor('phase-2');
      },
    },
  ];
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<LoadTimingHarnessSummary>}
 */
export async function main(argv = process.argv) {
  const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const raw = argv[index + 1];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const workers = arg('workers', undefined);
  const mainThreadIterations = arg('main-thread-iterations', undefined);
  /** @type {Parameters<typeof runLoadTimingHarness>[1]} */
  const options = {};
  if (workers !== undefined) options.workers = workers;
  if (mainThreadIterations !== undefined) options.mainThreadIterations = mainThreadIterations;

  const trace = createEventTrace({ label: 'bench/load-timing' });
  return runWithEventTrace(trace, () =>
    assertLoadTimingHarness(defaultLoadTimingChecks(), { ...options, trace }),
  );
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (entry === here) {
  main()
    .then(summary => {
      console.log(
        JSON.stringify({
          status: 'ok',
          runs: summary.runs,
          checks: summary.reports.map(report => ({
            name: report.name,
            ok: report.ok,
            passed: report.passed,
          })),
        }),
      );
    })
    .catch(error => {
      const summary = /** @type {any} */ (error).summary;
      console.log(
        JSON.stringify({
          status: 'quarantined',
          message: error.message,
          quarantined: summary?.quarantined ?? [],
        }),
      );
      process.exitCode = 1;
    });
}

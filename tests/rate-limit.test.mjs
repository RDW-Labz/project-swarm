import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runManifest } from '../tools/swarm.mjs';
import { summarizeRateLimit, rateLimitError, rateLimitWarning } from '../tools/rate-limit.mjs';

const RESETS = 1790481600;
const RESETS_ISO = '2026-09-27T04:00:00.000Z';
const warn = utilization => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: RESETS, rateLimitType: 'five_hour', utilization, isUsingOverage: false, surpassedThreshold: 0.9 } });
const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESETS, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 1.02, resetsAt: RESETS }, seven_day: { utilization: 0.31, resetsAt: 1790733600 } } } };
const synthetic = { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your monthly spend limit" }] }, error: 'rate_limit' };
const errorResult = { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 1.5755892, result: "You've hit your monthly spend limit" };
const okResult = { type: 'result', subtype: 'success', is_error: false, result: 'Worker complete' };

test('summarizeRateLimit returns null without rate limit events', () => {
  assert.equal(summarizeRateLimit([]), null);
  assert.equal(summarizeRateLimit([{ type: 'assistant' }, { type: 'result' }, null, 'text', 7]), null);
});

test('summarizeRateLimit summarizes the measured warning, warning, rejected sequence', () => {
  assert.deepEqual(summarizeRateLimit([warn(0.92), warn(0.94), rejected, synthetic, errorResult]), {
    status: 'rejected', rateLimitType: 'five_hour', resetsAt: RESETS_ISO, utilization: 1.02, maxUtilization: 1.02, warnings: 2
  });
});

test('summarizeRateLimit ignores unrelated events and non-object rate_limit_info', () => {
  const summary = summarizeRateLimit([
    { type: 'system', rate_limit_info: { status: 'rejected' } },
    { type: 'rate_limit_event', rate_limit_info: 'rejected' },
    { type: 'rate_limit_event', rate_limit_info: null },
    { type: 'rate_limit_event' },
    warn(0.5)
  ]);
  assert.equal(summary.status, 'allowed_warning');
  assert.equal(summary.warnings, 1);
  assert.equal(summary.maxUtilization, 0.5);
  assert.equal(summarizeRateLimit([{ type: 'rate_limit_event', rate_limit_info: 'rejected' }, { type: 'rate_limit_event', rate_limit_info: null }]), null);
});

test('summarizeRateLimit resolves nulls for missing or non-finite fields', () => {
  assert.deepEqual(summarizeRateLimit([{ type: 'rate_limit_event', rate_limit_info: { status: 3, rateLimitType: 4, resetsAt: 'soon', utilization: 'high' } }]), {
    status: null, rateLimitType: null, resetsAt: null, utilization: null, maxUtilization: null, warnings: 0
  });
});

test('summarizeRateLimit takes the last event for status but the maximum for utilization', () => {
  const summary = summarizeRateLimit([warn(0.97), { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: RESETS, utilization: 0.2 } }]);
  assert.equal(summary.status, 'allowed');
  assert.equal(summary.utilization, 0.2);
  assert.equal(summary.maxUtilization, 0.97);
  assert.equal(summary.warnings, 1);
});

test('rateLimitError only reports a rejected summary', () => {
  const summary = summarizeRateLimit([warn(0.92), rejected]);
  assert.equal(rateLimitError(summary), `Provider rate limit rejected (five_hour); resets ${RESETS_ISO}`);
  assert.equal(rateLimitError(summarizeRateLimit([warn(0.92)])), null);
  assert.equal(rateLimitError(null), null);
  assert.equal(rateLimitError(undefined), null);
});

test('rateLimitError falls back to unknown when resetsAt or type is missing', () => {
  const summary = summarizeRateLimit([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]);
  assert.equal(rateLimitError(summary), 'Provider rate limit rejected (unknown); resets unknown');
});

test('rateLimitWarning reports warnings and rejections, and nothing otherwise', () => {
  assert.equal(rateLimitWarning('w', null), null);
  assert.equal(rateLimitWarning('w', summarizeRateLimit([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }])), null);
  assert.equal(rateLimitWarning('w', summarizeRateLimit([warn(0.92), warn(0.94)])), 'rate limit warning: w five_hour at 94%');
  assert.equal(rateLimitWarning('w', summarizeRateLimit([warn(0.92), warn(0.94), rejected])), `rate limit: w rejected (five_hour); resets ${RESETS_ISO}`);
  assert.equal(rateLimitWarning('w', summarizeRateLimit([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }])), 'rate limit warning: w unknown at ?%');
});

// Helpers copied from tests/swarm.test.mjs; only tests inject a provider.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = jobs => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()] });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const emit = (events, exitCode) => fake(`for (const line of ${JSON.stringify(events.map(event => JSON.stringify(event)))}) console.log(line);\nprocess.exitCode = ${exitCode};`);

test('a rejected provider rate limit fails the job with a specific error', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: emit([warn(0.92), warn(0.94), rejected, synthetic, errorResult], 1) });
  const [record] = state.jobs;
  assert.equal(record.status, 'failed');
  // 1.20.0 prefixes a non-zero exit with agentError (`exit 1: ...; `); the classification stays last.
  assert.ok(record.error.endsWith(`Provider rate limit rejected (five_hour); resets ${RESETS_ISO}`), record.error);
  assert.match(record.agentError, /^exit 1: /);
  assert.equal(record.rateLimit.status, 'rejected');
  assert.equal(state.status, 'failed');
  assert.ok(state.warnings.includes(`rate limit: writer rejected (five_hour); resets ${RESETS_ISO}`));
});

test('a rate limit warning on a successful job stays complete and is surfaced as a warning', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: emit([warn(0.92), okResult], 0) });
  const [record] = state.jobs;
  assert.equal(record.status, 'complete');
  assert.equal(record.error, null);
  assert.equal(record.rateLimit.status, 'allowed_warning');
  assert.deepEqual(state.warnings, ['rate limit warning: writer five_hour at 92%']);
});

test('a job without rate limit events records a null rateLimit and no warning', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: emit([okResult], 0) });
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].rateLimit, null);
  assert.deepEqual(state.warnings, []);
});

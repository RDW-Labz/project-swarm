// SPDX-License-Identifier: Apache-2.0
// Anthropic API lane: one-request, tool-free workers paid from the operator's own API credits.
// - The key is read by the swarm parent only (env SWARM_ANTHROPIC_API_KEY, else the macOS
//   keychain item service `project-swarm` account `anthropic.api_key`) and never reaches a worker.
//   The ambient ANTHROPIC_API_KEY is deliberately ignored so another tool's key is never billed.
// - Sensitive jobs are allowed: Anthropic already receives this code through Claude workers.
// - Cheap models by default (Haiku, then Sonnet); Opus only for a job that sets tier "expensive".
// - Spend caps are machine-wide (one ledger shared by every project): a lifetime total and a UTC
//   day, each checked against a worst-case estimate before a request and recorded after it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocalConfig } from './local-config.mjs';

export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_KEY_ENV = 'SWARM_ANTHROPIC_API_KEY';
export const ANTHROPIC_KEY_ITEM = Object.freeze({ service: 'project-swarm', account: 'anthropic.api_key' });
// Raising either cap is the operator's decision; nothing here reads a raise from a manifest.
export const TOTAL_CAP_USD = 500;
export const DAY_CAP_USD = 20;
export const JOB_CAP_USD = 5;

// USD per token. Haiku 5.5 charges more once a prompt passes 100K tokens (`longIn`/`longOut`).
export const PRICES = Object.freeze({
  'claude-haiku-5-5': Object.freeze({ tier: 'cheap', input: 0.10e-6, output: 0.50e-6, longInput: 0.50e-6, longOutput: 2.50e-6, longAt: 100000 }),
  'claude-sonnet-5-5': Object.freeze({ tier: 'mid', input: 2e-6, output: 10e-6 }),
  'claude-opus-5-5': Object.freeze({ tier: 'expensive', input: 4e-6, output: 20e-6 }),
});
export const DEFAULT_MODELS = Object.freeze({ cheap: 'claude-haiku-5-5', mid: 'claude-sonnet-5-5', expensive: 'claude-opus-5-5' });
const CACHE_WRITE = 1.25, CACHE_READ = 0.1;

class AnthropicError extends Error {}
const fail = message => { throw new AnthropicError(message); };

export function anthropicPrice(model) {
  const price = PRICES[model];
  if (!price) fail(`anthropic-model-unsupported: ${model}; the lane prices only ${Object.keys(PRICES).join(', ')} so the spend caps can be enforced`);
  return price;
}
// Opus is the expensive tier: refused unless the job asked for it.
export const isOpusModel = model => typeof model === 'string' && /opus/i.test(model);
// Checked when a manifest validates: a typo'd model is refused when the request is built, but Opus
// is refused up front so it never reaches a run without the explicit tier.
export function assertOpusTier(job) {
  if (isOpusModel(job.model) && job.tier !== 'expensive') fail(`anthropic-opus-needs-tier: ${job.model} only runs for a job that sets tier "expensive"`);
}
export function assertModelAllowed(job) {
  assertOpusTier(job);
  anthropicPrice(job.model);
}

export function readAnthropicKey(env = process.env, { platform = process.platform, exec = execFileSync } = {}) {
  const fromEnv = env[ANTHROPIC_KEY_ENV];
  if (typeof fromEnv === 'string' && fromEnv.length) return fromEnv;
  if (env.SWARM_ANTHROPIC_NO_KEYCHAIN === '1' || platform !== 'darwin') return null;
  try {
    const out = exec('/usr/bin/security', ['find-generic-password', '-s', ANTHROPIC_KEY_ITEM.service, '-a', ANTHROPIC_KEY_ITEM.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const key = String(out).trim();
    return key.length ? key : null;
  } catch { return null; }
}

// Machine-wide: always the user's home, never a project directory.
export function ledgerPath(env = process.env, home = os.homedir()) {
  return path.join(env.SWARM_LOGS_DIR || path.join(home, '.project-swarm', 'logs'), 'anthropic-spend.jsonl');
}
export function readLedger(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap(line => { try { const row = JSON.parse(line); return Number.isFinite(row.costUsd) ? [row] : []; } catch { return []; } });
}
export function spentSoFar(rows, { jobId, day }) {
  let job = 0, today = 0, total = 0;
  for (const row of rows) {
    total += row.costUsd;
    if (String(row.ts ?? '').slice(0, 10) === day) today += row.costUsd;
    if (row.jobId === jobId) job += row.costUsd;
  }
  return { job, today, total };
}
export function appendLedger(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

// Worst case for one request: every input character counted as a token, plus the full output budget.
export function worstCaseUsd(model, { inputChars, maxTokens }) {
  const price = anthropicPrice(model);
  const long = price.longAt && inputChars > price.longAt;
  return inputChars * (long ? price.longInput : price.input) + maxTokens * (long ? price.longOutput : price.output);
}
export function usageCostUsd(model, usage = {}) {
  const price = anthropicPrice(model);
  const fresh = Number(usage.input_tokens) || 0, write = Number(usage.cache_creation_input_tokens) || 0, read = Number(usage.cache_read_input_tokens) || 0, out = Number(usage.output_tokens) || 0;
  const promptTokens = fresh + write + read;
  const long = price.longAt && promptTokens > price.longAt;
  const input = long ? price.longInput : price.input, output = long ? price.longOutput : price.output;
  return fresh * input + write * input * CACHE_WRITE + read * input * CACHE_READ + out * output;
}

// The caps come from code, not from a manifest. The machine config may only lower the day cap
// (`spend.lanes.anthropic.dailyUsd`); the $500 total is code only.
export function caps(env = process.env) {
  const lanes = loadLocalConfig({ env })?.spend?.lanes?.anthropic ?? {};
  const lower = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, fallback) : fallback);
  return { totalUsd: TOTAL_CAP_USD, dayUsd: lower(lanes.dailyUsd, DAY_CAP_USD), jobUsd: JOB_CAP_USD };
}
export function assertWithinCaps({ worstUsd, spent, limits = caps() }) {
  if (spent.job + worstUsd > limits.jobUsd) fail(`Anthropic job cap: $${spent.job.toFixed(4)} spent + $${worstUsd.toFixed(4)} worst case > $${limits.jobUsd}; request refused`);
  if (spent.today + worstUsd > limits.dayUsd) fail(`Anthropic day cap: $${spent.today.toFixed(4)} spent today + $${worstUsd.toFixed(4)} worst case > $${limits.dayUsd}; request refused (ask the operator before raising it)`);
  if (spent.total + worstUsd > limits.totalUsd) fail(`Anthropic total cap: $${spent.total.toFixed(4)} spent + $${worstUsd.toFixed(4)} worst case > $${limits.totalUsd}; request refused (ask the operator before raising it)`);
}

export { AnthropicError };

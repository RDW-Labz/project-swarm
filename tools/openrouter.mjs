// SPDX-License-Identifier: Apache-2.0
// OpenRouter as a tool-free API worker pool. Every rule the owner set lives here, enforced in
// code before any request leaves the machine:
// - every request carries provider.data_collection = "deny"; a body without it is refused;
// - anthropic/* models are pinned to the Anthropic provider, with no fallback;
// - deepseek/* models may only write bookkeeping files (PR payloads, changelogs, mutants files,
//   metrics), never code;
// - spend caps: $5 per job and $25 per UTC day, checked against a worst-case estimate before
//   each request and recorded from the provider's reported cost after it.
// The key is read by the swarm parent only (env OPENROUTER_API_KEY, else the macOS keychain item
// named by config `keychain.service`, default "project-swarm", account "openrouter.api_key"),
// never passed to a worker.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocalConfig } from './local-config.mjs';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
// A public repo names no product keychain service: the default is generic, and a project's own
// service name arrives via config `keychain.service` (loadLocalConfig).
export const DEFAULT_KEYCHAIN_SERVICE = 'project-swarm';
export function openRouterKeyItem(config = {}) {
  const service = typeof config?.keychain?.service === 'string' && config.keychain.service ? config.keychain.service : DEFAULT_KEYCHAIN_SERVICE;
  return { service, account: 'openrouter.api_key' };
}
export const OPENROUTER_KEY_ITEM = Object.freeze(openRouterKeyItem());
export const JOB_CAP_USD = 5;
export const DAY_CAP_USD = 25;
// Bookkeeping outputs a deepseek/* model may write. Anything else (all code, tests, configs)
// refuses. An allowlist, not a denylist: a new sensitive path can never slip through.
export const BOOKKEEPING_OUTPUTS = Object.freeze([
  /(^|\/)[^/]*-pr-create\.json$/,
  /(^|\/)\.?pr-body\.md$/,
  /(^|\/)CHANGELOG\.md$/,
  /(^|\/)[^/]*mutants[^/]*\.json$/,
  /(^|\/)[^/]*-metrics\.md$/,
  /(^|\/)[^/]*metrics[^/]*\.jsonl?$/,
  // Field lesson #230: manifests (mutants files, PR payloads, etc.) live here; a contract or any
  // other design-content .md still does not match this and goes to a cheap Claude tier instead.
  /(^|\/)\.swarm-manifests\/[^/]*\.md$/,
]);

class OpenRouterError extends Error {}
const fail = message => { throw new OpenRouterError(message); };

export const isAnthropicModel = model => typeof model === 'string' && model.startsWith('anthropic/');
export const isBookkeepingOnlyModel = model => typeof model === 'string' && model.startsWith('deepseek/');

// Field lesson #285: outputSchema already forces files/edits to be empty when outputs: [] — every
// character of real content such a job can ever return rides in one summary string, capped at its
// own output-token limit. A prompt plainly asking for substantial written output has nowhere else
// for it to go, so it refuses before any request is ever sent (never spends against the caps).
const CONTENT_REQUEST_RE = /\b(write|draft|list|summarize|summarise|report|document|describe|compile|produce)\b/i;
export function emptyOutputsContentRefusal(job) {
  if ((job.outputs?.length ?? 0) > 0) return;
  if (!CONTENT_REQUEST_RE.test(job.prompt ?? '')) return;
  fail(`openrouter-empty-outputs-content: Job ${job.id} has outputs: [] but its prompt asks for real content; a job with no declared output file can only ever return a short summary string capped at its own output-token limit — declare an output file for the content instead`);
}

// The provider block every request carries. require_parameters keeps OpenRouter from routing to
// a provider that would silently drop response_format.
export function providerPolicy(model) {
  return isAnthropicModel(model)
    ? { data_collection: 'deny', require_parameters: true, order: ['anthropic'], allow_fallbacks: false }
    : { data_collection: 'deny', require_parameters: true };
}

// The last check before a body is sent. Refuses anything that does not carry the owner's rules.
export function assertRequestBody(body) {
  if (!body || typeof body !== 'object') fail('OpenRouter request refused: no body');
  const provider = body.provider;
  if (!provider || provider.data_collection !== 'deny') fail('OpenRouter request refused: provider.data_collection must be "deny"');
  if (isAnthropicModel(body.model) && (!Array.isArray(provider.order) || provider.order.length !== 1 || provider.order[0] !== 'anthropic' || provider.allow_fallbacks !== false)) {
    fail('OpenRouter request refused: anthropic/* models must pin provider.order ["anthropic"] with allow_fallbacks false');
  }
  return body;
}

// A deepseek/* job may only write bookkeeping files. Returns the offending outputs (empty = ok).
export function nonBookkeepingOutputs(model, outputs) {
  if (!isBookkeepingOnlyModel(model)) return [];
  return (outputs ?? []).filter(file => !BOOKKEEPING_OUTPUTS.some(pattern => pattern.test(String(file).replaceAll('\\', '/'))));
}
export function assertBookkeepingOnly(job) {
  const bad = nonBookkeepingOutputs(job.model, job.outputs);
  if (bad.length) fail(`Job ${job.id}: ${job.model} is for bookkeeping jobs only (PR payloads, changelogs, mutants files, metrics, .swarm-manifests/*.md); a contract or other .md with design content goes to a cheap Claude tier instead; refused outputs: ${bad.join(', ')}`);
}

// The key: env first (tests, CI), else the keychain on macOS. Never logged, never returned
// in any result.
export function readOpenRouterKey(env = process.env, { platform = process.platform, exec = execFileSync, config } = {}) {
  const fromEnv = env[OPENROUTER_KEY_ENV];
  if (typeof fromEnv === 'string' && fromEnv.length) return fromEnv;
  if (env.SWARM_OPENROUTER_NO_KEYCHAIN === '1' || platform !== 'darwin') return null;
  const item = openRouterKeyItem(config ?? loadLocalConfig({ env }));
  try {
    const out = exec('/usr/bin/security', ['find-generic-password', '-s', item.service, '-a', item.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const key = String(out).trim();
    return key.length ? key : null;
  } catch { return null; }
}

// Spend ledger: one JSON line per request, append-only, in the swarm logs dir.
export function ledgerPath(env = process.env, home = os.homedir()) {
  return path.join(env.SWARM_LOGS_DIR || path.join(home, '.project-swarm', 'logs'), 'openrouter-spend.jsonl');
}
export function readLedger(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap(line => { try { const row = JSON.parse(line); return Number.isFinite(row.costUsd) ? [row] : []; } catch { return []; } });
}
export function spentSoFar(rows, { jobId, day }) {
  let job = 0, today = 0;
  for (const row of rows) {
    if (String(row.ts ?? '').slice(0, 10) === day) today += row.costUsd;
    if (row.jobId === jobId) job += row.costUsd;
  }
  return { job, today };
}
export function appendLedger(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

// Per-token prices for one model, from OpenRouter's public model list (no key sent).
export async function fetchPricing(model, { fetchImpl = fetch, signal } = {}) {
  let response;
  try { response = await fetchImpl(OPENROUTER_MODELS_URL, { method: 'GET', redirect: 'error', signal }); }
  catch { fail('OpenRouter pricing unavailable; the spend cap cannot be checked, so the request is refused'); }
  if (!response.ok) fail(`OpenRouter pricing HTTP ${response.status}; the spend cap cannot be checked, so the request is refused`);
  let body; try { body = await response.json(); } catch { fail('OpenRouter pricing malformed; request refused'); }
  const entry = Array.isArray(body?.data) ? body.data.find(item => item?.id === model) : null;
  if (!entry) fail(`OpenRouter model not found: ${model}`);
  const prompt = Number(entry.pricing?.prompt), completion = Number(entry.pricing?.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) fail(`OpenRouter pricing missing for ${model}; request refused`);
  return { prompt, completion };
}

// Worst case for one request: every input character counted as a token (tokens are always
// fewer), plus the full output budget.
export function worstCaseUsd(pricing, { inputChars, maxTokens }) {
  return inputChars * pricing.prompt + maxTokens * pricing.completion;
}

export function assertWithinCaps({ worstUsd, spent }) {
  if (spent.job + worstUsd > JOB_CAP_USD) fail(`OpenRouter job cap: $${spent.job.toFixed(4)} spent + $${worstUsd.toFixed(4)} worst case > $${JOB_CAP_USD}; request refused`);
  if (spent.today + worstUsd > DAY_CAP_USD) fail(`OpenRouter day cap: $${spent.today.toFixed(4)} spent today + $${worstUsd.toFixed(4)} worst case > $${DAY_CAP_USD}; request refused`);
}

// Row #185: a tool-free worker is never left with a generic "incomplete, refused, truncated, or
// unexpected" — the finish reason the provider actually gave rides along in the error, so a
// truncated (maxOutputTokens too small) reply reads e.g. "truncated: finish_reason length"
// instead of leaving the cause to guesswork. Null means the response is complete.
export function describeIncompleteChatResponse(body) {
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  if (choices.length !== 1) return `OpenRouter response incomplete: expected exactly one choice, got ${choices.length}`;
  const choice = choices[0];
  const reason = choice?.finish_reason ?? 'missing';
  if (typeof choice?.message?.content !== 'string') return `OpenRouter response unexpected: finish_reason ${reason} carried no message content`;
  if (choice.message?.tool_calls?.length) return `OpenRouter response unexpected: finish_reason ${reason} carried unrequested tool_calls`;
  if (choice.message?.refusal) return `OpenRouter response refused: finish_reason ${reason}`;
  if (reason !== 'stop') return `OpenRouter response truncated: finish_reason ${reason}`;
  return null;
}
export function assertCompleteChatResponse(body) {
  const problem = describeIncompleteChatResponse(body);
  if (problem) fail(problem);
  return body;
}

// Field lesson #226: a reasoning model's output budget covers its thinking plus its reply, so the
// default for a DeepSeek reasoning model is double the generic default; any explicit
// job.maxOutputTokens still wins outright.
export function defaultMaxOutputTokens(model) {
  return typeof model === 'string' && model.startsWith('deepseek/') ? 16000 : 8192;
}

// Field lesson #226: `finish_reason: "length"` with no reply text at all (not merely truncated
// text) is the one case worth one automatic retry at double the limit — anything with at least
// some content is left as a plain truncation error, never silently retried into a second spend.
export function isEmptyLengthTruncation(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  return choice?.finish_reason === 'length' && (typeof choice.message?.content !== 'string' || choice.message.content.trim() === '');
}

export { OpenRouterError };

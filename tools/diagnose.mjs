// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyJobType, JOB_TYPES } from './job-types.mjs';
import { diagnoseSummaryFromJob } from './ticket-manifest.mjs';
import { PROMPT_PATH_RE, CONTEXT_TOTAL_CAP } from './swarm/patterns.mjs';

export const DIAGNOSE_MAX_USD = 1;
export const DIAGNOSE_OUTPUT_MAX_LINES = 20;
export const DIAGNOSE_OUTPUT_MAX_LINE_CHARS = 160;
export const DIAGNOSE_LOG = '.swarm/diagnose/log.ndjson';

export const DIAGNOSE_USAGE = [
  'Usage: swarm diagnose "question" [--files a,b] [--lane hermes|cursor] [--json]',
  '       swarm diagnose --help',
  '',
  'Runs one read-only diagnose job (Hermes, then Cursor on auto). Context is --files plus paths',
  'named in the question that exist in the repo (capped). Prints only the summary: up to 20 lines,',
  '160 characters each. On failure, one line names the reason and lane. Logs to .swarm/diagnose/log.ndjson.',
  `Small run spend cap ($${DIAGNOSE_MAX_USD}).`,
].join('\n') + '\n';

export function trimDiagnoseLine(line) {
  const s = String(line ?? '').trim();
  return s.length <= DIAGNOSE_OUTPUT_MAX_LINE_CHARS ? s : s.slice(0, DIAGNOSE_OUTPUT_MAX_LINE_CHARS);
}

/** Pure formatter: at most 20 non-empty lines, each trimmed to 160 characters. */
export function formatDiagnoseSummaryLines(summary) {
  const lines = String(summary ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.slice(0, DIAGNOSE_OUTPUT_MAX_LINES).map(trimDiagnoseLine);
}

export function pathsFromQuestion(text) {
  const out = new Set();
  const promptText = String(text ?? '')
    .replace(/<<<[\s\S]*?>>>/g, ' ')
    .replace(/(\b[\w./-]+\.\w+):\d+\b/g, '$1');
  for (const match of promptText.matchAll(PROMPT_PATH_RE)) {
    const raw = match[1].replace(/^\.\//, '').replace(/\/$/, '').replace(/:(?:\d+)$/, '');
    if ((raw.includes('/') || raw.includes('.')) && !raw.includes('***')) out.add(raw);
  }
  return [...out];
}

export function capDiagnoseContext(files, sizeOf, cap = CONTEXT_TOTAL_CAP) {
  const kept = [];
  let total = 0;
  for (const file of files) {
    const bytes = Math.max(0, Number(sizeOf(file)) || 0);
    if (bytes > cap) continue;
    if (kept.length && total + bytes > cap) break;
    kept.push(file);
    total += bytes;
  }
  return kept;
}

export function selectDiagnoseContextFiles({ explicit = [], question = '', exists = () => false, tracked = null, lane = null, sizeOf = () => 0 }) {
  const merged = [...new Set([...explicit, ...pathsFromQuestion(question)])];
  const existing = merged.filter(file => exists(file));
  const trackedSet = tracked === null ? null : new Set(tracked);
  const filtered = lane === 'cursor' && trackedSet
    ? existing.filter(file => trackedSet.has(file))
    : existing;
  return capDiagnoseContext(filtered, sizeOf);
}

export function buildDiagnoseManifest({ question, files = [], lane, id = 'diagnose' }) {
  if (typeof question !== 'string' || !question.trim()) {
    throw Object.assign(new Error('diagnose requires a non-empty question'), { code: 'diagnose-args' });
  }
  const agent = lane === 'hermes' || lane === 'cursor' ? lane : 'auto';
  const job = {
    id,
    type: 'diagnose',
    agent,
    prompt: question.trim(),
    context: [...files],
    outputs: [],
    sensitive: false,
  };
  const { job: typed } = applyJobType(job);
  return {
    version: 1,
    concurrency: 1,
    budget: { maxUsd: DIAGNOSE_MAX_USD },
    jobs: [typed],
  };
}

export function parseDiagnoseArgs(argv, { fail = message => { throw Object.assign(new Error(message), { code: 'diagnose-args' }); } } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let filesArg;
  let lane;
  let json = false;
  let overCap = false;
  let reason;
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--files') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail('--files requires a comma-separated list');
      filesArg = value;
      continue;
    }
    if (flag === '--lane') {
      lane = argv[++index];
      if (!lane || lane.startsWith('--')) fail('--lane requires hermes or cursor');
      if (!['hermes', 'cursor'].includes(lane)) fail('--lane must be hermes or cursor');
      continue;
    }
    if (flag === '--json') { json = true; continue; }
    if (flag === '--over-cap') { overCap = true; continue; }
    if (flag === '--reason') {
      reason = argv[++index];
      if (!reason) fail('--reason requires a value');
      continue;
    }
    if (flag.startsWith('--')) fail('Invalid arguments; use --help');
    positionals.push(flag);
  }
  if (positionals.length !== 1) fail('diagnose requires exactly one question argument; use --help');
  const explicit = filesArg ? filesArg.split(',').map(part => part.trim()) : [];
  if (explicit.some(part => !part)) fail('comma lists cannot contain empty members');
  if (overCap && !reason) fail('--over-cap requires --reason');
  return { question: positionals[0], explicit, lane: lane ?? null, json, overCap, reason };
}

export function diagnoseFailureLine(job) {
  const lane = job?.agent ?? 'unknown';
  const why = String(job?.error ?? job?.status ?? 'failed').replace(/\s+/g, ' ').trim();
  const line = `${why}; lane ${lane} failed`;
  return line.length <= DIAGNOSE_OUTPUT_MAX_LINE_CHARS ? line : line.slice(0, DIAGNOSE_OUTPUT_MAX_LINE_CHARS);
}

export async function appendDiagnoseLog(root, entry, { appendFile = fs.appendFile, mkdir = fs.mkdir } = {}) {
  const file = path.join(root, DIAGNOSE_LOG);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

async function fileSize(root, file) {
  try {
    const stat = await fs.stat(path.join(root, file));
    return stat.isFile() ? stat.size : 0;
  } catch { return 0; }
}

export async function diagnoseRun(root, options, runOptions = {}) {
  const {
    runManifest,
    writeJson,
    trackedFiles: trackedFilesFn,
    exists = file => fs.access(path.join(root, file)).then(() => true).catch(() => false),
    runWithIdRetry,
    now = () => new Date().toISOString(),
  } = runOptions;
  if (!runManifest || !writeJson || !runWithIdRetry) {
    throw Object.assign(new Error('diagnoseRun requires runManifest, writeJson, and runWithIdRetry'), { code: 'diagnose-internal' });
  }
  const { question, explicit, lane } = options;
  const tracked = trackedFilesFn ? await trackedFilesFn(root) : null;
  const sizes = new Map();
  for (const file of [...new Set([...explicit, ...pathsFromQuestion(question)])]) {
    if (await exists(file)) sizes.set(file, await fileSize(root, file));
  }
  const context = selectDiagnoseContextFiles({
    explicit,
    question,
    exists: file => sizes.has(file),
    tracked,
    lane,
    sizeOf: file => sizes.get(file) ?? 0,
  });

  const { id, state } = await runWithIdRetry('diagnose', runOptions, async runId => {
    const manifest = buildDiagnoseManifest({ question, files: context, lane, id: runId });
    await writeJson(root, `.swarm/diagnose/runs/${runId}/manifest.json`, manifest);
    const runState = await runManifest(root, manifest, { ...runOptions, id: runId, maxUsd: DIAGNOSE_MAX_USD });
    return { state: runState };
  });

  const record = state.jobs?.[0] ?? { id, status: state.status, agent: lane ?? 'auto' };
  const summary = diagnoseSummaryFromJob(record);
  const ok = record.status === 'complete' && Boolean(summary);
  const lines = ok ? formatDiagnoseSummaryLines(summary) : [];
  const failureLine = ok ? null : diagnoseFailureLine(record);

  await appendDiagnoseLog(root, {
    at: now(),
    question,
    runId: id,
    status: ok ? 'complete' : record.status ?? 'failed',
    summary: ok ? lines.join('\n') : failureLine,
    context,
  }, runOptions);

  return {
    ok,
    id,
    runId: id,
    status: state.status,
    jobStatus: record.status,
    agent: record.agent ?? null,
    contextFiles: context,
    summary: ok ? summary : null,
    lines,
    failureLine,
    costUsd: typeof record.costUsd === 'number' ? record.costUsd : null,
  };
}

// SPDX-License-Identifier: Apache-2.0
import { formatDuration } from './monitor-view.mjs';
import { sanitizeWorkerText, UNTRUSTED_LABEL } from './worker-text.mjs';
export { sanitizeWorkerText, UNTRUSTED_LABEL } from './worker-text.mjs';

export const REPORT_KEYS = Object.freeze(['status', 'summary', 'files', 'risks', 'followups']);
export const REPORT_STATUSES = Object.freeze(['complete', 'blocked', 'failed']);
export const SUMMARY_MAX = 500, ITEM_MAX = 200, LIST_MAX = 10;
export const REPORT_PROMPT_LINE = 'Finish with exactly one JSON line and nothing after it: {"status":"complete|blocked|failed","summary":"at most 500 characters","files":["changed declared outputs"],"risks":["short risk"],"followups":["short follow-up"]}. Use exactly these five keys. This replaces any other final-line format above.';
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const cut = (value, max) => value.length > max ? value.slice(0, max - 3) + '...' : value;

export function validateReport(value, { outputs = [] } = {}) {
  const errors = [];
  const add = message => { if (errors.length < 5) errors.push(message); };
  if (!plain(value)) return { report: null, errors: ['report is not an object'] };
  for (const key of REPORT_KEYS) if (!Object.hasOwn(value, key)) add(`missing key ${key}`);
  for (const key of Object.keys(value)) if (!REPORT_KEYS.includes(key)) add(`unexpected key ${key}`);
  if (!REPORT_STATUSES.includes(value.status)) add('status must be complete, blocked or failed');
  if (!nonblank(value.summary) || value.summary.length > SUMMARY_MAX) add('summary must be a non-blank string of at most 500 characters');
  if (!Array.isArray(value.files) || Array.from(value.files).some(file => typeof file !== 'string')) add('files must be an array of declared outputs');
  else {
    const seen = new Set();
    for (const file of value.files) {
      if (!outputs.includes(file)) add(`file not in outputs: ${file}`);
      if (seen.has(file)) add(`duplicate file: ${file}`);
      seen.add(file);
    }
  }
  for (const key of ['risks', 'followups']) {
    if (!Array.isArray(value[key]) || value[key].length > LIST_MAX || Array.from(value[key]).some(item => !nonblank(item) || item.length > ITEM_MAX)) add(`${key} must be at most 10 non-blank strings of at most 200 characters`);
  }
  if (errors.length) return { report: null, errors };
  return { report: Object.freeze({ status: value.status, summary: value.summary.trim(), files: Object.freeze([...value.files]), risks: Object.freeze([...value.risks]), followups: Object.freeze([...value.followups]) }), errors };
}

export function legacyReport({ status, error, result, outputs = [] }) {
  const notes = Array.isArray(result?.notes) ? result.notes.filter(nonblank).join('; ') : result?.notes;
  const summary = [result?.summary, notes, error, status].find(nonblank) ?? 'failed';
  const files = Array.isArray(result?.files_changed) ? result.files_changed : Array.isArray(result?.filesChanged) ? result.filesChanged : [];
  return { status: status === 'complete' ? 'complete' : status === 'blocked' ? 'blocked' : 'failed', summary: cut(summary.trim(), SUMMARY_MAX), files: [...new Set(files.filter(file => outputs.includes(file)))], risks: [], followups: [], legacy: true };
}

export function rollupRun(state, { top = 10 } = {}) {
  const jobs = state.jobs ?? [];
  const counts = Object.fromEntries(['complete', 'failed', 'blocked', 'timeout', 'cancelled', 'skipped', 'queued', 'running'].map(key => [key, 0]));
  const lanes = {}, spend = { costUsd: 0, costReportedJobs: 0, tokens: 0, estimatedJobs: [] }, files = new Set();
  const reports = { short: 0, legacy: 0, invalid: 0, missing: 0 };
  let fileJobs = 0;
  const attention = [], risks = new Map(), followups = new Map();
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  for (const job of jobs) {
    if (Object.hasOwn(counts, job.status)) counts[job.status]++;
    if (job.agent) lanes[job.agent] = (lanes[job.agent] ?? 0) + 1;
    if (typeof job.costUsd === 'number' && Number.isFinite(job.costUsd)) { spend.costUsd += job.costUsd; spend.costReportedJobs++; }
    if (['estimated-from-tokens', 'reservation'].includes(job.costSource)) spend.estimatedJobs.push(job.id);
    spend.tokens += number(job.usage?.total_tokens ?? (number(job.usage?.input_tokens) + number(job.usage?.output_tokens)));
    if (job.report?.files?.length) { fileJobs++; for (const file of job.report.files) files.add(file); }
    if (job.report) reports[job.report.legacy ? 'legacy' : 'short']++;
    else reports.missing++;
    if (job.reportErrors?.length) reports.invalid++;
    if (job.status !== 'complete' || job.reportErrors?.length) {
      const summary = sanitizeWorkerText([job.report?.summary, job.error, job.status].find(nonblank) ?? '', 160);
      if (summary) attention.push({ id: job.id, status: job.status, agent: job.agent, summary });
    }
    for (const [key, map] of [['risks', risks], ['followups', followups]]) {
      for (const item of job.report?.[key] ?? []) {
        const text = sanitizeWorkerText(item, 200);
        if (text) map.set(text, (map.get(text) ?? 0) + 1);
      }
    }
  }
  spend.costUsd = Math.round(spend.costUsd * 100) / 100;
  spend.estimatedCount = spend.estimatedJobs.length;
  spend.estimatedJobs = spend.estimatedJobs.slice(0, 10);
  const priority = status => ['failed', 'timeout'].includes(status) ? 0 : status === 'blocked' ? 1 : 2;
  attention.sort((a, b) => priority(a.status) - priority(b.status));
  const entries = map => [...map].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 5);
  const starts = jobs.map(job => job.startedAt).filter(Boolean).map(Date.parse).filter(Number.isFinite);
  const created = state.createdAt ? Date.parse(state.createdAt) : NaN;
  const start = Number.isFinite(created) ? created : starts.length ? Math.min(...starts) : null;
  const end = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
  const shown = attention.slice(0, Math.max(0, Math.min(50, Number.isInteger(top) ? top : 10)));
  const rollup = { id: state.id, status: state.status, total: jobs.length, counts, lanes, spend, files: { changed: files.size, jobs: fileJobs }, reports, attention: shown, attentionMore: attention.length - shown.length, risks: entries(risks), followups: entries(followups), elapsedMs: start !== null && Number.isFinite(end) ? Math.max(0, end - start) : null };
  // Bound the compact view by showing fewer attention entries when summaries fill the budget.
  const queue = state.mergeQueue, summary = queue?.summary ?? queue;
  rollup.mergeQueue = queue ? { state: queue.state, integrated: summary.integrated?.length ?? 0, requeued: summary.requeued?.length ?? 0, flagged: summary.flagged?.length ?? 0, checkFailed: summary.checkFailed?.length ?? 0 } : null;
  rollup.untrusted = ['attention.summary', 'risks', 'followups'];
  while (Buffer.byteLength(JSON.stringify(rollup)) >= 4096 && shown.length) { shown.pop(); rollup.attentionMore++; }
  while (Buffer.byteLength(JSON.stringify(rollup)) >= 4096 && (rollup.risks.length || rollup.followups.length)) (rollup.followups.length >= rollup.risks.length ? rollup.followups : rollup.risks).pop();
  return rollup;
}

export function renderRollupText(rollup) {
  const r = rollup;
  const lines = [`Run ${sanitizeWorkerText(r.id)} - ${sanitizeWorkerText(r.status)} - ${r.total} jobs - elapsed ${formatDuration(r.elapsedMs)}`, Object.entries(r.counts).map(([key, count]) => `${sanitizeWorkerText(key)} ${count}`).join(' - '), `lanes  ${Object.entries(r.lanes).map(([agent, count]) => `${sanitizeWorkerText(agent)} ${count}`).join(' - ')}`, `spend  $${r.spend.costUsd.toFixed(2)} (${r.spend.costReportedJobs} jobs reported cost) - tokens ${r.spend.tokens}${r.spend.estimatedCount ? ` - estimated cost for ${r.spend.estimatedCount} jobs` : ''}`, `files  ${r.files.changed} changed across ${r.files.jobs} jobs`, `reports  ${r.reports.short} short - ${r.reports.legacy} legacy - ${r.reports.invalid} invalid - ${r.reports.missing} missing`];
  const attention = r.attention.slice(0, 15), more = r.attentionMore + r.attention.length - attention.length;
  if (r.mergeQueue) lines.push(`merge  ${sanitizeWorkerText(r.mergeQueue.state)} - ${r.mergeQueue.integrated} integrated - ${r.mergeQueue.requeued} requeued - ${r.mergeQueue.flagged} flagged - ${r.mergeQueue.checkFailed} checks failed`);
  if (attention.length || more || r.risks.length || r.followups.length) lines.push(UNTRUSTED_LABEL);
  if (attention.length || more) {
    lines.push(`attention (${attention.length} of ${r.attention.length + r.attentionMore}):`);
    for (const job of attention) lines.push(`  ${sanitizeWorkerText(job.status)} ${sanitizeWorkerText(job.id)} (${sanitizeWorkerText(job.agent)}): ${sanitizeWorkerText(job.summary, 160)}`);
    if (more) lines.push(`  +${more} more: swarm inspect ${sanitizeWorkerText(r.id)}`);
  }
  for (const key of ['risks', 'followups']) if (r[key].length) {
    lines.push(`${key}:`);
    for (const item of r[key]) lines.push(`  ${sanitizeWorkerText(item.count)}x ${sanitizeWorkerText(item.text, 200)}`);
  }
  return lines.join('\n');
}

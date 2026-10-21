// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRunStates, laneLabel } from './board-data.mjs';
import { readLedger, logPath, wavesOf } from './tickets.mjs';
import { listRequests, LOG_FILE } from './handbuild.mjs';
import { jobSpend } from './spend.mjs';
import { scanSecretsDetailed, shannonEntropy } from './security-scan.mjs';

export const VERSION = 1;
export const FAILURE_CAUSES = Object.freeze([
  'planning-error', 'collision', 'check-failure', 'review-reject', 'integration-failure', 'timeout', 'provider-limit', 'other',
]);

const EMAIL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,255}\.\p{L}{2,24}/u;
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{8,24}\d(?![\w.])/;
const ABS_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|private|opt)\/|~\/)/;
const LONG_TOKEN = /\b[A-Za-z0-9+/=_-]{32,}\b/g;
const IDISH = /\b(?=[A-Za-z0-9_-]{0,80}[A-Za-z])(?=[A-Za-z0-9_-]{0,80}\d)[A-Za-z0-9_-]{20,80}\b/;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const duration = (start, end) => {
  const a = Date.parse(start ?? '');
  const b = Date.parse(end ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
};

function looksLikeToken(text) {
  const s = String(text ?? '');
  if (s.length < 24) return false;
  if (IDISH.test(s)) return true;
  for (const m of s.matchAll(LONG_TOKEN)) {
    if (m[0].length >= 32 && shannonEntropy(m[0]) >= 3.8) return true;
  }
  return false;
}

function secretHit(text) {
  const content = String(text ?? '');
  if (!content) return null;
  if (EMAIL.test(content)) return 'email';
  if (PHONE.test(content)) return 'phone';
  if (looksLikeToken(content)) return 'token';
  const { findings } = scanSecretsDetailed([{ path: 'field-export', content }]);
  if (findings.length) return findings[0].rule;
  return null;
}

function sanitizeFreeText(value, dropped) {
  if (value === null || value === undefined) return null;
  let text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  text = text.slice(0, 300);
  const hit = secretHit(text);
  if (hit || ABS_PATH.test(text)) {
    dropped.count += 1;
    return null;
  }
  return text;
}

function classifyFailure({ status, error, code, blockReason }) {
  if (status === 'complete' || status === 'done') return null;
  if (status === 'timeout') return 'timeout';
  if (status === 'provider-limit') return 'provider-limit';
  const blob = `${code ?? ''} ${blockReason ?? ''} ${error ?? ''}`.toLowerCase();
  if (/collision|writer-collision|shared-output/.test(blob)) return 'collision';
  if (/failed checks|check-failure|flake|env-check/.test(blob)) return 'check-failure';
  if (/review|acceptance/.test(blob)) return 'review-reject';
  if (/integrat|merge/.test(blob)) return 'integration-failure';
  if (/plan|manifest|validate|route-exhausted|scope-/.test(blob)) return 'planning-error';
  if (status === 'failed' || status === 'blocked' || status === 'timeout') return 'other';
  return null;
}

async function readNdjson(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readWaveEvents(root) {
  const lines = await readNdjson(logPath(root));
  return lines.filter(e => e.event === 'wave' && Array.isArray(e.tickets));
}

async function readWaveSlots(root) {
  const dir = path.join(root, 'docs', 'scope', 'waves');
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter(n => /^wave-[a-z0-9]+\.json$/i.test(n)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const slots = [];
  for (const name of names) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      const c = manifest?.concurrency;
      slots.push(Number.isInteger(c) && c > 0 ? c : null);
    } catch {
      slots.push(null);
    }
  }
  return slots;
}

function jobByTicketId(runs) {
  const map = new Map();
  for (const { id: runId, state } of runs) {
    for (const job of state.jobs ?? []) {
      if (job && typeof job === 'object' && typeof job.id === 'string') map.set(job.id, { runId, job });
    }
  }
  return map;
}

function ticketWaveMap(waveEvents) {
  const map = new Map();
  waveEvents.forEach((ev, index) => {
    for (const id of ev.tickets) map.set(id, index + 1);
  });
  return map;
}

function buildWaves(waveEvents, slotList) {
  return waveEvents.map((ev, index) => ({
    id: String(index + 1),
    tickets: [...ev.tickets].sort(),
    readyAtStart: Number.isInteger(ev.readyAtStart) ? ev.readyAtStart : ev.tickets.length,
    slots: slotList[index] ?? (Number.isInteger(ev.slots) ? ev.slots : null),
  }));
}

function buildTickets(ledger, runs, waveEvents, dropped) {
  const tickets = ledger?.tickets ?? [];
  const waveMap = ticketWaveMap(waveEvents);
  const depWaves = new Map();
  try {
    wavesOf(tickets).forEach((group, index) => { for (const id of group) depWaves.set(id, index + 1); });
  } catch { /* cycle: omit dep wave numbers */ }
  const jobs = jobByTicketId(runs);
  const out = [];
  for (const t of tickets) {
    if (!t || typeof t !== 'object') continue;
    const laneParsed = typeof t.lane === 'string' ? t.lane.split(':') : [];
    const agent = laneParsed[0] || null;
    const model = laneParsed.length > 1 ? laneParsed.slice(1).join(':') : null;
    const hit = jobs.get(t.id);
    const job = hit?.job;
    const retries = Number.isInteger(t.attempts) ? t.attempts : (Array.isArray(job?.attempts) ? Math.max(0, job.attempts.length - 1) : 0);
    const failureMsg = job?.error ?? (t.status === 'blocked' ? t.blockNote : null);
    out.push({
      id: typeof t.id === 'string' ? t.id : null,
      wave: waveMap.get(t.id) ?? depWaves.get(t.id) ?? null,
      lane: agent ? laneLabel(agent, model) : (job ? laneLabel(job.agent, job.model) : null),
      model: model ?? (typeof job?.model === 'string' ? job.model : null),
      status: typeof t.status === 'string' ? t.status : null,
      retries,
      retryNotes: sanitizeFreeText(t.retryNote, dropped),
      failureCause: classifyFailure({ status: t.status, error: failureMsg, code: job?.code, blockReason: t.blockReason }),
      startedAt: iso(job?.startedAt ?? t.waveAt),
      finishedAt: iso(job?.finishedAt),
      durationMs: num(job?.durationMs) ?? duration(job?.startedAt, job?.finishedAt),
    });
  }
  return out;
}

function buildJobs(runs, dropped) {
  const out = [];
  for (const { id: runId, state } of runs) {
    for (const record of state.jobs ?? []) {
      if (!record || typeof record !== 'object') continue;
      const failureMsg = record.error ?? record.setupError ?? null;
      out.push({
        runId,
        jobId: typeof record.id === 'string' ? record.id : null,
        lane: laneLabel(record.agent, record.model),
        model: typeof record.model === 'string' ? record.model : null,
        tier: typeof record.tier === 'string' ? record.tier : null,
        status: typeof record.status === 'string' ? record.status : null,
        costUsd: num(jobSpend(record).usd),
        costSource: typeof record.costSource === 'string' ? record.costSource : null,
        durationMs: num(record.durationMs) ?? duration(record.startedAt, record.finishedAt),
        retries: Array.isArray(record.attempts) ? Math.max(0, record.attempts.length - 1) : 0,
        failureCause: classifyFailure({ status: record.status, error: failureMsg, code: record.code }),
      });
      if (failureMsg) sanitizeFreeText(failureMsg, dropped);
    }
  }
  return out;
}

function buildGuard(blocks, requests) {
  return {
    blocks: blocks.map(b => ({
      at: iso(b.at),
      kind: typeof b.kind === 'string' ? b.kind : null,
      rule: typeof b.rule === 'string' ? b.rule : null,
    })),
    handbuildRequests: requests.map(r => ({
      id: typeof r.id === 'string' ? r.id : null,
      kind: typeof r.kind === 'string' ? r.kind : null,
      status: typeof r.status === 'string' ? r.status : null,
      decidedBy: typeof r.decidedBy === 'string' ? r.decidedBy : null,
      decidedAt: iso(r.decidedAt),
      reasonCategory: typeof r.kind === 'string' ? r.kind : null,
    })),
  };
}

function perLaneTotals(jobs) {
  const totals = Object.create(null);
  for (const job of jobs) {
    if (!job.lane) continue;
    const lane = totals[job.lane] ??= { jobs: 0, complete: 0, failed: 0, costUsd: 0 };
    lane.jobs += 1;
    if (job.status === 'complete') lane.complete += 1;
    if (['failed', 'timeout', 'provider-limit', 'cancelled'].includes(job.status)) lane.failed += 1;
    lane.costUsd += job.costUsd ?? 0;
  }
  for (const lane of Object.keys(totals)) totals[lane].costUsd = Math.round(totals[lane].costUsd * 1e6) / 1e6;
  return totals;
}

function jsonPathAt(text, index) {
  let depth = 0;
  const stack = ['export'];
  for (let i = 0; i < index && i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      depth += 1;
      stack.push(ch === '{' ? '{}' : '[]');
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      stack.pop();
    } else if (ch === '"' && text[i - 1] !== '\\') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) break;
      const key = text.slice(i + 1, end);
      i = end;
      if (text[i + 1] === ':') stack[stack.length - 1] = key;
    }
  }
  return stack.filter((x, i) => i === 0 || (x !== '{}' && x !== '[]')).join('.') || 'export';
}

function assertExportClean(exportObj) {
  const text = JSON.stringify(exportObj);
  if (ABS_PATH.test(text)) {
    const i = text.search(ABS_PATH);
    throw new Error(`field-export-secret-hit: absolute-path at ${jsonPathAt(text, i)}`);
  }
  const email = text.match(EMAIL);
  if (email) {
    const i = text.indexOf(email[0]);
    throw new Error(`field-export-secret-hit: email at ${jsonPathAt(text, i)}`);
  }
  const phone = text.match(PHONE);
  if (phone) {
    const i = text.indexOf(phone[0]);
    throw new Error(`field-export-secret-hit: phone at ${jsonPathAt(text, i)}`);
  }
  const { findings } = scanSecretsDetailed([{ path: 'field-export.json', content: text }]);
  if (findings.length) throw new Error(`field-export-secret-hit: ${findings[0].rule} at export`);
  for (const m of text.matchAll(LONG_TOKEN)) {
    if (m[0].length >= 32 && shannonEntropy(m[0]) >= 3.8) {
      throw new Error(`field-export-secret-hit: token at ${jsonPathAt(text, m.index)}`);
    }
  }
}

async function defaultReaders(root) {
  return {
    readLedger: () => readLedger(root),
    readRuns: () => readRunStates(root),
    readHandbuildLog: () => readNdjson(path.join(root, LOG_FILE)),
    readHandbuildRequests: () => Promise.resolve(listRequests(root)),
    readWaveEvents: () => readWaveEvents(root),
    readWaveSlots: () => readWaveSlots(root),
  };
}

export async function buildFieldExport({ root, machine, project, now = Date.now, readers } = {}) {
  if (!root || typeof root !== 'string') throw new Error('field-export: root is required');
  const projectId = typeof project === 'string' ? project : project?.id ?? project?.name ?? 'project';
  const machineId = typeof machine === 'string' ? machine : 'machine';
  const r = { ...await defaultReaders(root), ...readers };
  const dropped = { count: 0 };

  const [ledger, runs, handLog, handRequests, waveEvents, waveSlots] = await Promise.all([
    r.readLedger(root),
    r.readRuns(root),
    r.readHandbuildLog(root),
    r.readHandbuildRequests(root),
    r.readWaveEvents(root),
    r.readWaveSlots(root),
  ]);

  const blocks = (handLog ?? []).filter(e => e.event === 'blocked').map(e => ({
    at: e.at,
    kind: 'handbuild-block',
    rule: typeof e.tool === 'string' ? e.tool : 'guard',
  }));

  const extra = r.extraExport && typeof r.extraExport === 'object' ? r.extraExport : null;

  const jobs = buildJobs(runs ?? [], dropped);
  const exportObj = {
    version: VERSION,
    machine: machineId,
    project: projectId,
    generatedAt: new Date(now).toISOString(),
    tickets: buildTickets(ledger, runs ?? [], waveEvents ?? [], dropped),
    jobs,
    waves: buildWaves(waveEvents ?? [], waveSlots ?? []),
    guard: buildGuard(blocks, handRequests ?? []),
    totals: { perLane: perLaneTotals(jobs) },
    dropped: dropped.count,
    ...(extra ?? {}),
  };

  assertExportClean(exportObj);

  const clean = {
    version: exportObj.version,
    machine: exportObj.machine,
    project: exportObj.project,
    generatedAt: exportObj.generatedAt,
    tickets: exportObj.tickets,
    jobs: exportObj.jobs,
    waves: exportObj.waves,
    guard: exportObj.guard,
    totals: exportObj.totals,
    dropped: exportObj.dropped,
  };
  return clean;
}

export async function exportFieldFile({ root, machine, project, outFile, now = Date.now, readers } = {}) {
  const projectId = typeof project === 'string' ? project : project?.id ?? project?.name ?? 'project';
  const machineId = typeof machine === 'string' ? machine : 'machine';
  const safeProject = String(projectId).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  const safeMachine = String(machineId).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  const file = outFile ?? path.join(root, '.swarm', 'field', `${safeProject}-${safeMachine}.json`);
  const fieldDir = path.resolve(root, '.swarm', 'field');
  if (!path.resolve(file).startsWith(`${fieldDir}/`) && path.resolve(file) !== fieldDir) {
    throw new Error('field-export: outFile must be under .swarm/field');
  }
  const exportObj = await buildFieldExport({ root, machine: machineId, project: projectId, now, readers });
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const body = `${JSON.stringify(exportObj)}\n`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.close();
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
  return { file, bytes: Buffer.byteLength(body), dropped: exportObj.dropped };
}

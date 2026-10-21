// SPDX-License-Identifier: Apache-2.0

import { scanSecretsDetailed } from './security-scan.mjs';

const KINDS = new Set(['build', 'test', 'docs', 'migration']);
const REQUIRED = [
  'id',
  'title',
  'kind',
  'prompt',
  'files',
  'context',
  'testCommand',
  'acceptance',
  'scrubbedFrom',
  'sizeBytes',
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}\b/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

function isAbsolutePath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

function hasDotDotSegment(p) {
  if (typeof p !== 'string') return false;
  return p.split(/[/\\]/).some((seg) => seg === '..');
}

function pathError(field, p) {
  if (typeof p !== 'string' || !p.trim()) return `${field}: path must be a non-empty string`;
  if (isAbsolutePath(p)) return `${field}: absolute path not allowed`;
  if (hasDotDotSegment(p)) return `${field}: path must not contain .. segments`;
  return null;
}

export function validateCase(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['case must be an object'];
  }
  for (const key of REQUIRED) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
      if (key === 'sizeBytes' && obj[key] === 0) continue;
      if (key === 'scrubbedFrom' && obj[key] === '') errors.push(`${key}: required`);
      else if (obj[key] === undefined || obj[key] === null || obj[key] === '') errors.push(`${key}: required`);
    }
  }
  if (obj.kind != null && !KINDS.has(obj.kind)) {
    errors.push(`kind: must be one of ${[...KINDS].join(', ')}`);
  }
  if (!Array.isArray(obj.files)) {
    errors.push('files: must be an array');
  } else if (obj.files.length > 8) {
    errors.push('files: at most 8 paths allowed');
  } else {
    for (const p of obj.files) {
      const e = pathError('files', p);
      if (e) errors.push(e);
    }
  }
  if (!Array.isArray(obj.context)) {
    errors.push('context: must be an array');
  } else {
    for (const p of obj.context) {
      const e = pathError('context', p);
      if (e) errors.push(e);
    }
  }
  if (!Array.isArray(obj.testCommand)) {
    errors.push('testCommand: must be an argv array');
  } else if (obj.testCommand.some((x) => typeof x !== 'string')) {
    errors.push('testCommand: every element must be a string');
  } else {
    for (const arg of obj.testCommand) {
      if (isAbsolutePath(arg)) errors.push('testCommand: absolute path not allowed');
      if (hasDotDotSegment(arg)) errors.push('testCommand: path must not contain .. segments');
    }
  }
  if (!Array.isArray(obj.acceptance)) {
    errors.push('acceptance: must be an array');
  }
  if (obj.sizeBytes != null && typeof obj.sizeBytes !== 'number') {
    errors.push('sizeBytes: must be a number');
  }
  return errors;
}

function relPathOrDrop(abs, codeRoot) {
  if (!isAbsolutePath(abs)) return { value: abs, kind: null };
  const root = String(codeRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const norm = abs.replace(/\\/g, '/');
  if (root && (norm === root || norm.startsWith(`${root}/`))) {
    const rel = norm === root ? '.' : norm.slice(root.length + 1);
    return { value: rel, kind: 'absolute-path' };
  }
  return { value: '', kind: 'absolute-path' };
}

function scrubString(value, { codeRoot, field, dropped }) {
  let text = String(value ?? '');
  const record = (kind) => {
    dropped.push({ field, kind });
  };

  if (EMAIL_RE.test(text)) {
    text = text.replace(EMAIL_RE, '');
    record('email');
  }
  EMAIL_RE.lastIndex = 0;

  if (PHONE_RE.test(text)) {
    text = text.replace(PHONE_RE, '');
    record('phone');
  }
  PHONE_RE.lastIndex = 0;

  const secretFindings = scanSecretsDetailed([{ path: field, content: text }]).findings;
  if (secretFindings.length) {
    text = text.replace(LONG_TOKEN_RE, '');
    for (const f of secretFindings) record(f.rule === 'generic-secret' ? 'token' : 'secret');
  } else if (LONG_TOKEN_RE.test(text)) {
    text = text.replace(LONG_TOKEN_RE, '');
    record('token');
  }
  LONG_TOKEN_RE.lastIndex = 0;

  if (isAbsolutePath(text.trim())) {
    const { value, kind } = relPathOrDrop(text.trim(), codeRoot);
    text = value;
    if (kind) record(kind);
  } else {
    text = text.replace(/(?:[A-Za-z]:)?[/\\][^\s'"]+/g, (match) => {
      if (!isAbsolutePath(match)) return match;
      const { value, kind } = relPathOrDrop(match, codeRoot);
      if (kind) record(kind);
      return value || '';
    });
  }

  return text.trim();
}

function scrubValue(value, ctx) {
  if (typeof value === 'string') return scrubString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? scrubString(v, ctx) : v));
  return value;
}

export function scrubCase(raw, { codeRoot = '' } = {}) {
  const dropped = [];
  const ctx = (field) => ({ codeRoot, field, dropped });
  const caseOut = {};

  for (const key of REQUIRED) {
    if (raw?.[key] === undefined) continue;
    if (key === 'prompt') {
      let p = scrubString(String(raw.prompt), ctx('prompt'));
      if (p.length > 4000) p = p.slice(0, 4000);
      caseOut.prompt = p;
      continue;
    }
    if (key === 'files' || key === 'context') {
      caseOut[key] = (Array.isArray(raw[key]) ? raw[key] : []).map((p) => {
        const e = pathError(key, p);
        if (e) return scrubString(String(p), ctx(key));
        if (isAbsolutePath(p)) {
          const { value, kind } = relPathOrDrop(p, codeRoot);
          if (kind) dropped.push({ field: key, kind });
          return value;
        }
        return p;
      });
      continue;
    }
    if (key === 'testCommand') {
      caseOut.testCommand = scrubValue(raw.testCommand, ctx('testCommand'));
      continue;
    }
    if (key === 'acceptance') {
      caseOut.acceptance = scrubValue(raw.acceptance, ctx('acceptance'));
      continue;
    }
    if (typeof raw[key] === 'string') {
      caseOut[key] = scrubString(raw[key], ctx(key));
    } else {
      caseOut[key] = raw[key];
    }
  }

  const seen = new Set();
  const uniqueDropped = [];
  for (const d of dropped) {
    const k = `${d.field}|${d.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueDropped.push(d);
  }

  return { case: caseOut, dropped: uniqueDropped };
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p90(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.ceil(0.9 * s.length) - 1;
  return s[Math.max(0, idx)];
}

function aggregateMetrics(results, { parallel, startedAt, finishedAt, idleSlotMs }) {
  const n = results.length || 1;
  const passed = results.filter((r) => r.status === 'pass').length;
  const firstTry = results.filter((r) => r.status === 'pass' && (r.retries ?? 0) === 0).length;
  const durations = results.map((r) => r.durationMs ?? 0);
  const billed = results.reduce((s, r) => s + (r.billedUsd ?? 0), 0);
  const list = results.reduce((s, r) => s + (r.listUsd ?? 0), 0);
  const retries = results.reduce((s, r) => s + (r.retries ?? 0), 0);
  const flaky = results.filter((r) => r.flaky).length;
  const spanMs = Math.max(1, finishedAt - startedAt);
  const totalSlotMs = spanMs * parallel;
  const idle_slot_pct = totalSlotMs > 0 ? idleSlotMs / totalSlotMs : 0;

  return {
    pass_rate: passed / n,
    first_try_rate: firstTry / n,
    median_ms: median(durations),
    p90_ms: p90(durations),
    billed_usd_per_case: billed / n,
    list_usd_per_case: list / n,
    retries_per_case: retries / n,
    flaky_rate: flaky / n,
    throughput_per_min: (passed / spanMs) * 60_000,
    idle_slot_pct,
  };
}

export async function runReplay({
  cases = [],
  codeRoot = '',
  label = 'replay',
  parallel = 1,
  lanes,
  runner,
  now = () => Date.now(),
}) {
  const runRunner = runner ?? defaultRunner;
  const startedAt = now();
  if (!cases.length) {
    const finishedAt = startedAt;
    return {
      label,
      parallel,
      startedAt,
      finishedAt,
      results: [],
      metrics: aggregateMetrics([], { parallel, startedAt, finishedAt, idleSlotMs: 0 }),
    };
  }

  const queue = [...cases];
  const results = [];
  let inFlight = 0;
  let idleSlotMs = 0;
  let lastAt = startedAt;
  const sample = () => {
    const t = now();
    const dt = t - lastAt;
    if (dt > 0 && queue.length > 0) {
      idleSlotMs += Math.max(0, parallel - inFlight) * dt;
    }
    lastAt = t;
  };

  const runOne = async (caseObj, caseId) => {
    inFlight += 1;
    sample();
    let outcome;
    try {
      outcome = await runRunner(caseObj, { codeRoot, label, lanes });
    } catch (err) {
      outcome = {
        status: 'error',
        durationMs: 0,
        billedUsd: 0,
        listUsd: 0,
        retries: 0,
        tokens: 0,
        flaky: false,
      };
    }
    inFlight -= 1;
    sample();
    results.push({
      caseId,
      status: outcome.status ?? 'error',
      durationMs: outcome.durationMs ?? 0,
      billedUsd: outcome.billedUsd ?? 0,
      listUsd: outcome.listUsd ?? 0,
      retries: outcome.retries ?? 0,
      tokens: outcome.tokens ?? 0,
      flaky: !!outcome.flaky,
    });
  };

  const executing = new Set();
  let seq = 0;
  while (queue.length > 0 || executing.size > 0) {
    while (queue.length > 0 && executing.size < parallel) {
      const caseObj = queue.shift();
      const caseId = caseObj?.id ?? `case-${seq++}`;
      sample();
      const job = runOne(caseObj, caseId).finally(() => executing.delete(job));
      executing.add(job);
    }
    if (executing.size > 0) {
      await Promise.race(executing);
    }
  }

  const finishedAt = now();
  sample();

  return {
    label,
    parallel,
    startedAt,
    finishedAt,
    results,
    metrics: aggregateMetrics(results, { parallel, startedAt, finishedAt, idleSlotMs }),
  };
}

function defaultRunner() {
  throw new Error('bench replay runner not configured');
}

export async function runLoadSeries({
  cases,
  codeRoot,
  label,
  levels = [4, 8, 16],
  runner,
  now,
}) {
  const runs = [];
  for (const level of levels) {
    runs.push(
      await runReplay({
        cases,
        codeRoot,
        label,
        parallel: level,
        runner,
        now,
      }),
    );
  }
  const table = runs.map((r) => ({
    parallel: r.parallel,
    throughput_per_min: r.metrics.throughput_per_min,
    pass_rate: r.metrics.pass_rate,
    idle_slot_pct: r.metrics.idle_slot_pct,
    flaky_rate: r.metrics.flaky_rate,
  }));
  return { runs, table };
}

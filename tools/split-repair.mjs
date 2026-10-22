// SPDX-License-Identifier: Apache-2.0
// Pure split repair engine (no model, no fs, no swarm.mjs). Wired from scope-commands in T-8024.

import {
  chainSharedFiles,
  reconcileTicketContext,
  alignTestTicketsWithBuildStages,
  peelProtectedOutputs,
  stageRank,
  wiringGaps,
  unwiredRequirements,
  moduleTickets,
} from './wiring.mjs';

export const ROOT_RULES = Object.freeze([
  'Never put a file in a ticket\'s context or reads unless it exists in the repo now or is produced by a ticket in its dependsOn chain (the producer must be an ancestor).',
  'Two tickets in the same wave never write the same file: chain them with dependsOn or merge them.',
  'A test ticket is never in a later stage or wave than the code it tests: put tests in the build ticket\'s own outputs, or a test ticket that dependsOn it in the same stage.',
  'Protected files (coordination/checks.json, .project-swarm.json, .swarm/, .git/ and the project\'s protected paths) are never assigned to worker tickets: route them to an owner-window human ticket.',
  'Every requirement with build tickets gets exactly one integration ticket that mounts the modules in the real entry point (route, CLI command or page) with a route-level or end-to-end test.',
]);

function cloneTicket(t) {
  return {
    ...t,
    dependsOn: [...(t.dependsOn ?? [])],
    files: [...(t.files ?? [])],
    context: [...(t.context ?? [])],
    tests: [...(t.tests ?? [])],
    scopeRefs: [...(t.scopeRefs ?? [])],
    acceptance: [...(t.acceptance ?? [])],
  };
}

export function issueFingerprint(issue) {
  return [issue.code, issue.stage ?? '', issue.ticket ?? '', issue.path ?? '', issue.req ?? '', issue.reason ?? ''].join('|');
}

function issueFromPartial(partial, defaults = {}) {
  return {
    code: partial.code ?? defaults.code ?? 'other',
    stage: partial.stage ?? defaults.stage ?? null,
    ticket: partial.ticket ?? partial.id ?? defaults.ticket ?? null,
    title: partial.title ?? defaults.title ?? null,
    path: partial.path ?? null,
    req: partial.req ?? null,
    reason: partial.reason ?? partial.message ?? String(partial),
    fixable: partial.fixable ?? defaults.fixable ?? false,
  };
}

/** @param {object} sources refusal payloads from split ingest */
export function collectSplitIssues(sources = {}) {
  const issues = [];

  for (const msg of sources.readStageErrors ?? sources.errors ?? []) {
    if (typeof msg !== 'string') {
      issues.push(issueFromPartial({ code: 'stage-output', reason: String(msg) }));
      continue;
    }
    issues.push(issueFromPartial({ code: 'stage-output', reason: msg, fixable: false }));
  }

  for (const row of sources.rejected ?? []) {
    const reason = row.reason ?? '';
    let code = 'other';
    if (/context|does not exist|no earlier ticket/i.test(reason)) code = 'future-context';
    else if (/protected|owner commit/i.test(reason)) code = 'protected-file';
    else if (/test ticket|later stage|matching build/i.test(reason)) code = 'test-after-code';
    else if (/acceptance/i.test(reason)) code = 'acceptance';
    issues.push(issueFromPartial({
      code,
      ticket: row.id,
      title: row.title,
      reason,
      fixable: code === 'future-context' || code === 'test-after-code' || code === 'protected-file',
    }));
  }

  for (const msg of sources.acceptanceRefusals ?? []) {
    issues.push(issueFromPartial({ code: 'acceptance', reason: typeof msg === 'string' ? msg : String(msg), fixable: false }));
  }

  for (const gap of sources.wiringGaps ?? wiringGaps(sources.tickets ?? [], sources.touchedReqs)) {
    const reason = gap.reason ?? '';
    const code = /no integration ticket/i.test(reason) ? 'missing-integration' : 'missing-integration';
    issues.push(issueFromPartial({ code, req: gap.req, reason, fixable: false }));
  }

  for (const req of sources.unwiredRequirements ?? unwiredRequirements(sources.tickets ?? [])) {
    issues.push(issueFromPartial({
      code: 'missing-integration',
      req,
      reason: `${req}: build tickets but no integration ticket that mounts them in a route or page`,
      fixable: false,
    }));
  }

  for (const row of sources.pathValidation ?? sources.pathRefusals ?? []) {
    if (typeof row === 'string') {
      issues.push(issueFromPartial({ code: 'path', reason: row, fixable: false }));
      continue;
    }
    for (const err of row.errors ?? [row]) {
      issues.push(issueFromPartial({
        code: 'path',
        ticket: row.ticketId ?? row.ticket ?? err.ticket,
        path: err.path,
        reason: err.reason ?? err.message ?? 'path not in repo',
        fixable: false,
      }));
    }
  }

  for (const msg of sources.laneRefusals ?? []) {
    issues.push(issueFromPartial({
      code: 'lane-size',
      reason: typeof msg === 'string' ? msg : String(msg),
      fixable: false,
    }));
  }

  for (const err of sources.treeErrors ?? []) {
    let code = 'tree';
    if (err.code === 'conflict') code = 'shared-file-same-wave';
    issues.push(issueFromPartial({
      code,
      reason: err.message ?? String(err.code),
      fixable: code === 'shared-file-same-wave',
    }));
    if (Array.isArray(err.conflicts)) {
      for (const c of err.conflicts) {
        for (const ticketId of c.tickets ?? []) {
          issues.push(issueFromPartial({
            code: 'shared-file-same-wave',
            ticket: ticketId,
            path: c.file,
            reason: `both write ${c.file} in wave ${(c.wave ?? 0) + 1}`,
            fixable: true,
          }));
        }
      }
    }
  }

  for (const t of sources.strayTickets ?? []) {
    issues.push(issueFromPartial({
      code: 'stray',
      ticket: t.id,
      title: t.title,
      reason: `touches requirements outside the change order: ${(t.scopeRefs ?? []).join(', ')}`,
      fixable: false,
    }));
  }

  if (sources.waveRefusal) {
    issues.push(issueFromPartial({
      code: 'waves',
      reason: typeof sources.waveRefusal === 'string' ? sources.waveRefusal : String(sources.waveRefusal),
      fixable: false,
    }));
  }

  for (const raw of sources.issues ?? []) {
    if (raw && typeof raw === 'object' && raw.code) issues.push(issueFromPartial(raw));
    else issues.push(issueFromPartial({ reason: String(raw) }));
  }

  return issues;
}

export function autoFix(tickets, issues, { existing = [], repoFiles = [], profile = null, applyIngestGuards = true } = {}) {
  let next = tickets.map(cloneTicket);
  const fixed = [];
  const fixedKeys = new Set();
  const markFixed = (issue) => {
    const key = issueFingerprint(issue);
    if (!fixedKeys.has(key)) {
      fixedKeys.add(key);
      fixed.push(issue);
    }
  };

  const codes = new Set(issues.map(i => i.code));

  if (codes.has('shared-file-same-wave') || codes.has('tree')) {
    const before = JSON.stringify(next.map(t => t.dependsOn));
    chainSharedFiles(next, existing);
    const after = JSON.stringify(next.map(t => t.dependsOn));
    if (before !== after) {
      for (const issue of issues.filter(i => i.code === 'shared-file-same-wave' || i.code === 'tree')) markFixed(issue);
    }
  }

  if (!applyIngestGuards) {
    const remaining = issues.filter(i => !fixedKeys.has(issueFingerprint(i)));
    return { tickets: next, fixed, remaining };
  }

  if (codes.has('future-context') && repoFiles.length) {
    const notes = [];
    reconcileTicketContext([...existing, ...next], repoFiles, notes);
    if (notes.length) {
      for (const issue of issues.filter(i => i.code === 'future-context')) markFixed(issue);
    }
  }

  if (codes.has('test-after-code')) {
    const notes = [];
    const rejected = [];
    next = alignTestTicketsWithBuildStages(next, existing, { notes, rejected });
    if (notes.length) {
      for (const issue of issues.filter(i => i.code === 'test-after-code')) markFixed(issue);
    }
  }

  if (codes.has('protected-file') && profile) {
    let nextNum = Math.max(0, ...next.map(t => Number(String(t.id ?? '').slice(2)) || 0));
    const allocId = () => {
      nextNum += 1;
      return `T-${String(nextNum).padStart(4, '0')}`;
    };
    const notes = [];
    const extra = peelProtectedOutputs(next, profile, { notes, allocId });
    if (extra.length) next.push(...extra);
    if (notes.length) {
      for (const issue of issues.filter(i => i.code === 'protected-file')) markFixed(issue);
    }
  }

  const remaining = issues.filter(i => !fixedKeys.has(issueFingerprint(i)));
  return { tickets: next, fixed, remaining };
}

function requirementTextForStage({ scopeText, requirementsByStage, stage }) {
  if (requirementsByStage && requirementsByStage[stage]) {
    return requirementsByStage[stage].map(r => `### ${r.id} ${r.title ?? ''}\n${(r.acceptance ?? []).map(a => `- ${a}`).join('\n')}`).join('\n\n');
  }
  if (scopeText && stage) {
    const re = new RegExp(`##\\s+${stage}[^#]*([\\s\\S]*?)(?=##\\s+S\\d+|##\\s+External|$)`, 'i');
    const m = scopeText.match(re);
    if (m) return m[1].trim();
  }
  return scopeText ?? '';
}

export function buildRepairJobs({
  scopeText,
  requirementsByStage,
  stage,
  failedTickets,
  issues,
  rules = ROOT_RULES,
  round = 0,
  outputPath,
}) {
  const reqText = requirementTextForStage({ scopeText, requirementsByStage, stage });
  const issueLines = (issues ?? [])
    .filter(i => !stage || i.stage === stage || !i.stage)
    .map(i => `- [${i.code}] ticket=${i.ticket ?? '?'} path=${i.path ?? ''} req=${i.req ?? ''}: ${i.reason}`)
    .join('\n');
  const prompt = [
    `Split repair round ${round + 1} for stage ${stage}.`,
    '',
    '## Requirement text for this stage',
    reqText,
    '',
    '## Root rules (follow exactly)',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    '## Failed ticket JSON from the worker',
    JSON.stringify(failedTickets, null, 2),
    '',
    '## Issues to fix',
    issueLines || '(none listed)',
    '',
    `Return the FULL corrected JSON array of tickets for stage ${stage} to ${outputPath} (same path the split job used, so readStageFiles still works).`,
  ].join('\n');
  return { id: `split-${stage}`, prompt };
}

function groupIssuesByTicket(issues) {
  const map = new Map();
  for (const issue of issues) {
    const key = issue.ticket ?? `_stage:${issue.stage ?? 'unknown'}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(issue);
  }
  return map;
}

function parkInvalid(v, allIssues, rounds, history) {
  const valid = v.tickets ?? [];
  const validIds = new Set(valid.map(t => t.id));
  const pool = v.allTickets ?? valid;
  const byTicket = groupIssuesByTicket(allIssues);
  const parked = [];
  for (const [ticketKey, iss] of byTicket) {
    if (ticketKey.startsWith('_stage:')) continue;
    if (validIds.has(ticketKey)) continue;
    const ticket = pool.find(t => t.id === ticketKey || t.key === ticketKey) ?? { id: ticketKey };
    parked.push({ ticket, stage: iss[0]?.stage ?? null, issues: iss });
  }
  for (const t of pool) {
    if (!validIds.has(t.id) && !parked.some(p => p.ticket.id === t.id)) {
      const iss = byTicket.get(t.id) ?? allIssues.filter(i => i.ticket === t.id);
      if (iss.length) parked.push({ ticket: t, stage: t.stage, issues: iss });
    }
  }
  return { tickets: valid, parked, rounds, history };
}

export function runRepairLoop({ maxRepairs = 3, validate, rerun, log, now = () => Date.now() }) {
  const history = [];
  let rounds = 0;
  let prevIssueKeys = null;

  const snapshot = (v) => {
    const all = [...(v.issues ?? []), ...(v.stageIssues ?? [])];
    return { all, keys: [...all].map(issueFingerprint).sort().join('\0'), v };
  };

  const applyAutoFix = (v, allIssues) => {
    const pool = v.allTickets ?? v.tickets ?? [];
    const result = autoFix(
      pool.map(cloneTicket),
      allIssues,
      {
        existing: v.existing ?? [],
        repoFiles: v.repoFiles ?? [],
        profile: v.profile ?? null,
        applyIngestGuards: false,
      },
    );
    if (typeof v.setTickets === 'function') v.setTickets(result.tickets);
    return result;
  };

  let { all: issues, keys, v } = snapshot(validate());
  if (!issues.length) return { tickets: v.tickets ?? [], parked: [], rounds: 0, history };

  const errorsInFirst = issues.length;
  applyAutoFix(v, issues);
  ({ all: issues, keys, v } = snapshot(validate()));

  if (!issues.length) {
    log?.({ round: 0, errorsIn: errorsInFirst, errorsLeft: 0 });
    history.push({ round: 0, errorsIn: errorsInFirst, errorsLeft: 0 });
    return { tickets: v.tickets ?? [], parked: [], rounds: 0, history };
  }

  if (maxRepairs === 0) {
    return parkInvalid(v, issues, rounds, history);
  }

  prevIssueKeys = keys;

  while (rounds < maxRepairs) {
    const stages = [...new Set(issues.map(i => i.stage).filter(Boolean))];
    const issuesByStage = {};
    for (const issue of issues) {
      const s = issue.stage ?? '_';
      if (!issuesByStage[s]) issuesByStage[s] = [];
      issuesByStage[s].push(issue);
    }
    const errorsIn = issues.length;
    rerun(stages, issuesByStage, rounds);
    rounds += 1;

    ({ all: issues, keys, v } = snapshot(validate()));
    log?.({ round: rounds - 1, errorsIn, errorsLeft: issues.length });
    history.push({ round: rounds - 1, errorsIn, errorsLeft: issues.length });

    if (!issues.length) {
      return { tickets: v.tickets ?? [], parked: [], rounds, history };
    }

    applyAutoFix(v, issues);
    ({ all: issues, keys, v } = snapshot(validate()));

    if (!issues.length) {
      return { tickets: v.tickets ?? [], parked: [], rounds, history };
    }

    if (keys === prevIssueKeys) {
      return parkInvalid(v, issues, rounds, history);
    }
    prevIssueKeys = keys;
  }

  return parkInvalid(v, issues, rounds, history);
}

export function parkedBlockers(parked, { runId = 'RUN' } = {}) {
  return (parked ?? []).map(({ ticket, stage, issues }) => {
    const id = ticket?.id ?? 'unknown';
    const stageLabel = stage ?? ticket?.stage ?? '?';
    const errors = (issues ?? []).map(i => i.reason ?? i.code).join('; ');
    const text = `Split parked ${id} (${ticket?.title ?? 'untitled'}) in stage ${stageLabel}: ${errors}. Retry with: swarm scope split --ingest ${runId} --merge --max-repairs 3`;
    return {
      kind: 'blocker',
      id: `split-park-${stageLabel}-${id}`,
      text,
      ticket: id,
    };
  });
}

/** Helpers for tests and T-8024: detect test-after-code and missing-integration on ticket sets. */
export function detectTestAfterCodeIssues(tickets, existing = []) {
  const issues = [];
  const all = [...existing, ...tickets];
  for (const test of tickets) {
    if (test.type !== 'test') continue;
    const modules = all.filter(
      t => t.type === 'build' && t.integration !== true && (t.scopeRefs ?? []).some(r => (test.scopeRefs ?? []).includes(r)),
    );
    if (!modules.length) continue;
    const target = modules.reduce((best, m) => (stageRank(m.stage) > stageRank(best.stage) ? m : best), modules[0]);
    if (stageRank(test.stage) > stageRank(target.stage)) {
      issues.push(issueFromPartial({
        code: 'test-after-code',
        stage: test.stage,
        ticket: test.id ?? test.key,
        title: test.title,
        reason: `test ticket is in stage ${test.stage} but code is in ${target.stage}`,
        fixable: true,
      }));
    }
  }
  return issues;
}

export function detectMissingIntegrationIssues(tickets, touchedReqs) {
  const gaps = wiringGaps(tickets, touchedReqs);
  return gaps.map(g => {
    const modules = moduleTickets(tickets, g.req);
    return issueFromPartial({
      code: 'missing-integration',
      req: g.req,
      ticket: modules[0]?.id ?? modules[0]?.key ?? null,
      stage: modules[0]?.stage ?? null,
      reason: g.reason,
      fixable: false,
    });
  });
}

export function detectSharedFileIssues(tickets, existing = []) {
  const all = [...existing, ...tickets];
  const byId = id => all.find(t => t.id === id) ?? { id };
  const reaches = (from, target, seen = new Set()) => {
    if (seen.has(from.id)) return false;
    seen.add(from.id);
    return (from.dependsOn ?? []).some(d => d === target || reaches(byId(d), target, seen));
  };
  const byFile = new Map();
  for (const t of all) {
    if (t.type !== 'build' && t.type !== 'test') continue;
    for (const f of t.files ?? []) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(t);
    }
  }
  const issues = [];
  for (const [file, writers] of byFile) {
    if (writers.length < 2) continue;
    const sorted = [...writers].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < sorted.length; i += 1) {
      const early = sorted[0];
      const late = sorted[i];
      if (reaches(late, early.id) || reaches(early, late.id)) continue;
      issues.push(issueFromPartial({
        code: 'shared-file-same-wave',
        stage: late.stage,
        ticket: late.id,
        path: file,
        reason: `${early.id} and ${late.id} both write ${file}`,
        fixable: true,
      }));
    }
  }
  return issues;
}

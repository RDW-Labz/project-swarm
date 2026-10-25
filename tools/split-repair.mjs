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
import { validateTicket } from './tickets.mjs';
import { parseScope, requirementText } from './scope.mjs';
import { isSensitiveTicket } from './sensitive-ticket.mjs';
import {
  applyTicketPathWiring,
  validateTicketPaths,
  formatTicketPathRefusal,
  normTicketPath,
  ownersOfTicketPath,
  addingDepCreatesCycle,
  ticketOwnedPaths,
} from './ticket-paths.mjs';

const NEEDS_ACCEPTANCE = ['build', 'test', 'migration'];
const LIST_FIELDS = ['scopeRefs', 'acceptance', 'files', 'context', 'contracts', 'tests', 'screens', 'dependsOn', 'deletes', 'dependencies'];
const INACTIVE_OWNER_STATUSES = new Set(['done', 'rejected', 'cancelled']);
const publicRoutePath = file => /(?:^|\/)app\/api\/.+\/route\.[cm]?[jt]sx?$|(?:^|\/)src\/routes\/public(?:\/|$)/i.test(String(file ?? ''));
const writesPublicApiRoute = ticket => (ticket?.files ?? []).some(publicRoutePath);

function reqLookupFromScope(scope) {
  return new Map((scope?.requirements ?? []).map((requirement) => [requirement.id, requirement]));
}

/** Match scope-commands ticketsFromStageLists sensitive tagging (OR-only; never clear true). */
function applySplitterSensitive(ticket, scope, reqLookup) {
  if (ticket.sensitive === true) return;
  ticket.sensitive = isSensitiveTicket(ticket, scope, reqLookup) || writesPublicApiRoute(ticket);
}

function pickPathOwner(ownerIds, allTickets) {
  const byId = new Map((allTickets ?? []).map(t => [t.id, t]));
  for (const id of ownerIds) {
    const owner = byId.get(id);
    const status = owner?.status ?? 'todo';
    if (INACTIVE_OWNER_STATUSES.has(status)) continue;
    return id;
  }
  return null;
}

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
    contracts: [...(t.contracts ?? [])],
    tests: [...(t.tests ?? [])],
    scopeRefs: [...(t.scopeRefs ?? [])],
    acceptance: [...(t.acceptance ?? [])],
    ...(t.screens ? { screens: [...t.screens] } : {}),
  };
}

function toKebabScreenId(raw) {
  let s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length < 2) s = `${s || 'x'}`.padEnd(2, 'x').slice(0, 2);
  if (s.length > 40) s = s.slice(0, 40);
  return s;
}

function normalizeListFields(ticket, addNote) {
  let changed = false;
  for (const field of LIST_FIELDS) {
    if (ticket[field] === undefined || ticket[field] === null) continue;
    if (typeof ticket[field] === 'string') {
      ticket[field] = [ticket[field]];
      addNote(ticket.id, 'list-normalize', `${field} was a string; wrapped as array`);
      changed = true;
    }
    if (!Array.isArray(ticket[field])) continue;
    const next = [];
    const seen = new Set();
    for (const entry of ticket[field]) {
      const s = String(entry);
      if (seen.has(s)) continue;
      seen.add(s);
      next.push(s);
    }
    if (next.length !== ticket[field].length) {
      addNote(ticket.id, 'list-dedupe', `${field} duplicate entries removed`);
      changed = true;
    }
    ticket[field] = next;
  }
  return changed;
}

function normalizeScreens(ticket, addNote) {
  if (ticket.screens === undefined || ticket.screens === null) return false;
  const raw = Array.isArray(ticket.screens) ? ticket.screens : [ticket.screens];
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    const norm = toKebabScreenId(id);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 5) break;
  }
  const before = JSON.stringify(ticket.screens);
  const after = JSON.stringify(out.length ? out : undefined);
  if (before !== after) {
    if (out.length) ticket.screens = out;
    else delete ticket.screens;
    addNote(ticket.id, 'screens-normalize', `screens -> ${out.join(', ') || '(removed)'}`);
    return true;
  }
  return false;
}

function repairAcceptance(ticket, scope, addNote) {
  if (!NEEDS_ACCEPTANCE.includes(ticket.type)) return false;
  if (Array.isArray(ticket.acceptance) && ticket.acceptance.some(line => String(line).trim())) return false;
  const copied = (ticket.scopeRefs ?? [])
    .flatMap(ref => requirementText(scope, ref)?.acceptance ?? [])
    .map(line => String(line).trim())
    .filter(Boolean);
  if (!copied.length) return false;
  ticket.acceptance = copied;
  addNote(ticket.id, 'acceptance-copy', `copied ${copied.length} line(s) from scopeRefs ${ticket.scopeRefs.join(', ')}`);
  return true;
}

function repairPathsForTicket(ticket, allTickets, exists, addNote, pathOptions = {}, scope, reqLookup) {
  let changed = false;
  let sensitivePathsTouched = false;
  const owned = ticketOwnedPaths(ticket);

  for (const contractPath of ticket.contracts ?? []) {
    const norm = normTicketPath(contractPath);
    if (!norm || exists(norm)) continue;
    const owners = ownersOfTicketPath(norm, allTickets).filter(id => id !== ticket.id);
    if (owners.length) {
      const ownerId = pickPathOwner(owners, allTickets);
      if (!ownerId) continue;
      if (!addingDepCreatesCycle(ticket.id, ownerId, allTickets)) {
        const deps = new Set(ticket.dependsOn ?? []);
        if (!deps.has(ownerId)) {
          ticket.dependsOn = [...deps, ownerId];
          addNote(ticket.id, 'path-dependency', `dependsOn ${ownerId} for missing contract ${norm}`);
          changed = true;
        }
      }
      continue;
    }
    const pathProbe = validateTicketPaths(ticket, { ...pathOptions, exists, allTickets });
    const typo = pathProbe.errors.find((err) => err.field === 'contracts' && normTicketPath(err.path) === norm && err.suggestion);
    if (typo) continue;
    const files = new Set((ticket.files ?? []).map(normTicketPath));
    if (!files.has(norm)) {
      ticket.files = [...(ticket.files ?? []), norm];
      addNote(ticket.id, 'path-new-file', `${norm} declared in files (new contract output)`);
      changed = true;
      sensitivePathsTouched = true;
    }
  }

  for (const contextPath of ticket.context ?? []) {
    const norm = normTicketPath(contextPath);
    if (!norm || exists(norm) || owned.has(norm)) continue;
    const owners = ownersOfTicketPath(norm, allTickets).filter(id => id !== ticket.id);
    if (!owners.length) continue;
    const ownerId = pickPathOwner(owners, allTickets);
    if (!ownerId || addingDepCreatesCycle(ticket.id, ownerId, allTickets)) continue;
    const deps = new Set(ticket.dependsOn ?? []);
    if (!deps.has(ownerId)) {
      ticket.dependsOn = [...deps, ownerId];
      addNote(ticket.id, 'path-dependency', `dependsOn ${ownerId} for context ${norm}`);
      changed = true;
    }
  }

  const filesBeforeWiring = JSON.stringify(ticket.files ?? []);
  const wiring = applyTicketPathWiring(ticket, allTickets, { ...pathOptions, exists, allTickets });
  if (JSON.stringify(ticket.files ?? []) !== filesBeforeWiring) sensitivePathsTouched = true;
  for (const note of wiring.notes ?? []) {
    addNote(ticket.id, 'path-wiring', note.includes(':') ? note.slice(note.indexOf(':') + 1).trim() : note);
    changed = true;
  }
  const ownerById = new Map(allTickets.map(t => [t.id, t]));
  const activeDeps = (ticket.dependsOn ?? []).filter((depId) => {
    const status = ownerById.get(depId)?.status ?? 'todo';
    return !INACTIVE_OWNER_STATUSES.has(status);
  });
  if (activeDeps.length !== (ticket.dependsOn ?? []).length) {
    ticket.dependsOn = activeDeps;
    addNote(ticket.id, 'path-dependency', 'dropped dependsOn inactive ledger owners (done, rejected or cancelled)');
    changed = true;
  }
  if (sensitivePathsTouched) {
    applySplitterSensitive(ticket, scope, reqLookup);
    addNote(ticket.id, 'sensitive-refresh', `sensitive=${ticket.sensitive === true}`);
  }
  return changed;
}

function ticketValidationErrors(ticket, allTickets, exists, pathOptions = {}) {
  const shape = validateTicket(ticket);
  const paths = validateTicketPaths(ticket, { ...pathOptions, exists, allTickets });
  const errors = [...(shape.errors ?? [])];
  for (const err of paths.errors ?? []) {
    if (err.reason === 'missing file') {
      errors.push(`${err.field} path not in repo: ${err.path}`);
    } else {
      errors.push(formatTicketPathRefusal(ticket.id, err).replace(/^[^:]+:\s*/, ''));
    }
  }
  return errors;
}

function collapseDependentParked(failures) {
  const parked = [];
  for (const [id, entry] of failures) {
    const blockedParent = (entry.ticket.dependsOn ?? []).find(dep => failures.has(dep) && dep !== id);
    const onlyRejectedChain = entry.errs.every(reason => /depends on rejected/i.test(reason));
    if (blockedParent && (onlyRejectedChain || entry.errs.length === 0)) continue;
    parked.push({
      ticket: entry.ticket,
      issues: entry.errs.map(reason => ({ code: 'validation', reason })),
    });
  }
  return parked;
}

/**
 * Automatic split repairs on a ticket batch (no model). Pure over tickets, ledger, scope text, and path existence.
 * @returns {{ tickets: object[], notes: string[], parked: object[] }}
 */
export function repairTicketBatch({ tickets, ledgerTickets = [], scopeText = '', pathExists, repoFiles }) {
  const notes = [];
  const addNote = (id, rule, detail) => notes.push(`${id}: ${rule}: ${detail}`);
  const scope = scopeText ? parseScope(scopeText) : { requirements: [] };
  const reqLookup = reqLookupFromScope(scope);
  const exists = typeof pathExists === 'function'
    ? (p) => pathExists(normTicketPath(p))
    : () => false;
  const pathOptions = Array.isArray(repoFiles) && repoFiles.length ? { repoFiles } : {};

  let pool = (tickets ?? []).map(cloneTicket);
  const ledger = ledgerTickets ?? [];

  const allTickets = () => {
    const byId = new Map();
    for (const t of ledger) if (t?.id) byId.set(t.id, t);
    for (const t of pool) byId.set(t.id, t);
    return [...byId.values()];
  };

  for (let round = 0; round < 12; round += 1) {
    let changed = false;
    for (const ticket of pool) {
      changed = normalizeListFields(ticket, addNote) || changed;
      changed = normalizeScreens(ticket, addNote) || changed;
      changed = repairAcceptance(ticket, scope, addNote) || changed;
      changed = repairPathsForTicket(ticket, allTickets(), exists, addNote, pathOptions, scope, reqLookup) || changed;
    }
    if (!changed) break;
  }

  const failures = new Map();
  for (const ticket of pool) {
    const errs = ticketValidationErrors(ticket, allTickets(), exists, pathOptions);
    if (errs.length) failures.set(ticket.id, { ticket, errs });
  }

  const parked = collapseDependentParked(failures).map((entry) => {
    const pathOnly = (entry.issues ?? []).length > 0
      && (entry.issues ?? []).every((issue) => /path not in repo/i.test(String(issue.reason ?? '')));
    if (!pathOnly) return entry;
    return {
      ...entry,
      ticket: { ...entry.ticket, pathPending: true },
      parkedReason: 'path-not-in-repo-pending',
      issues: [{
        code: 'path-pending',
        reason: 'path not in repo (pending path gate)',
      }, ...(entry.issues ?? [])],
    };
  });
  const parkedIds = new Set(parked.map(p => p.ticket.id));
  const valid = pool.filter(t => !parkedIds.has(t.id));

  return { tickets: valid, notes, parked };
}

/** Re-check tickets that were rejected only because a dependency was rejected. */
export function refreshRejectedDependents({
  tickets,
  rejected = [],
  repairedIds = new Set(),
  candidateTickets = [],
  exists = () => false,
  pathOptions = {},
} = {}) {
  if (!repairedIds.size || !rejected.length) {
    return { tickets: [...(tickets ?? [])], rejected: [...(rejected ?? [])], notes: [] };
  }
  const notes = [];
  const nextTickets = (tickets ?? []).map(cloneTicket);
  const ticketById = new Map(nextTickets.map(t => [t.id, t]));
  for (const t of candidateTickets ?? []) {
    if (t?.id) ticketById.set(t.id, t);
  }
  const rejectedById = new Map(rejected.map(row => [row.id, row]));
  const stillRejected = new Set(rejectedById.keys());
  const allTickets = () => {
    const byId = new Map();
    for (const t of nextTickets) byId.set(t.id, t);
    for (const t of candidateTickets ?? []) {
      if (t?.id) byId.set(t.id, t);
    }
    return [...byId.values()];
  };
  const dependencyAccepted = (depId) => {
    if (nextTickets.some(t => t.id === depId)) return true;
    if (repairedIds.has(depId) && !stillRejected.has(depId)) return true;
    return false;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, row] of [...rejectedById]) {
      if (!/depends on rejected/i.test(String(row.reason ?? ''))) continue;
      const ticket = ticketById.get(id);
      if (!ticket) continue;
      const deps = ticket.dependsOn ?? [];
      if (!deps.length || !deps.every(dependencyAccepted)) continue;
      const shape = validateTicket(ticket);
      const paths = validateTicketPaths(ticket, { ...pathOptions, exists, allTickets: allTickets() });
      const pathErrs = [];
      for (const err of paths.errors ?? []) {
        if (err.reason === 'missing file') pathErrs.push(`${err.field} path not in repo: ${err.path}`);
        else pathErrs.push(formatTicketPathRefusal(ticket.id, err).replace(/^[^:]+:\s*/, ''));
      }
      const errs = [...(shape.errors ?? []), ...pathErrs];
      if (!shape.ok || errs.length) continue;
      stillRejected.delete(id);
      rejectedById.delete(id);
      if (!nextTickets.some(t => t.id === id)) {
        nextTickets.push(cloneTicket(ticket));
        notes.push(`${id}: rejected-dependency-refresh: dependencies accepted; ticket restored`);
      } else {
        notes.push(`${id}: rejected-dependency-refresh: dependencies accepted; ticket kept`);
      }
      changed = true;
    }
  }
  return { tickets: nextTickets, rejected: [...rejectedById.values()], notes };
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
    issues.push(wiringGapIssue(gap));
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

function wiringGapIssue(gap) {
  const reason = gap.reason ?? '';
  if (/not a test file|no route-level test/i.test(reason)) {
    return issueFromPartial({
      code: 'invalid-integration-test',
      req: gap.req,
      reason,
      fixable: true,
    });
  }
  return issueFromPartial({
    code: 'missing-integration',
    req: gap.req,
    reason,
    fixable: false,
  });
}

export function detectMissingIntegrationIssues(tickets, touchedReqs) {
  const gaps = wiringGaps(tickets, touchedReqs);
  return gaps.map(g => {
    const issue = wiringGapIssue(g);
    const modules = moduleTickets(tickets, g.req);
    const integ = (tickets ?? []).filter(t => t.type === 'build' && t.integration === true && (t.scopeRefs ?? []).includes(g.req));
    if (issue.code === 'invalid-integration-test') {
      issue.ticket = integ[0]?.id ?? integ[0]?.key ?? null;
      issue.stage = integ[0]?.stage ?? null;
    } else {
      issue.ticket = modules[0]?.id ?? modules[0]?.key ?? null;
      issue.stage = modules[0]?.stage ?? null;
    }
    return issue;
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

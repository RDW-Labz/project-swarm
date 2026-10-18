// SPDX-License-Identifier: Apache-2.0
import { validDependencySpec } from './dep-install.mjs';
import fs from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { safeWritableDir, assertRegularOrMissing, appendEvent } from './journal.mjs';
import { wiringGaps } from './wiring.mjs';
import { isExampleFile } from './init-profile.mjs';
import { isSensitivePath } from './sensitive-paths.mjs';

export const STATUSES = ['todo', 'ready', 'running', 'review', 'done', 'blocked', 'cancelled'];
export const TICKET_TYPES = ['build', 'test', 'docs', 'migration', 'design', 'contract', 'human'];
const RISKS = ['low', 'medium', 'high'];
const SIZES = ['S', 'M'];
const NEEDS_ACCEPTANCE = ['build', 'test', 'migration'];
const HASH_FIELDS = ['id', 'title', 'type', 'stage', 'scopeRefs', 'acceptance', 'files', 'context', 'contracts', 'dependsOn', 'size', 'risk', 'sensitive', 'hard', 'steps', 'skeleton', 'tests', 'screens', 'integration', 'deletes', 'dependencies'];
const RESERVED_FIRST = ['.git', '.swarm', '.github-hooks-free'];
// Build output anywhere in a path, and any dot-env file, are never ticket files.
const BUILD_DIRS = ['.next', 'node_modules', 'dist'];
const SECRET_NAMES = ['.project-swarm.json', '.env'];
const MOVES = {
  todo: ['ready', 'blocked', 'cancelled'],  // a human ticket may also go todo -> done (see HUMAN_MOVES)
  ready: ['running', 'blocked', 'cancelled'],
  running: ['review', 'ready', 'blocked', 'cancelled'],
  review: ['done', 'running', 'blocked', 'cancelled'],
  blocked: ['ready', 'cancelled'],
  done: [],
  cancelled: [],
};

// Day 0 and other human tickets are done by a person, at any time.
const HUMAN_MOVES = { todo: ['done'], ready: ['done'], running: ['done'], blocked: ['done'] };
const legalMoves = ticket => [...(MOVES[ticket.status] ?? []), ...(ticket.type === 'human' ? HUMAN_MOVES[ticket.status] ?? [] : [])];

const fail = (code, message) => Object.assign(new Error(message), { code });
const isStrArr = v => Array.isArray(v) && v.every(s => typeof s === 'string');
const none = v => v === undefined || v === null;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const canon = v => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
// readOnly (a context path): a names-only template such as .env.example is allowed to be read, never written.
const badPath = (p, readOnly = false) => {
  const segs = p.split('/');
  return p === '' ||
    p.startsWith('/') ||
    /^[A-Za-z]:/.test(p) ||
    p.includes('\\') ||
    segs.some(s => s === '' || s === '.' || s === '..') ||
    RESERVED_FIRST.includes(segs[0]) ||
    p.endsWith('.tsbuildinfo') ||
    segs.some(s => BUILD_DIRS.includes(s) || (/^\.env(?:$|\.)/i.test(s) && !(readOnly && isExampleFile(p)))) ||
    segs.some(s => SECRET_NAMES.includes(s.toLowerCase()));
};

export function ticketSetHash(tickets) {
  const picked = [...tickets].sort(byId).map(t => Object.fromEntries(HASH_FIELDS.map(k => [k, t[k]])));
  return createHash('sha256').update(canon(picked)).digest('hex');
}

export function validateTicket(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return { ok: false, errors: ['ticket must be an object'] };
  if (!/^T-[0-9]{4,}$/.test(t.id ?? '')) errors.push(`bad id: ${t.id}`);
  if (typeof t.title !== 'string' || t.title.length < 1 || t.title.length > 140) errors.push('title must be 1 to 140 characters');
  if (!TICKET_TYPES.includes(t.type)) errors.push(`unknown type: ${t.type}`);
  if (!Array.isArray(t.scopeRefs)) errors.push('scopeRefs must be an array');
  else {
    if (!t.scopeRefs.every(r => /^R-[0-9]{3,}$/.test(r))) errors.push('scopeRefs must contain R- ids');
    if (t.scopeRefs.length === 0 && t.origin !== 'ci' && !['human', 'contract'].includes(t.type)) errors.push('scopeRefs must name at least one requirement');
  }
  if (t.acceptance !== undefined && !isStrArr(t.acceptance)) errors.push('acceptance must be an array of strings');
  if (NEEDS_ACCEPTANCE.includes(t.type) && !(isStrArr(t.acceptance) && t.acceptance.length > 0)) errors.push('acceptance is required for build, test and migration tickets');
  if (t.size === 'L') errors.push('size L: split this ticket');
  else if (!SIZES.includes(t.size)) errors.push(`bad size: ${t.size}`);
  if (!RISKS.includes(t.risk)) errors.push(`bad risk: ${t.risk}`);
  for (const k of ['dependsOn', 'files', 'context', 'contracts', 'tests', 'deletes', 'dependencies']) if (t[k] !== undefined && !isStrArr(t[k])) errors.push(`${k} must be an array of strings`);
  if (isStrArr(t.dependencies)) {
    if (t.dependencies.length > 10) errors.push('dependencies: at most 10 packages');
    for (const d of t.dependencies) if (!validDependencySpec(d)) errors.push(`dependencies entry not allowed: ${d} (a registry package name with an optional version, like zod or zod@^3.23.0)`);
  }
  if (isStrArr(t.deletes)) {
    if (t.deletes.length > 20) errors.push('deletes: at most 20 files');
    for (const p of t.deletes) { if (badPath(p) || p.endsWith('/') || p.includes('*')) errors.push(`deletes path not allowed: ${p} (one real file, no folder, no glob)`); else if (isSensitivePath(p)) errors.push(`deletes path not allowed: ${p} is a manifest, lockfile, workflow, hook or profile file: delete it by hand`); if (isStrArr(t.files) && t.files.includes(p)) errors.push(`${p} is both written and deleted`); }
  }
  for (const k of ['files', 'context', 'contracts', 'tests']) if (isStrArr(t[k])) for (const p of t[k]) if (badPath(p, k === 'context')) errors.push(`${k} path not allowed: ${p}`);
  if (isStrArr(t.tests) && t.tests.some(p => p.startsWith('-'))) errors.push('tests path must not start with a dash');
  if (!STATUSES.includes(t.status)) errors.push(`bad status: ${t.status}`);
  if (t.sensitive !== undefined && typeof t.sensitive !== 'boolean') errors.push('sensitive must be a boolean');
  if (t.skeleton !== undefined && typeof t.skeleton !== 'boolean') errors.push('skeleton must be a boolean');
  if (t.integration !== undefined && typeof t.integration !== 'boolean') errors.push('integration must be a boolean');
  if (t.screens !== undefined && !(isStrArr(t.screens) && t.screens.length <= 5 && t.screens.every(id => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length >= 2 && id.length <= 40))) errors.push('screens must be up to 5 kebab-case screen ids');
  if (t.securityReview !== undefined) {
    const r = t.securityReview;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !['blocked', 'accepted-unreviewed'].includes(r.state) || typeof r.reason !== 'string' || r.reason.length < 1 || r.reason.length > 400) errors.push('securityReview must be {state: blocked or accepted-unreviewed, reason}');
  }
  if (t.acceptanceBlocked !== undefined) {
    const r = t.acceptanceBlocked;
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.reason !== 'string' || r.reason.length < 1 || r.reason.length > 600) errors.push('acceptanceBlocked must be {reason, at, run}');
  }
  if (t.acceptanceResults !== undefined) {
    const list = t.acceptanceResults;
    if (!Array.isArray(list) || list.length > 100 || !list.every(r => r && typeof r === 'object' && Number.isInteger(r.n) && r.n >= 1 && r.n <= 200 && ['test', 'review', 'owner'].includes(r.by) && ['pass', 'fail', 'pending', 'missing', 'accepted'].includes(r.verdict) && (r.line === undefined || (typeof r.line === 'string' && r.line.length <= 200)) && (r.evidence === undefined || (typeof r.evidence === 'string' && r.evidence.length <= 300)))) errors.push('acceptanceResults must be a list of {n, line, by, verdict, evidence} (verdict pass, fail, pending, missing or accepted)');
  }
  if (t.origin !== undefined && t.origin !== 'ci') errors.push('origin must be ci when set');
  if (t.type === 'human' && !(isStrArr(t.steps) && t.steps.length >= 1 && t.steps.length <= 30)) errors.push('human tickets need 1 to 30 steps');
  return { ok: errors.length === 0, errors };
}

export const ledgerPath = root => path.join(root, '.swarm', 'project', 'tickets.json');
export const logPath = root => path.join(root, '.swarm', 'project', 'tickets.log');

export async function readLedger(root) {
  try {
    return JSON.parse(await fs.readFile(ledgerPath(root), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeLedger(root, ledger) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'tickets.json');
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.tickets.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(ledger, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function appendLog(root, event) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'tickets.log');
  await assertRegularOrMissing(file);
  const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  } finally {
    await handle.close();
  }
}

export function createLedger({ scope, tickets = [], now = Date.now() } = {}) {
  const seen = new Set();
  for (const t of tickets) {
    const r = validateTicket(t);
    if (!r.ok) throw fail('ticket-invalid', `${t?.id ?? '?'}: ${r.errors[0]}`);
    if (seen.has(t.id)) throw fail('ticket-invalid', `duplicate ticket id: ${t.id}`);
    seen.add(t.id);
  }
  const at = new Date(now).toISOString();
  return { version: 1, scope, tickets, changeOrders: [], approved: null, createdAt: at, updatedAt: at };
}

export async function transition(root, id, to, { by = 'system', note, now = Date.now(), reason } = {}) {
  const ledger = await readLedger(root);
  if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
  const ticket = ledger.tickets.find(t => t.id === id);
  if (!ticket) throw fail('ticket-missing', `no ticket ${id}`);
  if (!STATUSES.includes(to) || !legalMoves(ticket).includes(to)) throw fail('ticket-transition', `${id}: ${ticket.status} -> ${to} is not allowed; legal next statuses: ${legalMoves(ticket).join(', ') || 'none'}`);
  if (to === 'ready') {
    const waiting = (ticket.dependsOn ?? []).filter(d => ledger.tickets.find(x => x.id === d)?.status !== 'done');
    if (waiting.length) throw fail('ticket-deps', `${id} waits on ${waiting.join(', ')}`);
  }
  const from = ticket.status;
  ticket.status = to;
  // Why a ticket is blocked decides whether it may unlock by itself: only a dependency block does.
  if (to === 'blocked') ticket.blockReason = reason ?? 'manual'; else delete ticket.blockReason;
  // A cancelled ticket stops being a dependency: the tickets that waited on it no longer wait.
  const pruned = to === 'cancelled' ? pruneCancelledDeps(ledger).pruned : [];
  ledger.updatedAt = new Date(now).toISOString();
  await writeLedger(root, ledger);
  await appendLog(root, { event: 'transition', id, from, to, by, note: note ?? null });
  await logPrune(root, pruned, { cancelled: id, by }, now);
  return ticket;
}

// Logs a prune and leaves a non-blocking note in the inbox naming the tickets that lost a dependency (close it with swarm done ID).
export async function logPrune(root, pruned, { cancelled, by } = {}, now = Date.now()) {
  if (!pruned.length) return;
  await appendLog(root, { event: 'prune-deps', ...(cancelled ? { cancelled } : {}), ...(by ? { by } : {}), tickets: pruned.map(p => p.id) });
  const list = pruned.map(p => `${p.id} (no longer waits on ${p.removed.join(', ')})`).join('; ');
  try {
    await appendEvent(root, { kind: 'human', id: `prune-${pruned[0].id}-${now}`, title: `FYI, no action needed: a cancelled ticket was dropped as a dependency of ${list}`, steps: [], unblocks: 0 }, { now: () => now });
  } catch { /* the note is a courtesy; the prune and its log line already happened */ }
}

// Takes every cancelled ticket out of the dependsOn of the others (in place). The owner's approval stays valid when it was valid just
// before: removing a dependency on a cancelled ticket only makes a ticket less blocked, and the seal is renewed over the new set.
export function pruneCancelledDeps(ledger) {
  const tickets = ledger?.tickets ?? [];
  const cancelled = new Set(tickets.filter(t => t.status === 'cancelled').map(t => t.id));
  const wasApproved = isApproved(ledger);
  const pruned = [];
  for (const t of tickets) {
    const removed = (t.dependsOn ?? []).filter(d => cancelled.has(d));
    if (!removed.length) continue;
    t.dependsOn = t.dependsOn.filter(d => !cancelled.has(d));
    pruned.push({ id: t.id, removed });
  }
  if (pruned.length && wasApproved) {
    const prev = ledger.approved;
    ledger.approved = { ...prev, ...approveLedger(ledger, { by: prev.by }).approved, at: prev.at };
  }
  return { ledger, pruned };
}

export function readyTickets(tickets) {
  const done = new Set(tickets.filter(t => t.status === 'done').map(t => t.id));
  return tickets
    .filter(t => (t.status === 'todo' || t.status === 'ready') && (t.dependsOn ?? []).every(d => done.has(d)))
    .sort(byId);
}

export function wavesOf(tickets) {
  const active = tickets.filter(t => t.status !== 'cancelled');
  const ids = new Set(active.map(t => t.id));
  const placed = new Set();
  const waves = [];
  let remaining = active;
  while (remaining.length) {
    const wave = remaining.filter(t => (t.dependsOn ?? []).every(d => !ids.has(d) || placed.has(d)));
    if (!wave.length) throw fail('ticket-cycle', `dependency cycle among: ${remaining.map(t => t.id).sort().join(', ')}`);
    const waveIds = wave.map(t => t.id).sort();
    waves.push(waveIds);
    for (const id of waveIds) placed.add(id);
    const inWave = new Set(waveIds);
    remaining = remaining.filter(t => !inWave.has(t.id));
  }
  return waves;
}

export function filterTickets(tickets, { stage, status, type, risk, requirement, file } = {}) {
  return tickets.filter(t =>
    (none(stage) || t.stage === stage) &&
    (none(status) || t.status === status) &&
    (none(type) || t.type === type) &&
    (none(risk) || t.risk === risk) &&
    (none(requirement) || (t.scopeRefs ?? []).includes(requirement)) &&
    (none(file) || (t.files ?? []).includes(file)));
}

// A requirement that has build tickets is wired when one of them is an integration ticket (it mounts the modules in real routes or
// pages and has a route-level test). Only ledgers made with the wiring rule (ledger.wiring) are held to it.
export function requirementWired(ledger, reqId) {
  if (!ledger?.wiring) return true;
  return wiringGaps(ledger.tickets ?? [], [reqId]).length === 0;
}

export function ledgerStats(ledger) {
  const tickets = ledger?.tickets ?? [];
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  const byStage = {};
  for (const t of tickets) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const key = t.stage ?? 'none';
    byStage[key] ??= { total: 0, done: 0 };
    byStage[key].total++;
    if (t.status === 'done') byStage[key].done++;
  }
  const live = tickets.filter(t => t.status !== 'cancelled');
  const percentDone = live.length ? Math.round(100 * live.filter(t => t.status === 'done').length / live.length) : 0;
  let coveragePct = null;
  if (Array.isArray(ledger?.requirements)) {
    const reqIds = ledger.requirements.map(r => (typeof r === 'string' ? r : r.id));
    const covered = reqIds.filter(id => {
      const refs = live.filter(t => (t.scopeRefs ?? []).includes(id));
      return refs.length > 0 && refs.every(t => t.status === 'done') && requirementWired(ledger, id);
    }).length;
    coveragePct = reqIds.length ? Math.round(100 * covered / reqIds.length) : 100;
  }
  return { total: tickets.length, byStatus, byStage, percentDone, coveragePct };
}

export function renderBuildPlan(ledger, scope) {
  const tickets = ledger?.tickets ?? [];
  const stats = ledgerStats(ledger);
  const name = scope?.name ?? ledger?.scope?.name ?? 'untitled';
  const version = scope?.version ?? ledger?.scope?.version ?? 1;
  const cell = s => String(s ?? '').replace(/\s+/g, ' ').split('|').join('/');
  const live = tickets.filter(t => t.status !== 'cancelled');
  const out = ['# Build plan', '', `Scope: ${cell(name)} (version ${version})`, `Progress: ${stats.percentDone}% done of ${live.length} live tickets`];
  if (stats.coveragePct !== null) out.push(`Requirement coverage: ${stats.coveragePct}%`);
  out.push(`Tickets: ${stats.total} total (${STATUSES.map(s => `${s} ${stats.byStatus[s] ?? 0}`).join(', ')})`);
  const cos = ledger?.changeOrders ?? [];
  out.push(`Change orders: ${cos.length}${cos.length ? ' (' + cos.map(c => c.id).join(', ') + ')' : ''}`, '');
  const stageList = Array.isArray(scope?.stages) ? scope.stages.map(s => ({ id: s.id, title: s.title ?? '' })) : [];
  for (const id of [...new Set(tickets.map(t => t.stage ?? 'none'))].sort()) if (!stageList.some(s => s.id === id)) stageList.push({ id, title: '' });
  for (const st of stageList) {
    const rows = tickets.filter(t => (t.stage ?? 'none') === st.id);
    out.push(`## ${cell(st.id)} ${cell(st.title)}`.trimEnd(), '', '| Ticket | Title | Status | Risk |', '| --- | --- | --- | --- |');
    for (const t of rows) out.push(`| ${cell(t.id)} | ${cell(t.title)} | ${t.status} | ${t.risk} |`);
    if (!rows.length) out.push('_No tickets._');
    out.push('');
  }
  const reqs = Array.isArray(scope?.requirements)
    ? scope.requirements.map(r => ({ id: r.id, text: r.text ?? '' }))
    : Array.isArray(ledger?.requirements)
      ? ledger.requirements.map(r => (typeof r === 'string' ? { id: r, text: '' } : { id: r.id, text: r.text ?? '' }))
      : [];
  if (reqs.length) {
    out.push('## Requirements', '', '| R | Text | Tickets | State |', '| --- | --- | --- | --- |');
    for (const r of reqs) {
      const refs = live.filter(t => (t.scopeRefs ?? []).includes(r.id));
      const done = refs.filter(t => t.status === 'done').length;
      const state = refs.length && done === refs.length && !requirementWired(ledger, r.id) ? 'unwired' : refs.length && done === refs.length ? 'done' : done || refs.some(t => t.status === 'running' || t.status === 'review') ? 'partial' : 'missing';
      out.push(`| ${cell(r.id)} | ${cell(r.text)} | ${refs.map(t => t.id).join(', ') || '-'} | ${state} |`);
    }
  }
  return out.join('\n') + '\n';
}

export function approveLedger(ledger, { by = 'owner', now = Date.now() } = {}) {
  return {
    ...ledger,
    approved: {
      at: new Date(now).toISOString(),
      by,
      scopeHash: ledger?.scope?.hash ?? null,
      ticketsHash: ticketSetHash(ledger?.tickets ?? []),
    },
  };
}

export function isApproved(ledger) {
  const a = ledger?.approved;
  return Boolean(a?.at) &&
    a.scopeHash === (ledger?.scope?.hash ?? null) &&
    typeof a.ticketsHash === 'string' &&
    a.ticketsHash === ticketSetHash(ledger?.tickets ?? []);
}

// SPDX-License-Identifier: Apache-2.0
import { wavesOf } from './tickets.mjs';

const DEFAULT_RATES = { perTicketMinutes: 2, usdPerTicket: 0.003, parallel: 64 };
const LARGE_WAVE = 200;
const NEEDS_ACCEPTANCE = new Set(['build', 'test', 'migration']);
const NO_REF_TYPES = new Set(['human', 'contract']);
const isFolder = (f) => typeof f === 'string' && f.endsWith('/');
const activeOf = (tickets) => tickets.filter((t) => t && t.status !== 'cancelled');
const listOf = (ids, n = 10) => ids.slice(0, n).join(', ') + (ids.length > n ? ` and ${ids.length - n} more` : '');
const countsOf = (items, key) => items.reduce((acc, t) => { const k = t[key] ?? 'none'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});

function findCycles(active, ids) {
  const indeg = new Map();
  const rev = new Map();
  for (const t of active) { indeg.set(t.id, 0); rev.set(t.id, []); }
  for (const t of active) {
    for (const d of new Set(Array.isArray(t.dependsOn) ? t.dependsOn : [])) {
      if (!ids.has(d)) continue;
      indeg.set(t.id, indeg.get(t.id) + 1);
      rev.get(d).push(t.id);
    }
  }
  const queue = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.pop();
    seen++;
    for (const next of rev.get(id)) {
      const n = indeg.get(next) - 1;
      indeg.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  return seen === active.length ? [] : [[...indeg].filter(([, n]) => n > 0).map(([id]) => id)];
}

function computeWaves(active, ids) {
  try {
    return wavesOf(active.map((t) => ({ ...t, dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).filter((d) => ids.has(d)) })));
  } catch {
    return null;
  }
}

function findConflicts(active, waves) {
  const out = [];
  if (!waves) return out;
  const byId = new Map(active.map((t) => [t.id, t]));
  const seen = new Set();
  waves.forEach((wave, wi) => {
    const ts = wave.map((id) => byId.get(id)).filter(Boolean);
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        for (const fa of [...(ts[i].files || []), ...(ts[i].deletes || [])]) {
          for (const fb of [...(ts[j].files || []), ...(ts[j].deletes || [])]) {
            let file = null;
            if (fa === fb) file = fa;
            else if (isFolder(fa) && fb.startsWith(fa)) file = fa;
            else if (isFolder(fb) && fa.startsWith(fb)) file = fb;
            if (!file) continue;
            const pair = [ts[i].id, ts[j].id].sort();
            const key = `${wi}|${file}|${pair.join('|')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ wave: wi, file, tickets: pair });
          }
        }
      }
    }
  });
  return out;
}

export function checkTicketTree({ scope, tickets = [], sizeBudget } = {}) {
  const reqs = Array.isArray(scope?.requirements) ? scope.requirements : [];
  const reqIds = new Set(reqs.map((r) => r.id));
  const allIds = new Map();
  for (const t of tickets) allIds.set(t.id, (allIds.get(t.id) || 0) + 1);
  const active = activeOf(tickets);
  const ids = new Set(active.map((t) => t.id));
  const errors = [];
  const warnings = [];
  const covered = new Set();
  const untraced = [];
  const badRefs = [];
  const missingAcceptance = [];
  const unknownDeps = [];
  const oversize = [];

  for (const [id, n] of allIds) if (n > 1) errors.push({ code: 'duplicate-id', message: `ticket id ${id} appears ${n} times`, ids: [id] });

  for (const t of active) {
    const refs = Array.isArray(t.scopeRefs) ? t.scopeRefs : [];
    const good = refs.filter((r) => reqIds.has(r));
    for (const r of good) covered.add(r);
    for (const r of refs) if (!reqIds.has(r)) badRefs.push({ ticket: t.id, ref: r });
    if (!NO_REF_TYPES.has(t.type) && t.origin !== 'ci' && good.length === 0) untraced.push(t.id);
    if (NEEDS_ACCEPTANCE.has(t.type) && !(Array.isArray(t.acceptance) && t.acceptance.some((x) => typeof x === 'string' && x.trim()))) missingAcceptance.push(t.id);
    for (const d of Array.isArray(t.dependsOn) ? t.dependsOn : []) if (!allIds.has(d)) unknownDeps.push({ ticket: t.id, dep: d });
    if (!['S', 'M'].includes(t.size)) oversize.push(t.id);
  }

  const uncovered = reqs.map((r) => r.id).filter((id) => !covered.has(id));
  const coveragePct = reqs.length ? Math.round((covered.size * 100) / reqs.length) : 0;

  if (sizeBudget && sizeBudget.maxMediumPerStage != null) {
    const perStage = new Map();
    for (const t of active) {
      if (t.size !== 'M') continue;
      const list = perStage.get(t.stage) || [];
      list.push(t.id);
      perStage.set(t.stage, list);
    }
    for (const list of perStage.values()) {
      for (const id of list.slice(sizeBudget.maxMediumPerStage)) if (!oversize.includes(id)) oversize.push(id);
    }
  }

  const cycles = findCycles(active, ids);
  const waves = cycles.length ? null : computeWaves(active, ids);
  if (!cycles.length && !waves) warnings.push({ code: 'waves-unavailable', message: 'could not compute waves; conflict check skipped' });
  const conflicts = findConflicts(active, waves);

  if (uncovered.length) errors.push({ code: 'uncovered', message: `${uncovered.length} requirement(s) not covered by any ticket: ${listOf(uncovered)}`, ids: uncovered });
  if (untraced.length) errors.push({ code: 'untraced', message: `${untraced.length} ticket(s) reference no real requirement: ${listOf(untraced)}`, ids: untraced });
  if (badRefs.length) errors.push({ code: 'bad-ref', message: `${badRefs.length} ticket reference(s) to unknown requirements`, refs: badRefs });
  if (missingAcceptance.length) errors.push({ code: 'missing-acceptance', message: `${missingAcceptance.length} ticket(s) lack acceptance criteria: ${listOf(missingAcceptance)}`, ids: missingAcceptance });
  if (unknownDeps.length) errors.push({ code: 'unknown-dep', message: `${unknownDeps.length} dependency reference(s) to unknown tickets`, deps: unknownDeps });
  if (cycles.length) errors.push({ code: 'cycle', message: `dependency cycle among: ${listOf(cycles[0])}`, ids: cycles[0] });
  if (conflicts.length) {
    // Name the exact tickets and file, so the fix is one dependsOn (or one file move), not a search.
    const title = id => { const t = active.find(x => x.id === id); return t ? `${id} "${String(t.title ?? '').slice(0, 50)}"` : id; };
    const detail = conflicts.slice(0, 6).map(c => `${c.tickets.map(title).join(' and ')} both write ${c.file} (wave ${c.wave + 1})`);
    errors.push({ code: 'conflict', message: `${conflicts.length} file ownership conflict(s) within a wave: ${detail.join('; ')}${conflicts.length > 6 ? `; and ${conflicts.length - 6} more` : ''}. Make one wait for the other (dependsOn) or give them different files.`, conflicts });
  }
  if (oversize.length) errors.push({ code: 'oversize', message: `${oversize.length} ticket(s) over the size budget or not S/M: ${listOf(oversize)}`, ids: oversize });

  return { ok: errors.length === 0, errors, warnings, coveragePct, uncovered, untraced, missingAcceptance, badRefs, unknownDeps, cycles, conflicts, oversize };
}

export function summarizeTree({ scope, tickets = [], rates = {} } = {}) {
  const r = { ...DEFAULT_RATES, ...rates };
  const active = activeOf(tickets);
  const ids = new Set(active.map((t) => t.id));
  const check = checkTicketTree({ scope, tickets });
  const waves = computeWaves(active, ids);
  const reqs = Array.isArray(scope?.requirements) ? scope.requirements : [];
  const stages = (Array.isArray(scope?.stages) ? scope.stages : []).map((s) => ({
    id: s.id,
    title: s.title,
    tickets: active.filter((t) => t.stage === s.id).length,
    requirements: reqs.filter((q) => q.stage === s.id).length,
  }));
  const n = active.length;
  const dependedOn = new Set(active.flatMap((t) => (Array.isArray(t.dependsOn) ? t.dependsOn : [])));
  const humanBlocking = active.filter((t) => t.type === 'human' && dependedOn.has(t.id)).map((t) => t.id);
  const sensitiveTickets = active.filter((t) => t.sensitive === true).length;
  const humanTickets = active.filter((t) => t.type === 'human').length;
  const waveCount = waves ? waves.length : 0;
  const minutes = waveCount * r.perTicketMinutes + Math.ceil(n / r.parallel) * r.perTicketMinutes;
  const usd = Math.round(n * r.usdPerTicket * 10000) / 10000;
  const risks = [];
  if (check.uncovered.length) risks.push(`${check.uncovered.length} requirement(s) have no ticket: ${listOf(check.uncovered)}`);
  if (humanBlocking.length) risks.push(`${humanBlocking.length} human ticket(s) block other work: ${listOf(humanBlocking)}`);
  if (sensitiveTickets) risks.push(`${sensitiveTickets} sensitive ticket(s) need careful review`);
  if (waves) waves.forEach((w, i) => { if (w.length > LARGE_WAVE) risks.push(`wave ${i + 1} has ${w.length} tickets (over ${LARGE_WAVE})`); });
  if (check.errors.length) risks.push(`${check.errors.length} integrity error(s) to resolve before approval`);
  return {
    stages,
    tickets: n,
    byType: countsOf(active, 'type'),
    byRisk: countsOf(active, 'risk'),
    coveragePct: check.coveragePct,
    waves: waveCount,
    humanTickets,
    sensitiveTickets,
    estimate: { minutes, usd },
    risks,
  };
}

export function formatSummary(summary) {
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const lines = [
    `Tickets: ${summary.tickets} in ${summary.waves} waves`,
    `Coverage: ${summary.coveragePct}%`,
    `Estimate: about ${summary.estimate.minutes} minutes, $${Number(summary.estimate.usd).toFixed(2)}`,
    `Human tickets: ${summary.humanTickets}; sensitive: ${summary.sensitiveTickets}`,
    `By type: ${fmt(summary.byType)}`,
    `By risk: ${fmt(summary.byRisk)}`,
    '',
    'Stages:',
    ...summary.stages.map((s) => `  ${s.id} ${s.title}: ${s.tickets} tickets, ${s.requirements} requirements`),
    '',
    'Risks:',
    ...(summary.risks.length ? summary.risks.map((x) => `  ${x}`) : ['  none']),
  ];
  return lines.slice(0, 40).join('\n');
}

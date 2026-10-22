// SPDX-License-Identifier: Apache-2.0
// The Orchestrator lane on the board: the Claude Code sessions driving each project, built from the hook events (tools/orchestrator-events.mjs) and the session transcripts
// (tools/orchestrator-usage.mjs). Read-only. A subscription session is shown at list value and marked so; it is never added to what was billed.
import path from 'node:path';
import os from 'node:os';
import { readEvents, sessionsOf, handBuiltOf } from './orchestrator-events.mjs';
import { sessionUsage, combinedUsage } from './orchestrator-usage.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';
import { chatUrlFor } from './orchestrator-chat.mjs';
import { externalSessionsForProjectSync, externalCostFromSessions } from './external-orchestrators.mjs';

const txt = (v, n) => (v === null || v === undefined ? null : sanitizeWorkerText(v, n));

export function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : true; }
}

/** Distinct files the swarm's finished jobs wrote in this project. */
export function swarmBuiltFiles(runs) {
  const files = new Set();
  for (const { state } of runs ?? []) for (const job of state?.jobs ?? []) {
    if (!job || job.status !== 'complete') continue;
    for (const f of Array.isArray(job.outputs) ? job.outputs : Array.isArray(job.files) ? job.files : []) if (typeof f === 'string' && f && !f.endsWith('/')) files.add(f);
  }
  return files;
}

/** { sessions, handBuilt, swarmBuilt, swarmPct, listUsd } for one project; `runs` are its run states (swarmBuiltFiles). */
export function projectOrchestrator(project, { runs = [], now = Date.now(), usage = sessionUsage, isAlive = defaultIsAlive, chatUrl = chatUrlFor, externalSessions = null } = {}) {
  const events = readEvents(project.root);
  const all = sessionsOf(events, now, { isAlive, host: os.hostname() });
  const claudeSessions = all.filter(s => s.shown).map(s => {
    const u = s.transcript ? usage(s.transcript, { now }) : null;
    const fullSessionId = typeof s.id === 'string' ? s.id : '';
    let sessionChatUrl = null;
    try { sessionChatUrl = chatUrl(fullSessionId) ?? null; } catch { sessionChatUrl = null; }
    return {
      id: fullSessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8), chatUrl: sessionChatUrl, project: txt(project.name, 80), projectId: project.id, state: s.state, lastAt: s.lastAt, since: s.since, endedAt: s.endedAt,
      doing: s.doing ? { tool: txt(s.doing.tool, 40), file: s.doing.file ? txt(s.doing.file, 120) : null, command: s.doing.command ? txt(s.doing.command, 80) : null, startedAt: s.doing.startedAt } : null,
      edits: s.edits, handBuilt: s.handBuilt, blocked: s.blocked,
      tool: 'claude',
      tokensToday: u?.todayTokens ?? null, listUsdToday: u?.todayListUsd ?? null, tokensAll: u?.allTokens ?? null, listUsdAll: u?.allListUsd ?? null, unpriced: Boolean(u?.unpricedTokens), models: u?.models ?? [],
    };
  });
  const external = externalSessions ?? externalSessionsForProjectSync(project, { now, env: process.env, home: os.homedir() });
  const sessions = [...claudeSessions, ...external]
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
    .slice(0, 8);
  // Cost counts every session the log knows (also ones no longer shown), each message once.
  const transcripts = [...new Set(all.map(x => x.transcript).filter(Boolean))];
  const c = transcripts.length ? combinedUsage(transcripts, { now }) : { todayListUsd: 0, allListUsd: 0, todayTokens: 0, allTokens: 0 };
  const extCost = externalCostFromSessions(external);
  const todayUsd = c.todayListUsd, allUsd = c.allListUsd, todayTokens = c.todayTokens + extCost.todayTokens, allTokens = c.allTokens + extCost.allTokens;
  const hand = handBuiltOf(events);
  const swarm = swarmBuiltFiles(runs).size;
  const total = swarm + hand.files;
  return {
    sessions,
    handBuilt: { files: hand.files, edits: hand.edits, blocked: hand.blocked, list: hand.list.map(f => txt(f, 120)) },
    swarmBuilt: { files: swarm },
    swarmPct: total ? Math.round((swarm * 100) / total) : null,
    handPct: total ? Math.round((hand.files * 100) / total) : null,
    transcripts,
    cost: {
      todayListUsd: Math.round(todayUsd * 1e6) / 1e6, allListUsd: Math.round(allUsd * 1e6) / 1e6, todayTokens, allTokens,
      todayCostUsdReported: extCost.todayReportedUsd, allCostUsdReported: extCost.allReportedUsd,
      kind: 'list value (subscription: not billed)',
    },
  };
}


// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { openItems } from './journal.mjs';

const MAX_BYTES = 4096;
const LIVE = ['running', 'queued', 'paused'];
const AGENTS = {
  codex: 'Read AGENTS.md. Run swarm commands through the swarm command.',
  cursor: 'Read .cursor/rules/project-swarm.mdc.',
  claude: 'Read CLAUDE.md.',
  gemini: 'Read GEMINI.md.',
};

export const DEFAULT_RULES = [
  'Route cheapest first: Haiku (anthropic), Cursor, Codex; Claude only after two failures; Hermes only for research; OpenRouter only for non-sensitive bookkeeping.',
  "Never merge to main, deploy, raise a spend cap or add a paid service without the owner's explicit OK.",
  'Never send secrets or .env files to a worker; sensitive jobs never go to OpenRouter, OpenAI, Gemini or Lambda.',
  'Workers run on the installed runner; update the runner only after the owner merges.',
  'Record decisions with swarm note "<text>".',
];

function clipText(text, width) {
  return text.length > width ? text.slice(0, width - 1) + '…' : text;
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nowOf(now) {
  return typeof now === 'function' ? now() : Number(now);
}

export async function loadRuns(root, { limit = 10 } = {}) {
  const directory = path.join(root, '.swarm', 'runs');
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let state;
    try {
      state = JSON.parse(await fs.readFile(path.join(directory, entry.name, 'state.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const jobs = state.jobs && typeof state.jobs === 'object' ? Object.values(state.jobs) : [];
    const costs = jobs.map(job => numberOrNull(job?.costUsd)).filter(value => value !== null);
    runs.push({
      id: state.id ?? entry.name,
      status: state.status ?? null,
      startedAt: state.startedAt ?? null,
      finishedAt: state.finishedAt ?? null,
      counts: state.summary?.counts ?? null,
      costUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
      pause: state.pause ?? null,
      integrated: Boolean(state.integratedFiles?.length) || state.integrated === true,
      sortTime: timeOf(state.startedAt),
      name: entry.name,
    });
  }
  runs.sort((a, b) => {
    if (a.sortTime !== null && b.sortTime !== null && a.sortTime !== b.sortTime) return b.sortTime - a.sortTime;
    if (a.name === b.name) return 0;
    return a.name < b.name ? 1 : -1;
  });
  return runs.slice(0, Math.max(0, limit)).map(({ sortTime, name, ...run }) => run);
}

export function buildBrief({ root, events = [], runs = [], rules, now = Date.now } = {}) {
  const list = Array.isArray(events) ? events : [];
  const runList = Array.isArray(runs) ? runs : [];
  const nowMs = nowOf(now);
  const newestFirst = [...list].reverse();
  const goalEvent = newestFirst.find(event => event?.kind === 'goal') ?? null;

  const done = [];
  for (const event of newestFirst) {
    if (done.length >= 8) break;
    if (event?.kind === 'integration' && ['complete', 'integrated'].includes(event.status)) {
      done.push(oneLine(`run ${event.run} integrated, ${event.files ?? 0} files`));
    } else if (event?.kind === 'pr' && event.status === 'merged') {
      done.push(oneLine(`PR ${event.number ?? event.url ?? 'unknown'} merged`));
    }
  }

  const running = runList
    .filter(run => LIVE.includes(run?.status) && ['running', 'queued', 'paused'].includes(run.status))
    .slice(0, 5)
    .map(run => ({ id: run.id, status: run.status, counts: run.counts ?? null, ...(run.pause ? { pause: run.pause } : {}) }));

  const allOpen = openItems(list);
  const open = allOpen.slice(0, 6).map(item => ({
    id: item.id,
    kind: item.kind,
    text: item.text,
    ...(item.steps === undefined ? {} : { steps: item.steps }),
  }));

  const next = [];
  const add = command => {
    if (command && next.length < 3 && !next.includes(command)) next.push(command);
  };
  const liveRun = runList.find(run => run?.status === 'running');
  if (liveRun) add(`swarm monitor ${liveRun.id} --watch`);
  for (const run of runList) {
    if (run?.status !== 'paused' || !run.pause) continue;
    const reasons = Array.isArray(run.pause.reasons) ? run.pause.reasons : [];
    const until = timeOf(run.pause.until);
    if (reasons.some(reason => reason === 'run-cap' || reason === 'lane-cap')) {
      add('swarm brief');
    } else if (reasons.length && reasons.every(reason => reason === 'quota')) {
      if (until !== null && until > nowMs) add(`swarm wait ${run.id}`);
      else add(`swarm resume ${run.id} --wait`);
    }
  }
  const complete = runList.find(run => run?.status === 'complete' && !run.integrated);
  if (complete) add(`swarm integrate ${complete.id} --queue`);
  const failed = runList.find(run => ['failed', 'cancelled'].includes(run?.status));
  if (failed) add(`swarm inspect ${failed.id} --results`);
  if (!goalEvent) add('swarm "describe the goal in one sentence"');
  if (allOpen.some(item => item.kind === 'human' || item.kind === 'blocker')) add('swarm brief');
  for (const fallback of ['swarm status', 'swarm board', 'swarm doctor all']) add(fallback);

  return {
    root: root ?? null,
    goal: goalEvent ? oneLine(goalEvent.text) : null,
    doneWhen: goalEvent?.doneWhen ? oneLine(goalEvent.doneWhen) : null,
    done,
    running,
    open,
    next,
    rules: Array.isArray(rules) ? rules : DEFAULT_RULES,
  };
}

function countsText(counts) {
  if (!counts || typeof counts !== 'object') return '';
  const parts = Object.entries(counts).map(([name, value]) => `${name} ${value}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function layout(brief, doneN, runN, openN, width) {
  const line = text => clipText(oneLine(text), width);
  const section = (title, rows) => (rows.length ? [title, ...rows] : [`${title} none`]);
  const out = ['Project Swarm brief', line(`Goal: ${brief.goal ?? 'none'}`)];
  if (brief.doneWhen) out.push(line(`Done when: ${brief.doneWhen}`));
  if (brief.tickets) out.push(line(`Tickets: ${brief.tickets.percentDone}% done of ${brief.tickets.total} (${Object.entries(brief.tickets.byStatus ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')})`));
  out.push(...section('Done:', brief.done.slice(0, doneN).map(text => line(`  - ${text}`))));
  out.push(...section('Running:', brief.running.slice(0, runN).map(run => {
    const reasons = Array.isArray(run.pause?.reasons) ? ` [${run.pause.reasons.map(String).join(', ')}]` : '';
    return line(`  - ${run.id} ${run.status}${countsText(run.counts)}${reasons}`);
  })));
  out.push(...section('Needs the owner:', brief.open.slice(0, openN).map(item => line(`  - ${item.id} (${item.kind}): ${item.text}`))));
  out.push('Next 3 actions:');
  brief.next.forEach((command, index) => out.push(line(`  ${index + 1}. ${command}`)));
  out.push(...section('Rules:', brief.rules.map(rule => line(`  - ${rule}`))));
  return out.join('\n');
}

export function renderBrief(brief) {
  let doneN = brief.done.length;
  let runN = brief.running.length;
  let openN = brief.open.length;
  let width = Infinity;
  let text = layout(brief, doneN, runN, openN, width);
  while (Buffer.byteLength(text) > MAX_BYTES) {
    if (doneN > 0) doneN -= 1;
    else if (runN > 0) runN -= 1;
    else if (openN > 0) openN -= 1;
    else if (width > 160) width = 160;
    else break;
    text = layout(brief, doneN, runN, openN, width);
  }
  while (Buffer.byteLength(text) > MAX_BYTES) text = text.slice(0, -1);
  return text;
}

export function renderHandoff(brief) {
  return [
    '<!-- generated by swarm; do not edit: regenerated from .swarm/project/journal.ndjson -->',
    '',
    '# Project Swarm handoff',
    '',
    '```text',
    renderBrief(brief),
    '```',
    '',
  ].join('\n');
}

export function renderAgentHandoff(brief, agent) {
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`handoff-agent-invalid: ${agent}`);
  return [
    'You are now the orchestrator for this project. The previous orchestrator handed over; read this brief first.',
    '',
    renderBrief(brief),
    '',
    AGENTS[agent],
    '',
  ].join('\n');
}

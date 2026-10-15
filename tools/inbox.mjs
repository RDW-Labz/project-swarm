// SPDX-License-Identifier: Apache-2.0
import { appendEvent as unusedAppend, readJournal as unusedRead, openItems, sanitizeText } from './journal.mjs';

function nowOf(now) {
  return typeof now === 'function' ? now() : Number(now ?? Date.now());
}

function ageMs(since, ms) {
  const t = Date.parse(since);
  return Number.isFinite(t) ? Math.max(0, ms - t) : 0;
}

function formatAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function compare(a, b) {
  if (b.unblocks !== a.unblocks) return b.unblocks - a.unblocks;
  return (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0);
}

function stepsOf(steps) {
  return Array.isArray(steps) ? steps.map(step => sanitizeText(step)) : [];
}

export function dependentsCount(jobs, jobId) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  const reverse = new Map();
  for (const job of jobs) {
    for (const dep of job.after ?? []) {
      if (!reverse.has(dep)) reverse.set(dep, []);
      reverse.get(dep).push(job.id);
    }
  }
  const seen = new Set([jobId]);
  const queue = [jobId];
  let count = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of reverse.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      const job = byId.get(next);
      if (job && job.status !== 'complete') count += 1;
    }
  }
  return count;
}

export function openDecisions(events) {
  const latest = new Map();
  for (const event of events) {
    if (event?.kind === 'decision' && event.id !== undefined && event.id !== null) {
      latest.set(String(event.id), event);
    }
  }
  return [...latest.values()].filter(event => event.confirm === true && event.confirmed !== true);
}

function humanItems(root, runs, ms) {
  const items = [];
  for (const run of runs) {
    const jobs = run.jobs ?? [];
    for (const job of jobs) {
      if (job.heldReason !== 'human' || job.status === 'complete') continue;
      items.push({
        id: `${run.id}:${job.id}`,
        kind: 'human',
        project: root,
        title: sanitizeText(job.title ?? job.id),
        steps: stepsOf(job.steps),
        unblocks: dependentsCount(jobs, job.id),
        since: job.heldAt ?? run.startedAt ?? new Date(ms).toISOString(),
        run: run.id,
        job: job.id,
      });
    }
  }
  return items;
}

function journalItems(root, events, ms) {
  const items = [];
  for (const event of openItems(events)) {
    const id = String(event.id);
    const since = event.ts ?? new Date(ms).toISOString();
    if (event.kind === 'human') {
      items.push({
        id,
        kind: 'human',
        project: root,
        title: sanitizeText(event.title ?? event.text ?? id),
        steps: stepsOf(event.steps),
        unblocks: Number.isFinite(event.unblocks) ? event.unblocks : 0,
        since,
      });
    } else if (event.kind === 'blocker') {
      items.push({
        id,
        kind: 'blocker',
        project: root,
        title: sanitizeText(event.text ?? event.title ?? id),
        steps: [],
        unblocks: 0,
        since,
      });
    }
  }
  for (const event of openDecisions(events)) {
    const item = {
      id: String(event.id),
      kind: 'decision',
      project: root,
      title: sanitizeText(event.text ?? String(event.id)),
      steps: [],
      unblocks: 0,
      since: event.ts ?? new Date(ms).toISOString(),
    };
    if (Array.isArray(event.options)) item.choices = event.options.map(option => String(option));
    if (event.choice !== undefined) item.default = String(event.choice);
    items.push(item);
  }
  return items;
}

export async function collectInbox(roots, deps) {
  const { listRuns, readState, readJournal, now, onNote } = deps;
  const ms = nowOf(now);
  const items = [];
  for (const root of roots) {
    try {
      const runIds = await listRuns(root);
      const runs = [];
      for (const id of runIds) {
        const run = await readState(root, id);
        if (run) runs.push({ ...run, id: run.id ?? id });
      }
      const events = await readJournal(root, { limit: Infinity });
      items.push(...humanItems(root, runs, ms), ...journalItems(root, events, ms));
    } catch (error) {
      if (onNote) onNote(`skipped ${root}: ${sanitizeText(error.message)}`);
    }
  }
  return items.sort(compare);
}

function closeCommand(item, root) {
  const swarm = root && item.project && item.project !== root ? `swarm --root ${item.project}` : 'swarm';
  if (item.kind === 'human') return `close: ${swarm} done ${item.id}`;
  if (item.kind === 'decision') {
    const choice = item.default ?? item.choices?.[0] ?? 'CHOICE';
    return `close: ${swarm} decide ${item.id} ${choice}`;
  }
  return 'close: resolve the blocker, then run swarm inbox again';
}

export function formatInbox(items, { now, root } = {}) {
  if (items.length === 0) return 'Nothing needs you.';
  const ms = nowOf(now);
  return [...items].sort(compare).map(item => {
    const lines = [`[${item.kind}] ${item.id} - ${item.title}`];
    lines.push(`  unblocks ${item.unblocks} waiting ${formatAge(ageMs(item.since, ms))}`);
    if (item.project) lines.push(`  project: ${item.project}`);
    (item.steps ?? []).forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
    lines.push(`  ${closeCommand(item, root)}`);
    return lines.join('\n');
  }).join('\n\n');
}

function recomputeReasons(run) {
  const others = (run.pause?.reasons ?? []).filter(reason => reason !== 'human');
  const stillHuman = (run.jobs ?? []).some(job => job.heldReason === 'human' && job.status !== 'complete');
  return stillHuman ? [...others, 'human'] : others;
}

export async function markDone(root, ref, deps) {
  const { readState, writeRun, readJournal, appendEvent, now } = deps;
  const text = String(ref ?? '');
  const events = await readJournal(root, { limit: Infinity });
  const journalItem = openItems(events).find(event => event.kind === 'human' && String(event.id) === text);
  if (journalItem) {
    await appendEvent(root, { kind: 'human', id: journalItem.id, done: true }, { now });
    return { id: text, kind: 'human' };
  }
  const sep = text.indexOf(':');
  if (sep <= 0) throw new Error(`inbox-unknown: ${text}`);
  const runId = text.slice(0, sep);
  const jobId = text.slice(sep + 1);
  const run = await readState(root, runId);
  const job = run ? (run.jobs ?? []).find(item => item.id === jobId) : undefined;
  if (!job) throw new Error(`inbox-unknown: ${text}`);
  if (job.status === 'complete') throw new Error(`inbox-already-done: ${text}`);
  if (job.heldReason !== 'human') throw new Error(`inbox-not-human: ${text}`);
  job.status = 'complete';
  delete job.heldReason;
  delete job.error;
  job.human = { doneAt: new Date(nowOf(now)).toISOString(), by: 'owner' };
  run.pause = { ...(run.pause ?? {}), reasons: recomputeReasons(run) };
  await writeRun(root, run);
  await appendEvent(root, { kind: 'human', id: text, done: true, run: runId, job: jobId }, { now });
  return { id: text, kind: 'human' };
}

export async function decide(root, ref, choice, deps) {
  const { readJournal, appendEvent, addGoal, now } = deps;
  const id = String(ref ?? '');
  const picked = String(choice ?? '').trim();
  if (picked === '') throw new Error('inbox-choice-invalid: empty choice');
  const events = await readJournal(root, { limit: Infinity });
  const item = openDecisions(events).find(event => String(event.id) === id);
  if (!item) throw new Error(`inbox-unknown: ${id}`);
  if (Array.isArray(item.options) && !item.options.map(String).includes(picked)) {
    throw new Error(`inbox-choice-invalid: ${picked}`);
  }
  const changed = picked !== String(item.choice);
  let goal = null;
  // The change goal is queued first, so a full backlog leaves the decision open instead of closing it unrecorded.
  if (changed) {
    goal = `Change decision ${id} to ${picked}`;
    await addGoal(root, { goal, paths: [] }, { now });
  }
  await appendEvent(root, { kind: 'decision', id, confirmed: true, choice: picked, text: sanitizeText(item.text ?? '') }, { now });
  return { id, choice: picked, changed, goal };
}

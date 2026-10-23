// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, readJournal, openItems, safeWritableDir, assertRegularOrMissing, sanitizeText } from './journal.mjs';

export const HANDOFF_FILE = 'orchestrator-handoff.json';

const HANDOFF_LIMIT = 40;

function clipList(list, limit = HANDOFF_LIMIT) {
  return list.slice(0, limit);
}

/**
 * Capture the orchestrator's current work from the project journal and persist it
 * under .swarm/project so a new session can continue the same work.
 * @returns {Promise<{ file: string, handoff: object }>}
 */
export async function writeOrchestratorHandoff(root, { now = Date.now } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('handoff-needs-root');
  const events = await readJournal(root, { limit: Infinity });
  const newestFirst = [...events].reverse();

  const goalEvent = newestFirst.find(event => event?.kind === 'goal') ?? null;
  const planEvent = newestFirst.find(event => event?.kind === 'plan') ?? null;

  const openTickets = clipList(openItems(events).map(item => ({
    id: item.id ?? null,
    kind: item.kind,
    text: sanitizeText(String(item.text ?? '')),
  })));

  const decisions = clipList(
    newestFirst
      .filter(event => event?.kind === 'decision')
      .map(event => ({ at: event.ts ?? null, text: sanitizeText(String(event.text ?? '')) })),
    20,
  );

  const at = new Date(typeof now === 'function' ? now() : now).toISOString();
  const handoff = {
    version: 1,
    at,
    goal: goalEvent ? sanitizeText(String(goalEvent.text ?? '')) : null,
    doneWhen: goalEvent?.doneWhen ? sanitizeText(String(goalEvent.doneWhen)) : null,
    plan: planEvent ? sanitizeText(String(planEvent.text ?? '')) : null,
    openTickets,
    recentDecisions: decisions,
    resume: 'Read this file, then .swarm/project/journal.ndjson for the full history, then continue the open tickets.',
  };

  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, HANDOFF_FILE);
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.${HANDOFF_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(handoff, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await fs.rename(tmp, file);

  await appendEvent(root, {
    kind: 'action',
    action: 'orchestrator-handoff',
    file: `.swarm/project/${HANDOFF_FILE}`,
    openTickets: openTickets.length,
    decisions: decisions.length,
  }, { now: () => Date.parse(at), best: true });

  return { file: path.join('.swarm', 'project', HANDOFF_FILE), handoff };
}

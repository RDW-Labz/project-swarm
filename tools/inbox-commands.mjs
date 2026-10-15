// SPDX-License-Identifier: Apache-2.0
// `swarm inbox | done | decide | decision | backlog`: the owner's side of Phase 10c. Plain commands, no model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, readJournal, sanitizeText } from './journal.mjs';
import { collectInbox, formatInbox, markDone, decide } from './inbox.mjs';
import { readStore, updateGroup, groupAsState } from './human-jobs.mjs';
import { readBacklog, addGoal, removeGoal } from './backlog.mjs';

const USAGE = {
  inbox: 'Usage: swarm inbox [--json] [--all]\n',
  done: 'Usage: swarm done ID\n',
  decide: 'Usage: swarm decide ID CHOICE\n',
  decision: 'Usage: swarm decision "TEXT" --choice CHOICE [--option OPTION]... [--id ID]\n',
  backlog: 'Usage: swarm backlog | backlog add "GOAL" [--paths a/,b/] [--max-usd N] | backlog remove ID\n',
};
const bad = command => ({ stdout: USAGE[command], exitCode: 1 });

// The inbox library reads and writes human items through these functions; here they are backed by
// .swarm/project/human-jobs.json and the project journal.
export function inboxDeps({ now = Date.now, onNote } = {}) {
  return {
    now,
    onNote,
    listRuns: async root => (await readStore(root)).groups.map(group => group.id),
    readState: async (root, id) => {
      const group = (await readStore(root)).groups.find(item => item.id === id);
      return group ? groupAsState(group) : null;
    },
    writeRun: async (root, run) => {
      await updateGroup(root, run.id, group => {
        for (const human of group.humans) {
          const job = run.jobs.find(item => item.id === human.id);
          if (job?.status === 'complete' && !human.done) { human.done = true; human.doneAt = job.human?.doneAt ?? new Date(now()).toISOString(); }
        }
      });
    },
    readJournal,
    appendEvent: (root, event, options) => appendEvent(root, event, options),
    addGoal,
  };
}

async function inboxRoots(root, installRoot, all) {
  const roots = [root];
  if (!all || !installRoot) return roots;
  let registry = [];
  try { const value = JSON.parse(await fs.readFile(path.join(installRoot, '.swarm-projects.json'), 'utf8')); registry = Array.isArray(value) ? value : []; } catch { registry = []; }
  for (const entry of registry) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || roots.includes(entry)) continue;
    try { await fs.access(path.join(entry, '.swarm')); roots.push(entry); } catch { /* not a swarm project */ }
  }
  return roots;
}

function flagValues(args, name) {
  const values = [];
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) { if (index + 1 >= args.length) return null; values.push(args[index + 1]); index += 1; } else rest.push(args[index]);
  }
  return { values, rest };
}

export async function runInboxCommand(root, command, args, { installRoot, now = Date.now } = {}) {
  try {
    if (command === 'inbox') {
      if (args.some(arg => !['--json', '--all'].includes(arg))) return bad(command);
      const notes = [];
      const items = await collectInbox(await inboxRoots(root, installRoot, args.includes('--all')), inboxDeps({ now, onNote: note => notes.push(note) }));
      const tail = notes.length ? `\n${notes.join('\n')}` : '';
      return { stdout: args.includes('--json') ? `${JSON.stringify(items)}\n` : `${formatInbox(items, { now })}${tail}\n`, exitCode: 0 };
    }
    if (command === 'done') {
      if (args.length !== 1) return bad(command);
      const out = await markDone(root, args[0], inboxDeps({ now }));
      return { stdout: `done: ${out.id}\n`, exitCode: 0 };
    }
    if (command === 'decide') {
      if (args.length !== 2) return bad(command);
      const out = await decide(root, args[0], args[1], inboxDeps({ now }));
      return { stdout: out.changed ? `decided ${out.id}: ${out.choice}; added to backlog: ${out.goal}\n` : `decided ${out.id}: ${out.choice}\n`, exitCode: 0 };
    }
    if (command === 'decision') {
      const choice = flagValues(args, '--choice');
      if (!choice || choice.values.length !== 1) return bad(command);
      const options = flagValues(choice.rest, '--option');
      const ids = options && flagValues(options.rest, '--id');
      if (!ids || ids.values.length > 1 || ids.rest.length !== 1 || ids.rest[0].startsWith('--')) return bad(command);
      const text = sanitizeText(ids.rest[0]);
      const id = ids.values[0] ?? `d-${Math.floor(now() / 1000).toString(36)}`;
      const pool = [...new Set([choice.values[0], ...options.values])];
      await appendEvent(root, { kind: 'decision', id, text, choice: choice.values[0], ...(options.values.length ? { options: pool } : {}), confirm: true }, { now });
      return { stdout: `decision recorded: ${id}; confirm with: swarm decide ${id} ${choice.values[0]}\n`, exitCode: 0 };
    }
    if (command === 'backlog') {
      const [verb, ...rest] = args;
      if (verb === undefined) {
        const { items } = await readBacklog(root);
        return { stdout: items.length ? `${items.map(item => `${item.id} [${item.status}] ${item.goal}${item.paths?.length ? ` (paths: ${item.paths.join(', ')})` : ''}`).join('\n')}\n` : 'Backlog is empty.\n', exitCode: 0 };
      }
      if (verb === 'remove' && rest.length === 1) { await removeGoal(root, rest[0]); return { stdout: `removed: ${rest[0]}\n`, exitCode: 0 }; }
      if (verb === 'add') {
        const paths = flagValues(rest, '--paths');
        const usd = paths && flagValues(paths.rest, '--max-usd');
        if (!usd || paths.values.length > 1 || usd.values.length > 1 || usd.rest.length !== 1) return bad(command);
        const maxUsd = usd.values.length ? Number(usd.values[0]) : undefined;
        if (maxUsd !== undefined && !(maxUsd > 0)) return bad(command);
        const item = await addGoal(root, { goal: usd.rest[0], paths: paths.values.length ? paths.values[0].split(',').filter(Boolean) : [], ...(maxUsd !== undefined ? { maxUsd } : {}) }, { now });
        return { stdout: `queued: ${item.id}\n`, exitCode: 0 };
      }
      return bad(command);
    }
  } catch (error) {
    return { stdout: `${String(error.message ?? error).split('\n')[0]}\n`, exitCode: 1 };
  }
  return bad('inbox');
}

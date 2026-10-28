// SPDX-License-Identifier: Apache-2.0
// `swarm inbox | done | decide | decision | backlog`: the owner's side of Phase 10c. Plain commands, no model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, readJournal, sanitizeText, openItems, integrateBlockerKindFromId, integrateBlockerResolutionEvent, integrateBlockerRunIdFromId } from './journal.mjs';
import { isProtectedTopic } from './board-action-guard.mjs';
import { collectInbox, formatInbox, markDone, decide } from './inbox.mjs';
import { readStore, updateGroup, groupAsState } from './human-jobs.mjs';
import { readBacklog, addGoal, removeGoal } from './backlog.mjs';
import { supersededSplitParks } from './split-park-supersede.mjs';

const USAGE = {
  inbox: 'Usage: swarm inbox [--json] [--all]\n',
  done: 'Usage: swarm done ID\n',
  decide: 'Usage: swarm decide ID CHOICE\n',
  resolve: 'Usage: swarm resolve BLOCKER_ID | swarm resolve RUN_ID --handled\n',
  decision: 'Usage: swarm decision "TEXT" --choice CHOICE [--option OPTION]... [--id ID] [--board-safe]\n',
  backlog: 'Usage: swarm backlog | backlog add "GOAL" [--paths a/,b/] [--max-usd N] | backlog remove ID\n',
};
const bad = command => ({ stdout: USAGE[command], exitCode: 1 });

// Owner at the computer: interactive TTY and not inside a Claude Code or swarm agent session.
// The guard (another module) blocks `swarm decide` / hand-build approval command text inside agent sessions; the owner's own terminal is outside that guard.
export function decideChannelFromEnvironment(env = process.env) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'agent';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'agent';
  if (env.SWARM_AGENT_SESSION) return 'agent';
  return 'computer';
}

// The inbox library reads and writes human items through these functions; here they are backed by
// .swarm/project/human-jobs.json and the project journal.
export function inboxDeps({ now = Date.now, onNote, channel } = {}) {
  return {
    now,
    onNote,
    channel,
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

function parseSupersededSplitsArgs(args) {
  if (!args.length || args[0] !== '--superseded-splits') return null;
  let stage;
  let dryRun = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--stage') {
      if (index + 1 >= args.length) return { bad: true };
      stage = args[index + 1];
      if (!/^S\d+$/.test(stage)) return { bad: true };
      index += 1;
      continue;
    }
    return { bad: true };
  }
  return { stage, dryRun, json };
}

export async function runInboxCommand(root, command, args, { installRoot, now = Date.now } = {}) {
  try {
    if (command === 'inbox') {
      if (args.some(arg => !['--json', '--all'].includes(arg))) return bad(command);
      const notes = [];
      const items = await collectInbox(await inboxRoots(root, installRoot, args.includes('--all')), inboxDeps({ now, onNote: note => notes.push(note) }));
      const tail = notes.length ? `\n${notes.join('\n')}` : '';
      return { stdout: args.includes('--json') ? `${JSON.stringify(items)}\n` : `${formatInbox(items, { now, root })}${tail}\n`, exitCode: 0 };
    }
    if (command === 'done') {
      if (args.length !== 1) return bad(command);
      const out = await markDone(root, args[0], inboxDeps({ now }));
      return { stdout: `done: ${out.id}\n`, exitCode: 0 };
    }
    if (command === 'decide') {
      if (args.length !== 2) return bad(command);
      const out = await decide(root, args[0], args[1], inboxDeps({ now, channel: decideChannelFromEnvironment() }));
      return { stdout: out.changed ? `decided ${out.id}: ${out.choice}; added to backlog: ${out.goal}\n` : `decided ${out.id}: ${out.choice}\n`, exitCode: 0 };
    }
    if (command === 'resolve') {
      const supersededArgs = parseSupersededSplitsArgs(args);
      if (supersededArgs?.bad) return bad(command);
      if (supersededArgs) {
        const events = await readJournal(root, { limit: Infinity });
        const { superseded, kept } = supersededSplitParks(events, { stage: supersededArgs.stage });
        const openById = new Map(
          openItems(events)
            .filter(event => event.kind === 'blocker')
            .map(event => [String(event.id), event]),
        );
        const resolved = [];
        for (const row of superseded) {
          const open = openById.get(row.id);
          if (!open) continue;
          const entry = {
            kind: 'blocker',
            id: row.id,
            resolved: true,
            text: sanitizeText(open.text ?? ''),
            resolvedBy: 'superseded-splits',
            supersededBy: row.newerRun,
          };
          if (!supersededArgs.dryRun) await appendEvent(root, entry, { now });
          resolved.push(row);
        }
        const payload = { resolved, kept, dryRun: supersededArgs.dryRun };
        if (supersededArgs.json) {
          return { stdout: `${JSON.stringify(payload)}\n`, exitCode: 0 };
        }
        const verb = supersededArgs.dryRun ? 'would resolve' : 'resolved';
        const lines = resolved.map(row => `${verb}: ${row.id} (superseded by ingest ${row.newerRun})`);
        lines.push(`${verb} ${resolved.length} superseded split blockers; kept ${kept.length}`);
        for (const row of kept) lines.push(`kept: ${row.id} (${row.reason})`);
        return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
      }
      if (args.length === 2 && args[1] === '--handled') {
        const runId = args[0];
        if (!runId || runId.startsWith('-') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) return bad(command);
        const statePath = path.join(root, '.swarm', 'runs', runId, 'state.json');
        let state;
        try {
          state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        } catch {
          return { stdout: `no run state for ${sanitizeText(runId)}\n`, exitCode: 1 };
        }
        state.handled = true;
        state.handledAt = new Date(now()).toISOString();
        await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await appendEvent(root, { kind: 'run', id: runId, status: state.status ?? 'failed', handled: true }, { now });
        return { stdout: `handled: ${runId}\n`, exitCode: 0 };
      }
      if (args.length !== 1 || args[0].startsWith('-')) return bad(command);
      const open = openItems(await readJournal(root, { limit: Infinity })).find(event => event.kind === 'blocker' && String(event.id) === args[0]);
      if (!open) return { stdout: `no open blocker ${sanitizeText(args[0])} in this project (swarm inbox lists them)\n`, exitCode: 1 };
      const integrateKind = integrateBlockerKindFromId(open.id);
      const integrateRun = integrateBlockerRunIdFromId(open.id);
      const resolution = integrateKind && integrateRun
        ? integrateBlockerResolutionEvent(open, {
          integrateKind,
          integrateRun,
          integrateCause: open.integrateCause ?? open.text,
          resolvedBy: 'owner',
        })
        : { kind: 'blocker', id: open.id, resolved: true, text: sanitizeText(open.text ?? '') };
      await appendEvent(root, resolution, { now });
      return { stdout: `resolved: ${open.id}\n`, exitCode: 0 };
    }
    if (command === 'decision') {
      const boardSafe = args.includes('--board-safe');
      const positional = args.filter(arg => arg !== '--board-safe');
      const choice = flagValues(positional, '--choice');
      if (!choice || choice.values.length !== 1) return bad(command);
      const options = flagValues(choice.rest, '--option');
      const ids = options && flagValues(options.rest, '--id');
      if (!ids || ids.values.length > 1 || ids.rest.length !== 1 || ids.rest[0].startsWith('--')) return bad(command);
      const text = sanitizeText(ids.rest[0]);
      const id = ids.values[0] ?? `d-${Math.floor(now() / 1000).toString(36)}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return bad(command);
      if ((await readJournal(root, { limit: Infinity })).some(event => event.kind === 'decision' && String(event.id) === id)) return { stdout: `decision id already used: ${id}\n`, exitCode: 1 };
      choice.values[0] = sanitizeText(choice.values[0]);
      options.values = options.values.map(value => sanitizeText(value));
      const pool = [...new Set([choice.values[0], ...options.values])];
      if (boardSafe) {
        const protectedFields = [text, id, choice.values[0], ...pool];
        if (protectedFields.some(field => isProtectedTopic(field))) {
          return { stdout: 'a decision about merge, deploy, spend, caps, keys or migrations can never be answered from the board; drop --board-safe\n', exitCode: 1 };
        }
      }
      await appendEvent(root, {
        kind: 'decision',
        id,
        text,
        choice: choice.values[0],
        ...(options.values.length ? { options: pool } : {}),
        confirm: true,
        ...(boardSafe ? { boardSafe: true } : {}),
      }, { now });
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

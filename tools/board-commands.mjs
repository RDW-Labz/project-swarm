// SPDX-License-Identifier: Apache-2.0
// swarm projects [list | add PATH | remove ID]     swarm history [filters] [--csv] [--backfill]
import fs from 'node:fs/promises';
import { listProjects, registerProject, removeProject, projectsFile } from './projects.mjs';
import { readHistory, historyCsv, appendHistory, historyFile } from './history.mjs';
import { historyEventsOf } from './board-data.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';
const safe = v => sanitizeWorkerText(v ?? '', 240);

export const BOARD_USAGE = 'Usage: swarm projects [list | add PATH | remove ID]\n       swarm history [--project NAME] [--kind project|stage|run|pr|merge|lesson|spend] [--q TEXT] [--from DATE] [--to DATE] [--limit N] [--csv] [--backfill]\n';
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });

// Adds the history of what is already on disk (runs, spend, stages, lessons) for every listed project. Safe to run again: events carry keys.
export async function backfillHistory({ env = process.env } = {}) {
  let added = 0;
  for (const project of await listProjects({ file: projectsFile(env) })) {
    const result = await appendHistory(await historyEventsOf(project), { file: historyFile(env) });
    added += result.added;
  }
  return added;
}

export async function runBoardCommand(root, command, args, { env = process.env } = {}) {
  if (command === 'projects') {
    const [verb = 'list', ...rest] = args;
    const file = projectsFile(env);
    if (verb === 'list') {
      const projects = await listProjects({ file });
      return out(projects.length ? projects.map(p => `${p.id}  ${safe(p.name)}  ${safe(p.root)}  last seen ${safe(p.lastSeen)}`).join('\n') : 'No projects yet. Run a swarm command inside one, or swarm projects add PATH.');
    }
    if (verb === 'add') {
      if (rest.length !== 1) return out(`add needs one folder\n${BOARD_USAGE}`, 2);
      const real = await fs.realpath(rest[0]).catch(() => null);
      if (!real) return out(`no such folder: ${rest[0]}`, 1);
      const result = await registerProject(real, { file, env: { ...env, SWARM_PROJECTS_FILE: file } });
      return result ? out(`${result.added ? 'added' : 'already listed'}: ${result.project.name} (${result.project.id})`) : out('that is not a folder', 1);
    }
    if (verb === 'remove') {
      if (rest.length !== 1) return out(`remove needs a project id\n${BOARD_USAGE}`, 2);
      return (await removeProject(rest[0], { file })) ? out(`removed ${rest[0]} from the list (its files and its history are untouched)`) : out(`no project ${rest[0]}`, 1);
    }
    return out(`Unknown projects command: ${verb}\n${BOARD_USAGE}`, 2);
  }
  const query = {}; let csv = false, backfill = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--csv') csv = true;
    else if (flag === '--backfill') backfill = true;
    else if (['--project', '--kind', '--q', '--from', '--to', '--limit'].includes(flag) && args[i + 1] !== undefined) query[flag.slice(2)] = args[++i];
    else return out(`Unknown argument: ${flag}\n${BOARD_USAGE}`, 2);
  }
  if (backfill) { const added = await backfillHistory({ env }); if (!csv && !Object.keys(query).length) return out(`history backfilled: ${added} new event(s)`); }
  const { total, events } = await readHistory({ file: historyFile(env), ...query, limit: csv ? 1e6 : Number(query.limit) || 50, cap: csv ? 1e6 : 1000 });
  if (csv) return out(historyCsv(events).trimEnd());
  return out(events.length ? [...events.map(e => `${e.at}  ${safe(e.project)}  ${e.kind}  ${safe(e.title)}${typeof e.usd === 'number' ? `  $${e.usd.toFixed(2)}` : ''}`), `${events.length} of ${total} event(s)`].join('\n') : 'No history yet. swarm history --backfill adds what is already on disk.');
}

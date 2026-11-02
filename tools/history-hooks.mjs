// SPDX-License-Identifier: Apache-2.0
// The places where the runner writes to the machine's history log. Always best effort: a failure here never touches the work.
// Scratch folders (a test's temp dir) write nothing unless the history file was chosen explicitly.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendHistory, historyFile } from './history.mjs';
import { registerProject, projectId, projectsFile } from './projects.mjs';
import { runTotals } from './spend.mjs';

const inTmp = async real => {
  const bases = new Set([path.resolve(os.tmpdir()), await fs.realpath(os.tmpdir()).catch((error) => {
    console.error('[tools/history-hooks.mjs] inTmp realpath(tmpdir):', error?.message ?? error);
    return null;
  }), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].filter(Boolean));
  return [...bases].some(tmp => real === tmp || real.startsWith(tmp + path.sep)) || real.split(path.sep).includes('.swarm');
};

async function identity(root, env) {
  let real;
  try { real = await fs.realpath(root); } catch { return null; }
  if (!env.SWARM_HISTORY_FILE && await inTmp(real)) return null;
  return { project: path.basename(real).slice(0, 80), projectId: projectId(real), real };
}

export async function recordHistory(root, event, { env = process.env } = {}) {
  try {
    const who = await identity(root, env);
    if (!who) return;
    await appendHistory({ project: who.project, projectId: who.projectId, ...event }, { file: historyFile(env) });
  } catch (error) {
    console.error('[tools/history-hooks.mjs] recordHistory:', error?.message ?? error);
  }
}

// swarm commands that mean "this folder is a project": it is listed on the board, and the first time is a history event.
export async function noteProject(root, { env = process.env } = {}) {
  try {
    const result = await registerProject(root, { file: projectsFile(env), env });
    // The history line follows the same rule as every other history write: nothing for a scratch folder unless the file was chosen.
    if (result?.added && await identity(root, env)) await appendHistory({ project: result.project.name, projectId: result.project.id, kind: 'project', key: `project:${result.project.id}`, title: `Project ${result.project.name} registered` }, { file: historyFile(env) });
  } catch (error) {
    console.error('[tools/history-hooks.mjs] noteProject:', error?.message ?? error);
  }
}

export async function recordRunHistory(root, state, { env = process.env } = {}) {
  if (!state || typeof state !== 'object' || !state.id) return;
  const jobs = state.jobs ?? [];
  const who = await identity(root, env).catch((error) => {
    console.error('[tools/history-hooks.mjs] recordRunHistory identity:', error?.message ?? error);
    return null;
  });
  const key = who ? who.projectId : 'x';
  await recordHistory(root, { kind: 'run', key: `run:${key}:${state.id}`, at: state.finishedAt ?? new Date().toISOString(), run: state.id, ref: state.id, title: `Run ${state.id}: ${state.status ?? 'finished'}, ${jobs.filter(j => j.status === 'complete').length}/${jobs.length} jobs` }, { env });
  const usd = runTotals(state).usd;
  if (usd > 0) await recordHistory(root, { kind: 'spend', key: `spend:${key}:${state.id}`, at: state.finishedAt ?? new Date().toISOString(), run: state.id, usd, title: `Run ${state.id} spent $${usd.toFixed(2)}` }, { env });
}

// A ship or merge result: the PR when there is one, and the merge when it merged.
export async function recordShipHistory(root, result, { env = process.env } = {}) {
  if (!result || typeof result !== 'object') return;
  const pr = result.pr && typeof result.pr === 'object' ? result.pr : null;
  const number = pr?.number ?? (Number.isInteger(result.pr) ? result.pr : null);
  const url = typeof pr?.url === 'string' ? pr.url : typeof result.url === 'string' ? result.url : null;
  const who = await identity(root, env).catch((error) => {
    console.error('[tools/history-hooks.mjs] recordShipHistory identity:', error?.message ?? error);
    return null;
  });
  const key = who ? who.projectId : 'x';
  if (number !== null) await recordHistory(root, { kind: 'pr', key: `pr:${key}:${number}`, ref: `#${number}`, run: result.runId ?? null, url, title: `Pull request #${number}${result.repo ? ` on ${result.repo}` : ''}` }, { env });
  if (result.status === 'merged' && number !== null) await recordHistory(root, { kind: 'merge', key: `merge:${key}:${number}`, ref: `#${number}`, url, title: `Merged #${number}${result.repo ? ` on ${result.repo}` : ''}${(result.mergeSha ?? result.sha) ? ` (${String(result.mergeSha ?? result.sha).slice(0, 8)})` : ''}` }, { env });
}

// A stage whose tickets are all done (the ledger of the project at `root`), once.
export async function recordStageHistory(root, ledger, { env = process.env } = {}) {
  const live = (ledger?.tickets ?? []).filter(t => t && !['cancelled', 'proposed'].includes(t.status) && /^S[1-9]\d*$/.test(String(t.stage)));
  const who = await identity(root, env).catch((error) => {
    console.error('[tools/history-hooks.mjs] recordStageHistory identity:', error?.message ?? error);
    return null;
  });
  if (!who) return;
  for (const stage of [...new Set(live.map(t => t.stage))]) {
    const mine = live.filter(t => t.stage === stage);
    if (mine.every(t => t.status === 'done')) await recordHistory(root, { kind: 'stage', key: `stage:${who.projectId}:${stage}`, ref: stage, title: `Stage ${stage} done (${mine.length} tickets)` }, { env });
  }
}

export async function recordLessonHistory(root, lesson, { env = process.env } = {}) {
  const who = await identity(root, env).catch((error) => {
    console.error('[tools/history-hooks.mjs] recordLessonHistory identity:', error?.message ?? error);
    return null;
  });
  if (!who || !lesson?.id) return;
  await recordHistory(root, { kind: 'lesson', key: `lesson:${who.projectId}:${lesson.id}`, ref: String(lesson.id), title: `Lesson ${lesson.id}: ${lesson.what ?? lesson.rule ?? ''}` }, { env });
}

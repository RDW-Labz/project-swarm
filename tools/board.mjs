#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// A per-user registry of live runs across worktrees, used to refuse a second writer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function liveDir(env = process.env, home = os.homedir()) {
  return env.SWARM_LIVE_DIR || path.join(home, '.project-swarm', 'live');
}

async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

export async function repoKey(root) {
  try {
    return await fs.realpath(await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch {
    return await fs.realpath(root);
  }
}

export async function repoPaths(root, outputs) {
  let toplevel;
  try {
    toplevel = await fs.realpath(await git(root, ['rev-parse', '--show-toplevel']));
  } catch {
    return [...outputs];
  }
  const realRoot = await fs.realpath(root);
  return outputs.map(file => path.relative(toplevel, path.join(realRoot, file)).split(path.sep).join('/'));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function registerLiveRun({ runId, root, outputs, pid = process.pid, dir = liveDir() }) {
  const realRoot = await fs.realpath(root);
  const repo = await repoKey(realRoot);
  const files = [...new Set(await repoPaths(realRoot, outputs))].sort();
  const record = { runId, root: realRoot, repo, files, pid, startedAt: new Date().toISOString() };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const target = path.join(dir, `${runId}.json`);
  const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function unregisterLiveRun(runId, { dir = liveDir() } = {}) {
  await fs.unlink(path.join(dir, `${runId}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export async function listLiveRuns({ dir = liveDir(), isAlive = pidAlive } = {}) {
  let entries;
  try { entries = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const target = path.join(dir, entry);
    let record;
    try { record = JSON.parse(await fs.readFile(target, 'utf8')); } catch { await fs.unlink(target).catch(() => {}); continue; }
    if (!isAlive(record.pid)) { await fs.unlink(target).catch(() => {}); continue; }
    runs.push(record);
  }
  return runs.sort((a, b) => a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);
}

export async function findWriterConflicts({ runId, root, outputs, dir = liveDir(), isAlive }) {
  const realRoot = await fs.realpath(root);
  const repo = await repoKey(realRoot);
  const files = new Set(await repoPaths(realRoot, outputs));
  const runs = await listLiveRuns({ dir, isAlive });
  const conflicts = [];
  for (const run of runs) {
    if (run.runId === runId || run.repo !== repo) continue;
    const shared = [...new Set(run.files)].filter(file => files.has(file)).sort();
    if (shared.length) conflicts.push({ runId: run.runId, root: run.root, files: shared });
  }
  return conflicts;
}

export async function boardSummary({ dir = liveDir(), isAlive } = {}) {
  const runs = await listLiveRuns({ dir, isAlive });
  const summarized = [];
  for (const run of runs) {
    let status = 'unknown', jobs = [];
    try {
      const state = JSON.parse(await fs.readFile(path.join(run.root, '.swarm/runs', run.runId, 'state.json'), 'utf8'));
      status = state.status;
      jobs = state.jobs.map(job => ({ id: job.id, status: job.status, outputs: job.outputs, ...(job.agent ? { agent: job.agent } : {}) }));
    } catch {}
    summarized.push({ runId: run.runId, root: run.root, repo: run.repo, pid: run.pid, startedAt: run.startedAt, status, jobs });
  }
  return { runs: summarized };
}

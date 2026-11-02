// SPDX-License-Identifier: Apache-2.0
// Project-wide spend: the total of every run in this repository (.swarm/runs/*/state.json), and the optional cap on it.
// --max-usd stays per run; this cap refuses NEW runs once the project total has reached it. A review re-ask is a run, so it counts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTotals } from './spend.mjs';
import { loadLocalConfig } from './local-config.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

const cache = new Map(); // state.json path -> { mtimeMs, size, run }: a rescan re-reads only runs that changed

// Total of every run in the project. A run state that cannot be read, or has the wrong shape, is listed in `unreadable`; never silently skipped.
// `exposureUsd` is what runs that are still running may yet spend under their own --max-usd (counted so runs started together cannot all slip under the cap).
export async function projectSpend(root) {
  const dir = path.join(root, '.swarm', 'runs');
  const total = { usd: 0, tokens: 0, runs: 0, unreadable: [], unknownUsd: 0, exposureUsd: 0 };
  let ids = [];
  try { ids = await fs.readdir(dir); } catch (error) { if (error.code !== 'ENOENT') total.unreadable.push('.swarm/runs'); }
  for (const id of ids) {
    const file = path.join(dir, id, 'state.json');
    let stat;
    try { stat = await fs.stat(file); } catch (error) { if (error.code !== 'ENOENT') total.unreadable.push(id); continue; }
    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      try {
        const state = JSON.parse(await fs.readFile(file, 'utf8'));
        if (state === null || typeof state !== 'object' || Array.isArray(state) || (state.jobs !== undefined && !Array.isArray(state.jobs))) throw new Error('state has the wrong shape');
        const run = runTotals(state);
        const cap = state.budget?.maxUsd;
        entry = { mtimeMs: stat.mtimeMs, size: stat.size, run: { usd: run.usd, tokens: run.tokens, unknown: run.unknownUsd.length, exposure: state.status === 'running' && finite(cap) ? Math.max(0, cap - run.usd) : 0 } };
        cache.set(file, entry);
      } catch { total.unreadable.push(id); continue; }
    }
    total.usd += entry.run.usd; total.tokens += entry.run.tokens; total.runs++; total.unknownUsd += entry.run.unknown; total.exposureUsd += entry.run.exposure;
  }
  return total;
}

const invalidCap = source => Object.assign(new Error(`project-cap-invalid: ${source} must be a number above 0`), { code: 'project-cap-invalid' });

// The lower of the profile cap and the local-config cap, with where it came from; null when neither is set. null or a bad value is an error, never "no cap".
export function projectCapInfo({ profile, config } = {}) {
  let best = null;
  for (const [source, value] of [['profile budget.projectMaxUsd', profile?.budget?.projectMaxUsd], ['config spend.projectMaxUsd', config?.spend?.projectMaxUsd]]) {
    if (value === undefined) continue;
    if (!finite(value)) throw invalidCap(source);
    if (!best || value < best.cap) best = { cap: value, source };
  }
  return best;
}
export const projectCap = input => projectCapInfo(input)?.cap ?? null;

// Reads the cap for a project. A missing pointer file means no profile; any other read or parse problem is an error, never "no cap".
export async function readProjectCap(root, { env = process.env } = {}) {
  let pointer = null;
  try { pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Object.assign(new Error(`project-cap-invalid: .project-swarm.json cannot be read (${error.code ?? 'bad JSON'}); the project cap cannot be checked`), { code: 'project-cap-invalid' }); }
  return projectCapInfo({ profile: pointer?.profile, config: loadLocalConfig({ env }) });
}

export function projectCapDecision({ spent, cap, source = 'profile budget.projectMaxUsd' }) {
  if (cap === null || cap === undefined) return null;
  if (spent.unreadable?.length) return { reason: 'project-cap-unreadable', spent: spent.usd, cap, message: `project-cap: ${spent.unreadable.length} run state${spent.unreadable.length === 1 ? '' : 's'} could not be read (${spent.unreadable.slice(0, 3).join(', ')}), so the project total is unknown and no new run starts; fix or move them` };
  const exposure = spent.exposureUsd ?? 0;
  if (spent.usd + exposure < cap) return null;
  return { reason: 'project-cap', spent: spent.usd, cap, message: `project-cap: this project has spent $${spent.usd.toFixed(2)} across ${spent.runs} runs${exposure > 0 ? ` and runs still going may spend $${exposure.toFixed(2)} more` : ''} >= the project cap $${cap.toFixed(2)}; no new run starts. Raising it needs the owner (${source})` };
}

export async function checkProjectCap(root, { env = process.env } = {}) {
  const info = await readProjectCap(root, { env });
  if (info === null) return null;
  return projectCapDecision({ spent: await projectSpend(root), cap: info.cap, source: info.source });
}

const summaryCache = new Map(); // root -> { at, value }: swarm watch asks every 250 ms, the total changes slowly
// What swarm watch shows: the project total, the cap (or null), and whether new runs are refused. Never throws.
export async function projectSummary(root, { env = process.env, now = Date.now, ttlMs = 3000 } = {}) {
  const hit = summaryCache.get(root);
  if (hit && ttlMs > 0 && now() - hit.at < ttlMs) return hit.value;
  let value;
  try {
    const spent = await projectSpend(root);
    let info = null, capError = null;
    try { info = await readProjectCap(root, { env }); } catch (error) { capError = error.message; }
    const decision = info ? projectCapDecision({ spent, cap: info.cap, source: info.source }) : null;
    value = { spendUsd: Math.round(spent.usd * 100) / 100, runs: spent.runs, capUsd: info?.cap ?? null, noCap: !info && !capError, reached: Boolean(decision), unknownUsd: spent.unknownUsd, unreadable: spent.unreadable.length, ...(capError ? { capError } : {}) };
  } catch (error) { value = { spendUsd: null, runs: 0, capUsd: null, reached: false, unknownUsd: 0, unreadable: 0, capError: String(error.message).slice(0, 200) }; }
  summaryCache.set(root, { at: now(), value });
  return value;
}

// swarm go prints this when the project has no cap at all. Nothing is set for the owner: there is no default value.
export const NO_CAP_WARNING = 'warning: NO CAP: this project has no project-wide spend cap, so only each run\'s own --max-usd limits spending. Set budget.projectMaxUsd in the profile (or spend.projectMaxUsd in the local config); swarm sets none for you.';
export async function noCapWarning(root, { env = process.env } = {}) {
  try { return (await readProjectCap(root, { env })) === null ? NO_CAP_WARNING : null; }
  catch { return null; } // an invalid cap is refused loudly when the run starts; it is not "no cap"
}

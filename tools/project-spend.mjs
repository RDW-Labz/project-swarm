// SPDX-License-Identifier: Apache-2.0
// Project-wide spend: the total of every run in this repository (.swarm/runs/*/state.json), and the optional cap on it.
// --max-usd stays per run; this cap refuses NEW runs once the project total has reached it. A review re-ask is a run, so it counts.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PAID_LANES, runTotals } from './spend.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { scratchRootDir } from './claude-shell.mjs';

const meteredLaneList = () => PAID_LANES.join(', ');

const finite = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

const cache = new Map(); // state.json path -> { mtimeMs, size, run }: a rescan re-reads only runs that changed

// Total of every run in one checkout. A run state that cannot be read, or has the wrong shape, is listed in `unreadable`; never silently skipped.
// `exposureUsd` is what runs that are still running may yet spend under their own --max-usd (counted so runs started together cannot all slip under the cap).
export async function treeSpend(root) {
  const dir = path.join(root, '.swarm', 'runs');
  const total = { usd: 0, listUsd: 0, billedUsd: 0, tokens: 0, runs: 0, unreadable: [], unknownUsd: 0, billedUnknown: 0, billedUnknownUsd: 0, exposureUsd: 0 };
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
        const billedForCap = run.billedUsd + (run.billedUnknownUsd ?? 0);
        const exposure = state.status === 'running' && run.hasPaidLaneJob && finite(cap) ? Math.max(0, cap - billedForCap) : 0;
        entry = { mtimeMs: stat.mtimeMs, size: stat.size, run: { usd: run.usd, billedUsd: run.billedUsd, tokens: run.tokens, unknown: run.unknownUsd.length, billedUnknown: run.billedUnknown, billedUnknownUsd: run.billedUnknownUsd, exposure } };
        cache.set(file, entry);
      } catch { total.unreadable.push(id); continue; }
    }
    total.usd += entry.run.usd; total.listUsd += entry.run.usd; total.billedUsd += entry.run.billedUsd; total.tokens += entry.run.tokens; total.runs++; total.unknownUsd += entry.run.unknown; total.billedUnknown += entry.run.billedUnknown; total.billedUnknownUsd += entry.run.billedUnknownUsd ?? 0; total.exposureUsd += entry.run.exposure;
  }
  return total;
}

const invalidCap = source => Object.assign(new Error(`project-cap-invalid: ${source} must be a number above 0`), { code: 'project-cap-invalid' });

// A linked worktree has a .git file pointing at its private git dir. Resolve that git dir back to
// the main checkout without invoking git; malformed or non-worktree layouts are simply unknown.
export async function mainWorktreeRoot(root) {
  try {
    const gitFile = path.join(root, '.git');
    const stat = await fs.lstat(gitFile);
    if (!stat.isFile()) return null;
    const pointer = (await fs.readFile(gitFile, 'utf8')).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match) return null;
    const gitDir = path.resolve(root, match[1].trim());
    let commonDir;
    try {
      const commonText = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
      if (!commonText) return null;
      commonDir = path.resolve(gitDir, commonText);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      commonDir = path.dirname(path.dirname(gitDir));
    }
    if (path.basename(commonDir) !== '.git') return null;
    return await fs.realpath(path.dirname(commonDir));
  } catch {
    return null;
  }
}

const realOrResolved = async root => await fs.realpath(root).catch(() => path.resolve(root));
const hasSwarmSegment = root => path.resolve(root).split(path.sep).includes('.swarm');
const insidePath = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);

// The cap is shared by the main checkout and every linked worktree recorded by git. This reads
// only the worktree metadata; it deliberately does not invoke git, and malformed entries are
// ignored so a missing or half-written entry cannot make cap inspection throw.
export async function worktreeFamily(root, { env = process.env, home = os.homedir() } = {}) {
  const requested = await realOrResolved(root);
  const mainCandidate = (await mainWorktreeRoot(root)) ?? root;
  const main = await realOrResolved(mainCandidate);
  const scratchRoot = await realOrResolved(scratchRootDir({ env, home }));
  let gitStat;
  try { gitStat = await fs.stat(path.join(main, '.git')); } catch { return [requested]; }
  if (!gitStat.isDirectory()) return [requested];

  const discovered = new Set();
  const worktreesDir = path.join(main, '.git', 'worktrees');
  let entries = [];
  try { entries = await fs.readdir(worktreesDir); } catch (error) { if (error.code !== 'ENOENT') entries = []; }
  for (const entry of entries) {
    const gitdirFile = path.join(worktreesDir, entry, 'gitdir');
    let pointer;
    try { pointer = (await fs.readFile(gitdirFile, 'utf8')).trim(); } catch { continue; }
    if (!pointer) continue;
    const gitdir = path.isAbsolute(pointer) ? pointer : path.resolve(path.dirname(gitdirFile), pointer);
    let member;
    try { member = await fs.realpath(path.dirname(gitdir)); } catch { continue; }
    if (hasSwarmSegment(member)) continue;
    if (insidePath(member, scratchRoot)) continue;
    if (member !== main) discovered.add(member);
  }
  return [main, ...[...new Set([...discovered, requested])].filter(member => member !== main).sort()];
}

export async function projectSpend(root) {
  const family = await worktreeFamily(root);
  const requested = await realOrResolved(root);
  const results = await Promise.all(family.map(async member => ({ root: member, spent: await treeSpend(member) })));
  const total = { usd: 0, listUsd: 0, billedUsd: 0, tokens: 0, runs: 0, unreadable: [], unknownUsd: 0, billedUnknown: 0, billedUnknownUsd: 0, exposureUsd: 0, trees: results.map(({ root: member, spent }) => ({ root: member, listUsd: spent.usd, billedUsd: spent.billedUsd, runs: spent.runs })) };
  const own = results.find(({ root: member }) => member === requested);
  for (const { spent } of results) {
    total.usd += spent.usd;
    total.listUsd += spent.listUsd;
    total.billedUsd += spent.billedUsd;
    total.tokens += spent.tokens;
    total.runs += spent.runs;
    total.unknownUsd += spent.unknownUsd;
    total.billedUnknown += spent.billedUnknown;
    total.billedUnknownUsd += spent.billedUnknownUsd ?? 0;
    total.exposureUsd += spent.exposureUsd;
  }
  const unreadable = [];
  if (own) unreadable.push(...own.spent.unreadable);
  for (const { root: member, spent } of results) {
    if (member === requested) continue;
    const prefix = path.basename(member);
    unreadable.push(...spent.unreadable.map(id => `${prefix}:${id}`));
  }
  total.unreadable = unreadable;
  return total;
}

// The lower of the profile cap and the local-config cap, with where it came from; null when neither is set. null or a bad value is an error, never "no cap".
export function projectCapInfo({ profile, config, inheritedFrom = null } = {}) {
  let best = null;
  for (const [source, value] of [['profile budget.projectMaxUsd', profile?.budget?.projectMaxUsd], ['config spend.projectMaxUsd', config?.spend?.projectMaxUsd]]) {
    if (value === undefined) continue;
    if (!finite(value)) throw invalidCap(source);
    if (!best || value < best.cap) best = { cap: value, source };
  }
  if (best && inheritedFrom && best.source === 'profile budget.projectMaxUsd') {
    best = { ...best, inheritedFrom, source: `${best.source} (inherited from ${path.basename(inheritedFrom)})` };
  }
  return best;
}
export const projectCap = input => projectCapInfo(input)?.cap ?? null;

// Reads the cap for a project. A missing pointer file means no profile; any other read or parse problem is an error, never "no cap".
export async function readProjectCap(root, { env = process.env } = {}) {
  const pointerFile = path.join(root, '.project-swarm.json');
  let pointer = null;
  let inheritedFrom = null;
  try {
    pointer = JSON.parse(await fs.readFile(pointerFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw Object.assign(new Error(`project-cap-invalid: .project-swarm.json cannot be read (${error.code ?? 'bad JSON'}; file ${pointerFile}); the project cap cannot be checked`), { code: 'project-cap-invalid' });
    const mainRoot = await mainWorktreeRoot(root);
    if (mainRoot && path.resolve(mainRoot) !== path.resolve(root)) {
      inheritedFrom = mainRoot;
      const mainPointerFile = path.join(mainRoot, '.project-swarm.json');
      try {
        pointer = JSON.parse(await fs.readFile(mainPointerFile, 'utf8'));
      } catch (mainError) {
        if (mainError.code !== 'ENOENT') throw Object.assign(new Error(`project-cap-invalid: .project-swarm.json cannot be read (${mainError.code ?? 'bad JSON'}; file ${mainPointerFile}); the project cap cannot be checked`), { code: 'project-cap-invalid' });
        pointer = null;
      }
    }
  }
  return projectCapInfo({ profile: pointer?.profile, config: loadLocalConfig({ env }), inheritedFrom });
}

export function projectCapDecision({ spent, cap, source = 'profile budget.projectMaxUsd' }) {
  if (cap === null || cap === undefined) return null;
  if (spent.unreadable?.length) return { reason: 'project-cap-unreadable', spent: spent.billedUsd ?? spent.usd ?? 0, cap, message: `project-cap: ${spent.unreadable.length} run state${spent.unreadable.length === 1 ? '' : 's'} could not be read (${spent.unreadable.slice(0, 3).join(', ')}), so the project total is unknown and no new run starts; fix or move them` };
  const billed = spent.billedUsd ?? spent.usd ?? 0;
  const unknownReserve = spent.billedUnknownUsd ?? 0;
  const billedForCap = billed + unknownReserve;
  const list = spent.listUsd ?? spent.usd ?? 0;
  const exposure = spent.exposureUsd ?? 0;
  if (billedForCap + exposure < cap) return null;
  const lanes = meteredLaneList();
  const unknownNote = spent.billedUnknown > 0 ? ` (${spent.billedUnknown} job${spent.billedUnknown === 1 ? '' : 's'} with unknown cost counted at the reserve)` : '';
  const exposureNote = exposure > 0 ? ` (plus $${exposure.toFixed(2)} exposure)` : '';
  return { reason: 'project-cap', spent: billedForCap, cap, message: `project-cap: this project has been billed $${billedForCap.toFixed(2)}${unknownNote}${exposureNote} of the $${cap.toFixed(2)} cap; list value $${list.toFixed(2)} across ${spent.runs} runs is not counted, only metered lanes (${lanes}) count. Raising it needs the owner (${source})` };
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
    const ownRoot = await realOrResolved(root);
    const own = spent.trees?.find(tree => tree.root === ownRoot);
    value = { spendUsd: Math.round(spent.usd * 100) / 100, listUsd: Math.round(spent.listUsd * 100) / 100, billedUsd: Math.round(spent.billedUsd * 100) / 100, treeUsd: Math.round((own?.listUsd ?? own?.usd ?? 0) * 100) / 100, sharedTrees: spent.trees?.length ?? 1, runs: spent.runs, capUsd: info?.cap ?? null, noCap: !info && !capError, reached: Boolean(decision), unknownUsd: spent.unknownUsd, billedUnknown: spent.billedUnknown, unreadable: spent.unreadable.length, capSource: info?.source ?? null, capInherited: Boolean(info?.inheritedFrom), inheritedFrom: info?.inheritedFrom ?? null, why: capError ? `cap invalid: ${capError}` : decision?.message ?? null, ...(capError ? { capError } : {}) };
  } catch (error) { const capError = String(error.message).slice(0, 200); value = { spendUsd: null, listUsd: null, billedUsd: null, treeUsd: null, sharedTrees: 1, runs: 0, capUsd: null, reached: false, unknownUsd: 0, billedUnknown: 0, unreadable: 0, capSource: null, capInherited: false, inheritedFrom: null, why: `cap invalid: ${capError}`, capError }; }
  summaryCache.set(root, { at: now(), value });
  return value;
}

// swarm go prints this when the project has no cap at all. Nothing is set for the owner: there is no default value.
export const NO_CAP_WARNING = 'warning: NO CAP: this project has no project-wide spend cap, so only each run\'s own --max-usd limits spending. Set budget.projectMaxUsd in the profile (or spend.projectMaxUsd in the local config); swarm sets none for you.';
export async function noCapWarning(root, { env = process.env } = {}) {
  try { return (await readProjectCap(root, { env })) === null ? NO_CAP_WARNING : null; }
  catch { return null; } // an invalid cap is refused loudly when the run starts; it is not "no cap"
}

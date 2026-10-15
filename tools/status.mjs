// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

const NEXT_COMMANDS = ['swarm doctor all', 'swarm board', 'swarm version --check', 'swarm scale', 'swarm help'];

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function latestRun(root) {
  const directory = path.join(root, '.swarm', 'runs');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const state = JSON.parse(await fs.readFile(path.join(directory, entry.name, 'state.json'), 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
      runs.push({ name: entry.name, state, time: timestamp(state.startedAt) ?? timestamp(entry.name) });
    } catch { /* Unreadable or corrupt runs do not hide usable history. */ }
  }
  runs.sort((a, b) => {
    if (a.time !== null && b.time !== null && a.time !== b.time) return b.time - a.time;
    return b.name.localeCompare(a.name);
  });
  if (!runs.length) return null;
  const { name, state } = runs[0];
  const costs = Object.values(state.jobs ?? {}).map(job => job?.costUsd).filter(value => typeof value === 'number' && Number.isFinite(value));
  const costUsd = typeof state.summary?.costUsd === 'number' && Number.isFinite(state.summary.costUsd)
    ? state.summary.costUsd : costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  return {
    id: state.id ?? name,
    status: state.status ?? null,
    startedAt: state.startedAt ?? null,
    finishedAt: state.finishedAt ?? null,
    counts: state.summary?.counts ?? null,
    costUsd,
  };
}

export async function projectStatus(root, { env = process.env, now = Date.now, doctorAll, spendToday } = {}) {
  let initialized = false;
  try { await fs.access(path.join(root, '.project-swarm.json')); initialized = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lastRun = await latestRun(root);
  let lanes = { up: [], down: [] };
  try {
    const result = await doctorAll();
    for (const { agent, status } of result.providers) {
      lanes[['compatible', 'configured', 'reachable'].includes(status) ? 'up' : 'down'].push(agent);
    }
  } catch (error) { lanes = { up: [], down: [], error: error?.message ?? String(error) }; }
  let spend = { usd: null, byLane: {} };
  try { if (spendToday) spend = await spendToday(); }
  catch { /* A missing ledger should not prevent status. */ }
  let first = 'swarm "describe your goal in one sentence"';
  if (!initialized) first = 'swarm init';
  else if (lastRun) {
    if (['failed', 'cancelled'].includes(lastRun.status)) first = `swarm inspect ${lastRun.id}`;
    else if (lastRun.status === 'running') first = `swarm monitor ${lastRun.id} --watch`;
    else if (lastRun.status === 'complete') first = `swarm rollup ${lastRun.id} --text`;
  }
  return { root, initialized, lastRun, lanes, spendToday: spend, next: [...new Set([first, ...NEXT_COMMANDS])].slice(0, 5) };
}

function age(value, now) {
  const started = timestamp(value);
  if (started === null) return 'unknown age';
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function money(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : 'unknown';
}

export function formatStatus(status, { now = Date.now } = {}) {
  const run = status.lastRun;
  const counts = run?.counts && typeof run.counts === 'object'
    ? Object.entries(run.counts).map(([name, count]) => `${name}: ${count}`).join(', ') : 'unknown';
  const lines = [
    `Project Swarm status for ${status.root}`,
    `Initialized: ${status.initialized ? 'yes' : 'no; run: swarm init'}`,
    run ? `Last run: ${run.id}, ${run.status}, ${age(run.startedAt, typeof now === 'function' ? now() : now)}; counts: ${counts}; cost: ${money(run.costUsd)}` : 'Last run: none',
    `Lanes up: ${status.lanes.up.join(', ') || 'none'}`,
    `Lanes down: ${status.lanes.down.join(', ') || 'none'}`,
    `Today's spend: ${money(status.spendToday.usd)}`,
    '',
    'Next:',
    ...status.next.map(command => `  ${command}`),
  ];
  return lines.map(line => line.replace(/[\r\n\u001b]/g, ' ')).join('\n');
}

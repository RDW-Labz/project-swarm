// SPDX-License-Identifier: Apache-2.0
// Chief orchestrator planning: one wave across all projects, up to the machine cap.

function fail(message) {
  return Object.assign(new Error(`chief-plan-invalid: ${message}`), { code: 'chief-plan-invalid' });
}

// projects: [{ project: string, ready: [ticket|{id}], running?: number }]
// cap: whole number >= 1 (machine-wide worker limit)
// Returns { wave: [{ project, ticket }], shares: { [project]: { running, planned, total } }, free }.
// Each slot goes to the project with the fewest running+planned jobs that still has a ready ticket,
// so every project with ready work starts jobs in the same wave whenever the cap allows.
export function planWave({ projects = [], cap } = {}) {
  if (!Number.isInteger(cap) || cap < 1) throw fail('cap must be a whole number of at least 1');
  if (!Array.isArray(projects)) throw fail('projects must be an array');
  const seen = new Set();
  const state = [];
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object' || typeof entry.project !== 'string' || !entry.project) throw fail('each project needs a name');
    if (seen.has(entry.project)) throw fail(`duplicate project ${entry.project}`);
    seen.add(entry.project);
    const running = entry.running === undefined ? 0 : entry.running;
    if (!Number.isInteger(running) || running < 0) throw fail(`${entry.project}.running must be a whole number >= 0`);
    const ready = Array.isArray(entry.ready) ? [...entry.ready] : [];
    state.push({ project: entry.project, ready, running, planned: 0 });
  }
  state.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  let free = cap - state.reduce((sum, item) => sum + item.running, 0);
  const wave = [];
  while (free > 0) {
    let pick = null;
    for (const item of state) {
      if (!item.ready.length) continue;
      if (pick === null || item.running + item.planned < pick.running + pick.planned) pick = item;
    }
    if (pick === null) break;
    wave.push({ project: pick.project, ticket: pick.ready.shift() });
    pick.planned += 1;
    free -= 1;
  }
  const shares = {};
  for (const item of state) shares[item.project] = { running: item.running, planned: item.planned, total: item.running + item.planned };
  return { wave, shares, free: Math.max(0, free) };
}

// Slot share per active project, for status output.
export function slotShares(plan) {
  return Object.entries(plan?.shares ?? {})
    .filter(([, share]) => share.total > 0)
    .map(([project, share]) => ({ project, ...share }));
}

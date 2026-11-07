// SPDX-License-Identifier: Apache-2.0
// Cross-project slot sharing for the machine chief: one wave uses the machine cap fairly across projects.
/**
 * @param {Array<{ project: string, ready: number }>} projects
 * @param {number} machineCap
 * @returns {Array<{ project: string, starts: number }>}
 */
export function planCrossProjectWave(projects, machineCap) {
  if (!Number.isInteger(machineCap) || machineCap < 1) {
    throw Object.assign(new Error('machineCap must be a positive integer'), { code: 'bad-cap' });
  }
  const queue = (projects ?? [])
    .filter(entry => entry && typeof entry.project === 'string' && Number.isInteger(entry.ready) && entry.ready > 0)
    .map(entry => ({ project: entry.project, remaining: entry.ready }));
  if (!queue.length) return [];
  const starts = new Map(queue.map(entry => [entry.project, 0]));
  let free = machineCap;
  let turn = 0;
  while (free > 0) {
    const active = queue.filter(entry => entry.remaining > 0);
    if (!active.length) break;
    const pick = active[turn % active.length];
    starts.set(pick.project, (starts.get(pick.project) ?? 0) + 1);
    pick.remaining -= 1;
    free -= 1;
    turn += 1;
  }
  return [...starts.entries()]
    .filter(([, count]) => count > 0)
    .map(([project, count]) => ({ project, starts: count }));
}

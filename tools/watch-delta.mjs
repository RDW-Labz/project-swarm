// SPDX-License-Identifier: Apache-2.0

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function diffSnapshots(prev, next) {
  const pv = prev || null;
  const nx = next || {};
  const keys = {};
  for (const k of Object.keys(nx)) {
    if (k === 'jobs') continue;
    if (!pv || !same(pv[k], nx[k])) keys[k] = clone(nx[k]);
  }
  const prevJobs = pv && Array.isArray(pv.jobs) ? pv.jobs : [];
  const nextJobs = Array.isArray(nx.jobs) ? nx.jobs : [];
  const prevById = new Map(prevJobs.map((j) => [j.id, j]));
  const nextIds = new Set(nextJobs.map((j) => j.id));
  const upserts = nextJobs
    .filter((j) => {
      const p = prevById.get(j.id);
      return !p || !same(p, j);
    })
    .map((j) => clone(j));
  const removed = prevJobs.filter((j) => !nextIds.has(j.id)).map((j) => j.id);
  return { keys, jobs: { upserts, removed } };
}

export function applyDelta(prev, delta) {
  const base = prev || { jobs: [] };
  const d = delta || {};
  const out = { ...base };
  const changed = d.keys || {};
  for (const k of Object.keys(changed)) out[k] = clone(changed[k]);
  const upserts = (d.jobs && d.jobs.upserts) || [];
  const removed = new Set((d.jobs && d.jobs.removed) || []);
  const jobs = (Array.isArray(base.jobs) ? base.jobs : [])
    .filter((j) => !removed.has(j.id))
    .map((j) => clone(j));
  const idx = new Map(jobs.map((j, i) => [j.id, i]));
  for (const u of upserts) {
    if (idx.has(u.id)) {
      jobs[idx.get(u.id)] = clone(u);
    } else {
      idx.set(u.id, jobs.length);
      jobs.push(clone(u));
    }
  }
  out.jobs = jobs;
  return out;
}

export function createThrottle(intervalMs, now = Date.now) {
  let last = null;
  return {
    shouldSend() {
      const t = now();
      if (last === null || t - last >= intervalMs) {
        last = t;
        return true;
      }
      return false;
    },
  };
}

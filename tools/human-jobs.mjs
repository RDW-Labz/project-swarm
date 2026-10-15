// SPDX-License-Identifier: Apache-2.0
// Human jobs (Phase 10c): tasks only the owner can do. A manifest may hold `type: "human"` jobs. Before a
// run starts they are lifted out: the run keeps every job that does not depend on one, and the jobs that
// do depend on one are saved with the humans as a "group" in `.swarm/project/human-jobs.json`. When every
// human in a group is done (and the run that held them is integrated), autopilot starts the saved jobs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeWritableDir, assertRegularOrMissing, sanitizeText } from './journal.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_GROUPS = 200;

export const isHumanJob = job => job?.type === 'human';

// Shape check for one human job; returns nothing, throws Error with a stable `code`.
export function validateHumanJob(job) {
  const bad = (message, code = 'human-job-invalid') => { throw Object.assign(new Error(`Job ${job?.id}: ${message}`), { code }); };
  for (const key of Object.keys(job)) if (!['id', 'type', 'title', 'steps', 'after'].includes(key)) bad(`a human job may not set ${key}`);
  if (typeof job.title !== 'string' || !job.title.trim() || job.title.length > 120) bad('title must be 1-120 characters');
  if (!Array.isArray(job.steps) || !job.steps.length || job.steps.length > 30 || job.steps.some(step => typeof step !== 'string' || !step.trim() || step.length > 400)) bad('steps must be 1-30 strings of at most 400 characters');
}

// Splits a manifest into the part that can run now and the part that waits for people.
export function liftHumanJobs(manifest) {
  const jobs = manifest.jobs ?? [];
  const humans = jobs.filter(isHumanJob);
  if (!humans.length) return { run: manifest, humans: [], deferred: null, edges: {} };
  const humanIds = new Set(humans.map(job => job.id));
  const blocked = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const job of jobs) {
      if (isHumanJob(job) || blocked.has(job.id)) continue;
      if ((job.after ?? []).some(id => humanIds.has(id) || blocked.has(id))) { blocked.add(job.id); changed = true; }
    }
  }
  const { jobs: _jobs, ...rest } = manifest;
  const deferredJobs = jobs.filter(job => blocked.has(job.id)).map(job => {
    const after = (job.after ?? []).filter(id => blocked.has(id));
    const { after: _after, ...others } = job;
    return after.length ? { ...others, after } : others;
  });
  const deferred = deferredJobs.length ? { ...rest, jobs: deferredJobs } : null;
  const humanList = humans.map(job => {
    const reach = new Set();
    for (let grew = true; grew;) {
      grew = false;
      for (const other of jobs) if (blocked.has(other.id) && !reach.has(other.id) && (other.after ?? []).some(id => id === job.id || reach.has(id))) { reach.add(other.id); grew = true; }
    }
    return { id: job.id, title: sanitizeText(job.title), steps: job.steps.map(step => sanitizeText(step)), unblocks: reach.size, done: false };
  });
  const edges = Object.fromEntries(jobs.filter(job => blocked.has(job.id)).map(job => [job.id, [...(job.after ?? [])]]));
  return { run: { ...rest, jobs: jobs.filter(job => !isHumanJob(job) && !blocked.has(job.id)) }, humans: humanList, deferred, edges };
}

const storeFile = root => path.join(root, '.swarm', 'project', 'human-jobs.json');

export async function readStore(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(storeFile(root), 'utf8'));
    return { groups: Array.isArray(parsed?.groups) ? parsed.groups : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { groups: [] };
    throw error;
  }
}

async function writeStore(root, store) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const target = path.join(dir, 'human-jobs.json');
  await assertRegularOrMissing(target);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(store)}\n`, { flag: 'w', mode: 0o600 });
  await fs.rename(temp, target);
}

export async function addGroup(root, { id, humans, deferred, edges = {}, now = Date.now }) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error(`human-group-invalid: ${id}`);
  const store = await readStore(root);
  if (store.groups.some(group => group.id === id)) throw new Error(`human-group-exists: ${id}`);
  store.groups.push({ id, createdAt: new Date(typeof now === 'function' ? now() : now).toISOString(), humans, deferred, edges, started: null });
  while (store.groups.length > MAX_GROUPS) store.groups.shift();
  await writeStore(root, store);
}

export async function updateGroup(root, id, mutate) {
  const store = await readStore(root);
  const group = store.groups.find(item => item.id === id);
  if (!group) throw new Error(`human-group-unknown: ${id}`);
  mutate(group);
  await writeStore(root, store);
  return group;
}

// The group as a run state, so the inbox can list and close its human items like any held job.
export function groupAsState(group) {
  const humans = group.humans.map(human => ({ id: human.id, status: human.done ? 'complete' : 'held', ...(human.done ? {} : { heldReason: 'human' }), title: human.title, steps: human.steps, after: [], ...(human.doneAt ? { human: { doneAt: human.doneAt, by: 'owner' } } : {}) }));
  const waiting = (group.deferred?.jobs ?? []).map(job => ({ id: job.id, status: 'held', heldReason: 'after human', after: group.edges?.[job.id] ?? job.after ?? [] }));
  return { id: group.id, startedAt: group.createdAt, jobs: [...humans, ...waiting], started: group.started };
}

export const humanGroupReady = (group, run) => !group.started && group.humans.length > 0 && group.humans.every(human => human.done)
  && (!run || (run.status === 'complete' && run.integrated === true));

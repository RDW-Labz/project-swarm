// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_WORKER_LEASE_MS = 15 * 60 * 1000;
export const MIN_FREE_DISK_GB = 20;

export function workerQueueFile({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_WORKER_QUEUE_FILE || path.join(env.SWARM_HOME || path.join(home, '.project-swarm'), 'state', 'worker-queue.json');
}

export function workerLanesFile({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_WORKER_LANES_FILE || path.join(env.SWARM_HOME || path.join(home, '.project-swarm'), 'state', 'worker-lanes.json');
}

export function workerPauseFile({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_WORKER_PAUSE_FILE || path.join(env.SWARM_HOME || path.join(home, '.project-swarm'), 'state', 'worker-queue.paused');
}

export async function pauseWorkerQueue({ file = workerPauseFile(), reason = 'brain-move' } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify({ reason, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  return file;
}

export async function resumeWorkerQueue({ file = workerPauseFile() } = {}) {
  await fs.rm(file, { force: true });
  return true;
}

export async function workerQueuePaused({ file = workerPauseFile() } = {}) {
  return fs.stat(file).then(() => true, () => false);
}

export function cooldownKey(machine, lane) {
  return `${machine}|${lane}`;
}

async function readCooldowns(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data && typeof data === 'object' && data.version === 1 && data.lanes && typeof data.lanes === 'object' ? data : { version: 1, lanes: {} };
  } catch { return { version: 1, lanes: {} }; }
}

export async function laneCooling({ machine, lane, file = workerLanesFile(), now = Date.now } = {}) {
  if (!machine || !lane) return null;
  const data = await readCooldowns(file);
  const entry = data.lanes[cooldownKey(machine, lane)];
  return entry && Date.parse(entry.until) > now() ? entry : null;
}

export async function coolLane({ machine, lane, reason = 'rate-limited', ms = 15 * 60 * 1000, file = workerLanesFile(), now = Date.now } = {}) {
  const data = await readCooldowns(file);
  const at = now();
  for (const [key, entry] of Object.entries(data.lanes)) if (!(Date.parse(entry.until) > at)) delete data.lanes[key];
  data.lanes[cooldownKey(machine, lane)] = { until: new Date(at + ms).toISOString(), reason };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  return data.lanes[cooldownKey(machine, lane)];
}

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function emptyQueue() {
  return { version: 1, items: {} };
}

function validItem(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && ['queued', 'leased', 'done', 'failed'].includes(item.status);
}

async function readQueue(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!data || data.version !== 1 || typeof data.items !== 'object' || Array.isArray(data.items)) throw fail('worker-queue-corrupt', `${file} is not a version 1 queue`);
    for (const item of Object.values(data.items)) if (!validItem(item)) throw fail('worker-queue-corrupt', `${file} has a malformed item`);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyQueue();
    if (error instanceof SyntaxError) throw fail('worker-queue-corrupt', `${file} is not valid JSON`);
    throw error;
  }
}

async function writeQueue(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}


async function withQueueLock(file, fn) {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  let handle = null;
  for (;;) {
    try {
      handle = await fs.open(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 10000) { await fs.rm(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw fail('worker-queue-busy', 'worker queue is busy');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lock, { force: true }).catch(() => {});
  }
}

export async function readWorkerQueue({ file = workerQueueFile(), env, home } = {}) {
  return readQueue(file);
}

export function itemId(manifestPath, jobId) {
  const base = path.basename(String(manifestPath)).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${base}:${jobId}`.slice(0, 120);
}

export async function enqueueManifest({ manifestPath, manifest, project, laneOverride = null, file = workerQueueFile(), env, home, now = Date.now } = {}) {
  let data = manifest;
  if (!data) {
    const text = await fs.readFile(manifestPath, 'utf8');
    data = JSON.parse(text);
  }
  if (!data || !Array.isArray(data.jobs) || !data.jobs.length) throw fail('worker-queue-empty', 'manifest has no jobs');
  const queue = await readQueue(file);
  const added = [];
  for (const job of data.jobs) {
    if (!job || typeof job.id !== 'string' || !job.id) continue;
    const id = itemId(manifestPath, job.id);
    if (queue.items[id] && queue.items[id].status !== 'failed') continue;
    queue.items[id] = {
      id,
      project: project ?? path.basename(path.dirname(manifestPath)),
      manifest: manifestPath,
      job: job.id,
      lane: laneOverride ?? job.agent,
      model: job.model ?? null,
      title: job.title ?? job.prompt?.slice(0, 80) ?? job.id,
      manifestData: data,
      status: 'queued',
      attempts: 0,
      lease: null,
      report: null,
      enqueuedAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    added.push(id);
  }
  await writeQueue(file, queue);
  return { added, total: added.length, items: added.map(id => queue.items[id]) };
}

export function expired(item, now) {
  return item?.status === 'leased' && (!item.lease?.expiresAt || Date.parse(item.lease.expiresAt) <= now);
}

export function normalizeExpired(queue, now) {
  let changed = false;
  for (const item of Object.values(queue.items)) {
    if (expired(item, now)) {
      item.status = 'queued';
      item.lease = null;
      item.attempts = (item.attempts ?? 0) + 1;
      item.updatedAt = new Date(now).toISOString();
      changed = true;
    }
  }
  return changed;
}

export async function nextWorkerItem({ lanes = [], machine = null, file = workerQueueFile(), env, home, now = Date.now, lanesFile } = {}) {
  if (await workerQueuePaused({ file: workerPauseFile({ env, home }) })) return null;
  const queue = await readQueue(file);
  const lanesFileResolved = lanesFile ?? workerLanesFile({ env, home });
  const at = now();
  const changed = normalizeExpired(queue, at);
  const laneSet = new Set(lanes);
  const cooling = new Set();
  if (machine) {
    const health = await readCooldowns(lanesFileResolved);
    for (const lane of laneSet) if (health.lanes[cooldownKey(machine, lane)] && Date.parse(health.lanes[cooldownKey(machine, lane)].until) > at) cooling.add(lane);
  }
  const candidates = Object.values(queue.items)
    .filter(item => item.status === 'queued' && (!item.lane || laneSet.has(item.lane)) && !(item.lane && cooling.has(item.lane)))
    .sort((a, b) => String(a.enqueuedAt).localeCompare(String(b.enqueuedAt)) || a.id.localeCompare(b.id));
  if (changed) await writeQueue(file, queue);
  return candidates[0] ?? null;
}

export async function claimWorkerItem(id, holder, { file = workerQueueFile(), env, home, now = Date.now, leaseMs = DEFAULT_WORKER_LEASE_MS } = {}) {
  if (typeof holder !== 'string' || !holder.trim()) throw fail('worker-holder-invalid', 'a worker holder is required');
  const queue = await readQueue(file);
  const at = now();
  normalizeExpired(queue, at);
  const item = queue.items[id];
  if (!item) throw fail('worker-item-unknown', `no work item ${id}`);
  if (item.status !== 'queued') throw fail('worker-lease-held', `${id} is ${item.status}`);
  item.status = 'leased';
  item.lease = { holder, expiresAt: new Date(at + leaseMs).toISOString() };
  item.attempts = (item.attempts ?? 0) + 1;
  item.updatedAt = new Date(at).toISOString();
  await writeQueue(file, queue);
  return item;
}

export async function renewWorkerItem(id, holder, { file = workerQueueFile(), env, home, now = Date.now, leaseMs = DEFAULT_WORKER_LEASE_MS } = {}) {
  const queue = await readQueue(file);
  const item = queue.items[id];
  if (!item) throw fail('worker-item-unknown', `no work item ${id}`);
  if (item.status !== 'leased' || item.lease?.holder !== holder) throw fail('worker-lease-lost', `${id} is not leased to ${holder}`);
  item.lease.expiresAt = new Date(now() + leaseMs).toISOString();
  item.updatedAt = new Date(now()).toISOString();
  await writeQueue(file, queue);
  return item;
}

export async function reportWorkerItem(id, holder, { status, report = null, file = workerQueueFile(), env, home, now = Date.now, lanesFile } = {}) {
  const lanesFileResolved = lanesFile ?? workerLanesFile({ env, home });
  if (!['done', 'failed', 'requeue'].includes(status)) throw fail('worker-report-invalid', 'status must be done, failed or requeue');
  const queue = await readQueue(file);
  const item = queue.items[id];
  if (!item) throw fail('worker-item-unknown', `no work item ${id}`);
  if (item.status === 'leased' && item.lease?.holder !== holder) throw fail('worker-lease-lost', `${id} is not leased to ${holder}`);
  if (status === 'requeue') {
    item.status = 'queued';
    item.attempts = (item.attempts ?? 0) + 1;
    item.report = report;
    item.lastError = report?.status ?? 'requeue';
    if (report?.lane && holder) await coolLane({ machine: String(holder).split('/')[0], lane: report.lane, reason: report.status ?? 'rate-limited', file: lanesFileResolved, now });
  } else {
    item.status = status;
    item.report = report;
  }
  item.lease = null;
  item.updatedAt = new Date(now()).toISOString();
  await writeQueue(file, queue);
  return item;
}

export async function releaseExpiredWorkerItems({ file = workerQueueFile(), env, home, now = Date.now } = {}) {
  const queue = await readQueue(file);
  const at = now();
  const released = [];
  for (const item of Object.values(queue.items)) {
    if (expired(item, at)) {
      item.status = 'queued';
      item.lease = null;
      item.attempts = (item.attempts ?? 0) + 1;
      item.updatedAt = new Date(at).toISOString();
      released.push(item.id);
    }
  }
  if (released.length) await writeQueue(file, queue);
  return { released, queue };
}

export async function listWorkerItems({ file = workerQueueFile(), env, home, now = Date.now } = {}) {
  const queue = await readQueue(file);
  normalizeExpired(queue, now());
  return Object.values(queue.items);
}

export async function clearFinishedWorkerItems({ file = workerQueueFile(), env, home, ids = null } = {}) {
  const queue = await readQueue(file);
  const removed = [];
  for (const [id, item] of Object.entries(queue.items)) {
    if (ids && !ids.includes(id)) continue;
    if (item.status === 'done' || item.status === 'failed') { delete queue.items[id]; removed.push(id); }
  }
  if (removed.length) await writeQueue(file, queue);
  return removed;
}

export function diskGuard(freeDiskGb, { min = MIN_FREE_DISK_GB } = {}) {
  return { ok: Number.isFinite(freeDiskGb) && freeDiskGb >= min, freeDiskGb, min };
}


const _enqueueManifest = enqueueManifest;
enqueueManifest = async (options = {}) => withQueueLock(options.file ?? workerQueueFile({ env: options.env, home: options.home }), () => _enqueueManifest(options));

const _nextWorkerItem = nextWorkerItem;
nextWorkerItem = async (options = {}) => withQueueLock(options.file ?? workerQueueFile({ env: options.env, home: options.home }), () => _nextWorkerItem(options));

const _claimWorkerItem = claimWorkerItem;
claimWorkerItem = async (id, holder, options = {}) => withQueueLock(options.file ?? workerQueueFile({ env: options.env, home: options.home }), () => _claimWorkerItem(id, holder, options));

const _renewWorkerItem = renewWorkerItem;
renewWorkerItem = async (id, holder, options = {}) => withQueueLock(options.file ?? workerQueueFile({ env: options.env, home: options.home }), () => _renewWorkerItem(id, holder, options));

const _reportWorkerItem = reportWorkerItem;
reportWorkerItem = async (id, holder, options = {}) => withQueueLock(options.file ?? workerQueueFile({ env: options.env, home: options.home }), () => _reportWorkerItem(id, holder, options));

const _releaseExpiredWorkerItems = releaseExpiredWorkerItems;
releaseExpiredWorkerItems = async (options = {}) => withQueueLock(options.file ?? workerQueueFile({ env: options.env, home: options.home }), () => _releaseExpiredWorkerItems(options));

const _clearFinishedWorkerItems = clearFinishedWorkerItems;
clearFinishedWorkerItems = async (options = {}) => withQueueLock(options.file ?? workerQueueFile({ env: options.env, home: options.home }), () => _clearFinishedWorkerItems(options));

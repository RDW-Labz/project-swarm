// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import { validateRentedConfig, effectiveRentedRaw } from './rented.mjs';
import { validateLocalLaneBlock, localLaneConcurrency, LOCAL_MODEL_PREFIX, localSlotRoom, attachLocalSlotMeta } from './local-lane.mjs';
import { DEFAULT_MACHINE_SHARE_PRIORITY, machineAllowance } from './project-priority.mjs';
import path from 'node:path';

export { machineAllowance } from './project-priority.mjs';

export const LANE_AGENTS = Object.freeze([
  'hermes', 'cursor', 'codex', 'claude', 'qwen', 'openai', 'gemini', 'ollama', 'lambda', 'openrouter', 'anthropic', 'rented', 'local',
]);
export const LANE_DEFAULTS = Object.freeze(Object.fromEntries(LANE_AGENTS.map(agent => [agent, Object.freeze({
  concurrency: ({ hermes: 1, cursor: 8, codex: 6, claude: 4, openrouter: 64, anthropic: 64 })[agent] ?? 32,
  requestsPerMinute: null,
  backoff: Object.freeze({ baseMs: 2000, maxMs: 300000, maxRetries: 5 }),
  pauseMs: 900000,
  maxPauseMs: 900000,
  model: null,
  paused: agent === 'codex',
  // null, or { start, min }: the lane begins at `start` requests in flight and finds its own limit (see report()).
  adaptive: agent === 'rented' ? Object.freeze({ min: 1, start: 4 }) : null,
})])));

// The claude lane also takes the models for tier "mid" and tier "expensive" jobs (the router falls back to `model`).
const CLAUDE_TIER_FIELDS = Object.freeze(['midModel', 'expensiveModel']);
const CLAUDE_EXTRA_FIELDS = Object.freeze(['shellPaused']);
const LOCAL_LANE_FIELDS = Object.freeze(['endpoints', 'agencyConcurrency']);
function invalid(agent, field, reason) {
  return Object.assign(new Error(`lanes-invalid: ${agent}.${field} ${reason}`), { code: 'lanes-invalid' });
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(agent, field, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(agent, field, `must be an integer ${min}–${max}`);
}
function validate(agent, lane) {
  integer(agent, 'concurrency', lane.concurrency, 1, 2048);
  if (lane.requestsPerMinute !== null) integer(agent, 'requestsPerMinute', lane.requestsPerMinute, 1, 100000);
  integer(agent, 'backoff.baseMs', lane.backoff.baseMs, 1, 600000);
  integer(agent, 'backoff.maxMs', lane.backoff.maxMs, lane.backoff.baseMs, 3600000);
  integer(agent, 'backoff.maxRetries', lane.backoff.maxRetries, 0, 20);
  integer(agent, 'pauseMs', lane.pauseMs, 1, 86400000);
  integer(agent, 'maxPauseMs', lane.maxPauseMs, 1, 86400000);
  if (lane.adaptive !== null) {
    if (!object(lane.adaptive) || Object.keys(lane.adaptive).some(key => !['start', 'min'].includes(key))) throw invalid(agent, 'adaptive', 'must be null, true or { start, min }');
    integer(agent, 'adaptive.min', lane.adaptive.min, 1, lane.concurrency);
    integer(agent, 'adaptive.start', lane.adaptive.start, lane.adaptive.min, lane.concurrency);
  }
  for (const field of CLAUDE_TIER_FIELDS) if (Object.hasOwn(lane, field) && lane[field] !== null && (typeof lane[field] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/.test(lane[field]))) throw invalid(agent, field, 'must be null or a valid model name');
  if (lane.model !== null && (typeof lane.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/.test(lane.model))) {
    throw invalid(agent, 'model', 'must be null or a valid model name');
  }
  if (Object.hasOwn(lane, 'paused') && lane.paused !== true && lane.paused !== false) throw invalid(agent, 'paused', 'must be true or false');
  if (agent === 'claude' && Object.hasOwn(lane, 'shellPaused') && lane.shellPaused !== true && lane.shellPaused !== false) throw invalid(agent, 'shellPaused', 'must be true or false');
}

export function resolveLanes({ config = {}, manifest = {}, env = process.env } = {}) {
  const lanes = Object.fromEntries(LANE_AGENTS.map(agent => [agent, { ...LANE_DEFAULTS[agent], backoff: { ...LANE_DEFAULTS[agent].backoff }, ...(LANE_DEFAULTS[agent].adaptive ? { adaptive: { ...LANE_DEFAULTS[agent].adaptive } } : {}) }]));
  // The rented lane's ceiling and starting point come from the machine config's rentedGpu block.
  // A running GPU session (swarm gpu up) lays its replicas and model over that block and makes the lane routable; without one the lane never is.
  const { raw: rentedRaw, session: gpuSession } = effectiveRentedRaw(config.rentedGpu, env);
  const rented = rentedRaw === undefined ? null : validateRentedConfig(rentedRaw, { allowSession: Boolean(gpuSession) }).config;
  if (rented) { lanes.rented.concurrency = rented.concurrency; lanes.rented.adaptive = { ...rented.adaptive }; }
  // routable only for a live session that is not a bake-off's (a bake-off session carries routable: false and uses explicit rented jobs)
  const routableSession = Boolean(rented && gpuSession && gpuSession.routable !== false);
  if (routableSession) lanes.rented.model = rented.model;
  for (const source of [config.lanes, manifest.lanes]) {
    if (source === undefined) continue;
    if (!object(source)) throw invalid('lanes', 'value', 'must be an object');
    for (const [agent, override] of Object.entries(source)) {
      if (!LANE_AGENTS.includes(agent)) throw invalid(agent, 'agent', 'is unknown');
      if (!object(override)) throw invalid(agent, 'value', 'must be an object');
      for (const [field, value] of Object.entries(override)) {
        if (agent === 'local' && LOCAL_LANE_FIELDS.includes(field)) continue;
        if (!Object.hasOwn(LANE_DEFAULTS[agent], field) && !(agent === 'claude' && (CLAUDE_TIER_FIELDS.includes(field) || CLAUDE_EXTRA_FIELDS.includes(field))) && !(agent === 'local' && LOCAL_LANE_FIELDS.includes(field))) throw invalid(agent, field, 'is unknown');
        if (field === 'backoff') {
          if (!object(value)) throw invalid(agent, field, 'must be an object');
          for (const [key, entry] of Object.entries(value)) {
            if (!Object.hasOwn(LANE_DEFAULTS[agent].backoff, key)) throw invalid(agent, `backoff.${key}`, 'is unknown');
            lanes[agent].backoff[key] = entry;
          }
        } else if (field === 'adaptive') lanes[agent].adaptive = value === true ? {} : value === false ? null : value;
        else lanes[agent][field] = value;
      }
    }
  }
  // adaptive: true (or a partial object) is filled in from the lane's concurrency once every override is applied.
  // Overrides in a manifest or the lanes config can lower the rented lane, never lift it past the ceiling rentedGpu names.
  if (rented) { lanes.rented.concurrency = Math.min(lanes.rented.concurrency, rented.concurrency); if (lanes.rented.adaptive && typeof lanes.rented.adaptive === 'object') lanes.rented.adaptive.start = Math.min(lanes.rented.adaptive.start ?? 4, lanes.rented.concurrency); }
  // No override may make the rented lane routable without a live session.
  if (!routableSession) lanes.rented.model = null;
  const machine = machineConcurrency(config);
  if (machine !== null) lanes.anthropic.concurrency = machine;
  for (const agent of LANE_AGENTS) {
    const adaptive = lanes[agent].adaptive;
    if (object(adaptive) && Object.keys(adaptive).every(key => ['start', 'min'].includes(key))) lanes[agent].adaptive = { min: adaptive.min ?? 1, start: adaptive.start ?? Math.max(adaptive.min ?? 1, Math.min(8, lanes[agent].concurrency)) };
  }
  const localBlock = validateLocalLaneBlock(config?.lanes?.local);
  if (config?.lanes?.local !== undefined || localBlock.endpoints.length > 0) {
    lanes.local.endpoints = localBlock.endpoints;
    lanes.local.agencyConcurrency = localBlock.agencyConcurrency;
  }
  if (localBlock.endpoints.length) {
    lanes.local.concurrency = localLaneConcurrency(localBlock.endpoints);
    lanes.local.model = `${LOCAL_MODEL_PREFIX}${localBlock.endpoints[0].name}`;
  } else {
    lanes.local.model = null;
  }
  for (const agent of LANE_AGENTS) validate(agent, lanes[agent]);
  return lanes;
}

export function classifyProviderOutcome(result) {
  const { status, error, httpStatus, retryAfterMs, quotaExhausted, resetsAt } = result ?? {};
  const retry = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
  const reset = typeof resetsAt === 'string' ? resetsAt : null;
  let kind = 'other';
  if (status === 'complete') kind = 'ok';
  else if (status === 'provider-limit' || quotaExhausted === true || httpStatus === 402
    || (typeof error === 'string' && /\b(quota (exhausted|exceeded)|insufficient[_ ](quota|credits?)|out of credits?)\b/i.test(error))) kind = 'quota-exhausted';
  else if (httpStatus === 429 || (typeof error === 'string' && /\b(429|rate[- ]?limit(ed)?|too many requests)\b/i.test(error))) kind = 'rate-limited';
  return { kind, retryAfterMs: retry, resetsAt: reset };
}

function abortError() {
  return Object.assign(new Error('Lane scheduler closed or acquisition aborted'), { name: 'AbortError' });
}

// Machine-wide lane state sits next to the shared install, like the spend store: every run
// (parent, child, and other repositories) counts in-flight jobs and pauses against one file.
export function lanesDir(env = process.env, home = os.homedir()) {
  if (env.SWARM_LANES_DIR) return env.SWARM_LANES_DIR;
  // The test suite simulates 429s and quota pauses. A 15-minute pause must not stall unrelated
  // tests in the same process. Those runs get a private directory; a test that needs the shared
  // file sets SWARM_LANES_DIR. Production runs (no SWARM_TEST_TMP) always share one file.
  if (env.SWARM_TEST_TMP) return path.join(env.SWARM_TEST_TMP, `lanes-${crypto.randomUUID()}`);
  return path.join(home, '.project-swarm', 'lanes');
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
const storeError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const slotLive = (slot, host, isAlive) => slot.host !== host || isAlive(slot.pid);

function validStore(store) {
  if (!object(store) || store.version !== 1 || !object(store.slots) || !object(store.pauses)) return false;
  for (const [agent, slots] of Object.entries(store.slots)) {
    if (!LANE_AGENTS.includes(agent) || !Array.isArray(slots)) return false;
    for (const slot of slots) {
      if (!object(slot) || typeof slot.id !== 'string' || !slot.id || !Number.isInteger(slot.pid) || slot.pid <= 0 || typeof slot.host !== 'string' || !slot.host || typeof slot.runId !== 'string') return false;
    }
  }
  for (const [agent, pause] of Object.entries(store.pauses)) {
    if (!LANE_AGENTS.includes(agent) || !object(pause) || (pause.state !== 'backoff' && pause.state !== 'paused') || !Number.isFinite(pause.until) || !Number.isInteger(pause.consecutiveRateLimits) || pause.consecutiveRateLimits < 0) return false;
  }
  return true;
}

// Callers in this process go through one queue per store, so a thousand workers starting or stopping at once do not all poll the lock file: one of them holds the file lock at a time and
// the rest wait their turn here (found by the 1,000-worker practice run: cancelling 1,000 workers made them time out on lanes.lock). The file lock still keeps other processes out.
// A caller waits only while the queue is moving: if no turn has started or finished for `timeoutMs`, the waiter gives up with lanes-store-locked (a hung holder can no longer block every
// worker forever), and its own turn is skipped when it comes. A call made from inside a turn of the same store would wait for itself, so it fails at once.
const storeQueues = new Map();
const inTurn = new AsyncLocalStorage();
export function withLaneStore(fn, options = {}) {
  const dir = options.dir ?? lanesDir();
  if (inTurn.getStore()?.has(dir)) return Promise.reject(storeError('lanes-store-reentrant', 'withLaneStore was called from inside a lane store turn on the same store; that would wait for itself'));
  const timeoutMs = options.timeoutMs ?? 10000;
  let queue = storeQueues.get(dir);
  if (!queue) { queue = { tail: Promise.resolve(), progress: Date.now(), pending: 0 }; storeQueues.set(dir, queue); }
  if (queue.pending === 0) queue.progress = Date.now();
  queue.pending += 1;
  let abandoned = false, running = false;
  const turn = queue.tail.then(async () => {
    if (abandoned) return undefined;
    running = true;
    queue.progress = Date.now();
    try { return await inTurn.run(new Set([...(inTurn.getStore() ?? []), dir]), () => withLaneStoreFile(fn, { ...options, dir })); }
    finally { queue.progress = Date.now(); }
  });
  const tail = turn.catch(() => {});
  queue.tail = tail;
  tail.then(() => { queue.pending -= 1; if (queue.pending === 0 && storeQueues.get(dir) === queue) storeQueues.delete(dir); });
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      // Only a caller still waiting for its turn gives up; one that is running is bounded by its own work.
      if (running || Date.now() - queue.progress <= timeoutMs) return;
      abandoned = true; clearInterval(timer);
      reject(storeError('lanes-store-locked', `timed out waiting in the lane store queue (no turn finished for ${timeoutMs} ms)`));
    }, Math.max(5, Math.min(250, Math.floor(timeoutMs / 4))));
    turn.then(value => { clearInterval(timer); resolve(value); }, error => { clearInterval(timer); reject(error); });
  });
}

async function withLaneStoreFile(fn, { dir = lanesDir(), now = Date.now, isAlive = pidAlive, timeoutMs = 10000 } = {}) {
  const lock = path.join(dir, 'lanes.lock'), file = path.join(dir, 'lanes.json');
  const host = os.hostname(), started = Date.now();
  await fs.mkdir(dir, { recursive: true });
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lock);
        let owner;
        try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); }
        catch (error) {
          if (error instanceof SyntaxError) owner = {};
          else if (error.code !== 'ENOENT') throw error;
        }
        if ((owner?.host === host && Number.isInteger(owner.pid) && owner.pid > 0 && !isAlive(owner.pid)) || (!owner && Date.now() - stat.mtimeMs > 60000)) {
          const cleanup = path.join(lock, 'cleanup');
          try { await fs.mkdir(cleanup); } catch (error) {
            if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
            if (Date.now() - started >= timeoutMs) throw storeError('lanes-store-locked', 'timed out waiting for stale lock cleanup');
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
          }
          const current = await fs.stat(lock);
          if (current.ino !== stat.ino || current.dev !== stat.dev) {
            await fs.rm(cleanup, { recursive: true, force: true });
            continue;
          }
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (Date.now() - started >= timeoutMs) throw storeError('lanes-store-locked', 'timed out waiting for lanes.lock');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
  let temp;
  try {
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host, at: new Date(now()).toISOString() }));
    let store;
    try { store = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') store = { version: 1, slots: {}, pauses: {} };
      else throw storeError('lanes-store-invalid', 'lanes.json could not be read as JSON');
    }
    if (!validStore(store)) throw storeError('lanes-store-invalid', 'lanes.json has an invalid shape');
    const before = JSON.stringify(store);
    for (const [agent, slots] of Object.entries(store.slots)) {
      const live = slots.filter(slot => slotLive(slot, host, isAlive));
      if (live.length) store.slots[agent] = live;
      else delete store.slots[agent];
    }
    for (const [agent, pause] of Object.entries(store.pauses)) if (!(pause.until > now())) delete store.pauses[agent];
    // The waiting list is advisory: a malformed one is reset (never an error that stops every run), dead or expired entries are dropped.
    if (store.demand !== undefined) {
      if (!store.demand || typeof store.demand !== 'object' || Array.isArray(store.demand)) store.demand = {};
      for (const [key, entry] of Object.entries(store.demand)) {
        const ok = entry && typeof entry === 'object' && Number.isInteger(entry.pid) && entry.pid > 0 && typeof entry.host === 'string' && entry.host && Number.isInteger(entry.count) && entry.count > 0 && typeof entry.project === 'string' && Number.isFinite(entry.at) && now() - entry.at <= DEMAND_TTL_MS * 4;
        if (!ok || !slotLive(entry, host, isAlive)) delete store.demand[key];
      }
    }
    const result = await fn(store);
    if (JSON.stringify(store) !== before) {
      temp = path.join(dir, `.lanes-${process.pid}-${crypto.randomUUID()}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(store)}\n`); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
      temp = null;
    }
    return result;
  } finally {
    if (temp) await fs.rm(temp, { force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}

// The machine-wide worker limit from the local config (`machineConcurrency`): null (no limit, the default) or a whole number 1 to 2048. Anything else is an error, never "no limit".
export function machineConcurrency(config) {
  const value = config?.machineConcurrency;
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 2048) throw Object.assign(new Error('lanes-invalid: machineConcurrency must be a whole number from 1 to 2048 (or left out for no limit)'), { code: 'lanes-invalid' });
  return value;
}

// Fair sharing of a machine-wide worker limit between projects (the setting `machineConcurrency`).
// Active projects split the limit by `machineSharePriority` (see project-priority.mjs); each gets at least one slot when active.
// A project may borrow what the others are not using, but never what another active project is still entitled to and asking for.
// Where there are more projects than workers (shares of 1), a freed worker goes to the project that has waited longest, not back to the one that freed it.
// Lane limits and spend caps are separate and unchanged.
const DEMAND_TTL_MS = 5000;           // a waiting run refreshes its entry every poll; one that stops polling stops reserving
const demandKey = (project, runId, agent) => `${project}|${runId}|${agent}`;

function grantSlotId(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry;
  return typeof entry.slotId === 'string' ? entry.slotId : null;
}

function grantJobId(entry) {
  if (entry == null || typeof entry !== 'object') return null;
  return typeof entry.jobId === 'string' && entry.jobId ? entry.jobId : null;
}

// Weight for `machineAllowance` on this claim: explicit machine fields, then this project's live slots or demand, else the default.
function machineSharePriorityForClaim(store, project, machine) {
  const explicit = machine?.priority ?? machine?.machineSharePriority;
  if (explicit !== undefined) return explicit;
  for (const held of Object.values(store.slots ?? {})) {
    if (!Array.isArray(held)) continue;
    for (const slot of held) {
      if (slot?.project === project && slot.machineSharePriority !== undefined) return slot.machineSharePriority;
    }
  }
  const demand = store.demand && typeof store.demand === 'object' && !Array.isArray(store.demand) ? store.demand : {};
  for (const entry of Object.values(demand)) {
    if (entry?.project === project && entry.machineSharePriority !== undefined) return entry.machineSharePriority;
  }
  return DEFAULT_MACHINE_SHARE_PRIORITY;
}

// One lock grants every slot this run can take. A per-job lock on a slow disk spaces
// state writes past the coalesce window.
export function claimLaneSlots({ dir, agent, concurrency, count, runId = '', machine = null, now = Date.now, isAlive, local = null, jobIds = null } = {}) {
  return withLaneStore(store => {
    const slots = store.slots[agent] ?? [];
    const pause = store.pauses[agent];
    if (pause && pause.until > now()) return { granted: [], reason: pause.state, state: pause.state, until: pause.until, consecutiveRateLimits: pause.consecutiveRateLimits, inFlight: slots.length };
    const laneRoom = Math.max(0, concurrency - slots.length);
    let take = Math.min(Math.max(0, count), laneRoom);
    let machineLimited = false;
    if (machine?.max) {
      const project = String(machine.project ?? '');
      const time = now();
      const priority = machineSharePriorityForClaim(store, project, machine);
      const { allowed } = machineAllowance({
        store, project, count: take, max: machine.max, isAlive: isAlive ?? pidAlive, time, priority,
      });
      if (allowed < take) machineLimited = true;
      take = Math.min(take, allowed);
      // What this run still waits for on this lane (not what the lane's own limit holds back) is written down, so the others leave its share for it.
      store.demand = store.demand && typeof store.demand === 'object' && !Array.isArray(store.demand) ? store.demand : {};
      const key = demandKey(project, runId, agent);
      const waitingFor = Math.max(0, Math.min(count, laneRoom) - take);
      if (waitingFor > 0 && project) {
        store.demand[key] = {
          project, runId, agent, count: waitingFor, pid: process.pid, host: os.hostname(),
          since: store.demand[key]?.since ?? time, at: time, machineSharePriority: priority,
        };
      }
      else delete store.demand[key];
    }
    if (take === 0) return { granted: [], reason: machineLimited ? 'machine-full' : 'full', inFlight: slots.length };
    const granted = new Array(take).fill(null);
    const tagJobs = Array.isArray(jobIds) && jobIds.length >= take;
    const localFor = index => (Array.isArray(local) ? local[index] ?? null : local);
    for (let n = 0; n < take; n += 1) {
      const localMeta = localFor(n);
      if (agent === 'local' && localMeta?.endpoint) {
        const room = localSlotRoom({ slots: { local: slots } }, {
          endpoint: localMeta.endpoint,
          slotsLimit: localMeta.slotsLimit ?? concurrency,
          agency: Boolean(localMeta.agency),
          agencyConcurrency: localMeta.agencyConcurrency ?? 1,
        });
        if (room < 1) continue;
      }
      const slotPriority = machine?.max ? machineSharePriorityForClaim(store, String(machine.project ?? ''), machine) : undefined;
      let slot = {
        id: crypto.randomUUID(), pid: process.pid, host: os.hostname(), runId,
        ...(machine?.project ? { project: String(machine.project) } : {}),
        ...(slotPriority !== undefined ? { machineSharePriority: slotPriority } : {}),
      };
      if (agent === 'local' && localMeta?.endpoint) slot = attachLocalSlotMeta(slot, { endpoint: localMeta.endpoint, agency: Boolean(localMeta.agency) });
      slots.push(slot);
      granted[n] = tagJobs ? { jobId: jobIds[n], slotId: slot.id } : slot.id;
    }
    store.slots[agent] = slots;
    if (!granted.some(Boolean)) return { granted: [], reason: 'full', inFlight: slots.length };
    return { granted, inFlight: slots.length };
  }, { dir, now, isAlive });
}

// A run that closes no longer waits: its own waiting entries go, never a sibling run's of the same project.
export function clearMachineDemand({ dir, project, runId, now = Date.now, isAlive } = {}) {
  return withLaneStore(store => {
    if (!store.demand || typeof store.demand !== 'object') return;
    for (const [key, entry] of Object.entries(store.demand)) if (entry?.project === project && entry?.runId === runId) delete store.demand[key];
  }, { dir, now, isAlive });
}

export function releaseLaneSlot({ dir, agent, slotId, now = Date.now, isAlive } = {}) {
  return releaseLaneSlots({ dir, slots: [{ agent, slotId }], now, isAlive });
}

export function releaseLaneSlots({ dir, slots, now = Date.now, isAlive } = {}) {
  const ids = new Set((slots ?? []).map(slot => slot.slotId));
  if (!ids.size) return Promise.resolve();
  return withLaneStore(store => {
    for (const [agent, held] of Object.entries(store.slots)) {
      const live = held.filter(slot => !ids.has(slot.id));
      if (live.length) store.slots[agent] = live;
      else delete store.slots[agent];
    }
  }, { dir, now, isAlive });
}

// A quota pause is never shortened by a rate-limit backoff. A later pause replaces an earlier one.
export function writeLanePause({ dir, agent, state, until, consecutiveRateLimits = 0, now = Date.now, isAlive } = {}) {
  return withLaneStore(store => {
    const time = now();
    const live = store.pauses[agent];
    const active = live && live.until > time ? live : null;
    if (state === 'ok' || until == null) {
      if (active) active.consecutiveRateLimits = 0;
      return;
    }
    const replace = !active || state === 'paused' || active.state !== 'paused' || active.until < until;
    if (replace) store.pauses[agent] = { state, until, consecutiveRateLimits };
    else active.consecutiveRateLimits = Math.max(active.consecutiveRateLimits, consecutiveRateLimits);
  }, { dir, now, isAlive });
}

export class LaneScheduler {
  constructor({ lanes, globalConcurrency, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, shared = null }) {
    integer('global', 'concurrency', globalConcurrency, 1, 2048);
    this.lanes = resolveLanes({ manifest: { lanes } });
    this.globalConcurrency = globalConcurrency;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;
    const machinePriority = shared?.machine?.priority ?? shared?.machine?.machineSharePriority;
    this.shared = shared ? {
      dir: shared.dir, runId: shared.runId ?? '', isAlive: shared.isAlive ?? pidAlive, file: path.join(shared.dir, 'lanes.json'),
      machine: shared.machine?.max ? {
        max: shared.machine.max,
        project: shared.machine.project ?? '',
        ...(machinePriority !== undefined ? { priority: machinePriority } : {}),
      } : null,
      claimWait: shared.claimWait ?? null,
    } : null;
    this.held = [];
    this.pendingReleases = [];
    this.releaseWaiters = [];
    this.refillTimer = null;
    this.sharedChain = Promise.resolve();
    this.globalInFlight = 0;
    this.peakGlobal = 0;
    this.nextArrival = 0;
    this.closed = false;
    this.timer = null;
    this.states = Object.fromEntries(LANE_AGENTS.map(agent => [agent, {
      state: 'ok', until: null, inFlight: 0, machineInFlight: null, peak: 0, queue: [], acquisitions: [], consecutiveRateLimits: 0, used: false,
      limit: this.lanes[agent].adaptive ? this.lanes[agent].adaptive.start : this.lanes[agent].concurrency, okStreak: 0,
    }]));
  }

  // How many requests this lane may have in flight right now: its configured cap, or, when adaptive, the limit it has found so far.
  limitOf(agent) {
    return this.lanes[agent].adaptive ? this.states[agent].limit : this.lanes[agent].concurrency;
  }

  lane(agent) {
    if (!Object.hasOwn(this.states, agent)) throw invalid(agent, 'agent', 'is unknown');
    return this.states[agent];
  }

  refresh(lane, time) {
    this.readShared(time);
    if (lane.until !== null && lane.until <= time) {
      lane.state = 'ok';
      lane.until = null;
    }
    while (lane.acquisitions.length && lane.acquisitions[0] <= time - 60000) lane.acquisitions.shift();
  }

  // The file is the source of truth for other runs. A local quota pause still wins over a shorter backoff.
  // Reads that only look (health, pausedFor, snapshot) reuse the last read while the file is unchanged; a pump always reads fresh.
  // Liveness of a slot's pid is checked once per pid per read, not once per slot.
  readShared(time, fresh = false) {
    if (!this.shared) return;
    // The file is only parsed again when it changed (size or modification time) or a second has passed (a slot's process may have died).
    let signature = null;
    try { const stat = statSync(this.shared.file); signature = `${stat.mtimeMs}:${stat.size}`; } catch { /* no file yet */ }
    if (!fresh && signature !== null && signature === this.sharedSignature && time >= this.lastSharedRead && time - this.lastSharedRead < 1000) return;
    this.sharedSignature = signature;
    this.lastSharedRead = time;
    let store;
    try { store = JSON.parse(readFileSync(this.shared.file, 'utf8')); }
    catch { return; }
    if (!validStore(store)) return;
    const host = os.hostname();
    const seen = new Map();
    const alive = pid => { if (!seen.has(pid)) seen.set(pid, this.shared.isAlive(pid)); return seen.get(pid); };
    this.machineTotal = 0;
    for (const agent of LANE_AGENTS) {
      const lane = this.states[agent];
      const slots = store.slots[agent] ?? [];
      lane.machineInFlight = slots.filter(slot => slotLive(slot, host, alive)).length;
      this.machineTotal += lane.machineInFlight;
      const pause = store.pauses[agent];
      if (!pause || !(pause.until > time)) continue;
      const keep = lane.state === 'paused' && lane.until !== null && lane.until >= pause.until && pause.state !== 'paused';
      if (!keep) {
        lane.state = pause.state;
        lane.until = pause.until;
        lane.used = true;
      }
      lane.consecutiveRateLimits = Math.max(lane.consecutiveRateLimits, pause.consecutiveRateLimits);
    }
  }

  acquire(agent, { signal, local = null, jobId = null } = {}) {
    const lane = this.lane(agent);
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    lane.used = true;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null, arrival: this.nextArrival++, local, jobId };
      waiter.abort = () => {
        const index = lane.queue.indexOf(waiter);
        if (index < 0) return;
        lane.queue.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        reject(abortError());
        if (this.shared) this.scheduleShared();
        else this.pump();
      };
      lane.queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (this.shared) this.scheduleShared();
      else this.pump();
    });
  }

  enqueuePump() {
    this.sharedChain = this.sharedChain.then(() => (this.closed ? null : this.pumpShared())).catch(error => {
      for (const lane of Object.values(this.states)) for (const waiter of lane.queue.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.reject(error);
      }
      for (const resolve of this.releaseWaiters.splice(0)) resolve();
    });
  }

  // One turn of the event loop collects every acquire and release already queued, then one
  // pump grants or frees them together. A per-job pump refills one slot at a time and the
  // state-file coalesce window misses the burst.
  scheduleShared() {
    if (!this.shared || this.closed || this.refillTimer !== null) return;
    this.refillTimer = this.setTimer(() => {
      this.refillTimer = null;
      this.enqueuePump();
    }, 0);
  }

  scheduleWake(callback, delay) {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.closed) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      callback();
    }, delay);
  }

  async flushReleases() {
    const slots = this.pendingReleases.splice(0);
    const waiters = this.releaseWaiters.splice(0);
    try {
      if (slots.length) await releaseLaneSlots({ dir: this.shared.dir, slots, now: this.now, isAlive: this.shared.isAlive });
    } catch (error) {
      this.pendingReleases.unshift(...slots);
      this.releaseWaiters.unshift(...waiters);
      throw error;
    }
    for (const resolve of waiters) resolve();
  }

  async pumpShared() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed) return;
    await this.flushReleases();
    if (this.closed) return;
    const time = this.now();
    let wakeAt = Infinity;
    this.readShared(time, true);
    for (const agent of LANE_AGENTS) {
      const lane = this.states[agent];
      this.refresh(lane, time);
      if (lane.until !== null) wakeAt = Math.min(wakeAt, lane.until);
    }
    const skipped = new Set();
    const releaseSlot = (agent, slotId) => releaseLaneSlot({ dir: this.shared.dir, agent, slotId, now: this.now, isAlive: this.shared.isAlive });
    while (this.globalInFlight < this.globalConcurrency) {
      let selected = null;
      for (const agent of LANE_AGENTS) {
        if (skipped.has(agent)) continue;
        const lane = this.states[agent];
        const limits = this.lanes[agent];
        if (!lane.queue.length || lane.state !== 'ok') continue;
        if (lane.machineInFlight !== null && lane.machineInFlight >= this.limitOf(agent)) { skipped.add(agent); continue; }
        if (limits.requestsPerMinute !== null && lane.acquisitions.length >= limits.requestsPerMinute) continue;
        if (selected === null || lane.queue[0].arrival < this.states[selected].queue[0].arrival) selected = agent;
      }
      if (selected === null) break;
      const lane = this.states[selected];
      const limits = this.lanes[selected];
      let otherEarliest = Infinity;
      for (const agent of LANE_AGENTS) {
        if (agent === selected || skipped.has(agent)) continue;
        const other = this.states[agent];
        const otherLimits = this.lanes[agent];
        if (!other.queue.length || other.state !== 'ok') continue;
        if (other.machineInFlight !== null && other.machineInFlight >= this.limitOf(agent)) continue;
        if (otherLimits.requestsPerMinute !== null && other.acquisitions.length >= otherLimits.requestsPerMinute) continue;
        otherEarliest = Math.min(otherEarliest, other.queue[0].arrival);
      }
      // The machine is full and this run's waiting entry was written a moment ago: look again later without taking the file lock (the entry is refreshed at least every second).
      if (this.shared.machine && Number.isFinite(this.machineTotal) && this.machineTotal >= this.shared.machine.max && time - (this.lastDemandAt ?? -Infinity) < 1000) { skipped.add(selected); continue; }
      const waiters = [];
      for (const waiter of lane.queue) {
        if (waiter.arrival > otherEarliest) break;
        if (this.globalInFlight + waiters.length >= this.globalConcurrency) break;
        if (lane.inFlight + waiters.length >= this.limitOf(selected)) break;
        if (limits.requestsPerMinute !== null && lane.acquisitions.length + waiters.length >= limits.requestsPerMinute) break;
        waiters.push(waiter);
      }
      if (!waiters.length) break;
      if (this.shared.claimWait) await this.shared.claimWait({ agent: selected, waiters });
      const tagGrants = waiters.every(waiter => waiter.jobId);
      let claim;
      try {
        claim = await claimLaneSlots({
          dir: this.shared.dir, agent: selected, concurrency: this.limitOf(selected), count: waiters.length, runId: this.shared.runId,
          machine: this.shared.machine, now: this.now, isAlive: this.shared.isAlive,
          local: selected === 'local' ? waiters.map(waiter => waiter.local ?? null) : null,
          jobIds: tagGrants ? waiters.map(waiter => waiter.jobId) : null,
        });
      }
      catch (error) {
        for (const waiter of waiters) {
          const index = lane.queue.indexOf(waiter);
          if (index >= 0) lane.queue.splice(index, 1);
          waiter.signal?.removeEventListener('abort', waiter.abort);
          waiter.reject(error);
        }
        continue;
      }
      const pending = this.closed ? [] : waiters.filter(waiter => lane.queue.includes(waiter));
      const pendingIds = new Set(pending.map(waiter => waiter.jobId).filter(Boolean));
      const grantByJobId = new Map();
      for (const grant of claim.granted) {
        const jobId = grantJobId(grant);
        if (jobId) grantByJobId.set(jobId, grantSlotId(grant));
      }
      for (const grant of claim.granted) {
        const slotId = grantSlotId(grant);
        if (!slotId) continue;
        const jobId = grantJobId(grant);
        if (jobId && !pendingIds.has(jobId)) await releaseSlot(selected, slotId);
        else if (!jobId && !tagGrants) {
          const index = claim.granted.indexOf(grant);
          if (index >= pending.length) await releaseSlot(selected, slotId);
        }
      }
      const grantedByWaiter = tagGrants
        ? pending.map(waiter => (waiter.jobId ? grantByJobId.get(waiter.jobId) ?? null : null))
        : pending.map((_, index) => claim.granted[index] ?? null);
      const grantCount = grantedByWaiter.map(grantSlotId).filter(Boolean).length;
      if (this.closed) return;
      if (claim.reason === 'machine-full') this.lastDemandAt = time;
      if (!grantCount) {
        if (claim.state) {
          if (lane.state !== 'paused' || lane.until < claim.until) {
            lane.state = claim.state;
            lane.until = claim.until;
          }
          if (claim.until) wakeAt = Math.min(wakeAt, claim.until);
        } else skipped.add(selected);
        continue;
      }
      lane.machineInFlight = claim.inFlight - (claim.granted.filter(Boolean).length - grantCount);
      for (let n = 0; n < pending.length; n += 1) {
        const waiter = pending[n];
        const slotId = grantSlotId(grantedByWaiter[n]);
        if (!slotId) continue;
        const index = lane.queue.indexOf(waiter);
        if (index >= 0) lane.queue.splice(index, 1);
        waiter.signal?.removeEventListener('abort', waiter.abort);
        lane.inFlight += 1;
        this.globalInFlight += 1;
        lane.peak = Math.max(lane.peak, lane.inFlight);
        this.peakGlobal = Math.max(this.peakGlobal, this.globalInFlight);
        if (limits.requestsPerMinute !== null) lane.acquisitions.push(time);
        this.held.push({ agent: selected, slotId });
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          lane.inFlight -= 1;
          this.globalInFlight -= 1;
          if (lane.machineInFlight !== null) lane.machineInFlight = Math.max(0, lane.machineInFlight - 1);
          this.held = this.held.filter(slot => slot.slotId !== slotId);
          return new Promise(resolve => {
            this.pendingReleases.push({ agent: selected, slotId });
            this.releaseWaiters.push(resolve);
            this.scheduleShared();
          });
        });
      }
    }
    if (skipped.size) wakeAt = Math.min(wakeAt, this.now() + 25);
    for (const agent of LANE_AGENTS) {
      const lane = this.states[agent];
      const limits = this.lanes[agent];
      if (lane.state !== 'ok') continue;
      if (lane.queue.length && limits.requestsPerMinute !== null && lane.acquisitions.length >= limits.requestsPerMinute) {
        wakeAt = Math.min(wakeAt, lane.acquisitions[0] + 60000);
      }
    }
    if (Number.isFinite(wakeAt)) this.scheduleWake(() => this.scheduleShared(), Math.max(0, wakeAt - this.now()));
  }

  pump() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed) return;
    const time = this.now();
    let wakeAt = Infinity;
    for (const agent of LANE_AGENTS) {
      const lane = this.states[agent];
      this.refresh(lane, time);
      if (lane.until !== null) wakeAt = Math.min(wakeAt, lane.until);
    }
    while (this.globalInFlight < this.globalConcurrency) {
      let selected = null;
      for (const agent of LANE_AGENTS) {
        const lane = this.states[agent];
        const limits = this.lanes[agent];
        if (!lane.queue.length || lane.state !== 'ok' || lane.inFlight >= this.limitOf(agent)) continue;
        if (limits.requestsPerMinute !== null && lane.acquisitions.length >= limits.requestsPerMinute) continue;
        if (selected === null || lane.queue[0].arrival < this.states[selected].queue[0].arrival) selected = agent;
      }
      if (selected === null) break;
      const lane = this.states[selected];
      const limits = this.lanes[selected];
      const waiter = lane.queue.shift();
      waiter.signal?.removeEventListener('abort', waiter.abort);
      lane.inFlight += 1;
      this.globalInFlight += 1;
      lane.peak = Math.max(lane.peak, lane.inFlight);
      this.peakGlobal = Math.max(this.peakGlobal, this.globalInFlight);
      if (limits.requestsPerMinute !== null) lane.acquisitions.push(time);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        lane.inFlight -= 1;
        this.globalInFlight -= 1;
        this.pump();
      });
    }
    for (const agent of LANE_AGENTS) {
      const lane = this.states[agent];
      const limits = this.lanes[agent];
      if (lane.state !== 'ok') continue;
      if (lane.queue.length && limits.requestsPerMinute !== null && lane.acquisitions.length >= limits.requestsPerMinute) {
        wakeAt = Math.min(wakeAt, lane.acquisitions[0] + 60000);
      }
    }
    if (Number.isFinite(wakeAt)) this.scheduleWake(() => this.pump(), Math.max(0, wakeAt - time));
  }

  report(agent, outcome) {
    const lane = this.lane(agent);
    if (this.closed) return;
    const limits = this.lanes[agent];
    lane.used = true;
    // Adaptive lanes: a full window of clean successes opens one more slot; a rate limit halves the limit (never below min).
    if (limits.adaptive) {
      if (outcome.kind === 'ok') {
        lane.okStreak += 1;
        if (lane.okStreak >= lane.limit) { lane.limit = Math.min(limits.concurrency, lane.limit + 1); lane.okStreak = 0; }
      } else if (outcome.kind === 'rate-limited') {
        lane.limit = Math.max(limits.adaptive.min, Math.floor(lane.limit / 2));
        lane.okStreak = 0;
      }
    }
    if (outcome.kind === 'rate-limited') {
      lane.consecutiveRateLimits += 1;
      const delay = outcome.retryAfterMs ?? Math.min(limits.backoff.maxMs, limits.backoff.baseMs * 2 ** (lane.consecutiveRateLimits - 1)) * (0.5 + this.random() / 2);
      const until = this.now() + delay;
      if (lane.state !== 'paused' || lane.until < until) {
        lane.state = 'backoff';
        lane.until = until;
      }
    } else if (outcome.kind === 'quota-exhausted') {
      const reset = typeof outcome.resetsAt === 'string' ? Date.parse(outcome.resetsAt) : NaN;
      lane.state = 'paused';
      lane.until = Number.isFinite(reset) && reset > this.now() ? reset : this.now() + limits.pauseMs;
    } else if (outcome.kind === 'ok') lane.consecutiveRateLimits = 0;
    // A clean success has nothing to publish. Rate limits and quota pauses still go to the shared file.
    if (this.shared) {
      if (outcome.kind !== 'ok' || lane.until !== null) return this.persistPause(agent).then(() => this.scheduleShared());
      this.scheduleShared();
      return;
    }
    this.pump();
  }

  persistPause(agent) {
    const lane = this.lane(agent);
    return writeLanePause({
      dir: this.shared.dir, agent, state: lane.until === null ? 'ok' : lane.state, until: lane.until,
      consecutiveRateLimits: lane.consecutiveRateLimits, now: this.now, isAlive: this.shared.isAlive,
    });
  }

  health(agent) {
    const lane = this.lane(agent);
    this.refresh(lane, this.now());
    return {
      agent, state: lane.state, until: lane.until === null ? null : new Date(lane.until).toISOString(),
      inFlight: this.shared && lane.machineInFlight !== null ? lane.machineInFlight : lane.inFlight, queued: lane.queue.length, concurrency: this.lanes[agent].concurrency,
      consecutiveRateLimits: lane.consecutiveRateLimits,
      ...(this.lanes[agent].adaptive ? { limit: lane.limit } : {}),
    };
  }

  snapshot() {
    const lanes = {};
    for (const agent of LANE_AGENTS) {
      const health = this.health(agent);
      if (this.states[agent].used || health.state !== 'ok') lanes[agent] = { ...health, peak: this.states[agent].peak };
    }
    return { globalConcurrency: this.globalConcurrency, globalInFlight: this.globalInFlight, peakGlobal: this.peakGlobal, lanes };
  }

  pausedFor(agent) {
    const lane = this.lane(agent);
    this.refresh(lane, this.now());
    return lane.state === 'paused' ? Math.max(0, lane.until - this.now()) : 0;
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const lane of Object.values(this.states)) {
      for (const waiter of lane.queue.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.reject(abortError());
      }
    }
    if (this.refillTimer !== null) this.clearTimer(this.refillTimer);
    this.refillTimer = null;
    const leftover = [...this.held.splice(0), ...this.pendingReleases.splice(0)];
    const waiters = this.releaseWaiters.splice(0);
    // A run that closes no longer waits for workers: the share it was asking for is freed for the others.
    const clearDemand = this.shared?.machine ? clearMachineDemand({ dir: this.shared.dir, project: this.shared.machine.project, runId: this.shared.runId, now: this.now, isAlive: this.shared.isAlive }).catch(() => {}) : null;
    if (!this.shared || !leftover.length) {
      for (const resolve of waiters) resolve();
      return clearDemand ?? undefined;
    }
    const done = Promise.all([clearDemand, releaseLaneSlots({ dir: this.shared.dir, slots: leftover, now: this.now, isAlive: this.shared.isAlive })]).catch(() => {});
    for (const resolve of waiters) done.then(resolve, resolve);
    return done;
  }
}

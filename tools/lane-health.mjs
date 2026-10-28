// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectSwarmHome } from './state-guard.mjs';
import { discoverLanes, listLaneAdapters, runLaneHealthCheck } from './lane-adapters.mjs';

const NOFOLLOW = fssync.constants.O_NOFOLLOW || 0;
const PROBE_CAP_MS = 5000;
const FLAP_WINDOW_MS = 30 * 60 * 1000;
const TIER_DOWN_MS = 30 * 60 * 1000;
const EVENTS_MAX_BYTES = 1024 * 1024;
const BASE_OK_STREAK = 2;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const DEGRADED_WEIGHT = 0.35;
const HEALTHY_WEIGHT = 1;

const CHEAP_LANES = new Set(['cursor', 'openrouter', 'anthropic']);
const EXPENSIVE_LANES = new Set(['claude', 'codex']);

export function laneHealthDir(home = os.homedir(), env = process.env) {
  return path.join(projectSwarmHome(home, env), 'lane-health');
}

export function laneHealthStatePath(home = os.homedir(), env = process.env) {
  return path.join(laneHealthDir(home, env), 'state.json');
}

export function laneHealthEventsPath(home = os.homedir(), env = process.env) {
  return path.join(laneHealthDir(home, env), 'events.ndjson');
}

function laneTier(lane) {
  if (CHEAP_LANES.has(lane) || (typeof lane === 'string' && lane.startsWith('local:'))) return 'cheap';
  if (EXPENSIVE_LANES.has(lane)) return 'expensive';
  return null;
}

function emptyLaneState(now) {
  return {
    state: 'paused',
    reason: 'awaiting first check',
    checkedAt: null,
    since: now,
    consecutiveOk: 0,
    consecutiveBad: 0,
    flaps: [],
    backoffUntil: null,
    requiredOkStreak: BASE_OK_STREAK,
    probation: { active: true, checksOk: 0, jobsOk: 0, since: now },
    lastJobOk: null,
    lastJobId: null,
  };
}

function needsYouReason(reason) {
  if (typeof reason !== 'string') return false;
  const lower = reason.toLowerCase();
  return lower.startsWith('login expired') || lower.startsWith('billing');
}

async function ensureLaneHealthDir(dir, fsImpl) {
  await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fsImpl.chmod(dir, 0o700);
  } catch { /* best effort */ }
}

async function writeAtomicJson(file, data, fsImpl) {
  await ensureLaneHealthDir(path.dirname(file), fsImpl);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fsImpl.open(temp, fssync.constants.O_WRONLY | fssync.constants.O_CREAT | fssync.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data)}\n`);
    await handle.chmod(0o600).catch(() => {});
  } finally {
    await handle.close();
  }
  await fsImpl.rename(temp, file);
}

async function readJsonNoFollow(file, fsImpl) {
  const handle = await fsImpl.open(file, fssync.constants.O_RDONLY | NOFOLLOW);
  try {
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function appendEventLine(eventsFile, line, fsImpl) {
  await ensureLaneHealthDir(path.dirname(eventsFile), fsImpl);
  try {
    const stat = await fsImpl.stat(eventsFile);
    if (stat.size >= EVENTS_MAX_BYTES) {
      const rotated = `${eventsFile}.1`;
      try {
        await fsImpl.rename(eventsFile, rotated);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const flags = fssync.constants.O_WRONLY | fssync.constants.O_APPEND | fssync.constants.O_CREAT | NOFOLLOW;
  const handle = await fsImpl.open(eventsFile, flags, 0o600);
  try {
    await handle.chmod(0o600).catch(() => {});
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

function pruneFlaps(flaps, now) {
  return (flaps ?? []).filter(ts => now - ts <= FLAP_WINDOW_MS);
}

function flapMultiplier(flaps, now) {
  const recent = pruneFlaps(flaps, now);
  if (recent.length < 3) return 1;
  return 2 ** Math.min(10, Math.floor(recent.length / 3));
}

function mapProbeToTarget(probeState) {
  if (probeState === 'healthy' || probeState === 'degraded' || probeState === 'down' || probeState === 'paused') {
    return probeState;
  }
  return 'down';
}

export async function readLaneHealth({ home = os.homedir(), env = process.env, fs: fsImpl = fs } = {}) {
  const file = laneHealthStatePath(home, env);
  try {
    const data = await readJsonNoFollow(file, fsImpl);
    if (!data || typeof data !== 'object') return { version: 1, lanes: {}, updatedAt: null };
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, lanes: {}, updatedAt: null };
    throw err;
  }
}

export function laneRoutable(snapshot, lane, job = {}) {
  const entry = snapshot?.lanes?.[lane];
  if (!entry) {
    return { ok: false, reason: 'lane unknown to health monitor', weight: 0 };
  }
  const now = snapshot.now ?? Date.now();
  if (entry.backoffUntil !== null && Number.isFinite(entry.backoffUntil) && now < entry.backoffUntil) {
    return { ok: false, reason: 'lane in flap backoff', weight: 0 };
  }
  if (entry.state === 'down' || entry.state === 'paused') {
    return { ok: false, reason: entry.reason ?? entry.state, weight: 0 };
  }
  if (entry.probation?.active) {
    const small = job?.size === 'small' || job?.risk === 'low';
    if (!small) {
      return { ok: false, reason: 'lane on probation (small/low-risk jobs only)', weight: 0 };
    }
  }
  if (entry.state === 'degraded') {
    return { ok: true, reason: entry.reason ?? 'degraded', weight: DEGRADED_WEIGHT };
  }
  if (entry.state === 'healthy') {
    return { ok: true, reason: entry.reason ?? 'healthy', weight: HEALTHY_WEIGHT };
  }
  return { ok: false, reason: entry.reason ?? 'not routable', weight: 0 };
}

export function createLaneHealthMonitor({
  home = os.homedir(),
  now = Date.now,
  fs: fsImpl = fs,
  env = process.env,
  config = {},
  adapters = listLaneAdapters(),
  exec,
  fetch,
  emit = () => {},
} = {}) {
  const state = { version: 1, lanes: {}, updatedAt: null };
  const tierNeedsYouEmitted = { cheap: false, expensive: false };
  const tierAllDownSince = { cheap: null, expensive: null };

  const eventsFile = laneHealthEventsPath(home, env);
  const stateFile = laneHealthStatePath(home, env);

  let persistChain = Promise.resolve();
  const pendingEvents = new Set();
  const pendingTicks = new Set();
  let stopped = false;

  function persist() {
    const write = persistChain.then(async () => {
      state.updatedAt = new Date(now()).toISOString();
      await writeAtomicJson(stateFile, state, fsImpl);
    });
    // A failed write must not prevent later writes from running.
    persistChain = write.catch(() => {});
    return write;
  }

  async function flush() {
    await Promise.all([persistChain, ...pendingEvents]);
  }

  function recordStateEvent(lane, from, to, reason) {
    const at = new Date(now()).toISOString();
    const line = `${JSON.stringify({ lane, from, to, reason, at })}\n`;
    const write = appendEventLine(eventsFile, line, fsImpl);
    const settled = write.catch(() => {});
    pendingEvents.add(settled);
    settled.then(() => pendingEvents.delete(settled));
    return write;
  }

  function emitChange(type, detail) {
    emit({ type, at: now(), ...detail });
  }

  function ensureLane(lane, time) {
    if (!state.lanes[lane]) state.lanes[lane] = emptyLaneState(time);
    return state.lanes[lane];
  }

  function maybeEndProbation(entry, lane) {
    if (!entry.probation?.active) return;
    if (entry.probation.checksOk >= 3 && entry.probation.jobsOk >= 2) {
      entry.probation.active = false;
      emitChange('probation-ended', { lane });
    }
  }

  function applyProbeResult(lane, probe, time) {
    const entry = ensureLane(lane, time);
    const probeState = mapProbeToTarget(probe.state);
    const prevState = entry.state;
    const required = entry.requiredOkStreak ?? BASE_OK_STREAK;

    if (probeState === 'healthy') {
      entry.consecutiveOk += 1;
      entry.consecutiveBad = 0;
      if (entry.probation?.active) {
        entry.probation.checksOk = (entry.probation.checksOk ?? 0) + 1;
        maybeEndProbation(entry, lane);
      }
    } else {
      entry.consecutiveOk = 0;
      if (probeState === 'down') entry.consecutiveBad = (entry.consecutiveBad ?? 0) + 1;
    }

    let nextState;
    if (probeState === 'paused') nextState = 'paused';
    else if (probeState === 'down') nextState = 'down';
    else if (probeState === 'degraded') nextState = 'degraded';
    else if (entry.consecutiveOk >= required) nextState = 'healthy';
    else if (prevState === 'healthy' && probeState === 'healthy') nextState = 'healthy';
    else nextState = 'degraded';

    entry.checkedAt = time;
    entry.reason = probe.reason ?? nextState;

    if (nextState !== prevState) {
      entry.flaps = [...pruneFlaps(entry.flaps, time), time];
      const mult = flapMultiplier(entry.flaps, time);
      entry.requiredOkStreak = BASE_OK_STREAK * mult;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 60_000 * mult);
      if (mult > 1 && (prevState === 'down' || prevState === 'degraded') && (nextState === 'degraded' || nextState === 'healthy')) {
        entry.backoffUntil = time + backoffMs;
      }
      if (nextState === 'down') {
        entry.backoffUntil = null;
      }
      entry.since = time;
      entry.state = nextState;
      recordStateEvent(lane, prevState, nextState, entry.reason).catch(() => {});
      const eventType = nextState === 'healthy' ? 'up'
        : nextState === 'down' ? 'down'
          : nextState === 'degraded' ? 'degraded'
            : 'paused';
      emitChange(eventType, { lane, from: prevState, to: nextState, reason: entry.reason });
      if (needsYouReason(entry.reason)) {
        emitChange('needs-you', { lane, reason: entry.reason });
      }
    } else {
      entry.state = nextState;
    }

    return entry;
  }

  function checkTierNeedsYou(time) {
    for (const tier of ['cheap', 'expensive']) {
      const members = discoverLanes({ config, adapters }).filter(l => laneTier(l) === tier);
      if (!members.length) {
        tierAllDownSince[tier] = null;
        continue;
      }
      const allDown = members.every(l => {
        const s = state.lanes[l];
        return s && s.state === 'down';
      });
      if (!allDown) {
        tierAllDownSince[tier] = null;
        tierNeedsYouEmitted[tier] = false;
        continue;
      }
      if (tierAllDownSince[tier] === null) {
        tierAllDownSince[tier] = time;
      }
      if (!tierNeedsYouEmitted[tier] && time - tierAllDownSince[tier] >= TIER_DOWN_MS) {
        tierNeedsYouEmitted[tier] = true;
        emitChange('needs-you', { tier, reason: `every ${tier} tier lane down for 30 minutes` });
      }
    }
  }

  async function probeLane(lane) {
    const entry = ensureLane(lane, now());
    const lastResult = entry.lastJobOk === null ? null : { ok: entry.lastJobOk, consecutiveBad: entry.consecutiveBad };
    let timer;
    try {
      const result = await Promise.race([
        runLaneHealthCheck({
          lane,
          config,
          env,
          exec,
          fetch,
          now,
          lastResult,
          adapters,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_CAP_MS);
        }),
      ]);
      applyProbeResult(lane, result, now());
    } catch {
      applyProbeResult(lane, { state: 'down', reason: 'probe failed' }, now());
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    tick() {
      if (stopped) return Promise.resolve();
      const tick = (async () => {
        try {
          const time = now();
          const discovered = discoverLanes({ config, adapters });
          const discoveredSet = new Set(discovered);
          for (const lane of Object.keys(state.lanes)) {
            if (!discoveredSet.has(lane)) {
              const prev = state.lanes[lane]?.state ?? 'unknown';
              delete state.lanes[lane];
              await recordStateEvent(lane, prev, 'pruned', 'lane removed from discovery');
              emitChange('pruned', { lane, from: prev });
            }
          }
          await Promise.all(discovered.map(lane => probeLane(lane)));
          checkTierNeedsYou(time);
          await persist();
        } catch {
          /* never throws */
        }
      })();
      pendingTicks.add(tick);
      tick.then(() => pendingTicks.delete(tick));
      return tick;
    },

    flush,

    async stop() {
      stopped = true;
      await Promise.all([...pendingTicks]);
      await flush();
    },

    snapshot() {
      return { version: state.version, lanes: { ...state.lanes }, updatedAt: state.updatedAt, now: now() };
    },

    recordJobResult(lane, ok, { jobId } = {}) {
      if (stopped) return;
      const entry = ensureLane(lane, now());
      entry.lastJobOk = ok === true;
      if (jobId) entry.lastJobId = jobId;
      if (ok === true) {
        entry.consecutiveBad = 0;
        if (entry.probation?.active) {
          entry.probation.jobsOk = (entry.probation.jobsOk ?? 0) + 1;
          if (entry.probation.checksOk >= 3 && entry.probation.jobsOk >= 2) {
            entry.probation.active = false;
            emitChange('probation-ended', { lane });
          }
        }
      } else {
        entry.consecutiveBad = (entry.consecutiveBad ?? 0) + 1;
      }
      persist().catch(() => {});
    },

    async load() {
      const disk = await readLaneHealth({ home, env, fs: fsImpl });
      if (disk?.lanes && typeof disk.lanes === 'object') {
        state.lanes = { ...disk.lanes };
        state.updatedAt = disk.updatedAt ?? null;
      }
    },
  };
}

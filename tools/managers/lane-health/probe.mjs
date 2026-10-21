// SPDX-License-Identifier: Apache-2.0
// Pre-run lane probes and in-run 429 detection for the lane-health manager (T-0194).

import { promises as fs } from 'node:fs';
import { constants as fsc } from 'node:fs';
import path from 'node:path';
import { classifyProviderOutcome, LANE_AGENTS, lanesDir } from '../../lanes.mjs';

/** @typedef {import('../../lanes.mjs').typeof LANE_AGENTS[number]} LaneAgent */

/**
 * @typedef {'ok' | 'down' | 'backoff' | 'paused' | 'rate-limited'} LaneProbeState
 */

/**
 * @typedef {object} LaneProbeFinding
 * @property {string} agent
 * @property {LaneProbeState} state
 * @property {string} reason
 * @property {string | null} [until]
 */

/**
 * @typedef {object} LaneHealthRouterHealth
 * @property {'ok' | 'backoff' | 'paused'} state
 * @property {string} [reason]
 * @property {string | null} [until]
 */

export const DEFAULT_RATE_LIMIT_STORM_THRESHOLD = 3;
export const DEFAULT_RATE_LIMIT_STORM_WINDOW_MS = 60_000;

const NOFOLLOW = fsc.O_NOFOLLOW || 0;
const UNHEALTHY_PROBE_STATES = new Set(['down', 'backoff', 'paused', 'rate-limited']);

const probeRank = (state) => ({
  ok: 0,
  backoff: 1,
  paused: 2,
  'rate-limited': 3,
  down: 4,
}[state] ?? 0);

/**
 * @param {unknown} pause
 * @param {number} now
 * @returns {LaneProbeFinding | null}
 */
export function lanePauseProbeFinding(agent, pause, now) {
  if (!pause || typeof pause !== 'object' || Array.isArray(pause)) return null;
  const state = pause.state;
  if (state === 'down') {
    const reason = typeof pause.reason === 'string' && pause.reason.trim() ? pause.reason.trim() : 'lane down';
    return { agent, state: 'down', reason, until: null };
  }
  if (state !== 'backoff' && state !== 'paused') return null;
  if (!Number.isFinite(pause.until) || pause.until <= now) return null;
  const reason = typeof pause.reason === 'string' && pause.reason.trim()
    ? pause.reason.trim()
    : `lane ${state}`;
  return {
    agent,
    state,
    reason,
    until: new Date(pause.until).toISOString(),
  };
}

/**
 * @param {unknown} store
 * @param {{ now?: number, agents?: readonly string[] }} [options]
 * @returns {LaneProbeFinding[]}
 */
export function probeLaneStore(store, { now = Date.now(), agents = LANE_AGENTS } = {}) {
  const pauses = store && typeof store === 'object' && !Array.isArray(store) && store.pauses && typeof store.pauses === 'object'
    ? store.pauses
    : {};
  const findings = [];
  for (const agent of agents) {
    const finding = lanePauseProbeFinding(agent, pauses[agent], now);
    if (finding) findings.push(finding);
  }
  return findings;
}

/**
 * @param {unknown} entries
 * @returns {LaneProbeFinding[]}
 */
export function probeLanesDownBeforeFirstWave(entries) {
  const findings = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object' || typeof entry.lane !== 'string' || !entry.lane) continue;
    const rawState = entry.state;
    const state = rawState === 'rate-limited' ? 'rate-limited' : 'down';
    const reason = typeof entry.reason === 'string' && entry.reason.trim()
      ? entry.reason.trim()
      : `${entry.lane} ${state}`;
    const until = typeof entry.markedAt === 'string' ? entry.markedAt : null;
    findings.push({ agent: entry.lane, state, reason, until });
  }
  return findings;
}

/**
 * @param {readonly LaneProbeFinding[][]} lists
 * @returns {LaneProbeFinding[]}
 */
export function mergeLaneProbeFindings(...lists) {
  const byAgent = new Map();
  for (const list of lists) {
    for (const finding of list) {
      const prev = byAgent.get(finding.agent);
      if (!prev || probeRank(finding.state) > probeRank(prev.state)) byAgent.set(finding.agent, finding);
    }
  }
  return [...byAgent.values()];
}

/**
 * @param {readonly LaneProbeFinding[]} findings
 * @returns {LaneProbeFinding[]}
 */
export function unhealthyLaneProbeFindings(findings) {
  return findings.filter(finding => UNHEALTHY_PROBE_STATES.has(finding.state));
}

/**
 * @param {readonly LaneProbeFinding[]} findings
 * @returns {string[]}
 */
export function lanesNeedingReroute(findings) {
  return unhealthyLaneProbeFindings(findings).map(finding => finding.agent);
}

/**
 * @param {readonly LaneProbeFinding[]} findings
 * @returns {(agent: string) => LaneHealthRouterHealth}
 */
export function routerHealthFromLaneProbe(findings) {
  const map = new Map();
  for (const finding of findings) {
    map.set(finding.agent, {
      state: finding.state === 'down' || finding.state === 'rate-limited' || finding.state === 'paused'
        ? 'paused'
        : 'backoff',
      reason: finding.reason,
      until: finding.until ?? null,
    });
  }
  return (agent) => map.get(agent) ?? { state: 'ok' };
}

/**
 * @param {readonly LaneProbeFinding[]} findings
 * @returns {string}
 */
export function formatPreRunLaneProbeNote(findings) {
  const unhealthy = unhealthyLaneProbeFindings(findings);
  if (!unhealthy.length) return 'Pre-wave lane probe: all probed lanes healthy';
  const parts = unhealthy.map(finding => `${finding.agent} ${finding.state} (${finding.reason})`);
  return `Pre-wave-1 lane probe: ${parts.join('; ')}`;
}

/**
 * @param {string} file
 * @returns {Promise<unknown>}
 */
export async function readLaneStoreJson(file) {
  const fh = await fs.open(file, fsc.O_RDONLY | NOFOLLOW);
  try {
    return JSON.parse(await fh.readFile('utf8'));
  } finally {
    await fh.close();
  }
}

/**
 * @param {{
 *   laneStore?: unknown,
 *   laneStoreFile?: string,
 *   lanesDownBeforeFirstWave?: unknown,
 *   agents?: readonly string[],
 *   now?: number,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {Promise<{ findings: LaneProbeFinding[], unhealthy: LaneProbeFinding[], reroute: string[], note: string }>}
 */
export async function runPreRunLaneProbe(options = {}) {
  const now = options.now ?? Date.now();
  const agents = options.agents ?? LANE_AGENTS;
  let store = options.laneStore;
  if (store === undefined && options.laneStoreFile) {
    store = await readLaneStoreJson(options.laneStoreFile);
  }
  if (store === undefined && options.env) {
    const file = path.join(lanesDir(options.env), 'lanes.json');
    try {
      store = await readLaneStoreJson(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      store = { version: 1, slots: {}, pauses: {} };
    }
  }
  const fromStore = store ? probeLaneStore(store, { now, agents }) : [];
  const fromFixture = probeLanesDownBeforeFirstWave(options.lanesDownBeforeFirstWave);
  const findings = mergeLaneProbeFindings(fromStore, fromFixture);
  const unhealthy = unhealthyLaneProbeFindings(findings);
  return {
    findings,
    unhealthy,
    reroute: lanesNeedingReroute(findings),
    note: formatPreRunLaneProbeNote(findings),
  };
}

/**
 * @param {{
 *   threshold?: number,
 *   windowMs?: number,
 *   now?: () => number,
 *   onRateLimited?: (agent: string, outcome: ReturnType<typeof classifyProviderOutcome>) => void,
 *   onStorm?: (agent: string, detail: { count: number, windowMs: number, reason: string }) => void,
 * }} [options]
 */
export function createRateLimitDetectionHook(options = {}) {
  const threshold = Number.isInteger(options.threshold) && options.threshold > 0
    ? options.threshold
    : DEFAULT_RATE_LIMIT_STORM_THRESHOLD;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : DEFAULT_RATE_LIMIT_STORM_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  /** @type {Map<string, { times: number[], consecutive: number, storm: boolean }>} */
  const byAgent = new Map();

  const lane = (agent) => {
    let entry = byAgent.get(agent);
    if (!entry) {
      entry = { times: [], consecutive: 0, storm: false };
      byAgent.set(agent, entry);
    }
    return entry;
  };

  const prune = (entry, time) => {
    entry.times = entry.times.filter(ts => time - ts <= windowMs);
  };

  return {
    /**
     * Classify a provider result and record 429 / rate-limit signals for one lane.
     *
     * @param {string} agent
     * @param {Parameters<typeof classifyProviderOutcome>[0]} result
     */
    observe(agent, result) {
      const outcome = classifyProviderOutcome(result);
      const entry = lane(agent);
      const time = now();
      if (outcome.kind === 'rate-limited') {
        entry.consecutive += 1;
        entry.times.push(time);
        prune(entry, time);
        options.onRateLimited?.(agent, outcome);
        if (!entry.storm && entry.times.length >= threshold) {
          entry.storm = true;
          const reason = `${entry.times.length} rate limits in ${Math.round(windowMs / 1000)}s`;
          options.onStorm?.(agent, { count: entry.times.length, windowMs, reason });
        }
      } else if (outcome.kind === 'ok') {
        entry.consecutive = 0;
        prune(entry, time);
      }
      return {
        outcome,
        rateLimited: outcome.kind === 'rate-limited',
        consecutiveRateLimits: entry.consecutive,
        storm: entry.storm,
        windowCount: entry.times.length,
      };
    },

    /**
     * @param {string} agent
     * @returns {LaneProbeFinding | null}
     */
    laneProbeFinding(agent) {
      const entry = byAgent.get(agent);
      if (!entry) return null;
      const time = now();
      prune(entry, time);
      if (entry.storm) {
        return {
          agent,
          state: 'rate-limited',
          reason: `${entry.times.length} rate limits in ${Math.round(windowMs / 1000)}s`,
          until: null,
        };
      }
      if (entry.consecutive > 0 && entry.times.length > 0) {
        return {
          agent,
          state: 'rate-limited',
          reason: `rate limited (${entry.consecutive} consecutive)`,
          until: null,
        };
      }
      return null;
    },

    /**
     * @returns {LaneProbeFinding[]}
     */
    laneProbeFindings() {
      const out = [];
      for (const agent of byAgent.keys()) {
        const finding = this.laneProbeFinding(agent);
        if (finding) out.push(finding);
      }
      return out;
    },

    /** @param {string} [agent] */
    reset(agent) {
      if (agent === undefined) {
        byAgent.clear();
        return;
      }
      byAgent.delete(agent);
    },
  };
}

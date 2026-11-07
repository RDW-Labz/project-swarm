// SPDX-License-Identifier: Apache-2.0
// Pause, reroute, concurrency shrink and unpause actions for the lane-health manager (T-0195).

import { lanesDir, writeLanePause, LANE_AGENTS, resolveLanes } from '../../lanes.mjs';
import { routeJob } from '../../router.mjs';
import { parseLane, laneText, laneOkForSensitive, PROPOSAL_ORIGINS } from '../../tickets.mjs';
import { routerHealthFromLaneProbe } from './probe.mjs';

/** @typedef {import('./probe.mjs').LaneProbeFinding} LaneProbeFinding */

/** Safe lane-health manager actions (registry.mjs). */
export const PAUSE_LANE_ACTION = 'pause-lane';
export const REROUTE_TICKETS_ACTION = 'reroute-tickets';
export const UNPAUSE_LANE_ACTION = 'unpause-lane';
export const SHRINK_CONCURRENCY_ACTION = 'shrink-concurrency';

/** Needs-you lane-health action when a lane stays down too long. */
export const LANE_DOWN_ESCALATE_ACTION = 'lane-down-escalate';

export const LANE_HEALTH_MANAGER_ID = 'lane-health';

/** Default pause for a lane marked down with no reset time (24h). */
export const DEFAULT_DOWN_PAUSE_MS = 86_400_000;

/** Down lanes longer than this go to Needs you (phase19 lane health). */
export const DEFAULT_LANE_DOWN_ESCALATE_MS = 3_600_000;

const OPEN_TICKET_STATUSES = new Set(['todo', 'ready', 'running', 'review', 'blocked']);

const unapprovedProposal = (ticket) =>
  PROPOSAL_ORIGINS.includes(ticket?.origin) && ticket.approvedBy !== 'owner';

/**
 * @param {LaneProbeFinding} finding
 * @param {number} now
 * @param {{ downPauseMs?: number }} [options]
 * @returns {{ state: 'backoff' | 'paused', until: number, consecutiveRateLimits: number } | null}
 */
export function lanePauseWriteFromFinding(finding, now, { downPauseMs = DEFAULT_DOWN_PAUSE_MS } = {}) {
  if (!finding || typeof finding.agent !== 'string') return null;
  if (finding.state === 'ok') return null;

  if (finding.state === 'down') {
    return { state: 'paused', until: now + downPauseMs, consecutiveRateLimits: 0 };
  }

  if (finding.state === 'rate-limited' || finding.state === 'backoff') {
    const parsed = finding.until ? Date.parse(finding.until) : NaN;
    const until = Number.isFinite(parsed) && parsed > now
      ? parsed
      : now + 60_000;
    return { state: 'backoff', until, consecutiveRateLimits: 1 };
  }

  if (finding.state === 'paused') {
    const parsed = finding.until ? Date.parse(finding.until) : NaN;
    const until = Number.isFinite(parsed) && parsed > now
      ? parsed
      : now + downPauseMs;
    return { state: 'paused', until, consecutiveRateLimits: 0 };
  }

  return null;
}

/**
 * @param {readonly LaneProbeFinding[]} findings
 * @returns {ReturnType<typeof routerHealthFromLaneProbe>}
 */
export function laneHealthRouterHealth(findings) {
  return routerHealthFromLaneProbe(findings);
}

/**
 * @param {unknown} ticket
 * @param {string} unhealthyAgent
 */
export function ticketPinnedToLane(ticket, unhealthyAgent) {
  const lane = parseLane(ticket?.lane);
  return Boolean(lane && lane.agent === unhealthyAgent);
}

/**
 * Minimal auto job shape for routing a pinned ticket onto another lane.
 *
 * @param {object} ticket
 */
function autoJobFromTicket(ticket) {
  return {
    id: ticket.id,
    agent: 'auto',
    sensitive: ticket.sensitive === true,
    tier: ticket.risk === 'high' ? 'expensive' : ticket.risk === 'medium' ? 'mid' : undefined,
    hard: ticket.hard === true,
    context: Array.isArray(ticket.context) ? ticket.context : [],
    outputs: Array.isArray(ticket.files) ? ticket.files : [],
    acceptance: Array.isArray(ticket.acceptance) ? ticket.acceptance : [],
  };
}

/**
 * @param {object} ticket
 * @param {ReturnType<typeof resolveLanes>} lanes
 * @param {(agent: string) => { state: string }} health
 * @param {string} [contract]
 * @param {number} [ready]
 */
export function pickHealthyLaneForTicket(ticket, lanes, health, { contract, ready = 0 } = {}) {
  const pinned = parseLane(ticket.lane);
  if (!pinned) return null;
  if (ticket.sensitive === true && !laneOkForSensitive(pinned)) return null;

  try {
    const route = routeJob(autoJobFromTicket(ticket), {
      lanes,
      health,
      contract,
      ready,
      failures: { [pinned.agent]: 2 },
    });
    if (!route || route.agent === pinned.agent) return null;
    return route;
  } catch {
    return null;
  }
}

/**
 * @param {object|null|undefined} ledger
 * @param {readonly LaneProbeFinding[]} unhealthyFindings
 * @param {ReturnType<typeof resolveLanes>} lanes
 * @param {{ contract?: string, ready?: number }} [options]
 * @returns {{ ticket: object, from: string, to: string, model?: string, reason: string }[]}
 */
export function planTicketReroutes(ledger, unhealthyFindings, lanes, options = {}) {
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  const health = laneHealthRouterHealth(unhealthyFindings);
  const unhealthyAgents = new Set(unhealthyFindings.map(f => f.agent));
  /** @type {{ ticket: object, from: string, to: string, model?: string, reason: string }[]} */
  const reroutes = [];

  for (const ticket of tickets) {
    if (!ticket || !OPEN_TICKET_STATUSES.has(ticket.status) || unapprovedProposal(ticket)) continue;
    const pinned = parseLane(ticket.lane);
    if (!pinned || !unhealthyAgents.has(pinned.agent)) continue;

    const finding = unhealthyFindings.find(f => f.agent === pinned.agent);
    const route = pickHealthyLaneForTicket(ticket, lanes, health, options);
    if (!route) continue;

    reroutes.push({
      ticket,
      from: pinned.agent,
      to: route.agent,
      model: route.model,
      reason: finding
        ? `lane-health-reroute: ${ticket.id} left ${pinned.agent} (${finding.state}: ${finding.reason}) for ${route.agent}`
        : `lane-health-reroute: ${ticket.id} left ${pinned.agent} for ${route.agent}`,
    });
  }

  return reroutes;
}

/**
 * @param {object} ledger
 * @param {readonly { ticket: { id: string }, to: string, model?: string }[]} reroutes
 * @returns {object}
 */
export function applyTicketReroutes(ledger, reroutes) {
  const next = structuredClone(ledger);
  if (!Array.isArray(next.tickets)) next.tickets = [];
  const byId = new Map(reroutes.map(r => [r.ticket.id, r]));
  for (const ticket of next.tickets) {
    const move = byId.get(ticket.id);
    if (!move) continue;
    ticket.lane = laneText({ agent: move.to, ...(move.model ? { model: move.model } : {}) });
  }
  return next;
}

/**
 * @param {ReturnType<typeof resolveLanes>} lanes
 * @param {string} agent
 */
export function shrinkLaneConcurrency(lanes, agent) {
  if (!LANE_AGENTS.includes(agent)) return null;
  const lane = lanes[agent];
  if (!lane || !Number.isFinite(lane.concurrency)) return null;
  const floor = lane.adaptive?.min ?? 1;
  const next = Math.max(floor, Math.floor(lane.concurrency / 2));
  if (next >= lane.concurrency) return null;
  return next;
}

/**
 * @param {object} manifest
 * @param {string} agent
 * @param {number} concurrency
 */
export function applyLaneConcurrencyShrink(manifest, agent, concurrency) {
  const next = structuredClone(manifest);
  if (!next.lanes || typeof next.lanes !== 'object') next.lanes = {};
  if (!next.lanes[agent] || typeof next.lanes[agent] !== 'object') next.lanes[agent] = {};
  next.lanes[agent].concurrency = concurrency;
  return next;
}

/**
 * @param {{
 *   dir?: string,
 *   agent: string,
 *   finding: LaneProbeFinding,
 *   now?: number,
 *   isAlive?: (pid: number) => boolean,
 *   downPauseMs?: number,
 * }} options
 */
export async function applyPauseLane(options) {
  const now = options.now ?? Date.now();
  const pause = lanePauseWriteFromFinding(options.finding, now, { downPauseMs: options.downPauseMs });
  if (!pause) return;
  await writeLanePause({
    dir: options.dir ?? lanesDir(),
    agent: options.agent,
    state: pause.state,
    until: pause.until,
    consecutiveRateLimits: pause.consecutiveRateLimits,
    now: () => now,
    isAlive: options.isAlive,
  });
}

/**
 * @param {{
 *   dir?: string,
 *   agent: string,
 *   now?: number,
 *   isAlive?: (pid: number) => boolean,
 * }} options
 */
export async function applyUnpauseLane(options) {
  const now = options.now ?? Date.now();
  await writeLanePause({
    dir: options.dir ?? lanesDir(),
    agent: options.agent,
    state: 'ok',
    until: null,
    now: () => now,
    isAlive: options.isAlive,
  });
}

/**
 * @typedef {object} LaneHealthPlannedAction
 * @property {string} action
 * @property {'info' | 'warn' | 'needs_you'} severity
 * @property {string} code
 * @property {string} reason
 * @property {string} [lane]
 * @property {string} [ticket]
 * @property {string} [recommendation]
 * @property {() => Promise<void>|void} [apply]
 */

/**
 * Plan pause, reroute, shrink and escalation actions from probe findings (AC1).
 *
 * @param {{
 *   findings: readonly LaneProbeFinding[],
 *   unhealthy?: readonly LaneProbeFinding[],
 *   ledger?: object|null,
 *   lanes?: ReturnType<typeof resolveLanes>,
 *   manifest?: object|null,
 *   contract?: string,
 *   ready?: number,
 *   now?: number,
 *   downEscalateMs?: number,
 *   downSince?: Record<string, number>,
 *   recovered?: readonly string[],
 *   lanesDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   isAlive?: (pid: number) => boolean,
 * }} options
 * @returns {LaneHealthPlannedAction[]}
 */
export function planLaneHealthActions(options = {}) {
  const now = options.now ?? Date.now();
  const findings = options.findings ?? [];
  const unhealthy = options.unhealthy ?? findings.filter(f => f.state !== 'ok');
  const lanes = options.lanes ?? resolveLanes({ manifest: options.manifest ?? {}, env: options.env });
  const downEscalateMs = options.downEscalateMs ?? DEFAULT_LANE_DOWN_ESCALATE_MS;
  const downSince = options.downSince ?? {};

  /** @type {LaneHealthPlannedAction[]} */
  const actions = [];

  for (const finding of unhealthy) {
    const pause = lanePauseWriteFromFinding(finding, now);
    if (pause) {
      actions.push({
        action: PAUSE_LANE_ACTION,
        severity: finding.state === 'down' ? 'warn' : 'info',
        code: `lane-${finding.state}`,
        reason: `${finding.agent} ${finding.state}: ${finding.reason}`,
        lane: finding.agent,
        apply: () => applyPauseLane({
          dir: options.lanesDir,
          agent: finding.agent,
          finding,
          now,
          isAlive: options.isAlive,
        }),
      });
    }

    if (finding.state === 'rate-limited') {
      const nextConcurrency = shrinkLaneConcurrency(lanes, finding.agent);
      if (nextConcurrency !== null) {
        actions.push({
          action: SHRINK_CONCURRENCY_ACTION,
          severity: 'info',
          code: 'lane-rate-limit-shrink',
          reason: `${finding.agent} rate limited: shrink concurrency ${lanes[finding.agent].concurrency} -> ${nextConcurrency} (${finding.reason})`,
          lane: finding.agent,
          apply: options.manifest
            ? () => {
                options.manifest = applyLaneConcurrencyShrink(options.manifest, finding.agent, nextConcurrency);
              }
            : undefined,
        });
      }
    }

    if (finding.state === 'down') {
      const since = downSince[finding.agent] ?? now;
      if (now - since >= downEscalateMs) {
        actions.push({
          action: LANE_DOWN_ESCALATE_ACTION,
          severity: 'needs_you',
          code: 'lane-down-escalate',
          reason: `${finding.agent} still down after ${Math.round((now - since) / 60000)}m: ${finding.reason}`,
          lane: finding.agent,
          recommendation: 'Fix login, quota or provider access for this lane, then unpause when healthy.',
        });
      }
    }
  }

  const reroutes = planTicketReroutes(options.ledger, unhealthy, lanes, {
    contract: options.contract,
    ready: options.ready,
  });
  for (const move of reroutes) {
    actions.push({
      action: REROUTE_TICKETS_ACTION,
      severity: 'warn',
      code: 'ticket-lane-reroute',
      reason: move.reason,
      ticket: move.ticket.id,
      lane: move.to,
      apply: options.ledger
        ? () => {
            const updated = applyTicketReroutes(options.ledger, [move]);
            options.ledger.tickets = updated.tickets;
          }
        : undefined,
    });
  }

  const unhealthyAgents = new Set(unhealthy.map(f => f.agent));
  for (const agent of options.recovered ?? []) {
    if (unhealthyAgents.has(agent)) continue;
    actions.push({
      action: UNPAUSE_LANE_ACTION,
      severity: 'info',
      code: 'lane-recovered',
      reason: `${agent} healthy again; clear manager pause`,
      lane: agent,
      apply: () => applyUnpauseLane({
        dir: options.lanesDir,
        agent,
        now,
        isAlive: options.isAlive,
      }),
    });
  }

  return actions;
}

/**
 * Detect unhealthy lanes and plan reroute-related actions (probe + plan).
 *
 * @param {{
 *   findings: readonly LaneProbeFinding[],
 *   unhealthy?: readonly LaneProbeFinding[],
 *   ledger?: object|null,
 *   lanes?: ReturnType<typeof resolveLanes>,
 *   manifest?: object|null,
 *   contract?: string,
 *   ready?: number,
 *   now?: number,
 *   lanesDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   isAlive?: (pid: number) => boolean,
 * }} options
 * @returns {{ actions: LaneHealthPlannedAction[], health: ReturnType<typeof laneHealthRouterHealth> }}
 */
export function laneHealthRerouteFromProbe(options) {
  const findings = options.findings ?? [];
  const unhealthy = options.unhealthy ?? findings.filter(f => f.state !== 'ok');
  const health = laneHealthRouterHealth(findings);
  const actions = planLaneHealthActions({ ...options, findings, unhealthy });
  return { actions, health };
}

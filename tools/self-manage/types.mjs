// SPDX-License-Identifier: Apache-2.0
// Shared self-managing swarm record shapes (S11 R-081 / R-082 / R-083). Types only — no runtime.

/**
 * @typedef {'healthy' | 'degraded' | 'down' | 'paused'} LaneHealthStatus
 * @exports LaneHealthStatus
 */

/**
 * Probe result for one lane (config key, local endpoint, or adapter).
 *
 * @typedef {Object} LaneHealthRecord
 * @property {LaneHealthStatus} status
 * @property {string | null} reason Human-readable detail; null when {@link LaneHealthStatus} is `healthy`.
 * @property {string} lastChecked ISO-8601 timestamp of the last probe.
 * @exports LaneHealthRecord
 */

/**
 * @typedef {Object} LeaseRecord
 * @property {string} ticketId Ledger ticket id (for example `T-0449`).
 * @property {string} [jobId] Manifest job id when the lease is job-scoped.
 * @property {string} holder Node or worker id holding the lease.
 * @property {string} expiry ISO-8601 lease expiry time.
 * @property {number} fencingToken Monotonic token; heartbeats must match to extend.
 * @exports LeaseRecord
 */

/**
 * Where a ticket was routed and why.
 *
 * @typedef {Object} RoutingRecord
 * @property {string} agent Lane agent (for example `claude`, `local`).
 * @property {string | null} model Resolved model name, if any.
 * @property {string} reason Short explanation of the routing decision.
 * @property {string} routeSource Rule or subsystem that chose the route (for example `cost-order`, `health-reroute`).
 * @exports RoutingRecord
 */

export {};

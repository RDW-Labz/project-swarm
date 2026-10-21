# Cluster architecture (N devices, one ledger)

## Goal

Run Project Swarm across many owner machines as one pool: one shared ticket ledger, autonomous node-to-node messages, and work stealing when slots are idle. Stage S9 (roadmap R-050 through R-061) replaces git hand-off branches and owner-relayed messages once the MacBook and Mac mini both run the ledger. S8 R-048 remains the cross-machine queue preview; the cluster ledger extends it with leases, fencing, push transport, and benchmarks.

## Nodes and the node registry

Each machine runs the swarm service and joins with `swarm join` using tailnet authentication (no shared passwords in repos). The join flow writes `~/.project-swarm/nodes/self` and registers with the ledger owner:

- Node id (stable per machine install)
- Host label (owner-chosen, not a secret)
- Capabilities: CPU cores, RAM GiB, configured worker limit, enabled lanes, optional GPU
- Last heartbeat timestamp and swarm release version

`swarm node list` and Swarm Watch node view read the same registry. A node that stops heartbeating is marked stale; it does not receive new steals until it re-hellos.

## The shared ledger and leases

One logical ledger (SQLite on the elected ledger owner, replicated to followers for read-only board views) holds tickets, states, and lease rows.

**Claim:** A worker sends `lease-claim` with ticket id and its node id. The ledger owner writes one atomic claim record: holder node id, lease id, fencing token (monotonic per ticket), expiry time.

**Heartbeat:** `lease-heartbeat` extends expiry only if the presented fencing token matches the current claim. Wrong token → reject (another node won or lease was released).

**Expiry:** Expiry is computed only on the ledger owner clock. Node-local clocks never shorten or extend a peer lease. After heartbeat timeout (90 s without refresh in harness defaults), the ticket returns to `ready` and the fencing token increments so late heartbeats from the dead node are ignored.

**Work stealing:** Ready tickets are visible to any node with free slots. Steal picks honor target worktree, file ownership from the ticket ledger, lane routing, capability fit, and fair share across projects (R-052).

**Why double builds cannot happen:** At most one active claim record per ticket. Every mutating ledger write (start job, integrate marker, release) must include the current fencing token. A stale token fails the write with `claim rejected`. Two nodes claiming at once contend on a single atomic transaction; one wins, one fails. Release benchmarks require 0 double claims.

## Transport

Primary path: persistent connection over the tailnet between nodes (WebSocket or equivalent), with per-node Ed25519 (or machine key) signatures on every frame.

Fallback: while a peer is offline or unreachable for 30 s, outbound messages copy to the GitHub `swarm-inbox` repo as typed JSON commits; on reconnect the peer pulls, validates, and acks. Fallback is not used when the live tailnet session is up.

**Replay protection:** Each sender keeps a monotonic sequence number per message type stream. Receivers keep the highest seen sequence and a nonce window for out-of-order duplicates. Replays inside the window are dropped and logged.

**Wake:** A validated inbound message schedules an internal event so orchestrator or autopilot runs without polling (R-053).

## Message schema

All cluster traffic is typed JSON validated against versioned JSON Schema. No executable fields, no shell commands, no free-form “run this” strings.

| Type | Purpose |
|------|---------|
| `handoff` | Pass ticket context between nodes |
| `ticket-done` | Worker finished build; triggers integrate path on holder |
| `release-shipped` | Release train marker across nodes |
| `request` | Ask peer for artifact or scope slice |
| `question` | Clarification between workers |
| `ack` | Positive ack with correlation id |
| `lease-claim` | Request ticket lease |
| `lease-heartbeat` | Extend lease with fencing token |
| `lease-release` | Voluntary release |
| `node-hello` | Register or refresh capabilities |

Enforcement:

- Size cap 64 KiB per message; larger payloads use blob refs outside the message body.
- Secret scan on send and receive; messages with key-like material are dropped and raised to the owner.
- Keys, tokens, and PAT material never appear in message bodies.

## Trust boundary

Owner-only actions stay owner-only on every node: approve/deny requests, merge to live, deploy, change caps, spend, and key management. Cluster messages cannot perform or imply these actions. A message that attempts them is dropped, logged locally, and surfaced on Swarm Watch for the owner. Workers and peers may only move ticket work and ledger-safe state.

## Failure model

| Scenario | Behavior |
|----------|----------|
| Node dies mid-ticket | Heartbeats stop; lease expires on owner clock; ticket returns to ready; another node steals; stale fencing blocks the dead worker from writing |
| Network drop | Push buffers; fallback inbox after grace; on heal, replay-safe delivery; no duplicate start if lease already moved |
| Clock skew | Lease expiry uses ledger owner clock only |
| Two nodes claim at once | One atomic winner; loser gets `claim rejected`; chaos suite runs 1000 races |
| Partition healing | Higher fencing token wins; duplicates deduped by sequence + nonce window |
| Duplicate delivery | Same sequence rejected; at-most-once side effects on ticket state |

## Benchmarks

Measured in the deterministic simulated-cluster harness (injected clock, fake transport, fixed seed) for CI stability. Optional `swarm bench cluster --tailnet` for owner machines on a real tailnet.

| Metric | Target | Regression gate (vs stored baseline) |
|--------|--------|-------------------------------------|
| Message latency p50 | under 100 ms (tailnet harness) | — |
| Message latency p95 | under 1 s | fail CI if more than 25% worse |
| Ticket ready → started p95 | under 30 s when a free slot exists | — |
| Slot utilization (ready tickets exist) | above 80% | fail CI if more than 5 points worse |
| Idle node-minutes while ready tickets exist | under 1% of node-minutes | — |
| Owner relays needed | 0 | — |
| Double-claims | 0 (any double claim fails the release) | — |
| Throughput | tickets done per hour per node, recorded and trended | fail CI if more than 10% worse |

**Storage:** One JSON file per release at `bench/cluster/<version>.json`. Schema (fields):

```json
{
  "version": "string",
  "recordedAt": "ISO-8601",
  "harnessSeed": "string",
  "messageLatencyMs": { "p50": 0, "p95": 0 },
  "readyToStartedMs": { "p95": 0 },
  "slotUtilizationPct": 0,
  "idleNodeMinutesPct": 0,
  "ownerRelays": 0,
  "doubleClaims": 0,
  "throughputTicketsPerHourPerNode": 0
}
```

CI uploads the file, compares to baseline, and fails on regression (R-058). Swarm Watch charts the last releases.

## Stages C1 to C6

| Stage | Scope | Gate |
|-------|--------|------|
| C1 | Node registry and `swarm join` | Two nodes visible in `swarm node list` within 5 s |
| C2 | Typed signed messages, secret scan, forged-sender and replay tests, approve-attempt dropped | All three security tests pass |
| C3 | Shared ledger, leases, fencing | 1000 simulated two-node claim races, 0 double claims |
| C4 | Push transport, inbox fallback, wake event | p95 latency under 1 s in harness |
| C5 | Work stealing, autonomy flows, board message log | Ticket built on node B marked delivered on node A with no owner action |
| C6 | Benchmarks, CI gate, chaos suite | Four chaos scenarios pass; baseline JSON stored |

## Risks

- Ledger owner availability: if the owner node is down, claims pause; followers serve read-only board until failover (future work; not in S9).
- Tailnet misconfiguration exposes the push port; messages are still signed and typed but transport must stay tailnet-only.
- Inbox fallback adds minutes of latency; it is a backup, not the steady state.

## Deliberately not built

- Multi-owner trust or federated tenants
- Remote code execution via messages
- Auto-update of peer binaries (owner runs `swarm update` per machine)
- Cross-owner clusters

## Requirements map

| Id | Topic |
|----|--------|
| R-050 | Join and node registry |
| R-051 | Shared ledger, leases, fencing (extends R-048) |
| R-052 | Work stealing |
| R-053 | Push transport and inbox fallback |
| R-054 | Typed signed messages |
| R-055 | Autonomous flows; owner-only boundary |
| R-056 | `swarm msg` and `swarm node` CLI + board views |
| R-057 | Benchmark storage per release |
| R-058 | CI regression gate and Swarm Watch trend |
| R-059 | Chaos suite |
| R-060 | MacBook + Mac mini cutover |
| R-061 | Third node join/leave |

Burst GPU (R-062) and cloud CPU (R-063) remain in S8 and are unrelated to cluster transport.

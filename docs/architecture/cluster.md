# Cluster architecture (N devices, one ledger)

## Goal

Run Project Swarm across many owner machines as one pool: one shared ticket ledger, typed node-to-node coordination without model turns, and work stealing when slots are idle. Stage S9 (roadmap R-052 through R-065) replaces git hand-off branches and owner-relayed messages once the MacBook and Mac mini both run the ledger. S8 R-048 remains the cross-machine queue preview; the cluster ledger extends it with leases, fencing, reliable delivery, and benchmarks.

## Nodes and the node registry

Each machine runs the swarm service and joins with `swarm join` using tailnet authentication (no shared passwords in repos). The join flow writes `~/.project-swarm/nodes/self` and registers with the ledger owner (R-055):

- Node id (stable per machine install)
- Host label (owner-chosen, not a secret)
- Capabilities: CPU cores, RAM GiB, configured worker limit, enabled lanes, optional GPU
- Live capacity: real memory pressure and swap, free slots, lane health (use the real free-memory reading, not Node `os.freemem`, which undercounts on macOS by about 30 times)
- Last heartbeat timestamp and swarm release version

`swarm node list` and Swarm Watch node view read the same registry. A node that stops heartbeating is marked stale; it does not receive new steals until it re-hellos.

## The shared ledger and leases

One logical ledger (SQLite on the elected ledger owner, replicated to followers for read-only board views) holds tickets, states, and lease rows (R-052).

**Claim:** A worker sends `lease-claim` with ticket id and its node id. The ledger owner writes one atomic claim record: holder node id, lease id, fencing token (monotonic per ticket), expiry time. Hand-off branches and per-node ticket id ranges are not used when the cluster ledger is enabled.

**Heartbeat:** `lease-heartbeat` extends expiry only if the presented fencing token matches the current claim. Wrong token → reject (another node won or lease was released).

**Expiry:** Expiry is computed only on the ledger owner clock. Node-local clocks never shorten or extend a peer lease. After heartbeat timeout (90 s without refresh in harness defaults), the ticket returns to `ready` and the fencing token increments so late heartbeats from the dead node are ignored.

**Work stealing:** Ready tickets are visible to any node with free slots. Steal picks honor target worktree, file ownership from the ticket ledger, lane routing, capability fit, and fair share across projects (R-060).

**Why double builds cannot happen:** At most one active claim record per ticket. Every mutating ledger write (start job, integrate marker, release) must include the current fencing token. A stale token fails the write with `claim rejected`. Two nodes claiming at once contend on a single atomic transaction; one wins, one fails. Release benchmarks require 0 double claims.

## Coordination and transport

Cluster coordination events (`ticket-done`, `release-shipped`, `lease-claim`, `lease-release`, `request`, `question`, `handoff`, `ack`) are typed JSON validated against versioned JSON Schema (R-053). They are delivered over the tailnet without LLM or orchestrator token spend; an orchestrator wakes only when a message kind needs an owner decision.

Primary path: persistent connection over the tailnet between nodes (WebSocket or equivalent), with per-node Ed25519 (or machine key) signatures on every frame (R-056).

**Reliable delivery (R-054):** Senders keep a durable on-disk outbox; receivers ack with correlation id; bounded retries with backoff; de-duplication by sender sequence; catch-up after sleep or reconnect delivers queued messages in order exactly once.

**Wake:** A validated inbound message that requires action schedules an internal event so orchestrator or autopilot runs without polling.

## Message schema

All cluster traffic is typed JSON. No executable fields, no shell commands, no free-form “run this” strings.

| Type | Purpose |
|------|---------|
| `handoff` | Pass ticket context between nodes |
| `ticket-done` | Worker finished build; triggers integrate path on holder |
| `release-shipped` | Release train marker; peers run `swarm update` between waves (R-058) |
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
- Replay protection: monotonic sequence per sender; forged signatures rejected; tailnet only.

## Trust boundary

Owner-only actions stay owner-only on every node: approve/deny requests, merge to live, deploy, change caps, spend, and key management (R-057). Cluster messages cannot perform or imply these actions. A message that attempts them is dropped, logged locally, and surfaced on Swarm Watch for the owner. Workers and peers may only move ticket work and ledger-safe state.

## Merge queue and placement

One repo-wide merge queue (R-059): PRs from any node merge in FIFO order through `swarm merge` with green checks, one at a time. Placement and stealing (R-060) use live capacity from the registry so heavy work lands on the node with headroom while honoring file ownership and lane fit.

## Failure model

| Scenario | Behavior |
|----------|----------|
| Node dies mid-ticket | Heartbeats stop; lease expires on owner clock; ticket returns to ready; another node steals; stale fencing blocks the dead worker from writing |
| Network drop | Outbox retries; catch-up on heal; no duplicate start if lease already moved |
| Clock skew | Lease expiry uses ledger owner clock only |
| Two nodes claim at once | One atomic winner; loser gets `claim rejected`; chaos suite runs 1000 races |
| Partition healing | Higher fencing token wins; duplicates deduped by sequence + nonce window |
| Duplicate delivery | Same sequence rejected; at-most-once side effects on ticket state |

## Benchmarks

Measured in the deterministic simulated-cluster harness (injected clock, fake transport, fixed seed) for CI stability. Optional `swarm bench cluster --tailnet` for owner machines on a real tailnet (R-062).

| Metric | Target | Regression gate (vs `bench/cluster/baseline.json`) |
|--------|--------|-----------------------------------------------------|
| Message latency p50 | under 100 ms (tailnet harness) | — |
| Message latency p95 | under 1 s | fail CI if more than 25% worse |
| Ticket ready → started p95 | under 30 s when a free slot exists | — |
| Slot utilization (ready tickets exist) | above 80% | fail CI if more than 5 points worse |
| Idle node-minutes while ready tickets exist | about 0 (under 1% in harness) | — |
| Owner relays needed | 0 | fail CI if above 0 |
| Double-claims | 0 (any double claim fails the release) | fail CI if above 0 |
| Throughput | tickets done per hour per node, recorded and trended | fail CI if more than 10% worse |

**Baseline:** The first `bench/cluster/baseline.json` is created from measured fixtures on the C6 benchmark ticket (Mac mini branch `idle/cluster-measure-20261021/node-mini-measure`: `docs/state/node-mini.md`, `bench/cluster/fixtures/node-mini.json`, `latency.json`, `claim-races.json`, `slot-use.json`). Facts carried into baseline without inventing numbers: 10 cores and 24 GB on the mini; `os.freemem` undercount of about 30×; average slot fill 15–16% per project with median 1 job at a time; O_EXCL claim race with exactly one winner at 2, 8, and 32 contenders at 4–7 ms median (measured under load average near 50, pessimistic).

**Storage:** One JSON file per release at `bench/cluster/<version>.json`. CI compares to baseline (R-063). Swarm Watch charts the last releases.

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

## Stages C1 to C6

| Stage | Scope | Gate |
|-------|--------|------|
| C1 | Shared ledger and leases (R-052) | 1000 simulated claim races, 0 double claims |
| C2 | Typed coordination events without model turns (R-053) | `ticket-done` updates peer ledger with 0 model calls |
| C3 | Reliable delivery: outbox, acks, catch-up (R-054) | 1000 offline messages delivered in order exactly once |
| C4 | Node join and registry; signed messages (R-055, R-056); owner-only boundary (R-057) | Join visible in 5 s; security tests pass; approve-attempt dropped |
| C5 | Release `swarm update` between waves (R-058); repo-wide merge queue (R-059); placement and stealing (R-060) | No mid-wave updates; FIFO merge; fair steal harness |
| C6 | CLI and board visibility (R-061); benchmarks and baseline (R-062); CI regression and chaos (R-063); two-node cutover (R-064); third node join/leave (R-065) | Baseline JSON stored; chaos suite green; three-node harness |

## Risks

- Ledger owner availability: if the owner node is down, claims pause; followers serve read-only board until failover (future work; not in S9).
- Tailnet misconfiguration exposes the push port; messages are still signed and typed but transport must stay tailnet-only.
- Outbox backlog on long offline periods needs disk headroom; catch-up is ordered but may take minutes after extended sleep.

## Deliberately not built

- Multi-owner trust or federated tenants
- Remote code execution via messages
- Auto-update of peer binaries mid-wave (owner runs `swarm update` between waves per R-058)
- Cross-owner clusters

## Requirements map

| Id | Topic |
|----|--------|
| R-052 | Shared ledger, leases, fencing (extends R-048) |
| R-053 | Coordination events without model turns |
| R-054 | Reliable delivery (outbox, acks, catch-up) |
| R-055 | Join and node registry with live capacity |
| R-056 | Typed signed messages |
| R-057 | Autonomous flows; owner-only boundary |
| R-058 | Release-ready `swarm update` between waves |
| R-059 | Repo-wide merge queue |
| R-060 | Placement and work stealing |
| R-061 | `swarm msg` and `swarm node` CLI + board views |
| R-062 | Benchmark storage per release |
| R-063 | CI regression gate, chaos suite |
| R-064 | MacBook + Mac mini cutover |
| R-065 | Third node join/leave |

Burst GPU (R-050) and cloud CPU (R-051) remain in S8 and are unrelated to cluster transport.

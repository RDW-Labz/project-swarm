# Swarm v2 architecture (proposal)

## Goal

Move Project Swarm from short-lived CLI processes and per-repo state to a per-machine service that owns queues, permissions, and events. Sessions and orchestrators become clients. Repos keep scope, tickets, and a pointer to machine-local state. The owner can run one board, one queue across machines, and burst work to cloud runners without breaking projects that still use today's CLI path.

## 1. Per-machine swarm service (launchd)

Today: Swarm runs as short-lived commands, one process per run. The only long-lived pieces are `swarm watch`, `swarm remote serve` (board), per-project autopilot, and `swarm orchestrator up` (#206) with one tmux session per project and a login launchd agent for remote-control.

Gap: No single daemon owns job lifecycle, reconnect, or machine-wide limits; restarts scatter state across processes.

Effort: L — new IPC, session protocol, and launchd packaging while keeping CLI entry points.

Migration: Ship `swarm service` alongside existing commands; default off. Opt in via machine config; clients use `SWARM_SERVICE=1` or `swarm --service`. Fallback: direct CLI invocation unchanged when the service is stopped.

## 2. One chief orchestrator across projects

Today: Each project gets its own orchestrator session under `swarm orchestrator up`, with separate autopilot loops and caps.

Gap: Cross-project slot fairness (R-032) and one owner chat surface need a single planner that sees all active projects on the machine.

Effort: M — chief process is mostly routing and policy; project orchestrators can shrink to thin clients first.

Migration: Flag `chief_orchestrator`; when on, project sessions register with the service and receive work from the chief. When off, current per-project tmux layout runs unchanged.

## 3. State outside the repo

Today: Each repo has a gitignored `.swarm` folder (runs, tickets ledger, journal ndjson, orchestrator events, handbuild guard state). Machine files live under `~/.project-swarm` (install, spend store, live-run registry, busy markers) and `~/.config/project-swarm`. Usage ledger and HANDOFF are generated markdown inside the repo; the board reads those files.

Gap: Dirty trees, large gitignored folders, and duplicated ledgers make multi-machine sync and clean `git status` hard.

Effort: M — move blobs to `~/.project-swarm/projects/<id>/` and keep a small committed pointer file in the repo.

Migration: Dual-write phase: new runs write to external store and mirror into `.swarm` until the board and tools read the pointer. Flag `external_state`; `swarm migrate state` copies once. Fallback: pointer still lists legacy `.swarm` paths until cutover.

## 4. Per-job isolation and enforced permissions

Today: Copied workspace per job with a sandbox profile; scratch worktrees for integration; Cursor and Codex lanes see committed HEAD only (integrated snapshot module on a branch). Jobs share machine ports and databases. Permissions rely on a text hand-build guard on orchestrator tool calls, git hooks, and GitHub branch protection.

Gap: Shared ports/DBs collide under parallel jobs; text guards are honest-but-fallible.

Effort: L — container or hardened worktree profiles, dynamic port/DB allocation, and service-granted caps per job.

Migration: Jobs request isolation level `legacy` vs `isolated`; isolated jobs get allocated ports/DB names from the service. Guard stays on for legacy; isolated jobs deny network/git/file outside the grant set at the service. Fallback: legacy sandbox path remains default per project until flipped.

## 5. Multi-machine cluster (one queue, one board)

Today: `swarm-inbox` git repo plus field export/collect over git; Mac mini runs its own clone and sessions. No shared queue; Swarm Watch already aggregates cards (R-028) from exports.

Gap: Two machines cannot dequeue the same ticket; queue depth and ordering diverge.

Effort: L — durable queue in the event store with lease semantics and tailnet auth.

Migration: Per machine, `queue_mode=local|cluster`; cluster mode enqueues to the shared store while still running workers locally. Local mode unchanged. Board reads cluster queue when any member reports `cluster`.

## 6. Cloud burst runners

Today: A rented GPU lane (vast/lambda style) exists; no general cloud runners for CPU build lanes.

Gap: Machine slots cap throughput; burst work cannot spill to elastic workers with the same isolation model.

Effort: M — reuse job isolation spec; add runner agent that registers with the service and pulls leased jobs.

Migration: Projects opt in with `burst=off|on`; only tagged tickets (e.g. `lane:burst`) leave the machine. Local runners always preferred; cloud jobs time out back to local queue on failure. Fallback: burst disabled by default.

## 7. One-command install, doctor, and `swarm add`

Today: `node tools/install.mjs --user`, `swarm update` from tags, `swarm doctor` checks lanes, `swarm init` links a project; no `swarm add`.

Gap: Onboarding a second repo is manual; service + cluster assumptions are not validated in one place.

Effort: S — wrap install, extend doctor checks, add `swarm add REPO` that writes pointer + scope hookup.

Migration: New installs get a single curl/bash entry; existing installs keep `swarm update`. `swarm add` is additive; `swarm init` remains for backward compatibility.

## 8. One event store (SQLite)

Today: ndjson and markdown ledgers in several places; the board assembles views from scattered files.

Gap: Consistency, cross-machine sync, and progress math duplicate logic and race under parallel writers.

Effort: M — SQLite per machine (or per cluster leader) with `events` table, SQL views for board panels, and export commands for committed repo artifacts.

Migration: Importers tail existing ndjson/markdown into SQLite; dual-publish new events to both until `event_store=primary`. Board switches views via flag; exports replace generated HANDOFF/usage on a schedule. Fallback: file-based readers stay until importers pass parity tests.

## Suggested order

1. **Event store (8)** — Single writer model unlocks service APIs, board views, and cluster queue without more file races.
2. **State outside repo (3)** — Depends on store for pointers and exports; enables clean repos before multi-machine scale.
3. **Per-machine service (1)** — Hosts store, grants, and queues; sessions become clients after store migration path exists.
4. **Chief orchestrator (2)** — Sits on the service once multiple projects register.
5. **Per-job isolation (4)** — Service allocates resources; can roll out per project after local service is stable.
6. **Install / doctor / `swarm add` (7)** — Document and gate the new paths once service + pointer layout exist.
7. **Multi-machine cluster (5)** — Needs shared store and queue semantics from (8) and stable external state (3).
8. **Cloud burst (6)** — Last; reuses isolation spec (4) and cluster leases (5).

## Risks

SQLite replication and tailnet exposure for the cluster queue are the main design risks; a bad migration could strand in-flight tickets if dual-write is cut early. Keep legacy CLI and file ledgers until doctor reports parity on a sample project.

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

## 4a. Test DB, ports, and cheap enforced permissions (stage 1)

Today: Copied workspace per job with a sandbox profile; jobs share machine ports and databases. Permissions rely on a text hand-build guard, git hooks, and GitHub branch protection.

Gap: Shared ports and DBs collide under parallel jobs; text guards are honest but fallible; broad tokens can change workflows or settings.

Effort: M — per-job test database (own name or own file) and ports allocated by swarm (no containers; nothing shared between concurrent test or e2e jobs); branch-only fine-grained GitHub PAT (Contents and Pull requests read/write, Metadata read, Actions read; no Administration, Workflows write, Secrets, or Environments) plus branch protection on main in every active repo (PR required, no force pushes or deletions, enforced for admins, required checks as today). Owner sees exact scopes before creating the token in GitHub settings.

Migration: Allocations and branch-only token default off per project. Exit gates: e2e passes 5 times in parallel on one Mac with zero shared data; an orchestrator session with that token pushes a feature branch and opens a PR while push to main, force push, and branch delete are rejected by the server.

## 4b. Container isolation and service-enforced permissions (later)

Today: Scratch worktrees for integration; Cursor and Codex lanes see committed HEAD only. Isolation beyond test DB and ports is not enforced by a service.

Gap: A compromised or confused agent can still reach network, git, and files outside the grant set without containers or service caps.

Effort: L — container or hardened worktree profiles and service-granted caps per job.

Migration: Jobs request isolation level `legacy` vs `isolated`; isolated jobs deny network, git, and file outside the grant set at the service. Fallback: legacy sandbox path remains default per project until flipped.

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

Gates and order: CPU runners for tests and e2e come first (R-051); a rented GPU worker (R-050) is allowed only after all three gates pass (queue pressure 3 days, flat-rate lanes rate-limited, GPU model 90 percent first-try on the benchmark replay); no rental until the numbers are shown to the owner; auto-start on a long queue, auto-shutdown when empty, counted in the daily limit, never given sensitive or production code.

## 7. One-command install, doctor, and `swarm add`

Today: `node tools/install.mjs --user`, `swarm update` from tags, `swarm doctor` checks lanes, `swarm init` links a project; no `swarm add`.

Gap: Onboarding a second repo is manual; service and cluster assumptions are not validated in one place.

Effort: S — wrap install, extend doctor checks, add `swarm add REPO` that writes pointer and scope hookup.

Migration: New installs get a single curl/bash entry; existing installs keep `swarm update`. `swarm add` is additive; `swarm init` remains for backward compatibility.

## 8. One event store (SQLite)

Today: ndjson and markdown ledgers in several places; the board assembles views from scattered files.

Gap: Consistency, cross-machine sync, and progress math duplicate logic and race under parallel writers.

Effort: M — SQLite per machine (or per cluster leader) with `events` table, SQL views for board panels, and export commands for committed repo artifacts.

Migration: Importers tail existing ndjson/markdown into SQLite; dual-publish new events to both until `event_store=primary`. Board switches views via flag; exports replace generated HANDOFF/usage on a schedule. Fallback: file-based readers stay until importers pass parity tests. The store uses built-in `node:sqlite` (Node 22.13+); on Node 20 the feature is off and its tests are skipped with a stated reason. Raising the engines floor is an owner decision.

## Stage 1 (internal, about one month)

Weeks 1–2: Event store (8) — events table, views, importers, dual publish. Gate: the board answers from the store with the same numbers as today's files on project-swarm.

Weeks 2–3: State outside the repo (3) — pointer file, `swarm migrate state`, dual write. Gate: `git status` clean after a full wave.

Weeks 2–4 (parallel): Test DB, ports, and branch-only token (4a); gates as above.

Weeks 3–4: `swarm add`, stronger doctor, minimal opt-in launchd service that owns the store and machine limit (1). Gate: restart and clients reconnect within 5 seconds; `swarm add` shows a project on the board in under 60 seconds.

Stage 1 does not include: chief orchestrator (2), containers and service-enforced permissions (4b), multi-machine cluster (5), or cloud burst (6). Every part stays flags-off by default until opted in.

## Suggested order

1. **Stage 1** — Event store first, then state outside the repo, then test DB and ports plus branch-only token in parallel, then `swarm add` and doctor, then the service MVP; all flags off by default.
2. **Chief orchestrator (2)** — After stage 1; one planner across registered projects.
3. **Container isolation (4b)** — Service-enforced permissions; after chief orchestrator.
4. **Multi-machine cluster (5)** — One queue and one board across machines.
5. **Cloud burst (6)** — Overflow runners last.

Node: event store needs `node:sqlite` (22.13+). On Node 20 the store is off and tests skip with a stated reason; dropping Node 20 is an owner decision.

## Risks

SQLite replication and tailnet exposure for the cluster queue are the main design risks; a bad migration could strand in-flight tickets if dual-write is cut early. Keep legacy CLI and file ledgers until doctor reports parity on a sample project.

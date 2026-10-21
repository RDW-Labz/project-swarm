# Scope: Project Swarm roadmap (audit 2026-10-20)
Version: 1

## Overview
Project Swarm builds software with many cheap AI workers, planned and checked by an orchestrator. The audit of 2026-10-20 (parts-request-app, atlas-seafloor, marketing agency, project-swarm) found that the main bottlenecks are bad ticket splitting, owner approvals, workers seeing only committed files, one giant swarm.mjs, idle slots, and serial version bumps. This scope is the checklist to fix them. It is also the first real test of the Swarm Watch "Build progress" view: every requirement below should show up there as progress toward a finished build.

Already merged before this scope (mark their tickets done with the PR as evidence): guard D+E (#208), autopilot P (#209), board hang fix (#212), CI timeouts + push-only-main (#213), executors flake fix (#217), flat-rate $0 reserve E9 (#204), base-check placeholders (#205).

Out of scope: building the 8 managers as separate long-running agents (S6 defines their first version only), GPU lane rental, any project's app features.

## Stages
- S1: Unblock autonomy
- S2: Ticket Manager v2
- S3: Throughput and reliability
- S4: Visibility on Swarm Watch
- S5: Operations
- S6: Managers, first versions
- S7: Swarm v2 stage 1 (internal, about one month)
- S8: Swarm v2 later stages
- S9: Cluster (N devices, one ledger, autonomous node-to-node work)

## S1 Unblock autonomy
### R-001 The policy engine auto-decides routine requests.
Acceptance:
- swarm policy init writes the owner's standing approvals as the default rules file.
- Requests matching a rule are decided without the owner and logged in the journal and Events with the rule id.
- Merges that deploy a live site, hosted DB migrations, new paid services or keys, and spend past the daily limit are never auto-decided.

### R-002 Autopilot runs for every active project.
Acceptance:
- Each project's orchestrator can start swarm autopilot, and it starts go --scope when ready tickets exist, nothing is running, and the cap has room.
- Autopilot pauses while the orchestrator integrates or runs e2e, and resumes after.
- swarm orchestrator up (#206) keeps autopilot and the orchestrator running across restarts.

### R-003 Workers see integrated but uncommitted output.
Acceptance:
- A job that depends on an earlier integrated run receives a snapshot of the integrated tree automatically.
- No orchestrator needs a local wip branch or a hand test run to pass state to a worker.

### R-004 tools/swarm.mjs is split into modules.
Acceptance:
- swarm.mjs is split into guard, scope, run, integrate, board, spend, lanes and cli modules with no behavior change.
- The full suite passes, and two queue items touching different modules can build in the same wave.

### R-005 The guard stops flagging harmless commands.
Acceptance:
- The word "claude" in --agent claude, commit trailers, paths and model names is not treated as self-approval.
- Backticks, $VARS and > inside quoted strings are not treated as writes.
- Manifests, ledger files and moves to the scratchpad are not counted as hand-built edits.

## S2 Ticket Manager v2
### R-006 Ticket paths are validated against the repo.
Acceptance:
- Every file a ticket writes or reads as context is checked against the real file tree before ingest.
- A ticket naming a missing file is rejected with the closest real path suggested.

### R-007 Tickets are sized for their lane.
Acceptance:
- The splitter sizes tickets by file bytes per lane (for example the Hermes 15 KB limit), not only file count.
- A ticket too large for every cheap lane is split or routed to a lane that edits in place.

### R-008 A build ticket owns its own tests.
Acceptance:
- A build ticket writes or owns the test file that proves it, so there is no build → test → fix chain.
- The critical path of a typical scope is shorter than before on the same input.

### R-009 Acceptance lines are provable by the ticket itself.
Acceptance:
- Every acceptance line can be checked from the ticket's own files plus context the splitter attaches automatically.
- No acceptance line depends on a later ticket's files.

### R-010 Risk tags are precise.
Acceptance:
- Tickets are tagged sensitive only for auth, database, payments, secrets and public routes.
- A scope like atlas store-wrapper no longer tags every ticket sensitive.

### R-011 The splitter sees existing tickets.
Acceptance:
- Done tickets release their files, and only open or running tickets block a file in a wave.
- New tickets can list existing open tickets as dependsOn.

### R-012 Waves are simulated before ingest.
Acceptance:
- Before ingest the swarm simulates waves for the current slot count.
- If the critical path is over 25% of tickets or average fill is under 50% of slots, it re-splits or asks.

### R-013 A blocked ticket is re-planned automatically.
Acceptance:
- A ticket that blocks, or fails twice, is re-split or rerouted without the orchestrator writing a manifest.
- The re-plan is logged with its reason.

### R-014 Delete, rename and migration tickets work.
Acceptance:
- A delete-only ticket passes sync once its files are gone.
- Rename and migration tickets have their own type with matching checks.

### R-015 Human tickets are a separate owner checklist.
Acceptance:
- Human tickets do not count toward build progress or block wave planning.
- They appear to the owner as a checklist with steps.

## S3 Throughput and reliability
### R-016 Releases ship as a train.
Acceptance:
- Runner changes merge without their own version bump, and one release bump batches them on a schedule or on demand.
- swarm update still sees a clean version per release.

### R-017 One bad ticket can't hold a wave.
Acceptance:
- Failed ticket outputs move to a quarantine folder automatically, and the retry gets them as read-only context.
- Passing tickets in a wave integrate through the merge queue while the failing one is bisected out.

### R-018 Tests don't flake under load.
Acceptance:
- Load-timing tests wait on events, not wall-clock time, and pass 5 runs in a row under artificial load.
- A flaky test is quarantined and reported, never silently retried to green.

### R-019 Base checks are honest.
Acceptance:
- A cached red base is always re-run, and green stays cached.
- Base checks take a per-checkout lock, and a red base reports which check failed, its exit code and its last lines.

### R-020 Reviews match risk and batch small work.
Acceptance:
- Review tier follows risk: Opus for sensitive paths, Sonnet for normal code, Haiku for tests and docs.
- Small low-risk tickets share one review job.
- Manifest runs get the same review gate as ledger tickets.

### R-021 Verify runs without a model.
Acceptance:
- verify mode "local" runs the ticket's tests itself with no agent and no tokens.
- Tested tickets can then be built on any lane, including Cursor and Hermes.

### R-022 The machine limit tunes itself.
Acceptance:
- The worker limit defaults from cores and free RAM, raises while CPU and RAM allow, and backs off on pressure or lane rate limits.
- Learned per-lane caps are kept per machine.

## S4 Visibility on Swarm Watch
### R-023 Build progress shows how close each project is to done.
Acceptance:
- Each project card shows % done, the current milestone and an ETA.
- The project page shows stages, what's left, the milestone strip and spend vs cap.
- This scope itself is shown correctly as the first test.

### R-024 Deploys are tracked.
Acceptance:
- "Deployed" lights up from the repo's Production deploys and shows "not tracked" when there is no data.

### R-025 The board shows only real sessions and real money.
Acceptance:
- Exited orchestrator sessions drop off within 5 minutes.
- Every dollar figure says billed or list value, and caps count billed spend only.
- Worktrees group under their parent project and share its cap.

### R-026 Idle lanes say why.
Acceptance:
- Each idle lane shows its reason: no ready jobs, rate limit, not routed or not set up.
- A project idle with ready tickets is flagged red.

### R-027 Split quality is graded.
Acceptance:
- A Split quality panel per project shows overhead ratio, first-try pass rate, critical path, wave fill, collisions, review $ per ticket and ticket sizes, each green, amber or red.

### R-028 One board covers every machine.
Acceptance:
- Projects and orchestrators from the MacBook and the Mac mini appear on one board.
- Each card shows its machine and swarm version, and version drift is flagged.

### R-029 The owner can act from the board.
Acceptance:
- Approve and Deny buttons appear for requests the policy leaves to the owner, tailnet only, with sign-in, a confirm step and an audit log.
- Merge, deploy and cap actions are refused from the phone or board server-side.
- Each orchestrator card has an "Open chat" link to its Remote Control session.

## S5 Operations
### R-030 Orchestrators hand off before their context gets expensive.
Acceptance:
- When an orchestrator's context passes a set size, it saves state to memory and a fresh session continues with no lost work.

### R-031 Deploys are watched by the swarm.
Acceptance:
- After a merge that deploys, the swarm checks the deploy, health and error logs for 15 minutes and offers rollback on failure.

### R-032 Slots are shared fairly across projects.
Acceptance:
- Machine slots are split across active projects by priority, so one project can't starve the others.

### R-033 Licences are enforced as a check.
Acceptance:
- Data sources carry their licence, and non-commercial sources are blocked from paid products by a swarm check.
- Required attribution is checked to be present where the data is shown.

### R-034 Test environments stay clean.
Acceptance:
- E2e runs clean up their own local test data, and a local-only cleanup tool refuses non-localhost databases.
- CI caches or mirrors images so Docker Hub rate limits don't fail runs.

### R-035 Field data from every project improves the swarm.
Acceptance:
- swarm field export, push and report work across both machines with metadata only and secret and PII scanning.
- Each new failure cause becomes a regression test, and lane pass rates feed routing.

## S6 Managers, first versions
### R-036 Ticket Manager and Unblocker.
Acceptance:
- The Ticket Manager keeps at least 5 ready tickets per active project.
- The Unblocker re-plans blocked tickets (R-013) and reports what it changed.

### R-037 Budget and Lane health managers.
Acceptance:
- The Budget manager watches billed spend per project and day and warns before a cap.
- The Lane health manager detects a lane that is down or rate limited and reroutes.

### R-038 Version and Merge queue managers.
Acceptance:
- The Version manager flags machines and projects behind the current release.
- The Merge queue manager merges green PRs in order under the standing approvals.

### R-039 Visual QA and Lessons keeper.
Acceptance:
- Visual QA takes screenshots of changed pages at phone and desktop size and attaches them to the PR.
- The Lessons keeper turns each logged lesson into a test or a rule and closes it.

## S7 Swarm v2 stage 1
### R-040 The event store answers the board.
Acceptance:
- One SQLite `events` table per machine; importers load existing ndjson and markdown; new events dual-publish until `event_store=primary` (flag off by default).
- `swarm board` and Swarm Watch % done, open tickets, and spend today match today's file-based numbers on project-swarm within 1 ticket and $0.01 spend.
- On Node 20, `event_store` stays off and event-store tests skip with a logged reason citing missing `node:sqlite` (requires Node 22.13+).

### R-041 Swarm state lives outside the repo.
Acceptance:
- Each project has a state folder under `~/.project-swarm/projects/<project-id>/`; the repo commits a pointer file with that id.
- `swarm migrate state` copies legacy `.swarm` once and dual-writes new runs until `external_state` is primary (flag off by default).
- After a full wave with external state primary, `git status` reports no untracked paths under `.swarm`.

### R-042 `swarm add` registers a project in one command.
Acceptance:
- `swarm add /path/to/repo` writes the pointer, registers the project, and exits 0 without manual `swarm init`.
- `swarm doctor` required checks pass on a machine with stage-1 flags enabled; optional lane sections may warn only.
- Swarm Watch lists the new project within 60 seconds of `swarm add` completing.

### R-043 A per-machine swarm service runs under launchd.
Acceptance:
- Opt-in `swarm service install` loads a user launchd agent; `swarm service status` reports running; CLI works unchanged when the service is off.
- The service owns the event store and machine worker limit when enabled (flags off by default).
- After `kill -9` on the service process, launchd restarts it and a waiting client reconnects within 5 seconds.

### R-044 Concurrent jobs share no test data.
Acceptance:
- Each job that runs tests or e2e gets its own test database (distinct name or file) and ports allocated by swarm before the job starts.
- Five parallel e2e runs on one Mac finish exit 0; no two runs use the same database name, TCP port, or temp directory path.
- `swarm doctor` reports allocation failures when ports or DB names cannot be assigned.

### R-045 Pushes are limited by the server.
Acceptance:
- Orchestrator setup shows the exact fine-grained PAT scopes (Contents and Pull requests read/write, Metadata read, Actions read; no Administration, Workflows write, Secrets, or Environments) before the owner creates the token in GitHub.
- Branch protection on `main` in every active repo requires a PR, blocks force pushes and branch deletion, enforces for admins, and keeps today's required checks.
- A session using the branch-only token pushes a feature branch and opens a PR; `git push origin main`, `git push --force`, and `git push origin :main` exit non-zero with a server rejection message.

## S8 Swarm v2 later stages
### R-046 One chief orchestrator plans across projects.
Acceptance:
- With `chief_orchestrator` on (default off), exactly one chief process runs per machine; `swarm orchestrator status` lists every active project and slot share.
- Starting a second chief exits non-zero and leaves the first chief unchanged.
- When two projects each have ready tickets and the machine cap is 4, the chief starts jobs on both projects in the same wave.

### R-047 Jobs run in containers with permissions enforced by the service.
Acceptance:
- Two concurrent isolated jobs receive different container grants; neither process can open the other's `DATABASE_URL` (connection refused or auth failure).
- An isolated job denied `git push` fails at the service with exit code 1 before the agent invokes `git push`.
- `legacy` sandbox jobs behave as today when `isolated` is not enabled for that project (default off).

### R-048 One queue and one board across machines.
Acceptance:
- With cluster queue on MacBook and Mac mini, enqueueing ticket T on either machine shows T in `swarm queue list` on both within 3 seconds.
- Only one machine holds an active lease on T; a second worker starting T gets exit non-zero and message `leased elsewhere`.
- Swarm Watch queue depth for the shared project matches on both machines within 1 ticket.

### R-049 Cloud runners take overflow work.
Acceptance:
- A ticket tagged `lane:burst` runs on a registered cloud runner and writes completion to the event store within 60 seconds of local enqueue on a test job.
- If the cloud runner misses heartbeat for 120 seconds, the lease returns to the local queue and a local worker can dequeue the ticket.
- `burst=off` remains the default; projects with burst off show zero cloud jobs in `swarm queue list` for 24 hours after a burst-enabled project runs a job.

### R-050 A rented GPU worker bursts only after the benchmark gates pass.
Acceptance:
- `swarm burst gpu status` prints three gate lines with measured values and PASS or FAIL: ready tickets greater than free slots across both Macs for 3 or more consecutive days; every flat-rate lane (Cursor, Codex) rate-limited during that period; GPU model first-try pass rate of 90 percent or more on the benchmark replay (bench harness, same ticket set as the Haiku baseline; last measured: GPU 73 percent, Haiku 100 percent).
- With any gate FAIL, `swarm burst gpu start` exits non-zero with message `gates not met` and rents nothing, and the numbers are shown to the owner before any rental.
- Once rented, the worker starts automatically when the queue stays long, shuts down automatically when the queue is empty for 10 minutes, and its cost counts toward the daily limit (stop or notify mode, hard ceiling still stops it).
- The GPU worker is only given tickets not marked sensitive and never production code, secrets or customer data, verified by a test that a sensitive ticket is refused with `not allowed on rented lane`.

### R-051 Cloud CPU runners run tests and end-to-end checks.
Acceptance:
- A registered cloud CPU runner runs a ticket's own test command and the full e2e suite and writes pass or fail plus duration to the event store.
- It is the first burst feature built, before any GPU work, because test waiting is the likely larger win: the benchmark scorecard must show ticket ready-to-merged time and idle slot percent before and after, and the runner stays off unless that scorecard improves.
- Same defaults as R-049: burst off by default, no sensitive code, local queue takes the ticket back after 120 seconds without a heartbeat, spend counted in the daily limit.

## S9 Cluster
### R-052 One shared ledger with ticket leases replaces hand-off branches and ticket ID ranges.
Acceptance:
- With cluster ledger enabled, R-048 shared queue behavior still holds; claims write a lease record with holder node id, monotonic fencing token, and expiry in the ledger owner store instead of hand-off branches or per-node ticket id ranges.
- A worker heartbeat every 30 seconds extends the lease only when the fencing token matches; after automatic expiry without heartbeat the ticket returns to ready with exit 0 on `swarm queue release --expired`, and a dead node's late heartbeats are rejected.
- Two simulated workers racing to claim the same ticket produce exactly one holder and one exit non-zero with message `claim rejected`; release benchmark harness records 0 double-claims.
- An expired lease returns the ticket to the pool for any node with a free slot without owner action.

### R-053 Coordination events are typed swarm-to-swarm messages that use no model turns and no orchestrator tokens.
Acceptance:
- `ticket-done`, `release-shipped`, `lease-claim`, `lease-release`, `request`, `question`, `handoff`, and `ack` each validate against schema and are handled without invoking an LLM or spending orchestrator tokens.
- In the harness, a `ticket-done` from node B reaches node A and updates the shared ledger with 0 model calls recorded on either node.
- The wake event fires only for message kinds that require an orchestrator decision; routine coordination messages do not start an orchestrator session.
- Lease and ticket state transitions from these messages complete without owner relay.

### R-054 Reliable delivery uses acks, bounded retries with backoff, a durable outbox on disk, de-duplication, and catch-up after reconnect.
Acceptance:
- Every delivered message receives an `ack` with correlation id; senders retry with bounded backoff until acked or max attempts, reading from a durable on-disk outbox that survives process crash.
- Receivers de-duplicate by sender id and monotonic sequence; duplicate frames are dropped with no side effect on ticket state.
- After a node sleeps or reconnects, catch-up delivers queued messages in order; 1000 messages queued while offline are delivered exactly once after return.
- A crash of the sender or receiver does not lose a message accepted into the outbox or inbox; recovery replays unacked work.

### R-055 Any machine joins with `swarm join` using tailnet auth and registers in the node registry with capabilities and live capacity.
Acceptance:
- `swarm join` with valid tailnet credentials exits 0, writes a node id under `~/.project-swarm/nodes/self`, and appears in `swarm node list` within 5 seconds with cores, RAM GiB, worker limit, lane list, and GPU flag.
- The registry row includes live capacity: real memory pressure and swap, free slots, and lane health; free memory uses the real free-memory reading, not Node `os.freemem`, which undercounts on macOS by about 30 times.
- A node missing tailnet auth exits non-zero and does not appear on any peer registry.
- Heartbeats refresh capacity fields so placement sees current headroom.

### R-056 Typed signed messages use per-node keys, schema validation, and never carry executable content.
Acceptance:
- Every cluster frame is signed with the sender node's key and validates against JSON Schema before send; oversize payloads above 64 KiB exit non-zero.
- Secret scan runs on send and on receive; messages with key-like material are dropped, logged, and never applied.
- Forged signatures, replays, and sequence gaps inside the nonce window fail closed with exit non-zero; traffic is accepted only over the tailnet.
- Message bodies contain no shell commands, scripts, or other executable fields.

### R-057 Autonomous node flows never perform owner-only actions.
Acceptance:
- Approve, merge to live, deploy, caps, spend, and keys remain owner-only on every node; cluster workers and peers cannot invoke them.
- A message that implies any owner-only action is dropped, logged locally, and raised to the owner with no side effect on ticket or deploy state.
- A simulated approve-attempt leaves ticket state unchanged and increments the owner alert counter by 1.
- `ticket-done`, `release-shipped`, `handoff`, `request`, `question`, and `ack` flows complete without owner relay in the harness.

### R-058 A release-ready event makes peer nodes run `swarm update` between waves, never mid-wave.
Acceptance:
- A `release-shipped` coordination event schedules `swarm update` on followers only when no wave jobs are running on that node (when-idle rule).
- Pinned projects skip update until unpinned; an in-flight wave is not interrupted by version sync.
- After update between waves, all nodes report the same swarm release version on `swarm node list` before the next wave starts.
- Harness verifies zero mid-wave update invocations while jobs are active.

### R-059 One repo-wide merge queue across nodes merges PRs in one order through `swarm merge`.
Acceptance:
- PRs opened from any node enqueue to a single merge queue; only one merge runs at a time via `swarm merge` with the green-check requirement.
- A node cannot merge around the queue; a second merge attempt while one is in flight exits non-zero.
- Merge order is FIFO by queue position regardless of which node opened the PR.
- Harness with two nodes submitting PRs proves one ordered merge history in the event store.

### R-060 Placement and work stealing use real capacity across nodes.
Acceptance:
- Each node reports free slots, memory pressure, and lane health; a node with free slots pulls ready tickets honoring file ownership, lane fit, ticket target worktree, and fair share across projects.
- Heavy jobs prefer the node with the most headroom when multiple nodes can run the lane.
- A ticket bound to a worktree on node B is not started on node C when B alone owns the ticket's files.
- When two projects both have ready work, slot share across nodes stays within 1 ticket of the fair-share target for 10 consecutive steal cycles in the harness.

### R-061 Messaging and nodes are visible on the CLI and board.
Acceptance:
- `swarm msg send`, `swarm msg list`, and `swarm msg tail` exit 0 and show typed messages with sender node id and sequence.
- `swarm node list` shows every joined machine with last heartbeat age under 120 seconds when healthy.
- Swarm Watch message log and node view list the same message ids as `swarm msg list` within 1 message.

### R-062 Release benchmarks per version run against a fixed baseline stored under `bench/cluster/`.
Acceptance:
- `swarm bench cluster` runs the deterministic harness and writes `bench/cluster/<version>.json` with message latency p50 and p95, ticket ready-to-started time, slot utilization, idle node-minutes while ready work exists, owner relays, double-claims, and tickets per hour per node.
- Re-running with the same seed produces identical JSON aside from `recordedAt`.
- Swarm Watch charts the trend for the last five release benchmark points.
- Optional `swarm bench cluster --tailnet` is documented for the owner and is not required for CI exit 0.

### R-063 CI fails on benchmark regression past threshold and chaos tests pass.
Acceptance:
- CI compares new results to `bench/cluster/baseline.json`: throughput more than 10 percent worse, latency p95 more than 25 percent worse, utilization more than 5 points worse, any double-claim above 0, or any owner relay above 0 fails the job with exit non-zero.
- Chaos tests pass: kill a node mid-ticket, drop the network, clock skew, and two nodes claiming at once (1000 races, 0 double-claims).
- A deliberate regression injection in the harness test fails CI in under 2 minutes.
- All four chaos scenarios are required for release gate exit 0.

### R-064 The MacBook and the Mac mini are the first two nodes; relayed hand-off flow is retired once both run on the ledger.
Acceptance:
- With both machines on cluster ledger, relayed hand-off branches and owner-forwarded messages count 0 for 24 hours in the board log.
- Ticket ready-to-started time p95 is under 30 seconds when any node has a free slot (harness with ready queue).
- Slot utilization across all nodes is above 80 percent whenever ready tickets exist in a 1-hour harness run.
- Cutover checklist documents disabling legacy hand-off paths after both nodes heartbeats are healthy.

### R-065 A third node joins and leaves without breaking leases, the queue, or the board.
Acceptance:
- A third simulated node joins via `swarm join`, steals work, then leaves cleanly; `swarm node list` drops it within 30 seconds and no ticket stays leased to the departed node id.
- Idle node-minutes while ready tickets exist stay under 1 percent of total node-minutes in the three-node harness.
- Owner relays and double-claims remain 0 for the three-node scenario.
- Shared merge queue and board views stay consistent while the third node joins and departs.

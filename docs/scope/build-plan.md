# Build plan

Scope: Project Swarm roadmap (audit 2026-10-20) (version 1)
Progress: 57% done of 407 live tickets
Tickets: 420 total (proposed 0, todo 61, ready 9, running 0, review 5, done 230, blocked 102, cancelled 13)
Change orders: 2 (CO-001, CO-002)

## S1 Unblock autonomy

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0001 | Policy rules file schema and validation for standing approvals | done | medium |
| T-0002 | Policy engine matches rules and auto-decides routine hand-build requests | done | medium |
| T-0003 | swarm policy init writes default rules from standing approvals | done | low |
| T-0004 | Policy decisions emit journal and Events lines with rule id | done | low |
| T-0005 | Wire policy engine into hand-build request create and decide paths | done | medium |
| T-0006 | Mount swarm policy init on the CLI entry | done | low |
| T-0007 | Tests for policy init, auto-decide, blocked cases, and journal rule id | done | low |
| T-0008 | Autopilot start-ready launches go --scope when tickets ready and cap allows | done | medium |
| T-0009 | Autopilot pauses during integrate or e2e and resumes afterward | done | medium |
| T-0010 | orchestrator up keeps autopilot and orchestrator alive across restarts | done | medium |
| T-0011 | Each active project orchestrator can start autopilot for its root | done | low |
| T-0012 | Mount swarm autopilot on the CLI for every project root | done | low |
| T-0013 | Tests autopilot go --scope gating, pause during integrate, and orchestrator up | blocked | low |
| T-0014 | Capture integrated tree bytes after integrate for dependent jobs | done | medium |
| T-0015 | Apply integrated snapshot into dependent worker workspaces before run | blocked | medium |
| T-0016 | Ticket manifests declare after-integrated deps without wip branches | done | medium |
| T-0017 | Mount integrated snapshot wiring on run CLI path | blocked | low |
| T-0018 | Tests integrated-tree snapshot handoff between dependent jobs | blocked | low |
| T-0019 | Extract guard helpers from swarm.mjs into swarm-guard module | cancelled | medium |
| T-0020 | Extract scope commands from swarm.mjs into swarm-scope module | cancelled | medium |
| T-0021 | Extract run pipeline from swarm.mjs into swarm-run module | done | medium |
| T-0022 | Extract integrate path from swarm.mjs into swarm-integrate module | cancelled | medium |
| T-0023 | Extract board and watch commands into swarm-board module | done | low |
| T-0024 | Extract spend and budgets commands into swarm-spend module | cancelled | low |
| T-0025 | Extract lane routing and doctor paths into swarm-lanes module | cancelled | low |
| T-0026 | Extract argv dispatch from swarm.mjs into swarm-cli module | done | medium |
| T-0027 | Rewire tools/swarm.mjs to import modular guard scope run integrate board spend lanes cli | cancelled | high |
| T-0028 | CLI entry tools/swarm.mjs dispatches through swarm-cli after modular split | cancelled | low |
| T-0029 | Tests modular swarm.mjs split and parallel module wave safety | cancelled | low |
| T-0030 | Stop treating claude in agents paths and trailers as self-approval | done | low |
| T-0031 | Ignore backticks vars and redirections inside quoted shell strings for writes | done | low |
| T-0032 | Exclude manifests ledger files and scratchpad moves from hand-built edits | done | low |
| T-0033 | Wire guard parsers and exemptions into handbuild decision path | done | medium |
| T-0034 | Mount handbuild guard behavior on the CLI handbuild request path | done | low |
| T-0035 | Tests harmless claude strings quoted shell and swarm-produced exemptions | done | low |
| T-0226 | Mount split swarm modules in tools/swarm.mjs entry point with no behavior change | cancelled | medium |

## S2 Ticket Manager v2

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0036 | Add ticket-paths helper to validate files and suggest closest repo paths | done | low |
| T-0037 | Wire ticket path validation into scope split --ingest | done | medium |
| T-0038 | Add lane-size module for per-lane byte budgets on split tickets | done | low |
| T-0039 | Apply lane byte sizing during split ingest and scope approve warnings | done | medium |
| T-0040 | Make build tickets own their test files in ticket-manifest prompts | done | low |
| T-0041 | Keep test tickets after build modules in wiring order | done | low |
| T-0042 | Wire build-owns-tests rules into scope split ingest | done | medium |
| T-0043 | Filter acceptance lines to those provable from ticket files and auto context | done | low |
| T-0044 | Reject or trim unprovable acceptance lines at split ingest | done | medium |
| T-0045 | Tag sensitive only for auth, database, payments, secrets and public routes | done | low |
| T-0046 | Use precise sensitive tagging during split ingest instead of scope phrase match | done | medium |
| T-0047 | Compute file owners from open tickets and release done ticket files | done | low |
| T-0048 | Expose existing ticket file locks to split workers and merge ingest | done | medium |
| T-0049 | Simulate ingest waves for slot count, fill and critical path length | done | low |
| T-0050 | Run wave simulation before scope split --ingest writes the ledger | done | medium |
| T-0051 | Re-split or reroute blocked tickets after two failures without a manifest | done | medium |
| T-0052 | Invoke ticket replan from scope sync when a ticket blocks or fails twice | done | medium |
| T-0053 | Validate delete-only tickets and migration ticket DDL rules | done | low |
| T-0054 | Add rename ticket type validation alongside migration checks | done | medium |
| T-0055 | Wire delete and rename ticket sync checks into scope sync integrated path | done | medium |
| T-0056 | Exclude human tickets from build progress and wave blocking counts | done | low |
| T-0057 | Show human ticket checklists on Swarm Watch plan tab without build progress | done | low |
| T-0058 | Owner validates human ticket checklist UX on Swarm Watch | todo | low |
| T-0059 | Document Ticket Manager v2 ingest and replan behavior in dogfood fixes design | done | low |
| T-0060 | Regression tests for ticket path validation at ingest | done | low |
| T-0061 | Regression tests for split wave simulation thresholds | done | low |
| T-0062 | Regression tests for delete-only and rename ticket sync | done | low |

## S3 Throughput and reliability

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0063 | Shared release-train record shapes for runner merges and batched version bumps | done | low |
| T-0064 | Merge runner-only changes without bumping package version on each PR | done | medium |
| T-0065 | Batch one scheduled or on-demand release version bump for accumulated runner merges | done | medium |
| T-0066 | Expose one clean semver per release for swarm update and install checks | done | low |
| T-0067 | Tests for release train merge policy, batched bump, and update version reporting | done | low |
| T-0068 | Wire release train commands into swarm CLI entry | done | medium |
| T-0069 | Shared quarantine paths and wave failure metadata for ticket retries | done | low |
| T-0070 | Move failed ticket outputs into quarantine automatically after a wave failure | done | medium |
| T-0071 | Attach quarantined outputs as read-only context on the retry manifest | done | medium |
| T-0072 | Integrate passing wave tickets through merge queue while the failure is bisected out | done | high |
| T-0073 | Tests for quarantine moves, retry context, and partial-wave integration | done | low |
| T-0074 | Wire wave quarantine and salvage into scope loop orchestration | review | high |
| T-0075 | Event-based synchronization helpers for load-timing checks instead of wall-clock sleeps | done | low |
| T-0076 | Artificial-load harness that stresses checks with five consecutive event-driven runs | done | medium |
| T-0077 | Quarantine flaky checks instead of silently retrying them to green | done | medium |
| T-0078 | Report quarantined flaky tests in run state and ship output | done | low |
| T-0079 | Tests for load-timing stability and flaky quarantine reporting | done | low |
| T-0080 | Wire event waits and flake quarantine into integrate check runner | blocked | medium |
| T-0081 | Re-run cached red base checks and keep green base checks cached | done | medium |
| T-0082 | Per-checkout lock so only one base check runs per worktree at a time | ready | medium |
| T-0083 | Rich red-base failure records with check name, exit code, and tail output | ready | low |
| T-0084 | Tests for honest base-check cache, lock, and failure reporting | todo | low |
| T-0085 | Wire honest base-check policy into swarm run base gate | blocked | medium |
| T-0086 | Choose review model tier from ticket risk and touched paths | done | medium |
| T-0087 | Batch small low-risk tickets into one shared review job | done | low |
| T-0088 | Apply the same review gate to manifest runs as ledger scope tickets | done | medium |
| T-0089 | Tests for review tier selection, batching, and manifest review parity | done | low |
| T-0090 | Wire risk-based review batching into scope sync review manifests | ready | medium |
| T-0091 | Run ticket tests locally with verify agent none and zero model tokens | done | low |
| T-0092 | Allow tested tickets on any lane after local verify passes | blocked | medium |
| T-0093 | Parse verify.mode local in project profile and manifest builder | blocked | low |
| T-0094 | Tests for local verify execution and cross-lane routing after tests pass | blocked | low |
| T-0095 | Wire verify mode local into swarm run manifest dispatch | blocked | medium |
| T-0096 | Default machine worker limit from CPU cores and free RAM | done | low |
| T-0097 | Raise or lower active worker limit based on CPU, RAM, and lane rate limits | done | medium |
| T-0098 | Persist learned per-lane concurrency caps per machine | done | low |
| T-0099 | Tests for adaptive worker limits and per-lane cap persistence | done | low |
| T-0100 | Wire adaptive worker tuning into lane scheduler and machineConcurrency | done | medium |

## S4 Visibility on Swarm Watch

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0101 | OpenAPI contract for Swarm Watch progress and deploy fields on the board snapshot | done | low |
| T-0102 | OpenAPI contract for board money, idle, quality, federation and owner-action endpoints | done | medium |
| T-0103 | Compute per-project percent done, current milestone and ETA for the board API | done | low |
| T-0104 | Read production deploy status from repo deploy logs for the Deployed indicator | done | low |
| T-0105 | Drop exited orchestrator sessions from the board snapshot within five minutes | done | low |
| T-0106 | Label every dollar as billed or list value and count only billed spend toward caps | done | low |
| T-0107 | Group worktree projects under their parent and share the parent spend cap | done | medium |
| T-0108 | Derive idle lane reasons: no ready jobs, rate limit, not routed or not set up | done | low |
| T-0109 | Compute split quality metrics per project for the quality panel | done | low |
| T-0110 | Merge board snapshots from multiple machines into one federated board feed | done | medium |
| T-0111 | Tailnet-only owner approve and deny handlers with confirm step and audit log entries | done | high |
| T-0112 | Refuse merge, deploy and cap actions from phone or board API paths server-side | done | high |
| T-0113 | Wire S4 board snapshot helpers into board-data exports | done | medium |
| T-0114 | Expose federated board snapshot and owner-action routes on the watch server | done | high |
| T-0115 | Render project card percent done, milestone and ETA on the board overview | done | low |
| T-0116 | Render stages, remaining work, milestone strip and spend vs cap on the project page module | done | low |
| T-0117 | Show Deployed lit or not tracked on each project card | done | low |
| T-0118 | Show billed vs list value labels on board money figures and cap bars | done | low |
| T-0119 | Nest worktree projects under parent cards on the board overview | done | low |
| T-0120 | Show idle lane reasons and red flag when a project is idle with ready tickets | done | low |
| T-0121 | Render the Split quality panel with green, amber and red metrics per project | review | low |
| T-0122 | Show machine and swarm version on cards and flag version drift | done | low |
| T-0123 | Approve and Deny controls with confirm step on the board Needs you panel | done | high |
| T-0124 | Add Open chat link on each orchestrator card to its Remote Control session | done | medium |
| T-0125 | Tests for project progress percent, milestone, ETA and project page progress strip | done | low |
| T-0126 | Tests for production deploy tracking and not-tracked state | done | low |
| T-0127 | Tests for session pruning, money labels, and worktree grouping under shared caps | done | low |
| T-0128 | Tests for idle lane reasons and red idle-with-ready flag | done | low |
| T-0129 | Tests for split quality metrics and red-amber-green grading | todo | low |
| T-0130 | Tests for multi-machine federation and version drift flags | done | medium |
| T-0131 | Tests for tailnet owner actions, server-side refusal, and orchestrator chat links | blocked | high |
| T-0132 | Mount progress UI on / board and /project pages | done | low |
| T-0133 | Wire deploy badge into the board overview page | done | low |
| T-0134 | Wire money labels and worktree grouping into the board overview | done | low |
| T-0135 | Wire idle reasons and red ready-ticket flag into the board Agents view | done | low |
| T-0136 | Mount Split quality panel on the project page | blocked | low |
| T-0137 | Wire machine badges and version drift into the federated board overview | done | medium |
| T-0138 | Mount owner Approve/Deny and orchestrator Open chat on the board | blocked | high |
| T-0139 | Document S4 Swarm Watch visibility features and ui screen ids for rendered check | done | low |
| T-0140 | Register Mac mini board peer URL in the machine federation config on both hosts | todo | medium |

## S5 Operations

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0141 | Measure orchestrator transcript size against a configurable handoff threshold | done | medium |
| T-0142 | Persist orchestrator handoff state to project memory and journal | done | medium |
| T-0143 | Trigger orchestrator handoff from orchestrator hooks when context is over limit | done | medium |
| T-0144 | Regression tests for orchestrator context handoff and resume | done | low |
| T-0145 | Wire orchestrator handoff into swarm CLI and resume path | blocked | medium |
| T-0146 | Track post-merge deploys and start a 15-minute watch window | done | medium |
| T-0147 | Poll deploy health endpoints and production error logs during the watch | done | medium |
| T-0148 | Offer rollback guidance when deploy watch detects failure | done | high |
| T-0149 | Regression tests for post-merge deploy watch and rollback offer | done | low |
| T-0150 | Wire deploy watch into swarm merge and ship flow | blocked | medium |
| T-0151 | Read per-project priority used for machine slot sharing | done | low |
| T-0152 | Apply project priority when granting machine-wide lane slots | done | medium |
| T-0153 | Regression tests for priority-weighted machine slot sharing | done | low |
| T-0154 | Expose fair slot sharing status on swarm status and board data | blocked | low |
| T-0155 | Model data-source licence metadata on manifests and profiles | done | low |
| T-0156 | Block non-commercial data sources from paid product builds in checks | done | medium |
| T-0157 | Verify required attribution is present where licensed data is shown | done | low |
| T-0158 | Regression tests for licence and attribution swarm checks | done | low |
| T-0159 | Register licence and attribution checks on swarm validate and integrate | blocked | medium |
| T-0160 | E2e harness cleans up local test data after each run | done | low |
| T-0161 | Local-only test database cleanup refuses non-localhost targets | done | medium |
| T-0162 | CI workflow template caches or mirrors Docker Hub images | done | low |
| T-0163 | Regression tests for e2e cleanup, localhost guard, and CI image cache | done | low |
| T-0164 | Wire test cleanup and CI mirror helpers into swarm test commands | blocked | low |
| T-0165 | Export field lessons metadata from a project without secrets or PII | done | medium |
| T-0166 | Push scanned field exports between swarm machines | ready | high |
| T-0167 | Summarize field exports into a cross-machine report | blocked | medium |
| T-0168 | Turn each new failure cause into a regression test stub | ready | low |
| T-0169 | Feed lane pass rates into ticket routing decisions | done | medium |
| T-0170 | Regression tests for field export, push, report, and metadata scanning | blocked | medium |
| T-0171 | Regression tests for failure regression stubs and lane pass routing | blocked | low |
| T-0172 | Wire swarm field export, push, and report subcommands | blocked | medium |

## S6 Managers, first versions

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0173 | OpenAPI contract for manager run, finding, and journal report shapes | done | low |
| T-0174 | Shared manager types aligned with contracts/managers.json | done | low |
| T-0175 | Journal line writer for manager findings and actions | done | low |
| T-0176 | Per-action off, shadow and auto mode settings for managers | done | low |
| T-0177 | Base manager class wiring types, journal lines and action modes | done | low |
| T-0178 | Register built-in managers by id for CLI and replay | done | low |
| T-0179 | Registry hooks for budget and lane health manager slots | done | low |
| T-0180 | Registry hooks for ticket-manager and unblocker slots | done | low |
| T-0181 | Registry hooks for version and merge-queue manager slots | done | low |
| T-0182 | Registry hooks for visual-qa and lessons-keeper slots | done | low |
| T-0183 | Replay harness stepping managers over recorded ledger snapshots | done | medium |
| T-0184 | Scorecard writer for manager replay caught, missed and wrong-action counts | done | low |
| T-0185 | Document scrubbed manager replay fixtures under evals/managers | done | low |
| T-0186 | Seeded S11-style spend fixture for budget manager replay | done | low |
| T-0187 | Seeded S13 lane-down fixture for lane health replay | done | low |
| T-0188 | Unit tests for manager base, registry, replay and scorecard | done | low |
| T-0189 | Public managers package exports for replay and scorecard | done | low |
| T-0190 | Mount swarm managers replay and scorecard on the managers CLI entry | done | low |
| T-0191 | Budget manager daily spend rollup per project from the spend ledger | done | medium |
| T-0192 | Budget manager cap forecast and warn actions before hard stop | done | medium |
| T-0193 | Budget manager orchestrator registering safe warn and hold actions | done | medium |
| T-0194 | Lane health pre-run probes and 429 detection hooks | done | medium |
| T-0195 | Lane health pause, reroute and concurrency shrink actions | done | medium |
| T-0196 | Lane health manager orchestrator wired into the registry | done | medium |
| T-0197 | Replay tests for budget cap warning and lane down reroute | done | low |
| T-0198 | Register budget and lane health managers on swarm managers run | done | low |
| T-0199 | Ticket Manager ready-pool check keeps five tickets ready per active project | done | low |
| T-0200 | Ticket Manager scope-time checks for ownership, context and gating | done | medium |
| T-0201 | Ticket Manager orchestrator blocking a run until scope checks pass | done | medium |
| T-0202 | Unblocker ranks blocked tickets by how many others they gate | done | medium |
| T-0203 | Unblocker safe replans for blocked tickets per R-013 | done | high |
| T-0204 | Unblocker change report summarizing replans and reroutes | done | low |
| T-0205 | Unblocker orchestrator after each wave with ranked safe fixes | done | high |
| T-0206 | Seeded S13 ticket-context fixture for ticket manager replay | done | low |
| T-0207 | Replay tests for ticket manager scope gate and unblocker replan report | done | medium |
| T-0208 | Register ticket-manager and unblocker on swarm managers scope and wave hooks | ready | medium |
| T-0209 | Version manager flags stale pointers, remote boards and installs | done | low |
| T-0210 | Version manager safe pointer bump and idle update scheduling | done | medium |
| T-0211 | Merge queue manager watches batches, conflicts and check failures | done | medium |
| T-0212 | Merge queue manager ordered green merge actions under standing approvals | done | high |
| T-0213 | Merge queue manager orchestrator with flaky-test fix ticket proposals | done | high |
| T-0214 | Seeded stale-pointer fixture for version manager replay | done | low |
| T-0215 | Replay tests for version stale flags and merge queue green ordering | done | medium |
| T-0216 | Register version and merge-queue managers on swarm managers run | todo | medium |
| T-0217 | Visual QA captures phone and desktop screenshots for changed pages | done | medium |
| T-0218 | Visual QA attaches screenshot artifacts to the active PR | done | medium |
| T-0219 | Visual QA manager orchestrator for UI tickets after integration | done | medium |
| T-0220 | Lessons keeper drafts a test or rule from a logged lesson file | done | low |
| T-0221 | Lessons keeper closes lessons after linked test or rule lands | done | low |
| T-0222 | Lessons keeper orchestrator proposing tests and rules from failures | done | low |
| T-0223 | Tests for visual QA screenshot attach and lessons keeper close loop | done | low |
| T-0224 | Register visual-qa and lessons-keeper on swarm managers run after UI tickets | todo | low |
| T-0225 | Wire manager-commands into swarm.mjs main dispatcher | blocked | medium |

## S7 Swarm v2 stage 1 (internal, about one month)

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0227 | Add stage-1 feature flags event_store, external_state and service, all off by default | ready | low |
| T-0228 | Create the SQLite events table DDL and node:sqlite guard for the per-machine event store | todo | medium |
| T-0229 | Import existing ndjson and markdown events into the event store | todo | medium |
| T-0230 | Dual-publish new events to files and the store until event_store is primary | todo | medium |
| T-0231 | Compute open tickets, percent done and spend today from the event store for swarm board | todo | medium |
| T-0232 | Tests for event store import, dual publish, board numbers and Node 20 skip | todo | low |
| T-0233 | Mount event store board numbers on the board data route | todo | medium |
| T-0234 | Read and write the committed state pointer file with the project id | done | low |
| T-0235 | Resolve and create the external state folder under ~/.project-swarm/projects | ready | low |
| T-0236 | Copy legacy .swarm state once and dual-write new runs until external_state is primary | done | medium |
| T-0237 | Tests for pointer, external folder, one-time migration and git status with external state | todo | medium |
| T-0238 | Mount swarm migrate state on the swarm CLI entry | todo | low |
| T-0239 | Implement swarm add to write the pointer, register the project and exit 0 | done | medium |
| T-0240 | Add required stage-1 checks for swarm doctor with optional lane sections as warnings | todo | low |
| T-0241 | Tests for swarm add and stage-1 doctor checks | todo | low |
| T-0242 | Mount swarm add and swarm doctor on the swarm CLI entry | todo | low |
| T-0243 | Generate and load the opt-in user launchd agent for the swarm service | done | high |
| T-0244 | Service process owns the event store and machine worker limit when enabled | todo | medium |
| T-0245 | Client reconnects to the restarted service within 5 seconds | todo | medium |
| T-0246 | Tests for launchd plist, service status, and client reconnect | done | medium |
| T-0247 | Mount swarm service install and status on the swarm CLI entry | todo | medium |
| T-0248 | Owner runs the kill -9 restart check on the Mac for the launchd service | todo | low |
| T-0249 | Allocate per-job test database names, TCP ports and temp dirs before a job starts | todo | medium |
| T-0250 | Tests for five parallel e2e allocations and doctor allocation failures | todo | medium |
| T-0251 | Mount job allocation on the swarm test and e2e commands | todo | medium |
| T-0252 | Show the exact fine-grained PAT scopes in orchestrator setup before token creation | ready | medium |
| T-0253 | Tests for PAT scope listing in orchestrator setup | todo | low |
| T-0254 | Mount the PAT scope display on the orchestrator setup CLI entry | todo | low |
| T-0255 | Owner enables branch protection on main and checks rejected direct pushes | todo | high |

## S8 Swarm v2 later stages

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0340 | OpenAPI contract for chief, isolation, cluster queue and burst shapes (R-046 to R-051) | blocked | low |
| T-0341 | Add chief_orchestrator flag, default off, read from the project profile | blocked | low |
| T-0342 | One chief per machine; refuse a second start with non-zero exit | done | medium |
| T-0343 | Print every active project and slot share in swarm orchestrator status | done | low |
| T-0344 | Start jobs on two projects in the same wave when the machine cap is 4 | blocked | medium |
| T-0345 | Tests for chief flag, singleton lock, status listing and same-wave start | blocked | low |
| T-0346 | Mount chief start and status on the swarm orchestrator CLI entry | blocked | low |
| T-0347 | Route-level test of the chief CLI entry | blocked | low |
| T-0348 | Issue a distinct container grant per isolated job so DATABASE_URL is never shared | blocked | high |
| T-0349 | Refuse git push from isolated jobs at the service with exit code 1 | blocked | high |
| T-0350 | Keep legacy sandbox behaviour unless isolated is enabled per project (default off) | blocked | low |
| T-0351 | Start each isolated job in its container with its grant and git policy applied | blocked | high |
| T-0352 | Tests for container grants, git push denial and legacy mode | blocked | medium |
| T-0353 | Mount isolated job mode on the swarm run CLI entry | blocked | medium |
| T-0354 | Route-level test of isolated job run through the swarm run entry | blocked | low |
| T-0355 | Define queue item and lease record shapes shared by both machines | blocked | low |
| T-0356 | Shared enqueue and list visible on both machines within 3 seconds | done | medium |
| T-0357 | Single active lease per ticket; refuse a second worker with leased elsewhere | blocked | medium |
| T-0358 | Report shared project queue depth so both machines agree within 1 ticket | blocked | low |
| T-0359 | Tests for shared enqueue, lease refusal and queue depth | blocked | low |
| T-0360 | Mount swarm queue list and lease commands on the swarm CLI entry | blocked | medium |
| T-0361 | Route-level test of swarm queue list through the CLI entry | blocked | low |
| T-0362 | Owner pairs MacBook and Mac mini for the shared cluster queue | blocked | low |
| T-0363 | Define cloud runner registration and heartbeat record shapes | blocked | low |
| T-0364 | Send lane:burst tickets to a cloud runner and record completion in the event store | blocked | medium |
| T-0365 | Return the lease to the local queue after 120 seconds without a cloud heartbeat | blocked | medium |
| T-0366 | Keep burst off by default and hide cloud jobs for projects with burst off | blocked | low |
| T-0367 | Tests for lane:burst routing, heartbeat lease return and burst off default | blocked | low |
| T-0368 | Mount swarm burst cloud status on the swarm CLI entry | blocked | low |
| T-0369 | Route-level test of burst status through the CLI entry | blocked | low |
| T-0370 | Print three GPU gate lines with measured values and PASS or FAIL | blocked | medium |
| T-0371 | Refuse GPU start with gates not met and rent nothing when any gate fails | blocked | high |
| T-0372 | Start the rented worker on a long queue and stop it after 10 empty minutes within the daily limit | blocked | high |
| T-0373 | Refuse sensitive tickets on the rented GPU lane with not allowed on rented lane | blocked | high |
| T-0374 | Tests for GPU gates, refusal, auto shutdown and sensitive refusal | blocked | medium |
| T-0375 | Mount swarm burst gpu status and start on the swarm CLI entry | blocked | high |
| T-0376 | Route-level test of GPU burst status and start through the CLI entry | blocked | medium |
| T-0377 | Run a ticket's test command and full e2e suite on a cloud CPU runner and record the result | blocked | medium |
| T-0378 | Record ready-to-merged time and idle slot percent before and after; keep the runner off unless it improves | blocked | low |
| T-0379 | Tests for cloud CPU test runs and scorecard gating | blocked | low |
| T-0380 | Mount the cloud CPU runner on the swarm test and e2e commands | blocked | medium |
| T-0381 | Route-level test of the cloud CPU runner through the swarm test entry | blocked | low |
| T-0382 | Owner registers the cloud CPU and burst runner accounts and keeps burst off | blocked | medium |

## S9 Cluster (N devices, one ledger, autonomous node-to-node work)

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0339 | OpenAPI contract for cluster lease, message and node shapes | blocked | low |
| T-0416 | Cutover checklist for disabling legacy hand-off after both node heartbeats are healthy | blocked | low |
| T-0417 | Shared cluster node, message, ack, lease and merge-queue record shapes | blocked | low |
| T-0418 | Durable on-disk outbox that keeps accepted messages across process crash | blocked | medium |
| T-0419 | Inbox de-duplicates by sender id and monotonic sequence with no side effect on duplicates | blocked | medium |
| T-0420 | Sender retries unacked messages with bounded backoff until ack or max attempts | blocked | medium |
| T-0421 | Catch-up delivers queued messages in order after reconnect and replays unacked work | blocked | medium |
| T-0422 | Mount cluster delivery on the swarm cluster CLI so send and catch-up reach the real path | blocked | medium |
| T-0423 | Route-level and unit tests for reliable delivery through the CLI entry | blocked | low |
| T-0424 | Refuse owner-only actions from cluster workers and peers and raise an owner alert | blocked | high |
| T-0425 | Mount owner-only guard on the swarm cluster CLI entry for node messages | blocked | high |
| T-0426 | Route-level and unit tests for owner-only refusal and autonomous flows | blocked | medium |
| T-0427 | Schedule swarm update on followers only when no wave jobs run on that node | blocked | medium |
| T-0428 | Mount when-idle update scheduling on the swarm cluster CLI entry | blocked | medium |
| T-0429 | Route-level and unit tests for between-wave update and version parity | blocked | low |
| T-0430 | Single repo-wide merge queue that runs one green merge at a time in FIFO order | blocked | high |
| T-0431 | Mount the shared merge queue on the swarm cluster merge CLI entry | blocked | medium |
| T-0432 | Route-level and unit tests for one ordered merge history across two nodes | blocked | medium |
| T-0433 | Pull ready tickets honoring file ownership, lane fit, worktree target and node headroom | blocked | medium |
| T-0434 | Work stealing with fair share across projects and heavy jobs on the most headroom node | blocked | medium |
| T-0435 | Mount placement and stealing on the swarm cluster node list CLI entry | blocked | medium |
| T-0436 | Route-level and unit tests for placement, stealing and fair share | blocked | low |
| T-0437 | Deterministic seeded cluster harness that emits the benchmark metrics | blocked | medium |
| T-0438 | Write bench/cluster/<version>.json for swarm bench cluster | blocked | low |
| T-0439 | Expose the last five release benchmark points as trend data for Swarm Watch | blocked | low |
| T-0440 | Mount swarm bench cluster on the swarm cluster bench CLI entry | blocked | low |
| T-0441 | Route-level test that bench output is deterministic and charted | blocked | low |
| T-0442 | CI gate comparing new benchmark results to bench/cluster/baseline.json with exit non-zero on regression | blocked | medium |
| T-0443 | Four chaos scenarios: kill node mid-ticket, drop network, clock skew, and 1000 claim races | blocked | high |
| T-0444 | Mount the benchmark gate and chaos scenarios on the swarm cluster gate CLI entry | blocked | medium |
| T-0445 | Route-level and chaos tests for the release gate exit code | blocked | medium |
| T-0446 | Node join, leave, lease release and node list expiry within 30 seconds | blocked | medium |
| T-0447 | Mount swarm join and node list on the swarm cluster join CLI entry | blocked | medium |
| T-0448 | Route-level and unit tests for three-node join and leave | blocked | low |

## S10 Swarm Watch Command Center (Hive overview, project cockpit, command palette, tools hub)

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0288 | OpenAPI contract for the Command Center shared data layer | done | low |
| T-0289 | Shared Command Center data module for Hive and Cockpit | done | medium |
| T-0290 | Unit test that Hive and Cockpit resolve identical data values | done | low |
| T-0291 | Classic tab wrapper that holds the existing Swarm Watch views | done | low |
| T-0292 | Playwright test that each pre-upgrade Swarm Watch path returns 200 | done | low |
| T-0293 | Hive top stat strip with labelled projects, agents, done today and needs you | done | low |
| T-0294 | Hive central brain layout with project nodes and category legend | done | medium |
| T-0295 | Hive bottom panels: event log, lanes, savings and throughput chart | done | medium |
| T-0296 | Tests for Hive stat strip, layout and bottom panels | done | low |
| T-0297 | Canvas particle streams from project nodes into the brain | done | medium |
| T-0298 | Original animated brain entity with merge pulse and failure flicker | done | medium |
| T-0299 | Tests for stream frame rate and brain motion states | done | low |
| T-0300 | Project zoom transition, breadcrumb back and deep-link routing | done | medium |
| T-0301 | Tests for zoom, breadcrumb and deep links | done | low |
| T-0302 | Cockpit orchestrator character and stage rings with ticket flow | done | medium |
| T-0303 | Cockpit ticket lists with search and live run stream | done | medium |
| T-0304 | Tests for Cockpit orchestrator, rings and ticket flow | done | low |
| T-0305 | Robot head avatar wrapper with lane colour and state mapping | blocked | low |
| T-0306 | Snapshot test of Command Center robot head lane colour tokens | todo | low |
| T-0307 | Glitch effect wrapper with duration, concurrency and reduced-motion limits | done | medium |
| T-0308 | Test that npm test glitch limits file exits 0 | done | low |
| T-0309 | Command palette with fuzzy search and recent items | done | medium |
| T-0310 | Tests for palette search, keyboard use and recents | done | low |
| T-0311 | Skippable first-visit guided tour with Replay tour in Help | done | low |
| T-0312 | Tests for tour steps, keyboard use and Escape dismiss | done | low |
| T-0313 | Resources hub entry JSON Schema and entry loader | done | medium |
| T-0314 | Schema test for Resources hub entries | done | low |
| T-0315 | Phone layout CSS for stacked Hive and tabbed Cockpit | blocked | low |
| T-0316 | Playwright phone layout test at 390 px | todo | low |
| T-0317 | Owner runs self-review loop, vendor records and licence check for Command Center | todo | low |
| T-0318 | Mount shared data layer on the Command Center route | done | medium |
| T-0319 | Mount Classic tab on the watch server routes | review | medium |
| T-0320 | Mount Hive overview on the Command Center route | review | medium |
| T-0321 | Mount particle streams on the Hive page | todo | medium |
| T-0322 | Mount animated brain on the Hive page | todo | medium |
| T-0323 | Mount zoom and deep links on the Command Center route | todo | medium |
| T-0324 | Mount Cockpit view on the project deep link | todo | medium |
| T-0325 | Mount ticket lists and run stream in the Cockpit | todo | medium |
| T-0326 | Mount robot heads on Command Center agent avatars | todo | low |
| T-0327 | Mount glitch effects on Command Center pages | todo | low |
| T-0328 | Mount command palette on the Command Center route | todo | low |
| T-0329 | Mount guided tour and Help replay on the Command Center | todo | low |
| T-0330 | Mount Resources and Tools hub route | todo | low |
| T-0331 | Mount phone layout on the Command Center routes | todo | low |
| T-0332 | Route-level Playwright test for every Command Center integration | todo | medium |

## S11 Self-managing swarm (lane health, self-healing, machine watchdog, shared queue, smart routing, quota forecasting, daily phone summary)

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0449 | Shared lane health, lease and routing record types for self-management | done | low |
| T-0450 | Discover every lane from the config lanes keys, local endpoints and adapter registry | done | low |
| T-0451 | Free lane probes: port reachable, models-list GET, CLI version, rate-limit and spend-cap records | done | low |
| T-0452 | Lane monitor timer inside autopilot probing every discovered lane about every 2 minutes | done | medium |
| T-0453 | Adapter health function with default check of reachability plus last job result | done | low |
| T-0454 | New lanes take small jobs only until 3 checks and 2 real jobs pass | done | medium |
| T-0455 | Down lanes get no new jobs and their share moves to the next cheapest healthy lane | done | medium |
| T-0456 | Retry a job running on a lane that went down on another healthy lane | review | medium |
| T-0457 | Lane returns after 2 healthy checks and flapping lanes back off longer | done | low |
| T-0458 | Write lane up and down events to the swarm event log and message bus when present | done | low |
| T-0459 | Safe self-heal per lane: restart own tunnel, kill only own leaked processes, wait out rate limits | blocked | high |
| T-0460 | Raise Needs-you only for tier-wide 30 minute outages or expired login or billing | todo | low |
| T-0461 | Machine watchdog reading memory, swap, disk and orphaned swarm processes | blocked | high |
| T-0462 | Shrink waves under memory pressure and widen them again within 2 checks | todo | medium |
| T-0463 | Scratch and run folder garbage collection under a configured cap that skips checkouts with swarm state | todo | medium |
| T-0464 | Shared ticket queue with lease claims over the message bus | done | high |
| T-0465 | Lease expiry returns a crashed machine's ticket to the shared queue for retry | done | medium |
| T-0466 | Score lanes by success rate, speed and cost per ticket type and log the scores | blocked | medium |
| T-0467 | Keep secrets off workers and sensitive code off OpenRouter under every routing score | todo | high |
| T-0468 | Forecast Claude, Anthropic and OpenRouter cap run-out and shift work early without raising caps | done | high |
| T-0469 | Morning phone summary of shipped work, lane health, spend per tier and owner needs | todo | medium |
| T-0470 | Opus static review and numbered release install on both Macs for self-management changes | todo | medium |
| T-0471 | Tests for lane discovery, probes, monitor timer, adapter health and probation | done | low |
| T-0472 | Tests for reroute, job retry, recovery hysteresis, routing scores and safety rules | todo | medium |
| T-0473 | Tests for self-heal fixes, lane events and Needs-you thresholds | todo | medium |
| T-0474 | Tests for watchdog cleanup, wave pressure and scratch garbage collection | todo | low |
| T-0475 | Two fake machine tests for no double run, crash expiry and network split | done | medium |
| T-0476 | Tests for forecast cap safety and daily summary content, length and once-per-day send | todo | medium |
| T-0477 | Mount lane monitor status on the swarm CLI status route | done | medium |
| T-0478 | Mount adapter health and probation on the swarm CLI lanes route | done | medium |
| T-0479 | Mount reroute and recovery on the swarm CLI run path | todo | medium |
| T-0480 | Mount lane colour dots and event log on the swarm CLI status route | todo | low |
| T-0481 | Mount self-heal and Needs-you on the swarm CLI heal route | todo | medium |
| T-0482 | Mount watchdog and wave pressure on the swarm CLI machine route | todo | medium |
| T-0483 | Mount shared queue claim and expiry on the swarm CLI queue route | todo | medium |
| T-0484 | Mount smart routing scores on the swarm CLI route | todo | medium |
| T-0485 | Mount quota forecast on the swarm CLI budget route | todo | medium |
| T-0486 | Mount the daily phone summary on the swarm CLI summary route | todo | low |
| T-0487 | Route-level test that every self-management CLI route answers through the swarm CLI entry | todo | low |

## S0

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-9001 | Day 0: Stripe | cancelled | low |
| T-9002 | Day 0: Hosting | cancelled | low |
| T-9003 | Day 0: Push notifications | cancelled | low |
| T-9004 | Day 0: Secrets vault | cancelled | low |

## Requirements

| R | Text | Tickets | State |
| --- | --- | --- | --- |
| R-001 | The policy engine auto-decides routine requests. | T-0001, T-0002, T-0003, T-0004, T-0005, T-0006, T-0007 | done |
| R-002 | Autopilot runs for every active project. | T-0008, T-0009, T-0010, T-0011, T-0012, T-0013 | partial |
| R-003 | Workers see integrated but uncommitted output. | T-0014, T-0015, T-0016, T-0017, T-0018 | partial |
| R-004 | tools/swarm.mjs is split into modules. | T-0021, T-0023, T-0026 | unwired |
| R-005 | The guard stops flagging harmless commands. | T-0030, T-0031, T-0032, T-0033, T-0034, T-0035 | done |
| R-006 | Ticket paths are validated against the repo. | T-0036, T-0037, T-0059, T-0060 | done |
| R-007 | Tickets are sized for their lane. | T-0038, T-0039, T-0059 | done |
| R-008 | A build ticket owns its own tests. | T-0040, T-0041, T-0042, T-0059 | done |
| R-009 | Acceptance lines are provable by the ticket itself. | T-0043, T-0044, T-0059 | done |
| R-010 | Risk tags are precise. | T-0045, T-0046, T-0059 | done |
| R-011 | The splitter sees existing tickets. | T-0047, T-0048, T-0059 | done |
| R-012 | Waves are simulated before ingest. | T-0049, T-0050, T-0059, T-0061 | done |
| R-013 | A blocked ticket is re-planned automatically. | T-0051, T-0052, T-0059, T-0202, T-0203, T-0205, T-0207 | done |
| R-014 | Delete, rename and migration tickets work. | T-0053, T-0054, T-0055, T-0059, T-0062 | done |
| R-015 | Human tickets are a separate owner checklist. | T-0056, T-0057, T-0058, T-0059 | partial |
| R-016 | Releases ship as a train. | T-0063, T-0064, T-0065, T-0066, T-0067, T-0068 | done |
| R-017 | One bad ticket can't hold a wave. | T-0069, T-0070, T-0071, T-0072, T-0073, T-0074 | partial |
| R-018 | Tests don't flake under load. | T-0075, T-0076, T-0077, T-0078, T-0079, T-0080 | partial |
| R-019 | Base checks are honest. | T-0081, T-0082, T-0083, T-0084, T-0085 | partial |
| R-020 | Reviews match risk and batch small work. | T-0086, T-0087, T-0088, T-0089, T-0090 | partial |
| R-021 | Verify runs without a model. | T-0091, T-0092, T-0093, T-0094, T-0095 | partial |
| R-022 | The machine limit tunes itself. | T-0096, T-0097, T-0098, T-0099, T-0100 | done |
| R-023 | Build progress shows how close each project is to done. | T-0101, T-0103, T-0113, T-0115, T-0116, T-0125, T-0132, T-0139 | done |
| R-024 | Deploys are tracked. | T-0101, T-0104, T-0113, T-0117, T-0126, T-0133, T-0139 | done |
| R-025 | The board shows only real sessions and real money. | T-0102, T-0105, T-0106, T-0107, T-0113, T-0118, T-0119, T-0127, T-0134, T-0139 | done |
| R-026 | Idle lanes say why. | T-0102, T-0108, T-0113, T-0120, T-0128, T-0135, T-0139 | done |
| R-027 | Split quality is graded. | T-0102, T-0109, T-0113, T-0121, T-0129, T-0136, T-0139 | partial |
| R-028 | One board covers every machine. | T-0102, T-0110, T-0113, T-0114, T-0122, T-0130, T-0137, T-0139, T-0140 | partial |
| R-029 | The owner can act from the board. | T-0102, T-0111, T-0112, T-0114, T-0123, T-0124, T-0131, T-0138, T-0139 | partial |
| R-030 | Orchestrators hand off before their context gets expensive. | T-0141, T-0142, T-0143, T-0144, T-0145 | partial |
| R-031 | Deploys are watched by the swarm. | T-0146, T-0147, T-0148, T-0149, T-0150 | partial |
| R-032 | Slots are shared fairly across projects. | T-0151, T-0152, T-0153, T-0154 | partial |
| R-033 | Licences are enforced as a check. | T-0155, T-0156, T-0157, T-0158, T-0159 | partial |
| R-034 | Test environments stay clean. | T-0160, T-0161, T-0162, T-0163, T-0164 | partial |
| R-035 | Field data from every project improves the swarm. | T-0165, T-0166, T-0167, T-0168, T-0169, T-0170, T-0171, T-0172 | partial |
| R-036 | Ticket Manager and Unblocker. | T-0173, T-0174, T-0175, T-0176, T-0177, T-0178, T-0180, T-0183, T-0184, T-0185, T-0188, T-0189, T-0190, T-0199, T-0200, T-0201, T-0202, T-0203, T-0204, T-0205, T-0206, T-0207, T-0208, T-0225 | partial |
| R-037 | Budget and Lane health managers. | T-0173, T-0174, T-0175, T-0176, T-0177, T-0178, T-0179, T-0183, T-0184, T-0185, T-0186, T-0187, T-0188, T-0189, T-0190, T-0191, T-0192, T-0193, T-0194, T-0195, T-0196, T-0197, T-0198, T-0225 | partial |
| R-038 | Version and Merge queue managers. | T-0173, T-0174, T-0175, T-0176, T-0177, T-0178, T-0181, T-0183, T-0184, T-0185, T-0188, T-0189, T-0190, T-0209, T-0210, T-0211, T-0212, T-0213, T-0214, T-0215, T-0216, T-0225 | partial |
| R-039 | Visual QA and Lessons keeper. | T-0173, T-0174, T-0175, T-0176, T-0177, T-0178, T-0182, T-0183, T-0184, T-0185, T-0188, T-0189, T-0190, T-0217, T-0218, T-0219, T-0220, T-0221, T-0222, T-0223, T-0224, T-0225 | partial |
| R-040 | The event store answers the board. | T-0227, T-0228, T-0229, T-0230, T-0231, T-0232, T-0233 | missing |
| R-041 | Swarm state lives outside the repo. | T-0227, T-0234, T-0235, T-0236, T-0237, T-0238 | partial |
| R-042 | `swarm add` registers a project in one command. | T-0239, T-0240, T-0241, T-0242 | partial |
| R-043 | A per-machine swarm service runs under launchd. | T-0227, T-0243, T-0244, T-0245, T-0246, T-0247, T-0248 | partial |
| R-044 | Concurrent jobs share no test data. | T-0249, T-0250, T-0251 | missing |
| R-045 | Pushes are limited by the server. | T-0252, T-0253, T-0254, T-0255 | missing |
| R-046 | One chief orchestrator plans across projects. | T-0340, T-0341, T-0342, T-0343, T-0344, T-0345, T-0346, T-0347 | partial |
| R-047 | Jobs run in containers with permissions enforced by the service. | T-0340, T-0348, T-0349, T-0350, T-0351, T-0352, T-0353, T-0354 | missing |
| R-048 | One queue and one board across machines. | T-0340, T-0355, T-0356, T-0357, T-0358, T-0359, T-0360, T-0361, T-0362 | partial |
| R-049 | Cloud runners take overflow work. | T-0340, T-0363, T-0364, T-0365, T-0366, T-0367, T-0368, T-0369, T-0382 | missing |
| R-050 | A rented GPU worker bursts only after the benchmark gates pass. | T-0340, T-0370, T-0371, T-0372, T-0373, T-0374, T-0375, T-0376 | missing |
| R-051 | Cloud CPU runners run tests and end-to-end checks. | T-0340, T-0377, T-0378, T-0379, T-0380, T-0381, T-0382 | missing |
| R-052 | One shared ledger with ticket leases replaces hand-off branches and ticket ID ranges. | T-0339 | missing |
| R-053 | Coordination events are typed swarm-to-swarm messages that use no model turns and no orchestrator tokens. | T-0339 | missing |
| R-054 | Reliable delivery uses acks, bounded retries with backoff, a durable outbox on disk, de-duplication, and catch-up after reconnect. | T-0417, T-0418, T-0419, T-0420, T-0421, T-0422, T-0423 | missing |
| R-055 | Any machine joins with `swarm join` using tailnet auth and registers in the node registry with capabilities and live capacity. | T-0339 | missing |
| R-056 | Typed signed messages use per-node keys, schema validation, and never carry executable content. | T-0339 | missing |
| R-057 | Autonomous node flows never perform owner-only actions. | T-0424, T-0425, T-0426 | missing |
| R-058 | A release-ready event makes peer nodes run `swarm update` between waves, never mid-wave. | T-0427, T-0428, T-0429 | missing |
| R-059 | One repo-wide merge queue across nodes merges PRs in one order through `swarm merge`. | T-0417, T-0430, T-0431, T-0432 | missing |
| R-060 | Placement and work stealing use real capacity across nodes. | T-0417, T-0433, T-0434, T-0435, T-0436 | missing |
| R-061 | Messaging and nodes are visible on the CLI and board. | T-0339 | missing |
| R-062 | Release benchmarks per version run against a fixed baseline stored under `bench/cluster/`. | T-0437, T-0438, T-0439, T-0440, T-0441 | missing |
| R-063 | CI fails on benchmark regression past threshold and chaos tests pass. | T-0442, T-0443, T-0444, T-0445 | missing |
| R-064 | The MacBook and the Mac mini are the first two nodes; relayed hand-off flow is retired once both run on the ledger. | T-0416 | missing |
| R-065 | A third node joins and leaves without breaking leases, the queue, or the board. | T-0417, T-0446, T-0447, T-0448 | missing |
| R-066 | Command Center views read one shared data layer with real labelled numbers only. | T-0288, T-0289, T-0290, T-0318, T-0332 | partial |
| R-067 | Everything Swarm Watch has today stays. | T-0291, T-0292, T-0319, T-0332 | partial |
| R-068 | The Hive overview shows the swarm at a glance. | T-0293, T-0294, T-0295, T-0296, T-0320, T-0332 | partial |
| R-069 | Particle streams flow from each project node into the core. | T-0297, T-0299, T-0321, T-0332 | partial |
| R-070 | The brain entity is an original animated centerpiece. | T-0298, T-0299, T-0322, T-0332 | partial |
| R-071 | Clicking a project zooms into the Project Cockpit with navigation back to the Hive. | T-0300, T-0301, T-0323, T-0332 | partial |
| R-072 | The Project Cockpit shows orchestrator, stages, and ticket flow. | T-0302, T-0304, T-0324, T-0332 | partial |
| R-073 | Cockpit sides and bottom expose lists and the live run stream. | T-0303, T-0304, T-0325, T-0332 | partial |
| R-074 | Real robot heads are used everywhere an agent appears. | T-0305, T-0306, T-0326, T-0332 | missing |
| R-075 | Signature glitch style uses PowerGlitch within strict limits. | T-0307, T-0308, T-0327, T-0332 | partial |
| R-076 | A command palette jumps to projects, tickets, runs, PRs, docs, and commands. | T-0309, T-0310, T-0328, T-0332 | partial |
| R-077 | A first-visit guided tour explains the Command Center. | T-0311, T-0312, T-0329, T-0332 | partial |
| R-078 | A Resources and Tools hub is searchable and plugin-extensible. | T-0313, T-0314, T-0330, T-0332 | partial |
| R-079 | The phone layout stacks the Hive and tabs the Cockpit without horizontal scroll. | T-0315, T-0316, T-0331, T-0332 | missing |
| R-080 | Performance, accessibility, and review gates pass for every Command Center stage. | T-0317 | missing |
| R-081 | Every lane is health-monitored automatically from the config and the adapter registry, with no hardcoded lane list. | T-0449, T-0450, T-0451, T-0452, T-0471, T-0477, T-0487 | partial |
| R-082 | Every lane adapter ships a health check, and new lanes start on probation. | T-0449, T-0453, T-0454, T-0471, T-0478, T-0487 | partial |
| R-083 | Routing uses lane health and reroutes without stuck jobs. | T-0449, T-0455, T-0456, T-0457, T-0472, T-0479, T-0487 | partial |
| R-084 | Lane status is visible and only truly stuck cases alert the owner. | T-0458, T-0460, T-0473, T-0480, T-0487 | partial |
| R-085 | Lanes try safe self-healing before they are marked down. | T-0459, T-0460, T-0473, T-0481, T-0487 | missing |
| R-086 | A machine watchdog keeps every machine healthy and widens waves again when pressure drops. | T-0461, T-0462, T-0463, T-0474, T-0482, T-0487 | missing |
| R-087 | The MacBook and the Mac mini pull from one shared queue. | T-0464, T-0465, T-0475, T-0483, T-0487 | partial |
| R-088 | Smart routing picks the best-value healthy lane and keeps the safety rules. | T-0466, T-0467, T-0472, T-0484, T-0487 | missing |
| R-089 | Quota forecasting shifts work early and never raises a cap. | T-0468, T-0476, T-0485, T-0487 | partial |
| R-090 | One short daily summary reaches the owner's phone. | T-0469, T-0476, T-0486, T-0487 | missing |
| R-091 | Self-management changes are reviewed and released safely. | T-0470 | missing |

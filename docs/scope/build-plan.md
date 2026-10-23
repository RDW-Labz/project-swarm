# Build plan

Scope: Project Swarm roadmap (audit 2026-10-20) (version 1)
Progress: 74% done of 218 live tickets
Tickets: 230 total (proposed 0, todo 12, ready 19, running 3, review 0, done 161, blocked 23, cancelled 12)
Change orders: 0

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
| T-0009 | Autopilot pauses during integrate or e2e and resumes afterward | ready | medium |
| T-0010 | orchestrator up keeps autopilot and orchestrator alive across restarts | done | medium |
| T-0011 | Each active project orchestrator can start autopilot for its root | ready | low |
| T-0012 | Mount swarm autopilot on the CLI for every project root | done | low |
| T-0013 | Tests autopilot go --scope gating, pause during integrate, and orchestrator up | blocked | low |
| T-0014 | Capture integrated tree bytes after integrate for dependent jobs | ready | medium |
| T-0015 | Apply integrated snapshot into dependent worker workspaces before run | blocked | medium |
| T-0016 | Ticket manifests declare after-integrated deps without wip branches | done | medium |
| T-0017 | Mount integrated snapshot wiring on run CLI path | blocked | low |
| T-0018 | Tests integrated-tree snapshot handoff between dependent jobs | blocked | low |
| T-0019 | Extract guard helpers from swarm.mjs into swarm-guard module | cancelled | medium |
| T-0020 | Extract scope commands from swarm.mjs into swarm-scope module | cancelled | medium |
| T-0021 | Extract run pipeline from swarm.mjs into swarm-run module | ready | medium |
| T-0022 | Extract integrate path from swarm.mjs into swarm-integrate module | cancelled | medium |
| T-0023 | Extract board and watch commands into swarm-board module | ready | low |
| T-0024 | Extract spend and budgets commands into swarm-spend module | cancelled | low |
| T-0025 | Extract lane routing and doctor paths into swarm-lanes module | cancelled | low |
| T-0026 | Extract argv dispatch from swarm.mjs into swarm-cli module | ready | medium |
| T-0027 | Rewire tools/swarm.mjs to import modular guard scope run integrate board spend lanes cli | cancelled | high |
| T-0028 | CLI entry tools/swarm.mjs dispatches through swarm-cli after modular split | cancelled | low |
| T-0029 | Tests modular swarm.mjs split and parallel module wave safety | cancelled | low |
| T-0030 | Stop treating claude in agents paths and trailers as self-approval | done | low |
| T-0031 | Ignore backticks vars and redirections inside quoted shell strings for writes | done | low |
| T-0032 | Exclude manifests ledger files and scratchpad moves from hand-built edits | done | low |
| T-0033 | Wire guard parsers and exemptions into handbuild decision path | done | medium |
| T-0034 | Mount handbuild guard behavior on the CLI handbuild request path | done | low |
| T-0035 | Tests harmless claude strings quoted shell and swarm-produced exemptions | done | low |
| T-0226 | Mount split swarm modules in tools/swarm.mjs entry point with no behavior change | todo | medium |

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
| T-0068 | Wire release train commands into swarm CLI entry | ready | medium |
| T-0069 | Shared quarantine paths and wave failure metadata for ticket retries | done | low |
| T-0070 | Move failed ticket outputs into quarantine automatically after a wave failure | done | medium |
| T-0071 | Attach quarantined outputs as read-only context on the retry manifest | done | medium |
| T-0072 | Integrate passing wave tickets through merge queue while the failure is bisected out | done | high |
| T-0073 | Tests for quarantine moves, retry context, and partial-wave integration | ready | low |
| T-0074 | Wire wave quarantine and salvage into scope loop orchestration | todo | high |
| T-0075 | Event-based synchronization helpers for load-timing checks instead of wall-clock sleeps | done | low |
| T-0076 | Artificial-load harness that stresses checks with five consecutive event-driven runs | done | medium |
| T-0077 | Quarantine flaky checks instead of silently retrying them to green | done | medium |
| T-0078 | Report quarantined flaky tests in run state and ship output | done | low |
| T-0079 | Tests for load-timing stability and flaky quarantine reporting | done | low |
| T-0080 | Wire event waits and flake quarantine into integrate check runner | blocked | medium |
| T-0081 | Re-run cached red base checks and keep green base checks cached | done | medium |
| T-0082 | Per-checkout lock so only one base check runs per worktree at a time | running | medium |
| T-0083 | Rich red-base failure records with check name, exit code, and tail output | running | low |
| T-0084 | Tests for honest base-check cache, lock, and failure reporting | todo | low |
| T-0085 | Wire honest base-check policy into swarm run base gate | blocked | medium |
| T-0086 | Choose review model tier from ticket risk and touched paths | done | medium |
| T-0087 | Batch small low-risk tickets into one shared review job | done | low |
| T-0088 | Apply the same review gate to manifest runs as ledger scope tickets | done | medium |
| T-0089 | Tests for review tier selection, batching, and manifest review parity | done | low |
| T-0090 | Wire risk-based review batching into scope sync review manifests | ready | medium |
| T-0091 | Run ticket tests locally with verify agent none and zero model tokens | ready | low |
| T-0092 | Allow tested tickets on any lane after local verify passes | blocked | medium |
| T-0093 | Parse verify.mode local in project profile and manifest builder | blocked | low |
| T-0094 | Tests for local verify execution and cross-lane routing after tests pass | blocked | low |
| T-0095 | Wire verify mode local into swarm run manifest dispatch | blocked | medium |
| T-0096 | Default machine worker limit from CPU cores and free RAM | done | low |
| T-0097 | Raise or lower active worker limit based on CPU, RAM, and lane rate limits | ready | medium |
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
| T-0121 | Render the Split quality panel with green, amber and red metrics per project | ready | low |
| T-0122 | Show machine and swarm version on cards and flag version drift | done | low |
| T-0123 | Approve and Deny controls with confirm step on the board Needs you panel | done | high |
| T-0124 | Add Open chat link on each orchestrator card to its Remote Control session | done | medium |
| T-0125 | Tests for project progress percent, milestone, ETA and project page progress strip | done | low |
| T-0126 | Tests for production deploy tracking and not-tracked state | done | low |
| T-0127 | Tests for session pruning, money labels, and worktree grouping under shared caps | done | low |
| T-0128 | Tests for idle lane reasons and red idle-with-ready flag | done | low |
| T-0129 | Tests for split quality metrics and red-amber-green grading | todo | low |
| T-0130 | Tests for multi-machine federation and version drift flags | ready | medium |
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
| T-0142 | Persist orchestrator handoff state to project memory and journal | ready | medium |
| T-0143 | Trigger orchestrator handoff from orchestrator hooks when context is over limit | todo | medium |
| T-0144 | Regression tests for orchestrator context handoff and resume | todo | low |
| T-0145 | Wire orchestrator handoff into swarm CLI and resume path | blocked | medium |
| T-0146 | Track post-merge deploys and start a 15-minute watch window | done | medium |
| T-0147 | Poll deploy health endpoints and production error logs during the watch | done | medium |
| T-0148 | Offer rollback guidance when deploy watch detects failure | running | high |
| T-0149 | Regression tests for post-merge deploy watch and rollback offer | todo | low |
| T-0150 | Wire deploy watch into swarm merge and ship flow | blocked | medium |
| T-0151 | Read per-project priority used for machine slot sharing | done | low |
| T-0152 | Apply project priority when granting machine-wide lane slots | ready | medium |
| T-0153 | Regression tests for priority-weighted machine slot sharing | todo | low |
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
| T-0207 | Replay tests for ticket manager scope gate and unblocker replan report | ready | medium |
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
| R-004 | tools/swarm.mjs is split into modules. | T-0021, T-0023, T-0026, T-0226 | missing |
| R-005 | The guard stops flagging harmless commands. | T-0030, T-0031, T-0032, T-0033, T-0034, T-0035 | done |
| R-006 | Ticket paths are validated against the repo. | T-0036, T-0037, T-0059, T-0060 | done |
| R-007 | Tickets are sized for their lane. | T-0038, T-0039, T-0059 | done |
| R-008 | A build ticket owns its own tests. | T-0040, T-0041, T-0042, T-0059 | done |
| R-009 | Acceptance lines are provable by the ticket itself. | T-0043, T-0044, T-0059 | done |
| R-010 | Risk tags are precise. | T-0045, T-0046, T-0059 | done |
| R-011 | The splitter sees existing tickets. | T-0047, T-0048, T-0059 | done |
| R-012 | Waves are simulated before ingest. | T-0049, T-0050, T-0059, T-0061 | done |
| R-013 | A blocked ticket is re-planned automatically. | T-0051, T-0052, T-0059, T-0202, T-0203, T-0205, T-0207 | partial |
| R-014 | Delete, rename and migration tickets work. | T-0053, T-0054, T-0055, T-0059, T-0062 | done |
| R-015 | Human tickets are a separate owner checklist. | T-0056, T-0057, T-0058, T-0059 | partial |
| R-016 | Releases ship as a train. | T-0063, T-0064, T-0065, T-0066, T-0067, T-0068 | partial |
| R-017 | One bad ticket can't hold a wave. | T-0069, T-0070, T-0071, T-0072, T-0073, T-0074 | partial |
| R-018 | Tests don't flake under load. | T-0075, T-0076, T-0077, T-0078, T-0079, T-0080 | partial |
| R-019 | Base checks are honest. | T-0081, T-0082, T-0083, T-0084, T-0085 | partial |
| R-020 | Reviews match risk and batch small work. | T-0086, T-0087, T-0088, T-0089, T-0090 | partial |
| R-021 | Verify runs without a model. | T-0091, T-0092, T-0093, T-0094, T-0095 | missing |
| R-022 | The machine limit tunes itself. | T-0096, T-0097, T-0098, T-0099, T-0100 | partial |
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

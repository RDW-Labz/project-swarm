# Build plan

Scope: Project Swarm roadmap (audit 2026-10-20) (version 1)
Progress: 52% done of 340 live tickets
Tickets: 352 total (proposed 0, todo 102, ready 26, running 0, review 16, done 178, blocked 18, cancelled 12)
Change orders: 1 (CO-001)

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
| T-0068 | Wire release train commands into swarm CLI entry | done | medium |
| T-0069 | Shared quarantine paths and wave failure metadata for ticket retries | done | low |
| T-0070 | Move failed ticket outputs into quarantine automatically after a wave failure | done | medium |
| T-0071 | Attach quarantined outputs as read-only context on the retry manifest | done | medium |
| T-0072 | Integrate passing wave tickets through merge queue while the failure is bisected out | done | high |
| T-0073 | Tests for quarantine moves, retry context, and partial-wave integration | done | low |
| T-0074 | Wire wave quarantine and salvage into scope loop orchestration | ready | high |
| T-0075 | Event-based synchronization helpers for load-timing checks instead of wall-clock sleeps | done | low |
| T-0076 | Artificial-load harness that stresses checks with five consecutive event-driven runs | done | medium |
| T-0077 | Quarantine flaky checks instead of silently retrying them to green | done | medium |
| T-0078 | Report quarantined flaky tests in run state and ship output | done | low |
| T-0079 | Tests for load-timing stability and flaky quarantine reporting | done | low |
| T-0080 | Wire event waits and flake quarantine into integrate check runner | ready | medium |
| T-0081 | Re-run cached red base checks and keep green base checks cached | done | medium |
| T-0082 | Per-checkout lock so only one base check runs per worktree at a time | ready | medium |
| T-0083 | Rich red-base failure records with check name, exit code, and tail output | done | low |
| T-0084 | Tests for honest base-check cache, lock, and failure reporting | todo | low |
| T-0085 | Wire honest base-check policy into swarm run base gate | blocked | medium |
| T-0086 | Choose review model tier from ticket risk and touched paths | done | medium |
| T-0087 | Batch small low-risk tickets into one shared review job | done | low |
| T-0088 | Apply the same review gate to manifest runs as ledger scope tickets | done | medium |
| T-0089 | Tests for review tier selection, batching, and manifest review parity | done | low |
| T-0090 | Wire risk-based review batching into scope sync review manifests | ready | medium |
| T-0091 | Run ticket tests locally with verify agent none and zero model tokens | done | low |
| T-0092 | Allow tested tickets on any lane after local verify passes | ready | medium |
| T-0093 | Parse verify.mode local in project profile and manifest builder | ready | low |
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
| T-0121 | Render the Split quality panel with green, amber and red metrics per project | ready | low |
| T-0122 | Show machine and swarm version on cards and flag version drift | done | low |
| T-0123 | Approve and Deny controls with confirm step on the board Needs you panel | done | high |
| T-0124 | Add Open chat link on each orchestrator card to its Remote Control session | done | medium |
| T-0125 | Tests for project progress percent, milestone, ETA and project page progress strip | done | low |
| T-0126 | Tests for production deploy tracking and not-tracked state | done | low |
| T-0127 | Tests for session pruning, money labels, and worktree grouping under shared caps | done | low |
| T-0128 | Tests for idle lane reasons and red idle-with-ready flag | done | low |
| T-0129 | Tests for split quality metrics and red-amber-green grading | todo | low |
| T-0130 | Tests for multi-machine federation and version drift flags | done | medium |
| T-0131 | Tests for tailnet owner actions, server-side refusal, and orchestrator chat links | ready | high |
| T-0132 | Mount progress UI on / board and /project pages | done | low |
| T-0133 | Wire deploy badge into the board overview page | done | low |
| T-0134 | Wire money labels and worktree grouping into the board overview | done | low |
| T-0135 | Wire idle reasons and red ready-ticket flag into the board Agents view | done | low |
| T-0136 | Mount Split quality panel on the project page | blocked | low |
| T-0137 | Wire machine badges and version drift into the federated board overview | done | medium |
| T-0138 | Mount owner Approve/Deny and orchestrator Open chat on the board | ready | high |
| T-0139 | Document S4 Swarm Watch visibility features and ui screen ids for rendered check | done | low |
| T-0140 | Register Mac mini board peer URL in the machine federation config on both hosts | todo | medium |

## S5 Operations

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0141 | Measure orchestrator transcript size against a configurable handoff threshold | done | medium |
| T-0142 | Persist orchestrator handoff state to project memory and journal | review | medium |
| T-0143 | Trigger orchestrator handoff from orchestrator hooks when context is over limit | todo | medium |
| T-0144 | Regression tests for orchestrator context handoff and resume | todo | low |
| T-0145 | Wire orchestrator handoff into swarm CLI and resume path | blocked | medium |
| T-0146 | Track post-merge deploys and start a 15-minute watch window | done | medium |
| T-0147 | Poll deploy health endpoints and production error logs during the watch | done | medium |
| T-0148 | Offer rollback guidance when deploy watch detects failure | ready | high |
| T-0149 | Regression tests for post-merge deploy watch and rollback offer | todo | low |
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
| T-0166 | Push scanned field exports between swarm machines | review | high |
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
| T-0227 | Define SQLite events table DDL and event row shape for the per-machine event store | review | medium |
| T-0228 | Import existing ndjson and markdown event files into the events table | todo | medium |
| T-0229 | Dual-publish new events to ndjson and the table until event_store is primary, flag off by default | todo | medium |
| T-0230 | Compute board open tickets, percent done and spend today from the event store | todo | medium |
| T-0231 | Mount event-store board numbers on the swarm board command in tools/swarm.mjs | todo | medium |
| T-0232 | Test event store schema, import, dual publish, board numbers and the swarm board route | todo | low |
| T-0233 | Write and resolve the repo pointer file that holds the project id for external state | done | medium |
| T-0234 | swarm migrate state copies legacy .swarm once and dual-writes runs until external_state is primary | review | high |
| T-0235 | Mount swarm migrate state on the swarm CLI entry in tools/swarm.mjs | todo | medium |
| T-0236 | Test pointer resolution, legacy copy once, dual write and the migrate state route | todo | low |
| T-0237 | swarm add /path/to/repo writes the pointer, registers the project and exits 0 with no swarm init | review | medium |
| T-0238 | Required doctor checks pass with stage-1 flags on and optional lane sections only warn | review | low |
| T-0239 | Mount swarm add and doctor checks on the swarm CLI entry in tools/swarm.mjs | todo | medium |
| T-0240 | Test swarm add, doctor required checks and the swarm add route | todo | low |
| T-0241 | swarm service install loads a user launchd agent and swarm service status reports running | done | medium |
| T-0242 | Service owns the event store and machine worker limit and clients reconnect within 5 seconds | todo | high |
| T-0243 | Mount swarm service install and status on the swarm CLI entry in tools/swarm.mjs | todo | medium |
| T-0244 | Test launchd install, status, service ownership and the service CLI route | todo | low |
| T-0245 | Allocate distinct TCP ports for each test job and report allocation failures | review | medium |
| T-0246 | Give each test or e2e job its own database name and temp directory before it starts | todo | medium |
| T-0247 | Mount per-job test environment and allocation checks on the swarm test path in tools/swarm.mjs | todo | medium |
| T-0248 | Test five parallel e2e isolation and doctor allocation reporting through the swarm test route | todo | low |
| T-0249 | Orchestrator setup prints the exact fine-grained PAT scopes before the owner creates the token | review | high |
| T-0250 | Build the main branch protection payload requiring PRs, blocking force push and deletion | review | high |
| T-0251 | Mount PAT scope display and branch protection on orchestrator setup in tools/swarm.mjs | todo | high |
| T-0252 | Test PAT scope list, protection payload and the orchestrator setup route | todo | low |
| T-0253 | Owner creates the branch-only PAT and applies branch protection on each active repo | todo | high |

## S8 Swarm v2 later stages

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0254 | Single chief orchestrator lock behind chief_orchestrator flag default off | done | high |
| T-0255 | Plan jobs across projects so ready tickets share one wave up to the machine cap | done | medium |
| T-0256 | Status view listing every active project and slot share for the chief | done | low |
| T-0257 | Mount chief lock and status on the swarm orchestrator CLI route | todo | medium |
| T-0258 | Tests for chief lock, cross-project wave planning, status and CLI route | review | medium |
| T-0259 | Issue distinct container grants per concurrent isolated job | review | high |
| T-0260 | Service-side permission check that denies git push for isolated jobs | review | high |
| T-0261 | Per-project isolated flag with legacy sandbox as the default | review | medium |
| T-0262 | Mount isolated sandbox modules on the swarm run CLI route | todo | high |
| T-0263 | Tests for container grants, git push denial, legacy mode and sandbox CLI route | todo | high |
| T-0264 | Cluster queue sync so an enqueue on either Mac shows on both within 3 seconds | review | medium |
| T-0265 | Single active lease per ticket across machines with leased elsewhere refusal | ready | high |
| T-0266 | Swarm Watch queue depth for the shared project matches across machines | done | low |
| T-0267 | Mount cluster queue and lease commands on the swarm queue CLI route | todo | medium |
| T-0268 | Tests for cluster queue sync, leases, shared depth and queue CLI route | todo | medium |
| T-0269 | Register cloud runners and return a lease to the local queue after 120 seconds without heartbeat | done | high |
| T-0270 | Route lane:burst tickets to a registered cloud runner and record completion | todo | high |
| T-0271 | Burst default off per project with zero cloud jobs when disabled | done | medium |
| T-0272 | Mount cloud burst runner and config on the swarm queue CLI route | todo | medium |
| T-0273 | Tests for cloud runner heartbeat, lane:burst routing, burst default and burst CLI route | todo | medium |
| T-0274 | Cloud CPU runner executes a ticket test command and e2e suite and records pass or fail with duration | todo | high |
| T-0275 | Scorecard for ready-to-merged time and idle slot percent before and after the CPU runner | todo | medium |
| T-0276 | Mount cloud CPU runner and scorecard on the swarm test CLI route | todo | medium |
| T-0277 | Tests for cloud CPU runner results, scorecard gate and CPU runner CLI route | todo | medium |
| T-0278 | Three GPU burst gate lines with measured values and PASS or FAIL | todo | medium |
| T-0279 | Refuse GPU rental when any gate fails and refuse sensitive tickets on the rented lane | review | high |
| T-0280 | Start the rented GPU worker on a long queue and shut it down after 10 idle minutes | review | high |
| T-0281 | Mount GPU burst status and start on the swarm burst gpu CLI route | todo | medium |
| T-0282 | Tests for GPU gates, gates not met refusal, auto scale and GPU burst CLI route | todo | medium |

## S9 Cluster (N devices, one ledger, autonomous node-to-node work)

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0283 | OpenAPI contract for cluster messages, node registry, leases and bench | ready | low |
| T-0284 | swarm join registers the node with tailnet auth, capabilities and live capacity | todo | high |
| T-0285 | Ticket leases with holder node id, fencing token, heartbeat and expiry in the ledger | todo | high |
| T-0286 | Durable on-disk outbox and inbox with acks, bounded retries, dedupe and catch-up | todo | medium |
| T-0287 | Signed typed message envelope with JSON Schema validation, size cap and secret scan | todo | high |
| T-0288 | Typed coordination events handled without LLM or orchestrator tokens | todo | medium |
| T-0289 | Owner-only action guard that drops and alerts on cluster messages implying approve, merge, deploy, caps, spend or keys | todo | high |
| T-0290 | Followers run swarm update between waves on release-shipped, never mid-wave | todo | medium |
| T-0291 | Repo-wide FIFO merge queue shared by all nodes for swarm merge | ready | high |
| T-0292 | Placement and work stealing by free slots, memory pressure, lane health and file ownership | todo | medium |
| T-0293 | swarm msg send, list and tail output with sender node id and sequence | todo | low |
| T-0294 | swarm bench cluster deterministic harness writing bench/cluster/<version>.json | ready | medium |
| T-0295 | CI gate comparing cluster bench to bench/cluster/baseline.json with chaos scenario checks | todo | medium |
| T-0296 | Third node join and leave cleanly without leaving leases on the departed node | todo | medium |
| T-0297 | Cutover checklist for disabling relayed hand-off after both nodes are healthy | ready | low |
| T-0298 | Mount cluster lease commands on the swarm CLI route | todo | medium |
| T-0299 | Mount coordination events on the swarm CLI route | todo | medium |
| T-0300 | Mount outbox delivery on the swarm CLI route | todo | medium |
| T-0301 | Mount swarm join and swarm node list on the swarm CLI route | todo | high |
| T-0302 | Mount signed message send and receive on the swarm CLI route | todo | high |
| T-0303 | Mount owner-only guard on the swarm CLI route | todo | high |
| T-0304 | Mount release-shipped update scheduling on the swarm CLI route | todo | medium |
| T-0305 | Mount repo-wide merge queue on swarm merge route | todo | high |
| T-0306 | Mount placement on the swarm CLI route | todo | medium |
| T-0307 | Mount swarm msg and node views on the swarm CLI route | todo | low |
| T-0308 | Mount swarm bench cluster on the swarm CLI route | todo | low |
| T-0309 | Mount bench gate in the CI entry route | todo | medium |
| T-0310 | Mount node churn handling on the swarm node route | todo | medium |

## S10 Swarm Watch Command Center (Hive overview, project cockpit, command palette, tools hub)

| Ticket | Title | Status | Risk |
| --- | --- | --- | --- |
| T-0311 | OpenAPI contract for Command Center data, views and hub endpoints | ready | low |
| T-0312 | Shared Command Center view-model types for Hive and Cockpit | todo | low |
| T-0313 | Shared data layer for Hive and Cockpit with accuracy unit test | todo | medium |
| T-0314 | Labelled number helper with source hover and omission of untrusted figures | todo | low |
| T-0315 | Mount shared Command Center data and labels on the /command-center route | todo | medium |
| T-0316 | Classic tab module listing existing Swarm Watch views without removing routes | ready | medium |
| T-0317 | Mount Classic tab and keep every pre-upgrade Swarm Watch path reachable | todo | medium |
| T-0318 | Hive top stat strip with projects, agents live, done today and needs you | todo | low |
| T-0319 | Hive brain entity with project nodes and category legend | todo | medium |
| T-0320 | Hive bottom panels for event log, lanes, savings and throughput chart | todo | medium |
| T-0321 | Mount Hive stats, layout and panels on the /command-center page | todo | medium |
| T-0322 | Canvas particle streams from project nodes into the brain | todo | medium |
| T-0323 | Start particle streams on the Hive page and sample frame rate | todo | medium |
| T-0324 | Original animated brain with breathing, pulses, flicker and reduced motion | todo | medium |
| T-0325 | Mount animated brain on the Hive page | todo | low |
| T-0326 | Project zoom transition, breadcrumb back and deep-link routing | todo | medium |
| T-0327 | Mount deep links for /command-center and /command-center/project/<id> | todo | medium |
| T-0328 | Cockpit orchestrator character, stage rings and ticket flow nodes | todo | medium |
| T-0329 | Mount Cockpit view on the project route | todo | medium |
| T-0330 | Searchable ticket lists matching swarm queue list ids | todo | low |
| T-0331 | Live run stream with progress, pace, ETA, PR refs and deploy status | todo | medium |
| T-0332 | Mount Cockpit lists and run stream on the project route | todo | low |
| T-0335 | PowerGlitch effect wrapper with duration, concurrency and reduced-motion limits | todo | medium |
| T-0337 | Command palette with fuzzy search across projects, tickets, runs, PRs, docs and commands | todo | medium |
| T-0339 | Skippable first-visit tour with Replay tour and Escape dismissal | todo | low |
| T-0341 | Resources hub index and entry JSON Schema with validated plugin entries | todo | medium |
| T-0342 | Mount Resources hub route on the watch server | todo | medium |
| T-0343 | Phone layout stylesheet for stacked Hive and tabbed Cockpit at 390 px | todo | low |
| T-0346 | Owner runs design self-review rounds and vendor licence entries for each CC stage | todo | low |
| T-0347 | Shared lane colour tokens and state mapping for agent robot heads | ready | low |
| T-0348 | Robot head component per lane and state for every agent avatar | todo | low |
| T-0349 | Kenney emote bubbles and Fluent animated badges layered on robot heads | todo | low |
| T-0350 | Snapshot test comparing robot head lane colour tokens to the All Projects baseline | todo | low |
| T-0351 | Mount real robot heads on every agent avatar in the Command Center route | todo | medium |
| T-0352 | Wire PowerGlitch effects into Command Center route with burst and concurrency limits | todo | medium |
| T-0353 | Mount command palette on Cmd-K and Ctrl-K in the Command Center route | todo | medium |
| T-0354 | Mount first-visit guided tour and Help menu Replay tour on the Command Center route | todo | low |
| T-0355 | Mount phone layout stylesheet and tabbed Cockpit on the Command Center route at 390 px | todo | medium |

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
| R-040 | The event store answers the board. | T-0227, T-0228, T-0229, T-0230, T-0231, T-0232 | partial |
| R-041 | Swarm state lives outside the repo. | T-0233, T-0234, T-0235, T-0236 | partial |
| R-042 | `swarm add` registers a project in one command. | T-0237, T-0238, T-0239, T-0240 | partial |
| R-043 | A per-machine swarm service runs under launchd. | T-0241, T-0242, T-0243, T-0244 | partial |
| R-044 | Concurrent jobs share no test data. | T-0245, T-0246, T-0247, T-0248 | partial |
| R-045 | Pushes are limited by the server. | T-0249, T-0250, T-0251, T-0252, T-0253 | partial |
| R-046 | One chief orchestrator plans across projects. | T-0254, T-0255, T-0256, T-0257, T-0258 | partial |
| R-047 | Jobs run in containers with permissions enforced by the service. | T-0259, T-0260, T-0261, T-0262, T-0263 | partial |
| R-048 | One queue and one board across machines. | T-0264, T-0265, T-0266, T-0267, T-0268 | partial |
| R-049 | Cloud runners take overflow work. | T-0269, T-0270, T-0271, T-0272, T-0273 | partial |
| R-050 | A rented GPU worker bursts only after the benchmark gates pass. | T-0278, T-0279, T-0280, T-0281, T-0282 | partial |
| R-051 | Cloud CPU runners run tests and end-to-end checks. | T-0274, T-0275, T-0276, T-0277 | missing |
| R-052 | One shared ledger with ticket leases replaces hand-off branches and ticket ID ranges. | T-0283, T-0285, T-0298 | missing |
| R-053 | Coordination events are typed swarm-to-swarm messages that use no model turns and no orchestrator tokens. | T-0283, T-0288, T-0299 | missing |
| R-054 | Reliable delivery uses acks, bounded retries with backoff, a durable outbox on disk, de-duplication, and catch-up after reconnect. | T-0283, T-0286, T-0300 | missing |
| R-055 | Any machine joins with `swarm join` using tailnet auth and registers in the node registry with capabilities and live capacity. | T-0283, T-0284, T-0301 | missing |
| R-056 | Typed signed messages use per-node keys, schema validation, and never carry executable content. | T-0283, T-0287, T-0302 | missing |
| R-057 | Autonomous node flows never perform owner-only actions. | T-0289, T-0303 | missing |
| R-058 | A release-ready event makes peer nodes run `swarm update` between waves, never mid-wave. | T-0290, T-0304 | missing |
| R-059 | One repo-wide merge queue across nodes merges PRs in one order through `swarm merge`. | T-0291, T-0305 | missing |
| R-060 | Placement and work stealing use real capacity across nodes. | T-0292, T-0306 | missing |
| R-061 | Messaging and nodes are visible on the CLI and board. | T-0293, T-0307 | missing |
| R-062 | Release benchmarks per version run against a fixed baseline stored under `bench/cluster/`. | T-0294, T-0308 | missing |
| R-063 | CI fails on benchmark regression past threshold and chaos tests pass. | T-0295, T-0309 | missing |
| R-064 | The MacBook and the Mac mini are the first two nodes; relayed hand-off flow is retired once both run on the ledger. | T-0297 | missing |
| R-065 | A third node joins and leaves without breaking leases, the queue, or the board. | T-0296, T-0310 | missing |
| R-066 | Command Center views read one shared data layer with real labelled numbers only. | T-0311, T-0312, T-0313, T-0314, T-0315 | missing |
| R-067 | Everything Swarm Watch has today stays. | T-0316, T-0317 | missing |
| R-068 | The Hive overview shows the swarm at a glance. | T-0311, T-0318, T-0319, T-0320, T-0321 | missing |
| R-069 | Particle streams flow from each project node into the core. | T-0322, T-0323 | missing |
| R-070 | The brain entity is an original animated centerpiece. | T-0324, T-0325 | missing |
| R-071 | Clicking a project zooms into the Project Cockpit with navigation back to the Hive. | T-0326, T-0327 | missing |
| R-072 | The Project Cockpit shows orchestrator, stages, and ticket flow. | T-0328, T-0329 | missing |
| R-073 | Cockpit sides and bottom expose lists and the live run stream. | T-0330, T-0331, T-0332 | missing |
| R-074 | Real robot heads are used everywhere an agent appears. | T-0347, T-0348, T-0349, T-0350, T-0351 | missing |
| R-075 | Signature glitch style uses PowerGlitch within strict limits. | T-0335, T-0352 | missing |
| R-076 | A command palette jumps to projects, tickets, runs, PRs, docs, and commands. | T-0337, T-0353 | missing |
| R-077 | A first-visit guided tour explains the Command Center. | T-0339, T-0354 | missing |
| R-078 | A Resources and Tools hub is searchable and plugin-extensible. | T-0341, T-0342 | missing |
| R-079 | The phone layout stacks the Hive and tabs the Cockpit without horizontal scroll. | T-0343, T-0355 | missing |
| R-080 | Performance, accessibility, and review gates pass for every Command Center stage. | T-0346 | missing |

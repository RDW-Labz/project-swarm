# Scope: Open adapters: any orchestrator, worker, model or tool
Version: 1

## Overview
The owner runs orchestrators and worker lanes beyond Claude Code, including opencode, Codex CLI, Cursor agent, Aider, Goose, OpenAI-compatible endpoints, and local or rented GPUs. The swarm core must not hard-code any one tool. One adapter interface and a plugin manifest let every orchestrator and lane plug in the same way. Built-in detection and agents become adapters too, so the board, guard, and queue read one shape of data. Opencode ships first as the proof because it already runs on parts-request-app and can reuse work on feat/external-orchestrators.

Out of scope: building a marketplace or remote adapter registry, running adapters from untrusted URLs automatically, any change to spend caps or how caps are raised.

## Stages
- S11: Open adapters

## S11 Open adapters
### R-081 One adapter interface covers orchestrator and worker kinds.
Acceptance:
- A published TypeScript or JSON schema defines orchestrator and worker adapter kinds with required methods and event shapes.
- A minimal reference adapter in tests implements both kinds and loads without core code changes.
- `swarm doctor` reports an adapter missing a required method with the schema field name.

### R-082 Orchestrator adapters report live session and spend data.
Acceptance:
- An orchestrator adapter lists active sessions with status, model id, token counts, and billed or list cost per session.
- Each session exposes an Open chat link when the tool provides one, or omits the field when it does not.
- Heartbeat updates session liveness at least every 60 seconds while the session runs; stale sessions drop off the board within 5 minutes.

### R-083 Worker and lane adapters run tickets and report lane health.
Acceptance:
- A worker adapter accepts a ticket job, returns pass or fail with logs, and reports tokens and cost for that run.
- The adapter exposes health (up, rate limited, or error) and free slot count for routing.
- A harness ticket run through a stub worker adapter writes completion to the event store with matching token and cost fields.

### R-084 Each adapter installs from a folder and manifest under the user config.
Acceptance:
- A valid install path is `~/.project-swarm/adapters/<name>/adapter.json` plus a small JS module the host loads.
- `adapter.json` names kind (orchestrator or worker), version, entry module, and declared permissions (see security requirements).
- `swarm adapter add` copies or links a folder into that path and validates the manifest against schema; invalid manifests exit non-zero.

### R-085 swarm adapter add, list, remove, and test manage the adapter set.
Acceptance:
- `swarm adapter list` prints every installed adapter with kind, version, and last test result.
- `swarm adapter remove <name>` uninstalls the folder and unregisters it from the host within one command.
- `swarm adapter test <name>` runs the contract suite for that adapter and exits non-zero on failure.

### R-086 Built-in orchestrators and lanes ship as adapters with no core special cases.
Acceptance:
- Claude Code, Cursor agent, Codex CLI, and default lane runners load from the same adapter host API as third-party plugins.
- A grep of core board and queue code finds no imports keyed only to a single vendor tool name (allowed: generic adapter id strings).
- Disabling a built-in adapter by remove plus list shows it absent; enabling uses the same add path as external adapters.

### R-087 Generic registration exposes unknown tools without custom adapter code.
Acceptance:
- `swarm orchestrator register --tool NAME --model MODEL` with heartbeat makes NAME appear in `swarm orchestrator list` before a full adapter exists.
- `swarm lane add --openai-compatible URL` registers a lane that accepts standard chat completions against URL and shows in `swarm lane list`.
- Board and spend views show the registered orchestrator and lane with model and URL labels from registration records.

### R-088 The opencode orchestrator adapter reuses external-orchestrators session reading.
Acceptance:
- The opencode adapter uses the session reader and register or heartbeat flow already built under feat/external-orchestrators without duplicating protocol logic.
- With opencode running on parts-request-app, `swarm adapter test opencode` exits 0 and board shows the live session.
- Replacing the reader module in tests with a fixture still passes contract tests.

### R-089 The board renders only from adapter and registration data.
Acceptance:
- Orchestrator cards, robot heads, lane colours, and Open chat links resolve from adapter records, not hard-coded tool tables.
- Adding a new adapter via add or register makes a new card appear on Swarm Watch without editing board UI source.
- Board accuracy tests compare displayed session count and lane colours to `swarm adapter list` and orchestrator list output within one session.

### R-090 An orchestrator-agnostic guard applies the same rules everywhere.
Acceptance:
- Git hooks and swarm-side command checks call one shared guard entry point with orchestrator id and command text.
- Opencode and Codex CLI hook configs document the same entry point Claude Code uses; a test invokes it for each id with a blocked command and gets exit non-zero.
- Harmless patterns from roadmap R-005 stay allowed when the orchestrator id is not Claude.

### R-091 AGENTS.md defines orchestrator safety for non-Claude tools.
Acceptance:
- Each active project AGENTS.md includes an orchestrator section listing merge, deploy, cap, and approval rules independent of vendor.
- `swarm doctor` warns when AGENTS.md lacks the orchestrator section on a project with a non-default orchestrator adapter.
- A template documents the section for opencode and Codex CLI setups.

### R-092 SECURITY: The host enforces each adapter's declared permission list.
Acceptance:
- `adapter.json` lists allowed network hosts, file path prefixes, and command prefixes; the host denies actions outside the list before the adapter runs.
- A contract test adapter that requests a disallowed host or path fails closed with exit non-zero and a permission error in the log.
- Permission changes require reinstall or manifest edit plus `swarm adapter test` before the adapter is marked active.

### R-093 SECURITY: Secrets use Keychain references only.
Acceptance:
- Manifests and adapter logs never contain raw API keys or tokens; only Keychain reference ids appear in config.
- A secret scan test on sample adapter output and `adapter.json` files in CI exits non-zero if a key pattern matches.
- Adapters receive resolved secrets through a host API that does not echo values to stdout.

### R-094 SECURITY: Adapters cannot perform owner-only or cap-breaking actions.
Acceptance:
- An adapter process or module cannot call approve, merge, deploy, spend past the daily cap, or raise a cap; host API returns exit non-zero for these entry points when caller is an adapter.
- A harness simulating adapter-initiated merge and cap raise leaves ledger and deploy state unchanged.
- Owner-only CLI commands remain available only to the owner session, not to adapter credentials.

### R-095 SECURITY: Sensitive projects block third-party code egress unless allowed.
Acceptance:
- A project marked sensitive refuses worker adapters whose manifest declares third-party network hosts unless the owner adds an allow rule for that adapter on that project.
- A sensitive ticket routed to a blocked adapter exits non-zero with message naming the adapter and project id.
- `swarm doctor` lists sensitive projects and which adapters are explicitly allowed.

### R-096 SECURITY: Every adapter call is logged.
Acceptance:
- Each adapter invocation appends an event with adapter name, action, timestamp, and success or failure; no secret values in the payload.
- `swarm events tail --adapter` shows the same rows as the event store query for the last 100 calls in tests.
- Failed permission denials from R-092 appear in the log with reason code.

### R-097 A fifteen-minute adapter guide ships with three worked examples.
Acceptance:
- `docs/adapters/write-an-adapter.md` walks through opencode orchestrator, Codex CLI orchestrator, and an OpenAI-compatible worker lane with copy-paste manifests and test commands.
- Each example ends with `swarm adapter test <name>` exiting 0 on a clean machine with fixtures documented in the guide.
- The guide states security fields from R-092 through R-096 in plain language.

### R-098 Built-in adapters have tests and one shared contract suite.
Acceptance:
- Every built-in adapter has a dedicated test file that mocks its tool and asserts session or run output shape.
- One contract test module defines required behaviors for orchestrator and worker kinds; all built-in adapters import it.
- `swarm adapter test <name>` runs built-in or third-party adapters through the same contract module and exits non-zero on any failed assertion.

### R-099 Opencode adapter ships first as the production proof.
Acceptance:
- Opencode orchestrator adapter merges before other third-party orchestrator adapters are enabled by default.
- parts-request-app orchestrator session appears on the board via the opencode adapter with chat link and heartbeat during an owner smoke run documented in the PR.
- No other third-party orchestrator adapter is marked default-on until opencode contract and security tests pass in CI.

## Build order
R-081, R-084, R-085, R-082, R-083, R-086, R-087, R-088, R-090, R-091, R-092, R-093, R-094, R-095, R-096, R-098, R-089, R-099, R-097

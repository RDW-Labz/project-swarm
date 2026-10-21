# Manager replay fixtures (`evals/managers`)

Small, scrubbed snapshots for the Phase 19 manager replay harness. They are recorded ledgers and journals only. No app code, secrets, or customer data belong here.

## What gets copied

Each fixture is a throwaway project folder the harness loads:

- ticket ledger and run states
- journal
- lane store snapshot
- spend ledger

Sources are real runs (parts-app S11, S12, S13; swarm-practice) plus invented **seeded failure** trees that break exactly one manager’s job.

Before commit, scrub API keys, tokens, inbox content, customer names, and anything that is not needed for the manager under test. Keep fixtures as small as the replay still needs.

## Running a replay

```text
swarm managers replay LEDGER_DIR MANAGER
```

The command copies `LEDGER_DIR` into a temp tree, steps through events in historical order, and records what the manager said and would do at each step. Replay runs are deterministic and cost $0.

`MANAGER` is one of: `budget`, `lane-health`, `version`, `ticket`, `unblocker`, `merge-queue`, `lessons`, `visual-qa`.

Scorecards from replays go to `docs/state/manager-scorecards/` (caught, time-to-fix, wrong actions, missed, cost).

## Layout (by convention)

Use one top-level directory per scenario. Name it so the manager and source are obvious, for example:

- `parts-s13-ticket-scope/` — Ticket Manager replay (pre–Ticket Manager S13 split)
- `parts-s11-budget-cap/`, `parts-s12-budget-cap/` — Budget manager cap warnings
- `parts-s13-lane-health/` — Lane health before wave 1 (Codex/Cursor never ran)
- `parts-137-vs-140-version/` — Version lag and stale remote board
- `parts-s12-merge-queue/` — Merge queue events
- `swarm-practice/` — extra cross-project replay data

Under each scenario, mirror what production writes (ledger paths the harness expects). Seeded-failure fixtures sit beside historical replays; they are written to trigger one failure class each.

## Fixtures per manager

### Budget (`budget`)

- **Replay:** S11 and S12 (each finished about $6 over cap before the hard-cap fix). The manager must warn before the cap is hit.
- **Seeded:** wave worst case over project cap; Opus review re-asked four times on one ticket; forecast far under actual spend (estimates bug class).

### Lane health (`lane-health`)

- **Replay:** S13 — Codex and Cursor never ran; must be caught before wave 1 with a clear reason.
- **Seeded:** Codex sandbox cannot start; Cursor key missing; Haiku 429 storm; Claude lane with no model (S13 start).

### Version (`version`)

- **Replay:** parts-app 1.137.0 vs 1.140.0 lag; 404 Watch link from an old remote board.
- **Seeded:** pointer two versions behind; remote on old snapshot; update requested mid-run; broken pointer profile.

### Ticket Manager (`ticket`)

Runs at scope time. Replay must match the problems the orchestrator fixed by hand on the S13 split.

- **Seeded:** 25 tickets listing test files owned by later tickets; files with no owner; CamelCase screen names; 34-ticket chain behind three tickets.

### Unblocker (`unblocker`)

Runs after every wave. Diagnosis must come from ledger and journal alone.

- **Replay / seeded (S13):** T-0323 (gates 11; retry note read as paths), T-0277 (missing DB context), T-0286 (gates 4; escalation planning failure), T-0311 (missing DB context). Each fixture should expect the same fix the orchestrator applied live.

### Merge queue (`merge-queue`)

- **Replay:** S12 merge-queue events.
- **Seeded:** flaky test (fails ~1 in 5); two tickets editing the same file; planted red batch.

### Lessons keeper (`lessons`)

- **Replay:** lessons already written from S11–S13, reproduced from raw failures only.
- **Seeded:** same missing-context failure on three tickets; same lane failing the same way twice.

### Visual QA (`visual-qa`)

- **Replay:** parts-app staff request page redesign screenshots.
- **Seeded:** layout overflow at 375px; contrast failure; changed screen no ticket claimed.

## Gate before `auto`

An action moves to `auto` only when replays and at least one live shadow run show 100% caught on the seeded set, zero wrong actions, and the owner approves that action. One action at a time.

## Ticket

Documented for **T-0185** (scrubbed manager replay fixtures). Requirements **R-036**–**R-039** map to the eight managers above.

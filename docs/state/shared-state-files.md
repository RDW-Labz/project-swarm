# Shared state files inventory (goal g-8b0f02fa)

Every file this project writes that more than one process could plausibly write concurrently (a shared singleton, not a per-run-id file only its own run ever touches), who writes it, and how. This is the inventory step - no code changed yet. A lock/atomic-write proposal follows at the bottom, for review before any edit.

**Out of scope for this goal's code changes** (owned elsewhere this round, listed here for completeness only):
- `tools/backlog.mjs` (backlog.json / goal queue) - the backlog-lock goal (g-08a347e1) owns this, running on the MacBook now.
- `tools/lane-health.mjs` (lane-health state/events) - the MacBook keeps this one ("the lane-health save race").
- Token files and the guard-chain files (`tools/shell-writes.mjs`, `tools/handbuild.mjs`, `tools/orchestrator-allow.mjs`, `tools/worker-token.mjs`, `tools/swarm/core-41.mjs`, `tools/cli-adapters.mjs`) - the MacBook's guard-chain release this round; not touched or proposed on here.

## 1. Ticket ledger - `.swarm/project/tickets.json`

- **Writer**: `tools/tickets.mjs` - `writeLedger(root, ledger)`.
- **Write style**: atomic (temp file + `fs.rename`), 0o600, via `safeWritableDir`/`assertRegularOrMissing`.
- **Lock**: **none**. No version/revision field in the stored shape either.
- **Risk**: a real lost-update race - two concurrent callers (e.g. a `swarm tickets --set` from a terminal racing an in-flight `autopilot`/`go --scope` ticket-status update) can both read the same ledger, each compute a different mutation, and the second `rename` silently discards the first caller's change. The individual write itself never corrupts the file (atomic rename), but the LOST UPDATE is real.
- **Companion**: `.swarm/project/tickets.log` - append-only event log via `appendLog(root, event)`, `O_APPEND`+`O_CREAT`, no lock needed in practice (append-mode small writes are effectively atomic at the OS level).
- **Existing backup**: `tools/ledger-backup.mjs` already runs after every `writeLedger` call (`ledgerBackupAfterWrite`) - a rotating backup already exists for this file specifically (worth checking its retention count against the backlog lock's "last 10" convention for consistency, not re-implementing it).

## 2. Run state / records - `.swarm/runs/<runId>/state.json` and `.swarm/runs/<runId>/<jobId>/*`

- **Writer**: `tools/swarm/core-31.mjs` - the generic `jsonWrite`/`write` helpers (atomic temp+rename, no lock).
- **Risk, narrowed**: each run has its own `runId`-named directory, and in the normal case exactly ONE process (the orchestrator that started the run) owns writing to it over its lifetime - this is NOT the same multi-independent-writer race as the ledger/backlog/board files above. The practical risk here is narrower: a `swarm integrate`/`swarm inspect`/`swarm wait` reading `state.json` mid-write could, in principle, read a half-written file if `fs.rename` were not atomic - but `fs.rename` on the same filesystem IS atomic, so a reader always sees either the fully-old or fully-new content, never a half-written one. **Assessment: lower priority than ledger/backlog/board** - no proposed change here unless a CONCRETE two-writer scenario surfaces (e.g. a lead job and a child job both writing the same run's state, which needs its own look before deciding).

## 3. Board state - `~/.project-swarm/board.json` (or `$SWARM_BOARD_FILE`)

- **Writer**: `tools/watch-cli.mjs` - `writeBoardFile(url, opts)`.
- **Write style**: atomic (temp with `wx` flag + `fs.rename`), 0o600.
- **Lock**: **none**.
- **Risk**: this file records which single board-server process currently owns the shared URL/token/port. Two `swarm watch` (or equivalent board-starting) invocations racing to start a board at the same time could overwrite each other's identity record, leaving a reader (`readBoardFile`) pointed at a board process that already exited, or vice versa. Lower call-frequency than tickets/backlog (board starts are relatively rare, usually one long-lived process), but a real race nonetheless.

## 4. Goal queue / backlog - `.swarm/project/backlog.json`

- Owned by g-08a347e1 this round (see "out of scope" above). Already gets a lock, version counter, drop-guard, and rotating backup per that goal's design - not duplicated here.

## 5. Token files

- Owned by the guard-chain release this round (see "out of scope" above). Not inventoried in further detail here since those files are off-limits to read/propose against this round per the owner's instruction.

## 6. Usage ledger - `docs/state/usage-ledger.md`

- **Writer**: lives in `tools/swarm/core-41.mjs` (confirmed via `grep -rln "usage-ledger.md" tools/*.mjs`) - **this file is in the guard-chain exclusion list for this round**, so its write mechanism is not inspected further here and no change is proposed against it. Flagging only that it exists and where its writer lives, for whoever eventually does take this one up.

## 7. Backups

- `tools/ledger-backup.mjs` - the ticket ledger's own rotating backup (see item 1). Already exists, already runs on every `writeLedger`.
- The backlog lock (g-08a347e1) is adding its own separate rotating backup (last 10) for `backlog.json`.
- No other shared-state file in this inventory currently has a backup mechanism (board.json, run state do not).

## 8. Spend logs - `~/.project-swarm/logs/anthropic-spend.jsonl` and `openrouter-spend.jsonl`

- **Writer**: `tools/anthropic.mjs` / `tools/openrouter.mjs` - `appendLedger(file, row)`, plain `fs.appendFileSync`, no explicit lock.
- **Risk**: append-only, one JSON line per call. POSIX `O_APPEND` writes are atomic for writes under the pipe buffer size (a single spend-log JSON line is always well under that), so concurrent appends from multiple processes do not corrupt each other or interleave mid-line in practice on this platform. **Assessment: lowest priority of the eight** - the risk here is not corruption or lost updates, it's that nothing currently reads these files under a lock either (two concurrent `spentSoFar()` cap-checks could both read the same "spent so far" total and both approve a request that together exceed the cap - a TOCTOU window on the cap check itself, not the log file). Worth a narrow fix (check-then-append under a lock) if this goal's scope wants to close that TOCTOU window specifically, separate from the log-file-corruption concern which doesn't really exist here.

## Summary table

| # | file | writer | write style | lock today | priority |
| --- | --- | --- | --- | --- | --- |
| 1 | tickets.json | tools/tickets.mjs | atomic (temp+rename) | none | **high** - real lost-update race |
| 1b | tickets.log | tools/tickets.mjs | append | n/a (append-safe) | low |
| 2 | runs/*/state.json | tools/swarm/core-31.mjs | atomic (temp+rename) | none | low - single-writer-in-practice |
| 3 | board.json | tools/watch-cli.mjs | atomic (temp+rename) | none | **medium** - rare but real race |
| 4 | backlog.json | tools/backlog.mjs | (being fixed under g-08a347e1) | — | owned elsewhere |
| 5 | token files | guard-chain files | — | — | owned elsewhere (MacBook) |
| 6 | usage-ledger.md | tools/swarm/core-41.mjs | — | — | owned elsewhere (MacBook, guard-chain exclusion) |
| 7 | ledger backups | tools/ledger-backup.mjs | n/a | n/a | already exists |
| 8 | spend logs (anthropic/openrouter) | tools/anthropic.mjs, tools/openrouter.mjs | append | none (append-safe for corruption; cap-check TOCTOU separately) | low-medium (narrow TOCTOU, not corruption) |

## Proposed lock/atomic-write plan (for review before any edit)

In priority order, scoped to only the files NOT owned elsewhere this round:

1. **tickets.json** (highest priority - real lost-update race, same shape as the backlog-lock problem): wrap `writeLedger` in `acquireAutopilotLock(root, { name: 'tickets' })` using the exact same reusable pattern as `tools/ledger-lease.mjs`/the backlog lock, read-modify-write under the lock. Add a `version`/revision counter to the stored ledger shape the same way the backlog lock is adding one, with a stale-write refusal. This is the most direct parallel to g-08a347e1's design and should reuse its reviewed pattern once that lands, rather than designing a second version in parallel.
2. **board.json**: wrap `writeBoardFile` in `acquireAutopilotLock(root-equivalent-or-a-fixed-machine-wide-name, { name: 'board' })` - board.json is machine-home-scoped, not project-root-scoped, so this needs a small adaptation of `acquireAutopilotLock`'s root-relative lock-file path (or a separate, smaller lock helper under `~/.project-swarm/`) - flagging this as a design question rather than assuming it fits the existing project-root-scoped helper unchanged.
3. **Spend-log cap-check TOCTOU**: a narrower fix - wrap the read-then-append-then-check sequence in `tools/anthropic.mjs`/`tools/openrouter.mjs`'s cap-enforcement path in a lock scoped to the spend log itself (e.g. `name: 'anthropic-spend'`), so two concurrent requests can't both pass the same cap check. This does not require touching the log's append format, only the surrounding cap-check call site.
4. **Run state (`runs/*/state.json`)**: no change proposed - assessed as single-writer-in-practice (see item 2's write-up above). Will revisit if a concrete two-writer scenario is found.

Opus review requested on items 1-3 before any of them is implemented, per the owner's instruction for lock changes. Waiting for a go-ahead on this plan before starting code.

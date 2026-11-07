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

## Users of `acquireAutopilotLock` and which of the 4 gaps hit them

The MacBook's Opus review of the backlog lock found `tools/autopilot-lock.mjs`'s `acquireAutopilotLock` itself is not a safe lock, independent of any caller: (1) creates the lock file with `O_EXCL` then writes the owner AFTER - a reader in that window sees an empty file, treats it as dead, deletes it; (2) a second caller in the SAME process sees `owner.pid === its own pid` and is let through without actually serializing against the first call (verified by reading the function: when `owner.pid === pid`, the code falls through past the throw and into the "dead owner, clear it" branch, deleting the first call's lock); (3) no wait or retry - fails fast rather than backing off and retrying; (4) stale-lock clearing is unconditional `rm` then re-`create`, with no compare-before-delete, so two concurrent cleaners can each delete and each recreate, both believing they hold the lock. I verified all four directly against the current `tools/autopilot-lock.mjs` source, not just taking the review's word for it.

Since every caller shares this one implementation, gaps 1/3/4 (cross-process races and no backoff) apply identically to all of them. Gap 2 (same-process, same lock `name`, concurrent calls) only bites a caller whose own call sites can plausibly run concurrently within one process for the same name:

| user | lock name | call sites | gap 2 (same-process concurrent calls) exposure |
| --- | --- | --- | --- |
| `tools/ledger-lease.mjs` | `leases` | `claim`, `renew`, `release`, `sweepExpiredLeases` (4 call sites, all same name) | **Real exposure** - claims for different tickets dispatched concurrently (e.g. via `Promise.all`) all take the same `leases` lock name in one process; gap 2 means they do not actually serialize against each other. |
| `tools/burst-lease.mjs` | `burst-runners` | `registerRunner`, `recordHeartbeat`, `sweepStaleHeartbeats` (3 call sites, all same name) | **Plausible exposure** - a heartbeat timer firing while another burst-lease call is in flight in the same process would hit gap 2. |
| `tools/ledger-merge.mjs` | `autopilot` (default) | `mergeTicketLedgers`'s single call site | **Low** - this is normally a one-shot CLI invocation, not called concurrently with itself within one process in the current codebase. Still exposed to gaps 1/3/4 from a concurrent `autopilot` process on the same machine. |
| `tools/swarm.mjs` (`go --scope`) | `scope-loop`, then `autopilot` | one call site, acquiring both names in sequence at start | **Low** for gap 2 (acquired once per process start). Gaps 1/3/4 apply fully - e.g. the orphan-scope-loop-guard added in PR #394 reads this same lock file via `readLockOwner`; gap 1's "empty file mid-write" window would make `readLockOwner` see a malformed/empty file, which it already treats as `null` (fails safe - conservatively NOT flagged as orphaned), so that specific consumer doesn't get WORSE from this bug, but it is still reading an unreliable primitive. |
| `tools/swarm.mjs` (`autopilot` command) | `autopilot` (default) | one call site, the autopilot daemon's own self-lock | **Low** for gap 2 (one call per daemon start). Gaps 1/3/4 apply the same as any other process-level lock acquisition. |

Per the MacBook's direction: not building a separate `tools/file-lock.mjs` for board.json - will use the MacBook's `tools/file-lock.mjs` once it lands and is confirmed merged, and the tickets.json plan will use it too (not stack a second lock beside `withLock`/`lockedUpdate`). Holding all code changes in this goal until then; this section is read-only investigation.

## Writers of `tickets.json` / `tickets.log`, and lock status

Per-writer-function table, built by tracing every `writeLedger(root, ...)` call site back to its enclosing exported function and checking whether that function's own body calls `lockedUpdate(root, ...)` or `withLock(root, ...)` (both defined in `tools/scope-commands.mjs`, a simple create-exclusive `scope-go.lock` file, separate from `acquireAutopilotLock`) before writing.

**tools/scope-commands.mjs** (its own `withLock`/`lockedUpdate`, `scope-go.lock`):

| function | locked? |
| --- | --- |
| `cmdGate`, `applyInfraReturn`, `applyForeignBlock`, `applyRetry`, `applyEscalation`, `setTicketField`, `markReviewBlocked`, `cmdSecurityReview`, `cmdAcceptanceReview`, `markDepsCommand`, `editTicketFiles`, `setTicketRoute`, `setTicketCheckTimeout`, `releaseTickets`, `ownerNoteCommand`, `retryNoteCommand`, `reopenTicket`, `setTicketStatus`, `prepareScopeRun`, `unlockLedger`, `addProposedTicket`, `approveProposed` | **yes** - each calls `lockedUpdate(root, ...)` or `withLock(root, ...)` around its `writeLedger` call |
| `runSplitIngest` | **no** - writes at lines 2264/2278 with no enclosing lock call found |
| `cmdApprove` | **no** - write at line 2461 |
| `cmdSync` | **no** - write at line 3278 |
| `cmdChange` | **no** - write at line 3883 |
| `addCiFixTicketLocked` | **no** lock call found in its own body (write at line 4084) - the name suggests its caller is expected to already hold the lock; worth confirming with whoever wrote it rather than assuming it's a live bug |

**tools/tickets.mjs** (the module `writeLedger`/`appendLog` themselves live in): `applyDelivered` (line 441) and one other ledger-mutating export (line 475) call `writeLedger` directly with **no lock at all** - this module does not import `scope-commands.mjs`'s lock or `acquireAutopilotLock`.

**tools/ticket-replan.mjs**: `persistReplans` (line 247) calls `writeLedger` directly, **no lock**.

**tools/watch-cli.mjs**: the board's "approve from board" handler (line 589) calls `writeLedger` directly, **no lock** - this is the owner's board-click path, a real concurrent-writer candidate (a board approve click racing an autopilot ledger write).

**tools/ledger-lease.mjs**: `claim`/`renew`/`release` (3 call sites) call `writeLedger` while already holding `acquireAutopilotLock(root, {name:'leases'})` - locked, but inherits all 4 `acquireAutopilotLock` gaps above.

**tools/ledger-merge.mjs** (the "mini ledger-merge"): `mergeTicketLedgers` writes via `applyMergedOutputs` while holding `acquireAutopilotLock(root, lockOptions)` - locked, same gaps.

**tools/swarm.mjs**: one `writeLedger` call (the `scale` test-fixture command) explicitly uses `withSharedWriteLock(root, 'tickets.json', ...)` - a THIRD, independent lock implementation (`tools/integration-lock.mjs`), not `scope-commands.mjs`'s `withLock` or `acquireAutopilotLock`. Have not yet verified this third implementation's own safety properties given the acquireAutopilotLock findings above - flagging as a follow-up check, not yet done.

**Summary**: tickets.json has at minimum THREE independent, mutually-unaware locking mechanisms in play (`scope-commands.mjs`'s own file lock, `acquireAutopilotLock`, and `integration-lock.mjs`'s `withSharedWriteLock`), plus multiple writer paths (`tools/tickets.mjs`, `tools/ticket-replan.mjs`, `tools/watch-cli.mjs`) that bypass all of them entirely. The MacBook's framing is confirmed: "the race may only be the callers that bypass it" - five named functions in `scope-commands.mjs` plus the three in `tools/tickets.mjs`/`ticket-replan.mjs`/`watch-cli.mjs` are the real gap, not a fundamentally unlocked file.

## Proposed lock/atomic-write plan (for review before any edit)

**Superseded in part**: the original plan below assumed `acquireAutopilotLock` was a safe, reusable primitive. The MacBook's Opus review of the backlog lock found it is not (see "Users of `acquireAutopilotLock`" above) and is building a new `tools/file-lock.mjs` to replace it everywhere. Per that direction: **holding all code for this goal** until `tools/file-lock.mjs` lands and is confirmed merged - not building a separate lock helper for board.json, and the tickets.json fix will use `tools/file-lock.mjs` (not stacked beside `scope-commands.mjs`'s own `withLock`/`lockedUpdate` - the fix needs to close the five unlocked `scope-commands.mjs` functions plus the three unlocked writers in `tools/tickets.mjs`/`ticket-replan.mjs`/`watch-cli.mjs`, not add a second, parallel lock next to the one `scope-commands.mjs` already has).

In priority order, scoped to only the files NOT owned elsewhere this round, to start once `tools/file-lock.mjs` is available:

1. **tickets.json** (highest priority - confirmed real lost-update race via the writer table above: `runSplitIngest`, `cmdApprove`, `cmdSync`, `cmdChange` in `scope-commands.mjs`, plus `tools/tickets.mjs`'s `applyDelivered`, `tools/ticket-replan.mjs`'s `persistReplans`, and `tools/watch-cli.mjs`'s board-approve handler all write with no lock at all): migrate every `writeLedger` call site - both the already-`scope-commands.mjs`-locked ones (onto `file-lock.mjs` instead of the bespoke `scope-go.lock`) and the unlocked ones - onto `tools/file-lock.mjs`, one lock covering the whole file, not two mechanisms side by side. Add a version/revision counter to the stored ledger shape with a stale-write refusal, same shape as the backlog lock.
2. **board.json**: lock `writeBoardFile` with `tools/file-lock.mjs` once it lands (not a separate helper).
3. ~~Spend-log cap-check TOCTOU~~ - **not this goal's scope**: folded into g-eb01221a (the single spend-number goal) per the owner's direction; not touching spend code here.
4. **Run state (`runs/*/state.json`)**: no change proposed - assessed as single-writer-in-practice (see item 2's write-up above). Will revisit if a concrete two-writer scenario is found.

Opus review requested on every lock change before merge, per the owner's instruction. Reading/investigating only until `tools/file-lock.mjs` is confirmed merged.

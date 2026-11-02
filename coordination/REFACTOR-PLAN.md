# Project Swarm refactor plan (draft, 2026-10-28)

Status: **plan only, nothing built.** Starts after release train 2 ships (owner, 2026-10-28).

## Owner decisions (2026-10-28)

1. Money day boundary: **Chicago everywhere**.
2. **Delete** `review-tier.mjs`, `review-batch.mjs`, `manifest-review-gate.mjs` (unused in production; git keeps them) — in Phase 4.
3. `--reopen` and `--release` become **legal owner moves** in `HUMAN_MOVES` — in Phase 4.
4. A done ticket is **never** a file's owner — one rule in Phase 4.
5. Train 2 (before the refactor) fixes B1, B2, B3 (first), B13, B16, B17 and adds **one spend cap: $5/day total across both Macs, Chicago day**; Opus security review on that train.
6. **Phase 2 (locking) goes first.** It does not need the new paths module: it reuses today's `safeWritableDir` / `assertRegularOrMissing` (`journal.mjs:99,122`) and `safePath` (`core-21.mjs:58`) unchanged; Phase 1 later swaps their internals behind the same names. New order: 2 → 1 → (3 ∥ 4) → (5 ∥ 6).
Surveyed read-only on the train 1 tree (`swarm/rel-1-167-23`). File:line citations are from that tree and will drift.

## Goals

1. One module each for: **state and locking**, **money**, **paths**, **ticket rules**.
2. Break up `tools/scope-commands.mjs` (4,234 lines) and `tools/swarm/core-NN.mjs` (15 files, numbered by an old mechanical split) by responsibility.
3. Behavior stays the same except where this plan names a bug fix. Every bug fix is its own small change with its own test, never hidden inside a move.

## Ground rules for every step

- **Tests first.** Each phase starts with characterization tests that pin today's behavior, plus table tests that run every old copy against the same inputs. They must be green before code moves.
- **Moves and fixes are separate PRs.** A "move" PR changes no behavior: same tests pass unchanged. A "fix" PR changes behavior and adds the regression test.
- **Keep import paths alive.** Each moved export stays re-exported from its old file until the last caller and test switch (`tools/swarm.mjs` re-exports, `scope-commands.mjs` as a barrel, thin shims for `tools/swarm/core-NN.mjs`). 125 test files import `tools/swarm.mjs`, about 50 import `scope-commands.mjs`, 24 import core-NN files directly.
- **Source-text tests.** `tests/policy-hardening-round4.test.mjs:156` and `tests/bare-status.test.mjs:67` regex-match source text through `tests/helpers/swarm-source.mjs`. Moving that text is fine; reformatting or duplicating it breaks them. `tests/split-module.test.mjs:578` needs `tools/swarm.mjs` to keep its `export { X } from` style.
- **Swarm-built.** Jobs on Cursor/Codex as usual. Jobs that write `tools/swarm.mjs` or `scope-commands.mjs` need `ignoreTestsReason` (the 100-entry ignoreTests cap, `core-31.mjs:386`) and run the affected tests as checks; the full suite runs once per release train.
- **Reviews.** Money, process-kill, locking and guard changes get their own Opus review (owner rule). Pure moves are covered by the train's combined Opus review.
- **Order matters.** Paths and state first (everything else uses them), then money and ticket rules, then the file breakups, which become mostly mechanical once the shared modules exist.

## Bugs found during the survey (fix before or alongside, each its own ticket)

These surfaced while mapping duplicates. They are real today, independent of the refactor.

| # | Area | Problem | Where | Severity |
|---|---|---|---|---|
| B1 | money | Anthropic day cap is **$20** in spend.mjs and **$25** in the adapter | `spend.mjs:22`, `anthropic.mjs:22` | high (money) |
| B2 | money | Haiku price differs **10×** between the two price tables | `anthropic.mjs:26-32` vs `rates.mjs:6-10` | high (cost reports, caps) |
| B3 | money | Paid key reads that skip the paused-lane block: rented (`rented.mjs:174`), OpenAI and Gemini env keys (`api-adapters.mjs:36-37`) | | high while lanes are paused |
| B4 | money | Day boundary mixes UTC (reserve, lane totals, adapter ledgers) and Chicago (accrue, daily limit) in the same store | `spend.mjs:507, 579`, `api-adapters.mjs:645,653` | medium |
| B5 | money | `spend.lanes.anthropic.mode` is read by the adapter but rejected as unknown by `resolveBudget` | `anthropic.mjs:120`, `spend.mjs:56` | low |
| B6 | money | Anthropic keychain service is hard-coded `project-swarm` while the worker key and OpenRouter use config `keychain.service` | `anthropic.mjs:19` | low |
| B7 | state | `tickets.json` is written under four different locks that don't exclude each other (leases, scope-go, autopilot, shared), and some writers take none (sync re-read `scope-commands.mjs:3355`, change `:3962`, ingest `:2312/2326`, approve `:2540`, board approve `watch-cli.mjs:600-623`, replan, brain) | | high (lost ticket updates) |
| B8 | state | `backlog.json` read-modify-write with no lock and truncate-in-place writes | `backlog.mjs:86` | medium |
| B9 | state | Journal lock has no stale rule (a crash blocks forever) and swallows EEXIST from the callback | `journal.mjs:269` | medium |
| B10 | state | Base-check lock is stolen after 60s even when the owner is alive (it never refreshes) | `base-check-lock.mjs:133` | medium |
| B11 | state | Lessons store lock: a crash leaves it stuck forever | `lessons.mjs:198` | low |
| B12 | state | Two liveness copies treat EPERM as dead, the other 14 as alive | `watch-cli.mjs:438`, `concurrency-guard.mjs:20` | low |
| B13 | paths | `omWriteTargetRel` resolves the root's real path but not the target's: on macOS `/tmp` roots a redirect into the manifest area is not detected (fails open) | `shell-writes.mjs:2474-2477` | high (guard) |
| B14 | paths | `orchestratorWriteAllowedRel('docs/plans/../../tools/x.md')` returns true; safe today only because every caller normalizes first | `orchestrator-allow.mjs:144` | medium (latent) |
| B15 | paths | `tickets.mjs` reserved-name check is first-segment and case-sensitive (`.GIT/x`, `src/.git/x` pass), the runner refuses them later | `tickets.mjs:40` | low |
| B16 | tickets | Delete-only tickets are marked done **before** the security review, so a delete touching auth skips Opus | `scope-commands.mjs:3127` | high (review) |
| B17 | tickets | `--delivered` only applies security review to tickets flagged `sensitive: true`; an unflagged ticket touching auth skips it | `scope-commands.mjs:3774` | high (review) |
| B18 | tickets | Review-tier code can pick haiku for acceptance, which the sync recorder rejects; and `review-tier.mjs`, `review-batch.mjs`, `manifest-review-gate.mjs` are not used by production code at all | | medium |
| B19 | tickets | `owners[0]` with no status filter can make a done or cancelled ticket an automatic dependency | `ticket-paths.mjs:359`, `acceptance-provable.mjs:162,204` | medium |
| B20 | tickets | Evidence batch choice differs: `doneEvidence` falls back to a passed batch, `qualityEvidence` to the last batch even if it failed | `verify-config.mjs:147`, `quality-checks.mjs:98` | medium |
| B21 | tickets | `--reopen` (done→ready) and `--release` (review→ready) write status directly, bypassing `MOVES`; ~15 other direct status writes (leases, unlock, replan, managers, change orders) | see ticket rules | medium |
| B22 | tickets | `markAcceptanceMetWithoutReview` sets done without `transition` or review (latent: production passes no `setTicketField` today) | `scope-loop.mjs:271` | low (latent) |

Recommendation: B1, B2, B3, B13, B16, B17 go into the next release train as fixes **before** the refactor starts; they are small and money/guard/review related. The rest are fixed inside their phase below, as separate fix PRs.

---

## Phase 1: paths (`tools/paths.mjs`)

**What moves in**
- One normalizer: posix separators, NFC, strip leading `./`, refuse absolute / drive letters / control chars / empty, `.` and `..` segments (per segment, never substring or `startsWith('..')`), keep leading dots and case, optional trailing-slash "folder" flag.
- One "real path inside root" (`realInside(root, rel)`), resolving **both** sides; replaces the four copies (`routing-paths.mjs:31`, `orchestrator-events.mjs:50/53`, `handbuild.mjs:187`, `orchestrator-allow.mjs:154`) and the half-resolved ones (`shell-writes.mjs:2474`, `policy.mjs:161`).
- One reserved/secret/protected classifier with named lists: runner-reserved (`.git .swarm .env* .ssh .aws .gnupg`, any depth, case-insensitive), secret (`isSecretPath` ×4 today: `init-profile.mjs:77`, `state-backup.mjs:24`, `remote-exec.mjs:18`, `executors.mjs:26`), protected (`ALWAYS_PROTECTED`, handbuild `PROTECTED`), sensitive (`sensitive-paths.mjs`).
- One case policy: compare case-insensitively when the file system is (the `auto-approve-policy.mjs:153` probe), used everywhere a guard decides.
- One glob dialect for user-facing patterns (context glob vs acceptance `globToRegExp` vs protected-path no-globs), with explicit names.
- Keep `relative()` + `safePath()` (runner) as thin wrappers over the module, same refusals.

**Risk: high.** These are guard and runner safety checks; a looser rule opens a hole, a stricter one breaks real projects. Mitigation: table-driven tests over every old copy first; land the module unused; switch callers one guard at a time; Opus review on each guard switch.

**Tests to write first**
- One table test that runs every current normalizer/validator on the same ~60 inputs (`./x`, `x/`, `..foo`, `a..b.md`, `a/../b`, `.github/x`, `.GIT/x`, `src/.git/x`, `__tests__/a.test.ts`, `@modal/page.tsx`, `(group)/page.tsx`, backslashes, NFD `é`, `C:\x`, `/abs`, `%2e%2e`, empty) and snapshots today's answers, so every disagreement is visible and each change is deliberate.
- Same for the four `isSecretPath` copies and the protected lists.
- Real-path tests on a macOS `/tmp` (symlinked) root: symlink out of root, symlink into protected, missing target with existing parent (B13 regression).
- `orchestratorWriteAllowedRel` with `..` (B14), mixed-case routing vs commit-window, NFC/NFD names against handbuild protected.

**Size: L** (≈30 call sites, ≈25 files touched; 6–8 small jobs plus 2 guard reviews). About 2–3 days of swarm time.

---

## Phase 2: state and locking (`tools/state-store.mjs`)

**What moves in**
- One liveness check (pid + optional start time, EPERM = alive, same-host rule explicit); replaces ~16 copies.
- One lock primitive with options: directory or O_EXCL file lock, owner record (pid, host, start time, command), wait/poll/backoff, stale rule by dead owner **and** by missed refresh (heartbeat), never by age alone while the owner is alive (B10), release in `finally`, and never swallowing the callback's errors (B9).
- One atomic write (tmp + fsync + rename, O_NOFOLLOW, mode, parent dir checks via `safeWritableDir`/`assertRegularOrMissing`); replaces ~20 helpers and the inline copies; fixes truncate-in-place writers (`backlog.mjs`, `state-migrate.mjs`, `state-pointer.mjs`, lock refreshers).
- One named lock per store, documented in a table: **`tickets.json` gets exactly one lock** that every writer takes (leases, scope wave, autopilot merge, shared writers, board approve, sync re-read, change, ingest, approve, replan, brain). Read-modify-write helper `updateLedger(root, fn)` so callers can't forget.
- Spend and lanes stores share the same store-lock code (they are near copies today).
- Leases + tickets two-step write becomes one locked update (or a journaled pair).

**Risk: high.** Deadlocks, lock order, and slower hot paths. Two locks on one file are a correctness bug today (B7), so this phase fixes real lost-update races, but a wrong lock order can hang the autopilot. Mitigation: lock-order table (tickets → leases → journal, never reverse), timeouts that fail loudly, and real concurrency tests before switching.

**Tests to write first**
- Real multi-process concurrency (child processes, not `Promise.all` in one process) for: lease claim during a wave; board approve during sync; two `scope sync` in parallel; backlog add/remove in parallel. Today only spend and the integration lock have real concurrency tests.
- Crash tests: kill the holder mid-write (tmp file left, lock left) for every store; next writer recovers with a stated rule.
- Stale rules: dead owner, other host, long-running live owner with heartbeat (B10), EPERM (B12), journal callback throwing EEXIST (B9).
- Characterization of every store's file format and mode (0600) so the switch is byte-compatible.
- Untested today, cover before moving: `base-check-lock`, `state-migrate`, `state-pointer`, scope-busy retry, projects lock timeout, lanes stale path, handbuild busy, `cancelInactiveRun`.

**Size: L–XL** (≈20 locks, ≈20 writers, 40 `writeLedger` call sites). About 3–4 days. Own Opus review (locking).

---

## Phase 3: money (`tools/money.mjs`)

Note: `tools/budgets.mjs` / `budgets-commands.mjs` are page-speed/accessibility budgets, not money; they stay out.

**What moves in**
- **Cap rules**, one resolver returning every applicable cap with its source: run (`maxUsd`/`maxTokens`), lane day caps (today in `spend.mjs:22` **and** inside each adapter), the $500 Anthropic total, daily limit + ceiling (`daily-limit.mjs`), project cap (`project-spend.mjs`), rented hours. One rule for raise vs lower (manifest can only lower; machine config sets; owner raises). Adapters stop carrying their own caps.
- **Paid-lane registry**, one list: which lanes are paid, subscription, unbilled, local; replaces `PAID_LANES`, `UNBILLED_LANES`, `subscription`, `isPaidLane`.
- **Key access**, one function per provider that checks the pause **before** reading env or keychain, for every paid lane including rented, OpenAI and Gemini (B3), using config `keychain.service` everywhere (B6). Worker-key read stays a deliberate, named exception with its test.
- **Spend ledger**: reserve / settle / release / accrue on one store with **one day boundary** (pick Chicago, the owner's day, and migrate keys; B4), plus the per-adapter jsonl ledgers.
- **Prices**: one table (per MTok, cache multipliers), config override, OpenRouter live pricing; delete the duplicate (B2) and dead `laneDailyTotals`.

**Risk: high (money).** A wrong cap spends money or blocks all work; a key path that skips the pause spends money while the owner thinks lanes are off. Mitigation: B1–B3 fixed first as their own PRs; snapshot tests of every cap decision; Opus review; keep the 1.167.21 paid-lane hard block tests unchanged and green throughout.

**Tests to write first**
- Cap table test: for a grid of configs (machine, project, manifest, CLI), assert the effective cap and its source per lane. Pins B1 and B5.
- Price parity test: every model priced once; Haiku/Sonnet/Opus input/output/cache match the published rates (pins B2).
- Pause test for **every** paid lane's key reader, including rented/OpenAI/Gemini (pins B3), with `SWARM_*_NO_KEYCHAIN` and a fake keychain so no test can reach the real keychain (today only 8 files set it).
- Day-boundary test around midnight UTC vs Chicago for reserve + accrue + daily limit (B4).
- Custom `keychain.service` returns the same Anthropic key on both paths (B6).

**Size: L** (≈10 modules, ≈40 call sites). About 2–3 days, plus an Opus money review. Ships in its own train, not mixed with other moves.

---

## Phase 4: ticket rules (`tools/ticket-rules.mjs`)

**What moves in**
- **Ownership**: one `ownedPaths(ticket)` (files, tests, deletes, contracts: decide each explicitly) and one `owners(ledger, path, {statuses})` with **named status sets** (`ACTIVE` = todo/ready/running/review/blocked, `LIVE` adds proposed) instead of the ~9 ad-hoc filters (`ticket-manifest.mjs:154,177`, `ticket-paths.mjs:201,243`, `split-repair.mjs:29,43,806`, `scope-integrity.mjs:11`, `scope-commands.mjs:126,862,3137,4207`, `watch-cli.mjs:609`). `rejected` (not a real status) goes away.
- **Review required**: one `reviewsRequired(ticket)` → {security: reason|null, acceptance: tier} using one sensitive-path rule (from Phase 1) and counting deletes and tests consistently; one allowed-reviewer table used by both the tier picker and the recorder (B18). Decide whether `review-tier.mjs` / `review-batch.mjs` / `manifest-review-gate.mjs` are wired in or deleted (they are unused in production today).
- **Done**: one `canMarkDone(ticket, evidence, how)` used by sync `--integrated`, `--set done`, `--delivered`, and the scope loop; review checks happen **before** any done write on every path (B16, B17, B22); one evidence-batch rule (B20).
- **Transitions**: every status write goes through `transition` with named exceptions (owner reopen, release) added to `MOVES`/`HUMAN_MOVES` explicitly (B21); one dependencies-done check (today 6 copies).

**Risk: medium-high.** These rules decide when work counts as done and what needs Opus; a mistake either blocks every wave or lets unreviewed work through. Mitigation: characterization of today's decisions on real ledgers (parts-request-app and project-swarm ledgers as read-only fixtures), then deliberate diffs, each a fix PR.

**Tests to write first**
- Real-ledger replay: load copies of the parts and project-swarm ledgers, run every current owner/review/done function over every ticket, snapshot the answers. Any change in the refactor must show up as a reviewed snapshot diff.
- Direct unit tests for what has none today: `validateSetTransition`, `failedRunChecks`, `ownersOfTicketPath`/`ticketOwnedPaths`, `pendingOutputOwner`, `fileOwnerOf`, board approve with a test-file clash.
- Regression tests for B16 (delete-only auth ticket must wait for security review), B17 (unflagged auth ticket via `--delivered`), B19 (done owner never becomes an auto-dependency), B20, B21, B18.

**Size: L** (≈15 modules). About 2–3 days; Opus review (review/done path).

---

## Phase 5: break up `tools/scope-commands.mjs`

Target `tools/scope/` with `scope-commands.mjs` left as the dispatcher and a barrel that re-exports every name tests use today (`runScopeCommand` ×42 test files, `runTicketsCommand`, `buildSplitManifest`, `ticketsFromStageLists`, `contextEnvFor`, `prepareScopeRun`, `WAVE_PREP_IGNORE_TESTS_REASON`, `REVIEW_FORMAT_REMINDER`).

| New module | Contents (current lines) | ~LOC |
|---|---|---|
| `scope/common.mjs` | fail/out/bad, parseArgs, resolveInside, readText, loadScope, writeFileSafe, readRunState, refreshPlan, readProfile, readApprovalPolicy (lock helpers move to Phase 2's store) | 250 |
| `scope/ticket-ids.mjs` | ticket-ID blocks, peer ledger (136–299) | 165 |
| `scope/waves.mjs` | longestWaveChain, waveRefusal, waveGateFails (300–382) | 85 |
| `scope/repo-files.mjs` | tracked files, reachable outputs, root files (383–455, 563–599) | 110 |
| `scope/run-prep.mjs` | contextEnvFor, uncovered tests, finalize wave manifest, prepareScopeRun, revertWave (620–823, 4031–4112) | 330 |
| `scope/quality.mjs` | qualityFor, ticket specs, outputsMatchTree, qualityOk (824–1030) | 200 |
| `scope/split.mjs` | split prompt/manifest, layout, change context, cmdSplit | 200 |
| `scope/ingest.mjs` + `scope/ingest-repair.mjs` | stage lists, evaluate/repair loop, ingest guards | 1000 |
| `scope/template.mjs` | new/template/check | 95 |
| `scope/gate.mjs` | ticket-manager gate | 165 |
| `scope/approve.mjs` | snapshot, cmdApprove, auto-ok | 175 |
| `scope/reviews.mjs` | security and acceptance review recording | 260 |
| `scope/sync.mjs` + `scope/sync-outcomes.mjs` | cmdSync and retry/escalation/infra outcomes | 560 |
| `scope/contracts.mjs` | contracts | 30 |
| `scope/ticket-edits.mjs` | all `tickets` sub-commands, addCiFixTicket, unlock | 600 |
| `scope/change.mjs` | change orders | 80 |

Also: move `addCiFixTicket` out first into its own small module, which removes the cycle `core-2`/`core-61` → `scope-commands` → (dynamic) `swarm.mjs`.

**Risk: medium.** Mostly mechanical once Phases 2 and 4 own the lock and rule code it calls. Main risks: hidden shared state between groups, the dynamic `swarm.mjs` imports at :1876/:2770, and the barrel missing a name.

**Tests to write first**
- An export-surface test: every name `scope-commands.mjs` exports today is still exported (snapshot of `Object.keys(await import(...))`).
- CLI golden-output tests for each `swarm scope …` and `swarm tickets …` sub-command on a fixture project (stdout and resulting ledger), so a move that changes output fails.
- An import-graph test: no `tools/scope/*` module imports `tools/swarm.mjs` statically; no cycles.

**Size: L** (≈16 moves, each a small job; the ingest and sync groups are the big ones). About 2 days.

---

## Phase 6: break up `tools/swarm/core-NN.mjs`

Rename by responsibility; leave each old `core-NN.mjs` as a re-export shim until the 24 tests that import them directly are switched, then delete the shims.

| New module | From |
|---|---|
| `swarm/util.mjs` | core-1 (fail, execFileAsync, digest, makeRunId, levenshtein) |
| `swarm/failure-text.mjs` | core-1 (lastFailureLines, evidenceBlock, absence claims) |
| `swarm/results.mjs` | core-1 result builders, summarizeRun |
| `swarm/adapters/claude-proc.mjs`, `claude-shell-job.mjs`, `codex-job.mjs`, `execute.mjs` | core-1, core-61, core-71, core-41 |
| `swarm/profile-policy.mjs`, `swarm/autopilot-policy.mjs` | core-2, core-21 |
| `swarm/cli-args.mjs` | core-2, core-12 flag helpers |
| `swarm/semver.mjs`, `swarm/release.mjs`, `swarm/update-idle.mjs` | core-2, core-12, core-52 |
| `swarm/manifest-validate.mjs`, `swarm/manifest-warnings.mjs` | core-31, core-11 |
| `swarm/checks.mjs` (merge) | core-11 runCheck, core-31 runChecks, core-51 base/run checks |
| `swarm/fs-io.mjs` | core-31 bytesAt/write/jsonWrite, core-21 safePath (atomic write now from Phase 2, path checks from Phase 1) |
| `swarm/workspace.mjs` (extend) | core-11 worktree paths, core-71 cleanup |
| `swarm/routing.mjs` | core-41 pickJobRoute, resolveAskRoute |
| `swarm/run-state.mjs` (extend), `swarm/run-lifecycle.mjs`, `swarm/run-select.mjs` | core-41 readState, core-51 idle/cancel/wait/orphans, core-11 selection |
| `swarm/integration-journal.mjs`, `swarm/integration-queue.mjs`, `swarm/redcheck.mjs` | core-41, core-71, core-62 |
| `swarm/mutants.mjs` (extend) | core-21 load, core-41 runMutant, core-51 collect, core-61 runMutants |
| `swarm/inspect.mjs`, `swarm/ship.mjs`, `swarm/doctor.mjs` | core-52, core-32 + core-42 |
| `swarm/validate-project.mjs` | core-51 |
| spend pieces in core-51/core-61 | move to Phase 3's `money.mjs` |

**Risk: medium.** Dependency direction is clean today (each core file imports only lower-numbered ones; no cycles inside core), so moves are mechanical. Risks: the 24 direct test imports, `tests/helpers/swarm-source.mjs` source-text checks, and `tools/swarm.mjs`'s re-export list (lines 4406–4525) drifting.

**Tests to write first**
- Re-export surface test for `tools/swarm.mjs` (every name exported today stays exported).
- Import-graph test: no cycles under `tools/swarm/`, and no module imports `scope-commands.mjs` once Phase 5 lands.
- Keep `tests/split-module.test.mjs:578` and the two source-text tests green on every move.

**Size: M–L** (~15 files into ~25; mechanical). About 2 days.

---

## Order, sizing and sequencing

| Step | What | Size | Depends on | Review |
|---|---|---|---|---|
| 0 | Bug fixes B1, B2, B3, B13, B16, B17 | S each | — | Opus (money/guard/review) |
| 1 | Paths | L | 0 | Opus per guard switch |
| 2 | State and locking | L–XL | 1 | Opus (locking) |
| 3 | Money | L | 1, 2 | Opus (money), own train |
| 4 | Ticket rules | L | 1, 2 | Opus (review/done) |
| 5 | scope-commands breakup | L | 2, 4 | train review |
| 6 | core-NN breakup | M–L | 1–3 | train review |

Total: roughly **2–3 weeks of swarm time** at the current release-train pace (2 trains a day, 2–3 jobs running), most of it in tests-first work for Phases 1–4. Phases 3 and 4 can run in parallel after 2 (different files). Phases 5 and 6 can run in parallel with each other.

Each phase ends with: full suite green, the phase's characterization snapshots unchanged (or every diff named as a fix), Opus review where noted, and a train release installed on both Macs.

## Open questions for the owner

1. Day boundary for money: Chicago everywhere (recommended; it's your day) or UTC everywhere?
2. Unused review-tier / review-batch / manifest-review-gate modules: wire them in (haiku/sonnet/opus tiers by risk) or delete them?
3. `--reopen` and `--release`: make them legal owner moves in `HUMAN_MOVES` (recommended) or remove the direct writes?
4. Should a done ticket ever count as a file owner (it does in sync and split-repair's shared-file check, not in the manifest)? Recommended: no, except for reporting.

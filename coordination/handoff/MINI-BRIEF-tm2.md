# Brief for the Mac mini: fixtures and Ticket Manager v2 work that does not touch swarm.mjs

From the MacBook orchestrator, 2026-10-21. Owner approved this split. Read this whole file, then start.

## 1. Fixtures for #241 (build progress)

- `coordination/handoff/roadmap-ledger.json`: the live roadmap ledger (225 tickets, 117 done at the time of the copy, 5 of 39 requirements covered). It is this project's own plan, no secrets.
- `coordination/handoff/parts-app-ledger.anon.json`: the parts-request-app ledger, anonymized (365 tickets: 339 done, 25 cancelled, 1 todo). Ids, status, stage, dependsOn, size, risk and sensitive are real. Titles, acceptance text, notes and context are generic, paths are hashed (extensions kept), scope name is "Anonymized Project". No emails, urls or product words (checked). Copy both into your fixture folder for #241's tests; do not edit them in place.
- Known real cases they cover: a ledger with many done tickets and no history (ETA null), requirements covered 5 of 39, a stage with an empty title, tickets delivered by PR evidence (status done with a delivered note).

## 2. What lands first (so you can build on it)

Branch `batch/5` (PR opened by me; pure additions): the Ticket Manager modules the roadmap waves built, all UNWIRED (no callers): `tools/managers/*`, `tools/ticket-paths.mjs` (validateTicketPaths), `tools/split-wave-sim.mjs` (simulateBeforeIngest), `tools/ticket-replan.mjs` (replanTickets, persistReplans), `tools/human-progress.mjs`, `tools/manager-commands.mjs`, `tools/wave-*.mjs`. Until it merges, base your branches on `origin/batch/5`; after it merges, rebase on main. I bump versions at merge time; you do not bump.

## 3. Your work packages (all in modules that do NOT include tools/swarm.mjs)

Each is a swarm job (cursor first, codex next), one PR per package or one batch. Acceptance lines are the ledger's own (T numbers in the roadmap ledger).

- A (R-006, T-0036): wire `validateTicketPaths` into split ingest and ticket edits in `tools/scope-commands.mjs`: a ticket path that is a directory, a missing read path, or a likely typo is refused with a `closestRepoPath` suggestion before ingest. Test with the roadmap ledger: T-0220 and T-0223 named `lessons/swarm` (a directory) and killed a wave at review time; that must now be refused at ingest.
- B (R-012, T-0049): call `simulateBeforeIngest` in `scope split` and `scope approve`: refuse or re-split when the critical path is above 25% of tickets or the average wave fill is below 50% of the slots; fixtures: roadmap ledger (critical path 7%, fill 59%), parts-app anon ledger.
- C (unblocker, T-0051): call `replanTickets` / `persistReplans` when a ticket blocks or fails twice (after the retry in sync): re-split or reroute automatically; in `tools/scope-commands.mjs` and `tools/tickets.mjs`.
- D (T-0056): use `human-progress` so human tickets are counted separately in `ledgerSummary` (`tools/scope-loop.mjs`) and in the board's owner checklist data.
- E (T-0208): `scope approve` runs the manager hooks (`tools/manager-commands.mjs` hooks) so approval is gated; in `tools/scope-commands.mjs`.
- F (reviews never stall): in `tools/scope-loop.mjs`, at loop start and on resume, every ticket in review without a recorded review run gets its acceptance review queued through the existing `deps.review`; a failed review start raises a named blocker (ticket id, path, reason) instead of a silent "stuck: skeleton not finished"; saved review manifests are regenerated from the current ticket context, not reused with old paths. Repro in the roadmap ledger history: wave 6 failed at review start on `lessons/swarm`, the loop then reported "stuck" with 10 tickets in review.
- G (context): `tools/ticket-manifest.mjs`: a ticket whose file is referenced by more than 100 tests no longer fails with "Uncovered test references" (T-0040 is the real case): auto-attach the most relevant tests to context and put the rest in ignoreTests with a generated reason.

## 4. File ownership (so we never edit the same file)

You may edit: `tools/scope-commands.mjs`, `tools/scope-loop.mjs`, `tools/tickets.mjs`, `tools/ticket-*.mjs`, `tools/split-wave-sim.mjs`, `tools/human-progress.mjs`, `tools/manager-*.mjs`, `tools/managers/*`, `tools/board-*.mjs`, `tools/watch-*`, `tools/build-progress.mjs`, and the tests for those.

I own (do not edit): `tools/swarm.mjs` and everything that will move out of it into `tools/swarm/*`, `tools/split-scan.mjs`, `tools/split-module.mjs`, `tools/spend.mjs`, `tools/project-spend.mjs`, `tools/daily-limit*.mjs`, `tools/policy*.mjs`, `tools/budget-set-commands.mjs`, `tools/autopilot.mjs`, `tools/handbuild*.mjs`, `tools/self-approval.mjs`, package files, `.github/`.

If a package needs a change in my files, write the exact hook you need (file, function, signature, one example) in `coordination/handoff/swarm-mjs-requests.md` on your branch and tell the owner; I do it after the swarm.mjs split lands (planned as 1.161.0).

## 5. Rules that bit us today (follow them)

1. Swarm jobs only; no hand edits to source, tests, docs or config. Manifests and ledger files are fine.
2. Before pushing a PR run the FULL local suite (`env -u CLAUDECODE npm test`), not just your new tests: batch 2 failed CI three times on tests nobody ran locally.
3. Tests must not depend on the shell they run in (no reading ambient environment, a TTY, inode numbers, wall clock); inject dependencies.
4. Never write token-shaped literals in files (the integration secret scan blocks the job); build fake secrets at runtime.
5. `swarm run` refuses manifests under `.swarm/`; copy them into `coordination/manifests/`.
6. A review-state ticket cannot go back to todo; use blocked, then `--release`.
7. Never commit `coordination/HANDOFF.md` or `docs/state/usage-ledger.md`; check `git diff origin/main --name-only` before opening a PR.
8. Never `--accept-unmet`, never force-push; ask the owner when a gate blocks.
9. Report each landed package with a before/after table (benchmark rule): ready-to-merged time, first-try pass rate, idle slots, on the roadmap ledger replay.

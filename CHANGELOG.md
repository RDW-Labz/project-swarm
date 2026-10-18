# Changelog

## 1.101.0

- `swarm lessons import <project-path> [--project NAME] [--dry-run]`: reads another project's `coordination/swarm-lessons.jsonl` (read only: a regular file, 2 MB cap, no symlink) and writes the lessons it does not have yet to `lessons/<NAME>/`, redacted, with stage and tags from the text; running it again skips what exists. First use: the parts-request-app lessons 33 to 47 (the earlier 32 were already here). An Opus review (2 high, 3 medium, 4 low) was fixed: no symlink on the way and one open handle with the size checked on it, a bad date fails only its row, text is redacted before it is cut, an existing id with another rule is a conflict, ids must be whole numbers, inherited object keys are ignored. Doc: docs/lessons-loop.md.

## 1.100.0

Safety group (docs/safety.md, design docs/plans/safety-design.md):
- `swarm stop --all`: the panic button. Writes a stop marker first (run, go, autopilot and resume refuse until `swarm stop --clear`), cancels running runs, stops the autopilot by exact PID, ends a rented GPU session and says to terminate the instance (an unreachable node is a failed step with a billing warning, exit 2), then takes a backup.
- State backups: `swarm backup`, `backup list`, `backup verify`, `swarm restore ID [--yes]` (hash-checked, never secrets or symlinks, a restore takes a pre-restore backup so it can be undone, newest 20 kept, automatic at `scope approve`).
- Safe migrations (profile `migrations` block, opt-in): every changed migration needs a down step, a destructive one needs `swarm migrations approve` (bound to the file hash, opens an inbox item), and up, seed, down, up must run clean, all in the merge queue before the tests.
- `swarm stop --all` also cancels paused, queued, pending and held runs (in place: unfinished jobs become cancelled), not only running ones.
- `swarm init` turns the migration check on for a new project that has a migrations folder (supabase, prisma, drizzle, db/migrations); existing projects keep the note. A re-init now also keeps hand-set `ui` and `quality` blocks (they were dropped before).
- An Opus review (7 high, 8 medium, 8 low) was fixed before release: an unreachable rented node is a failed step, the autopilot PID is signalled only when it really is an autopilot, the stop guard also covers sweep, scout, ship, merge, integrate and gpu up (and a flag value cannot switch it off), quoted identifiers, dollar-quoted bodies, E strings, `DROP` without `COLUMN`, CTE deletes and privileged calls are all caught, restore cannot prune its own source or write outside swarm state, secret names match case-insensitively, migration commands get a short environment.

## 1.99.0

Parts-app S7 lessons (40-41):
- The build check is on by default: a project with a `build` script runs it on every merge batch. `quality: {build: false}` in the profile turns it off.
- A ticket's named `tests` files are its own outputs unless another ticket owns them, so the worker may write them. A ticket whose named test files are not in the tree is sent back to the worker, not marked done.
- Tickets can declare `dependencies` (npm packages, registry names with an optional version; `--dependencies` on `swarm tickets`). The runner builds the new `package.json` and lockfile with no install scripts, they go through the security gate (manifest and lockfile audit) as part of `integrate --queue`, and `npm install --ignore-scripts` adds them to node_modules only after the gate passed.
- Automatic security review: a ticket that touches auth, an API route, a migration or database policy, or a sensitive path stays in review at `scope sync --integrated` until an Opus review passed on the code in the tree now. Sync writes `.swarm/security-reviews/RUN.json`; run it, then `swarm scope security-review REVIEWRUN` records the verdicts. A failed review sends the findings back to the worker. `--accept-unreviewed T-0001 --yes` is the logged way out.
- `go --scope` runs design tickets (as docs jobs) instead of skipping them.
- The worker prompt no longer says "Do not delete files" when the ticket declares `deletes`; it names the files it may delete.
- `swarm tickets ID --take-from A,B` takes files from several tickets (a file with two owners moves when both are named), and files move by role: a file the other ticket writes moves into `--files`, one it deletes moves into `--deletes` (a deletion is never turned into a write; eval 39.1 caught that).
- The typecheck check clears stale `.next/types` first (a check may declare `cleanDirs`, limited to that folder).
- Opus review fixes: dependencies install with `npm install --ignore-scripts` (never `npm ci`, which would wipe `node_modules`), only the named packages may change `package.json`, workspaces and private-registry scopes are refused; the security review counts only the Opus job of a manifest sync wrote, only for the tickets it listed, against the code hash taken when it was requested (a fail beats a pass, only the last JSON line counts); a build ticket waits (no retry) for a test ticket that owns its named test file; the local CI run uses a minimal environment and skips jobs with an `environment`, `services` or `container`, branch-gated jobs, steps that use a secret, run after failure or continue on error, and `pull_request_target` workflows.
- `ship` runs every command of the project's pull-request CI workflows (`.github/workflows`, in file and step order) before it pushes or opens a PR, and refuses (`ci-local-failed`, naming the step) if one fails. Steps that need secrets or `${{ }}` values, run only on push, or publish and deploy are listed as skipped, not run. `--no-ci-local` turns it off.
- Test fixes: the build-by-default and `cleanDirs` tests expect the new behavior (`build: false` is the opt-out); eval 38.4 now has the real test file its ticket names; test 286b has hard timeouts (a self-killing fake CLI, a spawn kill timer, a bounded wait and a test timeout) so a stuck child fails fast, and it is no longer skipped.

## 1.98.0

Parts-app S6 lessons (lesson 39):
- `swarm tickets ID --files a,b --take-from OTHER [--yes]` moves ownership of files from another ticket, even a done one: the other ticket's `files` lose them, this ticket's gain them, the ledger stays approved (sealed again), and a `file-move` line is logged. Only files OTHER writes (and is the only owner of) move; a running, review or cancelled source is refused; the output says when OTHER is done and its tests are not re-run. Without `--take-from` the refusal now names the owner and the flag.
- Tickets can declare `deletes` (existing files to delete, named exactly, no folder or glob, not also written). The split prompt asks for it, the job declares exactly those files and runs on a shell Claude worker that sees them and can delete in place. The job lists a deleted file in both `outputs` and `deletes` (the engine only integrates a deletion for such a path; a real integrate test found that ticket deletes were never applied before this). A delete counts as a write for file-ownership conflicts, and the security gate looks at deletions (fail closed): deleting a manifest, lockfile, workflow or action, hook, `.gitignore`, `.npmrc`, CODEOWNERS or the profile needs `--approve-manifest FILE`, which is accepted only when the file exists and is really absent in the job's result (a worker that kept the file is refused). A deletion alone no longer triggers the vulnerability scan (nothing is added to audit); after a `--queue` block the run is finished, so run the job again and integrate the new run with the approval. A ticket cannot declare the deletion of those files (delete them by hand).
- `swarm tickets ID --acceptance "one ;; two"` replaces the acceptance text (lines split on a newline or ` ;; `, so a shell check with `||` stays whole) on todo, ready or blocked tickets; `--add-acceptance TEXT` appends one line and also works on review and done tickets (a replace there could weaken what the work is judged against). The approval is sealed again.
- `scope check`, `split` and `approve` warn when a ticket names an e2e spec (`e2e/`, `*.e2e.ts`, `cypress/e2e`) and the project's e2e command would not run it: no e2e script in package.json, a command or config (`testDir`, `specPattern`, `--config`) limited to another folder, a playwright spec that does not end in `.spec` or `.test`, or a cypress spec that does not end in `.cy`. The nearest package.json decides in a monorepo; python and other non-JS specs are not judged.

## 1.97.0

Parts-app S6 report (9 hand fixes):
- A failing check keeps every ticket in its batch or run out of done, whatever the check is called (tests, an env check, a log lint; also a timeout or crash, and a run-level check after a passing batch) and whether or not the ticket has tests. `scope sync --integrated` leaves them in review and says which check failed; a batch of one job goes back to the worker with the failure. If the check was already failing on the base, `scope sync RUN --integrated --accept-failed-check NAME --yes [--note TEXT]` lets tickets pass; it is named, confirmed and logged.
- Dependency keys the split worker invented (a `dependsOn` key that names no ticket in its file) are dropped with a note instead of refusing the whole split.
- `--help` or `-h` on go, scope, tickets, change, run, integrate and other acting commands prints the help and does nothing else (`go --scope --help` used to prepare and release a wave).
- A check failure whose errors name only files that other tickets own (S6: T-0091's lint failed on the file T-0090 wrote) is not that ticket's failure: no escalation and no attempt for it. If the owner is in the run, the failure goes to the owner; if not, the ticket is blocked (manual) with a note naming the owner, to fix and `swarm tickets ID --release`. Applies to batches of one too. Tickets with failed checks are processed first, so the owner is not marked done before it gets the failure.
- A job that failed for a reason outside the ticket (credit exhausted, rate limit, HTTP 402/429/5xx, host or network down, run stopped; judged on the runner's error line only, never on test output) returns to ready at the same level instead of climbing the escalation ladder; after three in a row it is treated as the ticket's own.
- A ticket whose proposed output already matches the tree (a regular file in the run workspace, byte for byte, never a symlink or the project itself) is no longer stuck in review waiting for integration evidence; sync says it was not re-verified. A different tree still stays in review.
- `swarm tickets ID... --release [--note TEXT]` releases held tickets cleanly: blocked, todo or review go back to ready with attempts, escalation level and retry notes cleared (dependencies must be done; the approval stays valid).

## 1.96.0

- The route-level test of an integration ticket must be a test file (a tests, e2e or spec folder with a source file that is not a helper, fixture, support file or page; a `.test` or `.spec` file; `tests.py`, `test_*.py`, `*_test.go`, `*_test.ts`); a page or module file named as the test is refused at split. `swarm tickets --tests` applies the same rule to integration tickets.
- Lesson 1 and the strict-cancel option are parked in docs/plans/ideas.md.

## 1.95.0

- Lesson 16: `scope split --ingest`, `scope approve` and `scope check` warn when an acceptance check runs a supabase, cypress, prisma or drizzle-kit command and no ticket writes its config file and the project has none. The split prompt asks for that ticket.
- Lesson 21: a ticket that writes or runs database tests (supabase/tests, pgTAP, `supabase test db`) gets the runner rules in its prompt: every .sql under the tests folder runs, `\ir` stays inside the mounted folder, no dblink as a non-superuser.
- Lesson 26: a manifest check, preCheck or job setup that stops processes by a loose pattern (`pkill`, `killall`, `kill $(pgrep ...)`) is refused (`loose-kill`); `kill PID`, `pkill -P`, `pkill -F`, a pid-file `xargs kill` and a `grep` for the word are fine. It also catches `/usr/bin/pkill`, `kill $(lsof ...)`, `fuser -k` and `kill-port`. Shell workers and the agent pointer files (AGENTS.md, CLAUDE.md, GEMINI.md, cursor rule) carry the rule.
- Lesson 2: closed. The updater has run the new release's installer in a fresh process since 1.66.0 (test: tests/update.test.mjs). The lesson records now say so; lessons 14, 16, 17, 21 and 26 are marked built.

## 1.94.1

- `swarm integrate --approve-manifest FILE` is now tied to the file's exact content: swarm takes the sha256 of the bytes the workers proposed, the gate lets only that content through, and a later change to the same file is blocked again with "changed after you approved it (approved X, now Y)". The decision record names the hash.
- The "500 API jobs" lane test no longer depends on the timing of state snapshots (it failed once on a busy macOS runner): it checks from the requests that other lanes were served during the gemini pause.

## 1.94.0

- A failed tests check at done-check goes back to the worker with the failure, like lint and typecheck (one job in the batch: that job; a run-wide failure: only the ticket the output names; many tickets: base or setup, no paid retries).
- `swarm tickets ID --files a,b --context c --tests t [--yes]` changes a ticket's file lists (todo, ready, blocked or review only). It previews first, refuses a file another ticket owns, a bad path or an integration ticket with no test, and with `--yes` seals an approved ledger again.
- `swarm integrate RUN --approve-manifest FILE` lets one reviewed manifest or workflow file pass the security gate for that run only, and records a decision. The gate message now names the flag. Only a file the run really changes can be approved; the path must be exact (no glob, folder or spaces); the file joins the policy already in force (a disabled gate stays disabled); the decision is written before integrate and a failed write stops it; it works with `--queue`.
- `swarm tickets` only edits todo, ready or blocked tickets, refuses `.env` in context or tests, drops duplicates, logs the old and new lists, and reports a busy go lock instead of crashing.
- A ticket may name `.env.example` (and other names-only templates) as `context`: ticket validation no longer refuses it (lesson 37 follow-up). It is still refused as a file the ticket writes.

## 1.93.2

- Lesson 37 (the `--wire` flow failed on the parts app):
  - Integration tickets that write the same file (router, navigation, layout), even in different stages, are chained by code at ingest: the later one waits for the earlier, so they never share a wave.
  - `scope split --wire` skips requirements whose build tickets are all done (S1) and says so; `--all` includes them.
  - `.env.example` and other names-only templates (`.env.local.example`, `config.example.json`) are allowed as read-only context. They are still refused as outputs, and a real `.env` is still refused everywhere.
  - A file ownership conflict at ingest now names the tickets and the file ("T-0001 \"Create list page\" and T-0002 \"Add list filters\" both write src/pages/list.tsx (wave 1)") and says how to fix it.

## 1.93.1

- A cancel that drops a dependency now leaves one non-blocking note in `swarm inbox` naming the tickets that no longer wait (`FYI, no action needed`). It never pauses a run; close it with `swarm done ID`. Covers cancel, `go --scope` and autopilot.
- Lesson 35: a change order adds tickets only for requirements that have none. The split worker gets the real tracked file list and the existing tickets (read-only), told never to rewrite them. An ingest that touches any other requirement is refused whole, nothing written. The long-line timing test now counts CPU time, so a busy machine can't fail it.

## 1.93.0

- Lesson 34 (parts app S5 report). (1) Wiring: `scope split` now asks for an integration ticket (`integration: true`) per requirement that has build tickets: it mounts the modules in real routes or pages and lists a route-level or end-to-end test; the runner makes it depend on the module tickets of its requirements, and a split without one (or without its test) is refused. A requirement is reported done only when its integration ticket is done (Build Plan state `unwired` otherwise, coverage excludes it). `swarm scope split --wire` asks only for the missing integration tickets of an older ledger (then `--ingest RUN --merge --wire`). (2) `go --scope` and autopilot release `todo` tickets whose dependencies are done (the roots of an approved stage), logged as `release`; the approval is not touched. (3) Cancelling a ticket removes it from other tickets' `dependsOn` (and `go --scope` cleans older ledgers); a valid approval is resealed, and a deps-blocked ticket with nothing left to wait for unlocks. (4) A failed typecheck, lint or build check seen at `scope sync --integrated` (merge batch or plain integrate) sends the ticket back to the worker with the errors, like a failed test (a batch of one job blames that job; a run-wide check sends back only the ticket whose files the errors name; not when the same check failed for 3 or more tickets of the run); merge batches now keep a redacted tail of each failed check. (5) Gitignored build files a worker leaves behind (`tsconfig.tsbuildinfo`, `coverage/`, `.next/`, anything the project's `.gitignore` names) are no longer dropped writes, so `--accept-dropped` is not needed; files git tracks, secret-looking files (`.env*`, keys, `*.pem`, `*.tfvars`) and files hidden only by a catch-all `.gitignore` rule are always still reported.

## 1.92.0

- Phase 16, Swarm Watch: `swarm watch [RUN] [--all] [--tui] [--open] [--json]` opens a read-only dashboard for the newest live run (or the run named), built from the run's `state.json`, the ticket ledger and `.swarm/ui/`. It binds to 127.0.0.1 on a random port, needs a random token in the URL, answers only GET and HEAD, serves a strict Content-Security-Policy, uses no CDN and exits after 30 minutes idle (or when the run is done and the page is closed). The page streams deltas over Server-Sent Events (at most 4 a second) and has four tabs: Run (header, KPIs, swarm map, lanes, waves, attention feed, leads, merge queue, run-complete banner, job drawer), Build Plan (stage lanes, epics, ticket cards, requirement view, dependency graph, change orders, ticket drawer), Commands (generated from the `swarm completion` registry with what, when, example, cost and approval pills, search, and the copyable commands for this run) and Gallery (mockup and page screenshots from `swarm ui check` with verdict, approval and comments). Nothing on the page changes anything: pause, cancel, retry and approvals are shown as commands to copy. `--tui` draws the same data in the terminal, `--json` prints it, `--all` lists live runs on this machine.
- `swarm gallery list|approve ID...|comment ID "text"` records design-gallery approval in `.swarm/ui/gallery.json`; an approval goes stale when `swarm ui check` later fingerprints different code.
- `swarm tickets --mark-deps [ID...] [--yes]`: a one-time migration for ledgers made before `blockReason` (1.91.0): blocked tickets with no reason, no failed attempts and dependencies are marked as dependency-blocked so they unlock by themselves (the ones whose dependencies are done unlock at once). See docs/scope.md.
- Design and module contracts: `docs/plans/watch-design.md`; usage: `docs/watch.md`.

## 1.91.0

- Lessons 28 to 32 (the parts app S4 report). (28) Every merge batch with a build ticket runs the project's typecheck and lint (and build when the profile opts in, profile block `quality`); `scope sync --integrated` keeps the ticket in review until they passed, and a failure goes back to the worker with the errors. (29) A failed or cut-off job escalates its ticket (bigger output, then Codex, then Claude) before it ever blocks; split asks for tickets that fit one answer and `scope approve` warns about big ones. (30) Tickets blocked only by dependencies unlock when those are done, in `go --scope` and `autopilot` (a skipped job now blocks its ticket instead of leaving it running); `blockReason` tells deps, failure and manual blocks apart. (31) `swarm ui check` starts its own server on a free port (`{port}` in `ui.start`), never uses the owner's dev server, and screens may set `mockupQuery` and `waitFor` for pages with several states. (32) A test check that passed but ran 0 tests fails with `no-tests`; `scope approve` prints the test command detected from `package.json`. Small: `lesson add --area` now lists the real areas (tool, gotchas, skill folders) instead of names it then refused; variable names (not values) from `.env.example` go into every ticket prompt. Scenario evals: `tests/lessons-28-32-eval.test.mjs`; lessons L-0028 to L-0032. See docs/plans/lessons-28-32-design.md, docs/scope.md, docs/ui-check.md, docs/verification.md.

## 1.89.0

- Lesson 27, a rendered check for UI tickets: `swarm ui check [SCREEN_ID...]` renders each configured design screen (the mockup file and the real page at `baseUrl + route`) with the project's own Playwright, takes screenshots, and compares them: fonts the mockup uses must be on the page, the page must not look unstyled, no horizontal overflow, the mockup's words and colors must appear, and a coarse screenshot comparison (ink structure plus colors) must reach `minScore`. Profile block `ui` (base url on this machine only, optional dev server command, screens); reports in `.swarm/ui/`; tickets may carry `screens` (their mockups go into the job context, a prompt line asks for wired styles) and `scope sync --integrated` marks them done only after the check passed since the integration. On the parts app's real pages it flags the font variables that were never loaded. A Claude Opus review (2 high, 7 medium, 9 low) was fixed before release: the verdict is bound to the exact code state, the start of the check's own server and the time; mockups are protected paths that only the jobs rendering them may read; the browser cannot navigate off this machine; PNG decompression bombs are refused; the check cleans up on Ctrl-C. See docs/ui-check.md and docs/plans/ui-check-design.md.

## 1.88.1

- Code scanning cleanup: the nine old CodeQL alerts (tests that built `-e` scripts and preload modules by splicing values into code now pass them as arguments or environment variables) and two alerts from the last releases. One was a real bug: the production-word check in `ci` preview hooks split an argument on the letter `s` instead of on whitespace (`'[=:,\\s]+'` in a string), so `stage production` was not caught; now fixed with a test.

## 1.88.0

- Merge guard: `swarm merge PR [--repo OWNER/NAME]` squash-merges only when every check of the PR head is green (a rerun replaces an older failed run; failing, pending, cancelled or missing checks refuse), the PR is open, mergeable and based on the default branch, and no other open PR is stacked on its branch; there is no flag to skip it. `swarm ship` now reads the PR again right before merging and refuses with any failing or pending check, required or not (`--wait-required-only` only limits what it waits for first; pending ones are waited for, `ci-pending` on timeout). An Opus review (2 high, 5 medium, 6 low) was fixed before release: every check item counts on its own, required checks that have not reported are pending, `mergeable` must be known, the local update only runs in the merged repository. Doc: docs/merge-guard.md, design docs/plans/merge-guard-design.md.

## 1.87.0

- Dogfood fixes (the parts request app run logged 27 lessons, now in `lessons/parts-request-app/`): tests run before a ticket counts as done (profile `verify` block: a shell-capable worker with setup commands and test environment, the same tests on every merge-queue batch, done only on the runner's own test evidence, failed tickets go back once with the failure); tickets get their context automatically (scope reference sections, data model, contracts, design files, package.json, shared files first for prompt caching; scope `## Context` and `## Layout` sections, profile `context`); contract tickets must write OpenAPI JSON and `scope contracts` finds it and self-checks; the generated mock answers writes with a body that matches its response schema; split assigns real folder paths and shows the project layout; the profile's package manager reaches prompts and refuses other lockfiles; `swarm init` and `scope approve` ignore build output (`.next/`, `node_modules/`, `*.tsbuildinfo`); the security gate takes per-package accepted advisories with a review date and audits a `package.json` with no lockfile through a lockfile built in a temp folder. Also: `go --scope` validates the manifest before tickets move, human tickets close directly, python-style ticket lists are repaired, a lone empty-find edit is a whole-file write, re-init keeps hand-set profile blocks. A Claude Opus review of the round (4 high, 9 medium, 4 low) was fixed before release: automatic context never attaches secret, protected, symlinked or outside files; the temporary lockfile build takes only registry specs and no credentials; accepted advisories with an id cover only the ids they name; done evidence is tied to the batch that integrated the job and to the run that handed the ticket in, and a broken profile does not switch the test gate off; the retry is one locked write (the second failure blocks); `testEnv` and `{tests}` are checked; the gate also guards `verify`, `context`, `ci`, `approval` and protected paths in the profile; the contract self-check runs the generated mock in its own process. See docs/dogfood-fixes.md.
- Evals: 4 new tasks from the dogfood (data model columns, DDL-only migration, OpenAPI contract file, dependency version match); the fixtures got unique names; 12 tasks, all proven red on the start and green on the solution. Proof for the context fix on Haiku 5.5: the data model task passes 4 of 4 with the context file and 0 of 4 without it; the Tailwind version task 3 of 4 with package.json and 0 of 4 without.

## 1.86.0

- Phase 15, skeleton first, smoke tests and preview deploys: tickets may carry `skeleton: true` and `swarm go --scope` runs only the skeleton (and what it needs) until it is done (`--skip-skeleton` overrides); the project profile may carry a `ci` block with `smoke` and `preview` commands that run after each green batch in queue integration (secret-looking environment variables are not passed; production flags refused in a preview command); a failing hook never rolls the batch back but becomes a fix ticket (`origin: ci`, outside the approval hash) with a short failure summary; a passed preview records its URL. A Claude Opus review (4 high, 6 medium, 6 low) was fixed before release: hooks get an environment allowlist, the production refusal covers more forms (and is documented as a safety net), a hook cannot hang the queue, the files a hook runs are protected paths, runner-made fix tickets reseal the approval under the ledger lock instead of bypassing it, and the failure summary in prompts is labelled untrusted. Nothing deploys to production and nothing runs unless the profile says so. See docs/ci-hooks.md and docs/plans/phase15-lessons-design.md section 10.

## 1.85.0

- Phase 15, affected-only tests and adaptive batches: a manifest check may carry `affectedArgv` (with an `{affected}` item) and `fullEvery`; in queue integration each batch runs only the tests the repo map says its files affect, with a full run every `fullEvery`-th batch, on the last batch and whenever anything is unknown (no map, non-code or config file, too wide). the --adaptive flag of queue integration grows batches 10 to 25 to 50 after passing batches and shrinks after a failed one; bisect stays. A Claude Opus review (5 high, 6 medium, 2 low) was fixed before release: bisected halves always run the full checks, a final full run covers affected-only batches when the last batch cannot, a stale map is ignored, paths can never become flags, test helpers, fixtures, non-code files, deleted files and truncated import graphs force a full run. See docs/merge-queue.md and docs/plans/phase15-lessons-design.md sections 9 and 9b.

## 1.84.0

- Phase 15, lessons mine: `swarm lessons mine [--min N] [--include-guarded] [--write] [--json]` clusters lessons whose guard is still only proposed and writes one proposal per cluster (scope rule, lint, test template, contract test, router rule, review item or prompt rule) under `proposals/`, naming the lessons it comes from; deterministic, never overwrites, never merges. First proposal: `proposals/ci.md`. Design: docs/plans/phase15-lessons-design.md section 8.

## 1.83.0

- Worker output: a file returned both whole (`files`) and as `edits` is normalized to the whole file instead of failing the job.
- Anthropic lane (owner decision): default concurrency 64 (adaptive limit still on) and default `max_tokens` 4096; an answer cut off at the limit is retried once at double, re-checked against the job's spend caps with the first call counted and billed. Ticket jobs mark their contract files as the cached shared prefix (`cacheContext`). See docs/lanes.md.

## 1.82.0

- Phase 15, part 1, the lessons loop: structured lessons (`swarm lessons add|list|show|stats|check|backfill|notes`, one JSON file per lesson under `lessons/<project>/`, secrets, emails, home paths and run ids refused); all 229 numbered field lessons and the 2 queue rows are backfilled (idempotent); "Watch out for" notes (up to 3, at the end of the prompt) added to ticket jobs by `swarm go --scope`; a golden eval set (`evals/`, 8 tasks from real failures, each proven red on the start and green on the solution) with `swarm eval list|validate|manifest|score|gate` and a per-model baseline gate. Design and use: docs/lessons-loop.md and docs/plans/phase15-lessons-design.md.
- Built through the swarm: 8 modules/tests and 8 eval tasks as worker jobs (one rerun after a truncated file and a gate block); the command glue and wiring by hand.

## 1.81.0

- Phase 13, scope to tickets to swarm: `swarm scope template|check|split|approve|sync|contracts`, `swarm tickets`, `swarm change "reason"` and `swarm go --scope`. One scope file becomes a ticket ledger (`.swarm/project/tickets.json`, with an append-only log); integrity checks (every requirement covered, every ticket traced, no two parallel tickets on one file, no cycles, sizes S or M); you approve the plan once; `go --scope` runs the ready tickets in waves; change orders cancel, reopen and add tickets without losing history.
- Contracts first: an OpenAPI 3 file generates types, validators, a client, a mock API with seed data and contract tests (they run against the mock and the real API).
- Day 0 checklist of outside services (payments, domain, email, app stores, ...) as human tickets; profile `approval` block (human approvals, change-order limit, budget); `swarm brief` shows ticket progress. Design and details: docs/scope.md and docs/plans/phase13-design.md.
- A Claude Opus review (18 findings) was fixed before release: a merge clears the approval; the approval covers the ticket set and the scope hash; go --scope refuses a missing or changed scope file and takes a lock; sensitive detection reads requirement text and short words; writes never follow a symlink at the target; hostile OpenAPI names are rejected before any code is generated; split files are size and shape checked; change orders reset dependents of reopened tickets.
- Built through the swarm: the nine modules and their tests were worker jobs; the command glue, wiring and review fixes were hand work (see docs/state/dogfood.md).

## 1.80.0

- A1 follow-up: every integration is gated (plain `integrate` runs the gate on the planned writes before the first write, so there is no bypass; a block writes nothing and fails with `security-gate-blocked`); the code scan runs offline for every project, sensitive or not, with pinned local Semgrep rules (`tools/security-rules/semgrep-local.yml`, 15 rules, sha256 pinned in the code), metrics off, no network (`codeScan`: `local` default, `auto`, `off`); a change to a pnpm, yarn, Go, Cargo, Python, PHP, Ruby or JVM manifest or lockfile blocks the batch (`unsupported-manifest`) with an inbox item until the owner allows it (`allowUnparsedManifests`).
- Router (owner decision): Haiku is the default worker lane; the rented GPU lane is used by automatic routing only when 700 or more non-sensitive tickets are ready (`RENTED_MIN_READY`, `lanes.rented.minReady`); a job with `hard: true` goes to Codex first. The Anthropic lane's default concurrency is 32 (was 16): at our tier Haiku allows 10,000 requests, 10M input and 2M output tokens per minute, about 147 agents at the measured task profile (see docs/lanes.md).

- A Claude Opus review of the follow-up found 3 high and 6 medium issues, all fixed: plain integrate now refuses dependency manifest and lockfile changes (it cannot audit them before writing; use --queue) and fails closed when the gate cannot run; file names are compared case-insensitively; a batch cannot change the security policy or sensitivity in .project-swarm.json; changed install lifecycle scripts block; the unparsed-manifest list is much longer (npmrc, yarnrc, bun and uv locks, gradle wrapper, gitmodules, CI workflows, vendored folders and more) and the allow-list matches exact paths; the offline Semgrep scan runs in a fresh temp folder with a private HOME and a minimal environment; 4 more pinned rules (19 in all, validated and exercised with a real Semgrep); the router counts only non-sensitive auto jobs that are ready now.

## 1.79.0

- Security gate on every merge-queue batch (A1): after a batch's files are written and before it can stay merged, `integrate --queue` runs a secret scan (built-in rules; a finding has only a fingerprint, never the secret), a new-dependency check (must exist on npm or PyPI, be at least 30 days old, have real downloads, not look like a popular name; fails closed when the registry is unreachable), known-vulnerability checks (npm audit, pip-audit, osv-scanner; high and critical block; only when a manifest or lockfile changed), a Semgrep code scan when installed (findings become fix tickets, never a block) and a licence check (GPL and AGPL block unless the owner allows). A block rolls the batch back and bisects it like a failed check (`security-gate` in `checkFailed`, `securityBlocked` in the summary), opens an inbox blocker with no secret text and writes a sanitized lesson to `.swarm/project/security-lessons.ndjson`. The policy is the optional `security` block of the project profile; it can only be disabled there, never by a flag, and it also runs with `--no-checks`. See [security gate](docs/security-gate.md).

- A Claude Opus review of the gate found 7 high, 11 medium and 10 low issues; the high and medium ones are fixed: the gate runs before the project checks (a blocked batch never executes its own code); no file is skipped silently (NUL bytes, UTF-16, big files); workers cannot silence findings with the allow marker (it only works on lines that already existed); fingerprints are HMACs with a per-project key; bounded scan work per line; more secret rules and every match on a line; manifests in any folder, version bumps, non-registry and alias specs are checked or blocked; the vulnerability check fails closed; pip-audit runs without installing anything; semgrep runs with metrics off, never on sensitive projects unless the profile says so, and its messages never reach tickets; registry calls have a timeout and a per-run cache; licences use a real SPDX parser.

## 1.78.0

- Rented lane defaults (owner decision after the bake-off): Qwen3.6-35B-A3B NVFP4 only (Lightning and Coder-Next leave the shortlist), thinking ON by default (`SWARM_RENTED_THINKING=off` turns it off; the default output limit for the lane is 16000 tokens), 128 agents per GPU (`--per-replica` default 128), best-of-N off by default (`--best-of` default 1; a failed job escalates to Haiku, then Codex).
- Lane comparison (`bench/gpu-bakeoff/compare-lanes.mjs`, `docs/state/lane-comparison.md`): the same 11 tasks (the 10 lane tasks and the hard task) on Haiku (11/11, about $0.0023 per passing task), Codex (11/11, subscription) and the rented Qwen3.6 (8/11, about $0.0026 per passing task only at full 128-agent load): Haiku is the default and the GPU lane pays only for a large, busy queue. The hard task runs on any lane (`runHardTask` takes an agent); CLI lanes get no output limits.

## 1.77.0

- Bake-off follows the GPU memory plan (docs/plans/swarm-gpu-memory-plan.md): the pinned vLLM image is v0.31.0 (by digest; NVFP4 on this card needs 0.28 or newer); all models are NVFP4, text-only, no MTP, started with the plan's flags (gpu-memory-utilization 0.93, fp8 KV cache, prefix caching, mamba cache align, 131072 context, per-model quantization, MoE backend, parsers and environment): Qwen3.6-35B-A3B NVFP4, Nemotron 3.5 Lightning NVFP4, and Qwen3-Coder-Next NVFP4 (RedHat build) only when at least an hour of the session is left; one vLLM engine per GPU.
- The bake-off sweeps 32, 64, 96, 128 and 192 concurrent agents (ms per token, output tokens per second, errors and prefix-cache hit rate at each), takes the highest count under 35 ms per token as the agents per GPU, measures best-of-1 and best-of-3 at that count with that many agents loading the server, and ranks by cost per passing task, then agents per GPU. The rented lane sends `chat_template_kwargs: { enable_thinking: false }` (set `SWARM_RENTED_THINKING=on` to allow thinking). Container offers must also have PCIe Gen5 x16, at least 16 vCPU, 64 GB of RAM and 200 GB of NVMe disk; `rent --offer auto` picks the best current offer (offer ids on a busy host change by the minute); `--local-port` moves the tunnel off a port that is already in use (the exposure check refused to share one). `the test scratch folders is ignored.

- A hard task joins the bake-off (planWaves, bench/gpu-bakeoff/tasks/hard-planwaves): the model gets only the spec and a stub, 16 hidden tests grade it (pass is 16 of 16), 10 minutes per attempt; tests passed, time, attempts and tokens are recorded per model at best-of-1 and best-of-3 (bench/gpu-bakeoff/hard-task.mjs).
- Qwen3.6 NVFP4 is started without --moe-backend flashinfer_b12x: with it vLLM 0.31.0 crashed on the RTX PRO 6000 (CUDA illegal memory access while profiling CUDA graphs); the default MoE backend works.

## 1.76.0

- Container mode for rented GPUs (`swarm gpu up --mode container`, `--probe-ports`, `--ssh-port`): for nodes that are themselves a container running the pinned vLLM image (Vast.ai container instances, which cannot run Docker). `gpu up` starts `vllm serve` inside it (one per GPU, bound to 127.0.0.1, per-rental key only in the server environment); the exposure check reads `/proc/net/tcp` and `/proc/net/tcp6` instead of `ss` and also probes any ports you name; a failure stops the servers and removes the session; `gpu down` says to destroy the instance (a container cannot be powered off).
- Rental helper `bench/gpu-bakeoff/vast.mjs` (outside the runner; swarm itself still never rents): container-mode offer filter (verified, reliability 99% or more, RTX PRO 6000 S or WS, datacenter first, 4 hours within 80% of the cap), pinned-image create body with no mapped ports, instance id logged first, detached reaper under `caffeinate -i`, destroy command. The bake-off benchmark base is pinned to v1.65.0 (`--bench-ref`) and the rented lane gets the larger output cap.
- A Claude Opus review of container mode found 4 high and 5 medium issues, all fixed: the per-rental key is read once before the servers start (a background substitution raced the env-file removal and could start vLLM with no key), `gpu up` now requires the server to refuse an unauthenticated request (401 or 403), the `pkill` patterns no longer match their own command line (the dead-man timer was being killed), the stop is verified, a failed start also stops the tunnel and says to destroy the instance, Ctrl-C stops the servers, `--host`, `--port` and `--api-key` are refused in server args, the rental helper refuses a second live rental, verifies every destroy (retrying for an hour), checks the reaper is alive, destroys the instance on any failure after the create and on Ctrl-C, labels each rental, and counts download traffic in the 80%-of-cap check.
- Fixed: `swarm gpu up --ssh-port` and root logins without sudo (Vast.ai VMs); sessions remember their ssh options so `down` and `status` reach nodes on other ports.

## 1.75.0

- Rented GPU safety (finishing Phase 14e): the server image is pinned by digest (`vllm/vllm-openai@sha256:...`, vLLM v0.27.1) and tags are refused (`--image` takes only another digest); every rental gets a random 48-character API key (private env file on the node, removed by the timer and `gpu down`; kept in the 0600 session file; the lane and the bake-off send it as a Bearer header); `gpu up` fails and stops the servers if any server port answers from outside or the node lists a server port bound to anything but 127.0.0.1, so servers listen on the node's loopback only and are reached through the ssh tunnel.
- A regression test (mutation-checked) covers the fix that lets a lead's child manifest list uncovered tests in ignoreTests, so docs-only `swarm go` goals work.
- `gpu up` fails (before anything is created or sent) if the node's Docker is older than 28 or its version cannot be read: older Docker lets other hosts on the same network reach ports published on 127.0.0.1.
- Repo rule: project-swarm is only for the swarm itself (CLAUDE.md and AGENTS.md): other projects, the starter kit and the parts request app live in their own repos; evals stay small fixtures; lessons come back as lesson files only.
- Spend and lane lock files: the age of an ownerless lock is judged against the real clock, not an injected one (a test clock far in the future made a fresh lock look stale and let concurrent writers delete each other's lock). A second Claude Opus review of the new rental safety code found 0 high and 4 medium issues, all fixed: the key is never printed or carried by errors, a failed or exposed start stops the servers and removes the session (and a starting session is never routable), the node-side check treats any non-loopback listener as exposure and fails closed, the outside probe resolves the real host and runs again after the servers answer, and the machine config can no longer hold a session key.

## 1.74.0

- Rented GPU lane (Phase 14d): `agent: "rented"` runs jobs on an OpenAI-compatible server you start yourself in the cloud (vLLM or SGLang on a GPU node). Config in the machine config (`rentedGpu`: endpoint, model, Keychain key item, `hourlyUsd`, `maxHoursPerRun`, `concurrency`, `dailyUsd`, `trusted`). The lane is adaptive (starts at 4, up to the ceiling). Spend: the rental is billed by the hour, not the token. One meter per run counts the time the node was needed and adds it to the run cap and to the lane's day cap across runs (a machine-wide spend entry); the guard warns at 80% and stops launching at a cap or at `maxHoursPerRun` (running jobs are never killed); a run with no USD cap does not start rented jobs. Only jobs marked `sensitive: false` ever go to a rented host. Automatic routing picks the lane only while `swarm gpu up` has a live session. **Swarm never rents or starts anything**; the runbook for renting a node, connecting and shutting it down is in [rented GPU](docs/rented-gpu.md). Twelve adapters now.
- Small-model GPU swarm (Phase 14e): `swarm gpu models|up|down|status|bakeoff`. `up` runs one vLLM replica per GPU on a node you rented (ssh commands only; no file, key or .env is sent; servers listen on the node's loopback behind an ssh tunnel), sets a hard dollar cap (the session lasts at most the cap divided by the hourly price) and a timer on the node that removes the servers and powers it off; the rented lane spreads requests over the replicas (least in flight, an unreachable replica is skipped for 30 seconds). `bakeoff` ranks candidate small coding models on one GPU on our own tasks (the lane benchmark; the lessons eval set joins in Phase 15), reporting pass rate, tokens per second at 1, 50 and 200 concurrent agents, agents per GPU and cost per passing task, FP8 first and NVFP4 only with `--extra-quant`; the report is docs/state/gpu-bakeoff.md. Jobs on this lane must carry exact files, the manifest contract and `acceptance` tests (new job field); one failure escalates to Haiku, then Codex. `trusted` is gone: a rented host never takes a sensitive job.
- Best-of-N and prefix caching on the rented GPU lane: a job (or `swarm gpu up --best-of N`) can ask for N answers in one request; the ticket's visible tests run on each in a temporary git worktree and the smallest passing one is kept, otherwise the job fails with `best-of-failed` and escalates as usual (rented lane only, never on paid lanes). The bake-off compares pass rate at N=1 and N=3 and reports vLLM's prefix-cache hit rate; servers start with `--enable-prefix-caching` and the rented lane sends the project's shared files first and the ticket last. A Claude Opus review of the lane found 1 high and 7 medium issues, all fixed: the dead-man timer is now the first line of the start script and a session is recorded before anything starts (so `gpu down` can always clean up), the bake-off refuses to replace a live session and its session is never auto-routed, a failed start tears down its tunnel and session, tunnel ports must be free and the tunnel must stay up, ssh runs with agent and X11 forwarding off and strict host keys, passwordless sudo is checked at start, the adapter refuses any rented job that is not `sensitive: false`, only connection failures move a request to another replica, and the tunnel pid is checked before it is signalled.
- Batch mode is now opt-in per project: the machine config default (`batch.enabled`) applies only to the folders in `batch.projects` (so BinGo stays off); `--batch` and a manifest `batch` still work anywhere. Batch results stay on Anthropic's servers for up to 29 days; the docs say so.
- Batch mode is now opt-in per project: the machine config default (`batch.enabled`) applies only to the folders listed in `batch.projects`, so a sensitive project such as BinGo never batches unless you list it (or pass `--batch`). Batch is allowed on sensitive projects under the same rules as the Anthropic lane, and the docs now say batch results stay on Anthropic's servers for up to 29 days.
- A Claude Opus review found 1 high and 7 medium issues, all fixed: the rental is accrued every 10 seconds while the node is in use and kept as one machine-wide entry per UTC day (so other runs' day-cap checks see it, and a run over midnight counts on both days), the 80% warning is also checked on that timer and deduped per cap, a rented job on a run that has no rental meter is refused explicitly, `ask` and its fallbacks never use the rented lane, the lane's ceiling from `rentedGpu` cannot be lifted by manifest overrides, and the runbook now uses a private env file for the key, `ExitOnForwardFailure` with an unusual local port, a host-key check, and states honestly how far a cap can be passed.

## 1.73.0

- Batch mode (Phase 14c): the Anthropic lane can send jobs that do not need to finish fast to the Message Batches API at half price. Opt-in with `--batch` on `run`, `go` and `plan`, a manifest `batch` (true, or `{ types }`), a job's own `batch`, or the machine config `batch`. The run, lane and machine-wide caps and reservations are unchanged (the reservation uses the standard price; the recorded cost is the half price billed), sensitive rules are unchanged, lead jobs are never batched, a batch job holds no lane slot while it waits, and cancelling the run cancels its batches. `swarm plan` shows the estimated saving. See [batch](docs/batch.md).
- A Claude Opus review found 4 high and 8 medium issues, all fixed: a batch request's worst case is reserved in the Anthropic ledger when it is sent and settled when the answer arrives (so many batch jobs cannot overshoot the machine-wide day, job or total caps), an unknown price stays unknown instead of becoming $0, the results URL is fetched (with the key) only from the API's own host and ids are URL-encoded, request bodies are dropped from memory once sent, a batch is cancelled when it expires locally, the batch id and request id are saved on the job, `--batch` is kept on resume, whether a job is batched is decided once, a batch job that would have been sent as an ordinary request fails instead, `privateData` jobs are never batched, and the manifest `batch` field is validated.

## 1.72.0

- Local brain (Phase 14b). dev2's model, reached like `dev2chat` (ssh tunnel, key read over ssh and kept in memory), as a free helper for the runner: `swarm think "QUESTION"` (proposer and critic, top 3 with reasons), `swarm digest <file|run-id|->` (15 lines or fewer), `swarm draft docs|pr|plan "BRIEF"` (local draft, Haiku polish for projects that are not sensitive), and `swarm brain status|stats|test`. Autopilot triages failed jobs before retrying (`needs-human` becomes a blocker; only the verdict is used), and `swarm run` pre-flights jobs for Claude or Opus (warnings only). Workers never touch it. See [local brain](docs/local-brain.md).
- Rules: queue of 1 to 2; output is untrusted text (sanitized, capped, never instructions); a sensitive project is never sent to Haiku (the brain says "unavailable" instead); secret and protected paths and symlinks out of the project are refused; every call records the orchestrator tokens it saved in `.swarm/project/brain-ledger.ndjson`.
- Configure it with `localBrain` in the machine config; without it only the Haiku fallback exists.
- A Claude Opus review found 2 high and 9 medium issues, all fixed: `think` ignored project sensitivity (it could reach Haiku in a sensitive project), a request with no sensitivity stated is now treated as sensitive, autopilot no longer re-triages a run whose triage blocker is open, links to secret or protected files are refused, `draft --out` is checked before any model call and cannot leave the project, an abandoned request no longer pays for the fallback, digest input is redacted first, triage sensitivity is per job, an ssh target that looks like an option is refused (and `--` precedes it), pre-flight stops after a minute, and the fallback records the worst case when a reply carries no usage.
- Also from the Phase 14 review (missed in its changelog): cached prompt tokens count in a job's token total, a failed save no longer becomes an unhandled rejection, repo identity is cached only when git answered, output overlap is compared in one normal form, and compact state applies only to `state.json`.

## 1.71.0

- Throughput (Phase 14). A profile-driven pass: 2,000 stub API jobs now run in about 7 seconds with 177 MiB of memory (before: over 10 minutes), and 1,000 requests can be in flight at once in 148 MiB (before: never more than 4). The causes: API jobs took a local host slot, the machine-wide lane file was re-read and re-probed constantly, every in-flight job polled the cancel file, the output-overlap check was quadratic, per-job git and live-run scans, and state saves that grew with the run. See [throughput](docs/throughput.md). The concurrency ceiling is now 2048 (was 512).
- Added adaptive lanes: `"adaptive": true` lets a lane find its own limit (start low, one more slot per window of successes, halve on a 429, never below `min`).
- Added `cacheContext` for the Anthropic lane: shared context files go first in their own prompt-cache block, so a big fan-out pays full price for them once.
- Added `bench/throughput/stress.mjs`, the stress harness behind these numbers.
- A Claude Opus review of this phase found 2 high and 6 medium issues, all fixed: a save requested in the same turn the writer quit could be lost, cached prompt tokens now count in a job's token total and the pre-request cost bound and reservation price cache writes at 1.25 times, a failed save no longer becomes an unhandled rejection for callers that do not wait, repo identity is cached only when git answered, output overlap is compared in one normal form (case, `./`, trailing slash), compact state applies only to `state.json`, and a lane's default adaptive start respects its `min`.

## 1.70.0

- `swarm init` v2 (Phase 12). It now writes a **project profile** into `.project-swarm.json`: the stack, whether the project is sensitive (asked once at a terminal, default sensitive without one; `--sensitive` / `--not-sensitive`), **protected paths** that no job may write (detected `.env`, `secrets/`, keys and certificates, plus `--protect PATH`), a default budget (`--max-usd`, `--max-tokens`), and the **base check**: the project's own checks run once at init and recorded, so old failures are not blamed on workers (they run only with `--base-check`, or after a terminal confirms the listed commands, with a small environment; `--no-base-check` skips them). Running init again keeps the owner's answers.
- Added the **repo map** (`.swarm/project/repo-map.json`): files with their exports, imports (the import graph), external packages and test-to-source links for JS/TS, Python, Go and Rust, refreshed incrementally (unchanged files are reused). `swarm map` builds or refreshes it and prints a summary; `init` and `plan` keep it fresh.
- A Claude Opus review of this phase found 5 high and 9 medium issues, all fixed (protected paths are also blocked as job context unless the owner writes `allowProtectedContext` with a reason on that job, and symlinks are resolved so a path that really points at a protected file or outside the project is refused): a broken profile now fails closed, the pointer and checks file are protected, the check runs on the final manifest and again at integrate, the base check is opt-in and runs in its own process group with a scrubbed environment, init writes never follow symlinks, and the repo map bounds its patterns and never reads symlinks or devices.
- `swarm go "<goal>"` and `swarm "<goal>"` now accept goals that mention paths (`fix docs/a.md`): a sentence is a goal; one token with a slash or ending `.json`, an existing `.json` file, or a run id is not.
- Added `swarm init --check`, a read-only health check of the setup (pointer, version, profile, checks, base check, map, ignores, agent pointers); it exits 1 only on a failure and leaves no journal line.
- `validate`, `run` and lead child manifests refuse a job that writes or deletes a protected path (`protected-path`). `go` and `plan` use the profile's budget when no flag is given, plan lead jobs as `sensitive: false` when the profile says so, and show a `base-red` risk when the recorded base checks fail. The first run of `swarm go` in a new project initializes it without running the checks or building the map.

## 1.69.0

- Added plan preview and approval (Phase 11). `swarm plan "GOAL"` shows the leads and scopes, the job count, the lanes, estimated cost, time and peak concurrency, and risks, saves the plan, and runs nothing. `swarm go "GOAL"` prints the same preview and asks `Run? [y/N]`; `--yes` skips it, and with no terminal `--yes` also needs `--max-usd`. `swarm go --plan ID` runs exactly the saved plan (refused if the repo moved, `--accept-stale` overrides, or if the file was edited). After a run the estimate is shown beside the actuals and fed back into later estimates. See [plan-preview](docs/plan-preview.md).
- A saved plan runs once, is checked against a hash of its manifest, goal, flags and HEAD, and its preview is recomputed at approval; caps on `go --plan` can only tighten the saved ones; paid lanes the preview cannot price are flagged. A Claude Opus review of this phase found 4 high and 8 medium issues, all fixed.
- Fixed `swarm go "GOAL"`, which had never run for real (only against stubs). A real run on a throwaway repo found six faults, each fixed with a test: a lead was never told which files its scope holds (it cannot read any), so it planned folders instead of files; the lead prompt now lists the tracked files and says outputs are exact file paths; a lead that wrote a sentence in `report` made the child manifest invalid (it now means "short"); API-lane child jobs were given the CLI "finish with one JSON line" instruction, which made a small model leave its files out of the envelope; empty or untracked top-level folders became lead scopes the lead could not see; and a worker that also returned a file it was not asked for stopped integration (`dropped-writes`), so `go` now drops those files, goes on, and lists them as `droppedWrites`. Estimates are only recorded from completed runs, and the actual cost is the sum of the child jobs.
- `.swarm/` no longer counts as uncommitted work when `go` checks the working tree (untracked `.swarm/` entries only).

## 1.68.0

- Hermes (Qwen3.8 Uncensored IQ3_XXS on dev2) is now on the `docs` and `test` routes, after Anthropic (`docs`: anthropic, hermes, cursor, codex; `test`: codex, anthropic, hermes, cursor). It scored 8/10 in two lane benchmark runs at one job at a time, which was the bar; `build`, `fix` and `review` still never use it, and `research` still starts with it. The Hermes lane default is now one job at a time (was 3).

## 1.67.0

- Added human jobs and the inbox (Phase 10c). A manifest job `{ "id", "type": "human", "title", "steps": [...] }` is a task only the owner can do. The run finishes every job that does not depend on it; the jobs that do wait in `.swarm/project/human-jobs.json`, and autopilot starts them once every human job in the group is done and the run that held them is integrated. Nothing is spent while they wait.
- Added `swarm inbox [--json] [--all]` (what waits on you, most-blocking first, with the steps and the command to close each item; `--all` adds the projects in `.swarm-projects.json`), `swarm done ID`, `swarm decision "TEXT" --choice C [--option O]... [--id ID]` (record the default the swarm picked), and `swarm decide ID CHOICE` (confirm it; a different choice adds a backlog goal "Change decision ID to CHOICE").
- Added `swarm backlog` (`add "GOAL" [--paths a/,b/] [--max-usd N]`, `remove ID`). When every live run is waiting on a person or a quota window and nothing is running, autopilot starts the next goal that does not overlap files the waiting runs write, from a clean `swarm/*` branch, inside its budget. A goal with no `--paths` starts only when nothing else is waiting.
- Autopilot can send a macOS notification when a new inbox item would unblock 20 or more jobs, and one daily digest; off unless the machine config has `"notify": true`. It never notifies for an item that unblocks nothing.
- Only one autopilot runs per project: `swarm autopilot` takes a lock file (`.swarm/project/autopilot.lock`, with its PID) and refuses to start while a live process holds it; a lock left by a dead process is cleared.
- Fixed a test of the lane pause that failed on slow CI runners.

## 1.66.0

- Added orchestrator failover (Phase 10b). The runner now keeps a project journal (`.swarm/project/journal.ndjson`) written on every command, with secrets redacted. `swarm brief` prints a briefing of under 4 KB (goal, done, running, what needs the owner, the next 3 commands, the rules); `swarm handoff --to codex|cursor|claude|gemini` prints a paste-ready message; `swarm checkpoint` saves a snapshot; `swarm note` also writes to the journal. `coordination/HANDOFF.md` is regenerated from the journal after every command (a hand-written one is kept as `HANDOFF.previous.md`). `swarm init` now tells every agent to run `swarm brief` at session start, writes `GEMINI.md`, and installs a Claude Code `Stop` hook (in the git-ignored `.claude/settings.local.json`) that runs `swarm checkpoint`. See [failover](docs/failover.md).
- Added `swarm autopilot`, a loop with no model: it integrates finished runs, resumes runs paused on a quota window, retries failed jobs once, and starts the next wave of `.swarm/project/plan.json`. It never merges, deploys, raises a cap or calls a model; cap pauses and second failures become blockers. It fails closed when the journal cannot be read or written, and what it starts keeps the run's spend caps (or `swarm go`'s default).
- Fixed remote hosts, which never ran a job: the runner sent no command, so `swarm-remote-exec` waited forever (only stub transports had been tested). Hermes and Qwen jobs now run on a host that names their CLI in `commands`: one request with the command, message and environment, one reply with the exit code, output and sha256-checked files. `remote-exec` is one self-contained file, runs in a private workspace with the env allowlist, refuses symlinks, secret paths and traversal, limits output size, and kills leftover processes when the job ends. Hosts may set `remoteExec` (absolute path) and the ssh arguments are hardened like the Hermes path. A new test runs the real ssh transport against a real host (`tests/remote-exec-real.test.mjs`, skipped unless `SWARM_TEST_SSH_HOST` is set) and passed against dev2.
- Fixed `swarm run` and `swarm go` refusing every manifest that has an `agent: "auto"` job ("Unsupported API adapter"): the provider check was run on `auto` itself, so the manifests `swarm go` plans could never start. Only the in-process tests had exercised it.
- Fixed `swarm update` running the previous release's installer (the code already loaded), so install steps added by a new release, such as the `swarm` command and the completion file, never ran on the update that introduced them. It now runs the new release's `tools/install.mjs` in a fresh process.
- The `swarm` command run from the shared install now works on the project you are standing in (the nearest folder with `.project-swarm.json` or `.git`), not on the install itself. A folder with `.git` but no `.project-swarm.json` reports "Initialized: no; run: swarm init" for that folder; only outside any git repo does it fall back to the install. `version`, `update` and `onboard` still act on the install.
- Autopilot now integrates only from a clean `swarm/*` branch or a linked worktree that is not main/master. On main/master, any other branch, or with uncommitted changes it adds a blocker and does not integrate.
- A Claude Opus security review of this phase found two high and several medium issues, all fixed: autopilot's limits failing open when the journal could not be read or written, a second hand-written `HANDOFF.md` being overwritten, a shared job folder and symlink-following writes in `remote-exec`, redaction gaps (bare `TOKEN=`, `API_KEY: v`, JSON keys, URL credentials, more token types, `--token VALUE`), forged events from a failed command's output, symlinks letting handoff, checkpoint or journal writes reach outside the project, and retries or waves dropping spend caps.

## 1.65.0

- API workers (Anthropic, OpenRouter, OpenAI, Gemini, Ollama, Lambda) and Hermes/Qwen can now change a large existing file with several edits. Before, only one find/replace per output was allowed, so a bug fix or refactor that needed two changes in one file failed with `edits[].path ... is duplicate` (9 of the 17 failures in the lane benchmark). Edits to one path are applied in order, each `find` must occur exactly once in the file as it stands after the earlier edits, at most 200 edits, and a path is never in both `files` and `edits`. If any edit does not apply the job fails and the file is left as it was (`edit-no-match: <file> (edit 2 of 3)`). Every tool-free worker is now told this rule in its prompt.
- Fixed Hermes and Qwen dropping `edits`: the envelope was validated but only `files` were returned, so a worker that answered with edits was marked complete with no change applied.
- Reran the lane benchmark for the lanes this affects; see `docs/state/lane-benchmark.md`.

## 1.64.0

- Hermes (and Qwen) can run on another machine over ssh. The machine config `cliHosts` names the host and the CLI's absolute path (`{"cliHosts":{"hermes":{"target":"user@host","command":"/path/hermes"}}}`); jobs and `swarm doctor hermes` then run there. The job text goes on stdin. The ssh process gets only a short environment allowlist, agent and X11 forwarding are off, the host key must be known, and no key or `.env` file is copied. Exit 255 fails that job as `cli host unreachable`; a bad `cliHosts` entry fails the job, not the run. A security review (Claude Opus) of this code found a missing allowlist on the doctor path, an ineffective `SendEnv=-*`, an ssh target that could start with `-`, and unpinned host-key and forwarding options; all are fixed.
- Real Hermes prints `Warning: Unknown toolsets: none` on stdout before its first event, which the strict JSONL parser rejected, so no Hermes job could pass. The parser now ignores that exact line for Hermes and nothing else.
- Routing now follows the lane benchmark (`docs/state/lane-benchmark.md`). The cheap order for code is anthropic (Haiku), cursor, codex, with Claude after two failures. Hermes is out of the default order and runs only for `research` jobs (it passed 2 of 10). OpenRouter runs only non-sensitive bookkeeping jobs (outputs must be plain relative bookkeeping paths: no `..`, no absolute path). The router itself now refuses a sensitive job for OpenRouter, OpenAI, Gemini and Lambda, as a second check beside manifest validation; a Claude Opus review of the routing change found that gap. Job type routes: `build`, `fix` and `docs` are anthropic, cursor, codex; `test` is codex, anthropic, cursor; `review` is codex; `research` is hermes.
- Added the lane benchmark harness (`bench/lane-benchmark/`): 10 real tasks from this repo, two each of bug fix, new function, refactor, test-writing and docs, run on every lane and scored by real tests plus a review. First results: Codex, Cursor and Claude 10 of 10, Anthropic Haiku 9, Sonnet 8, OpenRouter 4, Hermes (2-bit qwen3.8) 2. Added to Phase 17 of the plan.

## 1.63.0

- Added a real `swarm` command. `swarm update` and `tools/install.mjs --user` now write `~/.local/bin/swarm`, a small script that runs the shared runner with the node it was installed with. It works in non-interactive shells, so Claude Code, Cursor and scripts can call `swarm` with no setup. A file already at that path that the installer did not write is never overwritten. `swarm doctor all` reports whether the command is installed and on PATH (`swarm-command-missing`, `swarm-not-on-path`); zsh reads `~/.zshenv` in non-interactive shells, so the PATH line goes there. Neither the installer nor doctor edits a shell profile.
- `swarm` with no arguments prints a short status for the project: whether it is initialized, the last run, lanes up and down, today's spend, and the 5 most useful next commands (`--json` for scripts).
- `swarm "goal"` is shorthand for `swarm go "goal"`. Only a single quoted argument with whitespace counts, so a mistyped one-word command never starts a paid run.
- `swarm go` runs `swarm init` the first time in a project. The files init writes are committed as `swarm init` on the go branch, never on the branch you started from.
- Added zsh completion: `swarm completion zsh` prints it, the installer writes it to `~/.project-swarm/completions/_swarm`, and run ids come from `swarm __complete runs`. Add `fpath=(~/.project-swarm/completions $fpath)` and `autoload -Uz compinit && compinit` to `~/.zshrc`.

## 1.62.0

- Added the `anthropic` lane: one-request, tool-free workers on your own Anthropic API credits through the Messages API. The key comes from the Keychain (service `project-swarm`, account `anthropic.api_key`) and is never sent to a worker. Sensitive jobs are allowed. Haiku 5.5 is the lane default, Sonnet 5.5 serves `tier: "mid"`, and Opus 5.5 runs only for a job with `tier: "expensive"`. Spend is capped machine-wide at $500 total and $20 a day, plus $5 a job, checked against a worst-case estimate before each request. Route order is now hermes, cursor, codex, anthropic, openrouter, claude. Auto jobs with `tier: "expensive"` still go to the Claude subscription.
- Cursor workers read `CURSOR_API_KEY` from the Keychain (service `project-swarm`, account `cursor.api_key`) when it is not set, and run with `AGENT_CLI_CREDENTIAL_STORE=memory` so `cursor-agent` never runs `security` or saves a login. The Cursor sandbox also denies `/usr/bin/security` and the Keychain dialog agent, so a worker can no longer raise a macOS keychain dialog.
- `doctor codex` no longer reports a healthy sandbox as broken. Its probe gave the sandboxed `node` stdout and stderr files in the OS tmp dir, which the seatbelt forbids, so node aborted at startup. It now uses pipes.
- The OpenRouter daily cap is $5, down from $25, and can be lowered further in the machine config (`spend.lanes.openrouter.dailyUsd`).
- Remote hosts are checked before any job is placed. A host that fails its ping is left out of the run (`hostsExcluded`, `host-unavailable` warning). ssh exit 255, a refused connection or a missing ssh client takes the host out and the job is placed again on a live host. Any other remote failure fails that one job, and a job with no usable host fails alone with `hosts-exhausted`. Nothing else is cancelled. A host entry can set `"enabled": false` to stay in the config without being used.
- A failed Anthropic job now records its real cost instead of its reservation.
- Added a live 50-job run to [the field report](docs/field-report.md): 50 of 50 jobs completed for $0.34 reported, with cost per tier.

## 1.61.0

- Added `swarm scale`. It runs 500 stub jobs with no model spend, at concurrency 500, in a throwaway repo and prints peak RAM, peak CPU, queue latency, and merge throughput. The measured run is in [the field report](docs/field-report.md). A live 50-job spread across every lane was not measured here: most lanes are not configured.

## 1.60.0

- Added `swarm init`. It links a project to the shared install, detects the stack, copies test and lint scripts and CI checks into `coordination/checks.json`, adds `.swarm/` to `.gitignore` and to an ESLint flat config or `pytest.ini` when that edit is obvious, writes agent pointers, and seeds `coordination/`. See [setup](docs/setup.md).
- Added `swarm go "<goal>"`. A cheap planning step reads the repo's real top-level folders and splits the goal into leads with non-overlapping scopes (`--leads` auto, max 10; `--max-jobs` 25 per lead; `--concurrency` 8). Lane caps still limit how many jobs run at once. The run starts with a budget of $5 and 2,000,000 tokens; `--max-usd` and `--max-tokens` change it. A cap pause names the `swarm resume` command. `go` refuses a dirty tree, does the work on `swarm/go-<runId>`, commits there, and prints that branch plus the rollup. It does not move the branch you were on. A manifest path or a run id still uses the existing `go` command.

## 1.59.0

- Added remote hosts. A manifest or the shared config can name `hosts`: `local`, `ssh` (a `user@host` that already has a host key), or `sandbox` (a command argv). Each host has a capacity. Jobs stay on the local executor unless a host is set.
- A remote job ships its copied workspace, runs there, and pulls back only its declared outputs. The pull is hash-checked. Secret paths (`.env`, `.ssh`, `.git`, and the rest of the reserved set) are not shipped, and the remote environment keeps only `PATH`, locale, `TERM`, `TZ`, and `SWARM_PORT_BASE`. API keys stay on the machine that already has them.
- Each remote host is pinged on a heartbeat. A host is dead after 3 missed heartbeats in a row; one miss leaves its jobs in place. A dead host's in-flight jobs are placed again on a live host, so a mixed local and ssh run still finishes. See [remote hosts](docs/executors.md).
- A sensitive job runs only on a local host, an ssh host, or a sandbox marked `trusted: true`.
- Each remote job has an id. `swarm-remote-exec` exits and kills its child if the connection closes. When a dead host answers again, the runner kills any orphaned ids before reusing it, and counts spend that kill reports.

## 1.58.0

- Added lead agents. A `type: "lead"` job owns an `area` (goal, file scope, job and concurrency caps, allowed agents, budget) and writes only a child manifest. Lead scopes must not overlap each other or any parent worker's outputs.
- The runner validates each child manifest before launching it: every output and delete is inside the lead's scope, job count and concurrency stay within the area, agents are allowed, and the budget stays within the area. Children cannot set checks, shell, network, or another contract, cannot weaken `sensitive`, and cannot contain leads (depth limit 2). Refusals fail the lead with `lead-child-invalid` and launch nothing; sibling leads continue.
- Each child runs as `<parentId>-<leadId>` under the same caps, reservations, ledger, and cancel signal. A parent `--max-usd` or `--max-tokens` can lower a child's area budget but never lift it. A paused child holds its lead (`child-paused`); `resume` on the parent resumes the child without repeating the lead's model call.
- Integrating a parent integrates each child run in order under the one lock, then the parent's own jobs; lead manifest files are never written to the project. Reruns skip already-integrated children.
- Rollups add a bounded `leads` list (one line per lead in text) and `monitor --view` adds a leads line, so the orchestrator reads lead rollups instead of child reports. See [lead agents](docs/leads.md).
- Lane caps and pauses are machine-wide. Every run on this machine — parent runs, lead child runs, and runs in other repositories — shares one lane file next to the shared install (`~/.project-swarm/lanes/lanes.json`, or `SWARM_LANES_DIR`). It tracks each lane's in-flight count and its rate-limit or quota pause, under a lock, and drops slots whose process has died. A 429 or quota pause in one run pauses that lane for all of them. Deleting a project's `.swarm/` does not reset it.

## 1.57.0

- Added spend caps: per-run `budget.maxUsd` / `budget.maxTokens` (or `run --max-usd` / `--max-tokens`) and per-lane daily caps (`spend.lanes` in config; OpenRouter defaults to $5 per UTC day). At a cap the runner stops launching, lets in-flight jobs finish, and holds the rest; the run ends `paused` (exit code 75).
- Daily lane caps are machine-wide. One locked spend store next to the shared install (`~/.project-swarm/spend/daily.json`, or `SWARM_SPEND_DIR`) is shared by every project, and deleting a project's `.swarm/` does not reset it.
- Each job reserves an estimated cost before launch (from `maxCredits` or `maxOutputTokens` times the model rate, or the lane's `reserveUsd`, default $0.50). The reservation counts toward run and lane caps until the actual cost replaces it, so concurrent launches overshoot by at most one reservation.
- A paid job with no reported cost is estimated from tokens × rate, or keeps its reservation as its cost. It is never counted as $0, and the estimate is flagged in the rollup and the ledger.
- Added `swarm resume RUN`: it dispatches exactly the held jobs and their dependents under the same run id and leaves completed records unchanged. Going past a cap needs `--raise KEY=VALUE --reason TEXT`; the runner never raises a cap itself.
- Quota exhaustion now holds jobs until the lane resets. `resume --wait` and `run --wait-quota` run the zero-model idle menu (configured local commands on `idle/<run>/<name>` branches, scrubbed env), wait for the reset, then resume.
- Runs now write the usage ledger automatically (`docs/state/usage-ledger.md` when present, else `.swarm/usage-ledger.md`), one row per attempt without duplicates, and recompute the daily summary. Added `swarm ledger RUN` and `swarm idle RUN`. See [spend guard](docs/spend.md).

## 1.56.0

- Make integration batches crash-safe with atomic journals, automatic rollback on recovery, and SIGINT/SIGTERM rollback of queue writes, including bytes, new files, deletions, and modes.
- Serialize integration and redcheck across every worktree of a repository with owner-recorded locks; clear dead local owners with a warning and refuse live owners with `integrate-locked`.
- Added `integrate --queue` for large runs, with ordered batches and checks per batch.
- Failed queue batches roll back and bisect to keep passing jobs and isolate check failures. Plain integration keeps its existing behavior.
- Conflicting jobs preserve newer checkout content, requeue twice by default, then get one merge job. Unresolved merge jobs are flagged.
- Added merge queue summary counts to `monitor --view` and rollup JSON. See [merge queue guidance](docs/merge-queue.md).

## 1.55.1

- Docs-only Codex and Cursor jobs are now told to edit their declared outputs (the old "read and grep only" wording made a worker refuse to edit).

## 1.55.0

- Sanitized and labeled untrusted worker text in rollups and sanitized monitor cells.
- Added one report-only re-ask for otherwise complete strict jobs before `report-invalid`.
- Added opt-in strict `report: "short"` at manifest and job level, with five-field worker reports and validation.
- Saved valid short reports or derived legacy reports for worker attempts that ended complete, blocked, or failed. Jobs that never ran have no report.
- Added `swarm rollup` for compact JSON or text summaries of status, lanes, spend, changed files, risks, and follow-ups.
- Added lane, queue, merge, and spend lines to `monitor --view`; runs over 40 jobs show a bounded table and a rollup hint.
- **Breaking:** explicit OpenAI, Gemini, and Lambda jobs now require `sensitive: false`, like OpenRouter; refusals use `sensitive-provider` while OpenRouter keeps `sensitive-openrouter`.
- Added `swarm ask --not-sensitive`; sensitive questions routed to OpenRouter, OpenAI, Gemini, or Lambda refuse before any network call with `ask-sensitive-provider`.

## 1.54.0

- Added eight optional job types with prompt guidance and default timeouts.
- Enforced type output rules, including read-only review and research jobs. Docs require documentation extensions or README.txt/CHANGELOG.txt basenames; docs/state/ is blocked.
- Added type-specific cheap routing, with Codex for merge and lead. Remaining cheap lanes follow Hermes → Cursor → Codex → OpenRouter; paused cheap lanes wait. Claude requires two real cheap failures and no cheap candidate, unless the tier is expensive.
- **Breaking:** jobs are sensitive by default. Explicit OpenRouter jobs must set `sensitive: false`; automatic routing also requires it for OpenRouter.
- Attached preset skills when available and reported missing skills as warnings.
- Added [job type guidance](docs/job-types.md) and one example per type.

## 1.53.0

- Raised manifest limits to 5000 jobs and global concurrency to 512; the default remains 2.
- Added per-agent lanes with concurrency caps, optional requests-per-minute limits, backoff, and quota pauses.
- Added `agent: "auto"` routing through configured lane models, with fallback after two failed or timed-out attempts on a lane.
- Added `sensitive` routing protection that excludes OpenRouter and refuses explicit sensitive OpenRouter jobs.
- Prepared workspaces and context lazily at dispatch and coalesced state writes for large runs. Saved state includes lane health, routes, attempts, and rate-limit retries.
- Added [lane configuration and routing guidance](docs/lanes.md), including defaults and override examples.
- Preserved run-start snapshots with lazy preparation; changed copied files fail the affected job with `snapshot-changed` before spawning.

## 1.52.0

- Added the `cursor` worker: `cursor-agent` runs as a worktree writer like codex, under `sandbox-exec` with the codex profile plus its install directory and `~/.cursor`, invoked as `-p --output-format json --model <model> --trust --workspace <worktree> --sandbox disabled --force <prompt>`. See [docs/providers.md](docs/providers.md#cursor-cli-cursor-macos-only).
- The Keychain stays blocked; a cursor job authenticates only with `CURSOR_API_KEY` in an allowlisted worker environment. The key is refused in prompts and argv, redacted from logs and saved output, and a run that exposed it is refused by integrate and ship.
- Cursor jobs fail fast with `cursor-not-installed` or `cursor-not-authenticated`, and `doctor cursor` checks the version and required flags without printing the key.
- Local config `cursor` sets `model`, `timeoutMs`, `maxAttempts` and `allowedPaths`; the codex retry helper now takes `maxAttempts`, and cursor retries only transient transport errors. Documented tiers route `mid` to cursor and `expensive` to codex; automatic tier escalation is not built.
- Worktree-writer gates (worktree use, `testEnv`, `readPaths`, `setup`, `after`, HEAD-only context, uncommitted-file warnings, shell-capable warnings) now cover cursor jobs, and `swarm board` jobs carry their agent so the Cursor lane guard names swarm-run cursor jobs.
- `run` now checks Cursor lane claims before starting workers and refuses conflicts with `cursor-claim-conflict`; `validate` warns. Invalid claims use `cursor-claims-invalid`, and the manual `check-manifest` check is optional.

## 1.51.1

- `ask` runs a named CLI agent (e.g. `--tier cheap` or `--agent codex --model gpt-6-luna`) directly as a read-only job with no outputs when no read-only fallback is configured (no matching tier, or a tier without `fallback`), with an `ask-agent-direct` warning and `route.direct: true`, instead of refusing with `ask-agent-fallback-unconfigured`. A configured but malformed fallback still refuses. (lesson 417)

## 1.51.0

- Added the Cursor lane guard with advisory file claims in `coordination/cursor-claims.json`: `claim` before work, `check` before merge, `release` after merge, `check-manifest` before a swarm run, and `list` to inspect claims. See [docs/cursor-lane.md](docs/cursor-lane.md).
- The guard falls back to the sibling `swarm.mjs` when a project has no `.project-swarm.json`; a present pin whose install is missing still fails.

## 1.50.0

- Vendored five worker skills from `mattpocock/skills` under the MIT License, pinned to commits `6fd947921b935b7e1e69293a200400f0fdd5c15f` and `153fc1b93de6584562765cdce299324e1ff9e661`; `installProject` copies each skill only when absent and keeps an existing skill untouched.
- UI changes now require or warn for preview-harness coverage of affected rendered views, and validation identifies uncovered UI roots. (lesson 362)
- Base checks whose only named tests are absent declared outputs are reported as pending rather than red. (lesson 363)
- Jobs that do not own changelog or version files receive explicit ownership guidance and do not block on those files. (lesson 364)
- Session metrics report follow-up rework by skill and mark red rate as not applicable when integration checks are empty. (lesson 365)
- Test suites isolate provider-limit caches and global paths under per-test temporary homes and guard against real-home access. (lesson 366)
- Monitoring reports idle seats, runnable unblocked work, and the hand steps associated with idle gaps. (lesson 369)
- Version-bump jobs discover tests asserting the old active version and require the full suite as their release check. (lesson 371)
- Ship records each failing test block with its name, location, and assertion and reruns only failed local files when requested. (lesson 372)
- Validation reuses live output-conflict checks and reports both conflicts and the subset of jobs that can start; run accepts that subset. (lesson 374)
- Note resolves task and handoff files under the configured coordination directory, while invalid lesson areas list allowed values. (lesson 375)
- Job-level contracts are normalized, null tier reasons are ignored, and sibling outputs in context are reported as pending. (lesson 377)
- CI checks expand shell globs and branch shipping infers head and base from the selected branch and default branch. (lesson 378)
- Validation warns when identifier-like mechanisms named in a brief or prompt are absent from the repository. (lesson 379)
- Integrated-tree audits block undeclared edits and rerun each job's reported check against the integrated tree. (lesson 380)
- Local checks ignore swarm scratch copies and warn when check output cites a scratch path. (lesson 381)
- CI failures after a zero-failure test summary are classified as timeouts and the failed job is retried once. (lesson 382)
- Existing safeguards already cover lesson 370.
- Existing safeguards already cover lesson 373.
- Existing safeguards already cover lesson 376.

## 1.48.0

- Read-only ask follows a selected configured tier and reports ask-agent-fallback when an unsupported route uses its configured fallback. (lesson 357)
- Prompt path validation accepts carried directories and matching globs while retaining missing-workspace refusals. (lesson 358)
- Held summaries warn decision-value-not-in-diff for values absent from added diff lines; the contract template records decision-fixed constants and pinning tests. (lesson 359)
- Integration refuses work-folder-reference in changed source and test files; validation warns work-folder-context for build scratch data. (lesson 360)
- The note command appends real UTC timestamps to task or handoff files without executing note text. (lesson 361)

## 1.47.0

- `check-pins --core` reports `vendored-core-missing-runtime-wheels` when a vendored core requirement is neither vendored nor a direct dependency. (lesson 343)
- The shared contract template records the accepting rule for externally validated values; scheduler-specific resource validation remains with its consumer. (lesson 345)
- Document the existing human-review hold and three-field handoff; green checks do not authorize a held merge. (lesson 348)
- Codex jobs can use `scope: "open"` with `outputDirs` for bounded tracked-file edits; `narrow-output-scope` warns about underspecified restrictive prompts. (lesson 351)
- `doctor` reports missing executables from an optional toolchain inventory and displays reinstall guidance without executing it. (lesson 352)
- Codex prepares narrow Vite cache write grants; preflight reports `vite-temp-not-writable` before dispatch. (lesson 353)
- `ship --rerun-flaky-ci 1` permits one retry after three verified local passes and a base pass, recording a flake only after fresh CI succeeds. (lesson 354)
- Mutant review warns `redundant-writer` about another call that may preserve the mutated effect. (lesson 355)
- Worktree jobs now default outside the repository root; `worktreesOutsideRoot: false` preserves the in-root layout, and recorded legacy paths remain readable.

Design-only Codex jobs are told to read and grep without tests or installs; sandbox test failures do not block them. (lesson 356)

## 1.46.1

- Claude `provider-limit` classification uses provider error events or standalone diagnostics on a failed exit; limit strings quoted from context files remain worker data. (lesson 347)
- `integrate` reports parsed result keys, source and text on skill-check failures; result-shape mismatches warn when all outputs exist, with `--accept-result-shape` for explicit acceptance. Debugging attaches only for fix prompts or an explicit manifest skill selection. (lesson 349)
- `ship --branch` refuses `branch-not-ahead` before checks when no commits are ahead of its base; `clean-branch --from REF --exclude GLOB` stages a rename-aware copy including additions, modifications and deletions on a clean destination. (lesson 350)

## 1.46.0

- `resultKeys missing` refusals (at dispatch and at integrate) now name the skills source directory, why the skill attached (`manifest skills list` or the matching `paths:` glob), and how to run without the skill; `attachSkillsForJob` exposes this via a new `attachedBy` field. (lesson 199)
- `run` refuses with `no-commits` when the project's HEAD is unborn (no commits yet) and the run needs one (base checks, or a codex / claude-shell worktree job), naming `git commit --allow-empty` instead of surfacing git's own raw error; a copied-workspace run without checks still runs as before. (lesson 199)
- `run --accept-red-base --reason` now records `acceptRedBase`, `acceptRedBaseReason` and `baseCheckFailures` in the run's state; `inspect` (not `status`) reports them when present. (lesson 199)

## 1.45.0

- Config `worktreesOutsideRoot: true` (default off) places codex and claude-shell job worktrees in a per-run scratch dir outside the repository root (`<scratch root>/worktrees/<repo>-<hash>/<run>/<job>`, override with config `worktreesDir`), so root-level lint, test and search tools never see swarm copies; `run` skips `swarm-dir-not-ignored` when it is on. (T86, lesson 330, decision #345)
- `state.json` records each worktree job's real `worktreePath` before checkout; `inspect`, `integrate`, evidence and the no-JSON fallback read it through one `resolveWorktree` helper, and a run without the field still resolves `.swarm/runs/<id>/worktrees/<job>` (compatibility shim, removed one release after the default flips). `inspect` shows `worktree` for kept worktrees. (T86)
- Checkout outside the root refuses with `worktree-disk-low` under 256 MiB free; `swarm orphans` lists scratch worktree dirs no run state points to and never deletes them. (T86)

## 1.44.1

- lesson add never fails on a malformed legacy markdown row: the legacy table is parsed only for the next id, a parse failure falls back to a regex scan of the ids and surfaces as warning legacy-table-unparsed (field lesson #346).
- validate names the nearest known job field when a manifest uses an unknown one, for example editOutputs → outputs (field lesson #344).

## 1.44.0

- `scaffold job --command` adds command handler modules to context; `validate` warns `command-handler-not-in-job` when a command named in a job prompt has a handler in neither context nor outputs. (lesson 327)
- `integrate --accept-blocked` excludes a blocked job's unwritten outputs, and `integrate --jobs` unselected jobs' outputs, from missing-output and undeclared-delete checks; a blocked job's written outputs still integrate, and one with no writes contributes no files or refusals. (lesson 328)
- `ship` and `integrate` strip check-output lines whose paths start with `.swarm/` from pass/fail decisions and report one `check-hit-swarm-dir` warning with the count; `run` warns `swarm-dir-not-ignored` once when the root eslint/vitest/pytest config never names `.swarm`. Job worktrees stay under `.swarm/runs/<id>/worktrees/`. (lesson 330)
- `ship` preflight reports `git-ignored-fixture` only for referenced paths that exist and are git-ignored; absent runtime paths are exempt, and `--exempt git-ignored-fixture:<file>=<reason>` remains available. (lesson 331)
- `validate` warns `max-output-below-model-default` when an API/OpenRouter job explicitly sets `maxOutputTokens` below its model default, naming both values, from the same default table the API adapters use. (lesson 332)

## 1.43.0

- `integrate RUN --jobs <id,...>` now accepts named jobs through the CLI, with either value form before or after the run id. (lesson 324)
- `validate` refuses oversized existing single-request API outputs with `output-cap-exceeded`; job `outputCapBytes` or config `outputCap` override the 61440-byte total and 15360-byte per-file defaults, while shell agents remain exempt. (lesson 325)
- API requests record the last provider `finishReason` in job state, including length retries; `inspect` reports it for incomplete jobs. (lesson 325)
- `lesson import --dry-run` previews lenient imports and private-row skips without writing; `--verbose` adds per-row verdicts. (lesson 326)

## 1.42.0

- `ship --wait-required-only` waits for protected required checks while optional checks continue; ordinary ship and unprotected branches retain the full wait.
- `ticket` runs the guarded run, inspect, integrate, checks, bounded commit, and ship stages with a durable resume journal.
- Shell worktrees link dependencies read-only or prepare isolated environments with `run --sync`; missing check environments refuse instead of counting as pre-existing failures.
- Shell adapters retain streaming evidence, inspect shows failed stderr tails, and Codex retries one transient connection failure only before any output changes.
- `scaffold job` validates context coverage and `scaffold pr` creates reviewable payloads whose mutation stub refuses required-section shipping.

## 1.41.0

- `lesson add` captures clock-stamped, private-safe lessons and routes rules into existing skills or gotchas with an 800-token skill cap.
- `lesson list` / `lesson set` track lifecycle, version, and regression coverage; `run` warns about queued lessons.
- `lesson manifest` emits a validated bounded fix with its regression test; `lesson check` reports stale queued lessons and missing installed tests.
- `lesson publish --version V` appends safe shipped entries idempotently; `lesson import` preserves legacy ids and dates without duplicating rows.

## 1.40.0

- `integrate RUN --jobs <id,...>` integrates only the named complete jobs (and refuses with a message mentioning `--jobs` when a partial run is integrated without the flag), enabling batch runs where individual jobs can be integrated separately as they complete. (lesson 298)
- `validate` now fails when an API job's declared outputs exceed its `maxOutputTokens` cap, estimated at ~500 tokens per output file. (lesson 294)
- `validate`/`integrate` now refuse outputs under `shared/`, `fixtures/` or `tests/` containing terms from the private-names file (same list as the #254 DeepSeek guard). (lesson 293)
- When the OpenRouter/API adapter rejects a structurally invalid envelope, the raw reply is now saved to `.swarm/runs/<id>/<job>/response-invalid.txt` for diagnosis. (lesson 296)
- `tests/_isolate-config.mjs` now honours `SWARM_TEST_TMP` (or `TMPDIR`) for creating its test temp directory, enabling codex jobs to run tests in a sandbox-writable workspace. (lesson 299)
- A codex job now gets a per-job scratch directory created outside the repository; the sandbox profile grants it in both raw and realpath forms (covering macOS's `/var` -> `/private/var`) plus ancestor file-read-metadata grants so the job's own upward directory walk can resolve it, with `TMPDIR`/`TMP`/`TEMP`/`SWARM_TEST_TMP` exported into the job's environment and the directory cleaned up afterward unless `SWARM_KEEP_TMP=1`. (lesson 308)
- The batch-y integrate test fixtures now mirror the real run layout (job state under `.swarm/runs/<id>/<job>/`, real outputs under `.swarm/workspaces/<id>/<job>/`) with `baseHashes` computed as real sha256 digests of the fixture's committed bytes, instead of placeholder values that only happened to work by coincidence.

## 1.39.0

- `ship --preflight`: every pre-push content guard runs in one pass and reports all failures (E2)
- A new top-level manifest `resources` (at most 50 file paths) names a file that should be copied
  into every job's own workspace/worktree even when it is untracked; `validate`/`run` now refuse
  `resource-missing: <path>` for a declared one absent from the repo root (`resource-is-directory:
  <path>` for one naming a directory) and refuse `prompt-path-not-in-workspace: Job <id>'s prompt
  names <file>, ...` when a job's own prompt names a real, on-disk repo-relative path covered by
  neither tracked files, this job's own context, nor `manifest.resources` — the 281 incident spent
  real shell-job dollars discovering a missing path only after the worker had already started.
  (lesson 281)
- A job may now declare `privateData: true`, withholding its own transcript (`response.txt`) and
  failure log (`agent.log`) from disk (a fixed placeholder text is written instead; `inspect` shows
  `transcript: "withheld"`); a new local config `privateData.paths` (glob list) now refuses
  `privateData-required: Job <id> touches a configured private path without privateData: true`
  before such a job ever dispatches. (lesson 282)
- `validate`/`run` now refuse `<skill>: resultKeys missing <key>` before a job ever dispatches when
  its own prompt's declared final-JSON shape (`Return JSON only, ...: {...}`) omits a key an
  attached skill's own `checks.resultKeys` requires, closing the gap where only `integrate` caught
  this — after the job had already spent. (lesson 283)
- `templates/coordination/CONTRACT.md`'s own `## Release` section now names `ship --preflight` and
  `swarm squash --branch` directly, instead of a batch rediscovering either by hand; no code change
  (both already exist). (lesson 284)
- A tool-free API job with `outputs: []` whose prompt plainly asks for real written content now
  refuses `openrouter-empty-outputs-content: Job <id> has outputs: [] but its prompt asks for real
  content; ...` before any request is ever sent; a truncated OpenRouter response's own error now
  names the prompt's size (`... (prompt <n> chars)`). (lesson 285)
- A plain `claude` job whose own CLI prints a weekly/usage/rate-limit message instead of
  stream-json now resolves job status `provider-limit` (naming the reported reset time) instead of
  a generic `Worker exited N`; `run`/`ask` now refuse `claude-provider-limit: resets <time>; pass
  --ignore-provider-limit to proceed anyway` for any further claude job until that time, and
  `board` reports the same marker. (lesson 286)
- A shell job's sandbox now grants write access to a linked-worktree project root's real git dir
  (its `gitDir`/`commonDir`), so a worker's own `git commit` there can actually succeed; `validate`
  now warns `linked-worktree-commit: Job <id>'s prompt asks it to commit; ...` when a shell job's
  prompt asks it to commit against such a root. (lesson 287)
- A codex job's own prompt now carries a waiver for any doc its repo's own AGENTS.md names that is
  not shown inline, in its declared context, or under `.swarm/skills` — it no longer needs to
  refuse over a read it was never going to be denied; a root `AGENTS.workspace.md`, when present,
  is now inlined directly into every codex prompt; `validate` now warns
  `codex-required-read-missing: Job <id>: AGENTS.md names <file> (tracked), not in this job's
  context` for a tracked AGENTS.md doc a codex job's own context omits. (lesson 288)
- `swarm ship --preflight` is now accepted by the CLI parser (it was only reachable from `ship()` directly)

## 1.38.0

- The default shell job scratch base (`SWARM_SCRATCH_ROOT`, else the existing `SWARM_INSTALL_ROOT` override, else `XDG_STATE_HOME`) is now `~/.project-swarm-scratch`, never `~/.project-swarm` (the install checkout itself, which can carry its own `.git`); `version --check` now proves this at install-check time, reporting `scratchOutsideRepo: true|false` (and, when false, `scratchRoot`) instead of only ever surfacing it on a shell job's first refusal. (lesson 280)
- `validate`/`run` now scan a manifest's own `contract` file and every job's `prompt` against the configured private-names list, for a repo `gh` reports public, refusing `private-term-in-contract: <file>:<line>` or `private-term-in-prompt: job:<id>:<line>` before any job ever dispatches (the term itself is never printed); a non-public repo is skipped, matching the existing diff-scan rule. (lesson 262)
- The shared `templates/coordination/CONTRACT.md` now asks for one test per evaluator/gate that feeds real vendored data and asserts the attack/violation path actually ran, plus a standard "treat every case as clean" mutant for every evaluator/gate a batch adds or changes. (lesson 264)
- `validate`/`run` now warn `protected-checkout-live-service: <root> has a live rig service on port <port>; never run git checkout/reset/stash here by hand — worktrees only` when a root's configured `rig.portFile` names a live rig service, the nearest hook for never changing HEAD in a live checkout by hand. (lesson 265)
- `validate` now warns `model-route-no-smoke-test: ...` when a job changes a file that looks like a model/provider route with no declared check named (or whose argv contains) `model-route-smoke`/`streaming-smoke`; `ship` separately refuses `model-route-verification-missing: ...` when a changed file matches an explicit, configured `modelRouteFiles` list and the PR body carries no `## Model verification` section. (lesson 266)
- `integrate --mutants` now also warns `mutant-missing-for-comparison: <file>:<line>` for a new or changed comparison-operator line with no mutant covering it, catching a second uncovered comparison on an already-covered file that the existing per-file warning could not. (lesson 267)
- `integrate --mutants` still reports a mutant `killed` on the unambiguous exit-1 test-failure most runners (pytest/vitest/jest/mocha/node `--test`) share, and now also on `cargo test`'s exit 101, but only once that ambiguous exit's own tail carries a real failure line (`cargo build` failures share the same exit 101, and are now reported `invalid-build` instead); an invalid mutant (its `find` did not match exactly once) is now reported `invalid-find`, distinct from a build failure; a formatter step that rewrites a mutant-target file's bytes before any mutant runs now warns `formatter-changed-mutant-target: <file>`. (lesson 274)
- `ship` now reads every green check run's own full log (never `--log-failed`) and warns `slow-new-test: <test id> <seconds>s` when a test this PR itself added used more than a configured share (default 30%) of the per-test CI timeout, configurable via local config `ci.perTestTimeoutSeconds` or a new `ship --per-test-timeout SECONDS` flag. (lesson 273)
- `--accept-pre-existing`'s own base re-run is now scoped to just the failing tests' own files once the whole check argv fails to produce a readable verdict on the throwaway base worktree, so a base that cannot run its full suite can still be verified for those tests specifically; the PR's own Checks section now names the exact test ids a `pre-existing` verdict was reached for. (lesson 275)
- New `swarm squash --branch BRANCH [--base REF]` resets a branch's index to its own merge-base with `origin/main` (never a moved main), refusing `squash-unexpected-files: <files>; undone, nothing committed` (and undoing itself) when the newly staged diff names a file the branch never touched at that merge-base; it only stages, printing the file list, and never runs `git commit` itself. (lesson 276)
- New local config `spend.dailyCapUsd`/`spend.warnUsd`, summed over every configured root's runs since 00:00 UTC (a rolling boundary unaffected by the process's own local time zone): `run`, `ask` and `scout` each print `spend-warn: today's spend $<n> >= warn $<n>` at warn and refuse `spend-cap: today's spend $<n> >= cap $<n>; pass --over-cap --reason TEXT to proceed anyway` at cap (scout's own per-sweep cap stays a separate, additional limit); `board` now also reports today's total. (lesson 277)
- A claude shell job's sandboxed `UV_CACHE_DIR` now points at the real, shared, already-warm uv cache under the real machine home (`~/.cache/uv` on Linux, `~/Library/Caches/uv` on macOS, already covered by the sandbox's existing read grants) instead of a fresh, empty, per-run directory, so an offline `uv lock`/`uv sync` inside the sandbox can actually find its registry metadata. (lesson 278)
- `ship --rerun-flaky`'s own default (one automatic rerun, applied only when the flag is absent) now also applies when every failing test's own file is one this PR never touches, warning `rerun-flaky-default: 1 (file-not-in-diff)` (alongside the existing `platform-only` variant); a per-repo flake log (`.swarm/flake-log.json`, hits counted only within a rolling 14-day window) now warns `flake-repeat-offender: <file> (<n> hits); dispatch a fix job` on a second hit, and is never written for a failing test whose file the PR's own diff already touches. (lesson 279)

## 1.37.0

- A shell job's own scratch directory (its `TMPDIR`/`HOME`) now lives under a per-run directory of the swarm install root (`~/.project-swarm` by default, honoring `SWARM_INSTALL_ROOT`) instead of the OS temp dir, which the reopened lesson found can itself still land inside, or be refused by, a git-aware path check; the existing upward `.git` scan stays as a defensive assertion, layered over both the OS temp dir and the new base. (lesson 263r)
- `run` now auto-accepts a red base (no `--accept-red-base` needed) when every failing check's own failing location is already covered by this run's own declared outputs, warning `red-base-auto-accepted: ...` instead of silently passing; `inspect` now runs a collect-only preflight (`node --check`, or `python -m pytest --collect-only -q` when pytest is on PATH) against a file-only job's own proposed test-file output, warning `collect-only-failed: <job>: <file>: <line>` on a bad import or `collect-only-skipped: <job>: pytest not on PATH` when it cannot check. (lesson 268)
- A worker's own reported `deviations` array may now hold a plain string, not just a `{contract, did, why}` object; `integrate`'s refusal and accepted-deviation record, and `inspect`'s own warning, all render a string deviation as its own real text instead of an empty or char-indexed value. (lesson 269)
- `inspect`/`integrate` no longer report a false `dropped write` warning for a worker's own self-reported path that carries a trailing `:line` or `:start-end` reference (e.g. `src/x.py:1009`); it is normalized to its bare path, same as an output the job actually declared, before being compared. (lesson 270)
- A dropped write (a workspace/worktree edit outside a job's declared outputs) is now saved to `.swarm/runs/<id>/dropped/<path>` (plus a diff alongside it, when a base copy exists) the moment it is detected; `integrate` now refuses a run with any unaccepted dropped write (`dropped-writes: <job>: <path>`) unless `--accept-dropped` (proceed without it) or `--salvage-dropped` (apply it from where it was saved) is passed. (lesson 271)
- `ship` now refuses (`test-reads-git-ignored-path: <file> -> <path>`) when a test file's own added lines reference a path git would refuse to track (a fixture dropped under a `.gitignore`d directory), unless `--exempt git-ignored-fixture:<file>=<reason>`; `inspect` warns the same way (`git-ignored-fixture: <job>: <file> -> <path>`) instead of refusing. (lesson 272)

## 1.36.0

- A worker result may now report `deviations: [{contract, did, why}]` for a contract MUST it could not meet instead of silently substituting a design; `inspect` warns `contract-deviation: <job>: <contract>` for each, and `integrate` refuses a run with a non-empty `deviations` list unless `--accept-deviation` is passed, which then logs the acceptance in the integrate result. (lesson 256)
- `templates/coordination/CONTRACT.md`'s "Tests" section now requires one test that forces a new platform-bound dependency's (keychain, OS API) backend to fail on a startup path and proves startup still succeeds, built to be constructed lazily via a factory. (lesson 257)
- `ship` now scans every commit it would publish (`origin/<base>..HEAD`, not just the cumulative diff) for a configured private term in that commit's own added lines or message, refusing `private-term-in-commit: <sha7>` before any push when found — a term added then removed within the same branch used to slip through the existing cumulative-diff scan entirely. (lesson 258)
- `ship`'s result for a PR whose body is held (`isHeld(body)`: first line starts with `**needs `) now carries `reviewNote: {changed, couldBreak, proof}` (the Summary's first two bullets, the Could break section or `FILL IN before sending`, and the Mutation check's first line plus the PR URL), also printed to stderr as three lines after the merge-or-hold decision. (lesson 259)
- `inspect` now warns `self-report-contradiction: <job>: <check>` when a job's own `checksRun` entry says `passed` for a check while the result's own text still names a nonzero fail count for it. (lesson 260)
- `validate`'s `check-path-missing` warning now fires only for the program a check's own argv actually invokes (after any `env VAR=...` prefix, with `npm` also implying `node`), instead of every program on the orchestrator's own PATH. (lesson 261)
- A shell job's own `TMPDIR`/`TMP`/`TEMP` now always point at that job's own scratch directory (already granted by the sandbox profile), so a worker's own `fs.mkdtemp(os.tmpdir())` tests run inside the sandbox; a non-shell job's env is unaffected. (lesson 263)

## 1.35.0

- New optional `swarm verify --orb [--scenario NAME]` step a frontend job can name in its own `checks`: serves that job's own `tests/fixtures/verify-orb/` fixture (a static page plus a tiny `fake-service.mjs`) and runs a saved `tests/orb-scenarios/<name>.json` scenario (selector/text assertions, optional screenshot), driven by Playwright in the toolchain's own Chromium, resolved only from `~/.project-swarm/toolchains` (Playwright + pinned Chromium copied in directly, decision #249) — never a system Node or PATH-resolved npx. The orb token (`SWARM_VERIFY_ORB_TOKEN`) is generated fresh per run and reaches the spawned worker only via that env var, injected into the page context via Playwright's `addInitScript`, never a file. Not wired into `swarm ship` or CI. (T52b, decision #262)

## 1.34.0

- A claude job that ends `api_error` with status 5xx or 429 is now retried once, over its own kept workspace, with a continuation note (`retries: 1`, `retryReason: "api_error <status>"`); `integrate --salvage` now also accepts a `failed` run whose failure is `api_error` and whose kept workspace has output changes. (lesson 248)
- A job's `costUsd` is now estimated from its own provider.jsonl transcript (summed usage over unique assistant message ids, output tokens estimated from content size when the stream's own count is partial, at a fixed per-model USD/MTok rate) whenever it ends with no reported cost, marked `costSource: "estimated-from-transcript"`; an unrecognized model warns `cost-rate-unknown: <model>` instead of guessing a rate. (lesson 252)
- `run` now runs a manifest's own `checks` against the committed base first (cached by base sha in `.swarm/base-checks/<sha>.json`) and refuses to dispatch onto a red base unless `--accept-red-base` is passed with `--reason`; `integrate` now labels each failing check's `failures[].origin` `pre-existing` or `new` by re-running it against the base. (lesson 253)
- `ship` now holds (status `held-red-check`, no merge, naming the failing test ids) on a check whose failure also reproduces on the base, unless `--accept-pre-existing` is passed; `validate` warns `check-path-missing: <check>: <prog>` when a check's own `env PATH=` omits a program (gh, git, node, npm, uv) the orchestrator's own PATH has. (lesson 254)
- `validate` warns `shell-python-no-setup: <job>` for a shell job whose checks or prompt run python/uv/pytest with no `setup` step declared; `inspect` warns `interpreter-outside-workspace: <job>: <path>` when a job's own reported test-run interpreter names a path outside its workspace. (lesson 255)
- The claude/codex shell sandbox profile now denies file-read and process-exec under `/private/tmp`, `/tmp` and `$TMPDIR` except a job's own scratch directory and the swarm's own temp files, so a shell worker can no longer read or execute another checkout's toolchain by searching the disk for one. (lesson 255)

## 1.33.0

- `inspect`/`integrate` no longer report a swarm-seeded file (e.g. a worker-skill copy under `.swarm/skills/**`) as a dropped write unless its content no longer matches what was actually seeded, comparing by path and content hash instead of reporting every seeded path a job never wrote. (lesson 244)
- `integrate --mutants` (and validation of a run's mutants sources, including a job's own `mutantsFile` output) now warns `mutant-missing-for-changed-file: <file>` for each changed non-test source file under `tools/` or `src/` with no mutant covering it. (lesson 245)
- `templates/coordination/CONTRACT.md`'s "Tests" section now requires naming where blocking I/O now runs (a worker thread vs. the event loop) when code moves it into or out of `async` context, plus one test that a concurrent task keeps running. (lesson 246)
- `--checks-from-ci` now skips a CI-only step (its run line or job `if:` mentioning `GITHUB_ACTIONS`/`runner.os`, a `pytest -m native`-style marker, or a `secrets.`-referencing `env:`), reporting `checks-from-ci-skipped (ci-only)` instead of replaying it locally; a workflow-level `env:` applies to every job while a job-level `env:` applies only to that job's own steps. (lesson 247)
- `inspect --results` now normalizes a worker's self-reported "changed" entry (trimming it, then dropping one trailing parenthetical and one trailing status word) to its own path before comparing it against a job's declared outputs, instead of warning `dropped write` for an output the job actually declared. (lesson 249)
- `--checks-from-ci`'s workflow reader now resets a job's own `env:` text at each new job key under `jobs:`, so a secrets-bearing `env:` in one job never leaks into a sibling job with no `env:` of its own. (lesson 250)
- The test suite now isolates the real home swarm config, the real user's skills directory, and the real git identity for every test, so a test that passed only in one long-lived checkout (never a fresh one) is caught. (lesson 251)

## 1.32.0

- `templates/coordination/CONTRACT.md`'s "Tests" section now names the unit a spend-cap or limit contract checks (each request, not each case/task) and requires one test where a single case trips the cap mid-way, not accumulated across cases. (lesson 242)
- `ship` now defaults `--rerun-flaky` to one automatic rerun when every failed check is platform-only and the flag is not given (an explicit `--rerun-flaky N`, including 0, always wins), warning `rerun-flaky-default: 1 (platform-only)` when the default applies. (lesson 243)

## 1.31.0

- A claude shell job's `networkAllow` host list now requires an `https://` scheme on each entry, refusing `invalid-networkAllow-host` otherwise (a well-formed https host still refuses as not-yet-supported); a manifest check may set `integrateOnly: true`, skipped by the shell worker's own smoke check and marked `(skipped-integrate-only)` in its prompt instead of gating the job. (lesson 238)
- `integrate` now tags a check whose output shows `sandbox_apply`/`Operation not permitted` as `sandbox-only`, excluded from fail counts — the orchestrator's own run outside the sandbox is the truth. (lesson 239)
- `validate` warns `contract-file-not-found` when a shared contract's own `Files:` line names a path missing from the repository root. (lesson 240)
- `templates/coordination/CONTRACT.md`'s "Tests" section now asks for one test per named failure class, not just that a diagnostic field exists. (lesson 241)

## 1.30.0

- New `templates/coordination/CONTRACT.md`, an "Event names" table (`event | producer file:line | reader file:line`); `validate` warns `event-reader-no-producer` when a contract lists a read event with no producer. (lesson 229)
- OpenRouter bookkeeping outputs now also allow `.swarm-manifests/*.md`; the matching refusal names that a contract or other design-content `.md` still goes to a cheap Claude tier. (lesson 230)
- A job may declare `maxCredits` (a number) and `creditPreflight` (a JSON `[{"call","cost"}, ...]` file); `validate`/`run` sum the preflight and refuse `credit-cap-exceeded` (naming the sum, cap and call count) or `credit-preflight-missing` when the file cannot be read. (lesson 231)
- `validate` warns `output-not-in-base` on a declared test output absent from base (a typo, most likely); `integrate` now treats a declared output absent from both base and workspace as `output-never-written` (a warning), never an undeclared-delete refusal. (lesson 232)
- `integrate --mutants`/`mutants` now run every distinct check once on the unmutated tree before any mutant, refusing `mutant-check-broken` (naming the exit code and tail) if it fails; any mutant `error` now reads in the summary as "N errored — not a kill". (lesson 233)
- `ship` refuses `release-version-mismatch` when a PR title naming a release version disagrees with package.json, or the CHANGELOG top heading is still `Unreleased`. (lesson 234)
- `templates/coordination/CONTRACT.md` gains a "Time zones" line; `validate` warns `utc-only-window-tests` when a job's own output touches a date-window comparison and no test in its context/outputs mentions a non-UTC zone. (lesson 235)
- `integrate` now runs manifest `preChecks` before its own checks on every run (not only when a lockfile changed); a preCheck that cannot even start (ENOENT/127) refuses `checks-not-runnable` instead of being scored as a red base; `--mutants-file` now resolves against the run's own not-yet-written outputs when the root copy is absent. (lesson 236)
- `templates/coordination/ORCHESTRATOR.md` and `docs/kickoff.md` now both state that work already in TASK.md is pre-approved at boot and can start right away; a typed confirm is needed only for new tickets, secrets, model keys, public lessons, and anything that spends credits or money. (lesson 237)

## 1.29.0

- Validation's `missing-deps` now only warns when `package.json` actually declares `dependencies`/`devDependencies`/`optionalDependencies`; `check-needs-env` now skips an `npm test`/`npm run <script>` check whose script resolves to a plain `node ...` command. (lesson 219)
- `ship`'s `scratch-file-in-diff` guard now judges only `git diff --name-only <base>...HEAD` (plus what is staged), never a run's own declared-output list; a gitignored/untracked output that was never committed no longer refuses a ship. (lesson 220)
- `ask`, `validate` and `run` now refuse `empty-context-file: <path>` for a 0-byte or whitespace-only context file, naming the path; a manifest `allowEmptyContext: [...]` names a deliberate exception. (lesson 221)
- API adapters now refuse `api-key-missing`, naming the env var (and, for OpenRouter, the keychain service/account and config path they looked in), before ever sending a request; a provider's "incomplete" error only fires once a real response exists, and an empty 200 body now names `empty-body` instead of a generic malformed-JSON error. (lesson 222)
- CLI jobs: a null result (no parsable JSON) on a job whose own prompt demands a JSON-only reply, with none of its declared outputs actually written, now ends `failed`, reason `no-output`, instead of `complete` (a job with no such demand keeps deferring a missing output to `integrate`, as before); a worker's prose `Status: BLOCKED` reply naming a `Required file:` line is now parsed into `status: "blocked"` with `needFile` set, the same as a JSON blocked envelope. (lesson 223)
- Worker skills: `checks.filesMustChange`/`checks.resultKeys: []` are now valid (an explicit "none"); the frontmatter reader now accepts a flow-style inline YAML list (`key: [a, b]`); a skill with an otherwise-invalid frontmatter field that no job in the manifest names or path-matches now only warns `skill-invalid-unused`, refusing only the jobs that actually attach it. New `swarm skills check [--dir DIR]` validates a skills directory (the configured `skills.dir` by default) and prints each problem. (lesson 224)
- `shell-sandbox-denied-check` no longer warns on a path already granted to a shell worker's sandbox (its own toolchains directory, or any job `readPaths`); new `swarm doctor shell` prints the effective sandbox profile (denied home directories, current loopback denials, keychain service, granted read paths, `skillsDir`) as JSON. (lesson 225)
- API jobs now default `maxOutputTokens` per model (a DeepSeek reasoning model defaults to 16000, covering its own thinking plus its reply); a `finish_reason: "length"` response with no reply text at all gets one automatic retry at double the limit (still checked against the job's own $ cap), recorded as `retriedForLength: true`. (lesson 226)
- The idle `no-job-running` warning gains an optional hint naming the first step of the next queued ticket, read from a coordination task file; `swarm next --from <file>` prints the same hint on its own. (lesson 227)
- A job manifest may set `loopbackAllow: [port, ...]` on a claude shell job to restrict its sandbox's loopback network access to only those ports; left unset, today's behavior (all loopback minus ports already listening at job start) is unchanged. (lesson 262)
- `ship` now returns `macCheckLine`, a ready-to-paste `mac-check: <repo>@<sha> merged <ISO timestamp>` line, alongside `mergeSha`, once a PR actually merges. (lesson 228)

## 1.28.0

- API job envelopes may now name `edits: [{path, find, replace}]` per declared output instead of the whole file; the coordinator applies each edit and refuses `edit-no-match`/`edit-multiple-match` when the find text is missing or ambiguous. Validation now warns `large-output-whole` when an API job declares an output already over 20 KB on disk. (lesson 113)
- `integrate`, `mutants` and `ship` now print a `no-job-running` warning, naming idle minutes since the latest run ended, when no run under the configured roots (local config `metrics.roots`, else the current `--root`) has status running. `session-metrics` gained `idleGaps()`, listing every gap of 5 minutes or more between recorded windows. (lesson 114)
- `scout --allow-license "<package>=<license id>"` (repeatable) exempts one named package from the license gate; the exempted pick is marked `licenseException: true` and stays in the report's picks. (lesson 115)
- `scout --licenses <file or csv>` replaces the built-in license allowlist outright; `scout --kind assets` adds a CC0-1.0/CC-BY-4.0 preset on top (a CC-BY-4.0 pick is marked `attribution: true`). A scout report's `sections: {<heading>: text}` now renders in `report.md` for any extra section the brief asked for. (lesson 116)
- `ship` now refuses `author-email-mismatch`, naming the commit, when any commit in `<base>..HEAD` has an author or committer email that is neither the repository's configured `user.email` nor a `*@users.noreply.github.com` address; this runs before the push. (lesson 117)
- `redcheck --commit <sha>` proves one specific commit's own regression coverage on a temporary worktree at HEAD (that commit's diff reverted there, checks run, worktree removed), independent of a run's own recorded base/job bytes; the result names `importOnly: true` when every failure is a missing-export `SyntaxError`. (lesson 118)
- API adapters (openrouter, openai, lambda, generic) now inline every manifest `context` file into the request with a 60,000-byte per-file cap, recording `contextInlined: [{path, bytes, truncated}]` on the job result; validation refuses `context-not-deliverable` when a tool-free job's context is missing or exceeds a 200,000-byte total cap. A tool-free job whose parsed reply is a bare JSON `null` now fails with reason `null-result` instead of ever being reported complete. (lesson 119)

## 1.27.0

- New optional worker skills: a manifest `skillsDir` (or local config `skills.dir`) names a
  directory of `<name>/SKILL.md` files (frontmatter `name`, `description`, optional `paths`,
  optional `checks`). Every job prompt (claude, claude shell, codex, API) gains one index line per
  skill; a job's own `skills: [...]` list, or else a frontmatter `paths:` glob matching that job's
  own context/outputs, prepends that skill's full body (an empty `skills: []` still overrides
  auto-attach, leaving every skill index-only). The source directory is copied into each job's own
  workspace/worktree at `.swarm/skills/` (already git-ignored; refuses any symlink instead of
  copying it). `integrate` fails a job naming `skill-check-failed: <skill>: <what>` when an
  attached skill's own `checks.filesMustChange`/`checks.resultKeys` are not met by that job's
  changed files/result — never bypassed by `--accept-failed-checks`. A job's own record gains
  `skills: [{name, gitHash, attached}]` (`gitHash` matches `git hash-object`); `validate` warns
  `skill-over-800` and refuses `skill-over-1200` on a skill's own estimated token size (never
  trimming it), and refuses `invalid-skill-frontmatter`/`unknown-skill` up front. New
  `tools/skills.mjs`; `tools/session-metrics.mjs` gains `reworkBySkill`, comparing jobs with vs
  without a given skill by the share needing a follow-up job on the same outputs within 24h.
  Absent, every prompt stays byte-identical to before this feature existed. Tests in
  `tests/worker-skills.test.mjs` (lesson #112).
- Fixed: an index-only skill's own line gave no way to find its full instructions, only its name
  and description. That line now ends with its copied path and a pointer,
  `.swarm/skills/<name>/SKILL.md — read it if your job touches this`; a named/paths-attached
  skill's line is unchanged. Tests in `tests/worker-skills.test.mjs`.

## 1.26.1

- Local config now lives outside the install checkout: default path is `$XDG_CONFIG_HOME/project-swarm/config.json` (when set and absolute) else `~/.config/project-swarm/config.json`; `SWARM_CONFIG` still wins. A leftover file at the old `~/.project-swarm/config.json` (inside the install clone) refuses with `config-inside-install` instead of being read, and any resolved config file found inside a git work tree refuses with `config-inside-repo`.
- `ship`'s private-names list now falls through to the local config's `privateNames` path when neither `--private-names` nor `<root>/coordination/private-names.txt` is present (refusing `private-names-missing` when that configured file does not exist). A `path:` prefixed line is a path glob (`*` within a segment, `**` across segments), never a text term: it refuses `private-path-in-diff` when a matching file enters `git diff --name-only <base>...HEAD` or the staged diff, public or private repo alike.
- Scrubbed private product names from docs, tests and comments that a prior release's own new tests had reintroduced (field lesson 112); a test asserting such a name's absence now reads its terms from local config or skips, never spelling the term itself.
- The test suite never reads the developer's own local config: a `--import` setup file points `SWARM_CONFIG` at a missing file; the private-term scan reads the real one only through `SWARM_REAL_CONFIG`.

## 1.26.0

- Fixed: the interpreter probe run before a check ever executes resolved a program's name against
  the orchestrator's own search path, refusing a check whose real invocation (an explicit
  environment-variable prefix naming its own search path) would have found it fine. The probe now
  honors that prefix's own search path first, then a dedicated tools directory, then the ordinary
  search path, and names every directory it searched in a refusal. Tests in
  `tests/field-lessons-batch-l.test.mjs` (lesson #99).
- A mutants file may now carry two purely documentation-only fields — one naming which test(s) a
  worker believes killed each mutant, one a free-text note — accepted with a warning instead of
  refusing the whole file; running mutants now compares a claimed killer against what actually
  failed and warns on a mismatch. Tests in `tests/field-lessons-batch-l.test.mjs` (lesson #100).
- Fixed: `ask` against an almost-valid reply (structured data with one common, narrow mistake in
  it) reported a bare empty result and a generic parse-failure message, with the real answer
  recoverable only from raw logs. A parse failure now tries one narrow, documented repair first,
  and otherwise reports a distinct status with the raw reply's own location and a leading excerpt,
  never a "complete" result that is silently empty. Tests in `tests/field-lessons-batch-l.test.mjs`
  (lesson #101).
- Fixed: a one-time setup step failing before a job's worker ever started looked identical to a
  worker that ran and reported nothing — empty error, empty result, empty cost — with the real
  cause visible only in a log file nobody was told to open. Inspecting a run now names the phase a
  setup failure happened in, with that failure's own log tail alongside it. Validation also now
  warns when a dependency lock names a local path no longer present in the tree, instead of that
  only surfacing once an offline install tries to use it. Tests in
  `tests/field-lessons-batch-l.test.mjs` (lesson #102).
- Fixed: a failed check at integration time stayed invisible unless a rarely remembered flag was
  passed, reporting success by default even with a failing check in the list. Integration now
  refuses by default when any check has failed, naming every one of them, with an explicit opt-in
  (`--accept-failed-checks`) for the rare case a failure should be accepted anyway;
  `--require-checks` remains an accepted flag. Tests in `tests/field-lessons-batch-l.test.mjs`
  (lesson #103).
- Validation now warns when a check or a shell job's own instructions name a path outside the
  worker's own sandboxed environment (one it could never actually reach to run), and that worker's
  own boilerplate now marks such a check as run by a later, unrestricted step instead of asking the
  worker to run it itself. Tests in `tests/field-lessons-batch-l.test.mjs` (lesson #104).
- `check-pins` gains a new rule: an exact pin on one of a repo's own packages with no vendored
  wheel and no local/`uv.sources`-style override now fails `pin-not-vendored`, closing a gap where
  such a pin was vendored nowhere at all and so was never compared against anything. Tests in
  `tests/field-lessons-batch-m1.test.mjs` (lesson #105).
- Fixed: `ship`'s scratch-file guard judged a run's own declared output list instead of the actual
  commit diff, so a declared output that was git-ignored and never committed (and so was never
  going to be pushed at all) was wrongly refused. The guard now checks the real diff between base
  and HEAD (plus anything staged) — what would actually be pushed — instead. Tests in
  `tests/field-lessons-batch-m1.test.mjs` (lesson #106).
- Fixed: two shell workers sharing one machine both spent their final minutes stuck in a
  sleep-and-poll loop waiting on a full test suite each had launched in the background, timing out
  with an empty result even though their real edits were already finished. `integrate --salvage`
  now accepts a timed-out job's declared outputs (hash-checked, marked `salvaged: true`), a shell
  worker's own instructions now say to run only its own changed test files (the full suite runs at
  integrate), `run` warns when two shell jobs share one root and both ask for a full suite, and a
  timeout result now names the transcript's last activity. Tests in
  `tests/field-lessons-batch-m2.test.mjs` (lesson #107).
- Fixed: a worker adding a new field to a persisted record chose its own "stricter" default for
  data saved before the field existed, which silently made a one-time migration a no-op for every
  existing record on disk — nothing caught it because no test ever loaded a pre-field file. A
  shell job's result schema now carries `newPersistedFields: [{name, legacyDefault, why}]`,
  inspecting a run warns when a diff adds a field to a persisted record with that list empty, and
  job instructions now say a new stored field must state its legacy default and have a
  from-disk legacy test. Tests in `tests/field-lessons-batch-m2.test.mjs` (lesson #108).
- Fixed: a routing decision that retired a model from the cheap tier was recorded only in a
  decision log, not in the rulebook a model reads at boot, so jobs kept routing to the old
  (now more expensive) choice. `validate` now warns when a job asks for the cheap tier on an
  agent pricier than the configured cheap-tier model, unless the job states a reason. Tests in
  `tests/field-lessons-batch-m2.test.mjs` (lesson #109).
- Fixed: a public-repo tool hard-coded a product's keychain service name, an app-support port-file
  path, and a product-specific denied-home-directory entry. All three now default to generic
  values and are overridden through local config only, so the public tool names nothing
  product-specific by default. Tests in `tests/field-lessons-batch-m3.test.mjs` (lesson #110).
- Fixed: a tool-free API worker's incomplete reply (cut short by an output-length limit) surfaced
  as a bare "incomplete or unexpected" error with no way to tell why. The error now names the
  provider's own finish reason (e.g. truncated by length) directly. Tests in
  `tests/field-lessons-batch-m3.test.mjs` (lesson #111).
- `ship`'s result gains `timing: { checksSeconds, ciWaitSeconds, attempts, rerunCount }` (seconds
  rounded to 0.1; `attempts` counts CI wait rounds, `rerunCount` counts failed-job reruns), using
  an injectable clock so tests can measure it deterministically. Tests in
  `tests/field-lessons-batch-m1.test.mjs`.
- `tests/ask-125.test.mjs` and `tests/swarm.test.mjs` updated for two batch L defaults: an
  unparsable worker reply now reports `status: "unparsed"` (not `"complete"` with a bare error),
  and integration now refuses by default on a failed check (not a silent exit 0).

## 1.25.0

- New `swarm check-pins [--root DIR] [--json] [--core NAME] [--app-prefix PREFIX]`: reads pyproject.toml/uv.lock, vendored wheel METADATA, and package.json to catch a stale internal pin — a library that exact-pins the shared core package named by `--core` (`library-exact-core-pin`; a repo whose own name starts with `--app-prefix` is exempt), an exact pin that no longer matches a vendored copy (`pin-not-vendored-version`), a pin older than a newer vendored copy (`pin-older-than-vendored`), and (in the `--core` repo itself) a vendored wheel's own `Requires-Dist` left unsatisfied by `uv.lock` (`wheel-requirement-unsatisfied`) — instead of only surfacing at a fresh offline install. Without `--core`, the two core-specific rules are skipped and named in a `skippedRules` field. Exits 1 on any finding. New `tools/check-pins.mjs`; tests in `tests/check-pins.test.mjs`, wired into `swarm.mjs`'s command dispatch with tests in `tests/scout-125.test.mjs` and `tests/wire-125.test.mjs` (lesson #224/#225).
- Fixed: `ship` labelled a check "pre-existing" and merged it even though both failing tests were new in that PR, because the guard only compared exit codes, not test ids, and the check's own PATH lacked the toolchains bin dir so a `shutil.which("uv")` lookup failed. Every failing check now carries `baseStatus: "fail"|"pass"|"absent"|"unknown"` per failing test id (only `"fail"` — the same id failing on the PR's base commit — is pre-existing; `absent`/`unknown`/`pass` block the merge), and every check ship spawns gets the resolved toolchains bin dir prepended to PATH. Tests in `tests/ship-125.test.mjs` and `tests/wire-125.test.mjs` (lesson #192).
- `ship`'s exemption audit log path now honours `SWARM_HOME` (after the existing home override), so the test suite no longer writes fixture rows into the real install's audit log; new exported `exemptionLogPath({ env, home })`. Tests in `tests/ship-125.test.mjs` (lesson #186).
- `ship --help`/`-h` prints usage and exits 0 in every argument position, before any other flag is parsed; every ship result JSON now names its run (`runId`, or `branch` for `ship --branch`), so a run is always recoverable without reading source. Tests in `tests/ship-125.test.mjs` and `tests/wire-125.test.mjs` (lesson #187).
- Fixed: a worker committed a scratch PR body into a release, discovered only a branch later. `ship` now refuses before pushing when the diff adds a file matching `.pr-body.md`, `*-pr-create.json`, `.swarm-manifests/**`, or `*.out`, with error code `scratch-file-in-diff`, unless excused with `--exempt scratch:<file>=<reason>`. Tests in `tests/ship-125.test.mjs` (lesson #180).
- Fixed: `ask` against an API agent (e.g. OpenRouter) returned `Worker returned no parsable final JSON` for a plain-text answer, because the prompt never asked the API worker's reply to be JSON. `ask`'s instruction to an API agent now asks for a final JSON line, and when none parses, `ask` falls back to `{status: "ok", answer: <summary text>, parsed: false}` instead of an error. Tests in `tests/ask-125.test.mjs` (lesson #184).
- Scout and ask run ids now carry a random suffix (`<prefix>-<ms>-<8 hex>`), so two runs launched in the same millisecond no longer collide on `EEXIST`; a claim collision retries once with a fresh id. A cancelled scout reports `costUsd` from the last cost-carrying event seen before it was killed, or `costUsd: null` with `costUnknown: true` and the reservation in `costReservedUsd` when no cost ever streamed. Tests in `tests/scout-125.test.mjs` and `tests/ask-125.test.mjs` (lesson #193).
- Fixed: scout's license gate rejected worker-verified asset picks (CC0, CC-BY) because it only ever checked a fixed code-license list. The gate now reads an `Allowed licenses: A, B, ...` line from the brief itself (case-insensitive, SPDX-ish match) and falls back to the fixed code list only when the brief names none. New exported `parseAllowedLicenses`/`licenseAllowed` in `tools/scout.mjs`. Tests in `tests/scout-125.test.mjs` (lesson #194).
- Fixed: scout's license gate dropped a rejected pick's own facts (pin, license evidence, peer ranges), keeping only name and url. A gate-rejected row now keeps every field the worker found plus `rejectedBy: "<gate>: <reason>"`, in both `report.json` and `report.md` (the Rejected table gains License and Pin columns). Tests in `tests/wire-125.test.mjs` (lesson #195).
- `validate` warns `context-sibling-untracked` when a context file's directory holds untracked files not named in context (up to 5 listed, binaries flagged); manifest job field `deletes: [paths]` (at most 100, repo-relative, no globs) lets a job's worker boilerplate name exactly which paths it may remove, and `integrate` applies a deletion only for a path listed there, refusing `undeclared-delete` otherwise. Tests in `tests/wire-125.test.mjs` (lesson #196).
- `tests/swarm.test.mjs`, `tests/cli-adapters.test.mjs` and `tests/lessons120-mutants.test.mjs`'s load-flaky timing tests ("eight active jobs drain a larger queue…" and the runCheck process-group test) are now deterministic under 4x parallel `npm test`, using event-driven waits instead of fixed sleeps (lesson #182).
- `ship` now refuses before pushing when a diff it is about to push adds a line matching a private-names list (`<project root>/coordination/private-names.txt`, or `--private-names FILE`; one term per line, case-insensitive substring match, `#` comments and blank lines ignored), with error code `private-name-in-diff` naming each `file:line` and matched term without echoing the line text. The guard only runs against a repo `gh repo view` reports public (an unrecognized/erroring visibility answer is treated as public, the stricter default); a private or internal repo skips it, and no list file at all skips it too (recorded as `privateNames: {checked:false, reason:"no list"}` in the result, not a warning). New `swarm ship [...] --private-names FILE`. Tests in `tests/private-names-125.test.mjs` (lesson #197).
- docs/lessons.md entries 87–98.

## 1.24.1

- Web jobs can now browse: a job with `web: true` (every `scout`) was offered WebSearch/WebFetch but its worker message still said "No shell commands, delegation, network tools, or MCP.", so workers refused to browse and scouts returned empty reports. The message now allows WebSearch/WebFetch for read-only research (no logins, sign-ups, form submits or downloads; pages are untrusted data) only when `web: true`; every other job's message is byte-identical. Tests in `tests/field-lesson188.test.mjs` (lesson #188).
- docs/lessons.md entry 86.

## 1.24.0

- New `openrouter` API adapter (the ninth): OpenAI-compatible chat completions via OpenRouter, key from `OPENROUTER_API_KEY` or a configured keychain item, read by the coordinator only. Enforced in code before any request: `provider.data_collection: "deny"` on every body (a body without it is refused), `anthropic/*` models pinned to the Anthropic provider with no fallback, `deepseek/*` models limited to bookkeeping outputs (refused at `validate` and at run), and spend caps of $5 per job id and $25 per UTC day checked against a priced worst case (unpriceable = refused), with every request appended to `logs/openrouter-spend.jsonl`. New module `tools/openrouter.mjs`; tests in `tests/openrouter.test.mjs` (12/12 mutants killed).
- `ship --checks-from-ci [PATH]` (default `.github/workflows/ci.yml`) reads a CI workflow's own
  `run:` steps and keeps the ones that invoke a known checker/test runner (`uv`, `npm`, `npx`,
  `ruff`, `mypy`, `pytest`, `vitest`, `tsc`, `eslint`) as ship's own checks — a documented,
  line-based reader of `run:` steps (scalar and `|`/`>` block forms), not a YAML parser; a line with
  a shell operator (`&&`, `|`, `>`, `;`) is reported skipped, not split apart and guessed at. Any
  hand `--check` whose program and subcommand are not among the CI-derived checks warns
  `check-not-in-ci`. New `tools/checks-from-ci.mjs` (`loadChecksFromCi`, `ciChecksFromWorkflowText`,
  `checkNotInCiWarnings`) (lesson #177a/b).
- Fixed: a check that already failed on the base commit's own tree (not something the change being
  shipped broke) blocked the ship the same as a genuine regression, costing a wasted re-ship once
  the same failure was rediscovered by hand. `ship` now re-runs a failing check once against the
  base commit's own tree (a throwaway `git worktree`, always cleaned up) and reports it
  `pre-existing` — still listed in the checks section, no longer blocking — when it fails there too.
  New exported `verifyPreExistingOnBase` in `tools/ship.mjs` (lesson #177c).
- `ship --rerun-flaky N` (default 0): on `ci-failed`, fetches the failed jobs' own logs via `gh`,
  extracts failing test file paths (pytest `FAILED path::name`, vitest `FAIL path`), and — only when
  none of them are among the files the shipped change itself touched — reruns the failed jobs
  (`gh run rerun <id> --failed`) up to N times and waits again; the result gains
  `flakyRerun: {attempts, result: "passed"|"failed", tests: [...]}`. A failing test that IS among
  the changed files is never rerun. New exported `extractFailingTestFiles`/`failedRunIds` in
  `tools/ship.mjs` (lesson #178).
- Fixed: `ship --branch` refused a branch over `tests/swarm.test.mjs -> ps`, a call already sitting
  on `main` and untouched by that branch's own diff. The undocumented-binary/env-var test-file gate
  now judges only the lines a change ADDS to a test file (`git diff <base>...HEAD -U0`, `+` lines
  only, never the `+++ b/<file>` header); a call already on the base does not refuse. `ps` joins the
  documented POSIX binaries (macOS/Linux; a Windows-run test spawning it still needs its own
  fake/skip seam). New repeatable ship flag `--exempt <guard>:<file>=<reason>` (works on `ship RUN`,
  `ship --branch`, and `go`) excuses one file from one guard (`undocumented-binary` or `env-var`) —
  never other files, never other guards; the reason is required (trimmed, >= 10 characters, else
  `exemption-needs-reason`) and an unknown guard id refuses with the valid list. Every used
  exemption appears in the result's `exemptions: [{guard, file, reason}]`, is appended as one JSON
  line to `<installRoot>/logs/ship-exemptions.jsonl` (`SWARM_LOGS_DIR` overrides the directory), and
  is written into the PR body's `## Exemptions` section (appended to one already there, or created
  fresh) — a shipped PR body can never omit a used exemption. An exemption that matched nothing
  warns `unused-exemption: <guard>:<file>` without touching the PR body. A guard that still refuses
  now ends its reason with a hint: `fix the cause, or pass --exempt <guard>:<file>=<reason>`. New
  exported `parseExemptFlag`, `EXEMPTION_GUARD_IDS`, `appendExemptionsSection`, `logExemption` in
  `tools/ship.mjs` (lesson #179).
- Fixed: `resolveToolchainBin` picked a directory that merely shared a program's name over the real
  binary (real case: `~/.project-swarm/toolchains/uv` is the pip package directory, not the `uv`
  binary, which sits at `toolchains/bin/uv`) — `fs.access(X_OK)` alone passes on a directory too,
  so every real check hit a spawn failure and the pre-push lock check refused with the empty reason
  `uv-lock-check failed: `, exactly what lesson #172 was meant to prevent. A candidate now also has
  to be a regular file (`fs.stat`, following a symlink) before it counts. A lock check that still
  fails to spawn no longer produces an empty reason either way: `shipExec` now names the errno on a
  genuine launch failure (`spawnError`, distinguished the same way `error.code` already told a real
  exit apart from one), and `ship` reports `lock-check-cannot-run: <path> (<errno>)` instead of the
  empty `<name> failed: ` (lesson #181).
- `ship` now warns `no-lockfile: <path>/package.json has no package-lock.json` when
  a changed Node manifest has no lockfile, and explicitly reports that `npm-lock-check`
  did not run. A present lockfile still runs `npm ci --dry-run`; stale or inconsistent
  locks still refuse before push. Added the project's dependency-free `package-lock.json`
  at version 1.24.0 and regression coverage including a real npm stale-lock refusal
  (lesson #183).
- docs/lessons.md entries 81–85.

## 1.23.0

- Fixed: `scout --brief` (like any relative path flag on `scout`/`ask`) resolved only against `--root`, not the cwd the user actually typed it from; `swarm scout --root repos/acme-desk --brief coordination/research/brief.md` failed "brief not found" for a path that only ever made sense relative to the cwd. A relative `--brief` is now tried against the cwd first, then against `--root`, and the not-found error names every path actually tried. `ship`/`go`'s `--pr PAYLOAD.json` had the identical bug (`ship --branch` and `ship <run-id>` both resolved it only against `--root`) and gets the same fix, via the new `resolvePathCwdThenRoot` (lesson #169).
- The lesson-#163/#168 git-stash guard also refuses `git checkout -- <path>` / `git checkout <path>` / `git restore <path>` when that path has uncommitted changes (working tree or staged), printing "commit WIP first"; a plain branch checkout (no local diff on the pathspec) still passes straight through, and a global `-C` is honored by the check itself. Shell and codex job boilerplate now also says to run mutants with `swarm mutants`, never by hand (a plain, non-shell job carries no such line — it has no Bash tool to misuse) (lesson #170).
- `swarm mutants` (and any other mutants source) accepts `id` as an alias for `name` in a mutant object, renamed with a warning instead of failing outright or needing a by-hand conversion; `env --print` now also states the exact mutants file shape, byte-identical to a job's own mutantsFile preamble (lesson #171).
- Fixed: the pre-push `uv-lock-check` (lesson #147) spawned a bare `uv`, which is not reliably on PATH when `uv` lives only in the swarm's own toolchains dir; a missing `uv` used to refuse with an empty reason (`uv-lock-check failed: `). `uv` is now resolved like any other toolchain binary (toolchains dir, then PATH) before ever being spawned, and a lock check that cannot even start refuses `lock-check-cannot-run: uv not found (tried …)` instead. Behavior change: `ship()` takes an optional `resolveUv`/`env` override (both default to the real resolution) (lesson #172).
- Fixed: `ship --require-section 'Mutation check'` refused a PR body whose heading was `## Mutation check (mutant → killing test)` — a real section, just with more text in the heading. A required section now matches `## <name>` followed by end of line, a space, or `(` (a prefix match on a word boundary, so `## Mutation checks` still does not match); a genuinely missing section's refusal now also names the nearest heading actually found in the body (lesson #174).
- Fixed: `ship --check '["uv",...]'` run from a shell without the toolchains dir on PATH gave `spawn-error` for every check, with no program or PATH shown. Ship/run checks now resolve a bare check `argv[0]` through the toolchains dir, then PATH — the same resolver lesson #172 added (now exported as `resolveToolchainBin`) — before ever spawning it; one that cannot be resolved refuses just that check with `cannot-run: <prog> not found (tried <dirs>)` instead of an uninformative spawn-error (lesson #175).
- `ask`'s own prompt now tells the worker that any claim in its answer that something is missing, never called, omitted, or absent must carry `"basis":"context-only"` and name what it searched — a worker reading only a fixed context list cannot tell a genuine absence from a file it was never given. The `ask` result JSON gains `contextFiles` (the exact context list given) and a `warnings` array, which gains `absence-claim-limited-context` whenever the worker's own answer text contains such a claim (a simple, case-insensitive, whole-word scan for `missing`/`never`/`omits`/`not invoked`/`not called`/`lacks`/`drops`), regardless of whether the worker itself added the basis marker (lesson #176). New exported `hasAbsenceClaim` in `tools/swarm.mjs`.
- docs/lessons.md entries 74–80.

## 1.22.0

- `validate` warns `shared-output-across-open-jobs` when the manifest being validated declares an output file that an already-open run elsewhere in the same repository (another worktree/branch) also lists — two open jobs each working from their own copy of one shared file collide on the next rebase or integrate; naming the other run(s) and suggesting a per-job fragment file, combined in a later step, instead. (Two jobs of the *same* manifest sharing one output file is still refused outright by the existing writer-collision check, so that case never reaches this warning.) (lesson #165)
- Fixed: `ship <run-id>` never passed the run's own integrated files through to `ship()`, so the pre-push lockfile check (lesson 147) never actually ran on a real run's ship — only `ship --branch` had it. `ship <run-id>` now passes `integratedFiles` through like `ship --branch` always did (lesson #166).
- Per-root gotchas file `.swarm/gotchas.md` (a linked worktree falls back to its main worktree's file, same as `.swarm/env.json`): free-form Markdown, at most 16 KiB, appended to every claude, codex and shell job prompt and to `env --print` (the plain `env` JSON gains a `gotchas: {text, source}` field). `validate` warns `windows-ci-no-gotchas` when the project's own `.github/workflows` already runs CI on Windows and no gotchas file exists (lesson #167). New `tools/gotchas.mjs`.
- Fixed: the lesson-#163 git-stash guard only ever protected a sandboxed shell worker (a fresh guard dir per job); an outside agent that only paste-ran `env --print`'s block into its own shell got no such protection. `env`/`env --print` now also materializes the stash-refusing wrapper into a stable per-root `.swarm/bin/git` and, with `--print`, adds an `export PATH=...` line for it ahead of the real git (the plain `env` JSON gains a `wrapperPath` field); `findRealGit` excludes that dir so the wrapper never resolves to itself, including on a second run after an earlier paste already put it on `PATH` (lesson #168). New `materializeGitGuard`/`GIT_GUARD_DIR` in `tools/swarm-env.mjs`.
- docs/lessons.md entries 70–73.

## 1.21.0

- Claude shell jobs follow `.venv/bin/python` symlink by symlink to its realpath (plus pyvenv.cfg `home` and its realpath) and grant every install dir that resolves under `$HOME`, instead of only the unresolved pyvenv.cfg `home`; a python link that resolves nowhere refuses the job (`venv-interpreter-unresolvable`). The swarm toolchains dir and uv's managed-Python dir are granted read-only when present, and the child env gets `UV_PYTHON_INSTALL_DIR` so `uv` finds its interpreters under the job-scoped `HOME` (lesson #158).
- Before a shell worker starts, the first placeholder-free manifest check is smoke-started once inside the job's own profile and env (worker key stripped, 30 s cap, `smoke.log`); one that cannot even start refuses the job `sandbox-cannot-run-check: <argv0>` (lesson #158).
- Packaging build check: `validate` warns `packaging-change-without-build-check` for a job writing `pyproject.toml`/`setup.cfg`/`setup.py`/`MANIFEST.in`/`package.json`/`Cargo.toml` with no build check (`uv build`, `-m build`, `pip wheel`, `npm pack`, `cargo package|build`); `integrate` warns and `ship` refuses when the change actually touches packaging keys (build sections, package data, published files) with no build check (lesson #159). New `tools/packaging-check.mjs`.
- Per-root env file `.swarm/env.json` (linked worktrees fall back to the main worktree's): applied to setup, codex and shell workers, preChecks, checks, flake reruns, redcheck, and every mutant check; secret-looking and reserved names refused. `validate` warns `check-needs-env` for an npm/npx/pnpm/yarn/cargo/uv check with no env file. New `env` / `env --print` (paste-ready export block, port block, no-stash rule) (lesson #160). New `tools/swarm-env.mjs`.
- `mutants` and `integrate --mutants` count every mutant's `find` in its target before anything runs and refuse the whole run listing each `invalid-find` / `ambiguous-find` / `no-op` mutant; nothing is mutated or checked (integrate checks the bytes it is about to write, before any write). `mutants --dry-run` does only that (lesson #161). Behavior change: integrate used to integrate and report such a mutant as an `error`.
- A mutant may carry its own `check` argv, overriding `--mutant-check`/`mutantCheck` for that mutant; every distinct check must pass unmutated first; results name `check` (`default`/`mutant`) and `checkArgv`; `--mutant-check` is optional when every mutant has its own (lesson #162).
- Shell and codex prompts say never to `git stash` (shared stack across worktrees; use a temp WIP commit or copy the file aside); shell workers get a `git` wrapper first on `PATH` that refuses `stash` with a plain message (lesson #163).
- `ship --branch BRANCH --pr payload.json [--check ARGVJSON]...` ships a branch built outside the swarm (no run id): same clean-tree, checks placeholder, `--require-section`, needs-a-human hold, lock check, test-binary gate and packaging check over the branch's diff, then push, PR, CI wait and merge (lesson #164).
- docs/lessons.md entries 63–69.

## 1.20.0

- A check that never started is no longer a generic `error`: `spawn-error` (Node could not spawn the check's own argv at all) and `unrunnable` (exit 127, or `command not found`/`ERR_MODULE_NOT_FOUND` in its own output — the tool/module itself is missing) are now distinct, each carrying a `hint`. Either classification triggers one automatic run of the manifest's own `preChecks` (if declared) plus a single retry of that same check before it is ever reported red; `integrate`'s result gains `checksErrored`, and the CLI now exits non-zero whenever any check errored this way, independent of `--require-checks`.
- `preChecks`' env-resync trigger now also fires on a changed `pyproject.toml`/`package.json`/`Cargo.toml`, not only a recognized lockfile; `validate` warns `stale-env-risk` when a job's own outputs include one of these dependency/version files and the manifest declares no `preChecks`, and `missing-deps` when `package.json` exists with no `node_modules` (or `pyproject.toml` with no `.venv`) at the project root.
- `validate` warns `tight-test-timeout` when a job's own test-file output contains a timeout literal under the 5-second hang-guard floor (Python `timeout=N`, JS `setTimeout(..., N)`/`waitFor({timeout: N})`).
- `runtime-check-no-shell` now also fires when a manifest check's own argv contains a repeat construct (`seq N`, `--repeat`, `for i in`), or a job's prompt names a flake/race/intermittent bug, and that job has no shell; a job whose outputs are all `.md` is exempt.
- New `tools/session-metrics.mjs`: a small state.json-compatible `{startedAt, finishedAt, costUsd}` record, one file per run under `.swarm/session-metrics/<kind>/<id>.json`. `ask`/`scout` each write one (`kind: 'ask'`/`'scout'`), and `integrate` writes one for its own checks phase and, when `--mutants` runs, its mutants phase — so background research and long check/mutant runs are no longer miscounted as idle time.
- The bare `validate` command now also runs the check-interpreter/module probe (`probeCheckInterpreters` in `tools/preflight.mjs`) `preflight` already ran, refusing a manifest whose check names a missing tool or Python module instead of only discovering it at `integrate` time; `validateProject` also now calls `registryPinningWarnings` (`tools/context-check.mjs`) for every job.
- `validate`/`preflight` run each check's `argv[0]` with `--version` (or `-c "import X"` for a `python3 -m X` form) once and refuse a check whose interpreter or module can't be found, instead of discovering it only at `integrate` time (`tools/preflight.mjs`).
- `contextDirectoryWarnings`/output-coverage: a guard test that reads a directory or extension glob (e.g. `src/**/*.css`, or the project's main stylesheet) now counts as covering a new same-kind output in a side file, so a new stylesheet or side file is recognized as needing the same guard tests as the main one.
- `validate` warns `registry-pinning-tests` when a job creates a new file in a directory that an existing test enumerates (`glob`/`listdir`/`load_*`) and that test isn't in the job's own context, outputs, or `ignoreTests`.
- docs/lessons.md entries 47–53.
- `ship` pre-check runs the project's own lock check before pushing a changed version/manifest file; `ship` pushes with `--force-with-lease` for the coordinator's own amended PR branch, refusing when someone else moved the head; a CI failure red on only some OS/job matrix entries prints `platform-only failure: <os>`; `ship` refuses a test file that shells out to an undocumented binary, and prints `swarm-env-in-tests: <file>` when a project test references a swarm-exported env var (SWARM_PORT_BASE).
- `--mutants-file`/`--mutant-check` on `integrate` implies `--mutants`; `runMutants` refuses to start unless the unmutated tree passes first, and classifies any non-test-failure exit as `invalid`, never `killed`; `integrate --accept-blocked` integrates a blocked job's declared outputs; `inspect`/`integrate` warn `invented-hash` on an unexplained 40-/64-hex string in an output diff; `run`/`validate` accept an absolute manifest path under `--root`; an in-flight check is killed as a process group on `cancel`; shell-job completion matches new output files against the same path normalisation as `integrate` does, so a declared new output is never warned as a dropped write; swarm tests that spawn `sandbox-exec` skip with a named reason when already inside a sandbox (`SWARM_IN_SANDBOX=1`).
- Env exported to checks: SWARM_PORT_BASE.

## 1.19.0

- Claude shell jobs: job field `shell: true` (claude only; `Job <id> shell is only supported for agent claude`), or model presets `sonnet-shell` (tier cheap) and `opus-shell` (tier expensive, `tierReason` still required), which expand to the real model plus `shell: true`. The job runs in a detached worktree and the WHOLE `claude -p` process runs under a generated macOS `sandbox-exec` profile: writes only in the worktree and the job's own run directory, the home directory hidden (codex deny list plus `~/.claude`, `~/.claude.json*` and keychains), keychain mach services and other processes' info denied, network only to a per-job localhost CONNECT proxy that tunnels `api.anthropic.com:443` and records refused host names. Tools are exactly `Read,Edit,Write,Bash,Grep,Glob`, no MCP. No sandbox (non-mac, no `sandbox-exec`) refuses the run; never an unsandboxed shell.
- Shell-job auth uses a worker key from `SWARM_CLAUDE_WORKER_API_KEY`, else a configured keychain item, read by the parent only and passed as `ANTHROPIC_API_KEY` in an allowlisted child env (job-scoped `HOME`/`CLAUDE_CONFIG_DIR`); missing refuses, never falling back to the person's claude login. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` hides the key from Bash commands; saved logs redact it; `integrate` and `ship` refuse a shell run whose saved files, outputs or payload contain it.
- Every shell-job API request carries `metadata.user_id = swarm-worker:<job-id>` (via `CLAUDE_CODE_EXTRA_BODY`).
- Shell jobs accept `readPaths` and `testEnv`; `networkAllow` is validated but any non-empty list is refused as not yet supported. The shell prompt asks the worker to run the manifest checks and report `checksRun`, which `inspect`/`inspect --results` show with `shell: true` and `proxyRefused`.
- `validate` warns `tests-without-shell` when a claude job without `shell` writes a tests path (lesson #135).
- Non-shell jobs keep 1.18.0's exact argv, env and prompt (tested).
- Per-worktree port block: env var `SWARM_PORT_BASE` gives every worktree its own stable block of 10 ports (derived from its own path), set for `integrate`'s `preChecks`/`checks`/mutant checks/flake reruns, `ship`'s own re-run of checks, codex job processes, and claude `shell: true` job processes (whose prompt also gets a `Ports:` line); `integrate` and `ship` results gain `portBase`, with a `port-block-moved`/`port-block-busy` warning when the computed block was busy. A manifest `testEnv` may not set `SWARM_PORT_BASE` itself. Non-shell claude jobs are unaffected.
- Job field `setup` (codex and claude `shell: true` jobs only): at most 5 argv arrays run once, outside the sandbox, in the job's own worktree, before the worker starts, so a toolchain sync (`uv sync`, `npm ci`) can reach the network the sandboxed worker never gets; a non-zero exit or timeout fails the job `setup-failed: <argv[0]> exit <code>` without ever starting the worker, and combined output is saved to `setup.log`. Claude shell jobs additionally gain sandbox grants for `uv`/`npm` workspace discovery (ancestor `file-read-metadata` plus a full read on any ancestor `pyproject.toml`/`uv.toml`/`package.json`), an automatic read path for a synced venv's own interpreter directory when it points inside `$HOME` (else a `venv-interpreter-denied` warning), offline-toolchain env (`UV_OFFLINE`, `UV_PYTHON_DOWNLOADS`, `UV_CACHE_DIR`, `npm_config_offline`, reserved in `testEnv`), and a prompt line stating `setup` already ran. Non-shell claude jobs are unaffected.
- Claude shell jobs can now run a project's own test suite: the sandbox profile additionally grants read-only access to the project root's own `.git` (a `literal` grant on the file plus the gitdir/commondir it resolves to, when the root is itself a linked worktree), and allows the job's own loopback sockets (`network-bind`/`network-inbound`/`network-outbound` on `localhost:*`) for local test servers, except every TCP port already listening on the host's loopback or wildcard address at job start (scanned via `lsof`, plus the rig-service port) — each denied port is recorded as `loopbackDenied` on the job record and shown by `inspect`; a service that starts listening only after the job started is a known gap. An `lsof` scan failure refuses the job (`loopback-scan-failed`) before any worker starts. The shell prompt gains a `Network:` line. Non-shell claude jobs are unaffected.
- Claude shell jobs get a per-job scratch dir (`fs.mkdtemp` under the OS tmp dir, mode 0700) for `HOME`/`TMPDIR`/`TMP`/`TEMP`/`CLAUDE_CODE_TMPDIR`, instead of the previous `<run>/<job>/shell/tmp` inside the project's own worktree, so a tool that refuses to write scratch data inside a git repo no longer fails; the sandbox profile grants it its own read+write allow, placed with the other writable-path allows. It is removed after the job ends unless the job sets `keepScratch: true` (claude shell jobs only), in which case its path is kept and recorded as `scratchDir`. If the OS tmp dir itself resolves inside a git repo, the job is refused (`scratch-inside-repo`) before any worker starts, the same shape as `loopback-scan-failed` (lesson #145). Non-shell claude jobs are unaffected.
- `doctor` (every agent) adds `toolchains: {dir, exists, tmpPaths}`, naming the expected toolchains directory (`SWARM_TOOLCHAINS`, else `~/.project-swarm/toolchains`), whether it exists, and any configured toolchain path (PATH entries included) that still resolves under `/tmp`/`/private/tmp`; advice only, never a status change. Onboarding prints one summary line. The existing `tmp-tool-path` validate warning now also names this directory (lesson #106).
- docs/lessons.md entries 40–45.
- Fixed: a worker's final-JSON extraction could return a nested inner object (e.g. one element of a `checksRun` array) instead of the whole top-level result when the reply held prose plus a fenced object with a nested array of objects; extraction now finds the last balanced top-level object via string-aware brace matching, preferring the last fenced block when present (lesson #146).
- Fixed (CI, lesson #157): the loopback port scan's `lsof` failure now carries a `loopbackScanHint` on the job record (e.g. naming a missing `lsof`) alongside the unchanged `loopback-scan-failed` error; shell-job tests inject a fake scanner instead of depending on the host having `lsof` (GitHub's ubuntu-latest runners don't).

## 1.18.0

- `validate` warns `mutants-file-undeclared` when a job's output path matches `*mutants*.json` but the job declares no `mutantsFile`; a job that does declare one gets the exact required shape, `{"name","file","find","replace"}`, stated directly in its own worker preamble.
- `integrate --mutants` now parses and validates every mutants source (manifest `mutants`, a job's own `mutantsFile` output, and `--mutants-file`) before writing any project file, instead of after; a bad shape, including trailing text after an otherwise valid JSON value, refuses with nothing written. Once files are written, the run's saved state gains `integrationStatus: "partial"` (persisted immediately, before `preChecks`/`checks`/mutants run), so a later failure leaves a run that can still be retried instead of one that refuses "already integrated" or falsely conflicts on files it already wrote.
- At job completion, a `.json` output that fails to parse is recorded as warning `output-invalid-json: <path>`, shown by `inspect`/`inspect --results`/`wait`.
- `integrate --mutants` skips every mutant with status `skipped-red-base` (and `mutantsPassed: false`) whenever any of the manifest's own `checks` failed, instead of reporting killed/survived verdicts against a base that fails regardless of the guard under test; `ship --require-section "Mutation check"` refuses outright when an integrated run's mutants came from a red base (a red base's mutants prove nothing, so a required Mutation check section can never be honestly filled from them).
- `validate`/`run` warn `context-directory-drift` when a job's `contextGlob` entries for one directory cover only some of that directory's filename prefixes, or when a plain (non-glob) context names just one or two files of an obviously numbered series (e.g. `activity-3.png`) and the directory holds more of that same prefix; both cases share this one warning code instead of two separate ones.
- `output-invalid-json` no longer fires for a job's own `resultFile`, which already gets a more specific `resultFile unreadable` warning.
- `inspect`/`integrate` warn `dropped write: <path> (not in outputs)` for a path a job's own result reports as `changed`, or that a copied (non-codex) workspace shows was actually modified or created, when that path is not one of the job's declared outputs; the worker preamble states that edits outside outputs are discarded.
- `inspect --results` lists, per job output, its workspace copy's absolute path and, for a `.json` output, whether it currently parses — visible before `integrate` ever reads it.
- docs/lessons.md entries 32–39.

## 1.17.0

- Add a standalone `mutants --mutants-file FILE --mutant-check "<argv json>"` command that mutation-tests the current tree directly, with no run id: each `{name,file,find,replace}` entry is applied alone (its `find` must match exactly once, else it is `invalid`), checked, and restored byte-for-byte before the next, restoring on `SIGINT` too, and reporting killed/survived/invalid counts plus the first failing test line per mutant.
- `doctor` warns when a named tool path, or a check argv binary, resolves under `/tmp` or `/private/tmp` ("macOS removes files here after 3 days unread; move the toolchain").
- `validate` warns when a job's declared outputs include a file whose pinning tests the worker cannot run (an agent without shell) and that file is the runner's own core module ("consider a checker job"); `inspect` now shows cost per 1k output tokens per job when tokens are reported.
- `integrate` accepts an optional manifest `preChecks` (an argv array) run before checks whenever any integrated file matches a lockfile pattern (`uv.lock`, `package-lock.json`, `Cargo.lock`, `pnpm-lock.yaml`); when a lockfile changed and no `preChecks` is declared, it warns "lockfile changed, env not synced".
- `integrate` prints a compact `failures` array (check name plus its last failing assertion lines, capped) for every failed check; `validate`/`run` accept `--evidence <file>`, whose failures block is appended verbatim to every job prompt under a fixed heading.
- `run` warns when a job prompt quotes a failure from a runtime check (a check name containing `harness`/`e2e`/`playwright`/`preview`, or the words "Timeout" and "waitFor") and the agent has no shell: "worker cannot reproduce; consider a shell agent or --evidence".
- Job field `contextGlob` now also accepts a filename prefix (`dir/prefix*.ext`, still no `**` and no directory wildcards); `validate` echoes the expanded file count per pattern.
- When a job prompt demands JSON only and the worker's final message does not parse, the job result is marked `resultMissing: true` in state and `inspect`; a `claude` agent gets one cheap re-ask on the same session ("Reply with the JSON only."), and the re-ask answer is used if it parses.
- `ship` resolves `gh` and `git` before doing any real work and refuses at once with "gh not found on PATH" (or the spawn error text) when either is missing; a `pr list failed` reason always includes stderr, or the literal `(empty)` when there is none.
- `scout`/`sweep --brief` may now be any readable path, including one outside the project root: it is read-only and is copied into the scout/sweep directory for provenance, and an unreadable brief fails before its job ever backgrounds.
- SKILL.md's UI-job boilerplate now also says: if a harness view triggers an intended HTTP error, add it to that view's expected-errors list.
- docs/lessons.md entries 21–31.

## 1.16.0

- Add post-build mutants: `integrate --mutants --mutants-file FILE` (a JSON array, or `{mutants:[...]}`) and a job field `mutantsFile` naming one of that job's own outputs, collected automatically once integration writes it; `--mutant-check "<argv json>"` supplies the check when the manifest declares no `mutantCheck`. Both combine with any manifest-declared `mutants` under the same shape and 32-entry cap.
- A worker that exits non-zero, or completes but writes none of its declared outputs, has its last 4 KB of stdout/stderr saved to `agent.log` and a short `agentError` (shown in `inspect`/`inspect --results`), redacting token-shaped secrets; a worker's own `blocked` envelope is reported as job status `blocked` with its summary instead of being masked by a generic "missing output".
- `validate`/`run` warn when a job's `context` lists 3 or more files of one extension from a single directory but that directory holds other files of that extension the context omits (a review round's context copied from an earlier round, missing new captures); add a job field `contextGlob` (simple `dir/*.ext` globs, no `**`) to pick up an entire directory instead of naming each file, expanded at validate/run time. docs/lessons.md entries 18–20.

## 1.15.0

- Point at existing mutation tooling instead of hand-writing mutant scripts: `ship ... --require-section` warns `no manifest mutants: declare "mutants" in the manifest and run "integrate --mutants" (see docs/verification.md)` when the run's manifest declares none, and the skill's ship checklist repeats the line.
- `ship` derives `--repo OWNER/NAME` from `git remote get-url origin` when it is omitted, warns when a given `--repo` differs from origin, and suffixes `(repo moved? origin is OWNER/NAME)` to a gh error containing `HTTP 301/302/307/308` — a bare redirect code no longer hides a renamed repository.
- After merging a version-bump PR, `ship` polls origin for the new release tag (`--tag-timeout`, default 180s) and reports `tag: {name, status, waitedSeconds}`; `update` reports `tagPending: true` instead of "up to date" when origin's version is already ahead of the newest published tag.
- Add a worker-preamble rule: a job that cannot meet a MUST or "do not" rule inside its own outputs must stop and return `blocked` with the file it needs, never work around it; `inspect --results` warns `outside outputs: <job>: <path>` when a job's own `crossJobNames`/`notes` name a real repo path outside its declared outputs.
- `redcheck` reports a clear hint when the test command can't be spawned (pass argv as separate tokens); add `redcheck --base <ref>` to restore from an explicit ref, and warn with `suggestBase` when an omitted `--base` isn't on the default branch.
- Add job field `testEnv` (codex jobs only) to set and name a sandboxed job's required test environment up front; `doctor codex` adds a `sandbox probe` check for the same class of sandbox denial.
- A failing check with `repeat` now reruns against a temporary checkout of the run's base commit and reports `flakeOnBase: {file, failed, runs}`, telling a pre-existing flake apart from a regression without a hand-run repro loop; disable with `--no-flake-check`, override run count with a check's `flakeRuns`.
- Add job field `resultFile` (with optional `resultSchema`) so `inspect --results` reads a worker's declared JSON report file directly, reporting `resultSource` and warning on a missing/invalid file, missing keys, or a mismatch with the worker's own final message.
- docs/lessons.md entries 10–17.

## 1.14.0

- Complete successful jobs with denied reads and surface capped permission warnings; retain changed declared outputs when jobs fail, while keeping failed runs blocked from integration.
- Add `redcheck <run-id> --test <argv...>` to verify regression tests against base implementation bytes, with conflict checks and restoration on command failure.
- Record nine field lessons, a push-only CI diagnostic template, measured evidence versus hypotheses, quieter race tracing, response-release snapshots, one mutant per guard, and fresh context at topic boundaries.

## 1.13.0

- Refuse `--root` on update/version before git access; updates validate the install checkout and target release before checkout.
- Link idempotent agent pointers for any orchestrator, with `--no-agent-files`; seed every missing coordination file individually and report added/kept paths.
- Add generic orchestrator, task, handoff and lessons templates, a 10-dispatch handoff rule, provider consent and spend-ceiling kickoff prompts.
- Add `.swarm/` to linked projects' gitignore and warn about root tool configs without explicit exclusions; document TypeScript, ESLint, Vitest/Jest, Playwright and pytest settings.
- Add opt-in `doctor --probe-local` health checks for loopback Ollama/Lambda; distinguish configuration from reachability without probing cloud keys.
- Discover tests in fresh projects with an empty git index, including projects nested in ignored directories.
- Provide a rendered shared skill for agents without Claude/Codex homes and include linked JSON reference examples; test adapter counts against the real adapter list and fix stale setup/workflow guidance.
- Add an anonymized field report with observed costs, lessons, open work and isolated installation proof. No live model verification or release publication is implied.

## 1.12.0

- Add `swarm sweep --model M --brief FILE --goals FILE [--max-usd N] [--concurrency N] [--top N] [--candidates N] [--known f1,f2,...] [--timeout SECONDS]`: read-only GitHub research across many areas at once (up to 20), each getting its own read-only worker with ≤3 picks and an hours-to-adopt estimate — the same shape as `scout`, but for a batch of tickets in parallel instead of one goal. GitHub data comes only from `gh api` (search, repo, commits, releases, contents), spawned as an argv array with no shell; `gh` reads its own credentials, and the child process never sees `GITHUB_TOKEN`/`GH_TOKEN`. OpenSSF Scorecard is a plain unauthenticated fetch, missing score is `null`, never an error. Every candidate's license, pin (40-hex commit), stars, scorecard, and flags come from code (`tools/sweep.mjs`), never from the model: a disallowed license (only `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MPL-2.0`, `0BSD`, `Unlicense` are kept), an archived repo, or a fork is dropped before the model ever sees it, and a model-supplied license or commit is always overwritten by the matching candidate's own. A cost cap (`--max-usd`, default 15) skips any area not yet launched once spending reaches it, without killing areas already running; the run's status is `partial` when any area failed or was skipped this way. Writes `.swarm/sweeps/<id>/candidates/<area>.json`, `areas/<area>.json`, `shortlist.json`, and `shortlist.md` (a table per area, capped at 3 rows). Results need a human yes before adoption — sweep never installs or runs anything it finds. See [the manifest reference](docs/manifest-reference.md#sweep).

## 1.11.0

- Add `swarm scout --model M --brief FILE [--context f1,f2,...] [--timeout SECONDS] [--max-picks N] "goal"`: one read-only worker searches the web (GitHub first) for open-source code that already does the job before a large build, and returns a structured report. Builders read only the report, never web pages: web text is untrusted, and the runner — not the model — applies the license gate.
- Add a manifest job field `web: true`: adds `WebSearch`/`WebFetch` to a claude worker's `--tools` and passes `--allowedTools WebSearch,WebFetch` (without it the restricted CLI asks for approval and, with no prompt surface, refuses). `validate` refuses `web: true` on a non-claude agent or a job with `outputs`; a web job never gets `Write`, `Edit`, `Bash`, or any other tool.
- `tools/scout.mjs` exports the pure report gate: `SCOUT_LICENSES`, `SCOUT_FLAGGED_LICENSES`, `SCOUT_FITS`, `scoutPrompt`, `normalizeScoutReport`, and `renderScoutMarkdown`. `normalizeScoutReport` keeps only the schema keys at every level, caps strings at 300 characters, moves a pick with a disallowed license (including `NOASSERTION`, `GPL-*`, `AGPL-*`, `LGPL-*`, `SSPL-1.0`, `BUSL-1.1`, or missing) or a non-`https://` url to `rejected`, flags a kept `MPL-2.0` pick, normalizes `commit`/`stars`/`lastCommit`/`fit`, and applies `maxPicks` after that gate. The runner writes `.swarm/scouts/<id>/report.json` and `.swarm/scouts/<id>/report.md`. See [the manifest reference](docs/manifest-reference.md#scout).

## 1.10.2

- Fix the Codex envelope refusal that had hit real runs three times (lessons #41, #64; decision #107): the final JSON is now parsed from the reply's last fenced block when it has one, otherwise its last top-level JSON object, with any keys accepted instead of a fixed `files_changed`/`notes` schema — the actual root cause, since both real failing replies were valid JSON using the shared `filesChanged`/`testsAdded`/`crossJobNames`/`notes` contract, not the malformed data the old schema check implied.
- When that JSON is still missing or does not parse, a codex job now falls back to its worktree's own result file if that alone parses as an object, then to its worktree's actual changes to declared outputs versus its base commit; either fallback still completes the job, keeps its worktree, and `inspect`/`wait` show a `codex envelope fallback: result-file` or `codex envelope fallback: worktree` warning. Only a worktree with no output changes and no parseable result file still fails the job (unchanged error text). Declared outputs are still the only files that ever integrate.
- Remove the now-obsolete `validate` warning that told a codex job's prompt not to ask for final-JSON keys beyond `files_changed`/`notes`; that schema restriction was the bug, not a convention worth preserving.

## 1.10.1

- `inspect --results`, `wait` and `ask` read a worker's final JSON even when it is wrapped in backticks or pretty-printed in a ```json fence (the last fenced object wins); plain final lines work as before.
- `validate`/`run` in a non-git root no longer print git's `fatal: not a git repository` to stderr (the context check's `git ls-files` fallback is now quiet).

## 1.10.0

- Add `swarm board`: a per-user registry of live runs across worktrees (`~/.project-swarm/live`, override with `SWARM_LIVE_DIR`). `run`/`go` now refuse to start a second writer on a file another live run already owns in the same repository (across worktrees), with no override. See [the manifest reference](docs/manifest-reference.md#board).
- Add a job `after` field: an optional list of other job ids in the same manifest that must all reach `complete` before the job starts; a dependent job's workspace receives its dependencies' changed outputs as read-only context. Not yet supported for `codex` jobs. See [the manifest reference](docs/manifest-reference.md#after).
- `checks` entries gain an optional `repeat` (1–20, default 1), running the check's argv up to that many times and stopping at the first failure; add `{new}`/`{new:.ext}` placeholders that expand to integrated files that did not exist before the run started. See [the manifest reference](docs/manifest-reference.md#repeat).
- A manifest's `contract` file is now injected into the codex prompt itself (a "Shared contract" section, read first) instead of only being required in `context`.
- `wait`/`inspect`/`inspect --results` job entries gain `tokens`; the run level gains `tokens` (summed) and `costNotReported` (job ids with no reported cost).

## 1.9.0

- Add `go <manifest.json|run-id> [--commit-message MSG] [--repo OWNER/NAME --pr payload.json] [--require-section NAME]... [--mutants] [--merge-method M] [--timeout S]`: one command from a manifest (or an already-started run) to a merged, reviewed change. It runs `validate`+`run`+`wait` (skipped when given a run id), `integrate` with checks (and mutants when `--mutants` is set or the manifest declares them), stages and commits exactly that run's integrated output files with `git add --` (never `git add -A`) when `--commit-message` is given, then `ship` when `--repo`/`--pr` are given. It prints one JSON line, `{status,stage,runId,cost,warnings,integrate,ship,reason}`, and exits `0` for `merged`/`held`/`ready`/`integrated`/`committed`, `1` for `failed`. See [the manifest reference](docs/manifest-reference.md#go).
- `checks` and `mutantCheck` argv items may now contain `{root}` anywhere inside the item (e.g. `"CARGO_TARGET_DIR={root}/src-tauri/target"`), which expands to the run's absolute project root, so parallel runs never share a build/output folder; `{integrated}`/`{integrated:.ext}` behavior is unchanged.
- Installs are now versioned: `install` snapshots the runtime into `<source>/versions/<version>-<hash8>/` and atomically repoints a `current` symlink at it, so a run already in flight keeps importing its own version dir even after a later install replaces `tools/` underneath it; the 5 newest version dirs are kept and `current`'s target is never deleted. `.swarm-install.json` records `versionDir` and `runner`, and installed skill files resolve `{{SWARM_RUNNER}}` to `<source>/current/tools/swarm.mjs`.
- Run through `current/`, commands with no `--root` (`version`, `update`, self-hosted runs) still target the install checkout, not the `versions/` snapshot; `go` stops at integrate on any surviving mutant, including a manifest's own mutants run without `--mutants`.

## 1.8.0

- `ship --require-section` treats any leftover `<!-- swarm:<name> -->` marker (other than `<!-- swarm:checks -->`, which ship fills itself) as unfilled.
- Job records gain `actualModel` (the model behind most `assistant` events, falling back to the init model then `null`), `modelsSeen` (distinct model ids observed, in first-seen order), and `modelMismatch` (true when an assistant-event model does not match the requested model); `wait` and `inspect` surface each mismatch in a top-level `warnings` array without failing the job.
- Add `swarm ask --model M --context f1,f2,... "question"`, a single read-only job run to completion that prints one JSON line with the worker's parsed result; add `inspect <run-id> --results` to print just `{runId,status,warnings,jobs}` with each job's `result`.
- A codex job whose process exits 0 but whose final envelope fails validation now keeps its worktree, fails the job with `keptWorkspace: <path>`, and `validate` warns when its prompt asks for extra top-level JSON keys beyond `files_changed`/`notes`.
- Context check no longer flags a test's reference to `package.json`, `package-lock.json`, `pyproject.toml`, `uv.lock`, `Cargo.toml`, `Cargo.lock`, or any `__init__.py`; the refusal JSON adds `suggestedIgnoreTests` listing the uncovered tests per job.
- Read-only jobs (`outputs: []`) start the Claude CLI with `--permission-mode default` instead of `plan`, which had silently run a different model than requested.
- Document `ask`, `inspect --results`, the model-mismatch warning, and `suggestedIgnoreTests` in the skill, README, and manifest reference; fix the skill's adapter count.

## 1.7.0

- Add `ship <run-id> --repo OWNER/NAME --pr payload.json`: push an integrated run's branch, open or update its pull request, re-run the manifest's `checks` and fill them into the PR body, wait for CI, and merge once green; refuses on a dirty tree, a failed check, a missing required `--require-section`, or a rejected push, and never merges a PR body opening with a `**needs ` human-review marker. Add a job `ignoreTests` field and a top-level manifest `contract` field: `validate`/`run` now refuse a job whose existing declared output is referenced by a project test missing from its `context`/`outputs`/`ignoreTests`, and, when `contract` names a shared file, refuse any job whose `context` omits it or whose `outputs` includes it (1.7.0)

## 1.6.0

- `wait`, `inspect` shows worker notes and cost, `validate` refuses untracked codex context, `integrate --mutants` mutation checks; CI actions SHA-pinned (1.6.0)

## 1.5.1

- Repository moved to `RDW-Labz/project-swarm`: `package.json` `repository.url`, README and setup clone URLs updated (1.5.1)

## 1.5.0

- One shared install per machine, agent-readable install steps, onboard/version/update commands (1.5.0)

## 1.4.0

- Add a sandboxed `codex` worker agent (Codex CLI in a per-job git worktree, macOS seatbelt; 1.4.0)
- Disable chat-template thinking on self-hosted Lambda origins, where a reasoning model behind the strict JSON envelope spends its whole output allowance on reasoning and returns no content; `SWARM_LAMBDA_THINKING=on` opts back in, and hosted Lambda Inference is unchanged.

## 1.3.0

- integrate runs manifest checks (format, tests) right after writing files (1.3.0)
- Fix `doctor` false-negative "lacks required flags" against Claude CLI 2.1.280+: its `--help` output can exit before the stdout pipe drains, truncating a piped read. `doctor` and `extraCliDoctor` now read CLI help through a shared temp-file-backed runner (`execViaFile`, the new default for the injectable `exec`), retry once if flags look missing, and report a distinct "help probe failed (no or empty output)" error when the read itself is empty rather than misreporting missing flags.
- Require an explicit non-empty `model` on every job, CLI or API: `validateManifest` now refuses a job with no `model` (`Job <id> requires an explicit model; the runner never uses a CLI default`), so Claude jobs can no longer silently fall back to the user's own installed CLI default model.
- Add `monitor <run-id> --view` (a dependency-free human table: id/agent/model/tier/status/elapsed/output count, a running·done·failed·queued summary, and per-provider usage) and `--watch [seconds]` to redraw it in place until the run finishes; the default JSON `monitor` output is unchanged.
- Replace topic-based routing checklist with difficulty-based rule: route by how hard the work is, not what topics it involves. `cheap` covers small follow-ups and bookkeeping regardless of domain; `mid` covers ordinary code and tests; `expensive` covers genuinely hard work or escalations after two mid-tier failures.
- Add an optional per-job `tier` (`cheap`/`mid`/`expensive`) and `tierReason` manifest field so model routing is a written, reviewable decision instead of gut feel. `expensive` requires a non-empty `tierReason`; an explicit `model` always wins over `tier`; a manifest with no `tier` behaves exactly as before. `tier` is validated metadata, surfaced in `preflight` and `inspect` output, and does not itself select a model. Document the routing guidance in the skill and orchestration guide; the failed-twice escalation is a coordinator rule, since the runner has no retry/re-dispatch path to hook it into.
- Check decoded API output strings for echoed provider keys before saving summaries, files, or metadata, including JSON-escaped echoes.
- Give every Lambda request a fresh routing-session nonce, including repeated runs with the same job ID in one process.
- Add preflight context breakdowns, snapshot-dependency warnings, and task-sizing advisories.
- Teach coordinators to split independent deliverables, use small integration batches, and preserve one writer per file.
- Add content-free live CLI output telemetry with explicit non-streaming API limitations.
- Document a real parallel connector/village build, measured integration waiting, and validation limits.
- Include new runtime modules and regression suites in the installer.

## 1.2.1

- Add a `lambda` adapter: one OpenAI-compatible chat-completions request with a strict JSON schema and no tools, against hosted Lambda Inference or an operator-owned `SWARM_LAMBDA_URL` origin under the existing origin rules.
- Reject Lambda responses that are truncated, refused, tool-calling, or absent, and keep `LAMBDA_API_KEY` out of logs and saved outputs.
- Package validation uses mocked transport; hosted Lambda access remains unverified. The contributor reports a separate self-hosted vLLM exercise; this is not a guarantee of another account or model.
- Increase startup headroom in two timeout tests without weakening their assertions.
- Keep fresh checkouts on LF and accept existing CRLF skill frontmatter in package checks.
- Anonymize the public website case study and remove customer-specific implementation details.
- Refresh provider discovery and document safe public contributions.


## 1.2.0

- Add restricted Hermes and Qwen Code CLI adapters with copied text and validated complete-file JSON output. Reject tool activity, malformed/duplicate results, and unsuccessful exits.
- Increase opt-in concurrency to 32 and queue capacity to 256; default concurrency remains 2.
- Clean owned process groups after normal exits, errors, cancellation, and timeouts, including inherited-open streams. Surface signal permission failures instead of claiming successful cleanup. Escaped groups remain outside scope.
- Show job status in inspection and block incomplete jobs, with explicit whole-run conflict recovery guidance.
- Persist the actual serialized Hermes/Qwen prompt and schema for review.
- Record queue/start/finish times, durations, observed peak activity, per-provider numeric usage, and concise `monitor` snapshots.
- Add active orchestration guidance, bounded CLI smoke recipes, parser/compatibility tests, and installed runtime support.
- CLI compatibility and authenticated live verification remain separate. New adapters are mock-process tested; live account access is not claimed.


## 1.1.0

- Add OpenAI Responses, Gemini generateContent, and local/explicit HTTPS Ollama adapters without npm dependencies.
- Share copied context, exact output ownership, review, and conflict-checked integration across providers.
- Validate structured complete-file responses; reject binary context, unexpected outputs, refusals, truncation, and oversized responses.
- Bound HTTP lifetimes, refuse redirects, omit raw HTTP errors/headers, and preserve credentials outside logs.
- Add provider configuration reports, mixed-provider recipes, API smoke templates, and complete installation of adapter runtime/tests.
- Raise opt-in concurrency to 16 while preserving the default 2. Test four active requests/processes and queued-job cancellation.
- API contract tests are deterministic mocks; live API account/model support is not claimed.


## 1.0.0

First standalone package extracted from the example website project's local orchestration tools.

- Fresh Claude Code workers with explicit model selection and concurrency from one to three.
- Explicit input/output manifests, copied workspaces, bounded runtime and logs, and local run records.
- Saved responses with provider metadata when available, status inspection, and cancellation of owned workers.
- Conflict-checked integration of declared outputs, with file-mode preservation and no deletion propagation.
- Local prerequisite diagnostics, manifest validation, and proposed-change inspection.
- An explicit target-project root option and an installer that refuses destination overwrites.
- A reusable orchestration skill, smoke and parallel-review examples, deterministic tests, and setup and extension guides.
- A factual website case study distinguishing direct CLI implementation from reusable-runner smoke and review jobs.
- Apache License 2.0.

In 1.0.0, the supported adapter was Claude Code only. Copied workspaces are not an OS security sandbox; Windows support is not claimed.

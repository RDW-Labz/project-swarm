# Scope, tickets and the build plan

Phase 13. You write one scope file. The swarm splits it into small tickets, you approve the plan once, and the swarm builds the tickets in waves.

## The flow

1. `swarm scope template --out docs/scope/scope.md`, then fill it in. Each requirement is one testable sentence with an `Acceptance:` list.
2. `swarm scope check` flags missing acceptance, duplicate ids and vague words. It also lists the outside services that need an owner on day 0 (Stripe, domain, email, app stores).
3. `swarm scope split` writes `docs/scope/split/manifest.json`: one job per stage. Run it with `swarm run docs/scope/split/manifest.json`.
4. `swarm scope split --ingest RUN` reads the ticket lists from that run, assigns ids, adds the day 0 human tickets, runs the integrity checks and writes the ledger (`.swarm/project/tickets.json`), not approved. A bad file refuses the whole ingest and names the problem.
5. `swarm scope approve` prints a short summary (stages, waves, estimate, risks). `swarm scope approve --yes` records your approval and writes `docs/scope/build-plan.md`. It refuses when coverage is below 100%, a ticket has no requirement, two parallel tickets write the same file, or the scope file changed after the split.
6. `swarm go --scope [--max-jobs N]` builds a manifest from the ready tickets (dependencies done), marks them running and starts the normal `go` run. It refuses an unapproved ledger, a ticket set edited since approval, or a scope file that is missing or changed since approval. Only one wave starts at a time (a lock). `--max-jobs` must be a positive whole number. Human tickets wait for you (`swarm tickets T-9001 --set done`).
7. After the run: `swarm scope sync RUN` moves finished tickets to review and failed ones to blocked. After `swarm integrate RUN`: `swarm scope sync RUN --integrated` marks that run's finished tickets done (it refuses a run that is not integrated). Then `swarm go --scope` again for the next wave.

`swarm tickets` lists tickets (filters `--stage --status --type --risk`, `--json`); `swarm tickets T-0002` shows one; `swarm tickets T-0002 --set ready --note "why"` moves one by hand (only legal moves). `swarm brief` shows ticket progress.

## Contracts first

`swarm scope contracts contracts/api.json --yes` (it asks for `--yes` because you approve contracts, and when it would overwrite files) takes an OpenAPI 3 JSON file (the contract ticket's output, which you approve) and generates `contracts/types.d.ts`, `validators.mjs`, `client.mjs`, `mock-server.mjs`, `seed.json` and `contract.test.mjs`. The mock API answers from seed data, so front-end and back-end tickets can run in parallel before either exists. The contract tests run against the mock and later against the real API (set `CONTRACT_BASE_URL`).

## Change orders

Edit the scope file, then `swarm change "why"`. It compares the new scope with the approved snapshot and shows what it cancels, reopens and needs new tickets for, with a rough cost. `--yes` records it and keeps the ledger approved (history is kept, the old snapshot is saved under the order id; cancelled tickets stay in the ledger). Then `swarm scope split` (only requirements without tickets are split) and `swarm scope split --ingest RUN --merge`. A merge adds worker-written tickets, so it clears the approval: run `swarm scope approve --yes` again before `go --scope`.

## Approval policy

The profile in `.project-swarm.json` may carry an `approval` block: `autoMergeToStageBranch` (default true), `humanApprovals` (default scope, contracts, design-gallery, final-stage-pr), `changeOrderOverUsd` (default 20), `budgetUsd` (default none). Anything unknown fails closed: it needs you. Nothing here merges to main or deploys.

## Safety

The split jobs are `sensitive: true` (they see your whole scope), so they never go to a rented, OpenRouter, OpenAI, Gemini or Lambda lane. Tickets are sensitive when the worker says so or their text names something in the scope's Sensitive list. Put no secrets or customer data in the scope file.

## Done means checked (lessons 28 to 32)

Design: [plans/lessons-28-32-design.md](plans/lessons-28-32-design.md).

- **Quality gate.** Every merge batch that holds a build ticket also runs the project's typecheck and lint (found in `package.json` scripts `typecheck` or `type-check` and `lint`, or `tsc --noEmit` when there is a `tsconfig.json`). `build` is off unless you opt in. Profile block `quality`: `{ "typecheck": ["npx","tsc","--noEmit"], "lint": false, "build": true }` (an argv replaces the detected command, `false` turns it off, `true` means the package script). `scope sync --integrated` keeps a build ticket in review until those checks passed on the batch that integrated it. No test is needed for this.
- **Escalation instead of a person.** A job that fails, or whose answer was cut off (`max_tokens`, `output-cap-exceeded`), sends its ticket back to ready one level higher: level 1 a bigger output (up to 32768 tokens), level 2 Codex first (it edits in place, no output cap), level 3 Claude (`expensive`). A cut-off answer starts at level 2. Only when level 3 fails does the ticket block (`blockReason: failure`). `swarm scope split` tells the worker to keep tickets to 4 files and about 12 KB each, and `scope approve` warns about tickets that look too big.
- **One-time migration for older ledgers.** Tickets blocked before `blockReason` existed have no reason, so they never unlock by themselves. Run `swarm tickets --mark-deps` to list the blocked tickets that have no reason, no failed attempts and dependencies, then `swarm tickets --mark-deps --yes` to mark them as dependency-blocked (add ticket ids to mark only those). Ones whose dependencies are already done become ready at once; the rest unlock when their dependencies are done. Tickets that failed before (they have attempts or a retry note) and tickets you blocked by hand with `--set blocked` are never touched.
- **Auto-unlock.** A ticket blocked only by dependencies (its job was skipped because one it waits on failed) becomes ready when all of them are done: `swarm go --scope` and `autopilot` both do it. Tickets blocked by failure or by hand (`swarm tickets ID --set blocked`) stay blocked.
- **Real test commands.** A test check that passes but ran 0 tests (wrong runner for the files, for example `node --test` on vitest files) now fails with `no-tests`. `scope approve` prints the test command detected from `package.json` (vitest, jest, playwright, node:test, pytest) when the profile has no `verify` block.
- **Example env names.** The variable names (never values) in `.env.example` are added to every ticket prompt.

## Wiring and release (lesson 34)

- **Integration ticket per requirement.** `scope split` asks for one ticket per requirement with build tickets that mounts the modules in real routes or pages (`integration: true`, with a route-level or end-to-end test in `tests`). The runner adds its dependencies on the module tickets of the same requirements. A split without it, or with an integration ticket that has no test, is refused. A requirement counts as done (Build Plan, coverage) only when its integration ticket is done, so the test passed. Older ledgers: `swarm scope split --wire` writes a manifest that asks only for the missing integration tickets; run it, then `swarm scope split --ingest RUN --merge --wire` (`--wire` refuses anything but integration tickets) and `swarm scope approve --yes`. A ledger made before this rule is not held to it (`ledger.wiring` stays unset), but every new ingest must wire the requirements it touches.
- **Roots are released.** `go --scope` and autopilot move `todo` tickets whose dependencies are all done (a stage's roots have none) to `ready` by themselves (log event `release`); human tickets wait for a person.
- **Cancel cleans dependencies.** Cancelling a ticket removes it from the `dependsOn` of the others; `go --scope` also cleans ledgers that still list a cancelled dependency. A valid approval stays valid. A deps-blocked ticket with nothing left to wait for unlocks.
- **Quality failures go back.** A typecheck, lint or build check that failed (in the merge batch, or in a plain integrate) sends the ticket back to the worker with the errors in the retry note. A check that never ran leaves the ticket in review, and a check that fails for 3 or more tickets of one run is treated as the base or the setup (no paid retries). A merge batch of one job blames that job; a run-wide check (plain integrate) with several failing tickets sends back only the ticket whose files the errors name, and the others stay in review.
- **Build files are not dropped writes.** `tsconfig.tsbuildinfo`, `coverage/`, `.next/`, `node_modules/`, `dist/`, caches and anything the project's `.gitignore` names are ignored by the dropped-write check, so `--accept-dropped` is not needed for them. Files git tracks, secret-looking files (`.env*`, keys, `*.pem`, `*.tfvars` ...) and files hidden only by a catch-all rule (`*`) are still reported.

## The --wire flow (lesson 37)

`swarm scope split --wire` skips requirements that are already built and done (add `--all` to include them). Integration tickets that write the same file are chained at ingest, the later one after the earlier, across stages. `.env.example` and other names-only example files can be context; they cannot be outputs. A file conflict error names the tickets and the file.
## Edit a ticket's files, and approve a reviewed manifest

- `swarm tickets T-0007 --files src/a.ts,src/b.ts --context docs/x.md --tests tests/a.test.ts` shows the change; add `--yes` to apply it. Only a todo, ready, blocked or review ticket can change. A file another live ticket writes is refused. An approved ledger stays approved (sealed again over the new lists); a ledger that was not approved stays that way. The log has a `ticket-edit` line.
- A failed tests check at `scope sync --integrated` goes back to the worker with the failure, the same as typecheck and lint.
- When the security gate blocks a dependency or workflow file ("the owner must review it"), read it, then run `swarm integrate RUN --approve-manifest FILE`. It is for that run only and is written to the journal as a decision.

`--approve-manifest FILE` approves the exact content the workers proposed (its sha256 is in the decision record). If the file changes afterwards, the gate blocks it again until you approve it again.
## Tool config files and database tests

- `scope split`, `scope approve` and `scope check` warn when an acceptance check runs a tool command (supabase, cypress, prisma, drizzle-kit) and no ticket writes its config file (for example `supabase/config.toml`) and the project has none.
- A ticket that writes or runs database tests gets the runner rules in its prompt (pgTAP: every .sql under the tests folder runs; `\ir` stays inside the mounted folder; no dblink as a non-superuser).
- A manifest command that stops processes by a loose pattern (`pkill`, `killall`, `kill $(pgrep ...)`) is refused with `loose-kill`.

## Integration test path and shared files

The route-level test of an integration ticket must be a test file (a tests, e2e or spec folder, or a `.test` or `.spec` file). Integration tickets that write the same file are chained by the runner, the later one after the earlier.

## S6 fixes (1.97.0)

- A check that failed on the batch or the run keeps all its tickets out of done (tickets with no tests too). A one-job batch goes back to the worker.
- Invented `dependsOn` keys from a split worker are dropped with a note.
- `--help` never acts. A failure that is not the ticket's own (credit, rate limit, host or network down, run stopped) returns the ticket to ready at the same level (three times at most). Output that already matches the tree does not need integration evidence.
- `swarm tickets T-0007 T-0008 --release` is the clean release of held tickets (attempts, escalation and retry notes cleared).

## Moving files, deleting files, editing acceptance (lesson 39)

- `swarm tickets T-0091 --files src/a.ts,src/useShops.ts --take-from T-0090 --yes` moves `src/useShops.ts` from T-0090 (even if it is done) to T-0091; logged as `file-move`.
- `--take-from T-0090,T-0091` names several tickets: a file with two owners moves when both are named, and the moved files may be written (`--files`) or deleted (`--deletes`) by this ticket in one step.
- `dependencies` on a ticket (`--dependencies zod,zod@^3`) are npm packages the runner installs: `integrate --queue` builds the new `package.json` and lockfile with no install scripts, the security gate audits them, and `npm install --ignore-scripts` adds them after the gate passed.
- **Acceptance lines are enforced.** Before a build, test, migration or contract ticket reaches done at `scope sync --integrated`, every line of its `acceptance` (numbered AC1, AC2, ... in order) is covered by a passing test or checked by the acceptance review, and the result is listed per line.
  - A line is **covered by a test** when a test file the ticket names has a (not skipped) test whose title carries the tag, for example `test('AC2: rejects a reply link with a bad host', ...)`, and the runner saw the tests pass (the profile's `verify` block). The worker prompt lists the lines with their tags and asks for this.
  - A file that can switch tests off (`describe.skip`, an options object with `skip` or `todo`, `.only`, `skipIf`, a pytest or Go skip) counts no titles; a title with two different tags covers nothing; only real test files that the tests check runs for this ticket count; an owner-accepted failed test run or output already in the tree is not "seen passing".
  - Any other line goes to **one read-only review job** per run (Sonnet by default, `profile.acceptance.model` can be `opus`): sync writes `.swarm/acceptance-reviews/RUN.json`; run it, record it with `swarm scope acceptance-review REVIEWRUN`, sync again. The review answers pass or fail per line with a reason. A verdict counts only for the code it was made on (a hash of the ticket's files and tests).
  - A ticket with a **missing** line stays in review. A **failing** line sends it back to the worker with the line and the reason. An unusable review answer is asked again once (like the security review); if it is still unusable the ticket is `acceptance-blocked` (stays in review, shown in swarm watch).
  - The per-line results are stored on the ticket (`acceptanceResults`), printed by sync (`acceptance: T-0168 AC1 pass (test), AC2 pass (review)`) and shown in the swarm watch ticket drawer.
  - The way out is `--accept-unmet T-0001 --reason TEXT --yes` (logged, kept on the ticket as `accepted`); a failing line is never overridden.
  - It applies to projects that have a profile (`swarm init`); `"acceptance": {"enforce": false}` turns it off.
- A ticket that touches auth, an API route, a migration or policy, or a sensitive path stays in review at `scope sync --integrated` until an Opus review passed: run `.swarm/security-reviews/RUN.json`, record it with `swarm scope security-review REVIEWRUN`, sync again. If the review's answer has no `{"reviews":[...]}` result, `scope security-review` asks the same review once more with a format reminder (one extra Opus run, capped at $1.5, at most once per review). If that is also unusable the tickets are **review-blocked**: they stay in review (never done), the ledger and the log say why, and sync lists them as `review-blocked`; write a new review with `scope sync RUN --integrated` and run it, or take the risk with `--accept-unreviewed T-0001 --reason TEXT --yes`. The reason (at least 8 characters) is required; it is logged, stored on the ticket (`securityReview`) and shown in swarm watch (the plan cards and the ticket drawer).
- The build check runs on every batch when `package.json` has a `build` script (`quality: {build: false}` turns it off). A ticket's named test files must exist before done.
- A ticket may list `deletes`; the worker deletes exactly those files. Deleting a manifest, lockfile, workflow or the profile is blocked by the security gate until `swarm integrate RUN --approve-manifest FILE`.
- `swarm tickets T-0007 --acceptance "check one ;; check two"` (todo, ready, blocked) or `--add-acceptance "check three"` (any status but running).
- A ticket's e2e spec must be run by the project's e2e command; `scope check` warns when it would not be.

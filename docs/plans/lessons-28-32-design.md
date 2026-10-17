# Lessons 28 to 32: gaps from the parts app S4 report

Five gaps and two small fixes. Each gets a pure module (built by workers from this contract), wiring (by hand), and a scenario eval in `tests/lesson-NN-eval.test.mjs` that fails on the old behavior and passes on the new. Worker-facing golden evals in `evals/` cannot test runner behavior, so these scenarios are the proof.

All modules: ES modules, node built-ins only, pure unless stated. Text from tools or workers is cut to the stated length.

## 28. Quality gate: typecheck, lint, build before done (`tools/quality-checks.mjs`)

Profile block `quality` (optional): `{ typecheck, lint, build }`. Each is an argv array, `false` (off), or absent (auto-detect). `build` defaults to off (the owner opts in with an argv or `true`, which means the package script `build`).

- `deriveQualityChecks({ pkg, hasTsconfig, manager = 'npm', config = {} })` returns an array of `{ name, argv }` in the order typecheck, lint, build. `pkg` is a parsed package.json (or null). Auto-detect: `typecheck` from `scripts.typecheck` or `scripts['type-check']` (run with the manager's run command: `npm run typecheck`, `pnpm run typecheck`, `yarn run typecheck`), else `['npx', 'tsc', '--noEmit']` when `hasTsconfig`; `lint` from `scripts.lint`; `build` only when `config.build` is an argv or `true` (then `scripts.build`, if present). A `config` entry that is an argv replaces the detected one; `false` removes it. No other checks are returned.
- `qualityChecksForJobs(jobs, derived, { timeoutMs = 600000 } = {})`: returns `[]` when no job in `jobs` has `type` `build`; otherwise `derived` mapped to `{ name, argv, timeoutMs }`.
- `qualityEvidence(state, jobId, names)`: `names` is the list of check names that must have passed. Find the merge-queue batch in `state.mergeQueue.batches` that integrated the job (use `state.mergeQueue.integratedIn[jobId]` as the batch id when present, else the last batch whose `jobs` contain the job; a job entry is a string id or an object with `id`). Returns `{ ok: true, reason }` when the batch has `checks` equal to `passed` and every name in `names` has an entry in `checkResults` with `status` `passed`; otherwise `{ ok: false, reason }` where the reason names the first missing or failing check (`no typecheck check ran in batch b1`, `lint check is failed in batch b1`) or says there is no batch for the job. An empty `names` returns `{ ok: true, reason: 'no quality checks configured' }`.

Wiring: `ticketsToManifest` adds the checks (after the tests check); `scope sync --integrated` keeps a build ticket in review until `qualityEvidence` is ok; a failed check retries the ticket once with the error tail (the merge queue already does this) and then escalates (28 feeds 29); `swarm init` detects and records `quality`.

## 29. Auto-escalate instead of a human (`tools/escalation.mjs`)

- `isTruncation(error)`: true when the error text (string, any case) contains `max_tokens`, `truncated` or `output-cap-exceeded`.
- `MAX_LEVEL` is 3. `nextStep(ticket, { error } = {})` returns `{ level, status, kind, reason }`. `level` = `(ticket.escalation ?? 0) + 1`. `kind` is `truncated` when `isTruncation(error)`, else `failed`. `status` is `ready` while `level <= MAX_LEVEL`, else `blocked`. `reason` is a short text, for example `escalated to level 2 after truncated output` or `blocked: 3 escalations failed`. A truncated ticket skips straight to level 2 at least (`level = max(level, 2)`) but never above `MAX_LEVEL + 1`.
- `routingFor(level, base = {})` returns the job fields for a level; `base.maxOutputTokens` defaults to 8192. Level 0 and 1: `{}` plus, at level 1, `maxOutputTokens` doubled (at most 32768). Level 2: `{ maxOutputTokens: 32768, hard: true }` (the router sends hard tickets to Codex first, which edits in place with no output cap). Level 3: `{ maxOutputTokens: 32768, tier: 'expensive', tierReason: 'escalated after 3 failed attempts' }` (starts at Claude). Never returns an `agent` or `model`.
- `sizeTicket(ticket, { sizes = {}, capBytes = 15360, maxFiles = 4 } = {})`: `sizes` maps a file path to its current byte size. Returns `{ ok, reasons }`. A ticket is too big when it has more than `maxFiles` output files (files not ending in `/`), or when the sum of `sizes[file] ?? 0` over its files is above `capBytes * 0.6` (a rewrite of existing big files will not fit), or when one file's size is above `capBytes * 0.8`. `reasons` has one short sentence per problem. Folder entries are ignored.

Wiring: the non-integrated `scope sync` moves a failed job's ticket to `ready` with `escalation` and `retryNote` from `nextStep` (blocked only after level 3, with `blockReason: 'failure'`); `ticketsToManifest` applies `routingFor(ticket.escalation)` to the job; `scope check` warns on tickets that `sizeTicket` rejects (and `scope split` prompts say to keep tickets small).

## 30. Auto-unlock blocked tickets (`tools/ticket-unlock.mjs`)

- `findUnlockable(tickets)` returns the ids (sorted) of tickets with `status` `blocked`, `blockReason` equal to `deps` or not set, no `attempts` and no `retryNote`, a non-empty `dependsOn`, and every id in `dependsOn` present with status `done`. Tickets whose `blockReason` is `failure` or `manual` are never returned. A dependency that is missing or cancelled blocks the unlock.
- `unlockReady(ledger)` returns `{ ledger, unlocked }`: a copy of the ledger where each unlockable ticket has `status: 'ready'`, and the list of ids. It never mutates its input and never changes `approved`.

Wiring: `swarm go --scope` and `autopilot` call it (one locked ledger write, one `unlock` line in the ticket log) before they pick ready tickets; `swarm tickets --set blocked` records `blockReason: 'manual'`.

## 31. UI check: own server, free port, steps (`tools/ui-server.mjs`)

- `async freePort()` returns a free TCP port on 127.0.0.1 (listen on port 0, read the port, close).
- `expandStart(argv, port)` returns a copy of the argv array with every `{port}` replaced by the port as text. `startEnv(port, env = {})` returns `{ ...env, PORT: String(port), SWARM_UI_PORT: String(port) }`.
- `screenUrl(base, screen)` returns `base + screen.route`.
- `mockupUrlSuffix(screen)` returns `''` when `screen.mockupQuery` is missing, else `'?' + mockupQuery` when it matches `^[A-Za-z0-9_=&.-]{1,100}$` and has no `#`; an invalid value throws `Error('invalid mockupQuery')`.
- `validWaitFor(value)` is true for a string of 1 to 100 characters that matches `^[A-Za-z0-9_#.\[\]=" -]+$`.

Wiring (ui-check): when the profile has `start`, the check always starts its own server on a free port (`{port}` in `start` and the `PORT` variable carry it) and uses that base url; a server already running at `baseUrl` is not used and not stopped; the verdict records `serverStarted: true`. Screens may set `mockupQuery` (a state of the mockup file, such as `step=2`) and `waitFor` (a selector awaited before the screenshot); the same `route` with a query string is how a page shows another state. `scope sync --integrated` already accepts a passing check as evidence; with the own-server rule it is never rejected for using the owner's dev server.

## 32. Real test commands, zero tests is a failure (`tools/zero-tests.mjs`)

- `countTests(output)` returns `{ runner, count }` from the text of a test run. Rules, first match wins, case-insensitive: node:test prints `# tests N` (runner `node`); TAP `1..0` is count 0 (`tap`); vitest prints `Tests  N passed` or `Test Files  N` and `No test files found` is count 0 (`vitest`); jest prints `Tests:       N` and `No tests found` is count 0 (`jest`); pytest prints `N passed`, `N failed` (sum them) and `no tests ran` or `collected 0 items` is count 0 (`pytest`); go prints `no test files` is count 0 (`go`). When nothing matches it returns `{ runner: null, count: null }`.
- `isTestCheck(name)` is true for names `test`, `tests` (also `test:unit`, `unit` ...: any name that is `test`, `tests` or starts with `test:`).
- `zeroTestGuard(check, result)` returns `result` unchanged unless `isTestCheck(check.name)`, `result.status` is `passed` and `countTests(result.tail).count` is 0; then it returns `{ ...result, status: 'failed', noTests: true, tail: <old tail> + a final line 'no-tests: the check passed but ran 0 tests (wrong test runner for these files?)' }`.
- `detectTestCommand({ pkg, files = [] })` returns `{ runner, command }` or null: `runner` is `vitest` when `pkg.devDependencies` or `dependencies` has `vitest`, else `jest` when it has `jest`, else `playwright` for `@playwright/test`, else `node` when `scripts.test` contains `node --test`, else `pytest` when `files` has `pyproject.toml` or `pytest.ini`. `command` uses the `{tests}` token: vitest `['npx', 'vitest', 'run', '{tests}']`, jest `['npx', 'jest', '{tests}']`, playwright `['npx', 'playwright', 'test', '{tests}']`, node `['node', '--test', '{tests}']`, pytest `['pytest', '{tests}']`. When both vitest and `node --test` appear, vitest wins.

Wiring: `runChecks` applies `zeroTestGuard` to every finished check; `swarm init --check` and `scope approve` print the detected command when the profile has no `verify` block; `doneEvidence` already requires a passed tests check, now meaning at least one test ran.

## Small fixes

- `lesson add --area`: the error listed fixed names (`process`, `docs`...) that the command then rejected. The area is `tool`, `gotchas`, or a skill folder in `coordination/skills/`. `lessonAreas(root)` (in `tools/lessons.mjs`) returns the real list; the error, `lesson --help` and the docs use it.
- `.env.example` names in ticket context (`tools/env-names.mjs`): `parseEnvNames(text)` returns the sorted, unique variable names from lines of the form `NAME=...` or `export NAME=...` where `NAME` matches `^[A-Z][A-Z0-9_]{0,63}$`; values and comments are never returned, and at most 100 names. `envNamesLine(names)` returns `''` for no names, else `Environment variable names this project reads (names only, values are not shared): A, B, C.` Wiring: `buildTicketContext` callers add the line to every build ticket prompt when the root has an `.env.example`.

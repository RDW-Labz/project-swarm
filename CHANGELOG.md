# Changelog

## 1.24.0

- New `openrouter` API adapter (the ninth): OpenAI-compatible chat completions via OpenRouter, key from `OPENROUTER_API_KEY` or the macOS keychain item `OASIS`/`openrouter.api_key`, read by the coordinator only. Enforced in code before any request: `provider.data_collection: "deny"` on every body (a body without it is refused), `anthropic/*` models pinned to the Anthropic provider with no fallback, `deepseek/*` models limited to bookkeeping outputs (refused at `validate` and at run), and spend caps of $5 per job id and $25 per UTC day checked against a priced worst case (unpriceable = refused), with every request appended to `logs/openrouter-spend.jsonl`. New module `tools/openrouter.mjs`; tests in `tests/openrouter.test.mjs` (12/12 mutants killed).
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
- docs/lessons.md entries 81–84.

## 1.23.0

- Fixed: `scout --brief` (like any relative path flag on `scout`/`ask`) resolved only against `--root`, not the cwd the user actually typed it from; `swarm scout --root repos/desktop-app --brief coordination/research/brief.md` failed "brief not found" for a path that only ever made sense relative to the cwd. A relative `--brief` is now tried against the cwd first, then against `--root`, and the not-found error names every path actually tried. `ship`/`go`'s `--pr PAYLOAD.json` had the identical bug (`ship --branch` and `ship <run-id>` both resolved it only against `--root`) and gets the same fix, via the new `resolvePathCwdThenRoot` (lesson #169).
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
- Shell-job auth uses a worker key from `SWARM_CLAUDE_WORKER_API_KEY`, else the existing keychain item `OASIS`/`anthropic.api_key`, read by the parent only and passed as `ANTHROPIC_API_KEY` in an allowlisted child env (job-scoped `HOME`/`CLAUDE_CONFIG_DIR`); missing refuses, never falling back to the person's claude login. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` hides the key from Bash commands; saved logs redact it; `integrate` and `ship` refuse a shell run whose saved files, outputs or payload contain it.
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

- Add `swarm sweep --model M --brief FILE --goals FILE [--max-usd N] [--concurrency N] [--top N] [--candidates N] [--known f1,f2,...] [--timeout SECONDS]` (OASIS decision #124): read-only GitHub research across many areas at once (up to 20), each getting its own read-only worker with ≤3 picks and an hours-to-adopt estimate — the same shape as `scout`, but for a batch of tickets in parallel instead of one goal. GitHub data comes only from `gh api` (search, repo, commits, releases, contents), spawned as an argv array with no shell; `gh` reads its own credentials, and the child process never sees `GITHUB_TOKEN`/`GH_TOKEN`. OpenSSF Scorecard is a plain unauthenticated fetch, missing score is `null`, never an error. Every candidate's license, pin (40-hex commit), stars, scorecard, and flags come from code (`tools/sweep.mjs`), never from the model: a disallowed license (only `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MPL-2.0`, `0BSD`, `Unlicense` are kept), an archived repo, or a fork is dropped before the model ever sees it, and a model-supplied license or commit is always overwritten by the matching candidate's own. A cost cap (`--max-usd`, default 15) skips any area not yet launched once spending reaches it, without killing areas already running; the run's status is `partial` when any area failed or was skipped this way. Writes `.swarm/sweeps/<id>/candidates/<area>.json`, `areas/<area>.json`, `shortlist.json`, and `shortlist.md` (a table per area, capped at 3 rows). Results need a human yes before adoption — sweep never installs or runs anything it finds. See [the manifest reference](docs/manifest-reference.md#sweep).

## 1.11.0

- Add `swarm scout --model M --brief FILE [--context f1,f2,...] [--timeout SECONDS] [--max-picks N] "goal"` (OASIS decision #112): one read-only worker searches the web (GitHub first) for open-source code that already does the job before a large build, and returns a structured report. Builders read only the report, never web pages: web text is untrusted, and the runner — not the model — applies the license gate.
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

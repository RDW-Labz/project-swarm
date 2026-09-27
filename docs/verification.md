# 1.15.0 verification and next steps

Release checks use local fake workers, synthetic provider responses and
isolated temporary projects. They do not make model calls or publish a tag.

## Verified

| Command / action | Outcome |
| --- | --- |
| `SWARM_LIVE_DIR="$PWD/.swarm/test-live" npm test` | 403 passed; 0 failed, skipped or cancelled; 14 new release tests |
| `npm run check` | Passed: syntax, local links, packaging, license, skill and examples |
| `git diff --check` | Passed |

The default test invocation encountered denied access to the user-level live
registry. Setting `SWARM_LIVE_DIR` to an isolated directory under the worktree
avoids shared live-run state. No dependency or network access is required.

The release tests exercise denial-only completion and integration, warning
format and caps, other failures that must stay failed, missing results and
outputs, and retained changed workspaces. Redcheck tests exercise a real
regression assertion against base bytes, green results, each test filename
pattern, absent base files, executable modes, multibyte output tails,
conflicting edits, hash-verified git fallback, metadata and lock refusals,
launch errors, timeouts, signals, CLI exit codes and literal argv forwarding.

These checks are local and synthetic evidence. Live provider verification,
release tagging and publication remain separate work; a version bump is not
evidence that a release was published.

## Regression and mutation evidence

First run the new regression test with the fix and record the passing result.
Then run `node tools/swarm.mjs redcheck <run-id> --test <argv...>` and inspect
its tail: the intended assertion must fail against base code. A worker's claim
is not evidence, and an unrelated setup failure is not regression coverage.
Run the test again after restoration.

Add **one mutant per new guard before shipping**. In one field run, mutation
testing found three of four new guards untested despite the worker's own test
claiming to prove the fix. Remove or invert each guard independently, bind a
focused command, and inspect every mutant's failure. A surviving mutant needs
better coverage or a justified removal of the redundant guard. Use manifest
`mutants` and `mutantCheck` with `integrate --mutants --require-checks`; the
runner restores each mutation before the next. Redcheck proves sensitivity
to the old implementation, while per-guard mutants expose partially tested
new logic. See [mutation checks](manifest-reference.md#mutation-checks).

## Flake on base

A failing check with `repeat` reruns the same argv, with the failing test file
appended, against a temporary checkout of the run's base commit (N times, N
from `repeat` or the check's own `flakeRuns`, capped at 20). The result gains
`flakeOnBase: {file, failed:k, runs:N}` and a `flake on base: k/N (<file>)`
line next to the failure; `k > 0` means the flake already existed on base, not
a regression the run introduced. This never changes the check's pass/fail; it
only tells a coordinator whether a hand-run repro loop is still needed. Pass
`--no-flake-check` to `integrate`/`ship` to disable it. See
[manifest reference](manifest-reference.md#flake-on-base).

## Redcheck against an explicit base

`redcheck --base <ref>` restores non-test outputs from `git show <ref>:<path>`
instead of the run's own recorded base. When `--base` is omitted and the run's
base commit is not an ancestor of the default branch tip, the result adds
`suggestBase: 'origin/main'` (or the actual default-branch ref) and a warning
that old code on the default branch may already contain the change — the case
that produced a false green result on a follow-up job whose base commit had
already picked up the fix. See
[manifest reference](manifest-reference.md#redcheck).

## resultFile

A job may declare `resultFile` (one of its own `outputs`, with optional
`resultSchema` listing required keys) so `inspect --results` reads that file
directly instead of depending on the worker's last message being valid JSON.
`result` then comes from the file, `resultSource` reports which source
answered (`'file'` or `'message'`), and mismatches or parse/schema problems
surface as warnings rather than silent nulls. See
[manifest reference](manifest-reference.md#result-file).

## Mutation tooling pointer

`ship ... --require-section 'Mutation check'` warns
`no manifest mutants: declare "mutants" in the manifest and run "integrate
--mutants" (see docs/verification.md)` when the run's manifest declares no
`mutants` — ship still continues, but the mutation-check requirement no
longer goes unanswered without at least naming the existing tooling. Declare
mutants and run `integrate --mutants` instead of hand-writing a mutation
script; see [mutation checks](manifest-reference.md#mutation-checks).

## Post-build mutants

A mutant's `find` string sometimes only exists in code a build job generates, so it cannot be declared in the manifest before that job runs. `integrate --mutants --mutants-file FILE` (a JSON array, or `{mutants:[...]}`) and a job field `mutantsFile` (one of that job's own outputs, collected automatically) supply mutants after the run's outputs are integrated, validated under the same shape and 32-entry cap as manifest `mutants`; `--mutant-check "<argv json>"` supplies the check when the manifest declares none. Restore-and-byte-check behavior is unchanged. See [mutation checks](manifest-reference.md#mutation-checks).

## Agent failure evidence

A CLI worker whose process exits non-zero, times out, or fails to spawn previously left only its bare exit reason, with no route back to its own stdout/stderr. The last 4 KB of each stream is now saved to `agent.log` and summarized as a short `agentError` (exit code plus the first blocked/credit/quota/rate-limit/auth line, or the last stderr line), shown in `inspect`/`inspect --results`, with token-shaped secrets redacted; the job's existing error text is kept, with the agent failure prefixed onto it. A worker that exits cleanly (code 0) but leaves a declared output missing keeps its prior status and error untouched — that gap is still resolved at integrate time, exactly as before. A worker's own `blocked` envelope is reported as job status `blocked` with its summary instead of being masked by a generic message. See [agent failure evidence](manifest-reference.md#agent-failure-evidence).

## Context directory drift

A review job's context copied from an earlier round can silently omit files added since to the same directory (new screenshot captures being the recurring case), so the reviewer reports already-fixed items as still missing. `validate`/`run` now warn when a job's `context` names 3 or more files of one extension from a single directory that holds other files of that extension the context omits; job field `contextGlob` (`dir/*.ext`, no `**`) expands to every matching file at validate/run time instead of naming each one by hand. See [context directory drift](manifest-reference.md#context-directory-drift).

## Tmp-path and no-shell diagnostics

`validate`/`run` now warn when a job's `readPaths` entry or a `checks`/`mutantCheck` `argv[0]` resolves under `/tmp` or `/private/tmp` (macOS purges unread files there after about 3 days), when a non-`codex` job's `outputs` includes this runner's own `tools/swarm.mjs` (only `codex` has shell access to run the tests that pin it — consider a checker job instead), and when a non-`codex` job's prompt quotes a runtime-check failure it has no shell to reproduce (consider a shell agent or `--evidence`). See [manifest reference](manifest-reference.md#commands).

## Evidence and compact check failures

`integrate`'s result now gains `failures`: a compact `{name, lines}` entry per failed/timed-out/errored check, the last few failure-shaped lines of its tail. `validate`/`run --evidence FILE` reads a local JSON file in that same `{"failures": [...]}` shape and appends a fixed heading plus each entry's lines verbatim to every job's prompt, so a follow-up job sees the exact prior failure instead of the coordinator retyping it. See [manifest reference](manifest-reference.md#checks).

## Pre-checks for a changed lockfile

An optional manifest `preChecks` (plain argv arrays, no shell) runs before `checks` whenever `integrate` writes a recognized lockfile (`uv.lock`, `package-lock.json`, `Cargo.lock`, `pnpm-lock.yaml`), to resync the environment first. With a changed lockfile and no `preChecks` declared, the result instead warns `lockfile changed, env not synced`. See [manifest reference](manifest-reference.md#pre-checks).

## Context glob prefixes

`contextGlob` now also accepts a filename prefix, `dir/prefix*.ext`, alongside the existing `dir/*.ext` (still one directory, still no `**`). `validate`/`run` echo each pattern's matched file count as `contextGlobCounts`. See [manifest reference](manifest-reference.md#job-fields).

## Recovering an unparsable JSON-only reply

A job whose prompt demands a JSON-only final reply but whose saved response never parses as JSON now gets `resultMissing: true` in state and `inspect`. For a `claude` job, the runner first tries one cheap re-ask on the same session ("Reply with the JSON only.") and uses that answer instead whenever it parses, clearing `resultMissing`. `inspect` also gains `costPer1kOutputTokens` per job, computed only when both a cost and an output-token count were actually reported. See [manifest reference](manifest-reference.md#commands).

## Mutants on the current tree

`mutants --mutants-file FILE --mutant-check ARGVJSON` runs the same restore-and-byte-check mutation loop as `integrate --mutants`, directly against the current tree with no run id or manifest — useful for a quick kill/survive read before wiring either into a manifest. A `Ctrl-C` is caught so the in-flight mutant's own restore still completes before the process exits. See [manifest reference](manifest-reference.md#mutants-current-tree).

## Post-build mutants: parsed before any write, retryable if interrupted after

Every mutants source (manifest `mutants`, a job's own `mutantsFile` output, and `--mutants-file`) is now parsed and validated — same shape, same combined cap — before `integrate --mutants` writes a single project file, not after. A `mutantsFile` output that fails to parse, including one carrying trailing text after an otherwise valid JSON value (a worker's own final-message line appended to its declared output instead of only sent as its reply), refuses integration with nothing written. Once files are written, the run's saved state gains `integrationStatus: "partial"`, persisted immediately, before `preChecks`/`checks`/mutants run; `integrate <run-id>` on a `partial` run is accepted as a retry, and a file that already carries the exact bytes this same run wrote is treated as already applied rather than a conflict. See [manifest reference](manifest-reference.md#post-build-mutants).

## Bad JSON output flagged at job completion

At job completion, any `.json` output that fails to parse is recorded as warning `output-invalid-json: <path>`, shown by `inspect`/`inspect --results`/`wait`, well before `integrate` would otherwise discover it (for example while reading it as a mutants source). This check is scoped to declared JSON *output* files only: a job's own `resultFile` is excluded here, since it already gets a more specific `resultFile unreadable: <job>: <reason>` warning from `inspect --results` itself. See [manifest reference](manifest-reference.md#mutation-checks).

## Mutants only count against a green base

`integrate --mutants` now checks whether the manifest's own `checks` passed before applying any mutant. When any check failed, every mutant is reported `status: "skipped-red-base"` instead of actually being applied and checked — a red base fails every mutant regardless of the guard under test, so a "killed" verdict there proves nothing. `ship --require-section "Mutation check"` refuses outright when an integrated run's mutants came from a red base, rather than accept a mutation check that never really ran. See [manifest reference](manifest-reference.md#mutation-checks).

## An undeclared mutants-shaped output

`validate` warns `mutants-file-undeclared` when a job's output path matches the shell glob `*mutants*.json` but the job names no `mutantsFile` — its shape would otherwise only be checked once `integrate --mutants` reads it, after the job has already run. A job that does declare `mutantsFile` gets the exact required shape stated directly in its own worker preamble. See [manifest reference](manifest-reference.md#job-fields).

## contextGlob directory coverage

`validate`/`run` warn `context-directory-drift` when a job's `contextGlob` entries for one directory cover only some of that directory's filename prefixes (multiple entries against the same directory, one prefix each, already work) — caught even when the omitted files share a prefix the job never declared at all. This is the same code, and the same check, described next. See [manifest reference](manifest-reference.md#context-check).

## Context directory drift also catches a small, plainly-numbered context list

`context-directory-drift` (see [Context directory drift](#context-directory-drift) above) previously only grouped a job's context by directory and extension, and required at least 3 already-listed files before warning — enough for the general "copied an old round's context" case, but not for a job that lists just one or two files of an obviously numbered series (e.g. `activity-3.png`) while the same directory holds several more of that same prefix; that gap stayed silent regardless of how many more existed. The check now also groups by a declared `contextGlob` prefix or an inferred one (a filename ending in digits implies a numbered series), with no minimum-file floor for either, and reports the one `context-directory-drift` code either way — the previous, separate `context-glob-partial-dir` warning was folded into this same code path. See [manifest reference](manifest-reference.md#context-check).

## Dropped writes

A worker's edit outside its job's declared `outputs` is never applied by `integrate` — only declared outputs are ever written to the project tree. `inspect`/`integrate` now warn `dropped write: <path> (not in outputs)` for every such path: one signal is a job's own final result naming a `changed` path that isn't one of its outputs; the other, for a non-codex job (whose workspace is a plain copy of its context and outputs), is an actual diff of that workspace — a context file whose bytes changed, or any wholly new file, that is not a declared output. The worker preamble states plainly that edits outside outputs are discarded. See [manifest reference](manifest-reference.md#dropped-writes).

## Outputs before integrate

`inspect --results` now lists, per job, each declared output's path, the absolute path of that job's own workspace copy on disk, and — for a `.json` output — whether it currently parses. This is the same information `integrate` (and a post-build mutants read) would otherwise be the first to discover, made visible at inspection time instead. See [manifest reference](manifest-reference.md#outputs-before-integrate).

## Check classification: spawn-error and unrunnable

A check that never actually started is no longer folded into a generic `error` status. A check whose own argv could not be spawned at all (Node's `error` event, or a synchronous spawn exception) is now `spawn-error`; a check that did start but whose own tool or module could not be found (exit 127, or `command not found`/`ERR_MODULE_NOT_FOUND` in its own output) is `unrunnable` — both carry a `hint`. Either classification gets one automatic run of the manifest's own `preChecks` (if any are declared) plus a single retry of that same check before it is ever reported red; the retried check gains `retriedAfterError: true`, and any preChecks run this way are returned as `retryPreChecks`. `integrate`'s result gains `checksErrored` (true when any check ended `spawn-error`/`unrunnable`), and the CLI now exits non-zero whenever `checksErrored` is true, independent of `--require-checks`. See [manifest reference](manifest-reference.md#checks).

## Wider env-resync trigger, and two new validate warnings

`preChecks` (see [Pre-checks](#pre-checks-for-a-changed-lockfile) above) now also runs when `integrate` writes `pyproject.toml`, `package.json`, or `Cargo.toml`, not only a recognized lockfile — a version-only bump to the manifest file itself leaves the checked-out environment just as stale. `validate` gains two related warnings: `stale-env-risk` when a job's own outputs include one of these dependency/version files and the manifest declares no `preChecks`, and `missing-deps` when `package.json` exists with no `node_modules` (or `pyproject.toml` with no `.venv`) at the project root — both are advisory, surfaced before any job runs rather than discovered later as a spawn failure. See [manifest reference](manifest-reference.md#pre-checks).

## Tight test timeouts

`validate` warns `tight-test-timeout` when a job's own test-file output contains a timeout literal under the 5-second hang-guard floor: a Python-style `timeout=N` keyword under 5, or a JS `setTimeout(..., N)`/`waitFor({timeout: N})` under 5000ms. A short timeout inside a test is a timing assertion in disguise — reliable on a fast runner, flaky on a slow one — so it is flagged at validate time instead of being rediscovered as a one-off CI failure. The same literal outside a test file is silent.

## runtime-check-no-shell also covers repeat checks and named flakes

`runtime-check-no-shell` (previously only for a prompt quoting a runtime-check failure) now also fires when a manifest check's own argv contains a repeat construct (`seq N`, `--repeat`, `for i in`), or when a job's prompt names a flake/race/intermittent bug, and that job has no shell to actually reproduce or repeat the check itself. A job whose outputs are all `.md` is exempt from every trigger this warning checks, since it never runs anything. See [manifest reference](manifest-reference.md#commands).

## Interpreter probe and registry pinning wired into validate/preflight

The bare `validate` command now also runs the same check-interpreter/module probe `preflight` already ran (`probeCheckInterpreters` in `tools/preflight.mjs`), refusing a manifest whose check names a missing tool or Python module instead of only discovering it at `integrate` time. `validateProject` also now calls `registryPinningWarnings` (`tools/context-check.mjs`) for every job, warning `registry-pinning-tests` when a job adds a new file under a directory an existing test enumerates (via `glob`/`listdir`) that isn't in that job's own context, outputs, or `ignoreTests`.

## session-metrics: scouts, asks, and check/mutant windows are no longer invisible to idle accounting

New `tools/session-metrics.mjs` writes and reads a small state.json-compatible `{startedAt, finishedAt, costUsd}` record, one file per run under `.swarm/session-metrics/<kind>/<id>.json`. `ask`/`scout` each write one such record (`kind: 'ask'`/`'scout'`) alongside their existing `.swarm/runs`/`.swarm/scouts` artifacts, and `integrate` writes one for its own checks phase (`kind: 'checks'`) and, when `--mutants` runs, its mutants phase (`kind: 'mutants'`) — so a coordinator-side idle-time reader can see a background research question or a long checks/mutants run as real elapsed time instead of an unexplained gap.

## Next

- Hard spend reservations, reliable cost reconciliation and runtime model
  availability mapping need a separate design.
- Enforce handoff counters and tracking-file freshness without overwriting
  project-owned instructions; currently these remain coordinator guidance.
- Isolate mutation runs and handle runtime caches before claiming protection
  from unrelated processes or abrupt host termination.
- Improve indirect test and fixture context discovery and undeclared-edit
  reporting.
- Adopt preserved failed worktrees only through a separately reviewed recovery
  flow; ordinary integration still refuses failed runs.
- Pin install snapshots used by live runs before promising safety across many
  successive upgrades.

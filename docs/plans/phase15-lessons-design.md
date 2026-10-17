# Phase 15, part 1: the lessons loop (schema and backfill, "watch out for" notes, golden eval set)

Source spec: [swarm-lessons-loop-spec.md](swarm-lessons-loop-spec.md), sections 1, 3 and 6. Not in this part: `lessons mine` (section 2), scope-check learning, test templates, fine-tuning (parked in order after this). The rest of Phase 15 (verify every write, escalation, learned routing) stays in the plan.

The old `swarm lesson` command and `coordination/swarm-lessons.jsonl` (the queue that turns a lesson into a shipped rule, with a public one-liner) are not changed. The new `swarm lessons` command is the structured, searchable record of what went wrong. A backfill reads the old free text.

## 1. Lesson record: `tools/lesson-schema.mjs`

A lesson is one JSON file, `lessons/<project>/<id>.json`:

```
{ version: 1, id: 'L-0001', project: 'swarm', date: '2026-10-16',
  ticket?: 'T-0001', requirement?: 'R-001',
  stage: 'scope' | 'split' | 'build' | 'test' | 'review' | 'merge' | 'integration' | 'deploy',
  what: string (1 to 600), rule: string (1 to 300, one imperative sentence),
  caughtBy: 'test' | 'review' | 'merge-check' | 'owner' | 'production' | 'missed' | 'unknown',
  cost: { retries: integer >= 0, minutes: number >= 0, usd: number >= 0 },
  laneModel: string (1 to 80) | null,
  fix: string (0 to 600),
  guard: { kind: 'scope-rule' | 'lint' | 'test-template' | 'contract-test' | 'router-rule' | 'review-item' | 'prompt-rule' | 'none', text: string (0 to 300), status: 'proposed' | 'built' | 'shipped' | 'dropped', ref?: string },
  tags: [kebab-case words, 1 to 12, each 2 to 40 characters],
  files?: [up to 10 repo-relative paths: no absolute path, no `..`, no backslash],
  source: { kind: 'manual' | 'auto' | 'backfill', ref?: string (0 to 120) } }
```

Exports:

- `STAGES`, `CAUGHT_BY`, `GUARD_KINDS`, `GUARD_STATUSES` (frozen arrays).
- `validateLesson(lesson)` returns `{ ok, errors: [string] }`. Unknown keys are errors. Every text field (`what`, `rule`, `fix`, `guard.text`, `laneModel`, `source.ref`, tags, files) is also checked by `findUnsafeText`; a hit is an error that names the field and the kind, never the matched text.
- `findUnsafeText(text)` returns `[{ kind }]` (empty when clean) for: a secret (use `scanSecrets` from `tools/security-scan.mjs`; check how it takes input), an email address, an absolute home path (`/Users/<name>`, `/home/<name>`, `C:\Users\...`), a URL with `user:password@`, an IPv4 address other than 127.0.0.1 and 0.0.0.0, a swarm run id (`\d{13}-[0-9a-f]{8}`), and a long hex or base64 token (32 or more characters of `[A-Fa-f0-9]` or 40 or more of `[A-Za-z0-9+/=_-]` with mixed case and digits).
- `redactText(text)` returns the text with each of those kinds (except secrets) replaced by `<email>`, `<home>`, `<run-id>`, `<ip>`, `<token>`; it never throws and leaves clean text unchanged. A secret is never redacted: a lesson containing one is refused by `validateLesson`.
- `lessonPath(project, id)` returns `lessons/<project>/<id>.json` (project matches `^[a-z0-9][a-z0-9-]{0,39}$`, id matches `^L-\d{4,}$`, otherwise throws `Error` with `code: 'lesson-id'`).
- `normalizeLesson(raw)` returns a copy with keys in the order above, trimmed strings, deduplicated sorted tags, and defaults (`cost` zeros, `laneModel` null, `fix` empty, `guard` `{ kind: 'none', text: '', status: 'proposed' }`, `source` manual).

## 2. The store: `tools/lesson-store.mjs`

- `async listLessons(root, { project, dir = 'lessons' } = {})` returns every lesson under `<root>/<dir>/` (or one project folder), sorted by id, skipping nothing: a file that is not valid JSON or fails `validateLesson` makes the result carry it in `invalid: [{ file, errors }]`; returns `{ lessons, invalid }`. It never follows a symlink (skip symlinked files and folders into `invalid` with the error `symlink`), never reads a file over 64 KB (error `too-large`).
- `async readLessons(roots)` takes an array of root folders and returns the merged `lessons` array of all valid lessons (used by notes).
- `async nextLessonId(root, { project, dir })` returns `L-0001` or the next id above the highest in the project folder.
- `async writeLesson(root, lesson, { dir = 'lessons', overwrite = false } = {})`: validates (throws `code: 'lesson-invalid'` with the first error), creates the folder (never through a symlink), writes `<id>.json` with 2-space JSON and a final newline through a temp file opened `O_EXCL | O_NOFOLLOW` and a rename; refuses to replace an existing lesson unless `overwrite` (`code: 'lesson-exists'`); returns the relative path.
- `filterLessons(lessons, { stage, tag, caughtBy, project, text })` (each optional; `text` is a case-insensitive substring of what, rule or fix).
- `lessonStats(lessons)` returns `{ total, byStage, byCaughtBy, byTag: [[tag, count]] (top 20, sorted by count then name), missed: count of caughtBy missed or production }`.

## 3. Backfill: `tools/lesson-backfill.mjs`

Converts the existing free text once. Pure functions plus one writer.

- `parseFieldLessons(markdown)` parses `docs/lessons.md`: entries start at a line matching `^\d+\. \*\*(.+?)\*\*\s*(.*)$` and continue over indented continuation lines until the next entry or a blank-line-then-non-indented line. Returns `[{ number, title, body }]` where `title` is the bold text with a trailing period removed and `body` is the rest joined with single spaces and markdown links reduced to their text.
- `lessonFromFieldEntry(entry, { project = 'swarm', date, idOffset = 0 })` returns `{ lesson, warnings }` where the lesson is complete and valid after `redactText`: id `L-<number + idOffset padded to 4>`; `what` is title plus the body before the first `Rule:` (cut at a sentence end to at most 600 characters); `rule` is the text after `Rule:` up to the next label (`Enforcement:`, `Documentation:`, `Regression coverage`, `Test:`) or the end, cut at a sentence end to at most 300; when there is no `Rule:` label, `rule` is the title as an imperative sentence; `fix` is the text from the first `Enforcement:` or `Documentation:` label (at most 600); `stage` from keyword rules on title and body (first match wins, in order: `scope`/`requirement` -> scope; `split`/`ticket` -> split; `review` -> review; `merge`/`queue`/`bisect` -> merge; `integrat` -> integration; `deploy`/`release`/`tag` -> deploy; `test`/`mutant`/`flake`/`redcheck` -> test; default build); `caughtBy` is `unknown`; `tags` are chosen from a fixed keyword table (at least 25 entries, for example mutant -> mutation-testing, flak -> flaky-test, timeout -> timeout, secret -> secrets, symlink -> symlink, path -> path-safety, race -> race-condition, ci -> ci, lane -> lane-routing, rate limit -> rate-limit, lock -> locking, cost/spend -> spend, review -> review, schema -> schema, manifest -> manifest, worker -> worker-output, prompt -> prompt) plus the stage name, at least one tag always; `guard.kind` is `test-template` when the body names a test, `review-item` when the stage is review, otherwise `lint`, `guard.text` is empty and `guard.status` is `shipped` when the body contains `Enforcement:` or `Documentation:` else `proposed`; `source` is `{ kind: 'backfill', ref: 'docs/lessons.md#<number>' }`; `date` defaults to the date argument or today. If the lesson is still invalid after redaction, return `{ lesson: null, warnings: [reason] }`.
- `lessonsFromStore(rows, { project = 'swarm', idOffset = 5000 })` converts rows of `coordination/swarm-lessons.jsonl` (`id, date, area, evidence, rule, fix, public, status, test, version`) to lessons: id `L-<id + idOffset>`, `what` from evidence, `rule`, `fix`, tags from the area, stage from the area (`tool` -> build, `process` -> review, `security` -> merge, `data` -> build, `release` -> deploy, `docs` -> build, `operations` -> deploy, `product` -> scope), guard status shipped when the row status is `shipped`, dropped when `dropped`, built when `built`, else proposed; `source.ref` is `coordination/swarm-lessons.jsonl#<id>`.
- `async backfill(root, { project, dir, dryRun, date })` reads `docs/lessons.md` and `coordination/swarm-lessons.jsonl` (either may be missing), converts, skips ids that already exist in the store, writes the rest with `writeLesson`, and returns `{ written: [ids], skipped: [ids], failed: [{ ref, reason }], total }`. Running it twice writes nothing the second time.

## 4. "Watch out for" notes: `tools/lesson-notes.mjs`

- `queryFromTicket(ticket, requirementTexts = [])` returns `{ text, files, tags, stage }`: text is the title, epic, acceptance and requirement texts joined; files are `files` and `context`; tags are the ticket type, risk, `sensitive` (when set) and every word of the title, epic and file path segments (lower-case, 3 or more characters, kebab words); stage is `build` for build tickets, `test` for test tickets, `integration` for contract and migration tickets, `build` otherwise.
- `selectNotes(query, lessons, { limit = 3, minScore = 3, project } = {})` returns up to `limit` lessons, best first: score is 3 per tag shared with the lesson tags, plus 2 per file path or path segment shared with the lesson `files`, plus 1 per query word (4 or more characters) that appears in the lesson `rule` or `what`, plus 1 when the stage matches; lessons whose guard status is `dropped` or whose `caughtBy` is `unknown` and have no shared tag are skipped; ties go to the newest date, then the lower id. Lessons with score under `minScore` are not returned.
- `renderNotes(notes, { maxChars = 900 } = {})` returns `''` for no notes, else `Watch out for (from past lessons):` followed by one line per note, `- <rule> [<tags joined by comma>]`, dropping whole lines from the end until the text is at most `maxChars`; each line is cut to 240 characters.
- `ticketsToManifest` (in `tools/ticket-manifest.mjs`) accepts `lessons` (an array) and appends `renderNotes(selectNotes(queryFromTicket(ticket, requirementTexts), lessons))` to the end of the job prompt when it is not empty. The notes go after the ticket text, so the shared start of every prompt stays the same (prompt caching). `prepareScopeRun` loads lessons from the project's own `lessons/` folder and from the installed swarm's `lessons/` folder (when run from a shared install) and passes them in; a failure to read lessons is ignored.

## 5. Golden eval set: `tools/evals.mjs` and `evals/`

An eval task is a small made-up repro of a real failure, with a hidden check:

```
evals/<id>/eval.json   { version: 1, id (kebab), title, lesson?: 'L-0001', tags: [..], prompt, context: [paths inside repo/], outputs: [paths inside repo/ the worker must write],
                         check: { argv: ['node', '--test', ...paths], timeoutSec: 1 to 120 } }
evals/<id>/repo/       the files the worker sees (the broken or empty starting point and the visible context)
evals/<id>/hidden/     check files copied over the result before the check runs (hidden tests); workers never see them
evals/<id>/solution/   a known-good version of each output file (same relative paths as outputs)
```

Exports of `tools/evals.mjs`:

- `validateEvalSpec(spec)` returns `{ ok, errors }`: shape above; id kebab-case 3 to 60; `prompt` 20 to 4000 characters and no `**`; `context` and `outputs` arrays of relative paths (no absolute path, no `..`, no backslash); `check.argv[0]` must be `node`; every other argv entry is a flag or a relative path; tags as in lessons.
- `async listEvals(root, { dir = 'evals' } = {})` returns `{ evals: [{ id, dir, spec }], invalid: [{ id, errors }] }`, never following symlinks.
- `async checkEval(evalDir, outputsDir, { run })`: copies `repo/` into a fresh temp folder, copies each output file from `outputsDir` (the same relative paths) over it, copies `hidden/` over that, runs `check.argv` with `cwd` the temp folder, a minimal environment (`PATH`, `HOME` set to the temp folder, `NODE_ENV=test`), no network assumption, the timeout from the spec (kill the process group), and returns `{ pass, exitCode, tail (last 600 characters of combined output, secrets and home paths redacted), ms }`. `run` is an injectable spawn function for tests. The temp folder is always removed.
- `async validateEval(evalDir, { run })` proves the task is fair: the check must FAIL on the untouched `repo/` (red) and PASS with the `solution/` files as outputs (green). Returns `{ ok, red: boolean, green: boolean, errors }`.
- `evalManifest(evals, { agent, model, lane, maxUsd })` returns a swarm manifest with one job per eval: `id` `eval-<id>`, `type: 'build'`, the agent and model given (default `agent: 'auto'`), `sensitive: true`, `prompt` the eval prompt, `context` the eval's context paths prefixed `evals/<id>/repo/`, `outputs` the output paths with the same prefix, `maxOutputTokens: 16000`, `timeoutMs: 600000`. The fixtures are in the repo, so the worker edits `evals/<id>/repo/<path>` in its workspace.
- `async scoreRun(root, runId, { evals, run })` reads `.swarm/runs/<runId>/state.json` (run ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), and for each job `eval-<id>` that is complete, checks the files in the job's workspace under `evals/<id>/repo/` with `checkEval`; a job that is not complete fails. Returns `{ runId, results: [{ id, pass, exitCode, tail, status }], passed, total, agents: [..], models: [..], costUsd }`.
- `compareBaseline(score, baseline)` where `baseline` is `{ [key]: { passed, total } }` and the key is `agent/model` of the run (`mixed` when several): returns `{ key, passed, total, baseline: {passed,total}|null, regressed: boolean }`; `regressed` is true when the baseline exists with the same total and `passed` is lower.

The gate rule (spec section 3): `swarm eval gate RUN` exits 1 when the score regressed against `evals/baseline.json`; `--update-baseline` records a better or equal score. A new model gets a baseline on its first scored run.

## 6. Commands: `tools/lessons-commands.mjs`

`swarm lessons list [--stage S] [--tag T] [--caught-by C] [--text T] [--json]`, `lessons show ID`, `lessons add` (flags `--stage --what --rule --fix --caught-by --tag --lane-model --ticket --requirement --guard-kind --guard-text --retries --minutes --usd`, repeatable `--tag`), `lessons check` (validates every file, prints invalid ones, exit 1 if any), `lessons backfill [--dry-run]`, `lessons stats [--json]`, `lessons notes "TEXT" [--file PATH]...` (prints the notes a ticket with that text would get). `swarm eval list`, `eval validate [ID | --all]`, `eval manifest [ID...|--all] [--agent A] [--model M] [--out FILE]`, `eval score RUN [--record]`, `eval gate RUN [--update-baseline]`.

## Done when (this part)

- All 229 numbered field lessons and the 2 queue rows are in the schema (`swarm lessons check` is clean, backfill is idempotent), with no secret, email or home path in any file.
- A ticket run adds at most three relevant "watch out for" lines to the prompt, and none when nothing is relevant.
- `evals/` has at least 8 tasks from real failures, each proven red on the starting repo and green on its solution, and `swarm eval manifest` plus `eval score` run them through a real lane and report a pass rate.

## 7. Review fixes (Opus review of the first build)

- **Evals argv:** `check.argv[0]` is `node`; the other entries are only `--test`, `--test-reporter=<name>`, `--test-timeout=<n>`, `--test-name-pattern=<text>`, or a relative path to a file that exists under `repo/` or `hidden/` (checked by `validateEval` and `checkEval`, not by the pure `validateEvalSpec`, which only checks the shape: allowed flag names or a relative path without `..`). Any other flag (`-e`, `--eval`, `--require`, `--import`, `--env-file`, ...) is an error.
- **No symlinks in evals:** `copyTree`, the output copy and `listEvals` refuse symlinks at every path part (`lstat` each part; open sources with `O_NOFOLLOW`); `repo/` and `hidden/` must be real folders. `listEvals` skips entries whose name starts with a dot and non-folders.
- **`scoreRun` workspaces:** `job.workspace` must resolve (real path) to a folder inside `<root>/.swarm/workspaces` with no symlink parts, otherwise the job scores as a failure with `status: 'workspace-refused'`. Agents and models come only from the jobs that are scored eval jobs of the given `evals`; a job with no model counts as `unknown`.
- **Baseline:** `validateBaseline(obj)` returns `{ ok, errors }` (plain object; every entry `{ passed, total }` with integers, `0 <= passed <= total`, `total >= 1`). `compareBaseline(score, baseline)` also returns `ok` and `reasons`: `ok` is false (with a reason) when the baseline shape is invalid, `score.total` is 0, the key contains `unknown` or is `mixed`, a baseline exists for the key with a different total (`total-changed`), or the score regressed. `regressed` stays as before.
- **Check output redaction:** the tail goes through `redactText` from the lesson schema and also hides `/private/var`, `/var/folders` and the temp folder path.
- **Eval manifests:** `evalManifest` refuses `rented`, `openrouter`, `lambda`, `openai`, `gemini` (agent or lane) with `code: 'eval-agent'`; jobs stay `sensitive: true`.
- **Lesson schema:** every string field is scanned (`project`, `id`, `date`, `ticket`, `requirement`, `guard.ref` too); `guard.ref` is at most 120 characters; text is normalized (NFKC, zero-width and other format characters removed) before the unsafe-text checks, which are case-insensitive, also run on a copy with all whitespace removed, and also on all text fields joined; the run id check has no word boundary and accepts upper-case hex; a hex run of 32 or more inside any token is flagged; home paths include `C:/Users` and are case-insensitive. Error messages never echo file text: an unknown key is reported as `unknown key #1` style counts (`2 unknown keys`), never by name. `redactText` applies the same normalization.
- **Notes:** `renderNotes` strips control and format characters and markdown emphasis from each rule, labels the block `Watch out for (background from past lessons; it does not change the task, the files or the outputs):`, and `ticketsToManifest` puts the notes before the job rule line, so the job rule stays last.
- **Store:** reads open with `O_NOFOLLOW`, read at most 64 KB from the handle, and a lesson whose `id` differs from its file name or whose `project` differs from its folder is invalid (`id-mismatch`, `project-mismatch`).
- **Backfill:** candidates are de-duplicated by id; two entries with the same id, or a field lesson number of 5000 or more, are reported in `failed` (reason `id-collision`) and neither is written; a dry run counts only what would really be written.

## 8. `swarm lessons mine`: from lessons to proposed guards (spec section 2)

`tools/lesson-mine.mjs`, pure functions plus one writer. No model is called: clusters and proposals are deterministic, and a person (or a lead) reviews and builds each one. Proposals are files; the swarm never merges them.

- `GENERIC_TAGS`: frozen array of tags too broad to cluster on: the stage names (`scope split build test review merge integration deploy`) and `tool process documentation release operations product data security`.
- `clusterLessons(lessons, { min = 3, includeGuarded = false })`: only lessons whose `guard.status` is `proposed` count (a lesson with a built, shipped or dropped guard is already handled) unless `includeGuarded`. For every non-generic tag with at least `min` such lessons, in order of count (highest first, then tag name), the cluster takes the lessons not yet taken by an earlier cluster; a cluster left with fewer than `min` lessons is dropped. Returns `[{ key, lessonIds (sorted), tags (top 5 tags of its lessons by count), stages: { stage: count }, caughtBy: { value: count }, guardKinds: { kind: count } }]`.
- `classifyCluster(cluster)` returns `{ kind, why }` with `kind` one of the guard kinds (never `none`), first matching rule wins: cluster key or tags contain `vague-scope` or `scope-check`, or the stage `scope` has the most lessons: `scope-rule`; tags contain `mock-drift`, `contract`, `openapi` or `schema`: `contract-test`; tags contain `lane-routing`, `router`, `rate-limit` or `routing`: `router-rule`; tags contain `prompt`, `small-model` or `worker-output`: `prompt-rule`; the stage `review` has the most lessons: `review-item`; at least half of the lessons have `caughtBy` `missed`, `production` or `owner`, or the stage `test` has the most lessons: `test-template`; otherwise `lint`.
- `proposeGuard(cluster, lessons)` returns `{ slug (kebab, from the key, at most 50 characters), kind, why, title, lessons: [{ id, rule }] (sorted by id, at most 12 listed, `moreCount` for the rest), text (a template per kind that names the cluster key and quotes up to three of the lesson rules), example: { bad, good } | null (for `scope-rule` only: `bad` is the `what` of the first lesson cut at 200 characters, `good` is its `rule`), target (the file or area where it would be built: `scope-rule` tools/scope.mjs checkScope and tests/scope.test.mjs; `contract-test` tools/contracts-gen.mjs; `router-rule` tools/router.mjs; `prompt-rule` tools/lesson-notes.mjs or the lane prompt; `review-item` the review checklist in docs/lessons-loop.md; `test-template` the test templates of the starter kit; `lint` a check in tools/security-rules or a project lint rule) }`.
- `renderProposal(proposal, { date })` returns Markdown: a title line, `Proposed guard: <kind>`, `Why this kind: ...`, the text, an `Example` section when there is one, `Comes from lessons:` one line per lesson (`- L-0012: <rule>`), `Where to build it: <target>`, `Done when:` (a test that fails without the guard; the eval set still passes; the lessons' guard status is set to built), and the line `Proposed by swarm lessons mine on <date>. Not merged automatically.` No text longer than 400 characters per line; no lesson text beyond the `rule`, `what` for the example.
- `async mine(root, { dir = 'lessons', outDir = 'proposals', min = 3, includeGuarded = false, write = false, date } = {})` loads lessons with `listLessons` from the lesson store, clusters, classifies, proposes, and when `write` creates `<outDir>/<slug>.md` (folder created through `safeWritableDir`; temp file `O_EXCL | O_NOFOLLOW` then rename; an existing proposal file is never overwritten and is reported in `skipped`). Returns `{ lessonCount, considered, clusters: [{ key, kind, size }], proposals, written: [paths], skipped: [paths] }`.
- Command: `swarm lessons mine [--min N] [--include-guarded] [--write] [--json]`: without `--write` it prints what it would propose (nothing is written).

## 9. Affected-only tests and adaptive batches (plan Phase 15, speed multipliers 1b and 2)

Two small pure modules; the queue wiring in `tools/swarm.mjs` is done by hand.

### `tools/affected.mjs`

- `selectAffectedTests(map, changed, { depth = 3, maxShare = 0.6, globalPatterns } = {})` returns `{ mode: 'affected' | 'full', tests: [paths], reasons: [string] }`. `map` is the repo map (`files`, `testLinks: [{ test, source, by }]`, `importedBy: { target: [importers] }`; a file entry has `isTest` and `lang`); `changed` is an array of repo-relative paths. It returns `mode: 'full'` (tests empty) with a reason when: `map` is missing or unsound (`no-map`); `changed` is empty (`no-changes`); a changed file matches a global pattern (default patterns: `package.json`, `package-lock.json`, other lockfiles, `.project-swarm.json`, `coordination/checks.json`, any path under `.github/`, any file named like `*.config.*`, any `tests/_*` helper, `tsconfig*.json`, `.npmrc`); a changed file is not in the map and is not a new test (`unknown-file: <path>`); a changed file is in the map but has no `lang` and is not a test (`unmapped-file: <path>`, for example Markdown, JSON data, shell scripts: the conservative choice, since tests may read them); or more than `maxShare` of all tests in the map would run (`too-wide`). Otherwise `mode: 'affected'` and `tests` is the sorted, de-duplicated union of: changed files that are tests; for every changed source file, the files reached by walking `importedBy` up to `depth` steps (breadth first, cycles safe), and every test that is in the reached set (tests import code directly) or is linked by `testLinks` to the changed file or to any reached file. A changed test file that no longer exists in the map is ignored. Paths with `..`, an absolute path or a backslash are `unknown-file`.
- `expandAffectedArgv(argv, selection)` returns `{ argv, empty }`: the `{affected}` item is replaced by the selected tests (as separate arguments); `empty` is true when the item is present and there are no tests; other items are copied unchanged. When `selection.mode` is `full`, the item is not expanded and `empty` is false, with `full: true` added to the result so the caller knows to use the full argv instead.

### `tools/adaptive-batch.mjs`

- `createBatchController({ start = 10, min = 1, max = 100, streak = 3 } = {})` returns `{ size, record(passed), history, state }` (size is a getter). Sizes step up when `streak` batches in a row passed: below 25 go to 25, from 25 to 50, never above `max`; the streak resets after a step. One failed batch steps down at once (50 or more to 25, 25 or more to 10, below that to `ceil(size / 2)`, never below `min`) and resets the streak. `start`, `min`, `max` and `streak` are validated (positive integers, `min <= start <= max`; otherwise throw `Error` with `code: 'batch-controller-invalid'`). `history` is the list of sizes used so far (`[10, 10, 10, 25, ...]`, one per `record`); `state()` returns `{ size, streak, steps: { up, down } }`.

### Wiring (by hand)

- A manifest check may carry `affectedArgv` (an argv with an `{affected}` item) and `fullEvery` (integer 1 to 100, default 5). In `integrate --queue`, when a batch's selection is `affected`, such a check runs `affectedArgv` instead of `argv`, and the result says `mode: 'affected'` with the test count; every `fullEvery`-th batch (counted per check), the last batch of the pass (and its bisected halves) and any batch whose selection is `full` run the normal `argv`. A check without `affectedArgv` always runs normally. An empty affected selection skips that check for the batch (`skipped`).
- `integrate --queue --adaptive` sizes batches with the controller (`--batch-size` is the start size); the summary carries `adaptive: { sizes, steps }`. Bisect stays the safety net.

### 9b. Review fixes (Opus review of section 9)

Changes to `selectAffectedTests` and `expandAffectedArgv` (the options object gains `deleted`):

- Paths: a changed path is `unknown-file` when any segment is empty, `.`, `..` or starts with `-`, or when the path has a control character, whitespace, `{`, `}` or a backslash, or is absolute.
- `expandAffectedArgv` puts `./` in front of every selected test (so a path can never be read as a flag) and refuses an `{affected}` item at index 0 (throws `Error` with `code: 'affected-argv'`).
- A file counts as a test only when its base name matches `.test.`, `.spec.`, `_test.` or `test_*.py` (the map's `isTest` flag, which is also set for any file under a test folder, is not enough). A changed file under a test folder whose name does not match is a `test-helper` full run. A changed file that is not in the map but whose name matches a test pattern is a new test: it is run, and does not force a full run. Any other file not in the map is `unknown-file`.
- More global patterns: `conftest.py`, any file whose base name contains `setup` or `fixture` and ends in `.js`, `.mjs`, `.ts`, `.py`, anything under `fixtures/`, `test/_`, `__tests__/_`, `jest.*`, `vitest.*`, `pytest.ini`, `setup.cfg`, `pyproject.toml`, `Cargo.toml`, `go.mod`.
- No depth limit: the importer walk runs to the end (default `depth` becomes `Infinity`; a number still limits it, and reaching the limit with files left unvisited is a full run, reason `depth-limit`). A walk that reaches a file with 200 or more importers (the map's cap), or a changed or reached file whose `bytes` is over 262144 (not fully scanned), is a full run (`truncated-graph`).
- A changed source file whose `lang` is not js, python or rust is `no-import-graph` (full run). A map with no tests is `no-tests` (full run). A changed source file that reaches no test is `no-test-reach` (full run) instead of selecting nothing.
- `options.deleted` (array of paths): any deleted file is `deleted-file` (full run); deleted tests are never selected.
- Reasons are strings that start with the code (`unknown-file: path`, `test-helper: path`, `truncated-graph: path`).

Wiring (by hand): bisected halves always run the normal argv; the map is used only when `mapIsFresh` holds at the start of the pass; tests added or changed by earlier batches of the same pass are always added to a later selection, and a file an earlier batch of the pass changed forces a full run; after the loop, if the tree has not had a passing full run since the last affected-only batch, one full run of the checks is made, and a failure marks the queue `final-check-failed`.

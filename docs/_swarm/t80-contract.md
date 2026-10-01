# T80 contract: lesson loop, project-swarm 1.41.0

Specification: `docs/_swarm/t80-brief.md`, decision #340. Baseline: 1.40.0.
This is a build contract, not implementation or evidence that tests passed.
Only synthetic examples belong in code, tests, fixtures, and release copy.

## §0 Goals and non-goals

Make an observed failure a stored lesson, immediate prompt guidance, a bounded
build job, a checked shipped fix, and a safe public entry. Preserve existing CLI behavior.

| Brief item | Command | Error/finding codes | Required test name |
|---|---|---|---|
| 1: clock-stamped private-safe store | `lesson add` | `private-name`, `lesson-store-invalid` | `T80 add rejects private fields without writes or disclosure` |
| 1: continue legacy numbering | `lesson add` | `lesson-id-overflow`, `lesson-import-invalid` | `T80 id continues beyond legacy and JSONL maxima` |
| 2: same-session routing and cap | `lesson add` | `skill-too-long`, `lesson-area-invalid`, `lesson-route-invalid` | `T80 skill cap refuses the whole add` |
| 2: filters and queue visibility | `lesson list`, `run` | `lesson-args`, `lesson-queue` | `T80 list filters and run queue warning use one age rule` |
| 3: bounded fix manifest | `lesson manifest` | `lesson-not-found`, `lesson-manifest-invalid` | `T80 manifest validates and always declares its regression test` |
| 3: lifecycle update | `lesson set` | `lesson-not-found`, `private-name` | `T80 set preserves identity and untouched fields` |
| 4: advisory audit | `lesson check` | `lesson-test-missing`, `lesson-stale` | `T80 check findings exit zero and respect installed tree` |
| 5: public archive | `lesson publish` | `public-line-unsafe`, `lesson-public-file-invalid` | `T80 publish never emits run ids or URLs` |
| 6: legacy conversion | `lesson import` | `lesson-import-invalid`, `private-name` | `T80 import handles legacy shapes and is idempotent` |
| 7: release and help | `lesson --help`, `--help` | `lesson-args` | `T80 CLI exposes every lesson command and preserves old help` |

Non-goals: dispatching a manifest, changing providers, deploying, pushing, automatic
status promotion, ingesting transcripts, rewriting old public entries, new dependencies,
editing the legacy table, or solving queued lessons as part of this release.
No model call is needed by any lesson command. Evidence is stored text, never executed.

Provisional decisions, fixed for these builders unless the coordinator revises this contract:
1. A owns `tools/lessons.mjs`; B owns `tools/lessons-publish.mjs`; C alone edits the CLI.
2. Import uses the deterministic split and fallback rules in §1.8, including historical dates.
3. Publish uses conservative refusal for unsafe public text; no lossy automatic rewrite.
4. The six skill command lines combine `list`/`set`; all seven verbs remain implemented.
5. Public entries use archive sequence numbers and stable lesson markers, not private row ids as sequence numbers.

## §1 Per-command build specification

### §1.1 CLI envelope, paths, input rules, and errors

Syntax: `swarm [--root PROJECT] lesson VERB ...`; existing global `--root` handling stays.
Relative paths resolve against root, never the caller's current directory once root is selected.
Common optional flags on all seven verbs: `--private-names FILE` and `--file PATH`.
For add/list/set/manifest/check/import, `--file` selects the JSONL store.
For publish only, `--file` selects the public Markdown destination; its store stays at the default.
Default store: `coordination/swarm-lessons.jsonl`; default legacy table: `coordination/swarm-lessons.md`.
An absent default store is an empty array, without creating it for read-only commands.
An explicitly selected missing store is also empty; missing explicit input files otherwise fail.
No `--date`, `--id`, `--now`, `--json`, `--force`, `--yes`, or extra positional arguments.
Flags take separate argv values; reject unknown/repeated flags, missing values, and bad enums.
Help: `lesson --help`, `lesson -h`, and `lesson VERB --help` print lesson usage and exit 0.
Success output is exactly one JSON line except list/help; no incidental stdout logging.
Errors are exactly one JSON line on stderr, empty stdout, exit 1; no stacks, terms, or raw OS messages.
Command handlers return `{stdout, exitCode}`; stdout already includes its final newline, or is empty.
Handlers throw errors whose `lessonError` holds only one of the safe objects below.
The CLI catches those errors locally, before the existing general `main().catch` envelope.
The following are exact schemas: uppercase example values are substituted, no other keys added.

```json
{"status":"error","code":"lesson-args","field":"FIELD"}
{"status":"error","code":"private-name","field":"FIELD"}
{"status":"error","code":"skill-too-long","tokens":801,"cap":800}
{"status":"error","code":"lesson-area-invalid","field":"area"}
{"status":"error","code":"lesson-route-invalid","field":"area"}
{"status":"error","code":"lesson-store-invalid","line":1}
{"status":"error","code":"lesson-import-invalid","line":1}
{"status":"error","code":"lesson-id-overflow","field":"id"}
{"status":"error","code":"lesson-not-found","id":9001}
{"status":"error","code":"lesson-manifest-invalid","field":"manifest"}
{"status":"error","code":"lesson-public-file-invalid","field":"file"}
{"status":"error","code":"public-line-unsafe","field":"public","pattern":"run-id"}
{"status":"error","code":"lesson-io","field":"FIELD"}
```

`FIELD` is a fixed schema/option name, never the supplied value; unknown flags use `arguments`.
Store/import line numbers are physical, 1-based; invalid schema and duplicate ids are store errors.
IO fields are one of `root`, `file`, `from`, `installed`, `private-names`, `registry`, `area`, `command`.
Unsafe public pattern classes, in priority order: `private-name`, `run-id`, `repo`, `url`, `handle`, `home-path`, `ticket-id`.
`public-line-unsafe.field` is `public` for an explicit public field, otherwise `rule` or `fix`.
Private-name precedence on add: scan present raw fields before reporting their ordinary value errors.
Use a deterministic schema-field order so errors do not change across platforms.
Validation failures write nothing, including no parent-directory creation for a refused add.
Preflight all target contents before writing; preserve original bytes if a later ordinary write fails.
Serialize store-mutating commands per store while allocating ids and writing; a held lock is `lesson-io/file`.
No promise of crash-atomic multi-file transactions; do not introduce a database or background repair service.

### §1.2 JSONL row, numbering, clock, and privacy

One complete JSON object per nonblank line, UTF-8, newline terminated; no JSON array wrapper.
Required keys, in serialization order: `id,date,area,evidence,rule,fix,public,status,test,version`.
Example shape (date shown is a fixture value, never a production input option):

```json
{"id":9001,"date":"2000-01-02","area":"tool","evidence":"run-0000","rule":"Validate input before writing.","fix":"Guard tools/example.mjs before writing.","public":null,"status":"queued","test":null,"version":null}
```

`id`: positive safe integer, unique. `date`: valid calendar date `YYYY-MM-DD` in UTC.
`area`, `evidence`, `rule`, `fix`: nonempty strings; imported rows may use documented fallbacks below.
`public`, `test`, `version`: null or nonempty strings. `status`: queued|built|shipped|dropped.
Reject unknown keys and wrong types on disk; do not silently repair or discard malformed rows.
Rule/public must be one logical line; trim outer whitespace; reject embedded CR/LF/NUL.
Evidence/fix may contain newlines; JSON serialization escapes them. Never interpret their content.
`test` must be a root-relative `tests/*.mjs` path, without traversal or absolute path components.
Versions accept `MAJOR.MINOR.PATCH` with optional SemVer prerelease/build suffix, no leading `v`.
Add id = `1 + max(0, JSONL ids, numeric ids in the legacy table)`; gaps remain gaps.
Scan all legacy data rows, not a header number or narrative number; an unsorted last row cannot lower the maximum.
Absent legacy file contributes zero; malformed numeric legacy data rows refuse, never restart numbering.
Check safe-integer overflow before adding; never reuse dropped ids or allocate by array length.
Add date = `new Date(now()).toISOString().slice(0,10)`; production `now` is `Date.now`.
The `now` function is an internal test seam only, not an argv option or environment override.
Age days = `max(0, floor((UTC midnight of now - UTC midnight of row.date)/86400000))`.
Older-than/stale means strictly greater than the supplied nonnegative integer day limit.
Set never changes date/id; import preserves a valid legacy date as historical data, not a fresh capture.
Use existing `loadPrivateNames(root, privateNamesFile ?? null, {env,home})` from `tools/ship.mjs`.
Use existing `findPrivateNameHitsInText(field, String(value), terms)`; check only hit presence.
The loader, not new duplicated parsing, owns explicit-file/config/default private-list precedence.
Do not use `privateNamesDispatchGuard`: its public-repository gate would skip checks for local lessons.
Scan every populated row field, including generated id/date/status, and all supplied CLI values before echoing them.
Never return matcher hits, the matched term, the source text, or a loader exception message.
Existing data is structurally readable even if unsafe; add/set/import validate rows they write,
and list/manifest check fields they would emit. Publish scans only its candidate public text plus emitted metadata.

### §1.3 `lesson add`: capture and route

Required: `--area AREA --evidence TEXT --rule TEXT --fix TEXT`; optional: `--public TEXT` and common flags.
Defaults: public/test/version null, status queued, id/date generated by §1.2.
Success: `{"status":"ok","lesson":ROW,"routedTo":PATH_OR_NULL}`.
`routedTo` is root-relative; tool => null; gotchas => `.swarm/gotchas.md`.
Other areas must match `/^[a-z0-9][a-z0-9-]{0,63}$/` and name an existing
`coordination/skills/<area>/SKILL.md`; `worker-skill` in the brief means an actual skill name.
Reject unknown areas and traversal with `lesson-area-invalid`; do not invent a new skill.
Reject symlinked skill/gotchas write destinations or ancestors that escape root with `lesson-route-invalid`.
Build this exact bullet: `- <rule> (lesson <id>)` followed by LF.
For skills, insert at the end of the existing exact `## Lessons` section, before the next level-1/2 heading.
If absent, preserve the file and append `\n\n## Lessons\n\n` plus the bullet, avoiding surplus boundary blank lines.
Preserve frontmatter and unrelated prose byte-for-byte; multiple exact Lessons headings refuse as route-invalid.
Compute prospective entire skill tokens as `ceil(Buffer.byteLength(nextText,'utf8') / 4)`.
800 passes; 801 refuses with the exact skill-too-long JSON; JSONL and skill bytes stay unchanged.
This deliberately follows the brief's bytes rule; the current loader's char-based estimate stays unchanged.
Gotchas appends the same bullet at EOF, creating the file/parent if needed, with no Lessons heading required.
Keep prospective gotchas within the existing 16 KiB reader limit; otherwise `lesson-route-invalid/area`.
Tool routes nowhere. Append exactly one row only after privacy, id, schema, route, and cap preflight pass.
No automatic reconfiguration of skillsDir: routing updates source guidance, whose existing attachment rules still apply.

### §1.4 `lesson list` and `lesson set`

List flags: `[--queued|--shipped] [--area AREA] [--older-than DAYS]`, plus common flags.
No filters means all rows; queued and shipped are mutually exclusive; other filters combine with AND.
Sort ascending by numeric id; empty match => empty stdout and exit 0, no JSON summary.
Each line: `#<id> <date> <area> <status> <rule.slice(0,100)>\n`; no ellipsis.
Set syntax: `lesson set ID --status queued|built|shipped|dropped [--version V] [--test PATH]`.
Set also accepts common flags. ID is a positive safe integer in decimal; absent id => lesson-not-found.
Any explicit status transition is permitted; changing status does not run a test or infer a version.
Omitted version/test retain prior values; there is no clearing flag in this release.
Success: `{"status":"ok","lesson":ROW}`; only the named row changes, order and other row values preserved.
Store replacement uses a same-directory temporary file and rename; an invalid update never truncates the store.

### §1.5 `lesson manifest`

Syntax: `lesson manifest ID --agent A --model M [--tier cheap|mid|expensive]`, plus common flags.
Agent/model are required; tier is omitted by default. Do not select a provider or execute it.
Success stdout is the manifest itself, without a status wrapper:

```json
{"version":1,"jobs":[{"id":"lesson-9001","agent":"claude","model":"sonnet","prompt":"FIX\nEvidence: EVIDENCE\nAdd a node:test case in tests/field-lesson-9001.test.mjs that fails without the fix; fixtures use fake ids, no names, repos, URLs or prompt text.","context":["tools/example.mjs","package.json"],"outputs":["tools/example.mjs","tests/field-lesson-9001.test.mjs"]}]}
```

Replace FIX/EVIDENCE with row values without summarizing; include the specified final sentence verbatim.
Recognize whole root-relative `tools/*.mjs` and `tests/*.mjs` tokens in fix (including nested paths).
Strip surrounding Markdown punctuation only; reject traversal, absolute paths, symlink escapes, and directories.
Take existing regular files only, deduplicate and sort lexically; append package.json if not already present.
Outputs are the discovered tools files plus `tests/field-lesson-ID.test.mjs`; always include that test once.
If that generated test already exists, include it in context too so a builder can read before editing.
Reject missing/empty package.json, unusable paths, or invalid agent/model/manifest as lesson-manifest-invalid.
When tier=expensive add `tierReason: "Explicit lesson manifest --tier expensive selection."` to satisfy the existing validator.
Other tiers add only `tier`; retain explicit model unchanged. No new manifest fields or CLI tierReason flag.
Validate with the existing shape and project validators before emitting; no exception text is echoed.
The CLI supplies `{validateManifest, validateProject}` callbacks, avoiding a circular import from B into swarm.
Tests must assert the test output explicitly: validateManifest alone currently permits its absence.
Validation may reject an incompatible model, missing related context, or project policy; do not weaken existing guards.

### §1.6 `lesson check` and the run queue warning

Syntax: `lesson check [--stale-days DAYS] [--installed DIR]`, plus common flags.
Defaults: stale-days 7; installed `path.join(home,'.project-swarm/current')`.
Installed is the selected version tree, not the project root and not a path auto-derived from row.version.
For shipped rows, null test or missing/non-file `<installed>/<test>` yields a missing-test finding.
For queued rows with ageDays > staleDays, yield a stale finding; other states do not become stale findings.
Success shape: `{"status":"ok","checked":N,"findings":[FINDING,...]}`; findings always exit 0.
Finding shapes: `{"code":"lesson-test-missing","id":9001,"test":null}` or test string;
`{"code":"lesson-stale","id":9002,"days":8,"limit":7}`. Sort by id then code.
Bad flags, malformed store, unsafe test traversal, or unreadable inputs are errors, not audit findings.
Queue warning uses only queued rows; oldest = lowest date, then lowest id on a tie.
Exact string: `lesson-queue: N queued, oldest #id (D days)`; always use `days`, including 1.
No queued rows/missing store => `[]`; otherwise helper returns `[STRING]`.
C appends this array to runManifestBody's manifestWarnings; preserve every existing warning.
Compute once per run with the same clock/age helper, not once per job or progress tick.
Malformed store must not be silently reported as an empty queue; surface the safe store error.

### §1.7 `lesson publish`

Syntax: `lesson publish --version V [--file docs/lessons.md] [--private-names FILE]`.
Select only status=shipped AND exact version V; sort by id. No matches => no write.
Public candidate = trimmed public when present, else `<rule> — <fix>`; fix serves as the generic consequence.
Normalize candidate whitespace to one line; do not generate or invent a consequence with a model.
Provisional scrub policy: refuse any unsafe class rather than dropping facts or guessing a replacement.
Check private terms with the shared matcher, including configured first names; never maintain another name list.
Check run ids with `/\b(?:[a-z][a-z0-9]*-)?\d+-[a-f0-9]+\b/gi` and `/\brun-\d+\b/gi` (synthetic ids included).
Check any `<owner>/<repo>` token, repository owners/names from root `.swarm-projects.json`, and bare registry names.
Read registry if present; recursively inspect string values for repo/owner pairs and URL repository paths,
and scalar `owner`, `repo`, `name` values for bare labels; malformed/unreadable registry => lesson-io/registry.
Conservative false positives are acceptable: the author supplies a generic `--public` line instead of a bypass.
Check URL schemes (`scheme://...`), `www.` URLs and Markdown/autolink destinations; check `@handles`.
Check `/Users/...`, `/home/...`, `/root/...`, Windows drive/UNC home paths, and tilde home paths.
Check ticket ids `/\bT\d+\b/i`. Scan normalized text again immediately before append.
For fallback candidates scan rule then fix so a refusal identifies only that schema field and pattern class.
Do not print the rejected line, matched span, registry text, evidence, or raw exception on any channel.
All selected public candidates and emitted metadata must pass before any write; never append a safe prefix of a refused batch.
Destination must exist with `# Field lessons` and numbered entries, or be absent (initialize that heading).
Continue public sequence at max existing top-level numbered entry + 1; baseline inspected ends at 198.
Append this existing-style numbered Markdown form (escape Markdown in interpolated prose):

```text
199. **<safe public candidate>**
    Enforcement: lesson <id>, shipped in <version>.
    Regression coverage: `<test>`.
    <!-- swarm-lesson:<id>:<version> -->
```

If test=null use `Regression coverage: not recorded.`; do not claim validation occurred.
Never emit raw evidence. Validate test/version metadata before rendering, including privacy and safe path grammar.
Vetted test paths are allowed in the regression line; the owner/repo heuristic applies to public prose, not that structured path.
Marker duplicates are skipped, making repeated publish idempotent without changing JSONL.
Success: `{"status":"ok","version":"V","file":"DESTINATION","published":[9001],"skipped":[9002]}`.
File echoes only the safe selected path; private-check that argument before any response or write.
Only the selected destination is written. An archive alias to the same file needs no second append.
The references archive is outside this contract job's readable context; its alias identity is unverified here.
B checks destination identity before writing through aliases; never separately rewrite a distinct archive.
Template approval/spot-check belongs to the release coordinator; this contract does not claim that approval happened.

### §1.8 `lesson import`

Syntax: `lesson import [--from coordination/swarm-lessons.md]`, plus common flags.
Parse pipe tables with numeric first cells; ignore headings/separators/prose; honor escaped pipes and code spans.
Recognize six-column header `# | Date | What happened | Evidence | Proposed swarm fix | Status`.
Also support sample data with five cells or a separate Rule cell despite that six-column header.
First two cells are id/date; third is What happened; remaining cells are semantic cells, not blindly fixed indices.
Find the first case-insensitive `Rule:` or `Fix:` in What happened: prefix becomes incident evidence;
Rule suffix becomes rule, Fix suffix becomes fix. Stop either suffix at the next Rule/Fix/Status marker.
Otherwise incident evidence is all of What happened. Prefer a later explicit Rule cell over fallback rule text.
An explicit `Swarm fix:`/`Fix:` later cell supplies fix; strip only its label/Markdown emphasis and Status suffix.
An unlabeled evidence cell precedes rule/fix cells; append it to incident evidence with LF, preserving content.
With no labeled fix use the last non-status semantic cell not already consumed as evidence/rule as fix.
With no rule use What happened; with no fix use rule. Empty evidence uses `legacy lesson <id>`.
With only one unlabeled trailing cell use it as fix; with two use first as evidence, last as fix.
Normalize rule to one line; preserve fix/evidence text otherwise. Default area=tool, public/test=null.
Find `Status:` in any cell: queued|built|shipped|dropped, case-insensitive; missing status defaults queued.
Extract version immediately after shipped/built if valid; ignore trailing parenthetical release references.
Unknown explicit status, invalid date/id, duplicate source ids with different contents, or unparseable numeric rows refuse.
Keep source id/date; never run add routing, generate a new id, or append skill/gotchas bullets during import.
Skip ids already in JSONL without overwriting them; validate/private-scan all new rows before writing any.
Import does not silently scrub private local history: unsafe new rows refuse without revealing their contents.
Success: `{"status":"ok","imported":[9001],"skipped":[9002]}`; arrays ascending, no write if imported is empty.

### §1.9 Existing hook map and release edits

Line ranges refer to the supplied baseline files, not post-edit positions; these are inspected callers.
`tools/swarm.mjs:20-32`: existing config/privacy/gotchas/skill imports; reuse ship helpers via those signatures.
`tools/swarm.mjs:890-990,990-1090`: validateManifest, required version/jobs/model/context/outputs and tierReason rules.
`tools/swarm.mjs:3550-3575`: privateNamesDispatchGuard shows loader/matcher call forms and the public-repo gate to avoid.
`tools/swarm.mjs:3593-3608`: validateProject entry, root realpath, manifest checks and skills size checks.
`tools/swarm.mjs:1878-1945`: runManifestBody, manifestWarnings at 1891, save at 1892, gotchas at 1907, skill attachment at 1939.
`tools/swarm.mjs:2426`: runWarnings composes existing warning strings; do not replace its other producers.
`tools/swarm.mjs:4778-4783`: main root extraction and top-level usage; insert lesson early branch after help/root parsing.
`tools/swarm.mjs:4872-4890`: lazy command module import precedent; use it to keep module loads independent.
`tools/swarm.mjs:5096,5100-5215,5340-5349`: generic dispatch/parser and final error handler; lesson returns before these.
`tools/gotchas.mjs:13-49`: GOTCHAS_FILE, 16 KiB read cap, loadGotchas fallback, gotchasPromptBlock reaches all job types.
`tools/skills.mjs:77-110,176-242`: parseSkillFrontmatter, tokenEstimate, loadSkillFile, attachSkillsForJob, skillsPromptBlock.
`docs/worker-skills.md:9-12,33-52`: configured source directory, named/path attachment, existing warning/refusal thresholds.
`docs/_swarm/worker-rules-SKILL.md:1-11` and `debugging-SKILL.md:1-10`: preserve paths/checks/resultKeys frontmatter.
`docs/_swarm/lessons-sample-rows.md:3-9` and `queued-lessons.md:3-54`: inconsistent legacy cells and embedded statuses.
`docs/lessons.md:1-18,2160-2223`: numbered public prose, enforcement/regression convention, last sequence 198.
`tests/field-lessons-batch-y.test.mjs:1-44,268-375`: node:test, isolated fixture cleanup, privacy test arrangement.
`tests/_isolate-config.mjs:9-28`: writable temp override, isolated config/HOME, process inheritance for children.
`package.json:3,9-14`: version 1.40.0 -> 1.41.0; test/check scripts unchanged; no build script exists.
`CHANGELOG.md:1-13`: prepend `## 1.41.0` with concise command bullets; leave older entries untouched.
`README.md:18-21,37` and `skills/project-swarm/SKILL.md:23-24`: kickoff version pins become 1.41.0.
C adds one README paragraph at the lesson link describing capture/routing, build/check, safe publish/import.
C replaces only SKILL.md lines 110-154's section content, stopping before `## Completion and reuse` at 156.
Replacement has at most ten physical lines: heading, blank, two-sentence loop paragraph, then six command bullets.
The six bullets cover add; list/set; manifest; check; publish; import, each with one short clause.
Preserve every other skill paragraph except the requested kickoff version pin; no unrelated cleanup.

## §2 Build and verification rules

Use node:test describe/test and node:assert/strict; fixtures via mkdtemp+realpath with t.after cleanup.
Always run owned tests with `node --import ./tests/_isolate-config.mjs --test <owned-test>`.
Use `process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir()` for temp roots.
Inherit isolated env into child CLI tests; no real HOME/config/installed-tree mutation or provider calls.
Fake run ids `run-0000`, pattern-shaped `9001000000000-deadbeef`; lesson ids 9001+ only.
Use synthetic privacy terms `FixtureSecret9001`, no real person/company/repository names or copied prompt text.
URL/repo/handle/home scrub cases are synthetic strings built inside tests; use reserved `.invalid` hosts only.
Generate fixture files in temp roots, not committed fixtures; all helper names below are local to owned tests.
Cover exact stdout/stderr/exit status, bytes unchanged on refusal, date bounds, cap boundaries including UTF-8,
all filters, imports twice, unsafe publish all-or-nothing, manifest CLI validation, and no-queue warning absence.
Test actual command branches through a child process, not only direct helper imports; avoid real paid runs.
For run warning integration use existing runManifest fake-spawn/provider seams and assert saved state.warnings.
No new npm dependency; keep every existing flag/output working; update global and lesson usage for all new flags.
No reformatting untouched code, generic parser refactor, shared fixture file, extra command, or shared output ownership.
Run only owned tests in build jobs; coordinator runs npm test and npm run check after integration.
No build script exists; report that fact rather than inventing one. Diagnose failures with the supplied debugging rules.
Run mutants only through `swarm mutants`; never hand-restore mutated files and never stash.
This contract-only job performs file reads/writes and structural review; its specific no-run instruction means no tests run here.
The jobs file is scheduling metadata (`summary`, `dependsOn`), not an executable swarm manifest.
Coordinator supplies agent/model/prompt/checks and the top-level contract field when constructing the execution manifest.
Stage B after A and C after A/B for runnable tests; C learns A/B interfaces only from §3, not their implementation files.
Do not translate dependsOn into codex `after`: current validateManifest expressly refuses that combination.

## §3 Cross-job names and interfaces

The following inventories define the shared names; do not invent parallel aliases.
Exports owned by A, all in `tools/lessons.mjs`:
- `LESSON_USAGE`: full lesson usage string, includes the seven subcommands and every accepted flag.
- `parseLessonArgs(argv)`: argv after `lesson` -> options; synchronous, strict, no IO.
- `lessonError(code, details={})`: returns Error with safe `.lessonError` JSON from §1.1.
- `readLessons(root, options={})`: Promise<Row[]>; options.storeFile selects JSONL.
- `writeLessons(root, rows, options={})`: Promise<void>; validated replacement store for set/import.
- `parseLegacyLessons(text)`: Row[] per §1.8; no IO/routing/privacy; shared by id allocation/import.
- `assertLessonPrivateSafe(root, fields, options={})`: Promise<void>; fields is a field-name/value map.
- `lessonAgeDays(date, now=Date.now)`: integer per §1.2.
- `lessonQueueWarnings(root, options={})`: Promise<string[]>; default store, optional internal now.
- `runLessonCore(root, options, deps={})`: Promise<{stdout,exitCode}> for add/list/set/help.
Export owned by B, in `tools/lessons-publish.mjs`:
- `runLessonShip(root, options, deps={})`: Promise<{stdout,exitCode}> for manifest/check/publish/import.
Options keys: `command,id,area,evidence,rule,fix,public,status,version,test,queued,shipped,olderThan,agent,model,tier,staleDays,installed,from,storeFile,publishFile,privateNamesFile,help`.
Absent optional keys are undefined; defaults are applied by handlers; numeric ids/day flags become numbers in parser.
Shared deps keys: `now` (function -> milliseconds), `env`, `home`, `validateManifest`, `validateProject`.
C passes existing validator functions for manifest; validators keep their current `(manifest)` and `(root,manifest,options)` signatures.
A owns parsing every verb; B never reparses argv. Both handlers use the same safe Error contract.
B imports A's storage/import/privacy/age/error exports; A never imports B; C lazily imports each as needed.
C imports lessonQueueWarnings inside runManifestBody before constructing manifestWarnings.
Shared existing exports reused: `loadPrivateNames`, `findPrivateNameHitsInText`, `validateManifest`, `validateProject`, `runManifest`.
Shared source/context/output paths: `docs/_swarm/t80-contract.md`, `docs/_swarm/t80-brief.md`, `docs/_swarm/worker-rules-SKILL.md`, `docs/_swarm/debugging-SKILL.md`, `docs/_swarm/queued-lessons.md`, `docs/_swarm/lessons-sample-rows.md`, `docs/worker-skills.md`, `tools/lessons.mjs`, `tools/lessons-publish.mjs`, `tools/swarm.mjs`, `tools/ship.mjs`, `tools/gotchas.mjs`, `tools/skills.mjs`, `tests/_isolate-config.mjs`, `tests/field-lessons-batch-y.test.mjs`, `tests/field-lesson-t80-core.test.mjs`, `tests/field-lesson-t80-ship.test.mjs`, `tests/field-lesson-t80-cli.test.mjs`, `package.json`, `README.md`, `CHANGELOG.md`, `skills/project-swarm/SKILL.md`, `docs/lessons.md`.
Shared runtime paths: `coordination/swarm-lessons.jsonl`, `coordination/swarm-lessons.md`, `coordination/private-names.txt`, `coordination/skills/<area>/SKILL.md`, `.swarm/gotchas.md`, `.swarm-projects.json`, `~/.project-swarm/current`, `tests/field-lesson-<id>.test.mjs`.
Shared verbs: `lesson`, `add`, `list`, `set`, `manifest`, `check`, `publish`, `import`.
Shared flags: `--root`, `--file`, `--private-names`, `--area`, `--evidence`, `--rule`, `--fix`, `--public`, `--queued`, `--shipped`, `--older-than`, `--status`, `--version`, `--test`, `--agent`, `--model`, `--tier`, `--stale-days`, `--installed`, `--from`, `--help`, `-h`.
Shared codes: `lesson-args`, `private-name`, `skill-too-long`, `lesson-area-invalid`, `lesson-route-invalid`, `lesson-store-invalid`, `lesson-import-invalid`, `lesson-id-overflow`, `lesson-not-found`, `lesson-manifest-invalid`, `lesson-public-file-invalid`, `public-line-unsafe`, `lesson-io`, `lesson-test-missing`, `lesson-stale`, `lesson-queue`.
Shared fixture names (local helpers/data labels, no shared module): `lessonFixture`, `queued9001`, `shipped9002`, `legacy9003`, `privateTerms9001`, `skillAtCap9001`, `unsafePublic9001`, `manifest9001`, `installed9001`.
Fixture temp files: `tools/example.mjs`, `tests/field-lesson-9001.test.mjs`, `tests/field-lesson-9002.test.mjs`; these are generated, never task context paths.
All ROW/result/finding schemas, option/deps keys, and test names in §§0-1 are shared contracts too.
CrossJobNames = 105: 16 exports, 34 paths, 8 verbs, 22 flags, 16 codes, 9 fixture names; excludes field keys/test titles.

## §4 Required mutants and their killing assertions

(a) Disable the shared private-name scan on add's write path in tools/lessons.mjs.
Test `T80 add rejects private fields without writes or disclosure` in core must fail:
each field's synthetic secret is refused, neither store nor route changes, no output contains the term.
Keep a clean positive control so refusing every add cannot pass the guard test.

(b) Remove/bypass the prospective skill token-cap comparison in tools/lessons.mjs.
Test `T80 skill cap refuses the whole add` in core must fail at 801 tokens;
assert exact tokens/cap JSON, unchanged store and skill bytes, plus a successful 800-token control.
Include a multibyte fixture that is under the char estimate but over the byte estimate.

(c) Bypass publish's run-id/URL safety gate in tools/lessons-publish.mjs, including its final scan.
Test `T80 publish never emits run ids or URLs` in ship must fail for each pattern separately;
assert refusal, correct pattern class, unchanged destination, and no secret text on stdout/stderr.
Also exercise fallback rule/fix and a clean explicit public line; do not assert only a regex's source text.

(d) Remove generated tests/field-lesson-ID.test.mjs from manifest outputs in tools/lessons-publish.mjs.
Test `T80 manifest validates and always declares its regression test` in ship must fail:
use validateManifest/validateProject AND assert exact output inclusion. CLI repeats real `swarm validate` on the emitted file.
An assertion that only calls validateManifest is insufficient; its existing schema allows test-free outputs.

(e) Allocate id from JSONL only, ignoring the legacy maximum, in tools/lessons.mjs.
Test `T80 id continues beyond legacy and JSONL maxima` in core must fail:
seed JSONL id 9001 and legacy id 9003, expect 9004; include empty JSONL and unsorted legacy variants.
Assert persisted id and routed bullet agree. Run each mutant with its owner's test and inspect the intended failing assertion.

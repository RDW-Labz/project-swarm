# T81 contract — speed pipeline, project-swarm 1.42.0

Decision #341; specification: `docs/_swarm/t81-brief.md`.
A = t81-ship-pipeline; B = t81-adapters; C = t81-wire-scaffold.
Line ranges below are the supplied baseline, before T80/T81 edits; follow the named function after integration.
This is a build contract, not a claim that the implementation or its tests already exist.

## §0 Goals and non-goals

| Brief item | Command / flag | Error codes or existing status | Required test title |
| --- | --- | --- | --- |
| 1: required CI only | `ship --wait-required-only` | `required-contexts-unavailable`, `ci-failed`, `timeout` | `T81 required checks merge while optional checks run` |
| 1: retain defaults/fallback | ordinary ship; protection 404 | existing ship statuses | `T81 required checks fallback preserves all-context wait` |
| 2: stage pipeline | `ticket MANIFEST --pr PAYLOAD` | `pipeline-stage-failed`, `ticket-args` | `T81 pipeline stops at first red stage` |
| 2: durable resume | `ticket ... --resume RUN` | `pipeline-invalid`, `pipeline-resume-unsafe` | `T81 resume skips every green stage` |
| 2: bounded commit | `--branch`, `--commit-message`, `--check` | `pipeline-dirty`, `pipeline-branch-mismatch` | `T81 commit includes only outputs and check-changed lockfiles` |
| 3: linked environments | run default | `workspace-env-invalid` | `T81 linked dependencies are readable executable and never writable` |
| 3: isolated sync | `run --sync` | existing `setup-failed` | `T81 sync precedes worker and never follows root dependency links` |
| 3: environment failures | integrate / ship checks | `check-env-missing` | `T81 spawn-shaped failures cannot become pre-existing` |
| 3: worker checks | codex / claude shell | existing worker statuses | `T81 both shell prompts list checks and request checksRun` |
| 4: retained streams | run / inspect | `adapter-log-failed` | `T81 failed fake codex leaves streaming evidence` |
| 4: one retry | codex run | existing final failure | `T81 codex retries only blips with zero written outputs` |
| 5: job scaffold | `scaffold job` | `scaffold-args`, `scaffold-invalid` | `T81 scaffold job covers uncovered tests and validates` |
| 5: PR scaffold | `scaffold pr` | `scaffold-run-invalid`, `scaffold-branch-unavailable` | `T81 scaffold PR carries mutation stub into ship refusal` |
| 5: stub refusal | `ship --require-section S` | `stub-section` | `T81 required mutation section rejects literal stub` |
| 6: release/docs | 1.42.0 / usage / Workflow | none | `T81 CLI documents new commands and retains old flags` |
| Non-goals | no T80 rename, new dependency, implicit protection change, or new provider | existing guards retained | `T81 legacy state and default ship remain compatible` |

## §1 Per-item build specification

### §1.0 Common boundary and errors

Only the three jobs' declared outputs may change; no shared ownership or new fixture module.
A and B may build independently; C builds after both integrate and consumes §3 signatures.
All CLI paths resolve against the selected `--root`; preserve ship's existing cwd-then-root payload lookup.
New commands accept `--help` / `-h` without IO; unknown flags, duplicate singleton flags, and missing values refuse.
New parsers never execute argv or interpolate shell strings. Repeatable flags preserve input order.
New error objects below are exact JSON templates: uppercase strings stand for validated runtime values.
For ticket/scaffold CLI errors, print one JSON line to stdout and exit 1; success exits 0.
Existing ship stdout result and exit mapping remain; add specified fields without dropping old fields.
`{"status":"error","stage":"parse","detail":{"code":"ticket-args","message":"MESSAGE"}}`
`{"status":"error","stage":"STAGE","detail":{"code":"pipeline-stage-failed","result":{}}}`
The `result` above is the complete returned stage result; exceptions use `{"message":"MESSAGE"}` there.
`{"status":"error","stage":"resume","detail":{"code":"pipeline-invalid","message":"MESSAGE"}}`
`{"status":"error","stage":"resume","detail":{"code":"pipeline-resume-unsafe","stage":"STAGE"}}`
`{"status":"error","stage":"commit","detail":{"code":"pipeline-dirty","paths":["PATH"]}}`
`{"status":"error","stage":"run","detail":{"code":"pipeline-branch-mismatch","expected":"BRANCH","actual":"BRANCH"}}`
`{"status":"error","code":"scaffold-args","message":"MESSAGE"}`
`{"status":"error","code":"scaffold-invalid","message":"MESSAGE"}`
`{"status":"error","code":"scaffold-run-invalid","runId":"RUN","message":"MESSAGE"}`
`{"status":"error","code":"scaffold-branch-unavailable","runId":"RUN"}`
Scaffold write refusal: `{"status":"error","code":"scaffold-exists","file":"PATH"}`; never overwrite silently.
IO failure: `{"status":"error","code":"scaffold-io","file":"PATH","message":"MESSAGE"}`.
A stage is red when its explicit success predicate below fails, not merely when it throws.

### §1.1 Required-context ship wait (A logic, C flag wiring)

Add boolean `waitRequiredOnly=false` to ship options; `--wait-required-only` sets it true in both ship modes.
Do not enable it implicitly for ticket; ticket forwards it only when explicitly supplied (provisional P1).
Keep pollMs=20000, timeoutMs=2700000, noCiGraceMs=300000, mergeMethod=squash and tagTimeoutMs=180000.
After payload/base and repo resolution, before push, call injected exec:
`gh api repos/<owner>/<repo>/branches/<encoded-base>/protection/required_status_checks`.
Encode base as one URL component; do not infer it from the currently checked-out branch.
Union `contexts` strings and `checks[].context`, stable deduplicate; match `name ?? context` exactly.
404/no protection, null response, or a valid empty context set uses today's all-context wait (provisional P1).
Other nonzero responses or malformed response JSON refuse before push; never silently relax after 401/403/5xx.
Ship refusal adds exactly `{"code":"required-contexts-unavailable"}` to its existing result with status `refused` and a reason.
When the option was requested, every ship result adds `requiredContexts`, `pendingAtMerge`, `waitedForRequiredOnly`.
Defaults for those requested-mode fields: `null`, `[]`, `false`; omit all three when the option was absent.
On active protected mode: `{"requiredContexts":["check-9001"],"pendingAtMerge":["check-9002"],"waitedForRequiredOnly":true}`.
`requiredContexts` is string[]; `pendingAtMerge` is deduplicated string[] of still-pending optional checks in the last matching-head poll.
Never record pendingAtMerge before the merge boundary; held/ready/failed results retain [].
`waitForCiOnce` still obtains the entire rollup, checks headRefOid===sha, and uses the existing injected clock/sleep.
Only required entries feed its readiness/failure summary; missing required names count as pending, never green.
All occurrences of a required name must settle successfully; preserve existing SUCCESS/NEUTRAL/SKIPPED semantics.
Optional failures and optional pending entries do not block active required-only mode; required failures retain existing rerun policy.
Pass only required entries into failure/rerun and passing-log scans; do not fetch logs for running optional jobs.
Keep match-head-commit, manual-review holds, merge verification, release tagging, and preflight guards unchanged.
Hooks: ship.mjs `ship` 1112-1179; `summarizeRollup` 1065-1084; `waitForCi/Once` 1541-1588;
CI rerun/log scan 1598-1666; merge/held boundary 1668-1717; `SHIP_USAGE` 1030-1038.
C hooks: swarm.mjs `parseShipFlags` 4453-4530; `shipBranch` 4620-4645; `shipRun` 4693-4718.
Tests also cover missing required check, wrong SHA, required failure, duplicate contexts, no flag, 404, and non-404 refusal.

### §1.2 Ticket pipeline (A orchestrator, C dependency callbacks)

Syntax: `swarm ticket MANIFEST --pr PAYLOAD [--check ARGVJSON]... [--repo O/R] [--branch B]`
`[--commit-message M] [--require-section S]... [--resume RUN] [--wait-required-only]`.
Manifest and --pr required even on resume; --check has existing JSON argv grammar, max 10 additional checks.
Additional names are `ticket-check-1` ... `ticket-check-10`; reject collisions with manifest check names.
Default repo is ship's origin-derived repo; commit message defaults to payload.title; requireSections defaults [].
Default branch is payload.head; --branch must equal payload.head and the current symbolic HEAD (provisional P2).
Ticket does not create/switch branches or accept detached HEAD; verify this before the run stage spends.
Reuse `runManifestChecked`, `inspectRun`, `integrateRun`, `runChecks`, `commitOutputs`, and `shipRun` through callbacks.
Do not spawn the swarm CLI recursively or reimplement integration/ship guards in pipeline.mjs.
C passes run/inspect/integrate/checks/commit/ship callbacks; A can test every stage with pure fakes.
C's run callback retains provider-limit, spend, doctor, validate and red-base guards from the ordinary run command.
No automatic budget override, red-base acceptance, salvage, dropped-write acceptance, or deviation acceptance.
Preselect runId with existing makeRunId('ticket'); pass that id through runManifestChecked to runManifest.
Create pipeline.json before run; creating the directory does not create runManifest's exclusive `claim` file.
Ordered stage enum: `run`, `inspect`, `integrate`, `checks`, `commit`, `ship`.
Run ok iff state.status===complete and all jobs complete; detail is `{id,status}` plus safe diagnostic results on failure.
Inspect ok iff all jobs complete and all file statuses are ready/unchanged; missing/conflict/blocked is red.
Existing inspect warnings remain visible in detail; no newly invented automatic warning waiver.
Integrate calls integrateRun(root,id,{noChecks:true}); keep its existing preChecks, conflict and output safeguards.
Integrate ok iff status===integrated, no rejected/blocked/deviation result, and preChecks all passed.
Checks runs manifest checks plus additional checks via exported runChecksForRun; ok iff checksPassed and !checksErrored.
No check results means ok, with existing no-check warning retained at ship; never synthesize a passed check.
Capture lockfile hashes before integrate, so lockfiles changed by integrate preChecks are attributed too.
Commit exactly declared output paths plus lockfiles whose bytes changed during integrate/checks; deduplicate, sort.
Provisional P2 lockfile allowlist: package-lock.json, npm-shrinkwrap.json, uv.lock, pnpm-lock.yaml, yarn.lock, Cargo.lock (root-relative).
Existing unrelated dirt/index entries refuse before run; recheck before commit to catch edits introduced concurrently.
Do not attribute a pre-existing dirty lockfile to checks; snapshot presence/hash and index state before any stage.
Call commitOutputs(root,files,message) for exact path staging, never `git add .` or `git add -A`.
An unchanged tree is an ok commit stage with `{status:"unchanged",files:[],sha:"SHA"}`; do not create an empty commit.
For changed files require commit success and capture SHA; fail before ship on unexpected dirt outside allowed paths.
Ship calls shipRun with additionalChecks as an INTERNAL option, preserving its public --check restriction for run IDs.
Ship may revalidate local checks as it does today; the ticket checks stage does not disable ship's final guards.
Ship ok iff shipExitCode(status)===0; held remains held, never report it merged.
Final JSON: `{"status":"complete","runId":"RUN","ship":{}}`, with the entire ship result in ship.
A red result uses §1.0, persists its error entry, exits 1 and never executes a later callback.

Pipeline path: `.swarm/runs/<runId>/pipeline.json`; UTF-8 JSON, trailing LF, atomic same-directory replacement.
Schema v1 (all keys required, no stage result data discarded):
`{"version":1,"runId":"RUN","root":"ABS_REAL_ROOT","manifestPath":"REL","manifestHash":"SHA256","payloadPath":"ABS","payloadHash":"SHA256","options":{"repo":null,"branch":"B","commitMessage":"M","requireSections":[],"checks":[],"waitRequiredOnly":false},"lockfileBaseline":{},"stages":[]}`
`checks` uses `{name,argv}` objects; lockfileBaseline maps every allowlisted path to SHA256 or null when absent.
Each stages element: `{"stage":"run","status":"running","startedAt":"ISO_UTC","finishedAt":null,"detail":{}}`.
Before each callback append running entry and flush; afterward append ok/error entry with same startedAt and finishedAt=clock ISO.
Final entries retain returned detail; never overwrite historical entries. Use injected now() in milliseconds.
Resume validates schema/version/root/runId, hashes, normalized options, legal stage order and dependency prefix.
For each stage use its latest entry; skip iff latest status=ok, reusing its saved detail; never rerun a green stage.
Persisted success is not permission to skip validation of journal identity or path safety.
An error at checks may be retried after environment repair; a new entry records the attempt, preserving earlier red evidence.
Provisional P2: an interrupted running stage refuses pipeline-resume-unsafe rather than guessing whether its side effect committed.
A failed run cannot be relaunched using its existing exclusive claim; resume returns that run's red result, requiring a new ticket.
Missing/invalid pipeline.json is pipeline-invalid; an ordinary legacy run is not silently upgraded into a ticket pipeline.
Hooks: swarm.mjs `runManifestChecked` 4722-4731; existing `go` callbacks 5305-5319; `readState` 2293-2298;
`integrateRun` 2966-2998, 3200-3284; `runChecks` 2624-2732; `shipRun` 4648-4719; `main` 4778-4783, 5096-5349.
C exposes runChecksForRun(root,id,{additionalChecks=[],spawnImpl,env}={}) using readState, saved manifest, port/env loaders and runChecks.
Tests cover every red stage, all-green resume with zero callbacks, failed checks resume, corrupt journal, crash marker, dirty lock and unrelated staged file.

### §1.3 Workspace environments and classification (B helpers, C integration, A ship guard)

Only codex and claude shell worktrees receive automatic environment linking/sync; plain/API jobs keep existing behavior.
Without --sync, for each existing root `.venv/` and `node_modules/`, resolve realpath, validate denied-home rules and require directory.
Create worktree `.venv` / `node_modules` symlinks to the real root directory; do not copy their contents or include them as proposals.
If worktree destination already is a local directory, retain it; reject a conflicting symlink/file, never replace it recursively.
Existing matching dependency links are idempotent; new automatic links are an explicit exception only in internal worktrees.
Use profile option `environmentReadPaths=[]` distinct from generic readPaths so it can carry strict write denials.
Exact profile lines per canonical dependency path P (sandboxPath-validated, escaped with existing filter):
`(allow file-read* (subpath "P"))`
`(allow process-exec (subpath "P"))`
`(deny file-write* (subpath "P"))`
Read/exec grants follow temp/home deny rules; final dependency write deny follows ALL writable grants/restrictions.
Keep denied-home/keychain rules last; grants must never reopen a denied credential path.
Add literal file-read-metadata for ancestors of P, including temp ancestors; never add broad ancestor content grants.
Explicit final write denial matters even if root dependencies resolve under /private/tmp or another existing writable subtree.
Keep interpreter-chain resolution via resolveVenvInterpreterDirs; C applies it to codex as well as shell profiles.
`run --sync` sets runtime sync=true (default false), not a new manifest job field; thread through checked run/body/adapter options.
With sync, create no root dependency links. Refuse an existing external dependency symlink before invoking any installer.
Provisional P3: run both commands in order if both markers exist: uv sync --locked, then npm ci; neither marker means no-op.
Commands execute outside the worker sandbox in its own worktree with setup env and no worker key, before existing job.setup.
Reuse runJobSetup/runCheck via injected setup callback, with each command timeout 600000; nonzero prevents worker spawn.
Keep setup.log and existing setup-failed result; never silently fall back to shared links after sync fails.
Bad environment adds `{"code":"workspace-env-invalid","path":"PATH"}` to a failed/refused-before-start job result.
Worker prompt line (both adapters): `Manifest checks: LIST. Run these; fix red before you return; report checksRun.`
LIST is name plus JSON argv for each check; checksRun shape is `[{"name":"NAME","status":"passed|failed|not run"}]`.
Keep integrateOnly/path-denied checks visibly listed as not run; no instruction to evade sandbox or run an orchestrator-only suite.
No checks: LIST=`none declared; run relevant tests`; preserve existing shell check/result guidance.

Shared classifyCheckEnvironment({exitCode,head}) returns null or exactly:
`{"code":"check-env-missing","hint":"run uv sync --locked / npm ci in this worktree or pass --sync"}`.
Trigger exitCode===127 regardless of output, OR exitCode===2 and `/Failed to spawn|command not found|No such file or directory/i` in first three lines.
Normalize CRLF; head captures the first three combined stdout/stderr lines in observed order, across chunk boundaries.
Capture head independently of tail; a long later log must not discard the trigger. Do not match a fourth-line-only trigger for exit 2.
runCheck adds head:string, then status=check-env-missing and code/hint above before unrunnable/pre-existing handling.
Cancellation/timeout/cleanup failure still wins; spawn-error/cannot-run without a numeric exit keep their existing statuses.
Add check-env-missing to CHECK_ERRORED_STATUSES and NOT_PASSED; preCheck retry is still bounded, never green by default.
originForCheck must not call an environment-failed base probe pre-existing; require a genuine base status=failed.
A applies the same classifier before ship's base verification, preferring head then full output; legacy short tail is last fallback.
Ship refuses these results as checks-failed with code=check-env-missing and the exact hint; --accept-pre-existing cannot bypass it.
Hooks: codex-adapter.mjs codexProfile 55-94, codexMessage 105-117; claude-shell.mjs shellProfile 235-295,
resolveVenvInterpreterDirs 403-430 and shellMessage 436-446; swarm.mjs runJobSetup 1426-1442,
executeCodexJob 1474-1532, executeClaudeShellJob 1623-1743, runManifest 1827-1877/body 1878-1966,
runCheck 2545-2600, originForCheck 2605-2623, runChecks 2624-2732, smokeCheckInSandbox 1459-1470;
ship.mjs checks/base verification 1393-1438 and failed check gate 1440-1451.

### §1.4 Streaming evidence and codex retry (B helpers, C call sites)

Before spawning create `.swarm/runs/<id>/<job>/stderr.txt` and `stdout.txt` with append semantics, including empty streams.
Write every child chunk immediately to its stream file; close/flush on success, failure, spawn throw, timeout and cancellation.
Keep existing provider.jsonl, stderr.log, response.txt, agent.log, progress byte counters and the existing in-memory log cap.
Append evidence before the in-memory cap check; a cap-triggered termination retains the chunk that caused termination.
Reuse the same files across the one retry without truncation; do not interleave invented attempt banners with child bytes.
Streaming sink errors fail the job with `{"code":"adapter-log-failed","stream":"stderr|stdout"}`; no silent evidence loss.
Preserve privateData withholding and worker-key redaction before persistence (provisional P4 security-preserving exception to full streams).
For privateData write the existing withheld placeholder; inspect must not reveal hidden output via stderrTail.
For shell keys split across chunks use a per-stream rolling suffix buffer; redaction must work across boundaries and at close.
Codex retry regex is exactly `/workspace routing discovery failed|Reconnecting\.\.\. 5\/5|Connection failed: error sending request/`.
B owns CODEX_BLIP_RE and retry helper; C invokes it inside executeCodexJob while the worktree still exists.
Predicate: first attempt failed, regex matches stderr, zero declared outputs written, not cancelled/timed out/cleanup-failed/refused-before-start.
Snapshot output bytes/modes immediately before launch; output creation, modification, or deletion disables retry.
Unchanged pre-existing output is not a worker write; do not use anyOutputExists or envelope files as evidence of output production.
Missing-output validation failures must retain the child's stderr and reach the same retry decision before cleanup throws it away.
Retry once in the same worktree with a fresh result-output filename; clean old result evidence must never impersonate the new reply.
Before retry persist record.retries=1 and record.retryReason=`codex-blip: MATCHED_TEXT`; second failure is final.
Legacy retries defaults 0, retryReason null on read; preserve existing plain-Claude api_error retry semantics and fields.
inspectRun and inspectResults add stderrTail:string|null to every non-complete job; last 20 lines, drop one final empty newline.
Missing legacy file => null; complete jobs omit the field; privateData uses withheld placeholder without reading raw stream contents.
Hooks: swarm.mjs execute 1286-1381 stream listeners/finish, executeCodexJob 1474-1572,
runOne call sites 2057-2061 and existing retry 2079-2093, state record 1966 and final assignment 2239,
inspectRun 3807-3861 and inspectResults 3863-3965; codex-adapter.mjs exports 149-199.
Tests cover killed fake process evidence before close, thrown spawn, both streams, 20-line tail, second blip, output-written veto and no-signature veto.

### §1.5 Scaffolds and stub gate (C generation, A refusal)

Syntax exactly as brief for scaffold job/pr; global --root plus help accepted; no undisclosed flags.
Job requires id/agent/model/tier/context/outputs; comma lists trim/dedupe, reject empty interior members; empty outputs may mean [].
Timeouts: cheap 900000, mid 1800000, expensive 2400000; model/agent validation delegates to validateManifest.
Manifest shape: `{"version":1,"jobs":[{"id":"X","agent":"A","model":"M","tier":"T","prompt":"TEXT","context":[],"outputs":[],"timeoutMs":900000,"ignoreTests":[]}]}`.
Expensive adds tierReason=`Explicit expensive tier requested for scaffolded job.` (provisional P5); no model fallback.
Prompt-file contents are preserved; absent file uses `Implement the declared outputs using the supplied context.` (provisional P5).
Optional ticket appends `Ticket: docs/TICKETS.md#T81`; validate ticket file exists and add the part before # to context.
Use listProjectFiles(root) and findUncoveredTests(root,job,projectFiles), exactly the validator's context-check call.
Fill sorted unique ignoreTests from uncovered[].test; append one standard sentence per test:
`ignoreTests: PATH — Existing test is outside this job's declared outputs; the coordinator runs it after integration.` (provisional P5 wording).
Always append `Return JSON only: {"status":"complete|partial|blocked","filesChanged":[],"reproTest":"PATH or n/a"}`.
Run validateManifest and validateProject before writing; no automatic check deletion or broad ignore glob.
Default output `.swarm-manifests/<id>.json`; create parents, exclusive write, return `{"status":"ok","file":"PATH","manifest":{}}`.

PR requires --from RUN and --title T; --repo optional, output default `.swarm-manifests/<run-id>-pr.json` (provisional P5).
Read state/manifest and inspectResults; verify run belongs to root. Never execute worker findings as commands.
Payload exactly `{title,head,base,body}` accepted by parsePrPayload; do not add repo as an unsupported payload key.
Resolve head using git symbolic branch; resolve base with `gh repo view [O/R] --json defaultBranchRef --jq .defaultBranchRef.name`.
Provisional P5: no guessed main/master fallback; missing head/base returns scaffold-branch-unavailable.
What bullets: one per filesChanged entry and finding, grouped by job id; preserve informative string/object finding text as inert Markdown.
If filesChanged absent, use files_changed then declared outputs as explicitly labeled declared paths; never call them proven changes.
If state.integratedFiles or a job result changed CHANGELOG.md, append its top `##` entry through next `##`; use proposal before integration.
Body sections in order: `## What`, `## Checks` containing `<!-- swarm:checks -->`, `## Mutation check` containing `<!-- swarm:stub mutation -->`.
Provisional P5 trailers: `Swarm-Run: RUN` and `Swarm-Jobs: ID1, ID2`; supplied context does not establish another project trailer format.
Do not invent human attribution/coauthor lines. Success: `{"status":"ok","file":"PATH","payload":{}}`.
A adds exported STUB_SECTION_RE=`/<!-- swarm:stub(?:\s+[^>]*?)?\s*-->/` and checks only each requested section's content.
Required section matching stays headingMatchesName-compatible; check stub before generic missing/placeholder refusal.
Exact diagnostic object: `{"code":"stub-section","section":"S"}`; merge into existing refused ship result and failures entry for preflight.
Keep reason=`stub-section: S`; refusal occurs before push/PR mutation even with other prose alongside the stub.
Do not globally change CHECKS_PLACEHOLDER replacement or claim a mutation was run by generating text.
Hooks: swarm.mjs context imports 25, validateProject 3593-3600/3766-3804, validateManifest 890-1097;
inspectResults 3863-3965, main 4778-4783/5096; ship.mjs getMarkerForSection 736-750,
missingSections 818-833, preflightReport 444-498, ship missing section gate 1440-1451.

### §1.6 Release and usage (C, except SHIP_USAGE owned by A)

package.json:3 -> 1.42.0; preserve scripts 9-14 and dependencies. CHANGELOG.md:1-13 prepend ## 1.42.0.
README.md:37 gets one concise ticket/scaffold paragraph; kickoff version pins at 18/21 become 1.42.0.
SKILL.md Workflow at 44-65 receives exactly two new lines mentioning ticket and scaffold; no other section growth.
Preserve T80's already-fixed names/content; no reset of its release entry. Existing skill version pin may update to 1.42.0 without growth.
Update main global usage, ship usage, new TICKET_USAGE/SCAFFOLD_USAGE for every listed flag including run --sync.
No other release files or dependency lockfile edits are assigned in this build batch.

## §2 Build and verification rules

Use node:test describe/test, node:assert/strict, mkdtemp+realpath and t.after cleanup as batch-y demonstrates.
Use SWARM_TEST_TMP || TMPDIR || os.tmpdir(); all test invocations import tests/_isolate-config.mjs first.
Run owned tests: `node --import ./tests/_isolate-config.mjs --test tests/field-lesson-t81-<pipeline|adapters|cli>.test.mjs`.
Coordinator runs npm test and npm run check after integration; package.json has no build script, do not invent one.
This contract job runs no tests, installs, network commands, providers, or git mutations, per its specific instruction.
Fakes for gh/git/codex/clock are mandatory; do not copy batch-y's real git init/commit fixture behavior into T81 tests.
Inject exec/spawn/now/sleep at the actual boundary; C may add optional gitImpl seams in swarm.mjs, B in adapter git helper.
No fake that merely tests a duplicate implementation: exercise production callbacks, stream listeners and refusal predicates.
Fake run ids run-0000; numeric ids 9001+; no real names/repos/URLs/prompt text; synthesize protocol strings with numeric ids and .invalid hosts.
Use local helper labels in §3, generated temp fixture files, actual SHA256 baseHashes; no committed shared fixture files.
Cover absent new state fields from disk, empty streams, no protection, default flags, and old output keys.
Use node child CLI help/parser tests with inherited isolated env; fake executables for any process protocol needed.
No new npm dependency, no generic parser rewrite, no reformatting untouched code, no deletion, no stash or hand-reverted mutant.
Jobs JSON is scheduling metadata; coordinator supplies agent/model/prompts/checks and contract when making execution manifests.
Do not translate dependsOn into codex after; C runs in a later cohort after A/B integrate. No worker dispatches workers.

## §3 Cross-job names (frozen interfaces)

New exports owned by A in ship.mjs: classifyCheckEnvironment({exitCode,head}), STUB_SECTION_RE.
A in pipeline.mjs: PIPELINE_STAGES, TICKET_USAGE, parseTicketArgs(argv), ticketPipeline(root,options,deps).
B in codex-adapter.mjs: prepareWorkspaceEnvironment(root,worktree,{sync=false,runSetup,home,config}={}),
createAdapterLogSink(directory,{privateData=false,workerKey=null}={}), CODEX_BLIP_RE,
runCodexWithRetry(attempt,{hasWrittenOutputs,onRetry,cancelled}).
prepareWorkspaceEnvironment -> {environmentReadPaths,setupResult}; runSetup(argv) -> runCheck result, nonpass stops preparation.
createAdapterLogSink -> Promise<{write(stream,chunk),close()}>; write is ordered/synchronous to caller or internally queued, close awaits all writes.
runCodexWithRetry -> final result; attempt(index) receives 0/1, hasWrittenOutputs()->Promise<boolean>, onRetry(reason)->Promise<void>.
C exports in swarm.mjs: runChecksForRun(root,id,options); changes existing runManifestChecked to accept id/sync while preserving callers.
C in scaffold.mjs: SCAFFOLD_USAGE, parseScaffoldArgs(argv), scaffoldJob(root,options,deps), scaffoldPr(root,options,deps).
Scaffold deps: validateManifest, validateProject, listProjectFiles, findUncoveredTests, readState, inspectResults, exec; no import cycle back to swarm.
Pipeline deps: run(root,manifest,id), inspect(root,id), integrate(root,id), checks(root,id,additionalChecks),
commit(root,files,message), ship(root,id,flags), exec(file,args,{cwd}), now(), makeRunId(prefix).
Existing shared exports: ship, SHIP_USAGE, parsePrPayload, shipExitCode, parseShipFlags, shipRun, shipBranch,
runManifest, inspectRun, inspectResults, readState, integrateRun, validateManifest, validateProject, runCheck,
codexProfile, codexMessage, shellProfile, shellMessage, resolveVenvInterpreterDirs, git, commitOutputs, makeRunId.
Shared flags: --root, --help, -h, --wait-required-only, --sync, --pr, --check, --repo, --branch,
--commit-message, --require-section, --resume, --id, --agent, --model, --tier, --context, --outputs, --prompt-file, --ticket, --out, --from, --title.
Shared codes: ticket-args, pipeline-stage-failed, pipeline-invalid, pipeline-resume-unsafe, pipeline-dirty,
pipeline-branch-mismatch, required-contexts-unavailable, check-env-missing, workspace-env-invalid, adapter-log-failed,
scaffold-args, scaffold-invalid, scaffold-run-invalid, scaffold-branch-unavailable, scaffold-exists, scaffold-io, stub-section.
Shared state.json fields: version,id,root,status,jobs,baseCommit,integratedAt,integrationStatus,integratedFiles,
integratedNewFiles,checks,checksPassed,checksErrored; jobs[].id,status,outputs,workspace,baseHashes,baseModes,
retries,retryReason,progress,keptWorkspace,setupFailed. Only retries/retryReason extend codex persistence; legacy defaults 0/null.
Other shared result/options keys: sync,environmentReadPaths,additionalChecks,head,stderrTail,checksRun,
waitRequiredOnly,requiredContexts,pendingAtMerge,waitedForRequiredOnly; pipeline fields exactly §1.2.
Shared source paths: tools/swarm.mjs, tools/ship.mjs, tools/codex-adapter.mjs, tools/claude-shell.mjs,
tools/pipeline.mjs, tools/scaffold.mjs, docs/_swarm/t81-brief.md, docs/_swarm/t81-contract.md, docs/_swarm/t80-contract.md,
tests/_isolate-config.mjs, tests/field-lessons-batch-y.test.mjs, package.json, CHANGELOG.md, README.md, skills/project-swarm/SKILL.md.
Shared runtime paths: .swarm/runs/<id>/pipeline.json, state.json and manifest.json in that same directory;
.swarm/runs/<id>/<job>/stderr.txt and stdout.txt; .swarm/runs/<id>/worktrees/<job>; .swarm/workspaces/<id>/<job>.
Shared local fixture labels: pipeline9001, required9001, optional9002, blip9001, output9001, uncovered9001, legacy9001, fakeClock9001.
T80 §3 remains binding: tools/lessons.mjs, tools/lessons-publish.mjs, lessonQueueWarnings and run warning composition retain their names.
CrossJobNames=157: 39 exports, 23 flags, 17 codes, 24 state paths, 15 source paths, 7 runtime paths, 8 fixture labels, 11 other keys, 7 stage/command names, 6 lockfile names.
Count state paths with jobs[]. qualification; exports include runManifestChecked, stage/command names are six stages plus scaffold; exclude T80 inventory.

## §4 Mutants (apply only with swarm mutants)

(a) A: `T81 required checks merge while optional checks run` must fail if the selected rollup assignment becomes `selectedRollup = fullRollup`.
Assert merge occurs while optional9002 is pending, and pendingAtMerge names it; fake clock must not accidentally settle optional work.
(b) A: `T81 pipeline stops at first red stage` must fail if `if (!ok) return failure` becomes `if (false) return failure`.
Assert no later callback, exact error stage, durable error entry and nonzero CLI exit for every stage position.
(c) A: `T81 resume skips every green stage` must fail if `if (latest.status === 'ok') continue` becomes `if (false) continue`.
All-green journal must return saved ship result with zero callbacks, including zero commits and provider calls.
(d) A/C: `T81 spawn-shaped failures cannot become pre-existing` must fail if classifier's trigger return becomes `return null`.
Use exit 2 first-line Failed to spawn plus base returning the same; assert check-env-missing, no base rerun, no merge even with acceptance.
(e) B/C: `T81 failed fake codex leaves streaming evidence` must fail if stderr sink append becomes `if (stream !== 'stderr') append()`.
Read stderr.txt before child close, then after simulated failure; assert exact chunks survive, not only progress.stderrBytes.
(f) B: `T81 codex retries only blips with zero written outputs` must fail for either one-line deletion of regex guard OR output-written guard.
Test both independent mutations, zero-output blip retries exactly once, unsigned failure never retries, and modified/created/deleted output vetoes.
(g) A/C: scaffold stub test must fail if generated mutation marker becomes empty; required-section test must fail if stub guard becomes false.
Run both one-line mutants; prose alongside a stub must still refuse before any remote mutation.
(h) C: `T81 scaffold job covers uncovered tests and validates` must fail if `job.ignoreTests = uncoveredTests` becomes `job.ignoreTests = []`.
Fixture uncovered9001 references output9001; assert exact ignored path, standard sentence, and production validation success.
Mutant find strings are bound to the implemented single line after integration; never claim a textual sketch was executed.

Binding implementation clarifications (included in the inventories above):
- The eleventh other shared key is `setupResult`, the preparation helper's returned setup outcome.
- Default link mode runs existing job.setup first, then links only absent dependency directories; this prevents setup from mutating root dependencies through a new link.
- Sync mode performs automatic sync before existing job.setup and creates no links; failure stops both setup continuation and worker launch.
- Retry output-write evidence includes removal of an existing output; changed output modes also veto retry.
- Legacy check fixtures without head use output or short tail only for compatibility; new runCheck always retains head independently.
- The six pipeline stage names counted above are run/inspect/integrate/checks/commit/ship; ticket is additionally the CLI command and should be treated as frozen, making CrossJobNames=158.

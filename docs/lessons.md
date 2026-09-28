# Field lessons

Every real-run friction becomes an entry here plus, where possible, a tool
check and a test. Each entry records what happened, the rule, and where that
rule is enforced or documented.

1. **Denied reads lost finished work.** A completed output was treated as a
   failed job solely because reads outside its context were denied. Rule:
   preserve finished work, warn for denial-only success, and retain changed
   outputs on other failures. Enforcement: the runner records capped warnings
   and `keptWorkspace`, keeps failed runs blocked from integration, and adds a
   context-only read reminder. Regression coverage is in `tests/lessons.test.mjs`.
2. **A claimed regression test passed on old code.** The worker's assertion
   that its new test failed without the fix was false. Rule: orchestrators run
   `redcheck` before trusting a regression claim and inspect the actual failure.
   Enforcement: the [redcheck command](manifest-reference.md#redcheck) restores
   base implementation bytes temporarily; red, green and error restoration
   cases are covered in `tests/lessons.test.mjs`.
3. **CI handoff guesses were wrong.** Bisecting on CI with throwaway branches,
   a control branch and a push-triggered, single-OS diagnostic workflow found
   the cause in three short rounds. Rule: reproduce in the failing environment,
   use verbose per-test timings, and open no diagnostic pull requests.
   Documentation: [Bisect on CI](orchestration.md#bisect-on-ci) and
   `templates/ci-diag.yml`.
4. **Equal wait and test timeouts hid the stuck step.** The runner reported only
   that the test timed out. Rule: keep element waits below the test timeout and
   diagnose with a long `--testTimeout`. Documentation: the skill's UI-test
   prompt guidance.
5. **Logging hid a race.** Probes changed timing enough to mask the failure.
   Rule: record events into an in-memory array and print only on failure.
   Documentation: the skill's “Tracing races” guidance.
6. **An inference became false evidence.** A job prompt stated a suspected
   cause as fact and the worker built on it. Rule: separate “Evidence
   (measured)” from “Hypothesis” in every diagnostic prompt. Documentation:
   the skill's prompt guidance and [orchestration](orchestration.md#evidence-in-job-prompts).
7. **A held-response fake froze state too soon.** It built the response when
   the request arrived, so it could not reproduce service after a later event.
   Rule: held responses offer snapshot-at-release to model that real ordering.
   Documentation: the skill's UI-test and fake guidance.
8. **Three of four new guards lacked tests.** Mutation testing found those
   gaps even though the worker's own test supposedly proved the fix. Rule:
   add one mutant per new guard before shipping and inspect each kill.
   Documentation: [verification](verification.md#regression-and-mutation-evidence).
9. **A new topic needs fresh context.** Continuing unrelated work carried old
   assumptions forward. Rule: hand off at the dispatch limit or when the next
   work is unrelated, whichever comes first. Documentation:
   [kickoff](kickoff.md#handoff) and
   [orchestration](orchestration.md#fresh-context-per-topic).
10. **Mutation tooling existed but nothing pointed to it.** The orchestrator
    hand-wrote mutant scripts for weeks because the existing `mutants`
    manifest field and `integrate --mutants` never surfaced at the moment of
    need. Rule: surface existing tooling at the point of need instead of
    re-inventing it. Enforcement: `ship ... --require-section` warns
    `no manifest mutants: declare "mutants" in the manifest and run
    "integrate --mutants" (see docs/verification.md)` when the run's manifest
    declares no `mutants`; the skill's ship checklist repeats the same line.
    Documentation: [manifest reference](manifest-reference.md#mutation-checks)
    and [verification](verification.md).
11. **A bare HTTP 307 hid a renamed repository.** `ship` failed at PR
    creation with only an opaque redirect code; the git remote already
    pointed at the repository's new name. Rule: derive the repo from the git
    remote instead of trusting a stale flag, and explain a redirect as a
    possible rename. Enforcement: `ship` derives `--repo` from
    `git remote get-url origin` when it is omitted, warns when a given
    `--repo` differs from origin, and appends `(repo moved? origin is
    OWNER/NAME)` to any GitHub CLI error containing `HTTP 301`, `302`, `307`,
    or `308`. Documentation: [manifest reference](manifest-reference.md#ship).
12. **`update` reported up to date on the old version.** It ran seconds
    before the release-tag workflow finished publishing the new tag. Rule:
    distinguish "no newer tag yet" from "the tag is still on its way."
    Enforcement: `update` returns `tagPending: true` and message `tag pending
    for <version>; retry in a minute` when origin's package.json version is
    already newer than the newest `v*` tag; `ship` itself polls for the new
    tag after merging a version-bump PR and reports `tag: {name, status,
    waitedSeconds}`. Documentation:
    [manifest reference](manifest-reference.md#ship).
13. **A wiring job added an undisclosed request.** Told to reuse an existing
    data fetch, the worker found the component on the data path outside its
    declared outputs, quietly added a new request instead, and mentioned it
    only in a side field; two existing tests broke and a follow-up job was
    needed (cost: $1.18 plus the follow-up). Rule: scout the data path — who
    mounts or calls whom — before a wiring job, and put every file on that
    path in its outputs; a worker that cannot meet a rule inside its outputs
    must return `blocked`, never work around it. Enforcement: the worker
    preamble states the blocked-not-worked-around rule; `inspect --results`
    warns `outside outputs: <job>: <path>` when a job's `crossJobNames` or
    `notes` name a real repo path outside its own outputs. Documentation:
    [orchestration](orchestration.md#wiring-jobs).
14. **The first real `redcheck` run misfired twice.** A test command passed
    as one quoted string failed with an empty error, and on a follow-up job
    the run's base commit already contained the feature, so the check
    reported green even though the old code on the default branch actually
    failed most of the new tests. Rule: pass the test command as separate
    argv tokens, and check the run's base against the default branch before
    trusting a green result. Enforcement: a spawn failure now returns a hint
    to pass separate argv tokens; `redcheck --base <ref>` restores from an
    explicit ref, and an omitted `--base` gets a `suggestBase` field and a
    warning when the run base is not an ancestor of the default branch tip.
    Documentation: [manifest reference](manifest-reference.md#redcheck).
15. **A sandboxed checker found its own missing environment variable.** A
    worker running in a detached, sandboxed worktree saw its test runner
    fail with `EPERM` on `package.json` and had to find the right
    environment variable itself before it could report a real result; a
    weaker worker could easily have reported that setup failure as a red
    suite (13 minutes, 262k tokens spent working around it). Rule: name the
    required test environment explicitly instead of relying on a worker to
    rediscover it. Enforcement: manifest job field `testEnv` (codex jobs
    only) sets the child process environment and tells the worker what is
    already set; `doctor codex` adds a `sandbox probe` check that surfaces
    the same kind of sandbox denial up front. Documentation:
    [orchestration](orchestration.md#sandboxed-checker-jobs).
16. **A pre-existing flake looked like a regression.** A wait equal to the
    test timeout (see entry 4) stopped `ship` on a repeated check; telling a
    flake already present on the base commit apart from an actual regression
    took 20 hand-run loops of the suite, twice. Rule: automatically compare a
    failing repeated check against the run's base commit before asking a
    human to hand-run anything. Enforcement: a failing check with `repeat`
    reruns the named test file against a temporary checkout of the run's
    base commit and reports `flakeOnBase: {file, failed, runs}` plus a
    `flake on base: k/N (<file>)` line; entry 4's rule (keep waits below the
    test timeout) still stands. Documentation:
    [verification](verification.md#flake-on-base).
17. **A correct report got lost behind a one-line summary.** A worker wrote
    a valid JSON report file but ended its turn with a short prose summary
    instead of that JSON as its final message, so `inspect --results` showed
    nulls and the orchestrator had to open the file by hand. Rule: let a job
    declare its own report file so review does not depend on the worker's
    last line matching it. Enforcement: job field `resultFile` (must be one
    of that job's `outputs`, with optional `resultSchema` listing required
    keys); `inspect --results` reads and parses that file directly, warning
    on missing/invalid JSON, missing keys, or a mismatch with the worker's
    own final message, and reports `resultSource: 'file'|'message'`.
    Documentation: [verification](verification.md#resultfile).
18. **A mutant could not be declared before the code it targets existed.** A
    build job's generated code held the only string a useful mutant's `find`
    could match, so that mutant could not be written into the manifest before
    the run even started, and the orchestrator fell back to a hand-written
    mutation loop again. Rule: let mutants be supplied once the code they
    target actually exists, under the same shape and cap as declared ones.
    Enforcement: `integrate <run-id> --mutants --mutants-file FILE` loads
    mutants from a JSON array or `{mutants:[...]}`, and a job field
    `mutantsFile` (one of that job's own outputs) is collected automatically;
    `--mutant-check "<argv json>"` supplies the check when the manifest
    declares none. Documentation:
    [manifest reference](manifest-reference.md#mutation-checks) and
    [verification](verification.md).
19. **A failed job kept only "missing output," not why.** A worker exited
    non-zero, or wrote none of its declared outputs, and the run reported
    only `Missing output (deletions are never propagated): <file>`; the
    worker's own explanation — a `blocked` envelope naming what it needed, or
    a provider's plain "out of credits" line — lived only in an unread
    stderr log. Rule: keep a worker's own failure reason next to the job
    record, and never let a later generic message stand in for a `blocked`
    envelope. Enforcement: the last 4 KB of stdout/stderr are saved to
    `agent.log` and summarized as `agentError` (exit code plus the first
    matching blocked/credit/quota/rate-limit/auth line, else the last
    stderr line), shown in `inspect`/`inspect --results`, with secrets
    redacted; a worker's own `blocked` envelope is reported as job status
    `blocked` with its summary instead. Documentation:
    [verification](verification.md#agent-failure-evidence).
20. **A review round's context quietly dropped new captures.** A reviewer's
    context was copied from the previous round and never updated, so new
    screenshots landed in the same directory without ever reaching the
    job, and the reviewer reported already-fixed items as still missing.
    Rule: warn when a job's context names most, but not all, files of one
    kind in a directory, and offer a way to include a whole directory
    instead of naming files by hand. Enforcement: `validate`/`run` warn
    `context lists k of n .ext in <dir>; missing e.g. a.ext, b.ext (+m
    more)` when context names 3+ files of one extension from a directory
    that holds others it omits; job field `contextGlob` (`["dir/*.ext"]`,
    no `**`) expands to every matching file at validate/run time.
    Documentation: [manifest reference](manifest-reference.md#context-check).
21. **A toolchain path had days left before macOS deleted it.** A named tool
    path and a check's own argv binary both resolved under a temp directory
    that macOS silently clears after a few days unread. Rule: warn as soon as
    a resolved binary lives under a temp directory unsafe to leave unattended.
    Enforcement: `doctor` warns when a named tool path, or a check argv
    binary, resolves under `/tmp` or `/private/tmp`, naming the macOS
    three-day cleanup and telling the operator to move the toolchain.
    Documentation: [manifest reference](manifest-reference.md#doctor).
22. **A pinning test could never actually run against the file it pinned.**
    A job's declared outputs included a file whose own regression tests
    needed a shell, but the worker assigned to write it had none, so nobody
    could ever exercise that pin. Rule: flag an output whose only tests a
    no-shell worker cannot run when that output is also the runner's own
    core module, and suggest a follow-up checker job instead of trusting an
    unverifiable pin. Enforcement: `validate` warns to "consider a checker
    job" in that exact situation; `inspect` also reports cost per 1k output
    tokens per job whenever token usage is known, making a token-heavy job
    visible without hand computation. Documentation: [manifest
    reference](manifest-reference.md#validate).
23. **A dependency lockfile changed and nobody resynced the environment.**
    An integrated run touched a lockfile, and the checks that followed ran
    against an environment nobody had reinstalled into, giving misleading
    results. Rule: let a manifest declare commands to run before checks
    whenever a lockfile changed, and warn plainly when it doesn't.
    Enforcement: `integrate` runs an optional manifest `preChecks` (an argv
    array) before its checks whenever an integrated file matches a lockfile
    pattern (`uv.lock`, `package-lock.json`, `Cargo.lock`, `pnpm-lock.yaml`);
    with a changed lockfile and no `preChecks` declared, it warns "lockfile
    changed, env not synced". Documentation: [manifest
    reference](manifest-reference.md#prechecks).
24. **A failed check's real assertion was buried in a full log.**
    Diagnosing a failed run meant opening a whole log file to find the one
    assertion that actually failed, every time. Rule: surface the failing
    assertion inline, and let a diagnostic job see actual measured failures
    instead of a paraphrase. Enforcement: `integrate` prints a compact
    `failures` array (check name plus its last failing assertion lines,
    capped) for every failed check; `validate`/`run` accept `--evidence
    <file>`, whose failures block is appended verbatim to every job prompt
    under a fixed heading. Documentation: [manifest
    reference](manifest-reference.md#evidence).
25. **A no-shell worker was asked to reproduce a failure it could never see
    run.** A job prompt quoted a failure from a runtime check, but the
    assigned worker had no shell and so could never rerun the harness/e2e/
    preview suite that produced it. Rule: warn when a runtime-check failure
    lands in a no-shell worker's prompt, and suggest a shell agent or
    measured evidence instead. Enforcement: `run` warns "worker cannot
    reproduce; consider a shell agent or --evidence" when a job prompt
    quotes a failure from a check whose name contains `harness`, `e2e`,
    `playwright`, or `preview`, or the words "Timeout" and "waitFor", and the
    agent has no shell. Documentation: [manifest
    reference](manifest-reference.md#evidence).
26. **A whole review round's screenshots still needed naming one by one.**
    Even with a directory glob, a round that shared one filename prefix
    still had to spell out every one of its own files by hand. Rule: let a
    glob pattern also match by filename prefix, not only by directory and
    extension. Enforcement: job field `contextGlob` now also accepts
    `dir/prefix*.ext` (still no `**` and no directory wildcards); `validate`
    echoes the expanded file count per pattern so an unexpectedly empty or
    huge expansion is visible before dispatch. Documentation: [manifest
    reference](manifest-reference.md#context-check).
27. **A worker's final answer, still not JSON, made the run look like it had
    no result at all.** A prompt demanded JSON only, but the worker's final
    message still didn't parse, and the run recorded nothing usable even
    though the worker was still reachable. Rule: name the failure plainly
    and give a cheap, bounded chance to correct it on the same session
    before giving up. Enforcement: when a prompt demands JSON only and the
    final message does not parse, the job result is marked `resultMissing:
    true` in state and `inspect`; a `claude` agent gets one cheap re-ask on
    the same session, and that answer is used if it parses. Documentation:
    [verification](verification.md#resultmissing).
28. **A useful mutant needed a whole run's manifest, even for a one-off
    check.** Testing a single guard on the current tree meant writing a
    throwaway manifest and a full run just to reach mutation testing. Rule:
    let mutation testing run directly against the working tree, with no run
    at all. Enforcement: `mutants --mutants-file FILE --mutant-check "<argv
    json>"` applies each `{name,file,find,replace}` entry alone (its `find`
    must match exactly once, else `invalid`), checks it, and restores the
    file byte-for-byte before the next, restoring on `SIGINT` too, and
    reports killed/survived/invalid counts plus the first failing test line.
    Documentation: [verification](verification.md#mutation-checks).
29. **An intended error alarmed a review that expected only failures.** A
    harness view that deliberately triggered an HTTP error to exercise error
    handling was flagged by review as an unexpected failure. Rule: any view
    that intentionally triggers an error belongs on that view's own
    expected-errors list, not treated as a surprise. Enforcement: the
    skill's UI-job boilerplate states this rule directly. Documentation: the
    skill's UI-test prompt guidance.
30. **A brief document that lived outside the project could not be used at
    all.** Useful background for a research job sat in a path outside the
    project root, and the only way to use it was to copy it in by hand
    first. Rule: let a research brief name any readable path, read-only,
    while still keeping a copy for provenance and refusing early on a path
    that cannot be read. Enforcement: `scout`/`sweep --brief` accepts any
    readable path, including one outside the project root; it is copied
    into the scout/sweep directory for provenance, and an unreadable brief
    fails before its job ever backgrounds. Documentation: [manifest
    reference](manifest-reference.md#scout).
31. **A missing CLI and an empty error both hid the same kind of failure.**
    Landing a run failed partway through with a bare error before anyone
    noticed the required CLI simply was not on PATH; separately, a failed
    pull-request lookup gave no detail at all when its own error stream was
    empty. Rule: check that the tools a landing step depends on actually
    exist before doing any real work, and always show what came back, even
    when that is nothing. Enforcement: `ship` resolves `gh` and `git` before
    doing any real work and refuses at once with "gh not found on PATH" (or
    the spawn error text) when either is missing; a `pr list failed` reason
    always includes stderr, or the literal `(empty)` when there is none.
    Documentation: [manifest reference](manifest-reference.md#ship).
32. **A worker's own mutants file used the wrong shape, discovered only after
    the run.** A job wrote its post-build mutants file with different key
    names than required, and `integrate --mutants --mutants-file` refused
    only once the build had already finished — well after the manifest could
    have named the file so its shape could be checked up front. Rule: a job
    that writes mutants declares which output that is, so its shape is
    checked at validate time, not discovered later. Enforcement: `validate`
    warns when a job's output path matches `*mutants*.json` but the job
    declares no `mutantsFile`; the worker preamble for a job that does
    declare one states the exact `{name,file,find,replace}` shape directly.
    Documentation: [manifest reference](manifest-reference.md#job-fields).
33. **A failed mutants parse left every other output already written.**
    `integrate --mutants` wrote every job's output into the project tree,
    then failed while parsing the mutants file, leaving the run neither
    cleanly integrated nor safely retryable — a retry refused with "changed
    since worker snapshot" on the very files it had itself just written.
    Rule: integration is all-or-nothing; every precondition, including a
    mutants file's shape, is checked before the first file is written.
    Enforcement: `integrate --mutants` parses and validates every mutants
    source, including `--mutants-file` and a job's own `mutantsFile` output,
    before writing anything; a later failure instead leaves the run's saved
    state `integrationStatus: "partial"` (persisted immediately after the
    write step), so a retry recognizes files it already wrote as already
    applied instead of refusing them as changed. Documentation: [manifest
    reference](manifest-reference.md#post-build-mutants).
34. **A review round's copied context missed an entire new capture kind, and
    the existing drift warning stayed quiet.** A round's context was copied
    from the previous one, and a new kind of screenshot capture landed in
    the same directory alongside the files the context already listed; the
    reviewer reported the new captures as still missing. Rule: a job that
    names one capture kind by directory glob should name every kind actually
    captured there, not just the first one noticed. Enforcement: `validate`
    warns when a job's `contextGlob` entries for one directory cover only
    some of that directory's filename prefixes, naming the covered prefixes
    and up to 5 uncovered files; declaring one `contextGlob` entry per prefix
    (multiple entries already work against the same directory) closes the
    gap. Documentation: [manifest reference](manifest-reference.md#context-check).
35. **A cheap worker's own output file carried its final answer as a
    trailing line.** A worker appended its last-message JSON to the end of
    its own JSON output file instead of only in its final reply, so that
    file no longer parsed as JSON; `integrate --mutants` still wrote every
    output to the tree before discovering the parse failure, leaving the
    same stuck, unretryable state as an externally supplied bad mutants
    file. Rule: a JSON output file holds only its JSON; a worker's own
    result line belongs in its final message, never appended to a declared
    output. Enforcement: at job completion, any `.json` output that fails to
    parse (JSON.parse also refuses trailing data after an otherwise valid
    value) is recorded as warning `output-invalid-json: <path>`, shown by
    `inspect`, before integration ever attempts to use it. Documentation:
    [verification](verification.md#agent-failure-evidence).
36. **A mutation check ran, and reported, against a red base.** One of a
    run's checks failed, but `integrate --mutants` still applied and checked
    every mutant and reported each one "killed" — a result that looked like
    passing mutation coverage but proved nothing, since a failing base kills
    every mutant regardless of the guard being tested. Rule: mutants only
    count against a base that is actually green. Enforcement: `integrate
    --mutants` reports every mutant `skipped-red-base` (and `mutantsPassed:
    false`) whenever any check failed, instead of actually running them;
    `ship --require-section "Mutation check"` refuses outright when the
    integrated run's mutants came from a red base. Documentation: [manifest
    reference](manifest-reference.md#mutation-checks).
37. **A worker's edit outside its own declared outputs vanished without a
    trace.** A worker changed a file that was in its context but not its
    outputs, said so plainly in its own result, and `integrate` wrote every
    declared output and said nothing about the rest — part of a fix was
    silently lost, discoverable only by re-reading the worker's notes by
    hand. Rule: a path outside a job's declared outputs is never applied, so
    say so loudly the moment it is known, from either the worker's own
    account or the actual copy it worked in. Enforcement: `inspect`/
    `integrate` warn `dropped write: <path> (not in outputs)` for every path
    a job's own result names under `changed`, and — for a non-codex job,
    whose workspace is a plain copy — for any file that copy shows was
    actually modified or newly created outside that job's outputs; the
    worker preamble states plainly that edits outside outputs are discarded.
    Documentation: [verification](verification.md#dropped-writes).
38. **A bad output was only ever discovered after `integrate` had already
    read it.** Knowing where a job's own output actually landed, and whether
    a `.json` one even parsed, meant opening the run's workspace by hand;
    the first real signal came only once `integrate` (or a post-build
    mutants read) tried to use it. Rule: show where each declared output
    sits, and whether it parses, at the moment of inspection — before
    integration ever depends on it. Enforcement: `inspect --results` lists,
    per job output, its workspace copy's absolute path and, for a `.json`
    output, whether it currently parses. Documentation:
    [verification](verification.md#outputs-before-integrate).
39. **The same directory-drift gap had two different warnings, and the
    general one still missed a real case.** A contextGlob-specific warning
    was added in the runner itself because the module that owned the
    general context-drift check was out of scope for that job; once back in
    scope, the general check turned out to still miss a job's own context
    naming just one or two files of an obviously numbered series (e.g.
    `activity-3.png`) from a directory holding several more of that same
    prefix, because it only ever grouped by directory and extension and
    required at least 3 already-listed files before saying anything. Rule: a
    declared prefix, or even a single context file that is plainly one of a
    numbered series, is already strong evidence of a series — no arbitrary
    floor should suppress it — and one drift check should own the whole
    story instead of two overlapping ones. Enforcement:
    `contextDirectoryWarnings` now also groups by an inferred numbered-stem
    prefix (or a declared `contextGlob` prefix) with no minimum-file floor,
    alongside its original plain-extension grouping (still 3+ files, to
    avoid noise on ordinary source directories); both report the single
    `context-directory-drift` code, and the runner's separate
    contextGlob-only warning was removed. Documentation: [manifest
    reference](manifest-reference.md#context-check).
40. **File-tools-only workers reported done with tests they never ran.** A
    worker that can only read and edit files writes tests, then reports
    them passing, although nothing in its seat can execute them; the first
    real run of those tests happens only at integration. Rule: a worker
    asked to add or change tested code needs a way to run the checks
    itself, inside a sandbox, and must report which checks it ran.
    Enforcement: claude `shell: true` jobs (presets `sonnet-shell`,
    `opus-shell`) run the whole worker under a generated seatbelt profile
    with a sandboxed shell and report `checksRun`; `validate` warns
    `tests-without-shell` when a claude job without a shell writes tests.
    Documentation: [manifest reference](manifest-reference.md#shell-jobs).
41. **Two concurrent checks shared a fixed dev-server port.** Checks in two
    different worktrees each started a dev server on the same fixed port at
    the same time; one side failed on "port in use" and the failure looked
    like a real test failure. Rule: give each worktree its own stable block
    of ports, derived from its own path, and tell every process that runs
    there. Enforcement: env var `SWARM_PORT_BASE` is set for a run's
    `preChecks`/`checks`/mutant checks, a shipped run's re-run of checks, and
    every codex or claude shell-job process (whose prompt also states its
    port range); a manifest `testEnv` may not set it itself; `integrate` and
    `ship` report the resolved block and warn when it had to move or every
    candidate block was busy. Documentation: [manifest
    reference](manifest-reference.md#ports).
42. **A sandboxed shell job could not run its own project's checks.** Its
    toolchain sync needed network the sandbox never grants, and even after a
    sync ran outside the sandbox, the sandboxed worker still failed to find
    its own workspace root or the venv that sync had just produced, both
    hidden from it by default. Rule: run a toolchain sync once, outside the
    sandbox, before the worker starts, and grant the narrow extra reads that
    a synced toolchain actually needs to find itself. Enforcement: a job field
    runs setup commands outside the sandbox in the job's own worktree before
    the worker starts, failing the job outright on a non-zero exit instead of
    starting the worker; the sandbox profile separately grants ancestor
    workspace-discovery reads and, after setup, a synced interpreter's own
    directory when it lives under the coordinator's home. Documentation:
    [manifest reference](manifest-reference.md#setup).
43. **A sandboxed shell job still could not run its own project's tests.** Even
    after its toolchain sync and workspace-discovery reads worked, a real run
    hit two more walls: some tools' own upward git discovery reads the
    project root's `.git` entry directly, not just the job's own detached
    worktree's local one, and every test that opens a loopback server found
    the network entirely closed. Rule: grant read-only access to the
    project root's own `.git` (its gitdir and common dir too, when the root
    is itself a linked worktree), and allow the job's own loopback sockets —
    but never one a service on the host already had listening when the job
    started. Enforcement: the sandbox profile grants the root's `.git`
    read-only and allows `localhost:*` bind/inbound/outbound, with an
    explicit deny (placed after that allow) for every port an `lsof` scan
    found already listening, plus a fixed rig-service port; an `lsof`
    failure refuses the job outright instead of guessing. Documentation:
    [manifest reference](manifest-reference.md#shell-jobs).
44. **A tool temp dir inside a repo trips repo-safety rules.** A sandboxed
    job's own temp directory sat inside the project's own git worktree, and a
    tool it ran refused to write scratch data there, correctly treating it as
    version-controlled storage. Rule: a job's scratch/temp directory must
    live outside every git repo, never as a path under one the job itself is
    working in. Enforcement: a claude shell job's `HOME`/`TMPDIR` point at a
    per-job scratch dir created under the OS temp dir, refusing the job
    outright if that OS temp dir itself resolves inside a repo. Documentation:
    [manifest reference](manifest-reference.md#shell-jobs).
45. **Toolchains under the OS temp dir get purged.** A toolchain cache placed
    under the OS temp directory worked at first, then silently broke once the
    OS reclaimed unread files there after a few days. Rule: point toolchains
    at a stable, non-temp directory, and flag it plainly whenever one still
    resolves under the temp dir. Enforcement: a reusable report names the
    expected toolchains directory, whether it exists, and every configured
    path that still resolves under the temp dir; both diagnostics and
    onboarding surface it as advice, never a status change. Documentation:
    [manifest reference](manifest-reference.md#kickoff-diagnostics-and-install-commands).
46. **A worker's final JSON extraction returned one nested element, not the
    whole result.** A final message held prose plus a fenced object whose own
    value included an array of similarly-shaped objects; naive per-line
    parsing matched one of those inner objects before it ever reached the
    real top-level result, so the report looked complete but carried the
    wrong (and mostly null) fields. Rule: extraction must find the last
    *balanced top-level* object, string-aware so a brace inside a string
    value never counts, not merely the last line or fenced block that happens
    to parse. Enforcement: the same brace-depth scan prefers the last fenced
    block when one exists and never returns a span that only opened at a
    nested depth. Regression coverage is in `tests/final-json.test.mjs`.
47. **A version-only dependency bump left checks running against a stale
    environment.** A lockfile-only resync trigger missed a manifest file
    (`pyproject.toml`/`package.json`/`Cargo.toml`) bumped without its
    lockfile moving, so the installed environment silently disagreed with
    the code. Rule: any dependency/version file counts as a resync trigger,
    not only its lockfile. Enforcement: the env-resync trigger now also
    fires on these three files, and `validate` warns `stale-env-risk` when
    a job outputs one with no `preChecks` declared to resync it.
    Regression coverage is in `tests/lessons120-checks.test.mjs`.
48. **A check that never started looked like a check that failed.** A
    missing tool or module produced the same generic status as a real
    assertion failure, so a red run could not be told apart from an
    environment that was never even ready to run it. Rule: a check that
    could not start is distinct from one that ran and lost, and deserves
    one resync-and-retry before being reported red. Enforcement: `spawn-error`
    (could not spawn at all) and `unrunnable` (started but its own tool or
    module was missing) are now their own statuses, each triggering one
    automatic `preChecks` run plus a single retry; `integrate` gains
    `checksErrored` and the CLI exits non-zero on it regardless of
    `--require-checks`. Regression coverage is in
    `tests/lessons120-checks.test.mjs`.
49. **A test timeout under 5 seconds was a timing assertion in disguise.**
    A short hang-guard passed reliably on a fast runner and flaked on a
    slow one, discovered only after it went red in CI. Rule: a test
    timeout is a hang guard, never a timing assertion, and belongs at 5
    seconds or more. Enforcement: `validate` warns `tight-test-timeout`
    when an added test line contains a timeout literal under that floor.
    Regression coverage is in `tests/lessons120-checks.test.mjs`.
50. **A flaky-test fix went to a worker that could never reproduce it.** A
    job whose own acceptance check loops or repeats, or whose prompt names
    a flake or race, produced only a guess when handed to a worker with no
    shell to run that check itself. Rule: a job whose done-when is
    "reproduce, then prove N green" needs a shell-capable worker, not a
    guess. Enforcement: `runtime-check-no-shell` now also fires when a
    check's own argv contains a repeat construct or the prompt names a
    flake/race/intermittent bug, exempting a job whose outputs are all
    docs. Regression coverage is in `tests/lessons120-checks.test.mjs`.
51. **Background research and long check runs were miscounted as idle
    time.** A single-question run and a scout wrote no record a
    session-metrics reader could find, and a long checks/mutants run
    inside integration looked identical to silence. Rule: measure what
    actually runs, not just what writes to the run registry the reader
    already knew about. Enforcement: a small state.json-compatible
    `{startedAt, finishedAt, costUsd}` record is now written for a
    single-question run, a scout, and integrate's own checks/mutants
    windows. Regression coverage is in `tests/lessons120-checks.test.mjs`.
52. **A check's interpreter was discovered missing only once integration
    ran it for real.** A manifest check named `python3 -m X`, and the
    system `python3` on the machine that later ran it had no such module,
    so a job that was otherwise fine came back red. Rule: a check's
    interpreter or module is confirmed present before the job that needs
    it ever starts. Enforcement: `validate`/`preflight` probe each check's
    resolved interpreter (or import the named module, for a `python -m X`
    form) once and refuse a manifest naming one that can't be found.
    Regression coverage is in `tests/lessons120-context.test.mjs`.
53. **A side file, and a new registry entry, both escaped their guard
    tests.** A second file of the same kind as an existing, guarded one
    (in the same directory) was missed by a whole-file/glob guard that
    only matched literal names, and a new entry added to a directory a
    test enumerated by listing/globbing broke that test without ever
    being in the job's own context or outputs. Rule: a directory- or
    glob-level guard covers every same-kind file in it, and a job that
    adds to a registry a test enumerates owns that test too. Enforcement:
    a whole-file/glob guard test now counts as covering a new same-kind
    output in the same directory, and `validate` warns
    `registry-pinning-tests` when a job's new file lands in a directory an
    existing test enumerates outside that job's own context, outputs, or
    `ignoreTests`. Regression coverage is in
    `tests/lessons120-context.test.mjs`.
54. **An env var exported to checks leaked into an independent project test.**
    A release added `SWARM_PORT_BASE` to the environment of every check, and a
    project's own test suite that unstubbed/restored environment variables saw
    the swarm's value leak through and change the test's behavior unexpectedly.
    Rule: a release that adds environment variables to check processes lists
    them clearly, and test code that exercises env isolation must explicitly
    unset or stub them. Enforcement: `integrate`/`ship` scan every project test
    file that was integrated for references to names of swarm-exported env vars
    (`SWARM_PORT_BASE`, …); a match prints `swarm-env-in-tests: <file>: references
    <name>; stub or unset it in this test`. The changelog lists all exported
    env vars under a dedicated line. Regression coverage is in
    `tests/lessons120-ship.test.mjs`.
55. **A shell job's new declared output triggered a spurious dropped-write
    warning.** A shell worker created a file declared in the job's own outputs,
    but the completion logic warned it as a dropped write before integration
    even saw the run. The warning's path-matching logic differed from
    integration's own normalization, so files that would integrate just fine
    were flagged as skipped. Rule: a warning that claims data was lost must
    match integration's own decision; shell-job and copy-job completion use
    identical path logic for output matching. Enforcement: shell-job completion
    normalizes and matches new files against the outputs list the same way
    `integrate` does, so a declared output is never warned as dropped; the
    warning only fires when `integrate` would actually skip the file.
    Additionally, swarm's own tests that spawn the sandbox no longer run when
    already inside a sandbox; they skip with a named reason set via
    `SWARM_IN_SANDBOX=1`, avoiding spurious nested-sandbox denials. Regression
    coverage is in `tests/lessons120-mutants.test.mjs`.
56. **Mutation checks ran against a red base and reported false coverage.**
    A manifest check failed, but mutation checks still applied every mutant
    and reported each one killed — a result that looked like passing coverage
    but proved nothing, since a red base kills every mutant regardless of the
    guard being tested. Rule: mutants only count against a base that is
    actually green. Enforcement: `integrate --mutants` refuses to start unless
    the unmutated tree passes all checks first; any non-test-failure exit
    (spawn error, usage error) is classified as `invalid`, never `killed`;
    `ship --require-section "Mutation check"` refuses outright when an
    integrated run's mutants came from a red base. Regression coverage is in
    `tests/lessons120-mutants.test.mjs`.
57. **A blocked job's useful outputs were lost because they could not be
    integrated.** A job returned `blocked` but its declared outputs were still
    usable; they were abandoned entirely because the integration path had no
    way to accept them. Rule: a blocked job's declared outputs are still
    integrated, with the same conflict and snapshot checks, instead of being
    discarded. Enforcement: `integrate --accept-blocked` integrates a blocked
    job's outputs and records `integrationStatus: 'integrated-blocked'`,
    carrying the blocked reason into the next job's evidence so a follow-up
    can understand what happened. Regression coverage is in
    `tests/lessons120-mutants.test.mjs`.
58. **A hash-shaped string in output was never flagged as possibly invented.**
    A job's output contained a 40- or 64-character hexadecimal string that
    appeared nowhere verbatim in the job's own context files, suspiciously
    hash-shaped but never noticed to be unexplained. Rule: an unexplained
    40/64-hex string in an output is flagged as possibly invented. Enforcement:
    `inspect`/`integrate` warn `invented-hash` when an output diff adds a
    40-hex or 64-hex string not present verbatim in the job's own context
    files. Regression coverage is in `tests/lessons120-mutants.test.mjs`.
59. **A cancelled check process left its children running.** A `cancel`
    command during an in-flight check killed the main process but left child
    processes orphaned, consuming resources and holding ports. Rule: an
    in-flight check is killed as a process group, not left running after a
    run is cancelled. Enforcement: `runCheck` spawns the check as a process
    group (not a bare child), and `cancel` kills the whole group, ensuring no
    child process survives after cancellation. Regression coverage is in
    `tests/lessons120-mutants.test.mjs`.
60. **Force-pushing an amended PR branch overwrote another contributor's
    work.** A run amended its PR branch and pushed it, but another contributor
    had moved the remote head between the run's start and landing, so a
    force-push silently overwrote their work undetected. Rule: ship uses a
    lease-push for its own amended PR branch when the remote head is not an
    ancestor, and refuses outright when someone else moved it. Enforcement:
    `ship` pushes with `--force-with-lease=<branch>:<last-known-remote-sha>`
    when the PR author is the coordinator's own bot identity and the remote
    head is not an ancestor; it refuses (not lease-forces) when someone else
    moved the head. Regression coverage is in `tests/lessons120-ship.test.mjs`.
61. **A platform-only CI failure hid which OS actually failed.** A rollup of
    CI results across multiple OS/job matrix entries showed a failure without
    saying which platform was red, so the cause had to be rediscovered by
    hand instead of being named in the run report. Rule: name the platform
    when a CI failure is red on only some OS/job matrix entries, not all.
    Enforcement: `ship` prints `platform-only failure: <os>` with the failing
    test ids when a CI failure lands on only a subset of the OS/job matrix.
    Regression coverage is in `tests/lessons120-ship.test.mjs`.
62. **A test that shells out to a host binary was never checked before
    ship.** A test file called an undocumented host system binary outside the
    shipped code's own control, and ship did not catch it before integration,
    so the test could fail mysteriously in CI even though it passed locally.
    Rule: a test that shells out to a host binary needs a fake, a skip seam,
    or a documented allowlist; ship checks this before pushing. Enforcement:
    `ship` refuses when a test file spawns a binary outside the allowlist
    (defined in the project's own `check:ci-like` script) with no fake or skip
    seam, and runs the check under a stripped environment to match CI
    conditions exactly. Regression coverage is in `tests/lessons120-ship.test.mjs`.
63. **A shell job could not start its own test interpreter.** A mid-tier
    shell job's venv pointed at a managed Python under the home directory,
    reached through symlinks; the sandbox hid it, so the worker fell back to
    an old system Python and reported its checks as not run. Rule: a shell
    job's first check must be able to start before the worker spends a
    token. Enforcement: the parent follows `.venv/bin/python` symlink by
    symlink to its realpath and grants every install dir under `$HOME`, plus
    the swarm toolchains dir and uv's managed-Python dir (and points
    `UV_PYTHON_INSTALL_DIR` at it); a python link that resolves nowhere
    refuses the job, and the first manifest check is smoke-started once
    inside the profile, refusing `sandbox-cannot-run-check: <argv0>` when it
    cannot start. Regression coverage is in
    `tests/field-lessons-batch-e.test.mjs`.
64. **A packaging change passed every check and still broke the package.**
    A mid-tier job ($4.77) added a build-backend include rule for data
    that was already packaged; tests, lint and types all passed, but the
    wheel build failed on a duplicate archive path, caught only by a hand
    build. Rule: a job that touches packaging config gets a check that builds
    the package. Enforcement: `validate` warns
    `packaging-change-without-build-check` for a packaging-file output with
    no build check; `integrate` warns and `ship` refuses when the change
    touches packaging keys and no check builds the package. Regression
    coverage is in `tests/field-lessons-batch-e.test.mjs`.
65. **Every worker's first harness run failed on a missing env var.** Three
    expensive-tier outside workers each hit "set the browsers path" on their
    first harness run; the coordinator had to send the toolchain env to each
    one mid-run, because it lived only in task prose. Rule: every check, and
    every prompt that runs one, carries the toolchain env. Enforcement: a
    per-root `.swarm/env.json` is applied to every setup, worker, check,
    redcheck and mutant check; `validate` warns `check-needs-env` for a
    toolchain check with no env file; `env --print` prints a paste-ready
    block for outside agents' prompts. Regression coverage is in
    `tests/field-lessons-batch-e.test.mjs`.
66. **Two of fifteen mutants had a find string that was not in the file.**
    A cheap-tier job wrote mutants from diffs; two multi-line `find` blocks
    carried the wrong indentation and matched nothing, caught only because
    the coordinator counted each by hand. Rule: count every mutant's find in
    its target before a mutants run. Enforcement: `mutants` and
    `integrate --mutants` refuse the whole run before any check or write,
    listing each `invalid-find` / `ambiguous-find` / `no-op` mutant;
    `mutants --dry-run` does only that. Regression coverage is in
    `tests/field-lessons-batch-e.test.mjs`.
67. **Layout mutants survived unit tests that never read layout.** Nine of
    thirty style mutants survived the unit-test check; rerunning just those
    against the screenshot harness for the affected views killed three more,
    through a hand-written wrapper per worktree. Rule: a layout mutant runs
    against the harness view that shows it. Enforcement: a mutant may carry
    its own `check` argv, overriding the shared mutant check for that mutant;
    each distinct check must pass unmutated first, and the report names which
    check ran. Regression coverage is in `tests/field-lessons-batch-e.test.mjs`.
68. **A worker ran a bare git stash in a shared worktree.** An outside UI
    worker ran `git stash` / `git stash pop` in a worktree whose stash stack
    is shared with every other worktree and session; the stack happened to
    be empty, so nothing was lost. Rule: workers never use `git stash`; they
    use a temporary WIP commit. Enforcement: shell and codex prompts and the
    `env --print` block carry the rule, and a shell worker's `git` is a
    wrapper that refuses `stash` with a plain message. Regression coverage is
    in `tests/field-lessons-batch-e.test.mjs`.
69. **A branch built outside the swarm could not be shipped by it.** One
    slice was built by an outside worker in its own worktree, so that root
    had no swarm run and `ship` refused without a run id; the coordinator
    fell back to a hand push and PR, and the merge waited for a later turn.
    Rule: any finished branch is shippable, whoever built it. Enforcement:
    `ship --branch <b>` (no run id) runs the given `--check` argvs, fills the
    checks placeholder, and applies the same hold, required-section, lock,
    test-binary and packaging rules before push, PR, CI wait and merge.
    Regression coverage is in `tests/field-lessons-batch-e.test.mjs`.
70. **Two parallel branches' outputs collided on one shared file.** Two open
    branches, being built in parallel worktrees of the same repository, each
    listed one shared registry file among their outputs; when the two came
    together, a hand union-merge of their two independent versions of that
    file broke its own syntax. Rule: a coordinator should see a shared output
    file before it happens, not after, and never as a hard block, since a
    genuinely shared file (a registry, an index) is sometimes integrated one
    branch at a time on purpose. Enforcement: `validate` warns
    `shared-output-across-open-jobs` when the manifest being validated
    declares an output file that an already-open run elsewhere in the same
    repository also lists, naming the other run and suggesting a per-job
    fragment file, combined in a later step, instead. Regression coverage is
    in `tests/field-lessons-batch-f.test.mjs`.
71. **A ship check was unreachable from the real ship path.** The pre-push
    lockfile check ran only when shipping a branch built outside the swarm;
    shipping a run never handed the run's integrated files to it, so for
    runs the check silently never ran. Found in review before it hid a real
    failure. Rule: every check a command claims must be reachable from its
    real entry point, and tested through that entry point. Enforcement:
    shipping a run now passes its integrated files through to the shared
    ship logic, so a stale lockfile refuses the push; the regression test
    goes through the CLI entry, not the inner function. Regression coverage
    is in `tests/field-lessons-batch-f.test.mjs`.
72. **A known platform quirk cost a CI round.** A Windows-only quirk (it
    refuses private files placed directly under the test runner's raw temp
    directory) was known but lived only in the coordinator's memory, not in
    any job prompt. A new job hit it again: one CI round (about 6 minutes)
    plus one fix job. Rule: known platform gotchas travel with every build
    job in that repository. Enforcement: a per-root `.swarm/gotchas.md` (a
    linked worktree falls back to its main worktree's file, like the
    toolchain env file) is appended to every claude, codex and shell job
    prompt and to `env --print`; `validate` warns `windows-ci-no-gotchas`
    when the repository's CI runs on Windows and no gotchas file exists.
    Regression coverage is in `tests/field-lessons-batch-f.test.mjs`.
73. **A prompt-level ban was not enough outside the sandbox.** An agent
    working in a shared worktree, told plainly not to, ran the stash command
    anyway. A prior fix had already given sandboxed shell workers a wrapper
    that refuses the command outright, but that protection never reached an
    agent working outside that sandbox. Rule: a rule this costly to break
    should be enforced everywhere it can be, not only where the harness
    happens to control the tool. Enforcement: the same refusal is now
    materialized into a stable, per-project location and handed to any
    outside agent as a `PATH` entry it can paste in, ahead of the real
    version of the tool, so pasting the block gets the refusal even outside
    a sandbox. Regression coverage is in `tests/field-lessons-batch-f.test.mjs`.
74. **A path flag was read against the target directory, not the one it was
    typed from.** A research run named its input file the way it was typed,
    sitting in one directory while pointed at another; the file was read only
    against the pointed-at directory, so a plainly-relative path failed "not
    found" even though it existed exactly where it was typed. Cost one
    re-run (seconds). Rule: a path flag resolves the way the user typed it —
    tried against the directory they were sitting in before the one the
    command was pointed at. Enforcement: every such flag is now tried against
    the current directory first, then against the pointed-at one; a truly
    missing file names every path actually tried. Regression coverage is in
    `tests/field-lessons-batch-g.test.mjs`.
75. **A worker hand-reverted a mutant and wiped its own unrelated edit to the
    same file.** A mid-tier worker, undoing a mutant by hand, ran a plain
    revert command on the mutated file and lost uncommitted work of its own
    sitting in that same file; recovery needed a full re-run of the check
    suite and every mutant to confirm nothing else had been lost. Rule:
    workers never hand-revert a mutant; the tool that applies one also
    restores it. Enforcement: the guard that already refused a shared-stack
    stash command now also refuses a plain revert of any path that still has
    uncommitted changes, naming the fix in its own refusal message; job
    instructions for any worker with shell access now say to run mutants only
    through the tool, never by hand. Regression coverage is in
    `tests/field-lessons-batch-g.test.mjs`.
76. **One mutants shape was expected, but a worker wrote a different one.** A
    worker's own mutants file used a different key for a mutant's name than
    the one the mutation tool reads, so the difference had to be converted by
    hand before the tool would accept the file. Rule: state the one true
    shape everywhere a worker can read it, and let the tool bridge the common
    near-miss instead of failing outright. Enforcement: the mutation tool now
    accepts the old key as an alias for the new one (renamed, with a
    warning), and the paste-ready environment block states the exact shape
    alongside every other rule a worker needs. Regression coverage is in
    `tests/field-lessons-batch-g.test.mjs`.
77. **A check that could not even start reported no reason at all.** A
    pre-push lock check spawned a toolchain binary that was not on a bare
    system path (it lived only in a dedicated toolchains directory); the
    check refused with a blank reason, costing one re-attempt (about three
    minutes) before the real cause was found. Rule: a check that cannot start
    says so, naming the command it tried. Enforcement: that toolchain binary
    is now resolved the same way every other one is (a dedicated toolchains
    directory, then the system path) before it is ever spawned; when it
    cannot be found, the check refuses at once, naming every path it tried.
    Regression coverage is in `tests/field-lessons-batch-g.test.mjs`.

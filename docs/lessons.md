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

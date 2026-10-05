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
78. **A required section was refused for carrying extra words in its own
    heading.** A gate that required a named section refused a real section
    whose heading added a short parenthetical after the required name, even
    though the section itself was present and filled in. Rule: match a
    required heading by its name plus a following word boundary (end of
    line, a space, or an opening parenthesis), not by an exact match, so a
    heading that only shares a name's first word without a boundary still
    correctly fails to match. Enforcement: the section-matching rule was
    changed from an exact heading match to this boundary-prefix match, and a
    refusal for a section that is genuinely absent now also names the
    heading in the body that came closest to matching, to save a guess.
    Regression coverage is in `tests/field-lessons-batch-h.test.mjs`.
79. **A missing toolchain gave a check failure with no program or path
    named.** A local check step spawned a bare tool name from a shell whose
    session did not have the dedicated toolchains directory on its path,
    and every such check failed with a bare, generic status and no
    indication of what was missing or where it looked. Rule: reuse the one
    resolver that already checks a dedicated toolchains directory before the
    system path for any check's own command, not only the one binary that
    previously had this treatment, and name every location tried when
    nothing is found. Enforcement: local check execution resolves a bare
    command through that shared resolver before ever spawning it; one that
    cannot be resolved anywhere refuses only that check, naming the command
    and every path tried, instead of a bare, uninformative failure.
    Regression coverage is in `tests/field-lessons-batch-h.test.mjs`.
80. **A read-only research worker's own "it's missing" claim was taken as
    fact.** A read-only worker, given a fixed set of context files, reported
    that a piece of behavior was dropped — an allowlist omitted it, a
    callback was never invoked — when the truth lay entirely in a file
    outside that fixed context; the claim read as a finding, not a guess
    bounded by what the worker was shown. A follow-up job spent on the order
    of 100k tokens proving there was no bug before the mistake was caught.
    Rule: a worker reading only a fixed context list cannot tell a genuine
    absence from a file it was never given, so any claim of one must say so
    and name what it searched. Enforcement: the worker's own prompt now
    states that a claim of something missing, never called, omitted, or
    absent must carry a basis marker naming the claim as context-only, plus
    what was searched; the result also carries back the exact context list
    the worker was given, and gains a warning naming the result "limited by
    context" whenever the worker's own answer text contains an absence claim
    (a simple, case-insensitive, whole-word scan for a handful of such
    words), independent of whether the worker itself added the basis marker.
    Regression coverage is in `tests/field-lessons-batch-i.test.mjs`.
81. **A hand-typed check list drifted from what CI actually ran.** A format
    check CI never ran failed on a batch of already-unformatted files, and
    ship's own hand-typed checks had already passed, so the drift was found
    only once CI itself ran — costing one wasted re-ship. Rule: a hand-typed
    check list is a guess at what CI runs, and guesses drift; a check that
    already fails on the commit being shipped from proves nothing about what
    the change itself broke. Enforcement: ship can now read a CI workflow's
    own run steps directly and use them as its own checks, and warns when a
    hand-typed check's program and subcommand are not among them; separately,
    any check that fails is re-run once against the base commit's own tree (a
    throwaway checkout, always cleaned up) and reported pre-existing — still
    listed, no longer blocking — when it fails there too. Regression coverage
    is in `tests/field-lessons-batch-j.test.mjs`.
82. **Ship stopped on a red CI run whose failing tests the change never
    touched.** A platform-specific, timing-sensitive test suite failed on a
    run that otherwise had nothing to do with the change being shipped, and a
    manual rerun of the same run passed immediately — the wait and the manual
    step were both wasted. Rule: a failing test the change did not touch is
    worth one automatic rerun before it blocks a ship; a failing test the
    change did touch is treated as a real regression and must never be rerun
    away. Enforcement: ship can now rerun a CI run's own failed jobs, up to a
    given number of attempts, but only when none of the tests they failed on
    appear among the files the change itself touched; it reports how many
    attempts it took and whether the rerun passed. Regression coverage is in
    `tests/field-lessons-batch-j.test.mjs`.
83. **A diff guard refused a branch over a call already on its base.** A
    static gate over a changed test file's spawned binaries refused a branch
    for a call that was already present on the base commit, untouched by that
    branch's own diff, and unrelated to what the branch actually did. Rule: a
    guard over what a change touches must judge only the lines that change
    itself adds, never a whole file's current content, or it blames a branch
    for something it did not do. Enforcement: the guard now reads only the
    lines a diff adds to each changed test file before scanning them; one
    documented binary was added to the allowlist (with a platform note, since
    "documented" here means one platform, not every platform); and a
    repeatable, owner-decision exemption flag can excuse one file from one
    named guard, with a required reason, logged and always visible in the
    resulting PR body — never silently applied, never applied to a file or
    guard it wasn't given for. Regression coverage is in
    `tests/field-lessons-batch-k.test.mjs`.
84. **A resolver picked a directory because it passed the same check a file
    would.** A path resolver for a named binary considered a candidate found
    as soon as one existence-and-permission check passed, and a directory
    that happened to share the binary's name passed that same check — so the
    resolver returned a directory, and every attempt to run "it" then failed
    before it ever started, with no message worth reading. Rule: a resolver
    picking a program to run must confirm it is actually a regular,
    executable file, not merely a path that exists and carries an execute
    bit — directories carry that bit too. A step that fails to even start a
    program must never report an empty reason; it must name what could not be
    started and why. Enforcement: the resolver now also requires the
    candidate to stat as a regular file before it counts, and the launcher
    that spawns a resolved path now distinguishes "never started" from "ran
    and exited non-zero," naming the failure either way. Regression coverage
    is in `tests/field-lessons-batch-k.test.mjs`.
85. **A lock check ran without the lockfile it needed.** A changed dependency
    manifest triggered a strict install check in a project that had no
    lockfile, so the check refused before shipping could proceed. Rule:
    commit a lockfile for every Node project; a missing lockfile must name
    the manifest in a warning and explicitly say the lock check did not run.
    Enforcement: ship warns when the manifest exists without its lockfile;
    when the lockfile exists, the strict install check still runs and a
    stale or inconsistent lockfile still refuses before push. Regression
    coverage includes a real local dependency mismatch in
    `tests/field-lesson183.test.mjs`.
86. **A research worker was given web tools and told not to use them.** A
    research job offered the web search and fetch tools, but the fixed
    worker message still banned network tools, so the worker obeyed the
    message and returned an empty report while the run reported success.
    Rule: the worker message must match the tools a job is actually given.
    Enforcement: web-enabled jobs get a message that allows read-only web
    research and treats pages as untrusted data; every other job's message
    is unchanged. Regression coverage is in `tests/field-lesson188.test.mjs`.
87. **A scratch file committed into a release surfaced only a branch
    later.** A short-lived scratch document, never meant to be tracked, rode
    into a commit and was noticed only once a later, stacked branch showed
    it as modified. Rule: a change that adds a scratch-shaped file never
    enters a commit unmerged. Enforcement: pushing a reviewed change now
    refuses when its diff adds a file matching a small set of known scratch
    patterns, naming the offending path, unless an explicit, reasoned
    exemption names that exact file. Regression coverage is in
    `tests/ship-125.test.mjs`.
88. **A failing check that was new to the change was excused as
    pre-existing, and merged.** A guard meant to tell a flake apart from a
    real regression compared only exit codes, not which test actually
    failed, so two tests that existed only in the change being shipped were
    waved through as if they already failed before it; the same failure
    also happened only because a resolved tool directory was missing from
    the check's own environment. Rule: a failing test is pre-existing only
    when that same test, by id, already failed on the unchanged base; a
    test absent from the base is never pre-existing, and a check's own
    resolved toolchain must reach every process it spawns. Enforcement:
    every failing check now records a per-test status of fail, pass, absent
    or unknown against a base run, and only a genuine base failure is
    treated as pre-existing; every spawned check inherits the same resolved
    toolchain location. Regression coverage is in `tests/ship-125.test.mjs`
    and `tests/wire-125.test.mjs`.
89. **A test suite wrote real fixture rows into a live audit log.** Running
    the test suite left fixture organization names and fixture reasons
    sitting in the genuine, on-disk audit log a real release would read.
    Rule: tests never write under the real install location. Enforcement:
    the audit log's own path is now overridable by an environment variable
    that every test sets to a temporary directory, with a test asserting
    the real log stays untouched after the suite runs. Regression coverage
    is in `tests/ship-125.test.mjs`.
90. **A release step had no `--help`, and an externally built run's own
    identity was unrecoverable.** A release command failed outright on
    `--help`, and, separately, a run built outside the normal flow left no
    way to name which run had produced a given branch, costing a manual
    source read to piece it back together. Rule: every command answers
    `--help`, and every result names the run (or the branch) that produced
    it. Enforcement: `--help`/`-h` now prints usage and exits cleanly before
    any other flag is parsed, and every release result carries its own run
    or branch identifier. Regression coverage is in `tests/ship-125.test.mjs`
    and `tests/wire-125.test.mjs`.
91. **A read-only research job's reply could not be trusted to hold JSON at
    all.** A research call to a plain API model expected a final line of
    JSON, but the model's real reply was ordinary prose, so the exchange
    returned only a hard parse error instead of anything usable. Rule: a
    read-only reply that fails to parse as the requested JSON still returns
    a usable answer, marked as such, rather than nothing at all.
    Enforcement: when no parsable JSON line is found, the reply now falls
    back to the model's own summary text with an explicit "not parsed as
    JSON" flag alongside it. Regression coverage is in
    `tests/ask-125.test.mjs`.
92. **Two runs started in the same instant were given the same id.** Two
    background jobs launched within the same millisecond generated
    identical run identifiers, so the second one collided with the first
    and died before it ever started; a cancelled job also reported no idea
    what it had already spent. Rule: a run id is unique across processes,
    not merely across milliseconds, and a cancelled job still reports
    whatever it is known to have spent. Enforcement: run ids now add a
    short random suffix and retry once on a genuine collision; a cancelled
    job reports its last known cost, or an explicit "unknown" flag with the
    amount it had reserved when no cost was ever observed. Regression
    coverage is in `tests/scout-125.test.mjs` and `tests/ask-125.test.mjs`.
93. **A research gate rejected results a brief had explicitly allowed.** A
    license check used only its own fixed, hard-coded allowlist, so
    worker-verified results the requesting brief explicitly permitted were
    moved to rejected anyway, and had to be re-admitted by hand. Rule: a
    gate driven by policy reads that policy from the request that actually
    made it, not only from a list baked into the tool. Enforcement: the
    gate now reads an explicit allowed-licenses line from the brief itself
    when present, falling back to the fixed list only when the brief names
    none. Regression coverage is in `tests/scout-125.test.mjs`.
94. **A gate that moved a result also quietly dropped what was known about
    it.** A licensing gate relocated a result to a rejected list but kept
    only its name and link, discarding every other fact — license
    evidence, version pin, compatible ranges — that had already been
    verified about it. Rule: a gate may move a result, but it must never
    drop the facts already gathered about it. Enforcement: a rejected
    result now keeps every field the original result carried, plus which
    gate moved it and why. Regression coverage is in
    `tests/wire-125.test.mjs`.
95. **A worker's required inputs sat untracked next to files it was actually
    given, and there was no way to say a job could delete something.** A
    job's own directory held extra, untracked files the job needed but was
    never handed, and separately, a worker whose task genuinely required
    removing a file had no way to say so, since the standard instruction
    flatly forbade deletion. Rule: a directory that holds untracked
    siblings to what a job was given is worth flagging, and a job that must
    delete something says exactly what, in the open. Enforcement:
    validation now warns when a context file's own directory holds
    untracked files never named to the job, and a job can now declare
    exactly which paths it may remove; only a path declared this way is
    ever actually deleted, and removing anything else is refused by name.
    Regression coverage is in `tests/wire-125.test.mjs`.
96. **The same timing-sensitive tests flaked only under real parallel
    load.** Two tests that waited on fixed, wall-clock sleeps passed alone
    but intermittently failed when several processes ran the same suite at
    once, making a real regression indistinguishable from ordinary system
    noise. Rule: a timing-sensitive test waits on the actual event it
    needs, never on a fixed sleep. Enforcement: both tests were rewritten to
    wait on their own completion signal instead of a clock, and now pass
    reliably under repeated parallel runs. Regression coverage is in
    `tests/swarm.test.mjs`, `tests/cli-adapters.test.mjs`, and
    `tests/lessons120-mutants.test.mjs`.
97. **A stale internal version pin was found three times before anyone
    built a check for it.** The same kind of mistake — a library pinning an
    internal dependency to one exact version instead of a range, or an
    exact pin left behind after a vendored copy moved on — recurred across
    unrelated projects, discovered only once each at a fresh, offline
    install. Rule: check what a project actually ships against what it
    actually pins, before a stale pin ever reaches an offline install.
    Enforcement: a new check reads each project's own dependency
    declaration, lock information, and vendored copies, and reports every
    exact-pin mismatch it finds, exiting non-zero on any finding.
    Regression coverage is in `tests/check-pins.test.mjs`.
98. **A name that must never appear in a public repo had no automated guard
    against it.** A term internal reviewers all knew to keep out of a public
    project's history relied entirely on every contributor remembering not
    to type it, with nothing to catch a slip before it was pushed. Rule: a
    name that must never reach a public diff is checked by a tool, not by
    memory alone. Enforcement: shipping now reads an optional list of such
    terms and refuses, before pushing, when any line the diff actually adds
    contains one — naming the file and line, never the text itself — but
    only against a repo actually reported public; a private or internal
    repo, or a project with no such list, ships as before (the result
    records that no list was found; it is not a warning). Regression coverage is in
    `tests/private-names-125.test.mjs`.
99. **A dependency probe refused a check whose own interpreter actually
    existed, because the probe resolved the program name against the
    orchestrator's own search path instead of the path the check itself
    would use.** A check invoked through an explicit environment-variable
    prefix (setting its own search path before naming the program) was
    probed as if that prefix were not there at all. Rule: a probe must
    resolve a program the same way the real check will — honoring an
    explicit search-path override first, then a dedicated tools directory,
    then the ordinary search path — and a refusal must name every place it
    looked. Enforcement: the probe now unwraps that prefix, tries the
    dedicated tools directory, and falls back to the ordinary search path,
    listing every directory tried in its refusal. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
100. **A file carrying a worker's own evidence about which mutant killed
    which test was refused outright over one extra, purely informational
    field.** The shape check treated every field it did not already know
    about as a hard error, with no room for a worker to attach its own
    supporting notes. Rule: a documentation-only field is accepted with a
    warning, never a reason to refuse a file whose real content is
    otherwise valid. Enforcement: two such fields are now accepted and
    carried through, and a worker's own claim about which test killed a
    mutant is compared against what actually failed, warning on a mismatch
    instead of trusting it blindly. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
101. **A worker that answered a question was reported exactly as if it had
    said nothing at all.** A reply that was almost valid, structured data —
    readable by a person, just not by a strict parser — was reduced to a
    bare empty result plus a generic parse-failure message, with the actual
    answer recoverable only by digging through raw logs by hand. Rule: a
    worker that answered is never reported as empty; a parse failure keeps
    the raw answer reachable, and an easy, well-understood mistake is
    repaired automatically before it is treated as a failure at all.
    Enforcement: a parse failure now tries one narrow, documented repair
    first and reports the raw reply's own location and a leading excerpt of
    it when nothing can be recovered, instead of only a bare empty result.
    Regression coverage is in `tests/field-lessons-batch-l.test.mjs`.
102. **A job that never even got the chance to start looked identical, from
    the outside, to one that ran and produced nothing.** A one-time setup
    step failing before the actual worker ever launched left an empty
    error, empty result, and empty cost — the same shape a worker that ran
    and simply reported nothing would leave — with the real cause visible
    only in a log file nobody was told to open. Separately, a dependency
    lock naming a local file no longer present in the tree was only
    discovered once an offline install actually tried to use it. Rule: a
    job that never started says so, with the setup failure's own tail
    alongside it; a lock naming a path that is not there is flagged before
    anything tries to install it. Enforcement: inspecting a run now names
    the phase a setup failure happened in and includes that failure's own
    log tail, and validation now warns when a dependency lock names a local
    path missing from the tree. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
103. **A failed check at integration time stayed invisible unless a rarely
    remembered flag was passed, letting a broken change through silently.**
    The default behavior treated a check that failed exactly like one that
    passed, reporting success and requiring extra, easy-to-forget ceremony
    to surface the failure at all. Rule: a failed check at integration time
    is loud by default, never a quiet field a reader has to go looking for.
    Enforcement: integration now refuses by default when a check has
    failed, naming every failed check, with an explicit opt-in for the rare
    case that failure should be accepted anyway. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
104. **A worker was told to run a check that lived somewhere its own sandbox
    could never reach, and spent its turns discovering that the hard way.**
    A check naming a path outside the worker's own restricted environment
    was indistinguishable, in the instructions it was given, from one it
    could actually run itself. Rule: a check a sandboxed worker is told to
    run must be reachable from within its own sandbox, or the instructions
    must say plainly that a later, unrestricted step runs it instead.
    Enforcement: validation now warns when a check or a job's own
    instructions name a path outside the sandboxed environment, and that
    worker's own boilerplate now marks such a check as run by a later step
    instead of asking the worker to run it itself. Regression coverage is
    in `tests/field-lessons-batch-l.test.mjs`.
105. **An exact pin on a repo's own package was vendored nowhere at all, and
    passed clean.** The stale-pin check only ever compared an exact pin
    against a vendored copy of the same package; a pin with no vendored
    copy to compare against fell through both of its rules instead of
    failing either one. Rule: an exact pin is only trustworthy when it is
    backed by something the tests actually ran against — a vendored copy,
    or an explicit local/override source. Enforcement: an exact pin with
    neither now fails a new rule, in every kind of repo (no exemption for
    the kind of repo that owns the shared core package). Regression
    coverage is in `tests/field-lessons-batch-m1.test.mjs`.
106. **A guard meant to stop a scratch file from ever being pushed judged
    the wrong thing and refused a file that was never going to be pushed
    at all.** It asked whether a run's own declared-output list named a
    scratch-shaped file absent from the base commit — but a declared
    output that is git-ignored and never committed is *also* absent from
    the base commit, so a legitimate, ignored side-effect file was refused
    exactly like a real mistake would have been. Rule: a guard that exists
    to stop something from being pushed must judge the actual diff that
    would be pushed, never a list of what a job merely claims to have
    produced. Enforcement: the guard now reads the real diff between the
    base commit and the current one (plus anything staged) instead of the
    run's declared outputs. Regression coverage is in
    `tests/field-lessons-batch-m1.test.mjs`.
107. **Two workers sharing one machine both burned their last minutes in a
    sleep-and-poll loop, waiting on a full test suite each had launched in
    the background, and both timed out with nothing to show for it even
    though their real work was already finished.** A shell worker told to
    "run the full suite" ran it itself, in the background, and then polled
    it by sleeping — exactly the kind of busy-waiting that starves a
    shared machine when two such workers land on it at once. Rule: a
    worker runs only its own new or changed files; the full suite is the
    orchestrator's job, run once, after the fact. Enforcement: a worker's
    own instructions now say so directly; integrating a timed-out job can
    now accept its already-finished, hash-checked outputs instead of
    discarding them; starting two shell jobs that share a root and both
    ask for a full suite now warns up front; and a timeout result now
    names what the transcript was last doing when time ran out.
    Regression coverage is in `tests/field-lessons-batch-m2.test.mjs`.
108. **A worker fixed a set of failing tests by adding a new field to a
    persisted record, picked its own default for data saved before the
    field existed, and called that choice "stricter" — but that default
    silently made a one-time migration a no-op for every record already on
    disk, which was the entire point of the fix.** Every test was green
    because no test ever loaded a file saved before the field existed.
    Rule: a newly persisted field must state its legacy default in plain
    words, and a test must prove that default by loading a real pre-change
    file from disk — a worker's own judgment about which default is
    "safer" is not a substitute for that. Enforcement: a result schema now
    carries the field's name, legacy default and reasoning; inspecting a
    run warns when a diff adds a field to a persisted record with that
    left empty. Regression coverage is in
    `tests/field-lessons-batch-m2.test.mjs`.
109. **A routing decision that retired a model from the cheap tier landed
    only in a decision log, not in the rulebook a model reads at boot, and
    jobs kept quietly routing to the old, pricier choice.** Rule: a routing
    decision only takes effect once it lands in the document the model
    actually reads before acting, not only in a record meant for humans.
    Enforcement: validation now warns when a job asks for the cheap tier on
    an agent pricier than the configured cheap-tier model, unless the job
    states a reason the cheaper model was skipped. Regression coverage is
    in `tests/field-lessons-batch-m2.test.mjs`.
110. **A public tool hard-coded a private product's keychain service name,
    an app-support path, and a product-specific denied-directory entry.**
    A contract written for one project's own conventions was carried
    faithfully into a tool meant to be read by anyone. Rule: a public-repo
    tool names no private product specifics directly; project-specific
    values arrive through local configuration, with a generic default.
    Enforcement: all three now default to generic values, overridden only
    through local config. Regression coverage is in
    `tests/field-lessons-batch-m3.test.mjs`.
111. **A tool-free API worker's reply, cut short by an output-length limit,
    surfaced only as a bare "incomplete or unexpected" error with no way
    to tell why from the error alone.** Rule: a failure to parse a
    worker's reply names the actual reason it failed, not just the fact
    that it did. Enforcement: the error now names the provider's own
    finish reason (e.g. truncated by length) directly. Regression coverage
    is in `tests/field-lessons-batch-m3.test.mjs`.
112. **A release removed a private name from code while its own new tests
    added it back, and nothing caught it because the list of private
    names lived outside the repo being shipped.** A scrub is only as good
    as the check that runs on every later change, and a check with no
    list to read against cannot enforce anything. Rule: a private-names
    list lives in local, machine-specific configuration (never a source
    literal), and ship's own diff guard reads it from there by default
    when a project keeps no list of its own, refusing outright when a
    configured list names a file that does not exist. Enforcement: ship's
    private-names source order now falls through to local config, and a
    `path:` line in that list refuses a whole file entering a diff at
    all, public or private repo alike. Regression coverage is in
    `tests/config-private-names.test.mjs`.

113. **A tool-free worker asked to return a large existing file whole, in
    one reply, ran out of its own output budget partway through, and the
    failure was reported as a generic "incomplete or unexpected" error.**
    Rule: a worker changing only part of a large file should say so as
    one exact find-and-replace, never the whole file, and a system that
    cannot know in advance whether a worker will choose that should warn
    up front instead of guessing. Enforcement: a tool-free worker's
    structured reply may now name one exact find/replace pair per
    declared output instead of returning it whole, refused outright when
    the text to find is missing or matches more than once; validation
    now warns when an existing declared output is already large enough
    that asking for it whole risks the same failure. Regression coverage
    is in `tests/field-lessons-batch-n.test.mjs`.
114. **An idle window between hand steps went unnoticed until it had
    already cost real time, because nothing checked whether a job was
    actually running before the next hand step began.** Rule: check that
    a job is running before any hand step, and account for idle time the
    moment it happens rather than only after the fact. Enforcement: a
    coordinator now warns before certain hand steps when no job is
    running anywhere under its configured project roots, naming how long
    it has already been idle; a background-time reader now lists every
    idle gap of five minutes or more between recorded windows.
    Regression coverage is in `tests/field-lessons-batch-n.test.mjs`.
115. **A named license exception for one specific package was written
    down as prose for a worker to remember, and the automatic license
    gate rejected that same package anyway, needing a manual fix
    afterward.** Rule: a named exception is configuration a gate
    enforces, not prose a worker or a later reviewer has to remember.
    Enforcement: a scouting tool now accepts a repeatable per-package
    license exception that keeps a matching pick in the results,
    distinctly marked, while every other pick under the same license is
    still rejected. Regression coverage is in
    `tests/field-lessons-batch-n.test.mjs`.
116. **A scouting tool's license gate was a fixed list built for source
    code, so a search explicitly allowed to use permissive asset
    licenses had every real result rejected, and an extra report section
    the search brief asked for was silently dropped by a fixed report
    layout.** Rule: the list of allowed licenses is exactly what the
    search brief says it is, not a fixed built-in assumption, and an
    extra section a brief asks for must survive into the final report.
    Enforcement: the allowed-license list can now be replaced outright
    from a file or a plain list, a preset exists for common permissive
    asset licenses (flagging the one that requires attribution), and any
    extra section a report includes now renders in the final document.
    Regression coverage is in `tests/field-lessons-batch-n.test.mjs`.
117. **A coordinator overrode its own git identity to make a commit
    land, and the hosting service refused the resulting push over an
    email-privacy setting, requiring several commits to be redone.**
    Rule: never override git identity; the repository's own
    configuration decides. Enforcement: shipping now refuses, before any
    push, when a commit in the change carries an author or committer
    email that is neither the repository's configured address nor a
    hosting-service-issued privacy address. Regression coverage is in
    `tests/field-lessons-batch-n.test.mjs`.
118. **A regression check across several stacked changes to the same
    file could not tell whether an older change still mattered, because
    the reconstruction it relied on assumed only one change had ever
    touched that file.** Rule: a regression check across stacked changes
    must work on the tree as it now stands, not on bookkeeping that
    assumed no later change would touch the same file. Enforcement: a
    regression check can now target one specific change directly,
    reverting only that change's own effect on a disposable copy of the
    current tree, and it now says plainly when every failure it saw was
    only a loading error rather than real evidence. Regression coverage
    is in `tests/field-lessons-batch-n.test.mjs`.
119. **A worker with no ability to run tools of its own was pointed at
    reference material it needed for its task, but that material never
    actually reached the request sent to it, and the run was still
    reported as finished successfully with nothing usable to show for
    it.** Rule: a worker with no tools of its own must have its
    reference material actually delivered to it, or the task should be
    refused outright; a result that amounts to nothing is never reported
    as finished successfully. Enforcement: reference material for such a
    worker is now inlined directly into its request, with a size limit
    per file and a record of what was actually included; material that
    cannot be delivered this way now refuses the task up front, and an
    empty result from such a worker is now reported as failed rather
    than finished. Regression coverage is in
    `tests/field-lessons-batch-n.test.mjs`.
120. **A dependency-installation warning and a toolchain-environment
    warning both fired when nothing they warned about could actually
    break.** One fired on a manifest with no dependencies at all; the
    other fired on a check that only ever ran a plain script interpreter
    needing no extra environment. Rule: a warning fires only when the
    thing it warns about can actually break. Enforcement: the dependency
    warning now fires only when a manifest actually declares
    dependencies; the toolchain warning now recognizes a script that
    resolves to a plain interpreter call and skips it. Regression
    coverage is in `tests/field-lessons-batch-o.test.mjs`.
121. **A shipping guard refused a run for a scratch file that was never
    actually part of what got pushed.** The guard read a run's own
    declared-output list instead of the actual pushed diff, so a
    git-ignored bookkeeping file always tripped it even though it was
    never committed. Rule: a diff guard checks the diff, not a list of
    what a run merely declared. Enforcement: the guard now reads the
    actual pushed diff (plus anything staged) and no longer refuses a
    file that was never committed. Regression coverage is in
    `tests/field-lessons-batch-o.test.mjs`.
122. **An empty reference file was sent to a worker as if it were real
    input.** A platform difference in a text-processing tool silently
    produced a zero-byte file, and it was handed to a worker anyway; the
    worker reported back blocked only after it had already spent effort
    reading everything else. Rule: an empty context file is a mistake,
    never real input. Enforcement: an empty (0-byte or whitespace-only)
    reference file now refuses up front, naming the file, before any
    worker starts. Regression coverage is in
    `tests/field-lessons-batch-o.test.mjs`.
123. **A tool-free worker failed instantly with a vague "incomplete or
    unexpected response" message, but no request had actually reached
    the provider at all.** The real cause was a missing credential after
    a configuration path moved; nothing in the failure said so. Rule: a
    request that never reached the provider must say so; a missing
    credential is named before any request is even attempted.
    Enforcement: a missing credential now refuses up front, naming where
    it looked; the generic incomplete-response error is now used only
    once a real provider response exists, and an empty successful
    response is now named plainly instead of read as malformed.
    Regression coverage is in `tests/field-lessons-batch-o.test.mjs`.
124. **A worker that replied in plain prose instead of the requested
    structured answer, having produced nothing at all, was still
    recorded as finished successfully.** A missing declared result and a
    missing declared output together should never read as success.
    Rule: a worker with no usable result and no output actually produced
    is never reported as finished successfully; a plain-language refusal
    is still a refusal. Enforcement: that combination is now recorded as
    failed with a specific reason, and a plain-language refusal naming
    what it needs is now parsed into the same structured refusal a
    well-formed one would produce. Regression coverage is in
    `tests/field-lessons-batch-o.test.mjs`.
125. **One broken shared instruction file, sitting in a directory shared
    across every project, blocked every single task in every project —
    including tasks that would never have used it at all.** A field
    meant to say "none" was mistaken for missing, and a compact list
    format was silently read as empty. Rule: an explicit "none" is
    valid, not missing; a shared broken resource should only ever block
    the tasks that would actually use it. Enforcement: an explicit empty
    list in that instruction format is now accepted; a compact list is
    now parsed correctly; and a broken shared instruction file now only
    blocks a task that actually references it, warning everywhere else
    instead of refusing. A new check validates such a directory
    directly, on demand. Regression coverage is in
    `tests/field-lessons-batch-o.test.mjs`.
126. **A sandbox warning kept firing on a path that the sandbox
    actually allowed.** The warning had no idea that a shared toolchain
    location was specifically granted, so it repeated itself every
    single time regardless. Separately, there was no single place to see
    what a sandboxed worker's access actually looked like; it had to be
    pieced together by hand. Rule: a path a sandbox actually grants is
    never denied; the effective access a sandbox grants should be one
    command away. Enforcement: the warning now recognizes granted paths
    and stays quiet about them; a new diagnostic command prints the
    whole effective sandbox profile as structured output. Regression
    coverage is in `tests/field-lessons-batch-o.test.mjs`.
127. **A reasoning-capable worker was cut off mid-answer at a fixed
    output budget that never accounted for its own internal reasoning
    consuming part of that budget.** Rule: a reasoning model's output
    budget must cover its internal reasoning as well as its actual
    reply. Enforcement: reasoning-capable models now get a larger
    default output budget; a response cut off with literally no reply
    text at all now gets exactly one automatic retry at double the
    budget, still bounded by the same spending cap. Regression coverage
    is in `tests/field-lessons-batch-o.test.mjs`.
128. **During a stretch when no automated task was running at all, only
    hand-run steps happened one after another, wasting time nothing was
    actively working during.** The only queued work at that point
    belonged to a different, not-yet-started track of work, and nothing
    suggested starting it. Rule: when the only queued work belongs to a
    not-yet-started track, its first, read-only step should start during
    idle stretches instead of nothing running at all. Enforcement: the
    idle-time warning now offers a hint naming that first step, and the
    same hint is available as its own on-demand command. Regression
    coverage is in `tests/field-lessons-batch-o.test.mjs`.
129. **A sandboxed worker's local-network access stayed wide open to
    every unused local port by default, an accepted risk noted for
    future tightening.** Rule: a sandbox's local-network access should
    be narrowable to only the ports a task actually needs, without
    changing today's default for a task that does not ask for it.
    Enforcement: a task may now name the exact local ports its sandbox
    is allowed to use; naming none leaves today's broader default
    unchanged. Regression coverage is in
    `tests/field-lessons-batch-o.test.mjs`.
130. **A record meant to prompt a follow-up check after a merge was
    written with only vague instructions, so the check ran against the
    wrong state entirely, well before the real change had even
    landed.** Rule: a post-merge follow-up record must name the exact
    resulting state, not vague instructions to pull and restart.
    Enforcement: shipping now prints the exact merged state plus a
    ready-to-use line naming it, right after a merge completes.
    Regression coverage is in `tests/field-lessons-batch-o.test.mjs`.
131. **A log reader's own tests fed it fixture events directly, so its
    mutation-testing score looked strong even though nothing in the real
    system actually produced most of the event names it read.** Rule: a
    reader of logged events needs at least one test fed by a real
    producer's own output. Enforcement: a shared contract now names
    every event a producer writes and a reader reads, and validation
    warns when a listed reader has no matching producer anywhere in the
    batch. Regression coverage is in `tests/field-lessons-batch-p.test.mjs`.
132. **A cheap, bookkeeping-only worker tier was refused for writing a
    small internal note file, even though that exact kind of file was
    already the tier's intended job.** Rule: an allowlist of
    bookkeeping-only output paths should match the files that tier is
    actually meant to write. Enforcement: a small internal note file now
    matches the bookkeeping allowlist; any other design-content file
    still goes to a more capable, still inexpensive tier, and the
    refusal now says so. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
133. **A spend figure shown before a paid job was based on mental
    arithmetic rather than an actual itemized estimate, and the job went
    over its own cap before its own safety step caught it.** Rule: every
    spend figure a cap is set from, and the cap check itself, must come
    from a real itemized estimate computed in code, never arithmetic
    done by eye. Enforcement: a job may now declare a spend cap
    alongside an itemized cost-estimate file; the total is summed in
    code and refused before the job ever starts when it exceeds the cap,
    or when the estimate file cannot be read. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
134. **A declared output with a typo'd name that never existed anywhere
    was read, once nothing showed up for it, as a real deletion and
    blocked the whole change.** Rule: an output missing from both the
    starting state and the finished work was simply never written, not
    deleted, and a typo like this is worth flagging before anything even
    runs. Enforcement: a declared test output absent from the starting
    state now warns up front; an output missing from both the starting
    state and the finished work is now treated as not written, never as
    a deletion. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
135. **A verification command used to score a set of deliberate code
    changes turned out unable to run at all, yet every one of those
    changes still came back with a result that looked like a completed
    score.** Rule: a verification command has to prove it can pass on
    the unmodified code before its result means anything. Enforcement:
    that command now runs once, unmodified, before any deliberate change
    is scored; a command that still cannot pass refuses outright, naming
    why, and any change that comes back unscorable is now called out
    plainly rather than silently averaged in. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
136. **A release request's own title named one version while the
    version recorded in the project and its own change log both still
    named the old one, so nothing was actually tagged and a second
    cleanup was needed to fix it.** Rule: the version bump and the
    release title belong to the same change, checked against each
    other, never trusted to already agree. Enforcement: a release
    request whose title names a version that disagrees with the
    recorded version, or whose change log still marks itself unreleased,
    is now refused before anything ships. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
137. **A time-window check was exercised only ever by clocks already set
    to one particular time zone, so a real event that fell outside the
    window on a different clock went unnoticed by every test that
    covered it.** Rule: code that judges a date or time window needs at
    least one test set to a different time zone, not only the zone every
    other test happens to use. Enforcement: a shared checklist now calls
    this out explicitly, and validation warns when a change touching a
    time-window comparison has no test naming a different zone.
    Regression coverage is in `tests/field-lessons-batch-p.test.mjs`.
138. **A fresh working copy with none of its usual tooling installed yet
    had every one of its checks fail to even start, and that was
    silently scored the same as a real failure of the change itself.**
    Rule: an environment-setup step meant to prepare a fresh working
    copy should run on every attempt, not only when something happened
    to look like it needed it; and a check that never even started is
    not the same thing as a real failure. Enforcement: a setup step now
    runs before checks on every attempt; a setup step that cannot even
    start is now called out plainly instead of being scored as a real
    failure of the change. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
139. **A pasted standing approval already covering queued work was still
    held for a second confirmation round trip, only because an unrelated
    policy change arrived bundled in the same message.** Rule: work
    already recorded and queued is pre-approved and can start right
    away; a fresh typed confirmation is needed only for genuinely new
    requests, secrets, credentials, material meant for publication, or
    anything that spends money. Enforcement: the coordination guide and
    the onboarding instructions both now state this rule at the point
    work begins. Regression coverage is in `tests/kickoff.test.mjs`.
140. **A sandboxed worker had no way to declare the few outside hosts one
    task genuinely needed, and a check known to only ever work outside
    the sandbox had no way to say so, leaving it either dropped from the
    plan or left to block a job it could never pass from inside.** Rule:
    a check known to run only at the later, unsandboxed step says so
    instead of gating a job that can never satisfy it from inside; a job
    that needs outside hosts still goes to a tool-enabled worker, since
    per-host access from the sandbox is not built yet. Enforcement: a
    check may now be marked as running only at that later step, skipped
    by the sandboxed worker and named as such in its own instructions;
    the (still refused) allowed-host list now also refuses any entry not
    written as a secure, named address. Regression coverage is in
    `tests/field-lessons-batch-q.test.mjs`.
141. **A full check run performed inside an already-sandboxed worker
    showed several failures that were purely the host's own security
    layer refusing a nested sandbox call, not a real problem with the
    change, and nothing separated those from genuine failures short of
    opening each one by hand.** Rule: a failure whose own output names
    that exact kind of nested-sandbox refusal is not a real failure and
    must never be counted as one. Enforcement: the check runner now
    recognizes that specific wording in a failing check's own output and
    tags the result sandbox-only, excluded from the fail count.
    Regression coverage is in `tests/field-lessons-batch-q.test.mjs`.
142. **A shared task brief pointed to certain files as evidence a fix had
    landed, and one of those paths did not actually exist in the
    project, discovered only once someone went looking for it by
    hand.** Rule: a shared brief's own file references are checked
    against the real project before anyone trusts them. Enforcement:
    validation now reads a shared brief's own file references and warns
    when one names a path missing from the project. Regression coverage
    is in `tests/field-lessons-batch-q.test.mjs`.
143. **A task's own success criterion named a diagnostic field to check,
    and the work that followed satisfied that literal wording while
    still never proving the one real case the field existed to catch,
    caught only at review.** Rule: a success criterion naming a
    diagnostic field must also say which real case it needs to tell
    apart, and the test plan for it should ask for one test per such
    case, not merely proof that the field exists. Enforcement: the
    shared task template's own test-plan section now asks for exactly
    that. Template change only; no code check.
144. **A spend-cap contract said the cap held before each paid call, and
    the work that followed it checked the cap once per case using a
    one-call worst case, while a single case could make several paid
    calls in a row — a gap every worker's own regression tests missed,
    caught only at review.** Rule: a spend-cap or limit contract must
    name the exact unit that is checked (each paid call, not each
    case/task) and require one test where a single case makes several
    such calls, tripping the cap mid-way through that one case rather
    than only across accumulated cases. Enforcement: the shared
    contract template's own test-plan section now asks for exactly
    that. Template change only; no code check.
145. **A one-off platform-only failure in a file a change never touched
    still stopped the ship outright, even though the tool already
    recognized and named it as platform-only; a person had to notice the
    label and manually trigger a rerun each time.** Rule: a platform-only
    failure in an untouched file earns one automatic rerun before a
    person is asked to look, while an explicit rerun-count setting
    (including "never rerun") always overrides that default, and a
    failure that recurs after the automatic rerun still blocks. Enforcement:
    the release tool now defaults to exactly one automatic rerun when
    every failing check is platform-only and no explicit rerun count was
    given, naming the default in a warning; an explicit setting always
    wins, and a failing check already inside the change's own diff is
    still never rerun. Regression coverage is in
    `tests/field-lessons-batch-r.test.mjs`.
146. **Copies a tool itself placed into a job's own workspace were reported
    as if the job had written them.** A batch of otherwise ordinary
    warnings about unexplained files buried the one that actually
    mattered, because every copy the tool had seeded there on the job's
    behalf (never touched by the job at all) triggered the very same
    warning as a real stray write. Rule: a file a tool seeds into a
    workspace is never reported as that job's own dropped write, unless
    its content no longer matches what was actually seeded there, which
    is the one real sign something else edited it. Enforcement: dropped-
    write detection now compares a seeded path against the content hash
    recorded at seed time, before ever flagging it. Regression coverage
    is in `tests/field-lessons-batch-s.test.mjs`.
147. **A change touched two source files, but only one of them ever got a
    mutant.** Mutation testing reported a clean result, and a fix's own
    regression tests passed, while the second changed file's logic was
    never exercised by any mutant at all — found only once a reviewer
    traced which file each mutant actually targeted. Rule: every non-test
    source file a change touches needs at least one mutant of its own; a
    changed file with none is named as a gap, not silently passed over.
    Enforcement: mutant validation now warns of a changed source file
    with no covering mutant, at the same point a run's mutants are
    checked. Regression coverage is in
    `tests/field-lessons-batch-s.test.mjs`.
148. **A fix moved a blocking call into asynchronous code and kept
    calling it exactly the same way as before.** Every existing test
    passed, because none of them ever ran anything else at the same
    time; only once the change reached a real concurrent caller did the
    now-genuine wait visibly stall everything sharing that same thread.
    Rule: a change that moves blocking work into or out of asynchronous
    code must say where that work now actually runs (a background
    thread versus the main event loop) and needs one test proving a
    second, unrelated task keeps making progress while it is in flight.
    Enforcement: the shared contract template's own test-plan section
    now asks for exactly that. Template change only; no code check.
149. **A test step that only ever runs inside real continuous-integration
    was replayed on a plain local machine and simply refused to run
    there.** The step's own guard (checking for a CI-only environment
    variable) correctly stopped it before anything unsafe happened, but
    the wasted round-trip cost real time before the mistake was even
    understood. Rule: a step gated on a CI-only signal — a CI-only
    environment variable, an operating-system check reserved for a
    runner, a marker meant only for real hardware, or a secret value —
    is never replayed locally; it is named and skipped instead, with the
    reason attached. Enforcement: the CI-derived check reader now skips
    such a step and reports why. Regression coverage is in
    `tests/field-lessons-batch-s.test.mjs`.
150. **A worker's own report of what it changed was a prose sentence, not
    a bare path, and a warning meant to flag an undeclared write instead
    fired on a file the job had actually declared.** The report string
    carried a trailing status word or a trailing parenthetical the
    comparison never stripped, so it never matched the declared path it
    was actually describing. Rule: a self-reported "changed" entry is
    normalized to its own path (trimmed, one trailing parenthetical
    dropped, one trailing status word dropped) before it is ever
    compared against what a job declared, or shown in a warning.
    Enforcement: the dropped-write check now normalizes each entry
    first. Regression coverage is in
    `tests/field-lessons-batch-s.test.mjs`.
151. **A secrets-bearing `env:` block declared for one job in a CI
    workflow was still being applied to a second, unrelated job that
    declared no `env:` of its own**, because the reader that tracks a
    workflow's own `env:` text never reset it between jobs. An ordinary
    step in the second job was wrongly treated as CI-only and skipped,
    just because an earlier, unrelated job happened to reference a
    secret. Rule: a workflow-level `env:` applies to every job, but a
    job-level `env:` applies only to that job's own steps, and must be
    reset the moment a new job starts. Enforcement: the CI workflow
    reader now scopes and resets job-level environment text at each job
    boundary, with a test that a second job's parsed steps carry none
    of an earlier job's environment keys. Regression coverage is in
    `tests/field-lessons-batch-s.test.mjs`.
152. **A handful of tests passed in continuous integration and in one
    long-lived local checkout, but failed the moment they ran from a
    fresh checkout in a different location.** Each read some piece of
    the real machine's own state instead of a value the test itself
    controlled: a personal configuration file, a personal collection of
    optional add-ons, or an ambient identity setting — all present (with
    one particular shape) on the machine that had been used for
    development, and absent or different elsewhere. Rule: a test run
    must never depend on the real user's home configuration, the real
    user's optional add-ons directory, the real global identity
    settings, or where the checkout happens to live; every test isolates
    all of these for itself. Enforcement: the shared test-isolation setup
    now isolates the real home configuration and identity settings for
    every test file that touches them, proven by running the affected
    tests from a brand-new checkout with an empty home directory.
153. **A worker's own CLI shell died on a transient provider error, and
    the orchestrator treated that exactly like a real worker
    failure**, refusing to salvage its partial (but real) progress even
    though a second attempt moments later, on an unrelated question,
    succeeded at once. Rule: a transient provider error (a 5xx or a 429
    status) is not a worker mistake. Enforcement: a job that ends on
    such a status is retried once, over its own kept workspace, with a
    short continuation note, before it is ever scored failed; a
    salvage of a run also now accepts a failed job whose failure is
    this kind of transient error and whose kept workspace still holds
    real output changes. Regression coverage is in
    `tests/field-lessons-batch-t1.test.mjs`.
154. **A worker process killed before it ever produced a final result
    still reported a cost of nothing, even though its own transcript
    showed real, substantial token usage.** A cost is only ever read
    from a provider's own final result event; a killed, timed-out, or
    otherwise interrupted job never emits one, so its real spend went
    unrecorded. Rule: a job's own transcript is real evidence of spend,
    even without a final result event. Enforcement: a job that ends
    with no reported cost now has one estimated from its own
    transcript (summed per distinct exchange, at a fixed rate per
    model), naming the estimate as such rather than as a reported
    figure; a model this cannot rate warns rather than guessing.
    Regression coverage is in `tests/field-lessons-batch-t1.test.mjs`.
155. **A batch of automated builds landed on a base that was already
    failing its own checks, and nothing said so until much later**,
    when a still-later step needed to tell a pre-existing failure from
    one a build had just introduced and had no easy way to do it. Rule:
    a base commit's own health is verified before anything is built on
    top of it, and a failure discovered afterward is labelled by
    whether it already existed on that base. Enforcement: dispatching a
    batch of automated builds now first verifies the base commit's own
    checks (a repeat run at the same base is answered from a cached
    verdict, not repeated), refusing to proceed onto a failing base
    without an explicit, reasoned override; a later failing check is
    labelled pre-existing or newly introduced by re-running it against
    that same base. Regression coverage is in
    `tests/field-lessons-batch-t1.test.mjs`.
156. **A release step merged a change with a locally failing check,
    silently, because that same check also happened to fail on the
    unchanged base** — treated as excused rather than as the
    environment problem it actually was. Separately, a check's own
    narrowed environment sometimes left out a program the wider
    environment plainly had, refusing in a way that read exactly like
    that program being genuinely absent. Rule: a release step never
    merges past a non-passing local check without an explicit,
    deliberate choice to do so, and a check failing the same way on the
    unchanged base is an environment problem to fix, never a quiet
    green light. Enforcement: a release step now holds, naming the
    failing tests, on a check that also fails on the base, unless that
    is explicitly accepted; validation also now warns when a check's
    own narrowed environment omits a program the wider environment
    plainly has. Regression coverage is in
    `tests/field-lessons-batch-t1.test.mjs`.
157. **A worker with shell access, given no synced local toolchain of
    its own, searched the wider disk and ran tests using another,
    unrelated checkout's leftover environment**, so its own claims of
    what passed or failed could not be trusted, and it read files well
    outside anything it was ever given. Rule: a shell worker reads and
    runs only its own workspace, the shared toolchains directory, and
    ordinary system paths — never another checkout's environment found
    by searching. Enforcement: the shell sandbox now denies reading or
    running anything under a shared temporary-files area apart from a
    job's own small scratch space; validation now warns when a shell
    job's own checks or instructions plainly need a toolchain sync
    step but declare none; and a job's own report of what it ran must name the actual
    program path used, with a warning when that path sits outside the
    job's own workspace. Regression coverage is in
    `tests/field-lessons-batch-t1.test.mjs` and
    `tests/field-lessons-batch-t2.test.mjs`.
158. **A worker's own report of an unmet rule read the same as a silent
    workaround.** A worker faced a contract requirement it genuinely could
    not satisfy inside its own declared outputs, but had no structured way
    to say so short of stopping outright, so a reviewer could not easily
    tell a deliberate, reasoned deviation apart from a worker that just
    quietly did something else instead. Rule: let a worker report a
    deviation it could not avoid, with what the rule was, what it did
    instead, and why, and require a person to accept it explicitly before
    it lands. Enforcement: a result may carry a `deviations` list read at
    review time and again before landing; landing refuses outright unless
    that acceptance is explicit, and an accepted deviation is recorded
    alongside the change instead of disappearing into a worker's own notes.
    Regression coverage is in `tests/field-lessons-batch-u.test.mjs`.
159. **A new dependency on a platform-only backend had no test for the
    backend being unavailable.** A change added a runtime dependency on a
    platform API (a keychain, say) reachable on a startup path, but nothing
    proved the program still started when that backend failed or was
    simply absent, which is exactly the environment a good share of real
    machines present. Rule: any new platform-bound dependency on a startup
    path needs one test that forces its backend to fail and proves startup
    still succeeds, with the dependency built lazily behind a factory so a
    test can swap it out. Enforcement: the shared contract template's own
    test checklist now states this requirement directly. Regression
    coverage is in `tests/field-lessons-batch-u.test.mjs`.
160. **A private term left a branch's history even though the final diff
    never showed it.** A term that must never reach a public remote was
    added in one commit and removed again in a later commit of the same
    branch; the existing guard compared only the cumulative diff against
    the branch's base, which no longer contained the term at all, so the
    scan missed it and the term still travelled inside that first commit's
    own history once pushed. Rule: a guard over what a branch will publish
    must judge every commit it will actually publish, not only the net
    change between endpoints. Enforcement: publishing now scans each
    commit's own added lines and message for a configured private term,
    refusing before any push and naming only the offending commit and the
    term's position in the list, never the term itself. Regression
    coverage is in `tests/field-lessons-batch-u.test.mjs`.
161. **A held review request carried no fixed shape for what a reviewer
    actually needed to see.** A pull request held for a named reviewer's
    attention read like any other held request, so the reviewer had to
    hunt through the whole body for what changed, what could break, and
    what evidence backed it, every single time. Rule: a request held for
    that reviewer carries a fixed three-field summary — what changed, what
    could break, and the proof — surfaced the moment the hold happens, not
    buried in prose. Enforcement: a hold whose body opens with that
    reviewer's own marker now gains a structured summary built from the
    body's own Summary, Could break, and Mutation check sections (a
    missing Could break section becomes an explicit fill-in-later marker,
    never blank), printed at the point the hold decision is made.
    Regression coverage is in `tests/field-lessons-batch-u.test.mjs`.
162. **A worker's own passing status and its own evidence disagreed, and
    nothing noticed.** A job's report named a check "passed" while the very
    same report's own text still carried a nonzero failure count for that
    check — a self-contradiction sitting in plain sight inside one report,
    caught only if a reviewer happened to read the whole thing closely.
    Rule: a report that grades itself is cheap evidence next to what its
    own numbers already say, and the two should never be allowed to
    quietly disagree. Enforcement: review now scans a job's own reported
    text for a nonzero failure count and warns when a check the same
    report calls "passed" is contradicted by it. Regression coverage is in
    `tests/field-lessons-batch-u.test.mjs`.
163. **A narrowed check environment warned about programs it never used at
    all.** A check that ran with a deliberately narrowed set of paths
    warned about every common program missing from that narrowed set, even
    ones the check itself never invoked, so a real gap (the one program the
    check actually needed) was buried in noise about programs that were
    never relevant to it. Rule: a missing-program warning belongs only to
    the program a check's own command line actually runs, not to every
    program a fixed list happens to name. Enforcement: the warning now
    resolves the actual invoked program (skipping past a leading
    environment-variable prefix, and treating one particular tool as
    implying a second one underneath it) before checking whether that
    program, specifically, is missing. Regression coverage is in
    `tests/field-lessons-batch-u.test.mjs`.
164. **A sandboxed job's own scratch-directory temp path did not reach its
    own temp-directory environment variables.** A sandboxed job's own
    tests could call the standard "create a temp directory under the
    system temp path" pattern and still land outside the one directory the
    sandbox actually grants that job read/write access to, because nothing
    guaranteed the system temp-path variables pointed at that job's own
    scratch directory in the first place. Rule: a sandboxed job's own
    temp-directory environment variables always point at that job's own
    scratch directory, the one its own sandbox already grants access to,
    never the bare system default. Enforcement: a sandboxed job's launch
    environment sets its temp-directory variables to its own scratch
    directory; an unsandboxed job's environment is unaffected. Regression
    coverage is in `tests/field-lessons-batch-u.test.mjs`.
165. **A sandboxed job's scratch directory still occasionally landed
    somewhere a version-control-aware path check could reach, or refuse.**
    An earlier fix already moved a sandboxed job's own scratch directory
    off the plain system temp path, but the underlying system temp
    location itself turned out to still be reachable by, or subject to,
    that same kind of check on some machines, so the same class of
    failure came back in the field. Rule: a sandboxed job's scratch
    directory belongs under the orchestrator's own install location, a
    place no project checkout ever occupies, not merely off the plain
    system temp path; a defensive check for the earlier failure mode stays
    in place alongside the new one rather than being removed. Enforcement:
    the scratch directory is now created as a per-run, per-job directory
    under the orchestrator's own install root (overridable by one
    environment variable), while the original safety scan is kept as a
    second, belt-and-suspenders check. Regression coverage is in
    `tests/field-lessons-batch-v.test.mjs`.
166. **A red starting point silently blocked a run whose whole point was
    to fix it, or silently waved one through that could not tell the
    difference.** A run meant to repair a known-broken starting point had
    to pass an explicit override every single time, even though the
    failures were already fully accounted for by what that run itself was
    about to change; separately, nothing checked a proposed test file for
    an import error before it was ever handed to a real test run, so a
    typo surfaced only much later. Rule: a run may proceed past a known-bad
    starting point without a manual override only when every one of its
    failures is already covered by what that run itself declares it will
    change, and a proposed test file's own importability is worth checking
    cheaply before it is trusted. Enforcement: a run now compares each
    failing check's own named locations against its own declared outputs
    and proceeds, with a logged warning, only when every location is
    covered; review separately performs a lightweight, collection-only
    dry run of a proposed test file, warning on a bad import or noting
    when the language's own collection tool is unavailable to check with.
    Regression coverage is in `tests/field-lessons-batch-v.test.mjs`.
167. **A plain piece of text reported as a deviation rendered as nothing,
    or as a jumble of individual characters.** A worker's own report of a
    contract rule it could not meet was expected to always arrive as a
    structured entry with named fields, but a plain line of text reported
    the same way instead read as blank in a refusal message and, once
    accepted, turned into an object keyed by character position rather
    than any real field. Rule: a reported deviation is real text a person
    needs to read, however it happens to be shaped, and every place that
    displays or records one must render that text intact. Enforcement:
    every place that turns a deviation into a message or a stored record
    now recognizes a plain line of text as a deviation in its own right,
    displaying and recording it exactly as given instead of assuming one
    fixed shape. Regression coverage is in
    `tests/field-lessons-batch-v.test.mjs`.
168. **A worker's own line number attached to a path made that path look
    unfamiliar.** A worker reporting what it changed sometimes appended a
    line number, or a line range, to an otherwise perfectly ordinary path,
    and that small addition was enough to make review treat a declared,
    expected path as if it were a surprise edit outside the job's own
    scope. Rule: a trailing line reference is not part of a path's
    identity and must be removed before that path is judged against
    anything else. Enforcement: the same normalizing step that already
    trimmed other trailing decorations from a self-reported path now also
    strips a trailing line number or line range, so a path differing from
    a declared one only by that suffix is recognized as the same path.
    Regression coverage is in `tests/field-lessons-batch-v.test.mjs`.
169. **An edit outside a job's declared scope vanished the moment the run
    was refused, with no way back short of asking the worker to redo it.**
    An edit made outside a job's own declared outputs was already detected
    and could block a run from landing, but nothing preserved the edit
    itself anywhere; a person facing that refusal could only discard it or
    re-run the job and hope for a cleaner result, even when the edit
    itself might have been perfectly reasonable and worth keeping. Rule: a
    detected out-of-scope edit is saved in full, not just flagged, the
    moment it is found, so a person facing it later has a real choice
    between discarding it and deliberately applying it. Enforcement: an
    out-of-scope edit's full content (plus a comparison against the
    original where one is available) is saved to a per-run location as
    soon as it is detected; landing the run now refuses outright on any
    unaddressed one unless a person explicitly chooses to proceed without
    it or to apply it from where it was saved. Regression coverage is in
    `tests/field-lessons-batch-v.test.mjs`.
170. **A test that reads its own fixture from a path nobody actually
    commits works for whoever wrote it and fails for everyone else.** A
    test file referenced a fixture sitting under a directory version
    control was told to ignore, so the fixture existed only on the
    machine that happened to write the test, and disappeared the moment
    anyone else checked the branch out fresh. Rule: a test file's own
    fixture references must name a path version control will actually
    carry along with the test, never one it has been told to skip. Enforcement:
    publishing a change now scans a test file's own newly added lines for
    a quoted, file-like path and checks whether version control would
    ignore it, refusing before anything ships when it finds one (with a
    documented, reasoned way to excuse a specific file); review performs
    the same scan and warns instead of refusing. Regression coverage is in
    `tests/field-lessons-batch-v.test.mjs`.
171. **A shell job's own scratch directory lived under the install
    checkout by default, which the install checkout being its own git
    repository could still place it inside of.** A prior fix moved a
    shell job's scratch base under the install root instead of the OS
    temp directory, but "the install root" is itself a git checkout on
    a default install, so the very defensive check meant to keep
    scratch data outside any repository could fire on the first job a
    fresh install ever ran. Rule: a scratch base must be proven outside
    any repository at install-check time, not only discovered the first
    time a job hits it. Enforcement: the default scratch base is now a
    sibling of the install checkout, never a path inside it, honoring
    the same override an operator could already set; a version-check
    command now runs the identical outside-repository assertion itself
    and reports the result, instead of a job only ever finding out by
    refusing. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
172. **A shared contract or a job's own prompt could name a private
    term and still reach a public repository, because the existing
    private-names scan only ever looked at the lines a change would
    add to a diff.** A contract file and a job prompt are both read
    by, and can both leak into, a public repository long before any
    diff exists to scan. Rule: a contract or a job prompt for a public
    repository passes the same private-names scan a diff already gets,
    before any job is ever dispatched. Enforcement: dispatching a
    manifest now scans the shared contract's own text and every job's
    own prompt text against the configured private-names list,
    refusing before any workspace is created when a term is found, and
    skipping the scan entirely once the target repository is confirmed
    non-public. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
173. **An evaluator's own test could report a clean pass while never
    once exercising the very attack path it exists to catch, because
    its test used only hand-built fixtures instead of the real data it
    will actually see in production.** A gate that only ever saw
    fixture data built to be clean, or built to be caught, proves
    nothing about whether it can tell the two apart on a real input.
    Rule: a test for any evaluator or gate must run on the real data it
    will see in production and prove the attack path itself actually
    ran, not merely that the final verdict came back as expected.
    Enforcement: the shared contract template now requires exactly that
    real-data test for every evaluator or gate a batch adds or changes,
    together with a standard mutant that forces the evaluator to treat
    every case as clean, which that same test must then kill.
174. **A live service's own checkout had its HEAD changed by hand to
    set up a comparison, sitting detached for a time before being
    restored.** Nothing in the tooling stopped a person from treating a
    live service's checkout the same as a disposable one, even though
    changing its HEAD by hand risks the service reading a half-updated
    tree while it keeps running. Rule: a checkout a running service
    depends on is never changed by hand; a standing warning names it
    before that happens again. Enforcement: validating or running a
    manifest now warns when its target root has a live service
    listening on its own configured port, naming both the root and the
    port and pointing at a worktree as the safe alternative, reusing
    the existing port-probing configuration instead of adding a second
    list to keep in sync. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
175. **A model or provider route was switched to a new value after
    only a listing call confirmed the new option existed, and every
    real message sent through that route then failed once it reached
    production.** A listing call and a real streaming message travel
    through completely different code paths in most clients, so
    confirming an option is listed proves nothing about whether a real
    message can actually complete through it. Rule: a model or provider
    route change needs one real message sent through the project's own
    client, on the same code path production uses, before it ever
    lands. Enforcement: validating a manifest now warns when a job
    changes a file that looks like a model or provider route and no
    declared check looks like that real smoke test; separately, an
    explicitly configured list of route files now makes publishing the
    change refuse outright unless its own description names the
    verification that was actually run. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
176. **A validator gained a second bound check on a file that already
    had one mutant covering it, and the new comparison went completely
    untested, because coverage was only ever tracked once per file,
    never once per line.** A file-level coverage count reads as
    satisfied the moment any one comparison on that file has a mutant,
    even while a second, unrelated comparison added later has none at
    all. Rule: a mutant is required for every pass-bar comparison a
    change adds, not just once per file that comparison happens to live
    in. Enforcement: mutation testing now also warns, at the line
    level, when a new or changed comparison operator has no mutant
    whose own target text actually touches that exact line, layered
    over the existing file-level warning rather than replacing it.
    Regression coverage is in `tests/field-lessons-batch-w.test.mjs`.
177. **A mutant a real test suite genuinely caught was still reported
    as unproven, because the classification trusted only one specific
    exit code as a real failure; separately, a mutant went unproven a
    second time after an unrelated formatting step silently rewrote its
    own target file first.** Some test runners report a real failure
    under a different exit code than the one classification already
    recognized, and a formatting step run before mutation testing can
    rewrite a mutant's own target text without anything noticing before
    the mutant is scored. Rule: a test runner's own known failure exit
    code, paired with a real failure line in its own output, counts as
    a kill; a formatting step that runs before mutation testing must
    never be allowed to rewrite a mutant's own target file unnoticed.
    Enforcement: mutation testing now recognizes a wider, named set of
    known test-failure exit codes together with a real failure line in
    the output as a kill, reports an invalid mutant separately from a
    genuine build failure, and warns whenever a step run before
    mutation testing changed the bytes of a file a mutant targets.
    Regression coverage is in `tests/field-lessons-batch-w.test.mjs`.
178. **A new test landed right at the edge of a per-test CI timeout,
    passing on one machine and timing out on another the moment
    anything nearby ran a little slower.** A test's own duration was
    never checked against the timeout it shares with every other test
    on that platform, so a test that already used most of the budget
    looked fine right up until it didn't. Rule: a newly added test's
    own duration is checked against a configured share of the per-test
    timeout before it gets the chance to surprise CI later on a
    slightly slower run. Enforcement: publishing a change now reads
    every check run's own timing output and warns by name and duration
    when a test this change added used more than that configured share
    of the timeout on any platform. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
179. **Accepting a known pre-existing failure could not reach a
    verdict at all, because proving it re-ran a whole, possibly slow
    or unrelated, suite on the base instead of just the failing tests
    in question.** A full-suite re-run on a throwaway base checkout can
    fail to produce any usable result for reasons that have nothing to
    do with the specific tests being excused, leaving the decision
    stuck with no way forward. Rule: a base comparison is scoped to
    just the tests actually in question, not the whole suite around
    them. Enforcement: accepting a pre-existing failure now re-runs the
    base check scoped to just the failing tests' own files, and the
    resulting summary names exactly which test ids that verdict
    covers. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
180. **Squashing a branch by hand onto a base that had since moved
    risked bringing someone else's already-merged changes into the
    index.** Resetting a branch's history onto whatever a base
    reference currently points at, instead of the shared point where
    the branch actually diverged, can silently stage far more than the
    branch itself ever changed. Rule: a squash always resets to the
    shared point of divergence, never a base reference that may have
    moved since, and refuses the moment anything unexpected ends up
    staged. Enforcement: a new command resets a branch's index to its
    own point of divergence from the base and refuses, undoing itself
    first, whenever the newly staged files include one the branch
    never touched there; it only stages and prints the file list,
    never committing on its own. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
181. **Spend crossed both a warn and a cap threshold in a single day
    before anyone noticed, because nothing tracked a running total
    across everything dispatched that day.** Spend was only ever
    summed after the fact, at handoff, so a threshold meant to stop
    further spending had already been crossed many dispatches earlier
    with nothing to flag it in the moment. Rule: a running daily spend
    total is checked before every dispatch, not tallied after the
    fact. Enforcement: a configurable warn and cap threshold are now
    checked against a running total, summed across every registered
    project's own dispatches since the start of the day, before a run,
    a question, or a scouting sweep ever starts, refusing at the cap
    unless explicitly overridden with a stated reason. Regression
    coverage is in `tests/field-lessons-batch-w.test.mjs`.
182. **An offline package-cache step failed inside a sandbox even
    though the exact same command succeeded instantly outside it.** The
    sandbox pointed the cache variable at a fresh, empty, per-run
    directory instead of the real one already warmed by everyday use,
    so an offline step had nothing to read from no matter how many
    times it had already succeeded elsewhere. Rule: an offline step
    needs to run where its already-warm cache actually lives, not a
    new empty directory invented for the occasion. Enforcement: the
    sandbox now points that cache variable at the real, shared cache
    directory under the real machine's own home (already readable by
    the sandbox) instead of a fresh per-run one beside the job's own
    workspace. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
183. **A default retry for a flaky-looking CI failure covered only one
    narrow pattern of it, missing a failure in a file the change never
    touched at all.** A failure on a file completely outside a change's
    own diff is just as clearly unrelated to that change as a failure
    that only happens on one platform, yet only the platform-specific
    pattern ever triggered an automatic retry, leaving every other kind
    of unrelated failure to block the change by hand. Rule: a default
    retry should cover any failure clearly unrelated to the change
    itself, not just one specific pattern of it. Enforcement: the
    default retry now also applies when a failing test's own file is
    one the change never touched, and a failure that keeps recurring
    in the same file across separate attempts is now logged and
    flagged by name for a follow-up fix, instead of being rerun forever
    with nothing else ever changing. Regression coverage is in
    `tests/field-lessons-batch-w.test.mjs`.
184. **A dispatched job's own prompt named a real file on disk that was
    never actually copied into its workspace, because nothing tracked,
    declared, or contextual named it either.** The file existed, so a
    human reading the prompt assumed it would be there; the worker
    discovered only after starting that it was not, after real money
    had already been spent. Rule: a prompt naming a real, on-disk path
    that is covered by neither tracked files, declared context, nor an
    explicit declared resource is refused before dispatch, not
    discovered by the worker. Enforcement: a new manifest field lists
    extra files to copy into every job's own workspace; a missing
    declared file (or one that names a directory) refuses at validate
    time, and an un-declared path a prompt names that exists on disk
    is refused the same way. Regression coverage is in
    `tests/field-lessons-batch-x.test.mjs`.
185. **A worker's own transcript, saved to disk by default, sometimes
    carried sensitive data a person never meant to leave their own
    machine.** Every worker's reply and failure log were written to a
    shared run directory the same way regardless of what they
    contained. Rule: a job may declare that its own transcript must
    never be written to disk, and a configured sensitive path may
    require that declaration before a job touching it is allowed to
    run at all. Enforcement: such a job's saved reply and failure log
    are replaced with a fixed placeholder on disk (the real text is
    still used in memory for that same run), and a job whose own
    context or outputs match a configured sensitive path without the
    declaration refuses before it ever starts. Regression coverage is
    in `tests/field-lessons-batch-x.test.mjs`.
186. **A job's own prompt asked its worker to return a JSON reply
    missing a field a later check required, and nothing caught it
    until well after the job had already been dispatched and paid
    for.** The shape a result had to carry was only ever checked once
    the run was already being integrated. Rule: a declared result
    shape is checked against a prompt's own stated reply shape before
    a job ever dispatches, not only once its real result is read back.
    Enforcement: a job's own prompt is parsed for the JSON shape it
    promises to return and compared against every attached
    requirement at validate time, refusing before dispatch on a
    mismatch. Regression coverage is in
    `tests/field-lessons-batch-x.test.mjs`.
187. **A one-pass pre-push guard and a fresh-merge-base squash command
    both already existed, but nothing pointed a batch at either one
    before it shipped.** A batch re-learned, by hand, the order these
    two steps should run in. Rule: a shared contract template names
    the already-built tools to use, and in what order, instead of
    leaving each batch to rediscover them. Enforcement: the shared
    contract template's own release guidance now names both commands
    directly. No code changed; this is a documentation-only entry.
188. **A tool-free worker job with no declared output file was asked
    for a substantial piece of real written content, which had
    nowhere to go but a short, capped summary field.** The job could
    only ever return a small fraction of what was asked for, silently
    truncated, with no declared file to hold the rest. Rule: a job
    with no declared output file may only ever be asked a short
    question, never for substantial written content. Enforcement: a
    job with no declared outputs whose prompt plainly asks for
    written content (a summary, a report, a draft) now refuses before
    any request is sent; a response that was cut off for running out
    of room now states the size of what was sent in, so the cause is
    provable instead of guessed at. Regression coverage is in
    `tests/field-lessons-batch-x.test.mjs`.
189. **A worker CLI's own plan-limit message, printed instead of its
    usual structured output, was scored as an ordinary job failure.**
    The real cause (a provider-side quota, not a mistake in the job or
    the worker) was buried under a generic exit-code error, and
    nothing stopped the next job from being dispatched straight into
    the same outage. Rule: a worker CLI's own quota or plan-limit
    message is a provider outage, not a job failure, and once seen it
    should stop further dispatches until the provider's own reported
    reset time, not rely on a person noticing the pattern by hand.
    Enforcement: this message is now detected and recorded with its
    own distinct status and the provider's reported reset time; a
    further dispatch that would need the same provider refuses until
    that time unless explicitly overridden. Regression coverage is in
    `tests/field-lessons-batch-x.test.mjs`.
190. **A sandboxed worker could read a project root's real git
    metadata but not write to it, so a job asked to commit from a
    linked working copy of that root could never actually succeed.**
    The read access alone was not enough for the one operation a
    commit actually needs. Rule: a sandbox that grants read access to
    a linked working copy's real git metadata for one operation grants
    write access for the same reason, scoped just as narrowly.
    Enforcement: a worker's sandbox now grants write access to exactly
    those paths when the project root is itself a linked working
    copy; a warning names the grant whenever a job's own prompt asks
    it to commit under this condition. Regression coverage is in
    `tests/field-lessons-batch-x.test.mjs`.
191. **A worker was told not to read anything outside a fixed list, then
    handed a repository whose own instructions told it to read
    something else first — and refused instead of testing whether that
    read would actually succeed.** The blanket rule and the
    repository's own real instructions pointed in different
    directions, and the worker resolved the conflict by giving up.
    Rule: a worker's own read restriction should name its real
    exceptions up front, not leave a worker to infer when the rule
    does not actually apply. Enforcement: a worker's own prompt now
    states plainly which required reads named by the repository's own
    instructions are genuinely out of reach, and inlines the ones that
    are not; a warning separately names a required, trackable read
    that a job's own declared inputs still omit. Regression coverage
    is in `tests/field-lessons-batch-x.test.mjs`.
192. **An output placed under a shared or test directory could still carry a
    private term with nothing catching it before integration.** A job's
    declared output landed under a shared skills directory or a fixtures/tests
    path and carried a private name or term, the same category an existing
    diff-wide scan already caught elsewhere, but that scan never looked at
    these directories specifically. Rule: any output under a shared, fixtures
    or tests path is scanned against the same private-names list used
    elsewhere, before it is ever integrated. Enforcement: `validate`/
    `integrate` now refuse `private-name` for an output under `shared/`,
    `fixtures/` or `tests/` whose content matches a configured private term.
    Regression coverage is in `tests/field-lessons-batch-y.test.mjs`.
193. **A job's declared outputs could exceed what the model could actually
    return, discovered only once the request itself came back truncated.** An
    API job's own declared output files, summed, exceeded its configured
    output-token cap, so a run that looked valid at dispatch time was destined
    to come back cut off. Rule: a job's declared outputs are sized against its
    own output cap before it ever dispatches, not after. Enforcement:
    `validate` now warns and refuses `output-cap-too-small` when a job's
    estimated declared-output size exceeds its configured `maxOutputTokens`.
    Regression coverage is in `tests/field-lessons-batch-y.test.mjs`.
194. **A skill's own required result keys were never checked against the
    actual API envelope shape.** A job carried an attached skill that declared
    required result keys, but the envelope schema built for an API job never
    required them, so a reply missing one of those keys could still pass
    validation. Rule: an attached skill's own required result keys are part of
    the envelope's required schema, not a separate, unchecked promise. 
    Enforcement: the API envelope now requires a `result` object, and
    `validate` injects an attached skill's own `resultKeys` into that schema
    before a job ever dispatches. Regression coverage is in
    `tests/field-lessons-batch-y.test.mjs`.
195. **An invalid envelope reply left no trace once it was rejected.** When
    the OpenRouter/API adapter rejected a structurally invalid envelope, the
    raw reply that caused the rejection was discarded, leaving nothing to
    diagnose beyond a generic error message. Rule: a rejected raw reply is
    worth keeping, not discarding, since it is the only evidence of what the
    model actually sent back. Enforcement: an invalid envelope's raw reply is
    now saved to a per-run, per-job file for diagnosis instead of being
    dropped. Regression coverage is in `tests/field-lessons-batch-y.test.mjs`.
196. **A whole run had to be integrated together even when only some of its
    jobs had actually finished.** A batch run with several jobs could not be
    integrated at all once any one job failed, even though its other jobs had
    completed cleanly and did not overlap in their outputs, forcing a wait for
    a full re-run instead of taking the finished work. Rule: a batch run's own
    complete, non-overlapping jobs can be integrated on their own, named
    explicitly rather than assumed. Enforcement: `integrate RUN --jobs
    <id,...>` integrates only the named complete jobs of a run whose other
    jobs failed, refusing with a message naming the flag when a partial run is
    integrated without it. Regression coverage is in
    `tests/field-lessons-batch-y.test.mjs`.
197. **A sandboxed test run could not create its own temp directory where the
    sandbox would actually allow it.** The test suite's own setup created its
    temporary directory using the plain OS default, which a sandboxed worker
    could not write to, so a sandboxed job attempting to run tests had no
    writable location for them at all. Rule: a test suite's own temp directory
    honors an explicit override before falling back to the OS default, so a
    sandboxed caller can point it somewhere writable. Enforcement: the test
    suite's shared setup now honors a dedicated test-temp environment variable
    (falling back to the ordinary temp-directory variable) when creating its
    own temp directory. Regression coverage is in
    `tests/field-lessons-batch-y.test.mjs`.
198. **A sandboxed job's scratch directory was not reliably reachable from
    inside its own sandbox.** A per-job scratch directory created outside the
    repository still was not consistently readable or writable from inside a
    sandboxed job, because the directory could be granted only in the form it
    was created with, while the job's own runtime resolved it through a
    different, equivalent path (for example a symlinked temp root), and an
    ancestor directory needed for the job's own path resolution was not
    granted either. Rule: a scratch-directory grant covers every real path a
    sandboxed job could use to reach it, including a resolved-symlink form and
    the metadata reads its own ancestors need, and the job's environment names
    that directory consistently. Enforcement: the sandbox profile now grants
    a per-job scratch directory in both its raw and resolved-symlink forms,
    plus ancestor file-read-metadata access; the job's environment exports the
    standard temp-directory variables pointing at it, and the directory is
    removed once the job finishes unless an explicit keep-temp override is
    set. Regression coverage is in `tests/field-lessons-batch-y.test.mjs`.
199. **Dispatch refusals must name the next action.** A coordinator linking a
    fresh, empty project hit three refusals in a row, each costing a
    source-code dive before the first run started: `bookkeeping-terse:
    resultKeys missing status`; `fatal: ambiguous argument 'HEAD': unknown
    revision`; and `Refusing: base is red (...); pass --accept-red-base with
    --reason to run onto it anyway`, whose override then left no trace once
    accepted. Rule: a refusal names where the thing came from and the one
    command that resolves it, and an accepted override is recorded, not just
    typed. Regression coverage is in `tests/dispatch-refusals.test.mjs`.

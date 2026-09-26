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

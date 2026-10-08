# Active orchestration

The coordinator turns the mission into reviewed changes. A list of imaginary workers is not a swarm run. Start only workers with concrete useful deliverables, record the run ID, and follow their work through verification.

For overflow work run manually with `cursor-agent`, use a separate git worktree and the [Cursor lane guard](cursor-lane.md) to claim files, check changes before merging, and check swarm manifests against those claims. The coordinator must run these advisory checks; the lane is not managed by the swarm runner.

## A practical operating loop

1. Inspect the actual project and its instructions. Identify the desired behavior, current implementation, shared interfaces, and relevant checks.
2. Split independent work into coherent deliverables, each with an acceptance check and one owner per output. A rendering change and its focused tests can belong to one worker; a separate worker can handle a disjoint navigation component. Keep exact shared interface decisions and final integration with the coordinator. Consumers of an unsettled interface belong in a later run.
3. Write a manifest naming explicit context and outputs. Always set `model` on every job; there is no default, so an omitted `model` is refused before any worker starts. Choose concurrency based on useful independent work and account/machine capacity; the default is 2, explicit maximum 32, and up to 256 jobs may wait in the queue.
4. Run `preflight`, resolve dependency warnings, and review task-size advisories before actually starting `run`. `validate` is still available for validation alone. Preserve the execution session and run ID. The command stays attached; it does not create an unattended daemon or visible terminal windows.
5. While workers execute, continue independent coordinator work and periodically call `monitor`. The snapshot reports recorded queued/running/terminal counts, elapsed time, peak concurrent jobs, and per-job timings. Do not invent activity or call an idle process productive work.
6. Review each response and proposed file against the supplied evidence. Reproduce plausible defects. Reject unsupported claims. Inspect conflicts, then integrate the complete acceptable run.
7. Execute the target project's checks and inspect real behavior. For dependent follow-up, integrate the first stage and create a new manifest from the updated source.
8. To land the integrated tree, run `node tools/swarm.mjs ship <run-id> --repo OWNER/NAME --pr payload.json`: it pushes the branch, opens or updates the pull request, re-runs the manifest's `checks` and fills them into the PR body, waits for CI, and merges once green. It refuses at any earlier step — a dirty tree, a failed check, a missing required PR section, a rejected push — before anything reaches the remote, and never merges a PR whose body opens with a `**needs ` human-review marker. See [the manifest reference](manifest-reference.md#ship) for its full status vocabulary and exit codes.

```sh
node tools/swarm.mjs preflight examples/four-reviewers.json
node tools/swarm.mjs run examples/four-reviewers.json
# From a separate coordinator execution call while that owned run is active:
node tools/swarm.mjs monitor <run-id>
node tools/swarm.mjs status <run-id>
node tools/swarm.mjs inspect <run-id>
# Review every proposed output before integration.
node tools/swarm.mjs integrate <run-id>
```

`monitor <run-id>` on its own is a single JSON snapshot, not a blocking watch loop; poll it at useful intervals (for example, 5–15 seconds for short runs and less often for longer ones) rather than continuously busy-polling. For a human watching the terminal instead of a script, `monitor <run-id> --view` renders the same saved state as a table — one row per job with status, elapsed time, and output count, plus a summary line — and `monitor <run-id> --view --watch [seconds]` (default 2) re-renders that table in place until the run finishes or you press Ctrl+C. `--watch` is still just repeated reads of the saved snapshot: it does not attach to the workers, and it cannot start, cancel, or integrate anything. Saved `running` state can be stale after a host crash. Timing measures runner job lifecycle, including startup/preparation and result handling; it is not GPU utilization or proof of productive reasoning.

CLI job progress includes observed stdout/stderr byte counts, first and last output timestamps, a sampled activity timestamp, and elapsed time without observed output (`silentMs`). These are output observations, not a heartbeat, semantic progress measure, or proof that a silent worker is stalled. Single-request API jobs mark incremental activity unobservable; older records without progress remain unknown. Do not invent timestamps for either case.

## Choosing a tier

Set each job's `tier` (`cheap` | `mid` | `expensive`) before dispatch and write a short `tierReason` for anything `expensive`; both are validated metadata (see [the manifest reference](manifest-reference.md)) and are shown back to you in `preflight` and `inspect`. Setting `tier` never selects a model by itself: put the model you actually want in `model`. Route by difficulty, not topic. Keep the wording short and plain.

- **`cheap`** — small follow-ups, PR bodies, summaries, manifests, bookkeeping. Always cheap, whatever the topic.
- **`mid`** — code and tests against a clear written contract. The default for ordinary implementation work.
- **`expensive`** — genuinely hard work: a new design with no clear contract, or tricky reasoning a mid-tier worker would likely get wrong. Or, a step a `mid`-tier worker already failed twice—escalate that one job one tier and record why in `tierReason` (for example: `"mid worker failed twice on token-refresh race; escalating"`).

Auth, async and similar topics are not triggers by themselves. A design choice that is not already in the plan is not a reason to reach for a more expensive model. Stop and ask the human instead; no tier setting substitutes for that decision.

The runner has no retry/re-dispatch path today — every job in a manifest runs exactly once. The escalate-after-two-failures rule is therefore a coordinator rule, not something the runner enforces: after a `mid` job's second failed attempt, the coordinator writes a fresh job with `tier: "expensive"` and a `tierReason` explaining the two failures, rather than dispatching a third `mid` attempt at the same task.

## Wiring jobs

A job that wires new code to an existing data path — reusing a fetch, event,
or call that already exists elsewhere in the project — needs that path
scouted before dispatch: identify who mounts or calls whom, and put every
file on that path in the job's declared `outputs`. Without that, a worker
told to "reuse the existing fetch" may find the component on that path
outside its outputs and quietly add a new request instead, mentioning it only
in a side field; the coordinator then discovers it only when unrelated tests
break. A worker that cannot meet a MUST or "do not" rule inside its own
outputs must stop and return status `blocked` naming the file it needs,
never work around the rule. Enforcement: this is stated directly in every
CLI worker's preamble, and `inspect --results` warns `outside outputs: <job>:
<path>` when a job's own `crossJobNames` or `notes` name a real repo path
outside its outputs. See
[manifest reference](manifest-reference.md#result-file).

## Sandboxed checker jobs

Name a `codex` job's required test environment explicitly with the job field
`testEnv` instead of letting a sandboxed, detached worktree rediscover it
under a permission denial. A capable worker may spend real time and tokens
finding a missing environment variable itself before it can report a genuine
result; a weaker one could just report that setup failure as a red suite.
`doctor codex`'s `sandbox probe` check surfaces the same kind of sandbox
denial ahead of any job, and `testEnv` values are also named for the worker
directly in its prompt. See
[manifest reference](manifest-reference.md#job-fields).

## Decompose before adding workers

A job that changes token refresh, persistence, revocation, runner behavior, scheduled work, archival, status, and their tests contains several concerns. First identify the stable interfaces and ownership boundaries. For example, settle a canonical account-access contract, then dispatch disjoint runtime callers and status presentation in parallel against that contract. Keep edits to a shared storage file with one writer; making several workers touch that file would create a merge bottleneck. Each job should state the behavior to deliver, files it owns, the acceptance check the coordinator will execute, and what must be true of its inputs.

When independent jobs must still agree on names neither can see the other choose — a cross-job export, CLI command, flag, manifest field, or output shape — write one contract file listing every such name before dispatch, and set the manifest's `contract` field to its path. The runner then refuses any job whose `context` omits the contract file and any job that lists it as an `outputs` entry (only the coordinator writes it), so "read the shared contract" cannot silently regress into "guess and hope it lines up." A worker that needs a name the contract does not cover reports the gap instead of inventing one; fold it into the contract for the next run.

Use small cohorts whose outputs can sensibly integrate together. An unrelated documentation task need not hold a ready code change behind the all-jobs-complete gate. Multiple independent runs can overlap, but the coordinator must ensure their output ownership does not overlap and account for total provider concurrency across runs. Preflight checks one manifest; it does not reserve files or detect other active runs. Review completed proposals while slower workers finish; do not bypass whole-run integration by copying files out manually.

Bind runnable acceptance evidence before dispatch. Name the existing check command and the behavior it covers, or assign a focused test file and its execution command. A job that writes a JSON report should declare it with the job field `resultFile` (in its own `outputs`) so `inspect --results` reads that file directly instead of depending on the worker's last message being valid JSON; see [manifest reference](manifest-reference.md#result-file). Implementation and its test may have the same owner; an independent test writer can work after the relevant API stabilizes. If the repository has one shared test file, use a serialized ownership handoff or first approve separate files supported by its test runner. Do not postpone all regression writing until one final broad testing job. The coordinator executes the cohort's checks after whole-run integration; worker-authored assertions and a proposed command do not count as passed tests. An integrated stage with missing or failing checks remains unverified, and dependent work must not assume its correctness.

Increase concurrency when more independent, useful work is ready and account capacity permits it. If workers are waiting on one unsettled contract, settle the contract rather than assigning more consumers to stale snapshots. A manager may help draft boundaries or review an area when that removes coordinator load. Restricted CLI managers have no agent or shell tools and cannot dispatch a nested swarm; the coordinator validates and starts their proposed manifests. An authorized native host manager can delegate bounded work when supported by the host, with those workers counted in the ownership and capacity ledger. This does not change the restricted runner's capabilities or grant new authorization.

Before dispatch, managers review ownership across active runs, required integrated dependencies, runnable acceptance checks, and task stop conditions. Return a concise disposition: **ready** with the inspected contract and check bindings, **fix** with the smallest correction and its evidence, or **blocked** with the unresolved dependency and required coordinator decision. After implementation, return the same disposition against actual files and check results; readiness to dispatch is distinct from verified acceptance. Stop the affected work when an unexpected shared-file edit, unsettled interface, missing context, failed check, or scope expansion would invalidate its contract. Managers report the issue rather than silently expanding outputs, permissions, budgets, or worker count. Independent work may continue within its existing scope.

See the [managed feature recipe](managed-feature-plan.md) for task contracts, ownership ledgers, and staged handoffs.

## What preflight reports

`preflight MANIFEST` performs the same manifest and project-path validation as execution, without calling a provider or creating a run. Invalid paths, missing context, reserved credential paths, symlinks, and ownership collisions still fail closed. Filename guards do not detect secrets inside ordinary source files; inspect the selected context before dispatch. A valid report includes:

- Per-job copied byte totals, every file's byte count and context/output role, and the five largest existing files. Existing output files count because workers receive those snapshots too; missing new outputs count as zero bytes.
- Repeated context across jobs, including copied existing outputs. Repetition may be needed for correctness; the report does not label those bytes wasted or estimate model tokens.
- Cross-job output-to-context references. Every job sees the pre-run snapshot, even at concurrency one. An exact stable contract can make parallel work valid; otherwise integrate the writer and create a fresh reader run.
- Advisory scope flags above five output files or 160 KiB of copied context. These heuristics ask for review; they neither reject a valid coherent job nor prove that a prompt contains multiple concerns. The coordinator must inspect the task's actual responsibilities.
- Each job's declared `agent`, `model`, `tier`, and `tierReason` (`null` when unset), so a tier decision is reviewable before dispatch instead of assumed. See "Choosing a tier" above.

The report is deterministic for unchanged inputs. It contains file paths and byte counts, but no source contents or prompts. It does not automatically split tasks, start workers, guarantee snapshot stability after the check, or predict speedup. The runner revalidates when execution starts.

## Observed bottleneck and how to evaluate changes

In the connector implementation study, a shared-account worker owned eleven files covering storage, token refresh, revocation, runtime callers, scheduled work, archival, status, and tests. It ran for 24 minutes 28 seconds. Its paired shared-key worker finished in 15 minutes 50 seconds, leaving its completed proposal waiting approximately 8 minutes 38 seconds for the cohort to become eligible for integration. Those are observed job durations and gate waiting; they are not a sequential baseline or evidence that adding workers would save the full waiting time.

That case motivates smaller coherent cohorts and earlier ownership/dependency review. To evaluate whether they help, record total time from dispatch through verified integration, each job's duration, waiting after completion, failures or retries, coordinator rework, and checks passed. Compare similar work with the actual input differences disclosed. Report unavailable usage or costs as unavailable and provider-reported costs as estimates. A higher peak worker count or an earlier model response is not by itself improved delivery.

Iteration counts should follow the user's task and the evidence. The connector skill-upgrade study uses three requested passes; ordinary work does not inherit a universal three-pass requirement.

## Scope and recovery

Jobs receive snapshots before execution. Setting concurrency to 1 does not create dependencies between jobs in the same manifest. Reports are untrusted suggestions, and generated code still needs review. Workers cannot authorize deployment, purchases, new tools, terminal attachment, or broad filesystem access.

A failed run cannot integrate. Correct the task, missing setup, or provider issue and start a fresh run. Cancellation stops the runner's owned processes/requests and prevents queued jobs from starting; it does not contact unrelated sessions or guarantee that a remote provider stopped billing. Do not start replacement workers until the cancelled run has settled.

Use recorded requested/resolved model fields, counts, and actual tests in the completion report. Missing usage/cost stays unavailable. Provider usage fields are aggregated within each provider only; different APIs count tokens differently.


## Evidence in job prompts

Use separate **Evidence (measured)** and **Hypothesis** sections. Record
commands actually run, their outputs, and observed event order as evidence.
Keep suspected causes and handoff guesses in the hypothesis section so a
worker can test them instead of building on an unproven premise.

Before accepting a regression test, run it with the fix, then run
`node tools/swarm.mjs redcheck <run-id> --test <argv...>`. Inspect the failing
assertion on base code and rerun with the restored fix. A worker's report that
a test fails on old code is a claim until the coordinator reproduces it.

## Bisect on CI

For a CI-only failure, bisect in the failing CI environment. Handoff guesses
were wrong in one observed incident; throwaway branches and a push-triggered,
single-OS diagnostic workflow narrowed the cause in three short rounds.

Copy `templates/ci-diag.yml` into the target's workflow directory. Edit its
one-OS matrix for the failing platform and use disposable `diag-*` branches.
Keep a control branch with the same diagnostic workflow and a known baseline.
Push candidate halves of the suspect changes, compare verbose per-test timings
against the control, and repeat on the failing half. Use no pull requests for
these diagnostic branches. Record commit, OS, command, failure and timings for
each round. A long test timeout helps reveal the specific wait that stalled.
The template also includes an optional commented native-app idle-CPU probe.

## Fresh context per topic

Hand off at the dispatch limit (10 build dispatches) or when the next work is
unrelated, whichever comes first. Update the task and handoff records with
measured evidence, remaining hypotheses and checks, then start fresh context
for the next topic. See [kickoff](kickoff.md#handoff).

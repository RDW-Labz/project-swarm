# Merge queue

Use `integrate --queue` for large runs. It integrates acceptable jobs in batches, isolates check failures, and starts fresh workers for conflicts. Plain `integrate` without `--queue` keeps its existing behavior.

## Command and flags

```sh
swarm integrate <run> --queue
swarm integrate <run> --queue --batch-size 8 --max-requeues 2
swarm integrate <run> --queue --accept-blocked --no-checks
```

| Flag | Meaning |
|---|---|
| `--queue` | Run the queue driver, starting with the named run. |
| `--batch-size N` | Up to N non-conflicting jobs per batch. Default 10; integer 1–100. Invalid values refuse with `queue-batch-invalid`. |
| `--max-requeues N` | Conflict requeues before one merge job. Default 2; integer 0–5. Invalid values refuse with `queue-requeues-invalid`. |
| `--no-checks` | Skip manifest checks for each batch. |
| `--accept-blocked` | Accept blocked jobs under the existing blocked-output rules. Unwritten blocked outputs are excluded. |

Other compatible integration flags keep their existing rules. `--jobs`, `--salvage`, and `--mutants` refuse with code `queue-flag-unsupported` and message `queue-flag-unsupported: <flag> cannot be combined with --queue`.

The CLI prints one JSON line. It exits 0 for `integrated`, or 1 for `partial`.

## One queue pass

The run need not be fully complete. A pass accepts complete jobs, plus blocked jobs with `--accept-blocked`. It lists every other job in `skipped` with its status.

The pass plans every acceptable job before writing. Existing gates still apply: declared outputs, missing files, deviations, dropped writes, private names, skill checks, and invented-hash warnings. A validation failure still stops the whole pass. One writer per file and explicit file lists remain required. The runner refuses `.git`, `.env`, and symlinks.

Only content and permission conflicts are collected. A job conflicts when any declared output's current checkout bytes or mode differ from its saved `baseHashes` or `baseModes`. None of that job's files are written. Conflicts never overwrite newer content or modes, even if the job's other outputs are safe.

Each conflict has `{job, files, reason}`. The reason is `changed since worker snapshot` or `permissions changed since worker snapshot`.

The pass holds `.swarm/integration.lock` throughout planning, writes, checks, and rollback. Declared `preChecks` run once before the first batch, under their existing lockfile and environment rules. The lock is released between passes. Keep one coordinator for project writes; the lock does not stop unrelated processes from editing the checkout.

## Batches, checks, and rollback

A batch contains up to `batchSize` non-conflicting jobs in manifest order. The pass saves previous bytes and modes, writes the batch's files, then runs the manifest `checks` once for that batch. `--no-checks` skips those checks.

A passing batch stays applied. A failing batch is rolled back: previous bytes and modes are restored, and files that were new are removed. The pass then bisects the batch. It splits into two halves, with the first half containing `ceil(n/2)` jobs. It applies and checks the first half, then the second. Each failing half is rolled back and split again.

Passing sub-batches stay applied. A single job whose checks fail is rolled back and recorded in `checkFailed` as `{job, checks}`, with the failed check names. Other jobs can still integrate.

Rollback after failed checks is intentional in queue mode. Plain integration never rolls back because a check failed. Queue rollback restores the batch's declared writes; it is not a general rollback of arbitrary check side effects.

## Security gate

Every batch also goes through the security gate (secret scan, new-package check, known vulnerabilities, code scan, licence check) after its files are written. A block fails the batch like a failed check: it is rolled back, bisected, and recorded in `checkFailed` as `security-gate`, and listed in `securityBlocked` with an inbox blocker and a sanitized lesson. `--no-checks` does not skip the security gate.

See [the security gate](security-gate.md) for the details and the profile security policy.

## Crash safety

Before writing a batch, including each bisected sub-batch, integration atomically saves `.swarm/integration-journal.json` with the previous bytes and modes of every file it will write or delete. The journal remains through queue checks and is removed after success or rollback. Plain integration removes its journal after successful writes and keeps its existing behavior of retaining writes when checks fail.

SIGINT and SIGTERM restore the journal, remove it, release the locks, and exit 130 or 143 without waiting for child checks. After SIGKILL or a crash, the next plain integration, queue pass, or redcheck restores the journal before planning. Its result includes `recoveredJournal: {runId, kind, jobs, files}` and the warning `integrate-journal-rolled-back: run <runId> <kind> jobs <ids> restored <n> files`. Re-running an interrupted queue pass replans unfinished jobs and skips files already applied by that run. Recovery covers declared batch writes, including new files and modes; arbitrary check side effects are outside the journal.

## Locking

Plain integration, each queue pass, and redcheck acquire a per-repository lock in the live registry before `.swarm/integration.lock`. All worktrees sharing a Git common directory share the repository lock. Both locks record the process, host, run, root, and start time and are released when the command finishes.

A dead owner on this host is cleared automatically with an `integrate-lock-stale-cleared` warning. An ownerless or unreadable lock is cleared only after 60 seconds. A live owner, a remote owner, or a fresh ownerless lock refuses with `integrate-locked`. Queue locks are released between passes while conflict workers run.

## Requeues and merge jobs

The driver starts with attempt 0. After each pass, conflicting jobs get a child run if their attempt is below `maxRequeues`. The default allows two requeues. Each child snapshots the current checkout, so workers see the newer content.

A requeue keeps each original declared job entry, including its ID, agent, model, prompt, context, outputs, and other fields. It removes `after`. The child carries the parent manifest's `checks`, `preChecks`, `lanes`, and `report`. It uses the same spawn, fetch, and environment options.

After the requeue limit, each still-conflicting job gets one child run of its own. Its ID is `<job>-merge` and its type is `merge`. It keeps the original agent and model; automatic routing keeps `agent: "auto"` and omits `model`. Its outputs remain the original outputs. Its context adds conflicting files that exist now, without duplicates. `--max-requeues 0` goes straight to this merge job.

The merge prompt asks the worker to keep newer checkout content and re-apply the original intent. It includes the original prompt. Valid UTF-8 proposed bytes from the conflicting attempt's workspace can appear as earlier-version reference blocks, labeled as untrusted data. The total text cap is 50000 bytes. Over-cap text is represented by file names only.

A merge job runs once. If it conflicts again, it is flagged `merge-conflict`. A failed or blocked merge job is flagged `merge-failed: <status>`. A merge job whose checks fail is flagged `merge-checks-failed`. Flagged jobs need coordinator review; they are never retried beyond this merge job.

## Results and saved progress

The queue driver returns these fields:

| Field | Shape and meaning |
|---|---|
| `status` | `partial` if `flagged` or `checkFailed` is nonempty; otherwise `integrated`. Skipped jobs alone do not make it partial. |
| `runs` | `[{id, attempt, kind}]`, where kind is `original`, `requeue`, or `merge`. |
| `integrated` | `[{job, run, attempt}]` for jobs that integrated. |
| `requeued` | `[{job, attempts}]` for every job requeued at least once. |
| `merged` | `[{job, run}]` for merge jobs that integrated. |
| `checkFailed` | `[{job, run, checks}]`, with failed check names. |
| `flagged` | `[{job, reason}]` for unresolved merge jobs. |
| `skipped` | `[{job, status}]` from the original pass. |

The original run saves the same driver result at `state.mergeQueue.summary`.

Each pass saves progress after every batch in `state.mergeQueue`:

```js
{
  state: 'running', // 'done' at the end of the pass
  batchSize: 10,
  batches: [{ jobs: ['guide'], checks: 'passed', bisected: false }],
  integrated: ['guide'],
  conflicts: [],
  checkFailed: [],
  skipped: []
}
```

Batch `checks` is `passed`, `failed`, or `skipped`. `bisected` records whether a failed batch was split. Pass-level `integrated` lists job IDs. Conflicts and failed checks use the pass shapes described above.

At the end of a pass, the run also saves `integratedAt`, `integratedFiles` for all files actually written, and `integrationStatus: "queued"`. The low-level `integrateRun(root, id, {queue: true, batchSize: 10})` returns `{id, status: 'integrated', integrationStatus: 'queued', mergeQueue, files, warnings}`. Use `integrateQueue(root, id, options)` for the full driver, including requeues and merge jobs.

## Monitor and rollup

When a driver summary exists, `swarm monitor <run> --view` shows:

```text
merge  done - 200 integrated - 10 requeued - 0 flagged
```

Without a summary, the merge line keeps its existing state display. Use `swarm rollup <run>` for compact JSON. Its `mergeQueue` field is `{state, integrated, requeued, flagged, checkFailed}`, with counts for the four job fields. It is `null` when no merge queue exists. Rollup keeps its 4096-byte budget.

See [reports and rollups](reports.md) for worker reports and [the manifest reference](manifest-reference.md#integrate-with-a-queue) for integration flags.

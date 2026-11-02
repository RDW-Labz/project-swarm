# Spend guard

Caps stop new launches when recorded spend reaches a limit. Jobs already running finish and their usage is recorded. A paused run keeps its completed work and resumes the held jobs under the same run ID.

## Commands and flags

```sh
swarm run manifest.json --max-usd 5 --max-tokens 100000
swarm run manifest.json --wait-quota
swarm resume <run> --raise maxUsd=10 --reason "User approved finishing this run"
swarm resume <run> --raise lane.openrouter.dailyUsd=8 --reason "User approved today's increase"
swarm resume <run> --wait
swarm idle <run>
swarm ledger <run>
```

`run` accepts `--max-usd N`, `--max-tokens N`, and `--wait-quota`. `resume` accepts repeated `--raise KEY=VALUE`, `--reason TEXT`, and `--wait`. Both commands exit with code **75** when their result is `paused`.

## Manifest and config

Add these top-level fields to a manifest alongside `version` and `jobs`:

```json
{
  "budget": {
    "maxUsd": 5,
    "maxTokens": 100000,
    "lanes": {
      "openrouter": { "dailyUsd": 3, "dailyTokens": 50000 }
    }
  },
  "idle": [
    {
      "name": "local-note",
      "argv": ["node", "-e", "require('node:fs').writeFileSync('idle-note.txt', 'Local maintenance complete\\n')"],
      "timeoutMs": 60000
    }
  ],
  "ledger": { "path": "docs/state/usage-ledger.md", "phase": "build" }
}
```

The local machine config can set lane caps, idle items, and a ledger path. For example:

```json
{
  "spend": {
    "lanes": {
      "openrouter": { "dailyUsd": 8, "dailyTokens": 200000 },
      "ollama": { "dailyTokens": 500000 }
    }
  },
  "idle": [],
  "ledger": { "path": ".swarm/usage-ledger.md" }
}
```

Manifest `idle` replaces config `idle` when present; an empty array disables configured items for that run. Unknown manifest fields are refused, including unknown fields inside `budget`, `idle` items, and `ledger`.

## Caps and precedence

Run caps come from `budget.maxUsd` and `budget.maxTokens`. CLI `--max-usd` and `--max-tokens` override the corresponding manifest values. Missing caps are `null`, meaning no limit for that measure.

Lane caps start with an OpenRouter default of **$5 per UTC day**. Other lane caps start unset. Config `spend.lanes.<agent>.dailyUsd` and `dailyTokens` may raise or lower those defaults, or set them to `null`. Manifest `budget.lanes.<agent>` may only lower the configured cap: when both values are set, the smaller wins. A manifest `null` cannot remove an existing lane cap.

Explicit raises apply last, in order. Valid keys are `maxUsd`, `maxTokens`, `lane.<agent>.dailyUsd`, and `lane.<agent>.dailyTokens`. Each value must exceed the current effective cap, or set a previously unset cap. A `null` or non-increasing raise refuses with `budget-raise-invalid`.

Caps must be `null` or finite positive numbers; token caps must be positive integers. Invalid cap values, unknown budget keys, and unknown lane agents refuse with `budget-invalid: <path> <reason>`.

## A lane at its cap

A job routed with `agent: "auto"` that is refused by its lane's daily cap is not held: the lane is skipped for that job and the next lane in the routing order (Cursor, then Codex, then the others) takes the job. The move is on the job as `capFallbacks` and in the run's `spendWarnings` as `lane-cap-reroute`. The per-run cap, a job that names its own lane, and a job no other lane can take still hold the run, as before. The caps themselves never change.

## Machine-wide daily spend

Lane daily totals are machine-wide. Every project on the machine shares one store, `~/.project-swarm/spend/daily.json`, or `$SWARM_SPEND_DIR/daily.json` if that is set. Each read and write takes the `daily.lock` directory lock, and writes are atomic. Deleting a project's `.swarm/` does not reset the day. Entries are keyed by project, run, job and attempt, and are pruned after 31 days. A malformed store refuses with `spend-store-invalid` and is never overwritten. A lock held past 10 s refuses with `spend-store-locked`. A stale lock from a dead process on this host is cleared.

## Reservations

Before launch, each job reserves an estimate under that lock. The job is admitted only if run and lane totals, counting every in-flight reservation, are still below their caps. The reservation counts toward both caps until the attempt finishes; then it is replaced by the actual cost. So concurrent launches can overshoot a cap by at most one job's reservation, plus any amount by which an actual cost exceeds its estimate.

Paid lanes are `openrouter`, `openai`, `gemini` and `lambda`. Their USD reservation is the first of these that applies:

- `maxCredits` times the model's `creditUsd`;
- input characters times the input rate, plus `maxOutputTokens` (or the lane default) times the output rate;
- the lane's `reserveUsd`.

Rates come from config `spend.rates.<model>` (`inUsdPerToken`, `outUsdPerToken`, optional `creditUsd`). For OpenRouter without a configured rate, they come from its public pricing. `reserveUsd` defaults to $0.50 and can be overridden in config `spend.lanes.<agent>.reserveUsd`. Every lane also reserves a token estimate (output limit plus input characters / 4) for token caps.

When an attempt finishes:

- **Reported cost:** the provider's reported cost is used.
- **No reported cost, but tokens:** a paid job is estimated as tokens × rate, with `costSource: "estimated-from-tokens"`.
- **No cost and no tokens:** the job keeps its reservation as its cost, with `costSource: "reservation"`.

A paid job is never counted as $0 unless the provider reported $0. Estimated costs are flagged:

- in the rollup: `spend.estimatedCount`, and "estimated cost for N jobs" in the text view;
- in the ledger: `$x.xx est` or `$x.xx reserved` cells, and `(incl. estimates)` in the daily summary.

A job that never reached its provider releases its reservation. A reservation left behind by a crashed process becomes `reserved-as-cost`.

The gate holds a job when the run total or its lane total is at least the cap. Run caps are checked first. With concurrency 1, five jobs costing $0.40 each with `maxUsd: 1` complete three and hold two.

For automatic routing, a lane at its daily cap is treated as paused so routing can choose another eligible lane. A direct job is held for its chosen capped lane. Existing `spendGuard` daily-cap behavior, `--over-cap`, and the Claude provider-limit marker keep their existing rules.

## Pause and resume

A cap-held job has status `held`, reason `run-cap` or `lane-cap`, no new attempt, and no prepared workspace. Its error explains the cap and the raise key, for example:

```text
spend-cap: run spent $1.20 >= maxUsd $1.00; resume with --raise maxUsd=<N> --reason TEXT
```

Quota exhaustion holds jobs with `heldReason: "quota"` and a `heldUntil` reset time. A job refused because the lane pause exceeds `maxPauseMs` retains `provider-limit` status and its error. Dependents of held jobs stay `queued` with a reason such as `after job-1 held`.

At the end, `state.pause` records unique reasons, held job IDs, the latest reset time (or `null`), a message, and a timestamp. The run is `paused` when every non-complete job has a hold reason; mixed failures retain the existing status logic. `swarm monitor <run> --view` displays:

```text
paused: run-cap until n/a; held 2 (job-3, job-4)
```

Never raise a cap without the user's explicit approval. `resume --raise` requires `--reason`, otherwise it refuses with `budget-raise-reason`. The runner records raises with their reason and time in `state.budgetRaises`; it never increases caps itself. A cap still hit refuses with `resume-over-cap: <decision message>` before launching work.

`resume` requires a paused run (`resume-not-paused` otherwise). Before dispatch it rechecks saved snapshot hashes; a changed file refuses with `resume-snapshot-changed: <file>`. It dispatches held jobs and their queued dependents in manifest order, using the same run directory, base hashes, and worktree base. Completed records, attempts, timestamps, reports, and workspace files stay unchanged. A resumed run can pause again under the same gates.

If a quota reset is still in the future, resume refuses with `resume-too-early: resets at <until>; pass --wait`. With `--wait`, it runs the configured idle menu until the reset deadline, sleeps for the remaining time, then resumes. An empty menu adds warning `idle-menu-empty`. `run --wait-quota` repeats this process for quota-only pauses, up to 24 loops; it does not raise caps.

Integration refuses a paused run with `run-paused: resume <id> first`.

## Local idle menu

`swarm idle <run>` runs the configured menu immediately without a reset deadline and prints the results. The menu makes no model calls. Configure only local commands that do not invoke models.

Items run in order. Names match `^[a-z0-9][a-z0-9-]{0,40}$`; `argv` is a non-empty string array, executed directly without a shell. Optional `timeoutMs` is an integer from 1000 to 3600000, default 600000. Invalid items refuse with `idle-invalid`.

Each item gets branch `idle/<run>/<name>` and a worktree at `.swarm/idle/<run>/<name>`, based on the run's base commit. An existing branch is skipped with `idle-branch-exists`. The child environment contains only available `PATH`, `HOME`, `LANG`, and `TMPDIR`, plus `SWARM_IDLE=1`; other environment variables, including API keys and tokens, are omitted.

A successful command with changes commits them as `idle: <name>` using author `swarm-idle <swarm-idle@localhost>`. A successful command without changes is `unchanged`; command failures and timeouts are `failed` and `timeout`. The worktree is removed afterwards and the branch stays for review. The menu does not check out, reset, or push other branches. The runner restricts the environment; this is not an OS sandbox for arbitrary commands.

Each result contains `name`, `status`, `branch`, `exitCode`, `commit`, and `error`. History is appended to `.swarm/runs/<run>/idle.json` as `{at, results}`. During quota waiting, each timeout is limited by the remaining time before reset, and no more items start once that deadline arrives.

## Usage ledger

Every run or resume writes missing attempt rows automatically, including when paused or failed. Path precedence is manifest `ledger.path`, config `ledger.path`, existing `docs/state/usage-ledger.md`, then `.swarm/usage-ledger.md`. A job output equal to the ledger path refuses with `ledger-is-output`. A write failure adds `ledger-write-failed: <message>` as a warning without failing the run.

The ledger contains date, phase, task, worker, model, result, tokens, and rough cost. Phase defaults to `-`. Each attempt has a key `<run>/<job>#<attempt>` in `state.ledgerKeys`, preventing duplicate writes. Task text uses the report summary or first prompt line, strips pipes, line breaks, and control characters, and is limited to 100 characters. Dates are UTC attempt finish dates. Complete attempts show `pass`; other results show their status and a short error.

Only the last attempt carries the job record's token count and reported dollar cost. Earlier token counts are `-`. Costs show `$x.xx` when reported, `subscription` for Codex, Cursor, Claude, Hermes, and Qwen without a reported cost, or `unknown` otherwise. These are recorded usage figures, not a billing reconciliation.

The `Daily summary` groups all ledger rows by UTC date and worker (the `tier` column), with calls, passes, failures/blocked attempts, summed numeric tokens, and rough cost. Numeric dollar costs are summed when present; otherwise the group shows `subscription` if present, or `unknown`. Content following the summary table is preserved.

`swarm ledger <run>` writes any missing rows for an existing run and prints `{path, added}`. Repeating it adds no duplicate rows.

## Project-wide spend cap

`--max-usd` and `budget.maxUsd` cap one run. To cap everything a project spends, set `budget.projectMaxUsd` in the profile (`.project-swarm.json`) or `spend.projectMaxUsd` in the local config (the lower one wins). The swarm adds up every run in `.swarm/runs/*/state.json`; once the total has reached the cap, a new run is refused with `project-cap` before any worker is called. A review re-ask is a run and counts. If the cap refuses a re-ask, its one retry is kept for after the owner raises the cap. Runs still going count with what their own `--max-usd` lets them spend, so runs started together cannot all slip under the cap. `swarm resume` is refused over the cap too (it starts paid jobs again). A run state or pointer file that cannot be read refuses new runs (the total or the cap would be unknown) instead of counting as zero. There is no default cap, and raising one is the owner's call. swarm watch shows the total, the cap and `CAP REACHED` (refreshed every few seconds).

The usage ledger's daily summary ends with a total row. A detail row with extra cells is read from the right; a row that cannot be read is reported under the summary.

With no project cap set, `swarm go` prints a `NO CAP` warning and swarm watch shows `NO CAP`. No default value is ever set for you.

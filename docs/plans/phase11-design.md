# Phase 11 design: plan preview and approval

Contract for `tools/plan-preview.mjs` (a plain ESM module, no dependencies, no model calls, no network; every dependency is passed in). The CLI wiring in `tools/swarm.mjs` is done by hand. Plan: `docs/plans/swarm-scale-plan-v2.md` (Phase 11).

What a goal plan is: `manifestForGoal` (tools/goal.mjs) returns lead jobs (`type: "lead"`, `area: { goal, scope, maxJobs, concurrency }`). Each lead writes child jobs when it runs, so the preview estimates the children from priors and past runs. The estimate is honest about that: it gives a point value and a range.

## Exports

```js
export const PRIORS = Object.freeze({
  childrenPerLead: 6,          // used when there is no history
  child: { inTokens: 15000, outTokens: 5000, seconds: 60 },
  lead: { inTokens: 6000, outTokens: 3000, seconds: 120 },
});

export function estimatePlan(manifest, { lanes, calibration, now }) // -> plan preview object (below)
export function formatPreview(preview)                              // -> plain text, under 40 lines
export function planHash(manifest)                                  // sha256 hex of a stable JSON of the manifest (keys sorted)
export async function savePlan(root, plan)                          // .swarm/plans/<id>.json, symlink-safe, returns the path
export async function loadPlan(root, id)                            // throws plan-not-found / plan-invalid
export async function readCalibration(root)                         // .swarm/project/estimates.json, or an empty one
export function recordActual(calibration, { id, estimate, actual }) // returns a new calibration (pure)
export async function writeCalibration(root, calibration)
```

`lanes` (what the caller knows about this machine):
`{ lead: { agent, model, concurrency, price }, child: { agent, model, concurrency, price }, runConcurrency }` where `price` is `{ inPerM, outPerM }` in USD per million tokens, or `null` for a subscription or local lane (cost 0).

### The preview object

```js
{
  goal,                       // area.goal of the first lead, or null
  leads: [{ id, scope: [folders], maxJobs }],
  jobs: { leads, expectedChildren, maxChildren },
  lanes: [{ agent, model, role: 'lead' | 'child', jobs, costUsd }],
  estimate: {
    costUsd,                  // point value, after calibration, rounded to 4 decimals
    costRange: [low, high],   // low = 0.5 x point; high = point x (maxChildren / expectedChildren), at most 5 x point
    tokens,                   // input + output, whole number
    minutes,                  // wall time, one decimal
    peakConcurrency,          // whole number, at least 1
    calibrated: boolean,      // true when a calibration ratio was applied
  },
  budget: { maxUsd, maxTokens },
  risks: [ { code, message } ],
}
```

Rules:
- Leads are the manifest jobs with `type === 'lead'`. A manifest with none is estimated as plain jobs: each job counts as a child (no lead phase), `expectedChildren = maxChildren = jobs.length`.
- `expectedChildren = leads x childrenPerLead`, where `childrenPerLead` is `calibration.childrenPerLead` when present, else the prior; clamped to `1..area.maxJobs` per lead. `maxChildren = sum of area.maxJobs`.
- Tokens and cost: leads use `PRIORS.lead`, children `PRIORS.child`; cost = tokens x the lane's price (0 when `price` is null), then x `calibration.costRatio` (default 1).
- Minutes: lead phase = `PRIORS.lead.seconds`; child phase = `ceil(children / childParallel) x PRIORS.child.seconds`, where `childParallel = min(runConcurrency, lanes.child.concurrency, max(1, children))`; total = (lead + child phase) / 60 x `calibration.timeRatio` (default 1).
- `peakConcurrency = max(1, min(leads x (area.concurrency ?? 1), lanes.child.concurrency, children))` when there are leads; else `min(manifest.concurrency ?? 1, lanes.child.concurrency, children)`.
- A lane entry is listed once per role with its job count and cost share.
- Risks, each `{ code, message }`:
  - `sensitive-folder`: a lead scope or a job path whose any segment is `.env`, starts with `.env.`, or (case-insensitive) is one of `secrets`, `credentials`, `.ssh`, `.aws`, `.gnupg`, `private`, `keys`.
  - `big-delete`: more than 20 paths in the sum of all jobs' `deletes`.
  - `over-budget`: the point estimate or the high end of the range is above `budget.maxUsd` (say which); `over-tokens` likewise for `budget.maxTokens`.
  - `many-jobs`: `maxChildren` above 100.
  - `deletes-unknown`: when there are leads (children are written at run time, so deletes and sensitive files in them cannot be seen yet).
- `now` is a function returning milliseconds; it is used for nothing else than future-proofing, tests may omit it.

### Calibration

`.swarm/project/estimates.json`: `{ "runs": [{ "id", "estimate": { costUsd, minutes, children? }, "actual": { costUsd, minutes, children? }, "at" }], "costRatio", "timeRatio", "childrenPerLead" }`.

`recordActual` appends the run (newest last, at most 20 kept) and recomputes: `costRatio` and `timeRatio` = median of `actual / estimate` over the runs where both numbers are finite and the estimate is above 0, each clamped to `0.1..10`; `childrenPerLead` = median of `actual.children / leads` when the runs carry `leads` and `children` (rounded, at least 1). A ratio with no usable runs stays 1 (or absent for `childrenPerLead`). An estimate whose actual cost or minutes is not a finite number is recorded but ignored for that ratio. Note: `estimate` stored in a run is the uncalibrated-then-calibrated final value shown to the owner, so the ratio is applied on top of the raw prior estimate; to avoid compounding, `recordActual` divides the stored estimate by the `costRatio` / `timeRatio` that was applied when it was shown (the stored object has `appliedCostRatio` and `appliedTimeRatio`, default 1).

### Plans on disk

`.swarm/plans/<id>.json`: `{ id, goal, createdAt, head, hash, flags, manifest, preview }`. `id` matches `^[a-z0-9][a-z0-9-]{5,60}$`. `savePlan` uses `safeWritableDir` and `assertRegularOrMissing` from `tools/journal.mjs`, writes a temp file opened `O_EXCL | O_NOFOLLOW` and renames it; it refuses to overwrite an existing plan id. `loadPlan` verifies `hash === planHash(manifest)` and throws `plan-invalid: hash` when someone edited the manifest, `plan-not-found: <id>` when missing, and `plan-invalid: id` for a bad id (never path traversal).

### Text

`formatPreview` prints: the goal; `Leads: N (scopes: a, b, c)`; `Jobs: about X (at most Y)`; one line per lane (`anthropic claude-haiku-5-5: 40 child jobs, about $0.12`); `Cost: about $A (range $L to $H)`, with `(subscription lanes are not counted)` when any lane has no price; `Time: about M min`; `Peak concurrency: P`; `Budget: $B, T tokens`; then `Risks:` with one line each, or `Risks: none seen`. Control characters in goal and folder names are replaced with spaces.

## CLI behavior (by hand in swarm.mjs)

- `swarm plan "GOAL" [--leads N|auto] [--max-jobs N] [--concurrency N] [--max-usd N] [--max-tokens N] [--json]`: builds the manifest as `go` does, prints the preview and `plan saved: <id>`; changes nothing else.
- `swarm go "GOAL"`: prints the same preview, then `Run? [y/N]`. Only `y`/`yes` runs it. `--yes` skips the question. Without a terminal, `--yes` is required, and `--yes` without a terminal also needs `--max-usd` (or `--plan`).
- `swarm go --plan ID`: runs exactly the saved manifest with its saved flags; refuses (`plan-stale`) when the git HEAD changed since the plan was made unless `--accept-stale`; refuses when the hash does not match.
- After a goal run, the estimate and the actuals (cost, minutes, child count) are recorded with `recordActual` and the result shows `estimate vs actual`.

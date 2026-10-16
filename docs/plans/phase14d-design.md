# Phase 14d design: the rented-gpu lane

A lane for any OpenAI-compatible endpoint (vLLM or SGLang) that we spin up ourselves in the cloud, for example one 8x H100 node serving an open model. **Nothing is rented by this phase; it only adds the lane, its spend guard and a runbook.** Contract for `tools/rented.mjs` (plain ESM, no dependencies); the wiring (lane agent `rented`, adapter, budget, admission, router, doctor) is done by hand.

The lane's agent name is `rented`. It is never chosen by automatic routing: a job uses it only with `agent: "rented"`.

## Config (machine config, `rentedGpu`)

```json
"rentedGpu": {
  "name": "h100-node",
  "endpoint": "https://203.0.113.9",
  "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
  "keyItem": { "service": "project-swarm", "account": "rented.api_key" },
  "hourlyUsd": 24.5,
  "maxHoursPerRun": 3,
  "concurrency": 64,
  "dailyUsd": 80,
  "trusted": false
}
```

The API key is read from the Keychain item (`keyItem`), never from the config file.

## 1. `tools/rented.mjs`

```js
export const RENTED_DEFAULTS = Object.freeze({ maxHoursPerRun: 4, concurrency: 32, minBillableMinutes: 1, warnAt: 0.8, trusted: false, keyItem: { service: 'project-swarm', account: 'rented.api_key' } })
export function validateRentedConfig(raw)   // -> { config, errors }   config is null when there are errors
export function createRentalMeter({ hourlyUsd, maxHours, minBillableMinutes = 1, now = Date.now })
//   -> { open(), close(), isOpen(), usd(), hours(), snapshot() }
export function rentalDecision({ meter, config, budget, runUsd, laneTodayUsd, warnAt })
//   -> { decision: null | { reason, message, spent, cap }, warning: null | string }
export function rentedSensitiveOk(config, job)   // -> boolean
export function formatRentalSummary(meter, config)   // -> one line
```

### validateRentedConfig(raw)
- `raw` must be a plain object with only these keys: `name`, `endpoint`, `model`, `keyItem`, `hourlyUsd`, `maxHoursPerRun`, `concurrency`, `dailyUsd`, `trusted`. Unknown keys are errors.
- `endpoint`: a string URL with no username, password, query or hash and a path of `/` or `/v1`; `https:` required, `http:` only for a loopback host (`127.0.0.1`, `[::1]`, `localhost`). The normalized endpoint is the origin.
- `model`: required, matches `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$`.
- `hourlyUsd`: a finite number above 0 and at most 1000, required. `maxHoursPerRun`: a finite number above 0 and at most 168 (default 4). `concurrency`: an integer 1 to 2048 (default 32). `dailyUsd`: a finite number above 0 (default `hourlyUsd x maxHoursPerRun`, rounded to 2 decimals). `trusted`: boolean (default false). `name`: at most 40 characters of `[A-Za-z0-9 ._-]` (default `rented`). `keyItem`: `{ service, account }`, both non-empty strings of at most 80 characters without control characters (default from `RENTED_DEFAULTS`).
- The normalized config adds `chatUrl` (`<origin>/v1/chat/completions`), `modelsUrl` (`<origin>/v1/models`) and `adaptive: { start: min(4, concurrency), min: 1 }`.
- All errors are collected (one string each, like `rentedGpu.hourlyUsd: must be a number above 0`); no error text contains the endpoint's credentials (there are none by rule).

### createRentalMeter
The meter counts the time the node was needed by a run: from the first `open()` until `close()` (or until now while open), at `hourlyUsd` per hour, with a minimum of `minBillableMinutes` once opened.
- `open()` records the start time on the first call and is a no-op after; `close()` records the end once; both are idempotent. After `close()`, `usd()` and `hours()` stop growing.
- `hours()` = elapsed hours (0 before `open`); `usd()` = `hourlyUsd x max(hours(), minBillableMinutes / 60)` once opened, 0 before, rounded to 4 decimals. A `now` that goes backwards never makes elapsed time negative.
- `snapshot()` returns `{ open, startedAt, endedAt, hours, usd }` (ISO strings or null) and survives `JSON.stringify`.

### rentalDecision
Called before each rented job is launched. `runUsd` is the run's spend on everything except the rental; `laneTodayUsd` is today's spend on the rented lane except this run's rental, from other runs. `budget` is the resolved budget (`budget.maxUsd`, `budget.lanes.rented.dailyUsd`). `rental = meter.usd()`.
- A run with no USD cap (`budget.maxUsd` null or undefined) is refused: `{ reason: 'run-cap', message: 'spend-cap: the rented lane needs a run USD cap (--max-usd)', spent: 0, cap: null }`.
- `reason: 'rental-hours'` when `meter.hours() >= config.maxHoursPerRun`: message `spend-cap: rented lane open for X.XX of Y hours (maxHoursPerRun)`.
- `reason: 'run-cap'` when `runUsd + rental >= budget.maxUsd`; `reason: 'lane-cap'` when `laneTodayUsd + rental >= budget.lanes.rented.dailyUsd` (falling back to `config.dailyUsd`). Messages follow the existing form `spend-cap: run spent $X.XX >= maxUsd $Y.YY` / `spend-cap: lane rented spent $X.XX today >= dailyUsd $Y.YY`. The first matching reason in the order hours, run-cap, lane-cap wins. A job is therefore launched only while every cap still has room; running jobs are never killed.
- `warning` (only when there is no decision): the highest of the three ratios (run `(runUsd + rental) / maxUsd`, lane `(laneTodayUsd + rental) / dailyUsd`, hours `hours / maxHoursPerRun`) at or above `warnAt` (default 0.8) gives `rented lane at NN% of the <run cap|lane day cap|hours limit> (...)`, otherwise null. `NN` is the whole percent.

### rentedSensitiveOk
True when `job.sensitive === false`, or when `config.trusted === true`. Anything else (including a missing config) is false: a rented server is trusted with sensitive jobs only when the owner marked it `trusted: true`.

### formatRentalSummary
`rented h100-node: 1.25 h, $30.63 (limit 3 h)`; `rented h100-node: not used` when the meter never opened.

## Wiring (by hand)

- Lane agent `rented` in `LANE_AGENTS`, `API_AGENTS`, `PAID_LANES`, the reserve and day-cap defaults; adaptive by default (`start` 4, `min` 1, ceiling `rentedGpu.concurrency`).
- Adapter: OpenAI-compatible chat completions to `chatUrl` with the Keychain key as a bearer token, `response_format` json_schema, the same envelope as the other API lanes; no tokens are priced (the cost is the meter).
- Spend: the meter's `usd()` counts in the run's totals and, through one entry in the machine-wide spend store (`rental/<run id>`), in the lane's day total across runs. `rentalDecision` runs in the admission step before each rented job; a decision holds the job like any cap; a warning goes into the run's warnings once per level. A run that uses the lane must have a run USD cap.
- Sensitivity: a rented job that is sensitive is allowed only when `rentedSensitiveOk`; otherwise validation refuses it (`sensitive-provider`). Never automatic routing.
- `swarm doctor rented`: checks the config, the Keychain item and that `modelsUrl` answers and lists the model.

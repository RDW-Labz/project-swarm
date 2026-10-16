# Phase 14c design: batch mode (Anthropic Message Batches)

Contract for `tools/batch.mjs` (plain ESM, no dependencies, every network and clock dependency injected). The wiring into `runManifest`, the CLI flags, config and the plan preview are done by hand. Anthropic Message Batches only; opt-in; same run, lane and machine-wide caps and reservations; sensitive rules unchanged (a batch job is an ordinary Anthropic-lane job that is sent later and priced at half).

## How it works

A batch job builds exactly the same Messages API request as any Anthropic-lane job. Instead of sending it at once, the run's **batch collector** gathers the requests of every batch job that is ready within a short window and submits them as one batch; each job waits for its own result. Results usually arrive within an hour and always within 24 hours. The job's reply, usage, cost recording and error handling are the normal code path: the collector hands back a `Response` shaped like the one the Messages API would have returned.

## 1. The collector (`tools/batch.mjs`)

```js
export const BATCH_LIMITS = Object.freeze({ maxRequests: 10000, maxBytes: 200 * 1024 * 1024, collectMs: 2000, pollMs: 30000, expireMs: 25 * 3600 * 1000 })
export const BATCH_DISCOUNT = 0.5
export function createBatchCollector({ fetchImpl, readKey, baseUrl = 'https://api.anthropic.com', version = '2023-06-01', now = Date.now, sleep, setTimer, clearTimer, limits = {}, onEvent })
// -> { submit(body, { id, signal }) -> Promise<Response>, cancelAll() -> Promise<void>, close(), status() -> { pending, batches: [{ id, requests, state }] } }
export function batchEligible(job, { all = false, types = [] } = {})   // -> boolean
export function batchCostUsd(standardUsd)                              // -> standardUsd * BATCH_DISCOUNT, rounded to 8 decimals; null stays null
export function estimateBatchSavings(standardUsd, { fraction = BATCH_DISCOUNT })  // -> { standardUsd, batchUsd, savedUsd }
```

### submit

- `body` is a Messages API request object (`model`, `max_tokens`, `system`, `messages`, `output_config`, ...). It is validated: a plain object with a string `model`, an integer `max_tokens` and a non-empty `messages` array, serialized size under 4 MiB; otherwise reject with `Error('batch-request-invalid')`.
- `id` (the job id) becomes the request's `custom_id`: characters outside `[A-Za-z0-9_-]` are replaced by `_`, cut to 56 characters, plus `-` and a per-collector counter so ids are unique (the whole id is at most 64 characters).
- Requests are held for `collectMs` after the first one arrives (timer from `setTimer`), then sent together. A flush also happens at once when `maxRequests` or `maxBytes` would be exceeded by the next request: the full set is sent and the new request starts the next batch. So 25,000 requests become three batches.
- A batch is created with `POST {baseUrl}/v1/messages/batches`, headers `x-api-key: <readKey()>`, `anthropic-version`, `content-type: application/json`, body `{ "requests": [{ "custom_id": ..., "params": <body> }, ...] }`. The key comes from `readKey()` each time and appears nowhere else (not in errors, events or status).
- If the create call answers a non-OK status, every request of that batch resolves with a `Response` carrying that status and the provider's JSON body (so rate limits, bad keys and invalid requests classify like a normal call). If the call itself throws (network), every request rejects with that error.
- After a successful create (the answer has `id` and `processing_status`), the collector polls `GET {baseUrl}/v1/messages/batches/{id}` every `pollMs` (using `sleep`) until `processing_status` is `ended`, or until `expireMs` has passed since creation (then every unresolved request resolves as expired, see below). Poll failures are tolerated up to 5 in a row (the next poll retries); the sixth rejects every unresolved request of that batch.
- When ended, the results are read from the answer's `results_url` (a GET with the same headers) as JSON lines `{ "custom_id", "result": { "type": "succeeded" | "errored" | "canceled" | "expired", "message" | "error" } }`. A line is matched to its request by `custom_id`; unknown ids and malformed lines are ignored; a request with no line resolves as `expired`.
- Resolution as a `Response`:
  - `succeeded`: status 200, `content-type: application/json`, body `JSON.stringify(result.message)`.
  - `errored`: the status for `result.error.type` (`invalid_request_error` 400, `authentication_error` 401, `permission_error` 403, `not_found_error` 404, `rate_limit_error` 429, `overloaded_error` 529, anything else 500); body `{ "type": "error", "error": result.error }`.
  - `canceled`: status 499 and `{ "type": "error", "error": { "type": "batch_canceled", "message": "batch request canceled" } }`.
  - `expired`: status 504 and `{ "type": "error", "error": { "type": "batch_expired", "message": "batch request expired before it was processed" } }`.
- `signal`: if it aborts before the request is sent, the request is dropped from the pending set and `submit` rejects with an `AbortError` (`name: 'AbortError'`). If it aborts after sending, `submit` rejects with an `AbortError` at once and the batch goes on; when every request of a sent batch has been aborted the collector cancels it (`POST .../cancel`, errors ignored).
- `cancelAll()` cancels every unfinished batch and rejects every unresolved request with an `AbortError`. `close()` stops all timers and polling without cancelling (a later `cancelAll` still can). After `close`, `submit` rejects with `Error('batch-closed')`.
- `onEvent({ type, ... })` is called (errors ignored) with `submitted` (`batchId`, `requests`), `polled` (`batchId`, `processing_status`, `counts`), `ended`, `canceled`; never with the key or request bodies.
- `status()` reports the number of requests waiting for the next flush and, per batch, its id, request count and `state` (`in_progress`, `ended`, `canceled`).

### batchEligible

`batchEligible(job, { all, types })` is true when ALL of: `job.agent === 'anthropic'`; `job.type !== 'lead'`; `job.batch !== false`; and one of: `job.batch === true`, `all === true`, or `types` includes `job.type` (a job with no `type` matches only by `all` or `job.batch === true`). Anything else false. It never throws on odd input (returns false).

## 2. Wiring (by hand)

- Opt-in: `swarm run --batch` and `swarm go --batch` turn it on for every eligible job; the manifest's `batch` (`true` or `{ "types": ["review", "docs", "test"] }`), a job's own `batch: true|false`, and the machine config `"batch": { "enabled": false, "types": [] }` do the same by type. Precedence: the job, then the flag, then the manifest, then the config.
- A batch job's `timeoutMs` is raised to 25 hours for its request (the job's own limit does not apply to a request that may wait); its cost is half of the standard price (`batchCostUsd`), recorded in the Anthropic ledger and the run totals; its reservation and cap checks use the standard price, so the caps are never looser. Run, lane and machine-wide caps apply exactly as for any Anthropic-lane job.
- Lead jobs are never batched. Cancelling a run cancels its batches. A run's state records `batch: true` and the batch id on each batch job.
- `swarm plan` shows the estimated saving when the child lane is Anthropic and batch would apply (`--batch` on plan, or by config), with the note that results can take up to 24 hours (usually under an hour).

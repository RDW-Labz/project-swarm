# Lanes and routing

A lane belongs to one agent. It has its own concurrency cap, request rate, backoff, and quota pause. The manifest's `concurrency` is a global cap shared by all lanes: 1–2048, default 2. A manifest accepts 1–5000 jobs. Increasing the global cap does not override a lane cap.

> "Hundreds at once" mostly comes from API workers, Hermes and remote machines. Subscription CLIs (Claude, Codex, Cursor) get rate-limited long before 100 parallel sessions, so each one gets its own lane cap. The global cap is capacity, not a target.

## Defaults

| Agent | Concurrency | Requests per minute | Routing model |
|---|---:|---|---|
| `hermes` | 1 | unlimited | `null` |
| `cursor` | 8 | unlimited | `null` |
| `codex` | 6 | unlimited | `null` |
| `claude` | 4 | unlimited | `null` |
| `qwen` | 32 | unlimited | `null` |
| `openai` | 32 | unlimited | `null` |
| `gemini` | 32 | unlimited | `null` |
| `ollama` | 32 | unlimited | `null` |
| `lambda` | 32 | unlimited | `null` |
| `openrouter` | 64 | unlimited | `null` |
| `anthropic` | 16 | unlimited | `null` |

Every lane defaults to `requestsPerMinute: null`, `backoff: { baseMs: 2000, maxMs: 300000, maxRetries: 5 }`, `pauseMs: 900000`, and `maxPauseMs: 900000`. A lane's `model` is used for automatic routing; explicit jobs keep their own model.

## Machine config and manifest overrides

Resolution starts with the defaults, merges machine config `lanes`, then merges manifest `lanes`. Fields merge independently, including each key inside `backoff`. For example, add this to the local machine config:

```json
{
  "lanes": {
    "hermes": { "model": "your-hermes-model" },
    "claude": { "concurrency": 3, "model": "sonnet", "backoff": { "baseMs": 4000 } },
    "openrouter": { "model": "your-provider/your-model", "requestsPerMinute": 60 }
  }
}
```

Then use this manifest:

```json
{
  "version": 1,
  "concurrency": 8,
  "lanes": {
    "claude": { "concurrency": 2, "backoff": { "maxRetries": 3 } }
  },
  "jobs": [{
    "id": "review",
    "agent": "auto",
    "sensitive": true,
    "prompt": "Review the supplied source. Return concise findings.",
    "context": ["src/example.mjs"],
    "outputs": []
  }]
}
```

Claude resolves to concurrency 2, base backoff 4000 ms, maximum backoff 300000 ms, and three retries. Replace the placeholder models and context path with available models and an existing file. Validation checks syntax, not model availability.

Unknown agents and fields refuse with `lanes-invalid`. Concurrency must be an integer 1–2048; `requestsPerMinute` is `null` or an integer 1–100000. Backoff `baseMs` is 1–600000, `maxMs` is at least `baseMs` and at most 3600000, and `maxRetries` is 0–20. Both pause fields are integers 1–86400000 ms. A lane model is `null` or matches `/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/`.

## Rate limits and quota pauses

Lane limits are machine-wide. Every run on this machine shares one lane file next to the shared install: `~/.project-swarm/lanes/lanes.json`, or `SWARM_LANES_DIR` when that is set. The file holds each lane's in-flight count and any rate-limit or quota pause. A lock keeps the counts exact, and a slot whose process has died is cleared on the next claim. A 429 or a quota pause in one run pauses that lane for every other run, including a lead's child runs and runs in other repositories. Deleting a project's `.swarm/` does not reset it. A run's own `concurrency` is still only that run's global cap.

Jobs wait for both global and lane capacity. When the global cap limits capacity, eligible waiters are served in arrival order across lanes. Each lane still serves its waiters in order; a blocked lane does not block another lane. A configured request rate counts acquisitions in the trailing 60000 ms. Workspace creation and context reads happen at dispatch; path and size validation stays up front.

HTTP 429 or a rate-limit error backs off the lane. A supplied `retryAfterMs` sets the delay; otherwise exponential backoff starts at `baseMs`, doubles for consecutive rate limits, and caps at `maxMs`, with a jitter factor from 0.5 to 1. API responses supply retry timing from `Retry-After` seconds or an HTTP date when valid. A successful attempt resets the consecutive rate-limit count.

A rate-limited job retries in a fresh workspace up to `backoff.maxRetries`. Those retries do not count as failures for routing. Exhausting the budget ends the job as `failed` with a `rate-limited:` error.

Quota exhaustion pauses only that lane until a valid future `resetsAt`, or for `pauseMs` if no usable reset is supplied. A rate limit never shortens a quota pause. HTTP 402 and quota or credit errors are quota signals. The attempt that hit quota retains its final status for explicit jobs; automatic jobs reroute. Queued jobs wait while the remaining pause is at most `maxPauseMs`; a longer pause ends them as `provider-limit` without spawning. Other lanes continue. A lane returns to `ok` when its backoff or pause ends.

Provider HTTP errors retain status and retry metadata, but their response body is never saved or echoed. Lane health and peaks are recorded in `state.lanes`; each job records its actual `lane`, `attempts`, and `rateLimitRetries`. Automatic jobs also record their selected `route`. State writes are coalesced for large runs.

## Snapshots

Every worker sees the project as it was when the run started. At run start, the runner hashes each distinct context, output, and resource file once, streaming the contents without keeping the bytes. At dispatch, copied files must match those hashes. A mismatch fails the affected job before spawning with `snapshot-changed: <file>`. Worktree jobs start from `state.baseCommit`.

## Automatic routing and fallback

Use `agent: "auto"` and omit `model`; supplying a model refuses with `auto-model-forbidden`. Configure non-null lane models first. The cheap lane order for code is **Anthropic (Haiku) → Cursor → Codex**, with Claude (subscription) last, after two failures. Hermes is not in that order: it runs only where a job type names it (`research`). OpenRouter runs only bookkeeping jobs (every output is a PR payload, changelog, metrics or `.swarm-manifests` file) that are `sensitive: false`. The order comes from the [lane benchmark](state/lane-benchmark.md). A job type tries its preset route first, without Claude, then the remaining cheap lanes in that order. Other agents still support explicit jobs. `validate` reports the current choice in `routes: [{ jobId, agent, model, reason }]`; dispatch resolves it again using current health.

The router picks the cheapest eligible healthy lane. It skips paused lanes and candidates that cannot accept the job's fields. If every remaining eligible lane is paused, it returns the first one with a reason naming the pause. Backoff alone does not remove a candidate. `tier: "expensive"` starts at Claude and still requires `tierReason`.

After two `failed` or `timeout` attempts on a lane for an automatic job, the router drops that lane only. Claude is eligible only when no cheap candidate remains and cheap lanes have collected at least two real failures. Paused cheap lanes wait and never trigger a jump to Claude. Each attempt gets a fresh workspace. `blocked`, `cancelled`, and rate-limit retries never count toward fallback. If no eligible lane remains, the job fails with `route-exhausted`. Explicit jobs do not automatically change agent or model.

Jobs are sensitive by default, including when `sensitive` is omitted. Only `sensitive: false` allows OpenRouter, OpenAI, Gemini, or Lambda. Explicit OpenAI, Gemini, and Lambda jobs without it refuse with `sensitive-provider`: `Job <id>: <agent> only gets jobs that set sensitive: false`. Explicit OpenRouter jobs without `sensitive: false` refuse with `sensitive-openrouter`: `Job <id>: OpenRouter only gets jobs that set sensitive: false`. Output ownership, explicit file lists, hash-checked integration, and all existing path and secret refusals still apply. See the [manifest reference](manifest-reference.md) for job fields.

## Haiku rate limits and lane concurrency

Anthropic rate limits for claude-haiku-5-5 at our tier, read from the response headers of a 1-token call on 2026-10-16: 10,000 requests per minute, 10,000,000 input tokens per minute, and 2,000,000 output tokens per minute (12,000,000 tokens per minute in all).

Measured Haiku task profile (the 11-task comparison): about 9.6k input and 2.7k output tokens per task, about 11.8 s per task. One agent therefore sends about 5.1 requests per minute, 49k input tokens per minute, and 13.6k output tokens per minute.

Maximum agents by each limit: requests 1,960; input tokens 204; output tokens about 147 (the binding one). That gives about 147 Haiku agents at full speed and about 100 with a 70 percent margin.

Anthropic estimates output tokens per minute from each request's `max_tokens` when it starts and corrects the estimate when it ends. So agents times requests per minute times `max_tokens` must stay under 2,000,000. At the default 8192 that is about 47 agents for fast 12 s tasks; at 4096 about 95; at 2048 about 190.

The lane's default concurrency is 64 and its default `max_tokens` is 4096 (owner decision): 64 agents times about 5.1 requests per minute times 4096 is about 1.34 million of the 2 million output tokens per minute (67 percent). A job that needs more sets `maxOutputTokens`; an answer cut off at the limit is retried once at double (8192, never above 16000), checked against the job's own spend caps with the first call counted and billed. Adaptive concurrency stays on, so 429 answers still shrink the lane and it grows back. Raise the lane with `lanes.anthropic.concurrency` in the machine config only while agents times 5.1 times `max_tokens` stays under 2,000,000 (at 4096 that is about 95 agents).

Prompt caching: ticket jobs from `swarm go --scope` list their contract files in `cacheContext`, so the contract is sent as a cached shared block first and each ticket's own text last; cached reads are billed at the cache-read rate. Caching only starts above the model's minimum size, so small contracts are sent plain.

A worker that returns the same file both whole (`files`) and as `edits` no longer fails the job: the whole file wins and the edits for it are dropped.

## Which lane gets a ticket

Router rule (owner decision):

- Haiku (anthropic) is the default worker lane.
- The rented GPU lane is used by automatic routing only when at least 700 non-sensitive tickets are ready in the run, and the job carries its contract. The ready count is the number of auto jobs in the manifest. The threshold is `RENTED_MIN_READY`, overridable with `lanes.rented.minReady`.
- Codex takes hard tickets: a job with `hard: true` goes to Codex first.
- Sensitive jobs never go to the rented lane.
- One failure on the rented lane escalates to Haiku, then Codex.

## The rented lane

`rented` is the lane for small, fast coding models served by vLLM on a GPU node you rent, one server per GPU; requests are spread over the servers. It has no routing model of its own: it is routable only while `swarm gpu up` has a live session, and then only for jobs marked `sensitive: false` that carry their exact files, the manifest's contract file and acceptance tests; one failure sends the job to Haiku, then Codex. Its cost is by the hour. See [rented GPU](rented-gpu.md).

## Adaptive lanes

`"adaptive": true` (or `{ "start": 4, "min": 2 }`) on a lane lets it find its own limit instead of trusting `concurrency`, which stays the ceiling. The lane starts at `start` requests in flight (default 8, at most the ceiling). Every window of clean successes (as many as the current limit) opens one more slot; a 429 halves the limit, never below `min` (default 1). The provider's `retry-after` still pauses the lane as before. Other failures leave the limit alone. The limit is per run (the machine-wide file still counts the slots every run holds), and `swarm status` shows it as `limit` in the lane's health. Off by default.

```json
{ "lanes": { "anthropic": { "concurrency": 200, "adaptive": true } } }
```

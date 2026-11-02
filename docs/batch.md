# Batch mode (Anthropic Message Batches)

The Anthropic lane can send jobs that do not need to finish fast to the Message Batches API, which costs **half** the standard price. Results usually arrive within an hour and always within 24 hours. Opt-in only, Anthropic lane only.

## Turning it on

| Where | How |
| --- | --- |
| One run | `swarm run MANIFEST --batch`, `swarm go "GOAL" --batch`, `swarm plan "GOAL" --batch` |
| A manifest | `"batch": true` (every eligible job) or `"batch": { "types": ["review", "docs", "test"] }` |
| One job | `"batch": true` or `"batch": false` on the job |
| The machine, per project | `"batch": { "enabled": true, "projects": ["/path/to/project"], "types": ["review", "docs", "test"] }` in `~/.config/project-swarm/config.json`. `enabled` applies only to the project folders listed in `projects` (`types` empty means every eligible job); a project that is not listed never batches by default, so a sensitive project such as BinGo stays off until you add it. `--batch` and a manifest's own `batch` still work anywhere |

The job wins over the flag, the flag over the manifest, the manifest over the config. A job is eligible when it runs on the Anthropic lane and is not a lead.

## What does not change

- **Caps and reservations.** A batch job is an ordinary Anthropic-lane job: the run cap, the lane day cap and the machine-wide caps ($500 total, $20 a day, $5 a job) all apply. The reservation and the pre-request check use the **standard** price, so a cap is never looser than without batch; the cost that is recorded (run totals, the Anthropic ledger, `rollup`) is the half price actually billed.
- **Sensitive rules.** Batch is allowed on sensitive projects under the same rules as the Anthropic lane (never secrets; a job with `privateData` is never batched), but it is **opt-in per project and off by default** (see `batch.projects` above). Keep it off for BinGo: **batch results stay on Anthropic's servers for up to 29 days**, longer than an ordinary request, so only batch a sensitive project when you accept that.
- **Results.** The reply, files, usage and errors come back through the normal path. A batch request that fails, is canceled or expires fails that job; a retry goes through batch again unless the job sets `"batch": false`.
- **Ledger.** Because a batch request can spend for up to a day before its answer comes back, its worst case is written to the Anthropic ledger when it is sent (so the next job's cap check sees it) and settled to the real half price when the answer arrives. If no answer ever arrives (cancelled, expired, the run was killed) the worst case stays as spent: the caps err on the side of counting.

## What changes

- Jobs are gathered into batches: requests are held until 2 seconds pass with no new request (never longer than 15 seconds in all), then sent together; up to 10,000 requests or 200 MB per batch, more become more batches.
- A batch job does not hold a lane or global concurrency slot while it waits, so a big fan-out can gather in one batch. (Spend is still reserved and capped before it is sent.)
- The job's own `timeoutMs` does not apply to the wait (up to 25 hours). Cancelling the run cancels its batches. The run state marks each batch job with `batch: true`.
- `swarm plan` shows `Batch: saves about $X of $Y (50% on the child jobs); results can take up to 24 hours (usually under an hour).` when the children go to the Anthropic lane and batch applies.

## If something goes wrong

- The batch id and request id of each batch job are saved on the job in the run state (`batchId`, `batchCustomId`). If the process is killed hard, batches already sent keep running (and billing) at Anthropic; cancel them from the Anthropic console with those ids. A normal cancel (Ctrl-C, `swarm cancel`) cancels the batch for you.
- A cancelled request that had already been processed is still billed by Anthropic, but its usage is not read back; the reservation covers it.
- `--batch` is remembered on a paused run, so `swarm resume` keeps batching.

## When not to use it

Anything on the critical path (an orchestrator waiting on one job), anything an `after` chain needs quickly, and anything you want to watch finish. It suits review, docs and test sweeps and other work that can wait.

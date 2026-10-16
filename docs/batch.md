# Batch mode (Anthropic Message Batches)

The Anthropic lane can send jobs that do not need to finish fast to the Message Batches API, which costs **half** the standard price. Results usually arrive within an hour and always within 24 hours. Opt-in only, Anthropic lane only.

## Turning it on

| Where | How |
| --- | --- |
| One run | `swarm run MANIFEST --batch`, `swarm go "GOAL" --batch`, `swarm plan "GOAL" --batch` |
| A manifest | `"batch": true` (every eligible job) or `"batch": { "types": ["review", "docs", "test"] }` |
| One job | `"batch": true` or `"batch": false` on the job |
| The machine | `"batch": { "enabled": true, "types": ["review", "docs", "test"] }` in `~/.config/project-swarm/config.json` (`enabled` with no `types` means every eligible job) |

The job wins over the flag, the flag over the manifest, the manifest over the config. A job is eligible when it runs on the Anthropic lane and is not a lead.

## What does not change

- **Caps and reservations.** A batch job is an ordinary Anthropic-lane job: the run cap, the lane day cap and the machine-wide caps ($500 total, $20 a day, $5 a job) all apply. The reservation and the pre-request check use the **standard** price, so a cap is never looser than without batch; the cost that is recorded (run totals, the Anthropic ledger, `rollup`) is the half price actually billed.
- **Sensitive rules.** Unchanged: the job goes to the same lane it would have gone to, just later.
- **Results.** The reply, files, usage and errors come back through the normal path. A batch request that fails, is canceled or expires fails that job, and a retry can run it without batch.

## What changes

- Jobs are gathered into batches: requests are held until 2 seconds pass with no new request (never longer than 15 seconds in all), then sent together; up to 10,000 requests or 200 MB per batch, more become more batches.
- A batch job does not hold a lane or global concurrency slot while it waits, so a big fan-out can gather in one batch. (Spend is still reserved and capped before it is sent.)
- The job's own `timeoutMs` does not apply to the wait (up to 25 hours). Cancelling the run cancels its batches. The run state marks each batch job with `batch: true`.
- `swarm plan` shows `Batch: saves about $X of $Y (50% on the child jobs); results can take up to 24 hours (usually under an hour).` when the children go to the Anthropic lane and batch applies.

## When not to use it

Anything on the critical path (an orchestrator waiting on one job), anything an `after` chain needs quickly, and anything you want to watch finish. It suits review, docs and test sweeps and other work that can wait.

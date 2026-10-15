# Throughput

What one Mac does with thousands of jobs, measured with `bench/throughput/stress.mjs` (stub API jobs through `runManifest` with a fake provider):

```
node bench/throughput/stress.mjs --jobs 2000 --concurrency 512 --latency 5
node bench/throughput/stress.mjs --jobs 1000 --concurrency 1000 --latency 20000
```

| Run | Before (1.70.0) | After (1.71.0) |
| --- | --- | --- |
| 500 jobs, 5 ms requests | 16 s | 1.2 s |
| 1000 jobs | 301 s | 2.5 s |
| 2000 jobs | over 10 minutes (stopped) | 6.8 s, peak memory 177 MiB |
| 1000 requests in flight at once (20 s each) | never above 4 in flight | all 1000 in flight, 23 s in all, peak memory 148 MiB |

## What was slow (found by profiling, not guessed)

- **API jobs took a local host slot.** The local host's capacity is for workers that run code, but every API job claimed one too, so a run was never more than about 4 requests deep however high the lane limit was. API jobs no longer claim a host.
- **The machine-wide lane file was re-read and every slot's process re-probed on each look** (status snapshots read it eleven times, and every waiting job asked about pauses on its own). Looks now reuse the last read until the file changes; a pump always reads fresh; waiting jobs are checked once per lane.
- **Every in-flight job polled the cancel file** (an API job every 100 ms): a thousand jobs were ten thousand file reads a second. One read now serves everyone for 250 ms.
- **The output-overlap check compared every pair** of outputs (4 million comparisons at 2,000 jobs). It is now one set lookup per parent folder.
- **Per-job live-run scans and git calls**: the repository identity is remembered for 2 seconds and the live-run list is read once per manifest.
- **State writes.** A save rewrote the whole state file and each save took longer as the run grew. Saves now wait about eight times as long as the last one took (20 ms to 2 s), so roughly a tenth of the time goes to saving however big the run is; state over 200 jobs is written compact; and a job waits only for the save that covers its own change, not for the writer to go quiet.

Limits raised: manifest, lane and global concurrency now go to 2048 (were 512).

## Added

- **Adaptive lanes** (`"adaptive": true`, see [lanes](lanes.md)).
- **Prompt caching** for shared context on the Anthropic lane (`cacheContext`, see [manifest reference](manifest-reference.md)).

## Not built, and why

- **An append-only state log or SQLite.** The measured cost was the write frequency and size, not the file format; with the changes above, state saving is about a tenth of the run and does not grow with it. If a later scale test shows otherwise, this is the next step.
- **Copy-on-write workspaces.** API jobs copy a handful of small files; worktree jobs use git worktrees. Neither was a cost in the profile.
- **Batch mode (Anthropic Message Batches).** It is a new paid surface with its own polling and result handling; it waits for the owner's go-ahead.
- **More hosts.** Waits for the dev2 link.

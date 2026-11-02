# Field report

Costs and counts from one production team that used Project Swarm as its only
build workforce: 10 repositories, about 20 orchestrator sessions over four days,
each session handing off after 10 build dispatches. Operational numbers, not a
benchmark. Models are grouped by tier (see [orchestration](orchestration.md)).

## Runs and jobs

| Measure | Count |
| --- | ---: |
| Runs | 208 |
| Runs complete | 196 |
| Runs failed | 7 |
| Runs cancelled | 4 |
| Jobs | 230 |
| Jobs complete | 217 |

## Jobs and spend by tier

| Tier | Jobs | Reported spend |
| --- | ---: | ---: |
| Cheap | 65 | about $6 |
| Mid | 126 | about $213 |
| Expensive (per-token) | 9 | about $15 |
| Expensive (flat plan) | 20 | $0 reported |
| Tier not recorded | 10 | about $9 |
| **Total** | **230** | **about $243** |

## Typical cost per job

| Job type | Cost |
| --- | --- |
| Cheap bookkeeping job | $0.02–$0.20 |
| Mid clear-contract build job | $0.80–$2.70 |
| Expensive shell-heavy job (flat plan) | 7–20 minutes, 100–200k tokens |

## Research, checks and delivery

| Measure | Count |
| --- | ---: |
| Prior-art scout runs per large task | 2 |
| Multi-area sweeps | 2 (12 areas each; $0.53 and $0.23) |
| Sweep areas that returned zero candidates | 3 |
| Hand-written mutation scripts | 28 |
| PRs merged in the final week | about 50 |
| Lessons logged | 79 |
| Lessons folded into earlier code or guidance | 18 |
| Lessons still open | 5 |

Approximate subtotals may not add exactly to the total. The run counts and the
final-week PR count cover different windows. Missing cost data is shown as
reported, not inferred.

How 1.15.0 was checked, and what is still open: [verification](verification.md).

The 1.15.0 follow-up records eight more [release lessons](lessons.md)
(entries 10–17), including a mutation-tooling pointer, a repo-rename hint on
`ship`, base-commit flake detection, and a job-declared result file.
The historical costs and counts above remain observations from the original
report; they are not new release measurements.

## Scale test (1.61.0)

`swarm scale` ran 500 stub jobs on this machine (macOS, Node 22.23.3, 10 cores). The adapter answered locally. No model was called. Spend was $0. Concurrency was 500, and the run's own peak was 500.

| Measure | Value |
| --- | ---: |
| Jobs complete | 500 |
| Spend | $0 |
| Peak RSS | 130.9 MiB (137,232,384 bytes) |
| Peak CPU | 44.6% of 10 cores |
| CPU time | 1,488 ms user, 1,661 ms system |
| Run time | 10.1 s |
| Queue latency p50 / p95 / max | 119 ms / 120 ms / 120 ms |
| Merge | 500 files in 971 ms (514.9 files/s) |

## Live test, 50 real jobs (1.61.0)

50 jobs ran on a throwaway repo with `budget.maxUsd` 2: each job read a 50-line `input.txt` and wrote one sentence restating one line. All 50 completed and all 50 outputs were non-empty. Run time was 1 m 33 s at concurrency 8. Hermes was skipped (dev2 was unreachable). Lanes used were the Anthropic API, OpenRouter, Cursor, Codex, and the Claude subscription.

| Tier | Lane / model | Jobs | Done | Reported cost | Tokens | Avg time |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| cheap | anthropic / claude-haiku-5-5 | 12 | 12 | $0.0038 | 30,007 | 2.7 s |
| cheap | openrouter / openai/gpt-oss-20b | 10 | 10 | $0.0008 | 15,628 | 10.2 s |
| cheap | cursor / composer-2.5 | 8 | 8 | subscription, none reported | - | 38.3 s |
| mid | anthropic / claude-sonnet-5-5 | 6 | 6 | $0.0368 | 14,890 | 3.6 s |
| mid | codex / gpt-6.1-sol | 8 | 8 | subscription, none reported | 42,237 | 13.8 s |
| expensive | claude (subscription) / opus | 6 | 6 | $0.2964 | 5,965 | 14.1 s |
| **All** | | **50** | **50** | **$0.3378** (34 jobs reported a cost) | 108,727 | |

- Cost per job, where reported: Haiku $0.0003, OpenRouter gpt-oss-20b $0.00008, Sonnet $0.0061, Claude Opus $0.049. Cursor and Codex do not report a dollar cost.
- The Claude Opus figure is the CLI's own reported cost on a subscription, not a bill. The API lanes (Anthropic and OpenRouter) cost $0.0414 together.
- This is a trivial one-sentence job. Cost scales with real context and output; treat the numbers as a floor, not a forecast.

An earlier attempt at the same 50 jobs failed after 14 and cancelled the rest. Two causes, both fixed before the run above:

- The unreachable `dev2` ssh host had been given jobs and returned `host-exit: 255`, which cancelled the run. The passing run pinned `hosts` to local only. A host that is down at the start still takes jobs until its heartbeat marks it dead; that is worth hardening.
- Three of the first 12 Anthropic Haiku jobs returned the same path in both `files` and `edits`, which the envelope validator rightly rejects. The Anthropic request now tells the model to return `edits: []` unless one large output needs a single change, and the 12 Haiku jobs in the passing run all completed. A failed Anthropic job also used to be booked at its $0.022 reservation instead of its real cost (about $0.0003); it now records the real cost.

The Hermes lane was not tested. It will be re-run when dev2 is reachable and a model is chosen.

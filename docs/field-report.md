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

A live run of 50 real jobs across every lane was not done. `doctor all` on this machine showed cursor, hermes, and qwen unavailable; openai, gemini, lambda, and openrouter unconfigured; codex's sandbox probe failed; claude's login was not checked. There is no cost-per-tier number from a live run.

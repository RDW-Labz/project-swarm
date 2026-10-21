# Node: Mac mini (measured, zero-quota)

Generated 2026-10-21T20:40:09.644Z by an idle-menu command (no model calls, no network). Re-run to refresh.

## Hardware

| Field | Value |
|---|---|
| host | Mac |
| model | Mac16,10 |
| cpu | Apple M4 |
| logicalCores | 10 |
| perfCores | 4 |
| effCores | 6 |
| totalRamGb | 24 |
| macos | 15.3.1 |
| node | v20.19.4 |
| load | 49.93 / 28.9 / 21.24 |

## Memory: real free vs Node

| Measure | GB |
|---|---|
| Node os.freemem() | 0.3 |
| vm_stat free pages | 0.07 |
| vm_stat free+inactive+speculative+purgeable | 4.45 |
| memory_pressure free (37%) | 8.88 |

Node undercounts usable memory by about 29.6x on macOS (it reports only free pages, not reclaimable cache). swarm's default limit formula gives **4** with Node's number and **9** with real free memory; the configured machineConcurrency is **8**.

## Lane throughput (last 14 days, every registered project on this machine)

| Lane | Jobs | Pass % | Median min | p95 min | Jobs/hour/slot |
|---|---|---|---|---|---|
| codex | 221 | 81 | 3.37 | 14.06 | 17.81 |
| claude | 118 | 96.6 | 1.97 | 5.21 | 30.51 |
| cursor | 39 | 92.3 | 1 | 5.32 | 59.96 |
| hermes | 32 | 84.4 | 0.33 | 2.5 | 182.55 |
| anthropic | 11 | 72.7 | 0.05 | 0.16 | 1116.97 |

## Slot use per project (last 14 days)

Fill = jobs per run / machine limit (8), capped at 100%.

| Project | Runs | Jobs | Avg fill % | Median peak concurrency |
|---|---|---|---|---|
| atlas-seafloor | 100 | 130 | 16 | 1 |
| project-swarm-1 | 39 | 50 | 16 | 1 |
| atlas-seafloor-ops | 14 | 18 | 16 | 1 |
| Marketing agency | 185 | 223 | 15 | 1 |

## Local claim race (O_EXCL lease file) and event append latency

| Contenders | Trials | Exactly one winner | Median claim µs | p95 claim µs |
|---|---|---|---|---|
| 2 | 20 | true | 4156 | 10434 |
| 8 | 20 | true | 5288 | 24860 |
| 32 | 20 | true | 6281 | 66840 |

Atomic write+rename (event append baseline, 200 samples): median 116 µs, p95 443 µs.

Local numbers are a floor: R-048 targets (ticket visible on both machines within 3 s, one lease holder) are cross-machine and need the cluster queue; see bench/cluster/fixtures.

# Memory-aware limits

Swarm reads live RAM and swap (via `readMachine` in `tools/autotune.mjs`) and classifies pressure:

| Level | When |
| --- | --- |
| **hard** | Available RAM under 3 GB, swap used over 4 GB, or swap use over 60% of total |
| **soft** | Available RAM under 6 GB, or swap used over 1 GB |
| **ok** | Otherwise |

## Config keys

- `jobMemoryGb` (or `machine.jobMemoryGb`) — estimated GB per concurrent job for projection (default `0.6`).
- `machineConcurrency` — fixed cap or `auto` for the machine-wide job limit tuner.

## What is held and why

- **Autopilot `start-ready` at hard pressure** — does not spawn `go --scope`; returns `held-memory` and logs one line so tickets stay ready for the next pass instead of piling on workers when the host is out of headroom.
- **Autopilot wave size** — `maxJobs` from config is capped by `effectiveMachineLimit` (projection and pressure). At soft pressure, `startScope` lowers `--max-jobs` to the memory-aware ceiling.
- **Integrate `tests` check** — for `node --test` argv only, sets `--test-concurrency` from pressure (1 hard, 2 soft, else up to 4). At hard pressure the runner may wait up to five minutes (15 s polls) for soft pressure; if still hard it runs once at concurrency 1 and records `ran under memory pressure`.

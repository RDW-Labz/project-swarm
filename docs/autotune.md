# Machine worker-limit autoscaling

Project owners can let the swarm pick how many machine workers run at once instead of fixing a number. The logic lives in `tools/autotune.mjs`: a hardware default, a live tuner, per-lane caps after rate limits, a state file location, and board text.

## `machineConcurrency: auto`

**Planned:** wiring so `machineConcurrency` can be set to `auto` and the runtime uses the tuner below. This module exports the tuning primitives only; it does not read project config or start workers yet.

## Hardware default (starting ceiling)

Before the live tuner runs, `defaultLimit` sets the first ceiling from the machine snapshot:

- **By CPU:** `cores × 2`
- **By RAM:** `floor((freeRamGb − 4) / 0.5)` (reserves 4 GB; each worker slot assumes ~0.5 GB free)
- Take the **minimum** of those two, then **clamp between 4 and 64**

Examples: 10 cores and 20 GB free → 20; 8 cores and 6 GB free → 4 (RAM-bound).

`readMachine` supplies `cores`, `freeRamGb`, `totalRamGb`, and `cpuPercent` (two `os.cpus()` samples ~100 ms apart, unless tests inject a CPU sampler).

## Live tuner (raise and backoff)

`createTuner` holds the current limit (defaults: min **4**, max **64**, step up **1**, backoff factor **0.75**). Each tuning tick changes the limit by **at most one step**.

**Raise** when there is no stress, `cpuPercent < 80`, `freeRamGb > 4`, `waiting > 0` (ready work queued), and `limit < max` → limit increases by 1.

**Backoff** when any stress applies → `floor(limit × 0.75)`, never below min:

| Stress | Condition |
|--------|-----------|
| CPU | `cpuPercent ≥ 80` |
| RAM | `freeRamGb ≤ 4` |
| Lane rate limit | `rateLimitedLanes` is non-empty |

If nothing is waiting (`waiting ≤ 0`), the limit does not rise; the reason is `no-ready-tickets`. Stress reasons (`cpu`, `ram`, `lane-rate-limit`) win over idle-queue logic. `inUse` is passed through for display but does not change the math in this module.

## Per-lane caps (learned)

Separate from the global limit, `createLaneCaps` remembers a **cap per lane** (e.g. CI vs main):

- **Rate limit:** cap × 0.75 (floored), held for **10 minutes**, clean streak reset
- **Clean windows:** after the hold ends, **10 minutes** without rate limits allows cap **+1**, up to the lane’s **initial** cap never exceeded

State serializes as JSON (`version: 1`, `initial`, `min`, per-lane `cap`, `heldUntil`, `cleanSince`) via `toJSON` / `fromJSON`.

**Planned:** calling `onRateLimit` / `onClean` from real lane traffic and applying `cap(lane)` when dispatching work.

## State file

Path: **`autotune-state.json`** in the **same directory** as the machine config file (`stateFilePath` uses `resolveConfigPath`, e.g. next to `config.json` when `SWARM_CONFIG` points at `/tmp/custom/config.json` → `/tmp/custom/autotune-state.json`).

**Planned:** loading and saving tuner limit plus lane-cap JSON on disk at that path.

## What the board shows

`describe` formats one line for owners:

`limit <n>, in use <n>, <reason>`

| `capped` | Text |
|----------|------|
| `cpu` | `capped by CPU <cpuPercent> percent` |
| `ram` | `capped by RAM <freeRamGb> GB free` |
| `lane-rate-limit` | `capped by lane rate limit` |
| `no-ready-tickets` | `capped by no ready tickets` |
| `none` | `not capped` |

The tuner’s `reason` field tracks why the limit changed; `capped` reflects what is limiting growth **right now** (including at max limit with headroom, which still reports `none`).

## Not wired yet (summary)

- `machineConcurrency: auto` in config and worker pool integration
- Periodic `readMachine` + `tune` loop tied to queue depth and rate-limit events
- Read/write **`autotune-state.json`**
- Enforcing per-lane caps during dispatch

# Autopilot

Autopilot is the project's background loop (`swarm autopilot`) that journals integration, resumes, retries, unlocks ready tickets, and starts scope work when the tree is idle.

## Wide waves

On every idle pass where **start-ready** runs, autopilot starts **all** startable tickets that fit in one wave, up to free worker slots (and project cap room). Tickets that share output files stay in separate waves: `planWaveBatch` keeps conflicting files out of the same batch.

The spawned command is `swarm go --scope` with `--max-jobs N`, where `N` is the planned batch size, so the run actually starts that many jobs instead of defaulting to a single skeleton ticket.

### `autopilot` config

Machine config (`SWARM_CONFIG`) and per-project config (`.project-swarm.json` → `autopilot`) accept:

| Key | Values | Default |
|-----|--------|---------|
| `skipSkeleton` | `true`, `false`, or `"auto"` | `"auto"` |
| `maxJobs` | integer 1–64 | free worker slots for this pass |

- **`skipSkeleton`**: when `true`, `go --scope` is called with `--skip-skeleton`. When `false`, the skeleton-first gate always applies. **`auto`** skips the skeleton gate once the ledger has at least **10** tickets in `done` status (day-0 bootstrap); younger projects keep the skeleton.
- **`maxJobs`**: ceiling for how many tickets autopilot may start in one wave; never above **64** or above free slots on this pass.

Unknown keys or invalid values make `loadLocalConfig` fail (same as other config blocks).

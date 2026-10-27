# Silent failures audit (goal g-33a7a4ae)

Audit only - no code changed. Scope: every file under `tools/` (including `tools/swarm/`, `tools/self-manage/`, `tools/managers/`), excluding the guard-chain files currently owned by the MacBook seat this round: `tools/shell-writes.mjs`, `tools/handbuild.mjs`, `tools/orchestrator-allow.mjs`, `tools/worker-token.mjs`, `tools/swarm/core-41.mjs`, `tools/cli-adapters.mjs`, `tools/lane-health.mjs`.

**Method**: a brace-aware scanner (not a line-regex) that finds every `catch` clause - both `try { } catch (e) { }` and `.catch(fn)` promise-chain form - and flags it when its body is empty, comment-only, or a no-op expression (`() => undefined`, `() => null`, etc.) after stripping comments. This matches the three named patterns: `catch {}`, `catch (e) {}`, and `.catch(() => {})`. It does NOT flag a catch that returns a sentinel, continues a loop, or does any other real (if terse) handling - only genuinely silent swallows.

## Count: before = **630**, after = _pending the fix round (not started - audit only per owner instruction)_

## By folder

| folder | count |
| --- | --- |
| tools/ (top-level) | 561 |
| tools/swarm/ | 48 |
| tools/managers/ | 20 |
| tools/self-manage/ | 1 |

## By file (every file with at least one finding, sorted by count)

| file | count |
| --- | --- |
| tools/swarm.mjs | 45 |
| tools/board-data.mjs | 28 |
| tools/scope-commands.mjs | 23 |
| tools/watch-cli.mjs | 22 |
| tools/phone.mjs | 20 |
| tools/server-restart.mjs | 19 |
| tools/gc.mjs | 15 |
| tools/ship.mjs | 13 |
| tools/autopilot.mjs | 11 |
| tools/ledger-backup.mjs | 11 |
| tools/kit.mjs | 10 |
| tools/ui-check.mjs | 10 |
| tools/install.mjs | 9 |
| tools/concurrency-guard.mjs | 8 |
| tools/evals.mjs | 8 |
| tools/managers/visual-qa/screenshots.mjs | 8 |
| tools/update-pending.mjs | 8 |
| tools/batch.mjs | 7 |
| tools/history-hooks.mjs | 7 |
| tools/server-discovery.mjs | 7 |
| tools/swarm/core-31.mjs | 7 |
| tools/swarm/core-61.mjs | 7 |
| tools/brain-commands.mjs | 6 |
| tools/gpu.mjs | 6 |
| tools/lessons.mjs | 6 |
| tools/projects.mjs | 6 |
| tools/swarm/core-12.mjs | 6 |
| tools/swarm/core-2.mjs | 6 |
| tools/swarm/core-52.mjs | 6 |
| tools/errors.mjs | 5 |
| tools/gpu-commands.mjs | 5 |
| tools/init-profile.mjs | 5 |
| tools/needs-you-triage.mjs | 5 |
| tools/orchestrator-hook.mjs | 5 |
| tools/project-commands.mjs | 5 |
| tools/swarm/core-51.mjs | 5 |
| tools/api-adapters.mjs | 4 |
| tools/autopilot-ready-deps.mjs | 4 |
| tools/base-check-lock.mjs | 4 |
| tools/board.mjs | 4 |
| tools/busy-marker.mjs | 4 |
| tools/claude-shell.mjs | 4 |
| tools/githook-check.mjs | 4 |
| tools/integrated-snapshot.mjs | 4 |
| tools/lanes.mjs | 4 |
| tools/managers/version/index.mjs | 4 |
| tools/orchestrator-events.mjs | 4 |
| tools/security-review.mjs | 4 |
| tools/tickets.mjs | 4 |
| tools/watch-server.mjs | 4 |
| tools/bench-baseline.mjs | 3 |
| tools/board-inbox.mjs | 3 |
| tools/client-report.mjs | 3 |
| tools/errors-commands.mjs | 3 |
| tools/executors.mjs | 3 |
| tools/generated-state.mjs | 3 |
| tools/go.mjs | 3 |
| tools/handbuild-commands.mjs | 3 |
| tools/handbuild-guard.mjs | 3 |
| tools/handoff-commands.mjs | 3 |
| tools/handoff-docs.mjs | 3 |
| tools/lessons-commands.mjs | 3 |
| tools/managers/replay.mjs | 3 |
| tools/orchestrator-handoff-hook.mjs | 3 |
| tools/orchestrator-usage.mjs | 3 |
| tools/pins.mjs | 3 |
| tools/quotes.mjs | 3 |
| tools/remote-exec.mjs | 3 |
| tools/security-gate.mjs | 3 |
| tools/split-module.mjs | 3 |
| tools/swarm/core-21.mjs | 3 |
| tools/acceptance.mjs | 2 |
| tools/auto-approve-policy.mjs | 2 |
| tools/bench-commands.mjs | 2 |
| tools/best-of.mjs | 2 |
| tools/board-keepalive.mjs | 2 |
| tools/board-live.mjs | 2 |
| tools/brain.mjs | 2 |
| tools/budgets.mjs | 2 |
| tools/build-progress.mjs | 2 |
| tools/context-check.mjs | 2 |
| tools/dep-install.mjs | 2 |
| tools/gate-rerun.mjs | 2 |
| tools/history.mjs | 2 |
| tools/init.mjs | 2 |
| tools/integration-lock.mjs | 2 |
| tools/lane-pass-routing.mjs | 2 |
| tools/lessons-publish.mjs | 2 |
| tools/managers/lane-health/index.mjs | 2 |
| tools/managers/version/stale.mjs | 2 |
| tools/phone-commands.mjs | 2 |
| tools/policy-run.mjs | 2 |
| tools/release-train-update.mjs | 2 |
| tools/report-commands.mjs | 2 |
| tools/scale.mjs | 2 |
| tools/scope-loop.mjs | 2 |
| tools/split-quality.mjs | 2 |
| tools/state-backup.mjs | 2 |
| tools/state-guard.mjs | 2 |
| tools/status.mjs | 2 |
| tools/swarm-produced.mjs | 2 |
| tools/swarm/core-1.mjs | 2 |
| tools/swarm/core-11.mjs | 2 |
| tools/wave-quarantine-types.mjs | 2 |
| tools/wave-quarantine.mjs | 2 |
| tools/autopilot-lock.mjs | 1 |
| tools/autopilot-pause.mjs | 1 |
| tools/autotune.mjs | 1 |
| tools/board-commands.mjs | 1 |
| tools/board-peers.mjs | 1 |
| tools/board-run.mjs | 1 |
| tools/budgets-commands.mjs | 1 |
| tools/burst-commands.mjs | 1 |
| tools/burst-lease.mjs | 1 |
| tools/burst-route.mjs | 1 |
| tools/checks-from-ci.mjs | 1 |
| tools/chief-orchestrator.mjs | 1 |
| tools/ci-hooks.mjs | 1 |
| tools/ci-local.mjs | 1 |
| tools/codex-adapter.mjs | 1 |
| tools/contracts-gen.mjs | 1 |
| tools/contracts-verify.mjs | 1 |
| tools/cursor-adapter.mjs | 1 |
| tools/daily-limit-notify.mjs | 1 |
| tools/deploy-status.mjs | 1 |
| tools/gate-fingerprint.mjs | 1 |
| tools/git-hooks.mjs | 1 |
| tools/goal.mjs | 1 |
| tools/gpu-bakeoff.mjs | 1 |
| tools/inbox-commands.mjs | 1 |
| tools/job-grants.mjs | 1 |
| tools/job-sandbox-grants.mjs | 1 |
| tools/journal.mjs | 1 |
| tools/lanes-rule.mjs | 1 |
| tools/ledger-lease.mjs | 1 |
| tools/ledger-merge.mjs | 1 |
| tools/lesson-store.mjs | 1 |
| tools/load-sync-wait.mjs | 1 |
| tools/machine-limit.mjs | 1 |
| tools/managers/lessons/close.mjs | 1 |
| tools/migration-gate.mjs | 1 |
| tools/models-commands.mjs | 1 |
| tools/orchestrator-context.mjs | 1 |
| tools/orchestrator-up.mjs | 1 |
| tools/plan-commands.mjs | 1 |
| tools/preflight.mjs | 1 |
| tools/project-add.mjs | 1 |
| tools/release-train-bump.mjs | 1 |
| tools/release-train-merge.mjs | 1 |
| tools/remote.mjs | 1 |
| tools/runner-pointer.mjs | 1 |
| tools/safety-commands.mjs | 1 |
| tools/self-manage/lane-monitor.mjs | 1 |
| tools/service-launchd.mjs | 1 |
| tools/session-metrics.mjs | 1 |
| tools/split-scan.mjs | 1 |
| tools/swarm-env.mjs | 1 |
| tools/swarm/core-32.mjs | 1 |
| tools/swarm/core-71.mjs | 1 |
| tools/swarm/warnings.mjs | 1 |
| tools/swarm/workspace.mjs | 1 |
| tools/ticket-replan.mjs | 1 |
| tools/time-auto.mjs | 1 |
| tools/tool-config.mjs | 1 |
| tools/tunnel.mjs | 1 |
| tools/verify-local-runner.mjs | 1 |
| tools/verify-orb.mjs | 1 |
| tools/watch-gallery.mjs | 1 |

## Full listing (file, line, form)

`form` key: `try-catch` = `catch (e) { }`, `try-catch-no-binding` = `catch { }`, `dot-catch-arrow` = `.catch(() => { })`, `dot-catch-noop-expr` = `.catch(() => undefined)`-shaped.

### tools/acceptance.mjs (2)
- line 229: `try-catch-no-binding`
- line 364: `dot-catch-noop-expr`

### tools/api-adapters.mjs (4)
- line 452: `try-catch-no-binding`
- line 453: `dot-catch-arrow`
- line 468: `dot-catch-arrow`
- line 745: `try-catch-no-binding`

### tools/auto-approve-policy.mjs (2)
- line 149: `try-catch-no-binding`
- line 224: `try-catch-no-binding`

### tools/autopilot-lock.mjs (1)
- line 57: `try-catch-no-binding`

### tools/autopilot-pause.mjs (1)
- line 45: `try-catch-no-binding`

### tools/autopilot-ready-deps.mjs (4)
- line 43: `try-catch-no-binding`
- line 57: `try-catch-no-binding`
- line 385: `try-catch-no-binding`
- line 422: `try-catch-no-binding`

### tools/autopilot.mjs (11)
- line 568: `try-catch-no-binding`
- line 686: `try-catch-no-binding`
- line 700: `try-catch-no-binding`
- line 774: `try-catch-no-binding`
- line 1215: `try-catch-no-binding`
- line 1219: `try-catch-no-binding`
- line 1222: `try-catch-no-binding`
- line 1230: `try-catch-no-binding`
- line 1462: `dot-catch-noop-expr`
- line 1465: `try-catch-no-binding`
- line 1468: `try-catch-no-binding`

### tools/autotune.mjs (1)
- line 157: `try-catch-no-binding`

### tools/base-check-lock.mjs (4)
- line 79: `dot-catch-arrow`
- line 88: `try-catch-no-binding`
- line 108: `try-catch-no-binding`
- line 130: `dot-catch-noop-expr`

### tools/batch.mjs (7)
- line 24: `try-catch-no-binding`
- line 35: `dot-catch-arrow`
- line 69: `try-catch-no-binding`
- line 76: `try-catch-no-binding`
- line 82: `try-catch-no-binding`
- line 93: `dot-catch-arrow`
- line 112: `try-catch-no-binding`

### tools/bench-baseline.mjs (3)
- line 77: `try-catch-no-binding`
- line 215: `try-catch-no-binding`
- line 495: `dot-catch-arrow`

### tools/bench-commands.mjs (2)
- line 115: `try-catch-no-binding`
- line 128: `try-catch-no-binding`

### tools/best-of.mjs (2)
- line 158: `try-catch-no-binding`
- line 161: `try-catch-no-binding`

### tools/board-commands.mjs (1)
- line 33: `dot-catch-noop-expr`

### tools/board-data.mjs (28)
- line 466: `try-catch-no-binding`
- line 493: `try-catch-no-binding`
- line 495: `try-catch-no-binding`
- line 527: `try-catch-no-binding`
- line 536: `try-catch-no-binding`
- line 538: `try-catch-no-binding`
- line 549: `try-catch-no-binding`
- line 570: `dot-catch-noop-expr`
- line 838: `dot-catch-noop-expr`
- line 862: `dot-catch-noop-expr`
- line 869: `dot-catch-noop-expr`
- line 898: `dot-catch-noop-expr`
- line 899: `dot-catch-noop-expr`
- line 1043: `try-catch-no-binding`
- line 1045: `try-catch-no-binding`
- line 1155: `dot-catch-noop-expr`
- line 1157: `dot-catch-noop-expr`
- line 1173: `dot-catch-noop-expr`
- line 1174: `dot-catch-noop-expr`
- line 1175: `dot-catch-noop-expr`
- line 1176: `dot-catch-noop-expr`
- line 1197: `try-catch-no-binding`
- line 1199: `try-catch-no-binding`
- line 1258: `dot-catch-noop-expr`
- line 1275: `try-catch-no-binding`
- line 1306: `try-catch-no-binding`
- line 1309: `try-catch-no-binding`
- line 1331: `dot-catch-noop-expr`

### tools/board-inbox.mjs (3)
- line 129: `dot-catch-noop-expr`
- line 135: `dot-catch-arrow`
- line 171: `dot-catch-noop-expr`

### tools/board-keepalive.mjs (2)
- line 138: `dot-catch-arrow`
- line 206: `try-catch-no-binding`

### tools/board-live.mjs (2)
- line 121: `dot-catch-noop-expr`
- line 122: `dot-catch-noop-expr`

### tools/board-peers.mjs (1)
- line 58: `dot-catch-arrow`

### tools/board-run.mjs (1)
- line 65: `try-catch-no-binding`

### tools/board.mjs (4)
- line 72: `dot-catch-arrow`
- line 89: `dot-catch-arrow`
- line 90: `dot-catch-arrow`
- line 119: `try-catch-no-binding`

### tools/brain-commands.mjs (6)
- line 53: `dot-catch-noop-expr`
- line 89: `dot-catch-noop-expr`
- line 96: `dot-catch-arrow`
- line 97: `dot-catch-noop-expr`
- line 239: `try-catch-no-binding`
- line 251: `try-catch-no-binding`

### tools/brain.mjs (2)
- line 82: `try-catch-no-binding`
- line 166: `try-catch-no-binding`

### tools/budgets-commands.mjs (1)
- line 40: `dot-catch-noop-expr`

### tools/budgets.mjs (2)
- line 155: `try-catch-no-binding`
- line 179: `dot-catch-arrow`

### tools/build-progress.mjs (2)
- line 49: `try-catch-no-binding`
- line 325: `try-catch-no-binding`

### tools/burst-commands.mjs (1)
- line 68: `dot-catch-arrow`

### tools/burst-lease.mjs (1)
- line 94: `dot-catch-arrow`

### tools/burst-route.mjs (1)
- line 58: `dot-catch-arrow`

### tools/busy-marker.mjs (4)
- line 79: `dot-catch-arrow`
- line 95: `dot-catch-arrow`
- line 96: `dot-catch-arrow`
- line 101: `dot-catch-arrow`

### tools/checks-from-ci.mjs (1)
- line 236: `try-catch-no-binding`

### tools/chief-orchestrator.mjs (1)
- line 52: `try-catch-no-binding`

### tools/ci-hooks.mjs (1)
- line 174: `try-catch-no-binding`

### tools/ci-local.mjs (1)
- line 85: `dot-catch-noop-expr`

### tools/claude-shell.mjs (4)
- line 148: `try-catch-no-binding`
- line 363: `try-catch-no-binding`
- line 397: `try-catch-no-binding`
- line 423: `try-catch-no-binding`

### tools/client-report.mjs (3)
- line 29: `try-catch-no-binding`
- line 165: `try-catch-no-binding`
- line 243: `dot-catch-noop-expr`

### tools/codex-adapter.mjs (1)
- line 40: `try-catch-no-binding`

### tools/concurrency-guard.mjs (8)
- line 88: `try-catch-no-binding`
- line 90: `try-catch-no-binding`
- line 94: `try-catch-no-binding`
- line 101: `try-catch-no-binding`
- line 113: `try-catch-no-binding`
- line 119: `try-catch-no-binding`
- line 133: `try-catch-no-binding`
- line 139: `try-catch-no-binding`

### tools/context-check.mjs (2)
- line 339: `try-catch-no-binding`
- line 373: `try-catch-no-binding`

### tools/contracts-gen.mjs (1)
- line 19: `try-catch-no-binding`

### tools/contracts-verify.mjs (1)
- line 18: `try-catch-no-binding`

### tools/cursor-adapter.mjs (1)
- line 139: `try-catch-no-binding`

### tools/daily-limit-notify.mjs (1)
- line 230: `try-catch-no-binding`

### tools/dep-install.mjs (2)
- line 43: `dot-catch-noop-expr`
- line 49: `dot-catch-arrow`

### tools/deploy-status.mjs (1)
- line 55: `try-catch-no-binding`

### tools/errors-commands.mjs (3)
- line 22: `dot-catch-noop-expr`
- line 25: `dot-catch-arrow`
- line 27: `dot-catch-arrow`

### tools/errors.mjs (5)
- line 105: `try-catch-no-binding`
- line 188: `try-catch-no-binding`
- line 215: `dot-catch-noop-expr`
- line 223: `dot-catch-arrow`
- line 326: `dot-catch-noop-expr`

### tools/evals.mjs (8)
- line 37: `dot-catch-noop-expr`
- line 44: `dot-catch-noop-expr`
- line 54: `dot-catch-noop-expr`
- line 140: `dot-catch-noop-expr`
- line 148: `dot-catch-noop-expr`
- line 183: `try-catch-no-binding`
- line 228: `dot-catch-noop-expr`
- line 304: `dot-catch-noop-expr`

### tools/executors.mjs (3)
- line 189: `try-catch-no-binding`
- line 221: `dot-catch-arrow`
- line 270: `dot-catch-arrow`

### tools/gate-fingerprint.mjs (1)
- line 268: `dot-catch-arrow`

### tools/gate-rerun.mjs (2)
- line 520: `try-catch-no-binding`
- line 526: `try-catch-no-binding`

### tools/gc.mjs (15)
- line 182: `try-catch-no-binding`
- line 208: `try-catch-no-binding`
- line 221: `try-catch-no-binding`
- line 241: `dot-catch-noop-expr`
- line 284: `try-catch-no-binding`
- line 286: `try-catch-no-binding`
- line 359: `try-catch-no-binding`
- line 423: `try-catch-no-binding`
- line 470: `dot-catch-noop-expr`
- line 473: `try-catch-no-binding`
- line 482: `try-catch-no-binding`
- line 502: `try-catch-no-binding`
- line 589: `try-catch-no-binding`
- line 647: `try-catch-no-binding`
- line 674: `try-catch-no-binding`

### tools/generated-state.mjs (3)
- line 238: `try-catch-no-binding`
- line 272: `try-catch-no-binding`
- line 274: `try-catch-no-binding`

### tools/git-hooks.mjs (1)
- line 157: `try-catch-no-binding`

### tools/githook-check.mjs (4)
- line 113: `try-catch-no-binding`
- line 162: `try-catch-no-binding`
- line 169: `try-catch-no-binding`
- line 267: `try-catch-no-binding`

### tools/go.mjs (3)
- line 108: `try-catch-no-binding`
- line 134: `dot-catch-arrow`
- line 151: `dot-catch-arrow`

### tools/goal.mjs (1)
- line 164: `try-catch-no-binding`

### tools/gpu-bakeoff.mjs (1)
- line 137: `try-catch-no-binding`

### tools/gpu-commands.mjs (5)
- line 78: `try-catch-no-binding`
- line 89: `try-catch-no-binding`
- line 101: `dot-catch-arrow`
- line 171: `try-catch-no-binding`
- line 181: `try-catch-no-binding`

### tools/gpu.mjs (6)
- line 252: `try-catch-no-binding`
- line 273: `try-catch-no-binding`
- line 357: `try-catch-no-binding`
- line 358: `try-catch-no-binding`
- line 405: `try-catch-no-binding`
- line 426: `try-catch-no-binding`

### tools/handbuild-commands.mjs (3)
- line 90: `dot-catch-arrow`
- line 99: `try-catch-no-binding`
- line 134: `try-catch-no-binding`

### tools/handbuild-guard.mjs (3)
- line 41: `try-catch-no-binding`
- line 61: `try-catch-no-binding`
- line 75: `try-catch-no-binding`

### tools/handoff-commands.mjs (3)
- line 43: `try-catch-no-binding`
- line 50: `dot-catch-noop-expr`
- line 147: `dot-catch-noop-expr`

### tools/handoff-docs.mjs (3)
- line 137: `try-catch-no-binding`
- line 146: `try-catch-no-binding`
- line 188: `try-catch-no-binding`

### tools/history-hooks.mjs (7)
- line 12: `dot-catch-noop-expr`
- line 28: `try-catch-no-binding`
- line 37: `try-catch-no-binding`
- line 43: `dot-catch-noop-expr`
- line 56: `dot-catch-noop-expr`
- line 65: `dot-catch-noop-expr`
- line 74: `dot-catch-noop-expr`

### tools/history.mjs (2)
- line 15: `dot-catch-arrow`
- line 67: `try-catch-no-binding`

### tools/inbox-commands.mjs (1)
- line 63: `try-catch-no-binding`

### tools/init-profile.mjs (5)
- line 179: `try-catch-no-binding`
- line 211: `try-catch-no-binding`
- line 223: `try-catch-no-binding`
- line 244: `try-catch-no-binding`
- line 254: `try-catch-no-binding`

### tools/init.mjs (2)
- line 72: `try-catch-no-binding`
- line 158: `try-catch-no-binding`

### tools/install.mjs (9)
- line 300: `try-catch-no-binding`
- line 304: `try-catch-no-binding`
- line 398: `try-catch-no-binding`
- line 458: `try-catch-no-binding`
- line 491: `try-catch-no-binding`
- line 505: `try-catch-no-binding`
- line 511: `try-catch-no-binding`
- line 512: `dot-catch-arrow`
- line 532: `try-catch-no-binding`

### tools/integrated-snapshot.mjs (4)
- line 131: `dot-catch-arrow`
- line 133: `dot-catch-arrow`
- line 186: `dot-catch-arrow`
- line 218: `dot-catch-arrow`

### tools/integration-lock.mjs (2)
- line 29: `try-catch-no-binding`
- line 65: `try-catch-no-binding`

### tools/job-grants.mjs (1)
- line 192: `dot-catch-arrow`

### tools/job-sandbox-grants.mjs (1)
- line 59: `dot-catch-arrow`

### tools/journal.mjs (1)
- line 284: `dot-catch-arrow`

### tools/kit.mjs (10)
- line 61: `dot-catch-noop-expr`
- line 98: `dot-catch-noop-expr`
- line 122: `dot-catch-noop-expr`
- line 141: `dot-catch-noop-expr`
- line 144: `dot-catch-noop-expr`
- line 165: `try-catch-no-binding`
- line 185: `dot-catch-arrow`
- line 186: `dot-catch-arrow`
- line 187: `dot-catch-arrow`
- line 187: `dot-catch-arrow`

### tools/lane-pass-routing.mjs (2)
- line 93: `try-catch-no-binding`
- line 123: `try-catch-no-binding`

### tools/lanes-rule.mjs (1)
- line 118: `dot-catch-arrow`

### tools/lanes.mjs (4)
- line 185: `dot-catch-arrow`
- line 484: `try-catch-no-binding`
- line 863: `dot-catch-arrow`
- line 868: `dot-catch-arrow`

### tools/ledger-backup.mjs (11)
- line 68: `dot-catch-arrow`
- line 75: `dot-catch-arrow`
- line 144: `try-catch-no-binding`
- line 164: `try-catch-no-binding`
- line 178: `try-catch-no-binding`
- line 206: `try-catch-no-binding`
- line 293: `try-catch-no-binding`
- line 321: `try-catch-no-binding`
- line 344: `try-catch-no-binding`
- line 358: `try-catch-no-binding`
- line 481: `try-catch-no-binding`

### tools/ledger-lease.mjs (1)
- line 136: `dot-catch-arrow`

### tools/ledger-merge.mjs (1)
- line 162: `dot-catch-arrow`

### tools/lesson-store.mjs (1)
- line 171: `dot-catch-arrow`

### tools/lessons-commands.mjs (3)
- line 123: `dot-catch-arrow`
- line 170: `dot-catch-arrow`
- line 179: `dot-catch-noop-expr`

### tools/lessons-publish.mjs (2)
- line 204: `dot-catch-arrow`
- line 206: `dot-catch-arrow`

### tools/lessons.mjs (6)
- line 200: `dot-catch-arrow`
- line 200: `dot-catch-arrow`
- line 232: `dot-catch-arrow`
- line 233: `dot-catch-arrow`
- line 411: `try-catch-no-binding`
- line 413: `try-catch-no-binding`

### tools/load-sync-wait.mjs (1)
- line 245: `dot-catch-arrow`

### tools/machine-limit.mjs (1)
- line 242: `try-catch-no-binding`

### tools/managers/lane-health/index.mjs (2)
- line 57: `dot-catch-noop-expr`
- line 93: `dot-catch-noop-expr`

### tools/managers/lessons/close.mjs (1)
- line 218: `try-catch-no-binding`

### tools/managers/replay.mjs (3)
- line 74: `dot-catch-noop-expr`
- line 109: `dot-catch-noop-expr`
- line 470: `dot-catch-arrow`

### tools/managers/version/index.mjs (4)
- line 108: `try-catch-no-binding`
- line 161: `try-catch-no-binding`
- line 203: `try-catch-no-binding`
- line 312: `try-catch-no-binding`

### tools/managers/version/stale.mjs (2)
- line 270: `try-catch-no-binding`
- line 282: `try-catch-no-binding`

### tools/managers/visual-qa/screenshots.mjs (8)
- line 71: `try-catch-no-binding`
- line 91: `try-catch-no-binding`
- line 124: `try-catch-no-binding`
- line 175: `try-catch-no-binding`
- line 177: `dot-catch-arrow`
- line 188: `dot-catch-noop-expr`
- line 205: `dot-catch-arrow`
- line 280: `dot-catch-noop-expr`

### tools/migration-gate.mjs (1)
- line 328: `try-catch-no-binding`

### tools/models-commands.mjs (1)
- line 44: `try-catch-no-binding`

### tools/needs-you-triage.mjs (5)
- line 264: `try-catch-no-binding`
- line 285: `try-catch-no-binding`
- line 301: `try-catch-no-binding`
- line 325: `try-catch-no-binding`
- line 342: `try-catch-no-binding`

### tools/orchestrator-context.mjs (1)
- line 303: `try-catch-no-binding`

### tools/orchestrator-events.mjs (4)
- line 182: `try-catch-no-binding`
- line 184: `try-catch-no-binding`
- line 189: `try-catch-no-binding`
- line 216: `try-catch-no-binding`

### tools/orchestrator-handoff-hook.mjs (3)
- line 153: `try-catch-no-binding`
- line 168: `try-catch-no-binding`
- line 183: `try-catch-no-binding`

### tools/orchestrator-hook.mjs (5)
- line 77: `try-catch-no-binding`
- line 82: `try-catch-no-binding`
- line 168: `try-catch-no-binding`
- line 171: `try-catch-no-binding`
- line 181: `try-catch-no-binding`

### tools/orchestrator-up.mjs (1)
- line 58: `try-catch-no-binding`

### tools/orchestrator-usage.mjs (3)
- line 18: `try-catch-no-binding`
- line 32: `try-catch-no-binding`
- line 36: `try-catch-no-binding`

### tools/phone-commands.mjs (2)
- line 41: `dot-catch-noop-expr`
- line 43: `try-catch-no-binding`

### tools/phone.mjs (20)
- line 70: `dot-catch-noop-expr`
- line 133: `try-catch-no-binding`
- line 210: `dot-catch-arrow`
- line 210: `dot-catch-arrow`
- line 215: `dot-catch-arrow`
- line 215: `dot-catch-arrow`
- line 220: `dot-catch-arrow`
- line 220: `dot-catch-arrow`
- line 238: `dot-catch-arrow`
- line 238: `dot-catch-arrow`
- line 239: `dot-catch-arrow`
- line 239: `dot-catch-arrow`
- line 242: `dot-catch-arrow`
- line 242: `dot-catch-arrow`
- line 250: `dot-catch-arrow`
- line 250: `dot-catch-arrow`
- line 256: `dot-catch-arrow`
- line 282: `dot-catch-arrow`
- line 283: `dot-catch-arrow`
- line 307: `try-catch-no-binding`

### tools/pins.mjs (3)
- line 91: `dot-catch-noop-expr`
- line 133: `dot-catch-arrow`
- line 171: `try-catch-no-binding`

### tools/plan-commands.mjs (1)
- line 74: `try-catch-no-binding`

### tools/policy-run.mjs (2)
- line 345: `try-catch-no-binding`
- line 350: `try-catch-no-binding`

### tools/preflight.mjs (1)
- line 79: `try-catch-no-binding`

### tools/project-add.mjs (1)
- line 21: `dot-catch-noop-expr`

### tools/project-commands.mjs (5)
- line 113: `dot-catch-noop-expr`
- line 212: `try-catch-no-binding`
- line 257: `dot-catch-noop-expr`
- line 278: `try-catch-no-binding`
- line 414: `dot-catch-arrow`

### tools/projects.mjs (6)
- line 28: `dot-catch-arrow`
- line 49: `dot-catch-arrow`
- line 65: `try-catch-no-binding`
- line 67: `try-catch-no-binding`
- line 82: `dot-catch-arrow`
- line 280: `dot-catch-noop-expr`

### tools/quotes.mjs (3)
- line 131: `try-catch-no-binding`
- line 138: `try-catch-no-binding`
- line 156: `dot-catch-noop-expr`

### tools/release-train-bump.mjs (1)
- line 104: `dot-catch-arrow`

### tools/release-train-merge.mjs (1)
- line 157: `dot-catch-arrow`

### tools/release-train-update.mjs (2)
- line 123: `try-catch-no-binding`
- line 129: `try-catch-no-binding`

### tools/remote-exec.mjs (3)
- line 95: `try-catch-no-binding`
- line 111: `try-catch-no-binding`
- line 135: `try-catch-no-binding`

### tools/remote.mjs (1)
- line 91: `try-catch-no-binding`

### tools/report-commands.mjs (2)
- line 14: `try-catch-no-binding`
- line 42: `dot-catch-noop-expr`

### tools/runner-pointer.mjs (1)
- line 202: `try-catch-no-binding`

### tools/safety-commands.mjs (1)
- line 58: `try-catch-no-binding`

### tools/scale.mjs (2)
- line 148: `try-catch-no-binding`
- line 165: `dot-catch-arrow`

### tools/scope-commands.mjs (23)
- line 141: `try-catch-no-binding`
- line 635: `try-catch-no-binding`
- line 681: `try-catch-no-binding`
- line 835: `try-catch-no-binding`
- line 1077: `dot-catch-arrow`
- line 1181: `try-catch-no-binding`
- line 1218: `try-catch-no-binding`
- line 1373: `try-catch-no-binding`
- line 1905: `try-catch-no-binding`
- line 1917: `try-catch-no-binding`
- line 1920: `try-catch-no-binding`
- line 1960: `try-catch-no-binding`
- line 1981: `dot-catch-noop-expr`
- line 2477: `try-catch-no-binding`
- line 2890: `try-catch-no-binding`
- line 2891: `try-catch-no-binding`
- line 3162: `try-catch-no-binding`
- line 3241: `dot-catch-arrow`
- line 3379: `try-catch-no-binding`
- line 3675: `try-catch-no-binding`
- line 3940: `dot-catch-noop-expr`
- line 3946: `dot-catch-arrow`
- line 4027: `try-catch-no-binding`

### tools/scope-loop.mjs (2)
- line 351: `dot-catch-noop-expr`
- line 480: `try-catch-no-binding`

### tools/security-gate.mjs (3)
- line 170: `try-catch-no-binding`
- line 200: `try-catch-no-binding`
- line 307: `try-catch-no-binding`

### tools/security-review.mjs (4)
- line 38: `try-catch-no-binding`
- line 118: `try-catch-no-binding`
- line 143: `try-catch-no-binding`
- line 149: `try-catch-no-binding`

### tools/self-manage/lane-monitor.mjs (1)
- line 263: `dot-catch-arrow`

### tools/server-discovery.mjs (7)
- line 97: `try-catch-no-binding`
- line 287: `try-catch-no-binding`
- line 307: `try-catch-no-binding`
- line 322: `try-catch-no-binding`
- line 323: `try-catch-no-binding`
- line 344: `try-catch-no-binding`
- line 356: `try-catch-no-binding`

### tools/server-restart.mjs (19)
- line 65: `try-catch-no-binding`
- line 240: `try-catch-no-binding`
- line 330: `try-catch-no-binding`
- line 350: `try-catch-no-binding`
- line 357: `try-catch-no-binding`
- line 438: `try-catch-no-binding`
- line 444: `try-catch-no-binding`
- line 506: `try-catch-no-binding`
- line 524: `try-catch-no-binding`
- line 633: `try-catch-no-binding`
- line 649: `try-catch-no-binding`
- line 668: `dot-catch-arrow`
- line 682: `dot-catch-arrow`
- line 708: `dot-catch-arrow`
- line 748: `try-catch-no-binding`
- line 753: `try-catch-no-binding`
- line 836: `try-catch-no-binding`
- line 844: `try-catch-no-binding`
- line 990: `try-catch-no-binding`

### tools/service-launchd.mjs (1)
- line 80: `dot-catch-arrow`

### tools/session-metrics.mjs (1)
- line 46: `try-catch-no-binding`

### tools/ship.mjs (13)
- line 78: `try-catch-no-binding`
- line 242: `try-catch-no-binding`
- line 283: `try-catch-no-binding`
- line 354: `try-catch-no-binding`
- line 873: `try-catch-no-binding`
- line 880: `try-catch-no-binding`
- line 1005: `try-catch-no-binding`
- line 1006: `dot-catch-arrow`
- line 1201: `try-catch-no-binding`
- line 1202: `dot-catch-arrow`
- line 1217: `dot-catch-noop-expr`
- line 1220: `dot-catch-noop-expr`
- line 2189: `dot-catch-noop-expr`

### tools/split-module.mjs (3)
- line 47: `try-catch-no-binding`
- line 932: `try-catch-no-binding`
- line 977: `try-catch-no-binding`

### tools/split-quality.mjs (2)
- line 56: `try-catch-no-binding`
- line 66: `dot-catch-noop-expr`

### tools/split-scan.mjs (1)
- line 776: `try-catch-no-binding`

### tools/state-backup.mjs (2)
- line 125: `try-catch-no-binding`
- line 177: `try-catch-no-binding`

### tools/state-guard.mjs (2)
- line 165: `dot-catch-arrow`
- line 170: `try-catch-no-binding`

### tools/status.mjs (2)
- line 29: `try-catch-no-binding`
- line 65: `try-catch-no-binding`

### tools/swarm-env.mjs (1)
- line 191: `try-catch-no-binding`

### tools/swarm-produced.mjs (2)
- line 26: `try-catch-no-binding`
- line 28: `try-catch-no-binding`

### tools/swarm.mjs (45)
- line 322: `dot-catch-noop-expr`
- line 364: `dot-catch-arrow`
- line 401: `try-catch-no-binding`
- line 440: `dot-catch-noop-expr`
- line 463: `dot-catch-arrow`
- line 495: `dot-catch-arrow`
- line 548: `dot-catch-arrow`
- line 822: `dot-catch-arrow`
- line 838: `try-catch-no-binding`
- line 1007: `dot-catch-arrow`
- line 1299: `dot-catch-arrow`
- line 1313: `dot-catch-arrow`
- line 1468: `try-catch-no-binding`
- line 1485: `try-catch-no-binding`
- line 2105: `try-catch-no-binding`
- line 2112: `try-catch-no-binding`
- line 2282: `try-catch-no-binding`
- line 2371: `try-catch-no-binding`
- line 2578: `try-catch-no-binding`
- line 2579: `try-catch-no-binding`
- line 2584: `try-catch-no-binding`
- line 2591: `try-catch-no-binding`
- line 2647: `try-catch-no-binding`
- line 2655: `try-catch-no-binding`
- line 2682: `try-catch-no-binding`
- line 2773: `try-catch-no-binding`
- line 2791: `try-catch-no-binding`
- line 2803: `try-catch-no-binding`
- line 2961: `try-catch-no-binding`
- line 2967: `try-catch-no-binding`
- line 3027: `dot-catch-noop-expr`
- line 3482: `dot-catch-noop-expr`
- line 3485: `dot-catch-noop-expr`
- line 3544: `try-catch-no-binding`
- line 3567: `dot-catch-noop-expr`
- line 3571: `try-catch-no-binding`
- line 3578: `dot-catch-noop-expr`
- line 3582: `dot-catch-noop-expr`
- line 4069: `dot-catch-noop-expr`
- line 4134: `dot-catch-noop-expr`
- line 4217: `try-catch-no-binding`
- line 4263: `try-catch-no-binding`
- line 4303: `try-catch-no-binding`
- line 4329: `dot-catch-arrow`
- line 4394: `dot-catch-arrow`

### tools/swarm/core-1.mjs (2)
- line 79: `try-catch-no-binding`
- line 235: `try-catch-no-binding`

### tools/swarm/core-11.mjs (2)
- line 90: `try-catch-no-binding`
- line 490: `try-catch-no-binding`

### tools/swarm/core-12.mjs (6)
- line 78: `dot-catch-noop-expr`
- line 86: `dot-catch-arrow`
- line 119: `try-catch-no-binding`
- line 124: `try-catch-no-binding`
- line 349: `try-catch-no-binding`
- line 440: `try-catch-no-binding`

### tools/swarm/core-2.mjs (6)
- line 58: `try-catch-no-binding`
- line 84: `try-catch-no-binding`
- line 169: `try-catch-no-binding`
- line 180: `dot-catch-noop-expr`
- line 183: `dot-catch-noop-expr`
- line 199: `try-catch-no-binding`

### tools/swarm/core-21.mjs (3)
- line 144: `try-catch-no-binding`
- line 145: `dot-catch-arrow`
- line 166: `try-catch-no-binding`

### tools/swarm/core-31.mjs (7)
- line 80: `try-catch-no-binding`
- line 109: `dot-catch-arrow`
- line 122: `dot-catch-arrow`
- line 130: `try-catch-no-binding`
- line 571: `dot-catch-noop-expr`
- line 572: `dot-catch-arrow`
- line 610: `try-catch-no-binding`

### tools/swarm/core-32.mjs (1)
- line 55: `try-catch-no-binding`

### tools/swarm/core-51.mjs (5)
- line 72: `try-catch-no-binding`
- line 261: `dot-catch-arrow`
- line 326: `try-catch-no-binding`
- line 327: `dot-catch-arrow`
- line 414: `try-catch-no-binding`

### tools/swarm/core-52.mjs (6)
- line 184: `try-catch-no-binding`
- line 214: `try-catch-no-binding`
- line 224: `try-catch-no-binding`
- line 244: `try-catch-no-binding`
- line 257: `dot-catch-noop-expr`
- line 435: `dot-catch-noop-expr`

### tools/swarm/core-61.mjs (7)
- line 140: `try-catch-no-binding`
- line 267: `dot-catch-noop-expr`
- line 421: `dot-catch-arrow`
- line 422: `try-catch-no-binding`
- line 423: `try-catch-no-binding`
- line 425: `dot-catch-arrow`
- line 502: `dot-catch-arrow`

### tools/swarm/core-71.mjs (1)
- line 326: `try-catch-no-binding`

### tools/swarm/warnings.mjs (1)
- line 267: `try-catch-no-binding`

### tools/swarm/workspace.mjs (1)
- line 69: `try-catch-no-binding`

### tools/ticket-replan.mjs (1)
- line 238: `try-catch-no-binding`

### tools/tickets.mjs (4)
- line 252: `try-catch-no-binding`
- line 264: `try-catch-no-binding`
- line 282: `dot-catch-arrow`
- line 499: `try-catch-no-binding`

### tools/time-auto.mjs (1)
- line 48: `try-catch-no-binding`

### tools/tool-config.mjs (1)
- line 44: `try-catch-no-binding`

### tools/tunnel.mjs (1)
- line 332: `try-catch-no-binding`

### tools/ui-check.mjs (10)
- line 87: `try-catch`
- line 111: `dot-catch-arrow`
- line 116: `try-catch-no-binding`
- line 131: `try-catch-no-binding`
- line 169: `try-catch-no-binding`
- line 169: `dot-catch-arrow`
- line 176: `dot-catch-noop-expr`
- line 262: `dot-catch-arrow`
- line 263: `dot-catch-arrow`
- line 270: `dot-catch-arrow`

### tools/update-pending.mjs (8)
- line 27: `dot-catch-arrow`
- line 77: `dot-catch-arrow`
- line 83: `dot-catch-arrow`
- line 126: `dot-catch-arrow`
- line 214: `try-catch-no-binding`
- line 351: `try-catch-no-binding`
- line 397: `try-catch-no-binding`
- line 424: `dot-catch-arrow`

### tools/verify-local-runner.mjs (1)
- line 44: `try-catch-no-binding`

### tools/verify-orb.mjs (1)
- line 237: `dot-catch-arrow`

### tools/watch-cli.mjs (22)
- line 76: `dot-catch-noop-expr`
- line 208: `dot-catch-noop-expr`
- line 213: `dot-catch-noop-expr`
- line 258: `dot-catch-noop-expr`
- line 266: `dot-catch-noop-expr`
- line 271: `try-catch-no-binding`
- line 295: `dot-catch-noop-expr`
- line 391: `try-catch-no-binding`
- line 409: `try-catch-no-binding`
- line 445: `try-catch-no-binding`
- line 457: `dot-catch-arrow`
- line 457: `dot-catch-arrow`
- line 662: `dot-catch-noop-expr`
- line 781: `try-catch-no-binding`
- line 826: `dot-catch-arrow`
- line 839: `dot-catch-arrow`
- line 850: `dot-catch-arrow`
- line 908: `dot-catch-arrow`
- line 913: `try-catch-no-binding`
- line 920: `try-catch-no-binding`
- line 922: `try-catch-no-binding`
- line 923: `dot-catch-arrow`

### tools/watch-gallery.mjs (1)
- line 160: `dot-catch-arrow`

### tools/watch-server.mjs (4)
- line 99: `try-catch-no-binding`
- line 294: `try-catch-no-binding`
- line 402: `try-catch-no-binding`
- line 761: `try-catch-no-binding`

### tools/wave-quarantine-types.mjs (2)
- line 189: `dot-catch-arrow`
- line 263: `dot-catch-noop-expr`

### tools/wave-quarantine.mjs (2)
- line 68: `dot-catch-arrow`
- line 142: `dot-catch-noop-expr`


# Fake-tests audit (goal g-d84ff1c5)

Audit only - no fixes applied, per the owner's explicit scope for this goal.

**Method**: a heuristic grep-driven survey across all 630 files in `tests/`, looking for four structural signatures named in the goal: (1) a test that fakes the thing it's testing by setting an identity env var the code under test is supposed to derive independently, (2) a mocked dispatcher or guard/hook, (3) a Node-only test of browser-targeted code, (4) a fake `spawn` that never runs a real process. This is a survey, not an exhaustive line-by-line read of every file - it is meant as a starting candidate list for the owner/MacBook to triage, not a final verdict on each file. A file appearing below is not automatically wrong; many of these are legitimate, standard dependency-injection unit-testing style (you cannot reasonably spawn a real subprocess or a real browser in every unit test). The ones worth the most scrutiny are the ones whose own test NAME or assertions claim to prove something about real OS/browser behavior while the fake never actually exercises it.

## Category 1: Node-only tests of browser-targeted code (26 files)

Every file in this repo that imports from `tools/watch-assets/*.js` (code meant to run in a real browser DOM) and exercises it via a hand-rolled fake-DOM object in plain Node, with **no real browser engine**. Checked every `.spec.mjs` file in the repo (the naming convention this codebase uses for anything meant to need a real browser) for an actual `playwright` import: only **one** file in the entire repo does, `tests/swarm-watch-human-checklist-walkthrough.spec.mjs` (T-0058). Every other file below, including three other `.spec.mjs`-named files, runs entirely in Node with a fake DOM:

- tests/board-idle-ready.test.mjs
- tests/board-no-money.test.mjs
- tests/board-live.test.mjs
- tests/board-owner-actions-ui.test.mjs
- tests/command-center-canvas.test.mjs
- tests/command-center-cockpit.test.mjs
- tests/command-center-hive-layout.test.mjs
- tests/command-center-nav.test.mjs
- tests/command-center-hive.test.mjs
- tests/command-center-stat-strip.test.mjs
- tests/command-center-robots.test.mjs
- tests/board-owner-actions.test.mjs
- tests/command-palette.test.mjs
- tests/command-center-glitch-limits.test.mjs
- tests/command-center-lists.test.mjs
- tests/command-center-tour.test.mjs
- tests/orchestrator-lane.test.mjs
- tests/machine-share.test.mjs
- tests/project-spend.test.mjs
- tests/owned-paths.test.mjs
- tests/pins-board.test.mjs
- tests/pins.test.mjs
- tests/s4-r029-owner-route.test.mjs
- tests/watch-ui.test.mjs
- tests/watch-human-progress.test.mjs
- tests/command-center-phone.spec.mjs (`.spec.mjs`-named but no playwright import - CSS-string assertions only)

Also `.spec.mjs`-named but not browser/DOM code (testing a real Node HTTP server instead, so NOT flagged as fake-DOM, listed here only for completeness since the naming convention is otherwise reserved for "needs a real runtime" tests):
- tests/classic-routes.spec.mjs (real HTTP requests against a real board server - legitimate)
- tests/command-center-routes.spec.mjs (same)

**Risk**: real browser layout, CSS cascade, event timing, and rendering-engine quirks are never actually exercised by any of the 26 files above except via hand-maintained geometry math duplicated between the implementation and the fake-DOM test (e.g. the hive-layout overlap-proof tests compute expected positions with the same formulas the implementation uses, rather than measuring a real rendered page). A bug in the SHARED formula would pass both sides. `tests/command-center-phone.spec.mjs` is explicit in its own header comment about this limitation ("no DOM, viewport, or layout engine... true overflow and hit-target behavior need a browser-based follow-up") - most of the other 25 are not self-documenting about the gap.

## Category 2: Fake `spawn` with no real process (88 files)

Every file defining a `spawnImpl` fake (either `spawnImpl = (...)` or `spawnImpl:` object field) in place of `node:child_process`'s real `spawn`. This is the dominant pattern across the whole suite for testing anything that shells out (autopilot's `startScope`, lesson manifests, ticket manifests, etc.) - full file list is long; representative sample from the autopilot/startScope area this session touched directly: tests/autopilot-ready-deps.test.mjs, tests/autopilot-wide-waves.test.mjs, tests/autopilot-start-ready.test.mjs, tests/memory-fixes.test.mjs, tests/memory-wiring.test.mjs. Full list of all 88 files available on request (grep `spawnImpl\s*=\s*(\|spawnImpl:` across `tests/*.test.mjs`).

**Risk, narrowed**: most of these are fine (standard DI-style unit testing - you don't want a real `go --scope` spawned in every unit test). The real risk is specifically where the test's OWN PURPOSE is to prove something about real process behavior - exit codes, signals, timing, SIGTERM/SIGKILL sequencing, a detached child outliving its parent - and the fake never actually models that behavior realistically (e.g. a fake that always calls its exit callback on the same tick, with no possibility of a real race). This session's own work on `tools/autopilot-ready-deps.mjs`'s `startScope` (PR #394) hit exactly this: the pre-existing fake-child test doubles in `tests/memory-fixes.test.mjs`/`tests/memory-wiring.test.mjs`/`tests/autopilot-wide-waves.test.mjs` call their exit callback with NO arguments at all (`cb()`), which is not a real shape a Node child process ever actually produces (`exit` always provides a `code` or a `signal`, never neither, except in that specific test double's own invented convention) - these tests have been "passing" without ever representing a real process exit.

## Category 3: Mocked guard/hook (21 files)

Files referencing `orchestrator-hook`, or defining a fake/mock/stub guard or hook:

- tests/claude-shell.test.mjs
- tests/field-lessons-batch-e.test.mjs
- tests/field-lessons-batch-m2.test.mjs
- tests/field-lessons-batch-q.test.mjs
- tests/handbuild-channel.test.mjs
- tests/handbuild-channels-hardening.test.mjs
- tests/handbuild-guard.test.mjs
- tests/handbuild-hook-hardening.test.mjs
- tests/hook-path-stable.test.mjs
- tests/hooks-repoint-all.test.mjs
- tests/lessons120-mutants.test.mjs
- tests/orchestrator-lane.test.mjs
- tests/orchestrator-mode-review4.test.mjs
- tests/orchestrator-mode-timeout.test.mjs
- tests/phase10b-init.test.mjs
- tests/ports.test.mjs
- tests/self-approval-hardening.test.mjs
- tests/shell-loopback.test.mjs
- tests/shell-scratch.test.mjs
- tests/shell-setup.test.mjs
- tests/ui-check.test.mjs

**Note**: several of these (`handbuild-guard.test.mjs`, `handbuild-channel*.test.mjs`, `handbuild-hook-hardening.test.mjs`, `self-approval-hardening.test.mjs`) are tests OF the guard-chain files the MacBook owns this round (`tools/handbuild.mjs`, `tools/orchestrator-allow.mjs`, `tools/worker-token.mjs`). This audit only lists them (read-only), it does not touch or propose changes to them - that is explicitly the MacBook's own work this round.

## Category 4: env var set to an identity value the code under test is supposed to derive itself

Narrowest, least-confident category - only two files matched a direct grep for `env.SWARM_AUTOPILOT_PID =` or similar identity-env assignment inside a test, which is too narrow a pattern to claim broad coverage here:

- (needs a deeper, more manual pass than this audit's time budget allowed - flagging as the weakest-covered category, not a clean "nothing found")

## Summary counts

| category | files found |
| --- | --- |
| Node-only tests of browser-targeted code | 26 |
| Fake spawn, no real process | 88 |
| Mocked guard/hook | 21 |
| Env-var self-fulfilling identity | 2 (likely undercounted - needs manual follow-up) |

No fixes applied. This list is the input for a later triage/fix round, not a final verdict.

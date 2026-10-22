# Handoff

Hand-written until Phase 10b ships (this PR); then `swarm brief` regenerates it. Updated after every step.

Last updated: 2026-10-15, Phase 10b built and waiting for the real-host test run on dev2 before the PR is opened.

## Goal
Plan: docs/plans/swarm-scale-plan-v2.md. Order: 10 → 10b → 10c → 11 → 12 → 14 → 13 → 15 → 16 (Swarm Watch, after Phase 14) → 17.
Rules: route cheapest first (anthropic Haiku → cursor → codex → claude after 2 failures; Hermes research only; OpenRouter bookkeeping only); one PR per phase with tests, CHANGELOG, version bump and the dogfood scoreboard in the PR description; never merge without Braden's OK; ask before raising a cap or adding a paid service; never touch dev2's model/disk/Strata without his go.

## Done
- Merged by Braden's OK: #103, #104, #105, #106 (v1.63.0 to v1.65.0). Shared runner (~/.project-swarm) is on 1.65.0; `swarm` command installed; alias still in ~/.zshrc (remove it; PATH line in ~/.zshenv).
- Phase 10b built on branch feat/phase10b-failover (v1.66.0): journal, brief, handoff, checkpoint, autopilot, generated HANDOFF.md, init pointers + Gemini + local Claude hook, remote-host fix (swarm-remote-exec now runs a command; real-host test), updater fix, `auto` doctor bug fix, project-root default for the shared runner. Claude Opus security review run ($0.78); all high/medium findings fixed. docs/failover.md written. Full suite 1957 pass.
- Lessons logged: 1 (remote hosts), 2 (updater).

## Running
- A background loop re-running tests/remote-exec-real.test.mjs against dev2 (the VPN drops most calls). Remote side is at /home/dev2/swarm-bench/remote-exec/ (remote-exec.mjs + wrapper swarm-remote-exec). Results: scratchpad real-loop.out. The test passed once for each of its 3 cases on earlier script versions; the final hardened script still needs one clean full pass.

## Open
- BLOCKED, waiting on Braden: the dev2 model swap. Strata 0.1.41 cannot be shown to load orcarouter Q3_K_M (expert gate/up are Q3_K, which Strata's native expert kernels do not handle; expert down is Q5_0, needs the opt-in Orca build). Strata documents IQ3_XXS (85.2 GB, 2 shards) and Q4_K_S (112 GB, special build). Nothing was deleted or downloaded. Options sent to Braden: IQ3_XXS, Q4_K_S, or Q3_K_M anyway with no deletion until it loads. dev2 facts: 91 GiB RAM (Strata uses ~60), RTX 5090 32 GB full, disk 86 GB free, Strata runs as user unit strata.service on :8000 (shared by hermes-dev sessions and the Cluer stack).
- Then: Hermes benchmark rerun at concurrency 1 on the new model, add to docs/state/lane-benchmark.md next to the IQ2_XS rows.
- After this PR merges: `swarm update` (the updater now runs the new installer, so the first update that includes the fix still runs the old one: run `node ~/.project-swarm/tools/install.mjs --user` once if the swarm command is missing).
- Phase 10c (inbox and unblocked work) is next after 10b.
- Hermes is research-only in routing; dev2 `hosts` entry stays enabled: false until Braden turns it on (remote hosts now work: add `commands` and `remoteExec` to it).

## Next 3 commands
1. `cat <scratchpad>/real-loop.out` (real-host test result; rerun `SWARM_TEST_SSH_HOST=dev2@10.10.10.220 SWARM_TEST_SSH_EXEC=/home/dev2/swarm-bench/remote-exec/swarm-remote-exec node --import ./tests/_isolate-config.mjs --test tests/remote-exec-real.test.mjs`)
2. `git add -A <10b files> && git commit && git push -u origin feat/phase10b-failover && gh pr create` (body: scoreboard from docs/state/dogfood.md)
3. Wait for CI + CodeQL, then report the PR ready; do not merge

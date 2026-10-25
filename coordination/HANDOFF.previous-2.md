# Handoff

Hand-written until Phase 10b ships; then `swarm brief` regenerates it. Updated after every step.

Last updated: 2026-10-15, after opening PR #106 (multi-edit) and applying the owner's routing decisions to #105.

## Goal
Plan: docs/plans/swarm-scale-plan-v2.md. Order: 10 → 10b → 10c → 11 → 12 → 14 → 13 → 15 → 16 (docs/plans/swarm-watch-spec.md, prototype in docs/design/; after Phase 14) → 17 (now includes the lane benchmark).
Rules: route cheapest-first; one PR per phase with tests, CHANGELOG, version bump and the dogfood scoreboard in the PR description; never merge without Braden's OK; ask before raising a cap or adding a paid service.
Dogfood rules: workers run on the INSTALLED runner (~/.project-swarm/current, still v1.62.0), never the working copy; update the runner only after Braden merges a phase; spend-cap/secrets/sensitive-routing/merge-queue changes get a Claude review job before the PR; keep docs/state/dogfood.md; use Swarm Watch once it ships.

## Open PRs (none merged; Braden merges in order #103 → #104 → #105 → #106 after review)
- #103 docs only: plan v2 + 10b/10c addendum + Swarm Watch spec/prototype + lane benchmark in Phase 17 + routing rule. Branch docs/plans-v2.
- #104 Phase 10, v1.63.0 (real swarm command...). Branch feat/phase10-swarm-command. 12 checks were green.
- #105 Lane benchmark + Hermes over ssh + Hermes parser fix + routing from the owner's decisions (anthropic→cursor→codex→claude; Hermes research only; OpenRouter bookkeeping only; test route codex→anthropic→cursor), v1.64.0, stacked on #104. Claude security reviews run on the ssh code and on the routing change; findings fixed. Branch feat/lane-benchmark-hermes-ssh.
- #106 Several ordered edits per file on API + Hermes/Qwen lanes (+ fix: Hermes dropped edits) + benchmark rerun, v1.65.0, stacked on #105. Branch feat/multi-edit. Rerun: Hermes 2→6/10, Sonnet 8→10, Haiku 9, OpenRouter 3.

## Done
- Benchmark: 7 lanes x 10 tasks; results in docs/state/lane-benchmark.md. Hermes ran on dev2 itself (bundle copied, only results-hermes.json came back).
- Machine config (~/.config/project-swarm/config.json): cliHosts.hermes (dev2, /home/dev2/.local/bin/hermes), lanes.hermes.model qwen3.8-flash-next-iq2_xs, lanes.anthropic haiku, lanes.openrouter gpt-oss-20b; dev2 `hosts` entry stays enabled: false (remote `hosts` don't work yet, see below).
- Claude security review of cli-host code run (Opus, $0.26); 5 findings fixed.

## Running
Nothing.

## Open
- BUG for the next phase PR (10b): remote `hosts` send no command to swarm-remote-exec, so remote jobs hang or return nothing; only stub-tested. Fix + a test against real dev2. Logged as lesson 1 (coordination/swarm-lessons.jsonl).
- Multi-edit is done in #106 (waiting for review).
- Hermes is out of the default order (research only) per Braden's decision. Next Hermes experiment: rerun at concurrency 1 on dev2 (3 of its 4 failures were CLI `exit 1` with no message). Bigger model options on dev2 were sent to Braden (nothing downloaded, ask first): IQ3_XXS/IQ3_S need ~80 GB of disk (86 GB free; would mean deleting the 64 GB IQ2_XS); UD-IQ4_XS is a 94 GB download.
- VPN to dev2 has ~90% packet loss; Tailscale later. Don't patch for it further.
- After #104 merges: `swarm update`, remove the alias from ~/.zshrc, PATH in ~/.zshenv (steps in the #104 description). After #105 merges: update the runner again and dev2's copy is no longer needed.
- Phase 10b itself (journal, brief, handoff, checkpoint, autopilot) and 10c (inbox) are not started. Cut 10b from main once #104/#105 merge (or stack on #105).

## Next 3 commands
1. `gh pr checks 105 --watch` (CI + CodeQL must be green before calling it ready)
2. `git checkout -b feat/phase10b-failover feat/lane-benchmark-hermes-ssh`, then write the 10b manifest (journal, brief, handoff, checkpoint, autopilot, remote-exec fix as separate jobs) and run it on the installed runner with `--root /Users/bean/project-swarm`
3. After each merge: `swarm update` (shared runner) and re-run `swarm doctor all`

# Dogfood scoreboard

One row per plan phase, built with the swarm itself. Rules (from Braden): workers run on the installed shared runner, never the working copy; the shared runner is updated only after a phase is merged; spend caps, secrets, sensitive routing and merge-queue code get a Claude review job before the PR; Swarm Watch is used on these runs once it ships.

| Phase | Jobs | First-try pass | Retries | Failures | Cost per lane | Claude share | Wall time (swarm run) | Waiting on Braden | Conflicts / bisects | Manual fixes by the orchestrator | Better or worse than the last phase |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- |
| 10 (real `swarm` command) | 3 | 100% (3 of 3) | 0 | 0 | codex: $0 reported (subscription), 71,179 tokens | 0% of jobs (the orchestrator session itself is Claude) | 2 m 10 s | none during the run | 0 / 0 | 5 (see below) | First row. Baseline. |

## Phase 10 notes

- **What the swarm built:** three self-contained modules with tests, on Codex: `tools/completion.mjs`, `tools/swarm-bin.mjs`, `tools/status.mjs`. All 21 of their tests passed on the first try.
- **What the orchestrator did by hand:** wiring into `tools/install.mjs`, `tools/swarm.mjs` (no-args status, completion commands, goal shorthand, first-run init), `swarm doctor`, 7 integration tests, docs, CHANGELOG and the version bump. These were not given to workers because they touch one large shared file and need judgment about the CLI.
- **Manual fixes after integration (5):** (1) the completion table had five wrong or generic command summaries; (2) it was missing `resume`, `ledger`, `idle`, `ticket` and `scaffold`; (3) the worker's usage-line regex broke when the help text gained a line, so the test was fixed; (4) status now probes loopback services so a configured but stopped Ollama shows as down; (5) the status module needed the real doctor and spend store passed in.
- **Rule exception:** Phase 10's run was started from the working copy (`node tools/swarm.mjs run ...`) before the installed-runner rule was given. Later phases run on `~/.project-swarm/current`.
- **Review job:** not needed for Phase 10. It changes no spend cap, secret handling, sensitive routing or merge-queue code.
- **Cost:** Codex jobs on the subscription report tokens but no dollars, so cost per lane is $0 reported.

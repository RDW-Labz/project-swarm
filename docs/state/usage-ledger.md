# Usage ledger

One row per worker call made while building the scale plan (`docs/plans/swarm-scale-plan.md`). Cost is rough: subscription CLIs report tokens, not dollars.

| date | phase | task | worker | model | result | tokens | rough cost |
|---|---|---|---|---|---|---|---|
| 2026-10-14 | 0 | claims-code: claims check in run/validate, smoke manifest, tests | codex | gpt-6.1-sol | pass | 40,841 | subscription |
| 2026-10-14 | 0 | claims-docs (first try): docs for the claims check | codex | gpt-6.1-sol | blocked: contract file not in HEAD worktree | 9,546 | subscription |
| 2026-10-14 | 0 | startable-fix: exclude claimed jobs from validate's startable list | codex | gpt-6.1-sol | pass | 51,496 | subscription |
| 2026-10-14 | 0 | claims-docs (retry, contract inlined) | codex | gpt-6.1-sol | pass | 28,917 | subscription |
| 2026-10-14 | 0 | ci-fix: Linux skip for doctor test, CodeQL regex-escaping alert | codex | gpt-6.1-sol | pass | 49,461 | subscription |
| 2026-10-14 | 1 | lanes-core: tools/lanes.mjs + tests | codex | gpt-6.1-sol | pass | 52,438 | subscription |
| 2026-10-14 | 1 | router: tools/router.mjs + tests | codex | gpt-6.1-sol | pass | 18,737 | subscription |
| 2026-10-14 | 1 | release-docs: 1.53.0 bump, docs/lanes.md, limits in docs | codex | gpt-6.1-sol | pass (self-flagged blocked: nested-sandbox tests only) | 74,353 | subscription |
| 2026-10-14 | 1 | lanes-fix: arrival order across lanes, pause never shortened | codex | gpt-6.1-sol | pass | 32,301 | subscription |
| 2026-10-14 | 1 | docs-fix: snapshot-changed + ordering docs | codex | gpt-6.1-sol | pass | 22,422 | subscription |
| 2026-10-14 | 1 | runner-lanes (attempt 1): runner integration | codex | gpt-6.1-sol | blocked: test file not in outputs (coordinator miss) | 102,212 | subscription |
| 2026-10-14 | 1 | runner-lanes-2 (attempt 2): runner integration + 500-job test | codex | gpt-6.1-sol | pass, 1 regression found in review | 230,411 | subscription |
| 2026-10-14 | 1 | shell-snapshot-fix: drop on-disk snapshot copies | codex | gpt-6.1-sol | pass | 54,215 | subscription |
| 2026-10-14 | 2 | types-code: job-types module, validation, router, examples, tests | codex | gpt-6.1-sol | pass | 103,395 | subscription |
| 2026-10-14 | 2 | types-docs: 1.54.0 release + job-types docs | codex | gpt-6.1-sol | pass (blocked only on sibling-owned examples) | 54,080 | subscription |
| 2026-10-14 | 2 | phase2-fixes: cheap-first router, sensitive default, docs rule | codex | gpt-6.1-sol | pass | 104,726 | subscription |
| 2026-10-14 | 4-pre | phase4-pre: ask --not-sensitive, openai/gemini/lambda need sensitive: false | codex | gpt-6.1-sol | pass (2 release pins left to coordinator) | 88,515 | subscription |
| 2026-10-14 | 4 | reports-code: reports module, strict/legacy reports, rollup, monitor view | codex | gpt-6.1-sol | pass (blocked on 1 out-of-scope test assertion) | 241,950 | subscription |
| 2026-10-14 | 4 | reports-docs: docs + changelog | codex | gpt-6.1-sol | blocked (runner design-only wording read as no-edit) | 10,973 | subscription |
| 2026-10-14 | 4 | reports-docs-2: retry with clarified prompt | codex | gpt-6.1-sol | pass | 97,869 | subscription |
| 2026-10-14 | 4 | phase4-review-fixes: untrusted worker text, report-only re-ask | codex | gpt-6.1-sol | pass | 123,100 | subscription |
| 2026-10-14 | fix | docs-only-wording: 1.55.1 prompt wording | codex | gpt-6.1-sol | pass (1 cursor test pin fixed by coordinator) | 49,501 | subscription |
| 2026-10-14 | 3 | queue-code: queue pass, bisect, requeue, merge jobs, CLI, monitor/rollup | codex | gpt-6.1-sol | pass | 136,303 | subscription |
| 2026-10-14 | 3 | queue-docs: merge-queue docs + changelog | codex | gpt-6.1-sol | pass | 94,637 | subscription |
| 2026-10-14 | 3 | queue-safety: batch journal, signal rollback, per-repo integrate lock | codex | gpt-6.1-sol | pass | 122,405 | subscription |
| 2026-10-14 | 6 | spend-core: tools/spend.mjs budgets, caps, ledger, idle menu + tests | codex | gpt-6.1-sol | pass | 61,198 | subscription |
| 2026-10-14 | 6 | spend-run: gates, pause/resume, ledger and idle wiring, CLI + tests | codex | gpt-6.1-sol | pass | 333,862 | subscription |
| 2026-10-14 | 6 | spend-docs (first try) | codex | gpt-6.1-sol | blocked: README/SKILL.md not in read context | 18,554 | subscription |
| 2026-10-14 | 6 | spend-docs (retry): docs/spend.md, README link, SKILL.md | codex | gpt-6.1-sol | pass | 60,219 | subscription |
| 2026-10-14 | 6 | spend-fixes-core: machine-wide spend store, reservations, cost estimates + tests | codex | gpt-6.1-sol | pass | 72,987 | subscription |
| 2026-10-14 | 6 | spend-fixes-run: reservation wiring, two-root and 64-job tests | codex | gpt-6.1-sol | pass | 100,515 | subscription |
| 2026-10-14 | 5 | leads-core: Implemented section A; 90 tests passed.; Deviation: oversized prompt goal, scope and out | codex | gpt-6.1-sol | pass | 42,962 | subscription |
| 2026-10-14 | 5 | leads-run: status: blocked. Existing type-lead fixtures lack required area; need access to tests/job | codex | gpt-6.1-sol | blocked: blocked: no summary given | 158,156 | subscription |
| 2026-10-14 | 5 | leads-docs: Documented lead areas, child validation, errors, lifecycle, integration, and rollups wit | codex | gpt-6.1-sol | pass | 44,416 | subscription |
| 2026-10-15 | - | completion: Implemented command metadata, zsh completion, and newest-first run discovery capped at 2 | codex | gpt-6.1-sol | pass | 21,256 | subscription |
| 2026-10-15 | - | swarm-bin: Implemented executable wrapper installation, safe quoting, foreign-file refusal, and comm | codex | gpt-6.1-sol | pass | 22,753 | subscription |
| 2026-10-15 | - | status: Implemented project status, five suggested commands, and compact plain-text formatting.; All | codex | gpt-6.1-sol | pass | 27,170 | subscription |
| 2026-10-15 | - | review-cli-host: Quoting (shellQuote/sshInvocation) is sound for POSIX remote shells, the message tr | claude | opus | pass | 8,619 | $0.26 |
| 2026-10-15 | - | review-routing: Through routeJob a sensitive job cannot reach OpenRouter: the check at router.mjs:34 | claude | opus | pass | 9,138 | $0.29 |
| 2026-10-15 | - | journal: Anthropic response truncated: stop_reason max_tokens | anthropic | claude-haiku-5-5 | failed: Anthropic response truncated: stop_reason max_tokens | - | $0.01 |
| 2026-10-15 | - | brief: Anthropic response truncated: stop_reason max_tokens | anthropic | claude-haiku-5-5 | failed: Anthropic response truncated: stop_reason max_tokens | - | $0.01 |
| 2026-10-15 | - | autopilot: Anthropic response truncated: stop_reason max_tokens | anthropic | claude-haiku-5-5 | failed: Anthropic response truncated: stop_reason max_tokens | - | $0.01 |
| 2026-10-15 | - | remote-exec: Implemented request/response protocol, isolated workspaces, environment filtering, outp | codex | gpt-6.1-sol | pass | 83,417 | subscription |
| 2026-10-15 | - | journal: Implemented tools/journal.mjs per design section 1 (exports KINDS, journalPath, appendEvent | anthropic | claude-haiku-5-5 | pass | 38,200 | $0.02 |
| 2026-10-15 | - | brief: Implemented tools/brief.mjs (loadRuns, buildBrief, renderBrief, renderHandoff, renderAgentHan | anthropic | claude-haiku-5-5 | pass | 37,890 | $0.01 |
| 2026-10-15 | - | autopilot: Implements tools/autopilot.mjs per design section 3 (decide, nextWave, autopilotStep, run | anthropic | claude-haiku-5-5 | pass | 36,276 | $0.01 |
| 2026-10-15 | - | review-10b: Phase 10b review, no edits. remote-exec path, symlink, command and env checks hold. Two | claude | opus | pass | 26,335 | $0.78 |
| 2026-10-15 | - | inbox: Implements tools/inbox.mjs (collectInbox, formatInbox, markDone, decide, plus helpers depende | anthropic | claude-haiku-5-5 | pass | 35,180 | $0.01 |
| 2026-10-15 | - | backlog: Implements tools/backlog.mjs for section 3 of the Phase 10c design: readBacklog, addGoal, r | anthropic | claude-haiku-5-5 | pass | 29,965 | $0.01 |
| 2026-10-15 | - | notify: Implemented tools/notify.mjs (pendingNotifications and macNotify per design section 4) and t | anthropic | claude-haiku-5-5 | pass | 14,204 | $0.00 |
| 2026-10-15 | - | review-10c: complete | claude | opus | pass | 12,922 | $0.43 |
| 2026-10-15 | - | plan-preview: Anthropic response truncated: stop_reason max_tokens | anthropic | claude-haiku-5-5 | failed: Anthropic response truncated: stop_reason max_tokens | - | $0.02 |
| 2026-10-15 | - | plan-preview: Anthropic response truncated: stop_reason max_tokens | anthropic | claude-haiku-5-5 | failed: Anthropic response truncated: stop_reason max_tokens | - | $0.02 |
| 2026-10-15 | - | module: Creates tools/plan-preview.mjs implementing the phase 11 contract: PRIORS, estimatePlan, for | anthropic | claude-haiku-5-5 | pass | 39,408 | $0.01 |
| 2026-10-15 | - | tests: Adds tests/plan-preview.test.mjs covering the Phase 11 estimate formulas, calibration ratios | anthropic | claude-haiku-5-5 | pass | 25,280 | $0.01 |
| 2026-10-15 | - | review-11: Phase 11 review: 4 high, 8 medium, 5 low. Biggest: (1) on a dirty tree in a project witho | claude | opus | pass | 15,071 | $0.43 |
| 2026-10-15 | - | profile-module: Wrote tools/init-profile.mjs covering sections 1 and 3 of the design: detectProtecte | anthropic | claude-haiku-5-5 | pass | 42,192 | $0.02 |
| 2026-10-15 | - | profile-tests: Wrote tests/init-profile.test.mjs covering sections 1 and 3 of the Phase 12 design ag | anthropic | claude-haiku-5-5 | pass | 40,306 | $0.02 |
| 2026-10-15 | - | map-module: Implements section 2 of the phase 12 design in tools/repo-map.mjs: buildRepoMap (increme | anthropic | claude-haiku-5-5 | pass | 39,528 | $0.02 |
| 2026-10-15 | - | map-tests: Adds tests/repo-map.test.mjs for tools/repo-map.mjs (section 2 of the design). It covers | anthropic | claude-haiku-5-5 | pass | 30,087 | $0.01 |

## Daily summary

| date | tier | calls | pass | fail/blocked | tokens | rough cost |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-14 | codex | 34 | 29 | 5 | 2,887,673 | subscription |
| 2026-10-15 | anthropic | 17 | 12 | 5 | 408,516 | $0.22 |
| 2026-10-15 | claude | 5 | 5 | 0 | 72,085 | $2.19 |
| 2026-10-15 | codex | 4 | 4 | 0 | 154,596 | subscription |

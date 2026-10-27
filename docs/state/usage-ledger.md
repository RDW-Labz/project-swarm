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
| 2026-10-15 | - | review-12: complete | claude | opus | pass | 16,779 | $0.53 |
| 2026-10-15 | - | review-14: complete | claude | opus | pass | 17,924 | $0.47 |
| 2026-10-15 | - | link-module: Implements section 1 of phase14b-design as tools/brain-link.mjs: openBrainLink with inj | anthropic | claude-haiku-5-5 | pass | 23,083 | $0.01 |
| 2026-10-15 | - | link-tests: Wrote tests/brain-link.test.mjs for tools/brain-link.mjs (section 1 of the design) using | anthropic | claude-haiku-5-5 | pass | 21,980 | $0.01 |
| 2026-10-15 | - | brain-module: Creates tools/brain.mjs implementing section 2 of the design: a bounded queue (concurr | anthropic | claude-haiku-5-5 | pass | 20,129 | $0.01 |
| 2026-10-15 | - | brain-tests: Adds tests/brain.test.mjs for tools/brain.mjs as specified in section 2 of docs/plans/p | anthropic | claude-haiku-5-5 | pass | 23,811 | $0.01 |
| 2026-10-15 | - | tasks-module: Implements section 3 of the design in tools/brain-tasks.mjs: think, digest, triage, dr | anthropic | claude-haiku-5-5 | pass | 28,587 | $0.01 |
| 2026-10-15 | - | tasks-tests: Adds tests/brain-tasks.test.mjs for tools/brain-tasks.mjs, using injected fake ask func | anthropic | claude-haiku-5-5 | pass | 22,244 | $0.01 |
| 2026-10-15 | - | review-14b: Phase 14b safety review. Highs: think ignores project sensitivity, so it can fall back t | claude | opus | pass | 64,577 | $0.56 |
| 2026-10-16 | - | f1-rules: Adds the pinned local Semgrep rule file tools/security-rules/semgrep-local.yml with JavaSc | anthropic | claude-haiku-5-5 | pass | 5,967 | $0.00 |
| 2026-10-16 | - | f1-router: Updated tools/router.mjs only. Added exported RENTED_MIN_READY = 700 and a ready option: | anthropic | claude-haiku-5-5 | pass | 8,014 | $0.00 |
| 2026-10-16 | - | f1-lanes: Changed the anthropic default concurrency from 16 to 32 with one edit to tools/lanes.mjs, | anthropic | claude-haiku-5-5 | pass | 16,126 | $0.00 |
| 2026-10-16 | - | f1-profile: Rewrote tools/init-profile.mjs with the requested changes limited to validateSecurity: c | anthropic | claude-haiku-5-5 | pass | 19,626 | $0.01 |
| 2026-10-16 | - | f1-rules-fix: Updated only the swarm-js-exec-injection rule in tools/security-rules/semgrep-local.ym | anthropic | claude-haiku-5-5 | pass | 5,641 | $0.00 |
| 2026-10-16 | - | f2-gate: Updated tools/security-gate.mjs for the A1 follow-up: pinned local semgrep rules with hash | anthropic | claude-haiku-5-5 | pass | 25,695 | $0.01 |
| 2026-10-16 | - | f3-rented-run: Rewrote tests/rented-run.test.mjs only. The failing GPU-session test (test 9) no long | anthropic | claude-haiku-5-5 | pass | 51,839 | $0.01 |
| 2026-10-16 | - | f3-lanes: Updated tests/lanes.test.mjs for the anthropic lane default concurrency change (16 to 32). | anthropic | claude-haiku-5-5 | pass | 57,817 | $0.01 |
| 2026-10-16 | - | f3-security-gate: Updated tests/security-gate.test.mjs for the local-by-default Semgrep gate. Rewrot | anthropic | claude-haiku-5-5 | pass | 72,973 | $0.01 |
| 2026-10-16 | - | f3-security-queue: Updated tests/security-queue.test.mjs as a full file. Rewrote the failing 'semgre | anthropic | claude-haiku-5-5 | pass | 62,326 | $0.01 |
| 2026-10-16 | - | f3-router: Updated tests/router.test.mjs by keeping every existing test unchanged (test-failures.txt | anthropic | claude-haiku-5-5 | pass | 48,314 | $0.01 |
| 2026-10-16 | - | f3-init-profile: Updated tests/init-profile.test.mjs as a full-file rewrite. Kept all existing tests | anthropic | claude-haiku-5-5 | pass | 52,837 | $0.01 |
| 2026-10-16 | - | f3-plain: Adds tests/security-plain-integrate.test.mjs covering the plain integrateRun gate: planted | anthropic | claude-haiku-5-5 | pass | 21,941 | $0.00 |
| 2026-10-16 | - | f4-lanes-doc: Adds two sections (Haiku rate limits and lane concurrency; Which lane gets a ticket) d | anthropic | claude-haiku-5-5 | pass | 7,342 | $0.00 |
| 2026-10-16 | - | f4-gate-doc: Returned exact-text edits for docs/security-gate.md only. Fixed the two sentences sayin | anthropic | claude-haiku-5-5 | pass | 6,633 | $0.00 |
| 2026-10-16 | - | f4-changelog: Inserted 1.80.0 directly after the changelog heading with both supplied bullets.; chec | codex | gpt-6.1-sol | pass | 15,947 | subscription |
| 2026-10-16 | - | f4-dogfood: Added the requested A1 follow-up bullet after the last "- A1 security gate:" bullet in t | anthropic | claude-haiku-5-5 | pass | 12,873 | $0.00 |
| 2026-10-16 | - | review-a1-followup: Partial review. Section (1), listing every write path beyond plain integrate and | claude | opus | blocked: blocked: Partial review. Section (1), listing every write pa | 46,296 | $0.42 |
| 2026-10-16 | - | g1-rules: Returned the complete tools/security-rules/semgrep-local.yml with all existing rules uncha | anthropic | claude-haiku-5-5 | pass | 7,888 | $0.00 |
| 2026-10-16 | - | g2-gate: Rewrote tools/security-gate.mjs with the requested changes: pinned rules hash 3ad961b2..., | anthropic | claude-haiku-5-5 | pass | 37,524 | $0.01 |
| 2026-10-16 | - | g2-deps: Changed manifest detection in parseDeps so the last path segment is lower-cased before matc | anthropic | claude-haiku-5-5 | pass | 13,420 | $0.00 |
| 2026-10-16 | - | g3-security-gate: Rewrote tests/security-gate.test.mjs as a complete file. Fixed the exact-map UNPAR | anthropic | claude-haiku-5-5 | pass | 63,662 | $0.02 |
| 2026-10-16 | - | g3-security-queue: Updated tests/security-queue.test.mjs. The failing test (sensitive project runs t | anthropic | claude-haiku-5-5 | pass | 42,123 | $0.01 |
| 2026-10-16 | - | g3-security-plain-integrate: Updated tests/security-plain-integrate.test.mjs. The made-up-dependency | anthropic | claude-haiku-5-5 | pass | 29,860 | $0.00 |
| 2026-10-16 | - | g3-field-lessons-batch-a: Updated tests/field-lessons-batch-a.test.mjs only. The two failing L109 su | anthropic | claude-haiku-5-5 | pass | 45,667 | $0.01 |
| 2026-10-16 | - | g3-field-lessons-batch-e: Returned the complete tests/field-lessons-batch-e.test.mjs. The only chang | anthropic | claude-haiku-5-5 | pass | 57,101 | $0.01 |
| 2026-10-16 | - | g3-field-lessons-batch-f: Updated tests/field-lessons-batch-f.test.mjs in full. The only change is i | anthropic | claude-haiku-5-5 | pass | 41,341 | $0.01 |
| 2026-10-16 | - | g3-gpu: Rewrote the failing rented-lane routing test in tests/gpu.test.mjs to pass ready: 700, which | anthropic | claude-haiku-5-5 | pass | 42,970 | $0.01 |
| 2026-10-16 | - | g3-deps: Rewrote tests/security-deps.test.mjs as a full file and added one test covering newDependen | anthropic | claude-haiku-5-5 | pass | 25,541 | $0.01 |
| 2026-10-16 | - | g3-router: Adds tests/router-ready.test.mjs covering routeJob's ready-count threshold for the rented | anthropic | claude-haiku-5-5 | pass | 12,161 | $0.00 |
| 2026-10-16 | - | g4-doc: Rewrote docs/security-gate.md as one complete file to match the supplied code after the A1 f | anthropic | claude-haiku-5-5 | pass | 18,504 | $0.00 |
| 2026-10-16 | - | g4-changelog: Added the supplied bullet after the last bullet in section 1.80.0.; checksRun: not run | codex | gpt-6.1-sol | pass | 15,677 | subscription |
| 2026-10-16 | - | g4-dogfood: Added the requested Review bullet immediately after the A1 follow-up and router bullet i | anthropic | claude-haiku-5-5 | pass | 13,135 | $0.00 |
| 2026-10-16 | - | p13-scope: Wrote tools/scope.mjs per design section 1: SCOPE_TEMPLATE, parseScope, checkScope (all l | anthropic | claude-haiku-5-5 | pass | 23,518 | $0.01 |
| 2026-10-16 | - | p13-tickets: Wrote tools/tickets.mjs per design section 2: status and type constants, validateTicket | anthropic | claude-haiku-5-5 | pass | 30,987 | $0.01 |
| 2026-10-16 | - | p13-integrity: Wrote tools/scope-integrity.mjs with checkTicketTree, summarizeTree and formatSummary | anthropic | claude-haiku-5-5 | pass | 22,720 | $0.01 |
| 2026-10-16 | - | p13-change: Worker returned an invalid, duplicate, or undeclared output: edits[].find cannot be empt | anthropic | claude-haiku-5-5 | failed: Worker returned an invalid, duplicate, or undeclared output: | - | $0.00 |
| 2026-10-16 | - | p13-day0: Wrote tools/day0.mjs with DAY0_CATALOG, day0Checklist(scope, {extra}) and checklistToTicke | anthropic | claude-haiku-5-5 | pass | 17,379 | $0.00 |
| 2026-10-16 | - | p13-approval: Wrote tools/approval-policy.mjs per design section 7: DEFAULT_APPROVAL (frozen), valid | anthropic | claude-haiku-5-5 | pass | 14,727 | $0.00 |
| 2026-10-16 | - | p13-ticket-manifest: Wrote tools/ticket-manifest.mjs per design section 8: ticketsToManifest and tic | anthropic | claude-haiku-5-5 | pass | 15,988 | $0.00 |
| 2026-10-16 | - | p13-scope: Created tools/scope.mjs implementing SCOPE_TEMPLATE, parseScope, checkScope, requirementT | anthropic | claude-haiku-5-5 | pass | 22,749 | $0.01 |
| 2026-10-16 | - | p13-tickets: Wrote tools/tickets.mjs as a new file following the design's section 2: ticket validati | anthropic | claude-haiku-5-5 | pass | 32,626 | $0.01 |
| 2026-10-16 | - | p13-integrity: Created tools/scope-integrity.mjs implementing checkTicketTree, summarizeTree and for | anthropic | claude-haiku-5-5 | pass | 24,043 | $0.01 |
| 2026-10-16 | - | p13-change: Created tools/change-orders.mjs implementing diffScopes, impactAnalysis, nextChangeOrder | anthropic | claude-haiku-5-5 | pass | 16,665 | $0.00 |
| 2026-10-16 | - | p13-day0: Created tools/day0.mjs as a new file with the DAY0_CATALOG, day0Checklist and checklistToT | anthropic | claude-haiku-5-5 | pass | 18,702 | $0.00 |
| 2026-10-16 | - | p13-approval: Created tools/approval-policy.mjs as a new file per design section 7: DEFAULT_APPROVAL | anthropic | claude-haiku-5-5 | pass | 14,391 | $0.00 |
| 2026-10-16 | - | p13-ticket-manifest: Adds tools/ticket-manifest.mjs implementing section 8: ticketsToManifest (ready | anthropic | claude-haiku-5-5 | pass | 16,492 | $0.00 |
| 2026-10-16 | - | p13-contracts: Anthropic response truncated: stop_reason max_tokens | anthropic | claude-haiku-5-5 | failed: Anthropic response truncated: stop_reason max_tokens | - | $0.02 |
| 2026-10-16 | - | p13t-scope: Provider transport failed; check endpoint, connectivity, and redirect policy | anthropic | claude-haiku-5-5 | failed: Provider transport failed; check endpoint, connectivity, and | - | $0.09 reserved |
| 2026-10-16 | - | p13t-tickets: Adds tests/tickets.test.mjs with 19 node:test cases for tools/tickets.mjs, covering va | anthropic | claude-haiku-5-5 | pass | 26,476 | $0.01 |
| 2026-10-16 | - | p13t-integrity: Wrote tests/scope-integrity.test.mjs with 16 node:test cases against tools/scope-int | anthropic | claude-haiku-5-5 | pass | 33,933 | $0.01 |
| 2026-10-16 | - | p13t-change: Adds tests/change-orders.test.mjs with 19 node:test cases for diffScopes, impactAnalysi | anthropic | claude-haiku-5-5 | pass | 21,586 | $0.01 |
| 2026-10-16 | - | p13t-day0: Wrote tests/day0.test.mjs with 15 node:test cases for tools/day0.mjs (day0Checklist and c | anthropic | claude-haiku-5-5 | pass | 29,199 | $0.01 |
| 2026-10-16 | - | p13t-approval: Provider transport failed; check endpoint, connectivity, and redirect policy | anthropic | claude-haiku-5-5 | failed: Provider transport failed; check endpoint, connectivity, and | - | $0.09 reserved |
| 2026-10-16 | - | p13t-ticket-manifest: Wrote tests/ticket-manifest.test.mjs with 15 node:test cases for ticketsToMani | anthropic | claude-haiku-5-5 | pass | 27,213 | $0.01 |
| 2026-10-18 | - | review-spend-cap: Spend-cap review: 2 HIGH (resume skips the project cap and can raise per-run caps | claude | opus | pass | 89,523 | $0.61 |
| 2026-10-18 | - | review-central-checks: Reviewed central-checks.mjs, project-spend.mjs, the test file and the diff (s | claude | opus | pass | 43,076 | $0.40 |
| 2026-10-18 | - | review-down-dir: Reviewed down-dir diff, migration-gate, migration-queue, safety-commands and the do | claude | opus | pass | 73,843 | $0.46 |
| 2026-10-18 | - | review-lane-risk: No high-severity issues. Old ledgers still verify (canon drops undefined); re-appr | claude | opus | pass | 372,241 | $0.72 |
| 2026-10-18 | - | review-cap-reroute: Caps are not bypassed (rerouted job re-runs admission/reserveSpend; run-cap and | claude | opus | pass | 355,570 | $0.62 |
| 2026-10-18 | - | review-scope-loop: Reviewed the go --scope loop. 2 HIGH: Ctrl-C (SIGINT swallowed by runManifestChec | claude | opus | pass | 1,798,301 | $1.73 |
| 2026-10-18 | - | review-scope-loop-2: No high findings. Three medium: Ctrl-C outside the agent run can be ignored (a | claude | opus | pass | 965,324 | $1.39 |
| 2026-10-18 | - | review-watch-leftovers: I made no edits. Fix-ticket gating holds on every status path I could read. | claude | opus | pass | 1,548,377 | $1.75 |
| 2026-10-18 | - | review-s11-fixes: Template-context: whole file contents sent with no value guard and override of exp | claude | opus | pass | 208,304 | $0.74 |
| 2026-10-18 | - | review-budgets-models: Reviewed A2 budgets and B3 model watch from the diff plus ci-hooks/init-profi | claude | opus | pass | 336,492 | $1.00 |
| 2026-10-18 | - | review-board-1: Board review. Routes are safe: token, GET/HEAD-only and Host checks hold, projects a | claude | opus | pass | 468,460 | $1.10 |
| 2026-10-18 | - | review-board-2: Reviewed machine-wide fair sharing in tools/lanes.mjs plus wiring in swarm.mjs, boar | claude | opus | pass | 209,756 | $0.74 |
| 2026-10-18 | - | review-board-nav: No HIGH issues. Token separation, GET/HEAD only, Host check, server-side project i | claude | opus | pass | 129,750 | $0.50 |
| 2026-10-18 | - | review-errors: Reviewed the Phase 19 part 1 errors diff; no files edited. Proposal gating holds in r | claude | opus | pass | 275,150 | $1.26 |
| 2026-10-19 | - | review-client-report: complete | claude | opus | pass | 93,551 | $0.58 |
| 2026-10-19 | - | review-quotes: Reviewed quotes.diff (quotes.mjs, quote-commands.mjs, swarm/completion wiring, tests) | claude | opus | pass | 85,088 | $0.46 |
| 2026-10-19 | - | review-phone: Reviewed phone.diff (phone.mjs, phone-commands.mjs, tests, wiring) against inbox.mjs d | claude | opus | pass | 179,306 | $0.65 |
| 2026-10-19 | - | review-board-inbox: Read-only, textContent-only rendering and the token check hold. Main problems: t | claude | opus | pass | 59,636 | $0.33 |
| 2026-10-19 | - | review-watch-ui: Read-only review of the watch-ui diff; no files edited. 1 high-severity finding (a | claude | opus | pass | 454,439 | $1.22 |
| 2026-10-19 | - | review-remote: Reviewed swarm remote (remote.mjs, watch-server.mjs, qr.mjs, tests, docs). Main issue | claude | opus | pass | 253,259 | $0.89 |
| 2026-10-19 | - | review-installed-swarm: Review of installed-swarm.diff: no edits made, nothing executed (shell not p | claude | opus | pass | 621,677 | $0.96 |
| 2026-10-19 | - | review-kit-interview: Kit install can write outside the project via a linked root .gitignore and edi | claude | opus | pass | 498,760 | $0.92 |
| 2026-10-19 | - | review-hard-caps: Reviewed hard-caps.diff. Spend can still pass a cap: subscription reservations are | claude | opus | pass | 190,440 | $0.72 |
| 2026-10-20 | - | review3-p1: Reviewed the first third of the shell-writes.mjs diff only. Found 8 concrete gaps: $'... | claude | opus | pass | 27,851 | $0.26 |
| 2026-10-20 | - | review3-p2: Six concrete misreads in the middle third of the diff. find: -delete is ignored when -ex | claude | opus | pass | 24,893 | $0.22 |
| 2026-10-20 | - | review3-p3: Reviewed the last third of shell-writes.mjs from p3.diff. Here-document, eval, sh -c and | claude | opus | pass | 28,408 | $0.18 |
| 2026-10-20 | - | review3-p4: Four reproducible findings. A symlinked routing path hides edits because isHandBuilt use | claude | opus | pass | 21,402 | $0.16 |
| 2026-10-20 | - | review3-h1: Reviewed h1.diff only (first half of handbuild.mjs); nothing edited and nothing run. App | claude | opus | pass | 44,802 | $0.50 |
| 2026-10-20 | - | review3-h2: I reviewed the second half of handbuild.mjs from h2.diff by reading it only; no files ch | claude | opus | pass | 30,980 | $0.29 |
| 2026-10-20 | - | review3-h3: self-approval.mjs is a regex denylist that misses direct node tools/swarm.mjs handbuild | claude | opus | pass | 21,727 | $0.18 |
| 2026-10-20 | - | review3-c1: Found 5 ways around the c1 checks. Worst: the chat-merge hook trusts stdin it can't veri | claude | opus | pass | 24,830 | $0.20 |
| 2026-10-20 | - | w8-policy: Tightened git push/fetch policy (refspecs, remote validation, GIT_ env, no early allow af | cursor | composer-2.5 | pass | - | subscription |
| 2026-10-20 | - | w8-parser: analyzeShell: dynamic flag; git push refspecs/positionals; expanded hasConfig; find -exec | cursor | composer-2.5 | pass | - | subscription |
| 2026-10-20 | - | w8-selfapproval: complete | cursor | composer-2.5 | pass | - | subscription |
| 2026-10-20 | - | y2-git-hooks: complete | cursor | composer-2.5 | pass | - | subscription |
| 2026-10-20 | - | w8-docs: complete | cursor | composer-2.5 | pass | - | subscription |
| 2026-10-21 | - | s8-burst-gates: Added S8 requirements R-050 (GPU burst gates) and R-051 (cloud CPU test/e2e runners) | cursor | composer-2.5 | pass | - | subscription |
| 2026-10-27 | - | d-fix-gc-ledger-autopilot: 37 flagged catches updated; checksRun all passed; gc: 12 narrowed, 3 visi | cursor | composer-2.5 | pass | - | subscription |
| 2026-10-27 | - | ask-1793115390244-d531b567: complete | claude | opus | pass | 25,389 | $0.18 |

## Daily summary

| date | tier | calls | pass | fail/blocked | tokens | rough cost |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-14 | codex | 34 | 29 | 5 | 2,887,673 | subscription |
| 2026-10-15 | anthropic | 23 | 18 | 5 | 548,350 | $0.28 |
| 2026-10-15 | claude | 8 | 8 | 0 | 171,365 | $3.75 |
| 2026-10-15 | codex | 4 | 4 | 0 | 154,596 | subscription |
| 2026-10-16 | anthropic | 52 | 48 | 4 | 1,336,255 | $0.48 (incl. estimates) |
| 2026-10-16 | claude | 1 | 0 | 1 | 46,296 | $0.42 |
| 2026-10-16 | codex | 2 | 2 | 0 | 31,624 | subscription |
| 2026-10-18 | claude | 14 | 14 | 0 | 6,874,167 | $13.02 |
| 2026-10-19 | claude | 9 | 9 | 0 | 2,436,156 | $6.73 |
| 2026-10-20 | claude | 8 | 8 | 0 | 224,893 | $1.99 |
| 2026-10-20 | cursor | 5 | 5 | 0 | 0 | subscription |
| 2026-10-21 | cursor | 1 | 1 | 0 | 0 | subscription |
| 2026-10-27 | claude | 1 | 1 | 0 | 25,389 | $0.18 |
| 2026-10-27 | cursor | 1 | 1 | 0 | 0 | subscription |
| **total** | all | 163 | 148 | 15 | 14,736,764 | $26.85 (incl. estimates) |

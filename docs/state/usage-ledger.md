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

## Daily summary

| date | tier | calls | pass | fail/blocked | tokens | rough cost |
|---|---|---|---|---|---|---|
| 2026-10-14 | codex | 15 | 13 | 2 | 924,825 | subscription |

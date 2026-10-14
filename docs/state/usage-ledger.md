# Usage ledger

One row per worker call made while building the scale plan (`docs/plans/swarm-scale-plan.md`). Cost is rough: subscription CLIs report tokens, not dollars.

| date | phase | task | worker | model | result | tokens | rough cost |
|---|---|---|---|---|---|---|---|
| 2026-10-14 | 0 | claims-code: claims check in run/validate, smoke manifest, tests | codex | gpt-6.1-sol | pass | 40,841 | subscription |
| 2026-10-14 | 0 | claims-docs (first try): docs for the claims check | codex | gpt-6.1-sol | blocked: contract file not in HEAD worktree | 9,546 | subscription |
| 2026-10-14 | 0 | startable-fix: exclude claimed jobs from validate's startable list | codex | gpt-6.1-sol | pass | 51,496 | subscription |
| 2026-10-14 | 0 | claims-docs (retry, contract inlined) | codex | gpt-6.1-sol | pass | 28,917 | subscription |

## Daily summary

| date | tier | calls | pass | fail/blocked | tokens | rough cost |
|---|---|---|---|---|---|---|
| 2026-10-14 | codex | 4 | 3 | 1 | 130,800 | subscription |

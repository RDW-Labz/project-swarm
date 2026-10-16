# Ideas parking lot

The plan ([swarm-scale-plan-v2.md](swarm-scale-plan-v2.md)) is **frozen**: no new phases unless Braden says so. Any new idea, from Braden or from the orchestrator, goes here, not into the plan. An idea moves into the plan only when Braden says so.

Build order now: **14e → A1 security gate → 13**. After 13, dogfood on the parts request app as the first real test, and record what broke as lessons.

## Accepted (being built)

- **A1 security gate** (merge queue: secret scan, package check, known vulnerabilities, code scan, licence check; each block writes a lesson). Right after 14e. Spec: [swarm-more-upgrades-spec.md](swarm-more-upgrades-spec.md), section A1.
- **B2 shared prefix caching** and **B1 best-of-N on our own GPUs**, as part of 14e and its bake-off (N=1 vs N=3 pass rate; cache hit rate). Spec: sections B1 and B2.

## Parked (from [swarm-more-upgrades-spec.md](swarm-more-upgrades-spec.md); not scheduled)

- A2 accessibility and speed budgets (Lighthouse, axe on preview deploys).
- A3 safe database changes (tested rollbacks, fake-data dry run, human approval for destructive changes).
- B3 automatic model upgrades (`swarm models watch`; needs the eval set and a pre-approved short GPU rental cap).
- C1 errors become tickets; C2 handoff docs at each stage's final PR.
- D1 client progress reports; D2 better quotes (`swarm time`, `swarm quote`).
- E: panic button (`swarm stop --all`), phone inbox, encrypted state backups.

## New ideas

Add one line each, with the date and who had it. Do not build from this list without Braden's OK.

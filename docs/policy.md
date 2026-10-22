# Machine autonomy policy

Per-machine `policy.json` beside swarm config lists which standing approvals may run without waiting on the owner. Built-in defaults encode the owner’s standing approvals; the file only narrows them (disable rules, optional per-project or daily caps).

## Never auto-approved

These request kinds are always `needs-owner`. No `policy.json` entry can auto-approve them:

- `merge-other-repo`
- `new-paid-service`
- `new-key`
- `new-account`
- `new-secret`
- `spend-past-daily-limit`
- `irreversible-action`
- `deploy`
- `publish`
- `hand-edit-app-code`
- `auth-change`
- `payments-change`
- `override`
- `accept-unmet-acceptance`

New API keys, new accounts, new paid services, spend past the daily auto limit, and irreversible actions always need the owner.

## Boolean facts

Guard facts must be exactly `true` or `false`. Missing values, `null`, or other types are not treated as true or false and block auto-approve for rules that require a specific boolean.

## Default auto-approve rules

Each rule has an `id`, a one-line description, and is `enabled: true` in defaults.

| Rule id | Request kind(s) | Standing approval |
| --- | --- | --- |
| `merge-swarm-pr` | `merge-pr` | Swarm-repo merge when `repoClass` is `swarm`, `ciGreen`, `reviewsPass`, `fullSuiteGreen`, and `inMergeOrder` are `true` and `deploysLiveSite` is `false`. |
| `merge-live-site` | `merge-pr` | Swarm-repo merge that deploys a live site when `deploysLiveSite` is `true` and `ciGreen`, `fullE2eGreen`, `reviewsPass`, `postDeployWatch`, `autoRollback`, and `inMergeOrder` are `true`, and `irreversible` and `pastDailyAutoLimit` are `false`. |
| `hosted-migration` | `hosted-db-migration` | Hosted DB migration when `backwardCompatible`, `backupTaken`, `dryRunPassed`, and `mainE2eProof` are `true` and `destructive` and `irreversible` are `false`. |
| `branch-switch` | `branch-switch` | Switch to `branch` when the name is a plain branch (letters, digits, `.`, `_`, `/`, `-`, no `:`) and `force` is `false`. |
| `journal-restore` | `journal-restore` | Restore when every path in `files` is exactly one of: `coordination/HANDOFF.md`, `docs/state/usage-ledger.md`, `coordination/TASK.md`, `docs/scope/build-plan.md` (case-insensitive; no `..` segments). |
| `swarm-update-idle` | `swarm-update` | Swarm update when `machineIdle` and `afterReleaseMerge` are `true`. |
| `commit-push-swarm-branch` | `commit-push-swarm-branch` | Commit or push swarm-produced files on a branch that is not `main` or `master` (`allSwarmProduced` `true`, `branch` a non-empty plain string). |
| `commit-window-generated` | `hand-build-request` | Commit window (`commitWindow` `true`, `minutes` a positive integer capped at 120) when every path in `files` is a swarm-generated path (`docs/scope/`, `coordination/manifests/`, `coordination/handoff/`, `coordination/HANDOFF.md`, `coordination/TASK.md`, `coordination/review/`, `docs/state/`, or `.swarm/project/` ledger files `tickets.json`, `tickets.log`, `backlog.json`, `scope.snapshot.md`; not `docs/plans/ideas.md`), paths are normalized under `root` with no `..` or symlink escape, `git` is only `commit` and/or `push`, and `branch` is a non-protected plain string. One non-generated file needs the owner. |
| `setup-and-routing-hand-build` | `hand-build-request` | Hand-build when every path in `files` is a routing path (see `tools/routing-paths.mjs`) or a setup file (`.gitignore`, `CLAUDE.md`, `AGENTS.md`, `.project-swarm.json`, `coordination/checks.json`), `git` is empty or only `commit` / `push`, and `branch` is a non-empty plain string on a non-protected branch. |
| `ticket-routine` | `ticket-set-status`, `ticket-park`, `ticket-retry`, `ticket-release` | Routine ticket ops; `ticket-set-status` uses explicit `status` (or `to` / `newStatus`), trimmed and lower-cased. Missing status or done synonyms (`done`, `completed`, `closed`, `shipped`, `merged`) need the owner when `requiresReview` is not `false` and `reviewPassed` is not `true`. |
| `change-order-path-fix` | `change-order-path-fix` | Path-fix change order for a named project. |
| `change-order-split` | `change-order-split` | Split change order for a named project. |
| `change-order-rename-only` | `change-order` | Rename-only scope change when `renameOnly` is `true`, `addedRequirements` and `removedRequirements` are `0`, `cancelsTickets` and `reopensTickets` are `0`, `renames` has one to five `{from,to}` pairs with no protected path (coordination/checks.json, `.project-swarm.json`, `.github/workflows/*`, package lockfiles, secrets-looking names), and `hasApprovedLedger` is `true`. |
| `workflow-change` | `workflow-change` | Workflow change when `opusReviewPassed` is `true`, `isNewWorkflow` is strictly `false`, and `addsSecrets`, `addsDeploy`, and `addsPublish` are `false`. |
| `cap-raise-small` | `cap-raise` | Spend cap raise when `amountUsd` is positive, `raisedTodayUsd` + `amountUsd` ≤ 5 for that project on the US Central calendar day, and `pastDailyAutoLimit` is `false`. |
| `accept-failed-checks-new-tests-only` | `accept-failed-checks` | Accept failure when only checks listed in `newTestChecks` failed and `otherChecksPassing` is `true`. |

## policy.json shape

`swarm policy init` writes version `1` with an `owner-note` and a `rules` array of `{ "id", "enabled": true }` for every default rule. Init never overwrites an existing file.

Overrides may only set `enabled: false`, optional `projects`, and optional `maxPerDay` on known rule ids.

## CLI

- `swarm policy show` — never-auto list and each rule id with its one-line description (effective state). When the policy file is missing or invalid after init, output states that the engine is failing closed.
- `swarm policy validate` — validate `policy.json`.
- `swarm policy path` — path to `policy.json` on this machine.
- `swarm policy init` — create default `policy.json` when missing.

# Swarm autonomy policy

Swarm policy is a per-machine rules engine. It decides whether the swarm may **auto-approve** an owner request or must wait for you (**needs-owner**). Policy does not run work by itself; callers pass a request (kind, id, project, facts) and get a decision.

## Policy file location

Rules live in **`policy.json`** on each machine, in the **same directory as your swarm machine config**:

- Default: `~/.config/project-swarm/policy.json` (when `HOME` is set).
- With `XDG_CONFIG_HOME`: `$XDG_CONFIG_HOME/project-swarm/policy.json`.
- With `SWARM_CONFIG` pointing at a config file: `policy.json` sits beside that file.

There is no repo-level policy file. Each machine can differ.

## Decisions

- **`auto-approve`**: policy matched; the swarm may act without waiting on you.
- **`needs-owner`**: you must approve (or deny) explicitly.

If `policy.json` is missing, built-in defaults apply. If the file is invalid JSON or fails validation, the engine **fails closed**: no rules load and every request stays **needs-owner** until you fix the file.

## Never auto-approved

These request kinds are always **needs-owner**, regardless of `policy.json`:

- `merge-main`
- `deploy`
- `publish`
- `cap-raise`
- `hand-edit-app-code`
- `new-workflow`
- `new-secret`
- `auth-change`
- `payments-change`
- `migration`
- `override`
- `accept-unmet-acceptance`

You cannot add overrides for these ids in `policy.json`; validation rejects them.

## Default auto-approve rules

Unless you turn a rule off or narrow it, these defaults are **enabled** on every machine:

| Rule id | Request kind | When it auto-approves |
|--------|----------------|------------------------|
| `commit-push-swarm-branch` | `commit-push-swarm-branch` | Swarm-produced files on a branch that is not `main` or `master`, and `facts.allSwarmProduced` is true. |
| `setup-files-branch` | `setup-files-branch` | Project setup files on a non-`main`/`master` branch, and `facts.setupFiles` is true. |
| `accept-failed-checks-new-tests-only` | `accept-failed-checks` | `facts.failingChecks` is non-empty, every failing check is listed in `facts.newTestChecks`, and `facts.otherChecksPassing` is true. |
| `retry` | `retry` | `facts.project` is set. |
| `park` | `park` | `facts.project` is set. |
| `release` | `release` | `facts.project` is set. |
| `change-order-path-fix` | `change-order-path-fix` | `facts.project` is set. |
| `change-order-split` | `change-order-split` | `facts.project` is set. |

Unknown request kinds are always **needs-owner**.

## Turning a rule off or narrowing it

`policy.json` is a JSON object with an optional `rules` array. Each entry **overrides** a built-in rule by `id`. You may only use these fields:

- **`enabled`**: set to `false` to disable that default rule. You cannot set `enabled` to `true` (rules are on by default).
- **`projects`**: list of project names; the rule applies only when the request’s project is in that list.
- **`maxPerDay`**: positive integer; after that many auto-approvals for that rule id **today** (from `facts.autoToday`), further matches are **needs-owner**.

You cannot invent new rule ids or new kinds; unknown ids fail validation.

Example — disable retry and limit park to one project:

```json
{
  "rules": [
    { "id": "retry", "enabled": false },
    { "id": "park", "projects": ["my-app"], "maxPerDay": 3 }
  ]
}
```

## Logging auto-decisions

When the swarm auto-approves, it should append an **Events** record via `autoDecisionEvent`. The event is intentionally small (no free-text title, description, or reason from the request):

- `kind`: `"auto-decision"`
- `at`: ISO timestamp
- `rule`: matched rule id (or null)
- `requestKind`, `requestId`, `project`
- `machine`: hostname or machine label
- `reason`: engine reason (e.g. `policy match`)

For a short owner-facing history, **`handledForYou`** takes the Events list, keeps only `auto-decision` entries, sorts newest first, and returns up to 20 (configurable limit). That is the collapsed **“Handled for you”** list.

## CLI (planned wiring)

Command handlers exist for:

- `swarm policy path` — print this machine’s `policy.json` path
- `swarm policy show` — print never-auto kinds and effective auto rules (including disabled/narrowed state)
- `swarm policy validate` — validate `policy.json` (`ok`, or errors; missing file is `ok` with defaults)

These are **not wired into the main `swarm` CLI yet**; only the library and tests use them today.

## Board UI (not built yet)

Showing policy-driven auto-approvals on the owner **board** (beyond the Events / handled-for-you helpers) is **not implemented** in this repo yet.

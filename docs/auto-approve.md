# Policy auto-approve (hand-build)

Routine swarm-admin **file edits** (Write, Edit, NotebookEdit only) are approved in-process—no owner terminal—unless the kill switch is on. **Shell (Bash) is never covered** by policy auto-approve; every shell command stays owner-only under the normal hand-build flow (approval that names files and git ops).

## Frozen policy

The rules live in code as `tools/auto-approve-policy.mjs` (`POLICY_ID` / `POLICY_VERSION`). Agents cannot edit this file through an approval window; only the owner merges code changes.

At `swarm handbuild request` time the swarm evaluates the **normalized** request (validated exact file list and minutes). A matching request is stored as **approved** immediately. The guard re-checks every Write/Edit/NotebookEdit path at tool time against the frozen allow-list (including a no-follow open and fstat immediately before allow), so forged paths in the request text do not expand the window.

### File window (only)

Auto-approved when **every** listed path is an **exact** file (no folder entries, no prefix wildcards) under:

- `docs/state/` only (plain notes with allowed extensions)

Allowed extensions: `.md`, `.txt`, `.csv`, `.ndjson` — nothing else (json and yaml are parsed as config by trusted processes, so they never ride a window).

Path components under `docs/state/` and each window file basename must be ASCII `^[A-Za-z0-9._-]+$`. Comparisons use `fold(s) = s.normalize('NFKC').toUpperCase().toLowerCase()`.

Blocked even under `docs/state/`: instruction-style basenames agents load as trusted context (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `README.md`, `SKILL.md`, `CLAUDE.local.md`, any `*.instructions.md`, `*.rules.md`, or `*.local.md`), any path with a dot-folder component (for example `.cursor/rules/foo.md`), and files the swarm reads as **authoritative state** (not plain scratch notes):

| Path | Read as authoritative by |
| --- | --- |
| `docs/state/usage-ledger.md` | `tools/managers/budget/spend-watch.mjs`, `tools/generated-state.mjs`, `tools/go.mjs`, manifest ledger defaults in `tools/swarm/core-41.mjs` |
| `docs/state/eval-scores.ndjson` | `tools/model-watch.mjs`, `tools/models-commands.mjs` |
| `docs/state/manager-scorecards/*` | `tools/managers/scorecard.mjs` (manager replay scorecards) |

`docs/design/`, coordination handoff notes, `docs/scope/`, and `docs/plans/` are not allowed: they drive design, routing, scope approval, tickets and owner orders.

A request that names any git operation is never auto-approved (the owner decides it), and a policy row always stores an empty git list.

At write time the guard runs the full policy check whenever the covering approval is a policy row or any policy row covers the path (exact window entry and canonical comparison via `fold` on a case-insensitive filesystem). A path spelled differently from the window entry is denied. An existing target must be a regular file with a single link (checked with lstat and a no-follow open plus fstat); symlinks and hard links are refused.

**Timing gap:** Policy windows only cover inert notes under `docs/state/` that no tool executes or trusts as authoritative (see table above). Another process could still change a window file between the guard check and the editor write; the guard re-checks immediately before allow, but concurrent writers outside the session are not serialized.

Still owner-only: `docs/scope/`, `docs/plans/`, `docs/design/`, coordination handoff and review paths, job manifests, `.project-swarm.json`, `tools/`, `tests/`, `.github/`, `.swarm/`, `.git/`, guard state, code files, all shell commands, and all git commands (`commit`, `push`, `switch`, plain `git`, etc.).

At most **60** minutes and **20** files per window.

### Limits and logging

Rate limits (per window, per day, and max auto-approve windows per day) come from owner machine `~/.config/project-swarm/policy.json` (rule `swarm-admin-handbuild`). `SWARM_CONFIG` / `SWARM_POLICY_FILE` overrides apply only under the signed orchestrator test marker (never because a project sits in a temp directory).

Stats: `.swarm/handbuild/stats.json` and `.swarm/handbuild/stats.initialized` are created under the state lock on first policy use (`handbuildStatsInitialized`). Before initialization, missing stats do not block caps. After initialization, missing or unreadable stats block auto-approve (fail closed; the unreadable flag is never persisted to disk). Owner-terminal stats bumps skip writing when stats are unreadable.

Each auto-approval logs `auto-approved`; each policy-guarded file allow logs `policy-allowed` in `.swarm/handbuild/log.ndjson`. Use `swarm handbuild stats --json` on the board.

## Kill switch

Only the owner can disable policy auto-approve by creating **`.swarm/handbuild/auto-off`** (same protection as `.swarm/handbuild/off`—orchestrators cannot create it). Remove the file to turn policy auto-approve back on. The kill switch blocks only allows covered by a live policy row (file edits under the window), not unrelated git or merge operations.

## Deviations from main

None for git, merge, or Bash policy coverage.

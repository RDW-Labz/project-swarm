# Policy auto-approve (hand-build)

Routine swarm-admin **file edits** are approved in-process—no owner terminal—unless the kill switch is on. Git and other shell operations are **not** covered by policy auto-approve; they follow the normal hand-build flow (owner approval that names the operation).

## Frozen policy

The rules live in code as `tools/auto-approve-policy.mjs` (`POLICY_ID` / `POLICY_VERSION`). Agents cannot edit this file through an approval window; only the owner merges code changes.

At `swarm handbuild request` time the swarm evaluates the **normalized** request (validated exact file list and minutes). A matching request is stored as **approved** immediately. The guard re-checks every write path at tool time against the frozen allow-list, so forged paths in the request text do not expand the window.

### File window (only)

Auto-approved when **every** listed path is an **exact** file (no folder entries, no prefix wildcards) under:

- `docs/state/` only (plain notes with allowed extensions)

Allowed extensions: `.md`, `.txt`, `.csv`, `.ndjson` — nothing else (json and yaml are parsed as config by trusted processes, so they never ride a window).

Blocked even under `docs/state/`: instruction-style basenames agents load as trusted context (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `README.md`, `SKILL.md`, `CLAUDE.local.md`, any `*.instructions.md`, `*.rules.md`, or `*.local.md`), and any path with a dot-folder component (for example `.cursor/rules/foo.md`).

`docs/design/`, coordination handoff notes, `docs/scope/`, and `docs/plans/` are not allowed: they drive design, routing, scope approval, tickets and owner orders.

A request that names any git operation is never auto-approved (the owner decides it), and a policy row always stores an empty git list.

At write time the guard runs the full policy check whenever the covering approval is a policy row or any policy row covers the path (the file matcher or a canonical comparison: resolved, lower-cased on a case-insensitive filesystem). A path spelled differently from the window entry is denied. An existing target must be a regular file with a single link (checked with lstat and a no-follow open plus fstat); symlinks and hard links are refused. While a policy window is live, owner-only shell paths include any link-producing command that touches a window path (`ln`, `link`, `cp -l` / `cp -s`, `mv` onto a window path from outside the window file list, `tar`/`unzip` extraction, `rsync`, `install`).

Opaque shell commands (a command word that is a variable or substitution) count as a commit-level operation: they need an approval that names git `commit`, and a policy row never covers it.

Still owner-only: `docs/scope/`, `docs/plans/`, `docs/design/`, coordination handoff and review paths, job manifests, `.project-swarm.json`, `tools/`, `tests/`, `.github/`, `.swarm/`, `.git/`, guard state, code files, and all git commands (`commit`, `push`, `switch`, plain `git`, etc.).

At most **60** minutes and **20** files per window.

### Limits and logging

Rate limits (per window, per day, and max auto-approve windows per day) come from owner machine `~/.config/project-swarm/policy.json` (rule `swarm-admin-handbuild`). `SWARM_CONFIG` / `SWARM_POLICY_FILE` overrides apply only under the signed orchestrator test marker (never because a project sits in a temp directory).

Stats: `.swarm/handbuild/stats.json` and `.swarm/handbuild/stats.initialized` are created under the state lock on first policy use (`handbuildStatsInitialized`). Before initialization, missing stats do not block caps. After initialization, missing or unreadable stats block auto-approve (fail closed; the unreadable flag is never persisted to disk).

Each auto-approval logs `auto-approved`; each policy-guarded file allow logs `policy-allowed` in `.swarm/handbuild/log.ndjson`. Use `swarm handbuild stats --json` on the board.

## Kill switch

Only the owner can disable policy auto-approve by creating **`.swarm/handbuild/auto-off`** (same protection as `.swarm/handbuild/off`—orchestrators cannot create it). Remove the file to turn policy auto-approve back on. The kill switch blocks only allows covered by a live policy row (file edits under the window), not unrelated git or merge operations.

## Deviations from main

None for git or merge.

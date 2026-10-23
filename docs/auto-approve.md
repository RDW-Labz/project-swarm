# Policy auto-approve (hand-build)

Routine swarm-admin **file edits** are approved in-process—no owner terminal—unless the kill switch is on. Git and other shell operations are **not** covered by policy auto-approve; they follow the normal hand-build flow (owner approval that names the operation).

## Frozen policy

The rules live in code as `tools/auto-approve-policy.mjs` (`POLICY_ID` / `POLICY_VERSION`). Agents cannot edit this file through an approval window; only the owner merges code changes.

At `swarm handbuild request` time the swarm evaluates the **normalized** request (validated exact file list and minutes). A matching request is stored as **approved** immediately. The guard re-checks every write path at tool time against the frozen allow-list, so forged paths in the request text do not expand the window.

### File window (only)

Auto-approved when **every** listed path is an **exact** file (no folder entries, no prefix wildcards) under:

- `docs/plans/`, `docs/state/`, `docs/scope/`, `docs/design/`
- `coordination/handoff*.md` (routing handoff notes only)

Allowed extensions: `.md`, `.txt`, `.json`, `.ndjson`, `.csv`, `.yaml`, `.yml` — nothing else.

Still owner-only: `coordination/review/`, job manifests, `.project-swarm.json`, `tools/`, `tests/`, `.github/`, `.swarm/`, `.git/`, guard state, code files, and all git commands (`commit`, `push`, `switch`, plain `git`, etc.).

At most **60** minutes and **20** files per window.

### Limits and logging

Rate limits (per window, per day, and max auto-approve windows per day) come from owner machine `~/.config/project-swarm/policy.json` (rule `swarm-admin-handbuild`). `SWARM_CONFIG` / `SWARM_POLICY_FILE` overrides apply only under the signed orchestrator test marker (or temp test roots).

Stats: `.swarm/handbuild/stats.json` and `.swarm/handbuild/stats.initialized` are created on first policy use. After initialization, missing or unreadable stats block auto-approve (fail closed; counters are not reset by deleting the file).

Each auto-approval logs `auto-approved`; each policy-guarded file allow logs `policy-allowed` in `.swarm/handbuild/log.ndjson`. Use `swarm handbuild stats --json` on the board.

## Kill switch

Only the owner can disable policy auto-approve by creating **`.swarm/handbuild/auto-off`** (same protection as `.swarm/handbuild/off`—orchestrators cannot create it). Remove the file to turn policy auto-approve back on.

# Policy auto-approve (hand-build)

Routine swarm-admin edits and git on policy branches are approved in-process—no owner terminal—unless the kill switch is on.

Orchestrator mode stays **read-only** for git: `git commit`, `git push`, and `git switch` are not added to the orchestrator shell allowlist. Frozen policy git rules apply only on the **hand-build** path when a live policy auto-approval window covers the command (see `handbuildPolicyGuardCheck` in `tools/handbuild.mjs`).

## Frozen policy

The rules live in code as `tools/auto-approve-policy.mjs` (`POLICY_ID` / `POLICY_VERSION`). Agents cannot edit this file through an approval window; only the owner merges code changes.

At `swarm handbuild request` time the swarm evaluates the **normalized** request (validated file list, minutes, git ops). A matching request is stored as **approved** immediately; the guard still matches real write paths against the declared patterns at edit time, so forged paths in the request text do not expand the window.

### File window

Auto-approved when **every** file is under swarm-admin paths: `coordination/manifests/**`, `coordination/HANDOFF*.md`, `coordination/review/**`, `docs/scope/**`, `docs/plans/**`, `docs/state/**`, `docs/design/**` (documentation only—no code extensions), `.project-swarm.json`, `.swarm/project/` ticket ledger files, and manifests under `jobs/`. At most **60** minutes and **20** files. Everything else (including `tools/`, `tests/`, CI, package files, and guard state) stays on the normal owner flow.

### Git (hand-build policy window only)

On the **current** branch (read from git, not from the command text), when the checkout is the main tree or a worktree under `~/.project-swarm-scratch`, and a policy approval window is active:

- `git commit` on `swarm/…` or `feat/…` branches (no amend, hook-skipping, or reuse-message forms).
- `git push origin <same-branch>` only when `origin` is this project's repository (never another remote name, never bare `git push`, never refspecs with `:` or `+`, never force or delete).
- `git switch <branch>` or `git switch -c <branch>` on allowed prefixes with a **clean** working tree (no `checkout`, no path restores, no force/detach flags).
- `git worktree remove <path>` only for a **clean** worktree under `~/.project-swarm-scratch` (not `prune` or `remove --force`).

Each window is bound to the branch name and `HEAD` at grant time; both are re-checked before the command runs. Rate limits (defaults: **20** actions per window, **100** actions and **100** changed files per UTC day, overridable in machine `policy.json` under rule `swarm-admin-handbuild`) fall back to owner approval when exceeded.

Still owner-only: merge, deploy, rebase, `reset --hard`, `branch -D`, force push, `git checkout -- <paths>`, `restore`, `clean`, and `git -c` / hook-skipping commits (`--no-verify`).

### Logging and stats

Each auto-approval appends `auto-approved` and each policy-guarded allow appends `policy-allowed` to `.swarm/handbuild/log.ndjson` (policy id, branch, `HEAD`, rule, command). Per-day counters live in `.swarm/handbuild/stats.json` (`autoApproved`, `ownerTerminal`, `policyActions`, `policyFiles`); use `swarm handbuild stats --json` on the board. Agents cannot write `stats.json`, `log.ndjson`, or `auto-off`.

## Kill switch

Only the owner can disable policy auto-approve by creating **`.swarm/handbuild/auto-off`** (same protection as `.swarm/handbuild/off`—orchestrators cannot create it). Remove the file to turn policy auto-approve back on. The owner phrase for full guard off is unchanged.

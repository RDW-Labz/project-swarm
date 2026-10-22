# Policy auto-approve (hand-build)

Routine swarm-admin edits and git on policy branches are approved in-process—no owner terminal—unless the kill switch is on.

## Frozen policy

The rules live in code as `tools/auto-approve-policy.mjs` (`POLICY_ID` / `POLICY_VERSION`). Agents cannot edit this file through an approval window; only the owner merges code changes.

At `swarm handbuild request` time the swarm evaluates the **normalized** request (validated file list, minutes, git ops). A matching request is stored as **approved** immediately; the guard still matches real write paths against the declared patterns at edit time, so forged paths in the request text do not expand the window.

### File window

Auto-approved when **every** file is under swarm-admin paths: `coordination/manifests/**`, `coordination/HANDOFF*.md`, `coordination/review/**`, `docs/scope/**`, `docs/plans/**`, `docs/state/**`, `docs/design/**` (documentation only—no code extensions), `.project-swarm.json`, `.swarm/project/` ticket ledger files, and manifests under `jobs/`. At most **60** minutes and **20** files. Everything else (including `tools/`, `tests/`, CI, package files, and guard state) stays on the normal owner flow.

### Git (no hand-build request)

On the **current** branch (read from git, not from the command text), when the checkout is the main tree or a worktree under `~/.project-swarm-scratch`:

- `git commit` and `git push origin HEAD|<branch>` on branches matching `swarm/…` or `feat|fix|docs|chore/…`, with `origin` a configured remote, no force refspecs, and not on `main` / `master` / detached `HEAD`.
- `git switch` / `git checkout <branch>` (no path restore), `git checkout -b`, and `git worktree add` / `remove` under the scratch base between non-protected branches.

Still owner-only: merge, deploy, rebase, `reset --hard`, `branch -D`, force push, `git checkout -- <paths>`, `restore`, `clean`, and `git -c` / hook-skipping commits (`--no-verify`).

### Logging and stats

Each auto-approval appends `auto-approved` to `.swarm/handbuild/log.ndjson` (policy id, version, files, minutes, branch) and appears in `swarm handbuild status` / list output. Per-day counters live in `.swarm/handbuild/stats.json` (`autoApproved`, `ownerTerminal` for CLI `swarm handbuild approve`); use `swarm handbuild stats --json` on the board.

## Kill switch

Only the owner can disable policy auto-approve by creating **`.swarm/handbuild/auto-off`** (same protection as `.swarm/handbuild/off`—orchestrators cannot create it). Remove the file to turn policy auto-approve back on. The owner phrase for full guard off is unchanged.

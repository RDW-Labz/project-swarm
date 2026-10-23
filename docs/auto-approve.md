# Policy auto-approve (hand-build)

Routine swarm-admin edits and git on policy branches are approved in-process—no owner terminal—unless the kill switch is on.

Orchestrator mode stays **read-only** for git: `git commit`, `git push`, and `git switch` are not added to the orchestrator shell allowlist. Frozen policy git rules apply only on the **hand-build** path when a live policy auto-approval window covers the command (see `handbuildPolicyGuardCheck` in `tools/handbuild.mjs`).

## Frozen policy

The rules live in code as `tools/auto-approve-policy.mjs` (`POLICY_ID` / `POLICY_VERSION`). Agents cannot edit this file through an approval window; only the owner merges code changes.

At `swarm handbuild request` time the swarm evaluates the **normalized** request (validated file list, minutes, git ops). A matching request is stored as **approved** immediately; the guard still matches real write paths against the declared patterns at edit time, so forged paths in the request text do not expand the window.

### File window

Auto-approved when **every** file is under swarm-admin paths: `coordination/HANDOFF*.md`, `docs/scope/**`, `docs/plans/**`, `docs/state/**`, `docs/design/**` (documentation only—no code extensions), and `.swarm/project/` ticket ledger files. At most **60** minutes and **20** files. Everything else (including `coordination/review/`, `jobs/`, `coordination/manifests/`, `.project-swarm.json`, `tools/`, `tests/`, CI, package files, and guard state) stays on the normal owner flow.

### Git (hand-build policy window only)

On the **current** branch (read from git, not from the command text), when the checkout is the main tree or a worktree under `~/.project-swarm-scratch`, and a policy approval window is active:

- `git commit` on `swarm/…` or `feat/…` branches (no amend, hook-skipping, or reuse-message forms).
- `git push origin <same-branch>` only when every `origin` push URL matches the **trusted repository URL** in owner machine `policy.json` (rule `swarm-admin-handbuild`, field `repository`) with exact normalized host/path—never another remote name, never bare `git push`, never refspecs with `:` or `+`, never force or delete, and no `remote.origin.pushurl`, `url.*.insteadOf`, or `url.*.pushInsteadOf` rewrites or non-default push mapping.
- `git switch <branch>` or `git switch -c <branch>` (no other flags) on allowed prefixes with a **clean** working tree (no `checkout`, no path restores).
- Read-only: `git status`, `git diff`, `git log`. `git add` only for swarm-produced paths when covered by the window.

Each window is bound to the branch name and the `HEAD` at grant time; the branch must still match and the current `HEAD` must descend from the granted commit (an empty granted `HEAD` never binds). Policy git checks run with hardened `-c` overrides, refuse any `GIT_*` in the session environment, verify effective config from user/XDG/local scopes against the same allow-list as repo-local config (system gitconfig is ignored for that read), and require the exact hardened git argv (trusted `git` on `PATH`, not a basename impostor). Shell wrappers, `cd`, env assignments, and `git -C` / `--git-dir` / `--work-tree` are refused on the policy path; `git commit` allows only `-m`, and `git add` only literal window paths (no magic pathspecs). Machine policy is always `~/.config/project-swarm/policy.json` (no environment override). Rate limits fail closed when stats are unreadable, including when `stats.initialized` exists but `stats.json` is missing.

Still owner-only: merge, deploy, rebase, `reset --hard`, `branch -D`, force push, `git checkout -- <paths>`, `restore`, `clean`, and `git -c` / hook-skipping commits (`--no-verify`).

### Logging and stats

Each auto-approval appends `auto-approved` and each policy-guarded allow appends `policy-allowed` to `.swarm/handbuild/log.ndjson` (policy id, branch, `HEAD`, rule, command). Per-day counters live in `.swarm/handbuild/stats.json` (`autoApproved`, `ownerTerminal`, `policyActions`, `policyFiles`); use `swarm handbuild stats --json` on the board. Agents cannot write, delete, or rename anything under `.swarm/handbuild/` (including `stats.json`, `stats.initialized`, `log.ndjson`, and `auto-off`).

## Kill switch

Only the owner can disable policy auto-approve by creating **`.swarm/handbuild/auto-off`** (same protection as `.swarm/handbuild/off`—orchestrators cannot create it). Remove the file to turn policy auto-approve back on. The owner phrase for full guard off is unchanged.

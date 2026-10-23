# Policy auto-approve (hand-build)

Routine swarm-admin edits and git on policy branches are approved in-process—no owner terminal—unless the kill switch is on.

Orchestrator mode stays **read-only** for git: `git commit`, `git push`, and `git switch` are not added to the orchestrator shell allowlist. Frozen policy git rules apply only on the **hand-build** path when a live policy auto-approval window covers the command **and** the session runs **`swarm handbuild git SUBCOMMAND [args]`** (installed `swarm` or `node …/tools/swarm.mjs` only). Plain `git` in the shell is never auto-approved, even inside a policy window.

## Frozen policy

The rules live in code as `tools/auto-approve-policy.mjs` (`POLICY_ID` / `POLICY_VERSION`). Agents cannot edit this file through an approval window; only the owner merges code changes.

At `swarm handbuild request` time the swarm evaluates the **normalized** request (validated file list, minutes, git ops). A matching request is stored as **approved** immediately; the guard still matches real write paths against the declared patterns at edit time, so forged paths in the request text do not expand the window.

### File window

Auto-approved when **every** file is under swarm-admin paths: `coordination/HANDOFF*.md`, `docs/scope/**`, `docs/plans/**`, `docs/state/**`, `docs/design/**` (documentation only—no code extensions), and `.swarm/project/` ticket ledger files. At most **60** minutes and **20** files. Everything else (including `coordination/review/`, `jobs/`, `coordination/manifests/`, `.project-swarm.json`, `tools/`, `tests/`, CI, package files, and guard state) stays on the normal owner flow.

### Git (hand-build policy window only)

Use **`swarm handbuild git`** for every git operation you want the policy window to cover. That subcommand runs a **pinned** git binary (`/usr/bin/git`, `/opt/homebrew/bin/git`, or `/usr/local/bin/git`—first that exists, realpath-resolved, owned by root or you, not group/world-writable), in a **clean environment** (`PATH=/usr/bin:/bin`, empty temp `HOME`, `GIT_CONFIG_*` at `/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, no inherited `GIT_*`), with hardened `-c` overrides (`core.hooksPath=/dev/null`, empty credential helper, `core.sshCommand=ssh`, `protocol.ext.allow=never`). Policy checks and execution happen in the **same** process and environment; every call is logged.

On the **current** branch (read from git, not from the command text), when the checkout is the main tree or a worktree under `~/.project-swarm-scratch`, and a policy approval window is active:

- `swarm handbuild git commit …` on `swarm/…` or `feat/…` branches (no amend, hook-skipping, or reuse-message forms; `-m` only).
- `swarm handbuild git push origin <same-branch>` only when every `origin` push URL matches the **trusted repository URL** in owner machine `policy.json` (rule `swarm-admin-handbuild`, field `repository`) with exact normalized host/path—never another remote name, never bare push, never refspecs with `:` or `+`, never force or delete, and no `remote.origin.pushurl`, `url.*.insteadOf`, or `url.*.pushInsteadOf` rewrites or non-default push mapping.
- `swarm handbuild git switch …` (no other flags) on allowed prefixes with a **clean** working tree (no `checkout`, no path restores).
- Read-only: `swarm handbuild git status`, `diff`, `log`. `swarm handbuild git add` only for swarm-produced paths when covered by the window (literal paths after `--` when options are present; no `-f`, `--chmod`, `--pathspec-from-file`, or magic pathspecs).

Each window is bound to the branch name and the `HEAD` at grant time; the branch must still match and the current `HEAD` must descend from the granted commit (an empty granted `HEAD` never binds). Repo-local git config must stay on the allow-list; hooks under the git common dir must be `.sample` only. Machine policy is always `~/.config/project-swarm/policy.json` (`SWARM_CONFIG` / `SWARM_POLICY_FILE` overrides apply only with a signed orchestrator test marker). Rate limits fail closed when stats are unreadable; the policy initializes `stats.json` and `stats.initialized` on first use—deleting `stats.json` after that blocks auto-approve.

Still owner-only: merge, deploy, rebase, `reset --hard`, `branch -D`, force push, path restores, hook-skipping commits, and plain shell `git` (any path).

### Logging and stats

Each auto-approval appends `auto-approved` and each policy-guarded allow appends `policy-allowed` to `.swarm/handbuild/log.ndjson` (policy id, branch, `HEAD`, rule, command). `swarm handbuild git` also appends `handbuild-git` lines. Per-day counters live in `.swarm/handbuild/stats.json` (`autoApproved`, `ownerTerminal`, `policyActions`, `policyFiles`); use `swarm handbuild stats --json` on the board. Agents cannot write, delete, or rename anything under `.swarm/handbuild/` (including `stats.json`, `stats.initialized`, `log.ndjson`, and `auto-off`).

## Kill switch

Only the owner can disable policy auto-approve by creating **`.swarm/handbuild/auto-off`** (same protection as `.swarm/handbuild/off`—orchestrators cannot create it). Remove the file to turn policy auto-approve back on. The owner phrase for full guard off is unchanged.

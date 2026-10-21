# The hand-build guard

An orchestrator session (Claude Code driving a project) may not build by hand. Build work goes through the swarm (write a ticket). The guard runs in the project checkout before edit tools and shell commands, and blocks changes that would hand-build unless the owner approved them—or they fall on the free list below.

## Threat model

The orchestrator is **honest but fallible**, not an adversary. The guard stops **accidents**: a stray commit to `main`, a hand edit of application source, an unreviewed push, approving its own hand-build, or writing guard state. It is **not a sandbox** and cannot stop a determined party who can run arbitrary code on the machine, bypass hooks, or act outside git.

## What is free

**Routing files** (swarm coordination, not hand-built product code):

- `coordination/manifests/*.json`
- `HANDOFF.md`, `TASK.md`, `build-plan.md` at the repo root or under `coordination/` (plus `coordination/handoff.previous.md` and `handoff.previous-2.md`)
- `docs/state/usage-ledger.md`, `docs/state/eval-scores.ndjson`
- `coordination/swarm-lessons.jsonl`

Symlinks are resolved; the path must still match after resolution.

**Orchestrator and swarm lanes (no approval):** reading anything; running tests, typecheck, lint, and builds; writing under `.swarm/` and `docs/plans/` (tickets and plans); build output (`node_modules/`, `.next/`, `dist/`, `build/`, `coverage/`); anything outside the checkout; a worker workspace (`.swarm/workspaces/...`); `swarm ...` commands (they write under their own rules); moving untracked sources into the session scratchpad.

**Git and deploy reads (short allowlist, no global `-C` / config tricks):**

- `git fetch`, `status`, `log`, `diff`, `show`
- `gh pr create`, `pr view`, `pr list`, `pr checks`, `pr diff`, `run list`, `run watch`, `run view`
- `vercel ls`, `inspect`, `logs`, `whoami`, `--version`

**Swarm-produced commits and pushes (off `main` / `master`):** on a feature branch, `git commit` is allowed when every staged file is routing, orchestrator-owned (`.swarm/`, `docs/plans/`, build dirs), or its **working-tree or index bytes** match a SHA-256 recorded in an integrated run under `.swarm/runs/`. A plain `git push` (no force, no refspecs, no delete) to a non-protected branch is allowed when commits ahead of `origin/main` only carry paths that pass the same content check at `HEAD`. Adding paths that fail the check still needs approval.

## What needs the owner

**Hand edits and shell writes** to tracked project source, tests, **docs** (except routing paths above), config, and any other path not on the free list—including `Edit` / `Write` / `MultiEdit` / `NotebookEdit` and shell writers (`>`, `tee`, `sed -i`, `mv`/`cp` into the tree, `rm`, and similar).

**Git history on protected branches:** any `git commit` or `git push` while on `main`, `master`, or detached `HEAD` treated as protected.

**Never approvable** (even if a request names them): force-push or remote **delete** of `main` or `master`; writing approval state (`.swarm/handbuild/`, `.swarm/runs/`), hook settings (`.claude/`), `.git/`, the swarm install (`~/.project-swarm/`), or the user's Claude settings (`~/.claude/settings*.json`). An orchestrator session cannot run `swarm handbuild approve|deny|off|on|uninstall`, `swarm decide handbuild-...`, or other commands that approve guard state (including nested `bash -c`, `eval`, or `base64 | sh` patterns that try the same).

**Elevated git and deploy** (approval only with the owner **at the computer**—see below): `git merge`, `git push --force` (or `+ref`), `git branch -D` / forced branch delete, `vercel` deploy (including `--prod`), `gh api` with a write HTTP method, and other `gh` / `swarm` commands not on the read-only lists.

**Dynamic commands** the guard cannot pin down: a variable or substitution as a write target; `eval`; a command in the command position that is not a plain literal; pipes into a shell or interpreter that may execute decoded text; inline `node -e` / `python -c` that writes; `find -exec` / `xargs` writers; opaque expanded words. These are refused unless a hand-build approval names the files (and git ops) explicitly.

Edits to paths listed in integrate records but **not** matching a recorded hash still need approval (the path alone is not enough).

## Approvals

**Channels**

- **Computer:** `swarm handbuild approve ID` or `swarm decide handbuild-ID approve` for normal hand-builds. **Required** for requests whose `--git` includes `merge`, `deploy`, `force-push`, or `branch-D`—not from the phone, board, or remote control.
- **Phone / board:** `approve` / `deny` on a pending hand-build decision in **Needs you** (deny is default), for non-elevated requests only.
- **Chat (one-time):** when orchestrator hooks are installed, a single-line owner prompt `merge #N` / `merge pr #N` records a one-time allowance (about 60 minutes) for exactly one `gh pr merge N` or `swarm merge N` with no `-R` / `--repo` override. Consumed on use.

**Hand-build request**

```
swarm handbuild request --kind swarm-cannot|emergency|secret|tiny \
  --reason "why the swarm cannot do it" --files "src/a.ts,supabase/migrations/" \
  --minutes 30 [--git commit,push,merge,deploy,force-push,branch-D]
```

Shows in **Needs you** with a one-line recommendation. An approval covers **only named files** (file, folder at least two levels deep ending in `/`, or `*.ext` inside a folder—no `**`, no whole top-level folder), only named git operations, for at most 120 minutes (default 30). `git commit` is checked against staged files (or all tracked changes with `-a`); `git add -A` or pattern adds cannot be checked and are blocked. Unanswered requests expire after 24 hours.

| `--kind` | When it applies |
|---|---|
| `swarm-cannot` | No lane can do the work, or the swarm itself is broken |
| `emergency` | Live emergency where a ticket costs more than waiting |
| `secret` | Secret or credential no worker may see |
| `tiny` | Under 5 lines and the swarm is blocked from making it |

Anything else: **write a ticket instead** (the request is refused).

## The record

Every request, approval, denial, allowed use, and **blocked attempt** is one line in `.swarm/project/journal.ndjson` (`handbuild-*` actions) and in `.swarm/handbuild/log.ndjson` (`swarm handbuild log`). Blocked attempts and hand-written files feed orchestrator metrics on the board.

## Installing it

- `swarm init` installs the guard the first time a project is linked; `swarm update` refreshes it where already installed.
- In an existing project: `swarm handbuild install` (new Claude Code sessions). `uninstall` removes it; `off` / `on` toggle without removing settings (orchestrator cannot run those).
- `swarm handbuild uninstall` leaves a marker so a later `swarm init` does not reinstall; `swarm handbuild install` does.
- Project root is `CLAUDE_PROJECT_DIR`; writes inside a worker workspace are the swarm's; writes from a workspace into the checkout are not.
- PreToolUse hook: `tools/handbuild-guard.mjs` in `.claude/settings.local.json`. A missing script is a no-op until installed.

## Real enforcement

1. **Hook (session):** the hand-build guard reads tool input and command text before edits or shell run; it fails closed on unreadable or dynamic patterns.
2. **Git hooks (repo):** `swarm handbuild install` also installs **pre-commit**, **pre-push**, and **commit-msg** hooks. Pre-commit and pre-push check what git actually commits and pushes in an agent session, complementing the text analyzer. The **commit-msg** hook applies to every actor: if the subject line starts with `Manifest` (any casing), the staged set may contain only paths under `coordination/manifests/`. Anything else is refused with a list of offending paths—this catches manifest commits that accidentally include files left staged after a failed `git add`. Unstage stray files, commit them with their own message, then retry the manifest commit.
3. **Server:** GitHub branch protection on `main` (and usually `master`) is the backstop for pushes the session might still attempt.

If the guard script errors, the hook is designed not to lock the owner out (the call may proceed—treat that as an outage, not policy).

## Known limits

- **Obfuscation:** commands that pipe decoded text into a shell are treated as dynamic and refused, but a determined agent can still harm the machine or data outside git.
- **Hash trust:** swarm-produced allowance trusts integrate records in `.swarm/runs/`; those paths are not writable via hand-build approvals, but a compromised integrate pipeline would poison the allowlist.
- **Chat merge:** trusts the owner's prompt event, orchestrator hook installation, and that the merge command matches the recorded PR number once.
- **Incomplete parsing:** the guard is a text reader of shell and git commands (wrappers, subshells, `cd &&`, here-doc bodies as data). Gaps remain; unknown writers or git ops default to needing approval or blocking.

### Limits of the claude rule

The self-approval hook’s **claude** rule blocks a headless Claude Code session started from the shell in forms an honest agent could plausibly type: `claude` as the program (after variable assignments and wrappers with their own options, in groups, loops, substitutions, `bash -c` / `eval` strings, tmux and screen, package runners, `node` scripts named `claude`, and in Python or Node code strings that spawn `claude` with `-p` or `--print`).

It does **not** catch:

- **(a)** Text piped into a shell or interpreter as a here-document or echo body (`cat <<EOF | bash`, `echo '…' | bash`, a script file written and run in the same command).
- **(b)** Python or Node here-documents that spawn `claude` (they are read as shell text, not interpreter code).
- **(c)** A here-document inside a command substitution that contains backticks (can over-block, as the old rule did).
- **(d)** Interpreter code that passes a prompt without `-p`, and string literals that merely mention `claude -p` inside interpreter code.
- **(e)** Anything invisible to a text rule: a variable or alias for the program, `node $(which claude)`, script files, `gtimeout`, decoded text.

These are **accepted limits** under the honest-but-fallible orchestrator threat model. Real enforcement for commits and pushes is **git hooks** and **GitHub branch protection**; a deliberately hidden headless session is out of scope.

### Limits of the vercel, merge, switch and restore rules

A final review of these rules (Opus, owner's threat model: an honest but fallible orchestrator) found **no plausible honest-agent bypass**. Remaining gaps are **accepted limits**:

1. **`gh pr merge` parsing:** `gh pr -R owner/repo merge N` with a flag between `pr` and `merge` is not recognized as a merge, so an approval that names `gh` would allow it. `gh api` with a write HTTP method and `gh` aliases are likewise covered when an approval names `gh`, because `gh` is not treated as an elevated operation on its own. The sanctioned merge path is `swarm merge N`, which checks CI. A standing merge approval needs the **machine policy file** to enable the `merge-swarm-pr` rule (`enabled: true`, not disabled); **`gh pr merge` is always blocked** regardless.
2. **Checkout restore without `--`:** `git checkout` with `--pathspec-from-file` or `-p` can restore files without a double dash and is classified as a branch switch, not a path restore.
3. **Conflict style:** `git checkout --conflict=diff3` behaves like the blocked `-m` merge option for analyzer purposes.
4. **Restore path roots:** restore paths are checked against the **project root**, not the shell working directory, so a restore run from a subfolder can touch a different path than the one checked; paths starting with `-` after the double dash are not checked.
5. **One free op in the allow step:** in the final allow step, one free `switch`, `checkout`, or `restore` operation exempts the other `switch`, `checkout`, and `restore` operations the analyzer saw on the same command line, backstopped by the earlier per-operation check.
6. **Policy env and multiple merges:** the policy file path comes from the guard process environment (`SWARM_POLICY_FILE` or `SWARM_CONFIG`), so setting them inline in a command does not reach the guard; several standing `swarm merge` commands on one line are each checked separately.

## What the hook analyzes (summary)

It inspects redirects, `tee`, `sed -i`, `mv`, `cp`, `rm`, downloads, git and `gh` / `vercel` / `swarm` subcommands, `bash -c`, `eval`, `$(...)`, backticks, and common wrappers (`sudo`, `timeout`, `nice`, …). Read-only git is the short list above plus add, checkout, switch, and branch create when not destructive. Claude Code permissions cannot express "deny edits except under `.swarm/`"; the hook is the enforcement layer.

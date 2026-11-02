# The hand-build guard

An orchestrator session (Claude Code driving a project) may not build by hand. All build work goes through the swarm: write a ticket. The guard blocks, in the project checkout, every edit and every shell write that would build by hand, unless the owner approved that exact hand-build.

## What is blocked, and what is not

Blocked in the checkout, without an approval:
- the edit tools: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`;
- shell writes: `>` and `>>`, `tee`, `sed -i`, `perl -i`, `mv` or `cp` into the project, `rm`, `touch`, `mkdir`, `truncate`, `dd of=`, and inline scripts that write files (`node -e`, `python -c` with a write);
- `git commit`, `git push`, `git apply`, `git reset`, `git checkout -- FILE` and the other git commands that change the tree or history;
- a write whose target is a variable or a substitution (the guard cannot tell what it writes, so it asks).

Allowed without approval: reading anything; running tests, type checks, lint and builds; writing under `.swarm/` and `docs/plans/` (tickets and plans are the orchestrator's job); build output (`node_modules/`, `.next/`, `dist/`, `build/`, `coverage/`); anything outside the checkout; a swarm worker's workspace (`.swarm/workspaces/...`: that is the swarm building); `swarm ...` commands (they do their own writing, by their own rules).

Never approvable, whatever a request names (a request that names them is refused): the approval state (`.swarm/handbuild/`, and `.swarm` itself), the hooks' own settings (`.claude/`), `.git/`, the swarm install (`~/.project-swarm/`, where the guard's own scripts live) and the user's own Claude settings (`~/.claude/settings*.json`). A session also cannot run `swarm handbuild approve|deny|off|on|uninstall` or `swarm decide handbuild-...`: approving is the owner's alone.

## Asking for a hand-build

```
swarm handbuild request --kind swarm-cannot|emergency|secret|tiny \
  --reason "why the swarm cannot do it" --files "src/a.ts,supabase/migrations/" \
  --minutes 30 [--git commit,push]
```

The request shows in **Needs you** (the board and the phone inbox) as a decision with `approve` and `deny` (deny is the default) and a one-line recommendation. The owner answers with any of:

```
swarm handbuild approve ID       swarm decide handbuild-ID approve       (or the phone's one-time word)
swarm handbuild deny ID
```

An approval covers **only the files named** (a file, a folder at least two levels deep ending in `/`, or a `*.ext` pattern inside a folder), only the git operations named, for at most 120 minutes (default 30), then it expires. `**`, a whole top-level folder and a pattern in the first path segment are refused as a request. A `git commit` carries only the approved files: the staged files (all tracked changes for `-a`) are checked against the approval. A request nobody answers expires after 24 hours.

### Valid reasons

Only these four. Anything else: **write a ticket instead** (the request is refused with that message).

| `--kind` | When it applies |
|---|---|
| `swarm-cannot` | the swarm cannot run it: no lane can do the work, or the swarm itself is what is broken |
| `emergency` | an emergency fix to something live, where waiting for a ticket costs more than the hand-build |
| `secret` | it handles a secret or credential, which no worker may see |
| `tiny` | a change of under 5 lines that the swarm is blocked from making |

## The record

Every request, approval, denial, use of an approval and **every blocked attempt** is one line in the project journal (`.swarm/project/journal.ndjson`, an `action` event named `handbuild-request`, `-approve`, `-deny`, `-allowed`, `-blocked`) and in `.swarm/handbuild/log.ndjson` (`swarm handbuild log`). Blocked attempts and the files written by hand also feed the Orchestrator lane: the board shows `swarm-built 83%, hand-built 17% (12 files, 3 blocked)` per project, counting shell writes as well as edits.

## Installing it

- `swarm init` installs it for a new project. `swarm update` only refreshes it where it is already installed (a project the owner has not chosen is never changed).
- For an existing project: run `swarm handbuild install` in it (it applies to **new** Claude Code sessions there). `swarm handbuild uninstall` removes it; `swarm handbuild off` / `on` switch it without touching the settings (an orchestrator session cannot run those two).
- `swarm handbuild uninstall` leaves a marker: a later `swarm init` does not bring the guard back (`swarm handbuild install` does).
- The project is the one Claude Code names (`CLAUDE_PROJECT_DIR`), so a session that has moved to another folder, or into a swarm workspace, is still guarded for its project; a write inside a workspace is the swarm's, a write into the checkout from inside it is not. A tool call too large for the guard to read is refused.
- It lives in the personal, git-ignored `.claude/settings.local.json` as one PreToolUse hook (`tools/handbuild-guard.mjs`). The command is wrapped so a missing script (before the update that brings it) does nothing.

## What it is, and is not

It is a guard for an orchestrator that follows the rules, built on the text of the command: it reads redirects, `sed -i`, `tee`, `mv`, `cp`, `rm`, downloads and extraction, git commands, what is inside `bash -c "..."`, `eval`, `$(...)`, backticks, subshells and `cd DIR && ...` (here-document text is data), and wrappers such as `sudo -u x`, `timeout 5`, `nice -n 10`. It fails closed on what it cannot read: a pattern or variable as a write target, `find -exec` or `xargs` of a writer, `awk` that writes, inline code (`node -e`, `python -c`) that is not plainly read-only, an interpreter run on a script it could have written (inside `.swarm/` or `docs/plans/`) or on a file outside the checkout, a program read from standard input, and git commands other than a short read-only list (plus adding, switching branches and creating a branch). It is not a sandbox, and three rounds of review found it keeps having gaps to close: a text reader of shell commands cannot be complete. A determined session can find a way the analyzer does not read (a script file it wrote earlier and then runs, for example; writing that script is itself blocked inside the checkout). Claude Code's own permission rules cannot say "deny edits except under `.swarm/`", so the hook is the enforcement. If the guard itself breaks, it lets the call through rather than lock the owner out.

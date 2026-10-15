# Orchestrator failover

Any capable agent can take over a swarm project mid-way, in under a minute, with no lost work. The runner keeps the state, not a model's memory.

## The journal

`.swarm/project/journal.ndjson` is an append-only log, one JSON object per line, written by the runner on every command. No model has to remember to write it. `.swarm/` is git-ignored, so it is local to the checkout.

Each event has a `kind`: `goal`, `plan`, `decision`, `run`, `integration`, `pr`, `blocker`, `human`, `note`, `command`, `action` or `checkpoint`, plus a timestamp. The runner records:

- every command: its name, its arguments (with secrets redacted, including the value after `--token` or `--api-key`), and whether it succeeded;
- from a command that succeeded: the run, integration, PR or goal it produced;
- `swarm note "text"`, so any orchestrator can leave a decision in one command.

Stored text is cleaned: control characters become spaces, strings are cut at 2000 characters, a line is at most 8 KB, and anything that looks like a key (`sk-…`, `Bearer …`, GitHub and AWS and Google tokens, `NAME=value`, `"api_key":"…"`, URL credentials, long base64 or hex) becomes `[redacted]`. The journal never follows a symlink out of the project.

## The brief and the handoff

- `swarm brief` prints under 4 KB: the goal and when it is done, what is done, what is running, what needs the owner, **the next 3 actions as commands**, and the rules that apply (route cheapest first, never merge or raise a cap without the owner's OK, no secrets to workers).
- `swarm handoff --to codex|cursor|claude|gemini` prints one message you can paste into that agent: a header saying it is now the orchestrator, the brief, and where its instructions are.
- `coordination/HANDOFF.md` is regenerated from the journal after every command. A hand-written file is never lost: it is kept as `HANDOFF.previous.md` (then `-2`, `-3`, …). The regenerated files do not make `swarm go` think the work tree is dirty.
- `swarm init` writes `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and the Cursor rule with one extra line: **at session start, run `swarm brief` and continue from its next actions.**

## Checkpoints

`swarm checkpoint` saves the brief under `.swarm/project/checkpoints` (the newest 20 are kept), journals it, and refreshes `HANDOFF.md`. It needs no model. `swarm init` adds a Claude Code `Stop` hook to `.claude/settings.local.json` (local to the checkout and git-ignored) that runs it after each turn, so the state is current even if the next turn is rate limited. The hook does nothing where `swarm` is not on PATH, and your other settings and hooks are kept.

## Autopilot

`swarm autopilot [--once] [--interval SECONDS] [--max-steps N]` drives the project with no model, checking every `--interval` seconds (at least 5, default 30). For each recent run it does the first thing that applies:

1. A run that finished but was not integrated: integrate it through the merge queue. It only does this from a clean checkout on a `swarm/*` branch (or a linked worktree that is not main/master). On main/master, another branch, or with uncommitted changes it adds a blocker (`integrate-checkout-<run>`) and integrates nothing. A failed integration is never repeated; it becomes a blocker.
2. A run paused on a quota window that has passed: resume it. A run paused on a daily lane cap: try again after 15 minutes. A run paused on its own spend cap: **blocker**, because only the owner raises a cap.
3. A run with failed jobs: retry the failed jobs once, as a new run linked to the first. A retry that also fails is a blocker, never retried again.
4. If `.swarm/project/plan.json` exists (`{ "waves": [{ "id", "manifest", "after": ["wave id"], "maxUsd?", "maxTokens?" }] }`): start the next wave whose `after` waves are complete and integrated, at most one per step.

Autopilot never merges a PR, deploys, raises a cap, passes `--raise` to a resume, or calls a model. Anything it starts keeps the original spend caps, or `swarm go`'s default ($5 and 2M tokens) when none was set. It fails closed: if the journal cannot be read or written it does nothing, and it also remembers what it already did in this process, so a paid retry or wave cannot repeat. A blocker is written once and shows up in `swarm brief` under "Needs the owner".

## Taking over

Kill the session, start another agent (Codex, Cursor, Gemini, Claude), run `swarm brief`, and continue from its next actions. Runs started earlier are still going; `swarm brief` lists them.

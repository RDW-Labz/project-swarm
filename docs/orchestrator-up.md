# Always-on orchestrator (second seat)

A small helper for a Mac that stays on (for example a Mac mini): one tmux session running `claude remote-control` in your project repo. You drive it from [claude.ai/code](https://claude.ai/code) or the Claude phone app via Remote Control, alongside your main orchestrator on your laptop.

## Prerequisites

- `brew install tmux`
- Claude Code installed and signed in on that Mac
- In the project directory, run `claude remote-control` once by hand and confirm it connects before you automate it

## Start, stop, and status

From the project root (or pass `--root`):

```bash
node tools/orchestrator-up.mjs up
node tools/orchestrator-up.mjs status
node tools/orchestrator-up.mjs down
```

Optional flags: `--name` (tmux session name), `--permission-mode` (same values as Claude Code: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`).

Each command prints one JSON line. On success, `up` reports `started` or `running` and an `attach` hint.

## Attach and detach

```bash
tmux attach -t swarm-orch-<slug>
```

`<slug>` comes from the project folder name (letters, numbers, and hyphens). Detach without stopping Remote Control: **Ctrl-b** then **d**.

## Start at login (launchd)

Preview the plist first:

```bash
node tools/orchestrator-up.mjs launchd install --dry-run
```

Install for your user (runs `up` at login):

```bash
node tools/orchestrator-up.mjs launchd install --root /path/to/project
```

Logs: `~/Library/Logs/project-swarm/com.project-swarm.orchestrator.*.log`

Remove the LaunchAgent (does not stop tmux):

```bash
node tools/orchestrator-up.mjs launchd uninstall --root /path/to/project
```

## Safety

- `down` kills only its own tmux session (exact name match), never by pattern or PID.
- `launchd uninstall` leaves the tmux session running; use `down` when you want it stopped.
- The plist has no secrets—only paths and the `up` command.
- Treat this as a **second** orchestrator: take only assigned work on your own branches, and share the same spend ceiling with the first seat.

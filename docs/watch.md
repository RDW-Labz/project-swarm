# Swarm Watch

A read-only dashboard for a run. Design: [plans/watch-design.md](plans/watch-design.md). Spec: [plans/swarm-watch-spec.md](plans/swarm-watch-spec.md).

## Use

- `swarm watch` starts the dashboard for the newest live run in this project (or the newest run) and prints a URL. `swarm watch RUN` picks a run. `--open` opens the browser.
- `swarm watch --tui` draws the same data in the terminal (press `q` to leave). `swarm watch --json` prints the run and plan data once. `swarm watch --all` lists every live run on this machine with the command to watch each.
- `swarm gallery list` shows the screens from `swarm ui check`. `swarm gallery approve ID...` approves them. `swarm gallery comment ID "text"` saves a comment.

## What it shows

| Tab | Source | Shows |
|---|---|---|
| Run | `.swarm/runs/<id>/state.json` and `manifest.json` | status, progress, in flight, first-try pass rate, spend, ETA, the swarm map (one square per job, by state or lane), lanes, waves, needs-attention feed, leads, merge queue, the final banner, a job drawer |
| Build Plan | `.swarm/project/tickets.json` | scope header, stage lanes, epics and ticket cards, requirements (done, partial, missing), dependency graph with blocked chains, change orders, ticket drawer |
| Commands | the command registry of `swarm completion` plus `tools/watch-command-meta.mjs` | every command with what, when, example, flags, cost and approval pills; search; the commands for this run |
| Gallery | `.swarm/ui/results.json`, screenshots, `.swarm/ui/gallery.json` | mockup and page side by side, verdict, approval (approved, stale, none), comments |

## Safety

- Binds to 127.0.0.1 on a random port. Every page, data and screenshot request needs the token from the URL. A wrong `Host` header is refused (DNS rebinding). Only GET and HEAD are served; there are no write routes.
- A Content-Security-Policy allows only this server's own scripts and styles. The page never uses `innerHTML`; worker text is set as text (a test scans for this).
- It reads only the run's own state, the ticket ledger and `.swarm/ui/`. It never reads worker workspaces or secrets.
- No CDN or web font: fonts fall back to the system stack.

## Known limits

- The job drawer shows what the run state holds per job (lane, model, attempts, cost, time), not the worker's report or check output.
- `swarm go` does not start the server yet; run `swarm watch` in a second terminal.
- `--all` is a text board, not a web board.
- A gallery comment is saved, but does not create a fix ticket yet.

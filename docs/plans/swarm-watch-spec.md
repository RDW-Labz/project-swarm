# Phase 16 (expanded) — Swarm Watch

Replaces Phase 16 in `docs/plans/swarm-scale-plan-v2.md`.

Reference design: `docs/design/swarm-watch-prototype.html` (a working prototype with fake data). Match its layout, colors, fonts and motion. Replace the simulation with real run data.

## Commands

- `swarm watch`: opens the web dashboard for the newest live run in this project and prints the URL.
- `swarm watch <run-id>`: watch a specific run (live or finished).
- `swarm watch --all`: a board of every live run on this machine (all projects), one card each, with a click-through to the full view.
- `swarm watch --tui`: the same data in the terminal (for SSH and quick checks).
- `swarm go` and `swarm "goal"` print the watch URL when the run starts. `--watch` opens it automatically.

## Web dashboard (match the prototype)

Sections, top to bottom:

1. **Header:** run id, goal, status chip (LIVE pulsing / PAUSED / COMPLETE / FAILED), elapsed time, branch, budget pill.
2. **KPI row:** progress ring (done/total), in flight now plus a sparkline and the peak, first-try pass rate with retries and failed pills, spend against budget plus the forecast, ETA plus jobs/s, merged count plus queue and conflicts.
3. **Swarm map:** one rounded square per job, grouped by lead, drawn on a canvas. Running squares pulse in their lane's color. A toggle colors by state or by lane. Hovering shows id, file, lead, wave, type, lane/model, attempt and cost. Clicking opens a job drawer (below).
4. **Lanes:** one card per lane showing in flight / current limit, a bar with a marker for the adaptive limit, and done, pass rate, average time, 429s and cost pills. Offline lanes are dimmed with the reason (for example "dev2 unreachable").
5. **Waves:** contracts → build → verify progress bars (done plus running), then two charts: in flight over time and finished per second.
6. **Needs attention:** a newest-first feed of retries, failures, escalations, 429 backoffs, bisects, conflicts and cap pauses, with severity stripes. Quoted worker text gets a "worker text" tag and is always escaped.
7. **Leads table:** lead, scope, progress bar, running, retries, spend, state pill, and a sensitive pill when it applies.
8. **Merge queue:** waiting, batches, bisects and conflicts, plus a strip of the last batch results (✓ / bisect / conflict).
9. **Job drawer (new):** the job's prompt summary, files, lane history across attempts, short report, check results, cost and timing, plus the commands to run (`swarm inspect`, `swarm retry <job>`). Read-only.
10. **Run complete:** a final banner with the rollup (counts, spend per lane, time, branch name), the final gate result, and the review command.

Style (from Braden's taste): navy base, lime primary, one hue per lane (teal Hermes, blue Cursor, amber Codex, coral Anthropic, lavender OpenRouter, gold Claude). Rounded cards, pill chips, soft gradients, HUD corner brackets, comfortable contrast (not harsh), smooth motion, and `prefers-reduced-motion` respected. Fonts: Unbounded for display, Figtree for body, JetBrains Mono for data. Must work at phone width.

## Terminal view (`--tui`)

Same order, condensed:

```
 SWARM go-7f3a  LIVE  12:41  swarm/go-7f3a          $1.84 / $5  ETA 03:10
 ████████████████░░░░░░  812/1,200  68%   in flight 412  pass 97.1%
 LANES  cursor  8/8  ███  codex 6/6 ███  anthropic 318/402 ██████▌  openrouter 74/260 ██  claude 1/4  hermes off
 WAVES  contracts ██████████ 72/72   build ███████░░ 590/840   verify ██░░░ 150/288
 MAP    api ▓▓▓▓▓▓▓▓▒▒░░  web ▓▓▓▓▓▒▒▒░░  payments ▓▓▓▒▒░  data ▓▓▒░  tests ▓▒░  docs ▓▓▓▓▒
 ATTN   ! retry web-013 on Codex · "Missing import in handler" [worker]
        ✗ failed api-211 · 3 attempts
 MERGE  waiting 12 · batches 80 · bisects 2 · conflicts 1
 [q] quit  [l] lanes  [a] attention  [j] jobs  [/] filter
```

Use 256-color with the same lane hues, redraw at most 4×/s with no flicker, and adapt to terminal width.

## Data and server

- The source is the run's event log (Phase 14). Watch never reads worker workspaces or secrets.
- A local server binds to **127.0.0.1 only**, on a random port, with a random token in the URL. It refuses other hosts.
- The page gets a snapshot, then streams deltas over Server-Sent Events. Send at most 4 updates per second and batch events.
- It's read-only: no endpoints that change anything. Pause, resume, cancel and retry stay CLI-only and are shown as copyable commands.
- Escape all worker text and strip control characters (reuse `sanitizeWorkerText`).
- No external network. Fonts are bundled or fall back to the system stack. No CDN at runtime.
- The server exits when the run finishes and the page is closed, or after 30 minutes idle.

## Performance targets

- Smooth at 5,000 jobs and 1,000 in flight: the canvas map redraws under 8 ms, the page stays under 150 MB, and the CPU of the watch server stays under 5% of one core.
- `--all` board handles 20 live runs.

## Tests

- A server test: 127.0.0.1 binding only, the token is required, and there are no write routes.
- A snapshot plus delta replay rebuilds the same state as the event log.
- Untrusted text is escaped (an XSS attempt in a worker summary renders as text).
- The TUI renders at 80 and 160 columns.
- A Playwright check that the dashboard loads a recorded 1,200-job run and the map, lanes and feed all fill in.

## Done when

You can follow a real 1,000+ job `swarm go` run from start to the final gate without reading logs, on desktop or phone, and see at a glance what's running, what's stuck, what it costs and when it'll finish.

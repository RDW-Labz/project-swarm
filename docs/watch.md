# Swarm Watch

A read-only dashboard for a run. Design: [plans/watch-design.md](plans/watch-design.md). Spec: [plans/swarm-watch-spec.md](plans/swarm-watch-spec.md).

## Use

- `swarm watch` starts the dashboard for the newest live run in this project (or the newest run) and prints a URL. `swarm watch RUN` picks a run. `--open` opens the browser.
- `swarm watch --tui` draws the same data in the terminal (press `q` to leave). `swarm watch --json` prints the run and plan data once. `swarm watch --all` opens the **board**: every project on this machine (see below). `--all --text` prints the live runs as a list and `--all --json` prints them as data.
- `swarm go` starts Swarm Watch for its run when you are at a terminal and prints `watch: URL` (not in CI or a pipe; `--no-watch` or `SWARM_NO_WATCH=1` turns it off). It stops by itself when the run is done and the page is closed, or after 30 minutes idle. `go --scope` (the wave loop) does not start one: run `swarm watch` beside it.
- `swarm gallery list` shows the screens from `swarm ui check`. `swarm gallery approve ID...` approves them. `swarm gallery comment ID "text"` saves a comment and, when a ticket ledger exists, proposes a fix ticket for it; `swarm gallery tickets [ID...]` does the same for older comments.
- **Comments are untrusted text.** The ticket's title and acceptance are fixed words; the comment is kept only in `notes`, and a worker sees it only as quoted data. The ticket is `proposed`: outside the plan and the approval, never ready, never a job. You read it (`swarm tickets --status proposed`), name its files (`swarm tickets T-0042 --files a,b --yes`), and approve it (`swarm tickets T-0042 --approve --yes`); only then it is a todo ticket. `--set cancelled` drops it.

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

- The job drawer fetches the worker's report (summary, files, risks, follow-ups) when it opens, as sanitised, capped text under an "untrusted worker data" label; it does not show check output.
- The board lists runs; each run's page is its own server, so you copy the command for it.

## The board (`swarm watch --all`)

One page for the whole machine, read-only and behind a token like every Watch page. Its look and rules are in [design/swarm-watch-design-system.md](design/swarm-watch-design-system.md); screenshots are in `docs/design/screenshots/` (made from invented sample data).

**Tabs** (keys `1` to `4`, arrow keys between them, `#tab=cost` in the address): **Overview** (live agents, spend, worker use, lane bays, projects, Needs you), **Cost** (today per lane against its daily cap with the time the cap resets and any rate-limit pause with its end time, spend per project against its cap), **Agents** (one robot head per live agent) and **Events** (the history, search and filters).

**Keys:** `/` search events, `u` mark Needs you read, `p` pause motion, `?` the list, `Esc` closes. **Phone:** one column, Needs you first, tables become cards, controls at least 44px.

**Live state, never invented.** The "Live" chip is live only while the last answer is under 6 seconds old, then it says Stale with the time of the last good answer. A head is *working* when its job produced output in the last 90 seconds, *thinking* when it is running without output (yet, or for longer), *error* (red face) when its job failed or timed out in the last 10 minutes, and a *sleeping* head means no agent is running in that lane. Heads are the MIT-licensed robot-heads drawing, ported without React ([third-party.md](third-party.md)); at most 12 move at once, the rest show a still frame, nothing animates off screen or with the tab hidden, and with reduced motion (or Pause motion) every head is still.

**Run inspector** (`/run?id=PROJECT&run=RUN`, or `#run=PROJECT/RUN` on the board): the run's jobs as a graph (an arrow goes from a job to the job that waited for it; a run with no recorded dependencies says so), a dashed outline for a job tried more than once (a retry or a move to another lane), a journal of every time the run recorded with each job's cost where it ended, a replay slider and Play, and a compare against another run of the same project (totals, lanes, shared job ids with a different outcome). The live per-run Watch page stays one link away.

- **Needs you:** above the projects, everything waiting for you in every project: decisions with choices, human tasks, blockers, and proposed tickets (from gallery comments or production errors), oldest and most-blocking first. Each row shows the command to run at your computer (with a Copy button) and, if it was also asked on your phone, that question's state and when it expires. Blockers say what to do next (a "do this" line and Copy commands, including `swarm resolve ID` to dismiss one you dealt with). "FYI, no action needed" notes are kept in a collapsed list and not counted. Test and temp projects are hidden unless you switch them on. New items carry a badge until you have seen them (kept in this browser; reading the panel for a moment marks them). It is **read-only**: the board never answers anything. The top bar shows how many need you; `swarm watch --all --text` and `swarm status --all` print the same list.
- **Top:** live agents right now (workers running in runs that are really alive), by lane (Haiku, Sonnet, Opus, Codex, Cursor, GPU) and by project; spend today (UTC day), over the last 7 days and all time, in total and per project. Today and 7 days count what is billed per use (API lanes, rented GPUs); the all-time total is the number the project's cap uses and also holds the flat-rate lanes (Codex, Cursor, Claude subscription), which are shown apart as a list value only because they cost nothing extra; estimates (from tokens or a reservation) are marked. Each project's total is exactly the number its spend cap uses, and the machine totals are the sums of the project totals.
- **A lane per project:** current stage, live runs, jobs running / queued / blocked, open and blocked tickets, spend against the cap (or **NO CAP**, **CAP INVALID**, **CAP REACHED**), last activity. Lanes with live runs are open; idle ones are collapsed (your choice is kept while the page is open).
- **Click a run** and its own full Watch page opens: the board starts that run's page server (or reuses it) and sends you there; the page has its own token. **Click a project** for its page: tickets by status, run history, spend by lane, lessons.
- **History:** a permanent, append-only log of every project, stage, run, PR, merge, lesson and spend, newest first, in `~/.project-swarm/history/history.ndjson`. Search it, filter by project, type and date, click an entry to open it (a run opens its page, a PR opens on GitHub), export it as CSV. It survives restarts; `swarm history --backfill` adds what is already on disk (runs, spend, finished stages, lessons), and running it again adds nothing.
- **Workers held:** with a machine-wide worker limit (`machineConcurrency`, see [lanes.md](lanes.md)) the top bar shows how many workers are in use of the limit, which project holds how many (by lane), and which projects are waiting; without a limit it shows who holds what.
- **Limits:** the board reads at most the newest 5000 runs of a project and remembers parsed run states until they change; at most 6 per-run pages stay open from the board (the oldest is closed) and each closes after 10 idle minutes; the history log is read whole and is not rotated yet.
- **Getting back:** every run page and project page has "← All projects" and a breadcrumb (All projects › project › run). The links are ordinary links, so the Back button works too. From a run page the link finds the board that is running (its address is kept in `~/.project-swarm/board.json`, readable only by you) or starts one, and sends the browser there with the board's own token; a run page opened directly with `swarm watch RUN` works the same way. A board started that way stays up as long as that process does.
- **Which projects:** any swarm command run inside a folder lists it (`~/.project-swarm/projects.json`; scratch folders in the temp directory are not listed). `swarm projects`, `swarm projects add PATH`, `swarm projects remove ID` (removing only unlists it).
- **Isolation:** a project is named by an id from that list, never by a path the page sends. Its runs, tickets, lessons and files are read only under its own folder; two projects with the same run id are two different runs. `swarm history` (`--project`, `--kind`, `--q`, `--from`, `--to`, `--csv`) is the same log in the terminal.

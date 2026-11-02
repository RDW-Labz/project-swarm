# Swarm Watch: build design (Phase 16)

Spec: [swarm-watch-spec.md](swarm-watch-spec.md). Look: [the prototype](../design/swarm-watch-prototype.html). Build Plan: section 6 of [the scope spec](swarm-scope-tickets-spec.md). This file fixes the module contracts so workers can build the pieces in parallel.

## Decisions

- **Read-only means no write routes.** The page has three tabs: Run, Build Plan, Commands, plus a Gallery tab. Nothing in the page changes state. Gallery approval and comments are CLI commands the page shows as copyable text (`swarm gallery approve|comment`), which write `.swarm/ui/gallery.json`. A gallery comment becomes a fix ticket through that command, not through the server.
- **Commands tab source:** the `COMMANDS` registry in `tools/completion.mjs` (the same table `swarm completion` uses). `tools/watch-command-meta.mjs` adds what / when / example / cost / approval per command. A test fails when a registry command has no meta.
- **Data:** run `state.json` plus manifest (Run tab), `.swarm/project/tickets.json` (Build Plan), `.swarm/ui/results.json` and the screenshots (Gallery). No event log, no worker workspaces, no secrets.
- **Assets are real files** in `tools/watch-assets/`: `index.html` and `watch.css` (taken from the prototype: markup, styles), then `tabs.css`, `plan.css`, `commands.css`, `gallery.css`, `app.js`, `run-kpis.js`, `run-panels.js`, `run-drawer.js`, `run-map.js`, `plan-tab.js`, `plan-views.js`, `commands-tab.js`, `gallery-tab.js`. No template literals, no CDN, fonts fall back to the system stack. The server reads them from disk at start.

## Module contracts

All are ES modules, node built-ins only, pure unless stated. Worker text always goes through `sanitizeWorkerText` from `./worker-text.mjs` and is cut to 200 characters.

### tools/watch-state.mjs

`buildRunSnapshot(state, { manifest = null, now = Date.now() } = {})` returns:

```
{ schema: 1, runId, goal, branch, status, startedAt, finishedAt, elapsedMs,
  kpi, jobs, lanes, waves, attention, leads, mergeQueue, rollup }
```

- `runId` = `state.id`; `goal` = `manifest?.goal` or null; `branch` = `state.branch` or null.
- `status`: `state.pause` set and the run not finished -> `paused`; `state.status` `running` or `queued` -> `live`; `complete`, `integrated`, `integrated-with-failures` -> `complete`; anything else -> `failed`.
- `elapsedMs` = (`finishedAt` or `now`) minus `startedAt`; 0 when `startedAt` is missing.
- `jobs`: one per `state.jobs` entry, in order: `{ id, status, lane, agent, model, attempts, lead, wave, type, file, costUsd, durationMs }`. `lane` = job.lane or job.agent. `attempts` = length of job.attempts (0 if none). `lead`, `wave`, `type` come from the manifest job with the same id (null when absent). `file` = first of job.outputs or null. `costUsd` = job.costUsd or 0.
- `kpi`: `{ total, done, running, queued, failed, cancelled, retries, firstTryPassRate, peakInFlight, spendUsd, jobsPerSec, etaMs }`. `done` = status `complete`. `failed` = `failed` plus `timeout`. `retries` = sum over jobs of max(0, attempts - 1). `firstTryPassRate` = jobs complete with attempts <= 1 divided by finished jobs (complete, failed, timeout), or null when none finished. `peakInFlight` = `state.peakConcurrency` or 0. `spendUsd` = sum of costUsd. `jobsPerSec` = finished jobs divided by elapsed seconds (0 when elapsed is 0). `etaMs` = 0 when nothing is queued or running, null when jobsPerSec is 0, else (queued + running) / jobsPerSec * 1000 rounded.
- `lanes`: one per entry of `state.lanes.lanes` (an object keyed by name), sorted by name: `{ name, state, offline, inFlight, limit, done, failed, passRate, avgMs, rateLimits, costUsd, reason }`. `offline` = state is not `ok`. `limit` = the entry's `concurrency`. `done`/`failed` count jobs on that lane. `passRate` = done / (done + failed), null when both 0. `avgMs` = mean durationMs of finished jobs on the lane, null when none. `rateLimits` = sum of job.rateLimitRetries on the lane. `reason` = `<name> <state>` when offline, else null.
- `waves`: always three entries in order `contracts`, `build`, `verify`: `{ name, total, done, running }`. A job's wave is its manifest `wave` when that is one of the three names, else `contracts` for type `contract`, `verify` for type `test`, else `build`.
- `attention`: newest first, at most 50: `{ at, kind, severity, jobId, text }`. Kinds: `retry` (attempts > 1; severity warn; at = startedAt of the last attempt; text = the previous attempt's error or "retry"), `failure` (status failed or timeout; error; text = job.error or report.summary), `rate-limit` (rateLimitRetries > 0; warn), `pause` (state.pause set; warn; jobId null), `conflict` (one per entry of `state.mergeQueue.conflicts`; error; jobId null; text = the entry as a string, or its `file` field). `at` is an ISO string (job finishedAt, else startedAt, else the run startedAt).
- `leads`: group jobs by `lead` (jobs with no lead go in `main`), sorted by name: `{ lead, total, done, running, retries, spendUsd, state }`. `state`: `running` when any job runs, else `failed` when any failed, else `done` when all complete, else `queued`.
- `mergeQueue`: null when `state.mergeQueue` is missing, else `{ state, batches, integrated, conflicts, bisects, recent }`. The counts are array lengths (0 when absent). `bisects` = batches whose `bisected` is truthy. `recent` = the last 12 batches as `ok`, `bisect` (bisected truthy) or `conflict` (has a non-empty `conflicts` array).
- `rollup`: null unless status is `complete` or `failed`, else `{ counts, spendByLane, elapsedMs, branch }`. `counts` = `{ done, failed, cancelled, total }`; `spendByLane` = `{ lane: usd }`.

### tools/watch-delta.mjs

- `diffSnapshots(prev, next)` returns `{ keys, jobs }`. `keys` is a plain object mapping each top-level key of `next` except `jobs` whose JSON differs from `prev` to its new value (all such keys when `prev` is null; an empty object `{}` when nothing changed). `jobs` is `{ upserts: [job...], removed: [id...] }`: jobs that are new or changed (by JSON) and ids that disappeared.
- `applyDelta(prev, delta)` returns a new snapshot: `prev` (or `{ jobs: [] }` when null) with `keys` merged in and the jobs upserted (by id, new ids appended in delta order) and removed. It never mutates `prev`.
- Round trip: `applyDelta(a, diffSnapshots(a, b))` deep-equals `b` when `b.jobs` keeps the order of `a.jobs` plus appended new jobs.
- `createThrottle(intervalMs, now = Date.now)` returns `{ shouldSend() }`: true at most once per interval (first call true).

### tools/watch-plan.mjs

`buildPlanSnapshot(ledger, { now = Date.now() } = {})`. Uses `ledgerStats` from `./tickets.mjs`. Returns `{ schema: 1, present: false }` when `ledger` is null or has no tickets. Otherwise:

```
{ schema: 1, present: true, header, stages, requirements, dependencies, changeOrders, tickets }
```

- `header`: `{ scopeName, scopeVersion, percentDone, coveragePct, total, byStatus, spendUsd, estimateUsd, changeOrderCount }`. `scopeName`/`scopeVersion` from `ledger.scope` (an object with `name`, `version`; null when absent). `percentDone`, `coveragePct`, `total`, `byStatus` from `ledgerStats`. `spendUsd` = sum of ticket `costUsd` (0 when absent). `estimateUsd` = `ledger.estimate?.usd` or null. `changeOrderCount` = length of `ledger.changeOrders`.
- `stages`: one per distinct ticket `stage` (`none` when missing), in first-seen order: `{ id, total, done, percent, epics }`. `percent` = done / non-cancelled total, rounded, 0 when none. `epics`: grouped by ticket `epic` (`general` when missing), first-seen order: `{ id, total, done, cards }`. A card is `{ id, title, type, status, risk, sensitive, lane }` (`lane` = ticket.lane or null).
- `requirements`: from `ledger.requirements` (ids as strings or `{ id, title }`); when absent, from the union of ticket `scopeRefs`. Each: `{ id, title, tickets, state }`. `tickets` = ids of non-cancelled tickets that list it in `scopeRefs`. `state`: `missing` (no tickets), `done` (all done), else `partial`. Sorted by id.
- `dependencies`: `{ nodes, edges, blocked }`. `nodes` = `[{ id, status }]` for non-cancelled tickets. `edges` = `[{ from, to }]` meaning `from` depends on `to`, only between listed nodes. `blocked` = ids of non-done, non-cancelled tickets that depend (directly or through a chain) on a ticket whose status is `blocked`, plus the blocked tickets themselves; sorted.
- `changeOrders`: the ledger entries oldest first as `{ id, at, by, reason, cancelled, reopened, added }`; `added` = `diff.added` count (0 when absent). Reason text is sanitized.
- `tickets`: an object keyed by id: `{ id, title, type, status, stage, epic, risk, sensitive, lane, scopeRefs, acceptance, files, dependsOn, costUsd, pr, review, drift }`. Missing values are null, missing arrays are `[]`, `drift` is an array of strings. All text sanitized.

### tools/watch-command-meta.mjs

- `COMMAND_META`: an object keyed by command name with `{ what, when, example, cost, approval }`. `cost` is one of `free`, `local`, `spends`. `approval` is true when the command needs the owner's say (merges, spends, rents, deletes).
- `buildCommandList(commands, meta = COMMAND_META)` takes the `COMMANDS` array from `./completion.mjs` and returns `[{ name, summary, what, when, example, cost, approval, flags }]` sorted by name. A command without meta gets `what` = its summary, `when` = "", `example` = `swarm <name>`, `cost` = `free`, `approval` = false.
- `searchCommands(list, query)`: case-insensitive; every whitespace-separated word must appear in name, summary, what or when. Empty query returns the list.
- `contextCommands(snapshot, plan)` returns the copyable commands for the current run, a list of `{ label, command }`: `swarm inspect <runId>`, `swarm monitor <runId> --view`, `swarm cancel <runId>` (live or paused only), `swarm resume <runId>` (paused only), `swarm integrate <runId> --queue` (complete only), and `swarm inspect <runId> --results` when any job failed. Ids are used only when they match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`; `swarm retry` does not exist, so it is never shown. When `plan.present`, also `swarm tickets` and `swarm scope sync <runId> --integrated`.

### tools/watch-tui.mjs

`renderTui(snapshot, { width = 100, color = false, plan = null } = {})` returns a string of lines (no trailing newline) in the order of the spec: header, progress bar, lanes, waves, attention (max 6), merge. ASCII bars (`#` and `.`), width-adaptive (at 80 columns no line exceeds 80 visible characters; at 160 it uses the room). With `color` it uses 256-color lane hues, but the visible text is identical. A null `snapshot` gives a one-line "no run found". `formatBar(done, total, width)` is also exported.

### tools/watch-gallery.mjs (I/O)

- Every function in this module is async and returns a promise.
- `readGallery(root)` reads `.swarm/ui/results.json` and `.swarm/ui/gallery.json`; returns `{ schema: 1, screens: [{ id, verdict, at, score, hasMockup, hasPage, approval, comments }] }`. `results.json` is `{ at, head, screens: { <id>: { pass, score, reasons, at, tree, serverStarted } } }` (written by `swarm ui check`); a screen's `verdict` is `pass` when `pass` is true, else `fail`, its `fingerprint` is `tree` (a string), `at` and `score` as stored. Screenshot files are `.swarm/ui/<id>/mockup.png` and `page.png`; ids must match `^[a-z0-9][a-z0-9-]{0,63}$` or are skipped. Missing files give an empty screens list.
- `gallery.json` is `{ version: 1, screens: { <id>: { approved: { at, by, fingerprint } | null, comments: [{ at, text, ticket }] } } }`. `approval` in the read result is `approved` when the stored fingerprint equals the screen's current result fingerprint, `stale` when it differs, `none` otherwise.
- `approveScreens(root, ids, { by, now })` stores each id's current result `tree` as the approval fingerprint; `addComment(root, id, text, { now })` appends a comment with `ticket` null. Both create `.swarm/ui/` when missing, treat a missing `gallery.json` as empty, and write `gallery.json` atomically (temp file and rename). An id is known when it is in `results.json`. The comment text is sanitized and cut to 500 characters. Unknown ids throw.
- `screenshotPath(root, id, kind)` returns the absolute path for `kind` `mockup` or `page`, or null when the id is invalid or the file is missing or not a regular file (no symlinks).

### tools/watch-server.mjs (network surface)

`createWatchServer({ root, getRunSnapshot, getPlanSnapshot, getGallery, commandList, contextCommands, assetDir, deltaFile, idleMs = 1800000, now })`. The `get*` options are sync or async functions returning the data (`getRunSnapshot` may return null); `contextCommands(run, plan)` returns the list for the Commands tab; `deltaFile` is the absolute path of `watch-delta.mjs` returns `{ listen(), close(), token, url }`.

- Binds to `127.0.0.1` on port 0 (random). The token is 24 random bytes in hex. `url` = `http://127.0.0.1:<port>/?t=<token>` after `listen()`.
- Refuses any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (421), and any request without the token (query `t` or header `x-watch-token`) with 403. The page itself, `/api/*`, `/events` and `/shot/*` need the token; `/assets/*` does not.
- Only `GET` (and `HEAD`) are served; every other method gets 405. There are no write routes.
- Routes: `/` (index.html), `/assets/<name>` (a fixed allow-list: the files in the assets directory by exact name, plus `watch-delta.mjs` served from `tools/watch-delta.mjs` with the JavaScript content type; assets need no token because they are public code), `/api/snapshot` (`{ run, plan, gallery, commands, contextCommands }` as JSON), `/events` (Server-Sent Events carrying the run snapshot only: an initial `snapshot` event, then `delta` events from `diffSnapshots` polled from `getRunSnapshot` once a second and sent only when something changed, so at most 4 per second; the event data is JSON), `/shot/<id>/<kind>` (PNG from `screenshotPath`).
- Security headers on every response: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Shuts down on its own after `idleMs` with no requests and no open event stream, and when the run is finished and no event stream is open for 10 seconds.

### tools/watch-cli.mjs (hand-written glue)

`swarm watch [RUN] [--all] [--tui] [--open] [--json]`, plus `swarm gallery list|approve ID...|comment ID "text"`.

## Client assets contract

`index.html` (already written, from the prototype) loads `app.js` first as a classic script, then the tab scripts as classic scripts. No inline script anywhere (the Content-Security-Policy forbids it). All page text is set with `textContent` or `setAttribute`; **never** use `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`, and never put worker text into an attribute that is a URL or event handler. No external URLs, no CDN. Respect `prefers-reduced-motion`. Phone width works (CSS grid, 16px gutters).

Registry (defined in `app.js`): `window.SwarmWatch = { register(name, fn), data, token, openDrawer(titleText, node), closeDrawer() }`. A tab script calls `window.SwarmWatch.register('run', fn)` where `fn(data)` renders. Several scripts may register under the same name; all are called. `data` is `{ run, plan, gallery, commands, contextCommands }`: `run` is a snapshot from `watch-state.mjs` (or null), `plan` from `watch-plan.mjs` (`{ present: false }` when there is none), `gallery` from `watch-gallery.mjs`, `commands` from `buildCommandList`, `contextCommands` from `contextCommands`. Tab names: `run`, `plan`, `commands`, `gallery`. A tab's `fn` is called on first data and again on every change, also while its tab is hidden.

`app.js`: reads the token from `location.search` (`t`), fetches `/api/snapshot?t=TOKEN`, opens `EventSource('/events?t=TOKEN')`, applies `snapshot` and `delta` events to `data.run` using `applyDelta` from `/assets/watch-delta.mjs` (loaded with a dynamic `import()`), refreshes `plan`, `gallery`, `commands` from the `/api/snapshot` response when a `refresh` event arrives or every 5 seconds, wires the tab buttons (`#tabs button[data-tab]`, panes `#pane-<name>`, `aria-selected`, remembers the tab in `location.hash`), implements the drawer (`#drawer`, with a close button, Escape closes it), shows a "connection lost" chip text in `#status` when the stream drops, and calls every registered `fn`. A `fn` that throws must not stop the others.

Run tab DOM ids already in `index.html` (from the prototype): `goal status clock branch kDone kPct ringArc kFlight kPeak spark kPass kPassSub kSpend kSpendBar kEta kRate kMerged kMergeSub map tip legend cState cLane lanes waves chFlight chRate feed attnCount leads mWait mBatch mBisect mConf batches doneBanner`. `run-kpis.js` renders `goal status clock branch kDone kPct ringArc kFlight kPeak spark kPass kPassSub kSpend kSpendBar kEta kRate kMerged kMergeSub chFlight chRate` and `#doneBanner`; `run-panels.js` renders `lanes waves feed attnCount leads mWait mBatch mBisect mConf batches`; `run-map.js` renders `#map`, `#tip`, `#legend` and the `cState`/`cLane` toggle and, on a click, calls `window.SwarmWatch.openJob(job)` (the click does nothing when it is missing); `run-drawer.js` defines `window.SwarmWatch.openJob(job)` which opens the job drawer for a job object from `data.run.jobs` (it reads the run id from `window.SwarmWatch.data.run`). Match the prototype's look: reuse its CSS classes and its drawing code (`docs/design/swarm-watch-prototype.html`). The job drawer shows the job's id, status, lane, model, attempts, lead, wave, type, file, cost and time, and the read-only commands `swarm inspect <runId>` and `swarm inspect <runId> --results` each with a Copy button. `#status` text is `LIVE`, `PAUSED`, `COMPLETE` or `FAILED` with the matching chip class. `#doneBanner` is shown only when `run.rollup` is not null: counts, spend per lane, time, branch, and the review command `swarm inspect <runId>`.

Copy buttons use `navigator.clipboard.writeText` when it exists, else select a text field. Every number from the data is formatted with a helper that tolerates null.

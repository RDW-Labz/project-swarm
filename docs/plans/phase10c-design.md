# Phase 10c design: never wait on a human

Contract for the Phase 10c modules. Plain ESM files, dependencies passed as arguments, no model calls, no network. Plan: `docs/plans/swarm-scale-plan-v2.md` (Phase 10c). Builds on the project journal (`tools/journal.mjs`) and autopilot (`tools/autopilot.mjs`) from 10b.

## 1. Human jobs (runner, done in `tools/swarm.mjs`)

A manifest job `{ "id", "type": "human", "title", "steps": ["..."], "after"? }` is a task only the owner can do. It has no `agent`, `prompt`, `outputs` or `checks`. `title` is 1-120 characters; `steps` is 1-30 strings of at most 400 characters each (copy-paste steps). Other jobs name it in `after` to wait for it.

- When a human job becomes ready the runner does not start anything. It marks the job `status: "held"`, `heldReason: "human"`, `error: <title>`; its dependents are held as `after <id> held` (existing held-job path). Every job that does not depend on it keeps running.
- The run ends `paused` with `pause.reasons` containing `human`. Nothing is spent.
- `swarm done RUN:JOB` marks the job `complete` (`human: { doneAt, by: "owner" }`), clears its hold, recomputes `pause.reasons`, writes a `human` journal event with `done: true`. It does not start work; autopilot (or `swarm resume RUN`) does.
- `resumeRun` treats a human job that is not complete as still held: it stays held, its dependents stay held, the run stays `paused` with reason `human`.
- Autopilot: a run paused only on `human` is `wait` (no action). Once no `human` reason is left and only `after ... held` reasons remain, it resumes the run (existing rule).

## 2. The inbox (`tools/inbox.mjs`)

```js
export async function collectInbox(roots, { readState, listRuns, readJournal, now }) // -> items sorted by unblocks desc, then age
export function formatInbox(items, { now }) // -> text
export async function markDone(root, ref, deps)   // ref "RUN:JOB" or journal item id
export async function decide(root, ref, choice, deps)
```

Item: `{ id, kind: "human" | "decision" | "blocker", project, title, steps, unblocks, since, run?, job?, choices?, default? }`.

- `human` items: every job in a project's runs with `heldReason: "human"` (id `RUN:JOB`); `unblocks` is the count of jobs that transitively depend on it and are not complete (computed from the run's manifest `after` edges). Plus open journal `human` events (id = event id; `unblocks` from the event, default 0).
- `decision` items: open journal `decision` events with `confirm: true` (fields `id`, `text`, `choice` (the default the swarm picked), `options?`). `swarm decision "TEXT" --choice X [--option Y]... [--id ID]` writes one. `swarm decide ID CHOICE` closes it (`confirmed: true`, `choice`). If CHOICE differs from the recorded default it adds a backlog goal `Change decision ID to CHOICE` (see 3). Same choice: just confirmed.
- `blocker` items: open journal `blocker` events (from autopilot) with `unblocks: 0`.
- Roots: the current project plus the paths in `<install>/.swarm-projects.json` that exist and are swarm projects. A root that cannot be read is skipped with a note, never an error.
- Output text: one block per item, sorted by `unblocks`, with the steps and the exact command to close it (`swarm done ID` or `swarm decide ID CHOICE`). `--json` prints the items. An empty inbox prints `Nothing needs you.`
- `swarm done ID` where ID is unknown or already done exits 1 with a one-line error and changes nothing.

## 3. The backlog (`tools/backlog.mjs`)

`.swarm/project/backlog.json`: `{ "items": [{ "id", "goal", "paths": [], "maxUsd"?, "addedAt", "status": "queued" | "started" | "done", "run"? }] }`.

```js
export async function readBacklog(root)
export async function addGoal(root, { goal, paths, maxUsd, id }, { now })   // goal 1-2000 chars; paths are relative project folders; max 50 items
export async function removeGoal(root, id)
export async function markStarted(root, id, runId) / markDone
export function nextStartable(items, { activeClaims })   // first queued item whose paths do not overlap activeClaims
```

- Writes go through a symlink-safe writer (`safeWritableDir` from `tools/journal.mjs`). Text is passed through `sanitizeText`.
- An item with no `paths` is startable only when `activeClaims` is empty (nothing else is waiting), because overlap cannot be ruled out.
- `activeClaims` are the folders and files named by `outputs` and write paths in the manifests of incomplete runs; two paths overlap when one is equal to or inside the other.
- CLI: `swarm backlog` (list), `swarm backlog add "GOAL" [--paths a/,b/] [--max-usd N]`, `swarm backlog remove ID`.
- Autopilot: when no run is `running`, at least one run is waiting (paused on `human` or a quota window), and the backlog has a startable item, it starts that goal through `deps.startBacklog(root, item)` (once per step, at most one, inside the item's `maxUsd` or `swarm go`'s default, only from a clean `swarm/*` branch like integration). A failure becomes a blocker; an item is never started twice.

## 4. Notifications (`tools/notify.mjs`)

```js
export function pendingNotifications(items, notified, { now, threshold = 20 })  // -> { messages, notified }
export async function macNotify(message, { run })  // osascript on darwin only; elsewhere returns false
```

- A message for an item that unblocks at least `threshold` jobs and was not notified yet. At most one daily digest (`Needs you: N items, unblocking M jobs`) per local day, only when `N > 0` and it unblocks something. Never a message for an item that unblocks nothing. Several new items go out as one grouped message.
- `notified` is `{ items: [id], digestDay }`, stored in `.swarm/project/notified.json`.
- Off unless machine config has `"notify": true`. Autopilot calls it once per step through `deps.notify`; a failing notifier is ignored.

## 5. Planner guidance

`docs/failover.md` and the `swarm init` pointers say how an orchestrator plans around a human step: a `type: "human"` job with the steps and what it blocks; a stub path built against an interface plus a mock with tests, with the real hookup as a small job that `after`s the human job; sensible defaults recorded with `swarm decision`; anything touching auth, payments or secrets stays behind a flag and marked "not wired".

## Done when

A run with three human jobs (a key, a login, a design choice) finishes every job that does not depend on them, then sits `paused` on `human`; `swarm inbox` lists the three sorted by unblocks; `swarm done` on each, and autopilot resumes the held jobs without further input. Tests cover each module and this end-to-end path with a stub agent.

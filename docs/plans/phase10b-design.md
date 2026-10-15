# Phase 10b design: orchestrator failover

This is the contract for the Phase 10b modules. Each module is a plain ESM file with an exported API and a test file. Modules take their dependencies as arguments so tests never touch a real model, git, or the network.

Plan reference: `docs/plans/swarm-scale-plan-v2.md` (Phase 10b) and `docs/plans/swarm-plan-v2-addendum.md`.

## 1. The project journal (`tools/journal.mjs`)

An append-only log at `<root>/.swarm/project/journal.ndjson`. One JSON object per line, written by the runner on every command, never by a model. `.swarm/` is git-ignored, so the journal is local state.

```js
export const KINDS = ['goal', 'plan', 'decision', 'run', 'integration', 'pr', 'blocker', 'human', 'note', 'command', 'action', 'checkpoint'];
export function journalPath(root)                      // path.join(root, '.swarm/project/journal.ndjson')
export async function appendEvent(root, event, { now = Date.now } = {})   // returns the stored event
export async function readJournal(root, { limit = 500, kinds = null } = {}) // newest `limit` events, oldest first; corrupt lines skipped
export function sanitizeText(text)                      // see below
export function openItems(events)                       // blockers and human tasks not yet resolved
```

`appendEvent`:
- `event.kind` must be in `KINDS`, else throw `Error('journal-kind-invalid: <kind>')`.
- Adds `ts` (ISO string from `now()`). Never trusts a caller-supplied `ts`.
- Every string value, at any depth, goes through `sanitizeText`. Event keys are limited to `[A-Za-z0-9_]{1,40}`; at most 30 keys at the top level; the serialized line is at most 8192 bytes (longer: truncate the longest string fields and set `truncated: true`).
- Creates `.swarm/project/` if needed. Appends with a single `appendFile` of `JSON.stringify(event) + '\n'`.
- Never throws on I/O failure of the journal itself when `{ best: true }` is passed in options; by default it throws. (The runner calls it with `best: true` so a journal problem never fails a command.)

`sanitizeText(text)`:
- Replace control characters (except `\n` and `\t`) with a space.
- Cut to 2000 characters, adding `…` when cut.
- Redact secrets: `sk-`, `sk-ant-`, `sk-or-` followed by 16+ word characters or dashes; `Bearer ` followed by 16+ token characters; `ghp_`/`github_pat_` tokens; `AKIA` + 16 uppercase alphanumerics; any `KEY=value`, `TOKEN=value`, `SECRET=value`, `PASSWORD=value` style assignment where the name ends in KEY, TOKEN, SECRET or PASSWORD (replace the value); 40+ character base64 or hex runs. Replace each with `[redacted]`.

Event shapes by kind (fields beyond these are allowed but not required):

| kind | fields |
| --- | --- |
| `goal` | `text`, `doneWhen?` |
| `plan` | `text`, `id?`, `waves?` (array of `{ id, manifest, after? }`) |
| `decision` | `text`, `id?` |
| `run` | `id`, `status`, `counts?`, `costUsd?`, `manifest?` |
| `integration` | `run`, `status`, `files?` (count) |
| `pr` | `url?`, `number?`, `status` (`opened`, `merged`, `closed`) |
| `blocker` | `id`, `text`, `resolved?` (true to close the blocker with the same id) |
| `human` | `id`, `text`, `steps?`, `unblocks?` (count), `done?` (true to close the item with the same id) |
| `note` | `text` |
| `command` | `cmd`, `args`, `status` (`ok` or `error`), `ms` |
| `action` | `action`, `run?`, `reason`, `result?` (autopilot actions) |
| `checkpoint` | `file` |

`openItems(events)` returns the latest event for each `id` among `blocker` and `human` events whose latest event does not have `resolved: true` (blocker) or `done: true` (human), newest first.

## 2. The brief (`tools/brief.mjs`)

Builds the briefing a new orchestrator reads first. Under 4096 bytes.

```js
export async function loadRuns(root, { limit = 10 } = {})
// Reads <root>/.swarm/runs/*/state.json. Returns compact runs, newest first by startedAt (fallback: directory name):
// { id, status, startedAt, finishedAt, counts, costUsd, pause, integrated }
//   counts      state.summary.counts or null
//   costUsd     sum of the numeric job costUsd values, or null
//   pause       state.pause ({ reasons, until, message, jobs, at }) or null
//   integrated  Boolean(state.integratedFiles?.length) or state.integrated === true
// Unreadable or corrupt state files are skipped.

export function buildBrief({ root, events, runs, rules, now = Date.now })
// -> { root, goal, doneWhen, done, running, open, next, rules }

export function renderBrief(brief)                     // text, at most 4096 bytes
export function renderHandoff(brief)                   // markdown for coordination/HANDOFF.md
export function renderAgentHandoff(brief, agent)       // agent is codex, cursor, claude or gemini
export const DEFAULT_RULES                             // array of strings, see below
```

`buildBrief` fields:
- `goal`, `doneWhen`: from the newest `goal` event; else `goal: null`.
- `done`: up to 8 lines, newest first: `integration` events with status `complete` or `integrated` ("run <id> integrated, <files> files"), `pr` events with status `merged` ("PR <number|url> merged"), and `run` events whose latest status for that id is `complete` and not yet integrated are NOT in `done`.
- `running`: runs from `runs` whose status is `running`, `queued` or `paused`, each as `{ id, status, counts, pause? }`, at most 5. Runs keep going without an orchestrator, so the brief says which run ids are live.
- `open`: `openItems(events)` as `{ id, kind, text, steps? }`, at most 6.
- `next`: exactly three commands (strings that start with `swarm `), chosen by the first matching rule, then filled from the fallback list without duplicates:
  1. A `running` run exists: `swarm monitor <id> --watch`.
  2. A paused run whose `pause.reasons` are only `quota` and `pause.until` is in the past: `swarm resume <id> --wait`; if `until` is in the future: `swarm wait <id>`; if the reasons include `run-cap` or `lane-cap`: `swarm resume <id> --raise maxUsd=<N> --reason TEXT` (needs the owner's decision, so the third command is `swarm brief` and the open list gets no automatic entry).
  3. A `complete` run that is not integrated: `swarm integrate <id> --queue`.
  4. A `failed` or `cancelled` run: `swarm inspect <id> --results`.
  5. No goal: `swarm "describe the goal in one sentence"`.
  6. An open `human` or `blocker` item: `swarm brief` (the owner must act; do not guess).
  Fallbacks, in order: `swarm status`, `swarm board`, `swarm doctor all`.
- `rules`: `rules` argument or `DEFAULT_RULES`.

`DEFAULT_RULES` (exact strings):
- `Route cheapest first: Haiku (anthropic), Cursor, Codex; Claude only after two failures; Hermes only for research; OpenRouter only for non-sensitive bookkeeping.`
- `Never merge to main, deploy, raise a spend cap or add a paid service without the owner's explicit OK.`
- `Never send secrets or .env files to a worker; sensitive jobs never go to OpenRouter, OpenAI, Gemini or Lambda.`
- `Workers run on the installed runner; update the runner only after the owner merges.`
- `Record decisions with swarm note "<text>".`

`renderBrief` layout (plain text, no color): `Project Swarm brief`, then `Goal:` (and `Done when:`), `Done:`, `Running:`, `Needs the owner:`, `Next 3 actions:` (numbered), `Rules:`. Empty sections print `none`. If the text is over 4096 bytes, shorten the `Done:` list first, then `Running:`, then `Needs the owner:`, then each line to 160 characters. The result is always at most 4096 bytes.

`renderHandoff(brief)` writes the same content as markdown. Its first line is exactly `<!-- generated by swarm; do not edit: regenerated from .swarm/project/journal.ndjson -->`.

`renderAgentHandoff(brief, agent)`: a header that says the reader is now the orchestrator, then `renderBrief(brief)`, then agent-specific lines:
- `codex`: tells it to read `AGENTS.md` and to run swarm commands through the `swarm` command.
- `cursor`: tells it to read `.cursor/rules/project-swarm.mdc`.
- `claude`: tells it to read `CLAUDE.md`.
- `gemini`: tells it to read `GEMINI.md`.
- Any other agent name throws `Error('handoff-agent-invalid: <name>')`.

## 3. Autopilot (`tools/autopilot.mjs`)

A loop that drives work with no model. It only calls the runner functions it is given.

```js
export const ACTIONS = ['integrate', 'resume', 'retry-failed', 'start-wave'];
export function decide(run, ctx)
// run: a compact run from loadRuns. ctx: { now, events, plan, attempts }
// -> { action, run, reason, ...extra } or { action: 'wait', run, reason } or { action: 'block', run, id, text } or null

export async function autopilotStep(root, deps, { now = Date.now } = {})
// deps: { loadRuns(root), readJournal(root), appendEvent(root, event), readPlan(root), integrate(root, runId), resume(root, runId), retryFailed(root, runId), startWave(root, wave) }
// -> { actions: [ ...results ], blocked: [ ...ids ], idle: boolean }

export async function runAutopilot(root, deps, { intervalMs = 30000, once = false, maxSteps = Infinity, signal, sleep, now = Date.now } = {})
// repeats autopilotStep until once, maxSteps, or signal aborted; returns the list of step results
```

`decide(run, ctx)` rules, first match wins:
1. `run.status` is `complete` and the run is not integrated: `{ action: 'integrate' }`. A run whose journal `action` events show an `integrate` that ended with a failure is not retried: return a `block` with id `integrate-<runId>` and text `Integration of run <id> needs a decision: <reason>`.
2. `run.status` is `paused`:
   - Every reason in `pause.reasons` is `quota` (or starts with `after `), and `pause.until` is missing or in the past, and the last `resume` action for this run was at least 5 minutes ago: `{ action: 'resume' }`.
   - Reasons are `quota` and `pause.until` is in the future: `{ action: 'wait', reason: 'quota until <until>' }`.
   - Reasons include `lane-cap` and the last `resume` action for this run was at least 15 minutes ago: `{ action: 'resume' }` (daily caps reset at UTC midnight; if the lane is still capped the run pauses again and nothing is raised).
   - Reasons include `run-cap`, or `child-paused`: `{ action: 'block', id: 'cap-<runId>', text: 'Run <id> is paused on a spend cap. Raising a cap needs the owner: swarm resume <id> --raise maxUsd=<N> --reason TEXT' }`.
3. `run.status` is `failed` and `run.counts.failed` is at least 1 and no `retry-failed` action exists for this run in `ctx.events`: `{ action: 'retry-failed' }` (once per run).
4. `run.status` is `failed` after one retry: `{ action: 'block', id: 'failed-<runId>', text: 'Run <id> still has failed jobs after one retry: swarm inspect <id> --results' }`.
5. Otherwise `null`.

Wave starting: `ctx.plan` is `{ waves: [{ id, manifest, after?: [waveId] }] }` read from `<root>/.swarm/project/plan.json`. A wave is startable when every wave id in `after` has a `run` journal event with `status: 'complete'` and a matching `integration` event, and no `action` event `start-wave` exists for it. `autopilotStep` starts at most one wave per step: `{ action: 'start-wave', wave }`.

`autopilotStep` order: for each run (newest first, at most 10) call `decide`; execute `integrate`, `resume`, `retry-failed` through `deps`; then at most one `start-wave`. Every executed action appends an `action` event (`action`, `run`, `reason`, `result` with `ok` or the error message, never more than 500 characters). Every `block` result appends a `blocker` event with the given `id` and `text`, once per id (skip when `openItems(events)` already holds that id). A dependency that throws is caught: the action is recorded as failed and the step continues with the next run.

Hard limits, enforced in code and tested:
- `autopilotStep` calls only `deps.integrate`, `deps.resume`, `deps.retryFailed`, `deps.startWave`, `deps.appendEvent`, `deps.readJournal`, `deps.loadRuns` and `deps.readPlan`. It has no way to merge a PR, deploy, change a cap, or call a model.
- `deps.resume(root, runId)` takes no raises argument. Autopilot never passes one.
- No more than 3 actions per run per step.

`runAutopilot` sleeps `intervalMs` between steps (using the injected `sleep`), stops when `signal.aborted`, and returns early when a step is idle and `once` is true.

## 4. Remote execution fix (`tools/remote-exec.mjs`, `tools/executors.mjs`)

The bug: the runner sent `{ id, files, outputs }` with no command, so `swarm-remote-exec` waited forever and returned no files. Remote placement was only ever tested with stub transports.

New request line (one JSON object on stdin, then stdin stays open as the liveness link):

```json
{ "id": "<8-32 hex>", "command": "/abs/path/cli", "args": ["..."], "stdin": "<job message, utf8>", "files": [{ "path": "rel/path", "bytes": "<base64>" }], "outputs": ["rel/path"], "env": { "PATH": "...", "LANG": "..." } }
```

`swarm-remote-exec` must:
- Create a fresh temporary workspace directory (mode 0700) and write each file into it. Refuse (exit 1, no output) a path that is absolute, contains `..`, or is a secret path (`.env`, `.env.*`, `.git`, `.swarm`, `.ssh`, `.aws`, `.gnupg`, as in `isSecretPath`).
- Require `command` to be an absolute path, without NUL or newline. Run it with `spawn(command, args, { cwd: workspace, env: allowlisted env, detached: true })`. The environment is only `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TZ`, `SWARM_PORT_BASE` taken from the request `env` (other keys dropped), with `HOME` set to the workspace.
- Send `request.stdin` to the child's stdin, then close it.
- On child exit, read each path in `outputs` from the workspace (skip a missing one; refuse a path that escapes the workspace or is a symlink), and write one JSON line to stdout: `{ "id": "...", "exitCode": <n>, "stdout": "<child stdout, base64, at most 4 MiB>", "files": [{ "path": "...", "bytes": "<base64>", "sha256": "<hex>" }] }`. Then remove the workspace and exit with code 0 (the exit code of the job is in the line; a non-zero `exitCode` is a job result, not a transport failure).
- Keep the existing behavior: if stdin closes or SIGHUP/SIGTERM arrives before the child exits, kill the child's process group and exit 1; the job record under `SWARM_REMOTE_JOBS` still holds the pid and any reported cost so `--kill <ids>` works.

`defaultHostTransport.run({ host, jobId, files, outputs, command, args, stdin, env, signal })` sends that request and returns `{ exitCode, stdout (Buffer), files: [{ path, bytes (Buffer), sha256 }] }` after checking every sha256 with `checkPulled`. A response whose `id` differs from the request id is a `host-pull-mismatch`.

Which jobs may run on a remote host: only the text-envelope CLI agents (`hermes`, `qwen`). The host entry may name the absolute CLI path per agent with an optional `commands` object, for example `"commands": { "hermes": "/home/dev2/.local/bin/hermes" }`. A job whose agent is not eligible, or whose host has no command path for it, always runs locally.

## 5. Tests and style

- Node 20+, ESM, no dependencies. First line of every new file is `// SPDX-License-Identifier: Apache-2.0`.
- Tests use `node:test` and `node:assert/strict` and start with `import './_isolate-config.mjs';`.
- Use temporary directories for every file the code writes. Never touch the real home directory.
- Run a single test file with `node --import ./tests/_isolate-config.mjs --test tests/<file>`.

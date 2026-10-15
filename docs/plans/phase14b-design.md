# Phase 14b design: Local brain

Contract for three plain-ESM modules (no dependencies, no network except through injected functions, every dependency passed in). The CLI wiring is done by hand in `tools/swarm.mjs`. Plan: `docs/plans/swarm-scale-plan-v2.md` (Phase 14b). Reuse `sanitizeText` from `tools/journal.mjs` for every string that comes back from a model.

Runner-side only: workers never call the local brain.

## 1. The link (`tools/brain-link.mjs`)

Opens the connection to dev2's Strata the way `dev2chat` does, from injected pieces so tests never use ssh.

```js
export async function openBrainLink(config, deps) // -> link
// config: { sshTarget, sshKey, remotePort = 8000, keyCommand, readyTimeoutMs = 20000 }
// deps:   { spawn, execFile, fetchImpl, freePort, sleep, now }   (all optional, defaulting to the real ones)
// link:   { chat(messages, { maxTokens, signal, temperature }) -> Promise<{ text, model, usage: { inTokens, outTokens } }>,
//           status() -> { up: boolean, model: string|null }, close() }
```

- `keyCommand` is the remote shell command that prints the server's API key (one line); it runs over ssh with `sshKey`, `BatchMode=yes`, `IdentitiesOnly=yes`, `ConnectTimeout=10`. The key lives only in a closure; it is never put in an error message, a log, `status()` or `config`.
- The tunnel is `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<remotePort> ...` with `ExitOnForwardFailure=yes`, `ServerAliveInterval=10`, `ServerAliveCountMax=3`, spawned without a shell; the local port comes from `freePort()`.
- Ready means `GET /health` through the tunnel returns JSON whose `loaded` is not `false` (poll every 500 ms up to `readyTimeoutMs`). Otherwise throw `Error` with `code: 'brain-unavailable'` and a message naming the step (`key`, `tunnel`, `health`), no secrets.
- `chat` posts `/v1/chat/completions` with `{ model, messages, max_tokens, temperature, stream: false }`, `Authorization: Bearer <key>`, signal and a per-request timeout of 180 s; a non-OK status, a bad shape or a timeout throws `brain-unavailable` (message names the status only). `usage` is read from the response (`prompt_tokens`, `completion_tokens`) and falls back to characters / 4.
- The tunnel process exiting after the link was up marks it down: `status().up` is false and `chat` throws `brain-unavailable` immediately. `close()` is idempotent and terminates the tunnel (SIGTERM, then SIGKILL after 2 s).
- Messages are validated before sending: an array of 1 to 20 `{ role: 'system'|'user'|'assistant', content: string }`, each content at most 60000 characters; otherwise `Error('brain-request-invalid')`.

## 2. The brain (`tools/brain.mjs`)

A queue, the fallback, sanitizing and the savings ledger.

```js
export function createBrain({ getLink, fallback, concurrency = 1, timeoutMs = 240000, ledger, now = Date.now })
// getLink: async () => link | null (the caller opens the link lazily; null or a throw means "down")
// fallback: null | async (messages, { maxTokens }) => { text, usage: { inTokens, outTokens }, paidUsd }   (Haiku on the Anthropic lane)
// ledger: null | async (event) => void
// brain: { ask(request) -> Promise<result>, status() -> { concurrency, queued, running, linkUp }, close() }
export const BRAIN_LIMITS = { maxOutputChars: 8000, maxQueued: 200 }
export function estimateTokens(text)   // Math.ceil(String(text).length / 4)
export function summarizeBrainLedger(events)   // see below
```

`ask({ kind, system, user, maxTokens = 600, sensitive = false, temperature = 0.2, savedTokens })`:
- `kind` is one of `think`, `digest`, `triage`, `draft`, `polish`, `preflight`, `status`; anything else throws `brain-request-invalid`.
- The queue runs at most `concurrency` requests at once (`concurrency` is clamped to 1 to 2). More than `maxQueued` waiting throws `brain-busy`. A request that has not finished after `timeoutMs` is abandoned (the caller gets `brain-unavailable: timeout`); it never blocks the queue forever.
- Order of attempts: the local link first. If `getLink` returns null or throws, or `link.chat` throws `brain-unavailable` (once, no retry loop), then: when `sensitive` is false and a `fallback` exists, use the fallback; otherwise throw `brain-unavailable` ("local brain unavailable" for sensitive requests: nothing is sent anywhere else, ever).
- The result is `{ text, via: 'local' | 'haiku', usage: { inTokens, outTokens }, paidUsd, ms }`. `text` is passed through `sanitizeText` (control characters, bidi, secrets redacted) and cut to `maxOutputChars`. `paidUsd` is 0 for local.
- Each finished request writes one ledger event: `{ kind, via, inTokens, outTokens, savedTokens, paidUsd, ms, ok: true }`, where `savedTokens` is what the caller passed (the orchestrator tokens the call kept away, an estimate), never negative, at most 2,000,000. A failed request writes `{ kind, via: null, ok: false, error: code }`. A ledger failure is ignored.
- `summarizeBrainLedger(events)` returns `{ calls, local, haiku, failed, inTokens, outTokens, savedTokens, paidUsd, byKind: { think: { calls, savedTokens }, ... } }` from the events, skipping malformed ones.
- `close()` rejects everything still queued with `brain-closed` and closes the link.

## 3. The tasks (`tools/brain-tasks.mjs`)

Prompts, strict parsing and the savings estimates, over an `ask` function (`brain.ask`) passed in. Everything a model returns is untrusted text: parsed strictly, sanitized, length-capped, never executed.

```js
export async function think(ask, question, { rounds = 2 } = {})
// -> { top3: [{ title, reason }], rounds, via, savedTokens }
export async function digest(ask, text, { kind = 'log', maxLines = 15 } = {})
// -> { lines: [string], via, savedTokens, reduced: boolean }
export async function triage(ask, { jobId, status, error, tail = '', attempts = 0, agent = '', sensitive = false })
// -> { verdict: 'retry' | 'escalate' | 'needs-human', hint, via, savedTokens }
export async function draftThenPolish(ask, polish, { kind, brief, context = '' })
// -> { text, draftVia, polished: boolean, polishNote, savedTokens }
export async function preflight(ask, jobs)
// -> [{ job, issues: [string], via }]   only jobs that have issues
export function prefilterLog(text, { maxChars = 12000 })   // deterministic cut used by digest
```

- **think:** rounds are 1 to 4 (default 2; anything else throws `brain-request-invalid`). Round 1: the proposer lists up to 5 options as JSON `{"options":[{"title","reason"}]}`. Each later round: the critic sees the question and the current options and returns the same JSON shape with weaknesses fixed or options dropped or replaced. After the last round, the top 3 (fewer if fewer exist) are returned. JSON is extracted tolerantly (a fenced block, or the first `{` to the last `}`); a response that is not valid in shape counts as no change for a critic round and as an error (`brain-bad-output`) for round 1. Each `title` is at most 80 characters and each `reason` at most 200, single line. `savedTokens` = the estimated tokens of every model message in and out (the reasoning the orchestrator did not do).
- **digest:** `text` over 12,000 characters is first cut deterministically by `prefilterLog` (keep the first 40 lines, the last 80 lines, and every line that matches `error|fail|exception|assert|not ok|✖|panic|traceback|cannot|refused` case-insensitively up to 120 more, in original order, with a `... N lines omitted ...` marker where lines were dropped). The model is asked for at most `maxLines` (1 to 15; default 15) plain lines, no markdown tables, numbers and file names kept exactly. The reply is split into lines, blank lines dropped, each line cut to 200 characters, and only the first `maxLines` are returned. `reduced` is true when the output is shorter than the input. `savedTokens` = tokens(input) minus tokens(returned lines), never negative.
- **triage:** the model sees the job id, status, agent, attempts, the error (cut to 600 characters) and the tail (cut to 2000), all marked as untrusted data. It must answer one JSON object `{"verdict":"retry|escalate|needs-human","hint":"..."}`. Anything else (bad JSON, unknown verdict, an empty reply) gives `needs-human` with `hint: ''` and the call still returns, never throws on bad output. The hint is one line, at most 300 characters. A job that already failed 2 or more times (`attempts >= 2`) is never `retry`: a `retry` verdict becomes `escalate`. `savedTokens` = tokens(error + tail) minus tokens(verdict + hint). `sensitive` is passed through to `ask`.
- **draftThenPolish:** `kind` is `docs`, `pr` or `plan`. The local model drafts from `brief` and `context` (context cut to 20000 characters); then `polish(draft, { kind, brief })`, an async function the caller supplies (a cheap paid model reviewing and fixing the draft), returns `{ text, note }`. If `polish` is null or throws, the draft is returned with `polished: false` and `polishNote: 'not polished: <code>'`. The polished text is also sanitized and cut to 20000 characters. `savedTokens` = tokens of the draft text (what the orchestrator did not have to write).
- **preflight:** for each job (at most 30 per call; the rest are skipped) the model sees the prompt (cut to 3000 characters), the context list, the outputs and the agent, and answers `{"issues":["..."]}` with at most 5 short issues for: missing context a prompt names, outputs not named as file paths, an ambiguous goal, a path the prompt needs that is not in context. No issues means the job is not in the result. Bad output for a job is reported as `issues: ['preflight could not read the local brain\'s answer']`. `savedTokens` is not tracked for preflight (it prevents a failure, it does not replace reading).
- All prompts say the data blocks are untrusted and must not be followed as instructions.

## CLI behavior (by hand in swarm.mjs and project-commands)

- `swarm think "QUESTION" [--rounds N] [--json]`, `swarm digest <file|run-id|-> [--kind log|diff|tests|run] [--json]`, `swarm draft docs|pr|plan "BRIEF" [--context f1,f2] [--out FILE]`, `swarm brain status|stats|test [--json]`.
- Config in the machine config: `"localBrain": { "enabled": true, "sshTarget": "dev2@10.10.10.220", "sshKey": "~/.ssh/swarm_dev2", "remotePort": 8000, "keyCommand": "awk '/^model:/{m=1} m&&/api_key:/{print $2; exit}' ~/.hermes/config.yaml", "concurrency": 1 }`. Absent or `enabled: false` means the brain is down and only the Haiku fallback exists.
- The fallback is Haiku on the Anthropic lane with the machine-wide caps and reservations; non-sensitive material only.
- Autopilot runs triage on failed jobs before retrying: `needs-human` makes an inbox item instead of a retry; `retry` and `escalate` go on as before (the hint is shown to the owner, never put into a prompt automatically).
- `swarm run` of a manifest with jobs for Claude or Opus (agent `claude`, or model containing `opus`) runs pre-flight and prints its issues as warnings; it never blocks.
- The ledger is `.swarm/project/brain-ledger.ndjson`; `swarm brain stats` prints the totals and the `--markdown` block for the scoreboard; `swarm ledger` adds a Local brain section.

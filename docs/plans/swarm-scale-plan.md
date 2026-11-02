# Project Swarm — Scale Upgrade Plan

Goal: one command takes any task (a big app build down to a single test or review) and runs it across hundreds of concurrent workers, safely, cheaply, with one short report at the end.

Repo: `RDW-Labz/project-swarm` (current: 1.51.1, max 32 concurrent, max 256 jobs, single orchestrator, workers can't dispatch).

## Ground rules for the builder (Claude Code)

- Claude Code is orchestrator only. Route hands-on work cheapest-first: Hermes (dev2) → Cursor CLI → Codex CLI → OpenRouter (cheap models, $5/day cap, never sensitive code) → Claude workers only for high-risk work or after 2 failures elsewhere.
- Never send secrets, `.env`, keys, or vault contents to any worker.
- One PR per phase. Each PR: tests (`node --test`), CHANGELOG entry, version bump, docs + SKILL.md updated. Braden merges; never merge yourself.
- Keep the runner dependency-free Node (current rule). Keep all existing safety: one writer per file, explicit file lists, hash-checked integration, no `.git`/`.env`/symlinks.
- Dogfood: once Phase 1 lands, use the swarm itself to build later phases.
- Log every worker call to `docs/state/usage-ledger.md` (date, task, worker, model, pass/fail, rough cost) with a daily per-tier summary.

## Reality check (put this in the docs too)

"Hundreds at once" mostly comes from API workers, Hermes and remote machines. Subscription CLIs (Claude, Codex, Cursor) get rate-limited long before 100 parallel sessions, so each one gets its own lane cap. The global cap is capacity, not a target.

---

## Phase 0 — Cursor CLI worker

The `cursor` worker type is missing (`AGENTS` has claude, codex, hermes, qwen + API agents; the Cursor lane is only a manual guard).

- Add `cursor` to the CLI adapters (`cursor-agent`, explicit `model` required, same copied-workspace + envelope rules as codex).
- Fold the existing `cursor_lane_guard.py` claims into the normal job ownership check.
- Done when: a smoke manifest with a `cursor` job runs, integrates, and passes tests with a stubbed CLI.

## Phase 1 — Lanes + router

- Per-agent lanes, each with its own `concurrency`, requests/min, and backoff. Example defaults: hermes 3, cursor 8, codex 6, claude 4, openrouter 64, other API agents 32.
- On 429 / quota errors: exponential backoff with jitter; on "quota exhausted", pause that lane and keep the others running.
- Router: a job may set `agent: "auto"` → picks by job type + sensitivity + lane health, following the cheapest-first order. `sensitive: true` jobs never go to OpenRouter.
- Fallback: after 2 failures on one tier, retry one tier up.
- Raise the global cap to 512 and allow up to 5,000 queued jobs (a streaming queue; don't hold every job's context in memory).
- Lane config lives in the machine-wide swarm config, overridable per manifest.
- Done when: a stub-adapter test runs 500 jobs with lane caps respected, simulated 429s recovered, and one lane paused without stalling the rest.

## Phase 2 — Job types (presets)

Add `type` to jobs. Each preset sets the default lane, tools (read-only or write), timeout, output shape, and which vendored skill to load.

| type | writes files? | default route | notes |
|---|---|---|---|
| `build` | yes | cursor → codex | feature/app code + its tests |
| `fix` | yes | cursor → codex | uses `diagnosing-bugs` skill |
| `test` | yes (tests only) | codex → cursor | uses `tdd` skill |
| `review` | no | hermes → codex | uses `code-review` skill; returns findings JSON |
| `research` | no | hermes → openrouter | wraps existing `scout`/`sweep` |
| `docs` | yes (docs only) | hermes | |
| `merge` | yes | codex → claude | uses `resolving-merge-conflicts` skill (Phase 3) |
| `lead` | no (manifest only) | claude/codex | Phase 5 |

- Done when: each type has an example manifest in `examples/` and a validation test.

## Phase 3 — Merge queue

Today one conflict blocks the whole integration.

- `integrate --queue`: finished jobs merge continuously in small batches as they finish.
- Run the manifest `checks` per batch; if a batch fails, bisect to find the bad job.
- A conflicting or failing job gets requeued against the new project content (max 2 tries), then becomes a `merge` job, then gets flagged to the orchestrator.
- Keep the "never overwrite newer content" rule.
- Done when: a test with 200 jobs and 10 forced conflicts integrates the other 190 and requeues the 10.

## Phase 4 — Short reports

- Every worker must return: `status`, `summary` (≤ 500 chars), `files`, `risks`, `followups`. Reject anything else.
- New command `swarm rollup <run-id>`: one page grouped by status and risk. Leads (Phase 5) roll up their own children.
- `monitor --view` shows lanes, queue depth, merge-queue state, and spend.
- Done when: the orchestrator can read a 300-job run in one short report.

## Phase 5 — Lead agents (hierarchy)

- A `lead` job gets an area (a file scope + goal) and outputs a child manifest only.
- The runner validates it: every child output is inside the lead's scope, caps and budget are respected, and there are no file overlaps with siblings. Then it launches the child run.
- Max depth 2 (orchestrator → leads → workers). Workers still can't dispatch.
- The orchestrator only reads lead rollups.
- Done when: one goal ("build app X") → 5 leads → 100+ workers runs end-to-end with stub adapters.

## Phase 6 — Spend guard

- Per-run caps on USD and tokens, plus per-lane daily caps (OpenRouter $5/day). Stop launching new work at the cap; let in-flight jobs finish.
- Ask before any spend over a cap (no auto-raise).
- On quota exhaustion: pause, run the zero-quota idle menu (no model calls, `idle/` branches only), resume when the window resets.
- Write the usage ledger automatically.
- Done when: tests prove caps stop launches, and resume picks up exactly where the run left off.

## Phase 7 — Remote runners

- Executor interface: `local`, `ssh` (e.g. dev2 at 10.10.10.220), and `sandbox` (cloud).
- Ship the copied workspace to the executor, run the worker there, pull back only the declared outputs, then hash-check as today.
- Per-host capacity plus heartbeat; a dead host's jobs get requeued.
- Never copy secrets to remote hosts.
- Done when: a mixed run spreads jobs across local + ssh with a host killed mid-run and still finishes.

## Phase 8 — One-command drop-in

- `swarm init` in any project: link to the shared install, detect the stack, pull `checks` from `package.json`/CI, add `.swarm/` to `.gitignore` and lint/test ignores, write agent pointers (CLAUDE.md / AGENTS.md / cursor rule), and seed `coordination/`.
- `swarm go "<goal>"`: one entry point that plans → leads → workers → merge queue → rollup.
- Done when: a fresh repo goes from zero to a finished `swarm go` run in one command plus provider logins.

## Phase 9 — Scale test

- Stub adapter: 500 concurrent jobs with no model spend. Record peak RAM/CPU, queue latency, and merge throughput.
- Live test: 50 real jobs across all lanes on a throwaway repo. Record cost per tier.
- Publish the numbers in `docs/field-report.md`.

---

## Suggested order

0 → 1 → 2 → 4 → 3 → 6 → 5 → 7 → 8 → 9

(Lanes and reports first make every later phase cheaper and easier to check. Leads come after the merge queue and spend guard so big runs can't blow up the repo or the budget.)

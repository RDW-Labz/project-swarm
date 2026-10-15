# Project Swarm — Plan v2: Thousands of Workers, Better Drop-in, Better CLI

Starting point: v1.62.0. Lanes, job types, short reports, merge queue, spend guard, lead agents, remote hosts, `swarm init` / `swarm go` all shipped. 500 stub jobs ran at about 131 MB of memory. 50 real jobs ran across 6 lanes for $0.34.

Goal: one command takes any goal and runs it across up to thousands of workers, as fast and cheap as possible, without dropping quality.

## Ground rules (same as v1)

- Claude Code orchestrates only. Route cheapest-first, from the lane benchmark: Anthropic API (Haiku) → Cursor → Codex → Claude subscription (after two failures). Hermes runs only research/summary jobs. OpenRouter runs only non-sensitive bookkeeping jobs.
- No secrets to workers. Sensitive jobs never go to OpenRouter, OpenAI, Gemini, Lambda, or untrusted sandboxes.
- One PR per phase. Tests, CHANGELOG, and a version bump go in the same PR. Never merge without Braden's explicit OK.
- Ask before any cap raise or new paid service.
- Dogfood: use the swarm to build these phases.

## Reality check (put this in the docs)

- Thousands of workers at once only happens on **API lanes** (Anthropic Haiku/Sonnet, OpenRouter) and **extra hosts**. Subscription CLIs (Claude, Codex, Cursor) stay capped low per lane, or the accounts get throttled.
- The real ceiling is each provider's rate limit for your account tier. The swarm must find it and stay under it automatically.
- More workers only helps if the goal splits into that many independent pieces. The planner matters as much as the scheduler.

---

## Phase 10 — Real `swarm` command (replace the alias)

The alias only works in your interactive shell. Claude Code, Cursor agents, and scripts run commands in non-interactive shells that don't load aliases, so agents can't call `swarm`.

- Ship a real executable: `swarm` in `~/.local/bin`, symlinked to the `current` runner. `install`/`update` creates it, and `doctor` checks that it's on PATH. Remove the alias.
- Shell completion for zsh (commands, run ids, flags).
- `swarm` with no args: a short status for this project (initialized? last run? lanes up? today's spend), plus the 5 most useful next commands.
- `swarm "goal"` works as shorthand for `swarm go "goal"`.
- `swarm go` auto-runs `init` the first time in a project.
- Done when: a non-interactive `bash -c 'swarm doctor all'` works, and Claude Code can run `swarm` with no setup.

## Phase 10b — Orchestrator failover

**Goal:** any capable agent can take over mid-project in under a minute, with no lost work, and most routine orchestration doesn't need a frontier model at all.

### 1. The runner keeps the state, not the model's memory

- Add a **project journal** at `.swarm/project/journal.ndjson`: an append-only log of every goal, plan, decision, run, integration, PR, blocker and human task. The runner writes it automatically on every command. No model has to remember to write it.
- Add **`swarm brief`**: prints a compact briefing (under 4 KB) from the journal plus live run state:
  - the goal and done-when;
  - what's done (merged PRs, integrated runs);
  - what's running right now (run ids, waves, ETA) — runs keep going without the orchestrator;
  - open decisions and the human inbox (Phase 10c);
  - the exact **next 3 actions**, as commands;
  - the rules that apply (routing order, budget, no merging without OK).
- `coordination/HANDOFF.md` is regenerated from the journal after every command (keep the file for compatibility; it is no longer hand-written).
- `swarm note "<text>"` lets any orchestrator add a decision or context line to the journal in one command.

### 2. Make any agent pick up the seat

- The agent pointers (CLAUDE.md, AGENTS.md, Cursor rule, a Gemini file) all say: **"At session start, run `swarm brief` and continue from its next actions."**
- `swarm handoff --to codex|cursor|claude|gemini` prints one paste-ready message for that agent: the brief plus a short "you are the orchestrator, here are the rules" header.
- Add a **Claude Code hook** (installed by `swarm init`): after each turn, run `swarm checkpoint`. This is cheap and needs no model; it just snapshots the journal. That way the state is current even if the next turn gets rate-limited.

### 3. Autopilot: routine orchestration without a model

- **`swarm autopilot`**: a long-running, no-model process that drives the plan: start the next wave when its dependencies integrate, run the merge queue, retry and escalate failed jobs, pause and resume at caps and quota resets, open PRs, and update the journal.
- It only calls a model for real decisions: planning a new lead, reviewing a failed job twice, or the final gate. Those calls go through the lanes with fallback (orchestrator tier: Claude subscription → Codex top model → Anthropic API Sonnet), so one provider's limit never stops the project.
- When the human orchestrator (you plus Claude Code) is rate-limited, autopilot keeps building. You come back to progress, not a stalled terminal.
- It never merges to main, deploys, raises a cap, or spends past budget. Those wait in the inbox.

### Done when

- Kill the Claude Code session mid-project. Start Codex CLI, run `swarm brief`, and it continues correctly with zero re-explaining. Test this on a real project.
- A 500-job `swarm go` reaches its final gate with no orchestrator session open (autopilot only), with the inbox holding anything that needs Braden.

---

## Phase 10c — Never wait on a human (inbox and unblocked work)

**Goal:** everything that can be built gets built while manual steps are pending. Braden handles manual steps in one batch, whenever he's ready.

### 1. Human tasks are jobs too

- The planner marks anything that needs Braden as a `type: "human"` job: logins, API keys, approvals, design choices, account setup, deploys, merges. Each one says exactly what to do (copy-paste steps) and **which jobs it blocks**.
- The scheduler runs **every job that isn't blocked**, across all leads and waves, instead of working down the list. Only the jobs that truly depend on a human task wait.

### 2. Build around the gap

- When work depends on something missing (a key, an account, a decision), the planner adds a **stub path**: build against an interface plus a mock or fake (for example a fake payment provider, seed data, or a feature flag that's off), with tests on the mock. The real hookup becomes a small follow-up job that unlocks when the human task is done.
- Design choices: if there's a sensible default, the swarm **picks it, builds it, and records it** as "decision to confirm" in the inbox, instead of stopping. Braden confirms or changes it later, and a change becomes a normal follow-up job.
- Never stub anything security- or money-sensitive into the real path (auth, payments, secrets). Those stay behind a flag and clearly marked "not wired."

### 3. One inbox

- **`swarm inbox`**: everything waiting on Braden across all projects, sorted by **how much work it unblocks**. Each item has the steps and one command to mark it done (`swarm done <item>` or `swarm decide <item> <choice>`).
- Swarm Watch gets a **"Needs you"** panel at the top showing the same list.
- Optional notifications: a macOS notification when a new item would unblock 20+ jobs, and a daily digest. No spam: group items, and never notify for one that unblocks nothing.
- When an item is marked done, the jobs it blocked start automatically (autopilot).

### 4. Keep the pipeline full

- **`swarm backlog`**: queue several goals or projects. When one run is waiting on the inbox or a quota reset, autopilot starts unblocked work from the next goal (inside budget and lane limits, never in overlapping files).
- Matches the standing rule: never sit idle. During a quota wait, autopilot runs the zero-quota idle menu.

### Done when

- On a real app build with 3 manual steps (one key, one login, one design choice), all non-dependent work finishes before Braden touches the inbox, and finishing the 3 items unlocks the rest automatically.
- `swarm inbox` never shows an item without exact steps and the number of jobs it unblocks.

---

---

## Phase 11 — Plan preview and approval

- `swarm plan "goal"`: a dry run. Shows leads, scopes, job count, lanes, and **estimated cost, time, and peak concurrency**, plus anything risky (sensitive files, big deletes). Nothing runs.
- `swarm go` shows the same preview and asks `Run? [y/N]` (`--yes` skips it). Unattended runs need `--yes` plus a budget.
- Saved plans: `swarm go --plan <id>` runs exactly what was previewed.
- After each run, compare the estimates with the actuals and use the difference to improve future estimates.
- Done when: the preview is within 2× of the real cost and time on the scale-test runs.

## Phase 12 — Better drop-in (`swarm init` v2)

- **Project profile** in `.project-swarm.json`: stack, checks, default `sensitive` (asks once, e.g. BinGo = sensitive), protected paths (never written), and default budget.
- **Base check:** run the project's checks once at init. If they're already red, say so and record it, so workers aren't blamed for old failures.
- **Repo map:** build and cache a map of the repo (file tree, exports/symbols, import graph, test-to-source links). Refresh it incrementally on each run. Planners and leads read the map instead of re-reading the repo.
- Write agent pointers (CLAUDE.md / AGENTS.md / Cursor rule) that tell any agent how to use `swarm` in this project.
- `swarm init --check`: a read-only health check of the setup.
- Done when: a fresh clone of a real project goes from `swarm init` to a green `swarm plan` with no hand edits.

## Phase 13 — Planner quality (split work well)

- The planner uses the repo map and import graph to split work along real boundaries, keeping tightly coupled files in one job.
- **Waves:** shared interfaces and contracts come first (wave 1), implementations in parallel next (wave 2), then integration and tests (wave 3). This is built on the existing `after` support.
- **Job sizing:** target a size per job type, splitting jobs that are too big and merging ones that are too small, so thousands of jobs don't mean thousands of tiny, wasteful calls.
- Contracts are auto-attached to every job that needs them, and a job that mentions a contract it doesn't include is refused (the Phase 0 lesson).
- Done when: on 3 real repos, plans have zero file-ownership conflicts and fewer than 5% of jobs blocked on missing context.

## Phase 14 — Throughput to thousands

- **State store:** move run state from rewriting `state.json` on every change to an append-only event log (or SQLite), with snapshots for `inspect`, `monitor` and `rollup`. A full rewrite doesn't scale to thousands of jobs.
- **Cheap workspaces:** use copy-on-write clones (APFS `clonefile` on macOS, reflink or hardlinks on Linux) instead of byte copies. Clean them up as soon as a job integrates.
- **API jobs without processes:** API-lane jobs run as in-process async requests, not one child process each. That's what makes thousands in flight feasible on one Mac.
- **Adaptive concurrency:** each lane finds its own limit by ramping up until it hits 429s, then backing off, honoring `retry-after` and the provider's rate-limit headers. Shared machine-wide, as today.
- **Prompt caching:** shared context (repo map, contracts, style guides) goes in a cached prefix for Anthropic, cutting the cost of large fan-outs.
- **Batch mode:** `--batch` sends jobs that don't need to finish fast to the Anthropic Message Batches API at a lower price. Good for big review or doc sweeps.
- **More hosts:** dev2, once reachable, plus optional trusted cloud sandboxes with auto-scaling.
- Done when: 2,000 stub jobs and 1,000 concurrent fake-API requests on one Mac stay under 1 GB of memory, with no state-write slowdown.

## Phase 14b — Local brain

Use dev2's model (the Strata API, reached the way `dev2chat` does: an ssh tunnel with the swarm key) as a free helper that cuts orchestrator and paid-model use. **Runner-side only: workers never call it and never see its address, key or tunnel.** Built right after Phase 14.

- **`swarm think "question" [--rounds N]`:** a proposer/critic loop on the local model (default 2 rounds, at most 4). Returns a short top-3 with a reason for each, so the orchestrator reads 10 lines instead of reasoning through the options itself.
- **`swarm digest <file|run-id|diff>`:** condenses long logs, diffs, test output or a run's results to 15 lines or fewer for the orchestrator. Accepts a file path, a run id (its failures and results) or `-` / `git diff` text on stdin.
- **Failure triage:** when a job fails, the local model first classifies it `retry`, `escalate` or `needs-human` and writes the retry hint. The orchestrator (and autopilot) see only the verdict, the hint and the evidence pointer. `needs-human` becomes an inbox item (Phase 10c); `escalate` moves the job up the route (Claude after two failures stays the rule).
- **Draft then polish:** docs, PR text and plans are drafted by the local model; a cheap paid model (Haiku) reviews and fixes the draft instead of writing from nothing.
- **Pre-flight before Claude or Opus:** before any job is routed to Claude or Opus, the local model checks the prompt, the context list and the outputs for the usual mistakes (missing context, unnamed output files, ambiguous goal, a file the job needs that is not in context) and returns fixes. A failed pre-flight is a warning with the fixes; it never blocks on its own.

**Rules**
- A **local-brain queue** with concurrency 1 to 2 (one model server shared with other people's work). Requests time out; nothing waits on it forever.
- Everything it returns is **untrusted worker text**: sanitized (control characters, bidi, secrets redacted), length-capped, never executed, never pasted into prompts as instructions, and never allowed to approve, merge, raise a cap or change routing by itself.
- **Sensitive data:** the local model is on the owner's own machine, so sensitive material may go to it; it is the one remote helper allowed for sensitive jobs. Secret paths and protected paths are still never sent (the same rules as remote hosts).
- **If dev2 is down** (tunnel, server, or no answer in time), the same request falls back to Haiku on the Anthropic lane (machine-wide caps apply, non-sensitive material only; a sensitive request just reports "local brain unavailable" and does nothing).
- The tunnel and the API key are read the way `dev2chat` does and kept in memory only.
- **Saving is measured:** every call records the tokens it kept away from the orchestrator (the input it digested or the reasoning it replaced, estimated) and the paid tokens it used, in the usage ledger, and the dogfood scoreboard gets an "orchestrator tokens saved" column.
- Done when: on the Phase 17 scale test, triage and digest keep orchestrator reads of failures under 20 lines per failed job, and the scoreboard shows a measured drop in orchestrator tokens for the same work.

## Phase 15 — Quality at scale

- **Verify every write:** each write job is followed by checks (tests or lint on the files it touched), then a cheap review job. Failures go back to the worker once with the reviewer's notes.
- **Escalation ladder:** if a cheap lane fails checks, retry once on the next tier up (Haiku → Sonnet → Codex/Cursor → Claude). Record which lane passes which job type.
- **Learned routing:** use the pass/fail and cost history per (job type × lane × model) to pick the cheapest lane that usually passes. Start from the current fixed order and adjust slowly.
- **Best-of-N** for risky jobs (`quality: "high"`): run 2–3 cheap attempts, keep the one that passes checks and review.
- **Final gate:** before a `swarm/go` branch is marked done, run the full test suite plus one high-tier review of the whole diff (Claude subscription).
- Done when: on the scale-test repos, the final branch passes the full test suite with zero human fixes on at least 90% of runs.

## Phase 16 — Swarm Watch (replaced by the spec)

The full spec is [swarm-watch-spec.md](swarm-watch-spec.md) and the reference design is [the prototype](../design/swarm-watch-prototype.html). Build it with real run data from the Phase 14 event log, to match the prototype.

- `swarm watch` opens a local, read-only web dashboard for the newest live run (`<run-id>`, `--all` and `--tui` are in the spec). `swarm go` and `swarm "goal"` print the watch URL, and `--watch` opens it.
- The server binds to 127.0.0.1 only, uses a random port and token, streams deltas over Server-Sent Events, and has no write routes.
- Done when: you can follow a real 1,000+ job `swarm go` run from start to the final gate without reading logs, on desktop or phone.

---

## Phase 17 — Scale test v2

- 2,000 stub jobs: record memory, CPU, queue latency, state-write time, and merge throughput.
- 200 real jobs on a throwaway repo across all lanes (Hermes included if dev2 is reachable), with a $10 cap. Record cost and pass rate per tier.
- One real `swarm go` on a medium project. Record plan accuracy, the conflict rate, and how many fixes it needed after the run.
- **Lane benchmark** (a small one ran at 1.63.0; see `docs/state/lane-benchmark.md`): 10 real tasks from this repo, 2 each of small bug fix, new function plus test, refactor, test-writing and docs, run on every lane including Hermes on dev2. Each result is scored by real tests (hidden tests, mutants and fact checks the worker never sees) plus a review. Record pass rate, cost, time and quality per lane and per kind. Rerun it whenever a lane, model or the router changes, and use the results to set the default route per job type (`tools/job-types.mjs`). The harness is `bench/lane-benchmark/`.
- Publish the numbers in `docs/field-report.md`.

---

## Suggested order

10 → 10b → 10c → 11 → 12 → 14 → 14b → 13 → 15 → 16 (use swarm-watch-spec.md) → 17

(The CLI comes first. Failover and the inbox (10b, 10c) come next because they fix the biggest day-to-day stalls; see the addendum. The plan preview follows because it makes every later run safer and easier to use. Throughput comes before the planner and quality work, so those can be tested at real scale.)

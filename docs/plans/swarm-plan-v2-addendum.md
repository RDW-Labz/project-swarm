# Plan v2 Addendum — Never Stall

Two new phases for `docs/plans/swarm-scale-plan-v2.md`. Build them right after Phase 10 (the real `swarm` command), before the rest: they fix the biggest day-to-day slowdowns.

## The two problems

1. **The orchestrator hits its rate limit.** Work stops. Switching to another model (Codex, another frontier model) means it has to rediscover where things were. `coordination/HANDOFF.md` exists, but the model fills it in by hand, so it's stale exactly when the limit hits.
2. **Work goes one step at a time and waits on Braden.** A manual step (a login, key, approval, design choice or deploy) blocks the whole list, even though dozens of other tasks could already be built.

---

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

## Updated order

10 → **10b → 10c** → 11 → 12 → 14 → 13 → 15 → 16 (Swarm Watch) → 17

# Phase 19: swarm managers

Status: plan only. Nothing is built, nothing is spent. The owner approves the order and the caps below before any code.

The parts-app S13 run was kept alive by an orchestrator doing, by hand, what a person at a build site does: checking tickets before the run, finding blocked ones, fixing context, watching the budget, keeping the install in step, keeping main green. This phase turns each of those jobs into a **manager**: a small piece of code that watches one thing, says what it found, and (only where the owner has allowed it) acts.

## How every manager works

1. **Deterministic first.** Each manager is plain code over files the swarm already writes (the ticket ledger, run states, the journal, the lane store, the spend ledger, the install). A model is used only to *diagnose* something code cannot read, and never to decide an action that spends money or changes the plan.
2. **Three modes, per action, set by the owner:**
   - `off`: the manager does not run.
   - `shadow` (the default for everything new): it writes what it *would* do ("would add tests/a.test.ts to T-0277's context") to the journal and the board. Nothing changes.
   - `auto`: it does the action. An action becomes `auto` only after the owner says so for that one action, and only after its scorecard (below) is clean.
3. **Safe vs needs-you.** Each manager lists its actions in two groups. Safe actions are reversible, inside the ticket's own scope and free or nearly free (add context, reset a stale `running`, re-route a lane, split a ticket). Needs-you actions go to Needs you (board and phone inbox) with a one-line recommendation: acceptance text changes, any cap or budget change, migrations, RLS, auth, deleting anything, merging.
4. **Everything is on the record.** Every finding and every action is one journal line (manager, action, ticket or lane, reason, mode, cost) and one row on the board. A manager that acted can be undone from its journal line.
5. **Own lane on the board.** Each manager is a lane in Swarm Watch with its latest findings, its actions, its mode per action and its cost (a deterministic manager shows $0.00).
6. **A hard cap each.** A manager that uses a model has its own daily dollar cap inside the machine cap; hitting it turns the manager to shadow for the day and says so. No manager can raise a cap.
7. **Never the build.** Managers do not write app code. A manager that wants a ticket changed edits the ticket (through the same commands the owner has) or writes a new one.

## The testing approach (the same for all eight)

**Replay harness.** `swarm managers replay LEDGER_DIR MANAGER` loads a recorded project (ledger, run states, journal, lane store snapshot, spend ledger) into a throwaway folder, runs the manager over it step by step in the order things happened, and records what the manager said and did at each step. The recordings come from the real runs we already have: S11, S12 and S13 of the parts app (copied as *data* into `evals/managers/`, scrubbed of secrets and customer data, per the repo rule that only small fixtures live here), plus the swarm-practice repo.

**Seeded failures.** Each manager also gets a small set of invented but realistic failure fixtures written to break exactly its job (a ticket that lists a test file a later ticket owns, a lane that starts returning 429, a pointer two versions behind, a flaky test, a cap about to be passed by a wave).

**Scorecard** (one per manager per replay, written to `docs/state/manager-scorecards/` and shown on the board):

| Measure | What it is |
|---|---|
| caught | seeded or known failures found / total |
| time-to-fix | steps (or minutes in a live shadow run) from the failure appearing to the right fix being proposed or applied |
| wrong actions | actions that would have made things worse or that the owner marks wrong; must be 0 before `auto` |
| missed | failures the manager never raised |
| cost | model dollars spent, against the manager's cap |

**Gate to `auto`:** a manager action may be switched to `auto` only when, over the replays *and* at least one live shadow run, caught is 100% of the seeded set, wrong actions is 0, and the owner says so for that action. One action at a time.

**Live shadow.** After replay, the manager runs in shadow on the next real run (S13 and after). The owner reads its journal lines next to what actually happened.

## The eight managers, in build order

The owner's order: Budget, Lane health and Version first. The rest follow in the order that unblocks most tickets.

### 1. Budget manager
Forecasts the finish cost of the current wave and stage from tickets left, the cost per ticket by lane (real history, `tools/estimates.mjs`) and escalation rates. Warns when the forecast or the actual spend nears a cap, and **stops Opus loops** (the same ticket or review asked again and again at Opus price).
- Safe actions: warn on the board and in Needs you; hold a *review re-ask* that would pass its per-ticket Opus limit; lower the wave size so the hard cap is not reached.
- Needs you: any cap or budget change; letting an Opus loop go on.
- Seeded failures: a wave whose worst case passes the project cap; an Opus review asked 4 times for one ticket; a forecast far under the real spend (estimates.mjs bug class).
- Replay: S11 and S12 (each finished about $6 over its cap before the hard-cap fix) must be caught before the cap is reached.
- Model use: none. Cost $0.

### 2. Lane health manager
Before each wave, checks every lane the router could pick: binary present, login valid, a one-token smoke call where that is free, quota and pause state, last error. During a run it watches 429s and failures per lane.
- Safe actions: pause a lane that fails its check, re-route its tickets to the next cheapest healthy lane, un-pause when the check passes again, shrink a lane's concurrency on 429s (adaptive concurrency exists; this manager decides *when* and records why).
- Needs you: nothing that spends; a lane that is down for more than an hour goes to Needs you with the fix (login, quota, update).
- Seeded failures: Codex sandbox cannot start; Cursor key missing; Haiku 429 storm; claude lane with no model (the S13 start).
- Replay: S13 (Codex and Cursor never ran) must be caught before wave 1, with the reason.
- Model use: none; the one-token smoke calls are on flat-rate lanes (free) or Haiku (under $0.001 each, daily cap $0.05).

### 3. Version manager
Keeps the install, the project pointers, the running board and `swarm remote` in step. Refuses and explains updates while a run is live (the update guard is in 1.139.0), bumps pointers after an update (1.142.0), and says when a running board or remote is older than the install.
- Safe actions: bump a stale pointer's version field (backup first), show the stale-server banner, schedule "update when idle" and run it the moment no run is live **only when the owner has set it to auto**.
- Needs you: any update while a run is live (`--force` is always the owner's).
- Seeded failures: pointer two versions behind; remote on an old snapshot; update requested mid-run; a pointer file with a broken profile.
- Replay: the parts-app 1.137.0-versus-1.140.0 lag; the 404 Watch link from an old remote board.
- Model use: none. Cost $0.

### 4. Ticket Manager (runs at scope time, blocks the run until clean)
Checks the ticket set before the first wave: every ticket has its context (files under change, tests, configs, schema and existing migrations for DB tickets: the context builder already does most of this); every file is owned by exactly one ticket; no ticket lists a test file a later ticket owns; every acceptance line can be checked by the reviewer (a "no visual change" line goes to an owner checklist instead of the reviewer); shared files (CSS, layout, i18n, types) are split into early tickets; chains behind one ticket are flagged (the `gating-ticket` check, 1.141.0).
- Safe actions: add missing context, normalise names, split a ticket whose shared files gate others, move an uncheckable acceptance line to the owner checklist (the line is kept, not deleted).
- Needs you: changing acceptance text, adding or deleting tickets in an approved scope (one approval, one step: change order flow).
- Seeded failures: the 25 S13 tickets that listed later-owned test files; files with no owner; CamelCase screen names; a 34-ticket chain behind three tickets.
- Replay: the S13 split (before the Ticket Manager existed) must produce the same list of problems the orchestrator fixed by hand.
- Model use: Sonnet only for rewriting an acceptance line into a checkable one, as a *proposal* in Needs you. Cap $0.50 per scope, $2 per day.

### 5. Unblocker (runs after every wave)
Finds blocked, looping or stale tickets and ranks them by how many tickets each gates. Reads the failure reasons and applies safe fixes: add missing context, reset a stale `running`, re-route the lane, split a ticket, clear a retry note that is poisoning the next attempt. Everything else goes to Needs you with a one-line recommendation.
- Critical path: a ticket gating five or more others starts at the mid tier (Sonnet or Codex) instead of failing up from the cheapest lane, and gating tickets are scheduled first in each wave.
- Needs you: acceptance text changes, any cap or budget change, migrations, RLS, auth.
- Seeded failures and replay: the S13 cases **T-0323** (gates 11; retry note read as paths), **T-0277** (missing DB context), **T-0286** (gates 4; escalation planning failure), **T-0311** (missing DB context). Each must be diagnosed from the ledger and journal alone, with the fix the orchestrator applied by hand.
- Model use: a cheap model reads the failure text; Sonnet only for a diagnosis the cheap model marks unclear. Cap $0.50 per wave, $3 per day.

### 6. Merge queue manager
Keeps main green: watches the merge queue, conflicts and batch failures; a flaky test becomes a **fix ticket**, and a failing check is **never re-run to get green** (the owner's rule).
- Safe actions: bisect a failing batch (exists), requeue a conflicting job after an automatic rebase, open a fix ticket for a flaky or red test with the failing output.
- Needs you: merging a pull request, changing a required check, accepting a failed check.
- Seeded failures: a flaky test that fails 1 run in 5; two tickets editing the same file; a planted red batch.
- Replay: S12 merge-queue events.
- Model use: none. Cost $0.

### 7. Lessons keeper
Turns failures into rules: a repeated failure becomes a lesson, a routing change or a template change, proposed through the existing lesson files and routing config, never applied silently. Without it the same S13 bug is found again in the next project.
- Safe actions: write a lesson draft; propose a ticket-template or splitter-prompt change as a pull-request-sized diff for the owner.
- Needs you: every change to routing, the splitter prompt or templates (they change future runs).
- Seeded failures: the same missing-context failure on three tickets; the same lane failing the same way twice.
- Replay: lessons already written from S11 to S13 must be reproduced from the raw failures.
- Model use: Sonnet to draft the lesson text. Cap $0.30 per day.

### 8. Visual QA
After a UI ticket, takes screenshots at 375 px and desktop, diffs them against the mockup and the previous run, and runs an accessibility check (axe). Posts the before/after pair on the board.
- Safe actions: take and attach the screenshots and the axe report; open a fix ticket for a new axe violation.
- Needs you: accepting a visual change the diff flags; anything that changes the design system.
- Seeded failures: a layout that overflows at 375 px; a contrast failure; a changed screen no ticket claimed.
- Replay: the parts-app staff request page redesign.
- Model use: a cheap vision model only for "does this match the mockup" when the pixel diff is over a threshold. Cap $0.50 per day.

## Capped cost

Cost splits into **building** the managers (my work, spent as model calls on review and on the live shadow runs) and **running** them afterwards.

| Item | Cap |
|---|---|
| Building: Opus review per manager (one PR each, `$1` cap per review as before) | 8 x $1.00 = **$8.00** |
| Building: replay and seeded-failure runs (deterministic, local) | **$0.00** |
| Live shadow runs with the model-using managers (Ticket Manager, Unblocker, Lessons keeper, Visual QA, Lane health smoke calls) | **$5.00** in total, then they stop |
| Running, per day, all managers together (sum of the per-manager daily caps: Lane health $0.05, Ticket Manager $2, Unblocker $3, Lessons keeper $0.30, Visual QA $0.50) | **at most $5.85 a day**, normally under $0.50; shown on the Cost tab per manager |

**Phase total to build and prove: at most $13.00**, against the existing machine caps. Budget, Lane health, Version and Merge queue managers cost **$0 to run**. No cap is raised by this phase; if a number above is too high the owner says so before the first manager is built.

## Order and what each step delivers

| Step | Manager | Delivers | Shadow first |
|---|---|---|---|
| 0 | Framework | the manager lane on the board, the journal line, the replay harness, the scorecard, the `off / shadow / auto` setting | n/a |
| 1 | Budget | forecast per wave, cap warning, Opus-loop stop | yes |
| 2 | Lane health | pre-run lane checks, pause and re-route | yes |
| 3 | Version | pointers, board and remote in step, no updates mid-run | yes |
| 4 | Ticket Manager | scope-time gate with the S13 problem list | yes |
| 5 | Unblocker (with the critical-path scheduling) | blocker ranking, safe fixes, Needs-you for the rest, the Blockers panel | yes |
| 6 | Merge queue | flaky test to fix ticket, conflict requeue | yes |
| 7 | Lessons keeper | failures to proposed rules | yes |
| 8 | Visual QA | screenshots, diff, axe | yes |

Each step is one pull request with its replay tests, its scorecard and an Opus review, and **waits for the owner's OK before merging**. After each, the manager runs in shadow on the next real run; an action moves to `auto` only with the owner's OK for that action.

## What this plan does not do
- It does not build a general agent framework: eight managers over files that already exist.
- It does not let a manager change a cap, approve a scope, merge a pull request or touch an update during a live run.
- It does not put any app code in this repo: the replay data is recorded ledgers and journals only, scrubbed, small, under `evals/managers/`.

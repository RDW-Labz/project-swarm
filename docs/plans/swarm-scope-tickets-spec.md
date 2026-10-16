# Scope → Tickets → Swarm (Build Plan)

Add to `docs/plans/swarm-scale-plan-v2.md`. It replaces and expands Phase 13 ("Planner quality"), and its dashboard part joins Phase 16 (Swarm Watch).

Goal: Braden drops in a full build scope written with Claude. The swarm breaks it into hundreds or thousands of small tickets without losing anything in the scope, runs them in parallel, and keeps one live Build Plan that everyone (Braden, the orchestrator, leads, workers and the dashboard) checks progress against. Change orders update it.

## 1. The scope is the source of truth

- The scope lives in the project at `docs/scope/scope.md`, plus optional extra files in `docs/scope/`.
- **Scope template** (`swarm scope template` prints it). This is what Braden and Claude fill in:
  - Overview, users, goals, out of scope.
  - **Stages** (S1, S2, …), in build order.
  - **Requirements with IDs** (`R-001`, `R-002`, …) under each stage. One testable sentence each, plus acceptance criteria.
  - Data model, APIs, screens, integrations, non-functional needs (performance, security, accessibility).
  - Sensitive areas (payments, auth, customer data) and protected files.
- `swarm scope check` lints the scope before anything is split: requirements without IDs, untestable wording ("fast", "nice"), duplicate IDs, missing acceptance criteria, unclear stage order. It returns fixes for Braden and Claude to apply.

## 2. Breaking it into tickets

`swarm scope split` turns the scope into a ticket tree:

**Stage → Epic → Ticket**

Each ticket has:
- `id` (`T-0001`), title, type (build, test, docs, migration, design, human…);
- `scopeRefs`: the requirement IDs it delivers. Every ticket must trace back to the scope;
- acceptance criteria (copied or derived from the requirement, never invented);
- owned files or area (one writer per file), plus context files and contracts;
- `dependsOn` (other ticket IDs);
- size (S/M, never L; anything bigger gets split again), risk, and sensitive flag;
- status: `todo / ready / running / review / done / blocked / cancelled`.

How it splits well:
- It uses the repo map (Phase 12) and the import graph to put the work on real boundaries.
- **Contracts first:** shared types, API shapes and database schema become early tickets, so everything after them can run in parallel against a fixed interface.
- Waves come from the dependency graph automatically. The swarm runs **every ticket whose dependencies are done**, which is often hundreds at once.
- Leads (Phase 5) split each stage in parallel. The orchestrator only merges and checks.

## 3. Keeping the scope's integrity (no lost or invented work)

Before tickets run, `swarm scope split` must pass these checks:
- **Coverage:** every requirement ID is covered by at least one ticket. Missing ones are listed.
- **Traceability:** every ticket points to real requirement IDs. Tickets with none are flagged as "not in scope" and need Braden's OK.
- **Acceptance:** every ticket has testable acceptance criteria.
- **Ownership:** no two tickets write the same file in the same wave.
- **Size:** no ticket over the size budget.
- **Review:** a strong-model review of the whole ticket tree against the scope looks for gaps, wrong order and anything dropped. Local brain (Phase 14b) does a first free pass.
- **Approval:** Braden sees a summary (stages, ticket count, coverage %, estimated cost and time, risks) and approves. Nothing runs before that.

While it runs:
- Every worker report names its ticket ID. The review step checks the result against that ticket's acceptance criteria **and** the original requirement text.
- Work outside the ticket's scope is flagged as **drift** and not merged without approval.
- A ticket is only `done` when its checks pass, its review passes and it's merged.

## 4. Change orders

`swarm change "Add refunds to the order history page"`, or edit `scope.md` and run `swarm scope sync`:
- **Impact analysis:** which requirements and tickets are affected, which new tickets are needed, which get cancelled or reopened, and the cost and time change.
- Braden approves, then:
  - the scope gets new or changed requirement IDs (`R-045`, or `R-012 v2`);
  - tickets are added, cancelled or reopened, and dependents are re-planned;
  - everything is logged as a numbered change order (`CO-007`) with date, reason and diff.
- History is never deleted. You can always see what the original scope was and what changed.

## 5. The ticket ledger (one place everyone reads)

- Stored in the project at `.swarm/project/tickets.json` (current state) plus `tickets.log` (append-only history), and committed summaries in `docs/scope/build-plan.md`.
- `swarm tickets` lists them and filters by stage, status, owner, risk or requirement.
- `swarm ticket T-0123` shows the ticket, its scope text, runs, PR and cost.
- `swarm brief` and autopilot read it: the orchestrator always knows what's done, what's next and what's blocked against the scope, not just against runs.
- Optional later: two-way sync with GitHub Issues or Linear.

## 6. Build Plan in Swarm Watch (Phase 16)

A **Build Plan** tab next to the live run view:
- **Header:** scope name and version, overall % done, coverage % (requirements done / total), tickets by status, spend against estimate, and a change-order count.
- **Stage lanes:** each stage as a row with a progress bar. Expand it to see epics, and expand an epic to see tickets as cards with status color, type icon, risk and sensitive pills, and which lane is working on it.
- **Dependency view:** a graph of tickets and what each is waiting on. Blocked chains are highlighted.
- **Requirement view:** each `R-` ID with its tickets and a done/partial/missing state, so you can see at a glance that nothing in the scope was dropped.
- **Change orders:** a timeline of every change order and what it added, cancelled or reopened.
- **Ticket drawer:** the scope text, acceptance criteria, files, runs, review result, PR, cost, and drift flags.
- **Live:** it updates as tickets move. New tickets from a change order animate in.

## 7. Commands summary

`swarm scope template` · `swarm scope check` · `swarm scope split` · `swarm scope approve` · `swarm go --scope` (runs all ready tickets) · `swarm tickets` · `swarm ticket <id>` · `swarm change "<text>"` · `swarm scope sync`

## Done when

- A real scope with at least 100 requirements splits into 300+ tickets with 100% coverage, zero untraced tickets after review, and Braden's approval.
- `swarm go --scope` runs them in waves with hundreds in flight. Every merged change traces to a ticket and a requirement.
- A change order mid-build adds and cancels the right tickets, and the Build Plan view shows it live.

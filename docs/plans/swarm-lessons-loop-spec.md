# Lessons Loop — Turning Swarm Lessons into Better Guards and Tests

Add to `docs/plans/swarm-scale-plan-v2.md` as part of Phase 15 (Quality). Goal: every project the swarm builds makes the next one better. Lessons stop being notes and become **checks, tests, scope rules and routing rules** that run automatically.

Core idea: **scope quality and tests are the two biggest levers.** Lessons feed both.

---

## 1. Lessons become structured data

Each lesson written back to the swarm uses one schema (`lessons/<project>/<id>.json` in the swarm repo):

- `id`, `project`, `date`, `ticket` / `requirement` (if any)
- `stage` where it went wrong: scope, split, build, test, review, merge, integration, deploy
- `what happened` (one or two sentences)
- `caught by`: test, review, merge check, Braden, a user in production, or `missed`
- `cost`: retries, time, spend
- `lane/model` that made the mistake
- `fix` and the **guard that would have caught it earlier** (proposed)
- `tags` (for example `auth`, `migration`, `vague-scope`, `missing-import`, `mock-drift`)

Rules:

- **No secrets, no customer data, no production code** in lessons. Describe the bug and add a small made-up repro instead. BinGo production code never goes in.
- `swarm lesson add` writes one. The runner also drafts lessons automatically from failed jobs, bisects, escaped bugs and change orders. Braden or the orchestrator confirms them.
- Convert the existing free-text lessons to the schema once, as a backfill job.

## 2. `swarm lessons mine`: from lessons to guards

Run it weekly, or after each project. It groups repeat lessons and **proposes** one of these for each cluster:

| Lesson pattern | Becomes |
|---|---|
| Vague requirement led to the wrong build | a new `swarm scope check` rule, plus a bad and good example |
| Same bug type keeps slipping through | a lint or static check, or a required test case |
| Tests passed but the feature was broken | a test template (for example "must test the error path" or "must hit the real route") |
| Mock and real API disagreed | a contract test rule |
| Lane X keeps failing task type Y | a router rule (send Y elsewhere) |
| Reviewer missed it | a review checklist item |
| Small model makes the same mistake | a prompt rule or few-shot example for that lane |

Proposals come as a **PR to the swarm repo**, never auto-merged. Each PR names the lessons it comes from.

## 3. The golden eval set (the swarm's own test suite)

- Every real failure becomes an **eval task**: a small repro repo, the ticket, and pass/fail checks. Store these in `evals/`.
- Run it in the lane bake-off and before any change to prompts, guards, router rules or models.
- **Rule:** a change can't merge if the eval score drops. New models (for example a rented-GPU coding model) must pass it before they get real work.
- Keep the expanded lane benchmark (the 10-task one) as the starter set and grow it from lessons.

## 4. Scope check learns

- Lessons tagged `vague-scope` add rules and examples to `swarm scope check` and the scope interview (`swarm scope new`).
- Track **scope-caused rework** per project: tickets reopened, and change orders that were really missing requirements. This number should go down over time.

## 5. Test generation learns

- Test patterns that caught real bugs become **templates per app type**, shipped in the starter kit.
- Bugs that escaped become **required test cases** for that kind of ticket (for example "every payment ticket tests a declined card").
- Optional: run mutation testing now and then to find weak tests (tests that still pass when the code is broken).

## 6. Few-shot memory for workers (cheap, do first)

- When a ticket is dispatched, attach the 2–3 most similar past lessons (by tags and files) as short "watch out for" notes in the prompt. Keep it to a small token budget.
- Search through Oasis (RAG) later. Simple tag matching works to start.

## 7. Real fine-tuning (later, optional)

- Once there are thousands of clean examples (accepted diffs plus passing tests), we *could* LoRA-fine-tune the small worker model on dev2 or a rented GPU.
- Only use RDW Labz's own non-sensitive code. Never BinGo production code or customer data.
- Do this only if sections 2–6 stop improving scores. Better guards, tests and examples usually beat fine-tuning and cost almost nothing.

## 8. Measure it

Shown in `swarm stats` and Swarm Watch:

- **First-try pass rate** per lane and task type
- **Escaped bugs**: found after merge, and found in production
- **Guard catch rate**: which checks actually catch things. Retire guards that never catch anything and slow runs down.
- **Scope rework rate**
- Eval score over time

---

## Done when

- All existing lessons are in the schema, and `swarm lessons mine` has produced at least 5 merged guard, test or scope rules from them.
- The eval set has at least 30 tasks from real failures, and it gates prompt, router and model changes.
- Across two consecutive projects, first-try pass rate goes up and escaped bugs go down.

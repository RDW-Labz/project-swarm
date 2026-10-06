# T101 compare: upstream skills vs OASIS

Ours stays; these are proposed edits only. Upstream excerpts are MIT-licensed and attributed.

## to-tickets vs ticket format, contract, and task

- Upstream adds tracer-bullet slices, explicit blockers, acceptance criteria, approval questions, and dependency-order publishing (“Each slice cuts a narrow but COMPLETE path through every layer”, upstream, MIT).
- Ours adds provider/spend/model/tier, shared-contract ownership, live checks, and concrete desktop done-when evidence; upstream does not.

| our file | current line (quote, <= 15 words) or 'new line after: <quote>' | proposed line | why (<= 12 words) |
|---|---|---|---|
| 1 — docs/_swarm/t101-ours/oasis-tickets-sample.md | `**Done when:** desktop-app PR merged after T99` | `**Blocked by:** <ticket numbers/titles>; **Status:** ready-for-agent` | Makes dependency edges and readiness explicit before dispatch. |
| 2 — templates/coordination/TASK.md | `- Jobs: deliverable, model, tier, tierReason, context, outputs, tests, dependencies.` | `- Jobs: deliverable, model, tier, tierReason, context, outputs, tests, dependencies, blockers, acceptance.` | Keeps the graph and completion contract in one coordination record. |
| 3 — docs/_swarm/t101-ours/oasis-tickets-sample.md | `new line after: **Build:** reads T99's route list and per-chat choice from the local service` | `- [ ] Acceptance criterion: <observable end-to-end behavior>` | Prevents “done” from drifting into implementation-only completion. |

Not adopted: upstream’s tracker-publishing workflow; project-swarm owns publication and dispatch boundaries.

## to-spec vs contract and task

- Upstream synthesizes a no-interview spec with problem, solution, extensive user stories, decisions, testing, and scope (“Do NOT interview the user”, upstream, MIT).
- Ours captures operational execution—providers, spend, jobs, dependencies, contract names, and checks—but lacks a canonical product-spec and seam decision.

| our file | current line (quote, <= 15 words) or 'new line after: <quote>' | proposed line | why (<= 12 words) |
|---|---|---|---|
| 1 — templates/coordination/TASK.md | `- Goal:` | `- Goal: problem statement, user-visible solution, and numbered user stories.` | Preserves user intent when work crosses context windows. |
| 2 — templates/coordination/TASK.md | `- Scope / out of scope:` | `- Scope / out of scope: implementation decisions, testing decisions, and explicit exclusions.` | Makes omissions reviewable before tickets are dispatched. |
| 3 — templates/coordination/CONTRACT.md | `## Tests` | `## Tests — record the highest seam, prior art, and one test per failure class.` | Turns seam choice into an observable anti-rework decision. |

Not adopted: upstream’s issue-tracker publication and user quiz; orchestration approval remains outside these templates.

## handoff vs handoff rules and templates

- Upstream makes a compact, argument-tailored, redacted handoff in OS temp, with suggested skills and artifact references (“Redact any sensitive information”, upstream, MIT).
- Ours is a persistent orchestration protocol: update TASK/HANDOFF every dispatch, preserve live run/check/cost evidence, and stop with a resume block.

| our file | current line (quote, <= 15 words) or 'new line after: <quote>' | proposed line | why (<= 12 words) |
|---|---|---|---|
| 1 — templates/coordination/HANDOFF.md | `- Goal and done-when: see TASK.md.` | `- Goal and done-when: see TASK.md; tailor this handoff to the next session.` | Makes handoffs useful without duplicating the task record. |
| 2 — templates/coordination/HANDOFF.md | `- Next action (include how to resume a running job):` | `- Next action (include how to resume a running job); suggested skills:` | Transfers capability choices alongside operational continuation steps. |
| 3 — docs/_swarm/t101-ours/oasis-handoff-rules.md | `2. Write coordination/HANDOFF.md with what is done, what is in flight, and what is next.` | `2. Write coordination/HANDOFF.md with what is done, in flight, next, and links to existing artifacts.` | Reduces duplicated, stale context while retaining durable coordination evidence. |

Not adopted: upstream’s OS-temp destination; project coordination needs a durable, inspectable handoff record.

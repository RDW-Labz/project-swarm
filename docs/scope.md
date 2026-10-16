# Scope, tickets and the build plan

Phase 13. You write one scope file. The swarm splits it into small tickets, you approve the plan once, and the swarm builds the tickets in waves.

## The flow

1. `swarm scope template --out docs/scope/scope.md`, then fill it in. Each requirement is one testable sentence with an `Acceptance:` list.
2. `swarm scope check` flags missing acceptance, duplicate ids and vague words. It also lists the outside services that need an owner on day 0 (Stripe, domain, email, app stores).
3. `swarm scope split` writes `docs/scope/split/manifest.json`: one job per stage. Run it with `swarm run docs/scope/split/manifest.json`.
4. `swarm scope split --ingest RUN` reads the ticket lists from that run, assigns ids, adds the day 0 human tickets, runs the integrity checks and writes the ledger (`.swarm/project/tickets.json`), not approved. A bad file refuses the whole ingest and names the problem.
5. `swarm scope approve` prints a short summary (stages, waves, estimate, risks). `swarm scope approve --yes` records your approval and writes `docs/scope/build-plan.md`. It refuses when coverage is below 100%, a ticket has no requirement, two parallel tickets write the same file, or the scope file changed after the split.
6. `swarm go --scope [--max-jobs N]` builds a manifest from the ready tickets (dependencies done), marks them running and starts the normal `go` run. It refuses an unapproved ledger, a ticket set edited since approval, or a scope file that is missing or changed since approval. Only one wave starts at a time (a lock). `--max-jobs` must be a positive whole number. Human tickets wait for you (`swarm tickets T-9001 --set done`).
7. After the run: `swarm scope sync RUN` moves finished tickets to review and failed ones to blocked. After `swarm integrate RUN`: `swarm scope sync RUN --integrated` marks that run's finished tickets done (it refuses a run that is not integrated). Then `swarm go --scope` again for the next wave.

`swarm tickets` lists tickets (filters `--stage --status --type --risk`, `--json`); `swarm tickets T-0002` shows one; `swarm tickets T-0002 --set ready --note "why"` moves one by hand (only legal moves). `swarm brief` shows ticket progress.

## Contracts first

`swarm scope contracts contracts/api.json --yes` (it asks for `--yes` because you approve contracts, and when it would overwrite files) takes an OpenAPI 3 JSON file (the contract ticket's output, which you approve) and generates `contracts/types.d.ts`, `validators.mjs`, `client.mjs`, `mock-server.mjs`, `seed.json` and `contract.test.mjs`. The mock API answers from seed data, so front-end and back-end tickets can run in parallel before either exists. The contract tests run against the mock and later against the real API (set `CONTRACT_BASE_URL`).

## Change orders

Edit the scope file, then `swarm change "why"`. It compares the new scope with the approved snapshot and shows what it cancels, reopens and needs new tickets for, with a rough cost. `--yes` records it and keeps the ledger approved (history is kept, the old snapshot is saved under the order id; cancelled tickets stay in the ledger). Then `swarm scope split` (only requirements without tickets are split) and `swarm scope split --ingest RUN --merge`. A merge adds worker-written tickets, so it clears the approval: run `swarm scope approve --yes` again before `go --scope`.

## Approval policy

The profile in `.project-swarm.json` may carry an `approval` block: `autoMergeToStageBranch` (default true), `humanApprovals` (default scope, contracts, design-gallery, final-stage-pr), `changeOrderOverUsd` (default 20), `budgetUsd` (default none). Anything unknown fails closed: it needs you. Nothing here merges to main or deploys.

## Safety

The split jobs are `sensitive: true` (they see your whole scope), so they never go to a rented, OpenRouter, OpenAI, Gemini or Lambda lane. Tickets are sensitive when the worker says so or their text names something in the scope's Sensitive list. Put no secrets or customer data in the scope file.

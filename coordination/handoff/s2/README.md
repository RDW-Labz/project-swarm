# S2 (Ticket Manager v2): handed to the Mac mini, 2026-10-21

Owner decision: the Mac mini owns the open S2 tickets; the MacBook skips S2 and keeps S1, S3 and the rest moving. The MacBook marks the S2 tickets done when your PRs merge (swarm tickets ID --delivered PR).

- tickets.json: the S2 slice of the live roadmap ledger (27 tickets; 5 already done on the MacBook, 22 open and owned by you). tickets.log: their ledger events.
- On the MacBook the open S2 tickets are status blocked with the note owned by mac-mini, so no wave touches them.
- Work packages A to G, rules and file ownership: see ../MINI-BRIEF-tm2.md (same branch family). The modules these tickets built are on main since 1.161.0 (PR 248); most open tickets are the wiring, regression-test and owner-validation tickets.
- Two tickets outside S2 wait on open S2 tickets: T-0090 (S3) and T-0207 (S6); they start when you deliver their S2 dependencies.

## Tickets by requirement (status on the MacBook at handoff)

### R-006
- T-0036 [blocked] Add ticket-paths helper to validate files and suggest closest repo paths
- T-0037 [blocked] Wire ticket path validation into scope split --ingest
- T-0059 [done] Document Ticket Manager v2 ingest and replan behavior in dogfood fixes design
- T-0060 [blocked] Regression tests for ticket path validation at ingest

### R-007
- T-0038 [blocked] Add lane-size module for per-lane byte budgets on split tickets
- T-0039 [blocked] Apply lane byte sizing during split ingest and scope approve warnings

### R-008
- T-0040 [blocked] Make build tickets own their test files in ticket-manifest prompts
- T-0041 [blocked] Keep test tickets after build modules in wiring order
- T-0042 [blocked] Wire build-owns-tests rules into scope split ingest

### R-009
- T-0043 [done] Filter acceptance lines to those provable from ticket files and auto context
- T-0044 [blocked] Reject or trim unprovable acceptance lines at split ingest

### R-010
- T-0045 [done] Tag sensitive only for auth, database, payments, secrets and public routes
- T-0046 [blocked] Use precise sensitive tagging during split ingest instead of scope phrase match

### R-011
- T-0047 [done] Compute file owners from open tickets and release done ticket files
- T-0048 [done] Expose existing ticket file locks to split workers and merge ingest

### R-012
- T-0049 [blocked] Simulate ingest waves for slot count, fill and critical path length
- T-0050 [blocked] Run wave simulation before scope split --ingest writes the ledger
- T-0061 [blocked] Regression tests for split wave simulation thresholds

### R-013
- T-0051 [blocked] Re-split or reroute blocked tickets after two failures without a manifest
- T-0052 [blocked] Invoke ticket replan from scope sync when a ticket blocks or fails twice

### R-014
- T-0053 [blocked] Validate delete-only tickets and migration ticket DDL rules
- T-0054 [blocked] Add rename ticket type validation alongside migration checks
- T-0055 [blocked] Wire delete and rename ticket sync checks into scope sync integrated path
- T-0062 [blocked] Regression tests for delete-only and rename ticket sync

### R-015
- T-0056 [blocked] Exclude human tickets from build progress and wave blocking counts
- T-0057 [blocked] Show human ticket checklists on Swarm Watch plan tab without build progress
- T-0058 [blocked] Owner validates human ticket checklist UX on Swarm Watch

## How to report

Open your PRs against main on top of the current main; I bump versions at merge time. When a PR merges tell the owner which tickets it delivers; the MacBook runs swarm tickets IDS --delivered PR (sensitive tickets still need their review).

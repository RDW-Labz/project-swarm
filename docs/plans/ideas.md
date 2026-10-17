# Ideas parking lot

The plan ([swarm-scale-plan-v2.md](swarm-scale-plan-v2.md)) is **frozen**: no new phases unless Braden says so. Any new idea, from Braden or from the orchestrator, goes here, not into the plan. An idea moves into the plan only when Braden says so.

Build order now: **14e → A1 security gate → 13**. After 13, dogfood on the parts request app as the first real test, and record what broke as lessons.

## Accepted (being built)

- **A1 security gate** (merge queue: secret scan, package check, known vulnerabilities, code scan, licence check; each block writes a lesson). Right after 14e. Spec: [swarm-more-upgrades-spec.md](swarm-more-upgrades-spec.md), section A1.
- **B2 shared prefix caching** and **B1 best-of-N on our own GPUs**, as part of 14e and its bake-off (N=1 vs N=3 pass rate; cache hit rate). Spec: sections B1 and B2.

## Parked (from [swarm-more-upgrades-spec.md](swarm-more-upgrades-spec.md); not scheduled)

- A2 accessibility and speed budgets (Lighthouse, axe on preview deploys).
- A3 safe database changes (tested rollbacks, fake-data dry run, human approval for destructive changes).
- B3 automatic model upgrades (`swarm models watch`; needs the eval set and a pre-approved short GPU rental cap).
- C1 errors become tickets; C2 handoff docs at each stage's final PR.
- D1 client progress reports; D2 better quotes (`swarm time`, `swarm quote`).
- E: panic button (`swarm stop --all`), phone inbox, encrypted state backups.

## New ideas

Add one line each, with the date and who had it. Do not build from this list without Braden's OK.
- 2026-10-16 (orchestrator, owner decision): best-of-N is OFF for now (N=1; a failure escalates to Haiku, then Codex). Fix before turning it on again: pick the candidate by tests passed (and lint), never by size; the current selector falls back to the smallest candidate when no test is visible, which was wrong on the hard task (0/16).
- 2026-10-16 (orchestrator): retry Qwen3-Coder-Next and Nemotron Lightning with thinking on, and try Qwen3.6 with the MTP speculative decoding A/B from the memory plan.
- 2026-10-16 (orchestrator): rerun the sweep with a higher server max-num-seqs and levels 128 to 256 on the winner to find its real agent ceiling with thinking on.
- 2026-10-16 (orchestrator): wait for the ssh key to be active in vast.mjs rent (it took about 4 minutes after the instance was running) instead of retrying by hand.

## Second Haiku lane on Bedrock or Vertex (parked, needs the owner's OK before any account or spend)

Why: the first-party Haiku 5.5 limit (10,000 requests, 10M input and 2M output tokens per minute, about 147 agents at our task profile, about 100 with margin) is the ceiling for the default lane. A second account on another platform has its own quota, so it would add agents, not replace them.

What is known (checked 2026-10-16): Haiku 5.5 is reported available on Amazon Bedrock (model id `anthropic.claude-haiku-5-5`, regional and global inference profiles, 1M context). Bedrock tracks quotas as requests and tokens per minute per route (on-demand, cross-region, global cross-region); newer Haiku models may have no on-demand quota, so the cross-region quota is the one to read and raise. Defaults for Haiku 5.5 on Bedrock and any Vertex limits were not published where we could find them: read them from the Service Quotas console (`aws service-quotas list-service-quotas --service-code bedrock`) or the Google Cloud quota page before planning numbers.

Plan, if approved:
1. Owner decides platform and creates the account and a budget alarm (a new paid service: not done by the swarm). Credentials in the Keychain, never in the repo.
2. Read the real quotas, request an increase if the default is under 1M output tokens per minute.
3. Add a `bedrock` lane next to `anthropic`: same job format and Haiku routing, its own concurrency cap derived from its output-token quota (output tokens per minute divided by about 14,000 per agent, then 70%), its own spend cap, sensitive jobs allowed only if the owner agrees to send code to that cloud account.
4. Router: fill the `anthropic` lane to its safe cap, spill extra ready tickets to `bedrock`; failures escalate as today.
5. Smoke test with the 8 golden evals and the lane benchmark; compare pass rate and cost per passing task with first-party Haiku before it gets real work.
Open points: Bedrock limits on tool-use streaming fields differ by model generation (see the platform table), and prices may differ slightly from first-party.

## Swarm Watch follow-ups (from the Phase 16 build)

- `swarm go` and `swarm "goal"` start the watch server and print its URL; `--watch` opens it.
- `swarm watch --all` as a web board: one card per live run, with a click-through.
- Job drawer: prompt summary, lane history across attempts, short report and check results (needs a read-only route that returns those fields from state.json, scrubbed).
- Gallery comments become fix tickets (needs a ledger write and a re-approval of the changed ticket set).
- Bundled fonts (Unbounded, Figtree, JetBrains Mono) so the page matches the prototype exactly without a CDN.
- A recorded 1,200-job fixture run and a Playwright check inside the repo's own tests (today the render check runs through `swarm ui check` in a throwaway project).
- Watch hardening left from the review: open screenshots with O_NOFOLLOW and read from the handle; a lock for concurrent `swarm gallery` writes; do not print the token in the URL passed to `open`.

## Left from the lessons 28-32 review (1.91.0)

- `autopilot` `retry-failed` reruns a failed job at the same level while `scope sync` also escalates the ticket; the extra paid attempt is not counted by the ladder. Make retry-failed skip jobs of scope tickets (sync owns them) or count it.
- A change-order reopen sets a ticket back to todo but keeps its `escalation` level, so a reopened ticket may start at Codex or Claude. Reset `escalation`, `attempts` and `retryNote` when a change order reopens a ticket.

## Lesson 34 left-overs
- Done in 1.94.0 to 1.96.0: failed test goes back to the worker; the route-level test path must be a test file (a stricter check that the file really requests a route is still open); integration tickets sharing a file are chained by code.
- A later split that adds a module to an already-wired requirement does not add it to the existing integration ticket's dependencies (`--wire` only helps requirements with none): flag it.
- Cancelling a ticket now drops it from dependents and reseals the approval (asked for by the owner); a stricter option would block dependents for a look first.

## Batch A review notes (2026-10-17)
- Tests systemic-failure guard: `failCounts.get('tests')` counts only tickets with tests; compare it with the number of tickets that have test evidence, not the quality-checked total.
- One retry, two failures: a ticket whose tests and lint both failed uses one retry for the tests and a second for the lint; combine them into one retry note.
- The retry note carries the last 500 characters of check output as is (same as the lint path); strip control characters and wrap it as data.
## Parked by the owner (2026-10-17)
- Lesson 1: remote hosts (ssh/sandbox) send no command, so remote jobs hang; fix needs a test against a real host (dev2). Low while only local lanes are used.
- Strict cancel: block dependents of a cancelled ticket for a look instead of dropping the dependency and resealing the approval.


# More Upgrades — Safety, Speed, After-Launch and Business

Add to `docs/plans/swarm-scale-plan-v2.md`. Items go into existing phases where they fit. The rest become **Phase 19 (Run and grow)**.

**Build first:** A1 (security gate), B1 (best-of-N), B2 (prefix caching). Then the rest, in the order at the bottom.

---

## A. Quality and safety (into Phase 15)

**A1. Security gate on every batch (first).** It runs in the merge queue before a batch can merge:
- **Secret scan** (gitleaks or similar): any hit blocks the merge and opens an inbox item. The secret never goes into lessons or logs.
- **Package check:** every new dependency must exist on the registry, be older than 30 days, and have real downloads. This catches made-up and look-alike package names.
- **Known vulnerabilities** (npm audit, pip-audit or osv-scanner): high and critical findings block the merge.
- **Code scan** (Semgrep with standard rules) for injection, unsafe auth and similar issues. Findings become fix tickets.
- **Licence check:** no GPL/AGPL in client projects unless Braden approves.
- **Lessons:** each block writes a lesson (Phase 15 lessons loop), so the gate's rules learn over time.

**A2. Accessibility and speed budgets.** Every preview deploy runs Lighthouse and axe on the key screens:
- budgets per app type in the starter kit, for example performance at least 85, accessibility at least 95, no serious axe errors;
- a failure becomes a fix ticket; it blocks only the final stage PR, not every batch.

**A3. Safe database changes.**
- Every migration has a working down/rollback step, tested in CI (up, down, up again).
- It runs against a **fake copy of realistic data** (generated seed data, never real customer data) before merging.
- Destructive changes (dropping a column or table, rewriting data) get a `human` approval item.

## B. Speed and cost (into Phase 14e and the lessons loop)

**B1. Best-of-N on our own GPUs (first).**
- Only for rented-GPU and local lanes, where tokens are nearly free.
- Generate N versions (default 3, configurable) in parallel, run the ticket's tests on each, and keep the best passing one: the smallest diff with the clean review.
- If none pass, escalate as normal (Haiku, then Codex).
- Never on paid API lanes unless a project turns it on with a cap.
- The bake-off measures pass rate at N=1 vs N=3 to prove the gain.

**B2. Shared prompt caching on vLLM (first).**
- Turn on vLLM prefix caching.
- Build prompts as **shared prefix first** (rules, project context pack, contracts), then the ticket-specific part last, so all agents on a project reuse the cached prefix.
- Track cache hit rate per GPU in Swarm Watch. Target: over 70% on a project run.
- Same ordering for Anthropic API prompt caching.

**B3. Automatic model upgrades.**
- `swarm models watch` checks weekly for new open coding models that fit our GPUs, plus new versions on the API lanes.
- It runs the eval set (lessons loop) on candidates, using a short GPU rental within a small cap that Braden pre-approves once.
- It reports "model X beats the current one by Y% at Z cost" to the inbox. Braden approves any switch.

## C. After launch (Phase 19)

**C1. Errors become tickets.**
- Connect Sentry (or similar) per project in the starter kit.
- New error groups become tickets with the stack trace and steps, after removing user data. Duplicates merge into one ticket.
- Fixes go through the normal swarm flow and a PR; nothing deploys to production without Braden.
- Severity rules: a spike or a payments/auth error notifies right away; the rest go in a daily digest.

**C2. Handoff docs at the end.** Generated from the scope, the tickets and the code at each stage's final PR:
- a user guide (with screenshots from the gallery);
- an admin guide;
- a runbook: deploy, roll back, rotate keys, where logs are, who to call;
- docs are checked against the running preview, so steps really work.

## D. Business (Phase 19)

**D1. Client progress reports.**
- `swarm report --client` builds a weekly progress page from the Build Plan: done this week, next week, % complete, decisions needed from the client, and a preview link.
- No costs, internal notes, model names or code are shown to clients. Braden reviews before it's sent.

**D2. Better quotes.**
- Track real numbers per project: requirements, tickets, model cost, GPU hours, Braden's hours (logged with `swarm time`), change orders, and how long it took.
- `swarm quote <scope.md>` estimates cost, time and a price range from similar past projects, showing how confident it is.
- It gets more accurate with every finished project.

## E. Extras (Phase 19)

- **Panic button:** `swarm stop --all` stops every run, lane and rented GPU on this machine within 30 seconds, and confirms nothing is still billing. It's also in Swarm Watch as a copyable command and the phone inbox.
- **Phone inbox:** approve or decide inbox items from the phone through a secure link (signed, short expiry, approve/decide actions only). Never merge to main, deploy or raise spend caps from the phone without a second confirmation.
- **State backups:** back up the journal, ledgers, ticket ledger, lessons and evals nightly to a private location, encrypted. `swarm restore` gets them back. Test it once a month.

---

## Build order

1. A1 security gate
2. B2 prefix caching (with 14e)
3. B1 best-of-N (with the 14e bake-off)
4. Panic button and state backups
5. A3 safe migrations, A2 budgets
6. B3 model watch (after the eval set exists)
7. C1 errors to tickets, C2 handoff docs
8. D1 client reports, D2 quotes, phone inbox

## Done when

- A planted fake secret, a made-up package and a known-vulnerable dependency are each blocked before merge.
- On the bake-off GPU, best-of-3 raises pass rate measurably, and the prefix cache hit rate is over 70%.
- `swarm stop --all` stops everything including rented GPUs, verified.
- One real client project gets a weekly report, handoff docs, and errors-to-tickets after launch.

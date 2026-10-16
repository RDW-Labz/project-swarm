# Speed Multipliers — Cutting the Five Bottlenecks

Add to `docs/plans/swarm-scale-plan-v2.md` as Phase 18. Some parts fold into Phases 13, 15 and 16 where noted. Goal: move from "the code is fast, everything around it is slow" to shipping in hours and days.

---

## 1. Work that must happen in order (waves)

**a. Contracts first, then everything in parallel (Phase 13).**
- Wave 0 is small and quick: the database schema, API spec (OpenAPI), shared types, events, and screen list with routes. It comes straight from the scope, and Braden approves it once.
- **Generate, don't write:** a tool, not a model, generates types, API clients, validators, migrations, **mock API servers** and **seed data** from the contracts in seconds.
- Then the database, API and screens all build **at the same time** against the contract and mocks. About 6 waves become about 2.

**b. Speculative start.** The next wave starts against the contract before the previous wave finishes merging. Only tickets whose contract actually changed get redone.

**c. RDW Labz starter kit (biggest single win).** One template repo per app type (web app, mobile app, booking or portal):
- auth, roles, layout, design system, forms, tables, payments (sandbox), emails, file upload, admin panel, CI/CD, deploy, error tracking, test setup;
- all already built and tested.

New projects start at "the basics already work". The swarm only builds what's unique to the project. `swarm init --kit web-portal`.

## 2. Testing and merging

- **Tests from the scope first:** acceptance tests are written straight from the requirement acceptance criteria in wave 1, in parallel with the code, so every ticket has a pass/fail target from the start.
- **Test only what changed:** each batch runs the tests affected by its files (from the repo map's test links). The full suite runs every N batches and at the end.
- **Fast test machines:** cached dependencies, a prebuilt dev container, and tests split across CPU cores. They can run on the rented GPU box's CPUs too.
- **Adaptive batch size:** when batches keep passing, merge bigger batches (10 → 25 → 50). When failures rise, shrink. Bisect stays as the safety net.
- **Merge often, branch short:** every green batch lands on the `swarm/*` branch right away, so later tickets build on real code, not stale copies.

## 3. Braden (the human steps)

- **Scope interview:** `swarm scope new` asks structured questions (local brain or Claude), uses a scope template for the app type, and writes the scope with requirement IDs. Hours become about 30–60 minutes.
- **Design once per brand:** pick the design system once (for example RDW Labz navy and lime). Every screen uses it. Design review is a **screenshot gallery** (Phase 16) that you approve in one sitting, with comments becoming fix tickets.
- **Approval policy, set once per project:**
  - auto-merge into the `swarm/*` branch when tests and review pass;
  - Braden approves only: the scope and contracts (day 0), the design gallery, change orders over $X, and the final PR per stage;
  - a pre-approved budget per project.
- **Day 0 setup checklist:** splitting the scope lists **every** account, key and decision the project needs (Stripe, domain, app store, email provider…). Do them all at once on day 0, not as surprises mid-build.
- **Secrets vault** (the Oasis plan): keys go in once. Deploys and tests use them; agents never see them.

## 4. Gluing the pieces together

- **Thin end-to-end skeleton first:** one feature built all the way through (database → API → screen → test) before fanning out, so connection bugs show up on day 0, not at the end.
- **Contract tests on both sides:** generated from the contract. If the API and the screen disagree, it fails at the ticket, not at the end.
- **Integration continuously:** after every merged batch, run end-to-end smoke tests (Playwright) on a running copy of the app. Failures are triaged by local brain and become fix tickets automatically.
- **Integration lead:** one lead's whole job is watching connections between areas and opening fix tickets.

## 5. Real-world steps

- **Preview deploy per batch:** every green batch deploys to a preview URL automatically (Vercel, Fly, Cloudflare…). Braden or Tim can open it on a phone at any time.
- **Automated device checks:** Playwright mobile emulation plus simulators on every batch. Real-device testing only for final candidates.
- **Payments in sandbox from day 1:** build fully against Stripe test mode (or similar). Going live means swapping keys, not building.
- **Store and launch work starts on day 0** as human tasks: developer accounts, store listings, privacy policy, review submission. They run in parallel with the build, not after it. The publishing pipeline project plugs in here.
- **Deploy pipeline comes from the starter kit,** already working.

---

## Expected effect (to verify in Phase 17)

| | Before | After |
|---|---|---|
| Waves for a medium app | ~6–10 | ~2–3 |
| Swarm build time (medium app) | ~4–10 h | ~1–3 h |
| Braden's time (medium app) | ~2–4 days spread out | ~1 day, in 3–4 planned sittings |
| Glue bugs found | at the end | in the first hour |

## Build order

1. Contracts-first + codegen + mocks (in Phase 13)
2. Day 0 setup checklist + approval policy (in Phase 13)
3. Affected-only tests + adaptive batches (in Phase 15)
4. Skeleton-first + continuous integration tests + preview deploys (in Phase 15)
5. Screenshot gallery approval (in Phase 16)
6. Starter kit `web-portal` (its own project; dogfood it on the parts request app)
7. Scope interview (after Phase 13)

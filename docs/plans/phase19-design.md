# Phase 19 design: errors to tickets, handoff docs, client reports, quotes, phone approvals

Status: DESIGN, for the owner's review. Nothing here is built. Rule from the owner: **only services we already have** (Resend, GitHub, Vercel, the `gh` and `vercel` logins already on this machine). No new paid service and no new API key without asking. Every place where a design choice needs a service or key is marked **ASK**.

Shared rules for all five parts (they follow what the swarm already does):
- Anything that comes from outside (an error message, a client comment, a log line) is **untrusted data**: sanitised, quoted, never an instruction, and a ticket made from it is `proposed` (the mechanism built for gallery comments: outside the plan and the approval hash, never ready, never a job until the owner runs `swarm tickets ID --approve --yes`).
- Read-only by default; anything that sends, posts or deploys needs the owner's explicit step and is logged.
- Nothing deploys to production, merges to main or raises a spend cap from a phone or an automatic path.
- Each part is its own PR with an Opus review; each part works without the network (files first, sending is a separate, optional step).

## 1. Errors become tickets (C1)

**The problem with "Sentry or similar":** Sentry is a new service and a new key. The design is source-agnostic, so the source can be chosen later.

- **Core (no service at all):** a normalised error event `{ fingerprint, title, kind, route, release, count, firstSeen, lastSeen, stack[], sample }`. `swarm errors ingest FILE|-` reads events (JSON lines) from a file or stdin; `swarm errors list|show|digest`.
- **Scrubbing before anything is stored:** emails, phone numbers, tokens and keys (the existing secret redactor), UUIDs/ids in URLs and query strings, cookies and auth headers, request bodies, IP addresses. Stack frames keep file, line and function only. A text that still looks like a secret after scrubbing is withheld.
- **Dedupe:** by fingerprint (error type + top in-app frames, with numbers and ids normalised). A repeat updates the existing ticket's count and last-seen, never makes a second one. A fixed error that returns reopens its ticket (as a new `proposed` one that links the old).
- **Ticket:** `proposed` (owner approves; title and acceptance are fixed words, the scrubbed stack is in `notes` as quoted data; files are named by the owner or from the in-app frames the owner approves). Fixes then go through the normal swarm flow and PR.
- **Severity (owner-configurable globs in the profile):** a spike (count in a window over a threshold), or a route matching `payments/**` or `auth/**` (defaults, editable) = **notify now**; everything else goes into the **daily digest**. "Notify" = an inbox decision (existing `swarm inbox`) and the phone channel in part 5. No email is sent unless the owner turns it on (part 4's Resend step).
- **Sources, cheapest first (ASK which):**
  - **A. Vercel runtime logs** with the `vercel` CLI login that already exists (`vercel logs --json`, polled by `swarm errors pull`). No new service. Limit: Vercel keeps logs briefly on the free plan, so it must run often (autopilot already can).
  - **B. The app reports its own errors** to a table in the app's own database (parts app already has Supabase). The starter kit (Phase 18) gets a ~30-line error reporter. `swarm errors pull` reads it with a read-only key **the owner provides for that project** (ASK; it is a key the project already has, scoped read-only).
  - **C. Sentry:** only if the owner says so (new account and key).
  - My recommendation: build the core and **A** now; add **B** with the starter kit.

## 2. Handoff docs (C2)

At a stage's final PR, `swarm handoff generate --stage S3` writes `docs/handoff/` into the project: a user guide, an admin guide and a runbook.
- **Inputs:** the approved scope (requirements, screens, Day 0 services), the ticket ledger, the gallery screenshots (existing `.swarm/ui/<screen>/page.png`, copied into `docs/handoff/img/`), and the code through the repo map. Written by a worker lane under a cap (a normal manifest, `swarm go`-style, with the budget and sensitivity rules that apply to the project).
- **The runbook never invents facts.** Deploy, roll back, rotate keys, where the logs are and who to call come from a `handoff` block the owner fills in the profile (commands as arguments, links, names and phone numbers kept in the owner's file, not generated). A missing item is written as `TODO (owner)` and the handoff cannot be marked final until none is left.
- **Checked against the preview:** each guide step that names a route, a screen or a visible text carries a machine-readable check; `swarm handoff check --url PREVIEW` runs them (page answers, text is there, a link works) with the existing UI checker, and a failing step becomes a fix ticket (`proposed`). The preview address is the one the `ci.preview` hook already produces (host-allowlisted, as for budgets).
- **Output is files in the repo**, reviewed like code; nothing is sent anywhere.

## 3. Client progress reports (D1)

`swarm report --client` writes a weekly page from the Build Plan to `.swarm/reports/client-YYYY-MM-DD/` (HTML, self-contained, plus the same text as plain text for an email body).
- **Content, by construction an allowlist:** done this week, next week, percent complete, decisions needed from the client, preview link. Built from the **requirements** (the owner's own words in the scope file) and stage names, not from ticket titles (those are worker-written). "Done this week" = requirements whose last ticket reached done in the last 7 days (from the ticket log); "next week" = requirements in the running or next wave; "decisions needed" = human tickets marked for the client plus any scope `Questions` entries.
- **Never shown:** costs, model or lane names, ticket ids, file paths, code, internal notes. After the page is built, a **scan refuses it** if any banned thing appears (dollar amounts, model names, `T-0001`-style ids, file paths, `.env`, secrets), and the scan is tested with planted examples.
- **The owner reviews before anything leaves:** the report is a `draft`; `swarm report --client --approve` records the approval with the report's hash; any later edit un-approves it.
- **Delivery (ASK):** by default the files are yours to send (your own mail, or attach). Optional `swarm report --client --send` uses **Resend**, only for an approved, unchanged report, to recipients listed in the profile. This needs the Resend key you already have to be stored for swarm (Keychain item `swarm-resend`, never in a file or the profile). I will not add or create a key: tell me how you want the existing one made available (or "files only").
- The preview link is the project's preview address (Vercel, already there).

## 4. Better quotes (D2)

- **`swarm time log HOURS "note"`** (and `swarm time list`) records the owner's hours per project, in an append-only file in the project (`.swarm/project/time.ndjson`).
- **Numbers kept per finished project** (`~/.project-swarm/quotes/projects.json`, written when a project is marked finished, or by `swarm quote record`): requirements, tickets, stages, screens, Day 0 services, model cost (from run states, split billed / flat-rate as on the board), rented GPU hours, owner hours, change orders, calendar days from first run to last, and what was charged (entered by the owner, optional).
- **`swarm quote scope.md`** parses the scope (requirements, stages, screens, services), finds the finished projects most like it (by size and by shared traits, nearest first), and prints cost, calendar time and your hours as ranges (the middle half of the similar projects), a price range from your hourly rate and margin, and **how sure it is** (few similar projects = low, with the reason). With no history it says so and gives no number.
- **Needs from you (ASK):** your hourly rate and target margin (`quote.hourlyRate`, `quote.margin` in the local config; no default is invented). It gets better with each recorded project; I will backfill from the parts app and project-swarm itself as the first two data points, marked as such.

## 5. Phone approvals and the panic button (E)

**The constraint:** the swarm runs on this Mac, which a phone cannot reach, and a signed link needs a server to open it. A new server is a new service, so the design uses what you already have.

- **Channel: GitHub, from the GitHub mobile app.** For each inbox decision (and each "notify now" error), `swarm phone sync` opens an **issue in one private repo you name** (`phone.repo`, for example a new private repo `swarm-inbox` under your account: creating it is free but is a new GitHub resource, so **ASK**). GitHub sends the push or email notification itself (no Resend needed); you answer on the phone by commenting `approve`, `decline` or a choice word. `swarm phone sync` (run by autopilot or by hand) reads the comments with the `gh` login already here.
- **Why this is secure without signed links:** GitHub authenticates you (account, 2FA, device). Swarm accepts a comment only from your login, only on an issue it created, only once, only within its expiry (default 24 h), and only the actions that issue offers. A comment from anyone else is ignored and logged. The issue body is generated from fixed words plus sanitised data.
- **What a phone may do:** approve or decline an inbox decision, choose among its listed options, approve a `proposed` ticket (not edit its files), and run the panic button (`stop --all` has one confirm, because it only reduces risk).
- **What a phone may never do:** merge to main, deploy, raise a spend cap, approve a security-gate or migration override, accept an unmet acceptance line. These are not offered; if one is asked for, the issue says "do this at your computer". Anything borderline (approving a ticket that touches payments or auth) needs the **second confirmation**: swarm posts a one-time word, and you reply with it.
- **Nothing to leave running on the internet:** no server, no webhook, no tunnel. The cost is that decisions are picked up when `swarm phone sync` runs on the Mac (autopilot does it every few minutes while it runs).
- **Alternative if you prefer email:** a Resend email with the question and reply instructions; replies need an inbound address (a new Resend feature and setup), so I recommend GitHub.

## Order, cost and what I need

| PR | Part | Needs |
|---|---|---|
| 1 | Errors to tickets: core, scrubber, dedupe, severity, Vercel-logs source | **ASK** which source (A now, B with the starter kit?) |
| 2 | Client report: allowlist builder, banned-content scan, draft/approve, files | **ASK** files-only or Resend send, and how the existing key is made available |
| 3 | Quotes: `swarm time`, per-project record, `swarm quote`, backfill | **ASK** hourly rate and margin |
| 4 | Phone approvals through GitHub issues, panic button, second confirmation | **ASK** OK to use one private repo (name?) |
| 5 | Handoff docs: generator under a cap, runbook from the profile, preview checks | none (the generation run costs model spend under a cap I will state first) |

All parts are free to run except the model spend of the handoff generator (small, capped, stated first) and the optional Resend sends. Not in this phase: nightly encrypted offsite backups (it needs a storage place and an encryption key: separate decision).

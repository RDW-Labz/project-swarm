# Phase 13 design: Scope -> Tickets -> Swarm

Contract for the Phase 13 modules. Specs: [swarm-scope-tickets-spec.md](swarm-scope-tickets-spec.md) (the flow) and [swarm-speed-multipliers-spec.md](swarm-speed-multipliers-spec.md) (contracts first, day 0 checklist, approval policy, tests from the scope). Every module is plain ESM for Node 22 with no dependencies; all I/O is passed in or limited to the helpers named here; no model calls and no network inside these modules. First line of every file: `// SPDX-License-Identifier: Apache-2.0`.

## 1. The scope file (`docs/scope/scope.md`) and `tools/scope.mjs`

Format (Markdown):

```
# Scope: Parts Request App
Version: 1

## Overview
Free text (users, goals, out of scope).

## Stages
- S1: Foundations
- S2: Requests

## S1 Foundations
### R-001 A signed-in user can create a parts request.
Acceptance:
- The form needs a part name and a quantity of at least 1.
- A saved request appears in the list within one second.

## External
- Stripe: payments
- Domain: parts.example.com

## Sensitive
- payments
- customer data

## Protected
- .env
```

Exports:

- `SCOPE_TEMPLATE` (string): the template above, filled with placeholders and short comments.
- `parseScope(markdown)` returns `{ name, version, overview, stages: [{ id, title, order }], requirements: [{ id, stage, text, acceptance: [string], line }], external: [{ name, note }], sensitive: [string], protected: [string], errors: [string] }`. `name` from `# Scope: NAME`, `version` the integer from `Version: N` (default 1). A requirement is a heading `### R-NNN text` under a `## Sn Title` stage heading; `Acceptance:` lists the dash lines after it until the next heading or blank-line-then-heading. `stages` come from the `## Stages` list (`- S1: Title`); a `## Sn` heading for a stage not in that list adds it. `external`, `sensitive`, `protected` are the dash lists of those sections (external lines `Name: note`).
- `checkScope(scope)` returns `{ ok, findings: [{ level: 'error' | 'warn', code, id, message, fix }] }`. Codes: `missing-id` (a dash line directly under a stage heading, outside any requirement heading, is probably a requirement without an ID; warn), `bad-id` (a heading that starts `### ` under a stage but whose ID is not `R-` and three or more digits; error), `duplicate-id` (error), `missing-acceptance` (a requirement with no acceptance lines; error), `untestable-wording` (a requirement text or acceptance line containing, as a whole word, any of: fast, quick, nice, good, easy, intuitive, user-friendly, robust, scalable, modern, clean, seamless, simple, beautiful, secure, flexible, efficient, reliable, better; unless the same line has a digit; warn), `bad-stage-order` (stage ids are not S1..Sn without gaps, in order; error), `unknown-stage` (a requirement under a stage that is not listed; error), `no-requirements` (error), `parse` (each parse error; error). `ok` is true when there is no error.
- `requirementText(scope, id)` returns `{ text, acceptance }` for an ID or null.
- `scopeHash(markdown)` returns the sha256 hex of the text with line endings normalized to `\n` and trailing spaces trimmed per line.

## 2. Tickets and the ledger: `tools/tickets.mjs`

A ticket: `{ id: 'T-0001', title, type: 'build' | 'test' | 'docs' | 'migration' | 'design' | 'contract' | 'human', stage: 'S1', epic: 'E-01 Requests', scopeRefs: ['R-001'], acceptance: [string], files: [paths this ticket writes], context: [paths it reads], contracts: [paths], dependsOn: ['T-0000'], size: 'S' | 'M', risk: 'low' | 'medium' | 'high', sensitive: boolean, status, hard?: boolean, steps?: [string] (human tickets), notes?: string }`.

Statuses: `todo, ready, running, review, done, blocked, cancelled`.

Exports:

- `STATUSES`, `TICKET_TYPES`.
- `validateTicket(ticket)` returns `{ ok, errors: [string] }`: id matches `^T-\d{4,}$`; title 1 to 140 characters; type known; `scopeRefs` an array of `R-` ids (a `human` or `contract` ticket may have none); acceptance an array of strings (required, at least one, for build, test, migration; optional for others); size S or M only (an L is an error saying to split it); risk known; `dependsOn`, `files`, `context`, `contracts` arrays of strings with no absolute path, no `..` segment and no backslash; status known; a `human` ticket needs `steps` (1 to 30 strings).
- `ledgerPath(root)` is `.swarm/project/tickets.json`; `logPath(root)` is `.swarm/project/tickets.log`.
- `async readLedger(root)` returns the ledger or `null`; `async writeLedger(root, ledger)` writes atomically (temp file opened `O_EXCL | O_NOFOLLOW`, mode 0o600, rename) through `safeWritableDir` and `assertRegularOrMissing` from `tools/journal.mjs`; `async appendLog(root, event)` appends one JSON line (`{ at, event, ... }`) to the log.
- `createLedger({ scope: { name, version, hash }, tickets, now })` returns `{ version: 1, scope, tickets, changeOrders: [], approved: null, createdAt, updatedAt }` after validating every ticket (throws `Error` with `code: 'ticket-invalid'` and the first error).
- `async transition(root, id, to, { by, note, now })` loads the ledger, applies an allowed move, saves it and appends a log line; returns the updated ticket. Allowed: todo -> ready, ready -> running, running -> review, review -> done, running -> ready (retry), review -> running, any -> blocked, blocked -> ready, todo/ready/running/review/blocked -> cancelled. `done` can only change by a change order (use `reopenTicket`). An illegal move throws `code: 'ticket-transition'`. A ticket may become `ready` only when every dependency is `done` (else `code: 'ticket-deps'`).
- `readyTickets(tickets)`: tickets with status `todo` or `ready` whose dependencies are all `done`, sorted by id.
- `wavesOf(tickets)`: the dependency layering of tickets that are not cancelled: `[[ids], ...]`, wave n holds tickets whose dependencies are all in earlier waves; a cycle throws `code: 'ticket-cycle'` naming the ids.
- `filterTickets(tickets, { stage, status, type, risk, requirement, file })` (each optional, `requirement` matches `scopeRefs`, `file` matches `files`).
- `ledgerStats(ledger)` returns `{ total, byStatus, byStage: { S1: { total, done } }, percentDone (done / not cancelled, whole number), coveragePct (requirements whose tickets are all done / requirements, from ledger.requirements if present else null) }`.
- `renderBuildPlan(ledger, scope)` returns Markdown for `docs/scope/build-plan.md`: header (scope name and version, percent done, ticket counts by status, change orders), a table per stage (ticket id, title, status, risk), and a requirement table (R id, text, tickets, done/partial/missing).
- `approveLedger(ledger, { by, now })` sets `approved: { at, by, scopeHash }` (returns a new ledger); `isApproved(ledger)`.

## 3. Integrity checks: `tools/scope-integrity.mjs`

- `checkTicketTree({ scope, tickets, sizeBudget })` returns `{ ok, errors: [{ code, message, ... }], warnings, coveragePct, uncovered: [R ids], untraced: [ticket ids], missingAcceptance: [ids], badRefs: [{ ticket, ref }], unknownDeps: [{ ticket, dep }], cycles: [[ids]], conflicts: [{ wave, file, tickets: [ids] }], oversize: [ids] }`. Rules: every requirement is referenced by at least one ticket (`uncovered`), every non-human non-contract ticket references at least one real requirement (`untraced`, `badRefs`), acceptance present for build/test/migration tickets, no ticket depends on an unknown ticket or forms a cycle, no two tickets in the same wave (see `wavesOf`) own the same file or one owns a folder (a path ending `/`) that contains the other's file (`conflicts`), size S or M only and at most `sizeBudget.maxMediumPerStage` M tickets when given. `ok` is true when `errors` is empty; uncovered, untraced, cycles, conflicts and oversize are errors; missing acceptance is an error for the three types above.
- `summarizeTree({ scope, tickets, rates })` returns `{ stages: [{ id, title, tickets, requirements }], tickets, byType, byRisk, coveragePct, waves, humanTickets, sensitiveTickets, estimate: { minutes, usd }, risks: [string] }`; the estimate uses `rates` (`{ perTicketMinutes: 2, usdPerTicket: 0.003, parallel: 64 }` defaults): minutes = waves x perTicketMinutes plus ceil(tickets / parallel) x perTicketMinutes, usd = tickets x usdPerTicket; risks name uncovered requirements, human tickets that block others, sensitive tickets, and any wave wider than 200 tickets.
- `formatSummary(summary)` returns a plain-text approval summary of at most 40 lines.

## 4. Change orders: `tools/change-orders.mjs`

- `diffScopes(oldScope, newScope)` returns `{ added: [R ids], removed: [R ids], changed: [R ids] (same id, text or acceptance differs), stagesAdded, stagesRemoved }`.
- `impactAnalysis({ diff, tickets })` returns `{ cancel: [ticket ids] (every one of whose scopeRefs was removed), reopen: [ticket ids] (done or review tickets that reference a changed requirement), retag: [{ ticket, remove: [R ids] }] (tickets that also reference removed ones but keep others), needTickets: [R ids] (added requirements plus changed ones with no ticket), affected: [ticket ids], estimate: { newTickets, usd } }`.
- `nextChangeOrderId(ledger)` returns `CO-001`, `CO-002`, ... from `ledger.changeOrders`.
- `applyChangeOrder(ledger, { impact, diff, reason, by, now, scope })` returns a new ledger: cancelled tickets get status `cancelled`, reopened tickets `todo`, retagged tickets lose the removed refs, `scope` (name, version, hash) replaces the old one, and `changeOrders` gets `{ id, at, by, reason, diff: counts, impact: counts, cancelled: [...], reopened: [...] }`. History is never deleted: cancelled tickets stay in the ledger.

## 5. Day 0 checklist: `tools/day0.mjs`

- `DAY0_CATALOG`: an array of `{ id, name, kind, keywords: [lower-case words], steps: [string] }` for: stripe (payments), domain (domain and DNS), email (SendGrid, Postmark, Resend, SES), auth-google, auth-apple (sign in with Apple), sms (Twilio), hosting (Vercel, Fly, Cloudflare, AWS), error-tracking (Sentry), analytics, maps (Google Maps, Mapbox), push (Firebase Cloud Messaging, APNs), storage (S3, R2), app-store (Apple Developer account, listing, privacy policy, review submission), play-store (Google Play developer account and listing), secrets-vault. Steps are short imperative sentences ("Create a Stripe account and switch it to test mode").
- `day0Checklist(scope, { extra = [] } = {})` returns `[{ id: 'H-001', service, kind, why: [R ids or 'external'], steps }]` in catalog order: a catalog entry is included when a keyword appears as a whole word (case-insensitive) in any requirement text or acceptance line, in the overview, or in an `external` entry; every `external` entry that matches nothing in the catalog gets a generic item (`steps: ['Decide who owns the account', 'Create it and record where the keys go']`); `extra` entries (same shape) are appended. Ids are stable `H-001...`.
- `checklistToTickets(items, { startAt = 9001 })` returns human tickets `{ id: 'T-9001', title: 'Day 0: <service>', type: 'human', stage: 'S0', epic: 'E-00 Day 0', scopeRefs: [], acceptance: [], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', steps }`.

## 6. Contracts first: `tools/contracts-schema.mjs`, `tools/contracts-gen.mjs` and `tools/contracts.mjs` (generate, do not write)

The generator is split in two modules plus a re-export: `tools/contracts-schema.mjs` exports `validateOpenApi`, `generateTypes`, `generateValidators`, `generateSeed` and the shared helpers `resolveRef(doc, ref)`, `operationsOf(doc)` (array of { method, path, operationId, parameters, requestSchema, responseSchema, status }) and `schemaNames(doc)`; `tools/contracts-gen.mjs` imports those and exports `generateClient`, `generateMockServer`, `generateContractTests` and `contractFiles`; `tools/contracts.mjs` only re-exports everything from both.

All pure functions over an OpenAPI 3 document given as a JS object (the caller parses JSON; YAML is not supported). Supported subset: `paths` with `get/post/put/patch/delete`, `operationId` (required), path and query `parameters`, JSON `requestBody`, `responses` with a JSON schema for the first 2xx, `components.schemas` and local `$ref` (`#/components/schemas/Name`). Schema types: object (properties, required), array (items), string (enum, format `date-time`, `email`, `uuid`, `date`, minLength, maxLength), number, integer (minimum, maximum), boolean.

- `validateOpenApi(doc)` returns `{ ok, errors }` (missing operationId, unresolved $ref, unsupported type, duplicate operationId).
- `generateTypes(doc)` returns the text of a `types.d.ts` (one `export interface` or `export type` per component schema, plus `<OperationId>Request` and `<OperationId>Response` types).
- `generateValidators(doc)` returns the text of an ES module exporting `validate<SchemaName>(value)` returning `{ ok, errors: [string] }` (checks type, required, enum, min/max, string formats) for every component schema, and `validators` (a map by name).
- `generateClient(doc)` returns an ES module exporting `createClient({ baseUrl, fetchImpl = fetch })` that returns an object with one async function per operationId taking `{ path, query, body }` and returning `{ status, body }`, with path parameters substituted and encoded.
- `generateSeed(doc, { seed = 1, count = 5 })` returns `{ [SchemaName]: [objects] }` of deterministic example data (a small seeded PRNG; strings like `name-3`, emails, uuids and dates derived from the PRNG, enum picks, numbers within min/max); every object passes the generated validators.
- `generateMockServer(doc, { seedData })` returns the text of an ES module exporting `createMockServer({ port = 0 })` using `node:http`: for each path it answers the first 2xx example: GET collections (a response schema that is an array) return the seed rows of the item schema, GET with an `{id}` path parameter returns the row with that `id` or 404, POST/PUT/PATCH validate the JSON body against the request schema (400 with `{ errors }` when invalid) and answer 201 or 200 with the body plus a generated `id` when missing, DELETE answers 204, unknown routes 404 JSON; it returns `{ server, url, close() }`.
- `generateContractTests(doc)` returns the text of a `node:test` file that, given `process.env.CONTRACT_BASE_URL`, calls each operation with generated valid input and checks the response status and that the body passes the generated validators (skipped when the variable is unset): these run against both the mock and the real API.
- `contractFiles(doc, options)` returns `{ 'contracts/types.d.ts': text, 'contracts/validators.mjs': text, 'contracts/client.mjs': text, 'contracts/mock-server.mjs': text, 'contracts/seed.json': text, 'contracts/contract.test.mjs': text }`.

## 7. Approval policy: `tools/approval-policy.mjs`

- `DEFAULT_APPROVAL = { autoMergeToStageBranch: true, humanApprovals: ['scope', 'contracts', 'design-gallery', 'final-stage-pr'], changeOrderOverUsd: 20, budgetUsd: null }` (frozen).
- `validateApprovalPolicy(raw)` returns `{ policy, errors }` (unknown keys are errors; `humanApprovals` an array of known names; `changeOrderOverUsd` a non-negative number; `budgetUsd` null or a positive number; `autoMergeToStageBranch` boolean).
- `needsHuman(policy, event)` returns true when the event needs the owner: `{ kind: 'scope' | 'contracts' | 'design-gallery' | 'final-stage-pr' }` when the kind is in `humanApprovals`; `{ kind: 'change-order', usd }` when `usd > changeOrderOverUsd`; `{ kind: 'merge-to-stage-branch', testsPassed, reviewPassed }` is true unless autoMergeToStageBranch is true and both are true; `{ kind: 'spend', usd }` when `budgetUsd` is set and `usd` exceeds it; any other kind returns true (fail closed).
- The project profile gets an optional `approval` block validated by this function.

## 8. Tickets to a run: `tools/ticket-manifest.mjs`

- `ticketsToManifest(tickets, { ledger, scope, ready = true, contract, maxJobs })` returns a manifest `{ version: 1, concurrency, contract?, jobs }` from the ready tickets (or from the given list when `ready` is false): one job per ticket with `id` the ticket id, `type` (`build` for build, migration and contract tickets; `test` for test; `docs` for docs; design tickets are skipped), `agent: 'auto'`, `sensitive: ticket.sensitive`, `hard: true` when risk is high, `prompt` built from the ticket (title, the scope text and acceptance of each referenced requirement, the ticket's own acceptance criteria, the rule "work only on the files you own; report the ticket id"), `context` (ticket.context plus ticket.contracts, deduplicated; the contract file is included), `outputs: ticket.files` (a folder entry ending `/` is not allowed in outputs and is skipped with a warning), `after` listing dependencies that are in the same manifest, `acceptance: ticket.acceptance` only when the job's agent could be the rented lane (always include it: it is harmless elsewhere only if the manifest validator accepts it; the validator does), `timeoutMs: 600000`. Human tickets are emitted as `{ id, type: 'human', title, steps }` jobs. The result also carries `warnings: [string]` (not part of the manifest object returned for running: return `{ manifest, warnings, skipped: [ids] }`).
- `ticketOutcome(state, ledger)` maps a finished run's job states to ticket moves: complete -> `review`, failed/timeout -> `blocked` with the error, held/skipped -> unchanged; returns `[{ id, to, note }]`.

## 9. Commands: `tools/scope-commands.mjs`

`runScopeCommand(root, args, deps)` handles `swarm scope template|check|split|approve|sync`, `swarm tickets`, `swarm ticket <id>`, `swarm change "<text>"` and `swarm go --scope`; returns `{ stdout, exitCode }`. `scope split` writes a split manifest (one job per stage that returns a JSON ticket list for that stage into `.swarm/project/split/<stage>.json`; run it with `swarm run`), `scope split --ingest <runId>` reads those files, validates them, assigns ids, runs the integrity checks and writes the (unapproved) ledger; `scope approve` runs the checks again, prints the summary and, with `--yes`, records the approval; `swarm go --scope` refuses an unapproved ledger and runs the ready tickets through `ticketsToManifest`. `swarm brief` and autopilot show ticket progress when a ledger exists.

## Done when

A real scope with at least 100 requirements splits into 300+ tickets with 100% coverage, zero untraced tickets after review, and the owner's approval; `swarm go --scope` runs them in waves with hundreds in flight; a change order mid-build adds and cancels the right tickets; contracts-first codegen produces a working mock API and seed data in seconds.

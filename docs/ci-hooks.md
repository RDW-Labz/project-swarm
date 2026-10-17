# Skeleton first, smoke tests and preview deploys (Phase 15)

Generic hooks you configure per project. The swarm never picks or contacts a service by itself: it runs the commands you put in the project profile, and only in queue integration. Nothing here deploys to production.

## Skeleton first

Mark the thinnest vertical slice of the first stage (database, API, screen, test) with `skeleton: true` on its tickets; the split prompt asks for this. While any skeleton ticket is open, `swarm go --scope` runs only the skeleton (and the tickets it depends on, and runner-made fix tickets), so connection bugs show on day 0, before the fan-out. `swarm go --scope --skip-skeleton` overrides it for one run. `swarm scope split --ingest` warns when a ledger of 30 or more tickets has no skeleton ticket.

## Smoke tests and preview deploys after each green batch

In `.project-swarm.json`, under `profile`:

```json
"ci": {
  "smoke":   { "argv": ["npx", "playwright", "test", "--grep", "@smoke"], "timeoutSec": 600, "everyBatches": 1 },
  "preview": { "argv": ["vercel", "deploy", "--yes"], "timeoutSec": 600, "everyBatches": 1 }
}
```

`argv` is a program name or relative path plus arguments (no shell). After each batch that passed its checks, `smoke` runs on the checkout (the running copy); then `preview` (every `everyBatches`-th batch for each). Only a short list of environment variables is passed to either command (PATH, HOME, USER, LANG, LC_*, TERM, TZ, CI, NODE_ENV, PORT, TMPDIR, SWARM_PORT_BASE); tokens, `SSH_AUTH_SOCK` and database URLs are not, so log in to your deploy tool beforehand (its own login in your home folder works). The script a hook runs (for example `scripts/smoke.mjs`) and `package.json` for npm, pnpm, yarn, npx and bun become protected paths, so a worker's job cannot edit what runs with your rights; if a batch changes one of them anyway the hook is skipped with a warning.

A `preview` command with `--prod`, `--production`, `promote`, `-p`, a `prod` or `production` word in any argument, a shell (`sh -c ...`) or `-c` is refused when the profile is read. This is a safety net, not a guarantee: tools that deploy to production by default (for example `fly deploy` or `firebase deploy`) must be wrapped by you in a preview-only command.

A hook that fails or times out never rolls the batch back. It is recorded in the run state (`mergeQueue.ci`), warned about, and, when the project has a ticket ledger, becomes a fix ticket (`origin: ci`, risk high, files and context are the batch's files, a short failure summary from the local brain when it answers within 15 seconds, otherwise the redacted tail). The runner reseals your approval over the new ticket (only if it was valid just before) and records the ticket in `approved.ciTickets`; any other change to the ticket set still removes the approval. The failure summary reaches a worker prompt as labelled, capped, untrusted log text; the brain makes the summary only when the project profile says `sensitive: false`, otherwise the redacted tail is used. A passed preview records its URL (the first `https://` URL in its output). Playwright mobile emulation and simulators are whatever your smoke command runs; the swarm only starts the command and reads its exit code.

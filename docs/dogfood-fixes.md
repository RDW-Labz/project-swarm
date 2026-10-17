# What the first real project taught (parts request app)

The first full dogfood logged 27 lessons (kept as lesson files in `lessons/parts-request-app/`). These are the fixes, and what to set in a project to get them. Design: [dogfood-fixes-design.md](plans/dogfood-fixes-design.md).

## Tests run before a ticket counts as done

Add a `verify` block to the profile in `.project-swarm.json`:

```json
"verify": {
  "command": ["npm", "test", "--", "{tests}"],
  "setup": [["supabase", "start"]],
  "testEnv": { "DATABASE_URL": "postgres://127.0.0.1:54322/postgres" },
  "agent": "claude", "model": "sonnet-shell", "timeoutSec": 900
}
```

- A ticket lists its proof in `tests` (a build ticket lists the test files its test ticket owns and depends on that ticket). Tickets with tests go to a worker that can run commands (a Claude shell job, or Codex with an explicit `model`): the `setup` commands run once outside the sandbox (for example a local Supabase), the worker gets `testEnv`, runs the tests, and fixes what fails before it hands in. `"agent": "none"` keeps the cheap lane and relies on the merge queue.
- `testEnv` is for local, non-secret values: names containing KEY, JWT, DSN, SESSION, COOKIE, CERT, SIGN, PASS, AUTH, SECRET, TOKEN, PRIVATE or CREDENTIAL, JWT-shaped values, and URLs with a password to anything but this machine are refused. Anything a test needs from the tool itself comes from a setup command's own output. The script files named in `setup` or `command` become protected paths, the `package.json` scripts that an npm, pnpm, yarn or bun command runs cannot be changed by a batch (the gate blocks it; `package.json` itself stays writable), and a batch that changes `verify`, `context`, `ci`, `approval`, `security` or `protectedPaths` in `.project-swarm.json` is blocked by the gate.
- The same command runs on every merge-queue batch (only the affected tests, with the full run every few batches). `swarm scope sync RUN --integrated` marks a ticket done only when the runner itself saw the `tests` check pass; a worker's own report is not evidence. A ticket is bound to the run that handed it in (`sync RUN` records it), and the batch that integrated it must have passed, with the security gate not blocking. A ticket whose tests failed goes back to `ready` once with the failure text; the second failure blocks it. If the profile names a `verify` block but does not validate, `sync` refuses instead of switching the gate off.

## Tickets get their context automatically

`swarm scope approve` writes `docs/scope/context/overview.md` (the overview and every reference section of the scope) and `docs/scope/context/data-model.md` (sections titled data model, schema, tables or database). Each ticket's job gets, shared files first (cached): the overview, `package.json`, the contracts, then by kind: database tickets the data model; UI tickets the design files (`docs/design/tokens.json`, the README, `components.css`, and up to two screens whose names match the ticket); API and test tickets their entries. Only regular files inside the project qualify: symlinks anywhere in a path, `.env*` files (except `env.example.txt`), keys, certificates, the profile's protected paths and files over 60000 bytes are skipped with a warning. Name more files in the scope itself:

```
## Context
- docs/scope/scope-original.md [db]
- docs/design/tokens.json [ui]
- docs/glossary.md
```

(`[kinds]` are `db ui api test all`; no kinds means all.) Or set `profile.context: { shared, db, ui, api, test }`. Prompts also say: migrations are DDL only, use the versions in `package.json`, and the project's package manager.

## Contracts and the mock

A `contract` ticket must write exactly one OpenAPI 3 JSON file under `contracts/` (split and ingest enforce it). `swarm scope contracts --yes` finds it, generates the types, validators, client, mock and contract tests, then runs those tests against the mock and fails when they are red. A write operation's mock answer is the response schema's own example, never the request echoed back.

## Paths, package manager, build output, audit exceptions

- The split prompt asks for repo paths with their folders and shows the project layout (a `## Layout` section in the scope, or the repo's first two folder levels). Ingest refuses bare names that do not live at the root, `.env*` names (use `env.example.txt`), contract tickets that are not OpenAPI JSON, other managers' lockfiles, and build output (`.next/`, `node_modules/`, `dist/`, `*.tsbuildinfo`).
- The package manager is the profile stack's (`swarm init` detects it): prompts carry it; tickets writing another lockfile are refused. For npm, a `package.json` change with no lockfile is audited through a lockfile built in a temp folder (nothing is installed or run; only registry dependency specs go in, npm uses empty config files and no credentials).
- `swarm init` and `scope approve` add the usual build-output lines to `.gitignore`; a re-init keeps the `security`, `approval`, `ci`, `verify` and `context` blocks.
- Known, accepted advisories: `security.acceptedAdvisories: [{ "package": "eslint-config-next", "id": "GHSA-...", "reason": "dev-only lint chain", "reviewBy": "2026-12-31" }]`. They pass with a warning until `reviewBy`; after it the block returns. An entry with an `id` covers a package's finding only when every advisory id of that finding is named by a live entry; an entry with no `id` covers the whole package (your explicit, broader choice). Malformed entries (an `id` that is not a string, `reviewBy` not a real date, a reason outside 5 to 300 characters) are dropped and the block stays.

## Smaller fixes

`go --scope` checks the manifest before any ticket moves to running; human tickets close directly; a Python-style ticket list is repaired; secret file names in requirement text are hidden from the split prompt; a worker answer that writes a new file with an empty-`find` edit is treated as a whole-file write. Still open: Day 0 detection of out-of-scope text (1), init changing the install version (2), approving a reviewed workflow manifest (14), config tickets for tools used in acceptance (16), editing ticket files by command (17), the pgTAP pattern in the db prompt (21), never killing processes by loose pattern (26), a rendered check for UI tickets (27).

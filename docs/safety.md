# Safety: panic button, state backups, safe migrations

## `swarm stop --all` (panic button)

Acts at once: no confirmation and no flag to skip a step. In this order, each step on its own (one failing never skips the next):

1. Writes `.swarm/stop.json` first (before anything else is loaded). While it exists `swarm run`, `go`, `autopilot`, `resume`, `sweep`, `scout`, `ship`, `merge`, `integrate`, `gpu up` and `gpu bakeoff` refuse (`stopped`), and a running autopilot loop stops at its next step; help (`swarm run --help`), `status`, `cancel`, `stop`, `backup` and `restore` still work.
2. Stops the autopilot (first, so it cannot start a new run in the gap) by the exact PID in its lock: SIGTERM, then one SIGKILL. The PID is signalled only when `ps` shows it is a swarm autopilot; a lock with a dead PID is a stale lock (nothing to do); a live PID that is not an autopilot, or a lock with no usable PID, is a failed step and nothing is signalled. Never by a process-name pattern.
3. Cancels every run that could still start work and waits (up to 15 s) until none is left. A `running` run gets the cancel file (its runner stops the jobs); a `paused`, `queued`, `pending` or `held` run is cancelled in place (its unfinished jobs become `cancelled`, the pause is cleared, so a later resume has nothing to start). Finished runs are left alone.
4. If a rented GPU session exists: `swarm gpu down` (three tries), then checks the session is gone. A node that could not be reached over ssh is a **failed** step (the session record is removed either way, so this is checked from the down result). swarm never rents, so the output always says to terminate the instance in the provider console (powering off does not stop billing). A failed step prints `BILLING RISK`.
5. Takes a state backup (reason `stop --all`).

Exit 0 when every step is ok or had nothing to do; exit 2 when any step failed. `swarm stop --status` shows the marker; `swarm stop --clear` lets runs start again.

## State backups

`swarm backup [--reason TEXT]`, `swarm backup list`, `swarm backup verify ID`, `swarm restore ID [--yes]`.

- What is copied: `.swarm/project` (ticket ledger, log, scope state), `.project-swarm.json`, `.swarm/ui/results.json`, the journal. Never a secret (matched on the lower-cased path: `.env*`, key, token, secret, credential, password, private key, `id_rsa`, `.pem`, `.p12`, `.npmrc`, `.netrc`, `gpu-session`), a symlink, a file whose real parent is outside the project, or anything under `.swarm/backups`. A symlinked `.swarm` or `.swarm/backups` is refused.
- Each backup is `.swarm/backups/<id>/` with a `manifest.json` of SHA-256 hashes; `swarm backup verify` re-hashes it. The newest 20 are kept. One is taken at every `swarm scope approve` and by `swarm stop --all`.
- `swarm restore ID` shows the plan; with `--yes` it verifies the backup, takes a `pre-restore` backup of the current state (so a restore can be undone with `swarm restore <that id> --yes`), then writes the files back. Only swarm's own state can be restored (a planted backup naming `tools/x.mjs` or `package.json` is refused, also in the plan), the files are read and hash-checked into memory before anything is written, and the backup being restored is never pruned by the pre-restore backup. Files that are not in the backup are left alone.

## Safe migrations

`swarm init` turns the check on for a **new** project (no profile yet) that already has a migrations folder (`supabase/migrations`, `prisma/migrations`, `drizzle` or `db/migrations`): it writes `"migrations": {"dir": ..., "down": "sibling"}` to the profile and says so (`migrations-check-on`). An existing project keeps what it has: without the block it only gets a note when migration files change, and the owner turns it on by hand. To turn it off, remove the block. Hand-set `ui`, `quality` and `migrations` blocks survive a re-init.

To set it up by hand, add a `migrations` block to the project profile (`"migrations": {}` turns on the defaults):

```json
"migrations": { "dir": "supabase/migrations", "down": "sibling", "commands": { "up": ["npm","run","db:up"], "down": ["npm","run","db:down"], "seed": ["npm","run","db:seed"] } }
```

The merge queue then checks every changed migration file before the batch's tests:

- **Down step:** `down: "sibling"` needs `X.down.sql` next to `X.sql`; `down: "section"` needs a `-- migrate:down` section with a statement.
- **Destructive changes** (drop table/column/schema/view/sequence/type/function/extension/database, truncate, delete or update without a top-level where, alter column type, rename) and **privileged calls** (`COPY ... PROGRAM`, `CREATE EXTENSION`, `pg_read_file`, `lo_import` and similar) block the batch; the SQL is scanned with comments and string literals blanked, quoted identifiers kept as words, and dollar-quoted bodies (`DO $$ ... $$`) read as code and open a `human` item in the inbox. The owner runs `swarm migrations approve FILE [--note TEXT]`; the approval is bound to the file's hash, so any later edit needs a new one.
- **Round trip:** with `commands.up` and `commands.down` set it runs up, seed, down, up with no shell and a short environment (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, `DOCKER_HOST`, `DOCKER_CONFIG`; never provider keys; add names such as `DATABASE_URL` with `"env": ["DATABASE_URL"]` in the block). The seed command must produce synthetic data; a seed that names a dump or prod path is refused.
- A change to a down file re-checks its migration; `.SQL` files and subfolders count; an invalid block blocks (it does not fall back to the defaults); the inbox item is added once per file and hash.
- A project without the block gets a note in the queue's security notes when migration files change, not a refusal.

`swarm migrations [check [--yes]]` runs the same checks by hand (`--yes` also runs the round trip).

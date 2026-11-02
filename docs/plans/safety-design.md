# Safety group: panic button, state backups, safe migrations

Spec: docs/plans/swarm-more-upgrades-spec.md (A3, panic button and state backups). Three pure-ish modules, wired by hand into `tools/swarm.mjs`.
All modules are ES modules with no dependencies. Every filesystem or process effect goes through an injected `deps` object so tests need no real processes.

## 1. tools/stop-all.mjs (panic button)

`swarm stop --all` acts at once (no confirmation, no flag to skip a step). `swarm stop --status` shows the marker. `swarm stop --clear` removes it.

```
export const STOP_FILE = '.swarm/stop.json';
export async function readStopMarker(root)            // -> {at, reason} | null (never throws; bad JSON -> {at:null, reason:'unreadable marker'})
export async function stopGuard(root)                 // -> null | {code:'stopped', message}  message: 'stopped: swarm stop --all ran at T; run swarm stop --clear first'
export async function clearStop(root)                 // -> {cleared:boolean}
export async function runStopAll(root, deps)          // -> {ok, billingRisk, steps:[{name,status,detail}]}
```

`runStopAll(root, deps)` order (each step catches its own errors, never throws, never skips the next step):

1. `marker`: write `.swarm/stop.json` `{at: ISO, reason: deps.reason ?? 'swarm stop --all'}` mode 0600 FIRST, so nothing new starts while the rest runs.
2. `runs`: `deps.listRuns(root)` returns `[{id, status}]`; for each with status `running` call `deps.cancelRun(root, id)`; then poll `deps.listRuns` every `deps.pollMs` (default 500) until none is `running` or `deps.waitMs` (default 15000) passed. Status `done` (all stopped), `failed` with detail `still running: id1, id2` otherwise, `nothing` when none were running.
3. `autopilot`: `deps.readAutopilotPid(root)` returns a pid or null. A pid: `deps.kill(pid, 'SIGTERM')`, poll `deps.isAlive(pid)`; after `deps.waitMs` send `SIGKILL` once, poll again. Exact PID only, never a pattern. `done` when gone, `failed` when still alive, `nothing` without a pid.
4. `gpu`: `deps.gpuSession()` returns the session or null. With a session: call `deps.gpuDown()` up to 3 times (one second apart); verify with `deps.gpuStatus()` (must report no session / `deps.gpuSession()` null). `done` when verified; `failed` otherwise. A failed gpu step sets `billingRisk: true` and the detail says: `the rented node may still be billing: terminate the instance in the provider console now`.
5. `backup`: `deps.backup(root, {reason:'stop --all'})` best effort; a failed backup is a `failed` step like any other.

`ok` is true only when no step is `failed`. The CLI exits 0 on ok, 2 on any failure, and always prints one line per step.

## 2. tools/state-backup.mjs

Snapshots of swarm's own state, never of secrets or app code.

```
export const BACKUP_DIR = '.swarm/backups';
export const BACKUP_INCLUDE;                  // frozen array of repo-relative paths/dirs: '.swarm/project', '.project-swarm.json', '.swarm/ui/results.json', 'coordination/journal.ndjson'
export function isSecretPath(rel)            // true for any path with a segment starting '.env', or matching /(secret|token|credential|api[-_]?key|gpu-session|\.pem|\.key)/i
export async function createBackup(root, { reason, now = Date.now, keep = 20 } = {})   // -> {id, files:N, bytes, reason}
export async function listBackups(root)       // -> [{id, at, reason, files, bytes}] newest first (skips unreadable ones)
export async function verifyBackup(root, id)  // -> {ok, problems:[...]} re-hashes every file against manifest.json
export async function restoreBackup(root, id, { yes = false, now = Date.now } = {}) // -> {id, restored:[...], skipped:[...], preRestore:id|null, planned:boolean}
```

Rules:
- Id is `YYYYMMDD-HHMMSS-<4 hex>` (UTC from `now`); the backup is `.swarm/backups/<id>/files/<rel>` plus `manifest.json` `{version:1, id, at, reason, files:[{path, sha256, bytes}]}`. Id must match `/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/`; anything else is refused (no path tricks).
- Walk each include path; copy regular files only (a symlink or special file is skipped and listed nowhere); skip `isSecretPath` files and anything under `.swarm/backups`; cap 5000 files and 50 MB total (`backup-too-large` error).
- Write each file with a temp name then rename; write `manifest.json` last (a backup without a manifest is incomplete and ignored by `listBackups`).
- After writing, keep only the newest `keep` backups (delete older ones by id, only inside `BACKUP_DIR`).
- `restoreBackup` without `yes` only returns `planned: true` with the file list. With `yes`: `verifyBackup` first (refuse `backup-corrupt` on any problem), take a `pre-restore` backup of the current state (its id is returned, so a restore can be undone), then copy each file back through a temp file and rename; never write outside `root`, never through a symlink (refuse `unsafe-path`). Files that exist now but are not in the backup are left alone.

## 3. tools/migration-gate.mjs

```
export const MIGRATION_DEFAULTS = Object.freeze({ dir: 'supabase/migrations', down: 'sibling', commandTimeoutMs: 300000 });
export function validateMigrationsConfig(raw)     // -> {ok, config, errors}; raw {dir, down:'sibling'|'section', commands:{up, down, seed}} each command an argv array of strings; unknown keys are errors
export function isMigrationFile(file, config)     // repo-relative path in config.dir, ends .sql, not .down.sql
export function downFileFor(file)                 // 'a/001_x.sql' -> 'a/001_x.down.sql'
export function destructiveStatements(sql)        // -> [{kind, line, text}] ; kinds: drop-table, drop-column, drop-schema, truncate, delete-all, alter-type, rename, update-all
export async function checkMigrations({ files, config, read, exists, approvals = [] }) // -> {ok, problems:[{file, check, message}], needsApproval:[{file, sha256, statements}]}
export async function runRoundTrip({ root, config, exec }) // -> {ok, steps:[{name, ok, tail}]}
export async function readApprovals(root)         // .swarm/project/migration-approvals.json -> [{file, sha256, at, note}]
export async function addApproval(root, { file, sha256, note, now })
```

Rules:
- `files` are the changed repo-relative paths of the batch; only migration files are checked. `read(file)` returns the bytes (Buffer) and `exists(file)` a boolean.
- Down step: with `down: 'sibling'` the file `X.down.sql` must exist and be non-empty; with `down: 'section'` the migration must contain a line `-- migrate:down` followed by at least one statement. Missing: problem `no-down` with message `migration X has no down step (add X.down.sql)`.
- Destructive statements are found on SQL with `--` line comments and `/* */` block comments and string literals blanked out first, case-insensitive: `drop table`, `drop column` (inside alter table), `drop schema`, `truncate`, `delete from t` with no `where` before the next `;`, `update t set ...` with no `where`, `alter column ... type`, `rename column|to`. Only the UP part counts (text before `-- migrate:down` for `section` mode; the whole file for `sibling` mode).
- A destructive migration is OK only when `approvals` holds an entry with the same `file` and the sha256 of the file's current bytes (so any later edit needs a new approval). Otherwise it goes in `needsApproval`, and `ok` is false (problem `needs-approval`, message `migration X drops or rewrites data (drop-table line 3): the owner must run swarm migrations approve X`).
- `runRoundTrip` runs `config.commands.up`, `down`, `seed` (when set) and `up` again through `exec(argv, {cwd: root, timeoutMs})` -> `{code, stdout, stderr}`; stops at the first failing step; `tail` is the last 400 chars of its output. Without `commands.up` and `commands.down` it returns `{ok:true, steps:[]}` (nothing to run). The order is exactly `up`, `seed`, `down`, `up`; `seed` is skipped when not set.
- No real data: the check refuses a `commands.seed` argv that mentions a path containing `dump`, `prod` or `.sql.gz` (problem `seed-looks-real`).

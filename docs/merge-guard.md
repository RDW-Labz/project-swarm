# Merge guard

`swarm merge PR [--repo OWNER/NAME]` squash-merges a pull request, deletes its branch and updates the local default branch, and it refuses unless every check on the PR head is green. There is no flag to skip that: `--force`, `--admin`, `--skip-checks` and every other flag are refused (`merge-flag-refused`).

Every item of the PR head's check list counts on its own (no replacing an older run by a newer one: a stale failed or cancelled run that GitHub still lists blocks until it is gone or rerun), and a required check from branch protection that has not reported yet counts as pending. It refuses when: the PR is not open, has conflicts, or is not yet known to be mergeable (re-read up to four times); its base is not the default branch (retarget a stacked PR first); no checks are reported; any check is failing or pending, required or not (a rerun replaces an older failed run of the same check, only the newest counts); another open PR is stacked on this one's branch (deleting the branch would close it: retarget those first). The merge itself uses `--match-head-commit`, so a push after the check cannot slip in. The result is one JSON line (`merged`, `refused` with the reasons and the failing and pending check names, or `merge-failed`); the exit code is 0 only for `merged`.

`swarm ship` follows the same rule: `--wait-required-only` still limits what ship waits for to start, but right before the merge ship reads the PR again (same head commit required), looks at every check, waits until pending ones settle or the timeout passes (`ci-pending`) and refuses at once for failing ones (`ci-failed`, `checks not green: ...`). Merge pull requests with `swarm merge`, not by hand.

## Locks

### Integration lock (long hold)

`acquireIntegrationLock` takes two directory locks, both created with `mkdir` and holding `owner.json`:

- **Branch lock (machine-wide, shared across worktrees):** `<liveDir>/locks/integrate-<hash>`, where the hash is derived from the repository identity and the integration target branch. The branch comes from the explicit `branch` option, else from `git symbolic-ref --short HEAD`, else a per-worktree key `detached:<worktree-root>` for a detached HEAD. Only one integrate may hold a given repository plus branch key at a time; worktrees on different branches do not block each other.
- **Root lock (per worktree):** `<worktree>/.swarm/integration.lock`. Each worktree has its own; refusing this lock does not block integrates in other worktrees.

If the root lock cannot be taken after the branch lock was acquired, the branch lock is released again (so a later acquire for that branch can succeed). Stale integration locks clear when the owner is dead on this host or the lock directory is older than 60 seconds without a valid owner (integrate-specific stale rules).

Plain `integrate`, every `--queue` pass, and `redcheck` use this lock.

### Shared write lock (short hold, repo-wide)

`withSharedWriteLock` serializes writers for a named repo-shared file using `<liveDir>/locks/shared-<hash>` (hash from repository identity plus the lock name). Callers in `tools/swarm.mjs` today:

| Lock name | Shared file | Caller |
| --- | --- | --- |
| manifest ledger path or `.swarm/usage-ledger.md` | usage ledger markdown | `runManifestBody` |
| `notified.json` | `.swarm/project/notified.json` | autopilot `notify` handler in `main` |
| `tickets.json` | `.swarm/project/tickets.json` | `scale` full-practice `ledger.write` callback in `main` |

Defaults: wait up to 10 seconds to acquire (25 ms poll); warn if the callback runs longer than 5 seconds; treat a lock as stale after 30 seconds without a live owner (or when the owner PID is not alive), then clear it and retry.

### Known unprotected shared writes

Writes under `tools/swarm.mjs` and `tools/swarm/*.mjs` that update repo-shared paths (via `safeWritableDir` / project journal paths) without `withSharedWriteLock`:

| File | Function | Shared target |
| --- | --- | --- |
| `tools/swarm.mjs` | `runManifestBody` | `.swarm/claude-provider-limit.json` |
| `tools/swarm.mjs` | `main` (`scale` full-practice `ledger.write`) | `coordination/journal.ndjson` |
| `tools/swarm/core-2.mjs` | `securityFingerprintKey` | `.swarm/project/security-key` |
| `tools/swarm/core-51.mjs` | `appendRunLedger` | usage ledger path (also used from `writeRunLedger` without the shared lock) |
| `tools/swarm/core-61.mjs` | `applyQueuePlans` | `.swarm/project/journal.ndjson` via `appendEvent` |
| `tools/swarm/core-21.mjs` | `dispatchPolicyCli` (`policy check`) | `.swarm/project/journal.ndjson` via direct `appendFile` in `appendJournal` |

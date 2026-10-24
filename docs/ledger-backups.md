# Ticket ledger backups (outside the checkout)

The ticket ledger lives under `.swarm/project/` in your checkout. If that tree is deleted or the worktree is removed, in-repo backups from `swarm backup` go with it.

## Where backups live

Ledger snapshots are stored under:

`~/.project-swarm/ledger-backups/<key>/`

The `<key>` is `<checkout-basename>-<first-12-hex-of-sha256(real-path)>`, so the same physical checkout always maps to the same key even if you rename the folder later.

Each change snapshot is a directory named `<UTC-timestamp>-<first-8-hex-of-ledger-sha256>/` containing `meta.json` plus copies of ledger files that existed at backup time (`tickets.json`, `tickets.log`, scope snapshot markdown files, `brain-ledger.ndjson`, `backlog.json`). Secret paths and security-key material are never copied.

Set `PROJECT_SWARM_HOME` to redirect the parent directory (used in tests).

## Retention

- Up to **50** newest change snapshots per key (older complete snapshots are removed).
- **Daily** copies under `daily/YYYY-MM-DD/` keep the last change from each UTC day for **90** days.

Identical ledger content (same `tickets.json` hash as the newest snapshot) is not written again.

## Automatic backups

Every successful `writeLedger` triggers a best-effort backup (5s cap). Disable with `PROJECT_SWARM_NO_LEDGER_BACKUP=1`. Backups are skipped for roots under the OS temp directory unless `PROJECT_SWARM_HOME` is set.

## Restore

```bash
# Snapshot now
swarm backup ledger now

# List snapshots for this checkout
swarm backup ledger list

# Find a ledger after the checkout is gone
swarm backup ledger list --all

# Plan restore (does not overwrite)
swarm backup ledger restore latest

# Restore into this checkout (backs up current ledger first)
swarm backup ledger restore latest --yes

# Restore a specific key into another directory
swarm backup ledger restore ID --from KEY --into /path/to/checkout --yes
```

Restore refuses to overwrite an existing `tickets.json` without `--yes`, takes a pre-restore snapshot first, and verifies the ledger SHA-256 after copy.

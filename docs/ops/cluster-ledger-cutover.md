# Cluster ledger cutover (Mac mini + MacBook)

Migrate from two independent local ticket ledgers to one shared cluster ledger. The canonical machine runs the HTTP listener in `tools/cluster-ledger-api.mjs` (HMAC node auth, tailnet verification). Followers dial it via `tools/cluster-client.mjs` (fail-closed: timeouts, `redirect: 'error'`, host validation—no silent local fallback). Combine existing ledgers once with `tools/ledger-merge.mjs` before cutover.

**Roles**

| Machine | Role | Config |
| --- | --- | --- |
| **Mac mini** | **Canonical** — owns `tickets.json` / lease state under its project root; runs the cluster-ledger listener | `remoteClusterMode: true` in local config (`SWARM_CONFIG` / `tools/local-config.mjs`) |
| **MacBook** | **Follower** — queue claim/release go to the canonical API | `clusterCanonicalHost` set to the Mac mini’s tailnet hostname (see `resolveClusterCanonicalHost` in `tools/cluster-client.mjs`) |

Port: `SWARM_CLUSTER_LEDGER_PORT` or config `clusterLedgerPort`, default **9448** (`DEFAULT_CLUSTER_LEDGER_PORT`). Listener binds **127.0.0.1** only; expose to the tailnet with **`tailscale serve`** separately (see comment at top of `tools/cluster-ledger-api.mjs`).

Node registry (no registration API yet): each machine’s node id and secret live in `~/.project-swarm/nodes/registry.json`, or `SWARM_NODES_REGISTRY_FILE`, or under `SWARM_HOME` → `nodes/registry.json` (`nodesRegistryFile` in `tools/cluster-ledger-api.mjs`). The follower’s entry must exist on the **canonical** machine before remote claim/release will authorize.

---

## 1. Cutover procedure

Work on the **same git checkout / project root** you will treat as canonical (Mac mini). The merge **target** is that root. Paths below use `MINI_ROOT` and `BOOK_ROOT` for the two full project-swarm repo checkouts.

### 1.1 Merge the two local ledgers (dry-run, then apply)

`mergeTicketLedgers` in `tools/ledger-merge.mjs` is **dry-run by default** (`apply` omitted or `false`). It merges `tickets.json`, `.swarm/security-reviews/records.json`, and `.swarm/project/journal.ndjson`. **Ticket id collisions are a hard error** (`ticket-id-collision`); resolve them before apply.

From the repo root (on either machine, with both trees reachable):

```bash
cd "$MINI_ROOT"

# Report only (default): collisions, counts, merge notes
node --input-type=module -e "
import { mergeTicketLedgers } from './tools/ledger-merge.mjs';
const r = await mergeTicketLedgers({
  mini: process.env.MINI_ROOT,
  book: process.env.BOOK_ROOT,
  target: process.env.MINI_ROOT,
});
console.log(JSON.stringify({ ok: r.ok, report: r.report, notes: r.notes, collisions: r.collisions }, null, 2));
if (!r.ok) process.exit(1);
"
```

Review `report.collisions`, `report.merged`, and `notes` (including security-review merge notes). Fix any `ticket-id-collision` on disk before continuing.

When the dry-run is clean (`ok: true`, `report.wouldWrite: true`):

```bash
node --input-type=module -e "
import { mergeTicketLedgers } from './tools/ledger-merge.mjs';
const r = await mergeTicketLedgers({
  mini: process.env.MINI_ROOT,
  book: process.env.BOOK_ROOT,
  target: process.env.MINI_ROOT,
  apply: true,
});
console.log(JSON.stringify({ ok: r.ok, wrote: r.wrote, report: r.report }, null, 2));
if (!r.ok) process.exit(1);
"
```

Confirm writes under the target root: `tickets.json` (via `ledgerPath`), `.swarm/security-reviews/records.json`, `.swarm/project/journal.ndjson` (`applyMergedOutputs`).

Copy or sync this merged tree to the Mac mini if merge ran elsewhere. The MacBook should use the **same** ticket ledger content on disk only until follower mode is enabled; after cutover, lease authority is the canonical API, not a second copy of lease files.

### 1.2 Start the canonical listener (Mac mini)

On the Mac mini project root, in local config:

```json
{
  "remoteClusterMode": true,
  "clusterLedgerPort": 9448
}
```

(Optional: `clusterLedgerHosts` array for Host allowlist on the server, same as remote board.)

Restart the project-swarm process that calls `startClusterLedgerListener` (`tools/cluster-ledger-api.mjs`). When `remoteClusterMode === true`, it listens on `127.0.0.1` and the resolved port; when false, it does not listen.

Expose the local port on the tailnet (do not bind the listener on `0.0.0.0`):

```bash
# Example: tailnet HTTPS to local HTTP listener (adjust to your tailnet Serve setup)
tailscale serve --bg http://127.0.0.1:9448
```

API routes (POST unless noted): `/api/cluster/ledger/claim`, `/api/cluster/ledger/renew`, `/api/cluster/ledger/release`; GET `/api/cluster/ledger/read`.

### 1.3 Provision the follower node on the canonical registry

There is **no** self-service registration endpoint. On the MacBook, note this machine’s node id (from your node identity setup) and the matching `nodes.<nodeId>.secret` in **its** local `registry.json`.

Copy that **id + secret** entry onto the Mac mini’s canonical registry **out of band** (e.g. `scp` over Tailscale). Merge into `version: 1` / `nodes: { ... }` on the mini—do **not** commit secrets, email them, or paste them in chat.

```bash
# Example: copy follower's registry to mini for manual merge (edit nodes{} on mini to add one entry)
scp book:~/.project-swarm/nodes/registry.json /tmp/book-registry.json
# Edit ~/.project-swarm/nodes/registry.json on the mini to include the MacBook node id + secret
```

The canonical server reloads registry via `readNodeRegistry` on each request.

### 1.4 Configure the follower (MacBook)

On the MacBook, set **`clusterCanonicalHost`** to the Mac mini’s tailnet DNS name (hostname only—no scheme, port, or path; validated by `assertClusterCanonicalHost`):

```json
{
  "clusterCanonicalHost": "mac-mini.example.ts.net"
}
```

Use the same `clusterLedgerPort` / `SWARM_CLUSTER_LEDGER_PORT` as the canonical side if not default 9448. Do **not** set `remoteClusterMode: true` on the follower.

Ensure the MacBook still has its own node id + secret in **its** local registry (used to sign requests in `clusterLedgerRemoteFetch`).

### 1.5 Verify before relying on the follower

From the **MacBook** project root, run a real queue round-trip through the remote API (orchestrator uses `cluster-client` when `followerRemoteClusterConfigured` is true):

```bash
# Pick a ticket id that exists and is claimable in the merged ledger
swarm queue claim T-XXXX
swarm queue release T-XXXX
```

Both commands must succeed without `cluster-request-failed`, `cluster-request-timeout`, `cluster-host-missing`, or `unauthorized` errors. Repeat a claim/release from the Mac mini if it also uses the shared API for leases in your setup.

Only after this works should you depend on the follower for production queue work.

---

## 2. Rollback (canonical API unreachable)

`tools/cluster-client.mjs` **fails closed**: network errors, timeouts (default **15s**), non-OK HTTP, invalid JSON, and redirects throw (`cluster-request-failed`, `cluster-request-timeout`, etc.). There is **no** automatic fallback to local lease files.

### 2.1 Return a machine to local-only mode

On any machine that must keep working during an outage:

1. Remove or unset **`clusterCanonicalHost`** (follower).
2. Set **`remoteClusterMode`** to false or remove it (canonical)—stops `startClusterLedgerListener` from binding a listener.

Restart the swarm/orchestrator process so config is reloaded. Queue operations use local ledger/lease behavior again on that machine.

**Warning:** During split-brain, two machines may both mutate **local** lease state or ticket data. Treat that as two divergent ledgers until reconciled.

### 2.2 Reconcile after the API is healthy again

When the canonical listener is back and both trees are reachable, merge divergent state the same way as initial cutover:

1. Identify which roots hold the post-outage truth for **tickets** (often re-point `mini` / `book` at the canonical checkout vs the laptop checkout).
2. Run `mergeTicketLedgers` **without** `apply: true` first; fix any `collisions` / `ticket-id-collision`.
3. Run with **`apply: true`** on the chosen **target** root (usually the Mac mini canonical tree).
4. Re-enable `remoteClusterMode` on the mini, `tailscale serve`, and `clusterCanonicalHost` on the book; verify `swarm queue claim` / `release` again.

Use merge **notes** in the dry-run output to inspect security-review and ticket consistency warnings (`enrichTicketReviewConsistency`).

---

## 3. Disable legacy hand-off branches

The old **manual hand-off branch** workflow (coordination via `HANDOFF.md` and independent ledgers per machine) must stay authoritative until the shared ledger is proven.

**Do not** turn off hand-off coordination until **both** machines:

- Have completed section 1 (merged ledger on canonical, listener up, follower configured, registry provisioned), **and**
- Can **`swarm queue claim`** and **`swarm queue release`** through the remote API **without error** on each machine (section 1.5).

Then confirm there is no window where neither mechanism is valid: shared API is the single lease authority, both nodes authenticate (`x-swarm-node-id`, `x-swarm-timestamp`, `x-swarm-signature`), and you are not still relying on manual branch hand-off for ticket ownership.

Only after that confirmation, stop using the HANDOFF-driven manual coordination between Mac mini and MacBook for queue/lease authority. Keep the hand-off docs/process archived or updated so operators do not follow two conflicting procedures.

---

## Quick reference

| Item | Value |
| --- | --- |
| Canonical config | `remoteClusterMode: true`, optional `clusterLedgerPort`, optional `clusterLedgerHosts` |
| Follower config | `clusterCanonicalHost` (tailnet hostname of mini) |
| Registry file | `$SWARM_NODES_REGISTRY_FILE` or `$SWARM_HOME/nodes/registry.json` or `~/.project-swarm/nodes/registry.json` |
| Merge tool | `tools/ledger-merge.mjs` → `mergeTicketLedgers({ mini, book, target, apply?: boolean })` |
| Default port | 9448 (`SWARM_CLUSTER_LEDGER_PORT` / `clusterLedgerPort`) |
| Exposure | `127.0.0.1` listener + **`tailscale serve`** |

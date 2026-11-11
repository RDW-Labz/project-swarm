# Download batching — shared npm cache + batch prefetch

**For Braden and his agents (review bots + chief-of-staff):** this is an infrastructure/performance
change only, ordered by Michael (2026-11-11). It changes WHERE npm downloads land and HOW a wave's
downloads are fetched. It does not change what npm resolves, what any ticket produces, the security
gate, any test, or any check semantic. Measured gains and the exact revert are at the bottom.

## What the swarm downloads

The swarm's own code fetches over the network in exactly one production path: npm packages for
tickets that declare `dependencies` (`tools/dep-install.mjs`).

1. **Resolve** (`dependencyWrites`, at integrate): `npm install --package-lock-only` in a scratch
   folder builds the new `package.json`/`package-lock.json`, which the security gate then audits.
2. **Install** (`installDependencies`, after the gate passes): `npm install` into the project's
   `node_modules` from the approved lockfile.

Everything else network-shaped is not a download path: worker sandboxes are offline by design
(the shell profile even sets `npm_config_offline: 'true'` for jobs), API lanes talk to model
providers, and `tools/model-watch.mjs` polls the Hugging Face API for metadata JSON.

## What was wrong

The resolve ran with `npm_config_cache` pointed at a folder **inside the per-ticket scratch
directory** — and the scratch directory is deleted when the resolve finishes. Every ticket
therefore resolved against a cold, empty cache and re-downloaded every tarball and packument,
including packages the previous ticket on the same machine had fetched minutes earlier. It is the
npm twin of the bug field lesson #278 fixed for uv ("the fresh, empty, per-run directory was the
bug"): uv got a shared warm cache, npm never did. On top of that, a wave's tickets download
**serially** — ticket N+1's fetch starts only after ticket N integrated — and overlapping specs
(lodash in three tickets) are downloaded once per ticket.

Measured baseline (2026-11-11, this repo's own resolve invocation, 4 tickets:
`[lodash, nanoid]`, `[lodash, zod]`, `[express]`, `[lodash, express, chalk]`):
**17.80 s wall, 14.54 MB downloaded** — lodash fetched 3×, the express tree 2×, cache deleted 4×.

## What changed

- **`tools/dep-install.mjs` — one shared machine cache.** New export
  `resolveSharedNpmCacheDir()` mirrors `resolveSharedUvCacheDir` in `tools/claude-shell.mjs`:
  `SWARM_NPM_CACHE_DIR` env override wins, `off` disables, otherwise the machine's standard npm
  cache (`~/.npm`) — the same cache the operator's own npm use already keeps warm. The resolve
  uses it instead of the in-scratch cache; the post-gate install now names it explicitly too, so
  the install reuses the tarballs the resolve already fetched instead of downloading them twice.
  npm still revalidates registry metadata on its normal rules, integrity hashes still verify,
  and the produced `package.json`/`package-lock.json` bytes are npm's output either way.
- **`tools/dep-prefetch.mjs` — new standalone batch prefetch.** Collects the union of specs from
  CLI arguments and/or `--from-manifest <file.json>` (jobs' and tickets' `dependencies`), dedupes,
  validates each with the same `validDependencySpec`, and fetches the whole batch in **one** npm
  invocation into the shared cache. npm fetches in parallel, bounded by `--maxsockets`, which comes
  from config: `SWARM_DL_CONCURRENCY` (1..64, default 15 = npm's own default — nothing is
  hardcoded). It writes nothing to any project: scratch manifest/lockfile are throwaway, scripts
  never run, and the gate still audits every real change at integrate time, unchanged. Run it
  before a wave (or from the chief's session) to make every ticket in the wave a cache hit:

  ```
  node tools/dep-prefetch.mjs --from-manifest coordination/manifests/<wave>.json
  ```

- **`tests/dep-prefetch.test.mjs` — new tests** pinning the cache-dir resolution, the concurrency
  clamp, manifest spec union, and the single-invocation/dedup/shared-cache fetch shape. No existing
  test was touched.

Nothing else changed: no workflow files, no check definitions, no sandbox profile, no gate.

## Measured after (same download set, same machine, same day)

| Path | Wall clock | Bytes over the wire |
| --- | --- | --- |
| Before: 4 tickets, per-ticket throwaway cache | 17.80 s | 14.54 MB (with duplicates) |
| After: one batch prefetch (cold cache) + the same 4 resolves | **5.05 s** | **9.48 MB, each package once** |
| After: shared cache alone, warm (2nd identical wave, no prefetch) | 2.93 s for 4 resolves | ~0 (cache hits) |

Per-ticket resolve after prefetch: 0.42–0.68 s (vs a 4.45 s average before). Verified end-to-end
through the real `dependencyWrites`: prefetch 3.6 s cold, then resolves in 0.76 s / 1.19 s with
identical change outputs (`package.json` + `package-lock.json`).

## Revert

- Instant, no code change: set `SWARM_NPM_CACHE_DIR=off` — resolve and install fall back to the
  exact legacy behaviour (per-run scratch cache; install on the default cache).
- Full revert: `git revert` this change. `tools/dep-prefetch.mjs` and its test are new files;
  nothing else in the repo references the prefetch tool, so removing it cannot break a caller.

# Test isolation guard

The test suite must not read or write machine-wide swarm state under `~/.project-swarm` (lane claims, live runs, spend ledgers, or default config paths). `tools/test-isolation.mjs` exports `assertTestIsolation`, which throws `test-not-isolated` when `node --test` runs without the suite setup and code would fall back to those real paths.

## Running tests

Always use the npm script or the same flags it wraps:

```sh
npm test
# equivalent:
node --import ./tests/_isolate-config.mjs --test tests/*.test.mjs tests/*/*.test.mjs
```

`tests/_isolate-config.mjs` sets `SWARM_TEST_ISOLATED=1`, redirects `HOME`, `SWARM_CONFIG`, and related paths into temp directories, and keeps daily spend limits out of your real config.

## Production

Normal swarm commands do not set `NODE_TEST_CONTEXT`, so `assertTestIsolation` is a no-op and production behavior is unchanged. Explicit env overrides (`SWARM_LANES_DIR`, `SWARM_LIVE_DIR`, `SWARM_SPEND_DIR`, `SWARM_CONFIG`) also skip the guard because the caller chose a path.

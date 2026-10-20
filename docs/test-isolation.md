# Test isolation

Swarm tests must not touch your real machine config, spend store, lane claims, or live-run directory. Always use the isolated test entrypoint.

## Run tests

```bash
npm test
```

That is `node --import ./tests/_isolate-config.mjs --test tests/*.test.mjs`.

One file:

```bash
node --import ./tests/_isolate-config.mjs --test tests/your-file.test.mjs
```

Never run `node --test` without `--import ./tests/_isolate-config.mjs`. The import runs before test code and builds the sandbox.

## Without isolation

`tests/_isolate-config.mjs` sets `SWARM_TEST_ISOLATED=1`, moves `SWARM_CONFIG` into a temp `config.json`, and points `HOME`, git/npm config, and XDG dirs at temp trees under `SWARM_TEST_TMP`.

Skip the import and tests use the same paths as a normal local `swarm` session. One test used the machine's real lane claims and waited about 40 minutes on a claim held by another live run.

## `assertTestIsolation`

`tools/test-isolation.mjs` exports `assertTestIsolation(what, env = process.env)`. Production code calls it before using machine-local paths unless a test override is already set:

- **Machine config** — label `config` (`SWARM_CONFIG` is set by the setup import).
- **Spend directory** — label `spend store` unless `SWARM_SPEND_DIR` is set.
- **Lane claims** — label `lane claims`.
- **Live-run directory** — label `live runs` unless `SWARM_LIVE_DIR` is set.

If `NODE_TEST_CONTEXT` is unset, it never throws (CLI use is fine). Inside `node --test`, if `SWARM_TEST_ISOLATED` is missing, it throws instead of touching real paths.

## `test-not-isolated`

The error message starts with `test-not-isolated`, names the resource (`what`), says it would use a real machine path, and tells you to use `npm test` or `node --import ./tests/_isolate-config.mjs --test`. See `tests/isolation-check.test.mjs`.

## Child `git` / `node` processes

Tests that `spawn` children often copy `process.env`. Under Claude Code, `CLAUDECODE` may be set on the parent. Children that inherit it can run with Claude Code session behavior, which breaks hermetic fixtures.

Delete `CLAUDECODE` on the env object you pass to `spawn` / `spawnSync`, or build a small explicit env instead of spreading the full parent environment.

## CI

CI runs `npm test`; local runs should match.

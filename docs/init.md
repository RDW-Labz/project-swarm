# `swarm init` v2

`swarm init` links a project to the shared install and records what the swarm needs to know about it.

```
swarm init [--check [--json]] [--sensitive | --not-sensitive] [--protect PATH]...
           [--max-usd N] [--max-tokens N] [--no-base-check] [--no-map]
swarm map [--json]
```

## The profile (`.project-swarm.json`, key `profile`)

| Field | Meaning |
| --- | --- |
| `stack` | Detected stack (node, python, go, rust) and package manager. |
| `sensitive` | `true` unless you said `--not-sensitive`. At a terminal init asks once; without one it assumes sensitive. `false` makes `go` and `plan` write lead jobs as `sensitive: false`. |
| `protectedPaths` | Paths no job may write or delete: detected `.env` files, `secrets/`-style folders, keys and certificates, plus `--protect PATH`. `.git/` and `.swarm/` are always protected. Checked by `validate`, `run` and the manifests leads write (`protected-path`). |
| `budget` | Default `maxUsd` and `maxTokens` for `go` and `plan` when you pass no flag (starts at $5 and 2,000,000 tokens). |
| `baseCheck` | The project's own checks (from `coordination/checks.json`) run once at init: `green`, `red`, `skipped` or `none`, with the commit and a short tail for each failure. |

Running `init` again keeps your answers. It refreshes the stack, the base check and the map. A flag overrides an answer.

**The base check runs your project's checks** (`npm test` and so on) the way you would, one after another, with a 5-minute limit each. Use `--no-base-check` for a project whose dependencies are not installed yet. A red base is recorded, shown as the `base-red` risk in `swarm plan`, and means failures that were there before any worker touched the code.

## The repo map (`.swarm/project/repo-map.json`)

For every tracked file: language, exports, imports resolved to project files, external packages, and whether it is a test. Plus the import graph (`importedBy`) and test-to-source links (by import, else by name). JS/TS, Python, Go and Rust are understood; other files are listed without detail. `swarm map` refreshes it incrementally: files whose size and modification time did not change are reused. `swarm plan` refreshes it when the commit changed.

## `swarm init --check`

A read-only health check: the pointer file, its version against the installed one, the profile, the checks file, the base check (and whether it was taken at another commit), the map, whether `.swarm/` is git-ignored, and whether `AGENTS.md` and `CLAUDE.md` tell agents to run `swarm brief`. One line per item (`ok`, `warn`, `FAIL`); it exits 1 only when something failed, and writes nothing, not even a journal line.

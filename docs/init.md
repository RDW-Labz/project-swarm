# `swarm init` v2

`swarm init` links a project to the shared install and records what the swarm needs to know about it.

```
swarm init [--check [--json]] [--kit NAME --kit-source PATH_OR_GIT_URL] [--sensitive | --not-sensitive] [--protect PATH]...
           [--max-usd N] [--max-tokens N] [--no-base-check] [--no-map]
swarm map [--json]
```

## The profile (`.project-swarm.json`, key `profile`)

| Field | Meaning |
| --- | --- |
| `stack` | Detected stack (node, python, go, rust) and package manager. |
| `sensitive` | `true` unless you said `--not-sensitive`. At a terminal init asks once; without one it assumes sensitive. `false` makes `go` and `plan` write lead jobs as `sensitive: false`. |
| `protectedPaths` | Paths no job may write or delete: detected `.env`-style files (also git-ignored ones), `secrets/`-style folders, keys and certificates, plus `--protect PATH`. `.git/`, `.swarm/`, `.project-swarm.json` and `coordination/checks.json` are always protected. Checked by `validate`, `run`, the manifests leads write and again when `integrate` is about to apply files (`protected-path`); names are compared case-insensitively and in NFC. A profile that is not valid makes these commands refuse (`profile-invalid`) instead of dropping the protection. Reads are blocked too: a protected path as a job's `context`, in `contextGlob` (checked after expansion) or in manifest `resources` is refused unless that job carries `allowProtectedContext` with a reason (1-200 characters, owner-written; leads cannot give it to their children, and it never opens writing). Symlinks are resolved first: a context, output or delete path whose real path is protected is refused as that path, and one that resolves outside the project is refused (`path-outside-project`). |
| `budget` | Default `maxUsd` and `maxTokens` for `go` and `plan` when you pass no flag (starts at $5 and 2,000,000 tokens). |
| `baseCheck` | The project's own checks (from `coordination/checks.json`) run once at init: `green`, `red`, `skipped` or `none`, with the commit and a short tail for each failure. |

Running `init` again keeps your answers. It refreshes the stack, the base check and the map. A flag overrides an answer.

**The base check runs your project's checks** (`npm test` and so on), one after another, with a 5-minute limit each, in their own process group and with a small environment (no API keys or tokens). Because that runs commands that come with the repository, it never runs unasked: `--base-check` runs it, a terminal is shown the commands and asked, and anything else skips it and says so (`base-check-skipped`). Use `--no-base-check` to skip without the note. A red base is recorded, shown as the `base-red` risk in `swarm plan`, and means failures that were there before any worker touched the code.

## The repo map (`.swarm/project/repo-map.json`)

For every tracked file: language, exports, imports resolved to project files, external packages, and whether it is a test. Plus the import graph (`importedBy`) and test-to-source links (by import, else by name). JS/TS, Python, Go and Rust are understood; other files are listed without detail. `swarm map` refreshes it incrementally: files whose size and modification time did not change are reused. `swarm plan` refreshes it when the commit changed.

## `swarm init --check`

A read-only health check (exit 1 when anything FAILs). A missing, empty or runnable-check-less `coordination/checks.json` is a **FAIL**: nothing would verify the work. the pointer file, its version against the installed one, the profile, the checks file, the base check (and whether it was taken at another commit), the map, whether `.swarm/` is git-ignored, and whether `AGENTS.md` and `CLAUDE.md` tell agents to run `swarm brief`. One line per item (`ok`, `warn`, `FAIL`); it exits 1 only when something failed, and writes nothing, not even a journal line.

## After init

A new project's whole setup, in order, is in [new-project.md](new-project.md). `swarm init` also installs the Orchestrator-lane hooks (and, for a project linked for the first time, the hand-build guard) in `.claude/settings.local.json` (see [the Orchestrator lane](orchestrator-lane.md) and [the guard](handbuild-guard.md)); `.swarm/orchestrator/off` and `swarm handbuild uninstall` opt out.

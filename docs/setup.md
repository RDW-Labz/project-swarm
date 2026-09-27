# Setup and first run

Any agent can orchestrate Project Swarm: Claude Code, Codex CLI, Cursor, Gemini CLI or others. Workers use the chosen CLI or API adapter independently of the orchestrator. Start with the [agent kickoff prompt](kickoff.md). It does not attach to an existing terminal or run a background service. `install.mjs --user` does register the skill in your agent homes (`~/.claude`, `~/.codex`) so a supporting agent can discover it automatically, but it never updates itself and never touches credentials.

## Requirements

- Node.js 20.3 or newer.
- For Claude jobs only: Claude Code installed, authenticated, and available as `claude` on your PATH.
- For Claude jobs only: a Claude CLI version supporting the adapter's restricted mode, safe mode, explicit tool selection, noninteractive permissions, strict MCP configuration, and streaming JSON output.
- A project whose files you are authorized to send to the selected model provider.

The initial real-provider validation was on macOS. Linux is an intended platform; run the tests and a smoke exchange in your environment. Windows is not a supported platform claim for this release.

This package has no runtime npm dependencies. Claude Code is installed and authenticated separately. API adapters need no provider SDK: see [provider setup](providers.md) for environment authentication and local Ollama. This project does not provide model access or replace your provider's billing and account setup.

## Check the checkout

From your Project Swarm checkout:

```sh
node --version
claude --version
npm test
node tools/swarm.mjs doctor
```

`doctor` checks local prerequisites and CLI flag compatibility. A successful diagnostic does not establish that authentication, billing, a requested model, or network access will work. A real smoke job provides that evidence. It also reports `toolchains` (expected directory, whether it exists, and any configured toolchain path that still resolves under the OS tmp dir, which macOS purges after a few days unread) as advice only — see [manifest reference](manifest-reference.md#toolchains).

Read [the security boundaries](../SECURITY.md) before copying sensitive files into a worker context. Add `.swarm/` to your project's `.gitignore`; local run records can contain source code, prompts, and provider responses.

## One shared install per machine

Project Swarm uses a single shared install per machine instead of a copy inside every project. Clone (or update) it once at `~/.project-swarm` (or choose another directory and invoke its runner explicitly), then register the skill for every agent home on the machine:

```sh
node ~/.project-swarm/tools/install.mjs --user
```

This writes `skills/project-swarm/SKILL.md` and its `references/` guides into `~/.claude/skills/project-swarm/` and `~/.codex/skills/project-swarm/`, whichever of those agent homes already exist on this machine (it reports any it skipped), with the skill's runner placeholder resolved to this install's `current/tools/swarm.mjs` path. It also provides a resolved shared skill at `<install>/current/skills/project-swarm/SKILL.md` for any agent, including when neither agent home exists. It is idempotent; runtime snapshots and install records stay in the shared install. It refuses to run from a checkout with uncommitted changes to `tools/` or `skills/` unless you pass `--dev`, so a development checkout can't silently masquerade as a release.

## Upgrading while runs are live

Each install snapshots `tools/`, `package.json`, and the rendered skill with its reference guides into `versions/<version>-<hash>/` and atomically repoints a `current` symlink at that snapshot; the skill's runner path is `<install>/current/tools/swarm.mjs`, never a path directly under `tools/`. A run already in progress resolved its own version dir's real path when it started, so `git pull` plus a later `install.mjs --user` never rewrites files under a live run: `current` moves on to the new snapshot for the next run, while the in-progress one keeps importing the files it started with. Installing from unchanged runtime and skill/reference content reuses the existing snapshot instead of creating a new one. Old snapshots are pruned automatically, keeping the 5 newest plus whichever one `current` still points to.

## Link a project

From the shared install, point one project at it:

```sh
node ~/.project-swarm/tools/install.mjs /path/to/your-project
```

This writes a small pointer file, `<project>/.project-swarm.json` (`{"install": "<absolute install root>", "version": "<installed version>"}`), and registers the project path in the install's own `.swarm-projects.json` so `swarm update --projects` can find it later. It seeds each missing `coordination/` example and ORCHESTRATOR.md, HANDOFF.md, TASK.md and swarm-lessons.md, reporting `added` and `kept` paths. Existing files are never overwritten. It appends or updates marker-delimited blocks in AGENTS.md and CLAUDE.md and writes `.cursor/rules/project-swarm.mdc`; each points to the installed skill, kickoff guide and orchestrator seat. Use `--no-agent-files` after the project path to leave these agent files untouched. It does not copy `tools/`, `tests/`, or `skills/` into the project, and does not change package scripts, global settings, credentials, or the target's Git remote.

Run commands against that project with `--root`:

```sh
node ~/.project-swarm/tools/swarm.mjs --root /path/to/your-project doctor
```

Without `--root`, the runner uses its own install directory as the project. `update` and `version` refuse `--root` before any git operation; invoke those commands on the shared install runner without a project root. With `--root`, manifests, copied inputs, outputs, and `.swarm/` records are all resolved in the selected project. An explicit root is not permission to use files from other projects as context. If the project's `.project-swarm.json` version differs from the running install's version, `run` and `validate` print one warning line to stderr and continue.

## Run the smallest useful exchange

From the shared install itself, use `examples/smoke.json`. From a linked project, use `coordination/swarm-smoke.json` and `--root` instead. The smoke assignment needs no project context. Before running a review example in another project, read it and adapt its explicit file paths to files that exist there. Context paths are relative to the selected project root, not relative to the manifest's directory.

```sh
node ~/.project-swarm/tools/swarm.mjs validate examples/smoke.json
node ~/.project-swarm/tools/swarm.mjs run examples/smoke.json
```

In a linked project, the equivalent commands are:

```sh
node ~/.project-swarm/tools/swarm.mjs --root /path/to/project validate coordination/swarm-smoke.json
node ~/.project-swarm/tools/swarm.mjs --root /path/to/project run coordination/swarm-smoke.json
```

The runner prints a run ID and remains attached while its workers execute. Substitute that ID below:

```sh
node ~/.project-swarm/tools/swarm.mjs status <run-id>
node ~/.project-swarm/tools/swarm.mjs inspect <run-id>
```

Review the worker's response and every proposed file in `.swarm/workspaces/<run-id>/<job-id>/`. Inspect also reports integration readiness; it does not approve the content for you.

Only after review:

```sh
node ~/.project-swarm/tools/swarm.mjs integrate <run-id>
```

Run the target project's relevant tests and inspect its actual behavior. A successful worker process or integration is not a substitute for application validation.

## Troubleshooting

- **Unsupported Claude flag:** inspect `claude --help` and the `doctor` report. Use a compatible CLI version. Do not remove restricted-mode or tool restrictions merely to make a job start.
- **Authentication or unavailable model:** inspect the job's `stderr.log` and `provider.jsonl` locally. Correct the provider setup outside the worker, then start a new run. Do not put credentials in a manifest.
- **Missing context:** supply an explicit existing file path relative to the selected project root. Directory names and glob patterns are not accepted.
- **Integration conflict:** preserve the newer project content. Start a fresh task from that content or manually review the proposed changes; the runner intentionally does not force an overwrite.
- **A worker says it ran tests:** tool-free API and restricted Claude/Hermes/Qwen workers cannot run shell tests. Codex workers can test their committed worktree; the coordinator still verifies the integrated project.
- **Stale `running` status after a machine or runner crash:** inspect the records and processes you own. Status files are historical evidence, not proof that a process is alive. Never kill an unrelated terminal based on a stale PID.
- **Stale integration lock:** confirm no integration is active before manually removing `.swarm/integration.lock`. Locks are not silently discarded after crashes.
- **A project still has its own `tools/swarm.mjs` and `skills/`:** that is an old per-project copy from before the shared-install model. Run `node ~/.project-swarm/tools/swarm.mjs update --projects` to see it reported, then again with `--yes` to replace it with a pointer; the old files are moved into a timestamped `.swarm-old-copy-*/` folder in that project, never deleted.

For upgrades, run `node ~/.project-swarm/tools/swarm.mjs update` in the shared install. It refuses if `tools/` or `skills/` have uncommitted changes, verifies the install is its own project-swarm git checkout, fetches tags, validates the selected release package, checks out the newest semantic `v*` tag, reinstalls the skill, and reports the changelog sections between your previous and new version. It is a no-op if you are already on the newest tag. Nothing updates itself: run this only when you decide to.

## Public download

Anyone can clone the toolkit without a GitHub account or invitation:

```sh
git clone https://github.com/RDW-Labz/project-swarm.git
```

The owner name in the URL is the source repository location. You do not sign into that account. You can also download the source archive from the release page. Model execution still uses your own provider setup.

`doctor all` lists all eight adapters without making network requests by default. `doctor all --probe-local` opts into a short HTTP health probe only for loopback Ollama and self-hosted Lambda endpoints. It sends no credentials, follows no redirects and makes no model request. Remote endpoints and cloud keys are never probed. Reports distinguish `configured`, `reachable` (HTTP health only), and `unreachable`; `reachable: null` means not checked. `configured` means a required environment key is present, or a local Ollama endpoint is selected; it does not prove service health or model access. Each run checks only its selected providers. Default concurrency is 2; set `concurrency` to an integer from 1 to 32 when you deliberately want more simultaneous workers.

## Preflight before larger assignments

Run `node ~/.project-swarm/tools/swarm.mjs --root /path/to/project preflight coordination/my-tasks.json` before dispatch. Resolve invalid paths, inspect large context/output warnings, and split independent concerns into bounded deliverables. Output-to-context dependencies use the starting snapshot, even with concurrency one: integrate the producer before starting a dependent batch, or supply an explicit stable interface contract. See [orchestration](orchestration.md) for the checklist and sizing guidance.

`monitor` now reports CLI stdout/stderr byte counts and last-output times without including worker prose in progress metadata. API workers without streaming remain explicitly unobservable. An output timestamp is an activity signal, not evidence of task correctness.

For features with a queue and background worker, reserve a dependent integration
check after the producer and consumer interfaces settle. Exercise the real
handoff with a controlled external provider; test results from the two workers
separately do not establish that queued work starts. See the
[automation integration study](automation-integration-study.md).

For automatic agent features, include the installed manager and eligible worker
in readiness checks. Use the bundled prompts and effective permission limits
in acceptance fixtures. A provider key or model name being present is not a
successful tool round trip; verify the selected route with synthetic data when
activation depends on tool use. Keep prepared, activated, and observed outcome
claims distinct. The [mission readiness follow-up](automation-integration-study.md)
records the setup and verification gaps found in a real CRM implementation.

## Keep copied source out of project tooling

Link adds `.swarm/` to `.gitignore`; it cannot configure every build tool.
Merge these exact entries into existing settings, preserving other exclusions:

- `.gitignore`: `.swarm/`
- `tsconfig.json`: `"exclude": ["node_modules", ".swarm", "**/.swarm/**"]`
- ESLint flat config: a standalone global object `{ ignores: ["**/.swarm/**"] }` in the exported array; legacy config: `"ignorePatterns": ["**/.swarm/**"]`.
- Vitest: import `configDefaults` from `vitest/config`, then `test: { exclude: [...configDefaults.exclude, "**/.swarm/**"] }`.
- Jest: add `"<rootDir>/\\.swarm/"` to `testPathIgnorePatterns` (keep existing entries).
- Playwright: add `"**/.swarm/**"` to `testIgnore` (keep existing entries).
- `pytest.ini` or `[tool.pytest.ini_options]` in `pyproject.toml`: `norecursedirs = .swarm .git node_modules .venv` (TOML uses `norecursedirs = [".swarm", ".git", "node_modules", ".venv"]`; preserve other entries).

Doctor and preflight inspect root configs as text and warn if they cannot find
an explicit exclusion. They never execute configs. Dynamic settings, inherited
configs, imports that bypass exclusions, and narrow include/test directories
need manual review; a warning is advisory and a quiet report is not proof.


## Load the skill with any orchestrator

For Claude Code, Codex CLI, Cursor, Gemini CLI or any other agent, say:
`Read ~/.project-swarm/current/skills/project-swarm/SKILL.md and coordination/ORCHESTRATOR.md.`
Cursor also discovers its always-applied project rule; agents without an
AGENTS.md convention can follow that same explicit prompt. Keep HANDOFF.md
and TASK.md current after every dispatch; use the [exact handoff](kickoff.md#handoff)
at the 10th build dispatch.

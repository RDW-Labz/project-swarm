# Agent kickoff

The orchestrator can be any agent: Claude Code, Codex CLI, Cursor, Gemini CLI,
or another agent able to read local files and run commands. The orchestrator's
host is independent of the worker adapters. Gemini CLI and Cursor can run the
swarm without being worker adapters themselves.

## Give any agent this prompt

Replace PROJECT and GOAL with your project directory and intended outcome.
This is a request to perform the installation and checks, not merely describe them.

```text
Set up Project Swarm 1.15.0 for PROJECT and use it to deliver GOAL.
Before sending code or making model calls, ask me which model providers may
receive this project's code and what spend ceiling applies. Record my answers;
wait for them before dispatch. Never ask me to paste secrets into chat.
Check Node >=20.3. Install the shared toolkit from tag v1.15.0 at
~/.project-swarm (or my chosen install directory). For a new installation:
git clone --branch v1.15.0 --depth 1 https://github.com/RDW-Labz/project-swarm.git ~/.project-swarm
If the directory already exists, verify its identity and version first; preserve
local edits, and ask before upgrading unless I have already authorized it.
Run node ~/.project-swarm/tools/install.mjs --user, then
node ~/.project-swarm/tools/install.mjs PROJECT.
Run node ~/.project-swarm/current/tools/swarm.mjs --root PROJECT doctor all.
If I chose a loopback provider, also run doctor PROVIDER --probe-local with
that same project runner. Fix configuration warnings; do not weaken isolation.
Read ~/.project-swarm/current/skills/project-swarm/SKILL.md, docs/kickoff.md
in the shared install, and PROJECT/coordination/ORCHESTRATOR.md.
Read the seeded coordination/swarm-smoke.json. Set both jobs to an allowed
provider and an explicit available model; preserve the empty reader outputs
and the writer's coordination/swarm-handshake.md output. Validate, run,
inspect both responses and the writing output, integrate, and verify the file.
Record actual provider/model, cost or unknown cost, and outcomes. Do not call
validation alone a live smoke test. If a smoke fails, fix it before build work.
Fill coordination/TASK.md from my goal and answers, set a measurable done-when,
and initialize coordination/HANDOFF.md. Plan bounded jobs, one writer per
file, explicit model/tier/tierReason and a shared contract for parallel work.
Run preflight, then begin authorized work. Keep HANDOFF.md and TASK.md current
after every dispatch, log friction in coordination/swarm-lessons.md, and hand
off at the 10th build dispatch or before unrelated work, whichever comes first,
using the exact prompt below.
```

Work already in TASK.md is pre-approved at boot; start it right away. The
human's typed confirm is needed only for new tickets, secrets, model keys,
public lessons, and anything that spends credits or money.

A dropped-in checkout can be the chosen install directory instead of cloning
again. Verify its tag with `git describe --tags --exact-match` and use that
path consistently. `PROJECT_SWARM_HOME` is a shell convenience, not a runner
lookup override: invoke the selected install's runner explicitly.
For an unreleased development checkout, `install.mjs --user --dev` is explicit
opt-in; it is not evidence that the release tag exists or has been published.

## One-line skill loading

Paste the appropriate line into your agent. Use your chosen install path if different.

| Orchestrator | Prompt |
| --- | --- |
| Claude Code | Read `~/.project-swarm/current/skills/project-swarm/SKILL.md` and `coordination/ORCHESTRATOR.md`; use Project Swarm for this project. |
| Codex CLI | Read `~/.project-swarm/current/skills/project-swarm/SKILL.md` and `coordination/ORCHESTRATOR.md`; use Project Swarm for this project. |
| Cursor | Read `.cursor/rules/project-swarm.mdc`, follow its installed SKILL.md pointer, then read `coordination/ORCHESTRATOR.md`. |
| Gemini CLI | Read `AGENTS.md`, follow its installed SKILL.md pointer, then read `coordination/ORCHESTRATOR.md`. |
| Other agents | Read `AGENTS.md`, follow its installed SKILL.md pointer, then read `coordination/ORCHESTRATOR.md`. |

These are plain prompts, not assumptions about vendor-specific slash commands.
Linking adds marker-delimited blocks to AGENTS.md and CLAUDE.md and a Cursor
rule, preserving surrounding text. Relinking updates each block in place.
Use `install.mjs PROJECT --no-agent-files` to leave agent files untouched;
it still seeds missing coordination files and adds `.swarm/` to `.gitignore`.
Each seed is reported as `added` or `kept`; existing files are never overwritten.
The shared skill works even if neither `~/.claude` nor `~/.codex` exists.

## Smoke proof

Use the seeded two-job manifest after choosing an authorized provider/model:

```sh
node ~/.project-swarm/current/tools/swarm.mjs --root PROJECT validate coordination/swarm-smoke.json
node ~/.project-swarm/current/tools/swarm.mjs --root PROJECT run coordination/swarm-smoke.json
node ~/.project-swarm/current/tools/swarm.mjs --root PROJECT inspect RUN_ID
node ~/.project-swarm/current/tools/swarm.mjs --root PROJECT inspect RUN_ID --results
# Read both responses and the proposed file; integrate only when acceptable.
node ~/.project-swarm/current/tools/swarm.mjs --root PROJECT integrate RUN_ID --require-checks
```

Read the resulting `coordination/swarm-handshake.md`. Save the evidence in
HANDOFF.md. `--require-checks` fails on declared failing checks; it does not
invent checks for a manifest that has none. `doctor` checks configuration and
CLI compatibility without network requests by default. `--probe-local` checks
only loopback Ollama/Lambda HTTP endpoints with a short timeout, no credentials,
no redirects and no model call. Cloud credentials stay configuration-only.
`configured`, `reachable`, and a successful model exchange are different facts.

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

## Handoff

Start fresh context per topic. At the dispatch limit (10 build dispatches) or
when the next work is unrelated, whichever comes first, update both tracking
files and emit:

```text
You are orchestrator. Read coordination/ORCHESTRATOR.md, then coordination/HANDOFF.md,
then coordination/TASK.md. Confirm the done-when in one line, then continue.
Paste that into a fresh terminal. This chat is done.
```

## Never do these

- Never run `update` or `version` with `--root`; they refuse before git access. Use the shared install runner without `--root`.
- Never commit `.swarm/`; it contains copied source, prompts, tests and responses.
- Never let a worker see secrets. Review every context file and committed Codex worktree; read the [security boundaries](../SECURITY.md).
- Never infer approval to send code from a configured key, or call missing cost zero.
- Never overwrite existing coordination instructions or remove isolation flags to make a run succeed.

See [setup](setup.md) for troubleshooting and the [field report](field-report.md)
for observed outcomes, known limits and executed release checks.

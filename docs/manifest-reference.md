# Manifest reference

A manifest is a JSON object with `version`, `jobs`, and optional `concurrency`. It contains task data, not shell commands or provider configuration.

```json
{
  "version": 1,
  "concurrency": 2,
  "jobs": [
    {
      "id": "review-rendering",
      "agent": "claude",
      "model": "sonnet",
      "prompt": "Review the copied renderer for concrete performance issues. Write a concise report. Distinguish measured facts from hypotheses; do not claim to have run tests.",
      "context": ["src/renderer.js"],
      "outputs": ["reviews/rendering.md"],
      "timeoutMs": 300000
    }
  ]
}
```

Replace the example paths with files in your target project.

## Top-level fields

- `version`: required, exactly `1`.
- `jobs`: required array of 1–256 jobs.
- `concurrency`: optional integer from 1 to 32; default is 2. The effective parallelism is never greater than the number of jobs.
- `checks`: optional array of at most 10 post-integration checks, run by `integrate` after it writes files. See the Checks section below.
- `mutants`: optional array of at most 32 mutation entries, checked by `integrate --mutants`. See the Mutation checks section below.
- `mutantCheck`: optional, the single check run against each mutant in `mutants`. See the Mutation checks section below.
- `preChecks`: optional array of at most 10 plain argv arrays (e.g. `["uv", "sync"]`), run in order by `integrate` before its own `checks`, but only when an integrated file's basename is a recognized lockfile (`uv.lock`, `package-lock.json`, `Cargo.lock`, `pnpm-lock.yaml`). See [Pre-checks](#pre-checks) below.
- `contract`: optional explicit existing relative file path. When set, every job's `context` must include it and no job's `outputs` may include it — only the coordinator writes it. Use this for a single file that lists every cross-job event, command, export, and field parallel jobs need to agree on; a job that needs a name not in that file should surface it rather than invent one silently. For a `codex` job, its current bytes are also injected directly into the prompt (a "Shared contract" section, read first, wins over any other file); with no `contract`, the codex prompt is unchanged. See "Shared contract" in [workflows](workflows.md).

Unknown top-level fields are rejected.

## Job fields

- `id`: required unique string, 1–80 characters. The first character is an ASCII letter or digit; remaining characters may also include `_` and `-`.
- `agent`: required: `"claude"`, `"codex"`, `"hermes"`, `"qwen"`, `"openai"`, `"gemini"`, `"ollama"`, or `"lambda"`.
- `model`: required non-empty model identifier or alias, for every job on every agent. The runner never falls back to a CLI default — for Claude, that default is the user's own, often most expensive, configured model — so an omitted `model` is refused before any worker starts. The first character is an ASCII letter or digit; remaining characters may also include `.`, `_`, `:`, `/`, and `-`. Maximum length is 120 characters. Codex instead requires `/^[A-Za-z0-9._:-]{1,80}$/` and always passes `-m <job.model>`. Syntax validation does not prove provider availability.
- `prompt`: required nonblank string of at most 100,000 characters. Include the task, expected output, and relevant acceptance criteria.
- `context`: required array of explicit existing relative file paths, at most 100 entries. These files are copied for other workers; Codex receives them as a read-first list in its HEAD worktree.
- `outputs`: required array of explicit relative file paths, at most 100 entries. Existing files are copied automatically; new files may be created. An empty array creates a job with no proposed files; Codex still has shell access inside its sandbox.
- `readPaths`: optional for `codex` and claude `shell: true` jobs only, an array of at most 100 absolute read-only paths for extra toolchains. Quotes, backslashes, and control characters are refused. Paths under `~/.oasis`, `~/Library/Keychains`, `~/.ssh`, `~/.aws`, or `~/.config` are refused, including resolved aliases. Final sandbox denies override grants.
- `maxOutputTokens`: optional for API jobs only, integer 256–32768, default 8192. This is an output limit, not a dollar budget; reasoning may consume the allowance.
- `timeoutMs`: optional integer from 50 to 3,600,000 milliseconds. Default is 300,000 milliseconds, or five minutes.
- `tier`: optional, one of `"cheap"`, `"mid"`, or `"expensive"`. A named routing decision for the coordinator, not a model catalog lookup: setting `tier` never chooses, overrides, or resolves a model. It is validated metadata, shown in `preflight` and `inspect` output for review. See [the routing checklist](orchestration.md) for when to use each value.
- `tierReason`: optional string, at most 2,000 characters. Required, and must be non-empty after trimming, whenever `tier` is `"expensive"`; the reason is what makes the choice inspectable instead of gut feel. Optional for `"cheap"`/`"mid"`.
- `ignoreTests`: optional array of at most 100 explicit existing relative file paths, same path rules as `context`. Lists test files the job knowingly leaves uncovered by `context` — see "Context check" below. Give a reason in the `prompt` when you use it.
- `after`: optional non-empty array of other job ids in the same manifest that must all reach `complete` before this job starts. See [After](#after) below.
- `web`: optional, must be `true` when present. Adds `WebSearch`/`WebFetch` to the claude worker's `--tools` and passes `--allowedTools WebSearch,WebFetch` (without the latter the restricted CLI asks for approval and, with no prompt surface, refuses). Refused when `agent` is not `"claude"` (`web is only supported for the claude agent`) or when `outputs` is non-empty (`a web job must be read-only (no outputs)`) — a web job never gets `Write`, `Edit`, `Bash`, or any other tool. See [Scout](#scout) below.
- `testEnv`: optional, `codex` and claude `shell: true` jobs only — an object of string→string set in the codex process environment, with a matching prompt line `Test environment (already set): K=V, ...` so the worker never has to rediscover a sandboxed test's required variables. Refused on any other agent (`Job <id>: testEnv is only supported for codex jobs`). Keys must match `^[A-Z][A-Z0-9_]*$`; a key containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `CREDENTIAL` is refused (`Job <id>: testEnv key <k> looks like a secret`); the key `SWARM_PORT_BASE` is always reserved for the runner itself (`Job <id>: testEnv key SWARM_PORT_BASE is reserved`) — see [Ports](#ports) below. For a claude `shell: true` job, `UV_OFFLINE`, `UV_PYTHON_DOWNLOADS`, `UV_CACHE_DIR`, and `npm_config_offline` are reserved the same way (`Job <id>: testEnv key <k> is reserved for the shell sandbox`) — see [Setup](#setup) below. Values are capped at 200 characters and may not contain newlines. See "Sandbox probe" under [doctor](#kickoff-diagnostics-and-install-commands) below.
- `resultFile`: optional repo-relative path that must also be one of the job's own `outputs` (`Job <id>: resultFile must be one of its outputs`). Optional `resultSchema`: a list of required top-level keys. See "Result file" under `inspect` below.
- `shell`: optional boolean, `claude` only (`Job <id> shell is only supported for agent claude`). `true` makes a [shell job](#shell-jobs); absent or `false` leaves argv, env and prompt byte-identical to 1.18.0.
- `networkAllow`: optional, claude `shell: true` jobs only, an array of at most 20 hostnames. In 1.19.0 only an empty array is accepted; any host is refused with `networkAllow is not yet supported` (shell jobs reach only `api.anthropic.com`).
- `mutantsFile`: optional repo-relative path that must also be one of the job's own `outputs` (`Job <id>: mutantsFile must be one of its outputs`), collected automatically by `integrate --mutants` once that output exists; the job's own worker preamble states the exact required shape, `{"name","file","find","replace"}`, up front. See [post-build mutants](#post-build-mutants).
- `contextGlob`: optional array of at most 20 simple globs, each exactly `dir/*.ext` or `dir/prefix*.ext` (no `**`, no mid-path wildcards; the directory follows the same path-safety rules as `context`). Expanded into `context` at validate/run time — never at manifest-write time — with the same byte-cap rules as `context`; a glob matching zero files is refused. `validate` echoes, per pattern, how many files it matched (`contextGlobCounts: [{"pattern", "count"}]`). See [Context check](#context-check).
- `setup`: optional, `codex` jobs and claude `shell: true` jobs only (`Job <id>: setup is only supported for codex and claude shell jobs`) — an array of at most 5 argv arrays (same rules as one `checks` entry's `argv`), run once by the swarm parent outside the sandbox, in the job's own worktree, in order, after the worktree exists and before the worker starts. See [Setup](#setup) below.
- `keepScratch`: optional boolean, claude `shell: true` jobs only (`Job <id>: keepScratch is only supported for claude shell jobs`, `Job <id>: keepScratch must be true or false`). Keeps the job's scratch dir (see "Scratch dir" under [Shell jobs](#shell-jobs) below) after the job ends instead of removing it; the path is recorded as `scratchDir` on the job record.

**Precedence:** an explicit per-job `model` always wins. `tier` is descriptive, coordinator-facing routing guidance for choosing which provider/model to put in `model` (or which worker pool to dispatch to); the runner itself does not map `tier` to a model. A job may set both: `model` decides what actually runs, `tier`/`tierReason` document why that choice was made. A manifest with no `tier` field behaves exactly as before.

Unknown job fields are rejected. Manifests cannot specify executable paths, arbitrary provider commands, environment variables, shell scripts, MCP servers, or additional tools.

## Shell jobs

A claude job with `shell: true` gets `Bash` so it can run the project checks itself (lesson 40). Presets: `model: "sonnet-shell"` expands to `{model: "sonnet", shell: true, tier: "cheap"}` and `model: "opus-shell"` to `{model: "opus", shell: true, tier: "expensive"}` (so `tierReason` is still required); the saved manifest, state and `inspect` show the real model and `shell: true`. A conflicting `tier` or `shell: false` is refused. `shell` cannot be combined with `web`. `ask` and `scout` never get a shell.

- **Workspace:** a detached git worktree of `HEAD` (like codex); cwd is the worktree. Only declared outputs are copied back for `integrate`; the worktree is removed after a clean job.
- **Scratch dir (lesson #145):** before the worker starts, the parent creates a per-job scratch dir with `fs.mkdtemp` under the OS tmp dir (mode 0700), holding `tmp/` and `home/`. The job's `HOME`, `TMPDIR`/`TMP`/`TEMP`/`CLAUDE_CODE_TMPDIR`, and `CLAUDE_CONFIG_DIR` (`<scratch>/home/.claude`) all point into it — never into `<run>/<job>/shell/`, which sits inside this project's own worktree, since some tools (pytest included) refuse to write scratch data under a path that is itself version controlled. The sandbox profile grants this dir its own realpath'd read+write allow, alongside the worktree and job dir. It is removed after the job ends — success, failure, or cancel alike — unless the job sets `keepScratch: true`, in which case its path is kept and recorded as `scratchDir` on the job record. If the OS tmp dir itself resolves inside any git repo (walking up to `/` for a `.git` entry), the job is refused outright (`scratch-inside-repo`) before the worker ever starts, the same as a failed loopback scan.
- **Sandbox:** the whole `claude -p` process runs as `sandbox-exec -f <run>/<job>/sandbox.sb <claude> ...`. Writes are allowed only under the worktree, the job's `<run>/<job>/shell/`, and the scratch dir above; the worktree's `.git` file is read-only. The home directory is unreadable except the codex toolchain caches, the CLI's own install directory and `readPaths`; `~/.oasis`, `~/.ssh`, `~/.aws`, `~/.config`, `~/Library/Keychains`, `~/.claude`, `~/.claude.json*` and `/Library/Keychains` are always denied, as are keychain mach services and other processes' info. Every ancestor directory of the worktree, up to `/`, additionally gets `file-read-metadata` (so a workspace-discovery walk like `uv run`'s can see each one exists) plus a full read grant on any `pyproject.toml`, `uv.toml`, or `package.json` literally inside it (so that walk can actually read the marker file it finds) — nothing else in those directories. Final denies still override these. On a non-mac platform or without `/usr/bin/sandbox-exec` the run is refused; a shell never runs unsandboxed.
- **Git discovery (read-only, lesson #143):** the profile also allows `file-read*` on the project root's own `.git` entry — a `subpath` grant when the root is a plain repo (`.git` is a directory), or a `literal` grant on the `.git` file plus `subpath` grants on the gitdir it points at and that repo's resolved common dir when the root is itself a linked worktree. This is read-only; no write grant is added anywhere for it. Final denies still override.
- **Network:** the profile allows outbound only to a per-job localhost CONNECT proxy that tunnels `api.anthropic.com:443`, plus (lesson #143) the job's own loopback sockets — `network-bind`/`network-inbound` and `network-outbound` on `localhost:*` (TCP and UDP) — so a project's own test suite can start and reach its own local servers. Before writing the profile, the parent lists every TCP port already listening on the host's loopback or wildcard address (via `lsof`) plus the rig-service port (`~/Library/Application Support/OASIS/rig/service.port`, default 4405), excludes the job's own CONNECT proxy port, and denies each of the rest with an explicit `network-outbound` deny placed after the loopback allow (later rules win); that list is saved as `loopbackDenied` on the job record and shown by `inspect`. An `lsof` failure refuses the job outright (`loopback-scan-failed`) before any worker starts. **Known gap:** a service that starts listening on the host *after* the job started is still reachable — only ports already listening at job start are denied. Refused non-loopback host names (never paths) are kept as `proxyRefused` in the job record and `inspect`; everything else on the host or the internet stays unreachable.
- **Tools:** exactly `--tools Read,Edit,Write,Bash,Grep,Glob` (all pre-approved via `--allowedTools`), `--strict-mcp-config` with an empty config, `--restricted --safe-mode`.
- **Auth:** the parent reads the worker key from `SWARM_CLAUDE_WORKER_API_KEY`, else the existing keychain item service `OASIS` account `anthropic.api_key` (parent only, just before the run); missing refuses the run and never falls back to the person's claude login. The key is passed only as `ANTHROPIC_API_KEY` in the child env and is redacted from saved logs.
- **Env:** allowlist only — `PATH`, `LANG`, job `HOME`/`TMPDIR`/`TMP`/`TEMP` (all pointing into the scratch dir above), proxy variables, `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (the CLI unsets credential variables, the key included, inside each Bash command), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_EXTRA_BODY`, `SWARM_PORT_BASE` (see [Ports](#ports) below), `UV_OFFLINE=1`, `UV_PYTHON_DOWNLOADS=never`, `UV_CACHE_DIR=<run>/<job>/shell/uv-cache`, `npm_config_offline=true` (see [Setup](#setup) below), and `testEnv`. Every other parent variable is dropped; `testEnv` may not use those names, `TMP`, or `TEMP`.
- **Spend label:** `CLAUDE_CODE_EXTRA_BODY={"metadata":{"user_id":"swarm-worker:<job-id>"}}` makes every Messages request carry `metadata.user_id = swarm-worker:<job-id>`.
- **Key guard:** `integrate` and `ship` refuse a shell run whose saved exchange, logs, results, proposed outputs, integrated files or ship payload contain the worker key (exact bytes), before any project or git write. An output holding the key fails its job.
- **Prompt:** the shell boilerplate says to run the manifest `checks` before reporting done and to report `"checksRun": [{"name", "status"}]`, and states `Network: you may open local test servers on 127.0.0.1 and connect to them; nothing else on this machine or the internet is reachable.` (lesson #143); `inspect` and `inspect --results` show `shell: true` and `checksRun`. A job that declares `setup` also gets `Setup already ran outside the sandbox: <argv...>. Do not run it again; the network is blocked.` — see [Setup](#setup) below.
- `validate` warns `{"code": "tests-without-shell", "jobId", "message": "Job <id> adds tests without shell: the worker cannot run them (lesson #135)"}` for a claude job without `shell` whose outputs include a tests path.
- **Venv interpreter (lesson #158):** after `setup`, the parent follows `<worktree>/.venv/bin/python` (and `python3`) symlink by symlink to its realpath, and reads `.venv/pyvenv.cfg`'s `home`; the install dir of every hop (the parent of its `bin`), and its realpath, is granted read-only when either spelling lies under `$HOME` (same deny list as `readPaths`; a denied one is only warned `venv-interpreter-denied: <dir>`). A python link that resolves nowhere refuses the job before the worker starts: `venv-interpreter-unresolvable: .venv/bin/python`. The swarm toolchains dir (`SWARM_TOOLCHAINS`, else `~/.project-swarm/toolchains`) and uv's managed-Python dir (`UV_PYTHON_INSTALL_DIR` from the parent env, else `~/.local/share/uv/python`) are granted read-only when they exist, and the child env gets `UV_PYTHON_INSTALL_DIR` so `uv` finds its interpreters even though `HOME` is job-scoped (reserved in `testEnv`).
- **Smoke check (lesson #158):** before the worker starts, the first manifest check with no `{integrated}`/`{new}` placeholder runs once as `sandbox-exec -f <profile> <argv...>` in the worktree, with the worker's env minus `ANTHROPIC_API_KEY`, for at most 30 s (still running then counts as started). Output goes to `<run>/<job>/smoke.log`. A check that could not start (spawn error, exit 127, or output naming `Operation not permitted`, `No interpreter found`, `Failed to inspect/query Python interpreter`, `command not found`, `ERR_MODULE_NOT_FOUND`, a dyld library error) refuses the job: `sandbox-cannot-run-check: <argv0>`, `sandboxCannotRunCheck` on the job record. A check that starts and fails (red before the work) is fine.
- **No git stash (lesson #163):** the prompt says never to run `git stash`, and `git` inside the sandbox is a wrapper at `<run>/<job>/shell/bin/git`, first on `PATH`, that refuses `stash` as the subcommand (after any global options) with a plain message and exit 2, and runs the real git for anything else. Codex prompts carry the same line.
- **Env file (lesson #160):** the root's `.swarm/env.json` (see [Env file](#env-file)) is added to the child env, except any key this allowlist fixes itself; `testEnv` still wins.

## File rules

Paths are relative to the selected project root. Use forward slashes. Do not use absolute paths, empty segments, `.` or `..` segments, backslashes, directories, or glob patterns. Symlinks are refused along the checked path.

`.git`, `.swarm`, `.env`, and names beginning `.env.` are reserved path segments. These checks do not recognize every possible secret filename: explicitly audit the contents you choose to copy.

Files must be regular files no larger than 16 MiB. Each job's combined copied files are limited to 32 MiB. A context file must already exist. An output may be new, including a new nested path. Duplicate entries within either array are rejected; a path may appear in both `context` and `outputs` when a worker needs to edit a file it reads.

Each output has exactly one writer per manifest. Output collisions and overlapping file/directory output paths are rejected. There is no automatic handoff of one worker's new output to another worker in the same run.

Claude read-only jobs receive `Read`, `Glob`, and `Grep`. Writing jobs additionally receive `Write` and `Edit`. These restricted adapters do not receive shell, network, delegation, or MCP tools. Codex uses a separate macOS OS sandbox and a full detached HEAD worktree, with shell access for tests; see [Codex setup and file grants](providers.md). API jobs have no tools; the runner sends only copied UTF-8 text without NUL bytes in one request and validates an exact output-file envelope before writing the copy. Cloud providers require network access; Ollama defaults to localhost.

## After

A job's optional `after` field names other job ids in the same manifest that must all reach `complete` before it starts. `validate`/`run` refuse an unknown id (`Job <id> after names unknown job <x>`), a job naming itself, duplicate ids, a cycle (`after cycle: a -> b -> a`), and `after` on a `codex` job (`after is not supported for codex jobs yet`).

A job with no `after` starts exactly as before. A job that does have `after` starts only once every job it names has status `complete`; if any of them instead ends `failed`, `timeout`, or `cancelled`, the dependent job is never started — it gets `status: "skipped"` and `error: "after <id> <status>"`. Concurrency still caps how many jobs run at once. When a dependent job starts, each output its dependencies changed is copied into its workspace and added to its own context, read-only; a dependency's output can never also appear in a dependent's `outputs` — the existing one-writer-per-file rule already refuses that. `integrate` still applies jobs in manifest order; a run containing a `skipped` job is never `status: "complete"`.

## Board

`node tools/swarm.mjs board` prints `{"runs": [{"runId", "root", "repo", "pid", "startedAt", "status", "jobs": [{"id", "status", "outputs"}]}]}`, a read-only snapshot of every live run this machine's user is tracking across every worktree of every repository — not just the current project. It reads a per-user registry under `~/.project-swarm/live` (override with the `SWARM_LIVE_DIR` environment variable); each run there is a small JSON record keyed by the project's shared git directory, so two worktrees of the same repository are recognized as the same project even though their working directories differ. A record whose process is no longer alive is pruned automatically before the summary is built. Each run's `status`/`jobs` come from that run's own saved `.swarm/runs/<run-id>/state.json`; `status` is `"unknown"` and `jobs` is `[]` when that file cannot be read (for example, a run recorded on a since-removed worktree).

Before starting any job, `run` (and therefore `go`) checks this same registry for another live run in the same repository — across worktrees — already writing one of this run's declared outputs. If it finds one, it refuses to start with `Refusing to run: <file> is also written by live run <runId> in <root>`, naming the first conflicting file and run; every conflict is listed in the error's `details.conflicts`. Nothing is registered and no job starts. There is no override flag: resolve the conflict (wait for the other run, or change one manifest's outputs) and try again. Once a run is registered, it is unregistered when the run ends, whether it completes, fails, is cancelled, or the process itself throws.

## Commands

```sh
node tools/swarm.mjs doctor all
node tools/swarm.mjs doctor openai
node tools/swarm.mjs validate examples/smoke.json
node tools/swarm.mjs run examples/smoke.json
node tools/swarm.mjs ask --model sonnet --context src/a.js,src/b.js "question"
node tools/swarm.mjs scout --model sonnet --brief docs/scout-brief-example.md "goal"
node tools/swarm.mjs sweep --model sonnet --brief docs/scout-brief-example.md --goals docs/sweep-goals-example.json
node tools/swarm.mjs status <run-id>
node tools/swarm.mjs monitor <run-id>
node tools/swarm.mjs monitor <run-id> --view
node tools/swarm.mjs monitor <run-id> --view --watch 5
node tools/swarm.mjs wait <run-id>
node tools/swarm.mjs wait <run-id> --timeout 300
node tools/swarm.mjs inspect <run-id>
node tools/swarm.mjs inspect <run-id> --results
node tools/swarm.mjs integrate <run-id>
node tools/swarm.mjs integrate <run-id> --no-checks
node tools/swarm.mjs integrate <run-id> --require-checks
node tools/swarm.mjs integrate <run-id> --mutants
node tools/swarm.mjs integrate <run-id> --mutants --mutants-file post-build-mutants.json --mutant-check '["npm","test"]'
node tools/swarm.mjs mutants --mutants-file post-build-mutants.json --mutant-check '["npm","test"]'
node tools/swarm.mjs mutants --mutants-file post-build-mutants.json --mutant-check '["npm","test"]' --dry-run
node tools/swarm.mjs env
node tools/swarm.mjs env --print
node tools/swarm.mjs validate examples/smoke.json --evidence evidence.json
node tools/swarm.mjs run examples/smoke.json --evidence evidence.json
node tools/swarm.mjs redcheck <run-id> --test node --test tests/regression.test.mjs
node tools/swarm.mjs cancel <run-id>
node tools/swarm.mjs board
node tools/swarm.mjs ship <run-id> --repo OWNER/NAME --pr payload.json
node tools/swarm.mjs ship <run-id> --repo OWNER/NAME --pr payload.json --require-section "Mutation check" --no-merge
node tools/swarm.mjs --root ../worktree-of-branch ship --branch slice-5 --pr payload.json --check '["npm","test"]' --require-section Checks
node tools/swarm.mjs go examples/smoke.json --commit-message "Add render review" --repo OWNER/NAME --pr payload.json
```

Use `--root /path/to/project` to select a project explicitly. Otherwise the runner uses its own installed project root. Manifests are loaded from the selected root. Installs are versioned: `<source>/current/tools/swarm.mjs` is always the runner path, kept stable for a run already in flight even if a later install/update repoints `current` to a newer version underneath it.

`validate` checks the assignment, paths, file size limits, and (see "Context check" below) that every existing declared output is not left uncovered by a test that already references it, without creating a run or invoking a model. For Codex, both validate and preflight warn about uncommitted changes to declared context/output files because only HEAD is checked out; a declared `context` file that git does not track at all (untracked or ignored, not merely edited) is instead refused outright — `Job <id>: codex context file <path> is not tracked by git (codex sees HEAD only)` — since Codex would silently see nothing there; the manifest's `contract` path is exempt from this refusal, since its text now travels in the codex prompt directly (see below). `run` performs the same validation before dispatching any worker. `doctor` diagnoses local prerequisites without running a model task. `status` reports saved run state. `inspect` reports each job's `agent`, `model`, `tier`, and `tierReason`, plus proposed-output sizes, owning `jobStatus`, and current conflicts without editing files. Its file `status` is `blocked` whenever the owning job is not complete, even if the worker left a partial file. Neither inspection nor validation approves content or runs application tests.

`validate`/`run` also add these warnings: `{"code": "tmp-tool-path", ..., "message": "<path> resolves under /tmp: macOS removes files here after 3 days unread; move it under <dir>"}` (`<dir>` is `toolchainsReport`'s own dir — see "Toolchains" under [doctor](#kickoff-diagnostics-and-install-commands) below) for a job's `readPaths` entry or a `checks`/`mutantCheck` `argv[0]` that resolves under `/tmp` or `/private/tmp`; `{"code": "core-module-no-shell", "jobId", "message": "<agent> cannot run pinning tests for tools/swarm.mjs (no shell); consider a checker job"}` when a non-`codex` job's `outputs` includes this runner's own `tools/swarm.mjs` (only `codex` has shell access, so no other agent can run the tests that pin that file's own behavior); `{"code": "runtime-check-no-shell", "jobId", "message": "worker cannot reproduce; consider a shell agent or --evidence"}` when a non-`codex` job's prompt quotes a runtime-check failure (a check name containing `harness`, `e2e`, `playwright`, or `preview`, or the words "Timeout" and "waitFor" together); and `{"code": "mutants-file-undeclared", "jobId", "path", "message"}` when a job's output path matches the shell glob `*mutants*.json` but that job declares no `mutantsFile` naming it — its shape is otherwise only checked once `integrate --mutants` finally reads it, well after the job has already run. A job that does declare `mutantsFile` gets a line in its own worker preamble stating the exact required shape, `{"name": string, "file": string, "find": string, "replace": string}`, up front.

`validate MANIFEST --evidence FILE` and `run MANIFEST --evidence FILE` read a local JSON file `{"failures": [{"name", "lines": [...]}]}` (the same shape `integrate` prints, see [Checks](#checks) below) and append a fixed `## Evidence: prior check failures` block, one `### <name>` subsection with its `lines` verbatim, to every job's prompt before validating or running — so a follow-up job sees the exact failing-assertion text from an earlier failed `integrate --require-checks`, without the coordinator retyping it. `FILE` is resolved directly against the project root, like `ship`'s `--pr` payload, not subject to the in-repo path-safety rules. A missing or invalid file, or one with no `failures` array, is a clear error before anything is validated or run.

`inspect` additionally reports, per job, `result` — the worker's own final JSON-object line from its saved response (whatever keys it wrote, or `null` if no line parses as a JSON object) — and `costUsd` (a number when the provider reported one, else `null`). A `result.notes` array, if present, is capped at 20 entries of at most 500 characters each in the printed report; this is display data from the worker, never executed or trusted.

`inspect` (and `inspect --results`) also report `costPer1kOutputTokens`: `costUsd` divided by (`usage.output_tokens` / 1000), or `null` whenever either figure was not reported — never estimated from a total or input-token count. A job whose prompt demands a JSON-only final reply (`"Return JSON only"` / `"reply with ONLY this JSON"`) but whose saved response never parsed as JSON adds `resultMissing: true`; for a `claude` job, the runner first attempts one cheap re-ask on the same session (`"Reply with the JSON only."`) and uses that answer instead whenever it parses, in which case `resultMissing` is not set.

### Result file

For a job that declares `resultFile`, `inspect --results` sets `result` to the parsed JSON of that file (read from the job's proposed output) instead of the worker's final message line, and adds `resultSource: 'file'|'message'` so a reviewer can tell which one answered. A missing or invalid file adds warning `resultFile unreadable: <job>: <reason>`; missing required `resultSchema` keys add `resultFile missing keys: <job>: k1,k2`; when the worker's own final JSON also parses and shares a key with a different value, `resultFile disagrees with final message: <job>: <key>` is added too. See [verification](verification.md#resultfile).

`inspect --results` also warns when a job's own `crossJobNames` or `notes` string names a repo-relative path (a token with a `/` or a file extension) that exists in the repo but is not one of that job's declared `outputs`: `outside outputs: <job>: <path>` — a worker mentioning a file it silently touched outside its ownership, instead of stopping and returning `blocked`. See [orchestration](orchestration.md#wiring-jobs).

`wait`, `inspect`, and `inspect --results` job entries also carry `tokens` (`usage.total_tokens` when the provider reported it, else `null`). At the run level, `tokens` is the sum of every job's non-null `tokens` (or `null` when none are known), and `costNotReported` lists the ids of jobs whose `costUsd` is `null` (`[]` when every job reported a cost); the run's `costUsd` stays the sum of the costs that were reported.

Each job record also carries `actualModel` (the model behind most of its `assistant` events, falling back to the init-reported model, then `null`), `modelsSeen` (every distinct valid model id observed across init and assistant events, in first-seen order), and `modelMismatch` (`true` when an assistant-event model does not match the requested `model`, using alias matching: a requested `haiku`/`sonnet`/`opus`/`fable` matches any id containing that word, otherwise the id must equal or start with the request). Both plain `inspect` and `wait` add a top-level `warnings` array with one string per mismatched job, `model mismatch: <job id> asked <requested>, ran <actualModel>`; the job itself is not failed for it. Add `--results` to `inspect <run-id>` to print only `{"runId","status","warnings":[...],"jobs":[{"id","status","model","actualModel","modelMismatch","costUsd","result"}]}` and nothing else.

`wait <run-id> [--timeout SECONDS]` blocks, polling saved run status at most once a second, until the run reaches a terminal status (`complete`, `failed`, or `cancelled`); with no `--timeout` it waits indefinitely. It prints one compact JSON line, `{runId, status, durationMs, costUsd, tokens, costNotReported, warnings, jobs: [{id, status, costUsd, tokens, notes}]}`, where `costUsd` is the sum of the jobs' recorded provider costs when any are available, else `null`, `tokens` is the sum of the jobs' non-null `tokens` (else `null`), `costNotReported` lists the ids of jobs with no reported cost, `warnings` lists any model-mismatch strings (see above), and each job's `notes` come from the same final-JSON-line parsing as `inspect` (capped the same way). Exit code is `0` for `complete`, `1` for `failed`/`cancelled` (or an unknown run id), and `2` if `--timeout` expires first — in that case `status` in the printed line is still `running`.

## Ask

`ask --model M --context f1,f2,... [--agent claude] [--timeout S] "question"` builds one read-only job in memory — `id: ask-<timestamp>`, empty `outputs`, the given `context`, and the question plus a fixed suffix asking for one final JSON line — runs it like `run`, waits for it, and prints exactly one JSON line: `{"id","status","model","actualModel","modelMismatch","costUsd","result"}`, where `result` is the worker's parsed final JSON (or `null` plus `error`). It refuses with no `--model`, no `--context`, or an empty question. Exit code is `0` when the job completes, `1` otherwise. `--agent` defaults to `claude`; only `claude` and API agents are allowed, never `codex`. The run is saved under `.swarm/runs/` like any other run.

```sh
node tools/swarm.mjs ask --model haiku --context src/renderer.js "Any obvious performance bug here?"
```

After installing into a project, use `coordination/swarm-smoke.json` and `coordination/swarm-parallel-review.json` in place of the standalone checkout's `examples/` paths. `--root` may appear before or after the command.

## Scout

`scout --model M --brief FILE [--context f1,f2,...] [--timeout SECONDS] [--max-picks N] "goal"` runs one read-only `web: true` job (GitHub first) that searches for existing open-source code that already does the job named in `goal`, before a large build. The worker's agent is always `claude`; there is no `--agent` flag. Builders read only the report the runner writes, never web pages — web text is untrusted.

It refuses with no `--model` (`scout requires --model`), no `--brief` (`scout requires --brief`), a missing brief file (`scout brief not found: <path>`), an empty goal (`scout requires a non-empty goal`), or `--max-picks` outside 1–30 (`--max-picks must be 1-30`). `context` (comma-separated) is added to the brief file as extra read-only files for the worker.

The model returns one raw JSON line; the runner, not the model, applies the license gate (`normalizeScoutReport` in `tools/scout.mjs`): only the schema keys survive at every level, strings are trimmed and capped at 300 characters, a pick whose `url` does not start with `https://` is moved to `rejected` (`bad url`), a pick whose `license` is not one of `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `Unlicense`, `Zlib`, `BSL-1.0`, or `MPL-2.0` is moved to `rejected` (`license not allowed: <license or none>`, name added to `moved`), a kept `MPL-2.0` pick gets `flag: "file-level copyleft"`, a `commit` that is not a 40-hex sha becomes `null` (never shortened, never guessed), invalid `stars`/`lastCommit`/`fit` are normalized, and picks beyond `--max-picks` are dropped after that gate.

The runner writes `.swarm/scouts/<id>/report.json` (the normalized report plus `{id, goal, model, actualModel, createdAt}`) and `.swarm/scouts/<id>/report.md` (a table the runner renders — the model never writes markdown). It prints one JSON line: `{id,status,model,actualModel,modelMismatch,costUsd,report,reportMarkdown,picks,rejected,moved}`, where `report`/`reportMarkdown` are root-relative paths, `picks`/`rejected` are counts, and `moved` lists the pick names the gate moved to `rejected`. On a missing or invalid final JSON, `status` stays the run status, the counts are `0`, and the line adds `error: "scout returned no report"`. Exit code is `0` when the job completes, `1` otherwise. The run is saved under `.swarm/runs/` like any other. See [a generic example brief](scout-brief-example.md).

```sh
node tools/swarm.mjs scout --model sonnet --brief docs/scout-brief-example.md --max-picks 5 "Find a small retry/backoff library for outbound HTTP calls"
```

## Sweep

`sweep --model M --brief FILE --goals FILE [--max-usd N] [--concurrency N] [--top N] [--candidates N] [--known f1,f2,...] [--timeout SECONDS]` runs read-only `gh api`-only GitHub research across many areas (tickets) at once, instead of one goal at a time like `scout`. `--goals` is a JSON file `{"areas": [{"area": "t19-ui", "ticket": "T19", "goal": "...", "queries": ["topic:react-component license:mit stars:>300 pushed:>2025-09-01", ...]}, ...]}`: 1–20 areas, each `area` matching `^[a-z0-9-]{1,40}$` with a unique name, a non-empty `ticket` and `goal`, and at least one non-empty `queries` string. See [a generic example](sweep-goals-example.json).

It refuses with no `--model` (`sweep requires --model`), no `--brief`/a missing brief file, no `--goals`/a missing or invalid goals file, or a missing `--known` file. Defaults: `--concurrency 3`, `--top 3` (hard max 3, silently clamped), `--candidates 25` per area after dedupe (hard max 50, silently clamped), `--max-usd 15`, `--timeout 900` seconds. `--known` is a comma-separated list of files whose `https://github.com/<owner>/<repo>` URLs are extracted and skipped everywhere (case-insensitive on owner/repo) — already-rated repos never reappear.

For each area, every query's `gh api -X GET search/repositories -f q=<query> -f per_page=50` results are merged, deduped, known repos removed, ranked by stars and recency, and cut to `--candidates` before anything else is fetched — enrichment cost is bounded by that cap, not by how many raw hits came back. Each surviving candidate is enriched with `gh api repos/<o>/<r>`, `.../commits/<default_branch>`, `.../releases/latest`, and `.../contents/<path>` (only `.github/workflows`, `package.json`, `pyproject.toml`, the top-level listing, and `setup.py`'s presence in it) — every call an argv array with no shell, and the child process never receiving `GITHUB_TOKEN`/`GH_TOKEN` (the parent environment minus those two; `gh` reads its own credentials). An OpenSSF Scorecard is a plain unauthenticated fetch to `https://api.securityscorecards.dev/projects/github.com/<o>/<r>`; a missing score is `null`, never an error.

The gate (`tools/sweep.mjs`, all in code, none of it the model) drops an archived repo (`archived`), a fork (`fork`), or a license outside `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MPL-2.0`, `0BSD`, `Unlicense` (`license`) before the model ever sees it; a kept `MPL-2.0` candidate gets flag `weak-copyleft`. Other flags are computed the same way: `install-scripts` (a `preinstall`/`install`/`postinstall` script, or Python's `setup.py`), `stale` (not pushed in 365 days), `no-ci` (no files under `.github/workflows`), `no-tests` (no top-level `test`/`tests`/`__tests__`/`spec`).

One claude job per area (the existing scout machinery, no web tools — the candidates gathered by `gh api` are the only GitHub data the model sees, embedded directly in its prompt as labelled untrusted data, never as instructions), prompt from `sweepPrompt({brief, area, ticket, goal, top})`, `outputs: []`. The model returns `{area, picks: [{fullName, reasons: [..≤3], hoursToAdopt, fit: "drop-in"|"adapt"|"reference-only", where, risk}], rejected: [{fullName, reason}]}`; `normalizeSweepArea` keeps at most `top` (hard-capped at 3) picks, drops (moves to `rejected`, reason `not a candidate`) any pick whose `fullName` is not one of that area's candidates, drops (reason `invalid hoursToAdopt`) any pick whose `hoursToAdopt` is not a finite number 0.5–400, and always overwrites `license`, `commit`, `url`, `stars`, `scorecard`, and `flags` with the matching candidate's own values — the model can never set a license or a pin.

Before launching an area's job, if spending so far has already reached `--max-usd`, that area is `skipped` outright (no `gh api` calls, no job); areas already running are never killed. Areas run with the given `--concurrency`. It writes `.swarm/sweeps/<id>/candidates/<area>.json`, `areas/<area>.json`, `shortlist.json` (`{id, createdAt, model, areas: [{area, ticket, picks: [{fullName, url, license, commit, hoursToAdopt, fit, reasons, risk, where, stars, scorecard, flags}]}], skipped, costUsd}`), and `shortlist.md` (one `## <area> (<ticket>)` table — `| Pick | License | Pin | Hours to adopt | Fit | Why | Risk | Flags |`, at most 3 rows — per area, then a `Skipped:` line).

It prints one JSON line: `{id, status, costUsd, areas: [{area, status, picks, costUsd}], skipped: [area...], shortlist, shortlistMarkdown}`, where `status` is `complete` (every area completed), `partial` (some area failed or was skipped by the cost cap), or `failed` (no area completed). Exit code is `0` when `status` is `complete`, `1` otherwise. Sweep results are prior-art data, not an adopted decision: a human still reviews `shortlist.md` and says yes before any pick is actually pulled into the project.

```sh
node tools/swarm.mjs sweep --model sonnet --brief docs/scout-brief-example.md --goals docs/sweep-goals-example.json --max-usd 10 --concurrency 3
```

## Saved records

Each run uses these project-local locations:

```text
.swarm/
  runs/<run-id>/
    worktrees/<codex-job-id>/  # temporary detached HEAD checkout, removed after job
    base/<job-id>/           # exact original output bytes for redcheck
    manifest.json
    state.json
    <job-id>/
      message.txt
      response.txt
      provider.jsonl
      stderr.log
  workspaces/<run-id>/<job-id>/
    ...explicitly copied files and proposed outputs
  scouts/<run-id>/
    report.json
    report.md
  sweeps/<sweep-id>/
    candidates/<area>.json
    areas/<area>.json
    shortlist.json
    shortlist.md
```

The exact prompt, model response, and provider events are local evidence, not material to publish automatically. Provider metadata may contain usage and actual model identifiers when the provider emits them. API records contain a normalized event, numeric usage, and model identifier rather than raw HTTP responses or headers. API cost is unavailable, not inferred. Missing metadata must be reported as unavailable, not inferred from a requested alias.

An overall successful run has `status: "complete"`; individual jobs may instead fail, time out, or be cancelled. For Claude, a zero subprocess exit code alone is insufficient: the runner requires a successful provider result event and rejects malformed output and missing results. Permission denials alone
become warnings when a successful job produced a response or changed output
and all declared outputs exist. Each warning is `permission denials: <job>:
<tool> <path-or-input>`, capped at 200 characters, in `run`, `wait`, `inspect`
and `inspect --results`. Any other failure still fails the job. Failed jobs
with changed declared outputs set `keptWorkspace` for inspection; failed runs
remain ineligible for integration.

### Agent failure evidence

A CLI/codex worker that exits non-zero, or that otherwise looks complete but writes none of its declared outputs, has the last 4 KB of its stdout and the last 4 KB of its stderr saved to `.swarm/runs/<run>/<job>/agent.log`, and a short `agentError` set on the job record: the exit code plus the first stderr line matching `blocked`/`credit`/`quota`/`rate limit`/`auth`, or else the last non-empty stderr line, capped at 300 characters. Values shaped like a provider token or a `Bearer` header are redacted before either is saved. `agentError` (when set) is shown in both `inspect` and `inspect --results`. A worker that completes but writes none of its declared outputs is reported `failed`, naming the agent cause before any generic missing-output text, rather than left looking `complete` until a later `integrate` reports only a missing file.

A worker's own `blocked` envelope (its final JSON message with `{"status":"blocked", ...}`, per the worker preamble) is never masked by either of the above: the job is reported with status `blocked` and `error: "blocked: <summary>"`, using the envelope's own `summary` (or `file`) field.

## Integration contract

Integration requires a complete run from the same project, a matching saved manifest and worker record, and all declared output files. It validates every candidate and original target hash before writing any project output. If any target changed after the snapshot, integration stops with a conflict. It does not merge textual conflicts, propagate deletions, or import undeclared files.

An integration lock serializes integrations through this runner. Individual file replacements are atomic, with best-effort rollback on a caught write failure. This is not a transactional filesystem or protection against an unrelated process editing files concurrently. Keep a single coordinator for project writes and use normal version control.

API jobs additionally require a complete, non-refused response and valid JSON with exactly `summary` and `files`. Each file contains only `path` and complete `content`; every declared output must occur exactly once. Responses are capped at 16 MiB, redirects are refused, and partial/truncated output is never integrated. Provider credentials/endpoints cannot appear as manifest configuration. See [provider setup](providers.md).

The `monitor` command is a single read-only snapshot, suitable for periodic coordinator polling. New runs record `queuedAt`, `startedAt`, `finishedAt`, `durationMs`, configured concurrency, and observed peak active jobs. Counts reflect recorded queue state, not proof that stale processes survived a coordinator crash. Numeric usage is grouped by provider without combining incompatible token fields or estimating missing costs. Older run records remain readable; unavailable historical timings remain null.

`monitor <run-id>` still prints the JSON snapshot above by default; nothing about that output changed. Add `--view` for a human table instead: one row per job (`id`, `agent`, `model`, `tier`, `status`, elapsed/duration, declared output count), a summary line (running/done/failed/queued counts, total elapsed, peak concurrency), and, where recorded, usage per provider. Every status shows a symbol and a word together, never color alone, and color is used only on a TTY with `NO_COLOR` unset. Add `--watch [seconds]` (default 2) to keep `--view` re-rendering in place until the run reaches a terminal status or you press Ctrl+C; it only reads saved state and never starts, cancels, or integrates anything.

## Checks

`integrate <run-id>` runs the manifest's `checks` in declared order immediately after it writes the integrated files, so format drift and failing tests surface in the same command instead of costing the coordinator a separate job. Each check is `{"name": "...", "argv": ["...", ...], "timeoutMs": 300000}`:

```json
{
  "checks": [
    {"name": "format", "argv": ["uv", "run", "ruff", "format", "{integrated:.py}"]},
    {"name": "pytest", "argv": ["uv", "run", "pytest", "-q"], "timeoutMs": 600000}
  ]
}
```

- `name`: required, 1–60 characters from letters, digits, spaces, `.`, `_`, `-`.
- `argv`: required non-empty array of strings. `argv[0]` is the program; no shell is ever used, so shell metacharacters in any item are passed through literally, never interpreted.
- `timeoutMs`: optional integer 1,000–1,800,000; default 300,000.
- `repeat`: optional integer 1–20, default 1. See [Repeat](#repeat) below.
- `flakeRuns`: optional integer 1–20, overriding `repeat` as the number of base-commit reruns used to measure a pre-existing flake. See [Flake on base](#flake-on-base) below.

Up to 10 checks per manifest. Inside `argv`, a whole item of exactly `{integrated}` expands to the run's integrated file paths (relative to the project root) as separate argv items; `{integrated:.py}` (or any other extension) expands to only the integrated files with that extension. If a placeholder expands to zero files, that check is skipped (`status: "skipped"`) rather than run with nothing to act on.

The text `{root}` may also appear anywhere inside a `checks` or `mutantCheck` argv item — not only as a whole item — and is replaced with the run's absolute project root, for example `"CARGO_TARGET_DIR={root}/src-tauri/target"`. This keeps a project-relative build directory unique per run so two parallel runs never share (and corrupt) the same build folder. `{integrated}`/`{integrated:.ext}` still only expand a whole item, unchanged.

Checks run with `cwd` at the project root, the coordinator's inherited environment plus `SWARM_PORT_BASE` (see [Ports](#ports) below), and each check's own timeout; a later check still runs even if an earlier one fails, so a formatter can run before the tests that depend on its output. **Formatters may rewrite the files integration just wrote, and a failing check never rolls back the integration** — checks are reported, not a transactional gate. `integrate`'s own process exit code stays 0 when files integrate successfully regardless of check outcome; pass `--require-checks` to exit 1 when any check fails, times out, or errors. Pass `--no-checks` to skip them entirely (the result shows `checks: []`, `checksSkipped: true`, and `failures: []`).

The result also gains `failures`: one compact entry per check whose status is `failed`, `timeout`, or `error` — `{"name", "lines": [...]}`, the last few lines of that check's own `tail` that look like a failure (matching `fail`/`error`/`assert`/`expected`/`✗`/`✕`, capped at 5) — so a coordinator does not need to open the full tail to see what broke. `failures` is `[]` when every check passed or was skipped. This same shape is what `--evidence` (above) expects a local JSON file to contain.

## Pre-checks

`integrate <run-id>` also accepts an optional manifest `preChecks`: at most 10 plain argv arrays (not named checks — they exist to resync the environment, not to pass or fail), run in declared order, `cwd` at the project root, before the manifest's own `checks`. They only run when at least one integrated file's basename matches a recognized lockfile: `uv.lock`, `package-lock.json`, `Cargo.lock`, or `pnpm-lock.yaml`.

```json
{
  "preChecks": [["uv", "sync"], ["npm", "ci"]]
}
```

When a lockfile changed and the manifest declares no `preChecks`, the result instead gains `warnings: ["lockfile changed, env not synced"]` — a reminder that the checked-out environment may no longer match the lockfile that was just integrated. The result's `preChecks` array (each entry the same shape as a check result: `name`, `status`, `exitCode`, `durationMs`, `tail`) is present whenever any ran.

## Ports

Field lesson #141: two checks in different worktrees can start a dev server on the same fixed port at the same time, so every worktree gets its own stable block of 10 ports, derived from its own absolute path (same path, same block, every time).

- Env var **`SWARM_PORT_BASE`** (the block's first port, as a string): set, without replacing any other variable, in the environment of every child process a run starts inside a worktree — `integrate`'s `preChecks` and `checks` (including `--mutants` checks and any flake-on-base reruns), `ship`'s own re-run of checks, a `codex` job's process, and a claude `shell: true` job's process. A shell job's worker preamble also gets one prompt line: `Ports: this worktree owns <base>..<base+9> (SWARM_PORT_BASE). Start any dev server or test server on these, never on a fixed default port.` A harness or test server should read `SWARM_PORT_BASE` and bind somewhere in `base..base+9` instead of a fixed default port. A non-shell claude job's argv, env and prompt are unaffected.
- The block is computed from the directory the child process actually runs in — the job's own worktree for a codex/shell job, the project root for `integrate`'s and `ship`'s own checks — so a run's worktree and the project root may end up with different blocks; that is expected.
- `job.testEnv` may not set `SWARM_PORT_BASE` itself: `Job <id>: testEnv key SWARM_PORT_BASE is reserved`.
- `integrate`'s result and `ship`'s output both gain `portBase: <n>`. If the computed block was busy, the result also gains a warning: `port-block-moved: <from> -> <to>` when a different free block was found, or `port-block-busy: <base>` after 50 busy blocks in a row (the original block is used anyway, and the caller should investigate).

## Setup

Field lesson #142: a claude `shell: true` job's own sandboxed Bash has no network, so a project's own toolchain sync (`uv sync`, `npm ci`, ...) can never run inside it; without one, `uv run`/`pytest` inside the sandbox also failed to resolve the project's own workspace root and its synced venv, both hidden from the sandbox by default.

- Job field `setup` (see [Job fields](#job-fields) above): at most 5 argv arrays, `codex` and claude `shell: true` jobs only. The swarm parent runs each, in order, **outside the sandbox**, in the job's own worktree, once that worktree exists and before the worker starts. Each gets a 600000 ms timeout and the same environment as the manifest's own `checks` (including `SWARM_PORT_BASE`; never the worker key). Combined stdout+stderr is saved to `<run>/<job>/setup.log` (redacted the same way as other logs). A non-zero exit or a timeout fails the job with `setup-failed: <argv[0]> exit <code>` and the worker never starts.
- For a claude `shell: true` job specifically, the sandbox profile additionally grants: `file-read-metadata` on every ancestor directory of the worktree, up to `/`, and a full read grant on any `pyproject.toml`, `uv.toml`, or `package.json` literally inside one of those ancestors — see "Sandbox" under [Shell jobs](#shell-jobs) above. After `setup` runs, if `<worktree>/.venv/pyvenv.cfg` exists and its `home = <dir>` line names a directory under the coordinator's own `$HOME` (a toolchain cache, not the job-scoped `HOME`), that directory's parent is added as an automatic read path, subject to the same refusal list as `readPaths`; a refused one is skipped and adds a warning `venv-interpreter-denied: <dir>` (job record `venvInterpreterDenied`, and in `warnings`) instead of failing the job.
- The child env gains `UV_OFFLINE=1`, `UV_PYTHON_DOWNLOADS=never`, `UV_CACHE_DIR=<run>/<job>/shell/uv-cache`, and `npm_config_offline=true`; these are reserved in `testEnv` like `SWARM_PORT_BASE` (`Job <id>: testEnv key <k> is reserved for the shell sandbox`).
- A job with `setup` gets one more prompt line: `Setup already ran outside the sandbox: <argv...>. Do not run it again; the network is blocked.`
- A codex or claude job without `shell: true` is refused outright: `Job <id>: setup is only supported for codex and claude shell jobs`.

## Env file

Field lesson #160: a toolchain env a check needs (a browsers path, a toolchain cache) used to live only in prose. `<root>/.swarm/env.json` is a JSON object of at most 50 `"NAME": "value"` strings; a linked worktree with none uses its main worktree's file. `PATH`, `HOME`, `SWARM_PORT_BASE`, `SWARM_IN_SANDBOX` and any name that looks like a secret (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`) are refused, and so is an invalid file, by `validate`, `run`, `integrate` and `ship`.

- Applied to every `setup` step, codex worker, claude shell worker (minus the keys the shell allowlist fixes), `preChecks`, `checks` (in `integrate` and `ship`), flake reruns, `redcheck`, and every mutant check (`integrate --mutants` and `mutants`). Non-shell claude jobs, `ask` and `scout` have no shell, so nothing there reads it.
- `validate` warns `{"code": "check-needs-env", "checks": [...]}` when a check, preCheck or `mutantCheck` runs `npm`/`npx`/`pnpm`/`yarn`/`cargo`/`uv`/`uvx` and no env file exists.
- `env` prints `{source, env, portBase}`; `env --print` prints a paste-ready block for an outside agent's prompt: one `export NAME='value'` line per entry, `export SWARM_PORT_BASE=<base>` for this root, and the rule `Never run \`git stash\`...` (lesson #163).

## Packaging build check

Field lesson #159: a packaging-config change can pass every test, lint and type check and still produce a package that does not build. A build check is any `checks`/`preChecks` argv matching `uv|hatch|poetry|pdm|flit build`, `-m build`, `pip wheel`, `npm|pnpm|yarn pack`, or `cargo package|build` (argv0 may be an absolute path).

- `validate` warns `{"code": "packaging-change-without-build-check", "jobId", "files"}` when a job's outputs include `pyproject.toml`, `setup.cfg`, `setup.py`, `MANIFEST.in`, `package.json` or `Cargo.toml` and the manifest has no build check (the stricter reading: nothing is written yet, so any packaging output counts).
- `integrate` warns `packaging-change-without-build-check: <file>: <keys>` when the change itself touches packaging keys: a line in `[build-system]`, `[tool.hatch.build*]`, `[tool.setuptools*]`, `[project.scripts]`/`[project.entry-points*]`, `[options*]` (setup.cfg) and similar sections, a `packages`/`include`/`exclude`/`force-include`/`package-data`/... key, any `setup.py`/`MANIFEST.in` change, or `package.json`'s `files`/`main`/`module`/`exports`/`bin`/`types`/`browser`/`publishConfig`/`directories`. A version bump alone is not a packaging change.
- `ship` (a run, or `--branch`) refuses the same change before any check runs or anything is pushed: `packaging-change-without-build-check: <file>: <keys>; add a check that builds the package (uv build --wheel, npm pack --dry-run)`. With a build check, a broken package is simply a red check.

## Mutants (current tree)

```sh
node tools/swarm.mjs mutants --mutants-file post-build-mutants.json --mutant-check '["npm","test"]'
```

`mutants --mutants-file FILE --mutant-check ARGVJSON` runs mutation testing directly against the current tree — no run id, no manifest, and no integration required. `FILE` is the same shape as `integrate --mutants-file` (a JSON array of `{"name","file","find","replace"}`, or `{"mutants":[...]}`); `--mutant-check` is the same JSON-array-of-argv-strings shape as `integrate --mutant-check` and is always required (there is no manifest to fall back to). For each mutant, in order: `find` must occur in `file` exactly once or the mutant is `invalid`; otherwise the file is mutated, the check is run, and the file is always restored to its exact original bytes and mode afterward — including on a check timeout, launch failure, or a `Ctrl-C` (SIGINT), which is caught so the in-flight mutant's own restore still completes before the process exits; no further mutant then starts.

It prints `{"mutants": [{"name","file","status","exitCode","durationMs","tail","firstFailingLine"}], "mutantsSummary": {"killed","survived","invalid"}, "mutantsPassed"}`. Per mutant, `status` is `killed` (check exits non-zero), `survived` (check exits zero), or `invalid` (a timeout, launch failure, a `find` match count other than one, or a missing file); `firstFailingLine` is the first line of the check's own tail that looks like a failure, set only when `status` is `killed`, else `null`. `mutantsPassed` is `true` only when nothing survived or was invalid; exit code is `0` when `mutantsPassed`, else `1`. See also [mutation checks](#mutation-checks) for the run-integrated equivalent, `integrate --mutants`.

**Find pre-check (lesson #161):** before the baseline or any mutant runs, every mutant's `find` is counted in its target: missing (or the file is missing) is `invalid-find`, more than once is `ambiguous-find`, `find` equal to `replace` is `no-op`. Any of these refuses the whole run, listing each bad mutant (`Refusing to run mutants: N invalid mutant(s), nothing mutated: <name>: <code> (<file>: ...)`, with `mutantProblems` in the error details); nothing is mutated and no check runs. `--dry-run` does only this and prints `{"status": "dry-run", "mutants": [{"name","file","status":"valid","check","checkArgv"}], "mutantsValid": true}`.

**Per-mutant check (lesson #162):** a mutant may carry `"check": [argv...]`, run instead of `--mutant-check` for that mutant only, so one file mixes unit-test and harness checks. `--mutant-check` is optional when every mutant has its own. Every distinct check in use must pass on the unmutated tree first. Each result names `check` (`"default"` or `"mutant"`) and `checkArgv`.

## Redcheck

```sh
node tools/swarm.mjs redcheck <run-id> --test <argv...>
node tools/swarm.mjs redcheck <run-id> --base <ref> --test <argv...>
```

The exported function is `redcheckRun(root, runId, argv, options)`; tests may
inject `spawnImpl` and `timeoutMs` (default 300000). The CLI runs argv directly
without a shell in the selected root. Everything after `--test`, including
flags such as `--root`, belongs to the test command.

`--base <ref>` restores non-test outputs to `git show <ref>:<path>` content instead of the run's own recorded base (a path missing at `<ref>` is deleted for the test, then restored); default behavior is unchanged. When `--base` is omitted and the run's base commit is not an ancestor of the default branch tip (checked with `git merge-base --is-ancestor` against `origin/HEAD`), the result gains `suggestBase: 'origin/main'` (the actual default-branch ref name) and a warning `run base is not on the default branch; old code may already contain the change — try --base origin/main` — the case that produced a false green on a follow-up job whose base already contained the feature. The result JSON always carries `base: <ref or 'run-base'>`.

If the test command cannot be spawned (`ENOENT`, or a single `--test` token containing a space that fails to launch), the result is `{status:'error', exitCode:null, hint:'could not start <cmd>: pass the test command as separate argv tokens'}` instead of a bare launch failure.

For a complete or integrated run, redcheck temporarily restores **every
non-test declared output** to its base content. Test paths are under `tests/`
or `test/`, or have names matching `*.test.*`, `*.spec.*`, or `*_test.*`.
Test files stay untouched. Integrate first so the new tests are available;
a complete unintegrated run is also accepted if the command and needed tests
already exist in the root. In either case the job's implementation versions
are restored afterward, even on a launch error, timeout or failing command.
Thus running it before integration also leaves those implementation proposals
in the root; it does not mark the run integrated.

New runs save exact base bytes and a base commit. For older hash-only records,
redcheck uses matching current bytes or `git show <base>:<path>` (HEAD when no
base commit was saved), verifying the hash before any write. An output absent
at base is temporarily removed and then recreated from the proposal. It
refuses all changes before running the command if a target differs from both
base and job bytes, including uncommitted edits. It shares the integration
lock; keep unrelated writers out of these paths during the check.

One JSON line reports `{status:'red'|'green'|'error', exitCode, restored:[paths],
tail}`. `restored` lists paths temporarily reverted to base; `tail` keeps the
last 2000 characters of combined command output. `red` means a nonzero test
exit and exits 0; `green` means tests passed without the fix and exits 1.
Launch errors, signals, timeouts, conflicts and restoration failures report
`error` and exit 1. No model claim substitutes for this check: first verify the
tests pass with the fix, inspect that the red failure is the intended
regression assertion, then verify they pass again after restoration. A red
exit alone can also be an unrelated test failure.

## Repeat

A check is opt-in flaky-repro tooling: set `repeat` (1–20, default 1) to run its argv up to that many times, stopping at the first failure instead of running the remaining repeats. The result gains `runs` (how many times it actually ran) and, only on failure, `failedRun` (the 1-based repeat number that failed); a check with no `repeat` behaves exactly as before, `runs: 1`.

Inside `argv`, a whole item of exactly `{new}` expands to integrated files that did not exist when the run started (the job's base hash recorded the file as absent); `{new:.ext}` restricts that to files with the given extension. Both follow the same skip rule as `{integrated}`: if the placeholder expands to zero files, the check is skipped (`status: "skipped"`) rather than run with nothing to act on.

The result (and the saved run state, visible from `inspect <run-id>`) gains:

```json
{
  "checks": [{"name": "format", "status": "passed", "exitCode": 0, "durationMs": 812, "tail": "..."}],
  "checksPassed": true
}
```

`status` is one of `passed`, `failed` (non-zero exit), `timeout`, `error` (the program could not be launched), or `skipped`. `tail` is the last 2000 bytes of that check's combined stdout+stderr, never more. `checksPassed` is `true` only when no check failed, timed out, or errored.

## Flake on base

When a check with `repeat` fails during `integrate` or `ship`, and the failure output names a test file (the first path matching `(tests?|__tests__)/…\.(test|spec)\.[cm]?[jt]sx?` or `*.test.*`), the runner reruns that same check argv with the file appended, N times (N = the check's `repeat`, capped at 20; a check's own `flakeRuns` overrides N) against a temporary `git worktree add --detach` checkout of the run's base commit, removed afterward. The check result gains `flakeOnBase: {file, failed:k, runs:N}`, and a `flake on base: k/N (<file>)` line prints next to the failure; `k > 0` means the flake already existed on base, distinguishing it from an actual regression without a hand-run loop. This never changes the check's own pass/fail. Pass `--no-flake-check` to `integrate`/`ship` to disable it.

## Mutation checks

`integrate <run-id> --mutants` runs mutation testing after normal integration and its `checks` have already written and validated the real files. For each declared `mutants` entry, in order, it: reads the target file, requires `find` to occur in it exactly once, writes the file with `find` replaced by `replace`, runs the shared `mutantCheck` command, and then always restores the file's original bytes and mode — including when the check times out or fails to launch — before moving to the next mutant. A mutant is never applied unless `find` matched exactly once.

```json
{
  "mutants": [
    {"name": "off-by-one", "file": "src/limits.js", "find": "value <= max", "replace": "value < max"}
  ],
  "mutantCheck": {"argv": ["npm", "test"], "timeoutMs": 300000}
}
```

- `mutants`: optional array of at most 32 entries `{"name", "file", "find", "replace"}`, plus an optional `check` argv array (lesson #162; overrides `mutantCheck` for that mutant, must pass on the unmutated tree first, else that mutant is an `error`). `name` is required, non-empty, and unique. `file` is a relative project path, validated with the same rules as a job output. `find` is a required non-empty string that must occur in `file` exactly once for the mutant to run. `replace` is a required string (it may be empty).
- `mutantCheck`: required whenever `--mutants` is used and neither the manifest nor the CLI supplies one another way — `{"argv": [...], "timeoutMs": 300000}`, the same shape and limits as one entry in `checks` (no shell, no placeholders), run once per mutant with `cwd` at the project root.

The result gains `mutants: [{"name", "file", "status", "exitCode", "durationMs", "tail"}]` and `mutantsSummary: {"killed", "survived", "errors"}`. Per mutant, `status` is `killed` when the check exits non-zero, `survived` when it exits zero, or `error` for a timeout, a launch failure, a `find` match count other than one (`tail` explains why, e.g. `"find matched 0 times"`), or a missing file — none of these apply or run a check. `mutantsPassed` is `true` only when no mutant survived or errored. With `--require-checks`, a surviving or errored mutant also makes the `integrate` command exit 1, alongside a failed `checks` result. `--mutants` with no mutants available from any source is a clear error, not a silent no-op. Mutants never touch `.git`/`.swarm` (the same path rules as every other declared file forbid it) and never run during `run` — only `integrate --mutants`.

**Mutants only count against a green base.** Whenever any of the manifest's own `checks` failed (`checksPassed: false`), `integrate --mutants` never actually applies or checks any mutant — a red base kills every mutant regardless of the guard under test, so a "killed" verdict there would prove nothing. Instead every mutant is reported `status: "skipped-red-base"`, `mutantsSummary` gains a `skipped` count, `mutantsPassed` is `false`, the result's own `mutantsSkippedRedBase` is `true`, and `warnings` gains `"mutants skipped: red base (checks failed)"`. `ship --require-section "Mutation check"` refuses outright (`status: "refused"`, a reason naming the red base) rather than accept a run whose mutants came from one — see [Ship](#ship) below.

Every mutants source (manifest `mutants`, a job's own `mutantsFile` output, and `--mutants-file`) is parsed and validated — same shape, same combined 32-entry cap — **before the first project file is written**, alongside every other integration precondition; a `mutantsFile` output that fails to parse (or a malformed `--mutants-file`/`--mutant-check`) refuses integration with nothing written at all. See [Post-build mutants](#post-build-mutants) for the retry semantics this enables.

**Find pre-check (lesson #161):** `integrate --mutants` counts every mutant's `find` in the bytes its target will hold after this integration (the proposed output, else the current file) before the first project write, and refuses with the same `invalid-find`/`ambiguous-find`/`no-op` list as `mutants` — nothing is written, mutated or checked. Results gain `check`/`checkArgv` per mutant.

### Post-build mutants

A mutant's `find` string sometimes only exists in code a build job generates, so it cannot be written into the manifest before that job runs. Two sources close that gap, and both are validated exactly like manifest `mutants` (same shape, and the combined total from every source is still capped at 32):

- `integrate <run-id> --mutants --mutants-file FILE`: `FILE` is a JSON array of mutant entries, or `{"mutants": [...]}`, resolved like `ship`'s `--pr` payload (against the project root, read directly — not subject to in-repo path rules, since it is a coordinator-supplied local file, never written or copied).
- A job field `mutantsFile` naming one of that job's own `outputs` (`Job <id>: mutantsFile must be one of its outputs`): once `integrate --mutants` has written that output, its JSON content is collected automatically as another mutants source — no `--mutants-file` needed.

Either way, each mutant's `find` is checked against the file's bytes exactly like a manifest-declared mutant, but the **parse and shape validation** happens before any file is written: a job's own `mutantsFile` output is read from the exact bytes about to be written (not re-read from the tree afterward), and `--mutants-file` is read and parsed the same way, up front. When the manifest declares no `mutantCheck`, pass `--mutant-check "<argv json>"` (a JSON array of argv strings, e.g. `--mutant-check '["npm","test"]'`) — `integrate --mutants` refuses with a clear message, and writes nothing, if neither a usable mutants source nor a `mutantCheck` is available. Restore-and-byte-check behavior for every mutant, from any source, is unchanged.

**Integration is all-or-nothing.** Every mutants source, and every other precondition, is validated before the first project file is written; a bad shape (including a `mutantsFile` output whose worker appended trailing text after its own final JSON line — see [agent failure evidence](verification.md#agent-failure-evidence)) refuses cleanly with nothing written. Once files are written, the run's saved state gains `integrationStatus: "partial"`, persisted immediately, before `preChecks`/`checks`/mutants run; a later failure in any of those (rare, since every precondition above is already checked) leaves that marker in place rather than an ambiguous state. A subsequent `integrate <run-id>` on a `partial` run is accepted as a retry rather than refused `"Run already integrated"`, and a file that already carries the exact bytes this same run wrote is treated as already applied instead of a conflict. `integrationStatus` becomes `"complete"` only once the whole command, including any mutants, finishes.

## Context check

`validate` and `run` (which validates first) check, for every job, whether an already-existing declared output is referenced by a project test file that is not in that job's `context`, `outputs`, or `ignoreTests`. This catches a worker changing an output's behavior without ever seeing the test that asserts it. The check is advisory static text matching — a project file walk (or `git ls-files` in a git work tree) plus a regexp match against each candidate output's stem — not a dependency graph: it can miss an indirect reference and, rarely, flag a coincidental one. A reference from a test to a package manifest or version-only file — `package.json`, `package-lock.json`, `pyproject.toml`, `uv.lock`, `Cargo.toml`, `Cargo.lock`, or any `__init__.py` — never counts. A finding fails validation, naming the job, the output, and the test: add the test to `context`, or list it in `ignoreTests` with a reason in the job's `prompt`. The refusal JSON also carries `suggestedIgnoreTests: {"<jobId>": ["tests/...", ...]}`, listing exactly the uncovered tests per job so the coordinator can paste them in.

### Context directory drift

`validate`/`run` also add a warning (never a refusal) when a job's `context` names 3 or more files of the same extension from one directory, and that directory holds other files of that extension the context omits — the shape of a review round's context copied from an earlier round, silently missing new captures added to the same directory since (e.g. new screenshots). `.git`, `.swarm`, and `node_modules` segments are never scanned. The warning names the directory and up to 5 of the missing files:

```json
{"code": "context-directory-drift", "jobId": "review", "dir": "shots", "extension": ".png", "present": 3, "total": 4, "missing": ["shots/d.png"], "message": "context lists 3 of 4 .png in shots; missing e.g. shots/d.png"}
```

Add the missing files to `context` directly, or declare `contextGlob` (see [Job fields](#job-fields)) so every matching file in the directory is included automatically and this warning has nothing left to report. `contextGlob` also accepts a filename prefix, `dir/prefix*.ext` (still exactly one directory, still no `**` or mid-path wildcards), for a directory that mixes several naming schemes. `validate`/`run` echo, per job, how many files each pattern actually matched: `contextGlobCounts: [{"pattern": "shots/*.png", "count": 4}]`.

A directory can mix more filename prefixes than a job's `contextGlob` actually names — a review round declaring only one capture kind (say `shots/activity-*.png`) never learns that a second kind (`shots/scoreboard-*.png`) was also captured into the same directory. Multiple `contextGlob` entries against the same directory, each with its own prefix, already work; `validate`/`run` also warn `{"code": "context-glob-partial-dir", "jobId", "dir", "extension", "prefixes", "present", "total", "missing", "message"}` when that directory holds other files of the declared extension that match none of the job's declared prefixes, naming the covered prefixes and up to 5 uncovered files. Add one `contextGlob` entry per prefix actually present in the directory to close the gap.

## Ship

`ship <run-id> --repo OWNER/NAME --pr payload.json` pushes an integrated run's branch, opens or updates its pull request, waits for CI, and merges once everything is green — refusing at any earlier step leaves nothing pushed or merged. It requires the run to already be integrated (`integrate <run-id>` must have run first) and reuses that run's saved manifest `checks`, re-running them against the committed tree before filling `<!-- swarm:checks -->` in the PR body.

```sh
node tools/swarm.mjs ship <run-id> --pr payload.json
node tools/swarm.mjs ship <run-id> --repo OWNER/NAME --pr payload.json [--require-section NAME]... [--no-merge] [--merge-method squash|merge|rebase] [--timeout SECONDS] [--poll SECONDS] [--tag-timeout SECONDS] [--no-flake-check]
```

- `--repo OWNER/NAME`: optional; when omitted, derived from `git remote get-url origin` (both `https://github.com/...` and `git@github.com:...` forms, `.git` suffix stripped). If it cannot be parsed from origin, `ship` errors `cannot derive --repo from origin <url>; pass --repo OWNER/NAME`. When `--repo` is given and differs from origin's own `OWNER/NAME`, `ship` warns `--repo X differs from origin Y`. A gh call that fails with `HTTP 301`, `302`, `307`, or `308` in its output gets its error text suffixed `(repo moved? origin is OWNER/NAME)` — a bare redirect code otherwise gives no hint that the repository itself was renamed.
- `--pr payload.json`: required, a JSON file `{title, head, base, body}` (`draft`/`maintainer_can_modify` optional), resolved against `--root`.
- `--require-section NAME`: repeatable; refuse to push unless the PR body has a non-blank `## NAME` section with the checks placeholder already filled in. When a required section's name case-insensitively matches "Mutation check" and the run's saved manifest declares no `mutants`, `ship` adds warning `no manifest mutants: declare "mutants" in the manifest and run "integrate --mutants" (see docs/verification.md)` and continues — declaring `mutants` is easy to forget under a mutation-check requirement, so the warning restates where the tooling already lives instead of letting it go unmentioned. When the same required section is present and the integrated run's mutants were reported `skipped-red-base` (see [Mutation checks](#mutation-checks)), `ship` instead refuses outright (`status: "refused"`, a reason naming the red base) — a green-looking mutation check that ran against failing checks proves nothing, so it is never accepted as satisfying the section.
- `--no-merge`: stop at `ready` once CI is green instead of merging.
- `--merge-method squash|merge|rebase`: default `squash`.
- `--timeout SECONDS` / `--poll SECONDS`: how long to wait for CI and how often to poll; defaults are 45 minutes and 20 seconds respectively (the grace period before an empty rollup counts as `no-ci` is five minutes and is not configurable from the CLI).
- `--tag-timeout SECONDS`: how long to poll origin for a release tag after merging a PR whose diff changed `package.json`'s `version` (`git ls-remote --tags origin v<version>` every 10 seconds); default 180, `0` disables the wait.
- `--no-flake-check`: disable the base-commit flake rerun described in [Flake on base](#flake-on-base) above.

`ship` prints one JSON line: `{status, repo, pr, url, sha, mergeSha, checks, ci, reason, portBase}`, where `status` is one of `merged | held | ready | refused | checks-failed | ci-failed | no-ci | timeout | merge-failed` and fields that do not apply are `null`. The re-run of `checks` gets its own `SWARM_PORT_BASE` (see [Ports](#ports) above), computed from the project root; a moved or exhausted block adds the same `port-block-moved`/`port-block-busy` warning `integrate` does. When the merged PR's diff changed `package.json`'s `version`, the result also gains `tag: {name: 'v<version>', status: 'found'|'missing'|'skipped', waitedSeconds}`; a `missing` tag also adds warning `release tag v<version> not on origin after <n>s`. A PR body whose first non-blank line starts with `**needs ` is never merged (`held`); a person merges it. Exit code is `0` for `merged`, `held`, or `ready`, and `1` for every other status.

### Ship a branch without a run

Field lesson #164: `ship --branch BRANCH --pr payload.json [--check ARGVJSON]... [other ship flags]` (no run id) ships a finished branch built outside the swarm, e.g. by an outside agent in its own worktree. `--root` must be the worktree that has `BRANCH` checked out (else refused: `--branch <b> is not checked out in <root>`), and the payload's `head` must equal `BRANCH`. Each `--check '["argv",...]'` (repeatable, at most 10, named `check-1`, `check-2`, ...) runs like a manifest check, with the env file and this root's port block; with none, the result warns `no-checks: ...`. Everything else is the same `ship`: the tracked tree must be clean, the checks fill `<!-- swarm:checks -->`, `--require-section`, the `**needs ...**` hold, the lock check and test-binary gate over the branch's diff against `origin/<base>` (else `<base>`), the packaging build check, push, PR create/update, CI wait and merge. `--check` with a run id, or `--branch` with a run id, is refused.

## Go

`go <manifest.json|run-id> [--commit-message MSG] [--repo OWNER/NAME --pr payload.json] [--require-section NAME]... [--mutants] [--merge-method M] [--timeout S]` is one command carrying a manifest (or an already-started run) as far toward a merged change as the given flags allow, stopping at the first stage that fails:

1. **run** — given a manifest path, validate it, run it to completion, and wait; given a run id instead, this stage is skipped entirely and that run id is used as-is.
2. **integrate** — `integrate <run-id>` with the manifest's `checks` (and mutation checks when `--mutants` is passed or the manifest declares `mutants`).
3. **commit** — only when `--commit-message` is given: stage exactly that run's integrated output files (`git add --` plus that exact file list, never `git add -A`) and commit them with the message verbatim.
4. **ship** — only when both `--repo` and `--pr` are given: the same `ship` described above, forwarding `--require-section`, `--merge-method`, and `--timeout`. It requires stage 3 to have run, or an already clean tree.

```sh
node tools/swarm.mjs go examples/smoke.json --commit-message "Add render review" --repo acme/widgets --pr payload.json
node tools/swarm.mjs go <run-id> --commit-message "Add render review"
```

`go` prints one JSON line: `{status, stage, runId, cost, warnings, integrate, ship, reason}`, where `stage` is the last stage reached (`run`, `integrate`, `commit`, or `ship`), `integrate`/`ship` hold that stage's own result object (or `null` if never reached), and `status` is one of `merged | held | ready | integrated | committed | failed`. Exit code is `0` for every status except `failed`.

## Advisory preflight

`node tools/swarm.mjs preflight <manifest>` validates without starting workers, then reports file byte breakdowns, repeated copied context, output/input snapshot hazards, task-size advisories, and each job's `agent`, `model`, `tier`, and `tierReason` (`null` when unset). It does not automatically split or dispatch tasks, and it does not choose or verify a tier; that stays the coordinator's judgment call against [the routing checklist](orchestration.md). See [active orchestration](orchestration.md) and [manager task contracts](managed-feature-plan.md).

`monitor` includes content-free CLI byte counts and output timestamps where observable. API requests without streaming report unavailable progress; neither output nor silence proves whether a worker is making useful progress.

Preflight exits **0 for a valid report even when `reviewRequired` is true**: advisories require coordinator judgment and an agreed contract can justify parallel snapshots. Invalid manifests/paths exit nonzero. CI that requires a reviewed plan must inspect `reviewRequired`, `advisories`, and `snapshotHazards`; a zero exit is validation, not approval to dispatch. Preflight reads and validates file contents (including API UTF-8 checks), so large repeated contexts also incur repeated local I/O.

## Kickoff diagnostics and install commands

Any agent can orchestrate; see [kickoff](kickoff.md) for skill loading and the
10-dispatch handoff. `install.mjs PROJECT [--no-agent-files]` links a project,
seeds missing coordination files, adds `.swarm/` to gitignore and writes
idempotent agent pointers unless opted out. `update` and `version` refuse
`--root` before git access; invoke the shared install runner without it.
When origin/main's `package.json` version is newer than the newest `v*` tag
(the release-tag workflow has not published it yet), `update` returns
`tagPending: true` and message `tag pending for <version>; retry in a minute`
instead of reporting up to date.

`doctor [PROVIDER|all] [--probe-local]` reports configuration/compatibility and
root tool exclusion warnings. With no flag, no network requests are made.
Opt-in probes check loopback Ollama/Lambda HTTP health, not model access, with
a short timeout and no credentials or redirects. Remote endpoints stay
configuration-only. `preflight` includes the same static exclusion advisories.

### Toolchains

Field lesson #106: macOS purges unread files under `/tmp` (and its `/private/tmp`
realpath) after about 3 days, silently breaking a toolchain that lives there.
Every `doctor` result (every agent) adds `toolchains: {dir, exists, tmpPaths}`
— `dir` is `SWARM_TOOLCHAINS` when set, else `~/.project-swarm/toolchains`;
`exists` is whether that directory is actually there; `tmpPaths` lists every
`PATH` entry and every one of `RUSTUP_HOME`, `CARGO_HOME`, `UV_CACHE_DIR`,
`UV_PYTHON_INSTALL_DIR`, `UV_TOOL_DIR`, `PLAYWRIGHT_BROWSERS_PATH`, and
`npm_config_cache` that resolves under `/tmp` or `/private/tmp`. This is advice
only — it never changes `status`/`configured`. Onboarding prints one line:
ok when the dir exists and nothing was found under `/tmp`, else `toolchains:
move to <dir>` plus the offending paths.

import { API_AGENTS } from '../api-adapters.mjs';
import { EXTRA_CLI_AGENTS } from '../cli-adapters.mjs';

// Field lesson #202: a shell worker is told up front that the full suite is the orchestrator's own
// check at integrate, never its own job — so it never spends its last minutes sleep-polling a
// background run it started itself.
export const SHELL_SUITE_BOILERPLATE = 'Run only your own new/changed test files with the appropriate test runner; the full suite runs at integrate, never a sleep-poll on a background run.';

// Field lesson #206: a "stricter" default for a field a worker adds to a persisted/serialized
// record must not silently undo what an existing record on disk relies on.
export const NEW_PERSISTED_FIELD_BOILERPLATE = 'A new stored field states its legacy default and has a from-disk legacy test.';

const MAX_CONTEXT = 32 * 1024 * 1024;

const MAX_FILE = 16 * 1024 * 1024;

// Row #217: the total bytes of context a tool-free (API) job may declare; above this, at least
// one file cannot ride along inlined (each file is itself capped at CONTEXT_BYTE_CAP).
const CONTEXT_TOTAL_CAP = 200000;

// Row #185: a declared output at or under this size on disk is unlikely to hit an API worker's
// own output-token limit when asked for whole; larger warns toward the `edits` form instead.
const LARGE_OUTPUT_WHOLE_BYTES = 20000;

const OUTPUT_CAP_BYTES = Object.freeze({ total: 61440, perFile: 15360 });

const PROGRESS_INTERVAL = 1000;

const CLI_AGENTS = ['claude', 'codex', 'cursor', ...EXTRA_CLI_AGENTS];

// Worktree writers: codex and cursor run in a detached HEAD worktree with a shell, under a seatbelt
// profile, and write declared outputs in place. Gates whose reason is "worktree writer" use this.
const WORKTREE_WRITERS = ['codex', 'cursor'];

export const AGENTS = Object.freeze([...CLI_AGENTS, ...API_AGENTS]);

export const NON_SENSITIVE_ONLY_AGENTS = Object.freeze(['openrouter', 'openai', 'gemini', 'lambda']);

export const TIERS = ['cheap', 'mid', 'expensive'];

const API_PROGRESS_NOTE = 'Single-request API jobs return only when the request settles; incremental worker activity is not observable.';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

const CHECK_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;

const CHECK_TAIL = 2000;

// Field lesson 106: macOS purges unread files under /tmp (and its /private/tmp realpath) after
// about 3 days; a manifest that points a toolchain there works today and silently breaks later.
const TMP_PREFIX_RE = /^\/(?:private\/)?tmp(?:\/|$)/;

const TOOLCHAIN_TMP_ENV_VARS = ['RUSTUP_HOME', 'CARGO_HOME', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_TOOL_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache'];

// Field lesson 107: this runner's own core module has no shell available to any agent but
// codex, so a job assigned to write it can never itself run the tests that pin its behavior.
const CORE_MODULE_PATH = 'tools/swarm.mjs';

// Field lesson 113: a coordinator sometimes pastes a runtime-check failure straight into a job
// prompt; a worker with no shell (every agent but codex) cannot reproduce or rerun that check.
const RUNTIME_CHECK_RE = /harness|e2e|playwright|preview/i;

// Field lesson 153: a job whose own checks loop (a repeat construct in a manifest check's own
// argv) or whose prompt names a flake/race/intermittent bug needs a worker that can actually run
// and repeat that check itself, exactly like the runtime-check case above; a job whose outputs are
// all docs never runs anything, so it is exempt from every trigger this function checks.
const FLAKY_PROMPT_RE = /\b(flak(?:y|iness)|race condition|racy|intermittent(?:ly)?)\b/i;

const REPEAT_CONSTRUCT_RE = /\bseq\s+\d+\b|--repeat\b|\bfor\s+\w+\s+in\b/;

// Field lesson #254: a check spawned with its own `env PATH=...` prefix (argv[0] === 'env') that
// silently omits a program the orchestrator's own PATH has (gh, git, node, npm, uv) refuses in a
// way that reads identically to that program genuinely being absent — the check's env just never
// forwarded it.
const CHECK_PATH_PROGRAMS = ['gh', 'git', 'node', 'npm', 'uv'];

// Field lesson #255: a shell job left to search the disk for a python toolchain (no synced venv
// in its own workspace) may run pytest/ruff/mypy against some other checkout's stale environment
// instead — a `setup` step (e.g. `uv sync --offline --locked`) is what actually prevents that.
const PYTHON_TOOL_RE = /\b(python3?|pytest|ruff|mypy|uv)\b/;

// Field lesson 149: a test timeout under 5s is a hang guard masquerading as a timing assertion; a
// slow (but healthy) runner can miss it, so `validate` flags one in a job's own new/edited test
// output as soon as it's declared, rather than waiting for it to go red on an unlucky CI runner.
const PY_TIMEOUT_KWARG_RE = /\btimeout\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/g;

const JS_SET_TIMEOUT_RE = /\bsetTimeout\([^,)]*,\s*([0-9]+(?:\.[0-9]+)?)\s*\)/g;

const JS_WAITFOR_TIMEOUT_RE = /\bwaitFor\(\s*\{[^}]*\btimeout\s*:\s*([0-9]+(?:\.[0-9]+)?)/g;

// Lesson #135: a file-tools-only claude worker that writes tests reports done without ever
// running them; a claude shell job (shell: true) can run the checks itself.
const TESTS_PATH_RE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$/i;

// Field lesson 119: a job whose own output is a post-build mutants source, but that never
// declares `mutantsFile`, has its shape checked only once `integrate --mutants` finally reads it
// — well after the build already finished. Matching the shell glob `*mutants*.json` on the
// basename (not the whole path) is deliberately loose: it only needs to catch the obvious case.
const MUTANTS_FILENAME_RE = /mutants.*\.json$/i;

// Field lesson #206: a worker that adds a field to a serialized/persisted record (a Python
// @dataclass here) must state its own legacy default and reason, not choose one silently; this is
// a plain text scan of `@dataclass` bodies, not a real parser, matched against the job's own
// self-reported `newPersistedFields`.
const DATACLASS_FIELD_RE = /^\s+(\w+)\s*:\s*[^=\n]+(?:=.*)?$/;

// Field lesson #235: a date-window comparison judged only ever by a UTC clock can pass every test
// while being wrong for whoever isn't on UTC (a T66 forced run at 21:17 CT landed outside a window
// bucketed by UTC day). Fires only when a job's own output source touches a date-window call and
// none of that job's own test files (context or outputs) mention a non-UTC zone.
const DATE_WINDOW_RE = /\bdate\(|astimezone\(\s*UTC\b|timezone\.utc\b/;

const NON_UTC_ZONE_RE = /timezone\(\s*timedelta\(\s*hours\s*=|ZoneInfo\(|\bTZ\s*=/;

// Field lesson #281: a job prompt sometimes names a repo-relative path (a vendored CLI, a staged
// PDF, a venv) that exists on disk but is covered by neither tracked files, this job's own
// (already-expanded) context, nor manifest.resources — it will be silently absent from the copied
// workspace. `covered` is checked first (cheap, no filesystem access); `access` is injectable so
// tests never depend on the real filesystem's own layout.
const PROMPT_PATH_RE = /(?:^|[\s"'`(<])((?:\.\/)?[A-Za-z0-9_.*-]+(?:\/[A-Za-z0-9_.*-]+)*\/?)(?=$|[\s"'`)>,;])/g;

// Field lesson #283: a job's own final-JSON-reply demand ("Return JSON only, max N lines: {...}")
// names the exact keys its reply will carry; parsed here (a depth-aware brace scan, so a string
// value that itself contains braces or pipes never breaks it) so an attached skill's own
// `resultKeys` requirement can be checked against it before the job ever dispatches, not only once
// `integrate` reads the real result.
const RETURN_JSON_RE = /return json only/i;

// Field lesson #287: a linked-worktree root's real git dir (this very checkout's own shape) is
// read-only to a shell job's sandbox by default; a job whose prompt asks it to commit gets a
// write grant to it (see claude-shell.mjs's shellProfile) — this is only the informational
// heads-up that the grant was made, never a refusal.
const COMMIT_WORD_RE = /\bcommit\b/i;

// Field lesson #288: a codex job's own repo AGENTS.md may name a required doc that is tracked but
// not in this job's own declared context — worth a warning before that job ever runs, even though
// codexMessage's own waiver line (codex-adapter.mjs) already tells the worker it need not chase a
// doc AGENTS.md names that is NOT tracked/in context/under .swarm/skills.
const AGENTS_MD_DOC_RE = /`?([A-Za-z0-9_./-]+\.md)`?/g;

// Field lesson 109: a changed lockfile means the checked-out environment may no longer match it;
// `preChecks` gives the coordinator a place to resync before the manifest's own checks run.
const LOCKFILE_NAMES = new Set(['uv.lock', 'package-lock.json', 'Cargo.lock', 'pnpm-lock.yaml']);

// Field lesson 127/148: a version-only bump to the dependency manifest itself (pyproject.toml,
// package.json, Cargo.toml) leaves the checked-out environment stale exactly like a lockfile
// change does, even though no lockfile byte moved; the same resync trigger covers both.
const DEPENDENCY_MANIFEST_NAMES = new Set(['pyproject.toml', 'package.json', 'Cargo.toml']);

const ENV_RESYNC_TRIGGER_NAMES = new Set([...LOCKFILE_NAMES, ...DEPENDENCY_MANIFEST_NAMES]);

// Field lesson #205: a shell job's own sandbox hides $HOME and anything outside its worktree; a
// check argv naming a path there can never actually be run by that worker, only by integrate
// (which runs from the real checkout). This is a plain text scan, not a path resolver, since the
// argv may itself use `~` or `$HOME` a worker's shell would expand but this check never spawns.
// The trigger tokens are the same as before (bare `$HOME`/`~/`/absolute `/Users`, `/home`), but the
// full path text following the trigger is captured too — never shown in isolation before, and the
// only way #225's exemption below can tell a granted subtree (the toolchains dir) apart from any
// other path under the same trigger.
const SHELL_SANDBOX_DENIED_PATH_RE = /(\$HOME(?:\/[^\s"']*)?|~\/[^\s"']*|\/Users\/[^\s"']+|\/home\/[^\s"']+)/;

// Field lesson #202: two shell jobs sharing one root/machine, each asked to run "the full suite"
// itself, compete for the same sandboxed resources; only the orchestrator's own check at integrate
// should ever run the full suite.
const FULL_SUITE_RE = /\bfull\s+(?:test\s+)?suite\b/i;

// Field lesson #201: `uv sync --offline` only discovers a lock that names a local (path/editable)
// source no longer present in the tree once it actually runs; a repo-relative `path = "..."` inside
// a `[[package]]`'s `source` table is checked here the same cheap, no-real-TOML-parser way
// tools/check-pins.mjs already reads uv.lock blocks.
const UV_LOCK_PATH_SOURCE_RE = /source\s*=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"[^}]*\}/;

// Field lesson 110/117: a check's tail already holds its own evidence; these two views over the
// same text serve different reports — the last few failing lines for `integrate`'s `failures`,
// and just the first one as a single-line pointer for a mutant's `firstFailingLine`.
const FAILURE_LINE_RE = /fail|error|assert|expected|✗|✕/i;

// Field lesson 128: shas and provenance strings come from the coordinator, never a worker's own
// invention; a 40- (git) or 64-hex (sha256) string is suspect only once it is both new (absent
// from the file's own prior bytes) and not read verbatim anywhere in the job's own context.
const HEX_HASH_RE = /\b[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{40}\b/g;

// Field lesson 110: a prior `integrate --require-checks` failure can be replayed into a fresh
// `validate`/`run` as `--evidence`, so a follow-up job sees the exact failing assertion text
// instead of the coordinator retyping it. The heading is fixed so a worker sees a stable marker.
const EVIDENCE_HEADING = '## Evidence: prior check failures';

// Field lesson 116: a prompt that demands one final JSON-only reply sometimes still gets prose;
// this loose match covers the two phrasings actually used across job prompts.
const JSON_DEMAND_RE = /return json only|reply with only this json/i;

// A simple glob is exactly one directory plus an optional filename prefix plus `*.ext`; no `**`,
// no mid-path wildcards. This is deliberately narrow: it only needs to catch "everything of this
// extension (optionally starting with this prefix) in this directory".
const CONTEXT_GLOB = /^([^*]+)\/([^*/]*)\*(\.[A-Za-z0-9]+)$/;

// Field lesson #245: a fix that changes two source files but supplies a mutant for only one of
// them lets the other survive mutagenesis with nothing to prove the change was ever exercised;
// every non-test source file (under tools/ or src/, never docs/CHANGELOG/package files/manifests,
// which never match this prefix) a run's own writes touch needs at least one mutant whose `file`
// matches it — from manifest.mutants, --mutants-file, or a job's own mutantsFile output alike.
const MUTANT_COVERED_SOURCE_RE = /^(tools|src)\//;

// Field lesson #267: a mutant per pass-bar comparison, not one per changed file — the above warns
// at file granularity only, so a validator gaining a second comparison on an already-covered file
// (e.g. an added `<=` bound next to an existing `<` one already covered) never warns on its own.
// Only a NEW or changed line (absent from `previous`) counts, so an untouched comparison line one
// commit's own formatting shuffled past is never flagged.
const COMPARISON_LINE_RE = /[<>]=?|[!=]==?/;

// Generated framework caches a check may ask the runner to clear first (never source, never a path of the manifest's choosing).
const CLEANABLE_DIRS = ['.next/types'];

const AGENT_LOG_BYTES = 4096;

// No existing redaction helper is shared across adapters; a narrow generic pattern for
// provider-key-shaped tokens and Bearer headers, so a captured tail never carries a live credential.
const SECRET_PATTERN = /(?:sk|ghp|gho|xox[abp])[-_A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}/gi;

const AGENT_ERROR_KEYWORDS = /\b(blocked|out of credits?|insufficient credit|quota|rate[- ]?limit|auth(?:entication|orization)?\s*(?:failed|error|required))\b/i;

// Field lesson #282: the on-disk placeholder that replaces a privateData: true job's own
// transcript/agent log; the real text only ever lives in memory (finalMessage/parseFinalJson are
// computed before either write below switches to this).
export const PRIVATE_DATA_WITHHELD_TEXT = '[transcript withheld: job declared privateData: true]';

// Output that only ever means "this never got as far as running a test".
const SANDBOX_CANNOT_START_RE = /Operation not permitted|No interpreter found|Failed to (?:inspect|query) Python interpreter|sandbox-exec:|command not found|ERR_MODULE_NOT_FOUND|dyld(?:\[\d+\])?: Library not loaded/i;

const WORKTREE_MIN_FREE_BYTES = 256 * 1024 * 1024;

// Field lesson #253: a vendor/pin bump (or any other base commit) that is already red proves
// nothing once a build lands on it — a real base failure and a worker-introduced one become
// indistinguishable until a separate base run tells them apart, well after the fact. `run`
// checks the committed base itself first, caching the verdict by base sha (`.swarm/base-checks/
// <sha>.json`) so a repeat run at the same sha never repeats the (real) spawn cost.
// Field lesson #268: every path-like token a failing check's own stdout/stderr names — a stack
// trace, a `FAILED tests/...` line — so a red base whose only failures already sit in this run's
// own declared outputs can be told apart from one that names something else entirely.
const FAILURE_LOCATION_RE = /[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g;

// A base check has no integrated/new file list, so a check naming one of those placeholders is
// never spawned at base (the literal `{integrated}` would reach the tool as a file name and read
// red); it is recorded as skipped with its reason. So is a check that opts out with `base: false`.
const INTEGRATE_ONLY_PLACEHOLDER_RE = /^\{(?:integrated|new)(?::[^}]+)?\}$/;

// A run that is not running but could still start work (paused, queued, pending or held) is cancelled in place: its unfinished jobs become
// cancelled, the pause is cleared and the run ends as cancelled, so a later resume has nothing left to start. Used by swarm stop --all.
const INACTIVE_RUN = ['paused', 'queued', 'pending', 'held'];

const UNFINISHED_JOB = ['queued', 'pending', 'held', 'running'];

const MAX_NOTES = 20, MAX_NOTE_LEN = 500;

// Lesson #176: a read-only `ask` worker given a fixed set of context files has no way to know
// whether something it never found is genuinely absent or simply lives in a file it was never
// given; "the allowlist omits it, the callback is never invoked" reads as a fact either way. This
// is a deliberately simple, word-boundary, case-insensitive scan of the worker's own answer text
// for the handful of words an absence claim is made of — not an attempt to parse meaning, just a
// flag that the claim rests only on the files it was handed.
const ABSENCE_CLAIM_PATTERN = /\b(missing|never|omits?|lacks?|drops?|not\s+invoked|not\s+called)\b/i;

// Field lesson #249: a worker's self-reported "changed" entry is prose ("out.txt created",
// "other.txt (new)"), never a bare path; trimmed, then stripped of one trailing parenthetical,
// then of one trailing status word (optionally introduced by ":" or "-") to recover the path
// itself before it is ever compared against job.outputs or shown in a warning.
const CHANGED_STATUS_WORD_RE = /(?:\s*[:-]\s*|\s+)(?:created|modified|updated|edited|deleted|removed|added|new|changed)$/i;

// Legacy tool/module failures outside T81 classification remain unrunnable.
const UNRUNNABLE_RE = /command not found|ERR_MODULE_NOT_FOUND/i;

const CHECK_ERRORED_STATUSES = new Set(['spawn-error', 'unrunnable', 'cannot-run', 'check-env-missing']);

// Field lesson #239: macOS refusing a nested sandbox_apply call inside an already-sandboxed
// worker, never a real assertion failure.
const SANDBOX_ONLY_RE = /sandbox_apply|Operation not permitted/;

export const NEXT_TASK_FILE = 'coordination/TASK.md';

// Field lesson 330 (decision #345): worktrees stay under .swarm/runs/, so a root lint/test config
// that never mentions .swarm may sweep them up; best-effort, named once per run. A pyproject.toml
// counts only when it configures pytest.
const SWARM_DIR_IGNORE_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintignore', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vitest.config.ts', 'vitest.config.mts', 'pyproject.toml', 'pytest.ini'];

// Field lesson #214: a stacked run's own recorded base/job bytes can differ from BOTH the base
// and this job's own version once a later run has touched the same file again — no longer
// provable that way ("differs from both base and job versions"). `--commit <sha>` sidesteps run
// bookkeeping entirely: a temporary worktree at HEAD, that one commit's diff reverted there
// (never on the coordinator's own tree), the checks run there, then the worktree removed.
const MISSING_EXPORT_RE = /SyntaxError:.*does not provide an export named/;

// Field lesson #266: no generic way to run a project's own chat client from here (every
// project's client differs); the nearest hook is the same shape as #159's
// packagingWithoutBuildCheckWarning — warn when a changed file looks like a model/provider route
// and no declared check looks like the real-client smoke test the row's Rule requires. The regex
// heuristic is a guess and will both over- and under-match unusual repo layouts (open question,
// not settled); it only ever warns.
const MODEL_ROUTE_FILE_RE = /model.*(route|provider|client)|(route|provider|client).*model/i;

const MODEL_ROUTE_SMOKE_CHECK_RE = /model-route-smoke|streaming-smoke/;

// Fields only the API lanes understand (the output limit and prompt caching): a job routed to a CLI lane (Cursor, Codex, Claude) does not carry them, so an escalated
// ticket (bigger output limit) is not refused by the lane that would edit it in place.
const API_ONLY_JOB_FIELDS = ['maxOutputTokens', 'cacheContext'];

// Clock-stamped notes preserve existing bytes and never interpret their text as commands.
const NOTE_INVALID_ARGS = 'note-invalid-args: provide one non-empty single-line note; use note [--file TASK.md|HANDOFF.md] text';

const NOTE_INVALID_PATH = 'note-invalid-path: target must be a regular TASK.md or HANDOFF.md inside the project with existing non-symlink parents';

// The private symbol lets the CLI guard and runner share exactly one resolved route.
const ASK_ROUTE = Symbol('resolved ask route');

const ASK_ROUTE_INVALID = 'ask-route-invalid: choose either --tier cheap|mid|expensive or --model with an optional supported --agent; configured routes require agent and model';

// Files and folders the pre-1.5 installer copied into a project. Nothing else is ever moved.
const OLD_COPY_ENTRIES=['tools/swarm.mjs','tools/preflight.mjs','tools/monitor-view.mjs','tools/cli-adapters.mjs','tools/api-adapters.mjs','tools/codex-adapter.mjs',
  'tests/swarm.test.mjs','tests/preflight.test.mjs','tests/monitor-view.test.mjs','tests/live-progress.test.mjs','tests/cli-adapters.test.mjs','tests/adapters.test.mjs','tests/codex-adapter.test.mjs',
  'skills/project-swarm','licenses/project-swarm'];

const SHIP_FLAGS_WITH_VALUE = new Set(['--repo', '--pr', '--require-section', '--merge-method', '--timeout', '--poll', '--tag-timeout', '--branch', '--check', '--rerun-flaky', '--rerun-flaky-ci', '--exempt', '--private-names', '--per-test-timeout']);

const GO_FLAGS_WITH_VALUE = new Set(['--commit-message', '--repo', '--pr', '--require-section', '--merge-method', '--timeout', '--tag-timeout', '--exempt', '--leads', '--max-jobs', '--concurrency', '--max-usd', '--max-tokens']);

export { ABSENCE_CLAIM_PATTERN, AGENTS_MD_DOC_RE, AGENT_ERROR_KEYWORDS, AGENT_LOG_BYTES, API_ONLY_JOB_FIELDS, API_PROGRESS_NOTE, ASK_ROUTE, ASK_ROUTE_INVALID, CHANGED_STATUS_WORD_RE, CHECK_ERRORED_STATUSES, CHECK_NAME, CHECK_PATH_PROGRAMS, CHECK_TAIL, CLEANABLE_DIRS, CLI_AGENTS, COMMIT_WORD_RE, COMPARISON_LINE_RE, CONTEXT_GLOB, CONTEXT_TOTAL_CAP, CORE_MODULE_PATH, DATACLASS_FIELD_RE, DATE_WINDOW_RE, DEPENDENCY_MANIFEST_NAMES, ENV_RESYNC_TRIGGER_NAMES, EVIDENCE_HEADING, FAILURE_LINE_RE, FAILURE_LOCATION_RE, FLAKY_PROMPT_RE, FULL_SUITE_RE, GO_FLAGS_WITH_VALUE, HEX_HASH_RE, ID, INACTIVE_RUN, INTEGRATE_ONLY_PLACEHOLDER_RE, JSON_DEMAND_RE, JS_SET_TIMEOUT_RE, JS_WAITFOR_TIMEOUT_RE, LARGE_OUTPUT_WHOLE_BYTES, LOCKFILE_NAMES, MAX_CONTEXT, MAX_FILE, MAX_NOTES, MAX_NOTE_LEN, MISSING_EXPORT_RE, MODEL_ROUTE_FILE_RE, MODEL_ROUTE_SMOKE_CHECK_RE, MUTANTS_FILENAME_RE, MUTANT_COVERED_SOURCE_RE, NON_UTC_ZONE_RE, NOTE_INVALID_ARGS, NOTE_INVALID_PATH, OLD_COPY_ENTRIES, OUTPUT_CAP_BYTES, PROGRESS_INTERVAL, PROMPT_PATH_RE, PYTHON_TOOL_RE, PY_TIMEOUT_KWARG_RE, REPEAT_CONSTRUCT_RE, RETURN_JSON_RE, RUNTIME_CHECK_RE, SANDBOX_CANNOT_START_RE, SANDBOX_ONLY_RE, SECRET_PATTERN, SHELL_SANDBOX_DENIED_PATH_RE, SHIP_FLAGS_WITH_VALUE, SWARM_DIR_IGNORE_CONFIGS, TESTS_PATH_RE, TMP_PREFIX_RE, TOOLCHAIN_TMP_ENV_VARS, UNFINISHED_JOB, UNRUNNABLE_RE, UV_LOCK_PATH_SOURCE_RE, WORKTREE_MIN_FREE_BYTES, WORKTREE_WRITERS };

# Phase 12 design: `swarm init` v2

Contract for two new plain-ESM modules (no dependencies, no model calls, no network; every dependency is passed in) and the wiring done by hand in `tools/init.mjs` and `tools/swarm.mjs`. Plan: `docs/plans/swarm-scale-plan-v2.md` (Phase 12). Helpers to reuse from `tools/journal.mjs`: `safeWritableDir`, `assertRegularOrMissing`, `sanitizeText`.

## 1. The project profile (`tools/init-profile.mjs`)

Stored under `profile` in `.project-swarm.json`:

```js
{
  stack: [{ name: 'node', packageManager: 'npm' }],        // from detectStack (already exists)
  sensitive: true | false,                                   // default true; false only when the owner said so
  protectedPaths: ['.env', 'secrets/'],                      // never written by any job
  budget: { maxUsd: 5, maxTokens: 2000000 },                 // default for go and plan when no flag is given
  baseCheck: { status: 'green' | 'red' | 'skipped' | 'none', ranAt, head, checks: [{ name, ok, exitCode, tail }] }
}
```

```js
export const DEFAULT_PROFILE_BUDGET = Object.freeze({ maxUsd: 5, maxTokens: 2000000 });
export async function detectProtectedPaths(root, { list })     // list(root) -> tracked + untracked relative paths; returns the sorted protected entries found
export function normalizeProtectedPath(value)                  // -> clean relative path ('dir/' keeps its slash), or throws Error('protected-path-invalid: ...')
export function validateProfile(profile)                       // -> { profile (normalized copy), errors: [string] }
export function protectedPathHit(profile, file)                // -> the protected entry that covers `file`, or null
export function protectedViolations(profile, jobs)             // -> [{ job, path, entry, kind: 'output' | 'deletes' }]
export async function runBaseChecks(root, checks, { run, head, now, timeoutMs })  // see below
export function formatBaseCheck(baseCheck)                     // -> one short line
```

- `detectProtectedPaths` returns the entries that exist: `.env`, any `.env.*` file, folders named `secrets`, `credentials`, `.ssh`, `.aws`, `.gnupg`, `private`, `keys` (as `name/`), and files ending `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`, or named `id_rsa`, `id_ed25519`, `credentials.json`, `serviceAccount.json` (at any depth, as the exact relative path). Capped at 50 entries.
- `normalizeProtectedPath`: trims; rejects empty, absolute paths, `..` segments, NUL, glob characters (`* ? [ ] { }`), backslashes, and anything over 200 characters; strips a leading `./`; keeps a single trailing `/` for folders.
- `protectedPathHit`: an entry ending `/` covers every path inside that folder (and the folder itself without the slash); any other entry covers exactly that path and anything inside it if it is a folder. Matching is case-insensitive. `.git/` and `.swarm/` are always protected, whatever the profile says.
- `validateProfile`: unknown keys are errors; `sensitive` must be boolean; `protectedPaths` an array of at most 100 normalizable strings (duplicates removed); `budget.maxUsd` finite number > 0 and `budget.maxTokens` positive integer (both optional, defaults filled in); `baseCheck.status` in the list; `baseCheck.checks` at most 20 items of `{ name: string<=60, ok: boolean, exitCode: integer|null, tail: string }` with `tail` cut to 500 characters and sanitized with `sanitizeText`. The `stack` is passed through when it is an array of at most 10 `{ name: string, packageManager?: string }`.
- `protectedViolations(profile, jobs)` looks at each job's `outputs` and `deletes` arrays.
- `runBaseChecks(root, checks, { run, head, now, timeoutMs = 300000 })`: `run(argv, { cwd, timeoutMs })` resolves `{ exitCode, stdout, stderr }` or rejects (a rejection or timeout counts as a failed check with `exitCode: null` and the error message as `tail`). No checks → `{ status: 'none', ranAt, head, checks: [] }`. Every check ok → `green`; any failure → `red`. `tail` is the last 500 characters of stderr then stdout, sanitized. Checks run one after another, at most 10 of them. `ranAt` is `new Date(now()).toISOString()`.
- `formatBaseCheck`: `Base checks: green (2 checks, 2026-10-15T...)`, or `Base checks: RED, already failing before any change: test, lint`, `Base checks: not run`, `Base checks: none defined`.

## 2. The repo map (`tools/repo-map.mjs`)

```js
export const MAP_VERSION = 1;
export async function buildRepoMap(root, { previous, list, readFile, stat, head, now })   // -> map
export function summarizeMap(map, { scope })    // -> { files, languages: {js: n}, tests, links, exports, scope: [...]? } numbers only, plus up to 20 hub files
export async function readRepoMap(root)         // .swarm/project/repo-map.json or null; invalid JSON or version -> null
export async function writeRepoMap(root, map)   // symlink-safe atomic write (temp file O_EXCL|O_NOFOLLOW, rename)
export function mapIsFresh(map, head)           // map.head === head and head is a non-empty string
```

The map object:

```js
{
  version: 1, head, builtAt,
  files: { 'src/a.js': { bytes, mtimeMs, lang: 'js', exports: ['foo', 'Bar'], imports: ['src/b.js'], external: ['lodash'], isTest: false } },
  testLinks: [{ test: 'tests/a.test.js', source: 'src/a.js', by: 'import' | 'name' }],
  importedBy: { 'src/b.js': ['src/a.js'] },       // the import graph, reversed
  stats: { files, tests, links, reused }           // reused = entries taken from `previous` unchanged
}
```

Rules:
- `list(root)` returns the project's tracked files (the caller uses `git ls-files`, falling back to a walk that skips `.git`, `node_modules`, `.swarm`, `dist`, `build`, `__pycache__`, `.venv`, `target`). Only the first 20000 files are mapped; paths with `..`, absolute paths, or NUL are skipped. Binary or unreadable files, and files over 1 MiB, are listed with `lang: null`, no exports and no imports.
- Incremental: an entry from `previous.files` is reused as is when its `bytes` and `mtimeMs` equal what `stat` reports now; everything else is re-read. Files that are gone drop out. `stats.reused` counts reuses.
- Languages by extension: `js mjs cjs jsx ts tsx mts cts` (`js`), `py` (`python`), `go`, `rs` (`rust`); every other extension has `lang: null`.
- JS and TS exports: `export function|class|const|let|var|async function NAME`, `export default` (name `default`), `export { a, b as c }` (names `a`, `c`), `export * from` (nothing), `module.exports = { a, b }` and `exports.NAME =`. Imports (resolved to project files when they exist in the list, trying the exact path, then `.js .mjs .cjs .ts .tsx .jsx`, then `/index.js` and `/index.ts`): `import ... from 'x'`, `import 'x'`, `require('x')`, dynamic `import('x')` with a string literal. A non-relative specifier goes to `external` (package name only, scoped names kept whole), once.
- Python exports: top-level `def NAME`, `class NAME`, and `NAME = ` at column 0 for upper-case names. Imports: `import a.b` and `from a.b import c` and relative `from .x import y`, resolved to `a/b.py` or `a/b/__init__.py` relative to the project root or the importing file's folder; unresolved names go to `external` (top-level package).
- Go exports: `func Name(` and `type Name` with an upper-case first letter (not methods). Imports go to `external` (the import path). Rust exports: `pub fn|struct|enum|trait|const|type NAME`; `mod name;` resolves to `name.rs` or `name/mod.rs` next to the file.
- `isTest`: a path with a segment `test`, `tests`, `__tests__`, `spec`, or a file name matching `.test.` `.spec.` `_test.` `test_*.py` `*_test.go`.
- `testLinks`: each test file links to every source file it imports (`by: 'import'`), and, when it imports none, to the source whose base name matches (`a.test.js` or `test_a.py` or `a_test.go` to `a.js`, `a.py`, `a.go`, anywhere in the project, shortest path first) (`by: 'name'`). At most 5 links per test. Tests are never link targets.
- `importedBy` lists at most 200 importers per file, sorted. All lists are sorted and deduplicated so two builds of the same tree give the same JSON (apart from `builtAt`).
- `summarizeMap(map, { scope })`: `scope` is an optional array of folder entries (`src/`); counts only files inside it. `hubs` is the 20 files with the most importers (path and count), most first, ties by path.
- Writing: `.swarm/project/repo-map.json` through `safeWritableDir`; the file is never larger than 20 MB (drop `exports` beyond 200 names per file first, then refuse with `repo-map-too-large`).

## 3. Setup health check (`checkSetup`, in `tools/init-profile.mjs`)

```js
export async function checkSetup(root, deps)   // deps: { readJson, exists, stat, head, installVersion, readMap, readProfile, now }
// -> { ok: boolean, items: [{ id, level: 'ok' | 'warn' | 'fail', message }] }
```

Read-only. Items, in this order: `pointer` (`.project-swarm.json` exists and parses; fail if not), `version` (its `version` equals `installVersion`; warn when it differs), `profile` (all four profile keys present and valid; warn for each missing one, fail for an invalid one), `checks` (`coordination/checks.json` exists and has at least one check; warn if not), `base` (green: ok; red: warn naming the failing checks; none/skipped: warn that the base was never checked; also warn when `baseCheck.head` differs from the current head), `map` (fresh: ok; stale: warn; missing: warn), `ignore` (`.swarm/` appears in `.gitignore`; warn if not), `pointers` (`AGENTS.md` and `CLAUDE.md` exist and mention `swarm brief`; warn if not), `protected` (every protected entry that is a plain file or folder name exists or is a pattern the project could create later: never fails). `ok` is false only when some item has level `fail`. Each message is one line under 160 characters.

## CLI behavior (by hand)

- `swarm init [--sensitive | --not-sensitive] [--protect PATH]... [--max-usd N] [--max-tokens N] [--no-base-check] [--no-map] [--yes]`: links and seeds as before, then writes the profile. With a terminal and neither sensitivity flag it asks once, `Is this project sensitive (private code or data)? [Y/n]`; without a terminal the default is sensitive. Protected paths are the detected ones plus `--protect`. Runs the base checks unless `--no-base-check` (they run the project's own checks, so `--no-base-check` exists for a project that has no dependencies installed yet). Builds the repo map unless `--no-map`. Re-running `init` keeps an existing profile's answers (never asks twice) and only refreshes `stack`, `baseCheck` and the map; an explicit flag overrides.
- `swarm init --check [--json]`: runs `checkSetup`; prints one line per item (`ok`/`warn`/`FAIL`), exits 1 only on a `fail`. Writes nothing.
- `swarm map [--json]`: builds or refreshes the repo map incrementally and prints a short summary (files, languages, tests, links, reused, top hubs).
- Protected paths: `validateProject` refuses a manifest whose job outputs or deletes hit a protected entry (`protected-path: job X writes Y (protected: Z)`), including child manifests of leads.
- Profile defaults: `go` and `plan` use `profile.budget` when no `--max-usd` / `--max-tokens` is given, and `profile.sensitive === false` makes the lead jobs they plan `sensitive: false`.
- `swarm plan` shows `Base checks: ...` and adds the risk `base-red` when the recorded base is red; it refreshes the repo map incrementally when it is stale (best effort, never fails the plan).

## Done when

A fresh clone of a real project goes from `swarm init` to a green `swarm plan` with no hand edits (a test does this in a temporary repo with a `package.json` test script), and `swarm init --check` reports no `fail` afterward.

## Changes after the safety review

- The base check runs only with `--base-check` or after a terminal confirms the listed commands (it executes what the repository ships); it uses a small environment and its own process group.
- `.project-swarm.json` and `coordination/checks.json` are always protected; `outputDirs` count as outputs; names compare in NFC; a profile that is not valid makes `validate`, `run` and `integrate` refuse (`profile-invalid`); the gate also runs when `integrate` is about to apply files.
- `checkSetup`'s `exists`, `readJson` and `stat` take paths relative to the project root; `buildRepoMap`'s `stat` may return `size` or `bytes`, and a symlink, device or fifo is listed but never read.

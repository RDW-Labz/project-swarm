# T86 contract - job worktrees outside the repository root (release 1.45.0)

Single source for every T86 builder. Brief: `docs/_swarm/t86-brief.md` (option B, decision #345).
Line numbers below are from the 1.44.0 tree and only help you find code; match on the quoted code, not the number.

## 1. Rules every job follows

1. Minimal change. Make the smallest diff that meets this contract. No drive-by refactors, renames, reformatting or new comments beyond the ones named here.
2. Real paths only (lesson 299). Every stored or compared worktree path is an absolute `fs.realpath` result. `realpath` the existing base dir first, then `path.join` the segments below it, because the job dir does not exist yet.
3. Record before checkout. `record.worktreePath` is set and saved to state.json (`await queueSave()`) before `git worktree add` runs, so a crash or cancel mid-checkout still leaves a findable path.
4. One derivation point. Only `resolveWorktree(state, job)` may build a worktree path from a run id. Nothing else (code or test) joins `.swarm/runs/<id>/worktrees` or `<base>/<id>/<job>` by hand. The only exceptions are the T81 fixtures named in section 4.2, which keep the literal old path on purpose to prove the shim.
5. Windows-safe paths. Use `path.join` / `path.dirname` / `path.relative` only. No string concatenation with `/`, and no `:` or other reserved characters in generated segments. Sanitize the repo segment to `[A-Za-z0-9._-]`.
6. No new dependencies. Use only Node built-ins (`fs.statfs` exists on Node >= 18.15; engines is >= 20.3) and modules swarm already imports.
7. Behaviour with the flag off is byte-identical to 1.44.0, apart from the new optional `worktreePath` key on worktree-job records and the new `worktree` key in inspect output for kept worktrees.
8. Keep/remove decisions do not change. The existing `keepWorktree` logic in both executors decides what is kept. T86 changes only where the worktree is placed and how it is found.
9. Touch only the functions your job owns (section 2). If you need a change elsewhere, return `blocked` and name the function.

## 2. Layout and ownership

| Job | Writes (only these files) | Owns |
|---|---|---|
| `t86-core` | `tools/swarm.mjs` | Functions listed in 2.1 |
| `t86-tests-new` | `tests/t86-worktree-relocation.test.mjs` (new) | Whole file |
| `t86-tests-existing` | `tests/codex-adapter.test.mjs`, `tests/claude-shell.test.mjs`, `tests/field-lesson-t81-cli.test.mjs` | Only the lines listed in 4.2 plus one new T81 test |
| `t86-release` | `CHANGELOG.md`, `package.json` | Section 5 text only |

`t86-tests-new` and `t86-tests-existing` run after `t86-core`. `t86-release` is independent.
No job edits `tools/claude-shell.mjs`, `tools/codex-adapter.mjs`, `tools/pipeline.mjs` or `tools/local-config.mjs`. A grep found no worktree-path building in them. Both sandbox profiles already grant the worktree read/exec/write after their home and temp denies, and later rules win.

### 2.1 `t86-core` in `tools/swarm.mjs` (a 407 KB file; edit in place with Edit, never rewrite it)

May add (new, top-level, next to `jobWorktreePath` around line 1518 unless stated otherwise):
- `export function resolveWorktree(state, job)`
- `export async function worktreesBaseFor(root, config = {}, { env = process.env } = {})`
- `const WORKTREE_MIN_FREE_BYTES` and `async function prepareWorktreeLocation(worktree, { statfsImpl = fs.statfs } = {})`
- `const worktreeDiskLowResult`, next to `scratchInsideRepoResult` (around line 1495)
- `export async function listOrphanWorktrees(root, { env = process.env } = {})`, next to `cancelRun`

May edit only:
- `jobWorktreePath` (around line 1520)
- `executeCodexJob` (around line 1524)
- `executeClaudeShellJob` (around line 1694)
- `runManifestBody` (around line 1951): state setup, the `swarmDirWarning` line, the `portBase` line (around line 2113), the two executor calls (around lines 2133–2134), and the end-of-run block after the `keptWorkspace` loop (around line 2341)
- `inspectRun` (around line 4005): the `jobs.push({...})` entry only
- `swarmDirNotIgnoredWarning`'s preceding comment, and the comment above `jobWorktreePath`
- `main()`: the command allowlist line (around line 5482), the dispatch chain (around lines 5571–5575) and the usage/help text line that lists `board`
- The import line from `./claude-shell.mjs`, only if `scratchRootDir` is not already imported

Do not touch anything else, including `integrateRun`, `cancelRun`, `readState`, `waitRun`, `inspectResults`, the ship/redcheck worktrees (around lines 2722, 2801 and 3527), `validateManifest` and both sandbox profile builders.

## 3. Exact names and behaviour

### 3.1 Config (read with the existing `loadLocalConfig({ env })`; file is `$SWARM_CONFIG` or `~/.project-swarm/config.json`)
- `worktreesOutsideRoot`: boolean, default off. Only the literal `true` turns it on. In 1.45.0 a missing key means off.
- `worktreesDir`: optional absolute path that overrides the scratch base. If it is set but is not a string or not absolute, `worktreesBaseFor` throws `config worktreesDir must be an absolute path`.

### 3.2 Scratch dir location
Default base: `path.join(scratchRootDir({ env }), 'worktrees')`. This is the same root the shell scratch dirs use (`SWARM_SCRATCH_ROOT`, then `SWARM_INSTALL_ROOT`, then `$XDG_STATE_HOME/project-swarm`, then `~/.project-swarm-scratch`). With the override, the base is `config.worktreesDir`.
Layout: `<realBase>/<repoSegment>/<runId>/<jobId>`, where `repoSegment = <basename(realRoot) sanitized>-<sha256(realRoot) first 12 hex>`.

```js
export async function worktreesBaseFor(root, config = {}, { env = process.env } = {}) {
  const configured = config.worktreesDir;
  if (configured !== undefined && (typeof configured !== 'string' || !path.isAbsolute(configured))) fail('config worktreesDir must be an absolute path');
  const base = configured ?? path.join(scratchRootDir({ env }), 'worktrees');
  await fs.mkdir(base, { recursive: true });
  const realBase = await fs.realpath(base);
  await assertScratchOutsideRepo(realBase, file => fs.access(file));
  const realRoot = await fs.realpath(root);
  return path.join(realBase, `${path.basename(realRoot).replace(/[^A-Za-z0-9._-]/g, '_')}-${digest(realRoot).slice(0, 12)}`);
}
```

### 3.3 state.json fields
- Run level: `worktreesBase` (string, a real path). Present only when the flag is on and the manifest has at least one `usesWorktree` job.
- Job level: `worktreePath` (string, absolute, real). Set for codex and claude-shell jobs in both flag modes, before checkout. Never set on queued jobs that never started, or on copied-workspace jobs. It is an optional key. It is not added to the initial `state.jobs.push({...})` record.

### 3.4 The helper (exact text; mutants 1 and 2 match these lines)
```js
// T86: the one place a job worktree path is derived from a run id; every reader goes through it.
export function resolveWorktree(state, job) {
  if (typeof job.worktreePath === 'string' && job.worktreePath) return job.worktreePath;
  if (typeof state.worktreesBase === 'string' && state.worktreesBase) return path.join(state.worktreesBase, state.id, job.id);
  // T86 shim, removed one release after the default flips: runs from before 1.45.0 record no worktreePath.
  return path.join(state.root, '.swarm', 'runs', state.id, 'worktrees', job.id);
}
```
`jobWorktreePath(root, directory, jobId)` keeps its signature and its `safePath(..., { internal: true, parents: true })` validation, but takes the path from the helper:
`return safePath(root, path.relative(root, resolveWorktree({ root, id: path.basename(directory) }, { id: jobId })), { internal: true, parents: true });`

### 3.5 Run wiring (`runManifestBody`)
- Immediately after `const state = {...}`:
  ```js
  const worktreeConfig = loadLocalConfig({ env });
  if (worktreeConfig.worktreesOutsideRoot === true && manifest.jobs.some(usesWorktree)) state.worktreesBase = await worktreesBaseFor(root, worktreeConfig, { env });
  ```
- `const swarmDirWarning = state.worktreesBase ? null : await swarmDirNotIgnoredWarning(root);` because the warning is moot when no copy sits under the root. `check-hit-swarm-dir` in ship/integrate is unchanged.
- Port block: `resolvePortBlock(resolveWorktree(state, record))` replaces `resolvePortBlock(path.join(root, \`${directory}/worktrees/${job.id}\`))`.
- Both executor calls get two more options:
  `worktreePath: state.worktreesBase ? resolveWorktree(state, record) : undefined, onWorktreePath: async worktreePath => { record.worktreePath = worktreePath; await queueSave(); }`
- After the `keptWorkspace` loop: for each distinct `path.dirname(record.worktreePath)` with `state.worktreesBase` set, run `await fs.rmdir(dir).catch(() => {})`. This removes the per-run dir only when it is empty, never recursively.

### 3.6 Executors (`executeCodexJob`, `executeClaudeShellJob`)
- `const worktree = options.worktreePath ?? await jobWorktreePath(root, directory, job.id);`
- First statements inside `try`, before the `worktree add` call:
  ```js
  await options.onWorktreePath?.(worktree);
  if (options.worktreePath) await prepareWorktreeLocation(worktree, options);
  ```
- In `catch`, next to the `workspace-env-invalid` line: `if (error.code === 'worktree-disk-low') { result = worktreeDiskLowResult(error.message); return result; }`
- `prepareWorktreeLocation`: `fs.mkdir(path.dirname(worktree), { recursive: true })`, then `statfsImpl(parent)`, then `free = Number(bavail) * Number(bsize)`. If `free < WORKTREE_MIN_FREE_BYTES` (`256 * 1024 * 1024`), throw an Error with `code: 'worktree-disk-low'` and the message `worktree-disk-low: <parent> has <n> MiB free, needs 256 MiB; set worktreesDir in the swarm config to another volume`.
- `worktreeDiskLowResult = message => ({ status: 'failed', worktreeDiskLow: true, refusedBeforeStart: true, error: message, ...the same null/empty fields as scratchInsideRepoResult })`.

### 3.7 Readers
- `inspectRun` job entry adds `...(usesWorktree(job)&&record.keptWorkspace?{worktree:resolveWorktree(state,record)}:{})`.
- `integrateRun` and salvage already read the absolute `record.keptWorkspace`, which equals the worktree path, so they need no change. Evidence logs (`.swarm/runs/<id>/<job>/*.txt|log`) stay in the run dir. The no-JSON fallback keeps the worktree via the existing `envelopeFallback` branch at the recorded path.

### 3.8 Cleanup rules
| Outcome | Worktree at `worktreePath` |
|---|---|
| complete, no fallback | removed (`git worktree remove --force`, existing) |
| complete via `envelopeFallback` / `envelopeInvalid` | kept (lesson 64/41, contract 3) |
| failed / timeout / blocked with changed declared outputs | kept (contracts 1, 2) |
| failed / blocked with no changes | removed (existing behaviour) |
| cancelled | removed unless outputs changed (existing finally logic); queued jobs never get a dir or a `worktreePath` |
| any | empty `<base>/<repoSegment>/<runId>` dir removed at run end; never recursive |

`cancelRun` is unchanged (it writes the marker; the executors' `finally` blocks clean up).

### 3.9 Orphan report (list-only)
- CLI: `swarm orphans`, which takes no argument (allowlist it like `board`). Dispatch: `else if(command==='orphans')result=await listOrphanWorktrees(root);`. Help line: `orphans   list scratch worktree dirs no run state points to (never deletes)`.
- `listOrphanWorktrees(root, { env })` takes the base from `worktreesBaseFor(realRoot, loadLocalConfig({ env }), { env })`. The referenced set is every `job.worktreePath` from each readable `.swarm/runs/*/state.json` (via `readState`, skipping unreadable ones). The candidates are every `<base>/<runDir>/<jobDir>` entry. It returns `{ base, orphans: [...sorted absolute paths], deleted: 0 }` and never removes anything.

## 4. Tests

The repo runs one test file with: `node --import ./tests/_isolate-config.mjs --test <file>`. `npm test -- <file>` would also run the whole `tests/*.test.mjs` glob.

### 4.1 New: `tests/t86-worktree-relocation.test.mjs` (`t86-tests-new`)
Fixture: copy the `fixture(t)`/`fake()` shape from `tests/codex-adapter.test.mjs` (codex agent, `platform: 'darwin'`). Write a temp config `{ worktreesOutsideRoot: true, worktreesDir: <mkdtemp dir> }`, pass `env: { ...process.env, SWARM_CONFIG: <file> }`, and remove both temp dirs in `t.after`. Find every path through the exported `resolveWorktree` / `state.jobs[i].worktreePath`; never join it by hand. Test names are exact:
1. `run places worktree outside root when flag on`: the spawn `cwd` equals `state.jobs[0].worktreePath`; `path.relative(root, worktreePath)` starts with `..` or is absolute; `state.worktreesBase` is set; `.swarm/runs/<id>/worktrees` does not exist; and the worktree is removed after a complete run.
2. `state records worktreePath before checkout`: pre-create a non-empty dir at the expected path (`resolveWorktree({ root, id, worktreesBase: await worktreesBaseFor(root, config) }, { id: 'writer' })`, fixed `id`) so `git worktree add` throws. Assert that state.json on disk has `jobs[0].worktreePath` equal to it, and, through `onState`, that the first published state carrying `worktreePath` was saved while `<path>/.git` did not exist.
3. `inspect follows recorded path for failed job`: the worker writes `output.txt` and then `process.exit(7)`. `(await inspectRun(root, id)).jobs[0].worktree === state.jobs[0].worktreePath`, that path exists, and it is outside the root.
4. `blocked reply keeps evidence at recorded path`: outputs `['output.txt','missing.txt']`; the worker writes `output.txt` and the reply `{"status":"blocked","summary":"needs x"}`. Status is `blocked`, `keptWorkspace === worktreePath`, and `output.txt` there reads `proposed`.
5. `no-json reply with changed outputs falls back to worktree result at recorded path`: prose reply plus a changed `output.txt`. `envelopeFallback === 'worktree'`, `keptWorkspace === worktreePath`, it exists outside the root, and `git worktree list --porcelain` includes it.
6. `shim finds worktree in old location when worktreePath missing`: with the flag off (no config), a failing-with-changes run; delete `worktreePath` from state.json on disk; `inspectRun(...).jobs[0].worktree === path.join(root, '.swarm', 'runs', id, 'worktrees', 'writer')` (the literal is allowed here; it is the shim under test) and it exists. Also make pure helper assertions: a recorded `worktreePath` wins over `worktreesBase`; `worktreesBase` gives `path.join(base, id, job)`; neither gives the old layout.
7. `root tree walk finds no swarm copy`: the flag is on and the worktree is kept (fallback reply). `fs.readdir(root, { recursive: true })` lists `input.txt` exactly once, while `path.join(worktreePath, 'input.txt')` exists.
8. `integrate copies from recorded path`: the fallback run's `integrateRun(root, id).files` deep-equals `['output.txt']`, and the root `output.txt` bytes equal `path.join(worktreePath, 'output.txt')`.
9. `cancel removes scratch dir but keeps failed-job dirs`: concurrency 2, jobs `writer` (writes output, exits 7) and `slow` (outputs `['slow.txt']`, `setInterval`; `cancelRun` after `writer` finishes). Assert that `writer.worktreePath` exists, `slow.worktreePath` is recorded and gone, and the run is `cancelled`.
10. `symlinked temp root resolves to real path`: `worktreesDir` is a symlink to a mkdtemp dir. `worktreePath` starts with `await fs.realpath(target) + path.sep` and does not start with the symlink path.
11. `low free space refuses checkout with worktree-disk-low` (extra, from brief risk 1): call `executeCodexJob` directly with `worktreePath`, a `statfsImpl` returning `{ bavail: 1, bsize: 4096 }`, and a `gitImpl` that fails on `worktree add`. The result has `refusedBeforeStart` true and an error matching `/^worktree-disk-low:/`.
12. `orphans lists unreferenced scratch dirs without deleting` (extra, from brief risk 4): `mkdir <base>/<repoSegment>/ghost-run/job`; `listOrphanWorktrees` returns it in `orphans` with `deleted: 0`, and the dir still exists.

### 4.2 Changed existing tests (`t86-tests-existing`). Flag off throughout, so asserted values do not change.
- `tests/codex-adapter.test.mjs`
  - Line 11 import: add `resolveWorktree` from `../tools/swarm.mjs`.
  - Line 44, the `removed()` helper: `path.join(root, '.swarm/runs', state.id, 'worktrees/writer')` becomes `resolveWorktree(state, state.jobs.find(job => job.id === 'writer'))`.
  - Line 214: `assert.equal(received.options.cwd, resolveWorktree(state, state.jobs[0]))`.
  - Lines 296 and 348: `const worktree = resolveWorktree(state, state.jobs[0]);`.
  - Line 391: `await assert.rejects(fs.access(resolveWorktree(state, state.jobs[1])))`, plus a new `assert.equal(state.jobs[1].worktreePath, undefined)` (queued jobs never record a path).
  - Lines 16, 82–154: profile-string fixtures; unchanged.
- `tests/claude-shell.test.mjs`
  - Line 242: `const worktree = resolveWorktree(state, state.jobs[0]);` (add the import).
  - Lines 106–115: profile-string fixtures; unchanged.
- `tests/field-lesson-t81-cli.test.mjs`
  - Lines 298 and 343 keep the literal `.swarm/runs/run-0000/worktrees/output9001` with the flag off. They stay green and prove that `jobWorktreePath` still resolves the old layout through the shim. Unchanged.
  - Add the flag-on run of the same flow in `describe('T81 Codex worktree wiring')`: `T81 sync precedes worker at a recorded worktreePath outside the root`. Copy the first test, set `worktreePath` to a mkdtemp path (realpath'd) and `onWorktreePath` to a recorder, and assert that `gitImpl` sees `args[3] === worktreePath`, the recorder got that path before `worktree add`, and the `order` assertions are identical.
- `tests/shell-scratch.test.mjs:86,91` and `tests/board.test.mjs:22`: string fixtures or unrelated wording; unchanged.
- Exact-shape state assertions: none in the files above assert a whole job record. If a builder finds one, allow the optional `worktreePath` key; do not widen anything else.

## 5. Release text (`t86-release`)
`package.json`: `"version": "1.44.0"` becomes `"version": "1.45.0"`. Change nothing else.
`CHANGELOG.md`: insert above `## 1.44.0`:
```
## 1.45.0

- Config `worktreesOutsideRoot: true` (default off) places codex and claude-shell job worktrees in a per-run scratch dir outside the repository root (`<scratch root>/worktrees/<repo>-<hash>/<run>/<job>`, override with config `worktreesDir`), so root-level lint, test and search tools never see swarm copies; `run` skips `swarm-dir-not-ignored` when it is on. (T86, lesson 330, decision #345)
- `state.json` records each worktree job's real `worktreePath` before checkout; `inspect`, `integrate`, evidence and the no-JSON fallback read it through one `resolveWorktree` helper, and a run without the field still resolves `.swarm/runs/<id>/worktrees/<job>` (compatibility shim, removed one release after the default flips). `inspect` shows `worktree` for kept worktrees. (T86)
- Checkout outside the root refuses with `worktree-disk-low` under 256 MiB free; `swarm orphans` lists scratch worktree dirs no run state points to and never deletes them. (T86)
```

## 6. Mutants (each must turn the named test red; restore after)
Check argv for all four: `['node','--import','./tests/_isolate-config.mjs','--test','tests/t86-worktree-relocation.test.mjs']`.
1. `recorded-path-ignored`, `tools/swarm.mjs`. Find `if (typeof job.worktreePath === 'string' && job.worktreePath) return job.worktreePath;`, replace with `if (false) return job.worktreePath;`. Red: `shim finds worktree in old location when worktreePath missing` (the recorded-wins assertion).
2. `shim-wrong-dir`, `tools/swarm.mjs`. Find `return path.join(state.root, '.swarm', 'runs', state.id, 'worktrees', job.id);`, replace with `return path.join(state.root, '.swarm', 'runs', state.id, job.id);`. Red: `shim finds worktree in old location when worktreePath missing`.
3. `base-not-realpath`, `tools/swarm.mjs`. Find `const realBase = await fs.realpath(base);`, replace with `const realBase = base;`. Red: `symlinked temp root resolves to real path`.
4. `flag-ignored`, `tools/swarm.mjs`. Find `if (worktreeConfig.worktreesOutsideRoot === true && manifest.jobs.some(usesWorktree))`, replace with `if (false && manifest.jobs.some(usesWorktree))`. Red: `run places worktree outside root when flag on`.

## 7. Open questions (decided provisionally)
1. Default base is `scratchRootDir()/worktrees`, not `os.tmpdir()`: lesson 263r moved shell scratch out of tmp after git-aware tools refused tmp paths, and this also survives tmp wipes and small tmp volumes.
2. Repo segment `<name>-<sha12>` sits between the base and the run id, so `swarm orphans` lists only this repo's dirs and never another checkout's.
3. Run-level `worktreesBase` plus per-job `worktreePath`: the helper can plan a path before the record exists without a second derivation site.
4. `worktreePath` is recorded with the flag off too, so after the default flips the shim serves only pre-1.45.0 runs.
5. "Keep failed and blocked" follows the existing `keepWorktree` rules (kept only when declared outputs changed or the envelope was reconstructed), because changing keep semantics is outside T86.
6. The free-space floor is a fixed 256 MiB with no config knob: a worktree is a source checkout, and `worktreesDir` already gives the escape hatch.
7. `swarm orphans` makes the base dir if it is missing (`mkdir -p` through `worktreesBaseFor`), which is harmless and saves a second path rule.
8. `tools/local-config.mjs` is assumed to return unknown keys as parsed. If it filters keys, `t86-core` returns `blocked` naming that file.
9. Ship, redcheck and flake worktrees (temporary, already outside or short-lived) are out of scope.

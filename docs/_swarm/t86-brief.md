# T86 - Move job worktrees out of the repository root

Status: design brief, no code. The four contracts come from decision #345 in docs/DECISIONS.md. The excerpt available when this was written stopped before #345, so check the contracts below against its text before building.

## 1. Goal

Project lint, test, type-check and search tools must never scan swarm copies. Today a job worktree sits under the repo root (`.swarm/runs/<id>/worktrees/`), so a tool started at the root can walk a second copy of every source file. Done means: no root-level tool visits a swarm worktree, and the project needs no ignore file to make that true.

## Contracts that must keep working (#345)

1. A failed job keeps its worktree where `inspect` finds it.
2. A blocked or malformed agent reply keeps worktree evidence.
3. A reply with no JSON but changes to declared outputs falls back to a worktree result.
4. The T81 CLI fixtures (tests/field-lesson-t81-cli.test.mjs and its siblings) still pass.

All four share one weakness: they find the worktree by building a path from the run id. Any option must keep that lookup answerable.

## 2. Options

**A - keep `.swarm/runs/<id>/worktrees/`; `run` writes tool-ignore files only when safe.**
- Pro: no path change, so all four contracts hold as they are. Smallest diff.
- Con: ignore files are per tool (lint, test runner, search, editor); each new tool is a gap.
- Con: "only when safe" means we skip when the project already owns the ignore file, and then the copies are scanned anyway.
- Con: it edits files in the user's repo, which a job runner should not do.

**B - per-run scratch dir outside the root; record the path in state.json.**
- Pro: the root holds no copy, so every tool is covered with no per-tool work.
- Pro: `inspect`, `integrate` and evidence read the recorded path, so they work wherever the dir is.
- Con: needs a new state field and a compatibility shim for runs made before the change.
- Con: scratch dirs can fill a temp disk and need cleanup rules (see risks).

**C - `git worktree add` into `<root>/../.swarm-worktrees/<repo>/<run>/<job>`.**
- Pro: same root-clean result as B; sits on the same disk as the repo, so no cross-disk surprises.
- Pro: survives a temp-dir wipe.
- Con: writes outside the repo's parent-directory permissions; fails when the parent is read-only or shared.
- Con: leaves a visible directory next to the user's projects, and parent-level tools may scan it.
- Con: same recorded-path rule needed as B, so no saving in code.

## 3. Recommendation: B

Pick B. Rules:
- `state.json` gets `worktreePath` per job (absolute, real path). Every reader (`inspect`, `integrate`, evidence capture, the no-JSON fallback) uses it first.
- Compatibility shim, one release only: when a job has no `worktreePath`, look in `.swarm/runs/<id>/worktrees/<job>`. Remove the shim in the release after the default flips.
- Write `worktreePath` before the checkout starts, so a crash mid-checkout still leaves a findable path.
- Never derive a worktree path from the run id outside one helper, `resolveWorktree(state, job)`.

## 4. Tests

New (tests/t86-worktree-relocation.test.mjs):
- `run places worktree outside root when flag on`: the job worktree path is not inside the repo root.
- `state records worktreePath before checkout`: state.json has the path even if checkout throws.
- `inspect follows recorded path for failed job`: contract 1 with the flag on.
- `blocked reply keeps evidence at recorded path`: contract 2 with the flag on.
- `no-json reply with changed outputs falls back to worktree result at recorded path`: contract 3 with the flag on.
- `shim finds worktree in old location when worktreePath missing`: an old-layout run still inspects.
- `root tree walk finds no swarm copy`: a walk from the root with the flag on sees no job file.
- `integrate copies from recorded path`: integrate output equals the worktree content.
- `cancel removes scratch dir but keeps failed-job dirs`: see risks.
- `symlinked temp root resolves to real path`: `worktreePath` is the real path (lesson 299).

Changed:
- Any existing test that joins `.swarm/runs/<id>/worktrees` by hand: switch to `resolveWorktree`; find them with a search for `worktrees`.
- T81 CLI fixtures: keep them on the old layout with the flag off (they stay green and prove the shim); add one flag-on run of the same flow. Fixture state.json files need no edit for the shim; the flag-on run reads `worktreePath`.
- Tests that assert the exact state.json shape: allow the new optional `worktreePath` key.

## 5. Rollout

1. Release N: ship behind `worktreesOutsideRoot: true` in config, default off. Shim on.
2. Dogfood on swarm's own runs with the flag on; read the failed-job and blocked-reply cases by hand once.
3. Release N+1: default on; `false` still works. Shim still on for one more release, then removed.

## 6. Risks

- Disk: scratch dirs can sit on a small temp volume. Check free space before checkout and refuse with a clear message; allow a config path override.
- Symlinked temp roots (lesson 299): a temp path can differ from its real path, so string compares against the root fail. Store and compare real paths only.
- Cleanup on cancel: remove scratch dirs of cancelled and passed jobs; keep failed and blocked ones (contracts 1 and 2). A cancel mid-checkout must not leave an unrecorded dir, so record first.
- Orphans: a crash can leave dirs no state points to. Add a list-only report of unreferenced scratch dirs; no auto-delete in this ticket.
- Same-run readers: anything still building the old path by hand silently misses the worktree. The single `resolveWorktree` helper and the search above are the guard.

## Decision #345 (verbatim, from the OASIS decisions log)

 **Lesson 330 narrowed (orchestrator, provisional under #344):** moving codex/claude-shell job worktrees outside the repo root broke four existing contracts (worktrees are inspected under `.swarm/runs/<id>/worktrees/` after failures; lessons 41/64, T81 fixtures), 10 of the 14 reds on the 1.44.0 tree. 1.44.0 ships lesson 330 as the check-output rule only (`.swarm/` lines stripped from pass/fail with warning `check-hit-swarm-dir`) plus a `run` warning `swarm-dir-not-ignored` when the root's lint/test config does not ignore `.swarm/`. Relocation stays a queued lesson needing its own design. Reasoning: the narrow fix removes the observed harm (lint failing on swarm copies) without changing where evidence lives. 

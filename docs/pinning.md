# Version pinning

Pin a linked project when it must keep running an older swarm release while the shared install on the machine updates (for example a client project that is not ready for the newest hooks yet).

## Pointer fields

In the project's `.project-swarm.json` (alongside `install`, `version`, `profile`, and the rest):

- `pinned: true` — pin at the pointer's current `version` field.
- `pinnedVersion: "x.y.z"` — pin at that release; wins over `pinned` and over `version`.

A project is pinned when either field is set. Its effective pinned version is `pinnedVersion` when set, otherwise `version`.

## Commands

- `swarm pin` — list pinned projects on this install.
- `swarm pin PROJECT VERSION` — pin and, if needed, install that release under the install root's `versions/` from git tag `vVERSION` (does not move `current`).
- `swarm unpin PROJECT` — remove `pinned` and `pinnedVersion`; `version` stays until the next `swarm update`.

`PROJECT` is a registered project folder name, id, or path.

## What update skips

On `swarm update`, pinned projects are left unchanged: no `version` rewrite, no orchestrator hook refresh, no hand-build guard refresh, no rule files. The update output prints one line per pinned project: `skipped (pinned at x.y.z)`.

`swarm update --projects` lists pinned projects in a separate `pinned` section; `--yes` never replaces them.

## Pruning

`installUser` keeps version directories that any pinned project still needs, even when they are older than the usual keep-newest-five rule. Those protected folders do not count toward the five.

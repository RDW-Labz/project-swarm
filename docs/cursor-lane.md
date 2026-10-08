# Cursor overflow lane

The Cursor lane is work you run manually with `cursor-agent` in its own git
worktree. It can take overflow work alongside swarm jobs. Swarm cannot see
these manual workers, so the guard records which files they own and refuses
overlapping claims.

A swarm-run cursor job (`"agent": "cursor"` in a manifest; see
[provider setup](providers.md#cursor-cli-cursor-macos-only)) is not part of this
lane. It is an ordinary swarm job: swarm owns its outputs, it appears on
`swarm board` (tagged `swarm-run cursor job` in guard refusals), a manual claim
on one of its outputs is refused, and it never needs a claim of its own. Use the
guard only for `cursor-agent` sessions you start yourself.

Use Python 3; no Python packages are needed. Run the guard from the repository
you intend to merge into, or set `REPO` to that repository. Claims live in
`coordination/cursor-claims.json` under `REPO`. Keep that file out of worker
changes and use the same `REPO` for all guard calls.

1. Claim the exact repository-relative files before starting work:
   `python3 tools/cursor_lane_guard.py claim cursor-task src/example.js`.
   The guard refuses files held by another Cursor job or a visible swarm job.
2. Create a separate git worktree from the claimed base and run `cursor-agent`
   there. Give it the same file boundary.
3. Before merging, run
   `python3 tools/cursor_lane_guard.py check cursor-task /path/to/worktree`.
   It refuses unclaimed changes, including untracked files, and claimed files
   changed on the target branch since the claim. Resolve any refusal, review
   the diff, and run the project's tests before merging.
4. Merge the reviewed work, then run
   `python3 tools/cursor_lane_guard.py release cursor-task`.

Before starting any swarm run, also run
`python3 tools/cursor_lane_guard.py check-manifest manifest.json` to refuse
job outputs claimed by Cursor. Use `list` to inspect current claims. Exit
codes are `0` for success, `1` for refusal, and `2` for usage errors.

`SWARM` can override the runner command. Otherwise the guard uses the install
pinned in `.project-swarm.json`; when that file is absent, it runs `node` with
the `swarm.mjs` beside the guard. A present pin whose install is missing still
fails rather than silently selecting another install.

Claims are advisory: they do not lock files or automatically intercept either
runner. Coordinate claim and dispatch operations; simultaneous calls are not
an atomic reservation. The guard only knows about swarm runs visible on
`swarm board`. Unregistered workers and edits made after a check still need
coordinator oversight.

# Third-party code and ideas

What was taken from outside this repository, where from, under which license.

## Code included (MIT)

| What | Source | Version used | License | Where it lives here |
|---|---|---|---|---|
| **robot-heads**: the TV-headed robot drawing (2D canvas, no dependencies). The TypeScript was converted to plain JavaScript and the React component replaced by a small plain-DOM mount (`robot-head.js`); nothing else was added to the drawing code. | https://github.com/fayazara/robot-heads | commit `58ebf6439a8125a769f63b22ffd35bc18834b1b5` (2026-10-10, v0.3.0) | MIT, Copyright (c) 2026 Fayaz Ahmed | `tools/watch-assets/robot-*.js` (each file starts with its source and license line); license text in `tools/watch-assets/ROBOT-HEADS-LICENSE.txt` |
| **ui-ux-pro-max-skill**: a design-intelligence skill (local CSV data and standard-library Python scripts; no network). Installed project-local, never global. Only the skill folder was copied (its tests were left out). | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | commit `56ea9cf174ed86786187daa9de0e6247cb0747e4` (2026-10-14) | MIT, Copyright (c) 2024 Next Level Builder | `.claude/skills/ui-ux-pro-max/` (license in `.claude/skills/ui-ux-pro-max/LICENSE`) |
| **acorn**: ECMAScript parser used at runtime by `tools/split-scan.mjs` to locate top-level module items and scope-aware identifier uses when planning file splits (`tools/split-module.mjs`). Dev-only; not bundled into worker runs. | https://github.com/acornjs/acorn | 8.18.0 | MIT, Copyright (C) 2012-2022 various authors (see package) | `package.json` `devDependencies`; imported from `tools/split-scan.mjs` |
| **acorn-walk**: optional AST walkers for the same split scanner (available if the scanner needs shared walk helpers). Dev-only. | https://github.com/acornjs/acorn | 8.3.5 | MIT, Copyright (C) 2012-2022 various authors (see package) | `package.json` `devDependencies` |

Before it was added the skill was read: its scripts only read their own CSV files and print results; they do not open the network, run shell commands or write outside what the command line names. It was used to write `docs/design/swarm-watch-design-system.md` (`python3 .claude/skills/ui-ux-pro-max/scripts/search.py ... --design-system`).

## Ideas only (no code copied)

Concepts that inspired features, each rebuilt from scratch against this project's own data:

- **orca**: unread badges, per-lane usage with a reset countdown.
- **ruflo**: tabs for Overview, Cost, Agents and Events; run inspect and compare.
- **archify**: keyboard shortcuts (`/` search, `?` help), deep links to a run, a job graph.
- **ComfyUI** (GPL; ideas only, zero code): highlighting which graph nodes were run again.
- **openhuman** (GPL; ideas only, zero code): a replayable run journal with the cost of each call.

Skipped on purpose: text-to-cad, CLI-Anything.

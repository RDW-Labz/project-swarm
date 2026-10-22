# Third-party code and ideas

What was taken from outside this repository, where from, under which license.

## Code included (MIT)

| What | Source | Version used | License | Where it lives here |
|---|---|---|---|---|
| **robot-heads**: the TV-headed robot drawing (2D canvas, no dependencies). The TypeScript was converted to plain JavaScript and the React component replaced by a small plain-DOM mount (`robot-head.js`); nothing else was added to the drawing code. | https://github.com/fayazara/robot-heads | commit `58ebf6439a8125a769f63b22ffd35bc18834b1b5` (2026-10-10, v0.3.0) | MIT, Copyright (c) 2026 Fayaz Ahmed | `tools/watch-assets/robot-*.js` (each file starts with its source and license line); license text in `tools/watch-assets/ROBOT-HEADS-LICENSE.txt` |
| **ui-ux-pro-max-skill**: a design-intelligence skill (local CSV data and standard-library Python scripts; no network). Installed project-local, never global. Only the skill folder was copied (its tests were left out). | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | commit `56ea9cf174ed86786187daa9de0e6247cb0747e4` (2026-10-14) | MIT, Copyright (c) 2024 Next Level Builder | `.claude/skills/ui-ux-pro-max/` (license in `.claude/skills/ui-ux-pro-max/LICENSE`) |
| **acorn**: ECMAScript parser used at runtime by `tools/split-scan.mjs` to locate top-level module items and scope-aware identifier uses when planning file splits (`tools/split-module.mjs`). Dev-only; not bundled into worker runs. | https://github.com/acornjs/acorn | 8.18.0 | MIT, Copyright (C) 2012-2022 various authors (see package) | `package.json` `devDependencies`; imported from `tools/split-scan.mjs` |
| **acorn-walk**: optional AST walkers for the same split scanner (available if the scanner needs shared walk helpers). Dev-only. | https://github.com/acornjs/acorn | 8.3.5 | MIT, Copyright (C) 2012-2022 various authors (see package) | `package.json` `devDependencies` |
| **Motion (UMD build)**: card and chip transitions, toast | https://www.npmjs.com/package/motion/v/14.5.0 (file dist/motion.js) | 14.5.0 | MIT, Copyright (c) 2024 Motion B.V. | `tools/watch-assets/vendor/motion/motion.js`; license in `tools/watch-assets/vendor/motion/LICENSE` |
| **CountUp.js (UMD build)**: count-up numbers | https://www.npmjs.com/package/countup.js/v/2.10.1 (file dist/countUp.umd.js) | 2.10.1 | MIT, Copyright (c) inorganik | `tools/watch-assets/vendor/countup/countUp.umd.js`; license in `tools/watch-assets/vendor/countup/LICENSE` |
| **ShuffleText**: ticket id decrypt effect | https://www.npmjs.com/package/shuffle-text/v/0.6.0 (file build/shuffle-text.min.js) | 0.6.0 | MIT, Copyright (c) IKEDA Yasunobu / ICS | `tools/watch-assets/vendor/shuffle-text/shuffle-text.min.js`; license in `tools/watch-assets/vendor/shuffle-text/LICENSE` |
| **PowerGlitch**: one short glitch on failure | https://www.npmjs.com/package/powerglitch/v/2.5.0 (file dist/powerglitch.min.js) | 2.5.0 | MIT, Copyright (c) 2022 Benjamin Raymond | `tools/watch-assets/vendor/powerglitch/powerglitch.min.js`; license in `tools/watch-assets/vendor/powerglitch/LICENSE` |
| **simplex-noise (ES module)**: flow field of the Hive background | https://www.npmjs.com/package/simplex-noise/v/4.0.3 (file dist/esm/simplex-noise.js) | 4.0.3 | MIT, Copyright (c) 2018 Jonas Wagner | `tools/watch-assets/vendor/simplex-noise/simplex-noise.js`; license in `tools/watch-assets/vendor/simplex-noise/LICENSE` |
| **Radix Colors, dark scales (slate, blue, green, amber, red, violet, cyan, teal)**: navy surfaces and status colours | https://www.npmjs.com/package/@radix-ui/colors/v/3.0.0 | 3.0.0 | MIT, Copyright (c) 2021 Radix | `tools/watch-assets/vendor/radix-colors/*-dark.css`; license in `tools/watch-assets/vendor/radix-colors/LICENSE` |
| **Material Line Icons animated (6 icons as one JSON subset)**: animated draw-in check, spinner, alert | https://www.npmjs.com/package/@iconify-json/line-md/v/1.2.16 | 1.2.16 (@iconify-json/line-md) | MIT, Copyright 2020 Vjacheslav Trushkin | `tools/watch-assets/vendor/line-md/icons.json`; license in `tools/watch-assets/vendor/line-md/LICENSE` |
| **Microsoft Fluent Emoji Animated (6 badges)**: done, building, thinking, sleeping, waiting badges. Converted from the 256 px animated PNG originals (0.8 to 3 MB each) to 56 px animated WebP at 12 fps with ffmpeg (libwebp, quality 60); no other change. | https://github.com/microsoft/fluentui-emoji-animated (assets/*/animated/*.png) | repo main as of 2026-10-21 | MIT, Copyright (c) Microsoft Corporation | `tools/watch-assets/vendor/fluent-emoji/*.webp`; license in `tools/watch-assets/vendor/fluent-emoji/LICENSE` |

Before it was added the skill was read: its scripts only read their own CSV files and print results; they do not open the network, run shell commands or write outside what the command line names. It was used to write `docs/design/swarm-watch-design-system.md` (`python3 .claude/skills/ui-ux-pro-max/scripts/search.py ... --design-system`).

## Code and assets under other licences

| What | Source | Version used | License | Where it lives here |
|---|---|---|---|---|
| **augmented-ui**: HUD card frames and notched chips (pure CSS) | https://www.npmjs.com/package/augmented-ui/v/2.0.0 (file augmented-ui.min.css) | 2.0.0 | BSD-2-Clause, Copyright (c) 2020 James0x57, PropJockey | `tools/watch-assets/vendor/augmented-ui/augmented-ui.min.css`; license in `tools/watch-assets/vendor/augmented-ui/LICENSE` |
| **Oxanium Variable and Geist Mono Variable (latin woff2)**: HUD headings and tabular numbers | https://www.npmjs.com/package/@fontsource-variable/oxanium/v/5.3.0 and https://www.npmjs.com/package/@fontsource-variable/geist-mono/v/5.3.0 | 5.3.0 (Fontsource, both) | OFL-1.1, Oxanium: Severin Meyer; Geist Mono: Vercel (see the LICENSE files) | `tools/watch-assets/vendor/fonts/*-latin-wght-normal.woff2`; licence text in `tools/watch-assets/vendor/fonts/LICENSE-oxanium` and `tools/watch-assets/vendor/fonts/LICENSE-geist-mono` |
| **Lucide static icons (10 SVG files)**: UI icons | https://unpkg.com/lucide-static@1.61.0/icons/ | 1.61.0 | ISC, Copyright (c) 2026 Lucide Icons and Contributors | `tools/watch-assets/vendor/lucide/*.svg`; license in `tools/watch-assets/vendor/lucide/LICENSE` |
| **Kenney Emotes Pack, Vector style 1 (8 PNG)**: state bubbles over robot heads | https://opengameart.org/content/emotes-pack | opengameart release kenney_emotesPack.zip | CC0-1.0, Kenney Vleugels (Kenney.nl), public domain dedication | `tools/watch-assets/vendor/kenney-emotes/emote_*.png`; license in `tools/watch-assets/vendor/kenney-emotes/LICENSE` |

## Ideas only (no code copied)

Concepts that inspired features, each rebuilt from scratch against this project's own data:

- **orca**: unread badges, per-lane usage with a reset countdown.
- **ruflo**: tabs for Overview, Cost, Agents and Events; run inspect and compare.
- **archify**: keyboard shortcuts (`/` search, `?` help), deep links to a run, a job graph.
- **ComfyUI** (GPL; ideas only, zero code): highlighting which graph nodes were run again.
- **openhuman** (GPL; ideas only, zero code): a replayable run journal with the cost of each call.

Skipped on purpose: text-to-cad, CLI-Anything.

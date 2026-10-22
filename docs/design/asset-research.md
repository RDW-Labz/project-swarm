# Swarm Watch: open-source asset research (2026-10-21)

Constraints used for every pick: vendorable into the repo (no runtime CDN, no build step), license checked from the LICENSE file, dark HUD style, light on CPU, respects `prefers-reduced-motion`, pauses when the tab is hidden.

Star counts and dates were read through mirrors (GitHub API was blocked during research). Re-check each license file when vendoring and record it in `docs/third-party.md`.

---

## Recommended kit (start here)

| Area | Pick | License | Size (gz) | Use |
|---|---|---|---|---|
| Agent heads | fayazara/robot-heads (have it) | MIT | — | One head per lane, live state |
| State bubbles | **Kenney Emotes Pack** | CC0 | tiny PNGs | `!` `?` `zzz` error bubbles over robot heads |
| Animated state badges | **Microsoft Fluent Emoji Animated** (copy 6–8 APNGs only) | MIT | ~100–500 KB each | done / error / thinking / sleeping badges |
| HUD frames | **augmented-ui** | BSD-2 | 16 KB | cut-corner card frames, bracket corners, notched chips (pure CSS) |
| Motion | **Motion** (vanilla `animate`) | MIT | 57 KB (mini ESM much smaller) | card enter/exit, chip state springs, layout moves |
| Counters | **CountUp.js** | MIT | 2.3 KB | live numbers count up/down |
| Decrypt text | **ShuffleText** (or baffle) | MIT | 1.9 KB | ticket ID decrypts when a ticket starts |
| Failure glitch | **PowerGlitch** | MIT | 5 KB | one short glitch on worker fail / rate-limit |
| Background | **Own Canvas2D "Hive" swarm + simplex-noise** | MIT | 4.7 KB | live swarm background driven by real data (see below) |
| Shader layer (optional) | **OGL + webgl-noise** | Unlicense + MIT | ~15 KB | slow aurora/nebula behind the swarm, 0.5× res, 30fps |
| Charts | **uPlot** + **ECharts 6.1 custom build** + **dagre** | MIT / Apache-2.0 / MIT | 21 + ~180 + 16 KB | sparklines, streams, ticket DAG, Gantt per lane, sankey, rings, heatmap |
| Icons | **Lucide** (static) + **line-md** + **SVG Spinners** (animated) | ISC / MIT / MIT | per icon ~1 KB | UI icons; draw-in check/alert; "working" spinners |
| Fonts | **Oxanium Var** (headings) + **Geist Mono Var** (numbers) | OFL | 14 + 23 KB | HUD headings, tabular numbers |
| Sound (off by default) | **Kenney Interface Sounds** + **ZzFX** | CC0 / MIT | ~1.2 KB (ZzFX) | done/fail/needs-you chimes |
| Colour tokens | **Radix Colors** dark scales + **Open Props** easing/shadows | MIT | small CSS | navy surfaces, status scales, motion tokens |

---

## 1. Animated characters / avatars

| # | Name | URL | License | Vanilla | Use | Q |
|---|---|---|---|---|---|---|
| 1 | Kenney Emotes Pack | kenney.nl/assets/emotes-pack | CC0 | yes | state bubbles over robot heads | 5 |
| 2 | Noto Animated Emoji + lottie-web light | googlefonts.github.io/noto-emoji-animation · github.com/airbnb/lottie-web | CC BY 4.0 (credit) / MIT | yes | animated state badges | 5 |
| 3 | Microsoft Fluent Emoji Animated | github.com/microsoft/fluentui-emoji-animated | MIT | yes (img) | best-looking badges, no credit needed | 5 |
| 4 | Pixel Agents (idea) + MetroCity sprites | github.com/pixel-agents-hq/pixel-agents · jik-a-4.itch.io/metrocity-free-topdown-character-pack | MIT / CC0 | sprites yes | "office floor" view: one pixel worker per agent | 4.5 |
| 5 | Rive canvas-lite + community files | github.com/rive-app/rive-wasm · rive.app/community | MIT / CC BY 4.0 per file | yes (UMD + local wasm, ~1.3 MB) | real state-machine character per lane | 4.5 |
| 6 | DiceBear (CC0 styles only, pre-generated SVGs) | github.com/dicebear/dicebear | MIT / CC0 | pre-generate | fixed identity avatar per lane | 4 |
| 7 | thinking-orbs engine | github.com/Jakubantalik/Libraries.dev | MIT | partial | "thinking" aura | 3.5 |
| 8 | Kenney Robot Pack / Toon Characters | kenney.nl · opengameart.org | CC0 | yes | extra robot/creature sprites | 3.5 |
| 9 | boring-avatars-vanilla / jdenticon / minidenticons | github.com/hustcc/boring-avatars-vanilla etc. | MIT | yes | IDs for runs/jobs | 3 |
| 10 | pixel-sprite-generator | github.com/zfedoran/pixel-sprite-generator | MIT | yes | random sprite per short-lived sub-agent | 3 |

Excluded: LottieFiles free animations (not open source), Animated-Fluent-Emojis fork (personal use only), Multiavatar (custom restrictive), DiceBear bottts/avataaars (non-standard art license), OpenMoji (CC BY-SA), Lordicon / useAnimations (paid or attribution-only).

## 2. Sci-fi HUD UI and effects

| # | Name | URL | License | Vanilla | Use | Q |
|---|---|---|---|---|---|---|
| 1 | augmented-ui | github.com/propjockey/augmented-ui | BSD-2 | yes (CSS) | HUD card frames, notched chips | 5 |
| 2 | CountUp.js | github.com/inorganik/countUp.js | MIT | yes | live counters | 5 |
| 3 | Motion (vanilla) | github.com/motiondivision/motion | MIT | yes | all transitions (WAAPI, light CPU) | 5 |
| 4 | CSS techniques (SVG grain, `@property` gradient borders, scanlines, neon) | — | own | yes | grain, header scanlines, glowing chips | 5 |
| 5 | PowerGlitch | github.com/7PH/powerglitch | MIT | yes | glitch on failure only | 4 |
| 6 | ShuffleText | github.com/ics-creative/ShuffleText | MIT | yes | decrypt ticket IDs | 4 |
| 7 | Arwes frame functions (reference) | github.com/arwes/arwes | MIT (unmaintained) | partial | octagon/corner frame shapes; generate SVG once | 4 |
| 8 | Magic UI (port effects) | github.com/magicuidesign/magicui | MIT | port | border beam on active cards, retro grid | 4 |
| 9 | Splitting.js | github.com/shshaw/Splitting | MIT | yes | staggered type-in of HUD labels | 4 |
| 10 | NumberFlow | github.com/barvian/number-flow | MIT | partial | odometer digit roll | 4 |
| 11 | anime.js v4 | github.com/juliangarnier/anime | MIT | yes | timelines, SVG line draw | 4 |
| 12 | WebTUI | github.com/webtui/webtui | MIT | yes | terminal-style live log panel | 3 |
| 13 | Uiverse Galaxy (repo items only) | github.com/uiverse-io/galaxy | MIT | yes | individual loaders/toggles | 3 |

Flagged: GSAP (free but proprietary), React Bits (MIT + Commons Clause: OK to port into our app, not to redistribute), Animate.css (only npm 4.1.1 is MIT). Excluded: typed.js (now GPL-3.0), Aceternity UI (restrictive license), grained.js, particles.js.

## 3. Ambient backgrounds and shaders

| # | Name | URL | License | Use | Q |
|---|---|---|---|---|---|
| 1 | Own Canvas2D boids/flow field + simplex-noise | github.com/jwagner/simplex-noise.js | MIT | "The Hive" live swarm background | 5 |
| 2 | OGL | github.com/oframe/ogl | Unlicense | thin WebGL for one shader layer | 5 |
| 3 | webgl-noise | github.com/stegu/webgl-noise | MIT | safe noise GLSL | 4 |
| 4 | Paper Shaders (vanilla) | github.com/paper-design/shaders | Apache-2.0 (0.0.x, pin version) | polished mesh gradient / dot grid | 4 |
| 5 | Pure CSS grid / starfield / aurora | — | own | reduced-motion fallback | 4 |
| 6 | twgl.js / regl | greggman/twgl.js · regl-project/regl | MIT | alternatives to OGL; GPU particles | 4 / 3 |
| 7 | COBE | github.com/shuding/cobe | MIT | optional dot globe of machines (MacBook, mini, dev2) | 3 |
| 8 | Granim.js | github.com/sarcadass/granim.js | MIT | background tint by swarm state | 3 |

Excluded: Shadertoy code (CC BY-NC-SA by default), Book of Shaders examples (all rights reserved), LYGIA (Prosperity: non-commercial), whatamesh / Stripe gradient copies (unclear origin), shadergradient (needs React/three), WebGL fluid sim and Vanta (too heavy for all-day).

### "The Hive": data-driven swarm background

- One glowing leader per active agent, in its lane colour; a flock of 20–40 boids follows it, sized by queue depth. Cap ~300 particles.
- Tickets/hour sets flow speed: calm drift when quiet, fast stream when busy.
- Events: new ticket = burst joins a flock; merged PR = flock pulses inward; failure = amber flicker and scatter; idle agent = leader dims, boids drift away.
- Lane type sets boid shape/trail length (Hermes, Cursor, Codex, OpenRouter, Claude).
- Performance: spatial grid, low-opacity frame fade for trails, 30fps cap, 1× pixel density, optional Web Worker + OffscreenCanvas, stop when tab hidden, one still frame under reduced motion.

## 4. Charts and graphs

| Need | Pick |
|---|---|
| Sparklines, stat-card trends | uPlot (axes off, 40px) |
| Live time series | uPlot (high rate) / ECharts (animated, lower rate) |
| Ticket dependency DAG, waves | dagre layout → ECharts `graph` (`layout:'none'`) |
| Agent ↔ ticket live network | ECharts `graph` force layout (optional: force-graph, 55 KB) |
| Gantt of runs per lane | ECharts `custom` series |
| Sankey lanes → tickets → merged | ECharts `sankey` |
| Slot-usage rings | ECharts `gauge` (progress ring) |
| Activity calendar | ECharts `calendar` + `heatmap` |

Build ECharts once with the online builder (line, graph, custom, sankey, gauge, heatmap, calendar, canvas renderer), commit the file and its NOTICE. Throttle `setOption` to 1–2/s.

Excluded: ApexCharts (license changed: paid OEM for products used by others), elkjs (EPL/GPL, 456 KB), Plotly / Mermaid (too heavy for live), lightweight-charts (attribution link required), peity (jQuery).

## 5. Icons, fonts, sound, colour

- **Icons:** Lucide (ISC) primary; Tabler (MIT) for extra dev/ops coverage; Phosphor duotone as an alternative HUD look. game-icons.net (CC BY 3.0) only with credit.
- **Animated icons:** line-md (MIT, SMIL draw-in, no JS), SVG Spinners (MIT), SpinKit (MIT CSS).
- **Fonts (OFL):** Oxanium Var 14 KB + Geist Mono Var 23 KB. Alternatives: Chakra Petch, Space Grotesk, Exo 2; JetBrains Mono, Martian Mono. Use `font-variant-numeric: tabular-nums`. Self-host the Fontsource woff2 files.
- **Sound (off by default):** Kenney Interface Sounds + Sci-fi Sounds (CC0, OGG; add MP3 copies for Safari), ZzFX (MIT, 1.2 KB generated blips).
- **Colour:** Radix Colors dark scales (slate/blue dark for navy surfaces, status scales), Open Props easing/shadow tokens; Tokyo Night palette as accent reference; OKLCH tools for ramps.

Excluded: Lordicon (CC BY-ND + player), lucide-animated / itshover / useAnimations (React-only or unclear license), Material Symbols icon font (too large), NC/ND sound packs.

---

## Rules for the build

1. Vendor exact versions into `tools/watch-assets/vendor/`, with each LICENSE/NOTICE beside it, and list every asset in `docs/third-party.md`.
2. Effects fire on events; nothing loops loudly. Idle projects are calm.
3. `prefers-reduced-motion`: all motion off, still frames only.
4. Pause every animation loop when the tab is hidden; 30fps cap for canvas/WebGL.
5. Budget: total added JS/CSS/fonts ≤ ~400 KB gz on first load; lazy-load ECharts only on pages that chart.
6. Readability first: no effect may hide or delay information.

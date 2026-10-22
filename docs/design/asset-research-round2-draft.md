## Round 2 (2026-10-22)

---

### 1. Rive and Lottie: runtimes and individual files

#### Runtimes (all MIT, vanilla-usable)

| # | Name | URL | License (file checked) | Latest | Size (gz) | Use | Q | Caveat |
|---|---|---|---|---|---|---|---|---|
| 1 | `@rive-app/canvas-lite` | github.com/rive-app/rive-wasm | MIT, github.com/rive-app/rive-wasm/blob/master/LICENSE | 2.45.0, 2026-10-17 | rive.js 110 KB + rive.wasm 323 KB (rive_fallback.wasm 326 KB) | State-machine characters, one per lane | 4.5 | Needs a local wasm (`setWasmUrl`) to avoid the CDN. About 430 KB gz total, so it must be lazy-loaded. Canvas2D only, no Rive Renderer features. |
| 2 | `lottie-web` light build | github.com/airbnb/lottie-web | MIT, github.com/airbnb/lottie-web/blob/master/LICENSE.md | 5.13.0, 2025-05-21 | `lottie_light.min.js` 46.5 KB (full build 76 KB) | Noto and Fluent animated badges as Lottie | 4 | Maintenance mode: last push 2025-09, no release in 17 months. The light build is SVG and canvas only, with no expressions. |
| 3 | `@lottiefiles/dotlottie-web` | github.com/LottieFiles/dotlottie-web | MIT, github.com/LottieFiles/dotlottie-web/blob/main/LICENSE | 0.81.0, 2026-10-06 | index.js 33 KB + wasm 496 KB (WebGL variant 22 + 542 KB) | Plays `.lottie` (compressed, themeable, state machines) | 3.5 | Pre-1.0 API that moves fast. The wasm is heavier than lottie-web. |
| 4 | `@thorvg/lottie-player` | github.com/thorvg/thorvg.web | MIT, github.com/thorvg/thorvg.web/blob/main/LICENSE | 1.1.3, 2026-10-16 | `sw-lite/thorvg.wasm` 117 KB, `gl-lite` 120 KB | Smallest Lottie renderer (wasm only) | 3.5 | Lite builds drop some features. Few vanilla examples, so API effort is higher. |
| 5 | `@lottiefiles/lottie-player` | github.com/LottieFiles/lottie-player | MIT, github.com/LottieFiles/lottie-player/blob/master/LICENSE | 2.0.12 | n/a | n/a | 1 | **Archived**, last release 2024-11. Do not adopt. |

#### Individual animation files

| # | Name | URL | License (verified on page) | Vanilla | Size | Use | Q | Caveat |
|---|---|---|---|---|---|---|---|---|
| 6 | Robot Expressions (Rive), deborah.n.oliveira, 2025-04-01 | rive.app/community/files/18720-35184-robot-expressions | CC BY, linked to creativecommons.org/licenses/by/4.0/ | yes, Rive runtime | not shown | Robot head with 5 expressions, an accessory slot and cursor tracking. Maps to lane states. | 4 | Credit required. The page does not list the state-machine inputs, so open it in a runtime to inspect. Check that Download is enabled. |
| 7 | Cute Robot (Rive), JcToon, 2022-10-11 | rive.app/community/files/3364-7072-cute-robot/ | CC BY (4.0 link) | yes | not shown | Skins, color keys, nested artboards for eyes and chest screen, a "Fly" input | 3.5 | Cartoon look, so it needs recoloring to fit the HUD style. 2022 file, so check for a runtime version mismatch. |
| 8 | Robot connecting progress indicator (Rive), HaiDo, 2025-06-04 | rive.app/marketplace/20724-39007-robot-connecting-progress-indicator-animation | CC BY (4.0 link) | yes | not shown | "Connecting" state for a worker joining | 3.5 | Sits on the Rive Marketplace route. Confirm it is free to download. |
| 9 | Kabi mascot (bryllim), 2026-09-25 | github.com/bryllim/kabi-mascot | CC BY 4.0, github.com/bryllim/kabi-mascot/blob/main/LICENSE (full text, plus a NOTICE file) | yes | `kabi.riv` about 240 KB | 41-bone rig, 8 moods, "thinking" pose, gaze tracking, head-only avatar mode | 3 | Credit required. It is a workout bull, so it does not fit a sci-fi HUD. Useful mainly as a state-machine reference. |
| 10 | Cloud mascot, 6 expressions (Rive), AnggaMotion, 2026-03-23 | rive.app/community/files/26964-50676-rive-app-mascot-cloud-character-with-state-machine-and-6-expressions/ | CC BY (4.0 link) | yes | not shown | 6 expression states for status | 3 | Credit required. It is a cloud character, not a robot. |
| 11 | Loader (Rive), ikpativictor, 2025-08-27 | rive.app/community/files/23208-43471-loader | CC BY (4.0 link) | yes | not shown | Plain loading indicator | 2.5 | Credit required. |

I found no open Lottie file with an explicit CC0, MIT or CC BY 4.0 license beyond what the existing document lists. LottieFiles files fall under the Lottie Simple License, and some say "do not modify and re-publish". The Rive community license label comes from the page only; the page shows no license text. At vendoring time, record the page URL, the creator and the download date in `docs/third-party.md`, plus a credit line.

---

### 2. HUD frames, panels, corners, hex and circuit

| # | Name | URL | License (file checked) | Vanilla | Size | Use | Q | Caveat |
|---|---|---|---|---|---|---|---|---|
| 1 | Kenney UI Pack Sci-Fi | kenney.nl/assets/ui-pack-sci-fi | CC0 (page links the CC0 1.0 dedication) | yes (images) | 130 files | Panel, button and slider art for HUD cards, sliced into a few images | 4 | The page does not state formats or sizes, so check the zip. No credit needed. |
| 2 | Hero Patterns | heropatterns.com | CC BY 4.0 (badge on the page, links creativecommons.org) | yes (SVG) | ~1 KB per pattern | Circuit-board, hexagons and plus patterns as faint backdrop tiles, with a "Download unstyled SVG" option | 4 | Credit "Hero Patterns by Steve Schoger" is required. I could not read license text beyond the badge. |
| 3 | `cybercore-css` 0.3.0 | github.com/sebyx07/cybercore-css | MIT, github.com/sebyx07/cybercore-css/blob/main/LICENSE | yes | 12.7 KB gz | Neon, glitch and corner-bracket classes. Mine for ideas rather than adopt whole. | 3 | Only 75 stars. It would clash with augmented-ui and our own tokens. |
| 4 | `nocturne-css` 0.1.0 (Cyberpunk 2077 style) | github.com/starside-io/nocturne | Apache-2.0, github.com/starside-io/nocturne/blob/main/LICENSE | yes | 14.1 KB gz | Reference for HUD styling | 2.5 | 3 stars, v0.1.0. |
| 5 | `ScifiUI` (nsursock) | github.com/nsursock/ScifiUI | MIT, github.com/nsursock/ScifiUI/blob/main/LICENSE | Tailwind v4 dependency | n/a | Corner brackets and glass panes | 2 | Needs Tailwind, so it is incompatible with the no-build rule. |
| 6 | `honeycomb-grid` 4.1.5 | github.com/flauwekeul/honeycomb | MIT (npm metadata) | partial | 53 KB unpacked | Hex-grid math for a "hive cell" layout of agents | 3 | I did not check a separate LICENSE URL. For a plain hex layout, ~30 lines of own math is simpler. |
| 7 | `fancy-border-radius` | github.com/9elements/fancy-border-radius | MIT | yes | n/a | Organic blob shapes | 2 | Poor fit for a sci-fi HUD. |

Rejected here:
- Clippy has no license (bennettfeely/clippy: NONE).
- `trianglify` is GPL-3.0.
- A 21st.dev HUD chart has an unknown license and needs recharts.
- The astro-scifi-ui theme's license is unverified and it needs Astro and Tailwind.

---

### 3. Textures and procedural pattern generators

| # | Name | URL | License (file checked) | Vanilla | Size | Use | Q | Caveat |
|---|---|---|---|---|---|---|---|---|
| 1 | `css-doodle` 0.62.0 | github.com/css-doodle/css-doodle | MIT, github.com/css-doodle/css-doodle/blob/main/LICENSE | yes (web component) | 87 KB gz | Design patterns once at build time, then freeze the generated SVG or CSS into static files | 4 | Too heavy to ship at runtime. Released 2026-10-18, actively maintained. |
| 2 | `textures.js` 1.2.3 | github.com/riccardoscalco/textures | MIT, github.com/riccardoscalco/textures/blob/master/license | needs d3 | 2.0 KB gz | SVG hatch, circle and line fills for chart areas | 3 | Needs d3-selection. Last release 2021. Better to hand-write 5 `<pattern>` tags. |
| 3 | `svg-patterns` | github.com/derhuerst/svg-patterns | ISC, github.com/derhuerst/svg-patterns/blob/master/license | yes | small | Generate SVG pattern strings | 2.5 | Last push 2022. |
| 4 | `geopattern` 1.2.3 | github.com/btmills/geopattern | MIT, github.com/btmills/geopattern/blob/master/LICENSE | yes | ~0.5 KB core stub | Deterministic geometric backgrounds from a string | 2.5 | Last release 2015. Needs a jQuery-free fork or an own port. |
| 5 | `noise-maker` | github.com/CatsJuice/noise-maker | MIT | partial | n/a | SVG noise generator | 2 | 6 stars. The existing document already covers SVG grain by own technique. |
| 6 | `patternfills` (iros) | github.com/iros/patternfills | MIT | yes | n/a | SVG pattern snippets | 2.5 | Last push 2021. |
| 7 | Kenney Particle Pack | kenney.nl/assets/particle-pack | CC0 (page) | yes (PNG, 512 px) | 80 files | Glow, spark and smoke sprites for canvas trails (also area 5) | 4 | PNG sprites, so use `globalCompositeOperation: "lighter"`. Check sizes in the zip. |

Rejected here:
- Subtle Patterns and Transparent Textures: mixed licenses, many CC BY-SA.
- Haikei and Pattern Monster: custom terms I could not confirm.

---

### 4. Micro-interaction sets

| # | Name | URL | License (file checked) | Vanilla | Size (gz) | Use | Q | Caveat |
|---|---|---|---|---|---|---|---|---|
| 1 | `@formkit/auto-animate` 0.10.0 | github.com/formkit/auto-animate | MIT, github.com/formkit/auto-animate/blob/master/LICENSE | yes, one call | `index.min.js` 3.3 KB | Auto enter, exit and reorder for card lists | 5 | Released 2026-07-10. It respects reduced motion. |
| 2 | `vanilla-tilt` 1.8.1 | github.com/micku7zu/vanilla-tilt.js | MIT, github.com/micku7zu/vanilla-tilt.js/blob/master/LICENSE | yes | 2.5 KB | Hover tilt and glare on agent cards | 4 | Last release 2023-08. Keep it for focused or hovered cards only. |
| 3 | `canvas-confetti` 1.9.4 | github.com/catdad/canvas-confetti | ISC, github.com/catdad/canvas-confetti/blob/master/LICENSE | yes | `confetti.module.mjs` 6.9 KB | One burst when a PR merges | 4 | Released 2025-10-25. It has a reduced-motion option. Use sparingly, not on every event. |
| 4 | `vivus` 0.4.6 | github.com/maxwellito/vivus | MIT, github.com/maxwellito/vivus/blob/master/LICENSE | yes | `vivus.min.js` 4.2 KB | SVG line-draw for DAG edges and frames | 3.5 | No release since 2021. The anime.js already listed can do the same. |
| 5 | `mo.js` 0.288.2 / 1.7.1 | github.com/mojs/mojs | MIT, github.com/mojs/mojs/blob/main/LICENSE.md | yes | not measured | Burst, ring and shape bursts | 3 | npm still shows 2017 (0.288.2). The GitHub release is v1.7.1 from 2023. Version mismatch, so avoid. |
| 6 | `loaders.css` 0.1.2 | github.com/ConnorAtherton/loaders.css | MIT per `package.json` only (no LICENSE file, README or license API hit) | yes | small | CSS loader shapes | 2 | Stale since 2016. SpinKit and SVG Spinners are already covered. |
| 7 | `node-waves` 0.7.6 | github.com/fians/Waves | MIT (npm metadata) | yes | n/a | Press ripple | 2.5 | Stale since 2018. |

Rejected here:
- `Hover.css`: dual license that needs a paid commercial license (checked license.txt).
- `ScrollReveal`: no license detected on GitHub (repo shows NONE).
- `typed.js`: GPL-3.0.

---

### 5. Richer swarm background and richer agent cards

#### Background and particles

| # | Name | URL | License (file checked) | Vanilla | Size (gz) | Use | Q | Caveat |
|---|---|---|---|---|---|---|---|---|
| 1 | `tsParticles` (`@tsparticles/slim`) 4.4.0 | github.com/tsparticles/tsparticles | MIT, github.com/tsparticles/tsparticles/blob/main/LICENSE | yes, bundle | slim bundle 44.5 KB, confetti bundle 38 KB, basic 596 KB unpacked | Links, attractors, trails and emitters without writing a loop | 3.5 | License is clean MIT, the standing question you asked. Released 2026-08-31. Heavy against our ~400 KB budget, and our own Hive loop is smaller and data-driven. |
| 2 | `d3-force` 3.0.0 | github.com/d3/d3-force | ISC (npm metadata) | yes | `d3-force.min.js` 3 KB | Force layout for agent and ticket "constellation" | 4 | The UMD file needs d3-dispatch, d3-quadtree and d3-timer beside it (each ISC and small). Not bundled. Last release 2021, stable. |
| 3 | `pts` 1.0.3 | github.com/williamngan/pts | Apache-2.0, github.com/williamngan/pts/blob/master/LICENSE | yes | `pts.min.js` 66 KB | Canvas and SVG geometry, noise, particle examples | 3 | Needs NOTICE if Apache. Released 2026-10-16. |
| 4 | `matter-js` 0.20.0 | github.com/liabru/matter-js | MIT, github.com/liabru/matter-js/blob/master/LICENSE | yes | not measured | Physics-based "settling" cards | 2.5 | Overkill for a dashboard. |
| 5 | Kenney Particle Pack | see section 3 | CC0 | yes | PNG | Glow sprites for trails | 4 | Listed once in section 3. |
| 6 | `svg-path-properties` 2.2.0 | github.com/rveciana/svg-path-properties | ISC (npm metadata) | yes | 65 KB unpacked (not minified measure) | Move particles along DAG edges and SVG frames | 3.5 | Released 2026-10-16. |
| 7 | `proton-engine` 7.1.5 | github.com/drawcall/Proton | MIT, github.com/drawcall/Proton/blob/master/LICENSE | yes | 2.6 MB unpacked | Particle emitter engine | 2 | Heavy and dated. |
| 8 | `three.quarks` 0.17.1, `@pixi/particle-emitter` 5.0.10 | github.com/Alchemist0823/three.quarks, github.com/pixijs/particle-emitter | MIT (npm metadata) | no, needs three.js or Pixi | n/a | GPU particles | 2 | Needs a heavy engine. Not suitable. |

Rejected here:
- `particles.js` and Vanta: already excluded in the existing document.
- `gpu-io`: last release 2023, too niche.
- `boids` (hughsk): 2016, 40 lines you can write yourself.

#### Agent cards: radial progress, rings, menus

| # | Name | URL | License (file checked) | Vanilla | Size | Use | Q | Caveat |
|---|---|---|---|---|---|---|---|---|
| 1 | `svg-gauge` 1.0.7 | github.com/naikus/svg-gauge | MIT (npm metadata) | yes | `gauge.min.js` 1.5 KB gz | Per-agent slot and budget ring | 4 | Last release 2022. Tiny, so it is easy to restyle or fork. |
| 2 | `JustGage` 2.0.1 | github.com/toorshia/justgage | MIT, github.com/toorshia/justgage/blob/master/LICENSE | yes | `justgage.umd.min.js` 8.8 KB gz | Semi-circle gauges | 3.5 | Released 2025-10-13. A little heavy for one ring. |
| 3 | `ProgressBar.js` 1.1.1 | github.com/kimmobrunfeldt/progressbar.js | MIT, github.com/kimmobrunfeldt/progressbar.js/blob/master/LICENSE | yes | 12.7 KB gz | Circle, semicircle and line progress with easing | 3.5 | Last release 2023-10. GitHub's latest tag still says 1.0.1 (2016). |
| 3b | `d3-shape` 3.2.0 and `d3-hierarchy` 3.1.2 | github.com/d3/d3-shape, github.com/d3/d3-hierarchy | ISC | yes | n/a | Arcs, radial layouts, "decision ring" sectors by hand | 4 | Need small d3-path or similar companions. Not measured. |
| 4 | `radialMenu` (victorqribeiro) | github.com/victorqribeiro/radialMenu | MIT, github.com/victorqribeiro/radialMenu/blob/master/LICENSE | yes, canvas | not measured | Radial action menu on a card | 3 | Last release 2021-01. |
| 5 | `ray-menu` 0.1.6 | github.com/agmmnn/ray-menu | MIT, github.com/agmmnn/ray-menu/blob/master/LICENSE | web component | 369 KB unpacked | Radial pie menu | 3 | Released 2026-05-12, but 16 stars. |
| 6 | `RadialMenu` (Julien-Marcou) | github.com/Julien-Marcou/RadialMenu | CC BY 4.0, github.com/Julien-Marcou/RadialMenu/blob/main/LICENSE.txt | yes, SVG | not measured | Pie menu | 2.5 | CC BY for code, so credit needed. Last push 2022. |
| 7 | `flubber` 0.4.2 | github.com/veltman/flubber | MIT (npm metadata) | yes | 18 KB gz | Morph between SVG shapes (status badge to next shape) | 3 | Last release 2018. |

I found no library that implements a "decision ring" layout. That one is own SVG with d3-shape arcs and CSS `@property` conic gradients for status auras. I found no animated-avatar system with a clean license beyond the Rive files in section 1 and the existing document's list.

---

### 6. The motion repos

| # | Name | URL | License (file checked) | Usable here? | What the license allows |
|---|---|---|---|---|---|
| 1 | **Motion** (have) | github.com/motiondivision/motion | MIT, github.com/motiondivision/motion/blob/main/LICENSE.md | Yes, already adopted | `motion` 14.5.0 on npm |
| 2 | **lottie-web** | github.com/airbnb/lottie-web | MIT, github.com/airbnb/lottie-web/blob/master/LICENSE.md | Yes (section 1) | 5.13.0 |
| 3 | **Remotion** | github.com/remotion-dev/remotion | **Source-available company license**, github.com/remotion-dev/remotion/blob/main/LICENSE.md (v4.0.537, 2026-10-19). GitHub reports NOASSERTION. | **No for the dashboard. Developer guidance only.** | See below. |
| 4 | **HyperFrames** (HeyGen) | github.com/heygen-com/hyperframes | Apache-2.0, github.com/heygen-com/hyperframes/blob/main/LICENSE | Dev tool and ideas, not a runtime dependency | See below. |
| 5 | **GSAP** | gsap.com, npm `gsap` 3.15.0 | Proprietary "Standard 'no charge' license" at gsap.com/standard-license. The npm tarball has no LICENSE file; the `.min.js` header reads "Copyright 2026, GreenSock. All rights reserved. Subject to the terms at gsap.com/standard-license". | **No.** Not on our allowed list. | Could not read the terms (see below). |
| 6 | **gsap-skills** | github.com/greensock/gsap-skills | MIT, github.com/greensock/gsap-skills/blob/main/LICENSE | Developer guidance only | Skills for core, timeline, ScrollTrigger, plugins, React, utils, performance. |
| 7 | **Emil Kowalski's skills** | github.com/emilkowalski/skills | MIT, github.com/emilkowalski/skills/blob/main/LICENSE | Developer guidance only | 48k stars. Includes `animate`, `animation-performance`, `review-animations`, `improve-animations`, `animation-vocabulary` (all under `skills/`). |
| 8 | **LottieFiles motion-design-skill** | github.com/LottieFiles/motion-design-skill | MIT (license file found via the API) | Developer guidance only | Motion principles skill. |
| 9 | **Motion AI Kit** | github.com/motiondivision/ai-kit | **No LICENSE file at repo root** (GitHub shows NONE) | Not verified, so do not copy | Motion's own animation guidance plus CSS spring generation. Some features need Motion+ (paid). Use through the plugin only, and check the license before copying files. |
| 10 | **Remotion agent skills** | github.com/remotion-dev/skills | **No LICENSE file** (GitHub shows NONE) | No | Covers Remotion only, and sits under unclear terms. |
| 11 | **199-biotechnologies motion-dev-animations-skill** | github.com/199-biotechnologies/motion-dev-animations-skill | MIT | Developer guidance only | A Motion.dev skill. 203 stars. |
| 12 | **impeccable** (pbakaus) and **ui-ux-pro-max** (nextlevelbuilder) | github.com/pbakaus/impeccable, github.com/nextlevelbuilder/ui-ux-pro-max-skill | Apache-2.0 and MIT respectively | Developer guidance only | General UI skills with some motion content. ui-ux-pro-max v2.15.0 is already installed in this environment. |

**Remotion, exactly what the license says** (read from LICENSE.md):
- **Free License** applies if you are an individual, a for-profit organization with up to 3 employees, a non-profit, or just evaluating without commercial use.
- It grants permission "to use the software non-commercially or commercially for the purpose of creating videos and images" and to modify it for your own use.
- Disallowed: copying or modifying Remotion code to sell, rent, license, relicense or sublicense your own derivative.
- Anyone else needs a paid Company License (remotion.pro).
- The file also warns the license "will slightly change" in Remotion 5.0.
- It is not OSI-open-source. Even if the owner qualifies for the free tier, it grants video and image creation only, not embedding in a dashboard. We should not vendor it. If we want rendered videos, HyperFrames is the Apache-2.0 alternative.

**HyperFrames** is an open-source framework (HeyGen) that renders HTML, CSS and seekable animations (GSAP, CSS, Lottie, Three.js, Anime.js, WAAPI) into deterministic MP4 videos. It needs Node 22+ and FFmpeg. It ships 7 skills, including core ones (`hyperframes`, `hyperframes-cli`, `hyperframes-registry`, `media-use`) and `remotion-to-hyperframes`, plus about 450 registry blocks (transitions, titles, charts, 3D) as editable HTML. Its CREDITS.md notes that mediabunny (MPL-2.0) is used in the studio only, and some catalog pieces vendor three.js (MIT). Use it for:
- rendering demo videos or release clips of Swarm Watch;
- mining registry blocks for ideas.

It is not a runtime dependency. Blocks that use GSAP carry GSAP's terms, so port only the blocks that avoid it. I only listed the registry directory; I did not check each block's license or credits.

**GSAP:** gsap.com says it is "now free for everyone, thanks to Webflow", and the gsap-skills README says every plugin is free including commercial use. I could not verify the actual terms. Both the license page and the community terms page returned only a "forums offline" maintenance page, and the repo `greensock/GSAP` has no license file (the repo shows NONE). The license is custom and not on our allowed list. My recollection (unverified) is that it forbids using GSAP in tools that let users build visual animation, which is irrelevant to us, but I am not willing to rely on that. Use Motion (MIT), anime.js (MIT, in the existing document) and Web Animations instead. Do not vendor GSAP.

---

### Excluded in this round

- LottieFiles free files (Lottie Simple License, some "no modify/re-publish"): custom terms.
- OpenHuman mascots (tinyhumansai/mascots): GPL-3.0.
- `@lottiefiles/lottie-player`: archived.
- Hover.css: needs a commercial license for commercial use.
- ScrollReveal: no license detected.
- `trianglify`: GPL-3.0.
- `typed.js` 3.0.0: GPL-3.0.
- Clippy: no license.
- GSAP: proprietary custom license, unreadable terms.
- Remotion and Remotion skills: video-only license, not for embedding.
- Motion AI Kit files: no license file.
- `particles.js` and `gpu-io`: stale or niche.
- `proton-engine`, `matter-js`, `three.quarks`, `@pixi/particle-emitter`: heavy, and they need an engine.
- `mo.js`: npm 2017 and GitHub 2023 disagree on version.
- `ScifiUI`: needs Tailwind.
- Kabi mascot: kept only as a reference (credit, off-theme).
- Subtle Patterns, Transparent Textures: mixed licenses, many CC BY-SA.
- Haikei, Pattern Monster: license unverified.
- Rive community files without a visible CC BY label: skipped.

---

### Worth adding next (ranked)

1. **`@formkit/auto-animate` 0.10.0** (MIT). Copy `package/index.min.js` (3.3 KB gz) plus its `LICENSE` to `tools/watch-assets/vendor/auto-animate/`. Call it on the card-list containers, with no other setup.
2. **`vanilla-tilt` 1.8.1** (MIT). Copy `dist/vanilla-tilt.min.js` (2.5 KB gz) plus `LICENSE`. Enable on agent cards only.
3. **`canvas-confetti` 1.9.4** (ISC). Copy `dist/confetti.module.mjs` (6.9 KB gz) plus `LICENSE`. Fire one burst on a merged PR, with `disableForReducedMotion`.
4. **`svg-gauge` 1.0.7** (MIT). Copy `dist/gauge.min.js` (1.5 KB gz) plus a LICENSE from the repo (confirm one exists). Use it for per-agent slot and budget rings. If the repo has no LICENSE file, write the rings by hand with d3-shape arcs instead.
5. **Kenney UI Pack Sci-Fi** (CC0). Download the zip from kenney.nl/assets/ui-pack-sci-fi. Copy only the 6 to 10 panel and button images you use, plus the zip's `License.txt`. Record the pack name and download date. Verify formats when you open it, since the page does not state them.
6. **`d3-force` 3.0.0** (ISC) with `d3-dispatch`, `d3-quadtree` and `d3-timer` (all ISC). Copy `d3-force.min.js` (3 KB gz) and the three small dependency files from their `dist/` folders, plus each LICENSE. Use it for an agent and ticket constellation panel. Check the exact dependency versions before vendoring, since I did not open them.
7. **Rive pair, lazy-loaded:** `@rive-app/canvas-lite` 2.45.0 (MIT). Copy `rive.js` (110 KB gz) and `rive.wasm` (323 KB gz) plus `LICENSE`, and load them only on the agents page. Add one `.riv`: "Robot Expressions" by deborah.n.oliveira (CC BY 4.0, rive.app/community/files/18720-35184-robot-expressions). Show a visible credit line in an About or credits panel. Only do this if one animated robot per lane is worth ~430 KB gz.
8. **Hero Patterns** (CC BY 4.0). Copy 3 or 4 unstyled SVG files (circuit board, hexagons, plus) from heropatterns.com. Add a credit line "Hero Patterns by Steve Schoger, CC BY 4.0". Use them at under 5% opacity as card or page backdrops.

Not in the list because we already have an equivalent or it costs too much budget: `tsParticles` (44 KB gz slim bundle), `css-doodle` (build-time only), `lottie-web` (only needed if we choose Lottie badges over the existing APNG badges).

Round 1 file for reference: `/Users/bean/project-swarm/bench/gpu-bakeoff/Claude outputs/swarm-watch-asset-research.md` (an untracked copy of the same research). I wrote nothing to the repo.

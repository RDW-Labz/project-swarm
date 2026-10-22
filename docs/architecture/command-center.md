# Swarm Watch Command Center architecture

## Goal

Upgrade Swarm Watch (not replace it) with a Command Center experience: **The Hive** multi-project overview, **Project Cockpit** drill-down, keyboard-first navigation, and a Resources and Tools hub. Stage S10 (roadmap R-066 through R-080) builds on S4 visibility, S7 event store, and S9 cluster board data. Every number on screen is real, labelled, and explainable.

## What stays

Swarm Watch today remains fully available:

- Every current view, panel, and owner action from S4 stays implemented.
- All existing routes and pages still render; they move under a **Classic** tab in the Command Center shell.
- Nothing is removed or hidden behind a feature flag that defaults off for legacy URLs.
- Deep links to pre-upgrade paths continue to work (Classic tab selected when appropriate).

## View 1: The Hive

The default landing view when opening Command Center.

**Layout**

- **Central brain entity** — original animated design; the visual anchor (see R-070).
- **Project ring** — one node per registered project, positioned around the brain:
  - Status colour from ticket state (building, blocked, needs you, done).
  - Percent done, count of tickets building, needs-you count, machine label.
- **Top stat strip** — projects count, agents live, tickets done today, needs you (shared data layer, R-066).
- **Legend** — building, blocked, needs you, done with colours matching nodes.
- **Bottom panels** (grid on desktop, stack on phone):
  - Live event log in plain words (no jargon-only codes).
  - Lanes and who is working (lane name, robot head, current ticket).
  - What the swarm saved: relays avoided, retries prevented, estimated time saved (only when computable from events).
  - Throughput chart (tickets/hour trend, throttled updates).

**Streams (R-069)**

- Canvas layer: particles flow from each project node into the brain.
- Density ∝ active agents on that project; speed ∝ tickets per hour.
- 30 fps cap; pause when tab hidden; still frame under reduced motion.

## View 2: Project Cockpit

Opened by clicking a project node or via command palette / deep link.

**Center**

- **Orchestrator character** — built from `tools/watch-assets/robot-*.js` with live state (thinking, dispatching, waiting on you, reviewing).
- **Stage and wave rings** — progress from ledger milestones.
- **Ticket nodes** — animate through ready → building → review → done; building tickets show the lane’s robot head.

**Sides and bottom (R-073)**

- Tabbed or column layout on desktop: ticket lists (building, ready, blocked, done) with search.
- Live run stream: per-worker activity, progress %, pace, ETA, PR links, deploy status.

**Navigation (R-071)**

- Smooth zoom transition from Hive node to Cockpit.
- Breadcrumb: `Hive › <project name>` returns to overview.
- Routes: `/command-center`, `/command-center/project/<projectId>` with keyboard-accessible controls.

## Experience layer

| Feature | Purpose |
|---------|---------|
| Guided tour (R-077) | First visit + replay from Help; explains Hive, Cockpit, colours, palette |
| Command palette (R-076) | Cmd-K / Ctrl-K: projects, tickets, runs, PRs, docs, commands |
| Resources and Tools hub (R-078) | Docs, runbooks, CLI commands (copy), repos, PRs, deploys, lane guides, asset library |
| Phone layout (R-079) | Hive = vertical stack; Cockpit = tabs; 44 px touch targets; no horizontal scroll at 390 px |

**Resources hub plugin model**

- New tools or resources: drop a JSON or Markdown entry into `tools/watch-hub/entries/`.
- Validated by JSON Schema in CI; no application code change required for listing.

## Signature glitch style (R-075)

PowerGlitch (vendored per asset policy) provides short, event-driven bursts:

| Trigger | Effect |
|---------|--------|
| First load | Glitch-in on shell |
| Hive → Cockpit | Transition glitch |
| Event burst | Brain flicker |
| Failure / rate limit | Stronger red or amber glitch |
| Hover project name, ticket id, robot head | Light glitch |
| CountUp number change | Brief glitch on update |
| New needs-you chip | One glitch then static |
| Section heading scroll into view | Glitch reveal |

**Rules**

- Each burst &lt; 400 ms; never a continuous loop.
- Never glitch text while its value is actively updating.
- At most 3 simultaneous glitches on screen.
- All off when `prefers-reduced-motion: reduce`.

## Data rules

1. **Real data only** — same sources as S4 board and S7 event store; no decorative fake metrics.
2. **One source per number** — each displayed metric maps to exactly one field or aggregation; documented in hover copy.
3. **Labelled** — every figure has a visible label (not icon-only).
4. **Hover explanation** — title/tooltip states source (e.g. `events.spendToday`, `ledger.openTickets`).
5. **Hide if inaccurate** — if a value cannot be computed within S4 accuracy tolerances, omit it rather than guessing.
6. S4 board accuracy tests extend to Hive strip and Cockpit counters.

Shared module: Command Center views consume the same `board-data` / build-progress paths as Classic Swarm Watch (R-066).

## Performance and accessibility

| Rule | Target |
|------|--------|
| Idle CPU | &lt; 3% over 60 s trace (tab focused, no interaction) |
| Ambient canvas | 30 fps; pause when `document.hidden` |
| Interaction | 60 fps target for transitions driven by Motion/WAAPI |
| Reduced motion | Still frames; no glitch; no particle animation |
| Keyboard | Focus order for palette, breadcrumb, lists, tour |
| Contrast | Body text ≥ 4.5:1 against surface tokens |

Pause all animation loops when the tab is hidden (same rule as asset research doc).

## Asset policy

Follow `docs/design/asset-research.md` and roadmap R-033:

- Vendor exact versions under `tools/watch-assets/vendor/` with LICENSE/NOTICE.
- Robot heads from `tools/watch-assets/robot-*.js` only (R-074).
- Kenney emotes (CC0), Fluent animated badges (MIT), PowerGlitch, CountUp, uPlot/ECharts as needed.
- Each new asset: `VENDOR.json` + row in `docs/third-party.md`.
- No CDN at runtime; lazy-load heavy chart bundles on chart panels only.
- Budget: respect ~400 KB gz first-load guidance from asset research; Command Center adds lazy chunks for Cockpit charts.

## Self-review loop

Before each CC stage gate and before S10 sign-off:

1. Builder captures Playwright screenshots at **1440 px** (desktop) and **390 px** (phone).
2. Builder records a **5-second** clip of motion (or frame sequence for reduced-motion pass).
3. An **independent grader** (separate model/session from the builder; receives only screenshots, recording frames, and `docs/design/review-rubric.md`) scores every rubric row 1–5 with a one-line reason.
4. Fix lowest scores; repeat until **every item ≥ 4**, max **5 rounds** per pass.
5. Archive each round under `docs/design/review/<STAGE>/roundN/` (`scores.json`, `scores.md`, screenshots).
6. Deliver final screenshots and score table to the owner.

CC stage gates include the score table (all ≥ 4).

## Stages CC1 to CC5

| Stage | Scope | Gate |
|-------|--------|------|
| **CC1 Foundations** | Shared data layer wiring; Classic tab shell; PowerGlitch kit + limit tests; performance harness; Playwright review tooling + rubric wired; robot head mount helper | Data layer parity test green; glitch limit test exit 0; review round 1 artifacts present with all scores ≥ 4 |
| **CC2 The Hive** | Brain entity; project ring; particle streams; stat strip; legend; bottom panels | Hive screenshots 1440/390; stream pauses when hidden; review scores ≥ 4 |
| **CC3 Project Cockpit** | Orchestrator character; rings; ticket nodes; lists; run stream | Cockpit deep link + keyboard test pass; robot head parity test; review scores ≥ 4 |
| **CC4 Experience** | Command palette; guided tour; Resources and Tools hub; phone layout; deep links; zoom transition | Palette + tour e2e green; hub schema test exit 0; 390 px no horizontal scroll; review scores ≥ 4 |
| **CC5 Polish pass** | Glitch signature across board; final review rounds; performance budget check | Idle CPU &lt; 3%; glitch rules test; full rubric ≥ 4 on final round; licence check exit 0 |

## Risks

- Canvas + WebGL + charts together may exceed CPU budget on older laptops — mitigate with pause-when-hidden, 30 fps cap, and lazy chart load.
- Glitch overuse hurts readability — enforce concurrency and duration limits in tests.
- Classic tab drift if Classic and Command Center diverge on data imports — single shared module (R-066).
- Hub plugin folder without schema discipline could break the hub page — schema test required (R-078).

## Deliberately not built

- Replacing or removing Classic Swarm Watch views.
- Owner-only actions (merge, deploy, approve) from new UI beyond what S4 already exposes on Classic.
- Copied characters, art, or text from external reference posts (inspiration only; see below).
- Continuous full-screen glitch or shader backgrounds that run when idle.
- Fake metrics, demo projects, or lorem counts for empty states.

## Originality statement

The Hive layout, brain entity, project ring, Cockpit rings, and orchestrator presentation are **our own design**. The owner described two external reference posts as **inspiration only** for mood and information density. No art, characters, names, or verbatim text from those references are copied into the product or this repository.

## Requirements map

| Id | Topic |
|----|--------|
| R-066 | Shared data layer; labelled numbers; S4 accuracy extension |
| R-067 | Classic tab; all legacy routes |
| R-068 | Hive overview layout and panels |
| R-069 | Particle streams |
| R-070 | Brain entity animation |
| R-071 | Zoom, breadcrumb, deep links |
| R-072 | Project Cockpit core |
| R-073 | Lists and run stream |
| R-074 | Robot heads and badges |
| R-075 | PowerGlitch signature and limits |
| R-076 | Command palette |
| R-077 | Guided tour |
| R-078 | Resources and Tools hub |
| R-079 | Phone layout |
| R-080 | Performance, a11y, review loop, licensing |

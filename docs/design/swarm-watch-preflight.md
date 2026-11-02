# Swarm Watch UI upgrade: preflight

Scope: the `swarm watch --all` board (Overview, Cost, Agents, Events), the project page and the new run inspector. Not in scope: the per-run live Watch page (`index.html`), which keeps its own style.

How it was built: one agent (Claude Sonnet 5.5) did design, build and review as separate steps; no paid worker, image or video service was used, so the cost was $0. The prompt named GPT-6 Astra, which does not exist, so that line was skipped. Two MIT sources were added (robot-heads, ui-ux-pro-max-skill; see [third-party.md](../third-party.md)); five projects were used for ideas only.

## Status table

| Criterion | Scope | Status | Evidence | Unresolved |
|---|---|---|---|---|
| Scope completion | board 4 tabs, project page, run inspector, heads, badges, shortcuts, deep links, graph, replay, compare | PASS | `tests/watch-ui.test.mjs` (14 tests), screenshots in `docs/design/screenshots/` | per-run live Watch page not restyled |
| Design-system consistency | board, project, run pages | PASS | one stylesheet `swarm-ui.css`; test checks every token the design doc names exists | `index.html` still on `watch.css` |
| Critical journeys | open board, switch tabs, read Needs you, copy a command, open a run, replay, compare, back | PASS (simulated) | keys, tabs, dialog focus, deep link and routes exercised in headless Chrome (below) and in tests | real phone over Tailscale NOT RUN |
| States | empty (no projects), stale (server stopped), error head, sleeping head, no manifest, long text | PASS | empty board and stale chip captured; run page says "no dependencies recorded"; text wraps (test) | none |
| Responsive | 390, 820, 1440 px | PASS | horizontal overflow 0 px on every page and width (measured with device emulation) | a real phone NOT RUN |
| Accessibility | keyboard, focus, names, contrast, dialog | PARTIAL | 0 unnamed controls; focus ring on every control; `?` dialog traps and restores focus; all text tokens at least 4.54:1 (test); live chip and Needs-you chip are one atomic status | screen reader NOT RUN; automated checks only |
| Reduced motion | all animation | PASS | emulated `prefers-reduced-motion`: 0 animation frames in 3 s; Pause motion and `p`: 0 frames; CSS turns off pulses and eases | none |
| Motion and fallback | heads, bars, dots | PASS | heads fall back to a still frame; canvases draw nothing off screen or with the tab hidden; text carries every state | none |
| Performance | 60 live agents on the Agents tab | PASS with a note | see "Measured" | numbers are from headless Chrome with software rendering; a GPU browser is lighter, not measured |
| Type, lint, tests, build | repo | PASS | full suite 4006 pass / 0 fail; `npm run check` passes | none |
| Runtime and network errors | pages | PASS | no console errors (error listener on the board); nothing is requested from outside the machine (test scans the pages) | none |
| Preserved integrations | token auth, read-only, history, inbox, phone state | PASS | all earlier board tests still pass; new routes need the token; board JS has no write request (test) | none |
| Asset rights | robot-heads, ui-ux-pro-max | PASS | MIT licenses kept (`ROBOT-HEADS-LICENSE.txt`, skill `LICENSE`), commits logged | none |
| Pass 1, 2, 3 | see below | PASS | findings and fixes below | none |
| Independent review | the diff outside the ported drawing and the installed skill | PASS after fixes | an Opus review found 1 high (prototype pollution through a lane named `__proto__`) and 9 medium issues; all listed in the changelog are fixed and covered by tests | the review's low-severity items were not itemised in its summary |

## Measured (headless Chrome, software rendering, 1440 px, 60 running agents plus the sample runs)

| Case | Frames in 3 s | Time inside animation callbacks in 3 s | Canvases |
|---|---|---|---|
| Agents tab, motion on, before the animation budget | 49 | 2366 ms (79% of the thread) | 118 |
| Agents tab, motion on, after (at most 12 heads move, 15 frames/s each) | 179 | 735 ms (24%) | 118 |
| Agents tab, reduced motion | 0 | 0 ms | 118 |
| Agents tab, motion paused | 0 | 0 ms | 118 |
| Overview, motion on | 179 | 739 ms | 51 |

Page weight (no network, no fonts, no images): 207 KB of JavaScript across all board pages (the robot drawing is 70 KB of it), 18 KB of CSS; heap 2 to 5 MB; no layout shift measured (14 to 17 layouts in 6 seconds). Field metrics (LCP, INP, CLS at the 75th percentile) cannot be measured locally and were not.

## Pass 1: art direction and craft

Compared desktop 1440, tablet 820 and phone 390 on every page. Found and fixed: the Events tab stayed empty until the next poll (list was requested before the first data); the phone header took three rows of chips (now one scrolling row, and the count chip is hidden); job-graph nodes were clipped and the graph was stretched and off-centre (wider nodes, no stretch); the graph legend dots were invisible; the search box clipped its placeholder; phone KPI tiles were one per row (now two); an empty project list had no message on a phone. Checked and left: the lane-bay and head proportions, type scale, spacing.

## Pass 2: UX, states and accessibility

Exercised keys `1` to `4`, `/`, `u`, `p`, `?`, `Esc`, arrow keys, and Tab through the dialog; stopped the server (chip changes to Stale with the last good time, numbers stay); opened an empty board (every lane shows a sleeping head, "Nothing needs you", an empty-projects message); measured contrast. Found and fixed: `/` did not move focus to the search box (the tab was still hidden); an error head said "running" (now "failed N min ago"); the empty-projects text missing on a phone.

## Pass 3: motion, performance and integrated reliability

Counted animation frames normally, under reduced motion and paused; profiled 60 live agents. Found and fixed: 60 moving heads used 79% of the thread (animation budget and a 15 frames/s cap brought it to 24%); a quadratic repaint when many heads change visibility (debounced, and still frames are drawn once per state); a syntax error introduced late in a phone fix was caught by the screenshot step and by the suite, fixed, and everything was re-measured and the full suite re-run after the last change.

## Not done, and why

Screen-reader testing; a real phone over Tailscale (swarm remote is not built yet); field performance data; the per-run live Watch page restyle; keyboard shortcuts on the run inspector other than the native controls.

## Reusable output

`ui-ux-pro-max` is installed project-local and was used to write the design system; `docs/design/swarm-watch-design-system.md` lists the checks. The headless-Chrome checks used here (device emulation, frame counting, key events) were throwaway scripts and are not committed.

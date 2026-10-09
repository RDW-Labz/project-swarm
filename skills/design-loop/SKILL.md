---
name: design-loop
description: Run an autonomous design-iterate-review loop on a UI mockup or screen set — a designer worker edits, Playwright screenshots, a separate reviewer scores against a rubric and a definition of done, the orchestrator applies the ranked fixes, with human checkpoints and hard stop rules. Use when a user wants a UI/visual design improved over several rounds without hand-holding each round.
status: experimental
---

# Design loop

Experimental until (1) designer and reviewer workers run through the normal sandboxed job path, and (2) one full end-to-end run via `swarm design-loop`. First run candidate: BinGo Auctions mockup G (in progress).

## Running it

`swarm design-loop <config> [--dry-run] [--resume]`

A bounded loop: **design → screenshot → review → fix**, repeated until the work meets a definition of done and a rubric, or a round cap is hit. The orchestrator never edits the design itself. Humans check in at fixed rounds and their notes outrank the reviewer's.

## When to use
- A mockup, prototype, or real screen set needs several passes of visual/UX improvement.
- The user has taste to express but not time to review every round.
- The output can be rendered headlessly (HTML, a dev server, Storybook, a static site).

## When not to use
- One-shot design asks. Use a single designer task.
- Work that can't be screenshotted (native apps without a simulator, CLI output).
- Anything touching production. The loop edits the target only; shipping is a separate task.

## Inputs (fill `loop.config.json` before round 0)
| Key | Meaning |
|---|---|
| `target` | Path or URL of the thing being designed (mockup HTML, dev server route, Storybook story) |
| `screens` | List of `{name, url_or_selector, widths[]}` to capture each round |
| `baseline` | How to capture "today" for comparison (URL + login note, or "none") |
| `designer` | Worker type + model for design edits (e.g. `codex:gpt-6-astra`) |
| `reviewer.primary` | Worker for scored rounds (e.g. `claude:opus`) |
| `reviewer.cheap` | Worker for in-between rounds (e.g. `codex:default`). Never the designer. |
| `rubric` | Path to `RUBRIC.md` (8–10 lines, each scorable 1–10) |
| `done` | Path to `DONE.md` (binary must-haves; scores don't count until all green) |
| `rounds.max` | Hard cap (default 6) |
| `rounds.checkpoints` | Rounds where the human looks (default `[1,3,6]`) |
| `rounds.primary_reviewer_at` | Rounds that use the primary reviewer (default = checkpoints) |
| `motion` | `true` to capture an animation frame strip; `false` for static |
| `locks` | Things frozen after a given round (e.g. `{"fonts": 3}`) |
| `out` | Output dir (default `docs/design/<name>/rounds/`) |

## Round 0 — setup, no design changes
1. Capture baseline (if any) and round-0 screenshots of the target.
2. Run axe (or equivalent) on every screen; keep contrast numbers.
3. **Vision test**: have both reviewers write a top-5 list from round-0 screenshots. If fewer than 3 items overlap, the cheap reviewer is unreliable for this target: use the primary reviewer every round and report the cost to the human before continuing.
4. Confirm every `DONE.md` item is checkable from the artifacts you capture. If one isn't, fix the capture or rewrite the item.
5. Log round 0.

## Each round N (1..max)
1. **Fix**: the designer gets the target, the ranked change list from round N-1 (human items first, then reviewer items), the rubric, and `DONE.md`. It applies the list top to bottom, nothing else. One worker, own worktree.
2. **Capture**: Playwright headless. Every screen at every width; if `motion`, a 6-frame strip of the main entry animation (0/100/200/400/800/1200 ms) and one reduced-motion capture; axe numbers. Save under `out/round-N/`.
3. **Review**: a *fresh* reviewer worker (no memory of earlier rounds) gets: rubric, `DONE.md`, round-N artifacts, round-(N-1) artifacts and scores, baseline. It must, in order:
   a. Verify each item from the previous list was actually done. Undone items go to the top of the new list.
   b. Mark every `DONE.md` item green/red with the evidence screen.
   c. Score each rubric line 1–10 with one sentence of evidence.
   d. Write exactly 5 ranked changes: structure/workflow first, surfaces second, polish last. Each = screen + element + exact change. No vague notes.
4. **Log**: scores, done status, changes, worker, cost → `out/LOG.md` and the usage ledger.
5. **Checkpoint** (if N in `checkpoints`): open the target for the human; post the score table, done status, and the 5 items. Human replies agree/disagree per item and may add up to 3 of their own; human items outrank reviewer items next round. At checkpoint 1, if the direction is off, ask the human for 2–3 reference images and hand them to the designer rather than spending another round.

## Stop rules (first that triggers)
- All `DONE.md` green **and** every rubric line ≥ 8 for two consecutive rounds.
- Round = `rounds.max`.
- Average score drops two rounds running (log it as a stall; ask the human).
- A required worker is unavailable. Stop and say so. Never substitute silently.

On stop: final capture, `LOG.md` summary (first vs last scores, what moved, what didn't), open the result for the human.

## Guardrails
- Edits only the target. No app code, no dependencies, no config, unless the target *is* the app and the user said so.
- No production deploys, publishes, or data changes from inside the loop.
- No spend beyond existing subscriptions. Fonts/assets from sources with known licences; log them.
- Secrets never go to any worker. Baseline logins are the human's; the orchestrator takes those screenshots once and stores images only.
- Reviewer and designer are never the same model instance. Reviewer is fresh each round.
- If the designer "fixes" an item by removing the element, the reviewer flags it; it does not count as done.

## Files this skill expects beside it
- `RUBRIC.template.md` — starting rubric; copy and edit per project.
- `DONE.template.md` — starting definition of done.
- `LOG.template.md` — per-round log format.
- `capture.spec.ts` — Playwright capture script reading `loop.config.json`.
- `review.prompt.md` — the reviewer prompt, with slots for rubric, done list, and artifact paths.

## Failure modes seen
- Reviewer scores drift upward with no visible change → fresh reviewer per round + show it the previous round.
- Rounds oscillate between cosmetics and structure → ranked list, structure first.
- "Done" declared on scores while a flow is broken → `DONE.md` gates scoring.
- Timid output on "more gradient/motion" prompts → reference images at checkpoint 1 beat another round.
- Vision-weak cheap reviewer → round-0 vision test.

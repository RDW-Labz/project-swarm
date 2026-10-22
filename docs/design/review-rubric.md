# Command Center visual review rubric

Independent graders score each iteration of the Swarm Watch Command Center (S10) using this rubric. The builder must not grade their own pass.

## Rubric (score each 1–5)

| # | Criterion | 1 — Poor | 3 — Acceptable | 5 — Excellent |
|---|-----------|----------|----------------|---------------|
| 1 | **Readability at a glance** | Key status unclear; clutter | Main status readable with effort | Owner understands swarm state in &lt; 5 s |
| 2 | **Information accuracy** | Fake or unlabelled numbers | Most numbers labelled; rare guesses | Every number labelled; no fabricated metrics |
| 3 | **Visual hierarchy** | Flat; nothing stands out | Primary vs secondary mostly clear | Eye flows Hive → project → action naturally |
| 4 | **Colour** | Harsh or monochrome | Several accents; readable | Multiple accents; comfortable contrast; not harsh |
| 5 | **Polish** | Misaligned, inconsistent spacing | Mostly rounded and aligned | Rounded, consistent spacing, aligned grid |
| 6 | **Motion quality** | Janky or distracting | Smooth on interaction; some idle noise | Meaningful, smooth, calm when idle |
| 7 | **Asset use** | Placeholder art | Robot heads present; badges mostly fit | Real robot heads; Kenney/Fluent badges fit style |
| 8 | **Phone layout** | Broken or horizontal scroll | Usable with minor cramping | Vertical Hive; tabbed Cockpit; 44 px targets |
| 9 | **Performance** | Idle CPU high or stutter | Near budget most of the time | Idle CPU &lt; 3%; 60 fps interaction; 30 fps ambient |
| 10 | **Reduced-motion behaviour** | Motion ignores setting | Mostly still; some leaks | Still frames; no glitch; no particle loop |
| 11 | **Glitch vs readability** | Glitch hides text | Glitch occasional and readable | Glitch adds energy without hurting readability |

**Pass threshold:** every criterion **≥ 4** before a CC stage gate or S10 sign-off.

## Review process

1. **Capture (builder)**  
   - Playwright screenshot at **1440 px** width (desktop).  
   - Playwright screenshot at **390 px** width (phone).  
   - **5-second** recording of representative motion (Hive streams, Cockpit transition, or CountUp update).  
   - For reduced-motion verification, a second desktop screenshot with `prefers-reduced-motion: reduce` emulated.

2. **Grade (independent grader)**  
   - Separate review call from a **different model or session** than the builder.  
   - Inputs: screenshots, recording frames (or exported GIF), and **only** this rubric — not builder reasoning or implementation notes.  
   - For each row, assign **1–5** and one-line justification.

3. **Iterate**  
   - Fix the lowest-scoring items first.  
   - Repeat until all items ≥ 4 or **5 rounds** elapse (then escalate to owner).  
   - Keep every round’s artifacts.

4. **Archive**  
   - Path: `docs/design/review/<STAGE>/roundN/`  
     - `desktop-1440.png`, `phone-390.png`, `motion/` (frames or clip)  
     - `scores.json` — machine-readable scores and reasons  
     - `scores.md` — human-readable table for the owner  

5. **Deliver**  
   - Final round screenshots and the score table go to the owner with the stage gate PR.

**Stages:** use folder names `CC1` … `CC5` matching `docs/architecture/command-center.md`.

## Grader checklist (quick)

- [ ] No number on screen without a label in the screenshot  
- [ ] Legend colours match node colours  
- [ ] Glitch not running in reduced-motion screenshot  
- [ ] Phone screenshot has no horizontal scrollbar  
- [ ] Robot heads visible (not generic circles) on Cockpit and lanes panel  

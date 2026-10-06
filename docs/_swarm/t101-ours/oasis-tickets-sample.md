## T100 — Model picker in the chat header (desktop-app) — Braden typed 2026-10-06

**What (Braden):** a model picker in the chat header, per chat, showing the model name + a Cloud/Local badge; each reply bubble is tagged with the model that answered; switching is allowed mid-chat. Mac check by Braden.
**Build:** reads T99's route list and per-chat choice from the local service; offline routes show "offline" and cannot be picked; the picker only lists what the service offers (so #357 holds in the app too); bubble tag is small text under the bubble. Screenshots of each state (closed, open, offline, tagged bubbles) go with the PR (#293).
**Done when:** desktop-app PR merged after T99, OASIS.app rebuilt, Braden's Mac check passes (pick Local, answer tagged llama-moe3, switch back mid-chat, tag shows Sonnet).

## T100b — Model picker design pass (desktop-app) — Braden typed 2026-10-06

**What (Braden):** before T100's PR. (1) provider mark per model: official brand asset with its license noted in CREDITS.md, monogram fallback; (2) pill = mark + full name (e.g. "Claude Sonnet 5.5", never cut off; widen the pill) + Cloud/Local badge + status dot (green online, grey offline), animated open/close and hover like the holo cards; (3) the picked model gets a short ring pulse; (4) reply tags show the mark too; (5) matches the app's existing look, light and dark. The open list may cover the chat. The offline Local row reads "Local (dev2) — offline" and cannot be picked. Feel reference: coordination/research/openhuman.md + coordination/references/t98/ (screenshots only; GPL, no code or text). Checks: desktop-design-check (ui-ux-pro-max + impeccable distilled) on the renders. Reduced motion: no animation.
**Also fixes:** the 'closed' preview view rendered the list open (closed and open PNGs were identical bytes).
**Provisional (#159, stricter):** a brand mark ships only when its owner's published terms allow this use and the CREDITS.md line names them; otherwise the monogram ships and the mark question goes to Braden.
**Done when:** four states (closed, open, offline, two-model tags) re-rendered light + dark, design check passed, vitest/tsc/eslint green, harness green, then T100's PR opens (merges after T99).

## T101 — Adopt mattpocock/skills as worker skills (project-swarm) — Braden typed 2026-10-06

**What (Braden):** adopt mattpocock/skills (MIT, pinned commit). Vendor tdd, diagnosing-bugs, code-review, resolving-merge-conflicts, writing-for-agents as worker skills in project-swarm with our `paths:`/`checks:` frontmatter, trimmed to fit the skill limits, LICENSE kept. Separate one-page compare of to-tickets / to-spec / handoff vs ours: propose line-level edits, no replacement. Rework metric before/after. Private-names guard applies.
**Pins:** 6fd947921b935b7e1e69293a200400f0fdd5c15f (2026-10-06) for four skills; resolving-merge-conflicts was removed upstream (daa01d8) → vendored from its last version at 153fc1b93de6584562765cdce299324e1ff9e661 (same MIT license).
**Provisional (#159):** skills ship under project-swarm `templates/coordination/skills/<name>/` (scaffolded into a project's coordination/skills); each ≤800 tokens (swarm warns >800, refuses >1200); upstream LICENSE copied beside each; OASIS's own coordination/skills/code-review stays and wins in this project (no auto-replace).
**Rework metric:** before = `session_metrics.py --rework-only` red_rate and swarm `reworkBySkill` at adoption; after = same over the next 20 integrated runs that attach a vendored skill.
**Done when:** project-swarm PR merged (private-names 0 hits, each skill loads under cap, LICENSE present, CREDITS line with pin); compare page at coordination/research/t101-compare.md; before row in swarm-metrics.md.

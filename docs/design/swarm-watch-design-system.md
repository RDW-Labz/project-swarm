# Swarm Watch design system

Written with the project-local `ui-ux-pro-max` skill (`.claude/skills/ui-ux-pro-max/`, MIT, see `docs/third-party.md`):

```
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "operations dashboard dark admin live agents monitoring developer tool" --design-system -p "Swarm Watch"
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<topic>" --domain ux -n 3      # keyboard, live status, reduced motion, badges, tabs, tables
```

Its design-system answer for this kind of product was a real-time operations pattern in a dark, "dark tech plus status green" palette. Rules adopted from it are marked (skill). Rules it suggested that were not adopted: Fira Code/Fira Sans (they load from the internet; this board loads nothing external, so system fonts are used) and the glassmorphism style (kept to soft gradients only).

## Thesis

A dense dark admin for scanning many projects at once: rounded surfaces, pill controls, soft gradients, one accent colour per lane. It is an operations dashboard, so information density and fast scanning win over spectacle. Motion appears only for live state. The page is read-only and behind the board token.

Directions: desktop is the **Console** layout (KPI strip, projects table, sticky Needs you column) with the **Agent Bay** idea for live agents (one tinted bay per lane, one robot head per agent). On a phone it is the **Ledger** layout: one column, Needs you first.

## Tokens (`tools/watch-assets/swarm-ui.css`, `:root`)

| Role | Tokens |
|---|---|
| Surfaces | `--bg` `--bg-glow` `--card` `--card-2` `--line` `--line-soft` |
| Text (4.5:1 or better on `--card` and `--bg`) | `--fg` `--muted` `--faint` |
| Status | `--accent` (good, live) `--accent-ink` `--warn` `--bad` `--info` `--lav` |
| Lanes (one accent each) | `--haiku` `--sonnet` `--opus` `--codex` `--cursor` `--gpu` `--claude` `--other` |
| Shape | `--r-sm` `--r` `--r-lg` `--pill` |
| Type | `--font` (system sans) `--mono` (every number is tabular mono) |
| Motion | `--ease` `--dur-fast` `--dur` `--dur-slow` (shared; nothing hard-codes a duration) |
| Elevation and focus | `--shadow` `--ring` |

Dark theme only. Colour is never the only signal: every state also has text (a pill, a label, a word).

## Components

Topbar with live chip, Needs-you chip with an unread count, tabs (`role="tablist"`, arrow keys), KPI tiles, lane bays, project table (cards on a phone), Needs-you cards with Copy buttons, FYI list, event feed, run graph and journal, compare table, help dialog. Pills and buttons are fully rounded; cards 16px; tiles and dialogs 16 to 22px.

## What each live element means (nothing is invented)

| Element | Source | Rule |
|---|---|---|
| Live chip | the last good answer from `/api/board` | "Live" only within 6 seconds of it, otherwise "Stale, last update HH:MM:SS" (skill) |
| Robot head, working | a running job with output in the last 90 seconds | `agentState` in `tools/board-data.mjs` |
| Robot head, thinking | a running job with no output yet, or quiet for over 90 seconds | same |
| Robot head, error (red face) | a job that failed or timed out in the last 10 minutes | same |
| Sleeping head | no agent is running in that lane | the bay is dimmed; no agent is drawn that does not exist |
| Lane usage and cap | the spend store (billed lanes) and run states (flat-rate list value) | caps reset at UTC midnight, the day the spend store counts by |
| Rate-limit countdown | a pause recorded by the lane scheduler, with its end time | shown only while the end time is in the future |
| Needs you | inbox decisions, human tasks, blockers, proposed tickets | "FYI, no action needed" notes are listed apart and not counted |
| "New" badge | items not yet seen on this browser | kept in the browser; reading the panel for a moment marks them seen |
| Job graph | the run's manifest (`after`) and state | no manifest means no arrows, and the page says so |
| Dashed outline | a job with two or more recorded attempts | a retry or a move to another lane; there is no cache in the swarm, so nothing is called cached |
| Journal and replay | every queued, started and ended time of every job | cost is shown where a job ends (the run records it per job) |

## Motion principles

Live state only: a pulsing dot for a running run, robot heads that blink and glance, bars that ease to new values, a new Needs-you card that eases in. Everything else is instant. All motion is off under `prefers-reduced-motion` (heads draw a still frame), a "Pause motion" button (and `p`) turns it off for people who want it off, heads stop drawing while off screen, and the shared loop sleeps while the tab is hidden (skill: shared motion tokens, reduced motion, stop hidden work). No head follows the pointer.

## Keyboard and links

`1` to `4` tabs, `/` search events, `u` mark Needs you read, `p` pause motion, `?` this list, `Esc` closes. Arrow keys move between tabs. Deep links: `#tab=cost`, `#run=PROJECT/RUN` (opens the run inspector), and `/run?id=PROJECT&run=RUN`.

## UX checks (skill checklist, adapted) and how they are met

- Accessibility: contrast 4.5:1 for text tokens; visible focus ring on every control (`--ring`); tab order follows visual order; every icon-like control has a text label; the live chip and the Needs-you chip are `role="status"` with one atomic message (skill: contextual live badge); the help dialog traps focus and restores it.
- Touch: controls are at least 44px tall at phone width; no hover-only information (the full text of a cut value is in the page, wrapped).
- Layout: no horizontal scroll at 390px; tables become cards (skill: table handling); text wraps, it is cut at a word at most.
- Performance: no external fonts, scripts or images; heads reuse canvases between polls and stop off screen.
- Feedback: copy buttons say "Copied"; empty states say what is missing; a stale connection says so.
- Not run here: assistive-technology testing with a screen reader, a real phone over Tailscale.

## Out of scope for this change

The per-run live Watch page (`index.html`, `app.js`, `watch.css`) keeps its own style and is linked from the run inspector.

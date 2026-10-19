# Quotes: hours, cost and time as ranges

Private to you. Never part of a client report. Nothing here calls a model or the network.

## Your hours

- `swarm time log HOURS "note"` adds one entry (0.05 to 24 hours) to `.swarm/project/time.ndjson` in the project.
- `swarm time list` shows the entries and the total.

## Estimated hours (automatic)

`swarm time summary [--days N]` shows your estimated hands-on hours per day. Signals, timestamps only (never what you wrote): your messages to the orchestrator in this folder's Claude Code sessions (`~/.claude/projects/...`), ticket approvals, merges, and inbox answers. Activity with gaps of 15 minutes or less is one working block; its hours are the block's span plus 5 minutes (a single message still took some time). Messages that are tool results, system notices or side conversations do not count, and work in a different folder is not attributed.

Estimates are marked **estimated** and are never written to the time file. Your entries replace them:
- `swarm time log 3 "note"` replaces today's estimate; `--date YYYY-MM-DD` corrects a past day.
- `swarm time log 5.5 "so far" --through YYYY-MM-DD` enters a total up to that day: counted once, and the estimates for the days before it are not added on top.

## What is kept for each finished project

`swarm quote record [--name NAME] [--charged USD] [--change-orders N] [--gpu-hours H] [--backfill]`, run in the project folder, writes one entry to `~/.project-swarm/quotes/projects.json` (change the folder with `SWARM_QUOTES_DIR`). Recording again with the same name updates the entry.

It keeps: requirements, stages, screens and services (from the scope), tickets, model cost **billed** (per-use lanes and rented GPUs), the **flat-rate list value** (Codex, Cursor and Claude subscriptions, which cost nothing extra) and the **estimated full cost** (the two added: what the work would cost at list prices), rented GPU hours, your logged hours, change orders, calendar days from the first run to the last, and what you charged. A number it cannot know is stored as `?`, never as 0. `--backfill` marks work recorded after the fact. `swarm quote list` shows what is kept.

## A quote for a new scope

`swarm quote SCOPE.md` sizes the scope (requirements, stages, screens, services), finds the nearest finished projects (up to 5, by how far apart the sizes are on a log scale, using only the sizes both have), and prints:

- model cost (**estimated full**, with the billed part shown apart; quotes and the price use the full cost), calendar time, your hours, rented GPU hours, each as a **range**: the middle half of the similar projects; the lowest to the highest with two; one value, marked "no range", with one; **no number at all** with none.
- **Confidence** with the reason: none, low (fewer than 3 similar projects), medium, high (5 close ones). Backfilled projects and projects without logged hours are named in the reason.
- **Price:** blank until you set both an hourly rate and a margin: `swarm quote config --rate USD_PER_HOUR --margin PERCENT`. Then it is `(cost + hours x rate) / (1 - margin)`, as a low-to-high range. No default rate or margin is ever invented. `swarm quote config` alone shows what is set.

The ranges are not scaled for size, so they get better as more projects are recorded.

# Quotes: hours, cost and time as ranges

Private to you. Never part of a client report. Nothing here calls a model or the network.

## Your hours

- `swarm time log HOURS "note"` adds one entry (0.05 to 24 hours) to `.swarm/project/time.ndjson` in the project.
- `swarm time list` shows the entries and the total.

## What is kept for each finished project

`swarm quote record [--name NAME] [--charged USD] [--change-orders N] [--gpu-hours H] [--backfill]`, run in the project folder, writes one entry to `~/.project-swarm/quotes/projects.json` (change the folder with `SWARM_QUOTES_DIR`). Recording again with the same name updates the entry.

It keeps: requirements, stages, screens and services (from the scope), tickets, model cost **billed** (per-use lanes and rented GPUs) apart from the **flat-rate list value** (Codex, Cursor and Claude subscriptions, which cost nothing extra), rented GPU hours, your logged hours, change orders, calendar days from the first run to the last, and what you charged. A number it cannot know is stored as `?`, never as 0. `--backfill` marks work recorded after the fact. `swarm quote list` shows what is kept.

## A quote for a new scope

`swarm quote SCOPE.md` sizes the scope (requirements, stages, screens, services), finds the nearest finished projects (up to 5, by how far apart the sizes are on a log scale, using only the sizes both have), and prints:

- model cost (billed), calendar time, your hours, rented GPU hours, each as a **range**: the middle half of the similar projects; the lowest to the highest with two; one value, marked "no range", with one; **no number at all** with none.
- **Confidence** with the reason: none, low (fewer than 3 similar projects), medium, high (5 close ones). Backfilled projects and projects without logged hours are named in the reason.
- **Price:** blank until you set both an hourly rate and a margin: `swarm quote config --rate USD_PER_HOUR --margin PERCENT`. Then it is `(cost + hours x rate) / (1 - margin)`, as a low-to-high range. No default rate or margin is ever invented. `swarm quote config` alone shows what is set.

The ranges are not scaled for size, so they get better as more projects are recorded.

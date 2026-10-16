# Lessons loop (Phase 15, part 1)

Every project the swarm builds should make the next one better. This part turns lessons into data the swarm can search, puts the relevant ones in front of workers, and builds a golden eval set from real failures. Design: [phase15-lessons-design.md](plans/phase15-lessons-design.md). Source spec: [swarm-lessons-loop-spec.md](plans/swarm-lessons-loop-spec.md).

## Lessons as data

One JSON file per lesson: `lessons/<project>/L-0001.json` (stage, what happened, the rule, who caught it, cost, lane and model, fix, the guard that would have caught it earlier, tags). No secrets, emails, home paths, run ids or tokens: the schema refuses them and never prints what it found.

```
swarm lessons add --stage build --what "..." --rule "..." --tag symlink --caught-by review
swarm lessons list [--stage S] [--tag T] [--caught-by C] [--text T] [--json]
swarm lessons show L-0001 | stats | check
swarm lessons backfill [--dry-run]
```

`backfill` converted the 229 numbered entries in docs/lessons.md and the 2 queue rows (coordination/swarm-lessons.jsonl) once; running it again writes nothing. Their `caughtBy` is `unknown`, and stage and tags come from keywords, so treat them as a first pass to improve by hand. The older `swarm lesson` queue (area, evidence, rule, fix, public line) is unchanged.

Lessons from other projects come back here as lesson files only (see CLAUDE.md): run `swarm lessons add` in that project, then copy the file into this repo's `lessons/<project>/`.

## Watch-out notes

When `swarm go --scope` builds a ticket's job, it adds up to three short "Watch out for" lines from the most similar lessons (by tags, files and words), at the end of the prompt so the shared start stays cached. Nothing is added when nothing matches. Lessons come from the project's own `lessons/` and the installed swarm's `lessons/`. Try it: `swarm lessons notes "ticket text" [--file PATH]...`.

## Golden eval set

`evals/<id>/` holds a made-up repro of a real failure: `eval.json` (prompt, files, check command), `repo/` (what the worker sees), `hidden/` (the check, never shown), `solution/`.

```
swarm eval list
swarm eval validate --all        # each task must fail on repo/ and pass with solution/
swarm eval manifest --all --agent anthropic --model claude-haiku-5-5
swarm run evals/.run/manifest.json
swarm eval score RUN [--record]  # pass/fail per task; --record appends to docs/state/eval-scores.ndjson
swarm eval gate RUN [--update-baseline [--reset-baseline]]   # exit 1 when the score drops below evals/baseline.json
```

Rule: a change to prompts, guards, router rules or models does not merge when the eval score drops. A new model gets a baseline on its first scored run. Today: 8 tasks (all from real Phase 13 review findings); Haiku 5.5 passes 6 of 8 (the 2 misses were worker output-format slips).

The gate also fails on a malformed baseline file, an unknown or mixed model key, zero evals, an invalid eval, or a changed eval count (accept a new count on purpose with `--update-baseline --reset-baseline`). A baseline only moves up on the same count. The eval check runs only `node --test` on the hidden test with a clean environment; workspaces and fixtures are never followed through symlinks.

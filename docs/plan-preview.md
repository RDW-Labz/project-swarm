# Plan preview and approval

`swarm plan "GOAL"` shows what `swarm go "GOAL"` would do, and runs nothing.

```
Goal: add a thing to src
Leads: 1 (scopes: src/)
Jobs: about 6 (at most 25)
codex gpt-6.1-sol: 1 lead jobs, about $0.00
anthropic claude-haiku-5-5: 6 child jobs, about $0.24
Cost: about $0.24 (range $0.12 to $1.00) (subscription lanes are not counted)
Time: about 3 min
Peak concurrency: 6
Budget: $5.00, 2000000 tokens
Risks:
- deletes-unknown: children are written at run time; their deletes and files are not known yet
plan saved: plan-... (run it with: swarm go --plan plan-...)
```

- It takes the same flags as `go` for sizing (`--leads`, `--max-jobs`, `--concurrency`, `--max-usd`, `--max-tokens`); `--json` prints the plan as JSON.
- The estimate is a point value with a range. The leads write the child jobs when they run, so the number of children is a guess (6 per lead until there is history). Subscription and local lanes (Codex, Cursor, Hermes) cost nothing; only the Anthropic lane is priced.
- Risks it looks for: sensitive folders (`.env`, `secrets`, `credentials`, `.ssh`, `.aws`, `.gnupg`, `private`, `keys`), more than 20 deletes, an estimate above the budget, more than 100 possible jobs.

## Approving

- `swarm go "GOAL"` prints the same preview (to stderr) and asks `Run, spending at most $X (the cap)? [y/N]` (the question names the cap, the most the run may spend). Only `y` or `yes` runs it. A goal that looks like a command (a `--flag` in it, or a known subcommand starting a sentence of up to three words) is refused with "Did you mean: swarm ...?" before anything is planned.
- `--yes` skips the question. With no terminal (a script, cron, another agent) `--yes` is required, and it also needs `--max-usd`.
- `swarm go --plan ID` runs exactly the saved plan. It refuses if the repository moved since the plan was made (`plan-stale`; pass `--accept-stale` to go on) or if the saved file was edited (`plan-invalid: hash`).
- A plan runs once (`plan-already-run` after that). The saved file is checked against a hash of the manifest, goal, flags and HEAD, so an accidental or casual edit is refused; the preview shown at approval is recomputed from the saved manifest, never read from the file. `--max-usd` and `--max-tokens` on `go --plan` can only tighten the saved caps.
- Plans live in `.swarm/plans/`. A dirty working tree is refused by `go` before anything is previewed or asked.
- Lanes this preview cannot price (OpenAI, Gemini, OpenRouter, Lambda, or an unknown Anthropic model) are flagged as a risk (`unpriced-lane`) rather than counted as $0.

## Learning from real runs

After a goal run the result shows `estimate` (estimated and actual cost, minutes and child count). The numbers are saved in `.swarm/project/estimates.json` (the newest 20 runs). The median actual/estimate ratio for cost and time, and the median number of children per lead, correct the next preview, so `calibrated: true` plans get closer over time. The first previews are rough: the target (within 2x of the real cost and time) is checked on the scale-test runs in Phase 17.

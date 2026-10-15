# Lane benchmark

Ten tasks from this repo, two of each kind, run on every lane and checked by real tests plus a review. Base: `202df20d74`. Quality is a Claude Haiku review from 1 to 5 of the diff (a cheaper reviewer keeps the run inside its budget; it is told the automatic result).

## Per lane

| Lane | Agent / model | Passed | Cost | Median time | Quality |
| --- | --- | ---: | --- | ---: | ---: |
| hermes | hermes / qwen3.8-flash-next-iq2_xs | 2/10 | subscription (116,387 tokens) | 40 s | 1.8 |
| cursor | cursor / composer-2.5 | 10/10 | subscription (0 tokens) | 25 s | 3.8 |
| codex | codex / gpt-6.1-sol | 10/10 | subscription (131,678 tokens) | 22 s | 4.1 |
| anthropic-haiku | anthropic / claude-haiku-5-5 | 9/10 | $0.02 | 13 s | 3.6 |
| anthropic-sonnet | anthropic / claude-sonnet-5-5 | 8/10 | $0.29 | 9 s | 3.3 |
| openrouter | openrouter / openai/gpt-oss-20b | 4/10 | $0.0061 | 40 s | 2.3 |
| claude | claude / sonnet | 10/10 | subscription (17,012 tokens) | 14 s | 4.0 |

## Per task (✓ passed, ✗ failed, then the quality score)

| Task | Kind | hermes | cursor | codex | anthropic-haiku | anthropic-sonnet | openrouter | claude |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bug-percentile | bug-fix | ✗ 1 | ✓ 3 | ✓ 4 | ✓ 4 | ✓ 4 | ✗ 1 | ✓ 5 |
| bug-router-failover | bug-fix | ✗ 1 | ✓ 4 | ✓ 4 | ✓ 5 | ✓ 4 | ✓ 4 | ✓ 4 |
| new-parse-duration | new-function | ✗ 2 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 |
| new-cost-summary | new-function | ✗ 2 | ✓ 3 | ✓ 4 | ✓ 3 | ✓ 4 | ✗ 2 | ✓ 4 |
| refactor-anthropic-rates | refactor | ✗ 1 | ✓ 5 | ✓ 5 | ✓ 4 | ✗ 1 | ✓ 4 | ✓ 4 |
| refactor-spend-reserve | refactor | ✗ 1 | ✓ 5 | ✓ 5 | ✗ 1 | ✗ 1 | ✗ 1 | ✓ 4 |
| tests-model-matches | test-writing | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✗ 2 | ✓ 4 |
| tests-npm-script | test-writing | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✗ 1 | ✓ 4 |
| docs-anthropic-lane | docs | ✗ 1 | ✓ 3 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 3 | ✓ 4 |
| docs-host-failures | docs | ✗ 1 | ✓ 3 | ✓ 3 | ✓ 3 | ✓ 3 | ✗ 1 | ✓ 3 |

## Lanes that passed both tasks of a kind with quality 4 or more (cheapest first)

| Kind | Lanes |
| --- | --- |
| bug-fix | codex → anthropic-haiku → anthropic-sonnet → claude |
| new-function | codex → anthropic-sonnet → claude |
| refactor | cursor → codex → claude |
| test-writing | hermes → cursor → codex → anthropic-haiku → anthropic-sonnet → claude |
| docs | none passed both with quality 4 or more |

## Findings

- **Codex, Cursor and Claude (Sonnet) passed 10 of 10.** They work in place or on whole files, so a multi-site refactor is no problem. Codex had the best average quality (4.1), Claude 4.0 and Cursor 3.8. Cursor reports no tokens or cost, so its cost column is empty. The Claude CLI reported $0.63 of equivalent cost for its ten jobs; the subscription covers it.
- **Anthropic Haiku is the best paid lane: 9 of 10 for about $0.002 a job** ($0.02 for all ten, median 13 s). Sonnet cost 14 times as much ($0.29) and passed fewer (8 of 10), because both of its failures were refactors that hit the edit limit below. Haiku is the better default for API work.
- **OpenRouter `openai/gpt-oss-20b` passed 4 of 10** ($0.006 total). It is cheap but not good enough to be a default route for anything that writes code.
- **Hermes with `qwen3.8-flash-next-iq2_xs` on dev2 passed 2 of 10**, both test-writing tasks (each killed 4 of 4 mutants). It runs free, locally, at about 40 s a job. It failed bug fixes, new functions, refactors and docs: 5 of its 8 failures were the edit limit below, the rest were wrong or incomplete code. This is a 2-bit quantized model. A larger one may do better, and this benchmark is how to find out.
- **The one-edit-per-file rule of the API and Hermes lanes is the biggest single cause of failures (9 of the 17 failed jobs).** A tool-free worker may return the whole file or one find/replace per output. A refactor or bug fix that needs two separate changes in a large file fails with `edits[].path ... is duplicate`. Allowing several ordered edits per path (each `find` unique when applied) would likely lift Haiku, Sonnet and Hermes on bug-fix and refactor. That is a runner change, not done here.
- **`docs-host-failures` was a bad task as first written.** It asked for two strings that only exist in `tools/swarm.mjs`, which the worker was never given, so every lane failed. The check was fixed and all saved outputs were re-scored, so every row here uses the fixed check.
- **Reviews:** the first review pass showed the reviewer only the diff, and it marked correct minimal fixes "unverified". The second pass attaches the base files. Quality scores come from a Claude Haiku reviewer and are a rough guide. Pass or fail is the hard number.

## Route defaults set from this

Cheapest lane first, using only lanes that passed both tasks of the kind:

| Job type | Route before | Route now | Why |
| --- | --- | --- | --- |
| `fix` | cursor, codex | cursor, codex, anthropic | Haiku passed both bug fixes at about $0.001 each, so it is a cheap third choice |
| `test` | codex, cursor | hermes, codex, cursor | Hermes passed both test-writing tasks for free; the next two also passed both |
| `docs` | hermes | cursor, codex, anthropic | Hermes failed both docs tasks; these three passed both |
| `build` | cursor, codex | unchanged | Cursor and Codex passed all four build tasks (new function and refactor); the API lanes failed refactors |
| `review`, `research`, `merge`, `lead` | | unchanged | not in this benchmark |

The global cheap order (Hermes first, OpenRouter fourth) is unchanged because it is your standing rule. With this model, Hermes would be tried first for untyped `auto` jobs and would fail most of them. Removing `lanes.hermes.model` from the machine config keeps it out of untyped routing, while the typed `test` route still uses it.

## How it was run, and the limits

- **Harness:** `bench/lane-benchmark/`. `prepare` builds a one-commit copy of the repo (no history, no `bench/`) with the bugs and the removed doc sections in place. `lane` runs one lane with the installed runner and checks each output with tests, hidden tests, mutants and fact lists. `reverify` re-checks saved outputs. `report --review` adds the review and renders this page. Hidden tests, mutants and fact lists are never in the repo a worker can read.
- **Where:** six lanes ran on this Mac with the installed runner 1.62.0. Hermes ran on dev2 itself: the runner, harness and base repo were copied there (no keys, no .env), Hermes ran locally, and only the results file came back. dev2's copy had one patch the installed runner lacks: the parser fix for the `Warning: Unknown toolsets: none` line that real Hermes prints on stdout (in this PR). Without it every Hermes job failed with "Malformed CLI JSONL".
- **Cost:** about $0.55 of Anthropic API credit (jobs and reviews) and $0.008 of OpenRouter. The other lanes are subscriptions or local.
- **Small sample:** two tasks per kind and one run per lane, so one flaky job moves a number by 10 points. Treat this as a first look. Rerun it whenever a lane, model or the router changes (Phase 17).
- **Scoring runs worker-written code** (the tests) in a throwaway copy with a minimal environment and a 2-minute limit per run.

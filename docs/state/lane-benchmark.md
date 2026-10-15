# Lane benchmark

Ten tasks from this repo, two of each kind, run on every lane and checked by real tests plus a review. Two runs: the first, then a rerun of the four tool-free lanes after the one-edit-per-file limit was removed. The tables show the rerun. Base: `202df20d74`. Quality is a Claude Haiku review from 1 to 5 of the diff (a cheaper reviewer keeps the run inside its budget; it is told the automatic result). Review cost: $0.01.

## Per lane

| Lane | Agent / model | Passed | Before multi-edit | Cost | Median time | Quality |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| hermes | hermes / qwen3.8-flash-next-iq2_xs | 6/10 | 2/10 | subscription (63,150 tokens) | 25 s | 3.0 |
| cursor | cursor / composer-2.5 | 10/10 | unchanged (not rerun) | subscription (0 tokens) | 25 s | 3.8 |
| codex | codex / gpt-6.1-sol | 10/10 | unchanged (not rerun) | subscription (131,678 tokens) | 22 s | 4.1 |
| anthropic-haiku | anthropic / claude-haiku-5-5 | 9/10 | 9/10 | $0.02 | 13 s | 4.0 |
| anthropic-sonnet | anthropic / claude-sonnet-5-5 | 10/10 | 8/10 | $0.29 | 8 s | 4.3 |
| openrouter | openrouter / openai/gpt-oss-20b | 3/10 | 4/10 | $0.0079 | 104 s | 2.0 |
| claude | claude / sonnet | 10/10 | unchanged (not rerun) | subscription (17,012 tokens) | 14 s | 4.0 |

## Per task (✓ passed, ✗ failed, then the quality score)

| Task | Kind | hermes | cursor | codex | anthropic-haiku | anthropic-sonnet | openrouter | claude |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bug-percentile | bug-fix | ✓ 4 | ✓ 3 | ✓ 4 | ✓ 5 | ✓ 5 | ✗ 1 | ✓ 5 |
| bug-router-failover | bug-fix | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 5 | ✓ 4 | ✓ 4 |
| new-parse-duration | new-function | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 |
| new-cost-summary | new-function | ✗ 1 | ✓ 3 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 3 | ✓ 4 |
| refactor-anthropic-rates | refactor | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 4 | ✓ 5 | ✗ 1 | ✓ 4 |
| refactor-spend-reserve | refactor | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 5 | ✗ 1 | ✓ 4 |
| tests-model-matches | test-writing | ✗ 1 | ✓ 4 | ✓ 4 | ✗ 2 | ✓ 4 | ✗ 2 | ✓ 4 |
| tests-npm-script | test-writing | ✗ 1 | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | ✗ 1 | ✓ 4 |
| docs-anthropic-lane | docs | ✓ 4 | ✓ 3 | ✓ 4 | ✓ 4 | ✓ 4 | ✗ 2 | ✓ 4 |
| docs-host-failures | docs | ✗ 1 | ✓ 3 | ✓ 3 | ✓ 4 | ✓ 3 | ✗ 1 | ✓ 3 |

## Lanes that passed both tasks of a kind with quality 4 or more (cheapest first)

| Kind | Lanes |
| --- | --- |
| bug-fix | hermes → codex → anthropic-haiku → anthropic-sonnet → claude |
| new-function | codex → anthropic-haiku → anthropic-sonnet → claude |
| refactor | hermes → cursor → codex → anthropic-haiku → anthropic-sonnet → claude |
| test-writing | cursor → codex → anthropic-sonnet → claude |
| docs | anthropic-haiku |

## Findings

- **The one-edit-per-file limit was the main thing holding back the tool-free lanes, and removing it worked.** After the change (several ordered edits per file), Hermes went from 2 to 6 of 10, Sonnet from 8 to 10, and no job failed on the edit limit any more (it was 9 of the first 17 failures). Haiku stayed at 9: it now passes both refactors but failed `tests-model-matches` this time, which it passed before. OpenRouter went from 4 to 3 (it now passes `new-cost-summary` but failed two others). A change of one or two jobs on the same lane is run-to-run noise at this sample size.
- **A second bug sat behind the first.** The Hermes and Qwen adapter validated `edits` but returned only `files`, so a Hermes answer made of edits would have been marked complete with no change applied. Fixed in the same change.
- **Codex, Cursor and Claude (Sonnet) passed 10 of 10 again.** Codex has the best average quality (4.1). Cursor reports no tokens or cost. The Claude CLI reported $0.63 of equivalent cost for its ten jobs; the subscription covers it.
- **Anthropic Haiku is the best paid default: 9 of 10 for about $0.002 a job** ($0.02 for all ten, median 13 s, quality 4.0). **Sonnet passed 10 of 10 (quality 4.3) at 14 times the cost** ($0.29). That makes Sonnet the right mid tier, not the default.
- **OpenRouter `openai/gpt-oss-20b` passed 3 of 10** ($0.008) and was slow (median 104 s). It stays out of code routing.
- **Hermes with `qwen3.8-flash-next-iq2_xs` on dev2 passed 6 of 10** (quality 3.0), free and local, at 25 s a job. Three of its four failures were `exit 1` with no message from the Hermes CLI (possibly two jobs at once on a single local model server, which was set to run two at a time), one was an incomplete answer. A rerun at one job at a time is the first thing to try. Still, 6 of 10 on a 2-bit model suits research and summary jobs rather than code.
- **`docs-host-failures` was a bad task as first written.** It asked for two strings that only exist in `tools/swarm.mjs`, which the worker was never given, so every lane failed. The check was fixed and all saved outputs were re-scored (dev2 had the old check; its results were re-scored here from the saved outputs).
- **Reviews:** the first review pass showed the reviewer only the diff, and it marked correct minimal fixes "unverified". Later passes attach the base files. Quality scores come from a Claude Haiku reviewer and are a rough guide. Pass or fail is the hard number.

## Route defaults

What was set, from the first run and the owner's decisions (the rerun does not change them):

| | Setting |
| --- | --- |
| Cheap order for code | anthropic (Haiku), cursor, codex; Claude only after 2 failures |
| Hermes | out of the default order; runs only `research` jobs |
| OpenRouter | only non-sensitive bookkeeping jobs |
| `build`, `fix`, `docs` | anthropic, cursor, codex |
| `test` | codex, anthropic, cursor |
| `review` | codex |
| `research` | hermes |
| `merge`, `lead` | codex (unchanged, not benchmarked) |

The rerun supports these: Haiku passes both refactors now, so the edit limit is no longer a reason to keep it away from `build`. One thing to decide later: `test` has Haiku second, but Haiku was the lane that flipped on test-writing between runs; Sonnet passed both test tasks both times.

## How it was run, and the limits

- **Harness:** `bench/lane-benchmark/`. `prepare` builds a one-commit copy of the repo (no history, no `bench/`) with the bugs and the removed doc sections in place. `lane` runs one lane with a runner and checks each output with tests, hidden tests, mutants and fact lists. `reverify` re-checks saved outputs. `report --review` adds the review and renders this page. Hidden tests, mutants and fact lists are never in the repo a worker can read.
- **Run 1 (1.62.0, installed runner):** six lanes on this Mac. Hermes ran on dev2 itself: the runner, harness and base repo were copied there (no keys, no .env), Hermes ran locally, and only the results file came back. dev2's copy had the Hermes parser fix before it was merged.
- **Run 2 (after the multi-edit change, working copy of 1.65.0):** only the four lanes the change touches (Haiku, Sonnet, OpenRouter, Hermes). Codex, Cursor and Claude were not rerun: their jobs do not go through the envelope the change affects. This used the working copy, not the installed runner, because the change is not merged yet.
- **Cost:** about $0.9 of Anthropic API credit over both runs (jobs plus reviews) and $0.016 of OpenRouter, inside the $2 budget. The other lanes are subscriptions or local.
- **Small sample:** two tasks per kind and one run per lane, so one flaky job moves a number by 10 points. Treat this as a first look. Rerun it whenever a lane, model or the router changes (Phase 17).
- **Scoring runs worker-written code** (the tests) in a throwaway copy with a minimal environment and a 2-minute limit per run.

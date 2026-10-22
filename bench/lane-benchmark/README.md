# Lane benchmark

Ten synthetic tasks from this repo (two each of bug fix, new function, refactor, test-writing and docs), plus an optional **replay** set of twenty real closed tickets for comparing models (Strata baseline, llama.cpp, Cursor, Haiku, and others).

## Default task set (10)

```
node bench/lane-benchmark/run.mjs prepare --src . --ref main --dest /tmp/bench-repo --validate
node bench/lane-benchmark/run.mjs lane --lane codex --repo /tmp/bench-repo --runner ~/.project-swarm/current/tools/swarm.mjs --out results-codex.json
node bench/lane-benchmark/run.mjs reverify --results results-codex.json --repo /tmp/bench-repo
node bench/lane-benchmark/run.mjs report --results results-codex.json,results-cursor.json --review --repo /tmp/bench-repo --out lane-benchmark.md
```

Lanes: `hermes`, `cursor`, `codex`, `anthropic-haiku`, `anthropic-sonnet`, `openrouter`, `claude`, `rented`. Copy `harness` files and the base repo to another machine to run one lane there and copy back only its results file. `prepare` leaves `bench/` out of the base repo, so workers never see hidden tests. `--review` uses the Anthropic lane (Keychain key).

## Replay set (20 real tickets)

Input ledgers and logs live in `bench/lane-benchmark/replay-input/`. Selection is deterministic (sorted by ticket id, seeded spread across types and both ledgers):

```
node bench/lane-benchmark/replay-select.mjs
```

This writes `bench/lane-benchmark/replay-selected.json`. If fewer than twenty tickets pass the filters (non-sensitive, low/medium risk, size S/M, owned files with real diffs, tests passing at the merge commit), the file lists all that qualify; see `qualifiedCount` in the JSON.

OpenAI-compatible **endpoint** lane (single chat completion per task, temperature 0.2, hidden tests from the merge commit at verify time only):

```
node bench/lane-benchmark/run.mjs endpoint --set replay --base-url http://127.0.0.1:18000/v1 --model NAME --key-env BENCH_API_KEY --slots 4 --out results.json
```

The API key is read only from the named environment variable; it is never printed or written to results.

**Tool-calling** smoke checks (eight deterministic cases):

```
node bench/lane-benchmark/run.mjs toolcalls --base-url http://127.0.0.1:18000/v1 --model NAME --key-env BENCH_API_KEY
```

**Report** for replay / endpoint results (side-by-side when given several JSON files):

```
node bench/lane-benchmark/run.mjs report --results results-strata.json,results-haiku.json --out replay-benchmark.md
```

Swarm lanes can use the replay task list with `--set replay` on `lane` (each replay task carries its own base commit; per-task trees are used by the endpoint runner).

Results for the original ten-task benchmark: [docs/state/lane-benchmark.md](../../docs/state/lane-benchmark.md).

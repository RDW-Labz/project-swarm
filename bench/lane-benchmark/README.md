# Lane benchmark

Ten real tasks from this repo (two each of bug fix, new function, refactor, test-writing and docs), run on every lane and scored by real tests plus a review. Results: [docs/state/lane-benchmark.md](../../docs/state/lane-benchmark.md).

```
node bench/lane-benchmark/run.mjs prepare --src . --ref main --dest /tmp/bench-repo --validate
node bench/lane-benchmark/run.mjs lane --lane codex --repo /tmp/bench-repo --runner ~/.project-swarm/current/tools/swarm.mjs --out results-codex.json
node bench/lane-benchmark/run.mjs reverify --results results-codex.json --repo /tmp/bench-repo
node bench/lane-benchmark/run.mjs report --results results-codex.json,results-cursor.json --review --repo /tmp/bench-repo --out lane-benchmark.md
```

Lanes: `hermes`, `cursor`, `codex`, `anthropic-haiku`, `anthropic-sonnet`, `openrouter`, `claude`. Copy `harness` files and the base repo to another machine to run one lane there (Hermes runs on dev2 this way) and copy back only its results file. `prepare` leaves `bench/` out of the base repo, so workers never see the hidden tests, mutants or fact lists in `tasks.mjs`. `--review` uses the Anthropic lane (Keychain key, machine-wide caps apply). Scoring runs worker-written code in a throwaway copy with a minimal environment.

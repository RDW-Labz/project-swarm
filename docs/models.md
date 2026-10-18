# Model watch

Spec: B3 in [plans/swarm-more-upgrades-spec.md](plans/swarm-more-upgrades-spec.md). `swarm models watch` looks for better models and tells you; it never rents a GPU and never switches anything.

- `swarm models watch [--force] [--json]` checks Hugging Face for new public coding models (recent, enough downloads, not gated) and the Anthropic API's model list for new versions. It runs when a check is due (weekly; `--force` to check now): put it in a weekly cron, or run it when you start work.
- **Fit:** the weights, by data type from the Hugging Face size summary, must take at most 80% of the GPU memory (default one 96 GB GPU; the rest is for the KV cache). Unknown sizes are listed as "fit unknown"; models that are too big are recorded and listed, not sent to you.
- **First run:** it records what exists as a baseline and reports nothing. After that, each new model that fits becomes a decision in `swarm inbox` (default: skip). An outage on the first run does not make the second report everything.
- **Evaluating** a candidate rents a GPU, so the inbox item carries the command and your pre-approved cap, if you set one: `modelWatch.evalCapUsd` in the local config. With none set it says so. The command is `swarm gpu bakeoff --models MODEL --max-usd CAP` (a plan first; `--yes` only when you agree).
- `swarm models compare CURRENT CANDIDATE` reads the recorded eval runs (`docs/state/eval-scores.ndjson`) and says, for example, "X beats Y by 12 points at $0.02 per eval run", with a warning when there are fewer than 3 runs. Switching a lane's model is your decision.
- `swarm models list` shows what has been seen. State: `~/.project-swarm/models/watch.json`.

Local config (all optional): `modelWatch: { gpuMemGb: 96, gpus: 1, minDownloads: 1000, maxAgeDays: 120, intervalDays: 7, evalCapUsd: null }`.

Not done: the watcher does not start the evaluation by itself (that is the owner's step, so no rental happens unasked), and the API check needs the Anthropic key (it says so when there is none).

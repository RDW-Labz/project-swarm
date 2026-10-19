# Phase 17 practice run: plan and exact capped cost

Status: **proposed, nothing has been run or spent.** Each step below starts only on the owner's OK. Numbers come from the swarm's own price table (`tools/anthropic.mjs`) and the measured lane data in `docs/lanes.md` and `docs/state/lane-comparison.md`.

Why: before the real full-power build, run the swarm at scale on a **synthetic project in its own throwaway repo** (never in project-swarm), and report what broke at each step.

## Cost at a glance

| Step | What | Billed cost (ceiling) | Expected | Needs |
|---|---|---|---|---|
| A | 1,000 fake workers (stub): scheduler, merge queue, Watch, panic button, backups | **$0.00** (no model is called) | $0.00 | OK to use this Mac's CPU and RAM for a few minutes |
| B | First live `swarm go --scope`: 100 real Haiku tickets on a synthetic project | **$1.50 total**, enforced by a $1.50 project cap (run cap $1.00 + split cap $0.25) | **about $0.26** | OK + the concurrency decision below |
| C | 1,000 agents: plan only | **$0.00** (this page) | - | nothing |

The anthropic lane's machine-wide caps stay as they are ($20 a day, $500 total). No cap is raised.

## Step A: 1,000 stub workers (free)

1. `swarm scale --jobs 1000 --concurrency 1000` (a throwaway repo; the adapter answers locally; no model, no spend).
2. On that run, check: the scheduler holds the peak (1,000 in flight, queue latency), `integrate --queue` writes the files and the merge queue bisects a planted red batch, the Watch board (`swarm watch --all`, the run inspector and the project Live tab) stays responsive with 1,000 jobs, `swarm stop --all` stops the run and leaves a clean state, `swarm backup` and `swarm backup verify` work on the finished state.
3. Record: peak RAM and CPU, queue latency, integrate rate, board response times, what broke. Compare with the 500-job numbers in `docs/field-report.md`.

Cost: $0.00. Risk: it loads this Mac for a few minutes (the 500-job run peaked at 500 processes' worth of work); I will stop it with `swarm stop --all` if the machine struggles.

## Step B: first live `go --scope`, 100 real Haiku tickets

**The synthetic project** (own repo `~/Documents/project-repos/swarm-practice`, local only, no GitHub, no secrets): a scope of 100 requirements in 5 stages of 20, each "a pure function that does one small thing with a number-checked acceptance line" plus its test. A small generator under `evals/practice/` (a fixture generator, no app code) writes the scope and an empty TypeScript skeleton; nothing else of it lives in project-swarm.

**The commands**, each with its cap:

1. `swarm init` in the throwaway repo, project cap **$1.50** (`budget.projectMaxUsd`), not sensitive.
2. `swarm scope check`, then `swarm scope split` and its 5 split jobs (`swarm run` with `--max-usd 0.25`). Worst case $0.09 if all five go to Haiku (5 x $0.0172: 12,000 input characters and the 32,000-token output limit each); $0.00 if auto routing sends them to a subscription lane; expected $0.02.
3. `swarm scope approve --yes`, then `swarm go --scope --max-usd 1.00 --yes`: 5 waves (one per stage), 100 build tickets on the Haiku lane. A ticket costs about **$0.0023** (9,600 input and 2,700 output tokens, measured on 11 real tasks), so **100 tickets are about $0.23** (the worst case for 100 first attempts is $0.59 reserved at $0.0059 each: 38,400 input characters and the 4,096-token output limit). One retry on every ticket would still fit under $1.00. The acceptance review runs on a subscription lane (Sonnet, flat-rate): $0.00 billed, a list value is shown separately. No ticket is sensitive, so no Opus security review is triggered.
4. Expected total about **$0.26**; the **ceiling is $1.50** because the project cap refuses any run past it (review re-asks count toward it).

**Decision needed (concurrency).** `machineConcurrency` is 4 (your setting while dev2 is off), and it limits workers in all lanes together. At 4 the 100 tickets take about 5 minutes and do not exercise scale. To exercise 64 agents at once I would set it to 64 for the run and put it back to **4** afterwards. Haiku's own limit is the binding one: about 95 agents at the 4,096-token output limit (2,000,000 output tokens a minute), so 64 is 67 percent of it. Recommendation: raise to 64 for this run only, on your OK. Without the OK the run uses 4.

**Stops:** the project cap, `swarm stop --all` (the panic button, tested in step A), 3 waves in a row finishing no ticket (the loop's own no-progress stop), 429 answers shrinking the lane (adaptive concurrency).

**Record:** spend by lane (billed and flat-rate value), tickets passed on the first try, retries and escalations, waves and wall-clock, merge queue conflicts and bisects, what the Watch board showed, and every place it broke or was slow. This is the first live run of the loop, so a failure is expected to teach something; I will report it, not hide it.

## Step C: 1,000 agents (plan only, no spend)

Cost depends on the number of **tickets**, not agents; agents only change how long it takes. 1,000 tickets of the measured size:

| Route | Concurrent agents | Time for 1,000 tickets | Billed cost | Notes |
|---|---|---|---|---|
| Haiku (anthropic lane) | about 95 at the 4,096-token limit (about 190 at 2,048, if tasks fit) | about 2 to 3 minutes | **about $2.31** expected; $5.89 worst case reserved, so the run cap would be $6.00 | the default and the best value; limited by 2,000,000 output tokens a minute |
| Second Haiku lane on Bedrock | about another 95 (the cap comes from its own quota, to be read from Service Quotas) | halves the time | same list price (to verify) | **not built** (parked in `docs/plans/ideas.md`); needs an AWS account, keys and the owner's OK before any spend; code goes to that account |
| Rented GPU (Qwen3.6-35B-A3B, `swarm gpu`) | 128 per node | about 1.04 hours | **about $1.88** for the node plus about $0.62 for the 27 percent that escalate to Haiku: about **$2.50** | passes 73 percent against Haiku's 100 percent; the router only uses it above 700 ready tickets; never for sensitive tickets; needs a node you rent |
| Codex and Cursor (subscriptions) | their own limits | slower | $0.00 billed | for hard tickets, not for volume |

So **1,000 tickets cost about $2.3 on Haiku in minutes**; the GPU route costs the same and takes an hour. A true 1,000 agents **at the same moment** needs about 95 (Haiku) + about 95 (Bedrock, once built) + 6 GPU nodes (768 agents at $1.807 an hour each, about $10.84 an hour) and only pays off for a queue of many thousands of tickets. Recommendation: do not build for 1,000 simultaneous agents now. After step B, run **1,000 tickets** through Haiku at about 95 concurrent (ceiling $6.00, expected $2.31) only if step B went cleanly, as its own OK.

## What I need from you

1. OK for step A (free).
2. OK for step B, the $1.50 ceiling, and one of: concurrency 4 (slow, no scale test) or 64 for the run with a restore to 4.
3. Where the throwaway repo lives (default `~/Documents/project-repos/swarm-practice`, local only).

Not decided here and not started: the real full-power build, any new cloud account, any cap change.

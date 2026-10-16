# GPU bake-off

Run 2026-10-16 on one GPU at $1.807/h. Models are ranked on OUR tasks (the lane benchmark; the lessons eval set does not exist yet (Phase 15), so it is not included), not vendor SWE-bench numbers. FP8 first.

| Rank | Model | Quant | Cost per passing task | Pass rate N=1 | Pass rate N=3 | Max agents (under 35 ms/token) | Chosen agents | Prefix cache hit | Time, cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | qwen3.6-35b-a3b-nvfp4 | nvfp4 | $0.0624 | 7/10 (70%) | 8/10 | 128 | 128 | 100% | 14.51 min, $0.4371 |

The hard task (planWaves) gives the model only the spec and a stub, grades it with 16 hidden tests, and allows 10 minutes per attempt; Claude solved it in about 30 s with 16/16.

## qwen3.6-35b-a3b-nvfp4

| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |
| --- | --- | --- | --- | --- | --- |
| 64 | 24.2 | 2643.65 | 41.31 | 0 | 99% |
| 128 | 34.4 | 3718.06 | 29.05 | 4 | 99% |
| 192 | 39.7 | 4830.9 | 25.16 | 0 | 100% |

### Hard task (planWaves), qwen3.6-35b-a3b-nvfp4

| Best-of | Tests passed | Time | Attempts | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| N=1 | 16/16 | 80.2 s | 1 | 18445 | complete |
| N=3 | 0/16 | 128.2 s | 1 | 58647 | complete |

Agents per GPU is the highest tested agent count with under 5% errors and at most 35 ms per token for each agent (tested counts: 64, 128, 192). Best-of-N asks the server for N answers per task and keeps the smallest passing one; it is measured with background load at the chosen agent count. Ranking is cost per passing task, then agents per GPU. Prefix cache hit is vLLM's own counter after the run. Cost per passing task is the model's whole slot on the node at the hourly price, divided by tasks passed. Total spent on the node during the bake-off: $0.4400.

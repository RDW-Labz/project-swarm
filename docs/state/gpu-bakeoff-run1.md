# GPU bake-off

Run 2026-10-16 on one GPU at $1.807/h. Models are ranked on OUR tasks (the lane benchmark; the lessons eval set does not exist yet (Phase 15), so it is not included), not vendor SWE-bench numbers. FP8 first.

| Rank | Model | Quant | Cost per passing task | Pass rate N=1 | Pass rate N=3 | Max agents (under 35 ms/token) | Chosen agents | Prefix cache hit | Time, cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | qwen3.6-35b-a3b-nvfp4 | nvfp4 | $0.0685 | 3/10 (30%) | 5/10 | 192 | 192 | 0% | 6.82 min, $0.2054 |
| 2 | nemotron-3.5-lightning-nvfp4 | failed: gpu-unhealthy: no answer from http://127.0.0.1:18500 within 20 minutes (the model may still be downloading; run swarm gpu status) (the servers were stopped) Destroy the instance now (node bench/gpu-ba |  |  |  |  |  |  |  |
| 3 | qwen3-coder-next-nvfp4 | failed: gpu-unhealthy: no answer from http://127.0.0.1:18500 within 20 minutes (the model may still be downloading; run swarm gpu status) (the servers were stopped) Destroy the instance now (node bench/gpu-ba |  |  |  |  |  |  |  |

The hard task (planWaves) gives the model only the spec and a stub, grades it with 16 hidden tests, and allows 10 minutes per attempt; Claude solved it in about 30 s with 16/16.

## qwen3.6-35b-a3b-nvfp4

| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |
| --- | --- | --- | --- | --- | --- |
| 32 | 13.9 | 2307.28 | 72.1 | 0 | 0% |
| 64 | 17.8 | 3590.62 | 56.1 | 0 | 0% |
| 96 | 23.6 | 4067.19 | 42.37 | 0 | 0% |
| 128 | 23.2 | 5514.18 | 43.08 | 0 | 0% |
| 192 | 29.2 | 6583.44 | 34.29 | 0 | 0% |

### Hard task (planWaves), qwen3.6-35b-a3b-nvfp4

| Best-of | Tests passed | Time | Attempts | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| N=1 | 5/16 | 14.1 s | 1 | 4026 | complete |
| N=3 | 16/16 | 21.1 s | 1 | 10687 | complete |

Agents per GPU is the highest tested agent count with under 5% errors and at most 35 ms per token for each agent (tested counts: 32, 64, 96, 128, 192). Best-of-N asks the server for N answers per task and keeps the smallest passing one; it is measured with background load at the chosen agent count. Ranking is cost per passing task, then agents per GPU. Prefix cache hit is vLLM's own counter after the run. Cost per passing task is the model's whole slot on the node at the hourly price, divided by tasks passed. Total spent on the node during the bake-off: $1.42.

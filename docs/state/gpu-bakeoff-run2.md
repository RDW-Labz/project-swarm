# GPU bake-off

Run 2026-10-16 on one GPU at $1.807/h. Models are ranked on OUR tasks (the lane benchmark; the lessons eval set does not exist yet (Phase 15), so it is not included), not vendor SWE-bench numbers. FP8 first.

| Rank | Model | Quant | Cost per passing task | Pass rate N=1 | Pass rate N=3 | Max agents (under 35 ms/token) | Chosen agents | Prefix cache hit | Time, cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | qwen3.6-35b-a3b-nvfp4 | nvfp4 | $0.0848 | 3/10 (30%) | 5/10 | 192 | 192 | 0% | 8.45 min, $0.2545 |
| 2 | qwen3-coder-next-nvfp4 | nvfp4 | $0.0954 | 3/10 (30%) | 4/10 | 192 | 192 | 0% | 9.5 min, $0.2862 |
| 3 | nemotron-3.5-lightning-nvfp4 | nvfp4 | n/a | 0/10 (0%) | 1/10 | 192 | 192 | 0% | 5.44 min, $0.1638 |

The hard task (planWaves) gives the model only the spec and a stub, grades it with 16 hidden tests, and allows 10 minutes per attempt; Claude solved it in about 30 s with 16/16.

## qwen3.6-35b-a3b-nvfp4

| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |
| --- | --- | --- | --- | --- | --- |
| 32 | 13.4 | 2391.82 | 74.74 | 0 | 0% |
| 64 | 16.9 | 3781.21 | 59.08 | 0 | 0% |
| 96 | 23.4 | 4095.32 | 42.66 | 0 | 0% |
| 128 | 23.7 | 5406.81 | 42.24 | 0 | 0% |
| 192 | 29.4 | 6534.87 | 34.04 | 0 | 0% |

### Hard task (planWaves), qwen3.6-35b-a3b-nvfp4

| Best-of | Tests passed | Time | Attempts | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| N=1 | 0/16 | 20.5 s | 1 | 5282 | complete |
| N=3 | 16/16 | 23.8 s | 1 | 12680 | complete |

## qwen3-coder-next-nvfp4

| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |
| --- | --- | --- | --- | --- | --- |
| 32 | 17.2 | 1858.23 | 58.07 | 0 | 0% |
| 64 | 20.9 | 3064.93 | 47.89 | 0 | 0% |
| 96 | 23.7 | 4058.46 | 42.28 | 0 | 0% |
| 128 | 25.7 | 4983.65 | 38.93 | 0 | 0% |
| 192 | 32.5 | 5909.82 | 30.78 | 0 | 0% |

### Hard task (planWaves), qwen3-coder-next-nvfp4

| Best-of | Tests passed | Time | Attempts | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| N=1 | 0/1 | 17.8 s | 1 | 3774 | complete |
| N=3 | 7/16 | 28.2 s | 1 | 10088 | complete |

## nemotron-3.5-lightning-nvfp4

| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |
| --- | --- | --- | --- | --- | --- |
| 32 | 12.3 | 2597.34 | 81.17 | 0 | 0% |
| 64 | 15.3 | 4183.86 | 65.37 | 0 | 0% |
| 96 | 18.5 | 5187.55 | 54.04 | 0 | 0% |
| 128 | 20.4 | 6290.05 | 49.14 | 0 | 0% |
| 192 | 24.4 | 7866.84 | 40.97 | 0 | 0% |

### Hard task (planWaves), nemotron-3.5-lightning-nvfp4

| Best-of | Tests passed | Time | Attempts | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| N=1 | 0/16 | 11.2 s | 1 | 0 | failed: Worker must return every declared output exactly once |
| N=3 | 0/16 | 11.4 s | 1 | 4144 | complete |

Agents per GPU is the highest tested agent count with under 5% errors and at most 35 ms per token for each agent (tested counts: 32, 64, 96, 128, 192). Best-of-N asks the server for N answers per task and keeps the smallest passing one; it is measured with background load at the chosen agent count. Ranking is cost per passing task, then agents per GPU. Prefix cache hit is vLLM's own counter after the run. Cost per passing task is the model's whole slot on the node at the hourly price, divided by tasks passed. Total spent on the node during the bake-off: $0.7000.

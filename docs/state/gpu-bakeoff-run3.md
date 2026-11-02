# GPU bake-off

Run 2026-10-16 on one GPU at $1.807/h. Models are ranked on OUR tasks (the lane benchmark; the lessons eval set does not exist yet (Phase 15), so it is not included), not vendor SWE-bench numbers. FP8 first.

| Rank | Model | Quant | Cost per passing task | Pass rate N=1 | Pass rate N=3 | Max agents (under 35 ms/token) | Chosen agents | Prefix cache hit | Time, cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | qwen3.6-35b-a3b-nvfp4 | nvfp4 | $0.0599 | 7/10 (70%) | 7/10 | 0 | 192 | 100% | 13.91 min, $0.4190 |
| 2 | nemotron-3.5-lightning-nvfp4 | nvfp4 | $0.2187 | 2/10 (20%) | 2/10 | 0 | 192 | 58% | 14.52 min, $0.4374 |

The hard task (planWaves) gives the model only the spec and a stub, grades it with 16 hidden tests, and allows 10 minutes per attempt; Claude solved it in about 30 s with 16/16.

## qwen3.6-35b-a3b-nvfp4

| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |
| --- | --- | --- | --- | --- | --- |
| 192 | 42.9 | 4477.73 | 23.32 | 0 | 99% |
| 256 | 50 | 5120.21 | 20 | 31 | 100% |
| 384 | 100.7 | 3811.73 | 9.93 | 222 | 100% |

### Hard task (planWaves), qwen3.6-35b-a3b-nvfp4

| Best-of | Tests passed | Time | Attempts | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| N=1 | 0/16 | 82.5 s | 1 | 0 | failed: Rented server response incomplete, refused, truncated, or unexpected |
| N=3 | 0/16 | 104.2 s | 1 | 0 | failed: Rented server response incomplete, refused, truncated, or unexpected |

## nemotron-3.5-lightning-nvfp4

| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |
| --- | --- | --- | --- | --- | --- |
| 192 | 56.1 | 3425.23 | 17.84 | 0 | 58% |
| 256 | 80.9 | 3164.29 | 12.36 | 100 | 58% |
| 384 | 115.1 | 3335.76 | 8.69 | 131 | 58% |

### Hard task (planWaves), nemotron-3.5-lightning-nvfp4

| Best-of | Tests passed | Time | Attempts | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| N=1 | 0/16 | 73.3 s | 1 | 0 | failed: Rented server response incomplete, refused, truncated, or unexpected |
| N=3 | 0/16 | 79.7 s | 1 | 0 | failed: Rented server response incomplete, refused, truncated, or unexpected |

Agents per GPU is the highest tested agent count with under 5% errors and at most 35 ms per token for each agent (tested counts: 192, 256, 384). Best-of-N asks the server for N answers per task and keeps the smallest passing one; it is measured with background load at the chosen agent count. Ranking is cost per passing task, then agents per GPU. Prefix cache hit is vLLM's own counter after the run. Cost per passing task is the model's whole slot on the node at the hourly price, divided by tasks passed. Total spent on the node during the bake-off: $0.8600.

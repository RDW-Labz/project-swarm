# GPU bake-off

All runs used one rented RTX PRO 6000 S on a Vast.ai container instance (datacenter host) at $1.807/h, with the vLLM v0.31.0 pinned image. There were four bake-off runs. Per-task details are in the details-run2, details-run3 and details-run4 folders next to this report. The raw reports are the run1 to run4 report files next to this report. Each run used its own load prompt, thinking mode and sweep, so compare numbers only within a run.

| Model | Mode | Pass rate N=1 | Pass rate N=3 | Hard task N=1 | Hard task N=3 | Cost per passing task | Max agents under 35 ms/token | Prefix cache hit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3.6-35B-A3B NVFP4 | thinking off | 3/10 | 5/10 | 0/16 | 16/16 | $0.0848 | 192 (29.4 ms/token at 192) | 0% |
| Qwen3.6-35B-A3B NVFP4 | thinking on | 7/10 | 8/10 | 16/16 | 0/16 | $0.0624 | 128 | 99 to 100% |
| Qwen3-Coder-Next NVFP4 | thinking off | 3/10 | 4/10 | 0 of 1 (test file failed to load) | 7/16 | $0.0954 | 192 (32.5 ms/token at 192) | 0% |
| Nemotron 3.5 Lightning NVFP4 | thinking off | 0/10 | 1/10 | 0/16 | 0/16 | none (no passing task) | 192 (24.4 ms/token at 192) | 0% |
| Nemotron 3.5 Lightning NVFP4 | thinking on | 2/10 | 2/10 | truncated | truncated | not reported | none (56.1 ms/token at 192, the lowest tested) | 58% |

## Winner and agents per GPU

The winner is Qwen3.6-35B-A3B NVFP4 with thinking on. It passed 7 to 8 of 10 lane tasks. It solved the hard task at 16/16 with N=1. Its cost is about $0.062 per passing task.

The limit is about 128 agents per GPU at under 35 ms per token. At 128 agents it ran at 34.4 ms per token with 4 errors. At 192 agents it ran at 39.7 ms per token, so it is over the limit.

Claude solved the hard task in about 30 s with 16/16. Claude wrote the spec.

## What went wrong and was fixed

In run 1 we stopped the run early. Qwen3.6 passed 3/10 at N=1 and 5/10 at N=3. The hard task went from 5/16 to 16/16.

Nemotron failed to start. The plan used --prefix-match-unit 64, which is invalid for its 2128 block size. This was fixed.

Coder-Next failed to start. The RedHat build uses compressed-tensors, so --quantization modelopt_fp4 is rejected. This was fixed.

The flag --moe-backend flashinfer_b12x crashed Qwen3.6 with a CUDA illegal memory access. It is not used.

## Findings

1. Turning thinking on lifts Qwen3.6 from 3/10 to 7/10 on the lane tasks. It also solves the hard task. It uses about 3 to 4 times the tokens per task.
2. Best-of-3 helped when thinking was off. Qwen3.6 went from 3/10 to 5/10, and the hard task went from 0 to 16/16. It helped little with thinking on, from 7/10 to 8/10. It can also hurt. When a task has no visible tests in the job context, the selector has nothing to test. It then keeps the smallest candidate. On the hard task that candidate was wrong, at 0/16.
3. With thinking on and a long shared prefix, the practical limit was about 128 agents per GPU under 35 ms per token. Above about 192 agents the server queues and errors start. In run 3, 256 agents gave errors and 384 gave many. With thinking off and short prompts, 192 agents stayed at 29.4 ms per token.
4. Prefix caching works. Qwen3.6 with a long shared prefix reached 99 to 100% hits. Lightning reached 58%.
5. Nemotron Lightning was the fastest per token and the cheapest per token. It passed almost nothing, 0 to 2 of 10. It is not usable for tickets as configured.
6. Coder-Next passed 3/10 to 4/10 with thinking off. It was not retried with thinking.

## Money and cleanup

The Vast credit went from $25.00 to $20.13. That is about $4.87 in total. It covers four runs, three failed rental attempts (about $0.10 in total), and about 2.3 hours of the final instance.

The $15 cap was never close. The instance was destroyed at the end. The Vast API shows zero instances.

## Caveats

The lane benchmark has only 10 tasks, so one task is 10 percent.

Runs 2 to 4 changed the load prompt, the thinking mode and the sweep range. Numbers are comparable only within a run.

Cost per passing task counts the model's whole slot on the node. That includes load, sweep, benchmarks and the hard task, billed at the hourly price.

The lessons eval set does not exist yet (Phase 15), so it is not included.

# GPU Memory Plan — How Many Agents per RTX PRO 6000

For the 14e bake-off and the rented-GPU lane. Researched October 16, 2026. Numbers come from the models' config and weight files (exact) and published benchmarks (cited). Anything marked **est.** is my estimate. The bake-off confirms the real numbers.

---

## 1. Main findings

1. **Use one model copy per GPU with a big batch, not several copies.** A second copy loads the weights twice and takes half the room for agents. Tests only show gains from extra copies for tiny models (3B or less). vLLM's maintainers say to run one instance per GPU. (Databricks MPS study; vLLM forum)
2. **Don't move experts to RAM.** With 100 agents at once, almost every expert is used every step, so experts in RAM would be pulled over PCIe every step. Offloading only helps fit a model that doesn't fit, and ours all fit. RAM gets other jobs (section 5).
3. **Use NVFP4, not FP8.** The weights take half the memory, and NVFP4 was faster in the PRO 6000 tests. FP8 Qwen3.6 has an open slow-speed bug on this card (vLLM #44688).
4. **Upgrade vLLM from 0.27.1 to 0.31.0** (pinned by digest). NVFP4 on this card needs 0.28 or newer for the fast kernel. 0.31 also has the hybrid prefix-cache fixes.
5. **Speed is the real limit, not memory.** Past about 100 agents per GPU, each agent gets slow (more than about 35 ms per token). Pick the agent count by speed per agent.

## 2. The models (exact, from config and weight files)

| | Qwen3.6-35B-A3B | Qwen3-Coder-Next 80B-A3B | Nemotron 3.5 Lightning 30B-A3B |
|---|---|---|---|
| Active params | about 3.0B | about 3.5B | about 3.2B |
| Layers that use KV | 10 of 40 (the rest use DeltaNet) | 12 of 48 | 6 of 52 (the rest use Mamba) |
| NVFP4 weights (text only, no MTP) | **about 20.8 GB** | **47.5 GB** (RedHat build) | **about 18.9 GB** |
| FP8 weights | 37.5 GB | 80.4 GB (too big) | 32.3 GB |
| KV per token (FP8) | 10 KB | 12 KB | **3 KB** |
| Fixed state per agent | 33 MB (bf16) | about 40 MB (bf16) | 25 MB (fp16) |
| Memory per agent at 32K context | about 370 MB | about 440 MB | **about 125 MB** |
| SWE-bench Verified (vendor) | **about 70–73** | n/a | about 52 |

## 3. Memory table for one RTX PRO 6000 (96 GB)

Usable at 0.93 utilization is about 89 GB. Subtract the weights and about 5 GB of runtime overhead; what's left is room for agents.

| Model (NVFP4) | Weights | Room for agents | Agents that fit at 16K | at 32K | at 64K |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | 21 GB | about 63 GB | about 315 | about 170 | about 90 |
| Qwen3-Coder-Next | 48 GB | about 36 GB | about 150 | about 80 | about 45 |
| Nemotron Lightning | 19 GB | about 65 GB | about 1,000 | about 500 | about 260 |

Agents share their common prompt (rules, project context), and prefix caching stores it once, so real capacity is higher. "Align" mode adds some extra state, so treat the table as a rough guide.

## 4. Real limit: speed per agent

| Model | Measured on 1× PRO 6000 | Realistic agents per GPU |
|---|---|---|
| Qwen3.6 NVFP4 | 3,218 output tok/s at about 100 concurrent, 29 ms/token (flashinfer_b12x backend) | **about 80–120** |
| Coder-Next | 1,207 tok/s peak at 40 concurrent (FP8) | **about 40–60** (est., NVFP4) |
| Lightning | no PRO 6000 data; a B200 did 4,162 tok/s at 192 concurrent | **about 120–200** (est.) |

So an 8× PRO 6000 box is about 650–950 agents with Qwen3.6, or more with Lightning if its pass rate holds up. That costs about $9–13 per hour.

## 5. What host RAM and CPU are for

- **Not experts.** See section 1.
- **Fast restarts.** Model files stay in RAM after the first load. 64 GB or more is enough.
- **KV spill-over (later).** vLLM can spill agent memory to RAM (`--kv-offloading-size`), but it isn't tuned for these hybrid models yet. Revisit only if memory runs out.
- **CPU:** 16 or more vCPU. Scheduling and tokenizing for 100+ agents needs CPU, and a weak host CPU slows the GPU.
- **Rental filter:** PCIe Gen5 x16, 16 or more vCPU, 64 GB or more RAM (128 GB or more if we use KV spill-over), 200 GB or more NVMe.

## 6. Mixing a "lead" model and a fast "worker" model

- **On one GPU: no.** Two engines share the same compute, so the total output doesn't go up. They also waste memory on two sets of overhead, and two vLLM engines on one GPU are unreliable to start.
- **On a multi-GPU box: yes, one model per GPU.** For example, on 8 GPUs: 2 × Qwen3.6 for harder tickets and reviews, and 6 × Lightning for simple tickets (tests, docs, boilerplate, small fixes). The router sends each ticket by difficulty, and failures move up to Qwen3.6, then Haiku, then Codex.
- **Leads don't need the rented GPU at all.** There are few of them and they need the most smarts, so they stay on Claude, Codex or Haiku, and dev2 stays the "brain".
- **Only do this if the bake-off shows Lightning passes enough simple tickets.** Its general coding score is much lower (52 vs 70).

## 7. Bake-off changes

1. Upgrade the vLLM image to **v0.31.0, pinned by digest**.
2. Models, in order, all **NVFP4, text-only, no MTP**:
   1. Qwen3.6-35B-A3B NVFP4: full run.
   2. Nemotron 3.5 Lightning NVFP4: full run, which now matters for the mixed setup.
   3. Qwen3-Coder-Next NVFP4 (RedHat): only if time is left.
3. Flags to start from:
   - **All:** `--gpu-memory-utilization 0.93 --kv-cache-dtype fp8 --enable-prefix-caching --mamba-cache-mode align --prefix-match-unit 64 --max-num-batched-tokens 16384 --max-model-len 131072`
   - **Qwen:** `--quantization modelopt_fp4 --moe-backend flashinfer_b12x --mamba-ssm-cache-dtype bfloat16 --block-size 128 --reasoning-parser qwen3 --tool-call-parser qwen3_coder --enable-auto-tool-choice --language-model-only`, plus env `VLLM_HAS_FLASHINFER_CUBIN=1`
   - **Lightning:** the NVIDIA card's flags (`--mamba-ssm-cache-dtype float16 --reasoning-parser nemotron_v3 --tool-call-parser qwen3_coder --async-scheduling`), without DSpark/MTP.
4. **Agent counts:** test 32, 64, 96, 128 and 192 (instead of 1/50/200). Record ms/token, output tok/s, pass rate and prefix-cache hit rate at each step. **Max agents per GPU** is the highest count that stays under 35 ms/token.
5. **Best-of-1 vs best-of-3** at the chosen agent count.
6. Optional if time is left: an MTP A/B test at 32 agents.
7. **Ranking:** cost per passing ticket, then agents per GPU.

## Sources

- HF model cards, configs and weight files: Qwen/Qwen3.6-35B-A3B(-FP8), nvidia/Qwen3.6-35B-A3B-NVFP4, Qwen/Qwen3-Coder-Next(-FP8), RedHatAI/Qwen3-Coder-Next-NVFP4, nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 and -NVFP4
- vLLM recipes: recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B and recipes.vllm.ai/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16
- NVFP4 b12x benchmark on PRO 6000: forums.developer.nvidia.com/t/…/376703
- Coder-Next on PRO 6000: cloudrift.ai/blog/optimizing-qwen3-coder-rtx5090-pro6000
- Qwen3.6 FP8/NVFP4 on PRO 6000: helmcode.com/posts/qwen36-rtx-pro-6000-nvfp4 and millstoneai.com benchmarks
- FP8 slow-decode bug: github.com/vllm-project/vllm/issues/44688
- One engine vs replicas: databricks.com/en/blog/scaling-small-llms-nvidia-mps and discuss.vllm.ai/t/…/608
- Hybrid prefix caching: docs.vllm.ai (cache config, APC) and vllm issue #40696
- KV offload: vllm.ai/blog/2026-01-08-kv-offloading-connector
- Lightning on B200: docs.dynamo.nvidia.com/dynamo/recipes/nemotron-3-5-lightning
- vLLM releases: github.com/vllm-project/vllm/releases

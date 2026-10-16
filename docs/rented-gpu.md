# Rented GPU lane (`rented`)

A lane for an OpenAI-compatible server you start yourself in the cloud, usually vLLM or SGLang serving an open model on a rented GPU node (for example one 8x H100 machine). Thousands of cheap, parallel requests with no per-token bill: you pay by the hour for the node instead. **Swarm never rents or starts anything for you.** Renting and shutting down are manual steps (below); swarm only talks to the server and guards the spend.

Use it for work that suits a big open model and can wait for a server you started on purpose: sweeps, test and doc generation, review passes. It is never chosen by automatic routing: a job uses it only with `agent: "rented"`.

## How the money is counted

The cost is time, not tokens. For each run, one meter counts the hours the node was needed, from the first rented job's admission to the end of the run, at `hourlyUsd` (at least one minute once opened). That rental counts toward:

- the **run cap** (`--max-usd`, manifest `budget.maxUsd`), together with everything else the run spends;
- the **lane's day cap** across all runs and projects (default one run's maximum, `hourlyUsd x maxHoursPerRun`; raise or lower with `dailyUsd` in the config, or `spend.lanes.rented.dailyUsd`);
- the **hours limit** `maxHoursPerRun`.

The guard runs before each rented job starts. It **warns at 80%** of any of the three (a line in the run's warnings) and **stops launching at the cap**: remaining jobs are held (`run-cap`, `lane-cap` or `rental-hours`) and the run pauses. Jobs already running are never killed, so a run can pass a cap by the cost of one job's duration. A run with no USD cap does not start rented jobs. After `rental-hours`, `swarm resume` refuses: start a new run (and shut the server down).

**The meter does not stop the server.** The node bills until you terminate it. Set a spending alert and a hard limit at the provider too.

## Config

In `~/.config/project-swarm/config.json`:

```json
"rentedGpu": {
  "name": "h100-node",
  "endpoint": "http://127.0.0.1:8000",
  "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
  "keyItem": { "service": "project-swarm", "account": "rented.api_key" },
  "hourlyUsd": 24.5,
  "maxHoursPerRun": 3,
  "concurrency": 64,
  "dailyUsd": 80,
  "trusted": false
}
```

| Field | Meaning |
| --- | --- |
| `endpoint` | The server's origin. `https` required, except `http` to loopback (`127.0.0.1`, `localhost`), which is what an ssh tunnel gives you (recommended). No credentials, query or hash in the URL. |
| `model` | The model name the server serves. A rented job's `model` must be exactly this. |
| `keyItem` | The Keychain item holding the server's API key (default service `project-swarm`, account `rented.api_key`). The key is never in the config or a manifest. `SWARM_RENTED_API_KEY` overrides it (CI, tests). |
| `hourlyUsd` | The node's price per hour. Required: this is what the meter bills. |
| `maxHoursPerRun` | Hours one run may keep the node (default 4). |
| `concurrency` | The ceiling of requests in flight. The lane is **adaptive**: it starts at 4, opens one slot per window of successes, halves on a 429, and never passes this ceiling. |
| `dailyUsd` | The lane's day cap across runs (default `hourlyUsd x maxHoursPerRun`). |
| `trusted` | `true` only if this is your own server and you accept your code and data going to it. A sensitive job (the default) is refused on a server that is not `trusted: true`; with `sensitive: false` a job may always use it. |

`swarm doctor rented` checks that the block is valid and the Keychain key exists.

## Runbook: rent an 8x H100 node, serve an open model, use it, shut it down

Prices and names change; check the provider's current console and the model's vLLM recipe. Nothing here costs money until step 2.

1. **Pick the model.** An open-weights model that fits 8 x 80 GB, for example a large mixture-of-experts coder model in FP8 (Qwen3-Coder-480B-A35B-Instruct-FP8 is one), or a smaller model that needs fewer GPUs. Read its model card for the recommended vLLM or SGLang flags. Estimate the weights size (hundreds of GB for the largest).
2. **Rent the node** (this starts billing). From a GPU cloud (Lambda, RunPod, Vast.ai, CoreWeave and others offer 8x H100): on-demand, one 8x H100 80 GB (SXM preferred) instance, an Ubuntu image with NVIDIA drivers and Docker (most have them), at least 1 TB of NVMe disk (more for the largest models), a **dedicated ssh key** for this. Write down the instance id, the region and the hourly price, and put that price in `hourlyUsd`.
3. **Lock it down.** Open only ssh (port 22) in the provider's firewall, ideally from your IP. Do not expose port 8000.
4. **Start the server** (ssh in). Generate a key and keep it for step 5: `openssl rand -hex 24`. Then, for example with vLLM in Docker (flags change between releases; follow the model card):

   ```
   export RENTED_KEY=<the key you generated>
   docker run -d --name vllm --gpus all --ipc=host -p 127.0.0.1:8000:8000 \
     -v /data/hf:/root/.cache/huggingface \
     vllm/vllm-openai:latest \
     --model Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 \
     --served-model-name Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 \
     --tensor-parallel-size 8 --enable-expert-parallel --max-model-len 65536 \
     --api-key "$RENTED_KEY"
   ```

   The first start downloads and loads the weights (many minutes). Watch `docker logs -f vllm` until it says the application started, then, on the node: `curl -s -H "Authorization: Bearer $RENTED_KEY" http://127.0.0.1:8000/v1/models` lists the model. A gated model needs a Hugging Face token (`-e HF_TOKEN`) on the server only, never in a swarm repo. SGLang works the same way (`python -m sglang.launch_server --model-path ... --tp 8 --api-key ...`).
5. **Connect.** On your Mac, open a tunnel: `ssh -N -L 8000:127.0.0.1:8000 -i ~/.ssh/<that key> ubuntu@<node ip>` (leave it running). Store the key in the Keychain: `security add-generic-password -s project-swarm -a rented.api_key -w` (it asks for the key, so it is not in your shell history). Add the `rentedGpu` block above (`endpoint` `http://127.0.0.1:8000`, `model` the served name, `hourlyUsd` from step 2). Run `swarm doctor rented`.
6. **Smoke test**, cheap: a manifest with one job, `agent: "rented"`, `model` the served name, `sensitive: false`, then `swarm run smoke.json --max-usd 2`. `swarm inspect RUN` shows the `rental` (hours and dollars) beside the jobs.
7. **Use it.** Put `agent: "rented"` on the jobs that should run there, always with a run cap (`--max-usd`, or `go --max-usd`). Watch the 80% warning. Finish the work in one sitting: the meter, the day cap and the hours limit all assume you will.
8. **Shut it down, every time.** Stop the swarm runs; close the tunnel; `docker rm -f vllm`; then **terminate the instance in the provider's console** (a stopped instance often still bills for the reserved GPUs; terminate unless the provider says otherwise); delete any attached volume you do not need; check the billing page shows the instance gone; rotate the key (delete the Keychain item, make a new one next time).

| After every session | Done |
| --- | --- |
| Runs finished or paused, none still launching | |
| Tunnel closed | |
| Instance **terminated** in the console (not just stopped) | |
| Volumes deleted | |
| Billing page checked, no running instance | |
| Key rotated | |

## Troubleshooting

- `rented-not-configured`: no valid `rentedGpu` block; `swarm doctor rented` prints the first error.
- `model must be ...`: the job's `model` differs from the server's served model name.
- `401` from the server: the Keychain key differs from the `--api-key` the server started with.
- `connection refused`: the tunnel is down, or the server is still loading the weights.
- `only gets jobs that set sensitive: false`: the job is sensitive (the default) and `trusted` is false.
- Out of memory at start: lower `--max-model-len`, or use a smaller model or a quantized one.
- Held with `run-cap`: the run has no `--max-usd`, or the rental plus other spend reached it.

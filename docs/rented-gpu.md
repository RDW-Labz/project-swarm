# Rented GPU lane (`rented`)

A lane for **small, fast coding models** (about 7B to 35B, mixture-of-experts preferred) served by vLLM on a GPU node you rent: **one server per GPU**, jobs spread over all of them. It is the main cheap worker lane while a node is up; dev2's big Qwen stays the free reviewer and brain (see [local brain](local-brain.md)). You pay by the hour for the node, not per token. **Swarm never rents anything.** You rent and terminate the node; swarm only runs commands on it, keeps a session, and guards the spend.

## The rules (all enforced in code)

- **Only `sensitive: false` jobs** ever go to a rented host. There is no setting that changes this (`trusted: true` is refused in the config). Sensitive work goes to dev2, Haiku, Codex or Claude.
- No file and no key of yours ever goes to the node. swarm gpu up sends commands only (never scp, never a .env). The servers listen on the node's loopback only (docker publishes 127.0.0.1:800n) and are reached through an ssh tunnel. Each rental gets its own random 48-character API key, written to a private env file on the node (mode 600, removed by the timer and by gpu down) and kept in the session file next to your machine config (mode 600); it is not a key of yours and it dies with the rental. A model that needs a Hugging Face token is not supported by gpu up; use a public model.
- gpu up fails, and stops the servers, if any server port is reachable from outside: it tries to connect to every server port from this computer and reads the node's listening sockets (ss -ltn); anything bound to 0.0.0.0, * or [::] on a server port is refused.
- gpu up also refuses a node whose Docker is older than 28 (or whose version it cannot read): older Docker lets other hosts on the same network reach ports published on 127.0.0.1.
- The server image is pinned by digest (vllm/vllm-openai@sha256:..., vLLM v0.27.1); tags such as latest are refused, and --image accepts only another digest. To move to a newer vLLM, look up the new digest (a registry manifest request) and change PINNED_IMAGE in tools/gpu.mjs in a reviewed change.
- **Hard dollar cap per session** (`--max-usd`, required): the session lasts at most `max-usd / hourly-usd` hours (or `--max-hours`, default 4, if that is shorter).
- **Auto-destroy timer on the node itself:** at the expiry it removes the servers and powers the node off (best effort: it needs passwordless sudo). The timer still fires if your Mac sleeps or the link drops. **Powering off does not stop billing at most providers: terminate the instance.**
- **Contract on every job:** a job routed to this lane must name its exact files (`outputs` and `context`), carry the manifest's `contract` file in its context, and list `acceptance` tests (see below). Jobs without all four go to other lanes.
- **Escalation:** one failure on this lane sends the job to Haiku, then Codex.
- `swarm gpu up` and `swarm gpu bakeoff` print a plan and stop unless you add `--yes`.

## Which models

`swarm gpu models` lists the shortlist (ids are a starting point; check each exists on Hugging Face before renting). FP8 is the safe path on every Blackwell card; NVFP4 only as an extra run.

| Model | Weights | Why |
| --- | --- | --- |
| Qwen3.6-35B-A3B NVFP4 (nvidia build) | about 20.8 GB | full run; the fast small mixture-of-experts pick; about 80 to 120 agents per GPU expected |
| Nemotron 3.5 Lightning 30B-A3B NVFP4 (NVIDIA card) | about 18.9 GB | full run; tiny KV cache so the most agents per GPU; its coding score is lower so it is for simple tickets if the bake-off shows it passes them |
| Qwen3-Coder-Next 80B-A3B NVFP4 (RedHat build) | 47.5 GB | only if time is left; about 40 to 60 agents expected |

Vendor numbers decide nothing here: the bake-off ranks them on our own tasks by cost per passing task, then agents per GPU. The pinned vLLM is v0.31.0 (NVFP4 on this card needs 0.28 or newer; the FP8 Qwen3.6 build has an open slow-decode bug on it). One vLLM engine runs per GPU (no extra replicas on one GPU, no expert offload to RAM): see [the GPU memory plan](plans/swarm-gpu-memory-plan.md).

## Bake-off: `swarm gpu bakeoff`

On **one** rented GPU, one model after another (all models are NVFP4):

```
swarm gpu bakeoff --target ubuntu@<ip> --key ~/.ssh/<key> --hourly-usd 1.8 --max-usd 12
```

For each model it starts one server, runs our lane benchmark (10 real tasks scored by hidden tests; the lessons eval set joins once Phase 15 builds `evals/`), then sweeps 32, 64, 96, 128 and 192 concurrent agents and records ms per token, output tokens per second, errors and the prefix-cache hit rate at each; max agents per GPU is the highest count that stays under 35 ms per token for each agent; best-of-1 and best-of-3 are then measured at that count with that many agents loading the server. It reports and writes `docs/state/gpu-bakeoff.md`:

- **pass rate** on our tasks;
- **tokens per second**, total and per agent, at each level;
- **agents per GPU**: the highest tested level with under 5% errors and at least 10 tokens/s each;
- **cost per passing task**: the model's whole slot on the node (load, our tasks, throughput) at the hourly price, divided by tasks passed.
- **best-of-N gain**: the same tasks at N=1 and N=3 (`--best-of 1,3` is the default; `--best-of 1` skips it), and the prefix cache hit rate after the run;

Models are ranked by pass rate, then cost per passing task. A model that fails to start or crashes is recorded, not fatal; no new model starts once the cap is spent. After the run, terminate the instance.

## Faster and cheaper on our own GPUs

**Prefix caching.** vLLM starts with `--enable-prefix-caching`. The rented lane sends the project's shared files first and the ticket's own task last, so every agent on a project reuses the cached prefix. List shared files first in a job's `context`. The bake-off and `swarm gpu status` show vLLM's own prefix-cache hit rate; target over 70% on a project run.

**Best-of-N.** On this lane only (tokens are nearly free), set `bestOf` (1 to 8) on a job, or `swarm gpu up --best-of 3` for a default. The lane asks the server for N answers in one request, runs the ticket's visible tests (the test files in the job's `context`) on each in a temporary git worktree with the answer applied, and keeps the smallest passing one. If none pass, the job fails with `best-of-failed` and escalates to Haiku, then Codex, as usual. A candidate that is not valid output is skipped. With no tests in context it picks the smallest valid one. It is never used on paid API lanes.

Tasks. The 10 lane-benchmark tasks (two bug fixes, two new functions, two refactors, two test-writing tasks, two docs tasks; see bench/lane-benchmark/README.md) are scored by hidden tests, structural checks, mutants or fact checks. A hard task is added on top (bench/gpu-bakeoff/tasks/hard-planwaves): planWaves, a ticket wave planner. The model gets only TASK.md and a stub planWaves.mjs, never the tests or the solution; it is graded by running the 16 hidden tests (pass is 16 of 16), with 10 minutes per attempt. Per model and per best-of count the report records tests passed, time, attempts and tokens. Claude solved it in about 30 seconds, 16 of 16 on the first run (and Claude wrote the spec, so it had an advantage). Known issue: Qwen3.6 NVFP4 crashes with a CUDA illegal memory access under vLLM 0.31.0 on the RTX PRO 6000 when started with --moe-backend flashinfer_b12x, so that flag is not used; vLLM's default MoE backend starts and serves.

## Using the winner: `swarm gpu up|down|status`

```
swarm gpu up --target ubuntu@<ip> --key ~/.ssh/<key> --model Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 --hourly-usd 1.8 --max-usd 12 --yes
swarm gpu status
swarm gpu down
```

- `up` counts the GPUs (`nvidia-smi -L`), starts one vLLM container per GPU (`swarm-vllm-0`, `-1`, ...; ports 8000+n on the node, tunnelled to `127.0.0.1:18000+n` here), sets the timer, opens one ssh tunnel, writes a session file next to the machine config (`gpu-session.json`: replicas, model, price, cap, expiry; no secrets), and waits until every replica answers (the first start downloads the weights; allow many minutes). Use `--gpus N` for fewer replicas and `--per-replica N` (default 32) for the requests one replica takes.
- While the session is live (not expired), the rented lane is routable: jobs with `agent: "auto"` that carry the full contract and `sensitive: false` go to it first, and `agent: "rented"` jobs work. The lane **load-balances**: each request goes to the replica with the fewest requests in flight, a replica that cannot be reached is skipped for 30 seconds, and the lane's concurrency is replicas x `--per-replica`. When the session ends or expires the lane is unroutable again.
- `status` shows replicas answering, hours used, cost against the cap and minutes left.
- `down` stops the servers, closes the tunnel, removes the session and prints the hours and cost. **Then terminate the instance in the provider console.**

## Job contract on this lane

```json
{
  "version": 1,
  "contract": "docs/contracts/api.md",
  "budget": { "maxUsd": 12 },
  "jobs": [{
    "id": "t-0042", "agent": "auto", "type": "build", "sensitive": false,
    "prompt": "Add the refund field to src/orders.js as the contract says.",
    "context": ["src/orders.js", "docs/contracts/api.md", "tests/orders.test.js"],
    "outputs": ["src/orders.js"],
    "acceptance": ["tests/orders.test.js passes", "refund is a number of cents, never negative"]
  }]
}
```

`context` and `outputs` are the exact files; the manifest's `contract` file must be in `context`; `acceptance` is a list of tests or checks the files must satisfy (it is added to the worker's task text). A job missing any of these is not sent to the rented lane (an explicit `agent: "rented"` job without them is refused at validation with `rented-contract`). The usual checks, review and integration still run afterwards.

## How the money is counted

The cost is time, not tokens. For each run, one meter counts the hours the node was needed, from the first rented job's admission to the end of the run, at the session's hourly price (at least one minute once opened). That rental counts toward:

- the **run cap** (`--max-usd`, manifest `budget.maxUsd`), together with everything else the run spends;
- the **lane's day cap** across all runs and projects (with a session: the session's `--max-usd`; otherwise `hourlyUsd x maxHoursPerRun` or `dailyUsd` from the config);
- the **hours limit** (the session's hours).

The guard runs before each rented job starts. It **warns at 80%** of any of the three and **stops launching at the cap**: remaining jobs are held (`run-cap`, `lane-cap` or `rental-hours`) and the run pauses. Jobs already running are never killed, and the guard looks only when a rented job is about to start (and every 10 seconds, for the warning and the shared day total), so a run can pass a cap by whatever the rental costs until the run ends: stop the run yourself if you see the warning. A run with no USD cap does not start rented jobs. Two runs using the node at the same time each meter it at the full hourly price, so they count it twice: that errs toward stopping early.

**The meter does not stop the node.** Only the timer on the node (power-off) and you (terminate) do. Set a spending alert and a hard limit at the provider too.

## Without a session: the config block (advanced)

You can still point the lane at a server you started by hand. In `~/.config/project-swarm/config.json`:

```json
"rentedGpu": {
  "name": "gpu-node",
  "endpoints": ["http://127.0.0.1:18000", "http://127.0.0.1:18001"],
  "auth": "none",
  "model": "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
  "hourlyUsd": 1.8,
  "maxHoursPerRun": 3,
  "concurrency": 64,
  "dailyUsd": 12
}
```

`endpoint` (one URL) or `endpoints` (up to 16, balanced as above): `https`, or `http` to loopback. `auth: "none"` is for loopback tunnels only; otherwise the key comes from the Keychain item `keyItem` (default service `project-swarm`, account `rented.api_key`) or `SWARM_RENTED_API_KEY`. Without a live session this lane is **never** chosen by automatic routing: use `agent: "rented"`, and all the rules above (non-sensitive only, contract on every job) still apply. `swarm doctor rented` checks the block.

## Container mode (Vast.ai and other container hosts)

Use `swarm gpu up --mode container` for a node that IS a container already running the pinned vLLM image. Vast container instances cannot run Docker, so the docker mode cannot be used there.

- The instance is created from the pinned image by digest (never a tag), with ssh access only and no mapped ports.
- `swarm gpu up` then starts `vllm serve` inside it: one per GPU, with `CUDA_VISIBLE_DEVICES` set, bound to 127.0.0.1. The per-rental key is kept in the server's environment, never on a command line.
- Exposure is checked as in docker mode: TCP probes from this computer, plus `--probe-ports N,N` for external ports the host maps. The node-side check reads `/proc/net/tcp` and `/proc/net/tcp6` (no `ss` or docker needed). Any listener on a server port that is not loopback fails `gpu up` and stops the servers.
- The rental helper (`bench/gpu-bakeoff/vast.mjs`) then destroys the instance. Run gpu up as `swarm gpu up ... || node bench/gpu-bakeoff/vast.mjs destroy`.
- A container cannot be powered off, so the timer on the node only stops the servers. Billing ends when the instance is destroyed. The helper's detached reaper does this at the deadline (it runs under `caffeinate -i` so the Mac cannot sleep), and `gpu down` tells you to do it.
- Offers for container mode must be verified hosts with reliability of at least 99%, RTX PRO 6000 S or WS (not Max-Q), datacenter preferred, and 4 hours at their price must be at most 80% of the cap. The host must also have PCIe Gen5 x16 (measured at least 45 GB/s), at least 16 vCPU, at least 64 GB of RAM, at least 200 GB of free NVMe disk.
  - Search: `node bench/gpu-bakeoff/vast.mjs search --mode container`
  - Rent: `node bench/gpu-bakeoff/vast.mjs rent --mode container --offer ID --hours 4 --max-usd 15`
- The instance id is printed first and kept in `~/.project-swarm-scratch/vast-instance.json`, so it can be destroyed in the Vast console.
- The Vast API key lives in the Keychain (`project-swarm` / `vast.api_key`) and is read only by the helper.

## Renting the node (you do this; it costs money)

1. Pick the GPU: one or more RTX PRO 6000 Blackwell (96 GB) or similar; for the bake-off one GPU is enough. Prices change; note the hourly price for `--hourly-usd`.
2. Rent it on-demand (Lambda, RunPod, Vast.ai, CoreWeave and others): an Ubuntu image with NVIDIA drivers and Docker, at least 200 GB of disk, a **dedicated ssh key**, and passwordless sudo for the timer's power-off. Open only ssh (port 22) in the firewall.
3. Connect once by hand (`ssh -i <key> ubuntu@<ip>`) and compare the host key fingerprint with the provider's console; `swarm gpu` refuses unknown hosts (`BatchMode`).
4. Run the bake-off or `swarm gpu up` (above).
5. **Terminate the instance** when done, delete any volume you do not need, and check the billing page shows nothing running.

| After every session | Done |
| --- | --- |
| Runs finished or paused, none still launching | |
| `swarm gpu down` run | |
| Instance **terminated** in the console (not just stopped) | |
| Volumes deleted | |
| Billing page checked, no running instance | |

## Troubleshooting

- `gpu-unhealthy`: no answer within 20 minutes; the model may still be downloading. `swarm gpu status`, or `ssh` in and `docker logs swarm-vllm-0`.
- `gpu-session-exists`: run `swarm gpu status`, then `swarm gpu down`.
- `rented-contract`: the job lacks outputs, context, the manifest `contract` in context, or `acceptance`.
- `only gets jobs that set sensitive: false`: the job is sensitive (the default). A rented host never takes those.
- `connection refused`: the tunnel is down (`swarm gpu status`), or the server is still loading.
- Out of memory at start: use a smaller model, or lower `--max-model-len` (default 32768).
- Held with `run-cap`: the run has no `--max-usd`, or the rental plus other spend reached it.

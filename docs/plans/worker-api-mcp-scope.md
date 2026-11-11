# Worker API + Swarm MCP — scope (build after swarm go stage 1 passes)

Status: queued. Do not start until `swarm go` stage 1 is proven on every registered worker.

## Goal

Move worker claim/heartbeat/result traffic off SSH-RPC onto an authenticated HTTPS API on the brain, then expose the same operations as MCP tools. SSH stays for setup, repair, attach and screen; git mirror traffic stays on SSH.

## Requirements

- R-601 **Worker API on the brain.** Endpoints: submit job, claim, heartbeat, report result. Same queue, leases, retries, lanes and capabilities as today. Bind only to the private LAN/WireGuard interface; never the public internet.
- R-602 **Per-machine tokens.** Each machine has its own bearer token stored in its OS keychain (macOS Keychain, Linux Secret Service). Tokens are never written to the repo, queue files, logs or model context, and are never printed by any command.
- R-603 **Transport switch.** Workers select `SWARM_WORKER_TRANSPORT=https|ssh`; HTTPS is the new default after canary. `ssh` remains a working rollback path.
- R-604 **MCP server.** Tools: `submit_job`, `job_status`, `machine_list`, `fleet_check`, `session_list`, backed by the worker API and existing brain commands.
- R-605 **Canary migration.** The canary worker first: install token, switch transport, run `swarm fleet check` and a real `swarm go` run. Only then roll to the other workers. Auto-rollback to SSH-RPC if check or go fails.
- R-606 **Security checks.** Reject unauthenticated requests, tokens for a different machine, revoked tokens, oversized bodies and non-private binds. Never log Authorization headers.

## Tickets (in build order)

| ID | Title | Files / area | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T-6201 | HTTPS API skeleton + private bind | `tools/worker-api.mjs`, `tools/swarm.mjs` | — | Health route only on LAN/WireGuard; public bind refused; test covers bind policy |
| T-6202 | Machine token store + provisioner | `tools/machine-tokens.mjs` | T-6201 | Token generated per machine, stored in keychain, never in repo/logs; revoke works |
| T-6203 | Auth middleware + machine binding | `tools/worker-api.mjs` | T-6201, T-6202 | Missing/wrong/revoked token → 401/403; token machine mismatch rejected |
| T-6204 | submit/claim/heartbeat/result endpoints | `tools/worker-api.mjs`, `tools/worker-queue.mjs` | T-6203 | Same lease/requeue/timeout semantics as SSH-RPC; duplicate submit idempotent |
| T-6205 | HTTPS client transport | `tools/worker-runner.mjs` | T-6204 | `SWARM_WORKER_TRANSPORT=https` uses API; `ssh` unchanged; test switches both |
| T-6206 | MCP server skeleton | `tools/mcp-server.mjs` | T-6201 | Starts on private bind, no secrets in startup logs |
| T-6207 | MCP tools | `tools/mcp-server.mjs` | T-6206, T-6204 | Tools return job status, machine list, fleet check and session list; tests use a stub API |
| T-6208 | Canary worker migration | docs + provisioner | T-6205 | canary claims over HTTPS; fleet check passes; real swarm go ticket runs on the canary |
| T-6209 | Rollout + rollback drill | docs + fleet command | T-6208 | other workers migrate only after the canary; one-command revert to SSH-RPC tested |
| T-6210 | Security and leakage tests | tests | T-6203, T-6207 | No token in logs/queue/repo/model output; non-private bind and bad auth fail closed |

## Rollback

Keep `SWARM_WORKER_TRANSPORT=ssh` and the SSH-RPC endpoints intact until T-6209 passes. Canary rollback: restore the worker's previous `~/.project-swarm/current` and transport env, re-run `swarm fleet check`. Tokens can be revoked without touching SSH keys.

## Proof

The canary worker runs a real `swarm go` ticket over HTTPS (machine attribution shows the canary), `swarm fleet check` passes, then the other workers in order. A forced token failure proves auto-rollback to SSH-RPC.

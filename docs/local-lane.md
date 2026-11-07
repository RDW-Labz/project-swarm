# Local lane (OpenAI-compatible workers)

The **local** lane runs tool-free, single-request jobs against operator-owned OpenAI-compatible chat-completions servers (vLLM, llama.cpp server, etc.). Cost is always **$0**; token usage is still recorded on the job result.

## Configuration

Register endpoints in machine config (`SWARM_CONFIG`), never in a manifest:

```json
{
  "lanes": {
    "local": {
      "agencyConcurrency": 1,
      "endpoints": [
        {
          "name": "dev2",
          "baseUrl": "http://127.0.0.1:18000",
          "model": "my-model-id",
          "slots": 3,
          "keychain": { "service": "project-swarm", "account": "local.dev2" }
        }
      ]
    }
  }
}
```

- **No API key in config** (or in manifests, logs, or worker prompts). Validation refuses `apiKey`, `key`, `token`, and similar fields.
- **name** — short id; jobs use model `local:<name>` (for example `local:dev2`).
- **slots** — max concurrent jobs for that endpoint across the machine.
- **agencyConcurrency** — separate cap (default **1**) for `diagnose`, `test`, and `docs` jobs when `SWARM_AGENCY_CALL=1` (agency / other-people calls), so shared servers are not starved.

On Linux, set `linuxEnv` on the endpoint (or under `keychain`) to the name of an env var that holds the bearer token.

**Default:** no endpoints are configured; add `dev2` only after you confirm the tunnel and server.

## Managed tunnel (recommended)

`swarm tunnel` installs a **launchd** SSH forward that reconnects on its own, so dev2 keeps working when your terminal is closed.

Example (use **18001** locally so you do not collide with other tunnels on **18000**):

```bash
swarm tunnel add dev2 --host user@dev2.example --key ~/.ssh/project-swarm --local-port 18001 --remote-port 8000
```

Point `baseUrl` at `http://127.0.0.1:18001`, then `swarm tunnel status dev2` for launchd state, the local port, log tail, and `GET /v1/models` reachability (no API key is sent).

```bash
swarm tunnel remove dev2
```

## Manual SSH tunnel (example: dev2 Strata)

On your laptop, forward a local port to the server’s loopback inference port:

```bash
ssh -N -L 18000:127.0.0.1:8000 <dev2>
```

Point `baseUrl` at `http://127.0.0.1:18000`.

## Keychain (macOS)

The swarm **never** creates credentials. The operator stores the bearer token once:

```bash
security add-generic-password -s project-swarm -a local.dev2 -w
```

(`-w` prompts for the secret; it is read at request time and sent as `Authorization: Bearer …` only to the configured `baseUrl`.)

## Doctor

```bash
swarm doctor local
swarm doctor local --probe-local
swarm doctor local --probe-local --verify-key
```

`swarm doctor local` is configuration-only. With **`--probe-local`**, the parent runs unauthenticated `GET /v1/models` through each endpoint’s `baseUrl` with a **5 s** timeout (no API key is sent). It reports model id, latency, slot count, HTTP status, and reachability without hanging on a dead tunnel.

| HTTP response | Reachable | Meaning |
|---------------|-----------|---------|
| **2xx** | yes | Server up; models list verified (`status: ok`, `liveVerified: true`). |
| **401 / 403** | yes | OpenAI-compatible server up; bearer required (`status: ok-auth-required`, `liveVerified: false`). Routing does **not** pause the endpoint. |
| **404 / 405** | no | Not treated as a model server (another process or proxy on the port); `status: ok-unverified`, not reachable for routing or health cache. |
| **5xx**, timeout, connection error | no | Unreachable (`status: unreachable`). |

With **`--verify-key`**, after the unauthenticated probe the parent may read the Keychain (or `linuxEnv`) bearer and send one authenticated `GET /v1/models` per endpoint (`redirect: error`), but **only** when `baseUrl` is **https** or **http** on loopback (`127.0.0.1`, `[::1]`, `localhost`). Plain **http** to any other host is **key-blocked**: no credential read and no request. A **2xx** sets `liveVerified: true` and marks the endpoint healthy; **401** is **key rejected** and marks the endpoint **unhealthy** in the router health cache (the secret is never printed). Use this to confirm dev2 over a tunnel when the unauthenticated probe only sees 401.

**Sensitive jobs** (`sensitive` not `false`) are routed and executed only against **loopback** `baseUrl` values, regardless of probe reachability or endpoint health. Non-loopback HTTPS endpoints remain available for jobs explicitly marked `sensitive: false`.

## Routing

Auto jobs treat **local** as the cheapest API lane after Cursor and Codex when endpoints are configured and healthy. Before routing, the lane probes `GET /v1/models` (5 s timeout). A dead tunnel (connection refused or timeout) marks that endpoint **paused for 60 s** so jobs spill to other lanes instead of failing immediately. The router skips paused endpoints and picks the first healthy one when the job does not name a model.

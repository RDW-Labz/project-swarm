# Remote hosts

A run stays on this machine until a manifest or the shared config names `hosts`. Each host is `local`, `ssh`, or `sandbox`, and each has its own capacity.

```json
{
  "hosts": [
    { "id": "local", "kind": "local", "capacity": 4 },
    { "id": "dev2", "kind": "ssh", "target": "worker@10.10.10.220", "capacity": 2, "heartbeatMs": 5000 },
    { "id": "box", "kind": "sandbox", "driver": ["swarm-sandbox", "run"], "capacity": 1, "trusted": false }
  ]
}
```

A host with `"enabled": false` stays in the file but is never pinged or used; when no enabled host is left the run stays local. `target` is a host or `user@host` with no spaces. The ssh client is `BatchMode` and does not accept a new host key, so the key has to be in `known_hosts` already. `driver` is the sandbox command argv. `heartbeatMs` defaults to 5000 and can be 20–60000.

The runner places each job on a live host that still has room. A local job runs as it does today. An ssh or sandbox job sends the copied workspace, runs there, and writes back only the declared outputs. Each returned file must match its sha256.

These paths are never shipped: `.env`, `.env.*`, `.git`, `.swarm`, `.ssh`, `.aws`, and `.gnupg`. The process environment on the remote side is only `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TZ`, and `SWARM_PORT_BASE`. API keys stay where they already are; put them on the remote host itself if that worker needs them.

A job is sensitive unless it sets `sensitive: false`. A sensitive job runs on a local host or an ssh host. A sandbox host runs one only when that host sets `trusted: true`.

Each remote job gets an id. The remote command is `swarm-remote-exec`. It keeps the ssh connection open while the job runs. If that connection closes, or the session is hung up, it kills its child process and exits. A heartbeat runs `true` on each remote host. One missed ping leaves the host's jobs where they are. Three misses in a row mark the host dead, and those jobs are placed again on a host that is still up. When the dead host answers again, the runner sends a kill for any orphaned job ids before placing a new job on it. If that kill reports a cost, the run counts it (`orphanCostUsd`) with the rest of the spend. The job record keeps `host` (the last host) and `hostUses` (every host it was placed on).

## Host failures

Before the first job is placed, the runner pings every remote host once, in parallel. A host that fails is left out of the whole run and the run lists it under `hostsExcluded` and in `warnings` (`host-unavailable`). It is never revived mid-run.

A failure to reach a host mid-run (ssh exit 255, a refused connection, no ssh client) takes that host out for the rest of the run, and the job it was running is placed again on a live host. Jobs already running on that host are placed again too. Nothing else is cancelled. A remote command that exits with any other code, or returns files that fail their sha256, fails that one job and the run goes on. A job with no usable host left fails alone with `hosts-exhausted`.

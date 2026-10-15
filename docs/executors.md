# Remote hosts

A run stays on this machine until a manifest or the shared config names `hosts`. Each host is `local`, `ssh`, or `sandbox`, and each has its own capacity.

```json
{
  "hosts": [
    { "id": "local", "kind": "local", "capacity": 4 },
    { "id": "dev2", "kind": "ssh", "target": "worker@10.10.10.220", "capacity": 2, "heartbeatMs": 5000 },
    { "id": "box", "kind": "sandbox", "driver": ["swarm-sandbox", "run"], "capacity": 1 }
  ]
}
```

`target` is a host or `user@host` with no spaces. The ssh client is `BatchMode` and does not accept a new host key, so the key has to be in `known_hosts` already. `driver` is the sandbox command argv. `heartbeatMs` defaults to 5000 and can be 20–60000.

The runner places each job on a live host that still has room. A local job runs as it does today. An ssh or sandbox job sends the copied workspace, runs there, and writes back only the declared outputs. Each returned file must match its sha256.

These paths are never shipped: `.env`, `.env.*`, `.git`, `.swarm`, `.ssh`, `.aws`, and `.gnupg`. The process environment on the remote side is only `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TZ`, and `SWARM_PORT_BASE`. API keys stay where they already are; put them on the remote host itself if that worker needs them.

A heartbeat runs `true` on each remote host. If it fails, the host is dead and its in-flight jobs are placed again on a host that is still up. The job record keeps `host` (the last host) and `hostUses` (every host it was placed on).

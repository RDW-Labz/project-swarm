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

The runner places each job on a live host that still has room. A local job runs as it does today.

**Which jobs run remotely.** Only the text-envelope CLIs, Hermes and Qwen. A host names the absolute path of each CLI it can run in `commands`, for example `"commands": { "hermes": "/home/dev2/.local/bin/hermes" }`. Every other job, and any Hermes or Qwen job whose host has no path for it, runs on this machine; API jobs never leave it because their keys do not. If only remote hosts are configured, those other jobs still run locally.

**What happens.** The runner builds the job's message exactly as for a local Hermes, then sends one request over ssh (or the sandbox driver) to `swarm-remote-exec` on the host: `{ id, command, args, stdin, keepHome, env, files, outputs }`. The remote side runs `command` (an absolute path, no shell) in a fresh private workspace with only the allowlisted environment and the message on stdin, then replies with one line: `{ id, exitCode, stdout, files }`. The runner parses the stdout with the same envelope rules as a local run and writes the files and edits into the job's workspace. A non-zero `exitCode` fails that job. Each returned file must match its sha256, and a reply for a different id is refused. For Hermes and Qwen the message carries the job's text, so `files` and `outputs` are empty. `HOME` is the throwaway workspace unless the request sets `keepHome` (the runner sets it for Hermes and Qwen, which read their own provider config); a workspace file that is a symlink, a secret path, absolute, or contains `..` is refused, and an output must be a regular file under 32 MiB (64 outputs, 128 MiB in all). When the job ends, anything it left running in its process group is killed.

**Installing the remote side.** Copy `tools/remote-exec.mjs` (it imports nothing from this project) to the host and put a small wrapper next to it that runs it with node. Name the wrapper in the host entry with `remoteExec` when ssh's PATH does not find it:

```json
{ "id": "dev2", "kind": "ssh", "target": "dev2@10.10.10.220", "capacity": 2,
  "commands": { "hermes": "/home/dev2/.local/bin/hermes" },
  "remoteExec": "/home/dev2/swarm-bench/remote-exec/swarm-remote-exec" }
```

Job records live in a private per-user folder (`$TMPDIR/swarm-remote-jobs-<uid>`, mode 0700); a folder owned by another user, or a symlink, is refused.

**Testing against a real host.** `tests/remote-exec-real.test.mjs` runs the real ssh transport and is skipped unless you set `SWARM_TEST_SSH_HOST=user@host` and `SWARM_TEST_SSH_EXEC=/absolute/path/to/swarm-remote-exec`. It runs only `/bin/sh` with tiny scripts: no model, no key. It covers ping, stdin, files, the env allowlist, output with sha256, exit codes, dropped secret paths and refused traversal. The stub-transport tests prove scheduling; this one proves the protocol.

These paths are never shipped: `.env`, `.env.*`, `.git`, `.swarm`, `.ssh`, `.aws`, and `.gnupg`. The process environment on the remote side is only `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TZ`, and `SWARM_PORT_BASE`. API keys stay where they already are; put them on the remote host itself if that worker needs them.

A job is sensitive unless it sets `sensitive: false`. A sensitive job runs on a local host or an ssh host. A sandbox host runs one only when that host sets `trusted: true`.

Each remote job gets an id. The remote command is `swarm-remote-exec`. It keeps the ssh connection open while the job runs. If that connection closes, or the session is hung up, it kills its child process and exits. A heartbeat runs `true` on each remote host. One missed ping leaves the host's jobs where they are. Three misses in a row mark the host dead, and those jobs are placed again on a host that is still up. When the dead host answers again, the runner sends a kill for any orphaned job ids before placing a new job on it. If that kill reports a cost, the run counts it (`orphanCostUsd`) with the rest of the spend. The job record keeps `host` (the last host) and `hostUses` (every host it was placed on).

## Host failures

Before the first job is placed, the runner pings every remote host once, in parallel. A host that fails is left out of the whole run and the run lists it under `hostsExcluded` and in `warnings` (`host-unavailable`). It is never revived mid-run.

A failure to reach a host mid-run (ssh exit 255, a refused connection, no ssh client) takes that host out for the rest of the run, and the job it was running is placed again on a live host. Jobs already running on that host are placed again too. Nothing else is cancelled. A remote command that exits with any other code, or returns files that fail their sha256, fails that one job and the run goes on. A job with no usable host left fails alone with `hosts-exhausted`.

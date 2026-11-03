# Machines and workers

One swarm across the owner's machines: one brain (orchestrator, ticket queue, Swarm Watch), pull-based workers, and a single machine registry. The reference scripts in `docs/inputs/machines/` are inputs only; they are not run by the swarm.

## Commands

```
swarm machine add <user>@<host> [--name NAME] [--role worker|both|brain] [--slots N] [--key PATH]
swarm machine login <name>
swarm machine doctor [name]
swarm machine list [--probe]
swarm machine remove <name>
swarm remote setup <user>@<brain-host>
swarm attach
swarm screen <name>
swarm brain move <name> [--force]
swarm brain watch
swarm worker queue add <manifest> [--project P] [--lane L]
swarm worker queue list | sweep | clear
swarm worker next --lanes a,b [--json]
swarm worker claim ID --holder H
swarm worker renew ID --holder H
swarm worker report ID --holder H --report B
swarm worker run [--once]
swarm worker mirror <name> <repo-path>
swarm worker install | status
```

`machine add` is re-runnable: it detects an existing key, runner, folders, PATH line, package and lane installs, and skips them. It asks the target's password once, through `ssh-copy-id`; no password or key is stored by the swarm.

## Registry and measured data

`~/.project-swarm/machines.json` is the one registry (mode 600): role, host, user, OS, arch, RAM, cores, slots, lanes, health, free disk, battery/charger/lid, FileVault, Remote Login, Screen Sharing and runner state. Every value is measured on the machine; anything that cannot be measured is omitted, never guessed. `swarm machine list --probe` refreshes the measured fields. Swarm Watch reads the same registry and only renders the measured fields.

## Transport and repo access

Workers **pull** work over SSH from the brain; the brain never pushes tickets. Why SSH: it uses the key and access that `machine add` already establishes, needs no new listening port or shared token, survives a worker dropping offline, and keeps the LAN path fast. The brain's worker queue lives in `~/.project-swarm/state/worker-queue.json` with lease + heartbeat semantics; a silent worker's lease expires and the item returns to the queue.

Workers clone repositories from bare mirrors on the brain (`~/.project-swarm/mirrors/<name>.git`), not from GitHub. Why: the GitHub credential stays on the brain, the LAN clone is fast, and a worker never needs a repository token. Create or refresh a mirror with `swarm worker mirror <name> <repo-path>` on the brain.

## Shared state and brain handoff

The simplest reliable shared state is the brain's `~/.project-swarm/state` directory plus each project's `.swarm/project` files and `coordination/` state. It is small, needs no third-party sync service, works offline on the LAN, and has exactly one writer (the brain). `swarm brain move` pauses new leases, snapshots the listed projects' ticket queue, leases, plans, lessons and usage ledger into the state directory, rsyncs it to the next brain, moves the orchestrator and Watch, and repoints workers. Running tickets continue in their worker worktrees; they are not cancelled.

Only one brain exists at a time: `~/.project-swarm/brain.lock` is exclusive and stale locks are reclaimed. Workers read `~/.project-swarm/brain.json`. `swarm brain watch` checks the brain on an interval; after a few silent minutes it moves the brain to the next machine in the registry order (default `mini -> bean -> ghost -> air8`) and prints the failover. Moving the brain to a `remote+worker` machine on battery or away is refused unless `--force`; with `--force` the command warns that the swarm stops when that machine sleeps.

## Ghost (remote + worker)

A `remote+worker` machine takes new work only when it is on the charger, its lid is open, and it can reach the brain. Before each pull it checks all three; when any is false it takes no new work and shows `away` in the Watch. Existing work gets a short grace period, then hands back. When the owner is active it drops to one slot; when idle it uses its full slots. `swarm attach` and `swarm screen` reach it through the brain, so they work at home or away over WireGuard.

## Lanes

The worker lane plugins are one config entry each: `claude`, `codex`, `gemini`, `opencode` and `cursor` (`cursor-agent`). Each has its headless command, health check, login hint and rate-limit/logged-out detector. A rate limit or logged-out result cools that lane on that machine and work is not claimed for it until it recovers. The same runner runs on macOS (LaunchAgent in the logged-in user session, so Keychain logins work) and Linux (systemd user service).

## Hand steps that cannot be scripted

- Turn on **Remote Login** and **Screen Sharing** in System Settings -> General -> Sharing (macOS requires Full Disk Access to change these by script).
- Type the target Mac's password once during `ssh-copy-id`.
- Type each lane's own login on that machine (`claude`, `codex login`, `gemini`, `opencode auth login`, `cursor-agent login`, `gh auth login`).
- If FileVault is on, a reboot waits for the password at the keyboard; run `swarm machine doctor` to see it.
- Keep a full-time worker on the charger with the lid open; a `remote+worker` machine follows the ghost rules above.

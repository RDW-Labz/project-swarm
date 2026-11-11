# Machines and workers

One swarm across the owner's machines: one brain (orchestrator, ticket queue, Swarm Watch), pull-based workers, and a single machine registry. The reference scripts in `docs/inputs/machines/` are inputs only; they are not run by the swarm.

## Commands

```
swarm machine add <user>@<host> [--name NAME] [--role worker|both|brain] [--slots N] [--filevault warn|fail] [--key PATH]
swarm machine rollback <name> [--forget]
swarm machine login <name>
swarm machine doctor [name]
swarm machine list [--no-probe]
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

`machine add` is re-runnable: it detects an existing key, runner, folders, PATH line, package and lane installs, and skips them. It asks the target's password once, through `ssh-copy-id`; no password or key is stored by the swarm. Before it changes anything it writes `~/swarm-worker/rollback.sh` on the target, with the previous `current` symlink, PATH line, brain pointer, LaunchAgents, power settings and hostname captured once. `swarm machine rollback <name>` runs it; installed Homebrew packages and lane CLIs are left in place. Use IP targets, not `.local`, so a DHCP or Bonjour change cannot move a machine.

Apple silicon uses Homebrew at `/opt/homebrew`; Homebrew no longer supports Intel Macs. On an Intel Mac the bootstrap uses Xcode's `/usr/bin/git`, installs the official x86_64 Node build under `~/.local/node` (checksum verified, no sudo), uses `/usr/bin/jq`, and skips `gh` and `tmux` because workers clone from the brain's mirrors. It installs the lane CLIs with npm or their official installer. On Intel it leaves an arm64-only binary, or one that still fails to start after a clean-environment retry, out of `lanes.json` with a `lane_skipped` warning. On Apple silicon an installed CLI is accepted, because a one-shot `--version` can fail over SSH for Keychain or TTY reasons without meaning the lane is broken. The verified list in `~/swarm-worker/.lanes-ok` is what `machine list`, Swarm Watch and the add summary report, so warnings and the summary agree. The worker LaunchAgent puts `~/.local/node/bin` and `~/.local/bin` first, and SSH commands read the same PATH from `~/.zshenv`. Nothing uses sudo unless `sudo -n` already works; otherwise the bootstrap prints the exact command to run at the machine.

`--slots` sets the worker's slot ceiling. A full-time Mac uses that many concurrent tickets. A `remote+worker` laptop still needs the charger and an open lid, and drops to one slot while the owner is active. On a throttling Mac the runner backs off the ceiling from measured `CPU_Speed_Limit` / `CPU_Scheduler_Limit` and recovers one slot per clean sample; `swarm machine doctor` shows `CPU is throttling` when `pmset -g therm` reports it.

## Registry and measured data

`~/.project-swarm/machines.json` is the one registry (mode 600): role, host, user, OS, arch, RAM, cores, slots, lanes, health, free disk, battery/charger/lid, FileVault, Remote Login, Screen Sharing and runner state. Every value is measured on the machine; anything that cannot be measured is omitted, never guessed. `swarm machine list` probes live by default and writes the new measurements back; `--no-probe` is the quick cached view. Any measured value older than 15 minutes is hidden in `machine list` and Swarm Watch and replaced by `stale`, so an old disk or health figure is never shown as current.

## Transport and repo access

Workers **pull** work over SSH from the brain; the brain never pushes tickets. Why SSH: it uses the key and access that `machine add` already establishes, needs no new listening port or shared token, survives a worker dropping offline, and keeps the LAN path fast. The brain's worker queue lives in `~/.project-swarm/state/worker-queue.json` with lease + heartbeat semantics; a silent worker's lease expires and the item returns to the queue.

Workers clone repositories from bare mirrors on the brain (`~/.project-swarm/mirrors/<name>.git`), not from GitHub. Why: the GitHub credential stays on the brain, the LAN clone is fast, and a worker never needs a repository token. Create or refresh a mirror with `swarm worker mirror <name> <repo-path>` on the brain.

## Shared state and brain handoff

The simplest reliable shared state is the brain's `~/.project-swarm/state` directory plus each project's `.swarm/project` files and `coordination/` state. It is small, needs no third-party sync service, works offline on the LAN, and has exactly one writer (the brain). `swarm brain move` pauses new leases, snapshots the listed projects' ticket queue, leases, plans, lessons and usage ledger into the state directory, rsyncs it to the next brain, moves the orchestrator and Watch, and repoints workers. Running tickets continue in their worker worktrees; they are not cancelled.

Only one brain exists at a time: `~/.project-swarm/brain.lock` is exclusive and stale locks are reclaimed. Workers read `~/.project-swarm/brain.json`. `swarm brain watch` checks the brain on an interval; after a few silent minutes it moves the brain to the next machine in the registry order (`failoverOrder` in the local machine config, otherwise the order machines were added) and prints the failover. Moving the brain to a `remote+worker` machine on battery or away is refused unless `--force`; with `--force` the command warns that the swarm stops when that machine sleeps.

## Laptops (remote + worker)

A `remote+worker` machine takes new work only when it is on the charger, its lid is open, and it can reach the brain. Before each pull it checks all three; when any is false it takes no new work and shows `away` in the Watch. Existing work gets a short grace period, then hands back. When the owner is active it drops to one slot; when idle it uses its full slots. `swarm attach` and `swarm screen` reach it through the brain, so they work at home or away over WireGuard.

## Lanes

The worker lane plugins are one config entry each: `claude`, `codex`, `gemini`, `opencode` and `cursor` (`cursor-agent`). Each has its headless command, health check, login hint and rate-limit/logged-out detector. A rate limit or logged-out result cools that lane on that machine and work is not claimed for it until it recovers. The same runner runs on macOS (LaunchAgent in the logged-in user session, so Keychain logins work) and Linux (systemd user service).

## Hand steps that cannot be scripted

- Turn on **Remote Login** and **Screen Sharing** in System Settings -> General -> Sharing (macOS requires Full Disk Access to change these by script).
- Type the target Mac's password once during `ssh-copy-id`.
- Type each lane's own login on that machine (`claude`, `codex login`, `gemini`, `opencode auth login`, `cursor-agent login`, `gh auth login`).
- If FileVault is on, a reboot waits for the password at the keyboard; run `swarm machine doctor` to see it. FileVault is a warning on a `remote+worker` laptop (it is meant to have it on) and on a machine added with `--filevault warn` (for example a full-time worker that deliberately keeps it on; list it in `fileVaultWarn` in the local machine config). It is a failure only on a full-time worker without that policy, where an unattended reboot would wait at the keyboard.
- Keep a full-time worker on the charger with the lid open; a `remote+worker` machine follows the laptop rules above.

## Linux, PS5s and rented GPUs

The same `swarm machine add <user>@<host>` works on Linux: it installs the runner as a systemd user unit and writes the same `~/swarm-worker/lanes.json`. a Linux box is registered this way (`swarm machine add <user>@<host> --name <name>`); the PS5s and Vast.ai GPU hosts join with the same command. GPU work keeps using the existing `rented` lane and `swarm gpu`; the machine registry only adds placement and health.

On a worker below the 20 GB free-disk guard, `swarm machine doctor <name>` reports it and the runner refuses new work until the disk is cleaned. The brain has its own guard: `swarm machine doctor` warns under 50 GB and, under 30 GB, automatically clears regenerable caches and old runner logs (never worktrees).

## Local machine config

Fleet-specific names and defaults stay out of this repo. Copy `config/machines.example.json` to `~/.config/project-swarm/machines.local.json` (outside every checkout; also read: `~/.project-swarm/machines.local.json`, the gitignored `config/machines.local.json`, or a file named by `SWARM_MACHINES_LOCAL`) and set:

- `brainName`: registry name and `~/.ssh/config` alias of the brain (default `brain`).
- `brainHostHint`: part of the brain's hostname, used to name it the first time a worker is added.
- `failoverOrder`: preferred brain failover order.
- `laptops`: machines that default to `remote+worker` (charger + lid rules).
- `fileVaultWarn`: full-time workers where FileVault is a warning.
- `backupWorker`: the worker that receives `swarm fleet backup`.
- `sessionDefaults`: repo name to machine for `swarm session start <repo>`.
- `sessionModels`: repo name to default model for new sessions (`--model` overrides).

Addresses and users are never in this file; they come from `swarm machine add <user>@<host>` and the registry in `~/.project-swarm/machines.json`.

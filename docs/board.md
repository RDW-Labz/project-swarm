# Swarm board

The machine-wide web board is `swarm watch --all`: every registered project on this Mac, read-only, on loopback only.

## Stay-up

Use stay-up when you want one stable bookmark (and the same URL for a phone when `swarm remote` is on) across reboots and idle time:

```bash
swarm watch --all --keep-up
```

Optional fixed port (default **51058**):

```bash
swarm watch --all --keep-up --port 51058
```

Port and token live in `~/.project-swarm/board-identity.json` (directory `0700`, file `0600`). The board does not stop when idle. If the saved port is already taken by another process, the command fails instead of moving to a new port.

### launchd

User LaunchAgent example (replace `ROOT` with any project root that has `swarm` on `PATH`):

```bash
swarm --root ROOT watch --all --keep-up
```

Put that in `ProgramArguments` of `~/Library/LaunchAgents/com.project-swarm.board.plist`, then `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.project-swarm.board.plist`.

#!/bin/bash
# Run this ON the laptop you carry. One-time.
# Lets the laptop reach the Mac mini and every worker, at home or away,
# by going THROUGH the mini (the mini is the front door).
#
#   bash laptop-setup.sh <user>@<mini-ip> <user>@<worker> [<user>@<worker> ...]
#
# Example:
#   bash laptop-setup.sh braden@10.10.10.50 braden@worker-air16 braden@worker-pro
#
# Safe to run again (add more workers any time).

set -uo pipefail

ok()   { printf "\033[32m✔\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
step() { printf "\n\033[1m== %s ==\033[0m\n" "$*"; }

if [[ $# -lt 2 || "$1" != *@* ]]; then
  echo "Usage: bash laptop-setup.sh <user>@<mini-ip> <user>@<worker> [more workers...]"
  exit 1
fi
MINI_USER="${1%@*}"; MINI_ADDR="${1#*@}"; shift

KEY="$HOME/.ssh/swarm_ed25519"
CFG="$HOME/.ssh/config"
mkdir -p "$HOME/.ssh/sockets"; chmod 700 "$HOME/.ssh"
touch "$CFG"; chmod 600 "$CFG"

add_host() {  # add_host <alias> <settings>
  if grep -qE "^Host[[:space:]]+$1\$" "$CFG"; then
    ok "'$1' already in ~/.ssh/config"
  else
    printf "\n# swarm\nHost %s\n%s\n" "$1" "$2" >> "$CFG"
    ok "Added '$1' to ~/.ssh/config"
  fi
}

copy_key() {  # copy_key <alias>  — asks that machine's password once
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$1" true 2>/dev/null; then
    ok "Key already works on $1"; return 0
  fi
  echo "   Enter the password for $1 when asked:"
  ssh-copy-id -i "$KEY.pub" "$1" >/dev/null 2>&1 || \
    ssh "$1" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' < "$KEY.pub"
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$1" true 2>/dev/null; then ok "Key works on $1"; return 0; fi
  warn "Could not log in to $1"; return 1
}

COMMON="  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ControlMaster auto
  ControlPath ~/.ssh/sockets/%r@%h-%p
  ControlPersist 10m"

# ---------------------------------------------------------------------------
step "Check the mini is reachable ($MINI_ADDR)"
if ! nc -z -G 3 "$MINI_ADDR" 22 >/dev/null 2>&1; then
  warn "Can't reach the mini on SSH."
  echo "   • On the mini: System Settings → General → Sharing → turn on Remote Login"
  echo "   • On this laptop: be on home Wi‑Fi, or turn on WireGuard"
  exit 1
fi
ok "Mini is reachable"

# ---------------------------------------------------------------------------
step "Laptop SSH key"
if [[ -f "$KEY" ]]; then ok "Key exists"
else
  ssh-keygen -t ed25519 -N "" -C "laptop@$(scutil --get LocalHostName 2>/dev/null || hostname)" -f "$KEY" >/dev/null
  ok "Made new key"
fi

# ---------------------------------------------------------------------------
step "Mini"
add_host mini "  HostName $MINI_ADDR
  User $MINI_USER
$COMMON"
copy_key mini || exit 1

if ssh mini 'zsh -lc "command -v tmux >/dev/null || brew install tmux"' >/dev/null 2>&1; then
  ok "tmux ready on the mini"
else
  warn "Install tmux on the mini by hand:  brew install tmux"
fi

# ---------------------------------------------------------------------------
FAILED=""
for target in "$@"; do
  if [[ "$target" == *@* ]]; then user="${target%@*}"; host="${target#*@}"
  else user="$MINI_USER"; host="$target"
  fi
  host="${host%.local}"
  step "$host (through the mini)"
  add_host "$host" "  HostName $host.local
  User $user
  ProxyJump mini
$COMMON"
  if copy_key "$host" && ssh -o BatchMode=yes "$host" 'test -f ~/swarm-worker/lanes.json'; then
    ok "$host ready"
  else
    warn "$host not ready (awake? did worker-setup.sh finish?)"
    FAILED="$FAILED $host"
  fi
done

# ---------------------------------------------------------------------------
step "Shortcuts"
if ! grep -q ">>> swarm helpers >>>" "$HOME/.zshrc" 2>/dev/null; then
  cat >> "$HOME/.zshrc" <<'EOF'

# >>> swarm helpers >>>
# Jump into the live orchestrator session on the mini (makes it if missing).
# Leave without stopping it: Ctrl-b then d
swarm-mini() { ssh -t mini 'zsh -lc "tmux new -A -s swarm"'; }

# See a machine's screen from anywhere:  wscreen worker-air16   |   wscreen mini
wscreen() {
  local target="${1:?usage: wscreen <worker-name|mini>}"
  local dest="$target.local"
  [[ "$target" == "mini" ]] && dest="localhost"
  local port=$(( 15900 + RANDOM % 1000 ))
  ssh -fN -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes \
      -L "$port:$dest:5900" mini && open "vnc://localhost:$port"
}
# <<< swarm helpers <<<
EOF
  ok "Added swarm-mini and wscreen (open a new Terminal tab to use them)"
else
  ok "Shortcuts already added"
fi

# ---------------------------------------------------------------------------
step "DONE"
[[ -n "$FAILED" ]] && warn "Not ready:$FAILED"
echo "  swarm-mini            → your orchestrator session on the mini"
echo "  ssh mini              → shell on the mini"
echo "  ssh <worker>          → shell on a worker"
echo "  wscreen <worker>      → see a worker's screen"
echo "  Away from home: turn on WireGuard first."

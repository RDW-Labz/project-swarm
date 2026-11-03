#!/bin/bash
# Run this ON the Mac mini, after worker-setup.sh finished on each worker.
# It links the mini to the workers with a key (no passwords after this).
#
#   bash mini-setup.sh <user>@<worker-name> [<user>@<worker-name> ...]
#
# Example:
#   bash mini-setup.sh braden@worker-air16 braden@worker-pro
#
# Safe to run again (add more workers any time).

set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: bash mini-setup.sh <user>@<worker-name> [more workers...]"
  exit 1
fi

ok()   { printf "\033[32m✔\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
step() { printf "\n\033[1m== %s ==\033[0m\n" "$*"; }

KEY="$HOME/.ssh/swarm_ed25519"
mkdir -p "$HOME/.ssh/sockets" "$HOME/.swarm/workers"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/config"; chmod 600 "$HOME/.ssh/config"

step "Swarm SSH key"
if [[ -f "$KEY" ]]; then ok "Key exists"
else
  ssh-keygen -t ed25519 -N "" -C "swarm@$(scutil --get LocalHostName 2>/dev/null || hostname)" -f "$KEY" >/dev/null
  ok "Made new key"
fi

FAILED=""
for target in "$@"; do
  if [[ "$target" == *@* ]]; then user="${target%@*}"; host="${target#*@}"
  else user="$USER"; host="$target"
  fi
  host="${host%.local}"
  step "$host"

  # 1. Copy the key (asks for that Mac's password once).
  if ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
       "$user@$host.local" true 2>/dev/null; then
    ok "Key already works"
  else
    echo "   Enter $user's password for $host when asked:"
    if ! ssh-copy-id -i "$KEY.pub" -o StrictHostKeyChecking=accept-new "$user@$host.local" >/dev/null 2>&1; then
      ssh -o StrictHostKeyChecking=accept-new "$user@$host.local" \
        'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' \
        < "$KEY.pub"
    fi
  fi

  # 2. Short name + fast reuse of connections (ssh worker-air16 just works).
  if ! grep -qE "^Host[[:space:]]+$host\$" "$HOME/.ssh/config"; then
    cat >> "$HOME/.ssh/config" <<EOF

# swarm worker
Host $host
  HostName $host.local
  User $user
  IdentityFile $KEY
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ControlMaster auto
  ControlPath ~/.ssh/sockets/%r@%h-%p
  ControlPersist 10m
EOF
    ok "Added '$host' to ~/.ssh/config"
  else
    ok "'$host' already in ~/.ssh/config"
  fi

  # 3. Test + pull its lanes file.
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" 'cat ~/swarm-worker/lanes.json' \
       > "$HOME/.swarm/workers/$host.json" 2>/dev/null; then
    ok "Connected. Saved ~/.swarm/workers/$host.json"
    ssh -o BatchMode=yes "$host" '
      for c in claude codex gemini opencode cursor-agent git node gh; do
        if command -v $c >/dev/null 2>&1; then printf "   ✔ %s\n" $c; else printf "   ✘ %s missing\n" $c; fi
      done'
  else
    rm -f "$HOME/.swarm/workers/$host.json"
    warn "Could not reach $host (is it awake, on Wi-Fi, and did worker-setup.sh finish?)"
    FAILED="$FAILED $host"
  fi
done

step "DONE"
echo "  Workers saved in ~/.swarm/workers/"
ls -1 "$HOME/.swarm/workers/" 2>/dev/null | sed 's/^/    /'
if [[ -n "$FAILED" ]]; then
  warn "Not connected:$FAILED"
fi
FIRST="${1#*@}"; FIRST="${FIRST%.local}"
echo
echo "  Try it:   ssh $FIRST 'hostname && uptime'"
echo "  Screen:   open vnc://$FIRST.local"

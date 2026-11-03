#!/bin/bash
# Idempotent worker bootstrap used by `swarm machine add`. Safe to run again.
set -uo pipefail

NAME="${SWARM_MACHINE_NAME:?missing machine name}"
MODE="${SWARM_MACHINE_MODE:-worker}"
BRAIN_HOST="${SWARM_BRAIN_HOST:-}"
BRAIN_USER="${SWARM_BRAIN_USER:-}"

ok() { printf '\033[32mOK\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARN\033[0m %s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }

SUDO=""
if command -v sudo >/dev/null 2>&1; then
  if sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else sudo -v && SUDO="sudo -n"; fi
fi

step "name"
CURRENT_HOST=""
if command -v scutil >/dev/null 2>&1; then CURRENT_HOST="$(scutil --get LocalHostName 2>/dev/null || true)"; else CURRENT_HOST="$(hostname 2>/dev/null || true)"; fi
if [ "$CURRENT_HOST" = "$NAME" ]; then
  ok "name already $NAME"
else
  if [ "$MODE" = "worker" ] && command -v scutil >/dev/null 2>&1; then
    $SUDO scutil --set ComputerName "$NAME" >/dev/null 2>&1 || warn "ComputerName not set"
  fi
  if command -v scutil >/dev/null 2>&1; then
    $SUDO scutil --set LocalHostName "$NAME" >/dev/null 2>&1 || warn "LocalHostName not set"
    $SUDO scutil --set HostName "$NAME" >/dev/null 2>&1 || warn "HostName not set"
  else
    $SUDO hostnamectl set-hostname "$NAME" >/dev/null 2>&1 || warn "hostname not set"
  fi
  ok "$NAME"
fi

step "power"
if command -v pmset >/dev/null 2>&1; then
  CURRENT_POWER="$(pmset -g custom 2>/dev/null || true)"
  if [ "$MODE" = "worker" ]; then
    if printf '%s' "$CURRENT_POWER" | grep -q 'disablesleep *1'; then
      ok "power already set (never sleep)"
    else
      $SUDO pmset -a disablesleep 1 >/dev/null 2>&1 || warn "disablesleep not set"
      $SUDO pmset -c sleep 0 >/dev/null 2>&1 || warn "sleep not set"
      $SUDO pmset -c disksleep 0 >/dev/null 2>&1 || true
      $SUDO pmset -c displaysleep 5 >/dev/null 2>&1 || true
      $SUDO pmset -c powernap 0 >/dev/null 2>&1 || true
      $SUDO pmset -c tcpkeepalive 1 >/dev/null 2>&1 || true
      $SUDO pmset -a lowpowermode 0 >/dev/null 2>&1 || true
      ok "awake on charger, sleep disabled"
    fi
  else
    $SUDO pmset -a disablesleep 0 >/dev/null 2>&1 || true
    $SUDO pmset -c sleep 0 >/dev/null 2>&1 || warn "sleep not set"
    $SUDO pmset -c disksleep 0 >/dev/null 2>&1 || true
    $SUDO pmset -c displaysleep 10 >/dev/null 2>&1 || true
    $SUDO pmset -c tcpkeepalive 1 >/dev/null 2>&1 || true
    ok "awake on charger only"
  fi
fi

step "updates"
if [ "$MODE" = "worker" ] && command -v defaults >/dev/null 2>&1; then
  CURRENT_UPDATE="$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo missing)"
  if [ "$CURRENT_UPDATE" = "0" ]; then
    ok "macOS auto-install already off"
  else
    $SUDO defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false >/dev/null 2>&1 || warn "update setting not changed"
    ok "macOS auto-install off"
  fi
else
  ok "left unchanged"
fi

step "remote access"
if nc -z -G 1 127.0.0.1 22 >/dev/null 2>&1; then ok "Remote Login on"; else warn "remote_login_off: turn on Remote Login by hand"; fi
if nc -z -G 1 127.0.0.1 5900 >/dev/null 2>&1; then ok "Screen Sharing on"; else warn "screen_sharing_off: turn on Screen Sharing by hand"; fi

step "tools"
if [ "$(uname -s)" = "Darwin" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then eval "$("$b" shellenv)"; break; fi; done
  fi
  if ! command -v brew >/dev/null 2>&1; then
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >/dev/null 2>&1 || warn "Homebrew install failed"
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then eval "$("$b" shellenv)"; break; fi; done
  fi
  if command -v brew >/dev/null 2>&1; then
    BREW_PREFIX="$(brew --prefix)"
    for pkg in git node gh jq tmux; do
      if brew list --formula "$pkg" >/dev/null 2>&1; then ok "$pkg"; else brew install "$pkg" >/dev/null 2>&1 && ok "$pkg" || warn "$pkg install failed"; fi
    done
    if ! brew list --cask aldente >/dev/null 2>&1; then brew install --cask aldente >/dev/null 2>&1 && ok "AlDente" || warn "AlDente optional install failed"; else ok "AlDente"; fi
    warn "AlDente: set the charge limit to 80% in the app once"
    PATH_LINE="export PATH=\"$BREW_PREFIX/bin:$BREW_PREFIX/sbin:\$HOME/.local/bin:\$PATH\"  # swarm-worker"
    if ! grep -q "# swarm-worker" "$HOME/.zshenv" 2>/dev/null; then printf '%s\n' "$PATH_LINE" >> "$HOME/.zshenv"; fi
    export PATH="$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$HOME/.local/bin:$PATH"
    ok "PATH in ~/.zshenv"
  fi
else
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    for pkg in git curl jq tmux gh nodejs npm; do
      if command -v "$pkg" >/dev/null 2>&1; then ok "$pkg"; else $SUDO apt-get install -y -qq "$pkg" >/dev/null 2>&1 && ok "$pkg" || warn "$pkg install failed"; fi
    done
  else
    warn "apt-get not found; install git, node, jq, tmux by hand"
  fi
fi

step "lanes"
npm_cli() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1"; else
    if command -v npm >/dev/null 2>&1; then npm install -g "$2" >/dev/null 2>&1 && ok "$1" || warn "$1 install failed"; else warn "$1 missing and npm not found"; fi
  fi
}
npm_cli claude @anthropic-ai/claude-code
npm_cli codex @openai/codex
npm_cli gemini @google/gemini-cli
npm_cli opencode opencode-ai
if command -v cursor-agent >/dev/null 2>&1; then ok "cursor-agent"; else
  if command -v curl >/dev/null 2>&1; then curl -fsS https://cursor.com/install | bash >/dev/null 2>&1 && ok "cursor-agent" || warn "cursor-agent install failed"; else warn "cursor-agent missing and curl not found"; fi
fi

step "worker folders"
mkdir -p "$HOME/swarm-worker/repos" "$HOME/swarm-worker/worktrees" "$HOME/swarm-worker/logs"
ok "$HOME/swarm-worker"

if [ "$(uname -s)" = "Darwin" ]; then
  RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
  CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)
else
  RAM_GB=$(( $(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1048576 ))
  CORES=$(nproc 2>/dev/null || echo 1)
  CHIP=$(uname -m)
fi
if [ "$RAM_GB" -ge 16 ]; then SLOTS=4; elif [ "$RAM_GB" -ge 8 ]; then SLOTS=2; else SLOTS=1; fi
if [ "$MODE" = "both" ]; then ROLE="remote+worker"; else ROLE="worker"; fi
LANES=""
for c in claude codex gemini opencode cursor-agent; do
  if command -v "$c" >/dev/null 2>&1; then
    if [ "$c" = "cursor-agent" ]; then LANES="$LANES,\"cursor\""; else LANES="$LANES,\"$c\""; fi
  fi
done
LANES="[${LANES#,}]"
if [ ! -f "$HOME/swarm-worker/lanes.json" ]; then
  printf '{\n  "name": "%s",\n  "host": "%s.local",\n  "user": "%s",\n  "os": "%s",\n  "role": "%s",\n  "chip": "%s",\n  "cores": %s,\n  "ram_gb": %s,\n  "slots": %s,\n  "lanes_installed": %s,\n  "home": "%s/swarm-worker",\n  "updated": "%s"\n}\n' \
    "$NAME" "$NAME" "$USER" "$( [ "$(uname -s)" = Darwin ] && echo macos || echo linux )" "$ROLE" "$CHIP" "$CORES" "$RAM_GB" "$SLOTS" "$LANES" "$HOME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME/swarm-worker/lanes.json"
  ok "wrote lanes.json"
else
  ok "lanes.json already exists"
fi

step "brain pointer"
if [ -n "$BRAIN_HOST" ] && [ -n "$BRAIN_USER" ]; then
  mkdir -p "$HOME/.project-swarm"
  printf '{"host":"%s","user":"%s"}\n' "$BRAIN_HOST" "$BRAIN_USER" > "$HOME/.project-swarm/brain.json"
  chmod 600 "$HOME/.project-swarm/brain.json" 2>/dev/null || true
  ok "brain pointer -> $BRAIN_USER@$BRAIN_HOST"
fi

step "filevault"
if command -v fdesetup >/dev/null 2>&1; then
  if fdesetup status 2>/dev/null | grep -q "FileVault is On"; then warn "filevault_on: a reboot needs the password typed at the machine"; else ok "FileVault off"; fi
fi

step "done"
printf 'MACHINE_SETUP_OK name=%s slots=%s lanes=%s\n' "$NAME" "$SLOTS" "$LANES"

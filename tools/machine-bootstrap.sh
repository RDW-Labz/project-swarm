#!/bin/bash
# Idempotent worker bootstrap used by `swarm machine add`. Safe to run again.
set -uo pipefail

# Apple silicon uses /opt/homebrew; Intel Macs use /usr/local. Put both first so a
# non-interactive SSH shell finds brew, npm, node and every lane CLI on either kind.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
NAME="${SWARM_MACHINE_NAME:?missing machine name}"
MODE="${SWARM_MACHINE_MODE:-worker}"
BRAIN_HOST="${SWARM_BRAIN_HOST:-}"
BRAIN_USER="${SWARM_BRAIN_USER:-}"
MACHINE_HOST="${SWARM_MACHINE_HOST:-$NAME.local}"
CAPABILITIES="${SWARM_MACHINE_CAPABILITIES:-}"

ok() { printf '\033[32mOK\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARN\033[0m %s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }

SUDO=""
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; fi
need_sudo() {
  if [ -z "$SUDO" ]; then
    warn "$1 needs sudo by hand; skipped. Run at the machine: $2"
    return 1
  fi
  return 0
}

step "name"
CURRENT_HOST=""
if command -v scutil >/dev/null 2>&1; then CURRENT_HOST="$(scutil --get LocalHostName 2>/dev/null || true)"; else CURRENT_HOST="$(hostname 2>/dev/null || true)"; fi
if [ "$CURRENT_HOST" = "$NAME" ]; then
  ok "name already $NAME"
else
  if need_sudo "set the machine name" "sudo scutil --set ComputerName \"$NAME\"; sudo scutil --set LocalHostName \"$NAME\"; sudo scutil --set HostName \"$NAME\""; then
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
fi

step "power"
if command -v pmset >/dev/null 2>&1; then
  CURRENT_POWER="$(pmset -g custom 2>/dev/null || true)"
  SLEEP_DISABLED="$(pmset -g 2>/dev/null | sed -n 's/.*SleepDisabled[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
  if [ -z "$SLEEP_DISABLED" ]; then SLEEP_DISABLED="$(printf '%s' "$CURRENT_POWER" | sed -n 's/.*disablesleep *\([0-9]*\).*/\1/p' | head -1)"; fi
  AC_SLEEP=$(printf '%s' "$CURRENT_POWER" | awk '/^AC Power:/{ac=1;next}/^Battery Power:/{ac=0} ac&&/^ *sleep /{print $2; exit}')
  AC_DISKSLEEP=$(printf '%s' "$CURRENT_POWER" | awk '/^AC Power:/{ac=1;next}/^Battery Power:/{ac=0} ac&&/^ *disksleep /{print $2; exit}')
  if [ "$MODE" = "worker" ]; then
    if [ "$SLEEP_DISABLED" = "1" ] && [ "${AC_SLEEP:-1}" = "0" ] && [ "${AC_DISKSLEEP:-1}" = "0" ]; then
      ok "power already set (never sleep)"
    elif need_sudo "set worker power settings" "sudo pmset -a disablesleep 1; sudo pmset -c sleep 0; sudo pmset -c disksleep 0; sudo pmset -c displaysleep 5; sudo pmset -c powernap 0; sudo pmset -c tcpkeepalive 1; sudo pmset -a lowpowermode 0"; then
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
    if [ "${AC_SLEEP:-1}" = "0" ] && [ "${AC_DISKSLEEP:-1}" = "0" ]; then
      ok "power already set (awake on charger only)"
    elif need_sudo "set laptop power settings" "sudo pmset -a disablesleep 0; sudo pmset -c sleep 0; sudo pmset -c disksleep 0; sudo pmset -c displaysleep 10; sudo pmset -c tcpkeepalive 1"; then
      $SUDO pmset -a disablesleep 0 >/dev/null 2>&1 || true
      $SUDO pmset -c sleep 0 >/dev/null 2>&1 || warn "sleep not set"
      $SUDO pmset -c disksleep 0 >/dev/null 2>&1 || true
      $SUDO pmset -c displaysleep 10 >/dev/null 2>&1 || true
      $SUDO pmset -c tcpkeepalive 1 >/dev/null 2>&1 || true
      ok "awake on charger only"
    fi
  fi
fi

step "updates"
if [ "$MODE" = "worker" ] && command -v defaults >/dev/null 2>&1; then
  CURRENT_UPDATE="$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo missing)"
  if [ "$CURRENT_UPDATE" = "0" ]; then
    ok "macOS auto-install already off"
  elif need_sudo "turn off macOS auto-install" "sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false"; then
    $SUDO defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false >/dev/null 2>&1 || warn "update setting not changed"
    ok "macOS auto-install off"
  fi
else
  ok "left unchanged"
fi

step "remote access"
if nc -z -G 1 127.0.0.1 22 >/dev/null 2>&1; then ok "Remote Login on"; else warn "remote_login_off: turn on Remote Login by hand"; fi
if nc -z -G 1 127.0.0.1 5900 >/dev/null 2>&1; then ok "Screen Sharing on"; else warn "screen_sharing_off: turn on Screen Sharing by hand"; fi

# Official x86_64 Node into ~/.local/node; no sudo, no Homebrew.
install_node_intel() {
  if [ -x "$HOME/.local/node/bin/node" ]; then export PATH="$HOME/.local/node/bin:$PATH"; return 0; fi
  if ! command -v curl >/dev/null 2>&1; then warn "curl missing; cannot install Node"; return 1; fi
  BASE="https://nodejs.org/dist/latest-v22.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt" 2>/dev/null)" || { warn "Node download index failed"; return 1; }
  FILE="$(printf '%s\n' "$SUMS" | awk '/darwin-x64\.tar\.gz$/{print $2; exit}')"
  if [ -z "$FILE" ]; then warn "no darwin-x64 Node build found"; return 1; fi
  mkdir -p "$HOME/.local"
  TMP="$HOME/.local/.$FILE"
  if ! curl -fsSL "$BASE/$FILE" -o "$TMP"; then warn "Node download failed"; rm -f "$TMP"; return 1; fi
  EXPECTED="$(printf '%s\n' "$SUMS" | awk -v f="$FILE" '$2 == f { print $1; exit }')"
  GOT="$(shasum -a 256 "$TMP" 2>/dev/null | awk '{print $1}')"
  if [ -z "$EXPECTED" ] || [ "$GOT" != "$EXPECTED" ]; then
    warn "Node checksum check failed"; rm -f "$TMP"; return 1
  fi
  rm -rf "$HOME/.local/node.tmp"
  mkdir -p "$HOME/.local/node.tmp"
  if ! tar -xzf "$TMP" -C "$HOME/.local/node.tmp" --strip-components=1; then
    warn "Node archive could not be extracted"; rm -f "$TMP"; rm -rf "$HOME/.local/node.tmp"; return 1
  fi
  rm -rf "$HOME/.local/node"
  mv "$HOME/.local/node.tmp" "$HOME/.local/node"
  rm -f "$TMP"
  export PATH="$HOME/.local/node/bin:$PATH"
  ok "Node $(node -v 2>/dev/null) installed under ~/.local/node"
}

step "tools"
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
if [ "$OS_NAME" = "Darwin" ]; then
  # Homebrew is optional here: Apple silicon can install it; Intel Macs have no supported Homebrew.
  if ! command -v brew >/dev/null 2>&1; then
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then eval "$("$b" shellenv)"; break; fi; done
  fi
  if ! command -v brew >/dev/null 2>&1 && [ "$ARCH_NAME" != "x86_64" ]; then
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >/dev/null 2>&1 || warn "Homebrew install failed"
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then eval "$("$b" shellenv)"; break; fi; done
  fi
  if command -v brew >/dev/null 2>&1; then
    BREW_PREFIX="$(brew --prefix)"
    for pkg in git node gh jq tmux; do
      if brew list --formula "$pkg" >/dev/null 2>&1; then ok "$pkg"; else brew install "$pkg" >/dev/null 2>&1 && ok "$pkg" || warn "$pkg install failed"; fi
    done
    if [ -f "$HOME/swarm-worker/aldente-confirmed" ]; then ok "AlDente charge limit confirmed"; elif brew list --cask aldente >/dev/null 2>&1; then ok "AlDente"; warn "AlDente: set the charge limit to 80% in the app once, then create ~/swarm-worker/aldente-confirmed"; else warn "AlDente not installed (optional); install it by hand and set 80%"; fi
    PATH_LINE="export PATH=\"$BREW_PREFIX/bin:$BREW_PREFIX/sbin:\$HOME/.local/node/bin:\$HOME/.local/bin:\$PATH\"  # swarm-worker"
  else
    # Intel Mac without Homebrew. Use what macOS and Xcode provide, and a user-owned Node build.
    warn "Homebrew not found on this Intel Mac; using Xcode git, Node x64 under ~/.local and /usr/bin/jq"
    if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
      ok "git $(git --version 2>/dev/null | awk '{print $3}')"
    else
      warn "git missing or Xcode license not accepted; run at the machine: xcode-select --install (or sudo xcodebuild -license accept)"
    fi
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      install_node_intel || true
    fi
    if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
      ok "node $(node -v 2>/dev/null) at $(command -v node)"
    else
      warn "node not installed; lane CLIs that need npm will be skipped"
    fi
    if [ -x /usr/bin/jq ] || command -v jq >/dev/null 2>&1; then
      ok "jq $(/usr/bin/jq --version 2>/dev/null || jq --version 2>/dev/null || true)"
    else
      warn "jq missing: /usr/bin/jq not found and this Intel Mac has no Homebrew"
    fi
    ok "gh skipped on this worker (repos clone from the brain mirrors)"
    ok "tmux skipped on this worker (repos clone from the brain mirrors)"
    PATH_LINE="export PATH=\"\$HOME/.local/node/bin:\$HOME/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:\$PATH\"  # swarm-worker"
  fi
  if ! grep -q "# swarm-worker" "$HOME/.zshenv" 2>/dev/null; then
    printf '%s\n' "$PATH_LINE" >> "$HOME/.zshenv"
  else
    grep -v "# swarm-worker" "$HOME/.zshenv" > "$HOME/.zshenv.tmp-swarm" 2>/dev/null || true
    printf '%s\n' "$PATH_LINE" >> "$HOME/.zshenv.tmp-swarm"
    mv "$HOME/.zshenv.tmp-swarm" "$HOME/.zshenv"
  fi
  eval "$PATH_LINE" 2>/dev/null || true
  ok "PATH in ~/.zshenv"
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
mkdir -p "$HOME/swarm-worker"
LANES_OK_FILE="$HOME/swarm-worker/.lanes-ok"
: > "$LANES_OK_FILE"
npm_cli() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1 already installed"; else
    if command -v npm >/dev/null 2>&1; then npm install -g "$2" >/dev/null 2>&1 && ok "$1 installed" || warn "$1 install failed"; else warn "$1 skipped: npm not found"; fi
  fi
}
npm_cli claude @anthropic-ai/claude-code
npm_cli codex @openai/codex
npm_cli gemini @google/gemini-cli
npm_cli opencode opencode-ai
if command -v cursor-agent >/dev/null 2>&1; then ok "cursor-agent already installed"; else
  if command -v curl >/dev/null 2>&1; then curl -fsS https://cursor.com/install | bash >/dev/null 2>&1 && ok "cursor-agent installed" || warn "cursor-agent install failed"; else warn "cursor-agent skipped: curl not found"; fi
fi
# Only skip a lane that truly cannot run here. On Apple silicon an installed CLI is a working lane;
# a one-shot --version can fail over SSH for keychain/TTY reasons and must not hide it. On Intel,
# reject an arm64-only binary or one that still cannot start after a clean-env retry.
lane_runnable() {
  c="$1"
  command -v "$c" >/dev/null 2>&1 || { echo "$c is not installed"; return 2; }
  p="$(command -v "$c" 2>/dev/null || true)"
  if [ "$ARCH_NAME" = "x86_64" ]; then
    ft="$(file -b "$p" 2>/dev/null || true)"
    case "$ft" in
      *Mach-O*arm64*) case "$ft" in *x86_64*) ;; *) echo "$c is arm64-only"; return 3;; esac ;;
    esac
    "$c" --version >/dev/null 2>&1 && return 0
    env -i HOME="$HOME" PATH="$PATH" TERM=dumb "$c" --version >/dev/null 2>&1 && return 0
    echo "$c does not start on this Intel Mac"
    return 4
  fi
  return 0
}
for c in claude codex gemini opencode cursor-agent; do
  if reason="$(lane_runnable "$c")"; then
    ok "$c runs on this Mac"
    printf '%s\n' "$c" >> "$LANES_OK_FILE"
  else
    warn "lane_skipped $c ($reason)"
  fi
done

step "swarm CLI"
if [ -f "$HOME/.project-swarm/current/tools/swarm.mjs" ]; then
  mkdir -p "$HOME/.local/bin"
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -n "$NODE_BIN" ]; then
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$HOME/.project-swarm/current/tools/swarm.mjs" > "$HOME/.local/bin/swarm"
    chmod +x "$HOME/.local/bin/swarm"
    ok "swarm CLI at ~/.local/bin/swarm"
  else
    warn "node not found; swarm CLI not installed"
  fi
else
  warn "runner not present at ~/.project-swarm/current; swarm CLI not installed"
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
# machine add passes --slots for a machine the owner has measured (for example a hot 2019 i9).
if [ -n "${SWARM_MACHINE_SLOTS:-}" ]; then SLOTS="$SWARM_MACHINE_SLOTS"; fi
ARCH="$(uname -m)"
if [ "$MODE" = "both" ]; then ROLE="remote+worker"; else ROLE="worker"; fi
LANES=""
for c in claude codex gemini opencode cursor-agent; do
  if [ -f "$LANES_OK_FILE" ] && grep -qx "$c" "$LANES_OK_FILE"; then
    if [ "$c" = "cursor-agent" ]; then LANES="$LANES,\"cursor\""; else LANES="$LANES,\"$c\""; fi
  fi
done
LANES="[${LANES#,}]"
# Rewrite when machine add supplied measured values; otherwise leave an existing file alone.
CAPS=""
for c in $(printf '%s' "$CAPABILITIES" | tr ',' ' '); do CAPS="$CAPS,\"$c\""; done
CAPS="[${CAPS#,}]"
if [ ! -f "$HOME/swarm-worker/lanes.json" ] || [ -n "${SWARM_MACHINE_SLOTS:-}" ] || [ -n "${SWARM_MACHINE_CAPABILITIES:-}" ] || [ "${SWARM_MACHINE_UPDATE:-}" = "1" ]; then
  printf '{\n  "name": "%s",\n  "host": "%s",\n  "user": "%s",\n  "os": "%s",\n  "arch": "%s",\n  "role": "%s",\n  "chip": "%s",\n  "cores": %s,\n  "ram_gb": %s,\n  "slots": %s,\n  "lanes_installed": %s,\n  "capabilities": %s,\n  "home": "%s/swarm-worker",\n  "updated": "%s"\n}\n' \
    "$NAME" "$MACHINE_HOST" "$USER" "$( [ "$(uname -s)" = Darwin ] && echo macos || echo linux )" "$ARCH" "$ROLE" "$CHIP" "$CORES" "$RAM_GB" "$SLOTS" "$LANES" "$CAPS" "$HOME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME/swarm-worker/lanes.json"
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

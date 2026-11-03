#!/bin/bash
# Swarm worker setup — run this ON each MacBook you want as a worker.
#
#   bash worker-setup.sh <worker-name> [--both]
#
# Examples:
#   bash worker-setup.sh worker-air16          # full-time worker, stays by the mini
#   bash worker-setup.sh ghost --both          # laptop you carry that ALSO works when plugged in at home
#
# --both: only stays awake on the charger with the lid open. Sleeps normally
#         on battery / lid closed (safe in a bag). Leaves macOS updates alone.
#
# Safe to run again. It skips anything already done.

set -uo pipefail

NAME="${1:-}"
MODE="worker"
[[ "${2:-}" == "--both" ]] && MODE="both"
if [[ -z "$NAME" ]]; then
  echo "Usage: bash worker-setup.sh <worker-name> [--both]   (example: worker-air16)"
  exit 1
fi
if [[ ! "$NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "Name must be lowercase letters, numbers and dashes only."
  exit 1
fi
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Run this on a Mac."
  exit 1
fi

ok()   { printf "\033[32m✔\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
step() { printf "\n\033[1m== %s ==\033[0m\n" "$*"; }

step "Admin password (asked once)"
sudo -v || exit 1
# Keep sudo alive until the script ends.
( while true; do sudo -n true; sleep 50; done ) 2>/dev/null &
KEEPALIVE_PID=$!
trap 'kill "$KEEPALIVE_PID" 2>/dev/null' EXIT

# ---------------------------------------------------------------------------
step "1. Name this Mac: $NAME"
[[ "$MODE" == "worker" ]] && sudo scutil --set ComputerName "$NAME"   # --both keeps your display name
sudo scutil --set LocalHostName "$NAME"
sudo scutil --set HostName      "$NAME"
ok "This Mac is now reachable as $NAME.local"

# ---------------------------------------------------------------------------
if [[ "$MODE" == "worker" ]]; then
  step "2. Never sleep"
  sudo pmset -a disablesleep 1          || warn "disablesleep not set"
  sudo pmset -c sleep 0                 || warn "sleep not set"
  sudo pmset -c disksleep 0             || true
  sudo pmset -c displaysleep 5          || true   # screen can turn off, Mac stays awake
  sudo pmset -c powernap 0              || true
  sudo pmset -c tcpkeepalive 1          || true
  sudo pmset -a lowpowermode 0 2>/dev/null || true
  ok "Sleep is off (keep it plugged in, lid open for airflow)"
else
  step "2. Stay awake on charger only"
  sudo pmset -a disablesleep 0          || true   # lid closed = sleeps (safe in a bag)
  sudo pmset -c sleep 0                 || warn "sleep not set"
  sudo pmset -c disksleep 0             || true
  sudo pmset -c displaysleep 10         || true
  sudo pmset -c tcpkeepalive 1          || true
  ok "Awake when plugged in with lid open. Normal sleep on battery or lid closed."
fi

# ---------------------------------------------------------------------------
if [[ "$MODE" == "worker" ]]; then
  step "3. Stop surprise reboots from macOS updates"
  sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
  ok "macOS updates won't auto-install (do them by hand when you're here)"
else
  step "3. macOS updates"
  ok "Left on (this is your daily laptop)"
fi

# ---------------------------------------------------------------------------
step "4. Remote Login (SSH) + Screen Sharing"
ssh_on()    { nc -z -G 2 127.0.0.1 22   >/dev/null 2>&1; }
screen_on() { nc -z -G 2 127.0.0.1 5900 >/dev/null 2>&1; }

ssh_on || sudo systemsetup -setremotelogin on >/dev/null 2>&1 || true

if ssh_on && screen_on; then
  ok "Remote Login and Screen Sharing are on"
else
  warn "macOS wants you to flip these by hand."
  open "x-apple.systempreferences:com.apple.Sharing-Settings.extension" 2>/dev/null \
    || open "/System/Library/PreferencePanes/SharingPref.prefPane"
  echo "   In the Sharing window that just opened, turn ON:"
  ssh_on    || echo "     • Remote Login"
  screen_on || echo "     • Screen Sharing"
  read -r -p "   Press Enter when done... " _
  ssh_on    && ok "Remote Login on"    || warn "Remote Login still off — turn it on before using this worker"
  screen_on && ok "Screen Sharing on"  || warn "Screen Sharing still off (optional, but handy)"
fi

# ---------------------------------------------------------------------------
step "5. Homebrew"
load_brew() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$b" ]]; then eval "$("$b" shellenv)"; return 0; fi
  done
  return 1
}
if ! load_brew; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew || { warn "Homebrew install failed. Fix that, then run this script again."; exit 1; }
fi
BREW_PREFIX="$(brew --prefix)"
ok "Homebrew at $BREW_PREFIX"

# Commands sent over SSH (ssh worker 'codex ...') only read ~/.zshenv,
# so put the tool paths there or the CLIs won't be found.
PATH_LINE="export PATH=\"$BREW_PREFIX/bin:$BREW_PREFIX/sbin:\$HOME/.local/bin:\$PATH\"  # swarm-worker"
if ! grep -q "# swarm-worker" "$HOME/.zshenv" 2>/dev/null; then
  echo "$PATH_LINE" >> "$HOME/.zshenv"
fi
export PATH="$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$HOME/.local/bin:$PATH"
ok "Tool paths work over SSH"

# ---------------------------------------------------------------------------
step "6. Basic tools"
for pkg in git node gh jq tmux; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then ok "$pkg"
  else brew install "$pkg" && ok "$pkg" || warn "$pkg failed"
  fi
done
if ! brew list --cask aldente >/dev/null 2>&1; then
  brew install --cask aldente && ok "AlDente (battery limit app)" || warn "AlDente failed (optional)"
else
  ok "AlDente"
fi

# ---------------------------------------------------------------------------
step "7. Agent CLIs"
npm_cli() {  # npm_cli <command> <npm-package>
  if command -v "$1" >/dev/null 2>&1; then ok "$1 already installed"
  else npm install -g "$2" >/dev/null 2>&1 && ok "$1" || warn "$1 failed ($2)"
  fi
}
npm_cli claude   @anthropic-ai/claude-code
npm_cli codex    @openai/codex
npm_cli gemini   @google/gemini-cli
npm_cli opencode opencode-ai
if command -v cursor-agent >/dev/null 2>&1; then ok "cursor-agent already installed"
else curl -fsS https://cursor.com/install | bash >/dev/null 2>&1 && ok "cursor-agent" || warn "cursor-agent failed"
fi

# ---------------------------------------------------------------------------
step "8. Worker folder + lanes file"
mkdir -p "$HOME/swarm-worker/"{repos,worktrees,logs}

RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
CORES=$(sysctl -n hw.ncpu)
CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)
if   (( RAM_GB >= 16 )); then SLOTS=4
elif (( RAM_GB >= 8  )); then SLOTS=2
else SLOTS=1
fi

LANES=()
command -v claude       >/dev/null 2>&1 && LANES+=("claude")
command -v codex        >/dev/null 2>&1 && LANES+=("codex")
command -v gemini       >/dev/null 2>&1 && LANES+=("gemini")
command -v opencode     >/dev/null 2>&1 && LANES+=("opencode")
command -v cursor-agent >/dev/null 2>&1 && LANES+=("cursor")
# (Safe on macOS's old bash 3.2 even when no lanes were found.)
LANES_JSON="["
LANES_TEXT=""
for l in ${LANES[@]+"${LANES[@]}"}; do LANES_JSON+="\"$l\","; LANES_TEXT+="$l "; done
LANES_JSON="${LANES_JSON%,}]"

cat > "$HOME/swarm-worker/lanes.json" <<EOF
{
  "name": "$NAME",
  "host": "$NAME.local",
  "user": "$USER",
  "os": "macos",
  "role": "$( [[ "$MODE" == "both" ]] && echo "remote+worker" || echo "worker" )",
  "works_only_when": "$( [[ "$MODE" == "both" ]] && echo "on charger + home network" || echo "always" )",
  "chip": "$CHIP",
  "cores": $CORES,
  "ram_gb": $RAM_GB,
  "slots": $SLOTS,
  "lanes_installed": $LANES_JSON,
  "home": "$HOME/swarm-worker",
  "updated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
ok "Wrote ~/swarm-worker/lanes.json ($SLOTS job slots, ${RAM_GB}GB RAM)"

# ---------------------------------------------------------------------------
step "9. FileVault check"
if fdesetup status 2>/dev/null | grep -q "On"; then
  warn "FileVault is ON. After any reboot, this Mac waits for your password at the keyboard."
  warn "SSH won't work until you log in once. (Updates are off, so reboots should be rare.)"
else
  ok "FileVault is off"
fi

# ---------------------------------------------------------------------------
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")
step "DONE"
echo "  Name:   $NAME.local"
echo "  IP:     $IP"
echo "  User:   $USER"
echo "  RAM:    ${RAM_GB}GB  →  $SLOTS job slots"
echo "  Lanes:  ${LANES_TEXT:-none}"
echo
echo "  Next: log in to each CLI (claude, codex login, gemini, opencode auth login,"
echo "        cursor-agent login, gh auth login)."
echo "  Then on the Mac mini, once the swarm harness is built:"
echo "    swarm machine add $USER@$NAME"

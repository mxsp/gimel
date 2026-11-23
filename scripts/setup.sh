#!/usr/bin/env bash
# Gimel One-Time Setup Script (Linux / macOS)
#
# Sets up Python venv, installs Gimel, builds all frontend SPAs (Portal, Twin,
# Studio, Agent Lab), initializes Playground & Production localnet data dirs,
# and optionally creates the first Production admin account (username + password).
#
# Usage:
#   ./scripts/setup.sh
#   ./scripts/setup.sh --mode production --admin-user admin --admin-password "MyStrongPassword"
#   ./scripts/setup.sh --mode playground --non-interactive

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=""
ADMIN_USER=""
ADMIN_PASSWORD=""
NON_INTERACTIVE=0
SKIP_WEB=0
SKIP_DOCKER=0
WITH_PIPER=0
PIPER_VOICE="de_DE-thorsten-medium"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --skip-web) SKIP_WEB=1; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --with-piper) WITH_PIPER=1; shift ;;
    --piper-voice) PIPER_VOICE="${2:-de_DE-thorsten-medium}"; WITH_PIPER=1; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

echo "================================================================"
echo "  Gimel — One-Time Setup (Localnet · Playground + Production)"
echo "================================================================"

run_priv() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null || [[ "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; }; then
    sudo "$@"
  else
    return 126
  fi
}

python_ok() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

install_python() {
  echo "[0/4] Python 3.11+ (or venv/pip) missing — attempting automatic installation..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew install python@3.12 || true
      export PATH="/opt/homebrew/opt/python@3.12/bin:/usr/local/opt/python@3.12/bin:$PATH"
    else
      echo "Note: Homebrew not found. Install Python 3.12+ from https://www.python.org/downloads/ or install Homebrew." >&2
    fi
    return
  fi

  local rc=0
  if command -v apt-get >/dev/null 2>&1; then
    run_priv apt-get update -qq && run_priv apt-get install -y python3 python3-venv python3-pip || rc=$?
  elif command -v dnf >/dev/null 2>&1; then
    run_priv dnf install -y python3 python3-pip || rc=$?
  elif command -v yum >/dev/null 2>&1; then
    run_priv yum install -y python3 python3-pip || rc=$?
  elif command -v pacman >/dev/null 2>&1; then
    run_priv pacman -Sy --noconfirm python python-pip || rc=$?
  elif command -v zypper >/dev/null 2>&1; then
    run_priv zypper --non-interactive install python3 python3-pip || rc=$?
  else
    echo "Note: No supported package manager found for automatic Python installation." >&2
    return
  fi

  if [[ "$rc" -eq 126 ]]; then
    echo "Action needed: Run as root or with sudo to install Python 3.11+ (e.g. sudo apt-get install -y python3 python3-venv python3-pip)." >&2
  fi
}

install_docker() {
  echo "[0/4] Docker not found — attempting automatic installation..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew install --cask docker || echo "Note: Could not install Docker Desktop via brew (continuing without Docker)." >&2
    else
      echo "Note: Homebrew not found. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ (optional)." >&2
    fi
    return
  fi

  local rc=0
  if command -v curl >/dev/null 2>&1; then
    if run_priv sh -c 'curl -fsSL https://get.docker.com | sh'; then
      rc=0
    else
      rc=$?
    fi
  else
    rc=1
  fi

  if [[ "$rc" -eq 126 ]]; then
    echo "Action needed (optional): Docker requires root/sudo to install. Run 'curl -fsSL https://get.docker.com | sudo sh' later to enable Docker." >&2
    return
  fi

  if [[ "$rc" -ne 0 ]]; then
    if command -v apt-get >/dev/null 2>&1; then
      run_priv apt-get update -qq && run_priv apt-get install -y docker.io docker-compose-plugin || rc=$?
    elif command -v dnf >/dev/null 2>&1; then
      run_priv dnf install -y docker || rc=$?
    elif command -v yum >/dev/null 2>&1; then
      run_priv yum install -y docker || rc=$?
    elif command -v pacman >/dev/null 2>&1; then
      run_priv pacman -Sy --noconfirm docker docker-compose || rc=$?
    elif command -v zypper >/dev/null 2>&1; then
      run_priv zypper --non-interactive install docker || rc=$?
    fi
  fi

  if [[ "$rc" -eq 126 ]]; then
    echo "Action needed (optional): Docker requires root/sudo to install. Continuing Gimel setup without Docker." >&2
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      run_priv systemctl enable --now docker || true
    fi
    local target_user="${SUDO_USER:-${USER:-$(id -un)}}"
    if [[ -n "$target_user" && "$target_user" != "root" ]] && getent group docker >/dev/null 2>&1; then
      run_priv usermod -aG docker "$target_user" || true
      echo "Added '$target_user' to 'docker' group (re-login may be required)."
    fi
  else
    echo "Note: Docker could not be installed automatically (possibly offline). Continuing Gimel setup." >&2
  fi
}

if ! python_ok; then
  install_python
fi
python_ok || { echo "Error: python3 (3.11+) with venv and pip/ensurepip is required." >&2; exit 1; }

if [[ "$SKIP_DOCKER" -eq 0 ]] && ! command -v docker >/dev/null 2>&1; then
  install_docker
fi
if [[ "$SKIP_WEB" -eq 0 ]]; then
  command -v node >/dev/null 2>&1 || { echo "Error: Node.js 20+ is required (or pass --skip-web)." >&2; exit 1; }
  command -v npm >/dev/null 2>&1 || { echo "Error: npm is required." >&2; exit 1; }
fi

cd "$ROOT"

echo "[1/4] Setting up Python virtual environment (.venv)..."
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip --quiet
.venv/bin/pip install -e . --quiet

if [[ "$SKIP_WEB" -eq 0 ]]; then
  echo "[2/4] Building Portal (/app), Twin (/twin), Studio (/studio), and Agent Lab (/lab)..."
  (cd web && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build)
  if [[ -f "agentlab/web/package.json" ]]; then
    (cd agentlab/web && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build)
  fi
else
  echo "[2/4] Skipping frontend build (--skip-web)."
fi

echo "[3/4] Initializing localnet Playground sandbox..."
.venv/bin/gimel setup --mode playground

if [[ -z "$MODE" ]]; then
  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    MODE="both"
  else
    echo ""
    echo "Configure Production admin account now? (You can also create it in the browser on first visit.)"
    read -r -p "Admin username (leave empty to skip): " ADMIN_USER || true
    if [[ -n "$ADMIN_USER" ]]; then
      read -r -s -p "Admin password (min. 8 chars): " ADMIN_PASSWORD || true
      echo ""
    fi
    MODE="both"
  fi
fi

if [[ "$MODE" == "production" || "$MODE" == "both" ]]; then
  echo "[4/4] Initializing localnet Production environment..."
  if [[ -n "$ADMIN_USER" && -n "$ADMIN_PASSWORD" ]]; then
    .venv/bin/gimel setup --mode production --admin-user "$ADMIN_USER" --admin-password "$ADMIN_PASSWORD"
  else
    .venv/bin/gimel setup --mode production
  fi
else
  echo "[4/4] Playground-only setup complete."
fi

if [[ "$WITH_PIPER" -eq 0 && "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; then
  echo ""
  read -r -p "Optional (Opt-In): Install local Piper TTS voice (GPL-3.0, ${PIPER_VOICE})? [y/N]: " ANS || true
  if [[ "${ANS,,}" == "y" || "${ANS,,}" == "yes" || "${ANS,,}" == "j" || "${ANS,,}" == "ja" ]]; then
    WITH_PIPER=1
  fi
fi

if [[ "$WITH_PIPER" -eq 1 ]]; then
  echo "[Opt-In] Installing local Piper TTS (GPL-3.0) + voice ${PIPER_VOICE}..."
  .venv/bin/gimel piper-install --voice "$PIPER_VOICE" --accept-gpl
fi

echo ""
echo "Setup complete! Start Gimel with:"
echo "  Playground (Demo, :8040):      .venv/bin/gimel playground"
echo "  Production (Clean, :8041):     .venv/bin/gimel production"
echo "  Both side by side:             .venv/bin/python -m gimel.launcher --mode both"
echo "  Manage accounts:               .venv/bin/gimel accounts list"
echo "  Check for GitHub updates:      .venv/bin/gimel update --check"

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --skip-web) SKIP_WEB=1; shift ;;
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

command -v python3 >/dev/null 2>&1 || { echo "Error: python3 (3.11+) is required." >&2; exit 1; }
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

echo ""
echo "Setup complete! Start Gimel with:"
echo "  Playground (Demo, :8040):      .venv/bin/gimel playground"
echo "  Production (Clean, :8041):     .venv/bin/gimel production"
echo "  Both side by side:             .venv/bin/python -m gimel.launcher --mode both"
echo "  Manage accounts:               .venv/bin/gimel accounts list"
echo "  Check for GitHub updates:      .venv/bin/gimel update --check"

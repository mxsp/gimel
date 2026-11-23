#!/usr/bin/env bash
# Agent Lab: Tests auf einer eigenen temporären Datenbank, dann die Oberfläche bauen.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-$( [ -x .venv/bin/python ] && echo "$PWD/.venv/bin/python" || echo python3 )}
echo "== agentlab pytest"
"$PY" -m pytest -q -p no:cacheprovider agentlab/tests
echo "== agentlab web"
(cd agentlab/web && npm run build --silent)

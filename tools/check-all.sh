#!/usr/bin/env bash
# Gimel: API- und Kerntests, Bau beider Web-Apps, Tests gegen den Bau.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-$( [ -x .venv/bin/python ] && echo "$PWD/.venv/bin/python" || echo python3 )}
echo "== pytest";    "$PY" -m pytest -q -p no:cacheprovider tests
echo "== web";       (cd web && npm run build --silent \
                        && for t in *.test.mjs; do node "$t" ../gimel/webapp/dist; done)
echo "== gimel grün"

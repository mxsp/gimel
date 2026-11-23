#!/usr/bin/env bash
# Build standalone Gimel executable (bundles both Playground and Production modes).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ROOT}/.venv/bin/python"
PIP="${ROOT}/.venv/bin/pip"

echo "==> 1/3 Building frontend bundles (Portal, Studio, Twin, Agent Lab)"
(cd "${ROOT}/web" && npm run build)
(cd "${ROOT}/agentlab/web" && npm run build)

echo "==> 2/3 Ensuring PyInstaller is installed in .venv"
if ! "${PY}" -c "import PyInstaller" >/dev/null 2>&1; then
  "${PIP}" install --quiet "pyinstaller>=6.10"
fi

echo "==> 3/3 Building standalone executable via PyInstaller"
"${PY}" -m PyInstaller \
  --noconfirm \
  --clean \
  --distpath "${ROOT}/packaging/dist" \
  --workpath "${ROOT}/packaging/build" \
  "${ROOT}/packaging/gimel.spec"

cat > "${ROOT}/packaging/dist/start-playground.sh" <<'EOF'
#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/gimel" --mode playground "$@"
EOF
cat > "${ROOT}/packaging/dist/start-production.sh" <<'EOF'
#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/gimel" --mode production "$@"
EOF
chmod +x "${ROOT}/packaging/dist/start-playground.sh" "${ROOT}/packaging/dist/start-production.sh"

echo ""
echo "Done! Standalone executable built:"
ls -lh "${ROOT}/packaging/dist/gimel"
echo "Run Playground:  ${ROOT}/packaging/dist/gimel --mode playground"
echo "Run Production:  ${ROOT}/packaging/dist/gimel --mode production"
echo "Run Both:        ${ROOT}/packaging/dist/gimel --mode both"

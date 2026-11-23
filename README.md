# Gimel — Order, Nesting & Production Management

Gimel is a local-first manufacturing ERP, MES, sheet-nesting, and 3D factory twin platform for sheet-cutting job shops and manufacturers.

- **ERP Portal (`/app`)** — Orders, order desk, automated & interactive 2D sheet nesting (`lite` & `kerf`), picking (`Kommissionierung`), station worklists (`Arbeitsvorrat`), split `Arbeitsplätze` directory, production tracking, shipping, invoicing, inventory, materials, and calendar.
- **Twin Studio (`/studio`) & Floor Plan (`/twin`)** — Interactive 2D/3D hall layout, station status, material flow, and bottleneck analysis.
- **AI Assistant (`/lab` + docked Copilot)** — Optional assistant workspace (`agentlab/`) with configurable LLM providers, tools, routines, and artifacts.
- **Always ships with both modes:**
  - **Playground (`:8040`)** — Isolated sandbox pre-seeded with the fictional demo plant *Musterwerk GmbH* (`--reset` anytime).
  - **Production (`:8041`)** — Clean, empty production database (SQLite or PostgreSQL), strict secret/token validation, `/docs` disabled, and first-run admin setup right in the browser or via CLI.
- **Localnet-only by default (`GIMEL_LOCALNET_ONLY=1`)** — Blocks non-localnet peers and public proxy forwarding headers (`X-Forwarded-For`, `CF-Connecting-IP`, `Forwarded`) with `403`.
- **Simple Account Manager (Username + Password)** — Manage local accounts via `/app#/benutzer`, `/api/accounts`, or `gimel accounts list|add|passwd|role|enable|disable|unlock|delete`.

> **License:** Source-available for **non-commercial use only** (see [LICENSE](./LICENSE)). Commercial use requires a separate license.

---

## Quick Start

### 1. Docker (Playground + Production)

Start both Playground (`http://127.0.0.1:8040/app`) and Production + PostgreSQL (`http://127.0.0.1:8041/app`):

```bash
cp .env.example .env
# Edit .env to set POSTGRES_PASSWORD, GIMEL_SECRET_KEY, and GIMEL_ADMIN_PASSWORD
docker compose up -d --build
```

Run only the **Playground** sandbox:

```bash
docker compose up -d playground
docker logs gimel-playground   # prints the generated demo login credentials
```

Run only **Production** (with PostgreSQL 16):

```bash
docker compose up -d postgres production
```

### 2. Standalone Executable (Linux Binary / Windows `.exe`)

Build a self-contained single-file executable bundling the backend, all SPAs, and both modes:

- **Linux:** `./packaging/build-exe.sh` → produces `packaging/dist/gimel`
- **Windows (PowerShell):** `.\packaging\build-exe.ps1` → produces `packaging\dist\gimel.exe` + `.bat` launchers

```bash
./packaging/dist/gimel --mode playground   # Sandbox on http://127.0.0.1:8040/app
./packaging/dist/gimel --mode production   # Clean production on http://127.0.0.1:8041/app
./packaging/dist/gimel --mode both         # Run both side by side
```

### 3. Local Python + Node Development

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'

# Build frontend SPAs
(cd web && npm ci && npm run build)
(cd agentlab/web && npm ci && npm run build)

# Start Playground (auto-seeds Musterwerk GmbH into ~/.local/share/gimel/playground)
.venv/bin/gimel playground

# Or start Production (clean DB in ~/.local/share/gimel/production)
.venv/bin/gimel production --admin-user admin --admin-password "replace-with-strong-password"

# Manage local accounts (username + password)
.venv/bin/gimel accounts list
.venv/bin/gimel accounts add max --role staff
.venv/bin/gimel accounts passwd max
```

---

## Repository Layout

```text
gimel/                FastAPI backend, planning core, SQLAlchemy models, launcher
  core/               Pure planning & geometry: nesting (lite/kerf), routing, worklist, pricing
  routers/            REST API endpoints (/api/...)
  services/           Domain services, batch scheduler, security, settings store
  modules.py          Composable module & semi-external app registry
  launcher.py         Unified Playground & Production runner (CLI, Docker, EXE)
web/                  React 18 + Blueprint 5 frontend (Portal /app, Twin /twin, Studio /studio)
agentlab/             Optional AI assistant backend & frontend (/lab)
packaging/            PyInstaller spec and Linux/Windows executable build scripts
docs/MODULARITY.md    Developer guide for adding internal features or semi-external apps
tests/                Pytest backend & planning test suites
```

---

## Extending Gimel

See [docs/MODULARITY.md](./docs/MODULARITY.md) for how to:
1. Add new internal portal screens via `registerFeature(...)` (`web/src/modules/featureRegistry.ts`).
2. Mount semi-external Python/Vite modules via `gimel.modules.register_module(...)` or `GIMEL_MODULE_IMPORTS`.
3. Attach external web tools via `GIMEL_MODULES_FILE`.

---

## Running Tests

```bash
.venv/bin/pytest tests/ -q
cd web && node nav-groups.test.mjs && node jump.test.mjs && node areas.test.mjs ../gimel/webapp/dist
```

---

## License

Copyright (c) 2026 FyreFly Systems GbR / mxsp.
Licensed under the **Gimel Non-Commercial Source License** — see [LICENSE](./LICENSE) and [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

# Gimel — Installation & User Manual

This manual covers everything required to install, initialize, operate, manage accounts, and update **Gimel** in your local network.

---

## Table of Contents

1. [System Requirements](#1-system-requirements)
2. [One-Time Setup & Installation](#2-one-time-setup--installation)
   - [Option A: One-Time Setup Script (Source / Local Install)](#option-a-one-time-setup-script-source--local-install)
   - [Option B: Standalone Executable (Linux / Windows)](#option-b-standalone-executable-linux--windows)
   - [Option C: Docker Compose (Playground + Production + PostgreSQL)](#option-c-docker-compose-playground--production--postgresql)
3. [Playground vs. Production Modes](#3-playground-vs-production-modes)
4. [Localnet-Only Security](#4-localnet-only-security)
5. [Account Manager (Username + Password)](#5-account-manager-username--password)
6. [Using Gimel Day-to-Day](#6-using-gimel-day-to-day)
   - [ERP Portal (`/app`)](#erp-portal-app)
   - [Twin Studio (`/studio`) & Floor Plan (`/twin`)](#twin-studio-studio--floor-plan-twin)
   - [Agent Lab (`/lab`) & Copilot Dock](#agent-lab-lab--copilot-dock)
7. [Updating Gimel from GitHub Releases](#7-updating-gimel-from-github-releases)
8. [Backup, Restore & Troubleshooting](#8-backup-restore--troubleshooting)

---

## 1. System Requirements

| Deployment Option | Requirements |
| --- | --- |
| **Standalone Executable** | Linux x64 or Windows 10/11 x64 — no Python or Node.js required |
| **Docker Compose** | Docker Engine + Docker Compose v2 |
| **Source / One-Time Setup Script** | Python 3.11+, Node.js 20+, npm, Git |

- **Recommended browser:** Chromium, Chrome, Edge, or Firefox (WebGL enabled for the 3D Twin).
- **Network:** Runs **localnet-only** by default (loopback + private LAN subnets).

---

## 2. One-Time Setup & Installation

### Option A: One-Time Setup Script (Source / Local Install)

Clone the repository and run the one-time setup script once. It creates `.venv`, installs Gimel, builds all four frontend apps (`/app`, `/studio`, `/twin`, `/lab`), seeds the isolated Playground sandbox, and initializes Production:

**Linux / macOS:**

```bash
git clone https://github.com/mxsp/gimel.git
cd gimel
./scripts/setup.sh
```

Non-interactive example (pre-creating your first Production admin):

```bash
./scripts/setup.sh --mode both --admin-user admin --admin-password "MyStrongPassword"
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/mxsp/gimel.git
cd gimel
.\scripts\setup.ps1
```

Or run the built-in CLI setup wizard directly at any time:

```bash
.venv/bin/gimel setup --mode production --admin-user admin
```

### Option B: Standalone Executable (Linux / Windows)

Download the latest release archive from [GitHub Releases](https://github.com/mxsp/gimel/releases):

- **Linux:** extract `gimel-linux-x64.tar.gz` and run:
  ```bash
  ./gimel --mode playground     # Demo plant on http://127.0.0.1:8040/app
  ./gimel --mode production     # Clean production on http://127.0.0.1:8041/app
  ./gimel --mode both           # Run Playground (:8040) and Production (:8041) together
  ```
- **Windows:** extract `gimel-windows-x64.zip` and double-click `Start-Gimel-Playground.bat`, `Start-Gimel-Production.bat`, or `Start-Gimel-Both.bat`.

### Option C: Docker Compose (Playground + Production + PostgreSQL)

```bash
git clone https://github.com/mxsp/gimel.git
cd gimel
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, GIMEL_SECRET_KEY, GIMEL_ADMIN_USER, GIMEL_ADMIN_PASSWORD
docker compose up -d --build
```

- Playground: `http://127.0.0.1:8040/app` (`docker logs gimel-playground` shows the generated demo login)
- Production: `http://127.0.0.1:8041/app` (PostgreSQL 16 backend)

---

## 3. Playground vs. Production Modes

Gimel always keeps **Playground** and **Production** strictly isolated in separate data folders:

| Mode | Default Port | Data Directory | Purpose |
| --- | --- | --- | --- |
| **Playground** | `8040` | `~/.local/share/gimel/playground` | Pre-seeded sandbox (*Musterwerk GmbH*) for training, testing, and evaluation. Reset anytime with `--reset`. |
| **Production** | `8041` | `~/.local/share/gimel/production` (or `GIMEL_DATABASE_URL`) | Clean, empty database for real operations. Swagger/ReDoc (`/docs`) disabled; persistent `secret.key` & `portal.token` auto-created with `0600` permissions; refuses to start on a demo database. |

To expose Gimel to other devices on your office/shop-floor LAN (still restricted to localnet IPs):

```bash
gimel production --host 0.0.0.0 --port 8041
```

Then open `http://<server-lan-ip>:8041/app` from any workstation or shop-floor tablet on the same LAN.

---

## 4. Localnet-Only Security

Gimel enforces **localnet-only** access by default (`GIMEL_LOCALNET_ONLY=1`):

- **Allowed:** Loopback (`127.0.0.0/8`, `::1`), RFC 1918 private LAN (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, `fe80::/10`), and IPv6 ULA (`fc00::/7`).
- **Blocked (`403 Forbidden`):** Any public IP peer **and** any request carrying a public client IP in proxy headers (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`, `Forwarded`).
- **VPN / WireGuard subnets:** Add extra trusted private CIDRs via `GIMEL_LOCALNET_ALLOW=100.64.0.0/10`.

---

## 5. Account Manager (Username + Password)

Gimel uses a simple, local **Username + Password** account manager — no email server or external identity provider required.

### First-Run Admin Creation (Browser)
When starting Production on a fresh empty database, opening `/app` (or `/lab`) automatically displays the **Ersteinrichtung (First Admin Setup)** form: enter a username (e.g. `admin`) and password (min. 8 characters), submit, and you are signed in immediately. Once at least one account exists, the setup endpoint locks permanently (`409 Conflict`).

### Managing Accounts in the Web UI
Open the user menu (bottom-left in the sidebar) → **Benutzer** (`#/benutzer`):
- Create accounts with **Username + Password + Role**:
  - **Admin** — Full access, system settings, updates, and account management.
  - **Personal (`staff`)** — Office & shop-floor operations (orders, pricing, planning, inventory, shipping, invoicing).
  - **Werker (`worker`)** — Shop-floor execution (orders, worklist, picking, production, shipping, 3D Twin — no pricing/accounting).
- Change passwords (immediately revokes existing sessions), rename accounts, disable/re-enable, unlock after failed logins, or delete accounts.
- Change your own password via **Eigenes Passwort**.

### Managing Accounts via CLI

```bash
gimel accounts list
gimel accounts add max --role staff
gimel accounts add schicht1 --role worker
gimel accounts passwd max
gimel accounts role max admin
gimel accounts disable max
gimel accounts enable max
gimel accounts unlock max
gimel accounts delete max
```

---

## 6. Using Gimel Day-to-Day

### ERP Portal (`/app`)
Switch smoothly between **Büro** (Office) and **Leitstand** (Shop-floor Control) in the sidebar, or press `Ctrl+K` to jump to any screen or order:
- **Heute (`#/heute`)** — Daily overview with tabbed action items, active stations, and live bottlenecks.
- **Auftragserfassung (`#/auftragserfassung`) & Aufträge (`#/auftraege`)** — Create quotes/orders, check pricing, release into production.
- **Disposition (`#/disposition`) & Schachteln (`#/schachteln`)** — Batch sheet-nesting (`lite` & `kerf` engines), material allocation, and printable route cards (*Laufkarten*).
- **Arbeitsvorrat (`#/arbeitsvorrat`)** — Control-center queues (`Warteschlangen | Arbeitsplätze | Optimierung`) with busy-station focus and area filters.
- **Kommissionierung (`#/kommissionierung`), Produktion (`#/produktion`), Versand (`#/versand`)** — Material picking, job tracking, packing, and shipping.
- **Stammdaten** — Customers (`#/kunden`), Inventory (`#/lager`), Materials (`#/werkstoffe`), Accounting (`#/buchhaltung`), Calendar (`#/kalender`).

### Twin Studio (`/studio`) & Floor Plan (`/twin`)
- Open from the top app switcher or directly at `/studio/` (3D Twin Studio) and `/twin/` (Floor Plan).
- Inspect live station occupancy, edit hall layouts, machines, aisles, and storage zones, and save camera views.

### Agent Lab (`/lab`) & Copilot Dock
- Open `/lab/` for the full workspace or toggle the docked **Assistent** panel inside `/app` (`Ctrl+Shift+A`).
- Configure a local LLM (e.g. **Ollama** on your LAN) or cloud provider under **Admin → Assistent & Sandbox** (`#/admin`).
- Query orders, production queues, stock levels, and factory layout with built-in tools and reversible change tracking.

---

## 7. Updating Gimel from GitHub Releases

Gimel connects directly to `https://github.com/mxsp/gimel/releases/latest` (override via `GIMEL_UPDATE_REPO`):

### Via Web UI
1. Sign in as an **Admin**.
2. Open **Admin → Updates** (`#/admin`).
3. Click **Auf Updates prüfen** to query GitHub Releases.
4. If a newer release is available, review the release notes and click **Auf vX.Y.Z aktualisieren**, then restart Gimel.

### Via CLI

```bash
# Check whether a newer GitHub Release exists
gimel update --check

# Download and apply the latest GitHub Release
gimel update --apply
```

- **Standalone binary installs:** Downloads the platform archive (`gimel-linux-x64.tar.gz` / `gimel-windows-x64.zip`), verifies `SHA256SUMS.txt`, backs up the current executable (`.bak`), and stages/replaces the binary.
- **Git checkouts:** Fetches the release tag from `https://github.com/mxsp/gimel.git`, checks out the tag cleanly, updates Python packages, and rebuilds the web UI.
- **Docker installs:** Displays the exact `git pull && docker compose up -d --build` command.

---

## 8. Backup, Restore & Troubleshooting

- **SQLite Backup:** Stop Gimel (or use `sqlite3 gimel.db ".backup backup.db"`) and back up `~/.local/share/gimel/production/` (including `gimel.db`, `secret.key`, and `portal.token`).
- **PostgreSQL Backup:** Use `pg_dump` against the `postgres` service (`docker exec gimel-postgres pg_dump -U gimel gimel > gimel.sql`).
- **Resetting Playground:** `gimel playground --reset` wipes only the Playground database and re-seeds *Musterwerk GmbH*; Production data is never touched.
- **Locked out of Admin:** Reset any account's password locally via CLI:
  ```bash
  GIMEL_DATA=~/.local/share/gimel/production gimel accounts passwd admin
  ```
- **403 Localnet Error on VPN:** Add your VPN subnet CIDR to `GIMEL_LOCALNET_ALLOW` (e.g. `GIMEL_LOCALNET_ALLOW=100.64.0.0/10`) and restart Gimel.

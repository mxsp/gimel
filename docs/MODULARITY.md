# Gimel Modularity & Semi-External Software Guide

Gimel provides two clean seams for extending the platform without scattering changes across the core codebase:

1. **Frontend Feature Registry** (`web/src/modules/featureRegistry.ts`) — for adding internal ERP views in one place.
2. **Backend Composable Module & Semi-External App Registry** (`gimel/modules.py` + `/api/modules`) — for attaching semi-external software (sidecar web apps, dashboards, CAD/WMS tools, or standalone Python/Vite modules).

---

## 1. Adding a New Internal ERP Feature (1 File)

Register new portal screens via `registerFeature(...)` in `web/src/modules/features.tsx` (or a dedicated module file imported there):

```tsx
import { lazy } from "react";
import { registerFeature } from "./featureRegistry";

const QualityPage = lazy(() => import("../pages/QualityPage"));

registerFeature({
  id: "qualitaet",
  label: "Qualität",
  icon: "endorsed",
  area: "leitstand",          // "buero" | "leitstand" | "beide"
  group: "Fertigung",         // sidebar group
  placement: "sidebar",       // "sidebar" | "subview" | "menu"
  key: "q",                   // keyboard chord: g q
  workerAllowed: true,        // optional: allow worker accounts
  keywords: "prüfplan qs fehler messung",
  info: "Prüfpläne und Qualitätsmeldungen je Innenauftrag. Neue Meldungen lassen sich direkt mit dem Auftrag verknüpfen.",
  render: ({ role, admin }) => <QualityPage role={role} admin={admin} />,
});
```

This single call automatically wires:
- Routing (`#/qualitaet` in `App.tsx`)
- Sidebar / account menu visibility (`nav.ts`)
- Keyboard shortcut (`g q`)
- Command palette search (`Strg+K` via `jump.ts`)
- Contextual `(i)` help text (`pageInfo.ts`)

---

## 2. Attaching Semi-External Software (No Code / No Rebuild)

### Option A — Live via UI (**Kontomenü → Module & Apps**, `#/module`)
Admins can attach any local or remote web application via **Module & Apps → Anwendung anbinden**:
- **Eingebettet im Portal (`#/ext/<id>`)**: renders inside Gimel's shell (`ExternalAppHost`) with reload, fullscreen, and open-in-new-tab controls. Gimel automatically adds the app's origin to `Content-Security-Policy: frame-src` and posts `{ type: "gimel:context", theme, moduleId }` via `postMessage`.
- **Extern (`new_tab: true`)**: opens in a new browser tab.
- **Platzierung**: choose `Nur Module & Strg+K` (keeps the sidebar calm), `App-Wechsler unten`, `Seitenleiste`, or `Kontomenü`.

### Option B — Drop-in JSON Manifest (`GIMEL_MODULES_FILE`)
Point `GIMEL_MODULES_FILE=/path/to/modules.json` to a JSON file:

```json
{
  "modules": [
    {
      "id": "grafana",
      "label": "Werkstatt-BI",
      "short_label": "BI",
      "icon": "chart",
      "description": "OEE- und Maschinen-Dashboards",
      "kind": "embedded",
      "href": "http://127.0.0.1:3000/d/shopfloor",
      "placement": "switcher",
      "area": "leitstand",
      "roles": ["admin", "staff"]
    }
  ]
}
```

---

## 3. Mounting a Full Python + Frontend Semi-External Module

Unlike `gimel.extensions.use(...)` (which binds a single host application like Alef), `gimel.modules.register_module(...)` is **composable**—you can mount any number of independent modules with their own FastAPI routers, DB seed hooks, and built SPA bundles:

```python
from pathlib import Path
from fastapi import APIRouter
from gimel.modules import AppModule, register_module

def build_routers():
    r = APIRouter(prefix="/api/wms", tags=["wms"])

    @r.get("/status")
    def status():
        return {"ok": True}

    return [r]

MODULE = AppModule(
    id="wms",
    label="Lager-WMS",
    short_label="WMS",
    icon="database",
    description="Eigenständige Lagerverwaltung mit Scanner-UI",
    kind="mounted",
    href="/wms/",
    placement="switcher",
    mount_path="/wms",
    dist_dir=Path(__file__).parent / "webapp" / "dist",
    routers=build_routers,
)

register_module(MODULE)
```

Load modules automatically at startup without modifying `gimel/app.py`:

```bash
export GIMEL_MODULE_IMPORTS="my_wms.plugin:MODULE,my_cad.plugin:MODULE"
```

Gimel automatically:
- Includes the module's FastAPI routers
- Runs its optional `seed(db, verbose)` hook in isolated lifespan error handling
- Mounts `dist_dir` under `mount_path` with `no-cache` on HTML and `immutable` caching on `/assets/`
- Publishes it via `/api/modules` and `/api/version` to `AppSwitcher` and `Strg+K`

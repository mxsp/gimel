# Gimel Mobile — master document (AR, copilot, free walk, sensor/GPS navigation)

Status: build document, 2026-11-16. Nothing in this document is built.
Combines Part 1 (`plan-mobile-ar.md`, the whole mobile plan) and Part 2
(`spec-app-ar-copilot.md`, the detailed build spec). Where they differ, Part 2 wins: the
copilot is already merged into Gimel on another machine and the app may use a different
endpoint (relay recommended), so Part 1's "merge the Agent Lab backend" decision (D4, M7,
owner decision 3) is superseded by Part 2 §3 and work packages C0–C5.
References such as "§5.7" in Part 2 and "D5" or "M8" in Part 1 point inside their own part.

## Contents

- Part 1 — Mobile plan: LAN/HTTPS, pairing, QR, positioning ladder, app screens, server
  additions, work packages M0–M14, risks, owner decisions, appendices
- Part 2 — Build spec: endpoints and copilot relay, copilot integration, AR, copilot × AR,
  free walk (§11), sensor and GPS navigation (§12), work packages C/A/F/N, device checklist

---

# PART 1 — Mobile plan

## Plan: Gimel Mobile — phone on the LAN, copilot, QR, positioning, AR and the walkable twin

Status: proposal for review, 2026-11-16. Nothing in this document is built.
Audience: the owner (decisions in §13) and the building agent (work packages in §11).
Scope: Gimel standalone with the demo plant "Musterwerk GmbH" first; Alef inherits it later.
Basis: `CLAUDE.md`, `README.md`, `agentlab/README.md`, `docs/plan-twin-operators-robots.md`,
`docs/backlog-operator-twin.md` and the code as of commit `08be871f`.

## 1. Intent

An Android phone on the same network as the Gimel machine becomes a full working device:

1. **Reach Gimel by local IP**, paired once by QR, installable like an app.
2. **Do the hall work one-handed**: today, worklist, station, picking, stock, shipping, scan.
3. **Talk to the copilot.** The model key never leaves the machine Gimel runs on; the phone
   only ever sees the answer stream.
4. **Scan QR codes** as the universal "what is this / do the next thing" gesture, and as the
   anchor that tells the phone exactly where it stands.
5. **Know where I am** in the plant, with an honest confidence: GPS for site and hall, QR and
   AR tracking for metres.
6. **Walk the twin.** In the real hall through the camera (AR), on a table as a miniature, or
   as a "theoretical walk" in first person without being there.
7. **Plan in place.** Put a machine on the real floor through the camera, move it, check it,
   and hand the result to the office as a layout draft, never as a silent change.

Design rule carried over from the twin plan: **measured, reported, estimated and unknown look
different.** A GPS guess is a circle, never a dot. A draft machine is a ghost, never a station.

## 2. Where we are (verified in the code)

### 2.1 Gimel and the demo plant

- FastAPI app (`gimel/app.py`), React 18 + Blueprint 5 web app at `/app` (`web/`), a lighter
  floor view at `/twin` (`web-twin/`), SQLite, 30+ tables (`gimel/models.py`).
- `gimel demo` seeds **Musterwerk GmbH** (`gimel/demo.py`): one site "Werk Musterstadt"
  (lat 51.4810, lon 12.0050), Halle 1 (64 × 32 m, EG + 1. OG) and Halle 2 (KG, EG, 1. OG),
  both with map anchors (`lat`, `lon`, `rotation_deg`, `map_enabled`), zones, columns as
  obstacles, doors/gates/stairs/lift, an aisle graph per floor, stations with machine values
  (Plattenregal, Plotter 1/2, Wasserstrahl, Stanze, Nacharbeit, Packtisch, …), three simulated
  robots on the aisles, orders with routing scopes. Login in `<data>/demo-login.txt`.
- **All plan coordinates are metres** (`FactoryFloor` docstring); stations carry `x, y, w, h,
  rotation, floor_id`; floors carry `elevation_m`, `height_m`, `grid`, `snap`.
- Coordinate conventions already fixed: plan y counts south, `rotation_deg` turns the hall
  x-axis counter-clockwise from east (`web/src/sites.ts` `hallToWorld`/`worldToHall`/
  `hallOffset`); in three.js plan y lies on +z, station rotation is negated.
- 3D exists and is reusable: `web/src/components/twin/ThreeFloorPlan.tsx` (1655 lines, scene
  building is inside the component), `deviceModels.ts` (`buildDeviceModel`, built models per
  machine kind), `stationModel.ts` (GLB/OBJ/STL upload), `robotModel.ts`, `robots.ts` (pose
  from route and time). three 0.187.
- Pathfinding exists twice with a parity fixture: `gimel/core/pathfind.py` and the TypeScript
  copy in `web/src/factory.ts` (`tests/core/fixtures/aisle_parity.json`).
- Live updates: in-memory SSE bus (`gimel/services/events.py`), one-minute ticket
  (`POST /api/admin/events/ticket`), stream at `GET /api/admin/events`. Task state changes are
  not published yet (backlog P8).

### 2.2 What mobile has to deal with

| Fact | Where | Consequence |
|---|---|---|
| `gimel serve` binds `127.0.0.1:8040`; `--host` exists and prints a warning | `gimel/cli.py` | LAN mode is one flag away, but plain HTTP |
| Host guard already accepts any numeric IP in `Host` | `gimel/hostguard.py` | `https://192.168.x.y:port` passes without a setting |
| Refresh cookie is `Secure` only in production | `gimel/routers/auth.py:90` | must follow the request scheme in LAN mode |
| CORS is empty standalone; one CSP on every response | `gimel/app.py` | the phone app must be same-origin; no CDN, no inline script |
| Access token in `localStorage`, 30 min; refresh cookie on `/api/auth`, 30 days; sessions revocable (`AuthSession`) | `web/src/api.ts`, `gimel/security.py` | pairing can mint a normal session; "end device" already works |
| PIN login exists (shared account, throttled) | `routers/auth.py`, `services/pin_guard.py` | usable on a shared hall phone |
| Camera is used once: `getUserMedia` with `facingMode: environment` | `web/src/pages/PartVision.tsx:139` | works on localhost or HTTPS only |
| `usePhone()` = max-width 720 px; the web app is a dense desktop UI | `web/src/usePhone.ts`, `styles.css` | not a basis for a one-hand phone UI |
| Printed "Barcode"/"QR" are hash-derived decoration, no scan endpoint | `gimel/render/plate.py:45`, backlog P3 | QR has to be built for real |
| Any worker can read and change any station/task | backlog P7 | must be closed before phones multiply |
| Floor save has no revision | backlog P11 | AR must not write layouts directly |
| `cryptography>=42` is already a dependency | `pyproject.toml` | a local CA needs no new package |

### 2.3 The copilot today (Agent Lab)

- Separate process on port 8008 (`python -m agentlab serve --data …`), a Gimel plugin on the
  same database and `secret.key`, own tables `agent_*`, scheduler disabled in that process.
- OpenAI-compatible providers; the key is sealed in `agent_providers` or comes from
  `GIMEL_AGENT_API_KEY` / `AGENT_API_KEY`, and **is never returned by the API**.
- 75 typed tools (34 read, 41 write) with role filter, per-chat write switch, change ledger
  with compare-and-set revert, SSE events `start|delta|reasoning|assistant|tool_call|
  tool_result|error|done`. The system prompt already takes the current page (`route`).
- Its README lists the merge into `gimel/` as the step after acceptance.

So the user's "key stored on the machine where Gimel runs" is **already the design**. What is
missing is a single origin the phone can reach, and context from the phone (place, scan, pose).

## 3. Constraints that stay true

From `CLAUDE.md`, binding for every package below:

- **LAN only.** No tunnel, no public address, no cloud relay, no cloud anchors, no push
  service. The only outbound traffic is the one that exists today: the copilot provider (or a
  local Ollama) from the Gimel machine, and optional map tiles.
- **The seam is `gimel/extensions.py`;** Gimel never imports an application. A new router also
  goes into Alef's `app/_moved.py`.
- **`gimel/core/` stays pure:** alignment maths, GPS→hall conversion and layout checks that
  land in the core take all inputs as arguments, no clock, no I/O.
- **Live schema:** additive tables only, new columns through `ADDED_COLUMNS` in `seed.py`.
- **0 means unknown** for machine values; pose, battery and coordinates are nullable instead.
- **CSP:** no inline script, no `on…=` handler, no CDN. Bundled code only.
  `tests/app/test_security_headers.py` must keep passing.
- **Every state change is audited** with the signed-in actor.
- **Images never touch a disk or a form parser** (raw body, in memory), as in Teileerkennung.
- **Demo data is fictional;** German UI, German reasons in comments.
- Done means `tools/check-all.sh` green here, then in Alef.

New constraint this plan adds: **a person's position is not production data.** Pose and GPS
stay on the phone. The server learns a place only when the user does something there (a scan,
a task start), and stores the object, not a track. No worker movement history, no heat map of
people. Anything beyond that is an owner decision with the works-council question attached.

## 4. Architecture decisions

### D1 — Client: an installable web app at `/m`, AR through WebXR, native shell as fallback

Recommendation: a third Vite app **`web-mobile/`**, built into `gimel/mobile/dist`, served at
`/m`, installable to the Android home screen (manifest + service worker).

Why web first:

- The twin, the device models, the robot poses, the pathfinder and the API client are
  TypeScript + three.js today. WebXR renders the same three.js scene through the camera; a
  native app would rebuild all of it in Kotlin.
- One deployment: the phone always runs what the server serves. No APK signing, no store.
- Chrome on Android gives `immersive-ar` with hit-test, anchors and DOM overlay on ARCore
  devices, plus `BarcodeDetector`, geolocation and device orientation.

What web cannot do well, and the answer:

- **Automatic marker tracking** (WebXR image tracking is not generally available). Answer: a
  two-tap alignment on floor markers (§7.3); raw camera access as a later upgrade.
- **Background work and push** without a cloud push service. Answer: live only while open.
- **Hall-scale drift** over 60 m. Answer: re-anchoring at markers and a drift budget (§7.4).

**Gate:** work package M0 is a spike on the owner's actual phone. If it fails the criteria in
§11 M0, the AR part moves to a thin native Android shell (Kotlin + ARCore, appendix A) that
hosts the same `/m` web app in a WebView and replaces only the AR view. Everything else in
this plan is unaffected by that switch.

Not Blueprint on the phone: it is a desktop kit. `web-mobile` uses the existing design tokens
(`web/src/tokens.css`) with its own small set of touch components (≥ 48 px targets, bottom
navigation, sheets instead of dialogs). Shared logic moves to **`web-shared/`** (plain
TypeScript, no React): API client, types, `sites.ts` geometry, pathfinder, `deviceModels.ts`,
`robotModel.ts`, `robots.ts`, `stationModel.ts`, and a new `twinScene.ts` extracted from
`ThreeFloorPlan.tsx` (floor, walls, zones, stations, robots, labels as pure builders). `web/`
and `web-mobile/` both import it; the extraction is a refactor with the existing
`twin-load.test.mjs` as its guard.

### D2 — Transport: HTTPS on the LAN is not optional

Camera, WebXR, geolocation, device orientation and service workers all need a **secure
context**. `http://192.168.x.y` is not one. So "via local IP" means **`https://<LAN-IP>:8443`**.

New command **`gimel serve --lan`** (standalone only; Alef keeps its gate in
`fyrefly-ops/gimel-lan/`):

- Binds the chosen interface (`--host`, default: the primary private IPv4; refuses a public
  address unless `--i-know` is given), port 8443, `ssl_certfile`/`ssl_keyfile` in uvicorn.
- **Local CA in the data folder** (`<data>/lan/ca.key` 0600, `ca.crt`, `server.key`,
  `server.crt`), created with `cryptography` on first start. The server certificate lists the
  current LAN IPs and the hostname as SANs, is valid ≤ 397 days and is re-issued automatically
  when the IP set changes. Name constraints on the CA limit it to private address ranges and
  `.local`/`.lan`, so a stolen CA key cannot impersonate the internet.
- **Onboarding listener** on plain HTTP (port 8040 on the LAN interface, only in `--lan`):
  serves exactly three things — a page explaining the step, `ca.crt`, and a redirect to HTTPS
  for everything else. No API, no app, no cookies.
- The desktop shows the CA fingerprint; the phone page shows the same one to compare.
- `Secure` on the refresh cookie when the request scheme is HTTPS; `Strict-Transport-Security`
  is not sent (IP addresses, self-run CA).
- New headers in LAN mode: `Permissions-Policy: camera=(self), geolocation=(self),
  xr-spatial-tracking=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self),
  microphone=()`; CSP gains `worker-src 'self'; manifest-src 'self'`.
- A stable address matters: printed pairing sheets and the installed app point at the IP.
  The plan recommends a DHCP reservation and shows the hint in the pairing dialog. An optional
  `GIMEL_ALLOWED_HOSTS=gimel.lan` covers a local DNS name.

Development shortcuts (documented, never the product path): `adb reverse tcp:8040 tcp:8040`
makes the phone's `http://localhost:8040` a secure context over USB; Chrome's "insecure origins
treated as secure" flag does the same for one IP.

### D3 — Pairing: a QR on the desktop, a device session on the phone

- Desktop `/app` → Konto → **„Gerät koppeln“**: shows a QR with
  `https://<ip>:8443/m/pair#<code>`. The code is a one-time ticket (JWT scope `pair`, 120 s,
  single use via a row in `device_pairings`), in the URL fragment so it never reaches a log.
- Phone opens it, posts the code to `POST /api/mobile/pair`, receives a normal session
  (`AuthSession` + refresh cookie + access token) for **the user who created the QR**, labelled
  with a device name. `current_user` already rejects any scope that is not `access`.
- Devices appear in the existing session list (Konto → Geräte) and end there.
- Shared hall phones: pair as the PIN account or sign in with the Gimel PIN (existing
  throttle and audit). Personal phones: pair personally; 2FA stays on the desktop side because
  the pairing QR is issued from an already authenticated session.
- A paired worker phone can carry a **station binding** (`device.station_id`) so it opens on
  that station's work; this is also where backlog P7 (`allowed_station_ids(user)`) lands.
- Audit: `device_pair`, `device_revoke`, with device label and IP.

### D4 — Copilot: one origin, key on the server, phone context in

- **Merge the Agent Lab backend into the Gimel process** (the README's steps 1, 2, 7: tables
  to `models.py`, router to `gimel/routers/agent.py`, services to `gimel/services/agent_*`,
  tests to `tests/app/test_agent.py`), behind the setting `agent_enabled` (default off). The
  lab UI on 8008 can stay as the admin bench for providers and tool testing. Reason: the phone
  has one origin and one certificate; a second port would need CORS and a second pairing.
- **Key custody unchanged:** sealed in `agent_providers` or `GIMEL_AGENT_API_KEY` on the Gimel
  machine. `GET /providers` never returns it. A test asserts that no `/api/agent` or
  `/api/mobile` response contains the key or the `Authorization` header value.
- **Network shape:** phone → Gimel (LAN, TLS) → provider (internet) or Ollama (LAN/localhost).
  The phone needs no internet at all.
- **Context instead of a page name:** `POST /chats/{id}/messages` gains an optional `context`
  object next to `route`: `{surface: "mobile", floor_id, position: {x, y, quality}, station_id,
  last_scan: {kind, id}, draft_id, mode: "ar|walk|plan|list"}`. The runner renders it into the
  system prompt as data ("Der Nutzer steht laut QR-Anker bei Plotter 1, Halle 1 EG"). Position
  is sent only while the copilot sheet is open and is not stored with the message.
- **New read tools:** `where_am_i` (echo of context with names resolved), `stations_near`
  (floor, x, y, radius), `route_between_points` (aisle path, metres, estimated walk time),
  `station_status` (queue, running task, last material), `layout_draft_get`,
  `layout_draft_check`.
- **New write tools (write switch required, all revertable):** `layout_draft_create`,
  `layout_draft_add_station`, `layout_draft_move_station`, `layout_draft_remove_item`. The
  copilot edits **drafts**, never live stations, from the phone surface.
- **Client actions:** a new SSE event `client_action` with a closed list —
  `highlight_station`, `navigate_to_station`, `open_order`, `open_task`, `show_draft`,
  `start_walk`. The phone executes only names on the list with validated ids; anything else is
  dropped. This is how "bring me to the Wasserstrahl" or "show me where IA-1042 is" works.
- **Phone UI:** a sheet that slides over any screen and stays usable in AR through the WebXR
  DOM overlay; tool cards collapsed to one line; "Rückgängig" on every change; write switch
  visible and off by default; stop button.
- **Voice:** text first. Dictation through the Android keyboard is the user's own choice and
  needs nothing from us. Browser speech recognition sends audio to a cloud service and is
  therefore **not** built in. A local speech model on the Gimel machine is a later option.
- **Camera to the copilot** ("what is wrong with this cut?"): sends an image to the provider,
  so it leaves the LAN. Off by default, admin setting `agent_images`, a confirmation on every
  send, image never stored (only its hash and size in the message row). Later slice.
- Limits stay: typed tools only, role filter, `agent_max_steps`, results are data not
  instructions (QR payloads and scan results included in that rule).

### D5 — Positioning: a ladder with honest confidence

One client-side state, one small pure module (`web-shared/position.ts`, mirrored where the
server needs it in `gimel/core/geo.py`):

| Level | Source | Accuracy | Shown as | Used for |
|---|---|---|---|---|
| `unknown` | nothing | — | "Standort unbekannt" | lists only |
| `coarse` | GPS (`navigator.geolocation`, high accuracy) | 5–30 m outdoors, worse or absent indoors | circle with the reported radius | choose site and hall, outdoor walk between halls, pre-select floor list |
| `placed` | tap on the plan ("Ich stehe hier") | 1–3 m, user's claim | hollow dot with `≈` | lists sorted by distance, start of a route |
| `anchored` | QR anchor scan | 0.1–0.5 m at the moment of the scan | solid dot | AR alignment, navigation start |
| `tracked` | AR tracking since the last anchor | 0.1 m + drift (~1–2 % of the distance walked) | solid dot with heading | AR overlay, placing machines |
| `stale` | tracking lost, or drift budget used up | unknown | dot fades to hollow, "neu ankern" | prompts for the next marker |

GPS → plan: `east/north = (lat, lon) − hall anchor` in metres, then `worldToHall(east, north,
rotation_deg)`; the phone is "in" a hall if the point lies inside the outline grown by the
reported accuracy. Two candidate halls → ask. **The floor can never come from GPS:** it comes
from the last anchor, a manual choice, or stays "Ebene wählen". Compass heading is a hint
only (steel and motors bend it); it orients the 2D map arrow, never the AR alignment.

Hall anchors today are single points with a rotation set by dragging on a map. For GPS to be
useful the admin needs a check: **„Hallenlage prüfen“** on the phone — stand at two outside
corners, compare GPS with the plan, see the error in metres, optionally correct `lat/lon/
rotation_deg` (admin, audited). Without that check GPS is labelled "ungeprüft".

### D6 — QR: one real code system for objects, places and pairing

- **Encoder on the server**, pure Python, rendered as SVG. Two options: vendor a small
  QR encoder into `gimel/render/qr.py` (no dependency) or add `segno` (BSD, pure Python, no
  dependencies) — owner decision §13. Replaces the placeholder in `render/plate.py`; the
  Code-128 bar stays for keyboard-wedge scanners (backlog P3).
- **Payload**: `G1.<kind>.<id>.<sig>` — short, host-independent (a printed label survives an
  IP change), `sig` = first 8 base32 characters of an HMAC over kind+id with a key derived
  from `secret.key`. A code without a valid signature is shown as "fremder Code" and its text
  is never interpreted or passed to the copilot as an instruction.
- **Kinds:** `a` anchor (AR/position marker), `s` station, `w` work order (Innenauftrag),
  `p` plate, `t` task, `o` order, `l` storage location/stock item, `r` robot, `d` layout draft.
  Pairing is a URL QR (D3), because the phone's camera app must open it.
- **Scanner in the app:** `BarcodeDetector` on a `getUserMedia` stream; bundled pure-JS decoder
  as the fallback (no WASM, so the CSP needs no `wasm-unsafe-eval`). Torch toggle, haptic tick,
  continuous mode for picking.
- **Resolve:** `POST /api/mobile/scan {code}` → `{kind, id, title, facts, actions[]}` where
  actions are what this user may do right now (start task, report done, book stock, open
  station, navigate here, set as my position). One tap executes the first action; the scan
  itself only writes an audit line when an action follows.
- **Anchor markers** (`ar_anchors` table): floor id, x, y, heading, mounting (`floor` or
  `wall` + height), size in mm, label. Printed from the floor editor as an A4 sheet with the
  QR, a large arrow (the marker's +x), the name and the plan coordinates in clear text.
  Demo: six anchors seeded in Halle 1 EG on aisle nodes and at both gates.
- **Print sheets:** station signs, storage labels, anchor sheets, the pairing sheet.

## 5. The app — structure and functions

Bottom navigation with five entries; the copilot is a floating button on every screen.

### 5.1 Heute (start)

- Greeting with role, station binding, connection state (LAN, server version, live/polling).
- My next task, large; what is waiting at my station; what is late.
- Position chip (level from D5) — tap opens the map.
- Alerts from the live stream: material missing, run finished, robot blocked.

### 5.2 Arbeit

- **Arbeitsvorrat** of my station(s): one task per card, Start / Pause / Fertig with
  thumb-reach buttons, quantity stepper, undo for 10 s. Uses the existing
  `/api/factory/stations/{id}/worklist` and `/tasks/{id}/state`.
- **Station** view: running job, queue, last material, plate picture (existing renderers).
- **Kommissionierung**: continuous scan, each scan ticks a line, wrong item is refused loudly.
- **Bereitstellen / Versand**: confirm staging, pack, hand over.
- **Teileerkennung** with the phone camera as a hand-held alternative to the table camera
  (existing `/api/vision/*`; calibration differs per camera, so the phone gets its own profile
  or stays preview-only at first).
- Reasons for pause/scrap and actual minutes when backlog P4 lands; the screens leave the slot.

### 5.3 Scannen

The centre button. Scan anything with a Gimel code (D6); result sheet with facts and actions.
History of the last 20 scans on the device only.

### 5.4 Werk (map, AR, walk, plan)

One screen, four modes over the same scene data:

- **Karte:** 2D plan of the current floor, me (D5), stations with load colour, robots live,
  site/hall/floor switcher, search ("Wasserstrahl", "IA-1042", "EPDM 3 mm"), route to a target
  along the aisles with metres and walking time.
- **AR:** §7. **Rundgang (theoretical walk):** §8. **Planen:** §9.

### 5.5 Mehr

Orders and stock lookup (read; staff sees prices and customers, workers do not — the server
decides, as today), robots and transport jobs (status, approve/cancel by role), devices and
pairing, settings (haptics, units, AR quality, position sources on/off), about/diagnostics
(certificate fingerprint, server address, WebXR capability report).

### 5.6 Cross-cutting

- **Live:** one `useLive` hook (ticket → SSE, polling fallback every 30 s, backlog P8),
  publishing `task_state`, `task_assign`, `station_update`, `robot_pose`, `draft_update`.
- **Offline:** the shell and the last floor/stations/worklist are cached (service worker,
  cache-first for hashed assets, network-first for `/api`). Reads show their age. **Writes are
  never queued silently:** a failed start/done stays on screen as "nicht gesendet" with a retry.
- **Screen:** wake lock while a task runs or AR is open; portrait default, AR and walk rotate.
- **Roles:** the route list per role is a server answer (`GET /api/mobile/bootstrap`), not a
  client constant; it also returns features, settings, topology and the station binding.
- **Accessibility:** contrast for hall light, gloves (large targets, no swipe-only gesture),
  every colour paired with a word or symbol.
- **Language:** German, same wording as `/app`.

## 6. Server additions

### 6.1 Tables (all additive)

| Table | Purpose |
|---|---|
| `mobile_devices` | paired device: user, label, platform, `station_id`, `session_id`, last seen, revoked |
| `device_pairings` | one-time pairing codes: hash, creator, expires, used |
| `ar_anchors` | marker: floor, x, y, heading, mounting, height, size, label, active |
| `layout_drafts` | name, floor, base snapshot hash, status `open|submitted|applied|rejected`, author, note |
| `layout_draft_items` | op `add|move|rotate|resize|remove`, station id or new-station payload, x, y, rotation, source (`ar|walk|desk|agent`), position quality at capture |
| `factory_floor_revisions` | snapshot of floor + stations before any apply (closes backlog P11) |
| `agent_*` | moved from `agentlab/models.py` unchanged |

Column: `hall.geo_checked_at`, `hall.geo_error_m` through `ADDED_COLUMNS`.

### 6.2 Routes

```text
POST   /api/mobile/pairings                 create code (signed-in desktop)
POST   /api/mobile/pair                     exchange code → session
GET    /api/mobile/devices                  list (own; admin: all)
DELETE /api/mobile/devices/{id}             revoke
PUT    /api/mobile/devices/{id}/station     bind to a station (admin)
GET    /api/mobile/bootstrap                role routes, features, topology, binding, settings
POST   /api/mobile/scan                     resolve a code → facts + allowed actions
GET    /api/mobile/qr/{kind}/{id}.svg       a code as SVG (print)
GET    /api/mobile/print/anchors?floor_id=  anchor sheets (HTML, no inline script)

GET    /api/factory/anchors?floor_id=       list
POST   /api/factory/anchors                 create (admin)
PUT    /api/factory/anchors/{id}            move/rename (admin)
DELETE /api/factory/anchors/{id}            (admin)
POST   /api/factory/halls/{id}/geo-check    store measured GPS error / corrected anchor (admin)

GET    /api/factory/drafts                  list
POST   /api/factory/drafts                  create
GET    /api/factory/drafts/{id}             items + check result + comparison
POST   /api/factory/drafts/{id}/items       add/move/rotate/remove
DELETE /api/factory/drafts/{id}/items/{n}
POST   /api/factory/drafts/{id}/check       outline, obstacles, overlaps, aisle clearance, doors
POST   /api/factory/drafts/{id}/compare     transport metres and walk time, before vs after
POST   /api/factory/drafts/{id}/submit      worker → office
POST   /api/factory/drafts/{id}/apply       admin: writes stations, floor revision, audit
POST   /api/factory/drafts/{id}/reject      admin, with reason
POST   /api/factory/floors/{id}/revisions/{rev}/restore   admin

/api/agent/*                                as in agentlab/README.md, plus `context`
```

### 6.3 Pure core additions

- `core/geo.py`: lat/lon ↔ hall metres, point-in-outline with tolerance (Python twin of
  `sites.ts`, parity fixture like the pathfinder's).
- `core/layout_check.py`: a station rectangle (rotated) against outline, obstacles, other
  stations, minimum aisle width along the aisle graph, door swing/clear zone; returns typed
  findings with severity, never a bare boolean. Used by the draft check and mirrored in
  TypeScript for instant feedback while dragging (parity fixture).
- `core/align.py` (and `web-shared/align.ts`): two point pairs → yaw + translation
  (scale fixed), residual in metres; n ≥ 3 pairs → least squares. Fixture-tested.

## 7. AR — the real hall through the camera

### 7.1 Session

`navigator.xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test", "local-floor"],
optionalFeatures: ["anchors", "dom-overlay", "light-estimation", "depth-sensing",
"camera-access"] })`, three.js `WebXRManager`, the scene from `web-shared/twinScene.ts`.
Capability report on the diagnostics page; without AR the mode button explains why and offers
the walk mode.

### 7.2 Coordinate chain

`plan (x east-ish, y south, metres)` → `scene (x, elevation, z = y)` → **alignment transform
A (yaw θ about up, translation t; scale 1)** → `XR local-floor space`. A is the only thing AR
adds. Everything already drawn in the 3D hall is drawn in AR by parenting the scene root
under A.

### 7.3 Alignment procedures (in order of quality)

1. **Floor marker, two taps (default).** Scan an anchor QR (identifies it and gives plan x, y,
   heading). The app shows a reticle from hit-test on the floor: tap the marker centre, then
   the tip of its printed arrow. Two point pairs → A. Residual shown; > 15 cm asks to repeat.
2. **Two anchors.** Scan and tap anchor 1, walk, scan and tap anchor 2. Longer baseline, better
   yaw; recommended before placing machines.
3. **Two known points without markers.** Pick two plan points (a column corner, a gate post)
   and tap them in the camera. For a hall without printed markers.
4. **Automatic marker pose** (upgrade, behind the spike): WebXR raw camera access gives the
   image and intrinsics; the QR corners plus the known printed size give the marker pose
   (four-point PnP in TypeScript). No taps. Only if M0 shows it is stable.

Each alignment is stored on the device per floor with time and residual, and an XR anchor is
created at the marker so ARCore keeps correcting it.

### 7.4 Drift budget

Distance walked since the last alignment is integrated from the pose. Past a threshold
(default 25 m, setting) the state goes `stale`, overlays turn to outline style and the nearest
anchor is suggested with a direction arrow. Passing any anchor and scanning it re-aligns in
two taps. This is why anchors belong on aisle nodes and at doors.

### 7.5 What AR shows (read)

- **Stations** as footprint outlines on the floor plus a label card: name, state, queue
  minutes, running job, last material. Full ghost model on demand (a solid model over the real
  machine hides it).
- **Zones and aisles** as floor lines; **doors/gates** named.
- **Navigation:** a line on the floor along the aisle graph to a station, an order's next
  station, a storage location; remaining metres; arrival haptic. Stairs/lift hand over to the
  next floor ("oben neu ankern").
- **Robots:** live pose from `/api/factory/robots` with the existing staleness flags; planned
  route as a floor line; "Position unbekannt" stays unknown.
- **Material flow:** today's flow edges as animated floor lines, thickness by volume.
- **Tap a station** → sheet with worklist and actions; **look at a QR** → scan sheet.
- **Measure:** two taps → metres; three or more → area; result can be attached to a draft.
- **X-ray levels:** the floor above or below as a faint ghost (existing ghost-level idea).

### 7.6 Tabletop and scaled modes — essential for Musterwerk

Musterwerk is fictional: there is no 64 × 32 m hall to stand in. Two modes make the demo plant
walkable anyway, and stay useful for real plants (planning in a meeting room):

- **Tisch:** place the whole hall on a table at 1:100…1:20 (pinch to scale, twist to turn).
  All overlays work; placing machines works with snap; levels stack or fan out.
- **Maßstab frei:** drop the hall on any open ground (yard, car park) at 1:1, origin and
  heading by two taps. GPS can pre-align it outdoors (`coarse`), taps refine it. This is the
  honest way to "really walk" a plant that does not exist yet — the greenfield case.

## 8. Rundgang — the theoretical walk

First person through the twin without being there; no AR, works on any phone and on the
desktop (`/app` gets the same component).

- **Movement:** left thumb joystick, right thumb look; or tap a floor point to walk there along
  the aisles; or "magic window" (gyroscope turns the view as the phone turns). Eye height
  1.65 m, speed 1.2 m/s default, walls and obstacles block (collision against outline and
  obstacle polygons), doors pass.
- **Guided walks:** follow an order from storage through its stations to shipping; follow a
  robot job; follow the material flow of the day; walk "my shift" (the tasks of my station in
  order). Each shows metres and minutes and can be paused at every stop.
- **Time scrubber:** planned time band now; replay of a past shift once the event spine
  exists (backlog P9). The UI keeps planned and actual visibly different.
- **Floors:** stairs and lift doors are portals between levels (30 m estimate as in routing,
  labelled estimated). Between halls: outside walk over the map anchors, labelled estimated.
- **Draft walk:** switch between "Ist" and a layout draft while standing in the same spot;
  changed stations glow, removed ones are outlines.
- **Meeting mode:** one device leads, others follow the leader's camera (pose over the SSE bus
  on a per-session channel, LAN only, nothing stored). Later slice.
- **Capture:** a walk can be saved as a list of waypoints with notes (text only) and attached
  to a draft or sent to the copilot ("fasse die Engstellen zusammen").

## 9. Planen — placing machines

- **Catalogue:** the existing built models (plotter, waterjet, punch, rack, packing table,
  workbench, desk, generic) with default footprints, plus every uploaded station model, plus
  "copy of an existing station". Editable footprint (w × h) and height.
- **Place:** in AR the reticle carries the ghost on the detected floor; in walk and map mode
  it follows the crosshair. Drag to move, twist to rotate (15° steps, free with a second
  finger), snap to the floor's `snap` (0.25 m) and to edges of neighbours and walls.
- **Live check** while dragging (TypeScript mirror of `core/layout_check.py`): red on overlap,
  outside outline, on an obstacle; amber when an aisle gets narrower than the minimum or a
  door zone is touched; the reason is written out.
- **Move an existing station:** long-press its footprint → becomes a draft move; the original
  stays visible as an outline.
- **Position quality is recorded per item.** A machine placed while `stale` is marked `≈` and
  the office sees that.
- **Compare:** `POST /drafts/{id}/compare` runs the existing routing and material-flow
  calculation on the draft layout: transport metres per day, walking time, affected orders,
  findings from `twin_analysis` — before versus after, with the same estimated/measured
  language as the twin.
- **Submit → apply:** a worker or staff member submits; an admin applies on the desktop or
  phone. Apply snapshots the floor (`factory_floor_revisions`), writes stations through the
  same validation as `PUT /stations`, writes one audit line per station, and is restorable.
  Machine values of a new station are 0 = unknown until someone enters them.
- **Copilot in planning:** "stell einen zweiten Plotter neben Plotter 1, 2 m Abstand" creates
  draft items through the tools in D4; the result appears as ghosts to accept or drop.

## 10. Security and privacy summary

- TLS on the LAN with a constrained local CA; private keys 0600 in the data folder.
- Pairing codes single-use, 120 s, hashed at rest, in the URL fragment.
- Device sessions revocable; station binding and `allowed_station_ids` close backlog P7.
- No new CORS origin, no inline script, no CDN, no WASM.
- Model key on the server only; test for leaks; QR text and scan results are data to the model.
- Camera frames: QR decoding and AR happen on the device. Frames go to the server only for
  Teileerkennung (existing, in memory) and, if switched on, to the copilot provider with a
  confirmation each time.
- Position stays on the device; the copilot gets it only while its sheet is open; nothing
  stores a track. GPS permission is asked when the map is first opened, with the reason.
- Rate limits on `/api/mobile/pair` and `/api/mobile/scan` (reuse `pin_guard` pattern).
- LAN exposure is a real change from `127.0.0.1`: the plan requires the `--lan` flag, prints
  what is exposed, and README/SECURITY notes get the HTTPS-on-LAN section they still lack.

## 11. Work packages for the building agent

Order matters; each package ends green on `tools/check-all.sh`. Sizes S/M/L as in the backlog.

**M0 — Spike on the real phone (S, throwaway branch).**
A static test page behind a temporary self-signed certificate: WebXR session, hit-test,
anchors, DOM overlay, `BarcodeDetector`, geolocation accuracy indoors/outdoors, raw camera
access. Measure: two-tap alignment residual, drift after a 30 m loop back to the marker, frame
rate with the Musterwerk scene.
Pass: session starts; residual ≤ 15 cm; loop drift ≤ 0.5 m; ≥ 30 fps. Fail → appendix A.
Output: a short findings note with the device model and Chrome version. Needs the owner's phone.

**M1 — LAN mode and certificates (M).** `gimel serve --lan`, local CA, onboarding listener,
cookie `Secure` by scheme, `Permissions-Policy`, CSP additions.
Tests: certificate SANs and name constraints, re-issue on IP change, onboarding listener
serves nothing but the three resources, security headers test extended, public-IP refusal.

**M2 — Pairing and devices (M).** Tables, routes, desktop dialog with QR, device list, revoke,
station binding, `allowed_station_ids(user)` applied to station/worklist/task routes (P7).
Tests: code single-use and expiry, wrong scope rejected by `current_user`, revoke ends the
session, worker cannot touch a foreign station.

**M3 — `web-shared/` extraction (M).** Move API client, types, `sites.ts`, pathfinder, models
and a new `twinScene.ts` out of `web/`; `web/` imports them; no behaviour change.
Tests: all existing `web/*.test.mjs` unchanged and green; bundle size of `/app` not larger
than +2 %.

**M4 — Mobile shell (M).** `web-mobile/` at `/m`: manifest, service worker, login/pair/PIN,
bottom navigation, `bootstrap`, `useLive` with SSE + polling, offline read cache, wake lock,
diagnostics. `check-all.sh` builds it and runs its tests.
Tests: Playwright with a phone viewport: pair flow against mocked API, offline banner, no
write queued silently, CSP violations = 0.

**M5 — Work screens (L).** Heute, Arbeitsvorrat, Station, Kommissionierung, Bereitstellen,
Versand, lookups; task events published to the bus (P8).
Tests: start/pause/done round trip, undo window, role-hidden data never requested.

**M6 — QR for real (M).** Encoder, signed payloads, SVG route, replace the placeholder on the
traveller, station/storage/anchor print sheets, scanner component, `/api/mobile/scan`.
Tests: encoder against known vectors, signature reject, scan→action matrix per role, printed
HTML has no inline script.

**M7 — Copilot on the phone (M/L).** Backend merge behind `agent_enabled`, `context`,
new tools, `client_action`, phone sheet, Alef `_moved.py`.
Tests: moved agent tests green in `tests/app`, key-leak test, context rendered as data,
unknown client action dropped, write tools refuse without the switch, drafts-only on mobile.

**M8 — Map and positioning (M).** 2D map, D5 state machine, GPS → hall, "Ich stehe hier",
anchors CRUD in the floor editor, anchor scan sets position, hall geo-check, aisle navigation.
Tests: geo parity fixture (Python/TypeScript), inside-outline with accuracy, floor never
derived from GPS, state transitions.

**M9 — Rundgang (M/L).** First-person controller, collision, tap-to-walk on the aisle graph,
guided walks (order, robot job, flow, shift), floors as portals, also mounted in `/app`.
Tests: collision cases from fixtures, guided walk metres equal the server route metres,
Playwright smoke with WebGL.

**M10 — Layout drafts (L).** Tables, routes, `core/layout_check.py` + TypeScript mirror,
compare, submit/apply/reject, floor revisions and restore (P11), desktop review page.
Tests: check findings fixtures with parity, apply is atomic and audited, restore writes a new
revision, stale base snapshot → 409.

**M11 — Planen in map and walk mode (M).** Catalogue, place/move/rotate/snap, live check,
quality flag per item, compare view.

**M12 — AR view (L).** Session, alignment 1–3, drift budget, read overlays, navigation line,
tap-to-open, measure, tabletop and free-scale modes.
Tests: alignment maths fixtures, drift state machine, WebXR emulation smoke; a manual device
checklist in `docs/` (ten steps in Halle-1 tabletop and one real-room 1:1 run).

**M13 — Planen in AR (M).** Hit-test placement feeding the same draft items; ghosts; accept
from copilot proposals.

**M14 — Later slices.** Automatic marker pose, meeting mode, copilot images, local speech,
shift replay (after P9), reasons and actual minutes (P4), station sessions (P12), Alef rollout
through the existing LAN gate.

Suggested first milestone the owner can hold in the hand: **M0 → M1 → M2 → M3 → M4 → M6
(scan only) → M8 (map) → M9 (walk)**. Copilot (M7) can run in parallel after M4. AR (M12)
follows once drafts (M10) exist, so that placing has somewhere safe to write.

## 12. Risks

| Risk | Effect | Answer |
|---|---|---|
| Phone not ARCore-certified or WebXR unstable | no AR in the browser | M0 gate; walk and tabletop-less map still deliver; appendix A |
| Installing a CA on Android is fiddly (Settings → Security → install certificate) | onboarding friction | one guided page with screenshots per Android version; USB `adb reverse` for the first demo |
| LAN IP changes | installed app and pairing sheets point nowhere | DHCP reservation hint, optional local name, QR payloads are host-independent |
| Drift in a long hall, reflective floors, moving forklifts | overlays slide | drift budget, anchors every ~20 m, outline style when stale |
| GPS indoors is poor | wrong hall | accuracy circle, ask on ambiguity, never a floor, geo-check |
| Steel bends the compass | wrong heading on the map | heading is a hint; AR yaw only from alignment |
| SQLite single writer with more clients | short blocks | writes stay small; no position writes at all; agent in the same process removes one writer process |
| Agent merge touches the live schema | Alef risk | additive tables only, setting default off, Alef suite before merge |
| `ThreeFloorPlan.tsx` refactor regressions | desktop twin breaks | M3 is behaviour-neutral with the existing Playwright tests as the guard |
| Worker tracking concerns | trust, legal | position stays on device (§3), written into the settings page |
| Esri imagery terms | commercial use | unchanged from `CLAUDE.md`; mobile uses the same per-hall switch |

## 13. Decisions for the owner

1. **Web app with WebXR first, native shell only if M0 fails** — recommended (D1).
2. **Local CA and `gimel serve --lan`** as the way a phone reaches standalone Gimel —
   recommended; it is the first deliberate step off `127.0.0.1` for standalone.
3. **Merge the Agent Lab backend into the Gimel process now**, UI later — recommended; the
   alternative (second origin on 8008) needs CORS and a second certificate path.
4. **QR encoder:** vendored in `render/qr.py` (no dependency, ~300 lines to own) or `segno`
   (one small pure-Python dependency) — recommended: `segno`.
5. **Position never stored server-side** — recommended as a hard rule.
6. **Copilot may edit drafts only from the phone**, live stations stay with the desktop tools
   — recommended.
7. **Which phone** (model, Android and Chrome version) for M0, and whether a real room or yard
   is available for the 1:1 test.
8. Anchor sheets on the floor (sticker, walked on) or on walls/columns at 1.5 m — floor
   markers make the two-tap alignment simplest; wall markers survive longer.

## Appendix A — native fallback for AR

Kotlin app, single activity: a WebView on `https://<ip>:8443/m` (the CA is trusted through
the app's network security config, which also removes the manual CA install) and one native
AR screen with ARCore + SceneView. ARCore Augmented Images tracks the printed anchor sheets
automatically (no taps), Depth improves occlusion. The web app asks for AR through a small
JavaScript bridge (`openAr({floorId, draftId})`); the native screen reads the same REST
routes and writes the same draft items. Models: export the built device models once to GLB
(`GLTFExporter` from `deviceModels.ts`) and serve them next to uploaded station models.
Cost: a second code base for one screen, sideloaded APK, signing key custody. Not ARCore
Cloud Anchors or Geospatial: both need Google cloud and break LAN only.

## Appendix B — files the building agent will touch first

```text
gimel/cli.py                     --lan, certificate bootstrap
gimel/lan.py                     (new) local CA, server cert, onboarding listener
gimel/app.py                     /m mount, headers, routers
gimel/routers/auth.py            cookie Secure by scheme
gimel/routers/mobile.py          (new) pairing, devices, bootstrap, scan, qr
gimel/routers/drafts.py          (new) layout drafts, revisions
gimel/routers/agent.py           (moved) + context, client_action
gimel/services/agent_*.py        (moved from agentlab/)
gimel/render/qr.py               (new) real QR; render/plate.py uses it
gimel/core/geo.py, align.py, layout_check.py   (new, pure)
gimel/models.py, gimel/seed.py   new tables, ADDED_COLUMNS, demo anchors in demo.py
web-shared/                      (new) extracted TypeScript
web/                             imports web-shared; pairing dialog; draft review; walk
web-mobile/                      (new) the phone app
tools/check-all.sh               builds and tests web-mobile
tests/app/test_lan.py, test_mobile_pairing.py, test_scan.py, test_drafts.py, test_agent.py
tests/core/test_geo.py, test_align.py, test_layout_check.py  (+ parity fixtures)
README.md, CLAUDE.md             LAN/HTTPS section, mobile rules
alef: app/_moved.py              mobile, drafts, agent routers
```


---

# PART 2 — Build spec

## Spec: AR and Copilot inside the Gimel phone app

Status: build specification, 2026-11-16. Nothing here is built.
Parent: `docs/plan-mobile-ar.md` (the whole mobile plan). This document details two parts of
it far enough to build from: **the AR view** and **the copilot**, both inside the phone app
(`web-mobile/`, served at `/m`).
Decision taken by the owner on 2026-11-16: the copilot is already merged into Gimel **on
another machine**; the app integrates it now and **may talk to a different endpoint** for it.

## 1. Scope and assumptions

In scope:

- An AR mode in the app's "Werk" screen: the twin through the camera, aligned to the real
  floor, tabletop and free-scale variants, navigation, and placing machines into a draft.
- A copilot sheet available on every screen including AR, talking to a configurable endpoint.
- The glue between both: the copilot knows where the user stands and can point at things.

- A free walk (§11): first person through the twin without AR, on any phone and on the desktop.

Out of scope here (see the parent plan): pairing, LAN certificates, work screens, QR printing,
guided walks. AR depends on two of them and says so in §5.1.

**The merged copilot is not in this checkout.** This spec is written against the Agent Lab
contract in `agentlab/README.md` and `agentlab/router.py` at commit `08be871f`:

| Assumed | Source |
|---|---|
| Base path `/api/agent`, Bearer access token as in the main API | `router.py` |
| `POST /chats` `{title, provider_id?, model?, write_mode}` | `ChatCreate` |
| `POST /chats/{id}/messages` `{content ≤ 20000, route ≤ 200, attachment_ids}` answers `text/event-stream` | `MessageIn` |
| Frames are `event: <type>\ndata: <json>\n\n`; types `start, delta, reasoning, assistant, tool_call, tool_result, error, done` | `_sse`, `runner.py` |
| `GET /config` → `{configured, provider, admin}`; `GET /health` → `{ok: true}`; `GET /tools` → role-filtered catalogue | `router.py` |
| The model key is never in a response | `providers.py` |

Work package C0 (§8) probes the real machine and records every difference before any UI is
written. Where the merged version already has more (a `context` field, client actions), the
app uses it; where it does not, the fallbacks in §4.6 and §4.7 apply. **The app must work
against the unchanged Agent Lab contract.**

## 2. Target structure

```text
web-shared/                       plain TypeScript, no React, imported by web/ and web-mobile/
  api/client.ts                   token, refresh, ApiError (from web/src/api.ts)
  api/endpoints.ts                the endpoint registry (§3)
  twin/twinScene.ts               scene builders extracted from ThreeFloorPlan.tsx (§5.2)
  twin/deviceModels.ts …          moved unchanged
  geo/align.ts                    plan ↔ XR alignment maths (§5.4)
  geo/position.ts                 position state machine (parent plan D5)
  nav/pathfind.ts                 aisle pathfinder (from web/src/factory.ts)
  layout/check.ts                 placement checks, mirror of core/layout_check.py

web-mobile/src/
  copilot/
    copilotApi.ts                 chats, stream reader, cancel, revert
    copilotStore.ts               one store: chats, running stream, errors
    CopilotSheet.tsx              the sheet (normal screens)
    CopilotOverlay.tsx            the same content inside the WebXR DOM overlay
    context.ts                    builds the context object and its text fallback
    actions.ts                    closed list of client actions + executor
    ToolCard.tsx, ChangeRow.tsx
  ar/
    capability.ts                 feature detection and the reasons shown to the user
    ArSession.ts                  session lifecycle, renderer, frame loop (no React)
    ArView.tsx                    React shell: start button, overlay root, HUD
    hitTest.ts                    reticle from XRHitTestSource
    alignment.ts                  procedures: marker two-tap, two anchors, two points
    drift.ts                      walked distance, stale state
    overlays/stations.ts          footprints, ghosts
    overlays/labels.ts            DOM-overlay labels projected per frame
    overlays/navigation.ts        floor path line
    overlays/robots.ts            live poses
    place/PlaceController.ts      catalogue ghost on the reticle, move, rotate, snap, check
    tabletop.ts                   scale/rotate gestures, free-scale placement
    measure.ts
  werk/WerkScreen.tsx             mode switch: Karte | AR | Rundgang | Planen
```

## 3. Endpoints: one registry, different hosts allowed

```ts
// web-shared/api/endpoints.ts
export interface Endpoints {
  core: string;     // "" = same origin as the app → /api/…
  copilot: string;  // "" = same origin → /api/agent; or "https://192.168.1.20:8443"
  copilotPath: string; // default "/api/agent"
  copilotMode: "same-origin" | "relay" | "direct";
}
```

Resolution order: device override (Mehr → Verbindung, stored in `localStorage`
`gimel-endpoints`) → server answer `GET /api/mobile/bootstrap` (`copilot: {mode, url}`) →
default same origin. Every copilot request goes through `copilotUrl(path)`; no other file
builds a copilot URL.

Three modes, in the order the agent should build them:

**A. `same-origin`** — the copilot lives in the Gimel the app was loaded from. Nothing to do.

**B. `relay`** (recommended while the copilot is on another machine) — the app calls its own
origin at `/api/copilot/*`; Gimel forwards to the other machine.

- New `gimel/routers/copilot_relay.py`, active only when `<PREFIX>COPILOT_UPSTREAM` is set
  (for example `https://192.168.1.20:8443`). Forwards method, path below `/api/agent`, query,
  JSON or multipart body and the `Authorization` header with `httpx.AsyncClient.stream`;
  streams the answer back unbuffered (`X-Accel-Buffering: no`, no gzip on
  `text/event-stream`). Hop-by-hop headers and cookies are dropped in both directions.
- Upstream TLS is verified against `<PREFIX>COPILOT_CA` (a file); plain `http://` upstream is
  accepted only for private addresses and logged as a warning at start.
- Limits: body 16 MiB (attachments are 15 MB), connect 5 s, idle read 120 s, one stream per
  user. Private addresses are allowed on purpose (same reasoning as `agentlab/providers.py`);
  the upstream comes from the environment, never from a request.
- Why it is the default: the phone trusts one certificate, needs no CORS, and an HTTPS page
  cannot call an `http://` endpoint at all (mixed content). A relay removes all three issues.

**C. `direct`** — the app calls the other machine itself. Needs, on that machine:
HTTPS with a certificate the phone trusts, and CORS: `<PREFIX>CORS_ORIGINS=https://<app-host>:8443`
(the existing `CORSMiddleware` already allows all methods and headers, exposes
`WWW-Authenticate`). The app's CSP must list the host: `connect-src 'self' <copilot origin>`,
set from the bootstrap value, never a wildcard. Use for development only.

**Identity across endpoints.** The copilot checks the same JWT as the core
(`gimel/security.py`): signed with `secret.key`, session row looked up by `sid`.

- Same data folder and key on both sides (the merged Gimel *is* the Gimel, or shares its
  database): the app's token works, nothing to do. On `401` from the copilot the client
  refreshes once against **core** and retries.
- Different key or database: the token is rejected. The app then shows "Copilot: eigene
  Anmeldung nötig" and signs in against the copilot endpoint separately
  (`POST {copilot}/api/auth/login` or `/pin`), keeping that token under its own storage key
  `gimel-copilot-token`. Roles and audit actors are then the copilot machine's accounts — the
  sheet shows which account is active. No token is ever copied between machines by the app.

C0 determines which of the two cases is real.

## 4. Copilot integration

### 4.1 Client API

```ts
// web-mobile/src/copilot/copilotApi.ts
getConfig(): Promise<{ configured: boolean; provider: ProviderInfo | null; admin: boolean }>
getTools(): Promise<ToolInfo[]>                       // cached per session; drives fallbacks
listChats(): Promise<ChatSummary[]>
createChat(init?: { title?: string; write_mode?: boolean }): Promise<Chat>
getChat(id: number): Promise<ChatWithMessages>
patchChat(id: number, patch: { title?: string; write_mode?: boolean; model?: string }): Promise<Chat>
deleteChat(id: number): Promise<void>
send(id: number, body: { content: string; route: string; context?: CopilotContext },
     onEvent: (e: StreamEvent) => void, signal: AbortSignal): Promise<void>
cancel(id: number): Promise<void>
revertChange(chatId: number, changeId: number): Promise<void>
revertMessage(chatId: number, messageId: number): Promise<void>
```

`send` is a `fetch` POST read with `ReadableStream` + `TextDecoder`, split on blank lines,
`event:`/`data:` parsed exactly as `agentlab/web/src/api.ts:318` does (it is a POST, so
`EventSource` cannot be used and no SSE ticket is needed). Rules:

- Unknown event types are ignored, not errors (forward compatibility).
- A stream that ends without `done` is shown as "Verbindung abgebrochen" with the partial
  text kept and a "Erneut senden" button; the client then calls `getChat` to learn what the
  server stored.
- `AbortSignal` on the stop button, followed by `cancel(id)`.
- Leaving the app (page hidden > 30 s) aborts the read but not the run; on return the chat is
  reloaded.

### 4.2 Store

One store (`copilotStore.ts`, `useSyncExternalStore`, no new dependency):
`{ status: "unknown"|"unconfigured"|"unreachable"|"auth"|"ready", chats, activeChatId,
messages, stream: { running, text, reasoning, tools[] } | null, writeMode, error }`.
Only one stream at a time. The store survives screen changes and entering/leaving AR, so a
running answer continues while the user switches to the camera.

### 4.3 Sheet

- Floating button bottom right on every screen, hidden while a blocking dialog is open.
  Badge when an answer finished out of sight.
- Sheet heights: peek (input + last line), half, full. Swipe or handle; a visible close
  button for gloves.
- Header: chat title, model name (read-only on the phone), account if it differs from core,
  **write switch** ("Schreibzugriffe erlauben", default off, state from the chat), chat list.
- Messages: assistant text as plain text with a small safe formatter (bold, lists, code,
  line breaks — no HTML injection, no remote images); `reasoning` collapsed behind
  "Überlegung", never stored.
- Tool cards: one line (`German label · summary`), expandable preview; writes are marked;
  not-revertable tools carry the warning from the catalogue. Labels from
  `agentlab/web/src/toolLabels.ts` moved to `web-shared`, raw name as the fallback.
- After a write: a change row with **Rückgängig** (`revertChange`); `409` is shown as the
  server's explanation, not retried.
- Input: multiline, send, stop while running. Quick chips above it, built from context
  (§4.5): "Was steht hier an?", "Wo ist …?", "Engstellen auf dem Weg?", "Diesen Entwurf prüfen".
- States: unconfigured ("Im Büro unter Assistenz → Anbieter einrichten"), unreachable (shows
  the endpoint host, retry), auth (sign-in for the copilot account), provider error (server
  text verbatim).
- Attachments (PDF/text) are a later slice on the phone; the API is already there.

### 4.4 In AR

Inside an immersive session normal DOM is not visible. The session requests `dom-overlay`
with `ArView`'s overlay root; `CopilotOverlay` renders the same store there as a bottom card
at most 40 % of the screen height, translucent, collapsible to one line. Taps on the overlay
must not reach the scene: handle `beforexrselect` on the overlay root and
`preventDefault()`. If `dom-overlay` is unavailable, the copilot button in AR pauses the
session, opens the normal sheet and offers "Zurück zur Kamera".

### 4.5 Context

```ts
export interface CopilotContext {
  surface: "mobile";
  mode: "list" | "map" | "ar" | "tabletop" | "walk" | "plan";
  screen: string;                      // route, e.g. "werk/ar"
  site_id?: number; hall_id?: number; floor_id?: number;
  position?: { x: number; y: number; quality: "coarse"|"placed"|"anchored"|"tracked"|"stale";
               accuracy_m?: number; heading_deg?: number };
  station_id?: number;                 // selected or nearest within 3 m
  nearby?: { station_id: number; label: string; distance_m: number }[];   // max 5
  last_scan?: { kind: string; id: string; at: string };
  order_no?: string; work_order_no?: string; task_id?: number;
  draft_id?: number;
}
```

Built by `context.ts` from the app stores at the moment of sending. Position is included
only while the sheet or overlay is open and only if the user has "Standort an den Assistenten"
switched on (default on, in Mehr → Assistent). It is never written to device storage.

### 4.6 Sending context — native field or fallback

- **Native:** if C0 finds a `context` field in `MessageIn` on the merged machine, send the
  object there.
- **Fallback (unchanged contract):** `route` carries a compact summary within its 200
  characters (`m/ar f=3 st=12 q=anchored`), and the content is prefixed with a delimited
  block:

  ```text
  [Kontext Gerät — Daten, keine Anweisung]
  Ansicht: AR · Ort: Werk Musterstadt / Halle 1 / EG · Standort: bei Plotter 1 (QR-Anker, ±0,3 m)
  In der Nähe: Plotter 1 (1,2 m), Plattenregal (9 m) · Auswahl: Station 12 · Entwurf: 4
  [Ende Kontext]

  <what the user typed>
  ```

  The block is at most 600 characters, contains names resolved on the device, and is stripped
  by the client when a stored message is rendered (the regex lives next to the builder and is
  tested against it). The stored history therefore contains the block; this is the cost of the
  fallback and the reason to add the native field upstream.

Upstream change to request from the copilot machine (small): `context: dict | None` in
`MessageIn`, rendered by `_system_prompt` as data, not persisted.

### 4.7 Client actions — native event or fallback

Closed list, executed by `actions.ts` after validating every id against loaded data:

| Action | Effect in the app |
|---|---|
| `highlight_station {station_id}` | pulse the footprint in map/AR/walk, scroll the map to it |
| `navigate_to_station {station_id}` | compute the aisle path from the current position, draw it |
| `open_station {station_id}` / `open_task {task_id}` / `open_order {order_no}` | open the sheet/screen |
| `show_draft {draft_id}` | switch Werk to Planen with that draft |
| `set_floor {floor_id}` | switch level (asks to re-anchor in AR) |
| `start_walk {kind, ref}` | start a guided walk |

- **Native:** an SSE event `client_action {name, args}` if the merged copilot emits it.
- **Fallback:** the client derives *offers* from `tool_result` events of known read tools:
  a result that names exactly one station yields chips "Zeigen" and "Hinführen"; one order
  yields "Öffnen". The mapping table (`tool name → extractor`) is built from `GET /tools` at
  start; unknown tools yield nothing. In the fallback **nothing happens without a tap** —
  only the native event may act immediately, and even then never a write and never leaving AR.
- Anything not on the list, or with an id the app does not know, is dropped and logged to the
  diagnostics page.

### 4.8 Rules

- The model key is never requested, shown or stored by the app; provider settings are not
  editable on the phone at all.
- Scan results, QR text, station notes and tool output shown in the sheet are text. The app
  never turns them into actions except through §4.7.
- Write mode is per chat and visible at all times; switching it on shows what it means once
  per chat. From the phone, layout changes go to **drafts** only (parent plan D4) once the
  draft tools exist upstream; until then the phone hides nothing the server allows, and the
  role filter of the server stays the only authority.
- No microphone use, no browser speech recognition (cloud). Keyboard dictation is the user's.

### 4.9 Tests

- Stream parser: split frames across chunks, multi-line `data:`, unknown event, missing
  `done`, invalid JSON → fixtures as byte arrays.
- Context block: build → strip round trip; length cap; no position when the switch is off.
- Actions: unknown name dropped, unknown id dropped, fallback never auto-executes.
- Endpoint registry: three modes produce the right URLs; `401` refresh-once-then-retry.
- Relay (pytest): streams without buffering (first byte before upstream closes), forwards
  `Authorization`, drops cookies, refuses when unset, limits enforced, no key in any response.
- Playwright (phone viewport, mocked copilot): send, stop, tool card, revert, unreachable,
  unconfigured; CSP violations = 0.

## 5. AR integration

### 5.1 Preconditions

- **Secure context.** `navigator.xr` exists only on HTTPS or localhost. On the LAN that is the
  certificate work in the parent plan (M1); for development `adb reverse tcp:8040 tcp:8040`
  and `http://localhost:8040/m`.
- **Device:** Android with Google Play Services for AR and Chrome. `capability.ts` reports
  each of: secure context, `navigator.xr`, `isSessionSupported("immersive-ar")`, WebGL2,
  then per session the granted features. Every "no" has a German sentence and a next step;
  the AR button is never simply missing.
- **Data:** `GET /api/factory/topology`, `/floor?floor_id=`, `/stations`, `/robots`,
  `/robot-jobs`, `/flow` — all existing, all worker-readable. Anchors (`/api/factory/anchors`)
  and drafts come from the parent plan (M8, M10); without them AR offers two-point alignment
  (§5.5, procedure 3) and read-only overlays, so **AR read mode can be built before either**.
- Headers: `Permissions-Policy: camera=(self), xr-spatial-tracking=(self), geolocation=(self)`.

### 5.2 Scene refactor (prerequisite, behaviour-neutral)

`ThreeFloorPlan.tsx` builds its scene inside React effects and renders labels with
`CSS2DRenderer`, a `requestAnimationFrame` loop and `OrbitControls`. None of the three works
in an immersive session. Extract into `web-shared/twin/twinScene.ts`:

```ts
buildFloor(floor: Floor, opts): THREE.Group          // slab, outline, walls, zones, obstacles, doors
buildStations(stations: Station[], status, opts): { group: THREE.Group; byId: Map<number, THREE.Object3D> }
buildAisles(floor: Floor, opts): THREE.Group
buildFlow(edges: FlowEdge[], stations, opts): THREE.Group
buildRobots(robots: Robot[]): { group; update(nowMs: number, sampledAt: string): void }
labelAnchors(stations, robots): { id: string; text: () => LabelData; position: THREE.Vector3 }[]
disposeTree(root: THREE.Object3D): void
```

All builders return objects in **scene metres**: plan `(x, y)` → scene `(x, elevation, y)`,
station rotation negated, exactly as today. No renderer, camera, controls or DOM inside.
`ThreeFloorPlan.tsx` becomes a consumer; `web/twin-load.test.mjs` and the other web tests
stay green unchanged. Options carry a `style: "desktop" | "ar"`: in AR the slab and walls are
omitted (the real floor is there), footprints are thin emissive outlines, colours come from a
fixed AR palette with high contrast instead of CSS variables.

### 5.3 Session lifecycle (`ArSession.ts`)

```ts
const session = await navigator.xr!.requestSession("immersive-ar", {
  requiredFeatures: ["hit-test", "local-floor"],
  optionalFeatures: ["anchors", "dom-overlay", "light-estimation", "depth-sensing"],
  domOverlay: { root: overlayRoot },
});
renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.toneMapping = THREE.NoToneMapping;          // camera image must stay untouched
await renderer.xr.setSession(session);
renderer.setAnimationLoop(onFrame);                  // not requestAnimationFrame
```

- Must be started from a user gesture (the "AR starten" button).
- Scene graph: `scene → alignRoot (the alignment transform, §5.4) → twinRoot (builders)`;
  reticle, placement ghost in hand and measure markers live directly under `scene` in XR
  coordinates until committed.
- `onFrame(time, frame)`: update hit-test → reticle; update robots; update drift; project
  labels; render. No allocation per frame in these paths.
- End: `session.end()` on the close button, on `visibilitychange` hidden, on route change.
  On `end`: stop the loop, dispose renderer and trees, release the wake lock, keep the
  alignment in memory for 10 minutes so a quick return can offer "Ausrichtung übernehmen?"
  (valid only if the user re-anchors; tracking origins differ per session, so the stored
  alignment is **not** reused blindly — it only pre-selects the floor and the anchor).
- Tracking loss (`frame.getViewerPose` null or `emulatedPosition`): HUD "Tracking verloren —
  Kamera langsam bewegen", overlays hidden after 1 s, state `stale` after 5 s.
- Wake lock for the session; a thermal/battery hint after 10 minutes.

### 5.4 Alignment maths (`web-shared/geo/align.ts`, pure)

Work in the horizontal plane. Plan point `p = (px, py)`; its scene point is `(px, ·, py)`.
An XR floor point is `q = (qx, qz)`. Find yaw `φ`, scale `k` and translation `t` with
`q = k · R(φ) · p + t`, `R(φ) = [[cos φ, −sin φ], [sin φ, cos φ]]`.

From two pairs `(p1, q1)`, `(p2, q2)`:

```text
a = p2 − p1            b = q2 − q1
φ = atan2(b.z, b.x) − atan2(a.y, a.x)
k_measured = |b| / |a|
t = q1 − k · R(φ) · p1
```

- **1:1 mode:** `k = 1`. `k_measured` is only a quality check: outside 0.97…1.03 the
  alignment is refused ("Die beiden Punkte passen nicht zum Plan: 4,10 m statt 4,00 m").
- **Tabletop/free scale:** `k` is the chosen scale (1/100 … 1), set by gesture, not measured.
- Apply to three.js: `alignRoot.position.set(t.x, floorY, t.z)`,
  `alignRoot.rotation.y = −φ`, `alignRoot.scale.setScalar(k)`. A rotation about +Y in
  three.js turns x toward −z, hence the sign; **a fixture test pins it** (plan east/south
  points against expected XR points for φ = 0°, 90°, −37°).
- `floorY` is the y of the first hit-test tap on the floor (≈ 0 in `local-floor`); for an
  upper level the user stands on that level, so its elevation is *not* added — the level's
  group is placed at y = 0 and other levels are offset relative to it.
- n ≥ 3 pairs: least-squares (2D Procrustes with fixed scale); the function returns
  `{ φ, t, k, residual_m, max_error_m }`.
- Inverse (`xrToPlan`) for placing: `p = R(−φ) · (q − t) / k`.

### 5.5 Alignment procedures (`alignment.ts`)

State machine: `idle → choosing → point1 → point2 → review → aligned`, plus `stale`.

1. **Marker, two taps** (needs anchors, parent M8): scan the anchor QR (camera scanner before
   the session, or the anchor chosen from a list), start AR, the HUD shows the marker's sheet
   as a drawing; tap the reticle on the marker centre (pair 1: anchor `x, y`), then on the
   arrow tip (pair 2: anchor + `arrow_length · (cos h, sin h)` with heading `h` in plan
   axes). Baseline is short (≈ 0.25 m), so yaw is good to about ±2°: enough to look around,
   **not** enough to place machines 30 m away — the HUD says so and offers procedure 2.
2. **Two anchors:** as 1 at the first marker (centre only), walk to a second marker ≥ 5 m
   away, tap its centre. Long baseline, yaw good to a fraction of a degree. Required before
   Planen in 1:1 mode.
3. **Two known points** (no markers needed): pick two plan points on a mini-map in the
   overlay (it snaps to outline corners, column corners, door posts, station corners), then
   tap each in the camera. This is the procedure available from day one.
4. **Tabletop:** tap a table surface; the hall's centre goes there at 1:100, long side toward
   the user. No measurement involved; state is `aligned (Modell)`.
5. **Free scale 1:1:** tap where the plan origin should be, tap a second point for the +x
   direction. Optional pre-alignment from GPS outdoors.

Review step in 1–3: the outline and columns are drawn; the user confirms "passt" or repeats.
After confirming, create an `XRAnchor` at pair 1 (if `anchors` was granted) and re-derive
`alignRoot` from the anchor's pose each frame, so ARCore's corrections move the twin with the
world.

### 5.6 Drift (`drift.ts`)

Integrate horizontal viewer movement per frame (ignore steps > 0.5 m between frames: those
are relocalisation jumps and themselves a reason to go `stale`). Budget from settings
(default 25 m after a marker alignment, 60 m after a two-anchor alignment). On exceeding:
state `stale`, overlays switch to dashed outlines, placement is blocked in 1:1 mode, the HUD
points to the nearest anchor. Tabletop and free scale have no drift budget.

### 5.7 Overlays

- **Stations:** footprint outline on the floor (rotated rectangle `w × h`), colour by state
  with a text label; tap target is an invisible box of station height. Ghost model
  (`buildDeviceModel` / uploaded model, 35 % opacity) only for the selected station or in
  tabletop mode, where all stations are solid.
- **Labels (`overlays/labels.ts`):** `CSS2DRenderer` does not render in an immersive session.
  Labels are DOM elements in the overlay root, positioned every frame by projecting the label
  anchor with the XR camera (`renderer.xr.getCamera()`); hidden behind the viewer, beyond
  25 m, or when more than 12 would show (nearest win). Without `dom-overlay`: canvas-texture
  sprites for the nearest 8. Content: name, state word, queue minutes, running job — the same
  facts as the desktop inspector, with `≈` and `?` kept.
- **Aisles, zones, doors:** thin floor lines, toggled in a layer menu (default: aisles off).
- **Navigation:** path from `web-shared/nav/pathfind.ts` from the current plan position
  (`xrToPlan` of the viewer) to the target's access point; a ribbon 0.3 m wide on the floor
  with moving chevrons, remaining metres in the HUD, recomputed when the user is more than
  2 m off the path, haptic on arrival. Other floor → the path ends at the stairs/lift door
  with "oben neu ankern".
- **Robots:** `buildRobots` under `alignRoot`, poses from `/api/factory/robots` every 2 s
  with the existing `stale`/`position_known` flags; an unknown position draws nothing and
  lists the robot in the HUD instead.
- **Material flow:** optional layer, animated lines along the flow edges.
- **Occlusion:** with `depth-sensing` granted, footprints and ribbons are depth-tested
  against the real scene; without it they simply draw on top. Not required for the first cut.

### 5.8 Interaction

- Screen tap = XR `select`. Raycast from the tap through `alignRoot`: station box → select,
  open the station card in the overlay (queue, running task, actions "Arbeitsvorrat",
  "Hinführen", "Copilot fragen"); empty floor → clear selection.
- Overlay controls: close, layers, level, re-align, measure, copilot, mode (Ansehen / Planen).
- **Measure:** tap points on the floor via the reticle; live distance; three or more points
  give an area; "an Entwurf hängen" stores it as a note on the draft.
- Two-finger gestures are only used in tabletop mode (pinch = scale, twist = rotate, drag =
  move the model); in 1:1 mode the world does not move under the fingers.

### 5.9 Placing machines (`place/PlaceController.ts`)

Requires drafts (parent M10). Until then the controller runs against a **local draft** in
memory that can be exported as JSON — enough to build and test the interaction.

1. Catalogue sheet: built device types with default footprints, uploaded station models,
   "Kopie von <Station>". Pick one.
2. The ghost rides the reticle. Its plan position is `xrToPlan(reticle)`, snapped to the
   floor's `snap` (0.25 m) and, within 0.3 m, to wall and neighbour edges. Rotation: on-screen
   dial in 15° steps, fine mode 1°.
3. Live check through `web-shared/layout/check.ts` every 100 ms: outside outline, on an
   obstacle, overlapping a station (red, cannot drop); aisle narrower than the minimum, door
   clear zone touched (amber, can drop, finding recorded). The reason is written in the HUD.
4. "Absetzen" commits a draft item `{op: "add", type, w, h, x, y, rotation, source: "ar",
   quality}` where `quality` is the position state at that moment; an item placed while
   `stale` cannot be created in 1:1 mode and is marked `≈` in free-scale mode.
5. Existing station: long-press its footprint → "Verschieben" creates a `move` item; the
   original stays as a grey outline with a line to the new place.
6. Undo/redo stack per session; every commit also goes to the server draft when online.
7. "Vergleichen" calls the draft compare route and shows transport metres and findings
   before/after in the overlay; "Einreichen" submits to the office. Nothing in AR ever writes
   a live station.

### 5.10 Performance and quality budget

- Target 30 fps on a mid-range phone with all of Halle 1 EG visible. Musterwerk is small
  (tens of stations); still: merge static floor lines into one geometry, share materials,
  no shadows, pixel ratio capped by the XR framebuffer, labels capped at 12, robots update
  2 s + interpolation, no per-frame allocation.
- AR HUD shows frame rate on the diagnostics toggle; a 5 s average below 20 fps switches
  ghosts off and says so.
- Reduced motion: no chevron animation, no pulses.

### 5.11 Fallbacks

| Missing | Behaviour |
|---|---|
| Not a secure context | explain; link to the connection help; offer Karte and Rundgang |
| No `immersive-ar` | explain (ARCore/Chrome); offer Rundgang, and "Kamera-Vorschau" (2D camera with a compass-oriented mini-map, no overlay claims) |
| No `dom-overlay` | sprite labels, minimal in-scene buttons, copilot via pause |
| No `anchors` | alignment stays fixed to the session origin; drift budget halved |
| No anchors table yet | procedure 3, tabletop, free scale |
| No drafts yet | local draft with JSON export |
| WebGL context lost | end the session with a message; nothing is half-written because commits are items |

## 6. Copilot × AR

- Context (§4.5) in AR carries floor, plan position from `xrToPlan(viewer)`, quality from the
  alignment state, the selected station and up to five nearby stations.
- Quick chips in AR: "Was steht an dieser Station an?", "Führe mich zu …", "Passt hier eine
  zweite Maschine hin?" (sends the measured free rectangle if a measurement is active).
- Actions (§4.7) rendered in AR: `highlight_station` pulses the footprint and shows an edge
  arrow when it is off-screen; `navigate_to_station` draws the ribbon; `show_draft` loads the
  draft's ghosts; `set_floor` asks first because it invalidates the alignment.
- Copilot draft edits (once the draft tools exist upstream) arrive as `tool_result` events;
  the app reloads the draft and shows new items as **proposed** ghosts (blue, dashed) with
  "Übernehmen / Verwerfen" — the copilot proposes, the person standing there decides.
- While a placement ghost is in hand, client actions that change the view are queued until
  the ghost is dropped or cancelled.

## 7. Server changes this spec needs

Minimal, all additive:

1. `/m` mount for `gimel/mobile/dist` (same pattern as `/app`, `/twin` in `gimel/app.py`).
2. `Permissions-Policy` header; CSP `connect-src` extended by the configured copilot origin
   in `direct` mode only.
3. `gimel/routers/copilot_relay.py` + settings `COPILOT_UPSTREAM`, `COPILOT_CA` (§3 B);
   entry in Alef's `app/_moved.py`.
4. `GET /api/mobile/bootstrap` returning at least `{copilot: {mode, url}, features}`.
5. Later, from the parent plan: anchors, drafts, layout check. AR read mode and the copilot do
   not wait for them.

Requested on the copilot machine (not blocking): `context` in `MessageIn`, the
`client_action` event, the draft tools.

## 8. Work packages

Each ends with `tools/check-all.sh` green. C = copilot, A = AR. C and A tracks are independent
after the shell exists.

| # | Package | Result | Acceptance |
|---|---|---|---|
| C0 | Contract probe | `tools/probe-copilot.py <base-url>`: health, config, tools, a chat, one streamed message; writes `docs/copilot-contract.md` with every difference to §1, and whether the core token is accepted | run against the other machine by the owner; report committed |
| C1 | Endpoint registry + relay | §3 modes A and B, settings, tests | relay streams first byte < 1 s after upstream; no CORS needed from the phone |
| C2 | Client API + store | §4.1, §4.2 | parser fixtures green; stop and resume behave as specified |
| C3 | Sheet | §4.3 | Playwright flows green at 390 × 844; usable one-handed |
| C4 | Context + actions | §4.5–4.7 with both native and fallback paths | round-trip and drop tests green |
| C5 | Separate copilot sign-in | only if C0 shows different accounts | token kept apart; sheet names the account |
| A0 | Device spike | static page: session, hit-test, anchors, DOM overlay, two-point alignment residual, 30 m loop drift, fps | numbers recorded in `docs/ar-device-findings.md`; gate from the parent plan M0 |
| A1 | Scene extraction | §5.2 | existing web tests unchanged and green |
| A2 | Session + capability + tabletop | §5.1, §5.3, procedure 4, labels | Musterwerk Halle 1 stands on a table, labels readable, 30 fps |
| A3 | Alignment 1:1 | §5.4, procedures 3 and 5, review, XR anchor | fixture tests; residual ≤ 15 cm in a room test |
| A4 | Read overlays + interaction | §5.7, §5.8, drift | station tap opens the card; navigation ribbon follows the aisle path |
| A5 | Copilot overlay in AR | §4.4, §6 | ask in AR, answer visible, highlight works |
| A6 | Placement on a local draft | §5.9 steps 1–6 | place, move, rotate, undo; checks match the Python fixtures |
| A7 | Markers and server drafts | procedures 1–2, §5.9 step 7 | after parent M8 and M10 |

Suggested order for a first thing to hold: **C0 → A0 → C1 → C2 → C3 → A1 → A2 → A3 → A4 →
C4 → A5 → A6**.

## 9. Device test checklist (manual, kept in the repo with A2)

1. Open `/m` over HTTPS; diagnostics show secure context, WebXR, AR supported.
2. Tabletop: start, tap a table, hall appears; pinch to 1:50; labels follow.
3. Tap Plotter 1: card shows queue; "Copilot fragen" opens the overlay with context.
4. Ask "Was steht hier an?"; a tool card appears; answer names Plotter 1.
5. Stop a long answer; partial text stays; no second stream starts.
6. Free scale in a room: two taps, outline appears; walk 5 m, outline stays within a hand.
7. Two-point alignment on two real corners 4 m apart; residual shown ≤ 15 cm.
8. Navigate to Wasserstrahl: ribbon follows aisles, metres count down, haptic at arrival.
9. Planen: place a plotter next to Plotter 1; overlap turns red and cannot be dropped; move
   0.5 m; drop; undo.
10. Cover the camera 6 s: "Tracking verloren", then `stale`; re-align clears it.
11. Lock the phone and return: session ended cleanly, chat still there.
12. Switch the copilot endpoint to an unreachable host: sheet says unreachable with the host
    name; the rest of the app works.

## 10. Open points

1. **Result of C0:** is the merged copilot the same Gimel (same key and accounts) or a
   separate one? Decides whether C5 exists.
2. **Relay or direct** for daily use — recommended: relay.
3. Does the merged copilot already have `context`, `client_action` or draft tools?
4. Phone model and Chrome version for A0.
5. Minimum aisle width and door clear zone for the placement check (suggest 1.2 m and 1.0 m
   as editable factory settings; today no such value exists).

## 11. Free walk (Freier Rundgang)

First person through the twin, moving wherever the user wants, with no camera and no AR
support needed. It is the mode that always works: any phone, any browser with WebGL, the
desktop `/app`, and a plant that does not physically exist (Musterwerk). It shares the scene
builders (§5.2), the labels, the station card, navigation, placement and the copilot with AR;
only the camera and the input differ.

### 11.1 Files

```text
web-shared/walk/
  WalkController.ts      camera rig, movement integration, modes (no React, no DOM)
  collision.ts           circle vs. polygons with sliding (pure)
  portals.ts             stairs, lift, gates: level and hall changes
  input.ts               normalised intent {move: Vec2, look: Vec2, run, up, down} from any source
web-mobile/src/walk/
  WalkView.tsx           renderer, HUD, joysticks, minimap
  TouchSticks.tsx        two virtual sticks
  Minimap.tsx
web/src/pages/…          the same WalkController mounted in /app with keyboard and mouse
```

### 11.2 Rendering

A normal `THREE.WebGLRenderer` with `PerspectiveCamera` (FOV 70° portrait / 60° landscape,
near 0.05 m, far 400 m), `twinScene` builders in style `"walk"`: slab, walls at the floor's
real `height_m` (not the 0.85 m stub of the desktop view), a simple ceiling grid that can be
switched off, zones as floor tint, doors as openings with a name, solid device models, robots
live. Hemisphere light plus one directional light, no shadows; fog from 60 m keeps depth
readable. Labels through `CSS2DRenderer` are fine here (no immersive session), with the same
12-label cap and 25 m range as AR.

### 11.3 Movement modes

| Mode | Eye height | Collision | Who | Use |
|---|---|---|---|---|
| **Gehen** (default) | 1.65 m (setting 1.2–2.0) | walls, obstacles, stations | all | how the hall feels on foot |
| **Fahren** | 1.2 m, 2.5 m wide body | as Gehen, wider radius | all | forklift/AGV clearance check |
| **Fliegen** | free, 0.5 m … ceiling + 30 m | outline only | all | overview, look over machines |
| **Geist** | free | none | staff, admin | look inside, through walls, between levels |

Speeds: 1.4 m/s walk, 3 m/s run (stick pushed fully or Shift), 2 m/s driving, 6 m/s flying.
Acceleration and damping over 150 ms so starts and stops are not abrupt; reduced-motion
setting removes head bob (off by default anyway) and shortens transitions to cuts.

### 11.4 Input

- **Touch:** left stick moves (forward/back/strafe), right half of the screen drags to look;
  the right stick appears where the thumb lands. Two buttons for up/down in Fliegen and Geist.
  Double-tap on the floor walks there by the shortest free path (aisle graph when the target
  is far, straight line when visible).
- **Gyroscope look ("Fenster")**, optional switch: the view follows the phone's orientation
  (`DeviceOrientationEvent`; needs a secure context and, where the browser asks, a permission
  prompt from a tap). Yaw offset is recalibrated by a "Geradeaus" button; a drag adds to it.
- **Desktop:** WASD/arrow keys, mouse look with pointer lock on click, Shift run, Space/C
  up/down, F toggles Fliegen, M minimap, Esc releases the pointer.
- **Gamepad** if present (`navigator.getGamepads`): standard mapping, no configuration.
- All sources feed `input.ts`; the controller never reads events itself, so tests drive it
  with recorded intents.

### 11.5 Collision (`collision.ts`, pure)

The walker is a circle of radius 0.3 m (Gehen) or 1.25 m (Fahren) in plan coordinates.
Blocking geometry per floor, built once: outline edges (inward), obstacle polygons, station
footprints (rotated rectangles), minus door openings (`doors[]` position and `width` cut a
gap into the outline edge they sit on). Each step: move, find penetrations, push out along
the smallest normal, keep the tangential part (sliding along walls). Sub-step when a frame
moves more than half the radius. Spatial grid of 2 m cells so a frame tests a handful of
edges. Outside the outline is not walkable in Gehen/Fahren except through a gate, where the
walker reaches the **yard** (§11.7).

Fixtures: corridor between two stations, a column, a door of exactly body width (Fahren must
not pass a 2.4 m door), a concave corner, a 100 ms frame at run speed (no tunnelling).

### 11.6 Levels and portals (`portals.ts`)

Doors named "Treppe"/"Aufzug" (demo) or of kind `stairs`/`lift` (a new optional `kind` value
on door entries, additive JSON) are portals. Standing in one shows "Nach oben · 1. OG" /
"Nach unten · KG"; confirming moves the walker to the portal with the same name on the target
level of the same hall, with a 400 ms fade. Without a matching portal the walker lands at the
level's first aisle node and the HUD says so. Fliegen and Geist change level by height: past
the ceiling the level above becomes the active one. The level switcher in the HUD jumps
directly and keeps x/y if that point is inside the target outline.

### 11.7 Between halls

Through a gate the walker stands in the yard: a flat ground with the map tiles of the site if
the hall has `map_enabled` (same per-hall switch and attribution as the desktop), otherwise a
plain grid. Other halls of the site stand at their map-anchor offset (`hallOffset`,
`rotation_deg`) as full buildings; walking into one through its gate makes it the active
hall. A hall without a map anchor is not placed; the hall switcher teleports there instead.
Yard distances are labelled estimated, as in routing.

### 11.8 HUD

- Minimap (top right, tap to enlarge): floor plan, walker with view cone, stations, robots,
  target; tap on it = "hierhin gehen", long-press = teleport.
- Bottom: mode, level, layers (labels, aisles, flow, robots, ceiling), speed, "Fenster".
- Top left: place name (site / hall / level / zone under the feet), metres walked, time.
- Crosshair in the centre; what it rests on is named ("Plotter 1 · 4,2 m").
- Search: type a station, order or material → a route ribbon on the floor (same
  `overlays/navigation.ts` as AR) or instant teleport, user's choice.

### 11.9 Interaction

- Tap or click a station → the same station card as in AR (queue, running job, actions,
  "Copilot fragen").
- **Measure** with the crosshair: mark points on floor, walls or machines; distance, height
  and area.
- **Bookmarks:** save the current pose with a name, per device; share as a link
  `/m#/werk/walk?f=<floor>&x=…&y=…&h=…&yaw=…&pitch=…` that opens the same view elsewhere on
  the LAN.
- **Path recording:** record the walked line with metres and seconds; show it on the map;
  attach it as a note to a draft ("so läuft der Werker heute"). Stored on the device unless
  attached.
- **Screenshot** of the view (canvas to PNG, device only).
- **Follow:** stand "on" a robot or follow a guided walk from the parent plan, and break out
  into free movement at any moment.

### 11.10 Planning in the free walk

`PlaceController` (§5.9) works unchanged with the crosshair's floor hit instead of the AR
reticle: choose from the catalogue, the ghost stands where the crosshair meets the floor,
rotate, live check, drop into the draft with `source: "walk"` and quality `Modell` (a
position chosen in the model is exact in the plan, so no `≈`). Switch "Ist / Entwurf" while
standing still to compare. Fahren mode through a drafted layout is the quickest clearance
test: where the wide body cannot pass, the HUD names the pinch point and its width.

### 11.11 Copilot in the free walk

Context (§4.5) with `mode: "walk"`, the walker's floor and plan position (quality
`Modell`), the station under the crosshair and the nearest five. Actions: `highlight_station`
and `navigate_to_station` as in AR; additionally `teleport_to_station {station_id}` (lands
3 m in front of the station, facing it), executed immediately only from the native event,
offered as a chip in the fallback. The sheet is the normal `CopilotSheet` at peek height;
movement input is ignored while the text field has focus.

### 11.12 Performance and comfort

Same budget as §5.10; the frame loop pauses when the page is hidden. Pixel ratio capped at 2.
Comfort defaults: no head bob, no camera roll, FOV fixed, level changes fade, teleports cut.
A "ruhig" preset halves speeds and look sensitivity.

### 11.13 Tests and packages

- Unit: collision fixtures (§11.5), portal resolution, input → intent mapping, controller
  integration over recorded intents (deterministic with a passed-in `dt`), deep-link parse.
- Playwright: open the walk with mocked Musterwerk data, hold "forward" for 3 s, assert the
  position moved and stopped at a wall; switch level through the stairs; open a station card.
- Parity: walked distance along a double-tap path equals the pathfinder's metres.

| # | Package | Acceptance |
|---|---|---|
| F1 | `WalkController`, collision, touch and keyboard input, Gehen/Fliegen, HUD basics | walk Halle 1 EG end to end without passing a wall; fixtures green |
| F2 | Levels, portals, yard and second hall, minimap, search and route, bookmarks | stairs to 1. OG and back; walk from Halle 1 to Halle 2 through the gates |
| F3 | Fahren, Geist, gyroscope look, gamepad, measure, path recording | a 2.4 m door blocks Fahren and is named as the pinch point |
| F4 | Placement and copilot in the walk, Ist/Entwurf switch, desktop mount in `/app` | place and compare a draft without AR; ask the copilot about the station in view |

F1 needs only A1 (scene extraction). It can ship before any AR package and is the fallback
every AR "no" in §5.11 points to. Updated first-thing order:
**C0 → A1 → F1 → F2 → C1 → C2 → C3 → A0 → A2 → A3 → A4 → C4 → A5 → F3 → F4 → A6**.

## 12. Navigation from phone sensors and GPS (no camera needed)

Goal: the blue dot moves with the user through the plant and turn-by-turn guidance works with
the phone in the hand or pocket, without AR. AR tracking (§5) stays the most precise source;
this is the one that is always on. Everything runs on the device; nothing is sent or stored
(§3 of the parent plan).

### 12.1 What a browser on Android gives us

| Sensor | API | Rate | Good for | Weakness |
|---|---|---|---|---|
| GNSS | `navigator.geolocation.watchPosition({enableHighAccuracy: true})` → lat, lon, `accuracy`, sometimes `speed`, `heading` | ~1 Hz | absolute position outdoors, which hall, yard walks | 3–10 m outside, 10–50 m or nothing inside; no floor |
| Accelerometer | `DeviceMotionEvent.accelerationIncludingGravity` / `LinearAccelerationSensor` | 50–60 Hz | step detection, standing vs. walking | needs gait, fooled by shaking |
| Gyroscope | `DeviceMotionEvent.rotationRate` / `Gyroscope` | 50–60 Hz | smooth turning, short-term heading | drifts a few degrees per minute |
| Orientation | `deviceorientationabsolute` / `AbsoluteOrientationSensor` (fused with magnetometer) | 50–60 Hz | absolute heading (north) | bent by steel, motors, racks — common in a hall |
| Magnetometer | `Magnetometer` (often behind a permission/flag) | 10 Hz | detecting magnetic disturbance | not everywhere available |
| Barometer | not exposed to web pages | — | floor changes | **unavailable**; floor comes from portals, QR or the user |
| Wi-Fi / BLE scan | not exposed to web pages | — | indoor fixes | **unavailable** in the web app; native shell only (appendix of the parent plan) |

All need a secure context; motion and orientation may need a permission prompt started by a
tap. `sensors/capability.ts` reports each one with rate and a plain sentence; missing sensors
degrade the mode, they never block it.

### 12.2 Files

```text
web-shared/nav/
  sensors.ts        subscriptions, unit normalisation, timestamps, permission flow
  steps.ts          step detector and step length (pure)
  heading.ts        gyro/compass fusion with disturbance detection (pure)
  pdr.ts            dead reckoning: steps + heading → displacement (pure)
  gnss.ts           lat/lon → hall metres, gating by accuracy (uses geo/…)
  mapmatch.ts       particle filter on outline, obstacles and aisle graph (pure)
  fusion.ts         one estimator: sources in, PositionEstimate out
  guidance.ts       route → manoeuvres, progress, off-route, arrival (pure)
web-mobile/src/nav/
  NavScreen.tsx     map with dot, cone, uncertainty, next manoeuvre
  Calibrate.tsx     step length and compass check
```

Pure modules take time stamps as arguments; tests replay recorded sensor logs.

### 12.3 The estimator

State: floor id, position (x, y) in plan metres, heading, and an uncertainty — represented by
a **particle filter** (300–500 particles, each x, y, heading bias, step-length factor).
A particle filter is chosen over a Kalman filter because the strongest indoor information is
not a measurement but a constraint: *people do not walk through walls or machines.*

Per detected step:

1. **Predict.** Each particle moves `step_length × its factor` in direction
   `fused heading + its bias`, with noise (length ±10 %, heading ±5°).
2. **Constrain.** A particle whose move crosses the outline, an obstacle or a station
   footprint (same geometry as `walk/collision.ts`) is killed. Particles within 1.5 m of an
   aisle edge get a mild bonus (people mostly use aisles, not always).
3. **Correct**, when a source arrives:
   - **QR anchor scan:** all particles reset to the anchor ± 0.3 m; heading bias reset if the
     anchor is a floor marker with an arrow and the user confirms facing it.
   - **AR alignment/tracking** (§5): position ± 0.1 m and heading — the filter simply follows.
   - **GNSS:** weight by a Gaussian around the fix with σ = max(reported accuracy, 5 m);
     ignored when accuracy > 30 m, when the fix is outside every hall + yard by more than its
     accuracy, or indoors when the last anchor is younger than 60 s (the anchor is better).
   - **Manual "Ich stehe hier":** reset ± 2 m.
   - **Portal:** standing still at a stairs/lift door for 3 s offers "Ebene wechseln?"; on
     confirm the cloud moves to the matching portal on the new level.
4. **Resample** when the effective particle count drops below half; inject 5 % particles
   around the last GNSS fix outdoors so the filter can recover from a wrong start.

Output every 200 ms: `PositionEstimate {floor_id, x, y, heading_deg, radius_m (68 %),
quality, sources[]}`. `radius_m` is the real spread of the particles — it grows while walking
blind and collapses at an anchor, and it is what the map draws. Quality maps onto the ladder
of the parent plan (D5): `anchored` right after a scan, `tracked` while radius ≤ 2 m,
`coarse` while radius ≤ 15 m or GNSS only, `stale` above that — then guidance stops giving
turn instructions and asks for a scan.

### 12.4 Steps and step length (`steps.ts`)

- Gravity-aligned vertical acceleration, band-pass 0.7–3 Hz, peak detection with adaptive
  threshold and a 250 ms refractory time; a step needs a matching valley (rejects single
  knocks). No steps while the phone lies flat and still.
- Step length: Weinberg model `k · (a_max − a_min)^(1/4)` per step, `k` personal.
  Default from body height (setting, optional) or 0.7 m.
- **Calibration** (`Calibrate.tsx`, two minutes, optional but worth it): walk between two
  QR anchors or along a marked aisle of known length; `k` is solved from the counted steps
  and stored on the device. Every later pair of anchor scans refines `k` silently
  (exponential average, bounded 0.5–1.0 m).
- Fahren (forklift, cart): no steps. Mode switch "Ich fahre" uses GNSS speed outdoors and,
  indoors, only anchors and manual updates — said plainly in the HUD.

### 12.5 Heading (`heading.ts`)

- Short term: integrate gyroscope yaw (projected on gravity) — smooth and immune to steel.
- Long term: pull toward the absolute heading with a slow complementary filter (time
  constant 20 s) **only while the compass is trusted**.
- Trust test: field strength within 25–65 µT and stable inclination when the magnetometer is
  available; otherwise agreement between compass change and gyro change over the last 5 s
  within 10°. Untrusted → gyro only, and the HUD cone widens.
- Absolute heading has to be turned into plan axes: plan heading = compass heading (true
  north; apply the device's declination where only magnetic is given) − hall `rotation_deg`
  convention of `hallToWorld`. A fixture pins the sign for 0°, 90° and the demo's 8°.
- Phone pose: heading is the walking direction, not where the screen points. In the hand the
  device's forward axis is used; in the pocket the direction of the step acceleration over
  the last 3 steps. If neither is stable, the per-particle heading bias absorbs the offset
  and map matching sorts it out within a few metres of walking.
- Outdoors while moving > 1 m/s, GNSS course over ground corrects the bias directly.

### 12.6 GNSS (`gnss.ts`)

- `watchPosition` with high accuracy while a navigation or the map is open; stopped when the
  app is hidden. Battery note in settings.
- Conversion through the hall anchor (`lat`, `lon`, `rotation_deg`) as in the parent plan D5;
  the site's halls are tested in turn; yard coordinates use the site anchor.
- Indoor/outdoor guess: accuracy trend (worsening sharply = went inside), last portal/gate
  crossed in the filter, and whether the cloud is inside an outline. The guess only changes
  how GNSS is weighted.
- "Hallenlage prüfen" (parent plan) is a precondition for trusting GNSS near walls; unchecked
  halls use σ = max(accuracy, 15 m).

### 12.7 Guidance (`guidance.ts`)

- Route from the pathfinder (aisle graph, portals between levels, yard between halls) from
  the estimate to a station, anchor, order's next station, storage place or a map point.
- Manoeuvres derived from the polyline: "in 12 m links", "durch Tor Versand", "Treppe ins
  1. OG", "Ziel rechts". Shown as a large arrow, the distance and the street-name equivalent
  (zone and aisle), plus remaining metres and minutes at the user's measured pace.
- Progress: project the estimate onto the route; advance only when the projection moves
  forward with radius ≤ 5 m. **Off-route** when the estimate is more than max(4 m, radius)
  from the route for 5 s → reroute. Arrival within 2 m or on scanning the target's QR.
- Uncertainty is part of the instruction: with radius > 5 m the arrow is replaced by "weiter
  Richtung Zuschnitt · Standort ungenau — nächsten Anker scannen", and the nearest anchor on
  the way is marked.
- Feedback: vibration patterns (one short = turn ahead, two = turn now, long = arrived, three
  = off route) via `navigator.vibrate`; optional spoken instructions with
  `speechSynthesis` **only if an offline voice is installed** (`voice.localService`),
  otherwise silent — no cloud speech.
- Screen may be off in the pocket: browsers throttle sensors for hidden pages, so guidance
  holds a wake lock and dims the UI to a black "Taschenmodus" screen with large-touch unlock.
- Hand-over: starting AR mid-route reuses the same route as the floor ribbon (§5.7);
  leaving AR feeds the last AR pose into the filter as an anchor.

### 12.8 Map display

Dot with heading cone (cone width = heading uncertainty), translucent disc = `radius_m`,
dot style by quality (parent plan D5 table). A small strip names the active sources
("Schritte · Kompass gestört · GPS 18 m · Anker vor 40 s"). Map follows and rotates with the
heading or stays north-up (toggle).

### 12.9 Copilot

`position` in the context (§4.5) comes from the estimator with its quality and `accuracy_m`.
`navigate_to_station` starts guidance from the estimate; with quality `stale` the copilot's
action first asks for an anchor scan.

### 12.10 Accuracy to expect — stated in the app's help

| Situation | Typical error |
|---|---|
| Just scanned an anchor | 0.3 m |
| Walking 20 m of aisle after an anchor, calibrated step | 1–2 m, shrinking again at each turn the map explains |
| 60 m without anchor, compass disturbed | 3–6 m; guidance asks for a scan |
| Yard, open sky | 3–8 m |
| Inside, GNSS only | which hall, not more |

Anchors at doors, aisle crossings and every ~20–25 m keep the hall walk inside 2 m. The
filter makes the map do the rest.

### 12.11 Tests and packages

- Unit, from recorded logs (`web-shared/nav/__fixtures__/*.jsonl`: timestamped accel, gyro,
  orientation, GNSS, scans; recorded once with a small logger page from N1): step count within
  ±3 % on three walks; heading drift without compass < 5°/min; particle filter never places
  the estimate inside an obstacle; a walk along the Musterwerk Halle 1 centre aisle on
  synthetic data ends within 2 m; GNSS gating cases; guidance manoeuvre extraction and
  off-route logic; heading sign fixture.
- Synthetic generator: walk a polyline in the plan, emit ideal sensor streams plus noise and
  a magnetic disturbance zone — makes Musterwerk testable without a real hall.
- Device checklist additions (§9): 13. calibrate step length between two markers; 14. walk a
  40 m L-shaped route with the phone in the pocket, dot ends within 3 m; 15. hold the phone
  next to a steel column, source strip shows "Kompass gestört" and the dot does not swing;
  16. walk outside between two points, GPS takes over, hall is recognised on entering.

| # | Package | Acceptance |
|---|---|---|
| N1 | Capability, permission flow, sensor logger page, fixtures recorded | logs from the owner's phone committed (no position data from real premises: yard or synthetic) |
| N2 | Steps, heading, PDR | step and drift criteria above |
| N3 | GNSS conversion and gating, hall recognition | parity with `core/geo.py`; floor never from GNSS |
| N4 | Particle filter, fusion, anchors and portals as corrections | synthetic Halle 1 walk within 2 m; never inside an obstacle |
| N5 | Guidance, NavScreen, haptics, Taschenmodus | manoeuvres correct on three demo routes including a level change |
| N6 | Calibration, AR hand-over, copilot wiring | step length converges within ±5 % after two anchor pairs |

N1–N3 need only the shell and the map; N4 needs anchors (parent M8) for the real hall, and
works on synthetic data before that. Order with the rest:
**C0 → A1 → F1 → F2 → N1 → N2 → N3 → C1 → C2 → C3 → N4 → N5 → A0 → A2 → A3 → A4 → C4 → A5 →
N6 → F3 → F4 → A6**.

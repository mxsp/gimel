# Plan: Gimel Mobile — phone on the LAN, copilot, QR, positioning, AR and the walkable twin

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

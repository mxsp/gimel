# Gimel Mobile — plan (roadmap task 53)

2026-11-16 · status: **plan, waiting for go-ahead; docs phase done, no code** · Disruption 4/10

Docs for the coding agent: `Gimel/docs/mobile/` — served at **http://127.0.0.1:8091/** (start with `llms.txt`).

Owner, 2026-11-16: "detail a plan for the gimel mobile app, an app to properly access gimel via
local ip, foundation is already laid but I want to use the copilot/agent in the app and I want to
use my mobile device as AR to digital walk the factory using mobile sensors and gps to digital
design and real AR walk the factory" — and: "one plan is already existing in the github but github
is old and has legacy agent and 3d code in mxsp/all".

## Basis of this plan

- Written against **local Gimel `main` @ cb5cdc52** (plus 10 uncommitted auth files), not GitHub.
- **The GitHub plan could not be read.** `git fetch` in `~/Desktop/mxsp-all` fails ("Invalid
  username or token"), `gh` is not installed, the GitHub connector and the browser pane are not
  signed in. The local clone (state 2026-11-06, all branches) holds no mobile plan and no mobile
  code. Step 0 reconciles the two once the owner signs in or names the branch/file.
- mxsp/all is 2026-11-06 at best: modal `AgentPopup` instead of `CopilotDock`, no Twin Studio
  round two, no walk across halls/levels, no voice. Nothing from there is reused as code.

## What already exists (the foundation)

| Piece | Where | State |
|---|---|---|
| LAN HTTPS with own CA | `fyrefly-ops/lan-gate/lan-gate.mjs`, kali2 :8443 (live), :8447 (Musterwerk) | live; SANs include `kali2.fritz.box`, `kali2.local`, the IP |
| Phone layout | `web/src/usePhone.ts` (≤ 720 px), Leitstand phone tabs, dock as bottom sheet | exists, not complete on every page |
| Copilot dock + page context | `web/src/components/agent/` (`CopilotDock`, `twinContext.ts`), `agentlab/page_context.py` | task 38 A+B done; C–H partly (`show_in_view`, `twin_tools.py` exist) |
| Voice | `agentlab/speech.py`, `transcribe.py`, `voice_router.py`, `web/src/voiceInput` | local recognition (faster-whisper), read-aloud, Live mode |
| Walk mode ("Begehen") | `ThreeFloorPlan.tsx` (walk, collision, `walkHalls.ts`, `walkLevels.ts`), touch stick fallback | desktop-first, pointer lock; touch works without lock |
| Geo anchor | `FactorySite.lat/lon`, `FactoryHall.lat/lon/rotation_deg/map_enabled`, floors in metres, levels | exists; map off by default |
| Camera in the browser | Teileerkennung, MediaPipe (WASM, CSP `wasm-unsafe-eval`) | exists |
| 3D stack | three 0.187 (WebXR built in), `renderQuality.ts`, `frameBudget.ts`, `staticMerge.ts` | exists |

**Missing:** installable app shell, pairing, long-lived phone session, `Permissions-Policy` for
camera/sensors on the Gimel app (only Agent Lab sets `microphone=(self)`), any sensor or AR code,
any positioning, the Copilot on the *live* Gimel (task 52: kali2 runs a2b91dff without Agent Lab).

## Objective

One Gimel app on the phone, reached over the LAN only, that

1. opens like an app, stays signed in, and shows the screens a person needs while standing in the hall;
2. has the Copilot one thumb away, by voice, knowing where in the hall the user stands and looks;
3. walks the twin three ways: **digital** (twin on screen, phone as window), **located** (own
   position on the plan while walking the real hall), **AR** (twin drawn over the camera at 1:1);
4. lets the owner **design on site**: measure, capture corners and ways, place or move a planned
   machine where they stand — always as a proposal first.

## Decisions that shape everything

**D1. Native Android APK for the Pixel 8 (owner 2026-11-16: "i want to build an apk, google pixel 8").**
Kotlin + Jetpack Compose + ARCore, with a WebView for the portal screens that already exist. A
Trusted Web Activity cannot verify a LAN-only host with a private CA, and Android WebView has no
WebXR AR, so a pure web shell cannot do the AR walk. Native owns sign-in, Copilot and voice,
positioning and AR; the WebView shows Heute, Aufträge, Lager, Leitstand and the digital walk.
Sideloaded, no store. Build spec: `Gimel/docs/mobile/ANDROID-APK.md`. The Pixel 8 is ARCore
certified (depth-from-motion, no LiDAR, no UWB). This PC has `adb` but no JDK/Android SDK yet.

**D2. Use the hostname, not the bare IP.** `https://kali2.fritz.box:8443` is already in the
cert. The WebView's cookies, storage and camera grants hang on the origin, and an IP can change
with DHCP. Needs a DHCP reservation for kali2 in the
FRITZ!Box and the name in `<PREFIX>ALLOWED_HOSTS`. The IP stays as fallback.

**D3. GPS is the coarse layer, never the indoor position.** Inside a steel hall GPS is 5–30 m
off or absent and the compass is bent by machines. So:

| Layer | Source | Good for | Accuracy |
|---|---|---|---|
| Site/hall pick, yard walk | GPS + hall anchor (`lat/lon/rotation_deg`) | "you are at Halle 2", outdoor outline survey | 3–10 m outdoors |
| Heading for the digital walk | gyroscope (DeviceOrientation), compass only as first hint | phone as window into the twin | drift, re-centre button |
| Indoor position | ARCore/ARKit visual-inertial tracking, **anchored by markers** | AR overlay, on-site design | cm–dm near a marker, drifts ~1–2 % of the walked distance |
| Re-anchor | printed QR marker at a known hall point, or two tapped reference points | corrects drift | cm |

Markers are the honest answer to "where am I in the hall": Gimel prints an A4 QR per station or
pillar (id + hall x/y/level + facing), the app re-aligns each time one is seen. No beacons, no
UWB, no extra hardware in v1.

**D4. AR draws a light scene, not the full twin.** `ThreeFloorPlan.tsx` (5 200 lines, shadows,
sky, ambient life) is not loaded in AR. A new `ArScene` reuses the geometry builders
(`stationModel.ts`, `deviceModels.ts`, `marks.ts`, routes) at a lite quality level: footprints,
outlines, labels, status, paths; full models only for *planned* objects.

**D5. Position is not tracked.** Camera frames never leave the phone. The position lives in the
page and goes to the Copilot only as hall-local metres with the per-message context switch; never
WGS84, never stored, no per-person trail. A recorded walk is an explicit action by the user. This
is the lawyer gate (employee location data, DSGVO Art. 5/6, § 26 BDSG).

**D6. On-site design writes proposals.** Everything placed in AR is a draft (`whatif_*` first);
saving goes through the existing write switch, collision check and change register.

## Steps

Each step is usable and checkable on the Musterwerk demo (`:8040`, via `:8447` on the phone) alone.

### 0. Reconcile and check the device (½ day, no code)
- Read the GitHub plan (owner signs in or names it); list what it wanted that this plan lacks.
- Real phone on the LAN: CA installed, `https://kali2.fritz.box:8447/app` opens without warning,
  `ArCoreApk.checkAvailability()`, depth support, sensor permissions, camera, `adb` debugging on.
- **Done when:** a one-page capability note for the owner's phone exists in the vault.

### A. App shell and access (2–3 days)
- Gradle project `Gimel/mobile-android/` (Compose shell: bottom bar Heute · Aufträge · Halle ·
  Copilot · Mehr); the portal runs in a WebView that trusts the FyreFly LAN CA through the app's
  network security config. Toolchain first: JDK, Android SDK (owner's OK to install).
- No offline copy of API or customer data; `allowBackup=false`, `FLAG_SECURE` on order screens.
- Pairing: the desktop portal shows a QR under Konto → "Telefon koppeln" with the server URL and a
  one-time code (60 s, single use); the phone scans, signs in with the user's own second factor.
  No password in a QR, no shared device account.
- Phone session: device-bound, listed and revocable under Konto ("Geräte"), re-auth by fingerprint/face
  (`BiometricPrompt`) after idle; least-privilege roles of task 46 apply unchanged.
- Headers: `Permissions-Policy: camera=(self), microphone=(self)` on the portal so the WebView
  can run Teileerkennung and dictation; sensors, location and AR are native. CSP unchanged.
- Connection state: clear "nicht im Hausnetz" screen instead of a spinner; stale data marked.
- **Done when:** the debug APK is installed on the Pixel 8 over `adb`, opens the demo portal,
  survives a restart signed in, a revoked device is out within one request, a device outside the LAN gets nothing.
  Gates: security-advisor (pairing, session, service worker scope), designer-advisor (375 px).

### B. The core screens on the phone (3–4 days)
- Audit all pages at 375 px; fix what a person in the hall needs first: Heute, Auftrag,
  Arbeitsliste/Station, Lager (where is which plate), Leitstand tabs, Teileerkennung with the
  phone camera, scan a Laufkarte/QR to open the order or station.
- Thumb reach, 44 px targets, no hover-only controls, safe-area insets, dark hall / bright yard.
- **Done when:** the tasks above run one-handed on the phone; axe clean; `tools/check-all.sh` green.

### C. Copilot in the app (3 days; live use depends on task 52)
- Copilot tab = `CopilotDock` full screen, plus a floating talk button on every screen
  (hold to talk → local transcription → answer read aloud; "Live" for hands-free).
- New context block `position` (schema in `page_context.py`, capped, marked as data): hall,
  level, x/y in metres, heading, nearest three stations with distance, mode (digital/located/AR),
  accuracy. Off switch per message as today.
- `show_in_view` gains mobile actions: `guide_to` (station/point → path on the plan and in AR),
  `highlight` in AR, `open_station`. Unknown actions refused server-side as today.
- Photo to the Copilot ("what is wrong with this part?") only if the configured provider takes
  images; resized on the phone, never stored; lawyer note in the provider text. Optional.
- **Dependency:** the live Gimel has no Agent Lab (task 52). Until 52-A ships, the mobile Copilot
  runs on Musterwerk only. Recommend deciding 52 together with this plan.
- **Done when:** standing at a station on the demo: "Was steht hier an?" by voice answers for
  that station; "Führ mich zur Säge" draws the way. Gates: security (context reaches the model),
  lawyer (position and photos to a provider).

### D. Digital walk on the phone (2–3 days)
- `MobileWalk`: the existing walk logic (`walkStep`, collision, halls, levels) with a phone
  control set — left stick, look by **gyroscope** (phone as a window, re-centre button), tap a
  station to open it, teleport by tapping the minimap, lift/stairs between levels.
- Lite render profile for phones via `renderQuality.ts` (no shadows, merged statics, capped
  pixel ratio); target ≥ 30 fps on the owner's phone, battery and heat checked over 10 minutes.
- **Tabletop AR** as the early AR win (ARCore plane hit-test): place the whole hall as a 1:100 model on
  a desk, walk around it, tap stations. Needs no positioning at all.
- **Done when:** the demo plant is walkable on the phone by tilt and stick across two halls and
  levels; tabletop model stands stable on a table.

### E. Located walk: my position on the plan (3 days)
- `core/geo.py` (pure): WGS84 ↔ hall metres from the hall anchor and `rotation_deg`; the web
  mirror in `web/src/mobile/geo.ts`; tests with known points.
- "Ich-Punkt" on the 2D plan and minimap: GPS outdoors (with its accuracy circle shown), inside
  the hall only after an anchor (marker scan) and then dead-reckoned by AR tracking; the app
  says plainly which source it is using and how sure it is. No fake precision.
- Marker printing: Admin → Halle → "Marker drucken" (A4 PDF per station/pillar, id + pose);
  `FactoryMarker` table (hall, level, x, y, height, facing) through `ADDED_COLUMNS`/new table,
  no change to existing columns.
- Site/hall auto-pick from GPS when the user opens Halle.
- **Done when:** walking the real yard moves the dot within GPS accuracy; scanning a marker snaps
  it to the station; the nearest-station list in the Copilot context is right.

### F. AR walk: the twin over the real hall (5–7 days, the big one)
- ARCore session (plane finding, hit-test, Augmented Images for markers, optional Depth for
  occlusion), native `ArScene` per D4, alignment by marker (one marker = position + facing) or
  two tapped floor points; re-anchor silently whenever a marker is seen; drift indicator.
- Layers the user can switch: station footprints and names · status and queue ("3 Aufträge,
  nächster 14:20") · findings from the twin analysis · robot and material ways on the floor ·
  **planned** machines and robots from Twin Studio as full models at true scale · safety zones.
- Tap a station in AR → the same sheet as on the plan; talk button stays on top (native overlay).
- Occlusion and lighting are not promised: overlays are drawn on top, with outlines so they read.
- **Done when:** in a real room with two printed markers, footprints sit within 10 cm at the
  marker and within 30 cm after 20 m; a planned machine can be judged against a real doorway.
  Gates: designer (legibility on camera image), security (no frame leaves the device).

### G. Design on site (4–5 days)
- **Measure:** AR tape between two taps; result can be attached to a station or note.
- **Survey:** walk to hall corners / pillars / doors and tap → points in hall metres → proposed
  outline or correction of the Grundriss (diff shown on the plan before saving).
- **Ways:** record a walked path as an aisle/way proposal (explicit start/stop, D5).
- **Place and move:** pick a machine from the catalogue (task 39) or an existing station, put it
  on the real floor, rotate, see collisions and flow metres before/after (`whatif_move_station`),
  save as a proposal; the office accepts it in Twin Studio.
- **Notes:** photo + text pinned to a hall position, shown on the plan (stored only on save,
  retention setting, no faces policy in the hint text).
- **Done when:** a new machine is placed in AR, appears as a proposal in Twin Studio with the
  measured position, and is accepted or rejected there with the change register entry.

### H. (merged into A–G) — the app is native from step A; an iPhone build is out of scope
- Nothing separate: see `Gimel/docs/mobile/ANDROID-APK.md`.

### I. Checks, docs, release
- pytest for geo, markers, pairing, device sessions, context schema (hostile/oversized position);
  Kotlin unit tests for alignment maths, SSE parser, token refresh; ARCore recorded sessions for
  repeatable AR runs; Playwright at 375 px for the WebView screens; a written real-device checklist (cannot be automated).
- `tools/check-all.sh` in Gimel and Alef. Docs: `docs/mobile.md`, `Infra/LAN-CA.md` phone part.
- Release to live Gimel through `fyrefly-sync` with the wheel and Alef plugin together, dry run
  first, owner's OK; needs the hostname in the VM's allowed hosts and task 52-A for the Copilot.

## Order and effort

0 → A → B → C → D → E → F → G, all inside the APK. Roughly 28–35 working days in total (native shell, token bridge and toolchain add about a week over the web-only variant);
**A–D (app, screens, Copilot, digital walk, tabletop AR) are about 11–13 days** and already give
a daily tool. E–G are the AR/positioning part and carry the technical risk.

## Risks

- **Device:** AR needs an ARCore-certified Android phone with current Chrome; checked in step 0. iPhones get everything except AR.
- **Indoor accuracy** depends on markers and lighting; featureless floors and moving forklifts
  hurt tracking. Mitigation: markers at every station, drift shown, re-anchor often.
- **Heat/battery** in AR: session cap, lite scene.
- **Dirty tree:** 10 uncommitted auth files in Gimel; A touches `auth.py`/`account.py` — commit
  or finish that work first.
- **Prod gap:** live Gimel is 72 commits behind and has no Agent Lab (task 52).
- **Privacy:** location of people at work — D5 is a rule, not an option.

## Not in scope

Public access or tunnels (Gimel stays LAN only), app-store release, beacons/UWB/LiDAR scans,
live machine signals, head-mounted displays, storing camera video, tracking people.

## Open questions for the owner

1. ~~Which phone?~~ Android (2026-11-16). Exact model still wanted for the ARCore check.
2. Go-ahead for which steps — suggested first block: 0, A, B, C, D.
3. Task 52-A (full Gimel release incl. Agent Lab) before or with this, so the Copilot works on
   the live Gimel?
4. The GitHub plan: sign in (`/mcp` GitHub or the browser pane) or name the branch/file.
5. OK to print QR markers and put them up in the hall?

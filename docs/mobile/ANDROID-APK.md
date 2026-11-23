# Gimel Mobile — Android APK build spec (Google Pixel 8)

2026-11-16 · **spec only, nothing is built yet** · owner decision: an installable **APK** for a
**Google Pixel 8**. Companion files: `AGENT-API.md` (Copilot), `API-CURRENT.md` (all routes),
`GIMEL.md` (product, auth, schemas — legacy for agent and 3D), `PLAN.md` (roadmap task 53).

## 1. Why native, and what stays web

| Option | Verdict |
|---|---|
| PWA in Chrome | works, but is not an APK |
| Trusted Web Activity (Chrome inside an APK) | needs Digital Asset Links on a publicly verifiable HTTPS domain; Gimel is LAN only with a private CA → falls back to a browser bar. **No.** |
| Capacitor / plain WebView shell | Android **WebView has no WebXR AR**; the AR walk would be impossible. **No** as the whole app. |
| **Native Kotlin app + ARCore, with a WebView for the existing screens** | **Chosen.** Best tracking (ARCore direct), image-marker anchoring, depth occlusion, proper sensor and background handling; the portal screens are reused instead of rebuilt. |

**Split:**

| Part | Technology | Reason |
|---|---|---|
| Sign-in, pairing, server setup, settings | native (Jetpack Compose) | Keystore, QR scan, CA trust |
| Portal screens (Heute, Aufträge, Lager, Arbeitsliste, Leitstand, Teileerkennung) | **WebView** on the server's `/app` (later `/m`) | already exist, German, role-aware |
| Digital walk (twin on screen) | WebView (three.js / WebGL works there) + gyroscope fed in | reuses `ThreeFloorPlan` walk mode |
| Copilot chat + voice | native | streaming, mic, speaker, overlay on every screen incl. AR |
| Located walk, AR walk, design on site | native ARCore | not possible in WebView |

## 2. Device facts — Pixel 8

- Android 14 at launch, updates for 7 years → `minSdk 34`. `targetSdk` = newest stable at build time
  (look it up; do not copy a number from this file).
- **ARCore certified**, including the Depth API (depth-from-motion; no ToF/LiDAR sensor) and
  Geospatial API. Tensor G3; rear cameras 50 MP wide + 12 MP ultrawide. ARCore uses the wide camera.
- Sensors: accelerometer, gyroscope, magnetometer, barometer, dual-band GNSS. **No UWB** (Pro only).
- Consequences: indoor position = ARCore motion tracking + printed markers (plan decision D3).
  Barometer can hint level changes (stairs); never the only source. GPS only outdoors.
- Verify on the real phone in step 0: Google Play Services for AR installed and current,
  `ArCoreApk.checkAvailability()` = `SUPPORTED_INSTALLED`, depth supported for the camera config.

## 3. Project

```text
~/Desktop/Gimel/mobile-android/           ← new, own Gradle project (not in the Python wheel)
  app/                    Compose UI, navigation, WebView host
  core-api/               OkHttp + kotlinx.serialization: auth, agent, factory
  core-ar/                ARCore session, alignment, marker tracking, scene
  core-geo/               WGS84 ↔ hall metres, alignment maths (pure Kotlin, unit-tested)
  core-voice/             record, transcribe, speak
```

- Kotlin, Jetpack Compose, single activity. Package `de.fyreflysystems.gimel` (owner to confirm).
- Networking: OkHttp, kotlinx.serialization, coroutines/Flow. No Firebase, no analytics, no crash
  reporter that phones home, **no Google Maps key** — Gimel is LAN only and the APK must work with
  the internet off.
- AR rendering: ARCore SDK (`com.google.ar:core`) with **SceneView** (`arsceneview`, Filament) for
  glTF models and simple meshes. Use current stable versions — look them up at build time.
- QR: CameraX + ML Kit barcode scanning, **bundled model** (works offline) — or ZXing.
- Build host: this PC has `adb` but **no JDK, no Android SDK, no Gradle**. Needed first:
  JDK 17+, Android command-line tools (`sdkmanager`: platform, build-tools, platform-tools), or
  Android Studio. Install only with the owner's OK.
- Output: `./gradlew :app:assembleDebug` → `app-debug.apk`, installed with
  `adb install -r` over USB. A release build is signed with a keystore that lives **outside git**
  (`~/.config/fyrefly/android/`), never in the repo, never in a doc.
- Distribution: sideload only. No Play Store listing.

## 4. Network and trust

- **First target (owner 2026-11-16): Musterwerk GmbH demo on the dev PC,
  `http://192.168.178.24:8040`** — plain HTTP on the LAN, PIN login, fictional data. The **debug**
  build allows cleartext for exactly this host (and `10.0.2.2` for the emulator) in its
  network security config; the release build allows none.
- Later: `https://kali2.fritz.box:8447` (same demo through the kali2 gate, HTTPS) and
  `https://kali2.fritz.box:8443` (live). Server address is editable in the app.
- Over plain HTTP the refresh cookie must not be marked `Secure`; the demo already works that way
  in a browser. Camera and microphone inside the WebView need a secure origin: on the HTTP demo,
  Teileerkennung and web dictation in the WebView will not run — native voice and native AR are
  unaffected. Use the `:8447` HTTPS address to test those two.
- **Trust the FyreFly LAN CA only for the Gimel hosts**, via `res/xml/network_security_config.xml`
  with the CA certificate as a raw resource (`~/Desktop/fyrefly-lan-ca.crt` — a public certificate,
  safe to bundle; the CA *key* never leaves kali2). `cleartextTrafficPermitted="false"` in release.
  Never a trust-all `TrustManager`, never `onReceivedSslError → proceed()`.
- The WebView uses the same network security config, so the portal loads without a warning.
- The server's Host check needs `kali2.fritz.box` in `<PREFIX>ALLOWED_HOSTS` (backend config, part
  of the release, not of the app).
- Offline / outside the LAN: one clear screen ("Nicht im Hausnetz"), no spinner, no cached customer data.

## 5. Sign-in and session (see `GIMEL.md` §5 — still valid)

- `POST /api/auth/login` is **form-encoded** (`username`, `password`). Result `Token`:
  `access_token`, `token_type`, `role`, `email`, `name`, `admin_work`, `mfa_required`, `mfa_token`.
- 2FA: `POST /api/auth/2fa` `{"mfa_token", "code"}`. PIN: `POST /api/auth/pin` `{"pin"}` only when
  `GET /api/auth/login-options` says `gimel_pin_enabled` (12 h cap, never extended).
- Access token: JWT, 30 min, **memory only**. Refresh token: HttpOnly cookie `<prefix>_refresh`,
  `Path=/api/auth`, 30 days, rotated on every `POST /api/auth/refresh`. Keep it in a persistent
  OkHttp `CookieJar` whose storage is encrypted with an Android Keystore key. Reuse of an old cookie
  fails — refresh must be **single-flight**.
- WebView session: the portal SPA refreshes by cookie on load. Copy the refresh cookie into
  `CookieManager` for the server origin before loading the WebView — but then **only one side may
  refresh**, because rotation invalidates the other copy. Rule: the WebView never refreshes on its
  own; the native layer owns refresh and injects the access token through a
  `WebViewCompat.addWebMessageListener` bridge restricted to the server origin. (This needs a small
  hook in the web app's `api.ts` — backend/web gap M1 below.)
- Sessions are listed and revocable under Konto (`GET /api/account/security`,
  `DELETE /api/account/sessions/{id}`). Lock the app after idle with `BiometricPrompt`.
- Roles apply unchanged: a hall worker sees no customers, addresses or prices (task 46); the app
  adds no data path around the API.

## 6. Twin data the AR layer reads

| Need | Route | Fields that matter |
|---|---|---|
| Sites → halls → levels | `GET /api/factory/topology` | site `lat/lon`; hall `lat`, `lon`, `rotation_deg`, `map_enabled`; floors with `level`, `elevation_m` |
| One level | `GET /api/factory/floor?floor_id=` | `outline`, `zones`, `obstacles`, `doors`, `aisles`, `conveyors`, `height_m`, `elevation_m`, `hall_id`, `level` — all in **metres** |
| Stations | `GET /api/factory/stations` | `id`, `label`, `type`, `subtype`, `x`, `y`, `w`, `h`, `rotation`, `floor_id`, `active`, `queue_min`, `queue_jobs`, `model_url`, `model_scale`, `model_rotation` |
| One station, live | `GET /api/factory/stations/{sid}/view` · `…/queue` · `…/worklist` | queue, load, state |
| Findings | `GET /api/factory/twin/analysis` | sentences per station |
| Route length | `GET /api/factory/route?from_id=&to_id=` | `metres`, `minutes`, `exact`, `hops`, `note` — **no polyline**; the drawn path comes from the agent tool `find_route` (`POST /api/agent/chats/{id}/tools/find_route`) or is computed on the phone from `floor.aisles` (gap G4) |
| Robots | `GET /api/factory/robots` | position, state, `sim_plan` |
| Uploaded 3D model | `GET /api/factory/stations/{sid}/model` | GLB/OBJ/STL if one was uploaded |
| Saved cameras | `GET /api/factory/views` | bookmarks |

Exact shapes: `openapi.json` (current) and `API-CURRENT.md`.

**Coordinate rules (from `web/src/sites.ts`, `CLAUDE.md`):**

- Plan coordinates are metres; **plan y counts south**. In the 3D scene plan y lies on +z, so a
  station's rotation is applied negated.
- `rotation_deg` turns the hall's x-axis counter-clockwise from east.
- Hall ↔ east/north metres (its own inverse):
  `east = x·cos t + y·sin t`, `north = x·sin t − y·cos t`, `t = rotation_deg` in radians.
- WGS84 offset from the hall anchor: `east = Δlon · 111 320 · cos(lat)`, `north = Δlat · 111 320`.
- `0/0` lat/lon means **not recorded**, never the Gulf of Guinea. No anchor → no GPS features for that hall.
- Levels: `elevation_m` per floor; treat a missing/zero stack as one storey apart (the web uses
  storey height + 0.8 m). Eye height in the web walk is `EYE_HEIGHT_M`; ARCore gives the real one.
- Built-in machines exist only as three.js code. **AR v1 draws each station as its footprint
  (`w × h`, rotated), an outline up to a nominal height, a label and a status colour**; an uploaded
  GLB is used when `model_url` is set. Full built-in models need backend gap G11 (`AGENT-API.md`).

## 7. Positioning and alignment

1. **Coarse (outdoors / entering):** fused location → nearest hall by anchor → pre-select site,
   hall, level. Show the accuracy radius; below ~15 m accuracy show no dot at all indoors.
2. **Anchor:** scan a printed Gimel marker (A4, known hall, level, x, y, height, facing). With
   ARCore **Augmented Images** the marker's pose in the AR world gives the full transform
   `hall ← AR world` (position + yaw; gravity fixes the rest). Fallback without markers: tap two
   known floor points (two hall corners) via hit-test.
3. **Track:** ARCore motion tracking between markers. Re-anchor silently whenever a marker is seen;
   blend, do not jump. Show the distance walked since the last anchor as a drift hint.
4. **Level:** from the scanned marker; barometer delta as a hint to offer "Ebene wechseln?".
5. **Never** use the compass for alignment inside the hall (steel, motors); only as a first guess
   for the digital walk before the gyroscope takes over.

Markers need backend gap G8. Until then the two-point alignment works with no backend change.

**ARCore Geospatial API:** not used. It sends camera imagery features and location to Google and
needs internet — against "LAN only" and against plan decision D5.

## 8. Features and screens (build order = plan steps)

| Step | Screen / feature | Done when |
|---|---|---|
| A | Server setup, CA trust, login + 2FA/PIN, session, biometric lock, WebView portal | APK installs on the Pixel 8, opens the demo portal signed in, survives a restart, a revoked session is out within one request |
| B | Bottom bar Heute · Aufträge · Halle · Copilot · Mehr; scan a Laufkarte/QR to open order or station | the hall tasks run one-handed |
| C | Copilot: chat list, streaming answer with tool cards, Stop, Undo, write-mode switch; hold-to-talk, read aloud, hands-free; floating talk button on every screen; `tool_result.action` handled | "Was steht hier an?" by voice at a station answers for that station |
| D | Digital walk in the WebView with gyroscope look; tabletop AR (hall as 1:100 model on a desk) | walk across two halls and levels; model stands stable on a table |
| E | Located walk: position dot on the plan, GPS outdoors, marker/two-point anchor indoors; position in the Copilot context | dot within GPS accuracy outdoors; snaps to the station at a marker |
| F | AR walk at 1:1: footprints, labels, queue, findings, routes on the floor, planned machines; depth occlusion optional | footprints within 10 cm at a marker, within 30 cm after 20 m |
| G | Design on site: tape measure, corner survey, record a way, place/move a machine as a proposal | a machine placed in AR appears as a proposal in Twin Studio |

## 9. Android permissions

| Permission | Why | When asked |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | API | — |
| `CAMERA` | QR scan, AR, Teileerkennung in the WebView | first use, with a reason |
| `RECORD_AUDIO` | talk to the Copilot | first hold-to-talk |
| `ACCESS_FINE_LOCATION` | hall pick, yard walk | first located walk; **foreground only**, never background |
| `HIGH_SAMPLING_RATE_SENSORS` | gyroscope look | — |
| `USE_BIOMETRIC` | app lock | — |

`<uses-feature android:name="android.hardware.camera.ar" android:required="true"/>` and
`<meta-data android:name="com.google.ar.core" android:value="required"/>`. No `READ_*` storage,
no contacts, no background location, no advertising id. WebView: grant `onPermissionRequest` only
for the Gimel origin and only for camera/microphone.

## 10. Privacy and security rules (binding)

- Camera frames, depth and the AR map stay on the phone. Nothing is uploaded except what the user
  explicitly saves (a note photo, a measured point).
- Position goes to the server only inside the Copilot `context`, as hall metres, with a per-message
  off switch. No trail, no per-person history, no background tracking (DSGVO Art. 5/6, § 26 BDSG —
  lawyer gate before real use with employees).
- Recorded audio is sent to `/api/agent/transcribe` and discarded; hands-free must say that nearby
  speech is heard.
- No customer data in logs, notifications, screenshots of the recents screen (`FLAG_SECURE` on
  screens that show orders) or backups (`android:allowBackup="false"`).
- Tokens only in Keystore-encrypted storage; wiped on logout and on a 401 after refresh.
- AR writes are proposals first (`whatif_*`), then the normal write path with audit.
- Gates before "done": security-advisor (trust config, token storage, WebView bridge, pairing),
  lawyer-advisor (position, audio, photos), designer-advisor (legibility over a camera image, 44 dp
  targets, German copy).

## 11. Backend and web gaps this APK depends on (none built)

| # | Gap | Blocks |
|---|---|---|
| M1 | WebView token bridge hook in the portal's `api.ts` (accept an access token from the native host, skip own refresh) | clean shared session (A) |
| M2 | `kali2.fritz.box` in allowed hosts + DHCP reservation for kali2 | hostname instead of IP (A) |
| M3 | `Permissions-Policy` on the portal for camera/microphone in an embedded WebView | Teileerkennung in the app (B) |
| G1 | Agent Lab on the live Gimel (task 52-A) | Copilot on real data (C) |
| G2 | SSE heartbeat | stable streaming (C) |
| G4/G5 | `guide_to` action, position source/accuracy keys | guidance, honest position (C, E) |
| G6 | QR pairing + device-bound sessions | no password typing on the phone (A, optional) |
| G8 | Markers table, CRUD, printable PDF | indoor anchoring (E, F) |
| G3 | Image attachments | photo to the Copilot (optional) |
| G11 | glTF export of built-in machines | full models in AR (later) |

Until G1 ships, develop and demo everything against the Musterwerk instance (`:8447` / `:8040`).

## 12. Testing

- Unit: `core-geo` (hall ↔ WGS84, alignment from a marker pose, two-point alignment), SSE parser
  (split chunks, multi-line data, error mid-stream), single-flight refresh, context size cap.
- Instrumented on the Pixel 8: login/2FA/PIN, WebView session, mic → transcribe, ARCore session
  start, marker detection. ARCore **recorded sessions** (Recording & Playback API) for repeatable
  AR tests without walking the hall each time.
- Real-device checklist (cannot be automated): accuracy at a marker and after 20 m, drift over a
  full hall loop, 10 minutes AR for heat and battery, bright yard / dark hall legibility, gloves.
- Server side stays as is: `tools/check-all.sh` in Gimel and Alef for any backend gap that gets built.

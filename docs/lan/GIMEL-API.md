# Gimel API guide — Musterwerk GmbH

**One file, everything needed to build a client against Gimel.** Verified 2026-11-16 against the
running Musterwerk demo (Gimel v0.2.0, 357 operations). The machine-readable contract sits
next to this file as [`openapi.json`](openapi.json) — every schema named below is defined there.

| | |
|---|---|
| **API base (LAN)** | `http://192.168.178.24:8040` |
| **Web app** | `http://192.168.178.24:8040/app` |
| **This guide** | `http://192.168.178.24:8091/GIMEL-API.md` |
| **OpenAPI** | `http://192.168.178.24:8091/openapi.json` |
| **Data** | fictional demo plant "Musterwerk GmbH" — safe to read and write; the owner can reset it to a snapshot |
| **Reach** | LAN `192.168.178.0/24` only, plain HTTP, no public address |

## Contents

1. [Quick start](#1-quick-start)
2. [What the server is](#2-what-the-server-is)
3. [Conventions](#3-conventions)
4. [Sign-in and session](#4-sign-in-and-session)
5. [Copilot (agent) API](#5-copilot-agent-api)
   — [config](#51-configuration-and-catalogue) · [chats](#52-chats) · [streaming](#53-sending-a-message-streaming) · [context](#54-view-and-position-context) · [attachments](#55-attachments) · [undo](#56-changes-and-undo) · [voice](#57-voice) · [twin tools](#58-twin-tools-the-copilot-has)
6. [Factory twin: data and coordinates](#6-factory-twin-data-and-coordinates)
7. [Endpoint catalogue](#7-endpoint-catalogue) — all 357 routes by area
8. [Client checklist](#8-client-checklist)

---

## 1. Quick start

```bash
BASE=http://192.168.178.24:8040

# 1. What does this server offer?
curl -s $BASE/api/version                 # {"agent": true, "vision": true, "demo": true, ...}
curl -s $BASE/api/auth/login-options      # {"gimel_pin_enabled": true, ...}

# 2. Sign in — PIN (shop-floor login) or e-mail + password (form-encoded!)
TOKEN=$(curl -s -X POST $BASE/api/auth/pin -H 'Content-Type: application/json' \
        -d '{"pin":"<the PIN the owner gives you>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# 3. Call anything
curl -s $BASE/api/factory/topology -H "Authorization: Bearer $TOKEN"
curl -s $BASE/api/factory/stations -H "Authorization: Bearer $TOKEN"

# 4. Talk to the Copilot (answer arrives as a stream)
CHAT=$(curl -s -X POST $BASE/api/agent/chats -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{"title":"Test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -N -X POST $BASE/api/agent/chats/$CHAT/messages -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"content":"Welche Station ist am vollsten?","route":"/app/factory/twin"}'
```

The PIN and account passwords are **not** in this file; ask the owner.

## 2. What the server is

- **Gimel** is an order and production management platform: orders, quotes, nesting, production
  runs, a factory twin (sites → halls → levels → stations, robots, ways), stock, shipping,
  invoicing, and an AI assistant ("Copilot") with tools over all of it.
- **Musterwerk GmbH** is its built-in fictional plant: one site, two halls, five levels.
- One FastAPI process serves the REST API under `/api`, the web app under `/app`, Twin Studio under
  `/studio` and the Agent Lab UI under `/lab`.
- The UI and all API messages are **German**. `detail` strings are ready to show to a user.
- `GET /api/version` is the feature probe: `agent` (Copilot routes exist), `vision` (part
  recognition), `demo` (fictional data). `GET /api/health` is the liveness check.

## 3. Conventions

| Topic | Rule |
|---|---|
| Format | JSON in and out, UTF-8. Exceptions: login is form-encoded; uploads are multipart or a raw body; some exports are files. |
| Auth | `Authorization: Bearer <access token>` on everything marked **Bearer** in §7. |
| Times | ISO 8601 with time zone (UTC). |
| Units | Factory geometry in **metres**; part and plate geometry in **millimetres**; durations in minutes unless the field name says otherwise. |
| Unknown values | In machine data `0` means **unknown**, never zero. `lat/lon = 0/0` means not recorded. |
| IDs | Integers, except orders and work orders, which are addressed by their number (`{no}`, `{order_no}`). |
| Caching | `/api/*` answers `Cache-Control: no-store`. |
| Concurrency | Some writes are compare-and-set (`rev`, `layout_rev`): the loser gets `409` and nothing is written — re-read and retry. |
| Roles | `customer`, worker/staff, admin. A route you may not use answers `403`; an object that is not yours answers `404`. Hall workers never receive customers, addresses or prices. |
| Audit | Every state change writes an audit line with the signed-in user. |

**Errors**

| Status | Meaning | Client |
|---|---|---|
| 400 | business rule, with a sentence | show `detail` |
| 401 | no / expired token, ended session | refresh once, then sign in |
| 403 | wrong role | hide the action |
| 404 | missing, or not yours | "nicht gefunden" |
| 409 | conflict: busy, duplicate, lost a compare-and-set, answer already running | show `detail`, retry |
| 413 | upload too large | show the limit |
| 415 | wrong content type (audio) | fix the header |
| 422 | validation or domain rejection | show `detail` |
| 423 | account or second factor locked | show `detail` |
| 429 | throttled (PIN), honour `Retry-After` | wait |
| 503 | optional feature not installed (voice) | hide the feature |

Error bodies come in **two shapes** — handle both:
`{"detail": "Satz auf Deutsch."}` and `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`.

## 4. Sign-in and session

### 4.1 Tokens

| Piece | Details |
|---|---|
| Access token | JWT, sent as Bearer, lifetime **30 minutes**. Keep it in memory. |
| Refresh token | opaque, in an HttpOnly cookie (`gimel_refresh`), `Path=/api/auth`, 30 days, **rotated on every refresh** — an old cookie stops working. |
| Session | every request re-checks the server-side session; a revoked session gives `401` even with a valid JWT. |

### 4.2 Sign in

| Route | Body | Notes |
|---|---|---|
| `GET /api/auth/login-options` | — | `{"test_pin_enabled", "gimel_pin_enabled"}` — what to offer |
| `POST /api/auth/pin` | `{"pin": "…"}` | shared shop-floor login; session capped at 12 h, not extended by refresh; `429` after 5 failures per IP in 15 min |
| `POST /api/auth/login` | **form**: `username`, `password` | `401` wrong, `423` locked (5 failures, 15 min), `403` deactivated |
| `POST /api/auth/2fa` | `{"mfa_token", "code"}` | only when login returned `mfa_required: true` |

All three return `Token`:

```json
{ "access_token": "eyJ…", "token_type": "bearer", "role": "staff", "email": "…", "name": "…",
  "admin_work": true, "mfa_required": false, "mfa_token": "" }
```
With a second factor, `access_token` is empty and `mfa_token` (5 minutes) goes to `/api/auth/2fa`.

### 4.3 Keep the session

| Route | Notes |
|---|---|
| `POST /api/auth/refresh` | no body; reads the cookie, returns a fresh `Token`, sets a new cookie. `401` = sign in again. |
| `POST /api/auth/logout` | `204`; revokes the session and clears the cookie |
| `GET /api/auth/me` | the signed-in user (`UserOut`) |
| `GET /api/account/security` | sessions of the account |
| `DELETE /api/account/sessions/{session_id}` · `POST /api/account/sessions/revoke-others` | sign a device out |

### 4.4 Password

`POST /api/auth/password` (change; revokes all sessions), `POST /api/auth/reset/request`,
`POST /api/auth/reset/confirm`. Rules: 8–200 characters, at least 4 distinct, not a common password,
not containing the e-mail name.

### 4.5 Client recipe

1. On start call `POST /api/auth/refresh`; on failure show sign-in.
2. Send the access token as Bearer. On `401`, refresh **once, single-flight** (parallel requests wait
   for the same refresh — two refreshes with the same cookie invalidate each other), then repeat.
3. A non-browser client needs a persistent cookie store for `/api/auth` and must send the cookie only there.
4. Downloads need the header too: fetch the bytes, do not open the URL in a browser tab.
5. Live updates: `POST /api/admin/events/ticket` → `{ticket, expires_in}` (60 s), then
   `GET /api/admin/events?ticket=…` as an event stream.

## 5. Copilot (agent) API

All routes under `/api/agent`, Bearer, any signed-in non-customer account. A chat belongs to exactly
one account. The routes exist only when `GET /api/version` says `agent: true`.

```text
GET  /api/agent/config                         → configured: true?
POST /api/agent/chats            {"title"}     → chat.id
POST /api/agent/chats/{id}/messages            → text/event-stream
POST /api/agent/chats/{id}/cancel              → stop a running answer
```

### 5.1 Configuration and catalogue

#### `GET /api/agent/config`
```json
{ "configured": true,
  "provider": { "id": 1, "name": "…", "kind": "…", "base_url": "…", "default_model": "…",
                "enabled": true, "is_default": true, "has_key": true, "key_source": "db|env",
                "models": ["…"], "models_fetched_at": "…", "headers": {} },
  "admin": false,
  "web_enabled": false }
```
`configured: false` → show a calm "Assistent einrichten" state, not an error. Provider keys are never
returned. Provider/settings management (`/providers…`, `/settings…`) is admin work and **out of scope
for the phone**; do it in `/lab` on a desktop.

#### `GET /api/agent/tools`
`{"tools": [...], "web_enabled": bool}` — the tools this user may use (150+; role-filtered). Use it for
a "what can I ask" screen and to label tool cards; never hard-code the list.

#### `GET /api/agent/prompts` · `POST /prompts` · `PUT /prompts/{id}` · `DELETE /prompts/{id}`
Saved prompts: own, shared, and quick starts.

#### `GET /api/agent/stats?days=30`
Tokens and reported cost for the own account (`days=0` = everything).

#### `GET /api/agent/health` → `{"ok": true}` (no auth).

### 5.2 Chats

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/agent/chats` | — | `{"chats": [Chat]}` newest first, max 100 |
| POST | `/api/agent/chats` | `{"title"?, "provider_id"?, "model"?, "write_mode"?: false}` | `201 Chat` |
| GET | `/api/agent/chats/{id}` | — | `{"chat", "messages": [Message], "attachments": [pending], "changes": [Change]}` |
| PATCH | `/api/agent/chats/{id}` | any of `title`, `provider_id`, `model`, `write_mode` | `Chat` |
| DELETE | `/api/agent/chats/{id}` | — | `{"id", "deleted": true}` (soft delete) |

```jsonc
// Chat
{ "id": 12, "title": "Neuer Chat", "provider_id": 1, "provider_name": "…", "model": "…",
  "write_mode": false, "created_at": "…", "updated_at": "…", "last_message_at": "…",
  "last_message": "first 140 chars, markdown stripped" }

// Message   (role: "user" | "assistant" | "tool")
{ "id": 99, "chat_id": 12, "role": "assistant", "content": "markdown", "tool_calls": [],
  "tool_call_id": null, "name": null, "model": "…", "usage": {}, "interrupted": false,
  "created_at": "…", "attachments": [] }
```

**`write_mode`** is off by default. Only when it is on does the model get writing tools, and the server
re-checks the switch on every tool execution. Turning it on is audited. On the phone: an explicit
switch per chat, visibly on, never default.

### 5.3 Sending a message (streaming)

Request (JSON):

| Field | Type | Notes |
|---|---|---|
| `content` | string, 1–20 000 | required, not blank (422) |
| `route` | string ≤ 200 | the screen the user is on, e.g. `/app/factory/twin`; `"/voice"` adds the spoken-answer rule (short, no tables) |
| `context` | object ≤ 64 KiB raw | what the user sees — see §5.4; sanitised server-side to ≤ 4 KiB |
| `attachment_ids` | int[] ≤ 20 | ids from §5.5, unused and from this chat |
| `hands_free` | bool | live conversation; with `write_mode` only reversible changes are allowed |

Response: `200 text/event-stream`, one answer per chat at a time. A second POST while one runs → **409**
„In diesem Chat läuft bereits eine Antwort." Errors before the stream starts are normal JSON
(`401/403/404/409/422`); errors after it starts arrive as an `error` event.

#### Wire format

```text
event: delta
data: {"type":"delta","text":"Die Station "}

```
`event:` always equals `data.type`. No `id:`, no `retry:`, **no heartbeat**, no resume: if the
connection drops, the run keeps going server-side until it finishes or is cancelled; re-read the chat
with `GET /chats/{id}` to pick up the stored result. This is a **POST** stream, so `EventSource` does
not apply — read the body incrementally (OkHttp `ResponseBody.source()`, Ktor `bodyAsChannel()`),
with **no read timeout** on that call.

#### Events

| `type` | Payload | Meaning |
|---|---|---|
| `start` | `chat_id`, `user_message_id`, `title`, `model` | accepted; the user message is stored |
| `delta` | `text` | piece of the answer (markdown) |
| `reasoning` | `text` | model's thinking; display optional, never stored |
| `assistant` | `message_id`, `content`, `tool_calls`, `usage` | one finished assistant turn (there can be several per run, one per tool round) |
| `tool_call` | `id`, `name`, `arguments`, `write` | a tool is about to run; `write: true` = changes data |
| `tool_result` | `id`, `name`, `ok`, `summary`, `preview`, `action`, `change_id`, `change_reversible`, `change_summary`, `message_id` | tool finished; `summary` is a German sentence |
| `error` | `detail`, `message_id`? | readable error; the stream ends after it or continues to `done` |
| `done` | `chat_id`, `steps`, `stopped`, `model` | end of the run; `stopped: true` after a cancel |

Render order that matches the web client: tool cards (name · status · summary) **before** the answer
text of that round; append `delta` text live; replace it with `assistant.content` when that arrives.

#### `tool_result.action` — the Copilot drives the screen

A tool may return a whitelisted UI instruction. It never changes data. The client performs it if it
understands the type and ignores it otherwise, and shows what it did ("Ansicht: Station Laser 2").

| `action.type` | Fields | Client does |
|---|---|---|
| `navigate` | `route` ∈ `/app`, `/app/orders`, `/app/production`, `/app/dispatch`, `/app/nesting`, `/app/inventory`, `/app/shipping`, `/app/customers`, `/app/robots`, `/app/factory`, `/app/factory/twin`, `/app/accounting`, `/app/worklist` | open that screen |
| `select_station` | `station_id`, `label` | select/open the station |
| `focus` | `station_id`+`label` **or** `x`,`y` (metres) | move camera / AR pointer there |
| `highlight` | `station_ids` (≤ 40), `labels` (≤ 12) | highlight in plan / AR |
| `clear_highlight` | — | remove highlight |
| `set_floor` | `floor_id`, `label` | switch level |
| `set_view_mode` | `mode` ∈ `plan`, `iso`, `three`, `walk` | switch view (mobile: map `walk` → walk/AR) |
| `prepare_station_placement` | (see tool output) | start a placement gesture |

Ids are validated server-side; unknown actions never reach the client.

#### `POST /api/agent/chats/{id}/cancel` → `{"cancelled": true|false}`
Sets the stop flag; the stream ends with `done.stopped = true` and the partial answer is kept as
`interrupted`.

#### `POST /api/agent/chats/{id}/rewind` — body `{"message_id": <user message id>}`
Hides one user question and everything after it (edit / regenerate). Changes already made by the hidden
part stay in the register and are **not** undone; the response names them.

### 5.4 View and position context

The context is client text and therefore untrusted: the server enforces shape and size, strips control
characters, and passes it to the model explicitly as *data, not instructions*. Anything that does not
fit the shape is dropped silently.

```jsonc
{
  "route":  "/app/factory/twin",                 // ≤ 120 chars
  "title":  "Halle 1 · EG",                      // ≤ 120
  "entity": { "type": "station", "id": 14, "label": "Laser 2" },   // type ^[a-z][a-z0-9_-]{0,31}$, label ≤ 80
  "selection": [ { "type": "station", "id": 15, "label": "Säge 1" } ],   // ≤ 12
  "view": {                                       // ≤ 24 keys, key ^[A-Za-z0-9_.-]{1,40}$,
    "floor_id": 3,                                //   values: bool | null | number | string ≤ 80
    "modus": "ar",
    "begehen": true,
    "standpunkt_x": 12.4, "standpunkt_y": 7.9,    // metres in hall coordinates
    "standpunkt_ebene": 3,                        // floor_id the position is valid on
    "blick_richtung": 135,                        // degrees: 0 = +y, 90 = +x
    "vor_mir": "Laser 2", "vor_mir_id": 14, "vor_mir_abstand_m": 2.6,
    "naechste_station": "Laser 2", "naechste_station_id": 14, "naechste_station_abstand_m": 1.1
  },
  "facts": [ "3 Aufträge in der Warteschlange" ]  // ≤ 12 lines, ≤ 160 chars each
}
```

- Total after cleaning ≤ **4096 bytes**; facts are dropped first, then selection, then view.
- The `view` keys above are the ones the system prompt already explains (`page_context.render`):
  `standpunkt_x/y`, `blick_richtung`, `standpunkt_ebene`, `vor_mir(_id,_abstand_m)`,
  `naechste_station(_id,_abstand_m)`, `ebenen_sichtbar`, `hallen_sichtbar`. **A phone that knows its
  hall position can send exactly these today** — "Was steht vor mir?" and "stell die Maschine vor mich"
  (`placement="in_front"`) then work as they are.
- Web rules worth copying: "vor mir" = inside a ±22° cone, ≤ 30 m; "nächste Station" ≤ 4 m while
  walking. Distances are to the machine edge.
- Privacy rule for the mobile client: **hall-local metres only, never WGS84**, and a per-message
  switch to send no context. The position is not stored by the client.

### 5.5 Attachments

`POST /api/agent/chats/{id}/attachments` — `multipart/form-data`, field `file`, optional `password`
(PDF), `pages` (e.g. `1-3,7`). `201`:

```json
{ "id": 5, "filename": "plan.pdf", "content_type": "application/pdf", "size": 81234,
  "pages": 3, "chars": 5120, "created_at": "…", "meta": {}, "truncated": false, "ocr": false }
```

- Types: `.pdf`, `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.log`, any `text/*`. **No images** —
  a photo cannot be sent to the Copilot today.
- Limit from settings (`agent_attach_max_mb`, default 15 MB) → 413 with the limit in `detail`.
- Only the extracted text is stored. Attach with `attachment_ids` on the next message;
  `DELETE …/attachments/{aid}` works only while unused (409 afterwards).

### 5.6 Changes and undo

Every write a tool makes is recorded with before/after.

- `GET /api/agent/changes?chat_id=&status_filter=` → `{"changes": [Change]}` (own, max 200)
- `POST /api/agent/chats/{id}/changes/{change_id}/revert` — undo one change
- `POST /api/agent/chats/{id}/messages/{message_id}/revert` — undo everything one answer did

```json
{ "id": 7, "chat_id": 12, "message_id": 99, "tool": "move_station", "action": "update",
  "entity": "factory_station", "entity_id": "14", "before": {}, "after": {}, "reversible": true,
  "status": "applied", "summary": "…", "created_at": "…", "reverted_at": null, "reverted_by": null }
```
A `tool_result` with `change_id` should show an **Undo** button when `change_reversible` is true.

`POST /api/agent/chats/{id}/tools/{name}` with `{"arguments": {...}}` runs one tool by hand (same role
and write-mode rules; 404 unknown tool, 403 role, 409 write mode off, 422 tool error). Useful for
deterministic buttons such as "Weg zur Station" → `find_route` without a model round trip.

### 5.7 Voice

#### `GET /api/agent/voice` (only where the voice router is mounted)
```json
{ "tts_backend": "lokal", "llm_provider": "…", "stt_available": true, "stt_loaded": true,
  "stt_model": "small", "max_seconds": 120, "tts_available": true,
  "default_voice": "…", "voices": [ {"id": "…", "name": "…"} ] }
```

#### `POST /api/agent/transcribe?language=de` — speech → text, recognised on the server
- **Raw body**, not multipart. `Content-Type` one of `audio/webm`, `audio/ogg`, `audio/wav`,
  `audio/x-wav`, `audio/wave`, `audio/mp4`, `audio/mpeg`, `audio/aac`, `video/webm` (else 415).
  A phone recorder producing AAC in MP4 (`audio/mp4`) or Opus in OGG is fine; 16 kHz mono is enough.
- ≤ 10 MB (413), ≤ 120 s (413). **One recognition at a time**: a second gets `409` with
  `Retry-After: 3` — retry once, then tell the user.
- `503` when the server has no recognition installed.

```json
{ "text": "Was steht hier an", "language": "de", "audio_seconds": 2.4, "speech_seconds": 1.9,
  "peak_dbfs": -12.3, "rms_dbfs": -31.0, "gain_db": 0.0, "processing_seconds": 0.8, "model": "small" }
```
Empty `text` with very low `rms_dbfs` = too quiet, not "not understood" — say so. Audio is never
stored; only the recognised text becomes a chat message. Show the text before sending unless the
user chose hands-free.

#### `GET /api/agent/speech` · `POST /api/agent/speech` — text → audio
`GET` → `{"available", "backend", "default_voice", "voices"}`.
`POST {"text": "≤ 6000", "voice": "", "rate": 0.8–1.4}` → audio bytes (`Content-Type` per backend:
WAV for local Piper, MP3 for `edge`); `503` when unavailable. Speak sentence by sentence while the
answer streams, fetching the next sentence while the current one plays.

#### Hands-free ("Live")
Mic stays open → utterance → `/transcribe` → `/messages` with `hands_free: true`, `route: "/voice"` →
speak the answer → listen again. Speaking over the answer cancels playback and calls `/cancel`. Three
silent rounds pause. Nearby conversations are heard and sent to the model — the UI must say so.

### 5.8 Twin tools the Copilot has

Read-only: `get_floor_layout`, `get_station_details`, `get_nearby_stations` (defaults to where the
user stands), `find_free_spot`, `find_route`, `measure_between`, `get_twin_findings`,
`rank_stations_for`, `get_robot`, `check_robot_traffic`, `list_twin_views`, `size_fleet`.
What-if (nothing written): `whatif_move_station`, `whatif_station_down`.
Writes (write mode, reversible): `move_station`, `rotate_station`, `save_twin_view`, plus
`create_station` / `update_station` with `placement="in_front"`.
View: `show_in_view` (→ `tool_result.action`, §5).
The full, role-filtered list with schemas: `GET /api/agent/tools`.

## 6. Factory twin: data and coordinates

| Need | Route | Fields that matter |
|---|---|---|
| Sites → halls → levels | `GET /api/factory/topology` | site `lat`, `lon`; hall `lat`, `lon`, `rotation_deg`, `map_enabled`; floors with `level`, `elevation_m` |
| One level | `GET /api/factory/floor?floor_id=` (`FloorOut`) | `outline`, `zones`, `obstacles`, `doors`, `aisles`, `conveyors`, `height_m`, `elevation_m`, `hall_id`, `level`, `issues` |
| Stations | `GET /api/factory/stations` (`StationOut[]`) | `id`, `label`, `type`, `subtype`, `x`, `y`, `w`, `h`, `rotation`, `floor_id`, `active`, `queue_min`, `queue_jobs`, `model_url`, `model_scale`, `model_rotation` |
| One station, live | `GET /api/factory/stations/{sid}/view` · `…/queue` · `…/worklist` | queue, load, state |
| Findings | `GET /api/factory/twin/analysis` | sentences per station (capacity, changeover, transport, layout, dates, data) |
| Route length | `GET /api/factory/route?from_id=&to_id=` | `metres`, `minutes`, `exact`, `hops`, `note` — no polyline; for the drawn path use the Copilot tool `find_route` (§5.6: `POST /api/agent/chats/{id}/tools/find_route`) |
| Material flow | `GET /api/factory/flow` · `GET /api/factory/pipeline` | flows between stations |
| Robots | `GET /api/factory/robots` · `GET /api/factory/robots/{robot_id}` | position, state, `sim_plan` |
| Robot jobs | `GET /api/factory/robot-jobs` | transport jobs |
| 3D model of a station | `GET /api/factory/stations/{sid}/model` | only if a GLB/OBJ/STL was uploaded; built-in machines have no file |
| Saved cameras | `GET /api/factory/views` | bookmarks |
| Planned-robot simulation | `POST /api/factory/fleet-sim/run` | writes nothing |

**Coordinates**

- Plan coordinates are metres. **Plan y counts south** (down on the screen). In a 3D scene plan y
  lies on +z, so a station's `rotation` is applied negated.
- A station is the rectangle `w × h` centred as stored at `x`, `y`, turned by `rotation` degrees.
- A hall is placed on the earth by `lat`, `lon` (its plan origin 0/0) and `rotation_deg`, which
  turns the hall's x-axis counter-clockwise from east.
- Hall metres ↔ east/north metres (the mapping is its own inverse), `t = rotation_deg` in radians:
  `east = x·cos t + y·sin t`, `north = x·sin t − y·cos t`.
- WGS84 offset from the anchor: `east = Δlon · 111 320 · cos(lat)`, `north = Δlat · 111 320`.
- No anchor (`0/0`) → the hall has no place on a map; do not guess one.
- Levels of a hall stack by `elevation_m`. Routes between levels and halls are estimates, and
  between sites there is none.
- Writes: `PUT /api/factory/stations/{sid}` (move/turn), `PUT /api/factory/floor` (omit
  `conveyors` to leave them; `[]` removes them). Station overlaps are refused by the Copilot tools.

## 7. Endpoint catalogue

All 357 routes, straight from the server. **Auth** `Bearer` = token required; `—` = no bearer
declared (public probes, sign-in, and a few routes that check access another way: a ticket, a
gateway code, or an optional login). **Body** and **Returns** name a schema in `openapi.json`
(`json` = an untyped object; see the route's summary). Query parameters with `*` are required.

| Area | Routes |
|---|---|
| [`agent-voice`](#71-agent-voice--2-routes) | 2 |
| [`auth`](#72-auth--11-routes) | 11 |
| [`account`](#73-account--26-routes) | 26 |
| [`users`](#74-users--9-routes) | 9 |
| [`products`](#75-products--11-routes) | 11 |
| [`rates`](#76-rates--4-routes) | 4 |
| [`quotes`](#77-quotes--4-routes) | 4 |
| [`production`](#78-production--28-routes) | 28 |
| [`nesting`](#79-nesting--5-routes) | 5 |
| [`punchout`](#710-punchout--5-routes) | 5 |
| [`admin`](#711-admin--15-routes) | 15 |
| [`shipping`](#712-shipping--10-routes) | 10 |
| [`links`](#713-links--1-routes) | 1 |
| [`inventory`](#714-inventory--7-routes) | 7 |
| [`integration`](#715-integration--4-routes) | 4 |
| [`customers`](#716-customers--12-routes) | 12 |
| [`desk`](#717-desk--12-routes) | 12 |
| [`invoicing`](#718-invoicing--20-routes) | 20 |
| [`factory`](#719-factory--72-routes) | 72 |
| [`robots`](#720-robots--26-routes) | 26 |
| [`drawings`](#721-drawings--7-routes) | 7 |
| [`free-nesting`](#722-free-nesting--4-routes) | 4 |
| [`compliance`](#723-compliance--10-routes) | 10 |
| [`vision`](#724-vision--13-routes) | 13 |
| [`agent`](#725-agent--37-routes) | 37 |
| [`meta`](#726-meta--2-routes) | 2 |

### 7.1 `agent-voice` — 2 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/agent/voice` | Voice Info | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/transcribe` | Transcribe Audio | Bearer |  | language | 200 | `json` |

### 7.2 `auth` — 11 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| POST | `/api/auth/register` | Register | — | `RegisterRequest` |  | 201 | `Token` |
| POST | `/api/auth/login` | Login | — | `Body_login_api_auth_login_post` |  | 200 | `Token` |
| POST | `/api/auth/reset/request` | Reset Request | — | `PasswordResetRequest` |  | 202 | `json` |
| POST | `/api/auth/reset/confirm` | Reset Confirm | — | `PasswordResetConfirm` |  | 200 | `json` |
| POST | `/api/auth/2fa` | Login Second Factor | — | `MfaLogin` |  | 200 | `Token` |
| POST | `/api/auth/refresh` | Refresh | — |  |  | 200 | `Token` |
| POST | `/api/auth/logout` | Logout | Bearer |  |  | 204 |  |
| GET | `/api/auth/login-options` | Login Options | — |  |  | 200 | `json` |
| POST | `/api/auth/pin` | Pin Login | — | `PinLogin` |  | 200 | `Token` |
| GET | `/api/auth/me` | Me | Bearer |  |  | 200 | `UserOut` |
| POST | `/api/auth/password` | Change Password | Bearer | `PasswordChange` |  | 204 |  |

### 7.3 `account` — 26 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/account/me` | Get Me | Bearer |  |  | 200 | `UserOut` |
| DELETE | `/api/account/me` | Delete Me | Bearer | `MfaDisable` |  | 204 |  |
| PATCH | `/api/account/me` | Update Me | Bearer | `AccountUpdate` |  | 200 | `UserOut` |
| GET | `/api/account/security` | Security Overview | Bearer |  |  | 200 | `json` |
| POST | `/api/account/2fa/start` | Mfa Start | Bearer | `MfaStart` |  | 200 | `json` |
| POST | `/api/account/2fa/enable` | Mfa Enable | Bearer | `MfaConfirm` |  | 200 | `json` |
| POST | `/api/account/2fa/disable` | Mfa Off | Bearer | `MfaDisable` |  | 204 |  |
| POST | `/api/account/2fa/recovery` | Mfa New Recovery | Bearer | `MfaDisable` |  | 200 | `json` |
| POST | `/api/account/email` | Change Email | Bearer | `EmailChange` |  | 200 | `UserOut` |
| DELETE | `/api/account/sessions/{session_id}` | Revoke Session | Bearer |  |  | 204 |  |
| POST | `/api/account/sessions/revoke-others` | Revoke Other Sessions | Bearer |  |  | 200 | `json` |
| GET | `/api/account/addresses` | List Addresses | Bearer |  |  | 200 | `gimel__routers__account__AddressOut[]` |
| POST | `/api/account/addresses` | Create Address | Bearer | `gimel__routers__account__AddressIn` |  | 201 | `gimel__routers__account__AddressOut` |
| PUT | `/api/account/addresses/{addr_id}` | Update Address | Bearer | `gimel__routers__account__AddressIn` |  | 200 | `gimel__routers__account__AddressOut` |
| DELETE | `/api/account/addresses/{addr_id}` | Delete Address | Bearer |  |  | 204 |  |
| GET | `/api/account/parts` | List Parts | Bearer |  |  | 200 | `PartOut[]` |
| POST | `/api/account/parts` | Create Part | Bearer | `gimel__schemas__PartIn` |  | 201 | `PartOut` |
| GET | `/api/account/parts/{part_id}` | Get Part | Bearer |  |  | 200 | `PartOut` |
| PATCH | `/api/account/parts/{part_id}` | Update Part | Bearer | `PartPatch` |  | 200 | `PartOut` |
| DELETE | `/api/account/parts/{part_id}` | Delete Part | Bearer |  |  | 204 |  |
| GET | `/api/account/orders/{no}/tracking` | My Order Tracking | Bearer |  |  | 200 | `json` |
| GET | `/api/account/orders/{no}/invoice.xml` | My Invoice Xml | Bearer |  |  | 200 | `json` |
| GET | `/api/account/orders` | My Orders | Bearer |  |  | 200 | `array` |
| POST | `/api/account/claim` | Claim Orders | Bearer | `ClaimRequest` |  | 200 | `json` |
| POST | `/api/account/email-verification/request` | Request Email Verification | Bearer |  |  | 200 | `json` |
| POST | `/api/account/email-verification/confirm` | Confirm Email Verification | Bearer | `EmailVerification` |  | 200 | `json` |

### 7.4 `users` — 9 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/users` | List Users | Bearer |  | q, role, active, limit, offset | 200 | `UserOut[]` |
| POST | `/api/users` | Create User | Bearer | `UserCreate` |  | 201 | `UserOut` |
| GET | `/api/users/customers` | List Customers | Bearer |  | q, role, limit | 200 | `CustomerWithOrders[]` |
| PATCH | `/api/users/{user_id}` | Update User | Bearer | `UserUpdate` |  | 200 | `UserOut` |
| DELETE | `/api/users/{user_id}` | Delete User | Bearer |  |  | 200 | `json` |
| POST | `/api/users/{user_id}/password` | Set Password | Bearer | `PasswordSet` |  | 204 |  |
| POST | `/api/users/{user_id}/unlock` | Unlock User | Bearer |  |  | 200 | `UserOut` |
| POST | `/api/users/{user_id}/mfa/reset` | Reset Mfa | Bearer |  |  | 200 | `UserOut` |
| GET | `/api/users/{user_id}/orders` | Customer Orders | Bearer |  |  | 200 | `CustomerOrderOut[]` |

### 7.5 `products` — 11 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/products` | List Products | — |  | q, cat, cnc, plotter_only, include_inactive, limit | 200 | `ProductOut[]` |
| POST | `/api/products` | Create Product | Bearer | `ProductCreate` |  | 201 | `ProductOut` |
| GET | `/api/products/{product_id}` | Get Product | — |  |  | 200 | `ProductOut` |
| PATCH | `/api/products/{product_id}` | Update Product | Bearer | `ProductUpdate` |  | 200 | `ProductOut` |
| DELETE | `/api/products/{product_id}` | Deactivate Product | Bearer |  |  | 204 |  |
| GET | `/api/products/{product_id}/price-history` | Price History | Bearer |  |  | 200 | `PriceHistoryOut[]` |
| POST | `/api/products/plotter-only/apply` | Apply Plotter Only | Bearer |  |  | 200 | `json` |
| GET | `/api/products/plotter-only/preview` | Plotter Only Preview | — |  |  | 200 | `json` |
| POST | `/api/products/prices/bulk` | Bulk Price | Bearer | `BulkPriceChange` |  | 200 | `BulkPriceResult` |
| GET | `/api/products/matrix/view` | Matrix | — |  | include_inactive | 200 | `json` |
| POST | `/api/products/matrix/save` | Save Matrix | Bearer | `MatrixSave` |  | 200 | `MatrixSaveResult` |

### 7.6 `rates` — 4 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/rates` | List Rates | — |  |  | 200 | `RateOut[]` |
| PATCH | `/api/rates/{key}` | Update Rate | Bearer | `RateUpdate` |  | 200 | `RateOut` |
| GET | `/api/rates/{key}/history` | Rate History | Bearer |  | limit | 200 | `array` |
| GET | `/api/rates/engine/keys` | Engine Keys | — |  |  | 200 | `array` |

### 7.7 `quotes` — 4 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| POST | `/api/quote` | Calculate | Bearer | `QuoteRequest` |  | 200 | `QuoteResponse` |
| POST | `/api/orders` | Create Order | Bearer | `OrderRequest` |  | 201 | `OrderOut` |
| GET | `/api/orders/{no}` | Get Order | Bearer |  |  | 200 | `json` |
| POST | `/api/orders/{no}/reorder` | Reorder | Bearer |  |  | 201 | `OrderOut` |

### 7.8 `production` — 28 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/production/queue` | Queue | Bearer |  |  | 200 | `json` |
| GET | `/api/production/queue/bucket` | Queue Bucket | Bearer |  | mat*, thk*, customer_id | 200 | `json` |
| GET | `/api/production/queue/bucket/plate/{idx}.svg` | Queue Bucket Plate | Bearer |  | mat*, thk*, customer_id | 200 |  |
| GET | `/api/production/runs` | List Runs | Bearer |  | limit | 200 | `RunOut[]` |
| POST | `/api/production/runs` | Trigger Run | Bearer |  | force | 201 | `RunOut` |
| POST | `/api/production/runs/start` | Start Run | Bearer | `application/json` | force | 202 | `json` |
| GET | `/api/production/runs/jobs/{job_id}` | Run Job | Bearer |  |  | 200 | `json` |
| POST | `/api/production/renest` | Renest | Bearer | `RenestIn` |  | 201 | `RunOut` |
| POST | `/api/production/orders/{no}/release` | Release Order | Bearer | `gimel__routers__production__ReleaseIn` |  | 200 | `json` |
| GET | `/api/production/orders/{no}` | Order For Production | Bearer |  |  | 200 | `json` |
| POST | `/api/production/policies/preview` | Preview Policy | Bearer | `PolicyIn` |  | 200 | `array` |
| GET | `/api/production/policies` | List Policies | Bearer |  |  | 200 | `PolicyOut[]` |
| PUT | `/api/production/policies` | Upsert Policy | Bearer | `PolicyIn` |  | 200 | `PolicyOut` |
| DELETE | `/api/production/policies/{policy_id}` | Delete Policy | Bearer |  |  | 204 |  |
| GET | `/api/production/work-orders` | List Work Orders | Bearer |  | status, run, limit | 200 | `WorkOrderOut[]` |
| GET | `/api/production/work-orders/{no}` | Get Work Order | Bearer |  |  | 200 | `json` |
| POST | `/api/production/work-orders/{no}/plates/{idx}/status` | Set Plate Status | Bearer | `PlateStatusIn` |  | 200 | `json` |
| PATCH | `/api/production/work-orders/{no}/plates/{idx}/status` | Set Plate Status And Finish | Bearer | `PlateStatusChange` |  | 200 | `json` |
| GET | `/api/production/work-orders/{no}/plate/{idx}.svg` | Plate Drawing | Bearer |  | width, download | 200 |  |
| GET | `/api/production/work-orders/{no}/part/{position_id}.svg` | Part Drawing | Bearer |  | width, download | 200 |  |
| GET | `/api/production/work-orders/{no}/plate/{idx}.dxf` | Plate Cutfile | Bearer |  | plotpro, strategy | 200 | `json` |
| GET | `/api/production/work-orders/{no}/plate/{idx}/auftrag/{order_no}.dxf` | Plate Cutfile For Order | Bearer |  |  | 200 | `json` |
| GET | `/api/production/work-orders/{no}/part/{position_id}.dxf` | Part Cutfile | Bearer |  |  | 200 | `json` |
| GET | `/api/production/work-orders/{no}/cutfiles.zip` | Cutfile Bundle | Bearer |  | plotpro, strategy | 200 | `json` |
| GET | `/api/production/work-orders/{no}/sheet` | Traveller | Bearer |  | download | 200 | `text/html` |
| POST | `/api/production/work-orders/{no}/status` | Set Status | Bearer | `StatusChange` |  | 200 | `WorkOrderOut` |
| POST | `/api/production/work-orders/{no}/stage` | Set Material Staged | Bearer | `StageChange` |  | 200 | `WorkOrderOut` |
| POST | `/api/production/work-orders/{no}/orders/{order_no}/done` | Toggle Order Done | Bearer | `OrderDoneToggle` |  | 200 | `json` |

### 7.9 `nesting` — 5 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/production/work-orders/{no}/layout` | Get Layout | Bearer |  |  | 200 | `json` |
| PUT | `/api/production/work-orders/{no}/layout` | Save Layout | Bearer | `SaveIn` |  | 200 | `json` |
| POST | `/api/production/work-orders/{no}/layout/check` | Check Layout | Bearer | `LayoutIn` |  | 200 | `json` |
| POST | `/api/production/work-orders/{no}/layout/auto` | Auto Layout | Bearer |  |  | 200 | `json` |
| POST | `/api/production/work-orders/{no}/layout/reset` | Reset Layout | Bearer | `ResetIn` |  | 200 | `json` |

### 7.10 `punchout` — 5 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| POST | `/api/punchout/setup` | Setup | — |  |  | 200 | `SetupOut` |
| GET | `/api/punchout/session/{token}` | Session Info | — |  |  | 200 | `json` |
| POST | `/api/punchout/cart` | Cart Return | — | `CartIn` |  | 200 | `json` |
| GET | `/api/punchout/cart/form` | Cart Form | — |  | token* | 200 | `json` |
| GET | `/api/punchout/sessions` | List Sessions | Bearer |  | open_only | 200 | `json` |

### 7.11 `admin` — 15 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| POST | `/api/admin/events/ticket` | Sse Ticket | Bearer |  |  | 200 | `json` |
| GET | `/api/admin/events` | Sse Events | — |  | ticket | 200 | `json` |
| GET | `/api/admin/settings` | List Settings | Bearer |  |  | 200 | `gimel__routers__admin__SettingOut[]` |
| PUT | `/api/admin/settings/{key}` | Set Setting | Bearer | `gimel__routers__admin__SettingIn` |  | 200 | `gimel__routers__admin__SettingOut` |
| GET | `/api/admin/audit` | Audit | Bearer |  | action, actor, entity, entity_id, since, until, before_id, limit | 200 | `AuditOut[]` |
| GET | `/api/admin/audit/actions` | Audit Actions | Bearer |  |  | 200 | `array` |
| GET | `/api/admin/stats` | Stats | Bearer |  |  | 200 | `json` |
| GET | `/api/admin/dimension-limits` | Get Dimension Limits | Bearer |  |  | 200 | `json` |
| GET | `/api/admin/orders` | List Orders | Bearer |  | q, status, limit, offset | 200 | `OrderListResponse` |
| GET | `/api/admin/orders/{no}` | Order Detail | Bearer |  |  | 200 | `json` |
| POST | `/api/admin/orders/{no}/clone` | Clone Order | Bearer |  |  | 200 | `json` |
| POST | `/api/admin/orders/{no}/paid` | Mark Paid | Bearer | `MarkPaidIn` |  | 200 | `json` |
| GET | `/api/admin/orders/{no}/timeline` | Order Timeline | Bearer |  |  | 200 | `json` |
| POST | `/api/admin/orders/{no}/rollback` | Order Rollback | Bearer | `RollbackIn` |  | 200 | `json` |
| POST | `/api/admin/orders/{no}/rollback_legacy` | Order Rollback Legacy | Bearer | `RollbackIn` |  | 200 | `json` |

### 7.12 `shipping` — 10 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/shipping/ready` | Ready Orders | Bearer |  |  | 200 | `json` |
| GET | `/api/shipping/` | List Shipments | Bearer |  | status | 200 | `json` |
| POST | `/api/shipping/` | Create Shipment | Bearer | `ShipmentCreate` |  | 200 | `json` |
| GET | `/api/shipping/{no}` | Get Shipment | Bearer |  |  | 200 | `json` |
| PATCH | `/api/shipping/{no}` | Update Shipment | Bearer | `ShipmentUpdate` |  | 200 | `json` |
| DELETE | `/api/shipping/{no}` | Delete Shipment | Bearer |  |  | 200 | `json` |
| GET | `/api/shipping/{no}/label` | Shipment Label Html | Bearer |  |  | 200 | `text/html` |
| GET | `/api/shipping/{no}/orders` | Shipment Orders | Bearer |  |  | 200 | `json` |
| GET | `/api/shipping/by-order/{order_no}` | Shipments By Order | Bearer |  |  | 200 | `json` |
| GET | `/api/shipping/{no}/tracking` | Shipment Tracking | Bearer |  |  | 200 | `json` |

### 7.13 `links` — 1 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/links/{no}` | Related | Bearer |  |  | 200 | `json` |

### 7.14 `inventory` — 7 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/inventory` | List Stock | — |  | include_inactive | 200 | `StockRow[]` |
| GET | `/api/inventory/offcuts` | List Offcuts | Bearer |  | mat, status, limit | 200 | `json` |
| POST | `/api/inventory/offcuts` | Create Offcut | Bearer | `OffcutIn` |  | 200 | `json` |
| PATCH | `/api/inventory/offcuts/{offcut_id}` | Update Offcut | Bearer | `OffcutPatch` |  | 200 | `json` |
| GET | `/api/inventory/{product_id}/movements` | Stock Movements | — |  | limit | 200 | `StockMovementOut[]` |
| GET | `/api/inventory/{product_id}/timeline` | Stock Timeline | — |  | days | 200 | `json` |
| POST | `/api/inventory/{product_id}/adjust` | Adjust Stock | Bearer | `StockAdjust` |  | 200 | `StockMovementOut` |

### 7.15 `integration` — 4 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/integration/health` | Health | Bearer |  |  | 200 | `json` |
| GET | `/api/integration/stock` | Stock | Bearer |  | mats | 200 | `json` |
| GET | `/api/integration/plates` | Plates | Bearer |  | mats | 200 | `json` |
| POST | `/api/integration/sync` | Sync | Bearer | `SyncIn` |  | 200 | `json` |

### 7.16 `customers` — 12 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/customers` | List Customers | Bearer |  | q, limit, include_removed | 200 | `CustomerOut[]` |
| POST | `/api/customers` | Create Customer | Bearer | `CustomerCreate` |  | 201 | `CustomerOut` |
| GET | `/api/customers/next-number` | Peek Customer No | Bearer |  |  | 200 | `json` |
| GET | `/api/customers/duplicates` | Find Duplicates | Bearer |  | email, company, vat_id, exclude_id | 200 | `DuplicateOut[]` |
| GET | `/api/customers/{customer_id}` | Get Customer | Bearer |  |  | 200 | `CustomerOut` |
| PATCH | `/api/customers/{customer_id}` | Update Customer | Bearer | `CustomerUpdate` |  | 200 | `CustomerOut` |
| DELETE | `/api/customers/{customer_id}` | Delete Customer | Bearer |  |  | 204 |  |
| GET | `/api/customers/{customer_id}/addresses` | List Addresses | Bearer |  |  | 200 | `gimel__routers__customers__AddressOut[]` |
| POST | `/api/customers/{customer_id}/addresses` | Add Address | Bearer | `gimel__routers__customers__AddressIn` |  | 201 | `gimel__routers__customers__AddressOut` |
| PUT | `/api/customers/{customer_id}/addresses/{address_id}` | Update Address | Bearer | `gimel__routers__customers__AddressIn` |  | 200 | `gimel__routers__customers__AddressOut` |
| DELETE | `/api/customers/{customer_id}/addresses/{address_id}` | Delete Address | Bearer |  |  | 204 |  |
| GET | `/api/customers/{customer_id}/orders` | Customer Orders | Bearer |  |  | 200 | `json` |

### 7.17 `desk` — 12 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| POST | `/api/desk/dxf` | Upload Dxf | Bearer | `Body_upload_dxf_api_desk_dxf_post` |  | 200 | `json` |
| POST | `/api/desk/import/orders` | Import Orders | Bearer | `Body_import_orders_api_desk_import_orders_post` | commit | 200 | `json` |
| GET | `/api/desk/export/orders.csv` | Export Orders | Bearer |  |  | 200 |  |
| POST | `/api/desk/orders` | Create Order | Bearer | `DeskOrderIn` |  | 201 | `DeskOrderOut` |
| GET | `/api/desk/orders` | List Orders | Bearer |  | q, limit | 200 | `DeskOrderOut[]` |
| GET | `/api/desk/orders/{no}` | Get Order | Bearer |  |  | 200 | `DeskOrderOut` |
| PATCH | `/api/desk/orders/{no}` | Change Order | Bearer | `OrderChangeIn` |  | 200 | `DeskOrderOut` |
| POST | `/api/desk/orders/{no}/release` | Release Order | Bearer | `gimel__routers__desk__ReleaseIn` |  | 200 | `DeskOrderOut` |
| POST | `/api/desk/orders/{no}/hold` | Hold Order | Bearer | `HoldIn` |  | 200 | `DeskOrderOut` |
| POST | `/api/desk/orders/{no}/resume` | Resume Order | Bearer | `ResumeIn` |  | 200 | `DeskOrderOut` |
| GET | `/api/desk/orders/{no}/cancel-check` | Cancel Check | Bearer |  |  | 200 | `json` |
| POST | `/api/desk/orders/{no}/cancel` | Cancel Order | Bearer | `gimel__routers__desk__CancelIn` |  | 200 | `DeskOrderOut` |

### 7.18 `invoicing` — 20 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/invoicing/orders/{no}/billing-check` | Billing Check | Bearer |  |  | 200 | `json` |
| GET | `/api/invoicing/orders/{no}/invoice.xml` | Invoice Xml | Bearer |  |  | 200 | `json` |
| GET | `/api/invoicing/config` | Config | — |  |  | 200 | `json` |
| GET | `/api/invoicing/seller` | Get Seller | Bearer |  |  | 200 | `json` |
| PUT | `/api/invoicing/seller` | Put Seller | Bearer | `SellerIn` |  | 200 | `json` |
| POST | `/api/invoicing/orders/{no}/invoice/cancel` | Cancel Local Invoice | Bearer | `gimel__routers__invoicing__CancelIn` |  | 200 | `json` |
| GET | `/api/invoicing/export/invoices.csv` | Export Invoices | Bearer |  |  | 200 |  |
| GET | `/api/invoicing/local` | List Local | Bearer |  |  | 200 | `array` |
| GET | `/api/invoicing/local/{number}/invoice.html` | Local Html | Bearer |  |  | 200 |  |
| GET | `/api/invoicing/local/{number}/invoice.xml` | Local Xml | Bearer |  |  | 200 |  |
| GET | `/api/invoicing/orders/{no}/invoice.html` | Order Invoice Html | Bearer |  |  | 200 |  |
| POST | `/api/invoicing/orders/{no}/invoice` | Create Invoice | Bearer | `InvoiceIn` |  | 201 | `json` |
| POST | `/api/invoicing/orders/{no}/invoice/sync` | Sync Invoice | Bearer |  |  | 200 | `json` |
| GET | `/api/invoicing/invoices` | List Invoices | Bearer |  | only_open, limit | 200 | `InvoiceRow[]` |
| GET | `/api/invoicing/orders/{no}/invoice.pdf` | Invoice Pdf | Bearer |  | refresh | 200 |  |
| GET | `/api/invoicing/orders/{no}/invoice/links` | Invoice Links | Bearer |  |  | 200 | `InvoiceLinks` |
| POST | `/api/invoicing/orders/{no}/invoice/send` | Resend Invoice | Bearer |  |  | 200 | `json` |
| POST | `/api/invoicing/orders/{no}/invoice/void` | Void Invoice | Bearer |  |  | 200 | `json` |
| POST | `/api/invoicing/orders/{no}/invoice/paid` | Mark Paid | Bearer | `ManualPayment` |  | 200 | `json` |
| POST | `/api/invoicing/invoices/sync-open` | Sync All Open | Bearer |  |  | 200 | `json` |

### 7.19 `factory` — 72 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/factory/floor` | Get Floor | Bearer |  | floor_id | 200 | `FloorOut` |
| PUT | `/api/factory/floor` | Put Floor | Bearer | `FloorIn` | floor_id | 200 | `FloorOut` |
| GET | `/api/factory/route` | Route Between | Bearer |  | from_id*, to_id* | 200 | `json` |
| GET | `/api/factory/stations` | List Stations | Bearer |  |  | 200 | `StationOut[]` |
| POST | `/api/factory/stations` | Create Station | Bearer | `StationIn` |  | 200 | `StationOut` |
| PUT | `/api/factory/stations/{sid}` | Update Station | Bearer | `StationIn` |  | 200 | `StationOut` |
| DELETE | `/api/factory/stations/{sid}` | Delete Station | Bearer |  |  | 204 |  |
| POST | `/api/factory/stations/{sid}/model` | Upload Station Model | Bearer | `Body_upload_station_model_api_factory_stations__sid__model_post` |  | 200 | `StationOut` |
| GET | `/api/factory/stations/{sid}/model` | Get Station Model | Bearer |  |  | 200 | `json` |
| DELETE | `/api/factory/stations/{sid}/model` | Delete Station Model | Bearer |  |  | 200 | `StationOut` |
| GET | `/api/factory/settings` | List Settings | Bearer |  |  | 200 | `gimel__routers__factory__SettingOut[]` |
| GET | `/api/factory/settings/{key}` | Get Setting | Bearer |  |  | 200 | `gimel__routers__factory__SettingOut` |
| PUT | `/api/factory/settings/{key}` | Put Setting | Bearer | `gimel__routers__factory__SettingIn` |  | 200 | `gimel__routers__factory__SettingOut` |
| GET | `/api/factory/stations/{sid}/view` | Station View | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/work-orders/{no}/ranking` | Work Order Ranking | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/routing/simulate` | Simulate Routing | Bearer | `SimulateIn` |  | 200 | `json` |
| POST | `/api/factory/work-orders/{no}/assign` | Assign Work Order | Bearer | `gimel__routers__factory__AssignIn` |  | 200 | `json` |
| GET | `/api/factory/plan` | Get Plan | Bearer |  | limit, include_assigned | 200 | `json` |
| POST | `/api/factory/plan/apply` | Apply Plan Endpoint | Bearer | `ApplyIn` |  | 200 | `json` |
| POST | `/api/factory/plan/feed` | Feed Empty Stations | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/stations/{sid}/queue` | Station Queue | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/orders/{order_no}/handlers` | Order Handlers | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/orders/{order_no}/handler` | Set Order Handler | Bearer | `HandlerIn` |  | 200 | `json` |
| GET | `/api/factory/handlers/plan` | Handler Plan | Bearer |  | limit | 200 | `json` |
| GET | `/api/factory/flow` | Flow | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/stations/{sid}/complete/{order_no}` | Mark Completed | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/orders/ranking/{order_no}` | Order Ranking Legacy | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/pipeline` | Pipeline | Bearer |  | limit | 200 | `json` |
| GET | `/api/factory/staging` | Staging | Bearer |  | limit | 200 | `json` |
| GET | `/api/factory/twin/analysis` | Twin Analysis | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/floor/outline/from-dxf` | Outline From Dxf | Bearer | `Body_outline_from_dxf_api_factory_floor_outline_from_dxf_post` | unit, target_w_m | 200 | `json` |
| GET | `/api/factory/worklist` | Get Worklist | Bearer |  | kind | 200 | `json` |
| POST | `/api/factory/worklist/reconcile` | Run Worklist Reconcile | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/stations/{sid}/worklist` | Get Station Worklist | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/worklist/plan` | Get Worklist Plan | Bearer |  | kind | 200 | `json` |
| POST | `/api/factory/worklist/apply` | Apply Worklist Plan | Bearer | `WorklistApplyIn` |  | 200 | `json` |
| POST | `/api/factory/tasks/{task_id}/assign` | Assign Task | Bearer | `TaskAssignIn` |  | 200 | `json` |
| POST | `/api/factory/tasks/{task_id}/state` | Set Task State | Bearer | `TaskStateIn` |  | 200 | `json` |
| POST | `/api/factory/stations/{sid}/worklist/order` | Reorder Worklist | Bearer | `ReorderIn` |  | 200 | `json` |
| DELETE | `/api/factory/stations/{sid}/worklist/order` | Free Worklist Order | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/picking` | Picking Board | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/stock-locations` | List Stock Locations | Bearer |  | mat | 200 | `json` |
| POST | `/api/factory/stock-locations` | Create Stock Location | Bearer | `StockLocationIn` |  | 200 | `json` |
| PUT | `/api/factory/stock-locations/{loc_id}` | Update Stock Location | Bearer | `StockLocationIn` |  | 200 | `json` |
| DELETE | `/api/factory/stock-locations/{loc_id}` | Delete Stock Location | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/topology` | Topology | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/sites` | Create Site | Bearer | `SiteIn` |  | 200 | `SiteOut` |
| PUT | `/api/factory/sites/{site_id}` | Update Site | Bearer | `SiteIn` |  | 200 | `SiteOut` |
| DELETE | `/api/factory/sites/{site_id}` | Delete Site | Bearer |  |  | 204 |  |
| POST | `/api/factory/halls` | Create Hall | Bearer | `HallIn` |  | 200 | `HallOut` |
| PUT | `/api/factory/halls/{hall_id}` | Update Hall | Bearer | `HallIn` |  | 200 | `HallOut` |
| DELETE | `/api/factory/halls/{hall_id}` | Delete Hall | Bearer |  |  | 204 |  |
| POST | `/api/factory/floors` | Create Level | Bearer | `LevelIn` |  | 200 | `FloorOut` |
| DELETE | `/api/factory/floors/{floor_id}` | Delete Level | Bearer |  |  | 204 |  |
| GET | `/api/factory/orders/{order_no}/scope` | Get Order Scope | Bearer |  |  | 200 | `json` |
| PUT | `/api/factory/orders/{order_no}/scope` | Set Order Scope | Bearer | `ScopeIn` |  | 200 | `json` |
| PUT | `/api/factory/work-orders/{no}/scope` | Set Work Order Scope | Bearer | `ScopeIn` |  | 200 | `json` |
| GET | `/api/factory/views` | List Views | Bearer |  | floor_id | 200 | `TwinViewOut[]` |
| POST | `/api/factory/views` | Create View | Bearer | `TwinViewIn` |  | 201 | `TwinViewOut` |
| DELETE | `/api/factory/views/{view_id}` | Delete View | Bearer |  |  | 204 |  |
| GET | `/api/factory/fleet-sim/defaults` | Fleet Sim Defaults | Bearer |  | floor_id | 200 | `json` |
| POST | `/api/factory/fleet-sim/run` | Fleet Sim Run | Bearer | `FleetSimIn` |  | 200 | `json` |
| GET | `/api/factory/fleet-sim/scenarios` | List Fleet Scenarios | Bearer |  | floor_id | 200 | `array` |
| POST | `/api/factory/fleet-sim/scenarios` | Create Fleet Scenario | Bearer | `FleetScenarioIn` |  | 201 | `json` |
| DELETE | `/api/factory/fleet-sim/scenarios/{scenario_id}` | Delete Fleet Scenario | Bearer |  |  | 204 |  |
| GET | `/api/factory/robots` | List Robots | Bearer |  | floor_id | 200 | `json` |
| POST | `/api/factory/robots` | Create Robot | Bearer | `RobotIn` |  | 201 | `json` |
| GET | `/api/factory/robots/route-check` | Route Check | Bearer |  | floor_id | 200 | `json` |
| POST | `/api/factory/robots/{robot_id}/improve-route` | Improve Route | Bearer | `ImproveIn` |  | 200 | `json` |
| GET | `/api/factory/robots/{robot_id}` | Get Robot | Bearer |  |  | 200 | `json` |
| PUT | `/api/factory/robots/{robot_id}` | Update Robot | Bearer | `RobotIn` |  | 200 | `json` |
| DELETE | `/api/factory/robots/{robot_id}` | Delete Robot | Bearer |  |  | 204 |  |

### 7.20 `robots` — 26 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/factory/robot-gateways` | List Gateways | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/robot-gateways` | Create Gateway | Bearer | `GatewayIn` |  | 201 | `json` |
| PUT | `/api/factory/robot-gateways/{gateway_id}` | Update Gateway | Bearer | `GatewayIn` |  | 200 | `json` |
| DELETE | `/api/factory/robot-gateways/{gateway_id}` | Delete Gateway | Bearer |  |  | 204 |  |
| POST | `/api/factory/robot-gateways/{gateway_id}/test` | Test Gateway | Bearer |  |  | 200 | `json` |
| GET | `/api/factory/robot-programs` | List Programs | Bearer |  | status, limit | 200 | `json` |
| POST | `/api/factory/robot-programs` | Create Program | Bearer | `ProgramIn` |  | 201 | `json` |
| POST | `/api/factory/robot-programs/{program_id}/approve` | Approve Program | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/robot-programs/{program_id}/deploy` | Deploy Program | Bearer | `DeployIn` |  | 201 | `json` |
| GET | `/api/factory/robot-deployments` | List Deployments | Bearer |  | limit | 200 | `json` |
| POST | `/api/factory/robot-deployments/{deployment_id}/rollback` | Rollback Deployment | Bearer |  |  | 201 | `json` |
| GET | `/api/factory/robot-jobs` | List Jobs | Bearer |  | state, active, floor_id, order_no, work_order_no | 200 | `json` |
| POST | `/api/factory/robot-jobs` | Create Job | Bearer | `JobIn` |  | 201 | `json` |
| POST | `/api/factory/robot-jobs/plan` | Plan Job | Bearer | `JobIn` |  | 200 | `json` |
| GET | `/api/factory/robot-jobs/{job_id}` | Get Job | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/robot-jobs/{job_id}/approve` | Approve Job | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/robot-jobs/{job_id}/assign` | Assign Job | Bearer | `gimel__routers__robot_job_routes__AssignIn` |  | 200 | `json` |
| POST | `/api/factory/robot-jobs/{job_id}/start` | Start Job | Bearer |  |  | 200 | `json` |
| POST | `/api/factory/robot-jobs/{job_id}/done` | Done Job | Bearer | `NoteIn` |  | 200 | `json` |
| POST | `/api/factory/robot-jobs/{job_id}/cancel` | Cancel Job | Bearer | `NoteIn` |  | 200 | `json` |
| POST | `/api/factory/robot-jobs/{job_id}/fail` | Fail Job | Bearer | `NoteIn` |  | 200 | `json` |
| POST | `/api/factory/robot-ways/plan` | Plan Way | Bearer | `WayIn` |  | 200 | `json` |
| POST | `/api/factory/robot-ways/optimize` | Optimize Way | Bearer | `WayOptimizeIn` |  | 200 | `json` |
| POST | `/api/factory/robot-ways/check` | Check Way | Bearer | `WayCheckIn` |  | 200 | `json` |
| GET | `/api/factory/robot-events` | List Robot Events | Bearer |  | robot_id, limit | 200 | `json` |
| POST | `/api/factory/robot-telemetry/{gateway_code}` | Ingest Telemetry | — | `TelemetryIn` |  | 200 | `json` |

### 7.21 `drawings` — 7 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/drawings` | List Drawings | Bearer |  | q, limit, offset | 200 | `json` |
| POST | `/api/drawings` | Create From Points | Bearer | `PointsIn` |  | 200 | `json` |
| GET | `/api/drawings/{drawing_id}` | Get Drawing | Bearer |  |  | 200 | `json` |
| PATCH | `/api/drawings/{drawing_id}` | Rename Drawing | Bearer | `RenameIn` |  | 200 | `json` |
| DELETE | `/api/drawings/{drawing_id}` | Delete Drawing | Bearer |  |  | 200 | `json` |
| POST | `/api/drawings/import/dxf` | Import Dxf | Bearer |  | note | 200 | `json` |
| POST | `/api/drawings/import/svg` | Import Svg | Bearer |  | note | 200 | `json` |

### 7.22 `free-nesting` — 4 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| POST | `/api/free-nesting/runs` | Start Run | Bearer | `RunIn` |  | 200 | `json` |
| GET | `/api/free-nesting/runs/{run_id}` | Get Run | Bearer |  | rev | 200 | `json` |
| POST | `/api/free-nesting/runs/{run_id}/stop` | Stop Run | Bearer |  |  | 200 | `json` |
| GET | `/api/free-nesting/runs/{run_id}/export` | Export Run | Bearer |  | format, sheet | 200 | `json` |

### 7.23 `compliance` — 10 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/compliance/advisories` | List Advisories | — |  | product | 200 | `json` |
| GET | `/api/compliance/advisories/{ref}` | Get Advisory | — |  |  | 200 | `json` |
| GET | `/api/compliance/support-periods` | List Support Periods | — |  |  | 200 | `json` |
| POST | `/api/compliance/reports` | Submit Report | — | `ReportIn` |  | 201 | `json` |
| GET | `/api/compliance/admin/reports` | Admin List Reports | Bearer |  | status | 200 | `json` |
| PATCH | `/api/compliance/admin/reports/{ref}` | Admin Update Report | Bearer | `ReportPatch` |  | 200 | `json` |
| GET | `/api/compliance/admin/advisories` | Admin List Advisories | Bearer |  |  | 200 | `json` |
| POST | `/api/compliance/admin/advisories` | Admin Create Advisory | Bearer | `AdvisoryIn` |  | 201 | `json` |
| PATCH | `/api/compliance/admin/advisories/{ref}` | Admin Update Advisory | Bearer | `AdvisoryPatch` |  | 200 | `json` |
| PUT | `/api/compliance/admin/support-periods` | Admin Replace Support Periods | Bearer | `SupportPeriodIn[]` |  | 200 | `json` |

### 7.24 `vision` — 13 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/vision/status` | Status | Bearer |  |  | 200 | `json` |
| GET | `/api/vision/zone` | Get Zone | Bearer |  |  | 200 | `json` |
| PUT | `/api/vision/zone` | Set Zone | Bearer | `gimel__vision_api__ZoneIn` |  | 200 | `json` |
| DELETE | `/api/vision/zone` | Clear Zone | Bearer |  |  | 200 | `json` |
| GET | `/api/vision/expected` | Expected | Bearer |  | work_order | 200 | `array` |
| POST | `/api/vision/identify` | Identify | Bearer |  | work_order, preview | 200 | `json` |
| POST | `/api/vision/confirm` | Confirm | Bearer | `ConfirmIn` |  | 200 | `json` |
| DELETE | `/api/vision/confirm/{confirmation_id}` | Undo | Bearer |  |  | 200 | `json` |
| GET | `/api/vision/sample` | Sample | Bearer |  | work_order, count, seed | 200 | `json` |
| PUT | `/api/vision/calibration` | Set Calibration | Bearer | `CalibrationIn` |  | 200 | `json` |
| POST | `/api/vision/calibration/point` | Add Point | Bearer | `PointIn` |  | 200 | `json` |
| DELETE | `/api/vision/calibration/points` | Clear Points | Bearer |  |  | 200 | `json` |
| POST | `/api/vision/calibration/rectangle` | Calibrate Rectangle | Bearer | `RectangleIn` |  | 200 | `json` |

### 7.25 `agent` — 37 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/agent/providers` | List Providers | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/providers` | Create Provider | Bearer | `ProviderCreate` |  | 201 | `json` |
| PUT | `/api/agent/providers/{provider_id}` | Update Provider | Bearer | `ProviderUpdate` |  | 200 | `json` |
| DELETE | `/api/agent/providers/{provider_id}` | Delete Provider | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/providers/{provider_id}/default` | Default Provider | Bearer |  |  | 200 | `json` |
| DELETE | `/api/agent/providers/{provider_id}/key` | Delete Provider Key | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/providers/{provider_id}/test` | Test Provider | Bearer |  |  | 200 | `json` |
| GET | `/api/agent/providers/{provider_id}/models` | Provider Models | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/providers/{provider_id}/models/refresh` | Refresh Provider Models | Bearer |  |  | 200 | `json` |
| GET | `/api/agent/config` | Config | Bearer |  |  | 200 | `json` |
| GET | `/api/agent/settings` | Read Settings | Bearer |  |  | 200 | `json` |
| PUT | `/api/agent/settings` | Write Settings | Bearer | `SettingsUpdate` |  | 200 | `json` |
| POST | `/api/agent/settings/reset` | Reset Settings | Bearer | `SettingsReset` |  | 200 | `json` |
| POST | `/api/agent/settings/websearch/test` | Test Websearch | Bearer | `WebSearchTest` |  | 200 | `json` |
| GET | `/api/agent/chats` | List Chats | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/chats` | Create Chat | Bearer | `ChatCreate` |  | 201 | `json` |
| GET | `/api/agent/stats` | Stats | Bearer |  | days | 200 | `json` |
| GET | `/api/agent/chats/{chat_id}` | Get Chat | Bearer |  |  | 200 | `json` |
| PATCH | `/api/agent/chats/{chat_id}` | Update Chat | Bearer | `ChatUpdate` |  | 200 | `json` |
| DELETE | `/api/agent/chats/{chat_id}` | Delete Chat | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/chats/{chat_id}/attachments` | Upload Attachment | Bearer | `Body_upload_attachment_api_agent_chats__chat_id__attachments_post` |  | 201 | `json` |
| DELETE | `/api/agent/chats/{chat_id}/attachments/{attachment_id}` | Delete Attachment | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/chats/{chat_id}/messages` | Post Message | Bearer | `MessageIn` |  | 200 | `json` |
| POST | `/api/agent/chats/{chat_id}/cancel` | Cancel Chat | Bearer |  |  | 200 | `json` |
| GET | `/api/agent/changes` | List Changes | Bearer |  | chat_id, status_filter | 200 | `json` |
| POST | `/api/agent/chats/{chat_id}/changes/{change_id}/revert` | Revert Change | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/chats/{chat_id}/messages/{message_id}/revert` | Revert Message | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/chats/{chat_id}/rewind` | Rewind Chat | Bearer | `RewindIn` |  | 200 | `json` |
| GET | `/api/agent/prompts` | List Prompts | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/prompts` | Create Prompt | Bearer | `PromptIn` |  | 201 | `json` |
| PUT | `/api/agent/prompts/{prompt_id}` | Update Prompt | Bearer | `PromptUpdate` |  | 200 | `json` |
| DELETE | `/api/agent/prompts/{prompt_id}` | Delete Prompt | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/chats/{chat_id}/tools/{name}` | Invoke Tool | Bearer | `ToolInvokeIn` |  | 200 | `json` |
| GET | `/api/agent/tools` | List Tools | Bearer |  |  | 200 | `json` |
| GET | `/api/agent/speech` | Speech Info | Bearer |  |  | 200 | `json` |
| POST | `/api/agent/speech` | Speak | Bearer | `SpeechIn` |  | 200 | `json` |
| GET | `/api/agent/health` | Health | — |  |  | 200 | `json` |

### 7.26 `meta` — 2 routes

| Method | Path | What | Auth | Body | Query | OK | Returns |
|---|---|---|---|---|---|---|---|
| GET | `/api/health` | Health | — |  |  | 200 | `json` |
| GET | `/api/version` | Version | — |  |  | 200 | `json` |

## 8. Client checklist

- [ ] Probe `GET /api/version` first; hide what the server does not offer (`agent`, `vision`).
- [ ] Login is form-encoded; PIN and 2FA are JSON.
- [ ] Single-flight refresh on `401`; a `401` in the middle of a Copilot stream means sign in again.
- [ ] Accept both error shapes; show `detail` as it is.
- [ ] One running Copilot answer per chat; always offer Stop; no read timeout on the stream.
- [ ] Copilot write mode is off by default, visible when on, per chat; Undo on every reversible change.
- [ ] Context sent to the Copilot: hall metres only, ≤ 4 KiB, with a way to send none.
- [ ] `0` in machine values and `0/0` coordinates mean unknown.
- [ ] Never store audio, photos or a position trail on the client.

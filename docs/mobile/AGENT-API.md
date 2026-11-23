# Gimel Copilot (Agent) API — reference for the mobile client

**Source of truth:** local Gimel `main` @ `cb5cdc52` — `agentlab/router.py`, `agentlab/voice_router.py`,
`agentlab/runner.py`, `agentlab/page_context.py`, `agentlab/twin_tools.py`. Verified 2026-11-16 against
the running demo (`http://127.0.0.1:8040/openapi.json`, 357 operations).

**This file supersedes `GIMEL.md` for everything about the assistant.** `GIMEL.md` was derived from the
old `mxsp-all/gimel` tree and does not contain a single `/api/agent` route. Its auth chapter (§5) is
still correct and is the reference for login, refresh and sessions.

Everything is German on the wire: `detail` strings are display-ready German sentences.

---

## 1. Where the API lives

| Instance | Base URL | Agent | Voice (`/transcribe`) | Data |
|---|---|---|---|---|
| Demo portal (dev PC) | `http://127.0.0.1:8040` · LAN `https://192.168.178.54:8447` | yes | yes (`GIMEL_VOICE=1`) | fictional (Musterwerk) |
| Agent Lab (dev PC) | `http://127.0.0.1:8008` | yes | yes | same demo DB |
| Twin Studio (dev PC) | `http://127.0.0.1:8009` | yes | yes | same demo DB, no PIN login |
| **Live Gimel (kali2)** | `https://192.168.178.54:8443` · `https://kali2.fritz.box:8443` | **no — 404** (roadmap task 52) | no | live |

- Feature probe: `GET /api/version` → `{"agent": true|false, "demo": …, "vision": …}`. **If `agent` is
  false, hide the Copilot** — the routes do not exist on that server.
- Voice probe: `GET /api/agent/voice` — 404 means the server has no speech recognition (use Android's
  on-device `SpeechRecognizer` as fallback only if the owner allows it; see §9).
- All agent routes need `Authorization: Bearer <access token>` and a role that passes
  `require_worker` (staff/worker/admin; a `customer` account gets 403). Chats belong to exactly one
  account; an admin cannot read another user's chat (404).
- TLS on the LAN comes from the private **FyreFly LAN CA**. A native client must trust that CA
  explicitly (see `ANDROID-APK.md`); never disable certificate checks.
- The server checks the `Host` header (`gimel/hostguard.py`): `localhost`, any IP literal, or a name
  in `<PREFIX>ALLOWED_HOSTS`. `kali2.fritz.box` must be in that list before the hostname works.

## 2. Minimal flow

```text
POST /api/auth/login            (form: username, password)      → access_token (+ refresh cookie)
GET  /api/version                                                → agent: true?
GET  /api/agent/config                                           → configured: true?
POST /api/agent/chats           {"title": "Halle"}               → chat.id
POST /api/agent/chats/{id}/messages   {content, route, context}  → text/event-stream
POST /api/agent/chats/{id}/cancel                                → stop a running answer
```

## 3. Configuration and catalogue

### `GET /api/agent/config`
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

### `GET /api/agent/tools`
`{"tools": [...], "web_enabled": bool}` — the tools this user may use (150+; role-filtered). Use it for
a "what can I ask" screen and to label tool cards; never hard-code the list.

### `GET /api/agent/prompts` · `POST /prompts` · `PUT /prompts/{id}` · `DELETE /prompts/{id}`
Saved prompts: own, shared, and quick starts.

### `GET /api/agent/stats?days=30`
Tokens and reported cost for the own account (`days=0` = everything).

### `GET /api/agent/health` → `{"ok": true}` (no auth).

## 4. Chats

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

## 5. Sending a message — `POST /api/agent/chats/{id}/messages`

Request (JSON):

| Field | Type | Notes |
|---|---|---|
| `content` | string, 1–20 000 | required, not blank (422) |
| `route` | string ≤ 200 | the screen the user is on, e.g. `/app/factory/twin`; `"/voice"` adds the spoken-answer rule (short, no tables) |
| `context` | object ≤ 64 KiB raw | what the user sees — see §6; sanitised server-side to ≤ 4 KiB |
| `attachment_ids` | int[] ≤ 20 | ids from §7, unused and from this chat |
| `hands_free` | bool | live conversation; with `write_mode` only reversible changes are allowed |

Response: `200 text/event-stream`, one answer per chat at a time. A second POST while one runs → **409**
„In diesem Chat läuft bereits eine Antwort." Errors before the stream starts are normal JSON
(`401/403/404/409/422`); errors after it starts arrive as an `error` event.

### Wire format

```text
event: delta
data: {"type":"delta","text":"Die Station "}

```
`event:` always equals `data.type`. No `id:`, no `retry:`, **no heartbeat**, no resume: if the
connection drops, the run keeps going server-side until it finishes or is cancelled; re-read the chat
with `GET /chats/{id}` to pick up the stored result. This is a **POST** stream, so `EventSource` does
not apply — read the body incrementally (OkHttp `ResponseBody.source()`, Ktor `bodyAsChannel()`),
with **no read timeout** on that call.

### Events

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

### `tool_result.action` — the Copilot drives the screen

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

### `POST /api/agent/chats/{id}/cancel` → `{"cancelled": true|false}`
Sets the stop flag; the stream ends with `done.stopped = true` and the partial answer is kept as
`interrupted`.

### `POST /api/agent/chats/{id}/rewind` — body `{"message_id": <user message id>}`
Hides one user question and everything after it (edit / regenerate). Changes already made by the hidden
part stay in the register and are **not** undone; the response names them.

## 6. `context` — telling the Copilot what the user sees and where they stand

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
  (`placement="in_front"`) then work with no backend change.
- Web rules worth copying: "vor mir" = inside a ±22° cone, ≤ 30 m; "nächste Station" ≤ 4 m while
  walking. Distances are to the machine edge.
- Privacy rule for the mobile client: **hall-local metres only, never WGS84**, and a per-message
  switch to send no context. The position is not stored by the client.

## 7. Attachments

`POST /api/agent/chats/{id}/attachments` — `multipart/form-data`, field `file`, optional `password`
(PDF), `pages` (e.g. `1-3,7`). `201`:

```json
{ "id": 5, "filename": "plan.pdf", "content_type": "application/pdf", "size": 81234,
  "pages": 3, "chars": 5120, "created_at": "…", "meta": {}, "truncated": false, "ocr": false }
```

- Types: `.pdf`, `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.log`, any `text/*`. **No images** —
  a photo cannot be sent to the Copilot today (see §10).
- Limit from settings (`agent_attach_max_mb`, default 15 MB) → 413 with the limit in `detail`.
- Only the extracted text is stored. Attach with `attachment_ids` on the next message;
  `DELETE …/attachments/{aid}` works only while unused (409 afterwards).

## 8. Changes and undo

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

## 9. Voice

### `GET /api/agent/voice` (only where the voice router is mounted)
```json
{ "tts_backend": "lokal", "llm_provider": "…", "stt_available": true, "stt_loaded": true,
  "stt_model": "small", "max_seconds": 120, "tts_available": true,
  "default_voice": "…", "voices": [ {"id": "…", "name": "…"} ] }
```

### `POST /api/agent/transcribe?language=de` — speech → text, recognised on the server
- **Raw body**, not multipart. `Content-Type` one of `audio/webm`, `audio/ogg`, `audio/wav`,
  `audio/x-wav`, `audio/wave`, `audio/mp4`, `audio/mpeg`, `audio/aac`, `video/webm` (else 415).
  Android: `MediaRecorder` → AAC in MP4 (`audio/mp4`) or Opus in OGG; 16 kHz mono is enough.
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

### `GET /api/agent/speech` · `POST /api/agent/speech` — text → audio
`GET` → `{"available", "backend", "default_voice", "voices"}`.
`POST {"text": "≤ 6000", "voice": "", "rate": 0.8–1.4}` → audio bytes (`Content-Type` per backend:
WAV for local Piper, MP3 for `edge`); `503` when unavailable. Speak sentence by sentence while the
answer streams, fetching the next sentence while the current one plays. Alternative on the phone:
Android `TextToSpeech` with an offline German voice — no server load, works on the live Gimel.

### Hands-free ("Live")
Mic stays open → utterance → `/transcribe` → `/messages` with `hands_free: true`, `route: "/voice"` →
speak the answer → listen again. Speaking over the answer cancels playback and calls `/cancel`. Three
silent rounds pause. Nearby conversations are heard and sent to the model — the UI must say so.

## 10. Twin tools the Copilot already has (relevant on the floor)

Read-only: `get_floor_layout`, `get_station_details`, `get_nearby_stations` (defaults to where the
user stands), `find_free_spot`, `find_route`, `measure_between`, `get_twin_findings`,
`rank_stations_for`, `get_robot`, `check_robot_traffic`, `list_twin_views`, `size_fleet`.
What-if (nothing written): `whatif_move_station`, `whatif_station_down`.
Writes (write mode, reversible): `move_station`, `rotate_station`, `save_twin_view`, plus
`create_station` / `update_station` with `placement="in_front"`.
View: `show_in_view` (→ `tool_result.action`, §5).
The full, role-filtered list with schemas: `GET /api/agent/tools`.

## 11. Gaps — proposed, **not built** (no code until the owner says go)

| # | Gap | Proposal | Needed for |
|---|---|---|---|
| G1 | Live Gimel has no agent routes | roadmap task 52-A: full release incl. `agentlab/` and voice deps | Copilot on real data |
| G2 | SSE has no heartbeat; mobile networks and the LAN gate may cut idle streams | `: ping` comment every 15 s; optional `GET /chats/{id}/run` to re-attach | reliable streaming on Wi-Fi roaming |
| G3 | No image attachments | accept `image/jpeg|png|webp` (resized ≤ 1600 px on the phone), pass to vision-capable providers only, never stored | "what is wrong with this part?" |
| G4 | `show_in_view` has no route guidance | new actions `guide_to` (`station_id` or `x,y`, returns polyline from `find_route`) and `place_marker` | AR path on the floor |
| G5 | Position context is free-form `view` keys | keep the keys, add `quelle` (`gps|marker|ar|manuell`) and `genauigkeit_m`; document in `page_context.render` | honest answers about position |
| G6 | No device pairing / device-bound sessions | `POST /api/account/devices/pair-start` (QR, 60 s, single use) + `…/pair-finish`; device name on `auth_sessions` | install without typing a password on the phone |
| G7 | Refresh token only as cookie (`Path=/api/auth`) | fine for OkHttp with a persistent `CookieJar`; alternatively an explicit native refresh grant | native client |
| G8 | No hall markers | `factory_markers` (hall, level, x, y, height, facing, code) + CRUD + printable PDF | indoor re-anchoring |
| G9 | No WGS84 ↔ hall conversion endpoint | pure `core/geo.py`; clients can also compute it from `HallOut.lat/lon/rotation_deg` (see `ANDROID-APK.md`) | located walk |
| G10 | Voice is opt-in per process (`GIMEL_VOICE=1`), never on a tunnelled portal | keep; decide for live Gimel inside task 52 | voice on real data |
| G11 | No 3D asset export | `GET /api/factory/stations/{sid}/model` serves only uploaded GLB/OBJ/STL; built-in machines exist only as three.js code | full models in native AR (v1 draws footprints) |

## 12. Client checklist

- [ ] Probe `version.agent` and `agent/config.configured` before showing the Copilot.
- [ ] Single-flight token refresh on 401 (GIMEL.md §5.8); a 401 mid-stream means re-login, not retry.
- [ ] Error bodies come in two shapes: `{"detail": "text"}` and `{"detail": [{loc,msg,type}]}`.
- [ ] One running answer per chat; disable send while streaming; always offer Stop.
- [ ] Write mode visibly on, per chat, default off; Undo on every reversible change.
- [ ] Context: hall metres only, ≤ 4 KiB, per-message off switch.
- [ ] No audio, photo or position is stored on the phone beyond the current screen.

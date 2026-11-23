# Gimel Mobile — docs for the coding agent

**Not served any more** (owner 2026-11-16: only the endpoints and one structured guide go on the LAN). The LAN link http://192.168.178.24:8091/ now serves `docs/lan/` — `GIMEL-API.md` and `openapi.json`. The files here are working notes on this PC.
Start with `llms.txt`. Status 2026-11-16: **docs only — no app code exists yet.**

| File | Read it for | Trust |
|---|---|---|
| [`PLAN.md`](PLAN.md) | what is being built, in which steps, decisions, risks (roadmap task 53) | current |
| [`ANDROID-APK.md`](ANDROID-APK.md) | the APK for the Google Pixel 8: architecture, trust, session, AR, positioning, permissions, privacy rules, gaps | current |
| [`AGENT-API.md`](AGENT-API.md) | the Copilot: chats, streaming events, view/position context, UI actions, voice, undo, proposed additions | current, verified against code |
| [`API-CURRENT.md`](API-CURRENT.md) | every route of the current server (357), new ones marked | generated from the running demo |
| [`openapi.json`](openapi.json) | exact request/response schemas | generated, current |
| [`GIMEL.md`](GIMEL.md) | product, roles, **auth (§5)**, domain model, lifecycle, conventions | **legacy**: built from old `mxsp-all` code — 285 routes, no agent, old 3D. Where it disagrees with the files above, they win. |

## Rules for any agent working from these files

1. Source of truth for behaviour is the code in `~/Desktop/Gimel` (`main`), not GitHub `mxsp/all`
   (stale since 2026-11-06, legacy agent and 3D code).
2. Do not build until the owner gives the go-ahead per step in `PLAN.md`.
3. Gimel is LAN only. No tunnel, no public address, no cloud SDK that phones home.
4. Never copy live data, a VM `.env`, keys or keystores into the repo or these docs.
5. Never deploy, push or touch kali2; changes go through `fyrefly-sync` with the owner's OK.
6. **Target for now: the Musterwerk GmbH demo only** (owner 2026-11-16). It runs on the dev PC:
   `http://127.0.0.1:8040` locally, **`http://192.168.178.24:8040` from the phone on the LAN**
   (plain HTTP, PIN login, fictional data, agent and voice on). The HTTPS address
   `https://192.168.178.54:8447` exists only while kali2 is up. The live Gimel is out of scope
   until the owner says otherwise (and has no agent routes yet, task 52).
7. German UI text; `detail` strings from the API are display-ready.

## Refreshing the generated files

`openapi.json` and `API-CURRENT.md` are snapshots. After backend changes, fetch
`http://127.0.0.1:8040/openapi.json` again and regenerate the table.

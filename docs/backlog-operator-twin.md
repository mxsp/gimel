# Backlog: Operator experience and twin truth

Status: audit result, 2026-11-04. Not implemented. This is the queue after the
first robot/3D slice; sizes are S/M/L, not commitments.

## P1 — pack/process "done" is reopened by reconcile (fixed 2026-11-05)

`worklist.set_state` wrote done only for `pack`/`process`; the source
(shipment or order) still exists, so the 30-second `reconcile` set the row
back to `ready`. The operator saw "fertig gemeldet" and the task returned.

- Evidence: `gimel/services/worklist.py:899-983`, `:354-438`,
  `:271-337`; UI `web/src/components/WorkQueue.tsx:244-255`.
- Fixed: `station_tasks` now carries `closed_at`/`closed_by`/`closed_key`/
  `closed_reason`; `reconcile` keeps a human closure while the source key is
  unchanged and reopens only when the source really changed. Regression:
  `tests/app/test_operations_phase0.py`.
- Size: S.

## P2 — `/twin` is still a second planning twin

`web-twin` shows floor, orders and a routing simulator, but no current task,
no task-level start/done and no large-touch operator flow. The real execution
lives in `/app` `FactoryStation`.

- Evidence: `web-twin/src/App.tsx:37-43`,
  `web-twin/src/pages/TwinView.tsx:36-72`, `:358-445`,
  `web-twin/src/pages/StationView.tsx:64-76`;
  `web/src/pages/FactoryStation.tsx:827-877`.
- Smallest fix: make `StationView` the station terminal using
  `/api/factory/stations/{id}/worklist` and `/tasks/{id}/state`; move the
  routing simulator to `/app` only.
- Size: M. Depends on P1, P4, P7.

## P3 — printed "Barcode"/"QR" are decorative placeholders

The traveller prints hash-derived graphics, not valid encodings. No scan
endpoint exists.

- Evidence: `gimel/render/plate.py:45-114`, `:441-465`;
  `gimel/admin/produktion.js:70-91`.
- Smallest fix: real Code 128/QR plus `POST /api/factory/tasks/scan`
  (keyboard-wedge first). Keep the printed number as fallback.
- Size: M.

## P4 — no loss reasons or actual minutes

Task rows store only state and actors. Downtime, scrap, rework and blocked are
not captured; twin findings use `planned_min`, not actuals.

- Evidence: `gimel/models.py:1553-1563`,
  `gimel/services/worklist.py:899-931`,
  `web/src/components/WorkQueue.tsx:244-255`,
  `gimel/services/twin_analysis.py:568-579`.
- Smallest fix: `task_reasons` table/settings catalog, reason for
  pause/block/scrap, derive `actual_min` from start/done.
- Size: M. Do after P1.

## P5 — freshness is page freshness, missing worklist becomes 0

`FactoryTwin` marks the page stale after 90 s, but never the station data. If
the worklist fetch fails, top KPIs show 0 instead of unknown.

- Evidence: `web/src/pages/FactoryTwin.tsx:38-39`, `:178-235`,
  `:419-427`; `gimel/services/worklist.py:1108-1122`.
- Smallest fix: per-station `last_event_at`/`quality`, "unbekannt" KPIs when a
  source failed. Interim derivation from task/order timestamps is enough.
- Size: S/M.

## P6 — material flow is measured on the first floor only

`material_flow` and station supply use `layout_of(db)` for every station pair,
so multi-floor/multi-hall distances can be plausible but wrong.

- Evidence: `gimel/services/factory_router.py:725-790`;
  `gimel/routers/factory.py:846-867`; correct primitive
  `gimel/core/routing.py:266-291`.
- Smallest fix: use `ctx.route_between` and return "kein Weg" instead of a
  first-floor straight line.
- Size: S/M.

## P7 — worker endpoints are not station-scoped

Any worker can read/mutate any station/task; `assigned_users`/`visibility` only
gate parts of `station_view`.

- Evidence: `gimel/routers/factory.py:400-409`, `:1931-1944`,
  `:1966-1995`, `:2114-2137`, `:1271-1284`;
  `web/src/constants.ts:79-80`.
- Smallest fix: one `allowed_station_ids(user)` resolver applied to stations,
  worklist, task state and complete; explicit `all_for_all` override.
- Size: M.

## P8 — task changes do not reach the existing SSE bus

State/assignment routes never publish; operator pages poll every 30 s.

- Evidence: `gimel/services/events.py:19-42`,
  `gimel/routers/admin.py:50-102`,
  `gimel/routers/factory.py:2070-2137`,
  `web/src/pages/Worklist.tsx:60-64`.
- Smallest fix: publish `task_state`/`task_assign` after commit, add one shared
  `useLive` hook with polling fallback.
- Size: S.

## P9 — no event spine, no replay, no durable actual history

Current rows are overwritten; the in-memory bus is not a log. A shift cannot be
replayed and KPIs remain plan calculations.

- Evidence: `gimel/services/events.py:19-42`,
  `gimel/models.py:1474-1574`,
  `web/src/components/twin/TimeBand.tsx:5`,
  `gimel/services/twin_analysis.py:553-600`.
- Smallest fix: append-only `twin_events` + `station_states`, emitted from
  `worklist.set_state`/`assign`, `GET /api/twin/events?since=`.
- Size: L.

## P10 — robot telemetry lacks freshness/unknown-pose guardrails

**Done in the second robot slice:** `age_s`, `stale` and `position_known` are
returned, the 3D label no longer invents `0°` for an unknown heading, a robot
route saved through the fleet editor is checked against outline and obstacles
when a floor is given, and `POST /api/factory/robot-ways/check` validates a
free route.

`updated_at` was returned but ignored; a real robot with null heading was drawn
facing east; admin routes were not checked against outline/obstacles/aisles.

- Evidence: `gimel/services/robot_fleet.py:89-118`,
  `web/src/components/twin/robots.ts:87-98`,
  `gimel/routers/robots.py:67-77`.
- Smallest fix: return `age_s`/`stale`/`position_known`, show "Position
  unbekannt"/"Kurs ?", validate routes on create/update.
- Size: M.

## P11 — floor saves have no revision or pre-save validation

`PUT /floor` overwrites outline, obstacles, doors and aisles; only an audit
line remains. A bad layout silently replaces the truth.

- Evidence: `gimel/routers/factory.py:205-242`,
  `gimel/models.py:1254-1298`, `:429-454`.
- Smallest fix: `factory_floor_revisions` snapshot, restore writes a new
  revision, validation before write.
- Size: M.

## P12 — no station session or shift handover

We know who clicked, not who is at the machine or on which shift.

- Evidence: `gimel/models.py:1556-1563`,
  `gimel/services/worklist.py:921-927`,
  `web/src/pages/FactoryStation.tsx:741-769`.
- Smallest fix: `station_sessions` + start/stop endpoints and a short handover
  record; no performance scoring.
- Size: M/L.

## Quick wins, in order

1. P1: stop reconcile from reopening done `pack`/`process` tasks.
2. P8: publish task changes to the existing SSE bus, keep polling fallback.
3. P5: show "unbekannt" instead of 0 when the worklist source failed.
4. P10: remove the `heading_deg ?? 0` fallback and show age/staleness.
5. P6: use `ctx.route_between` for station supply.
6. P2: remove/hide the routing simulator in `/twin`.
7. P3: stop labelling placeholder graphics as Barcode/QR until a real encoder
   exists.

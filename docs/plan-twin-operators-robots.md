# Plan: Digital Twin, Operator Experience, Robots in the Loop

Status: proposal for review, 2026-11-04. First slice implemented: read-only
virtual fleet (`robot_assets`, `/api/factory/robots`), demo robots and a live
robot layer in the 3D hall. Second slice implemented: local gateway endpoints,
versioned program deployment, transport jobs with order context, way planning
from the aisle graph and a robot job layer in 3D and on the Robots page. The
remaining stages are still proposal, not committed work.
Scope: Gimel as a platform, standalone and as the base for Alef.
Basis: `CLAUDE.md`, the current code in `gimel/`, `web/` and `web-twin/`.

## 1. Intent

Three outcomes, in this order:

1. **The twin tells the truth, and says how sure it is.** It must answer "what is
   true now", "what was true at 09:15", and "what would happen if". Today it
   answers mostly the third question from a plan, not the first from the hall.
2. **An operator can run a station with one hand and a scanner.** One task at a
   time, large targets, no navigation maze, no silent assumptions, and every
   start/done/reason captured where it happens.
3. **Robots enter as transport resources, not as a second factory system.**
   Simulate first, read-only second, assisted dispatch third, autonomous last.
   The fleet manager keeps the safety functions; Gimel keeps the work.

The design rule behind all three: **capture the event where it happens, derive
everything else.** A twin that is typed in twice is a second truth; an operator
screen that is a report is work added to the shift.

## 2. Non-negotiable constraints

These come from `CLAUDE.md` and remain true for every work package below.

- **The core stays pure.** `gimel/core/` has no database, no I/O and no wall
  clock; callers pass `now`. New simulation and transport code follows that.
  The only time-budget exception remains `nesting.py`.
- **The seam is `gimel/extensions.py`.** Gimel never imports an application.
  Vendor robot adapters belong in a plugin or a service, never in the core.
- **0 in a machine value means unknown, never zero.** For physical robot
  quantities where zero is meaningful (battery, pose, weight), use nullable
  values instead; see RB-1.
- **Live schema discipline.** Never rename a table or column. New columns go
  through `ADDED_COLUMNS` in `seed.py`; new tables are created by `create_all`.
  There is still no Alembic path, so new tables must be additive and safe on
  an existing production SQLite.
- **LAN only.** Machine and robot gateways live on the local network. No
  tunnel, no cloud broker, no public robot endpoint.
- **Every state change is audited.** A task start, a reason code, a robot order
  and a manual override each leave an `AuditLog` line with the signed-in actor.
- **No false precision.** Measured, reported, estimated and unknown are
  different states and must look different. The twin already uses fixed lines,
  `≈` and `?`; extend that language instead of flattening it.
- **Demo data stays fictional.** A virtual robot in the demo is a model, not a
  connection to a real machine.
- **German UI and German reasons.** Code comments and user-visible text follow
  the house style. A new router also goes into Alef's `app/_moved.py`.

## 3. Where we are

### 3.1 Digital twin

What exists and is worth keeping:

- Site -> hall -> floor topology with map anchors and routing scope
  (`factory_sites`, `factory_halls`, `factory_floors`).
- 2D plan, semi-3D and interactive 3D with built-in device models and uploaded
  GLB/OBJ/STL (`web/src/components/twin/ThreeFloorPlan.tsx`,
  `web-twin/src/pages/TwinView.tsx`).
- Station load, flow edges, time band, handler suggestions and a findings
  engine (`gimel/services/twin_analysis.py`):
  capacity, feed, changeover, transport, layout, dates.
- Routing simulation and machine ranking (`/api/factory/routing/simulate`,
  `gimel/core/routing.py`).
- A working aisle graph and visibility-graph pathfinder, with Python/TypeScript
  parity fixtures (`gimel/core/pathfind.py`, `tests/core/test_pathfinder.py`).

The gap:

- **It is a planning twin, not a live twin.** There is no machine signal, no
  asset state, no event history and no actual-versus-plan comparison. The twin
  analysis is derived from `planned_min` and assignment, not from what happened.
- **Freshness is a timestamp on the page, not a property of the data.** A
  station can be stale or offline and still render as a valid number.
- **No replay.** You can scrub a *planned* time band, but not a past shift.
- **No scenario sandbox with side-effect-free comparison.** The routing
  simulator covers one job; there is no "move this machine / add this robot"
  comparison.
- **Layout is mutable without a revision.** A saved floor is the only version.
- **Two twin surfaces exist.** `/app` has the advanced `FactoryTwin`; `/twin`
  has the lighter `web-twin` with a routing simulator. They already share some
  source modules, but feature work will drift without an explicit owner per
  surface.

### 3.2 Operator

What exists:

- Worker role with a restricted route list (`web/src/constants.ts`), worklist,
  picking, production, shipping, part vision and station views.
- Worklist tasks (`pick`, `cut`, `pack`, `process`) with sequence, reason,
  start/done actors and audit (`gimel/services/worklist.py`).
- Manual start/pause/done and a broad station page
  (`web/src/pages/FactoryStation.tsx`).
- Station visibility and `assigned_users` gate parts of the station view
  (`gimel/routers/factory.py`).
- Part recognition at the table with a camera or uploaded still.

The gap:

- **No station session.** We know who clicked, not who is standing at the
  machine, on which shift, since when.
- **The worker UI is a desktop UI.** It works, but it is dense, mouse-oriented
  and navigation-heavy for a tablet in gloves.
- **No scan.** Job, plate and part labels are not a first-class start/stop
  mechanism, so the wrong job or the wrong material is caught by people, not
  by the system.
- **No reasons.** Downtime, scrap, rework and "waiting for material" are not
  captured, so the twin cannot explain losses and planning cannot improve them.
- **No shift handover.** Open issues and machine state are reconstructed by
  looking around.
- **No push.** The station refreshes on a timer; there is no "your next job is
  ready" or "material is missing" signal.
- **Scoping is partial.** `assigned_users` and visibility protect the station
  view, but the worker route list is broad and not site/hall-scoped server-side.

### 3.3 Robots

There is no robot code today. What exists is a good foundation:

- Metric floor coordinates, multi-level halls, door positions and widths.
- An aisle graph that is already used for distance, routing and 3D flow paths.
- A pure pathfinder that respects outline and obstacles.
- A pure worklist and routing core with deterministic scoring.
- SSE and a scheduler that can carry live updates and periodic reconciliation.

The gap is not "a robot class". The gap is the contract:

- No mobile asset model, no pose, no battery, no capabilities, no handover
  points.
- No transport demand separate from cutting/picking tasks.
- No gateway abstraction, no fleet-manager protocol, no safety envelope.
- No simulation that can answer "how many robots, which routes, what queue".

### 3.4 What we must not break

- The pure core and `tests/core/test_core_is_pure.py`.
- The routing/aisle parity between Python and TypeScript.
- The "propose, then apply" pattern: a plan is read-only until an explicit
  click. Robots make this more important, not less.
- The demo's fictional data and the LAN-only posture.

## 4. Target architecture

```
  PLC / machine        Robot fleet manager        Scanner / tablet
  (OPC UA, Modbus,     (VDA 5050 / vendor API)    (browser camera or
   MQTT, vendor)              |                    USB/Bluetooth)
        |                     |                          |
        +---------------------+--------------------------+
                              |
                 local gateway adapters (no cloud)
                              |
        +---------------------v--------------------------+
        |  services/twin_ingest.py                       |
        |  services/operator.py                          |
        |  services/robot_gateway.py                     |
        |  normalize, dedupe, validate, audit, publish   |
        +---------------------+--------------------------+
                              |
        +---------------------v--------------------------+
        |  SQLite: twin_events, station_sessions,        |
        |  transport_jobs, robot_assets, robot_events,   |
        |  layout_revisions, ...                         |
        +---------------------+--------------------------+
                              |
        +---------------------v--------------------------+
        |  gimel/core/ (pure)                            |
        |  routing, worklist, pathfind,                  |
        |  twin_state, transport, simulation             |
        +---------------------+--------------------------+
                              |
        +---------------------v--------------------------+
        |  REST + SSE + existing audit                    |
        +---------------------+--------------------------+
                              |
              /app (Büro, Leitstand)       /twin (Halle, operator terminal)
```

Ownership by surface, to stop the drift:

- **`/app`** is the office and Leitstand: planning, findings, scenarios, layout
  editing, administration, robot fleet overview.
- **`/twin`** is the hall: station terminal, task execution, scan, andon,
  handover. It may read the same APIs, but it is not a second planning UI.
- Shared React components live in `web/src/components/twin/`; `web-twin`
  already imports selected modules from `web/src`, and new shared pieces should
  follow that path. Do not fork a component to change one label.

### 4.1 Event contract

Every source writes the same envelope. The server owns the id and the received
time; the source owns the idempotency key.

```json
{
  "schema": 1,
  "type": "task.started",
  "ts": "2026-11-04T09:15:00Z",
  "source": "operator",
  "source_id": "station:12",
  "station_id": 12,
  "asset_id": null,
  "quality": "reported",
  "idempotency_key": "station12:task:cut:WO-1042:started",
  "payload": {"task_id": 4711, "kind": "cut", "ref": "WO-1042"}
}
```

Rules:

- `quality` is `measured`, `reported`, `estimated` or `unknown`. It is not a
  comment; it drives colour, wording and whether a value may feed a KPI.
- The server stores `received_at`; ordering uses server time. Late events are
  accepted and flagged, not silently reordered into history.
- Duplicate `(source, idempotency_key)` is a no-op. This is how retries from a
  scanner, a PLC gateway or a robot fleet manager stay safe.
- **State changes write their event in the same SQLite transaction as the
  change.** Publish to SSE after commit. No outbox daemon in phase 1; the
  single-process model makes the transaction the outbox.
- **Do not store raw high-frequency tags.** Persist state changes and a
  heartbeat (for example every 10 s). Downsample at the gateway. SQLite is not
  a historian.

### 4.2 New tables (additive)

| Table | Purpose | Important fields |
|---|---|---|
| `twin_events` | Append-only event spine | `id`, `ts`, `received_at`, `type`, `source`, `source_id`, `station_id`, `asset_id`, `quality`, `idempotency_key`, `payload`, `schema` |
| `station_states` | Last-value view per station, fast reads | `station_id`, `state`, `since`, `source`, `quality`, `updated_at` |
| `station_sessions` | Who is at which station, on which shift | `station_id`, `user_id`, `shift`, `started_at`, `ended_at`, `ended_reason` |
| `task_reasons` | Downtime, scrap, rework, blocked | `task_id`, `reason`, `minutes`, `note`, `created_by`, `created_at` |
| `transport_jobs` | A move that a human or robot must do | `ref`, `kind`, `from_station_id`, `to_station_id`, `payload`, `priority`, `state`, `robot_id`, timestamps |
| `robot_assets` | Mobile resource, not a station | `name`, `kind`, `floor_id`, `pose` (nullable), `battery_pct` (nullable), `state`, `capabilities`, `gateway_id`, `active` |
| `robot_events` | Robot telemetry and order history | `robot_id`, `ts`, `type`, `quality`, `payload`, `idempotency_key` |
| `layout_revisions` | Every saved floor, with a diffable snapshot | `floor_id`, `rev`, `snapshot`, `created_at`, `created_by`, `note` |

Columns added to existing tables go through `ADDED_COLUMNS`, for example a
`handover_point` JSON on `factory_stations` only if a separate transport point
table is not justified yet. New tables do not rename or replace anything.

### 4.3 New pure modules

- `gimel/core/twin_state.py` — reduce events to a state, compute staleness,
  confidence, actual-versus-plan and simple operational KPIs. Takes `now`.
- `gimel/core/transport.py` — derive transport demand from worklist facts,
  allocate jobs to resources, reserve aisle segments, return paths and ETAs.
  Deterministic, step-budgeted, no clock.
- `gimel/core/simulation.py` — run a scenario (layout, station set, fleet,
  demand, shift) for N steps and return KPIs and a trace. Same input, same
  output; no writes.
- `gimel/core/robot.py` — a small kinematic/state model for the simulator and
  for validating a fleet-manager state. No vendor I/O, no safety logic.

### 4.4 New services and routers

- `gimel/services/twin_ingest.py` — validation, idempotency, persistence,
  last-value update, audit and SSE publish.
- `gimel/services/operator.py` — station sessions, shift handover, reason
  codes, "next task" query.
- `gimel/services/robot_gateway.py` — `RobotGateway` protocol, simulator
  adapter, VDA 5050 adapter, vendor adapter slot. Never imported by core.
- `gimel/routers/twin.py` — `/api/twin/state`, `/api/twin/events`,
  `/api/twin/stream`, `/api/twin/replay`, `/api/twin/scenarios`.
- `gimel/routers/operator.py` — `/api/operator/session`, `/api/operator/next`,
  `/api/operator/reason`, `/api/operator/handover`.
- `gimel/routers/transport.py` — transport jobs and robot fleet read/dispatch.
- Register the routers in `app.py` and in Alef's `app/_moved.py`.

Do not grow `gimel/routers/factory.py` further; it is already 2,680 lines.

## 5. Workstream A — Digital twin improvements

### DT-0. One owner per twin surface

**Outcome:** `/app` is the Leitstand/office, `/twin` is the hall/operator
surface. A feature has exactly one home.

**Work:** agree the split, remove duplicate "routing simulator/floor" features
from the surface that does not own them, keep shared components in one place.

**Acceptance:** a feature list with one owner; no new duplicated component;
`web` and `web-twin` builds stay green.

### DT-1. Event spine and last-value state

**Outcome:** every relevant action (task state, assignment, pick, part
confirmation, shipping, future machine/robot signal) produces a `twin_event`;
`/api/twin/state` returns current station state with source and quality.

**Work:** event envelope, `twin_events`, `station_states`, emit from
`worklist.set_state`, `factory_router.assign`, shipping/vision hooks, SSE event
type `twin`, replay query.

**Acceptance:** duplicate event is a no-op; out-of-order event is flagged;
state endpoint matches the event history; audit line for manual changes;
`tests/app/test_twin_events.py`.

### DT-2. Freshness, confidence and offline

**Outcome:** the twin never shows a plausible number when the source is stale.
Live, reported, estimated, unknown and offline look different and say since
when.

**Work:** `quality` + `freshness` in the state reducer; badge in
`FactoryTwin`/`ThreeFloorPlan` labels; stale stations dimmed; "last seen" in
the inspector.

**Acceptance:** a station with an old event shows `veraltet` (or `offline`
after the configured threshold); no KPI consumes an unknown value without a
visible marker; German wording.

### DT-3. Actual versus plan, and operational KPIs

**Outcome:** planned minutes, actual minutes, wait time, changeover time,
scrap and block time sit next to each other. The source of each number is
visible.

**Work:** derive actuals from task start/done and reason codes; a small KPI
set (queue, throughput, wait, changeover share, scrap share, availability) in
`core/twin_state.py`; surface on `FactoryOptimize` and the station inspector.

**Acceptance:** a task with no start/done has no invented actual; a manual
reason is `reported`, not `measured`; KPI definitions are written down in the
module docstring.

### DT-4. Replay and shift comparison

**Outcome:** choose a past window and see the hall as it was, with events,
queue state and a timeline. Compare two shifts without exporting data.

**Work:** `GET /api/twin/replay`; timeline scrubber extension of `TimeBand`;
pure reducer from events; a "Was war um 09:15?" drawer.

**Acceptance:** replay is read-only; no replay event can be written back;
the same event window yields the same state; no raw high-frequency logs.

### DT-5. Scenario sandbox

**Outcome:** test "move press 3", "add a second shift", "one more plotter",
"two robots" against the current plan and compare KPI deltas, before changing
anything.

**Work:** scenario input type (stations, floors, fleet, demand, capacity),
`core/simulation.py`, `POST /api/twin/scenarios` (staff only, no writes),
comparison view; reuse `routing.simulate` for the job-level case.

**Acceptance:** scenario result carries "simuliert" and its assumptions; no
station, order or layout row is changed; deterministic with the same seed and
step budget.

### DT-6. Layout revisions and validation

**Outcome:** every floor save is a revision with an author and a note; the twin
can compare revisions and block a save that breaks routing (station outside
outline, no aisle connection, door too narrow for a robot route).

**Work:** `layout_revisions`; `save_floor`/`save_layout` snapshot; validation
before write; a diff view; restore is an explicit, audited action.

**Acceptance:** a revision can be inspected but not silently overwritten;
validation runs before the write lock; restore writes a new revision.

### DT-7. 3D live layer and performance

**Outcome:** 3D shows state, queue pressure and moving transports without
becoming a game. Camera bookmarks, level visibility and label density are
first-class.

**Work:** status animation, transport layer, level-of-detail for large halls,
label collision/decluttering, camera bookmarks, "follow selected station";
measure frame cost on the demo and one large synthetic hall.

**Acceptance:** 60 fps target on the reference laptop; graceful degrade; no
WebGL -> explicit hint (already present); no CSP inline script regression.

### DT-8. Data quality and commissioning wizard

**Outcome:** the twin has a "what is missing" list that a fitter can work
through: no speed, no capacity, no aisle graph, no storage marker, no handover
point, no door width, no robot route.

**Work:** extend `_machine_gaps` from `twin_analysis.py` into a quality score;
a guided setup screen; each gap links to the exact field/editor.

**Acceptance:** score is explainable; a filled gap drops the score immediately;
no gap is ever treated as zero.

### DT-9. Alerts and andon

**Outcome:** a station call, a material shortage, a blocked robot or a late
job creates an event and a visible alert; acknowledge and resolve are audited.

**Work:** event types `alert.raised`/`alert.acknowledged`/`alert.resolved`;
SSE to `/twin`; andon strip in the Leitstand; optional sound at the station
(off by default, user gesture required).

**Acceptance:** no duplicate alert for the same fact; acknowledgement is
per-user; alert history is replayable.

### DT-10. Multi-hall and site edge cases

**Outcome:** robots and twin state respect floor/hall/site boundaries. A route
that needs another hall or a missing map anchor is shown as "kein Weg", not
guessed.

**Work:** reuse `RoutingContext.route_between` rules; add robot route
validation; make `route_scope` visible in the operator terminal.

**Acceptance:** a robot job across an unsupported boundary is refused with a
reason; the twin never draws a straight line through a wall for a robot.

## 6. Workstream B — Operator improvements

### OP-1. Station session and presence

**Outcome:** an operator signs in at a station (badge, PIN or existing login),
the station shows who is there and since when, and a shift end closes the
session.

**Work:** `station_sessions`; `POST /api/operator/session/start|stop`;
presence badge in `/twin` and `/app`; optional auto-close with reason; audit.
Do not make presence a performance score by default.

**Acceptance:** one open session per station and operator; ending is idempotent;
stale sessions are visible, not silently deleted; works-council wording
reviewed before enabling on the floor.

### OP-2. Operator terminal (`/twin`) MVP

**Outcome:** one screen, one task, large touch targets, no sidebar maze. Works
on a tablet in the hall; also usable with keyboard.

**Work:** `web-twin` station terminal: current task, next three tasks, start/
done, material, drawing, cut file, call for help, scan; adapted from
`FactoryStation` but not a copy of its tables.

**Acceptance:** start/done in at most three taps; current task survives a
refresh; error states are German and actionable; no hover-only action; contrast
and font size pass the accessibility check.

### OP-3. Guided task flow

**Outcome:** each task kind has a short, explicit flow: verify material, load,
start, check, done. `pick` knows its target station; `cut` knows its plates;
`pack` knows its shipment; `process` knows its order.

**Work:** flow definitions in `services/operator.py`; checklist and required
confirmations; server-side validation; optional photo attachment for exception
cases (not for every task).

**Acceptance:** a task cannot be "done" while a required confirmation is
missing; every extra step has a reason; flows are data-driven, not a chain of
`if` in a page.

### OP-4. Scan to start, scan to hand over

**Outcome:** a QR/barcode on the job traveller, plate label and part bin is the
primary start and handover action. Wrong job or wrong material is caught before
work starts.

**Work:** label payload (`WO-...`, plate index, task key); scanner input
(keyboard wedge first, camera second); `POST /api/operator/scan`; conflict
response with the expected value; audit.

**Acceptance:** scanning the wrong traveller returns a clear refusal; scan is
idempotent; no camera permission is required for the keyboard-wedge path; no
label contains a customer name or price.

### OP-5. Reasons, actual times and quality

**Outcome:** when a task is paused, blocked or done with scrap, the operator
picks a reason from a short list. The twin gets the actual time and the loss
reason.

**Work:** `task_reasons`; reason catalog in settings; start/pause/done writes
duration; scrap quantity and rework flag where the task supports it; CSV/API
export for the office.

**Acceptance:** no free-text-only loss category; reasons are optional only if
the task type allows it; actual time is derived, never typed; reports label
"gemeldet" versus "gemessen".

### OP-6. Shift handover

**Outcome:** at shift end, the outgoing operator leaves a short handover: open
tasks, machine state, material issues, safety notes. The incoming operator sees
it at the station.

**Work:** `handover` record per station/shift; template with three to five
fields; acknowledgement by the next operator; audit; history in `/app`.

**Acceptance:** handover is per station, not per user only; it never blocks a
task; old handovers are readable but visually marked as history.

### OP-7. Push instead of polling

**Outcome:** the station learns about a new task, a material shortage or an
andon call without waiting for the 30 s refresh.

**Work:** SSE subscription in `/twin` using the existing event bus and ticket
auth; reconnect/backoff; fallback to polling; visible "live" indicator.

**Acceptance:** duplicate events do not duplicate tasks; reconnect does not
lose the current task; SSE failure degrades to polling with a visible note.

### OP-8. Server-side scoping and privacy

**Outcome:** a worker sees their site/hall/assigned stations, not the whole
company. The restriction is enforced by the API, not only by hidden routes.

**Work:** scope resolver in `services/operator.py`; apply to station view,
worklist, transitions and transport requests; admin override; tests for
cross-site access.

**Acceptance:** a worker from site A cannot read or change site B by changing an
id; `all_for_all` remains an explicit admin setting; no route list is the only
guard.

### OP-9. Accessibility and shop-floor ergonomics

**Outcome:** the terminal is usable with gloves, a large screen, poor light and
a keyboard; no essential action depends on hover or colour alone.

**Work:** touch target audit, focus order, contrast, `aria-live` for state,
German abbreviations, optional high-contrast mode, print-friendly traveller.

**Acceptance:** keyboard-only path for start/done; screen reader announces the
current task; colour is never the only status signal; print output is readable
in black and white.

### OP-10. Operator feedback loop (without surveillance)

**Outcome:** operator corrections improve the data, not a hidden score. "This
material is wrong", "this estimate is off", "this drawing is old" becomes a
structured, audited note.

**Work:** feedback action on the task; routing to the office; link to the
affected master data; no automatic re-training, no per-person ranking.

**Acceptance:** feedback is attributable and auditable; aggregate reporting is
the default; individual reports require an admin and a stated purpose.

## 7. Workstream C — Robots in the loop

### RB-1. Mobile asset model, not a station type

**Outcome:** a robot is a mobile resource with pose, battery, capabilities and
state. It is not a `FactoryStation` and not a `StationTask`.

**Work:** `robot_assets` and `robot_events`; coordinate convention matching the
floor (x east, y south, heading degrees); nullable pose with
`position_known`; nullable battery; capabilities (payload, max speed, floor
access, lift, conveyor); handover points as a small table or floor zone.

**Important:** do not apply "0 = unknown" to battery or pose. Battery 0 is
empty; (0, 0) is a real point. Missing means `NULL`/`unknown`.

**Acceptance:** a robot without a pose is displayed as "Position unbekannt",
not at the origin; a robot without a battery reading is not shown as 0 %; a
robot is never assigned a `cut`/`pack` task.

### RB-2. Transport demand from worklist facts

**Outcome:** the system knows what needs to move: storage -> machine,
machine -> buffer/pack, pack -> shipping, remnant -> storage. Demand is derived
from task state, not typed twice.

**Work:** `core/transport.py` demand function; explicit `transport_required`
flag per move (default off for the first pilot); start with two moves only:
`pick done -> cut station` and `cut done -> pack`.

**Acceptance:** no transport job is created for a task that is not done or not
marked; a cancelled job cancels its transport; every job names its source task.

### RB-3. Pure dispatcher

**Outcome:** given jobs, robots, aisle graph and reservations, the dispatcher
returns a deterministic assignment, path and ETA, or an honest "not possible".

**Work:** `core/transport.py`; constraints: floor/hall, door width, payload,
battery reserve, handover availability, one robot per aisle segment
(reservation), priority/deadline, no-go zones; deterministic tie-break; step
budget. Use the existing `pathfind` and `AisleGraph`.

**Acceptance:** same input -> same output; a blocked route returns `None` with
a reason; a lower-battery robot is not chosen when it cannot finish with
reserve; `tests/core/test_transport.py` with golden scenarios.

### RB-4. Virtual fleet and 3D simulation

**Outcome:** robots move in the twin without hardware. The team can size a
fleet, see congestion and test handover rules.

**Work:** simulator adapter implementing the gateway protocol; virtual robots
on the aisle graph; 3D animation in `ThreeFloorPlan`; scenario view
(`DT-5`); golden runs for one shift.

**Acceptance:** a virtual robot stays on aisles and out of obstacles; two
robots never occupy the same reserved segment; the demo shows a fictional
fleet; no real network call.

### RB-5. Gateway abstraction and VDA 5050

**Outcome:** one interface for a simulator, a vendor API and VDA 5050. The
protocol is a deployment detail.

**Work:** `RobotGateway` protocol (`capabilities`, `state`, `submit`, `cancel`,
`events`); settings-selected adapter; local MQTT broker for VDA 5050; mTLS or
token + IP allowlist; idempotent orders; timeouts and retries; no direct
actuator commands.

**Acceptance:** the simulator passes the same contract tests as an adapter;
a duplicate submit does not create a second order; an unreachable gateway
produces "offline", not a stuck job; no cloud endpoint exists.

### RB-6. Read-only twin integration

**Outcome:** a real robot's state appears in the twin, but Gimel sends no
orders. This is the observation phase.

**Work:** ingest `robot_events`; display pose, battery, state, current order;
freshness and offline handling; a "read-only" badge; log only.

**Acceptance:** no outbound order endpoint is reachable in this mode; a stale
robot is visibly stale; the twin does not draw a guessed pose.

### RB-7. Assisted transport dispatch

**Outcome:** Gimel proposes a transport job; a human confirms; the fleet manager
executes; the operator confirms handover. The loop is closed with a person in
it.

**Work:** `transport_jobs` state machine; one-click "Transport beauftragen";
confirmation at the handover point via scan; cancel/retry; audit every command
and override; a job board in `/app`.

**Acceptance:** no order leaves without a named human or an explicit
auto-dispatch setting; a failed order returns to the queue with its reason; a
cancelled order stops the robot via the fleet manager; the audit has actor,
robot, job and result.

### RB-8. Guardrails before autonomy

**Outcome:** autonomy is a setting with a fence, not a switch that removes
people.

**Work:** per-zone/per-route opt-in; max concurrent jobs; rate limit; dry-run;
kill switch; manual override; two-person rule for the first production week;
automatic fallback to manual when the gateway is stale or the error rate rises.

**Acceptance:** kill switch stops new orders immediately and is tested; an
auto-dispatched job is still cancellable by a human; an error budget disables
auto-dispatch; every autonomous action is auditable.

### RB-9. Robot-aware twin findings and KPIs

**Outcome:** the twin says when transport is the bottleneck: empty runs,
handover wait, blocked aisle, battery turn, fleet saturation.

**Work:** extend `twin_analysis` with transport findings; robot KPI set; show
them next to capacity findings; scenario comparison for fleet size.

**Acceptance:** a finding names the number and the cause; a transport finding
is never mixed with a machine capacity finding; a robot estimate is labelled
as an estimate.

### RB-10. Pilot and rollout

**Outcome:** one route, one robot, one shift, measured. Then decide with data.

**Work:** choose a route (storage -> one machine), define success criteria,
run read-only for two weeks, assisted for four weeks, collect interventions,
then decide on expansion.

**Acceptance:** success criteria met (see section 9); no safety incident; no
unplanned production stop attributed to the robot integration; signed review.

## 8. Roadmap

Durations are indicative for one full-stack pair plus a domain reviewer. They
are not commitments.

| Stage | Focus | Duration | Main deliverables | Exit gate |
|---|---|---|---|---|
| 0. Foundations | Event spine, sessions, surface decision | 4 weeks | `twin_events`, state API, SSE, `station_sessions`, ADRs, decision on `/twin` ownership | Duplicate/out-of-order tests green; one station emits events end to end |
| 1. Twin truth + operator MVP | DT-2, DT-3, DT-8, OP-1, OP-2, OP-4, OP-7 | 8-10 weeks | Live/stale state, actual vs plan, data quality, station terminal, scan start/done, push | Pilot station run by an operator for one week without a paper fallback; data quality above 90 % for that station |
| 2. Explanations + simulation | DT-4, DT-5, DT-6, OP-5, OP-6, RB-1..RB-4 | 8-10 weeks | Replay, reasons, handover, layout revisions, scenario sandbox, virtual fleet | A shift can be replayed; a "two robots" scenario is reproducible; no writes from simulation |
| 3. Robot read-only pilot | RB-5, RB-6, RB-9 | 6-8 weeks | Gateway, VDA 5050 or vendor adapter, real robot visible in twin, transport findings | Four weeks of stable read-only state; no guessed pose; gateway failure handled |
| 4. Assisted transport | RB-7, RB-8 (assisted parts), OP-8, OP-9 | 8-10 weeks | Transport jobs, human confirmation, handover scan, kill switch, scoped access | 100 assisted jobs, success rate above 95 %, every override audited |
| 5. Closed loop (conditional) | RB-8, RB-10 | 8-12 weeks | Opt-in auto-dispatch, error budget, rollout decision | Safety review, works council, insurance and operations sign-off; error budget respected |

Dependencies that must not be reordered:

- Event spine before any "live" claim.
- Operator session before operator reasons and handover.
- Simulator before the first real robot order.
- Read-only for a meaningful period before any outbound command.
- Safety review before autonomy, not after.

## 9. Success measures

Twin:

- Event freshness: operator events visible in under 5 s; machine/robot
  heartbeats under 30 s; stale is always visible.
- Data quality: at least 90 % of station time on the pilot line comes from
  reported or measured events, not estimates.
- Replayability: any shift can be reconstructed without reading logs.
- No KPI without a source and a quality label.

Operator:

- Start/done in at most three interactions from the station terminal.
- Scan rate above 90 % of starts on the pilot station.
- Wrong-material/wrong-job incidents reduced to zero in the pilot.
- A new operator can start a task without a guided tour.

Robots:

- Transport lead time and handover wait measured, not guessed.
- Empty-run share below the agreed baseline.
- Assisted job success above 95 % before autonomy.
- Interventions per 100 jobs trending down.
- Zero safety incidents; every override explained.

## 10. Testing and definition of done

For every stage:

- `tools/check-all.sh` in Gimel and then in Alef (the latter runs Alef's
  unchanged backend tests against this package).
- Pure tests for every new core module; `tests/core/test_core_is_pure.py` must
  stay green, including no clock and no I/O in `twin_state`, `transport`,
  `simulation` and `robot`.
- Golden fixtures for transport and simulation (`tests/core/fixtures/`), so a
  result is reproducible and reviewable.
- API tests for idempotency, out-of-order events, duplicate scan, stale
  gateway, unauthorized cross-site access and audit lines.
- Browser tests for the operator terminal and the twin state layer, following
  the existing `web/*.test.mjs` Playwright pattern; build both web apps.
- A demo path that works with fictional data only.
- Documentation: module docstring in German where the code is German, a short
  English plan update here, and an ADR for each irreversible decision.

## 11. Security, safety, privacy

- **Network:** machine and robot gateways on a dedicated VLAN; mTLS or a
  per-gateway token plus IP allowlist; DNS/NTP local. No inbound public route.
- **Robot commands:** high-level orders only. The fleet manager owns collision
  avoidance, zone interlocks, emergency stop and safe braking. Gimel must never
  stream velocity or bypass the fleet manager.
- **Safety:** a risk assessment per cell/route before commissioning; reference
  ISO 12100 and ISO 3691-4 (driverless industrial trucks) as applicable; a
  physical E-stop remains independent of Gimel and the network.
- **Human handover:** handover outside the machine's safety zone; confirm with
  a scan or an explicit terminal action; no "robot is probably there" state.
- **Operator data:** sessions are for traceability and worklist context. No
  camera-based person tracking. Retention configurable; individual reports
  require an admin and a purpose; works council agreement before the pilot.
- **Audit:** event ingestion, manual override, kill switch, robot order, cancel
  and reason code each write an audit line. A duplicate event does not write a
  second line.
- **CSP/CORS:** no inline script; SSE ticket auth as today; no new external
  origin. A local map tile host remains an explicit allowlist decision.

## 12. Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Data quality is worse than assumed | Twin findings mislead planners | Quality labels, commissioning wizard, no automation until the pilot gate |
| Operator adoption fails | Workarounds and double entry | Co-design with operators, scan-first, max three taps, pilot station, no surveillance |
| Two twin surfaces drift | Wasted work, inconsistent truth | DT-0 ownership, shared components, one API contract |
| Robot vendor lock-in | Expensive change later | Gateway protocol, VDA 5050 target, simulator first |
| Safety incident | People hurt, project stopped | Read-only phase, fleet manager safety, risk assessment, kill switch, gates |
| SQLite write load | Slow UI, locked DB | Downsample at gateway, state-change + heartbeat only, retention, read models |
| Network outage | Stale twin, stuck jobs | Freshness/offline states, gateway retry, manual fallback, no silent guess |
| Clock skew | Wrong ordering and KPIs | Server `received_at` for order, NTP on gateways, late-event flag |
| Scope explosion | Nothing ships | Stage gates, explicit non-goals, one pilot route |

## 13. Decisions needed before Stage 2

1. **Operator surface:** keep `/twin` as the hall terminal and `/app` as the
   office, or build a new `/operator` route and retire `web-twin`? Recommendation:
   keep the split, but make it explicit and share components.
2. **Pilot area:** which site, hall, floor and station? Which route for the
   robot?
3. **Machine access:** which controls are present (OPC UA, Modbus, MQTT,
   vendor API), and is a local gateway box allowed? Who owns it?
4. **Robot fleet:** which vendor/fleet manager, and does it support VDA 5050?
   Is a local MQTT broker acceptable?
5. **Operator identity:** badge, PIN, existing login, or a combination? What
   does the works council require for session data?
6. **Measurement policy:** which KPIs may be shown per person, and which only
   in aggregate?
7. **Team and budget:** who builds the gateway, the simulator and the operator
   terminal; is there a safety reviewer and an electrician/controls engineer?
8. **Retention:** how long are events, sessions and robot telemetry kept?

## 14. First 30 days (concrete)

Week 1:

- Decide the operator surface and the pilot area; write two short ADRs
  (event contract, robot gateway).
- Add `twin_events`/`station_states` and the event envelope; emit events from
  `worklist.set_state` and `factory_router.assign`.
- Add `GET /api/twin/state` and a read-only freshness badge in `FactoryTwin`.

Week 2:

- Add `station_sessions` and a station start/stop endpoint; show presence in
  `/twin` and `/app`; audit.
- Add SSE `twin` events with ticket auth and a polling fallback.
- Write `tests/app/test_twin_events.py` for duplicate, out-of-order and stale.

Week 3:

- Build the `/twin` operator skeleton: current task, next tasks, start/done,
  material, drawing, call for help.
- Add QR payloads for a work-order traveller and a plate label; keyboard-wedge
  scan first; scan-to-start on one station.

Week 4:

- Add the simulator adapter and a virtual robot on the existing aisle graph;
  show it in 3D with a "Simulation" badge.
- Add the data quality panel for one hall.
- Review gate: one station emits events end to end; an operator starts and
  finishes a task by scan; a virtual robot follows the aisle; no writes from
  simulation; `tools/check-all.sh` green.

## 15. Out of scope

- A full MES, ERP, WMS replacement or a second planning engine.
- Autonomous robot control without a safety case and a fleet manager.
- Cloud MQTT, remote access, public robot APIs.
- Predictive maintenance or ML quality prediction in this plan.
- Per-person performance ranking, camera-based operator tracking or hidden
  productivity scoring.
- Real customer data in the demo.
- A general-purpose 3D game engine or VR/AR in the first year.
- Renaming existing tables or columns; Alembic is a separate project.

The plan is deliberately ordered so that each stage is useful on its own: a
truthful twin, a better shift, and only then a robot that moves something.

## 16. Implemented first slice (2026-11-04)

- `robot_assets` (new table) and a read-only fleet API: `GET /api/factory/robots`
  with `floor_id` filter, plus admin `POST`/`PUT`/`DELETE` for configuration.
- Pure `gimel/core/robot.py` for loop and ping-pong path poses, and
  `gimel/services/robot_fleet.py` for the time-based virtual position. A robot
  with `gateway_id = "sim"` needs no network; battery and pose stay nullable.
- Three fictional robots in the demo (`AGV 1`, `AGV 2`, `AMR Nord`) on the
  existing aisle graph.
- 3D robot layer in `ThreeFloorPlan`: modeled AGV/AMR, animated between polls,
  route line, state and battery label, HUD count, "Simulation" badge and a
  "Roboter" toggle. The math is shared between Python and TypeScript
  (`web/src/components/twin/robots.ts`) and checked in `web/robots.test.mjs`.
- APIs are read-only for the hall; there is still **no** transport job, no
  fleet-manager order and no actuator command. Those remain the next stages in
  this plan.

## 17. Implemented second slice (2026-11-04)

- **Robot gateways with custom local endpoints.** `robot_gateways` stores the
  protocol (`sim`, `http`, `vda5050`), a local base URL, named paths for
  health/deploy/command/cancel and an encrypted token. Public addresses are
  refused; `services/robot_gateway.py` sends high-level JSON only, with a
  timeout and no redirects.
- **Code deployment as versioned artefacts.** `robot_programs` and
  `robot_deployments` store every version with SHA-256, keep a deployment
  attempt even when the gateway rejects it, and support an explicit rollback
  as a new deployment. Gimel never executes the program text.
- **Telemetry ingress with freshness.** `POST /api/factory/robot-telemetry/{code}`
  accepts a gateway token, deduplicates by `idempotency_key`, writes
  `robot_events` for state changes and heartbeats, and returns `age_s`,
  `stale` and `position_known`. A missing pose is never drawn at the origin.
- **Way and order-context planning.** `core/robot_way.py` turns the aisle graph
  into a polyline (`Layout.path` / `AisleGraph.path`), `core/robot_dispatch.py`
  ranks robots by hard limits and distance, and `robot_jobs` links a transport
  to its work order, customer order or station task. `POST /api/factory/robot-jobs/plan`
  is side-effect free; create/approve/assign/start/done/cancel/fail are audited.
- **Deep twin integration.** The 3D hall draws open transport routes as dashed
  lines with the order context at the destination; the Robots page has tabs
  for fleet, transports, missions and gateways. The robot label names the
  transport it is currently running.
- **Still missing.** No VDA 5050 MQTT adapter yet, no automatic transport
  demand from completed worklist tasks, no fleet-manager safety envelope and
  no autonomous dispatch. The robot job is a proposal until a human approves
  and starts it.

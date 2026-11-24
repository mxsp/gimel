// Twin Studio, reine Rechnungen: node twin-studio.test.mjs
// Wärme, Begehen mit Kollision, Rundgang und Messen ohne Browser.
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (entry) => {
  const out = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};
const m = await bundle("src/components/twin/studioMath.ts");
const c = await bundle("src/components/twin/collision.ts");

// Wärme: grün → gelb → rot, unbekannt grau und nie 0.
assert.equal(m.heatColour(0), "#2ea067");
assert.equal(m.heatColour(1.25), "#d6403c");
assert.equal(m.heatColour(null), "#8a939e");
const st = [
  { id: 1, x: 5, y: 5, w: 2, h: 2, active: true, queue_jobs: 3 },
  { id: 2, x: 15, y: 5, w: 2, h: 2, active: true },
  { id: 3, x: 25, y: 5, w: 2, h: 2, active: false },
];
const spots = m.heatSpots(st, {
  1: { ratio: 1.2, certainty: "estimated", rank: 60 },
  2: { ratio: null, certainty: "unknown", rank: 40 },
});
assert.equal(spots.length, 1, "nur volle Stationen: kein Fleck für unbekannt oder inaktiv");
assert.equal(spots[0].id, 1);
assert.equal(spots[0].estimated, true);
assert.equal(m.heatSpots(st, { 1: { ratio: 0.3 }, 2: { ratio: 0.5 } }).length, 0, "kein grüner Schein");
const warm = m.heatSpots(st, { 1: { ratio: 0.8 }, 2: { ratio: 1.4 } });
assert.equal(warm.length, 2);
assert.ok(warm[1].radius >= warm[0].radius, "überbucht strahlt nicht kleiner");
assert.notEqual(warm[0].colour, "#2ea067");

// Begehen: frei geradeaus, an der Maschine gleiten, nie hinein.
const floor = { outline: [[0, 0], [40, 0], [40, 20], [0, 20]], obstacles: [], zones: [], doors: [], aisles: { nodes: [], edges: [] } };
const stations = [{ id: 9, label: "Laser", x: 20, y: 10, w: 4, h: 4, rotation: 0, active: true, type: "laser" }];
const world = c.buildTwinWorld(floor, stations);
let p = [10, 10];
const north = Math.PI / 2; // yaw: Blick nach +x
for (let i = 0; i < 200; i++) p = m.walkStep(p, north, { forward: 1, strafe: 0 }, 0.05, world).pos;
assert.ok(p[0] < 20 - 2 - m.WALKER_RADIUS_M + 0.05, `bleibt vor der Maschine stehen (${p[0]})`);
const free = m.walkStep([10, 10], north, { forward: 1, strafe: 0 }, 0.1, world);
assert.equal(free.blocked, false);
assert.ok(Math.abs(free.pos[0] - (10 + m.WALK_SPEED_MS * 0.1)) < 1e-9);
const run = m.walkStep([10, 10], north, { forward: 1, strafe: 0, run: true }, 0.1, world);
assert.ok(run.pos[0] > free.pos[0], "Umschalt läuft schneller");
// Schräg gegen die Maschine: gleitet seitlich weiter statt stehen zu bleiben.
let q = [17.4, 7];
const diag = Math.atan2(1, 1); // nach +x und +y
const q0 = q[1];
for (let i = 0; i < 20; i++) q = m.walkStep(q, diag, { forward: 1, strafe: 0 }, 0.05, world).pos;
assert.ok(q[1] > q0 + 0.5, "gleitet an der Kante entlang");
assert.equal(world.query({ kind: "circle", x: q[0], y: q[1], r: m.WALKER_RADIUS_M }, { groups: ["station"] }).length, 0);
// Kein Schritt ohne Eingabe oder Zeit.
assert.deepEqual(m.walkStep([3, 3], 0, { forward: 0, strafe: 0 }, 0.1, world).pos, [3, 3]);
// Startpunkt: frei, innen hinter dem Tor.
const start = m.walkStart({ x: 0, y: 0, w: 40, h: 20 }, [{ x: 0, y: 10 }], world);
assert.ok(start && start[0] > 0 && start[0] < 6);
assert.equal(world.query({ kind: "circle", x: start[0], y: start[1], r: m.WALKER_RADIUS_M }, { groups: ["station", "obstacle", "wall"] }).length, 0);

// Rundgang: dringendste zuerst, inaktive nie, Grenze hält.
const stops = m.tourStops(st, { 1: { rank: 60 }, 2: { rank: 40 } }, 5);
assert.deepEqual(stops.map((s) => s.id), [1, 2]);
assert.ok(stops.every((s) => s.distance >= 9));
assert.equal(m.tourStops(st, {}, 1).length, 1);

// Messen.
assert.equal(m.polylineMetres([[0, 0], [3, 4], [3, 10]]), 11);
assert.equal(m.fmtMetres(7.5), "7,50 m");
assert.equal(m.fmtMetres(123.44), "123,4 m");
assert.equal(m.fmtMetres(NaN), "?");

// Bearbeiten im Begehen: Ablegen rastet auf das Hallenraster, Drehung bleibt im Kreis.
assert.deepEqual(m.movedStation(12.13, 5.87, 190), { x: 12.25, y: 5.75, rotation: -170 });
assert.deepEqual(m.movedStation(-0.1, -2.4, -190), { x: 0, y: -2.5, rotation: 170 });
assert.deepEqual(m.movedStation(3.3, 3.3, 360), { x: 3.25, y: 3.25, rotation: 0 }, "360° ist 0°");
assert.deepEqual(m.movedStation(1.2, 2.2, 0, 0), { x: 1.2, y: 2.2, rotation: 0 }, "snap 0 lässt frei");
assert.deepEqual(m.movedStation(NaN, Infinity, NaN), { x: 0, y: 0, rotation: 0 });

// Simulation abspielen: Start, Fahrt, Halt, Ende; Richtung bleibt beim Stehen.
const f = await bundle("src/components/twin/fleetSim.ts");
const track = [
  { t0: 10, t1: 20, state: "leer", points: [[0, 0], [10, 0]], demand: "T1" },
  { t0: 20, t1: 50, state: "laden", points: [], demand: "T1" },
  { t0: 50, t1: 60, state: "beladen", points: [[10, 0], [10, 10]], demand: "T1" },
];
let pose = f.trackPose(track, 0, [0, 0]);
assert.deepEqual([pose.x, pose.y, pose.state], [0, 0, "wartet"]);
pose = f.trackPose(track, 15, [0, 0]);
assert.equal(pose.state, "leer"); assert.ok(Math.abs(pose.x - 5) < 1e-9); assert.equal(pose.heading_deg, 0);
pose = f.trackPose(track, 30, [0, 0]);
assert.equal(pose.state, "laden"); assert.deepEqual([pose.x, pose.y], [10, 0]);
pose = f.trackPose(track, 55, [0, 0]);
assert.equal(pose.state, "beladen"); assert.ok(Math.abs(pose.y - 5) < 1e-9); assert.equal(pose.heading_deg, 90);
pose = f.trackPose(track, 999, [0, 0]);
assert.deepEqual([pose.x, pose.y, pose.state, pose.heading_deg], [10, 10, "wartet", 90]);
assert.equal(f.fmtSimClock(3725, 28800), "01:02 h");
assert.equal(f.fmtSimClock(99999, 28800), "08:00 h");
assert.equal(f.fmtWait(45), "45 s");
assert.equal(f.fmtWait(600), "10 min");
assert.equal(f.fmtWait(0), "0 min");

// Versorgungsrisiko-Ringe (Lieferkette Phase 4): nur aktive betroffene Stationen.
const sSpots = m.supplyRiskSpots(st, {
  "1": { station_id: 1, severity: "danger", role: "storage", reasons: ["PTFE knapp"], materials: ["ptfe-w"], metric: "2026-11-25" },
  "3": { station_id: 3, severity: "warning", role: "production", reasons: ["Inaktiv"], materials: ["epdm-70"], metric: "IA-1" },
});
assert.equal(sSpots.length, 1, "inaktive Stationen bekommen keinen Versorgungsring");
assert.equal(sSpots[0].id, 1);
assert.equal(sSpots[0].severity, "danger");
assert.ok(sSpots[0].radius > 1.5);
assert.equal(m.supplyRiskSpots(st, null).length, 0);

// Prognose + Termine-Linse: bei fehlender Uhrzeit oder bereits späten Aufgaben nicht „keine Termine“.
const mk = await bundle("src/components/twin/marks.ts");
const stDue = [{ id: 10, label: "Plotter", type: "production", active: true, x: 5, y: 5, w: 3, h: 2, rotation: 0,
  colour: "#0a5b9c", routing: "pull", materials: [], thicknesses: [], assigned_users: [],
  queue_jobs: 1, queue_min: 600, capacity_min_per_day: 450, is_storage: false, note: "" }];
const lateMarks = mk.buildMarks({
  stations: stDue,
  schedules: { 10: { times_known: true, changeovers: 0, slots: [{ seq: 1, kind: "cut", ref: "IA-1", label: "x", mat: "EPDM", thk: 2, changeover: false, late: true, day: 1, rush: false, started: false, orders: [], customers: [] }] } },
  suggestions: {}, step: 1, lens: "termine", flow: [], stale: false,
});
assert.ok(lateMarks[10].line.includes("spät"), lateMarks[10].line);
const unknownTimeMarks = mk.buildMarks({
  stations: stDue,
  schedules: { 10: { times_known: false, changeovers: 0, slots: [{ seq: 1, kind: "cut", ref: "IA-2", label: "x", mat: "EPDM", thk: 2, changeover: false, late: false, day: 1, rush: false, started: false, orders: [], customers: [] }] } },
  suggestions: {}, step: 1, lens: "termine", flow: [], stale: false,
});
assert.equal(unknownTimeMarks[10].line, "Terminlage ?");

console.log("twin-studio: ok");

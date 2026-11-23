// Run after npm run build: node leitstand.test.mjs ../gimel/twin/dist
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2] && !process.argv[2].includes("webapp") ? process.argv[2] : "../gimel/twin/dist";
const base = { type: "production", subtype: "", y: 6, w: 6, h: 4, rotation: 0, colour: "#0a5b9c", active: true, routing: "smart_suggest",
  materials: [], thicknesses: [], assigned_users: [], queue_jobs: 0, queue_min: 0, capacity_min_per_day: 450 };
const stations = [
  { ...base, id: 1, label: "Läufer", x: 6, queue_min: 150, queue_jobs: 2 },
  { ...base, id: 2, label: "Wartend", x: 16, queue_min: 150, queue_jobs: 1 },
  { ...base, id: 3, label: "Frei", x: 26 },
  { ...base, id: 4, label: "Knapp", x: 36, queue_min: 400, queue_jobs: 3 },
  { ...base, id: 5, label: "Über", x: 46, queue_min: 900, queue_jobs: 5, last_mat: "EPDM", last_thk: 3 },
  { ...base, id: 6, label: "Ohne", x: 6, y: 18, queue_min: 80, queue_jobs: 2, capacity_min_per_day: 0 },
  { ...base, id: 7, label: "Aus", x: 16, y: 18, active: false },
  { ...base, id: 8, label: "Stumm", x: 26, y: 18, queue_jobs: 2 },
];
const floor = { name: "Halle", outline: [[0, 0], [54, 0], [54, 24], [0, 24]], zones: [], obstacles: [], doors: [{ name: "Anlieferung", x: 0, y: 12, width: 3, kind: "gate" }], aisles: { nodes: [[1, 1], [2, 2]], edges: [[0, 1]] } };
const slot = (ref, start, finish, day, extra = {}) => ({ seq: 1, kind: "cut", ref, label: ref, mat: "EPDM", thk: 3, units: 1, n_parts: 1, n_plates: 1, rush: false,
  started: false, orders: [], customers: [], start_min: start, finish_min: finish, changeover: false, slack_min: null, late: false, day, reason: "", priority: {}, ...extra });
const schedule = slots => ({ station_id: null, label: "", times_known: true, changeovers: 0, changeovers_edd: 0, changeovers_saved: 0, changeover_min_saved: 0,
  total_min: 0, late: [], setup_mat: "", setup_name: "", setup_thk: 0, setup_end_mat: "", setup_end_name: "", setup_end_thk: 0, slots });
const worklist = { kinds: {}, pool: [{ kind: "cut", ref: "IA-90", suggest_station_id: 3 }, { kind: "cut", ref: "IA-91", suggest_station_id: 3 }, { kind: "pack", ref: "P-1", suggest_station_id: 3 }], auto_routing: false, policy: {}, stations: [
  { id: 1, schedule: schedule([slot("IA-77", 0, 60, 1, { started: true }), slot("IA-78", 60, 150, 1)]) },
  { id: 2, schedule: schedule([slot("IA-20", 0, 150, 1)]) },
  { id: 3, schedule: schedule([]) },
  { id: 4, schedule: schedule([slot("IA-40", 0, 400, 1)]) },
  { id: 5, schedule: schedule([slot("IA-50", 0, 450, 1, { late: true }), slot("IA-51", 450, 900, 2, { changeover: true })]) },
  { id: 6, schedule: schedule([slot("IA-60", 0, 80, 1)]) },
  { id: 7, schedule: schedule([]) },
] };
const analysis = { loads: [], unassigned: 1, summary: {}, findings: [
  { kind: "transport", severity: "info", title: "Weg lang", detail: "Abgeleitet.", metric: "", station_ids: [], job_nos: [], moves: [] },
  { kind: "capacity", severity: "warning", title: "Engpass Über", detail: "Mehr Arbeit als Tag.", metric: "200 %", station_ids: [5, 3], job_nos: [],
    moves: [{ job_no: "IA-51", from_id: 5, from_label: "Über", station_id: 3, label: "Frei", minutes: 45, score: 1, reason: "" }] },
] };
const suggestion = (job_no, station_id, mode = "auto") => ({ job_no, station_id, label: station_id ? "Frei" : "", mode, score: 80, reason: "frei", ranking: [] });
const plan = { auto_routing: true, counts: { auto: 1, suggest: 0, none: 0 }, suggestions: [suggestion("IA-90", 3), suggestion("IA-51", 3), suggestion("IA-99", null, "none")] };
const handler = (order_no, user_id = 4) => ({ order_no, customer_ref: "Muster", rush: false, user_id, name: "Testperson", score: 1, reason: "kennt den Kunden" });
const handlers = { suggestions: [handler("AB-1"), handler("AB-2", null)] };
const flow = { total_transport_m: 120, edges: [{ from: 1, to: 3, kind: "supply", count: 4, metres: 30, exact: true, materials: [] }] };
const robots = { sampled_at: "2026-11-04T10:00:00+00:00", simulated: true, robots: [{
  id: 1, name: "AGV Test", kind: "agv", floor_id: null, active: true, state: "moving", simulated: true,
  gateway_id: "sim", battery_pct: 80, payload_kg: 200, capabilities: ["transport"], route: [[1, 1], [8, 1], [8, 8], [1, 8], [1, 1]],
  route_mode: "loop", route_m: 28, speed_m_s: 1, progress_m: 3, x: 4, y: 1, heading_deg: 0,
}] };
const viewOf = id => ({ station: stations[id - 1], station_type: "production", all_for_all: false, orders: [], hidden_count: 0, auto_routing: false,
  queue: id === 1 ? [] : [{ no: `Q-${id}`, planned_min: 30, status: "open" }, { no: "ALT", planned_min: 1, status: "done" }] });

const browser = await chromium.launch();
const errors = [];

// side: gemerkte Wahl „Lage offen" (Aufgabe 41 F: ohne Wahl unter 1600 px zu). Die meisten Fälle lesen die Lage.
async function open({ role = "admin", width = 1280, height = 800, hash = "grundriss", clock = false, touch = false, data = {}, side = "1" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
  const page = await context.newPage();
  const seen = [];
  const state = { failAll: false, failWorklist: false, holdView: new Map(), plan: data.plan ?? plan, handlers: data.handlers ?? handlers };
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("503")) errors.push(m.text()); });
  await page.addInitScript(([r, open]) => {
    localStorage.setItem("gimel-token", "test-token");
    localStorage.setItem("gimel-user", JSON.stringify({ name: "Test", role: r }));
    if (open !== null) localStorage.setItem("gimel-leitstand-lage", open);
  }, [role, side]);
  if (clock) await page.clock.install();
  await page.route("**/*", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/")) seen.push(`${req.method()} ${path}`);
    if (path === "/api/version") return route.fulfill({ json: { version: "t", features: [] } });
    if (state.failAll && path.startsWith("/api/factory")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    if (state.failWorklist && path === "/api/factory/worklist") return route.fulfill({ status: 503, json: { detail: "Test" } });
    const assign = /^\/api\/factory\/work-orders\/(.+)\/assign$/.exec(path);
    if (assign) {
      state.plan = { ...state.plan, suggestions: state.plan.suggestions.filter(s => s.job_no !== assign[1]) };
      return route.fulfill({ json: {} });
    }
    const hand = /^\/api\/factory\/orders\/(.+)\/handler$/.exec(path);
    if (hand) {
      state.handlers = { suggestions: state.handlers.suggestions.filter(h => h.order_no !== hand[1]) };
      return route.fulfill({ json: {} });
    }
    const reply = { "/api/factory/floor": floor, "/api/factory/stations": data.stations ?? stations, "/api/factory/worklist": data.worklist ?? worklist, "/api/factory/flow": flow,
      "/api/factory/twin/analysis": data.analysis ?? analysis, "/api/factory/plan": state.plan, "/api/factory/handlers/plan": state.handlers,
      "/api/factory/robots": data.robots ?? robots }[path];
    if (reply) return route.fulfill({ json: reply });
    const view = /^\/api\/factory\/stations\/(\d+)\/view$/.exec(path);
    if (view) {
      const hold = state.holdView.get(+view[1]);
      if (hold) await hold;
      return route.fulfill({ json: viewOf(+view[1]) });
    }
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { detail: "Test" } });
    const file = path === "/twin/" || path === "/twin" ? "twin.html" : path.replace(/^\/twin\//, "");
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    await route.fulfill({ body: await readFile(resolve(dist, file)), contentType: mime[extname(file)] || "application/octet-stream" });
  });
  await page.goto(`http://internal.test/twin/#/${hash}`);
  return { page, seen, state, close: () => context.close() };
}

const station = (page, name) => page.locator(`.twin-station[aria-label^="${name},"]`);
const body = (page, name) => station(page, name).locator(".twin-body");
const count = (seen, line) => seen.filter(s => s === line).length;
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

try {
  // Eine Ladung, keine Schleife je Station; die Sicht kommt erst mit der Auswahl.
  {
    const { page, seen, close } = await open();
    await station(page, "Läufer").waitFor();
    await page.locator(".lage-finding").first().waitFor();
    assert.equal(seen.filter(s => s.endsWith("/view")).length, 0, "Kein Abruf je Station");
    for (const p of ["floor", "stations", "worklist", "flow", "twin/analysis", "plan", "handlers/plan", "robots"]) {
      assert.equal(count(seen, `GET /api/factory/${p}`), 1, p);
    }

    // Der Plan liegt ohne Scrollen im Bild, die Lage ist 340 Pixel breit und zeigt zuerst, was zu entscheiden ist.
    const box = await page.locator(".floor-stage").boundingBox();
    assert.ok(box.y < 220 && box.height > 320, JSON.stringify(box));
    assert.ok(box.y + box.height <= 800, JSON.stringify(box));
    assert.equal(Math.round((await page.locator(".leitstand-side").boundingBox()).width), 340);
    assert.equal(await page.locator(".app-main").evaluate(m => m.scrollHeight <= m.clientHeight), true);
    assert.equal(await page.locator(".lage-section .twin-panel-sub").first().textContent(), "Auffälligkeiten 2") /* textContent: die Schrift ist per CSS groß gesetzt */;
    assert.ok((await page.locator(".lage-finding").first().innerText()).includes("Achtung"), "Warnung vor Hinweis, als Wort");
    assert.match(await page.locator(".leitstand-stand").innerText(), /^Stand \d\d:\d\d$/);
    assert.equal(await page.locator(".leitstand-mode").innerText(), "Jetzt");
    // Das Band liegt links unter der Legende; Reihenfolge Plan, Zeit, Lage.
    const order = await page.evaluate(() => {
      const [a, b, c] = [".leitstand-plan", ".twin-band", ".leitstand-side"].map(q => document.querySelector(q));
      return [a.compareDocumentPosition(b), b.compareDocumentPosition(c)].every(p => p & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(order, "Plan, Zeit, Lage");
    assert.equal(await page.locator(".leitstand-main .twin-band").count(), 1);
    assert.equal(await page.locator(".twin-band [role=radio]").evaluateAll(r => r.map(x => x.querySelector(".twin-radio-label").textContent).join("|")),
      "Jetzt|Nach 1 Arbeitstag|Nach 2 Arbeitstagen|Nach 3 Arbeitstagen");
    // Zahlen im Band und in der Lage: benannte Teile, Stunden, kein „Tag".
    const band = await page.locator(".twin-band").textContent();
    assert.ok(band.includes("≈26,7 h Maschinenzeit · 2 ohne Maschine · 2 Stationen ohne Angabe"), band);
    assert.ok(!band.includes("Tag ") && !band.includes("Tage ·"), band);
    assert.ok(band.includes("geschätzt 26,7 h Maschinenzeit, 2 ohne Maschine"), "Band liest geschätzt vor");
    assert.equal((await page.locator(".lage-panel > h2 .lage-count").innerText()).trim(), "1 Warnung · 2 Zuordnungen · 1 Bearbeiter");
    const summary = await page.locator(".lage-summary").textContent();
    assert.ok(summary.includes("≈28 h auf 5 von 7 Maschinen · vollste ≈200 % der Tageskapazität · Dauer teils unbekannt"), summary);
    assert.ok(await page.evaluate(() => {
      const s = document.querySelector(".lage-summary");
      return document.querySelector('[data-lage-section="bearbeiter"]').compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING;
    }), "Zusammenfassung unter den Entscheidungen");
    // Der Auftrag, den die Warnung verschieben will, steht oben, und der Befund hat keinen eigenen Knopf.
    assert.ok((await page.locator('[data-lage-section="zuordnung"] .lage-item').first().innerText()).includes("IA-51"));
    assert.ok((await page.locator('[data-lage-section="zuordnung"] .lage-item').first().innerText()).includes("Vorschlag sicher"));
    assert.ok(!(await page.locator('[data-lage-section="zuordnung"]').innerText()).includes("Bewertung"));
    // Unbekannt hat keinen Balken, die Zelle bleibt.
    assert.equal(await page.locator('.lage-station[data-status="unbekannt"] .load-track').count(), 0);
    assert.equal(await page.locator('.lage-station[data-status="unbekannt"]').first().evaluate(b => b.children.length), 3);
    // Aktualisieren und Pause stehen an der Uhr, die Seiten zur Halle im Menü „Mehr" (Aufgabe 41 F).
    for (const name of ["Aktualisierung pausieren", "Aktualisieren"]) {
      await page.locator(".leitstand-status").getByRole("button", { name, exact: true }).waitFor();
    }
    await page.locator(".leitstand-status").getByRole("button", { name: "Mehr" }).click();
    for (const name of ["Schachteln", "Bereitstellen", "Roboter", "Optimierung", "Halle bearbeiten", "Standorte & Ebenen"]) {
      await page.getByRole("menuitem", { name, exact: true }).waitFor();
    }
    await page.keyboard.press("Escape");

    // Zustand als Form, Zeichen und Wort.
    const f = await page.locator(".twin-station").evaluateAll(nodes => Object.fromEntries(nodes.map(g => [g.getAttribute("aria-label").split(",")[0], {
      aria: g.getAttribute("aria-label"), status: g.dataset.status, certainty: g.dataset.certainty, text: g.textContent,
      edge: !!g.querySelector(".twin-edge"), hatch: !!g.querySelector(".twin-hatch"), cross: !!g.querySelector(".twin-cross"),
      load: !!g.querySelector(".twin-load-fill"), dash: g.querySelector(".twin-body").getAttribute("stroke-dasharray"),
      hollow: g.querySelector(".twin-body").classList.contains("twin-body-hollow") }])));
    assert.equal(f["Läufer"].status, "laeuft");
    assert.ok(f["Läufer"].edge && f["Läufer"].dash == null && f["Läufer"].certainty === "firm" && f["Läufer"].text.includes("läuft IA-77"), JSON.stringify(f["Läufer"]));
    assert.ok(f["Läufer"].aria.includes("gebucht"), f["Läufer"].aria);
    assert.equal(f.Wartend.status, "wartet");
    assert.ok(f.Wartend.text.includes("wartet · ≈2,5 h") && f.Wartend.dash && !f.Wartend.edge, JSON.stringify(f.Wartend));
    assert.ok(f.Wartend.aria.includes("geschätzt") && !f.Wartend.aria.includes("≈"), f.Wartend.aria);
    assert.ok(f.Frei.status === "frei" && f.Frei.hollow);
    assert.equal(f.Frei.certainty, "estimated", "Vorschläge sind geschätzt");
    assert.ok(f.Frei.text.includes("frei · 2 Vorschläge"), f.Frei.text);
    assert.ok(f.Frei.aria.includes("geschätzt 2 Vorschläge"), f.Frei.aria);
    assert.ok(!f.Frei.aria.includes("gebucht"), f.Frei.aria);
    assert.equal(f.Stumm.certainty, "unknown");
    const hit = await station(page, "Wartend").locator(".twin-hit").boundingBox();
    assert.ok(hit.width >= 28 && hit.height >= 28, JSON.stringify(hit));
    // Die Legende steht hinter dem Knopf „Legende" (Aufgabe 41 F).
    await page.getByRole("button", { name: "Legende" }).click();
    const legend = await page.locator(".twin-legend-row").textContent();
    for (const word of ["fest", "Balken: Last je Tageskapazität", "Kante links: läuft, gebucht"]) assert.ok(legend.includes(word), word);
    const door = await page.locator(".floor-door text").boundingBox();
    const stage = await page.locator(".floor-stage").boundingBox();
    assert.ok(door.x >= stage.x, `Anlieferung ragt heraus: ${door.x} < ${stage.x}`);
    assert.ok(f.Knapp.status === "voll" && f.Knapp.load, JSON.stringify(f.Knapp));
    assert.ok(f.Knapp.aria.includes("wird voll") && f.Knapp.aria.includes("89 %"), f.Knapp.aria);
    assert.ok(f["Über"].status === "ueber" && f["Über"].hatch);
    assert.ok(f.Ohne.status === "unbekannt" && f.Ohne.certainty === "unknown" && f.Ohne.text.includes("Kapazität unbekannt") && f.Ohne.dash, JSON.stringify(f.Ohne));
    assert.ok(!f.Ohne.aria.includes("%"), f.Ohne.aria);
    assert.ok(f.Ohne.aria.includes("geschätzt 80 min"), f.Ohne.aria);
    assert.ok(f.Aus.status === "inaktiv" && f.Aus.cross);
    assert.notEqual(f.Ohne.dash, f.Wartend.dash, "Unbekannt und geschätzt sehen verschieden aus");

    // Die Legende steht immer, „geschätzt" ist Text.
    assert.deepEqual(await page.locator(".twin-legend-list li[data-legend]").evaluateAll(items => items.map(li => li.lastChild.textContent)),
      ["läuft", "wartet", "frei", "wird voll", "überbucht", "unbekannt", "inaktiv"]);
    assert.ok((await page.locator(".twin-legend-row").textContent()).includes("geschätzt"));
    await page.getByRole("button", { name: "Legende" }).click();
    await page.locator(".twin-legend-row").waitFor({ state: "detached" });
    assert.ok((await page.locator('.lage-station[data-status="wartet"]').textContent()).includes("geschätzt"), "Liste liest geschätzt vor");

    // Schrift in Bildschirmpixeln, nicht in Metern.
    const px = await station(page, "Wartend").locator(".twin-name").evaluate(t => {
      const m = t.getScreenCTM();
      return +t.getAttribute("font-size") * m.a;
    });
    assert.ok(Math.abs(px - 12) < 0.5, `Name ${px} px`);

    // Klick markiert und öffnet im Panel, kein Drawer; die Sicht kommt genau einmal.
    await body(page, "Wartend").click();
    await page.locator(".twin-inspector").waitFor();
    assert.equal(await page.locator(".bp5-drawer").count(), 0);
    assert.equal(await station(page, "Wartend").getAttribute("aria-pressed"), "true");
    assert.equal(await station(page, "Wartend").locator(".twin-ring").count(), 1);
    await page.locator(".twin-queue .mono", { hasText: "Q-2" }).waitFor();
    assert.deepEqual(await page.locator(".twin-queue .mono").allInnerTexts(), ["Q-2"]);
    assert.equal(count(seen, "GET /api/factory/stations/2/view"), 1);
    const queued = await page.locator(".twin-inspector dt", { hasText: "Eingeplant" }).locator("xpath=../dd").innerText();
    assert.ok(queued.startsWith("≈"), queued);
    await page.getByRole("button", { name: "Zurück zur Lage" }).click();
    await page.locator(".lage-panel").waitFor();

    // Zeit ohne einsehbare Schlange sagt, woher sie kommt.
    await body(page, "Läufer").click();
    await page.locator(".twin-inspector", { hasText: "Warteschlange nicht einsehbar" }).waitFor();
    assert.ok(!(await page.locator(".twin-inspector").innerText()).includes("Hier wartet nichts"));
    await page.getByRole("button", { name: "Zurück zur Lage" }).click();
    await page.locator(".lage-panel").waitFor();

    // Befund markiert seine Stationen, ohne die Auswahl zu ändern.
    await page.locator(".lage-finding button", { hasText: "Engpass" }).click();
    await page.locator(".lage-detail", { hasText: "IA-51" }).waitFor();
    assert.equal(await page.locator(".lage-detail button").count(), 0, "Keine Aktion im Befund");
    assert.equal(await station(page, "Über").locator(".twin-ring-find").count(), 1);
    assert.equal(await station(page, "Frei").locator(".twin-ring-find").count(), 1);
    assert.equal(await station(page, "Wartend").locator(".twin-ring-find").count(), 0);

    // Keine Linsenleiste und kein Filter mehr über dem Plan; Materialfluss bleibt eine Ebene im Zwilling.
    assert.equal(await page.locator(".leitstand-planbar").count(), 0);
    assert.equal(await page.getByRole("radio", { name: "Rüsten" }).count(), 0);
    assert.equal(await page.locator(".floor-flow").count(), 0);
    await close();
  }

  // Aufgabe 41 F: ohne eigene Wahl ist die Lage unter 1600 px zu und die Bühne bekommt den Platz;
  // der Reiter nennt die Auffälligkeiten, eine Station öffnet das Panel, die Wahl bleibt gemerkt.
  {
    const { page, close } = await open({ side: null, width: 1440, height: 900 });
    await station(page, "Läufer").waitFor();
    assert.equal(await page.locator(".leitstand-side").count(), 0, "Lage zu unter 1600 px");
    const stage = await page.locator(".leitstand-stage").boundingBox();
    assert.ok(stage.width >= 1100 && stage.height >= 600, JSON.stringify(stage));
    const tab = page.getByRole("button", { name: /^Lage einblenden/ });
    assert.match(await tab.getAttribute("aria-label"), /, 1 Auffälligkeit$/);
    await body(page, "Wartend").click();
    await page.locator(".leitstand-side .twin-inspector").waitFor();
    await page.getByRole("button", { name: "Zurück zur Lage" }).click();
    await page.locator(".leitstand-side").waitFor({ state: "detached" });
    await tab.click();
    await page.locator(".leitstand-side .lage-panel").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("gimel-leitstand-lage")), "1");
    await page.reload();
    await page.locator(".leitstand-side .lage-panel").waitFor();
    // Zeitleiste: eine Zeile, „Alle Zahlen" zeigt die vier Spalten mit ihrer Zahl.
    assert.equal(await page.locator(".twin-band .twin-radio-sub").count(), 0);
    await page.getByRole("button", { name: "Alle Zahlen" }).click();
    assert.equal(await page.locator(".twin-band .twin-radio-sub").count(), 4);
    // Vollbild-Knopf ist da (die API selbst prüft der Browser).
    await page.getByRole("button", { name: "Vollbild", exact: true }).waitFor();
    await close();
  }
  {
    const { page, close } = await open({ side: null, width: 1700, height: 900 });
    await page.locator(".leitstand-side .lage-panel").waitFor();
    await close();
  }

  // Tastatur allein: Station wählen, zurück auf dieselbe Station.
  {
    const { page, close } = await open();
    await station(page, "Frei").focus();
    await page.keyboard.press("Enter");
    await page.locator(".twin-inspector").waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === "Frei");
    await page.keyboard.press("Escape");
    await page.locator(".twin-inspector").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Frei,"));
    // Aus der Liste geöffnet, zurück in die Liste, obwohl sie zwischendurch aushing.
    await page.locator('.lage-station[data-station-id="4"]').focus();
    await page.keyboard.press("Enter");
    await page.locator(".twin-inspector").waitFor();
    await page.getByRole("button", { name: "Zurück zur Lage" }).click();
    await page.waitForFunction(() => document.activeElement?.dataset.stationId === "4" && document.activeElement.classList.contains("lage-station"));
    await close();
  }

  // Nach Zuordnen und Übernehmen: der nächste Knopf, sonst die Überschrift.
  {
    const { page, close } = await open({ data: { plan: { ...plan, suggestions: [suggestion("IA-90", 3), suggestion("IA-92", 3)] } } });
    const assign = page.locator('[data-lage-section="zuordnung"]');
    await assign.getByRole("button", { name: "Zuordnen", exact: true }).first().click();
    await page.waitForFunction(() => document.activeElement?.dataset.rowKey === "IA-92");
    await assign.getByRole("button", { name: "Zuordnen", exact: true }).first().click();
    await page.waitForFunction(() => document.activeElement?.textContent.startsWith("Offene Zuordnungen"));
    await page.locator('[data-lage-section="bearbeiter"]').getByRole("button", { name: "Übernehmen" }).first().click();
    await page.waitForFunction(() => document.activeElement?.dataset.rowKey === "AB-2" || document.activeElement?.textContent.startsWith("Auftragsbearbeitung"));
    await close();
  }

  // Zählen, wo die Route endet; was eine Zeile nicht zuordnen kann, zählt nicht.
  {
    const many = { suggestions: Array.from({ length: 40 }, (_, i) => handler(`AB-${i}`)) };
    const { page, close } = await open({ data: { handlers: many } });
    await page.locator(".lage-count", { hasText: "40+ Bearbeiter" }).waitFor();
    await close();
  }

  // Unbekannte Arbeit: nie 0 und nie frei, auf keinem Schritt.
  {
    const hall = [{ ...base, id: 1, label: "Stumm", x: 6, queue_jobs: 2 }, { ...base, id: 2, label: "Offen", x: 16, capacity_min_per_day: 0, queue_min: 60, queue_jobs: 1, type: "shipping" }];
    const { page, close } = await open({ data: { stations: hall, worklist: { ...worklist, pool: [], stations: [] } } });
    await station(page, "Stumm").waitFor();
    assert.ok((await page.locator(".twin-band").textContent()).includes("Umfang unbekannt · 2 Stationen"));
    assert.ok((await page.locator(".lage-summary").textContent()).includes("Dauer unbekannt"));
    assert.ok(!(await page.locator(".lage-summary").textContent()).includes("nichts eingeplant"));
    await page.getByRole("radio", { name: /Jetzt/ }).focus();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowRight");
      await page.locator(".leitstand-banner").waitFor();
      assert.equal(await station(page, "Stumm").getAttribute("data-status"), "unbekannt");
      assert.equal(await station(page, "Offen").getAttribute("data-status"), "unbekannt");
      assert.ok(!(await page.locator(".twin-station").allInnerTexts()).join().includes("≈frei"));
    }
    await close();
  }
  {
    const hall = [{ ...base, id: 1, label: "Leer", x: 6 }];
    const { page, close } = await open({ data: { stations: hall, worklist: { ...worklist, pool: [], stations: [] } } });
    await page.locator(".twin-band", { hasText: "voraussichtlich nichts offen" }).waitFor();
    assert.ok((await page.locator(".lage-summary").textContent()).includes("nichts eingeplant"));
    await close();
  }

  // Ein Tag Kapazität ist nicht acht Stunden Wortlaut: 480 min bleiben Stunden.
  {
    const hall = [{ ...base, id: 1, label: "Acht", x: 6, queue_min: 480, queue_jobs: 1, capacity_min_per_day: 960 }];
    const { page, close } = await open({ data: { stations: hall, worklist: { ...worklist, pool: [], stations: [] } } });
    await station(page, "Acht").locator(".twin-word", { hasText: "wartet · ≈8 h" }).waitFor();
    for (const q of [".twin-band", ".lage-summary"]) assert.ok(!(await page.locator(q).textContent()).includes("Tag "), q);
    await close();
  }

  // Eine späte Antwort der vorigen Station überschreibt die neue Auswahl nicht.
  {
    const { page, state, close } = await open();
    await station(page, "Läufer").waitFor();
    let release;
    state.holdView.set(1, new Promise(r => { release = r; }));
    await body(page, "Läufer").click();
    await page.locator(".twin-inspector h2", { hasText: "Läufer" }).waitFor();
    await page.getByRole("button", { name: "Zurück zur Lage" }).click();
    await page.locator(".lage-station", { hasText: "Knapp" }).click();
    await page.locator(".twin-queue .mono", { hasText: "Q-4" }).waitFor();
    const late = page.waitForResponse(r => r.url().endsWith("/stations/1/view"));
    release();
    await late;
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
    assert.deepEqual(await page.locator(".twin-queue .mono").allInnerTexts(), ["Q-4"]);
    await close();
  }

  // Prognose: Schritte, Banner, ≈, gesperrte Aktionen, Esc zurück.
  {
    const { page, seen, close } = await open();
    await page.locator(".lage-item").first().waitFor();
    assert.equal(await page.locator(".twin-band [role=radio]").count(), 4);
    assert.equal(await page.locator("input[type=range], .bp5-slider").count(), 0);
    await page.getByRole("radio", { name: /Jetzt/ }).focus();
    await page.keyboard.press("ArrowRight");
    await page.locator('[role=status] .leitstand-banner', { hasText: "Prognose: aus dem Plan gerechnet, ohne neue Aufträge, volle Tageskapazität ab jetzt. Aktionen gesperrt." }).waitFor();
    assert.equal(await page.locator(".leitstand-mode").innerText(), "Prognose");
    const after1 = await station(page, "Über").getAttribute("data-status");
    assert.equal(after1, "voll", "900 min bei 450 je Tag: nach einem Tag bleiben 450, das ist voll");
    assert.ok((await station(page, "Über").textContent()).includes("wird voll · ≈7,5 h"));
    assert.equal(await page.locator('.lage-station:has-text("Über") .load-fill').evaluate(b => b.style.width), "100%");
    assert.equal(await page.locator('.lage-station:has-text("Knapp") .load-fill').evaluate(b => b.style.width), "0%", "Die Liste folgt der Prognose");
    assert.equal(await station(page, "Stumm").getAttribute("data-status"), "unbekannt");
    await page.getByRole("button", { name: "Alle Stationen mit allen Faktoren" }).first().click();
    assert.equal(await page.locator(".bp5-dialog").getByRole("button", { name: /^Auf .* legen$/ }).isDisabled(), true, "Dialog gesperrt");
    await page.locator(".bp5-dialog").getByRole("button", { name: "Schließen" }).click();
    await page.locator(".bp5-dialog").waitFor({ state: "detached" });
    await page.getByRole("radio", { name: /Nach 1 Arbeitstag/ }).focus();
    assert.equal(await station(page, "Läufer").locator(".twin-edge").count(), 0, "Eine Prognose bucht nichts");
    assert.equal(await station(page, "Läufer").getAttribute("data-status"), "frei");
    assert.ok((await station(page, "Läufer").textContent()).includes("≈frei"));
    assert.equal(await station(page, "Ohne").getAttribute("data-certainty"), "unknown", "Ohne Kapazität keine Rechnung");
    for (const name of ["Zuordnen", "Übernehmen", /automatisch zuordnen/]) {
      assert.equal(await page.locator(".lage-panel").getByRole("button", { name }).first().isDisabled(), true, String(name));
    }
    await page.keyboard.press("ArrowRight");
    await page.locator('.twin-radio[aria-checked="true"]', { hasText: "Nach 2 Arbeitstagen" }).waitFor();
    await station(page, "Über").locator(".twin-word", { hasText: "≈frei" }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".leitstand-banner").waitFor({ state: "detached" });
    assert.equal(await page.locator(".leitstand-mode").innerText(), "Jetzt");
    assert.equal(await page.locator(".lage-panel").getByRole("button", { name: "Zuordnen" }).first().isDisabled(), false);
    assert.equal(seen.filter(s => s.startsWith("POST")).length, 0);
    await page.getByRole("radio", { name: /Nach 3 Arbeitstagen/ }).click();
    await page.getByRole("button", { name: "Zurück zu Jetzt" }).click();
    await page.locator(".leitstand-banner").waitFor({ state: "detached" });
    await close();
  }

  // Ohne Aktualisierung über 90 s: Hinweis, Live-Markierung zurückgenommen; Aktualisieren heilt.
  {
    const { page, close } = await open({ clock: true });
    await station(page, "Läufer").locator(".twin-edge").waitFor();
    await page.getByRole("button", { name: "Aktualisierung pausieren" }).click();
    await page.getByRole("button", { name: "Aktualisierung fortsetzen" }).waitFor();
    await page.clock.fastForward(91_000);
    await page.locator(".leitstand-stale[role=status]", { hasText: "Daten veraltet" }).waitFor();
    assert.ok(!(await page.locator(".leitstand-stale").innerText()).includes("Stand"), "Die Uhr steht außerhalb");
    assert.match(await page.locator(".leitstand-stand").innerText(), /^Daten veraltet · Stand \d\d:\d\d$/);
    await station(page, "Läufer").locator(".twin-edge").waitFor({ state: "detached" });
    assert.ok(!(await station(page, "Läufer").getAttribute("aria-label")).includes("läuft"), "Live zurückgenommen");
    await page.getByRole("button", { name: "Aktualisieren" }).click();
    await page.locator(".leitstand-stale").waitFor({ state: "detached" });
    await station(page, "Läufer").locator(".twin-edge").waitFor();
    await close();
  }

  // Eine fehlgeschlagene Hintergrund-Aktualisierung bleibt nicht still.
  {
    const { page, state, close } = await open({ clock: true });
    await station(page, "Läufer").waitFor();
    state.failAll = true;
    await page.clock.fastForward(31_000);
    await page.locator(".leitstand-failed", { hasText: "Aktualisierung fehlgeschlagen" }).waitFor();
    await station(page, "Läufer").waitFor();
    await close();
  }

  // Fällt der Arbeitsvorrat während der Prognose aus, gilt Jetzt.
  {
    const { page, state, close } = await open({ clock: true });
    await station(page, "Läufer").waitFor();
    await page.getByRole("radio", { name: /Nach 1 Arbeitstag/ }).click();
    await page.locator(".leitstand-banner").waitFor();
    state.failWorklist = true;
    await page.clock.fastForward(31_000);
    await page.locator(".leitstand-banner").waitFor({ state: "detached" });
    assert.equal(await page.locator(".leitstand-mode").innerText(), "Jetzt");
    await page.locator(".twin-band", { hasText: "Keine Prognose" }).waitFor();
    await page.locator(".lage-panel", { hasText: "Nicht geladen: Arbeitsvorrat" }).waitFor();
    await close();
  }

  // Werker: dieselbe Seite, keine Plan- und Bearbeiteraktionen, keine Abrufe dafür.
  {
    const { page, seen, close } = await open({ role: "worker" });
    await station(page, "Läufer").waitFor();
    await page.locator(".lage-station").first().waitFor();
    for (const name of ["Schachteln", "Optimierung", "Halle bearbeiten", "Zuordnen", "Übernehmen"]) {
      assert.equal(await page.getByRole("button", { name }).count(), 0, name);
    }
    await page.getByRole("button", { name: "Mehr" }).click();
    await page.getByRole("menuitem", { name: "Bereitstellen" }).waitFor();
    for (const name of ["Schachteln", "Optimierung", "Halle bearbeiten"]) {
      assert.equal(await page.getByRole("menuitem", { name }).count(), 0, name);
    }
    await page.keyboard.press("Escape");
    assert.deepEqual(seen.filter(s => /plan|analysis/.test(s)), []);
    await body(page, "Wartend").click();
    await page.locator(".twin-queue .mono", { hasText: "Q-2" }).waitFor();
    assert.equal(await page.locator(".twin-inspector").getByRole("button", { name: "Belegung" }).count(), 0);
    await close();
  }

  // Telefon: Lage zuerst, sortiert nach Dringlichkeit; Knöpfe statt Rad; Blatt; 44 Pixel; kein Festhängen.
  {
    const { page, close } = await open({ width: 375, height: 812, touch: true });
    await page.locator(".lage-station").first().waitFor();
    assert.equal(await page.getByRole("tab", { name: "Lage" }).getAttribute("aria-selected"), "true");
    const order = await page.locator(".lage-station b").allInnerTexts();
    assert.equal(order[0], "Über");
    assert.equal(order[1], "Knapp");
    assert.equal(order.at(-1), "Aus");
    // Entscheidungen zuerst: Warnungen offen, alles andere zu.
    assert.equal(await page.locator('details[data-lage-section="auffaellig"]').getAttribute("open"), "");
    for (const id of ["hinweise", "zuordnung", "bearbeiter"]) {
      assert.equal(await page.locator(`details[data-lage-section="${id}"]`).getAttribute("open"), null, id);
    }
    assert.ok(await page.evaluate(() => document.querySelector('[data-lage-section="bearbeiter"]').compareDocumentPosition(document.querySelector(".lage-stations")) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.equal(await noOverflow(page), true);
    await page.getByRole("tab", { name: "Plan" }).click();
    await station(page, "Frei").waitFor();
    assert.equal(await noOverflow(page), true);
    assert.equal(await page.locator(".twin-station .twin-glyph").count(), 8, "Jede Station trägt ihr Zeichen");
    const small = await station(page, "Frei").locator(".twin-hit").boundingBox();
    assert.ok(small.width >= 28 && small.height >= 28, JSON.stringify(small));
    await page.getByRole("button", { name: "Legende" }).click();
    await page.locator(".twin-legend-row").waitFor();
    await page.getByRole("button", { name: "Legende" }).click();
    await page.locator(".twin-legend-row").waitFor({ state: "detached" });
    for (const name of ["Hineinzoomen", "Herauszoomen", "Auf Grundriss einpassen"]) {
      const b = await page.getByRole("button", { name }).boundingBox();
      assert.ok(b.width >= 44 && b.height >= 44, `${name}: ${JSON.stringify(b)}`);
    }
    assert.equal(await page.locator(".floor-svg").evaluate(s => getComputedStyle(s).touchAction), "pan-y pinch-zoom");
    await page.getByRole("button", { name: "Hineinzoomen" }).click();
    await page.locator(".floor-svg.floor-zoomed").waitFor();
    assert.equal(await page.locator(".floor-svg").evaluate(s => getComputedStyle(s).touchAction), "none");
    await page.getByRole("button", { name: "Auf Grundriss einpassen" }).click();
    await page.locator(".floor-svg:not(.floor-zoomed)").waitFor();
    await body(page, "Wartend").tap();
    const sheet = page.locator(".leitstand-sheet");
    await sheet.locator(".twin-queue .mono", { hasText: "Q-2" }).waitFor();
    // Das Blatt fährt herein: gemessen wird seine Ruhelage.
    await page.waitForFunction(() => {
      const r = document.querySelector(".leitstand-sheet").getBoundingClientRect();
      return r.x === 0 && r.y === 0 && r.width >= 375 && r.height >= 811.9;
    });
    await sheet.getByRole("button", { name: "Schließen" }).click();
    await sheet.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Wartend,"));
    await page.getByRole("tab", { name: "Zeit" }).click();
    const step = await page.getByRole("radio", { name: /Nach 1 Arbeitstag/ }).boundingBox();
    assert.ok(step.height >= 44, JSON.stringify(step));
    await page.getByRole("button", { name: "Mehr" }).click();
    await page.getByRole("menuitem", { name: "Bereitstellen" }).waitFor();
    await close();
  }

  // Der Editor zeichnet ohne Zustand, nur in der neutralen Darstellung (Einzelheiten: hall-editor.test.mjs).
  {
    const { page, close } = await open({ hash: "grundriss/admin" });
    await page.locator(".floor-station").first().waitFor();
    assert.equal(await page.locator(".twin-station").count(), 0);
    assert.equal(await page.locator(".floor-station rect").first().getAttribute("fill"), "var(--g-floor-station)");
    assert.equal(await page.locator(".floor-svg").evaluate(s => getComputedStyle(s).touchAction), "none");
    await close();
  }

  assert.deepEqual(errors, []);
  console.log("Leitstand checks passed: one load, status shapes, inline inspector, lenses, forecast, stale data, worker, phone, editor.");
} finally {
  await browser.close();
}

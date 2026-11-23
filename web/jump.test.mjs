// „Suchen & springen" (Aufgabe 35 B): node jump.test.mjs
// Reine Teile ohne Browser: Reihung, Seitenliste je Rolle, direkte Nummern, Handgriffe.
import assert from "node:assert/strict";
import { build } from "esbuild";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const out = await build({
  stdin: { contents: `export * from "./src/jump.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  nodePaths: [process.cwd() + "/node_modules"],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const features = ["vision", "library"];
const texts = (rows) => rows.map((r) => r.text);

// Umlaute, ß und Großschreibung spielen keine Rolle.
assert.equal(m.fold("Aufträge"), "auftrage");
assert.equal(m.fold("Straße"), "strasse");
assert.ok(m.jumpScore("auftrage", { text: "Aufträge" }) > 0);

// Anfang schlägt Wortanfang schlägt Mitte; ein Wort, das nirgends trifft, wirft die Zeile hinaus.
{
  const start = m.jumpScore("pro", { text: "Produktion" });
  const word = m.jumpScore("gru", { text: "Digitaler Grundriss" });
  const mid = m.jumpScore("dukt", { text: "Produktion" });
  assert.ok(start > word && word > mid && mid > 0, `${start} > ${word} > ${mid}`);
  assert.equal(m.jumpScore("pro xyz", { text: "Produktion" }), 0, "jedes Wort muss treffen");
  assert.equal(m.jumpScore("", { text: "Produktion" }), 0);
}

// Kennungen: mit oder ohne Bindestrich.
assert.ok(m.jumpScore("ab260005", { text: "Pumpenbau", code: "AB-26-0005" }) >= 130);
assert.ok(m.jumpScore("ab-26", { text: "Pumpenbau", code: "AB-26-0005" }) > 0);

// Stichwörter: „Rechnung" meint die Buchhaltung, „Halle" den Grundriss — aber der Name gewinnt.
{
  const pages = m.pageEntries("admin", features);
  assert.equal(m.rankJump("rechnung", pages)[0].text, "Buchhaltung");
  assert.equal(m.rankJump("halle", pages)[0].text, "Grundriss");
  assert.equal(m.rankJump("lager", pages)[0].text, "Lager", "der Name steht vor einem Stichworttreffer");
  assert.equal(m.rankJump("zzz", pages).length, 0);
}

// Seiten je Rolle: Admins finden auch Werkzeuge und Verwaltung; Werker nur ihre Liste.
{
  const admin = texts(m.pageEntries("admin", features));
  for (const label of ["Heute", "Optimierung", "Freies Schachteln", "Benutzer", "Admin", "Agent Lab", "Formen"]) {
    assert.ok(admin.includes(label), `Admin findet ${label}`);
  }
  const staff = texts(m.pageEntries("staff", features));
  assert.ok(!staff.includes("Benutzer"), "Benutzer nur für Admins");
  const worker = texts(m.pageEntries("worker", features));
  for (const label of ["Kunden", "Buchhaltung", "Auftragserfassung", "Benutzer", "Admin", "Werkstoffe", "Optimierung"]) {
    assert.ok(!worker.includes(label), `Werker finden ${label} nicht`);
  }
  assert.ok(worker.includes("Produktion") && worker.includes("Grundriss"));
  // Ohne das Plugin gibt es den Bildschirm nicht, also auch keinen Treffer.
  assert.ok(!texts(m.pageEntries("admin", [])).includes("Formen"));
  // Eigene Anwendungen sind Links, keine Routen.
  const lab = m.pageEntries("admin", features).find((e) => e.text === "Agent Lab");
  assert.ok(lab.href && !lab.route && lab.newTab);
  const twin = m.pageEntries("admin", features).find((e) => e.text === "Grundriss");
  assert.ok(twin.href === "/twin/" && !twin.route && twin.newTab);
  const prod = m.pageEntries("admin", features).find((e) => e.text === "Produktion");
  assert.equal(prod.route, "produktion");
  assert.match(prod.hint, /Leitstand/);
  assert.match(prod.hint, /g p/);
}

// Kunden suchen nur Büro-Rollen.
assert.equal(m.mayJumpCustomers("worker"), false);
assert.equal(m.mayJumpCustomers(""), false);
assert.equal(m.mayJumpCustomers("staff"), true);
assert.equal(m.mayOpenRoute("kunden/3", "worker"), false);
assert.equal(m.mayOpenRoute("produktion/IA-26-0001", "worker"), true);
// Werkstoffe öffnen nur Büro-Rollen; die Palette zeigt Werkern deshalb keine Werkstoff-Zeilen.
assert.equal(m.mayOpenRoute("werkstoffe", "worker"), false);
assert.equal(m.mayOpenRoute("werkstoffe", "staff"), true);
assert.ok(m.pageEntries("worker", features).every((e) => !e.route || m.mayOpenRoute(e.route, "worker")),
  "jede Seite, die ein Werker findet, darf er auch öffnen");

// Eine getippte Nummer führt direkt hin.
assert.equal(m.directEntry("ab-26-0005", "admin").route, "auftraege/AB-26-0005");
assert.equal(m.directEntry(" IA-26-0012 ", "worker").route, "produktion/IA-26-0012");
assert.equal(m.directEntry("AB-26", "admin"), null, "eine halbe Nummer ist kein Sprung");
assert.equal(m.directEntry("Pumpenbau", "admin"), null);

// Handgriffe: der Schalter nennt, was er tut; Werker legen keinen Auftrag an.
{
  const a = m.actionEntries("admin", { simple: true, assistant: true });
  assert.ok(a.some((e) => e.route === "auftragserfassung"));
  assert.match(a.find((e) => e.action === "detail").text, /Alles anzeigen/);
  assert.match(m.actionEntries("admin", { simple: false, assistant: true }).find((e) => e.action === "detail").text, /Weniger anzeigen/);
  assert.ok(a.some((e) => e.action === "assistant"));
  const w = m.actionEntries("worker", { simple: true, assistant: false });
  assert.ok(!w.some((e) => e.route === "auftragserfassung"));
  assert.ok(!w.some((e) => e.action === "assistant"));
  assert.equal(m.rankJump("dunkel", a)[0].action, "theme");
}

// Reihenfolge der Abschnitte ist fest, je Abschnitt gekappt.
{
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, group: "Seiten", text: `Plan ${i}`, icon: "dot" }));
  const act = [{ id: "a", group: "Aktionen", text: "Plan drucken", icon: "dot" }];
  const ranked = m.rankJump("plan", [...act, ...many], 6);
  assert.equal(ranked.filter((e) => e.group === "Seiten").length, 6);
  assert.equal(ranked.at(-1).group, "Aktionen", "Aktionen stehen hinter den Seiten");
}

// Zeilen aus den Listen: Auftrag mit Kunde aus beiden Endpunkten, interner Auftrag, Kunde, Werkstoff.
{
  const o = m.orderEntries([
    { no: "AB-26-0001", customer: "Pumpenbau Nord GmbH", status_label: "Eingeplant" },
    { no: "AB-26-0002", customer_name: "Chemiepark Ost" },
    { no: "AB-26-0003", internal_owner: "M. Beispiel" },
    { no: "AB-26-0004" },
  ]);
  assert.deepEqual(texts(o), ["Pumpenbau Nord GmbH", "Chemiepark Ost", "intern · M. Beispiel", "ohne Kunde"]);
  assert.equal(o[0].route, "auftraege/AB-26-0001");
  assert.equal(o[0].hint, "Eingeplant");
  const c = m.customerEntries([{ id: 7, company: "Pumpenbau Nord GmbH", name: "Einkauf", customer_no: "K-1002" }, { id: 8, email: "a@b.example" }]);
  assert.equal(c[0].route, "kunden/7");
  assert.equal(c[0].code, "K-1002");
  assert.equal(c[1].text, "a@b.example");
  const w = m.materialEntries([{ id: "ptfe-w", name: "PTFE weiß", brand: "", cat: "ptfe" }]);
  assert.equal(w[0].action, "material");
  assert.equal(w[0].arg, "PTFE weiß");
}

console.log("jump ok");

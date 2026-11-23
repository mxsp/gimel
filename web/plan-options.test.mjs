// Run after npm run build: the option list behind the fold-out menus.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plan-options-"));
execFileSync("node_modules/.bin/esbuild", ["src/planOptions.ts", "--format=esm", `--outfile=${join(dir, "planOptions.js")}`], { stdio: "ignore" });
writeFileSync(join(dir, "package.json"), '{"type":"module"}');
const { PLAN_OPTION_GROUPS, optionGroups, optionProblem } = await import(join(dir, "planOptions.js"));

assert.equal(optionGroups("nesting").length, 4, "Schachteln: Kern, Kerf, Geometrie, Suche");
assert.equal(optionGroups("batch").length, 1, "Disposition: Sammellauf");
assert.equal(optionGroups("all").length, 5);

const group = id => PLAN_OPTION_GROUPS.find(g => g.id === id);
const field = (groupId, key) => group(groupId).fields.find(f => f.key === key);

assert.equal(field("engine", "nesting_engine").options[0].value, "kerf", "Kerf ist die Vorgabe");
assert.equal(field("kerf", "nest_kerf_steps").empty, true, "leer heißt automatisch");
assert.equal(field("kerf", "nest_kerf_steps").min, 4);
assert.equal(field("batch", "batch_interval_minutes").max, 10080);

assert.equal(optionProblem(field("kerf", "nest_kerf_steps"), ""), null);
assert.equal(optionProblem(field("kerf", "nest_kerf_steps"), "3"), "Mindestens 4.");
assert.equal(optionProblem(field("kerf", "nest_kerf_steps"), "5001"), "Höchstens 5.000.");
assert.equal(optionProblem(field("kerf", "nest_kerf_cell"), "0,2"), "Mindestens 0,25.");
assert.equal(optionProblem(field("kerf", "nest_kerf_gravity"), "left"), null);
assert.equal(optionProblem(field("kerf", "nest_kerf_gravity"), "down"), "Ungültige Auswahl.");
assert.equal(optionProblem(field("kerf", "nest_kerf_refine"), "false"), null);
assert.equal(optionProblem(field("batch", "batch_min_utilisation"), "0,7"), null);
assert.equal(optionProblem(field("batch", "batch_enabled"), ""), "Schalter ist true oder false.");

assert.match(group("engine").summary({ nesting_engine: "kerf" }), /Kerf/);
assert.match(group("batch").summary({ batch_enabled: "true", batch_interval_minutes: "15", batch_mode: "sammel", batch_min_utilisation: "0.7" }), /aktiv · alle 15 min · sammeln · voll ab 70 %/);

console.log("Plan options passed: groups, Kerf default, bounds, inherited empties, batch summary.");

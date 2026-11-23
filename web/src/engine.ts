/* Rechenkern eines Laufs oder Innenauftrags in Klartext.

   Der Server speichert die Versionszeile des Kerns, der den Lauf wirklich
   gerechnet hat: „kerf-1.4.0" oder „2.11.0-lite". Hier steht nur, wie das
   auf Deutsch heißt — nichts, was die Zeile nicht hergibt. Ob Kerf auf einer
   einzelnen Platte auf lite zurückgefallen ist, steht nicht im Lauf; deshalb
   spricht diese Anzeige vom Kern des Laufs, nicht von jeder Platte. */

export interface EngineInfo {
  kind: "kerf" | "lite" | "gre" | "unknown";
  /** Kurzname für Tabellenzellen: „Kerf" / „lite". */
  name: string;
  /** Versionsnummer ohne Präfix, leer wenn unbekannt. */
  version: string;
  /** Ein Satz, was der Kern tut. */
  about: string;
}

export function engineInfo(label: string | null | undefined): EngineInfo {
  const raw = (label ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith("kerf")) {
    return { kind: "kerf", name: "Kerf", version: raw.replace(/^kerf-?/i, ""),
             about: "Konturschachtelung — Teile nach ihrer echten Form, jede Lage geprüft" };
  }
  if (lower.startsWith("gre")) {
    return { kind: "gre", name: "GRE", version: raw.replace(/^gre-?/i, ""),
             about: "Schachtelkern der Anwendung" };
  }
  if (lower.includes("lite")) {
    return { kind: "lite", name: "lite", version: raw.replace(/-?lite$/i, ""),
             about: "Standardkern — rechnet auch die Preise und die Vorschau" };
  }
  return { kind: "unknown", name: raw || "—", version: "", about: "" };
}

/** „Kerf 1.4.0" / „lite 2.11.0" — für Tags und Faktenzeilen. */
export function engineText(label: string | null | undefined): string {
  const e = engineInfo(label);
  return e.version ? `${e.name} ${e.version}` : e.name;
}

/** Für Läufe: ein Lauf ohne Platte hat nichts geschachtelt, also nennt er auch keinen Kern. */
export function runEngineText(label: string | null | undefined, nPlates: number): string {
  return nPlates > 0 ? engineText(label) : "nichts geschachtelt";
}
export function runEngineKind(label: string | null | undefined, nPlates: number): EngineInfo["kind"] {
  return nPlates > 0 ? engineInfo(label).kind : "unknown";
}

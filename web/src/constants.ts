/* Konditionen als feste Auswahl statt freiem Text.

   Preisgruppe und Zahlungsziel wurden bisher getippt. Getippte Konditionen
   laufen auseinander — „30 Tage netto", „30 Tage", „netto 30" sind für den
   Menschen dasselbe und für jede Auswertung drei Gruppen. Deshalb eine Liste.

   Ein bereits gespeicherter Wert, der nicht in der Liste steht, wird trotzdem
   angezeigt (siehe withCurrent): eine Maske darf einen Bestandswert nicht
   stillschweigend auf etwas anderes umstellen, bloss weil sie ihn nicht kennt. */

export const PRICE_GROUPS: Array<[string, string]> = [
  ["standard", "Standard"],
  ["high-prio", "High Prio"],
];

export const PAYMENT_TERMS: Array<[string, string]> = [
  ["0 Tage netto", "0 Tage — sofort fällig"],
  ["15 Tage netto", "15 Tage netto"],
  ["30 Tage netto", "30 Tage netto"],
];

/* Werkstoffgruppen — Schlüssel wie im Backend (PRODUCT_CATS), Beschriftung für
   die Maske. Ein neuer Werkstoff wird immer einer Gruppe zugeordnet. */
export const PRODUCT_CATS: Array<[string, string]> = [
  ["elastomer", "Elastomere"], ["ptfe", "Modifiziertes PTFE"], ["graphit", "Graphit"],
  ["faser", "Faserstoffe & Hochdruck"], ["hochtemp", "Hochtemperatur"],
];

const CAT_ALIASES: Record<string, string> = {
  rubber: "Elastomere",
  elastomer: "Elastomere",
  fibre: "Faserstoffe & Hochdruck",
  fiber: "Faserstoffe & Hochdruck",
  faser: "Faserstoffe & Hochdruck",
  graphite: "Graphit",
  graphit: "Graphit",
  ptfe: "Modifiziertes PTFE",
  hochtemp: "Hochtemperatur",
  cork: "Kork-Elastomer",
  kork: "Kork-Elastomer",
};

/** Einheitliche deutsche Gruppenbezeichnung für Werkstoffe (inkl. älterer englischer Schlüssel). */
export function productCatLabel(cat: string | undefined | null): string {
  const key = (cat ?? "").trim().toLowerCase();
  if (!key) return "—";
  return CAT_ALIASES[key] ?? (cat ?? "").trim();
}

/** Die Liste, ergänzt um den aktuell gespeicherten Wert, falls er fehlt. */
export function withCurrent(options: Array<[string, string]>, current: string | undefined | null): Array<[string, string]> {
  const value = (current ?? "").trim();
  if (!value || options.some(([v]) => v === value)) return options;
  return [...options, [value, `${value} (bestehend)`]];
}

/* Länder für Anschriften. Kurz gehalten: die Nachbarn, in die geliefert wird,
   plus die Länder, aus denen Anfragen kommen. Der Rest wäre eine Liste, durch
   die niemand scrollt — kommt ein weiteres dazu, gehört es hierher. */
export const COUNTRIES: Array<[string, string]> = [
  ["DE", "Deutschland"],
  ["AT", "Österreich"],
  ["CH", "Schweiz"],
  ["NL", "Niederlande"],
  ["BE", "Belgien"],
  ["LU", "Luxemburg"],
  ["FR", "Frankreich"],
  ["PL", "Polen"],
  ["CZ", "Tschechien"],
  ["DK", "Dänemark"],
  ["IT", "Italien"],
  ["SE", "Schweden"],
];

/* Zahlwege, wie Stripe sie benennt, in Worten des Hauses.

   Die Rechnung bietet dieselben Wege an wie die Kasse des Bestellportals:
   Karte sofort, oder Überweisung auf ein Konto, das Stripe je Rechnung
   ausweist. „customer_balance" ist Stripes Name für den zweiten Weg — der
   sagt niemandem in der Buchhaltung etwas, deshalb diese Tabelle. */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: "Karte",
  customer_balance: "Banküberweisung",
  sepa_debit: "SEPA-Lastschrift",
  bacs_debit: "Bacs-Lastschrift",
  us_bank_account: "US-Bankkonto",
};

/** Die angebotenen Zahlwege als lesbarer Satzteil: „Karte oder Überweisung". */
export function paymentWays(methods: string[] | undefined | null): string {
  const names = (methods ?? []).map((m) => PAYMENT_METHOD_LABELS[m] ?? m);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} oder ${names[names.length - 1]}`;
}

/** Was ein Werker-Konto öffnen darf (App.renderPage, SideNavigation). Das
 *  Backend prüft ohnehin selbst (require_worker); die Liste spart Werkern nur
 *  Seiten, auf denen jede Abfrage mit 403 endet. */
export const WORKER_ROUTES = ["heute", "auftraege", "arbeitsvorrat", "arbeitsplaetze", "produktion", "bereitstellen", "versand",
  "kommissionierung", "station"];


/* Werkstoffgruppen im Klartext. Die Gruppe ist ein freies Feld am Werkstoff; was
   hier nicht steht, wird unverändert gezeigt — nie verschluckt. */
const MATERIAL_GROUPS: Record<string, string> = {
  rubber: "Elastomer",
  fibre: "Faserstoff",
  fiber: "Faserstoff",
  graphite: "Graphit",
  cork: "Kork",
  ptfe: "PTFE",
  metal: "Metall",
  foam: "Schaumstoff",
  mica: "Glimmer",
};

export function materialGroupLabel(cat: string | null | undefined): string {
  const key = (cat || "").trim();
  return MATERIAL_GROUPS[key.toLowerCase()] ?? key;
}

/** Preisgruppe im Klartext („standard" → „Standard"); Unbekanntes bleibt, wie es gespeichert ist. */
export function priceGroupLabel(group: string | null | undefined): string {
  const key = group || "";
  return PRICE_GROUPS.find(([id]) => id === key)?.[1] ?? key;
}

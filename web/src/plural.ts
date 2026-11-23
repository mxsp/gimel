/* Mengen in Worten: „1 Platte", „3 Platten", „1 Tag".

   Eine Stelle statt vieler „Aufgabe(n)": die Klammer sagt dem Leser, dass die
   Oberfläche nicht gezählt hat. Zahlen im deutschen Format. */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("de-DE")} ${n === 1 ? one : many}`;
}

/** Tage mit Komma: „1 Tag", „1,5 Tage". */
export function days(v: number): string {
  const rounded = Number(v.toFixed(1));
  return `${rounded.toLocaleString("de-DE", { maximumFractionDigits: 1 })} ${rounded === 1 ? "Tag" : "Tage"}`;
}

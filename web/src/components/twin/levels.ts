/* Ebenen übereinander: gemeinsam für Leitstand und Twin Studio. */

/** Vertikaler Versatz je Ebene, gemessen über dem Erdgeschoss. Nur das EG
    liegt auf dem Boden (Karte, Hof); ein KG liegt darunter, obere Geschosse
    darüber. Die gemeldeten Höhen werden benutzt, aber nie kleiner als die
    aufaddierten Geschosshöhen plus ein sichtbarer Spalt: alte Datensätze ohne
    ``elevation_m`` (oder mit 0 für alle Ebenen) würden sonst alle Ebenen auf
    y = 0 zeichnen — ineinander statt übereinander. */
export function levelOffsets(
  floors: { id: number; level: number; elevation_m?: number; height_m?: number }[],
): Map<number, number> {
  const sorted = [...floors].sort((a, b) => (a.level || 0) - (b.level || 0) || a.id - b.id);
  const stack = new Map<number, number>();
  let y = 0;
  for (const f of sorted) {
    stack.set(f.id, y);
    y += Math.max(3.2, Number(f.height_m) || 6) + 0.8;
  }
  // Erdgeschoss ist der Bezug. Fehlt es (reine Obergeschoss-Halle), die
  // Ebene, die der Grundfläche am nächsten liegt.
  const ground = floors.find((f) => (f.level || 0) === 0)
    ?? [...floors].sort((a, b) => Math.abs(a.level || 0) - Math.abs(b.level || 0) || a.id - b.id)[0];
  const baseElev = Number(ground?.elevation_m) || 0;
  const baseStack = stack.get(ground?.id ?? -1) ?? 0;
  const out = new Map<number, number>();
  for (const f of floors) {
    const elev = (Number(f.elevation_m) || 0) - baseElev;
    const st = (stack.get(f.id) ?? 0) - baseStack;
    const magnitude = Math.max(Math.abs(elev), Math.abs(st));
    out.set(f.id, (elev || st) < 0 ? -magnitude : magnitude);
  }
  return out;
}

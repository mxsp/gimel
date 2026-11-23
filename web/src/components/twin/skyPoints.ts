/* Himmel der 3D-Halle: nachts ein Sternenhimmel, tags leichte Wolken. Hier
   stehen nur die festen Zahlen: die Punkte kommen aus einem Zufallsgenerator
   mit festem Startwert, damit das Bild auf jedem Gerät gleich aussieht und
   sich beim Umschalten des Themes nichts neu berechnen muss.

   Die Sterne sind Richtungen auf einer Kugel um die Kamera, keine Punkte auf
   dem Bildschirm: nur so dreht sich der Himmel mit, wenn die Kamera um die
   Halle schwenkt, und der Boden verdeckt sie wie jede andere Wand. Die Wolken
   bleiben in sky.css, weil ein paar helle Flecken am Himmel keine Tiefe
   brauchen. */

export interface SkyStar {
  /** Richtung auf der Einheitskugel: x rechts, y oben, z nach vorn. */
  x: number;
  y: number;
  z: number;
  /** Helligkeit 0..1 für die Sternfarbe. */
  alpha: number;
}

export interface SkyCloud {
  x: number;
  y: number;
  scale: number;
  /** Negative Verzögerung: die Wolken sind von Anfang an verteilt. */
  delay: number;
  duration: number;
}

/** mulberry32: klein, schnell und mit festem Startwert wiederholbar. */
export function skyRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Sterne als Richtungen auf der oberen Halbkugel. Unten bleibt der Himmel
    leer: unter dem Boden dürfen keine Sterne hervorschauen, wenn die Kamera
    flach über die Karte blickt. Die Höhe ist gleichmäßig verteilt, damit die
    Sterne nicht am Horizont zusammenlaufen. */
export function starDome(seed = 7, count = 420): SkyStar[] {
  const rnd = skyRandom(seed);
  const stars: SkyStar[] = [];
  for (let i = 0; i < count; i++) {
    const y = 0.03 + rnd() * 0.97;
    const phi = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    stars.push({
      x: r2(r * Math.cos(phi)),
      y: r2(y),
      z: r2(r * Math.sin(phi)),
      alpha: r2(0.25 + rnd() * 0.75),
    });
  }
  return stars;
}

/** Leichte Wolken am Tag: wenige Flecken, die langsam nach rechts ziehen. */
export function cloudField(seed = 5, count = 4): SkyCloud[] {
  const rnd = skyRandom(seed);
  const clouds: SkyCloud[] = [];
  for (let i = 0; i < count; i++) {
    clouds.push({
      x: r2(4 + ((i * 23 + rnd() * 12) % 82)),
      y: r2(8 + rnd() * 34),
      scale: r2(0.7 + rnd() * 0.7),
      delay: r2(-rnd() * 90),
      duration: r2(70 + rnd() * 50),
    });
  }
  return clouds;
}

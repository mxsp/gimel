/* Der Arbeitszyklus des 7-Achs-Arms — dieselben Phasen und Zeiten wie in der
   Sortierzelle unter Roboter → Arme & Zellen (sortingCell/runtime.ts).

   Der Zwilling spielt diesen Zyklus ab, damit der Arm in der Halle sich so
   bewegt wie an seiner Zelle: anfahren, senken, greifen, anheben, zum Korb
   fahren, ablegen, zurückfahren. Die Phasenfolge und die Zeiten stehen hier
   einmal; `runtime.ts` behält seine eigene Kopie, weil sie dort mit dem Band
   verwoben ist. Ändert man eins, ändert man beides.

   Rein (kein DOM, kein Three.js-Zustand): Phasen, Zeitfenster, Ease und die
   Zuordnung „Zeit → Phase" mit Zyklusnummer, damit jeder Zyklus den nächsten
   Korb nimmt (wie `targetBin` in der Zelle). Die Gelenkwinkel rechnet der
   Aufrufer aus den Schlüsselposen (`armKeyframes` in robotModel.ts). */

export type ArmPhase = "idle" | "approach" | "descend" | "grip" | "lift" | "transit" | "place" | "home";

export const ARM_PHASES: { id: ArmPhase; label: string; dur: number }[] = [
  { id: "idle", label: "Bereit", dur: 0.30 },
  { id: "approach", label: "Arm fährt über das Teil", dur: 0.95 },
  { id: "descend", label: "Greifer senkt", dur: 0.55 },
  { id: "grip", label: "Sauger greift", dur: 0.32 },
  { id: "lift", label: "Anheben", dur: 0.55 },
  { id: "transit", label: "Fahrt zum Korb", dur: 1.10 },
  { id: "place", label: "Ablegen", dur: 0.52 },
  { id: "home", label: "Rückfahrt", dur: 0.85 },
];

/** Dauer eines ganzen Zyklus (Sekunden bei ×1). */
export const ARM_CYCLE_S = ARM_PHASES.reduce((s, p) => s + p.dur, 0);

/** Körbe, die der Zyklus der Reihe nach bedient. */
export const ARM_BINS = 3;

export const armEase = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

export interface ArmSample {
  /** Index in ARM_PHASES. */
  phase: number;
  /** Fortschritt in der Phase, weich gerundet (0…1). */
  t: number;
  /** Wievielter Zyklus (0, 1, 2 …) — bestimmt den Korb. */
  cycle: number;
}

/** Wo der Arm im Zyklus steht, nach `seconds` Laufzeit. Der Zyklus läuft
 *  über ARM_BINS Körbe und beginnt danach wieder bei Korb 0. */
export function armSampleAt(seconds: number, bins: number = ARM_BINS): ArmSample {
  const total = ARM_CYCLE_S * bins;
  const s = ((seconds % total) + total) % total;
  const cycle = Math.floor(s / ARM_CYCLE_S);
  let rest = s - cycle * ARM_CYCLE_S;
  for (let i = 0; i < ARM_PHASES.length; i++) {
    const dur = ARM_PHASES[i].dur;
    if (rest < dur || i === ARM_PHASES.length - 1) {
      return { phase: i, t: armEase(rest / dur), cycle };
    }
    rest -= dur;
  }
  return { phase: 0, t: 0, cycle };
}


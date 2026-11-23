import { useEffect, useState } from "react";
import { api, runBatch } from "./api";

/* Der Sammellauf kann eine Minute dauern. Damit zwei Knöpfe auf zwei Seiten
   keinen zweiten Lauf anstoßen, hängt der Zustand hier am Modul und nicht an
   einer Seite: wer wegnavigiert und zurückkommt, sieht den Lauf weiterlaufen.
   Nach einem Neuladen findet ihn die Sitzung über die gemerkte Auftrags-ID.
   Der Server liefert keinen Fortschritt in Prozent — also zeigen wir, was wir
   wissen: dass er läuft und wie lange schon. */

export interface BatchState {
  running: boolean;
  force: boolean;
  /** Nur bestimmte Eimer, nicht die ganze Warteschlange. */
  selected: boolean;
  startedAt: number | null;
}

const KEY = "gimel-batch-job";
const IDLE: BatchState = { running: false, force: false, selected: false, startedAt: null };
let state = IDLE;
const listeners = new Set<() => void>();

function set(next: BatchState) {
  state = next;
  listeners.forEach((l) => l());
}

function remember(id: string | null) {
  try { if (id) sessionStorage.setItem(KEY, id); else sessionStorage.removeItem(KEY); } catch { /* egal */ }
}

/** Startet einen Lauf — oder liefert den, der schon läuft. Wirft bei Fehlern. */
export async function startBatchRun<T>(
  force: boolean,
  buckets?: { mat: string; thk: number }[],
  options?: { customerIds?: number[]; groupBy?: "material" | "customer" },
): Promise<T> {
  if (state.running) throw new Error("Ein Sammellauf läuft bereits — bitte warten, bis er fertig ist.");
  set({ running: true, force, selected: !!buckets || !!options?.customerIds?.length, startedAt: Date.now() });
  try {
    return await runBatch<T>(force, { onJob: remember }, buckets, options);
  } finally {
    remember(null);
    set(IDLE);
  }
}

let resumed = false;
/** Einmal pro Sitzung: lief beim Neuladen noch ein Lauf? Dann weiter warten. */
async function resume(onDone: () => void) {
  if (resumed || state.running) return;
  resumed = true;
  let id: string | null = null;
  try { id = sessionStorage.getItem(KEY); } catch { /* egal */ }
  if (!id) return;
  try {
    const job = await api<{ status: string }>(`/api/production/runs/jobs/${id}`);
    if (job.status !== "running") { remember(null); return; }
  } catch { remember(null); return; }
  // Der Server gibt bei „start" den laufenden Auftrag zurück: so hängen wir uns an.
  set({ running: true, force: false, selected: false, startedAt: Date.now() });
  try { await runBatch(false, { onJob: remember }); } catch { /* die Seite lädt neu */ }
  finally { remember(null); set(IDLE); onDone(); }
}

export function useBatchRun(onDone?: () => void): BatchState {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    void resume(() => onDone?.());
    return () => { listeners.delete(l); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

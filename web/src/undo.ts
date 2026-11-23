import { toaster } from "./toast";

/* Rückgängig — für die Handgriffe, die man im Betrieb danebengreift.

   Der Versandknopf sitzt neben dem Löschknopf, und beide sind klein. Ein
   Bestätigungsdialog vor jedem Klick hilft dagegen nicht: wer zwanzig Versände
   am Tag bucht, klickt ihn genauso reflexhaft weg wie den Knopf darunter. Was
   hilft, ist ein Weg zurück, nachdem der Fehler sichtbar geworden ist.

   Deshalb kein allgemeines „Undo" über einem Zustandsstapel, sondern je
   Aktion die benannte Gegenaktion — dieselben Endpunkte, die das Personal
   auch von Hand bedienen würde. Das hat zwei Vorteile: die Rücknahme läuft
   durch dieselben Prüfungen wie die Aktion (ein Versand, der schon
   unterwegs ist, lässt sich nicht mehr auflösen), und sie steht im
   Protokoll als eigener Vorgang statt als stille Korrektur.

   Was sich nicht zurücknehmen lässt, bekommt hier auch keinen Knopf. Ein
   falsches Versprechen wäre schlimmer als gar keines. */

const UNDO_MS = 15000;

export interface Undoable {
  /** Die Aktion selbst. */
  run: () => Promise<unknown>;
  /** Die benannte Gegenaktion. Fehlt sie, gibt es keinen Rückgängig-Knopf. */
  undo?: () => Promise<unknown>;
  /** Meldung nach der Aktion. Auch eine Funktion: sie wird erst nach `run`
      ausgewertet — wichtig, wenn die Meldung die frisch erzeugte Nummer
      tragen soll, die es vor der Aktion noch nicht gibt. */
  done: string | (() => string);
  /** Meldung nach der Rücknahme. Auch eine Funktion. */
  undone?: string | (() => string);
  /** Läuft nach Aktion und nach Rücknahme — zum Neuladen der Ansicht. */
  after?: () => void;
}

const msg = (m: string | (() => string) | undefined): string =>
  typeof m === "function" ? m() : (m ?? "");

export async function undoable({ run, undo, done, undone, after }: Undoable): Promise<void> {
  try {
    await run();
  } catch (e: any) {
    toaster.show({ message: String(e?.message ?? e), intent: "danger", icon: "error", timeout: 8000 });
    // Auch ein gescheiterter Handgriff muss die Ansicht beruhigen: sonst
    // bleibt der Knopf im Ladezustand und die Liste zeigt den alten Stand.
    after?.();
    return;
  }
  after?.();

  if (!undo) {
    toaster.show({ message: msg(done), intent: "success", icon: "tick-circle", timeout: 5000 });
    return;
  }

  const key = toaster.show({
    message: msg(done),
    intent: "success",
    icon: "tick-circle",
    timeout: UNDO_MS,
    action: {
      text: "Rückgängig",
      onClick: () => {
        toaster.dismiss(key);
        undo()
          .then(() => {
            toaster.show({ message: msg(undone) || "Zurückgenommen.", intent: "primary",
                           icon: "undo", timeout: 5000 });
            after?.();
          })
          .catch((e: any) => {
            // Die Rücknahme kann berechtigt scheitern — ein Versand, der
            // inzwischen unterwegs ist, darf sich nicht mehr auflösen.
            toaster.show({ message: `Zurücknehmen ging nicht: ${e?.message ?? e}`,
                           intent: "danger", icon: "error", timeout: 9000 });
            after?.();
          });
      },
    },
  });
}

/* Ein Wortschatz für den Stand eines Auftrags, an einer Stelle.

   „Laufend" hat genau eine Bedeutung: mindestens ein Innenauftrag steht auf
   ``running``, an einer Maschine wird also wirklich geschnitten. Dieselbe Regel
   zählt die Kennzahl (``work_orders_running``). Ein Auftrag, der nur einen
   Innenauftrag hat, ist eingeplant, nicht in Fertigung. So steht nie „0 laufend"
   neben Zeilen, die „in Fertigung" sagen.

   Das Backend fasst beides als ``in_produktion`` zusammen; die Trennung
   passiert hier. */

export type OrderPhase =
  | "gesperrt" | "wartet" | "freigegeben" | "eingeplant" | "laufend"
  | "versandbereit" | "versand" | "abgeschlossen"
  | "angehalten" | "storniert";

export type TagIntent = "none" | "primary" | "success" | "warning" | "danger";

export interface StatusInfo {
  label: string;
  intent: TagIntent;
  icon?: "lock" | "pause" | "arrow-right" | "time" | "cog" | "box" | "truck" | "tick-circle"
    | "stop" | "cross-circle";
}

export const ORDER_PHASES: Record<OrderPhase, StatusInfo> = {
  gesperrt: { label: "Gesperrt", intent: "danger", icon: "lock" },
  wartet: { label: "Wartet auf Freigabe", intent: "none", icon: "pause" },
  freigegeben: { label: "Freigegeben", intent: "primary", icon: "arrow-right" },
  eingeplant: { label: "Eingeplant", intent: "none", icon: "time" },
  laufend: { label: "In Fertigung", intent: "warning", icon: "cog" },
  versandbereit: { label: "Versandbereit", intent: "primary", icon: "box" },
  versand: { label: "Im Versand", intent: "primary", icon: "truck" },
  abgeschlossen: { label: "Abgeschlossen", intent: "success", icon: "tick-circle" },
  // Büro-Stände (Aufgabe 45): Wort und Zeichen tragen sie, nicht die Farbe allein.
  angehalten: { label: "Angehalten", intent: "warning", icon: "stop" },
  storniert: { label: "Storniert", intent: "none", icon: "cross-circle" },
};

interface OrderLike {
  cancelled_at?: string | null;
  held_at?: string | null;
  status?: string;
  blocked?: boolean;
  released?: boolean;
  work_orders?: Array<{ status?: string }>;
}

/** Läuft an einer Maschine etwas für diesen Auftrag? */
export function isRunning(o: OrderLike): boolean {
  return (o.work_orders ?? []).some((w) => w.status === "running");
}

export function orderPhase(o: OrderLike): OrderPhase {
  // Storniert schlägt alles, auch eine Sperre; angehalten entscheidet der
  // Server (er weiß, ob der Auftrag schon fertig oder unterwegs ist).
  if (o.cancelled_at || o.status === "storniert") return "storniert";
  if (o.status === "angehalten") return "angehalten";
  if (o.blocked) return "gesperrt";
  switch (o.status) {
    case "in_produktion": return isRunning(o) ? "laufend" : "eingeplant";
    case "versandbereit": case "versand": case "abgeschlossen":
    case "freigegeben": case "wartet": case "gesperrt":
      return o.status;
    default: return o.released ? "freigegeben" : "wartet";
  }
}

export const WORK_ORDER_STATUS: Record<string, StatusInfo> = {
  open: { label: "Offen", intent: "none" },
  running: { label: "Läuft", intent: "primary" },
  done: { label: "Fertig", intent: "success" },
  cancelled: { label: "Storniert", intent: "danger" },
};

export const workOrderStatus = (s: string): StatusInfo => WORK_ORDER_STATUS[s] ?? { label: s, intent: "none" };

/* „Wie funktioniert das?" je Bildschirm (Aufgabe 35 C/G): zwei Sätze, was man hier
   sieht und was man hier tut. Der Schlüssel ist die Route ohne Nummern; ein
   eigener Text auf der Seite (PageFrame `info`) geht vor. */

export const PAGE_INFO: Record<string, string> = {
  heute: "Oben steht, was heute brennt: überfällige und blockierte Aufträge und fehlendes Material. Jede Zeile führt an die Stelle, an der man sie erledigt; rechts steht je Station, was als Nächstes dran ist.",
  auftragserfassung: "Hier wird ein Auftrag Schritt für Schritt erfasst: Kunde, Positionen, Preis und Termin. Erst „Auftrag anlegen“ im letzten Schritt speichert ihn, vorher lässt sich jeder Schritt wieder öffnen.",
  auftraege: "Die Liste aller Aufträge mit Fertigungs- und Rechnungsstand; Suche und Filter grenzen sie ein. Ein Klick auf eine Zeile öffnet rechts die Einzelheiten mit Fortschritt, Positionen und Verlauf.",
  disposition: "Die Disposition zeigt, was als Nächstes geschnitten wird und warum der Rest noch sammelt. „Optionen“ stellt ein, wie lange gesammelt und wie geschachtelt wird; eine Änderung gilt für den nächsten Lauf.",
  arbeitsvorrat: "Jede Station hat eine Abarbeitungsliste, geordnet nach Zusage, Eil und Liegezeit. Mit „Auto“ verteilt der Planer neue Arbeit selbst, sonst ordnet man von Hand zu.",
  arbeitsplaetze: "Alle Arbeitsplätze der Halle nach Bereich geordnet — Maschinen, Lager, Versand und Büro auf einen Blick. Ein Klick auf eine Karte öffnet das jeweilige Stations-Cockpit.",
  schachteln: "Hier steht, wie die Teile eines Innenauftrags auf den Platten liegen. Die Lage lässt sich von Hand ändern; gespeichert wird nur, was die Prüfung als schneidbar bestätigt.",
  "freies-schachteln": "Freies Schachteln rechnet Teile auf Platten, ohne einen Auftrag anzulegen. Das Ergebnis lässt sich als DXF, SVG oder JSON herunterladen; Lager und Plan bleiben unberührt.",
  zeichnungen: "Die Ablage der Konturen für das freie Schachteln, gespeichert als Geometrie in Millimetern. Neue Zeichnungen kommen als DXF oder SVG herein oder als eingefügte Punkte; „Zum Schachteln“ übernimmt sie.",
  kommissionierung: "Welche Platten aus dem Regal an welche Maschine müssen, nach Werkstoff und je Maschine. Der Haken meldet: das Material liegt an der Maschine.",
  produktion: "Laufende Innenaufträge stehen oben, wartende darunter, jede Zeile eine Zeile hoch. Ein Klick öffnet die Einzelheiten mit Platten, Teilen und Dateien.",
  teileerkennung: "Die Kamera über dem Tisch erkennt geschnittene Teile und ordnet sie dem passenden Innenauftrag zu. Eine Zählung lässt sich zurücknehmen; Bilder werden nicht gespeichert.",
  grundriss: "Der Plan zeigt jede Station mit Zustand als Form, Zeichen und Wort; rechts in der Lage steht, was eine Entscheidung braucht. Gimel hat kein Maschinensignal: Gebuchtes ist fest, Geschätztes trägt ≈, Unbekanntes ein ?.",
  station: "Alles zu einer Station: was der Reihe nach dran ist, was wartet, welche Aufträge und welches Material sie betreffen. Starten, fertig melden und zuordnen geht direkt in der Liste.",
  "grundriss/admin": "Im Hallen-Editor werden Umriss, Stationen, Zonen, Gänge und Tore der gewählten Ebene gezeichnet. Speichern dürfen nur Admin-Konten; Rückgängig gilt für die Sitzung.",
  roboter: "Fahrzeuge zeigt die fahrende Flotte live auf Karte und Liste, Arme & Zellen die Arme mit der Sortierzelle als 3D-Simulation. Simulierte Roboter fahren nach einem begegnungsfreien Fahrplan; echte melden sich über ihr Gateway.",
  optimierung: "Was sich an der Halle verbessern ließe: Engpässe, lange Wege und Stationen ohne Arbeit. Jeder Vorschlag nennt seine Rechnung; „Umhängen“ ändert erst auf Klick.",
  versand: "Geschnittene Teile verpacken, Spedition und Tracking hinterlegen und die Versandmarke drucken. Was versandfertig ist, steht oben.",
  buchhaltung: "Rechnungen und Zahlungseingänge aller Aufträge. Eine gestellte Rechnung wird nicht geändert, sondern storniert und neu gestellt.",
  kalender: "Termine und Fristen der Aufträge und Stationen an einem Ort. Ein Klick springt zum Auftrag oder zur Station.",
  kunden: "Der Kundenstamm mit Konditionen, Adressen und Ansprechpartnern. Konditionen und Anschriften werden hier bearbeitet; ein Kunde ohne Geschäft wird deaktiviert.",
  lager: "Der Plattenbestand je Werkstoff mit Verlauf. Zugänge und Abgänge werden gebucht und lassen sich mit dem führenden System abgleichen.",
  werkstoffe: "Preise, Plattenformate und Sätze: die Stammdaten hinter jedem Preis. Eine Preisrunde ändert viele Preise auf einmal und zeigt vorher die Wirkung.",
  formen: "Normteile und abgelegte DXF-Konturen, dauerhaft auffindbar. Eine Form lässt sich in die Auftragserfassung übernehmen; die Liste zählt, in welchen Aufträgen sie steckt.",
  benutzer: "Konten für Personal, Werker und Kunden mit Rolle, Konditionen und Sicherheit. Konten mit Aufträgen werden stillgelegt, nicht gelöscht.",
  compliance: "Schwachstellenmeldungen, Sicherheitshinweise und Supportzeiträume an einer Stelle. Meldungen kommen über das Formular der Website herein, Hinweise gehen nach dem Veröffentlichen dorthin hinaus.",
  admin: "Kennzahlen, Sammellauf und Betriebsparameter der Installation. Änderungen hier gelten für alle Konten.",
};

/** Schlüssel einer Route: Nummern und Kennungen fallen weg, alte Pfade zeigen auf ihren Bildschirm. */
export function pageInfoKey(route: string): string {
  const [root, child] = route.replace(/^#?\/?/, "").split("/");
  if (root === "grundriss" && child === "admin") return "grundriss/admin";
  if (root === "grundriss" && child === "station") return "station";
  if (root === "grundriss" && child && PAGE_INFO[child]) return child;
  if (root === "bereitstellen") return "kommissionierung";
  if (root === "factory") return "grundriss";
  if (!root || root === "uebersicht") return "heute";
  return root;
}

import { featureInfoFor } from "../modules/featureRegistry";

export function pageInfo(route: string): string | undefined {
  const key = pageInfoKey(route);
  return PAGE_INFO[key] ?? featureInfoFor(key);
}

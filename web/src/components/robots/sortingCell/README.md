# Sortierzelle · 7-Achs-Roboter mit Teileerkennung

Die Arbeitsansicht unter **Roboter → Arme & Zellen** im Portal (seit 2026-11-08;
vorher im Twin Studio): ein 7-Achs-Roboter
sortiert Dichtungen und Formteile. Die Kamera über dem Tisch „sieht" die Teile,
die Teileerkennung klassifiziert sie, der Arm legt sie in den Korb der Klasse —
oder in die Nachprüfung, wenn die Erkennung unsicher ist.

**Alles ist Simulation: dargestellt, nicht gemessen.** Es werden keine Aufträge
geändert, keine Bilder gespeichert und keine echte Steuerung angesprochen.

## Öffnen

| Weg | Adresse / Klick |
|---|---|
| Im Portal | **Roboter → Arme & Zellen** (`/app/#/roboter/zellen`) |
| Aus dem Twin Studio | Konto-Menü **Sortierzelle (Portal → Roboter)** oder Hinweis **„Zelle im Portal"** in Halle 3 |

**Vollbild** legt die Zelle über die ganze Seite, `Esc` holt sie zurück. Die
frühere Seite `/studio/cell.html` und `/studio/?cell=1` gibt es nicht mehr.

## Was zu sehen ist

* **3D-Zelle** links: Band, Sortierkörbe, Kamera oben und der Arm mit sieben
  Drehgelenken A1–A7. Ziehen dreht die Ansicht, Rad zoomt. Die Gelenkwinkel
  stehen live links unten; A4 ist die redundante Achse (Nullraumbewegung).
* **„Was die Kamera von oben sieht"** rechts: dieselbe Szene, aber mit einer
  zweiten, orthografischen Three.js-Kamera von oben — also wörtlich das
  Kamerabild, keine nachgezeichnete Skizze. Erkennungsrahmen, Nummern,
  Klassen und Trefferwerte liegen darüber. *Kamera groß* tauscht die
  Gewichtung beider Ansichten.
* **Teileerkennung** rechts: Form, Maße, Winkel, Treffer in %, Alternativen
  und die Sortierentscheidung. *Kamerarauschen* verschlechtert die gemessene
  Kontur (Bewegung, streifendes Licht) → Nachprüfung. *Maßtoleranz* und
  *Teil vorziehen* (inkl. Fremdteil) erlauben gezielte Prüfungen.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `stations.ts` | Aufteilung der Zelle auf mehrere Arme: Greifstellen, Armfüße, Korbstreifen; höchstens zwei Arme je Zelle |
| `runtime.ts` | Renderer, drei Kameras per Scissor/Viewport, Band- und Zykluslogik je Arm, Protokoll, Handführung |
| `teach.ts` | Abbildung Handgelenk (MediaPipe) → Ziel im Greifraum, Werkzeuglage, Pinch/Sauger, 3D-Hand |
| `handTracking.ts` | Google MediaPipe im Browser: Hand (21 Punkte) und Körper (33 Punkte) je Bild, lokal |
| `teilerkennung.ts` | Reine Übersetzung von `gimel/core/vision.py::match`: umschreibendes Rechteck, Vorfilter, Kontur-IoU, confidence, ambiguous, Alternativen |
| `forms.ts` | Fünf Formen plus Fremdteil; Ringe in mm sind zugleich 3D-Geometrie, SVG-Vorschau und Template |
| `robotArm.ts` → `components/twin/arm7.ts` | 7-Gelenk-Kinematik mit Kugelhandgelenk (A5 ⟂ A6): IK für A1–A3, A5/A6 stellen das Werkzeug aus jeder A4-Lage senkrecht, A7 die Teilelage; Modell mit Schalen, Fugen, Kabelkanal, Vakuumgreifer; `buildArm(base, { ghost })` für die Handführung |
| `cellScene.ts` | Band, Körbe (je Station), Kameramast, Licht; Armkörper nur in der Perspektive (Schicht 1) |
| `SortingCell.tsx` / `sortingCell.css` | Oberfläche, Armliste, Erkennungs-Overlay, Handführungskarte |

Der Server prüft acht Lagen (spiegeln × 90°), weil er die Kontur vorher über
die Längsachse ausrichtet. Bei runden Teilen mit asymmetrischen Löchern ist
diese Achse willkürlich, deshalb richtet die Zelle nur den Schwerpunkt aus und
prüft 36 Drehlagen × 2 Spiegelungen. Es bleibt dieselbe IoU-Rechnung.

## Mehrere Arme

Stehen in derselben Halle zwei Arme, bekommt jeder eine eigene Station am Band
und einen halben Korbstreifen (die Formkörbe sind eine Partition, die
Nachprüfung gibt es an jeder Station). Das Band hält an, wenn ein Teil an
seiner Station steht oder ein Arm gerade greift. Mehr als zwei Arme je Zelle
baut die Zelle nicht auf; die weiteren bleiben in der Flottenliste. Drei und
mehr Stationen würden am Kameramast und am Bandende kollidieren.

## Handführung (Google MediaPipe)

„Kamera starten" nimmt die Webcam (nur lokal, kein Bild verlässt den Rechner)
und verfolgt Hand und Arm mit MediaPipe. Die Pose der Hand wird auf den
gezeigten Arm gelegt und als halbdurchsichtiger Geist (grau-blau, Leuchtring
zeigt den Sauger) dargestellt; der Pinch-Abstand Daumen–Zeigefinger steuert
den Sauger. „Trockenlauf" rechnet dieselbe Kette ohne Kamera
(`teach.ts::syntheticFrame`). „Mitte setzen" merkt die Neutralstellung,
„Pose aufnehmen" speichert Wegpunkte und exportiert sie als JSON — als Vorlage
für eine Mission, nicht als Steuerung: Gimel führt keine Programme aus.

Die Modelle liegen in `web/public/mediapipe/` (WASM bei jedem Build kopiert,
~14 MB Modelle einmalig über `npm run mediapipe:models`); ohne sie zeigt die
Zelle einen Hinweis statt der Kamera.

## Halle 3 · „Hello World"

`gimel hall3` legt idempotent **Hall 3 Experimental** neben Halle 2 an: eine
Ebene, ein Tor, Arbeitstisch, Pakete und den `RobotAsset` mit `kind="arm"`.
Zusätzlich gibt es eine Mission **Hello World** (`RobotProgram`, JSON mit
vier Posen). Im 3D-Grundriss fährt der Arm diese Posen als Schleife —
`components/twin/robotModel.ts` stellt sie dar. Gimel führt Programme
grundsätzlich nie aus; auch hier ist es Darstellung, keine Steuerung.

## Bauen und prüfen

```bash
cd web
npm run build                    # baut Portal und Studio (kopiert MediaPipe-WASM)
npm run mediapipe:models         # einmalig: Modelle (~14 MB), nur wenn die Kamera genutzt wird
node sorting-cell.test.mjs       # reine Teileerkennung: Formen, Drehung, Maße, Fremdteil, Rauschen
node arm7.test.mjs               # Kinematik: TCP auf Ziel, Werkzeug senkrecht, A4-Nullraum
node multi-arm.test.mjs          # Aufteilung der Zelle auf mehrere Arme, alle Ziele erreichbar
node teach.test.mjs              # Handführung: Abbildung, IK, Sauger, 3D-Hand
node robots-page.test.mjs ../gimel/webapp/dist   # Roboter-Seite: Fahrzeuge, Arme & Zellen
cd ..
.venv/bin/python -m pytest -q tests/app/test_hall3.py
```

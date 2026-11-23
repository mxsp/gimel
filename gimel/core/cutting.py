"""Die Schnittfolge — welche Datei welche Maschine bekommt, und warum.

Der Werkstattbefund, aus dem dieses Modul entstanden ist, im Wortlaut des
Betreibers:

    Plotter = DIE-Datei, Wasserstrahl = DIG-Datei.
    Das Umwandeln einer DXF in die DIE-Datei schneidet **von außen nach
    innen** — dabei sieht das Programm die ganze Auslage als *ein* Teil.
    Wird es am Plotter eigens einprogrammiert, schneidet er **von innen
    nach außen** und sieht *jedes Teil einzeln*. So muss es bei glatten
    Werkstoffen sein, sonst reicht die Ansaugkraft nicht und runde
    Dichtungen sehen aus wie Eier.
    Am Wasserstrahl gibt es das Problem nicht: dort wird die Reihenfolge in
    der Vorbereitung programmiert, und das System erkennt alles einzeln.

Daraus folgen drei Sätze, und dieses Modul ist nichts weiter als sie:

1. **Die voreingestellte Umwandlung ist der Fehlerfall.** Nicht eine
   Einstellung unter mehreren — der Zustand, in dem die Platte kaputtgeht.
   Deshalb ist die sichere Folge hier die *Vorgabe* und die andere die
   Ausnahme, die man ausdrücklich wählen muss. Vorher war es umgekehrt: ein
   Häkchen, das jemand setzen musste, und dahinter ``outside_in``.
2. **Die Entscheidung gehört der Maschine, nicht dem Bediener.** Welche
   Station den Innenauftrag schneidet, steht am Auftrag; welcher Werkstoff
   glatt ist, steht am Werkstoff. Beides ist bekannt, bevor jemand auf
   „Herunterladen" klickt — also darf die Frage nicht gestellt werden.
3. **Die Regel muss nachlesbar sein.** Jede Entscheidung trägt ihren
   Klartextgrund mit (``CutPlan.reason``), so wie die Freigaberegel in
   ``domain/batch.py`` und die Zuordnung in ``domain/routing.py``. Eine
   Regel, deren Entscheidung man nicht nachlesen kann, wird beim ersten
   Zweifel abgeschaltet.

Rein: keine Datenbank, kein Request, keine Uhr. Die Aufrufer in
``routers/production.py`` besorgen Maschinenart und Werkstoffgruppe.
"""

from __future__ import annotations

from dataclasses import dataclass

# --------------------------------------------------------------------------
# Ansaugkraft — wie gut ein Werkstoff auf dem Vakuumtisch hält
# --------------------------------------------------------------------------
# Der Vakuumtisch hält die Platte über ihre Fläche. Jeder durchgehende
# Schnitt ist ein Leck: sobald eine Außenkontur geschlossen ist, zieht die
# Maschine Luft durch die Fuge, und der Halt in der Umgebung sinkt. Wie viel
# das ausmacht, hängt an der Oberfläche — eine glatte Gummiplatte dichtet
# gegen den Tisch ab und rutscht als Ganzes, eine faserige Platte hält
# schlechter ab, greift aber mechanisch.
GRIP_SMOOTH = "glatt"    # Gummi, Silikon, PTFE — dichtet ab, rutscht, kippt
GRIP_NORMAL = "normal"   # Graphit — dazwischen
GRIP_ROUGH = "griffig"   # Faserstoffe, Hochtemperaturtextilien — greifen

#: Werkstoffgruppe → Ansaugkraft. Die Gruppen sind die fünf des Katalogs
#: (``data.js``/``Product.cat``).
#:
#: **Richtwert, nicht gemessen** — gehört auf die Prüfliste in CLAUDE.md §7.
#: Die Zuordnung folgt dem, was der Betreiber „glatte Materialien" nennt:
#: Elastomere und PTFE. Sie ist bewusst aus der *Gruppe* abgeleitet und nicht
#: aus einem neuen Feld je Werkstoff — ein leeres Feld an fünfzig
#: Katalogeinträgen wäre eine erfundene Zahl mehr, und die Gruppe trifft die
#: Werkstattfrage („ist das glatt?") heute schon richtig. Sortenweise
#: Ausnahmen gehören in ``GRIP_OVERRIDES``, mit Quelle.
CATEGORY_GRIP: dict[str, str] = {
    "elastomer": GRIP_SMOOTH,   # NBR, EPDM, FKM, Silikon — der genannte Fall
    "ptfe": GRIP_SMOOTH,        # PTFE ist die glatteste Oberfläche im Katalog
    "graphit": GRIP_NORMAL,     # Graphitfolie ist weich, aber nicht glatt
    "faser": GRIP_ROUGH,        # Aramid-/Glasfaser mit Elastomerbindung
    "hochtemp": GRIP_ROUGH,     # Glimmer, isoplan, Textilien
}

#: Sortenweise Abweichungen von der Gruppenregel, Werkstoff-ID → Ansaugkraft.
#: Leer, und das ist ehrlicher als ein geratener Eintrag: wer hier etwas
#: einträgt, hat es an der Maschine gesehen.
GRIP_OVERRIDES: dict[str, str] = {}

#: Wenn die Gruppe unbekannt ist. Der ungünstigere Fall gewinnt — eine
#: unbekannte Platte wie eine griffige zu behandeln heißt, den Schaden zu
#: riskieren, den dieses Modul verhindern soll.
GRIP_FALLBACK = GRIP_SMOOTH


def grip_of(cat: str, mat_id: str = "") -> str:
    """Die Ansaugkraft eines Werkstoffs — Sorte schlägt Gruppe."""
    if mat_id and mat_id in GRIP_OVERRIDES:
        return GRIP_OVERRIDES[mat_id]
    return CATEGORY_GRIP.get((cat or "").strip().lower(), GRIP_FALLBACK)


# --------------------------------------------------------------------------
# Der Plan
# --------------------------------------------------------------------------
#: Die sichere Folge: innen nach außen, auf allen drei Ebenen (siehe
#: ``render/dxf.py``). Das ist der Modus, den der Betreiber als „am Plotter
#: extra einprogrammiert" beschreibt.
SAFE_STRATEGY = "inside_out"

#: Was die DXF→DIE-Umwandlung von sich aus tut, wenn ihr niemand
#: widerspricht. Bleibt wählbar, weil eine geschichtete Datei mit *dieser*
#: Folge immer noch mehr sagt als eine ungeschichtete — aber sie ist nie die
#: Vorgabe, und auf glattem Werkstoff steht eine Warnung daneben.
CONVERSION_STRATEGY = "outside_in"

#: Was der Bediener statt einer Strategie wählen kann.
MODE_AUTO = "auto"          # aus Maschine und Werkstoff (Vorgabe)
MODE_CLASSIC = "klassisch"  # ungeschichtet, zwei Ebenen (Kontur/Loch)


@dataclass(frozen=True)
class CutPlan:
    """Wie diese Platte geschnitten wird, und woraus das folgt."""

    #: Trägt die Datei die Schnittfolge in Ebenen?
    layered: bool
    #: Welche Folge — leer, wenn ``layered`` falsch ist.
    strategy: str
    #: Die Eingaben, damit die Entscheidung ohne Rückfrage prüfbar ist.
    machine_kind: str
    grip: str
    #: Ist die geschichtete Datei hier Pflicht (glatter Werkstoff am Plotter)
    #: oder nur die bessere Wahl?
    mandatory: bool
    #: Warum — im Klartext, so wie es in der Oberfläche, auf der Laufkarte
    #: und im LIESMICH der ZIP steht.
    reason: str
    #: Gesetzt, wenn der Bediener gegen die Regel gewählt hat. Die Wahl
    #: gilt trotzdem — sie steht nur nicht unwidersprochen da.
    warning: str = ""
    #: Wurde ausdrücklich gewählt statt hergeleitet?
    chosen: bool = False

    @property
    def dxf_strategy(self) -> str | None:
        """Was ``plate_dxf(plotpro_strategy=…)` erwartet: die Folge oder None."""
        return self.strategy if self.layered else None

    @property
    def label(self) -> str:
        """Kurzform für Knöpfe und Dateinamen."""
        if not self.layered:
            return "Klassisch"
        return STRATEGY_LABELS.get(self.strategy, self.strategy)


#: Klartextnamen der Folgen. Eine Stelle, damit Oberfläche, Laufkarte und
#: LIESMICH nicht drei Wortlaute für dieselbe Sache tragen.
STRATEGY_LABELS = {
    "inside_out": "Innen → außen",
    "outside_in": "Außen → innen",
    "largest_first": "Größte zuerst",
    "smallest_first": "Kleinste zuerst",
}

_SMOOTH_WHY = ("glatter Werkstoff hält auf dem Vakuumtisch nur über die Fläche; "
               "eine früh geschnittene Außenkontur nimmt den Halt weg, und das "
               "Teil verzieht sich")


def plan_cut(machine_kind: str, cat: str, *, mat_id: str = "",
             want: str | None = None) -> CutPlan:
    """Der Schnittplan für eine Platte.

    ``machine_kind`` ist die Maschinenart der zugeordneten Station
    (``plotter`` | ``waterjet`` | ``punch`` | ``manual`` | ``""``), ``cat``
    die Werkstoffgruppe. ``want`` ist die Wahl des Bedieners: ``None`` oder
    ``MODE_AUTO`` überlässt die Entscheidung der Regel, ``MODE_CLASSIC``
    erzwingt die ungeschichtete Datei, jede Strategie erzwingt sich selbst.

    Ein erzwungener Plan wird nie überstimmt — der Mensch an der Maschine
    sieht mehr als diese Funktion. Er bekommt nur die Warnung dazu.
    """
    kind = (machine_kind or "").strip().lower()
    grip = grip_of(cat, mat_id)
    auto = _auto_plan(kind, grip)

    if want in (None, "", MODE_AUTO):
        return auto

    if want == MODE_CLASSIC:
        return CutPlan(
            layered=False, strategy="", machine_kind=kind, grip=grip,
            mandatory=auto.mandatory, chosen=True,
            reason="Klassische Datei ausdrücklich gewählt: zwei Ebenen "
                   "(Kontur/Loch), die Reihenfolge macht die Maschine.",
            warning=("Am Plotter sieht die Umwandlung die ganze Auslage als ein "
                     f"Teil und schneidet von außen nach innen — {_SMOOTH_WHY}."
                     if auto.mandatory else ""),
        )

    if want not in STRATEGY_LABELS:
        raise ValueError(f"Unbekannte Schnittfolge: {want!r}. "
                         f"Erlaubt: {MODE_AUTO}, {MODE_CLASSIC}, "
                         f"{', '.join(sorted(STRATEGY_LABELS))}")

    warning = ""
    if want == CONVERSION_STRATEGY and auto.mandatory:
        warning = ("„Außen → innen“ ist genau die Folge, die die Umwandlung von "
                   f"sich aus fährt — {_SMOOTH_WHY}. Für diesen Werkstoff ist "
                   "„Innen → außen“ die Werkstattvorgabe.")
    elif want in ("largest_first", "smallest_first") and auto.mandatory:
        warning = ("Diese Folge achtet nicht auf Verschachtelung: ein Teil in "
                   "einer Restfläche kann vor seinem Wirt oder nach ihm "
                   f"drankommen — {_SMOOTH_WHY}.")

    return CutPlan(
        layered=True, strategy=want, machine_kind=kind, grip=grip,
        mandatory=auto.mandatory, chosen=True, warning=warning,
        reason=f"{STRATEGY_LABELS[want]} ausdrücklich gewählt.",
    )


def _auto_plan(kind: str, grip: str) -> CutPlan:
    """Die hergeleitete Entscheidung — der ganze Regelsatz an einer Stelle."""
    if kind == "waterjet":
        # Der Betreiber ausdrücklich: am Wasserstrahl gibt es das Problem
        # nicht, weil die Folge in der Vorbereitung programmiert wird und das
        # System jedes Teil einzeln erkennt. Eine geschichtete Datei würde
        # dort nichts verbessern und die gewohnten Ebenen verstellen.
        return CutPlan(
            layered=False, strategy="", machine_kind=kind, grip=grip,
            mandatory=False,
            reason="Wasserstrahl: die Schnittfolge wird in der Vorbereitung "
                   "programmiert und das System erkennt jedes Teil einzeln — "
                   "die Datei bleibt klassisch (Kontur/Loch).",
        )
    if kind == "punch":
        return CutPlan(
            layered=False, strategy="", machine_kind=kind, grip=grip,
            mandatory=False,
            reason="Stanze: das Werkzeug bestimmt die Form, es gibt keine "
                   "Schnittfolge zu übergeben.",
        )
    if kind == "manual":
        return CutPlan(
            layered=False, strategy="", machine_kind=kind, grip=grip,
            mandatory=False,
            reason="Handarbeit: die Datei ist eine Zeichnung, keine "
                   "Maschinenanweisung.",
        )

    # Plotter — und alles, was noch keine Station hat. Ein Innenauftrag wird
    # oft heruntergeladen, bevor er zugeordnet ist; dann ist die sichere Folge
    # die richtige Vorgabe. Sie kostet an einer Maschine, die sie nicht
    # braucht, nichts außer ein paar Ebenen.
    if grip == GRIP_SMOOTH:
        return CutPlan(
            layered=True, strategy=SAFE_STRATEGY, machine_kind=kind, grip=grip,
            mandatory=True,
            reason=("Glatter Werkstoff am Plotter: jedes Teil liegt einzeln auf "
                    "seinen Ebenen und wird von innen nach außen geschnitten. "
                    "Ohne das sieht die Umwandlung die ganze Auslage als ein "
                    "Teil, schneidet von außen nach innen, und die Ansaugkraft "
                    "reicht nicht — runde Dichtungen werden oval."),
        )
    return CutPlan(
        layered=True, strategy=SAFE_STRATEGY, machine_kind=kind, grip=grip,
        mandatory=False,
        reason=(f"Werkstoff {grip}: der Halt ist unkritisch. Die Folge "
                "innen → außen bleibt trotzdem die Vorgabe — sie kostet nichts "
                "und hält die Reihenfolge nachvollziehbar."),
    )

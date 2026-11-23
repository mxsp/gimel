"""Betriebsparameter lesen und schreiben (Tabelle ``settings``)."""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import Setting

DEFAULTS: dict[str, tuple[str, str]] = {
    # Schlüssel: (Vorgabe, Erläuterung)
    "batch_enabled": ("true", "Sammellauf läuft automatisch im Takt."),
    "batch_mode": ("sammel", "Betriebsart: „sammel“ legt die Positionen aller Kunden je Werkstoff "
                             "und Dicke zusammen — beste Materialausnutzung. „sofort“ schneidet "
                             "jeden Auftrag für sich, ein Innenauftrag je Auftrag und Werkstoff — "
                             "kürzeste Durchlaufzeit, kein Mengeneffekt. Je Werkstoff "
                             "überschreibbar."),
    "batch_group_by": ("material", "Schachtelgruppe: „material“ mischt Kunden auf einer Platte "
                                   "(beste Ausnutzung), „customer“ hält jeden Kunden getrennt "
                                   "(keine Kundenmischung, mehr Platten). Gilt für den nächsten "
                                   "Lauf; ein ausdrücklicher Lauf kann es einmalig überschreiben."),
    "batch_interval_minutes": ("10", "Takt des Sammellaufs in Minuten (1 = jede Minute, 1440 = täglich)."),
    "batch_min_parts": ("1", "So viele wartende Teile müssen zusammenkommen, sonst wartet der Lauf "
                             "auf mehr — höhere Werte sammeln länger und nutzen die Platte besser, "
                             "verzögern aber die Lieferung."),
    "batch_min_utilisation": ("0.70", "Ab diesem Anteil der Plattenhöhe gilt eine Platte als voll und "
                                      "wird geschnitten; angebrochene Platten sammeln weiter. Das ist "
                                      "der eigentliche Materialhebel — vierzig DN25 und drei DN800 "
                                      "sind nicht dieselbe Platte, und die Stückzahl allein sagt "
                                      "darüber nichts."),
    "batch_max_age_minutes": ("1440", "Spätestens nach dieser Wartezeit wird geschnitten, auch wenn "
                                      "keine Platte voll ist. Verhindert, dass eine einzelne "
                                      "Position ewig liegen bleibt."),
    "batch_due_lead_hours": ("48", "Rückt eine zugesagte Lieferung näher als das, wird geschnitten. "
                                   "Materialoptimierung darf nie eine Zusage aufessen."),
    "batch_max_plates_per_run": ("0", "Höchstens so viele Platten je Lauf freigeben (0 = ohne Deckel). "
                                       "Eine Bremse, kein Auslöser: sie verhindert, dass ein Takt "
                                       "vierzig Platten auf eine Zweimannwerkstatt kippt."),
    "batch_max_orders_per_work_order": ("0", "Höchstens Kundenaufträge je Innenauftrag (0 = ohne Deckel, "
                                        "1 = jeder Auftrag für sich). Ein Kundenauftrag wird dabei nie "
                                        "auf mehrere Innenaufträge verteilt — der Auftrag bleibt ganz."),
    "batch_max_plates_per_work_order": ("0", "Höchstens Platten je Innenauftrag (0 = ohne Deckel). "
                                         "Überschreitet ein freigegebener Eimer den Wert, wird er in "
                                         "mehrere Innenaufträge zerlegt — ein Auftrag wandert dabei nie "
                                         "auseinander. Ein einzelner großer Auftrag darf den Wert als "
                                         "einziger überziehen, statt geteilt zu werden."),
    "offcut_enabled": ("true", "Reststücke: das ungenutzte Schnittband einer Platte wird als "
                               "Reststück geführt, und der Sammellauf legt eine Platte auf ein "
                               "passendes Reststück, statt eine volle Platte anzubrechen."),
    "offcut_min_side_mm": ("150", "Reststück erst ab dieser kürzeren Seite in mm — schmalere "
                                  "Streifen sind Verschnitt."),
    "offcut_min_area_m2": ("0.05", "Reststück erst ab dieser Fläche in m²."),
    "offcut_saw_mm": ("5", "So viel geht beim Abtrennen des Reststücks verloren (Schnittfuge "
                           "plus Sicherheit), in mm."),
    "batch_mixed_formats": ("true", "Ein Innenauftrag darf mehrere Plattenformate desselben "
                                    "Werkstoffs mischen — je Platte wird das günstigste Format "
                                    "gewählt. Aus: ein Format für den ganzen Auftrag."),
    "vision_calibration": ("{}", "Kameraaufbau der Teileerkennung (JSON). Wird auf dem Bildschirm "
                                 "Teileerkennung gepflegt."),
    "vision_zone": ("{}", "Zählbereich der Teileerkennung auf dem Tisch (JSON). Was darin "
                            "erkannt wird, zählt automatisch und wird vom Rest abgezogen."),
    "external_modules": ("[]", "Benutzerdefinierte semi-externe Module und Anwendungen (JSON). "
                               "Wird über Module & Apps gepflegt."),
    "nesting_engine": ("kerf", "Schachtel-Motor der Fertigung. „kerf“ ist die Vorgabe: echte "
                               "Kontur, Löcher und freie Lagen, mit „lite“ als Untergrenze. "
                               "„lite“ = der bewährte Kern (2.8.0), schneller und gröber. "
                               "„gre“ = GRE 5.3.0 — nutzt die Platte enger, rechnet dafür Sekunden "
                               "statt Millisekunden; nur der Sammellauf rührt ihn an, die Kasse "
                               "und ihre Preise bleiben immer bei „lite“. Fehlt die GRE-Installation, "
                               "wird laut auf „lite“ zurückgefallen — die Engine-Version am "
                               "Innenauftrag sagt, wer geschachtelt hat."),
    # Geometrie der Fertigungsschachtelung. Ausdrücklich NICHT die
    # Kalkulationssätze: rates.gap und rates.margin gehen in den Preis ein, und
    # wer sie verstellt, verschiebt jedes Angebot. Diese Werte gelten nur für
    # die Werkstatt — der Unterschied ist die Marge aus CLAUDE.md §8.2.
    "nest_gap_mm": ("", "Abstand Teil zu Teil in Millimetern. Leer = Kerf des Werkstoffs, "
                        "sonst der Kalkulationssatz. Der Wert muss die Schnittfuge tragen: "
                        "was der Strahl wegnimmt, fehlt beiden Nachbarn."),
    "nest_margin_mm": ("", "Abstand zum nutzbaren Plattenrand in Millimetern. "
                           "Leer = Steg des Werkstoffs."),
    "nest_trim_w_mm": ("0", "Nutzbare Breite = Plattenformat minus diesem Wert. Für "
                            "Spannkante, beschädigten Rand oder eine Zuführung, die den "
                            "Anfang der Platte nicht erreicht."),
    "nest_trim_h_mm": ("0", "Nutzbare Höhe = Plattenformat minus diesem Wert."),
    "nest_max_ms": ("", "Rechenzeit-Notbremse der Schachtelung in Millisekunden. Leer = ohne. "
                        "Sie greift nur zwischen zwei Kandidaten, nie mitten in einem Layout; "
                        "greift sie, steht das am Plan. Gilt nur für die Fertigung — ein Preis "
                        "darf nicht von der Tageslast abhängen."),
    "nest_max_candidates": ("", "Wie viele Saatordnungen die Schachtelung bewertet (1–5). "
                                "Das ist das eigentliche Budget: gezählt in Layouts, nicht in "
                                "Sekunden, damit derselbe Eimer auf jeder Maschine gleich "
                                "ausfällt. Leer = Vorgabe des Rechenkerns."),
    "nest_corner_max_mm": ("", "Kein Teil weiter als dieser Abstand von der Nullecke der Platte. "
                                "Für Maschinen, deren Portal nicht die ganze Platte erreicht, und "
                                "um den Rest als ein zusammenhängendes Stück zu erhalten. "
                                "Leer = keine Schranke."),
    # Verschachtelungs-Politik des GRE-Exaktrechners (Engine 5.2.0). Vom
    # Bediener wählbar; beide Schalter stehen standardmäßig auf AN, weil
    # Materialausnutzung das Ziel ist. Drehung trifft nur freie Konturen —
    # Werkstoff mit Textur/Materialwelle bleibt über grain_constrained ohnehin
    # auf 0° gesperrt.
    "nest_allow_rotation": ("true", "Teile dürfen gedreht werden. Aus: alles liegt unverdreht "
                                     "(0°) — auch die Platte wird dann nicht mehr um 90° gedreht "
                                     "angeboten, denn das ist dieselbe Operation. Gilt für lite "
                                     "und kerf; GRE liest den Wert ebenfalls."),
    "nest_allow_mirror": ("true", "Teile dürfen gespiegelt (gewendet) werden. Bei asymmetrischen "
                                   "Konturen verdoppelt das die Legemöglichkeiten; aus ist es bei "
                                   "einseitigen Werkstoffen. lite und GRE spiegeln; kerf prüft "
                                   "jede Lage ohne Spiegelung."),
    "nest_rotation_step_deg": ("15", "GRE-Schachtelung: Winkelauflösung in Grad (15 = 24 Lagen). "
                                      "Feiner = bessere Ausnutzung, längere Rechenzeit; "
                                      "0 = nur 0° und die kantenausgerichteten Winkel."),
    # Kerf-Feinschliff (Engine „kerf“). Leer heißt „aus der Arbeitsmenge“ und
    # nicht 0 — dieselbe Regel wie bei den übrigen Suchvorgaben.
    "nest_kerf_steps": ("", "Schritte des Kerf-Rechenkerns. Leer = aus Teilezahl und Lagen "
                             "geschätzt (4 bis 120; große Körbe bekommen weniger). Mehr Schritte "
                             "suchen länger nach einer besseren Lage und bleiben reproduzierbar. "
                             "Zwischen 4 und 5000."),
    "nest_kerf_stall": ("0", "Kerf bricht ab, wenn so viele Schritte keinen Gewinn mehr brachten. "
                              "0 = aus (er rechnet das Budget zu Ende). Zwischen 0 und 5000."),
    "nest_kerf_cell": ("", "Rasterweite des Kerf-Rechenkerns in Millimetern. Leer = aus "
                            "Plattengröße und kleinstem Teil. Feinere Raster finden engere Lagen, "
                            "brauchen aber mehr Speicher; zwischen 0,25 und 100."),
    "nest_kerf_gravity": ("top", "Füllrichtung: „top“ füllt von der oberen Kante, „left“ von der "
                                  "linken. Die Werkstatt schneidet meist von oben; bei einem "
                                  "Vorschub von links ist „left“ die bessere Wahl."),
    "nest_kerf_seed": ("1", "Startwert der Kerf-Suche. Gleicher Korb, gleiche Einstellungen und "
                             "gleicher Startwert ergeben dieselbe Lage. Ein anderer Wert ist ein "
                             "anderer Versuch, keine bessere Lage."),
    "nest_kerf_refine": ("true", "Kerf verfeinert das letzte Drittel des Budgets auf halbem "
                                  "Raster. Aus = schneller, aber gröber; bei sehr großen Körben "
                                  "schaltet der Kern von selbst ab."),
    "order_prefix": ("AB-26", "Präfix der Auftragsnummern."),    "work_order_prefix": ("IA-26", "Präfix der Innenauftragsnummern."),
    "run_prefix": ("SL-26", "Präfix der Sammellaufnummern."),
    "customer_prefix": ("KD-26", "Präfix der Kundennummern. Leer gelassene Kundennummern\n                                 vergibt das Auftragsbüro daraus fortlaufend."),
    "delivery_days": ("3", "Werktage bis zur zugesagten Lieferung. Daraus entsteht das Zusagedatum "
                           "am Auftrag, das die Freigaberegel liest."),
    # Schaufenster Port 8000, geführt aus Port 8001 (getrennt, aber geführt).
    "shop_plotter_only": ("true", "Shop-Sortiment: nur CNC-Plotter-Werkstoffe (cnc=confirmed). "
                                   "Faser/Hochtemp bleiben fürs Personal bestellbar."),
    "shop_notice": ("", "Hinweiszeile im Shop (Port 8000), gepflegt aus dem Backend."),
    "portal_url": ("http://127.0.0.1:8000", "Adresse des Kundenportals (Kasse/Verfolgung)."),
    "punchout_enabled": ("true", "OCI-PunchOut für SAP freigeschaltet."),
    # Maßbeschränkungen für den Bestellportal — begrenzen, welche Teile
    # Kunden über das Portal bestellen können. Leer = keine Beschränkung.
    "limit_max_od": ("", "Maximaler Außendurchmesser in mm. Teile größer als dieser "
                        "Wert werden im Portal abgelehnt. Leer = keine Beschränkung."),
    "limit_min_od": ("", "Minimaler Außendurchmesser in mm. Teile kleiner als dieser "
                        "Wert werden im Portal abgelehnt. Leer = keine Beschränkung."),
    "limit_min_web": ("", "Minimaler Steg (Randbeschnitt) in mm — der Abstand zwischen "
                          "Innenloch und Außenkante. Leer = Steg des Werkstoffs."),
    "limit_min_corner": ("", "Minimaler Eckabstand in mm — Abstand derkontur nearest edge to "
                             "plate corner. Für Rechteck- und Ovalteile. Leer = 0."),
    "limit_max_plate_w": ("", "Maximale Plattenbreite in mm. Das größte Format, das "
                              "die Schachtelung verwenden darf. Leer = ohne Deckel."),
    "limit_max_plate_h": ("", "Maximale Plattenhöhe in mm. Das größte Format, das "
                              "die Schachtelung verwenden darf. Leer = ohne Deckel."),
}


def get_all(db: Session) -> dict[str, str]:
    rows = {s.key: s.value for s in db.query(Setting).all()}
    return {k: rows.get(k, v[0]) for k, v in DEFAULTS.items()} | {
        k: v for k, v in rows.items() if k not in DEFAULTS
    }


def get(db: Session, key: str, default: str | None = None) -> str:
    row = db.get(Setting, key)
    if row:
        return row.value
    return DEFAULTS.get(key, (default or "", ""))[0]


def get_int(db: Session, key: str, default: int = 0) -> int:
    try:
        return int(float(get(db, key, str(default))))
    except (TypeError, ValueError):
        return default


def get_float(db: Session, key: str, default: float = 0.0) -> float:
    try:
        return float(get(db, key, str(default)))
    except (TypeError, ValueError):
        return default


def get_bool(db: Session, key: str, default: bool = False) -> bool:
    return get(db, key, "true" if default else "false").strip().lower() in ("1", "true", "yes", "ja")


def set_value(db: Session, key: str, value: str, actor: str = "") -> Setting:
    row = db.get(Setting, key)
    if row:
        row.value = value
        row.updated_by = actor
    else:
        row = Setting(key=key, value=value, updated_by=actor,
                      note=DEFAULTS.get(key, ("", ""))[1])
        db.add(row)
    return row


def ensure_defaults(db: Session) -> None:
    def seed() -> None:
        for key, (value, note) in DEFAULTS.items():
            if not db.get(Setting, key):
                db.add(Setting(key=key, value=value, note=note))

    # Zwei Prozesse können gleichzeitig starten (Leitstand-Instanz und ein
    # zweiter Port). Der zweite darf an einer bereits eingefügten Zeile nicht
    # scheitern; nach dem Rollback fehlen nur noch seine eigenen Schlüssel.
    for _ in range(3):
        seed()
        try:
            db.commit()
            return
        except IntegrityError:
            db.rollback()
    seed()
    db.commit()

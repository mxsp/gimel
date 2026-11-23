"""Brücke zwischen ORM-Zeilen und den reinen Werttypen des Rechenkerns."""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..core.types import Product as DomainProduct
from ..core.types import Rates
from ..models import Product, Rate

# Schlüssel in der Tabelle `rates` → Feldname in domain.Rates
RATE_FIELDS = {
    "cut": "cut", "machineH": "machine_h", "cutSpeed": "cut_speed_mm_s",
    "cutThk1": "cut_thk1", "cutThk15": "cut_thk15", "cutThk2": "cut_thk2",
    "cutThk3": "cut_thk3",
    "pierceS": "pierce_s", "setupMin": "setup_min",
    "handlingMinPerPlate": "handling_min_per_plate",
    "setupPct": "setup_pct",
    "setupFix1": "setup_fix1", "setupFix2": "setup_fix2", "setupFix3": "setup_fix3",
    "gap": "gap", "margin": "margin",
    "wasteMin": "waste_min", "wasteMax": "waste_max", "cert31": "cert31",
    "freight": "freight", "sheetMarkup": "sheet_markup", "vat": "vat",
    "leftoverThreshold": "leftover_threshold",
}

RATE_META = {
    "cut": ("€/m", "Schnittlänge. Rückfall für Dicken ohne eigenen Satz. Hergeleitet "
                    "aus Maschinenstundensatz ÷ Nettovorschub: "
                    "65 €/h ÷ 43 mm/s ≈ 0,42 €/m (ATOM FlashCut 3015/5: 50 m/min max, "
                    "netto nach Kurven/Anstich/Handling). Plotter ≠ Wasserstrahl."),
    "machineH": ("€/h", "Maschinensatz CNC-Plotter inkl. Bediener, Energie, Wartung. "
                       "Richtwert 2026-09: ca. 65 €/h."),
    "cutSpeed": ("mm/s", "Netto-Vorschub nach Kurven, Anstichen und Handling "
                         "(nicht der Maximalvorschub 833 mm/s). 43 mm/s ≈ 2,6 m/min."),
    "pierceS": ("s", "Anstechen/Positionieren je Kontur — Zeitmodell für Routing und Info."),
    "setupMin": ("min", "Rüsten je Innenauftrag — Zeitmodell, kein Preisbestandteil."),
    "handlingMinPerPlate": ("min", "Platte auflegen und abräumen — Zeitmodell."),
    "setupPct": ("x", "Ruesten als Anteil an Material+Zuschnitt, zusaetzlich "
                         "zur festen Einrichtung je Stufe (Betriebsvorgabe beides)."),
    "cutThk1": ("€/m", "Schnittsatz 1,0 mm — 65 €/h ÷ 3,0 m/min ≈ 0,36 €/m."),
    "cutThk15": ("€/m", "Schnittsatz 1,5 mm — 65 €/h ÷ 2,5 m/min ≈ 0,43 €/m."),
    "cutThk2": ("€/m", "Schnittsatz 2,0 mm — 65 €/h ÷ 2,0 m/min ≈ 0,54 €/m."),
    "cutThk3": ("€/m", "Schnittsatz 3,0 mm — 65 €/h ÷ 1,0 m/min ≈ 1,08 €/m."),
    "setupFix1": ("€", "Feste Einrichtung Stufe 1 (genormte Dichtungen), 1× je Auftrag."),
    "setupFix2": ("€", "Feste Einrichtung Stufe 2 (Sondermaß oder Löcher), 1× je Auftrag."),
    "setupFix3": ("€", "Feste Einrichtung Stufe 3 (Zeichnung oder Sonder mit Löchern), "
                        "1× je Auftrag."),
    "gap": ("mm", "Standardabstand zwischen zwei Teilen, wenn der Werkstoff keinen eigenen Kerf trägt."),
    "margin": ("mm", "Randbeschnitt / Spannkante."),
    "wasteMin": ("×", "Untere Grenze des Verschnittfaktors."),
    "wasteMax": ("×", "Obere Grenze des Verschnittfaktors."),
    "cert31": ("€", "Abnahmeprüfzeugnis 3.1 nach EN 10204."),
    "freight": ("€", "Versandpauschale."),
    "sheetMarkup": ("×", "Aufschlag auf Plattenware ab Lager."),
    "vat": ("", "Umsatzsteuersatz Inland."),
    "leftoverThreshold": ("", "Ab dieser ungenutzten Plattenfläche wird die Restflächen-Gutschrift "
                              "angezeigt (reine Anzeige, verändert die Summe nie)."),
}


def to_domain_product(row: Product) -> DomainProduct:
    return DomainProduct(
        id=row.id,
        eur_m2=float(row.eur_m2),
        # Verkaufspreis je Dicke (VK €/m²) — wo die Einkaufsliste ihn nennt.
        # Ohne ihn rechnet der Kern mit eur_m2 (2.10.0-lite, wie engine.js).
        eur_m2_thk=dict(getattr(row, "eur_m2_thk", None) or {}),
        sheets=[(float(w), float(h)) for w, h in (row.sheets or [])],
        kerf=row.kerf,
        web=row.web,
        # Mindeststeg im Teil — fällt im Kern auf 10 mm Fabrikvorgabe zurück,
        # wo die Zeile keinen trägt (wie data.js).
        min_web=row.min_web,
        name=row.name,
        cnc=getattr(row, "cnc", None) or "check",
        # Die Werkstoffrichtung reist mit — ohne sie würde der Kern Teile auf
        # gerichtetem Werkstoff drehen: Ausschuss, der richtig aussieht.
        grain=getattr(row, "grain", None) or "none",
        flip_ok=getattr(row, "flip_ok", True) is not False,
    )


def load_products(db: Session, only_active: bool = True,
                  plotter_only: bool = False) -> dict[str, DomainProduct]:
    """Werkstoffe als Rechenkern-Typen. ``plotter_only`` = nur ``cnc=confirmed``
    (Shop-Sortiment, PunchOut-Katalog) — die Fertigung selbst bleibt fähig,
    was sie immer konnte (Faser/Wasserstrahl/Handarbeit laufen weiter)."""
    q = db.query(Product)
    if only_active:
        q = q.filter(Product.active.is_(True))
    if plotter_only:
        q = q.filter(Product.cnc == "confirmed")
    return {r.id: to_domain_product(r) for r in q.all() if r.sheets}


def load_rates(db: Session, vat_rate: float | None = None) -> Rates:
    values = {r.key: r.value for r in db.query(Rate).all()}
    kwargs = {}
    for key, field in RATE_FIELDS.items():
        if key in values:
            kwargs[field] = float(values[key])
    return Rates(vat_rate=vat_rate, **kwargs)

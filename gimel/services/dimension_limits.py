"""Maßbeschränkungen für das Bestellportal.

Prüft, ob eine Position die admin-seitig gesetzten Grenzen einhält. Die
Grenzen betreffen:

1. Maximaler / minimaler Außendurchmesser (das Teil muss auf eine Platte passen).
2. Mindeststeg — Abstand zwischen Innenloch und Außenkante.
3. Mindesteckabstand — Abstand einer Kontur zur nächstgelegenen Plattenecke.
4. Maximales Plattenformat — die Schachtelung darf kein größeres Format wählen.

Leere Werte bedeuten „keine Beschränkung" (bzw. beim Steg: Erbe des
Werkstoffs). Die Prüfung erfolgt auf dem API-Level, bevor gerechnet wird —
ein unzulässiges Teil kommt nie in die Kalkulation.

Wird sowohl von quotes.py / portal.py (Server) als auch als Referenz für
das Frontend (engine.js) genutzt.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from . import settings_store


@dataclass(frozen=True)
class DimensionLimits:
    """Die admin-seitig gesetzten Grenzwerte."""

    max_od: Optional[float] = None
    min_od: Optional[float] = None
    min_web: Optional[float] = None
    min_corner: Optional[float] = 0.0
    max_plate_w: Optional[float] = None
    max_plate_h: Optional[float] = None


def load_limits(db: Session) -> DimensionLimits:
    """Grenzen aus der settings-Tabelle lesen."""
    def _opt(key: str) -> Optional[float]:
        raw = settings_store.get(db, key, "").strip()
        if raw == "":
            return None
        try:
            return float(raw.replace(",", "."))
        except ValueError:
            return None

    return DimensionLimits(
        max_od=_opt("limit_max_od"),
        min_od=_opt("limit_min_od"),
        min_web=_opt("limit_min_web"),
        min_corner=max(0.0, settings_store.get_float(db, "limit_min_corner", 0.0)),
        max_plate_w=_opt("limit_max_plate_w"),
        max_plate_h=_opt("limit_max_plate_h"),
    )


def validate_position(od: float, di: float, limits: DimensionLimits,
                       product_min_web: Optional[float] = None) -> list[str]:
    """Eine einzelne Position gegen die Grenzen prüfen.

    Rückgabe: Liste von Fehlertexten (leer = ok).
    ``product_min_web`` ist der Mindeststeg des Werkstoffs
    (``product.min_web``), der als Fallback dient, wenn ``limits.min_web``
    nicht gesetzt ist. Ausdrücklich NICHT ``product.web`` — das ist der
    Spannrand für die Schachtelung, keine Teileigenschaft (derselbe
    Kategorienfehler, der im Portal 11-mm-Lochstege gegen 12 mm Spannrand
    meldete).
    """
    errors: list[str] = []

    if limits.max_od is not None and od > limits.max_od + 1e-7:
        errors.append(f"Außendurchmesser {od:.1f} mm übersteigt das Maximum von "
                      f"{limits.max_od:.1f} mm.")

    if limits.min_od is not None and od < limits.min_od - 1e-7:
        errors.append(f"Außendurchmesser {od:.1f} mm unterschreitet das Minimum von "
                      f"{limits.min_od:.1f} mm.")

    # Mindeststeg: der Abstand zwischen Innenloch und Außenkante
    web = limits.min_web if limits.min_web is not None else product_min_web
    if web is not None and di > 0:
        actual_web = (od - di) / 2
        if actual_web < web - 1e-7:
            errors.append(f"Steg {actual_web:.1f} mm (Ø {od:.1f} / Øi {di:.1f}) "
                          f"unterschreitet Mindestabstand {web:.1f} mm.")

    return errors


def validate_corner_distance(od: float, w: Optional[float] = None,
                             h: Optional[float] = None,
                             limits: Optional[DimensionLimits] = None) -> list[str]:
    """Eckabstand prüfen — für Rechteck- und Ovalteile.

    Der Mindesteckabstand ist der Abstand des Teils zur nächsten Plattenecke.
    Bei einem Kreis (od) ist der Abstand zur Ecke ``(√2/2 · Plattenformat − od/2)``,
    bei einem Rechteck ``(√2/2 · Plattenformat − √(w²+h²)/2)``.

    ``w``/``h`` sind die Außenmaße des Teils; fehlen sie, wird od als Kreis angenommen.
    """
    if not limits or limits.min_corner <= 0:
        return []
    if limits.max_plate_w is None or limits.max_plate_h is None:
        return []

    errors: list[str] = []
    pw, ph = limits.max_plate_w, limits.max_plate_h
    diag_half = math.sqrt(pw ** 2 + ph ** 2) / 2

    if w is not None and h is not None:
        part_diag_half = math.sqrt(w ** 2 + h ** 2) / 2
    else:
        part_diag_half = od / 2

    corner_dist = diag_half - part_diag_half
    if corner_dist < limits.min_corner - 1e-7:
        errors.append(f"Eckabstand {corner_dist:.1f} mm unterschreitet "
                      f"Mindestabstand {limits.min_corner:.1f} mm zur Plattenecke.")

    return errors


def check_plate_fit(od: float, limits: DimensionLimits,
                     w: Optional[float] = None,
                     h: Optional[float] = None) -> list[str]:
    """Prüft, ob ein Teil grundsätzlich auf die maxSize-Platte passt.

    Kreise prüfen über den Umkreis; Konturen über ihre Standfläche in
    beiden Drehungen — ein 1800×1000-Teil passt längs auf 2000×1500,
    sein Umkreis (2059 mm) dagegen nicht (verhaltensgleich zu
    engine.js checkPlateFit).
    """
    if limits.max_plate_w is None or limits.max_plate_h is None:
        return []

    errors: list[str] = []
    pw, ph = limits.max_plate_w, limits.max_plate_h
    if w is not None and h is not None and (w > 0 or h > 0):
        fits = ((w <= pw + 1e-7 and h <= ph + 1e-7)
                or (w <= ph + 1e-7 and h <= pw + 1e-7))
        if not fits:
            errors.append(f"Kontur {w:.1f} × {h:.1f} mm passt nicht auf die "
                          f"maximale Platte ({pw:.0f} × {ph:.0f} mm).")
        return errors

    max_dim = min(pw, ph)
    if od > max_dim + 1e-7:
        errors.append(f"Außendurchmesser {od:.1f} mm passt nicht auf die "
                      f"maximale Platte ({pw:.0f} × "
                      f"{ph:.0f} mm).")

    return errors


def validate_all(od: float, di: float, w: Optional[float] = None,
                 h: Optional[float] = None,
                 limits: Optional[DimensionLimits] = None,
                 product_min_web: Optional[float] = None) -> list[str]:
    """Alle Prüfungen zusammen — die zentrale Funktion für Quote und Portal."""
    if not limits:
        return []

    errors = validate_position(od, di, limits, product_min_web)
    errors.extend(validate_corner_distance(od, w, h, limits))
    errors.extend(check_plate_fit(od, limits, w, h))
    return errors

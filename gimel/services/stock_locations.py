"""Lagerorte — wo ein Werkstoff liegt, damit die Kommissionierung einen Weg hat.

``Product.stock`` ist die Summe; ``StockLocation`` verteilt sie auf Lagerstation
und Fach. Dieser Dienst liest die Verteilung für die Kommissionierung und
schreibt sie auf Zuruf. Er bucht keinen Bestand (das macht ``inventory.move_stock``)
und rät keinen Ort: ein Werkstoff ohne Zeile hat ausdrücklich „Ort unbekannt".
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import FactoryStation, StockLocation
from . import sites as site_svc


def _where(db: Session) -> dict[int, dict]:
    """Je Station: Name, Halle, Ebene — damit „Plattenregal" nicht in zwei
    Hallen dasselbe heißt."""
    topo = site_svc.topology(db)
    out: dict[int, dict] = {}
    for s in db.query(FactoryStation).all():
        fid = site_svc.station_floor_id(s, topo.default_floor_id)
        hall = topo.halls.get(topo.floor_hall.get(fid)) if fid is not None else None
        floor = topo.floors.get(fid) if fid is not None else None
        out[s.id] = {
            "station_label": s.label,
            "hall_name": hall.name if hall is not None else "",
            "floor_name": (floor.level_name or floor.name) if floor is not None else "",
            "is_storage": bool(s.is_storage),
            # Grundriss-Koordinaten für die Empfehlung (nächster Weg).
            # Es sind Planungseinheiten, keine Meter — nur zum Vergleichen.
            "x": float(s.x or 0.0),
            "y": float(s.y or 0.0),
        }
    return out


def row_out(r: StockLocation, where: dict[int, dict]) -> dict:
    w = where.get(r.station_id or -1, {})
    return {
        "id": r.id,
        "mat": r.product_id,
        "thk": float(r.thk or 0.0),
        "station_id": r.station_id,
        "station_label": w.get("station_label", ""),
        "hall_name": w.get("hall_name", ""),
        "floor_name": w.get("floor_name", ""),
        "bin": r.bin or "",
        "qty": int(r.qty or 0),
        "note": r.note or "",
        "x": w.get("x"),
        "y": w.get("y"),
        "updated_by": r.updated_by or "",
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def for_materials(db: Session, mats: set[str] | None = None) -> dict[str, list[dict]]:
    """Alle Lagerorte je Werkstoff, größte Menge zuerst. ``mats`` None = alle."""
    q = db.query(StockLocation)
    if mats is not None:
        if not mats:
            return {}
        q = q.filter(StockLocation.product_id.in_(sorted(mats)))
    where = _where(db)
    out: dict[str, list[dict]] = {}
    for r in q.order_by(StockLocation.qty.desc(), StockLocation.id.asc()).all():
        out.setdefault(r.product_id, []).append(row_out(r, where))
    return out


def for_thickness(rows: list[dict], thk: float) -> list[dict]:
    """Die Orte, aus denen genau diese Dicke geholt werden kann: eigene Dicke
    zuerst, dann Fächer mit gemischten Dicken (``thk`` 0)."""
    exact = [r for r in rows if r["thk"] and abs(r["thk"] - float(thk or 0.0)) < 0.005]
    mixed = [r for r in rows if not r["thk"]]
    return exact + mixed


def summarise(rows: list[dict], stock: int, thk: float) -> dict:
    """Orte für eine (Werkstoff, Dicke) plus die Ehrlichkeit dazu: wie viel
    der Bestand verortet ist. Verortet über alle Dicken zu summieren wäre
    falsch, deshalb zählt der Bestand hier nur, wenn die Zeile den Werkstoff
    ohne Dickenangabe führt."""
    here = for_thickness(rows, thk)
    return {
        "locations": here,
        "located": sum(r["qty"] for r in here),
        "unplaced": max(0, int(stock or 0) - sum(r["qty"] for r in rows)) if rows else int(stock or 0),
    }


def recommend(
    rows: list[dict],
    thk: float,
    needed: int,
    target: tuple[float, float] | None = None,
) -> dict | None:
    """Der Ort, aus dem zuerst gegriffen werden sollte — mit Begründung.

    Die Reihenfolge ist die des Werks, nicht einer Kennzahl: erst ein Fach mit
    genau dieser Dicke, dann eines, das für den ganzen Auftrag reicht, dann
    der kürzeste Weg zur Maschine, zuletzt die größte Menge. Reicht ein Fach
    nicht allein, sagt die Begründung das — statt eine zweite Fahrt zu
    verschweigen. Ohne hinterlegten Ort gibt es keine Empfehlung; dann bleibt
    die Wahl beim Menschen.
    """
    here = for_thickness(rows, thk)
    if not here:
        return None
    need = max(0, int(needed or 0))

    def exact(r: dict) -> bool:
        return bool(r["thk"]) and abs(r["thk"] - float(thk or 0.0)) < 0.005

    def distance(r: dict) -> float | None:
        if target is None or r.get("x") is None or r.get("y") is None:
            return None
        return ((float(r["x"]) - target[0]) ** 2 + (float(r["y"]) - target[1]) ** 2) ** 0.5

    def rank(r: dict) -> tuple:
        d = distance(r)
        return (
            1 if exact(r) else 0,
            1 if r["qty"] >= need else 0,
            -(d if d is not None else 0.0),
            int(r["qty"]),
            -int(r["id"]),
        )

    best = max(here, key=rank)
    reasons: list[str] = []
    if need and best["qty"] >= need:
        reasons.append(f"{best['qty']} Pl. — deckt alle {need}")
    elif need:
        reasons.append(f"{best['qty']} Pl. — reicht für {best['qty']} von {need}")
    else:
        reasons.append(f"{best['qty']} Pl.")
    if not exact(best):
        reasons.append("gemischtes Fach — Dicke prüfen")
    if distance(best) is not None:
        reasons.append("kürzester Weg zur Maschine")
    return {"location": best, "reason": " · ".join(reasons)}


def describe(db: Session, row: StockLocation) -> str:
    """Ein Lagerort als Satz für die Buchung: „Plattenregal · Fach B2"."""
    info = row_out(row, _where(db))
    place = info["station_label"] or "ohne Lager"
    return " · ".join(p for p in (place, info["bin"]) if p)

"""Fortlaufende Nummern — atomar, nicht aus ``COUNT(*) + 1``.

Zwei Schreiber, die gleichzeitig zählen, vergeben sonst dieselbe Nummer; nach
einem Löschen fällt die Zählung sogar zurück. Die Sequenzzeile wird per
``UPDATE`` erhöht. SQLite serialisiert den Schreibzugriff, Postgres sperrt die
Zeile — in beiden Fällen sieht der zweite Schreiber den neuen Wert.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..models import (
    GoodsReceipt,
    MaterialLot,
    NestRun,
    NumberSequence,
    Offcut,
    Order,
    PurchaseOrder,
    Shipment,
    WorkOrder,
)

_MODELS = {
    "order": (Order, Order.no),
    "work_order": (WorkOrder, WorkOrder.no),
    "nest_run": (NestRun, NestRun.no),
    "shipment": (Shipment, Shipment.no),
    "offcut": (Offcut, Offcut.code),
    "purchase_order": (PurchaseOrder, PurchaseOrder.no),
    "goods_receipt": (GoodsReceipt, GoodsReceipt.no),
    "material_lot": (MaterialLot, MaterialLot.code),
}


def _max_existing(db: Session, kind: str, prefix: str) -> int:
    model, column = _MODELS[kind]
    rows = db.query(column).filter(column.like(f"{prefix}%")).all()
    highest = 0
    for (no,) in rows:
        suffix = str(no)[len(prefix):].lstrip("-")
        if suffix.isdigit():
            highest = max(highest, int(suffix))
    return highest


def next_number(db: Session, kind: str, prefix: str, *, width: int = 4) -> str:
    """Nächste Nummer im Kreis ``kind`` mit ``prefix`` — im Transaktionskontext
    des Aufrufers, damit ein fehlgeschlagener Lauf keine Nummer verbraucht."""
    if kind not in _MODELS:
        raise ValueError(f"Unbekannter Nummernkreis: {kind}")
    key = f"{kind}:{prefix}"
    now = datetime.now(timezone.utc)
    if db.get(NumberSequence, key) is None:
        start = _max_existing(db, kind, prefix)
        # ``ON CONFLICT DO NOTHING`` ist hier die Sperre: zwei Prozesse, die
        # gleichzeitig die erste Nummer ziehen, legen die Zeile nur einmal an
        # und erhöhen sie danach beide — keine doppelte Nummer, kein Fehler.
        db.execute(
            text(
                "INSERT INTO number_sequences (key, value, updated_at) "
                "VALUES (:key, :start, :now) ON CONFLICT (key) DO NOTHING"
            ),
            {"key": key, "start": start, "now": now},
        )
    db.execute(
        text(
            "UPDATE number_sequences SET value = value + 1, updated_at = :now "
            "WHERE key = :key"
        ),
        {"now": now, "key": key},
    )
    value = db.execute(
        text("SELECT value FROM number_sequences WHERE key = :key"),
        {"key": key},
    ).scalar_one()
    separator = "" if prefix.endswith("-") else "-"
    return f"{prefix}{separator}{int(value):0{width}d}"

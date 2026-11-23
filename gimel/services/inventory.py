"""Lagerbewegungen für Plattenware — ein Prinzip, zwei Aufrufer.

Der Sammellauf zieht Platten automatisch (Reason ``sammellauf``, siehe
``batch_runner.run_batch``); das Support-Personal bucht Wareneingang und
Korrekturen von Hand (``routers/inventory.py``). Beide Wege laufen durch
``move_stock``, damit kein Bestand ohne Verlaufszeile verschwindet oder
entsteht — dasselbe Prinzip wie ``_apply_price`` für Preise.
"""

from __future__ import annotations

from sqlalchemy import func, update
from sqlalchemy.orm import Session

from ..models import Product, StockMovement


def move_stock(db: Session, product: Product, delta: int, *, reason: str,
               actor: str = "", note: str = "", work_order_no: str = "",
               thk: float | None = None, lot_id: int | None = None,
               purchase_order_no: str = "") -> StockMovement:
    """Bestand um ``delta`` verschieben (negativ = Verbrauch) und die Bewegung
    protokollieren. Schreibt direkt auf die übergebene, bereits an die Session
    gebundene ``Product``-Zeile — commit bleibt Sache des Aufrufers, damit ein
    Sammellauf mit mehreren Innenaufträgen eine Transaktion bleibt.

    Absichtlich ohne Untergrenze bei 0: ein Sammellauf zieht Platten, die laut
    Buchung nicht da sind, trotzdem — geschnitten wird schließlich wirklich.
    Ein negativer Bestand ist dann die ehrliche Meldung, dass die Zählung
    nicht mehr stimmt, statt ein still geglätteter Fehler."""
    # Atomar statt lesen-addieren-schreiben: zwei Buchungen auf derselben
    # Werkstoffzeile (Sammellauf und Handkorrektur) dürfen einander nicht
    # überschreiben. ``UPDATE`` rechnet in der Datenbank, danach wird der neue
    # Stand gelesen — nicht der alte aus dem Objekt.
    db.execute(
        update(Product)
        .where(Product.id == product.id)
        .values(stock=func.coalesce(Product.stock, 0) + delta)
    )
    db.refresh(product)
    movement = StockMovement(
        product_id=product.id, delta=delta, balance_after=int(product.stock),
        reason=reason, note=note[:400], work_order_no=work_order_no,
        thk=thk, lot_id=lot_id, purchase_order_no=purchase_order_no[:30],
        actor=actor,
    )
    db.add(movement)
    return movement

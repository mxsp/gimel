"""Änderungsregister und Rücknahme.

Jede schreibende Werkzeugausführung legt eine Zeile mit Vorher/Nachher an.
Die Rücknahme schreibt den alten Stand nur dann zurück, wenn der aktuelle
Stand noch dem Nachher entspricht (Vergleich-und-Setzen). Sie löscht keine
Geschichte: Protokoll und Preisverlauf bekommen eine neue Zeile.
"""

from __future__ import annotations

import enum
from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from gimel.models import (
    Address,
    AuditLog,
    Drawing,
    FactoryFloor,
    FactoryHall,
    FactorySite,
    FactoryStation,
    TwinView,
    Order,
    PriceHistory,
    Product,
    SecurityAdvisory,
    Setting,
    Shipment,
    ShipmentItem,
    ShipmentStatus,
    StationTask,
    SupportPeriod,
    User,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
    WorkPlate,
)
from gimel.services import settings_store
from gimel.services.inventory import move_stock

from .models import AgentChange, AgentChat


class RevertConflict(Exception):
    """Der Zustand hat sich seit der Änderung bewegt; nicht überschreiben."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _jsonable(value):
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, enum.Enum):
        return value.value
    return value


def _decode(current, value):
    if isinstance(current, datetime) and isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if isinstance(current, date) and not isinstance(current, datetime) and isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return value
    if isinstance(current, enum.Enum) and isinstance(value, str):
        try:
            return type(current)(value)
        except ValueError:
            return value
    return value


def record(
    db: Session,
    *,
    chat: AgentChat | None,
    message_id: int | None,
    user: User,
    tool: str,
    action: str,
    entity: str,
    entity_id: str,
    before,
    after,
    summary: str,
    reversible: bool = True,
) -> AgentChange:
    change = AgentChange(
        chat_id=chat.id if chat else None,
        message_id=message_id,
        user_id=user.id,
        tool=tool,
        action=action,
        entity=entity,
        entity_id=str(entity_id)[:120],
        before=_jsonable(before),
        after=_jsonable(after),
        reversible=reversible,
        summary=summary[:500],
    )
    db.add(change)
    db.add(
        AuditLog(
            actor=user.email,
            action="agent_change",
            entity=entity,
            entity_id=str(entity_id)[:80],
            detail={
                "tool": tool,
                "action": action,
                "summary": summary[:300],
                "reversible": reversible,
                "chat_id": chat.id if chat else None,
            },
        )
    )
    db.flush()
    return change


def _same(current, expected) -> bool:
    expected = _decode(current, expected)
    if isinstance(current, datetime) and isinstance(expected, datetime):
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        if expected.tzinfo is None:
            expected = expected.replace(tzinfo=timezone.utc)
        return current == expected
    if hasattr(current, "value"):
        current = current.value
    if hasattr(expected, "value"):
        expected = expected.value
    return current == expected


def _check_fields(obj, after: dict) -> None:
    for key, value in after.items():
        if key.startswith("_"):
            continue
        if not hasattr(obj, key):
            raise RevertConflict(f"Feld {key} gibt es nicht mehr.")
        if not _same(getattr(obj, key), value):
            raise RevertConflict(
                f"{key} wurde inzwischen geändert — Rücknahme wäre nicht mehr sicher."
            )


def _restore_fields(obj, before: dict) -> None:
    for key, value in before.items():
        if key.startswith("_"):
            continue
        setattr(obj, key, _decode(getattr(obj, key, None), value))


def _revert_stock(db: Session, change: AgentChange, user: User) -> None:
    product = db.get(Product, change.entity_id)
    if not product:
        raise RevertConflict("Werkstoff nicht mehr vorhanden.")
    if int(product.stock) != int((change.after or {}).get("stock", -1)):
        raise RevertConflict("Der Bestand wurde inzwischen erneut geändert.")
    before = int((change.before or {}).get("stock", 0))
    delta = before - int(product.stock)
    if delta:
        move_stock(
            db, product, delta, reason="agent_revert", actor=user.email,
            note=f"Rücknahme von {change.tool}",
        )


def _revert_order(db: Session, change: AgentChange, user: User) -> None:
    order = db.query(Order).filter(Order.no == change.entity_id).first()
    if not order:
        raise RevertConflict("Auftrag nicht mehr vorhanden.")
    after = change.after or {}
    if after.get("_created"):
        if order.invoice_no:
            raise RevertConflict("Der Auftrag hat bereits eine Rechnung.")
        if db.query(WorkItem).filter(
            WorkItem.position_id.in_([p.id for p in order.positions])
        ).count():
            raise RevertConflict("Der Auftrag ist bereits in der Fertigung.")
        if db.query(ShipmentItem).filter(ShipmentItem.order_id == order.id).count():
            raise RevertConflict("Der Auftrag ist bereits im Versand.")
        db.delete(order)
        return
    before = change.before or {}
    _check_fields(order, after)
    # Eine geänderte Position hängt an derselben Änderung: die Nummer bleibt,
    # Menge und Kosten werden mit zurückgenommen.
    spec_after = after.get("_position") or {}
    spec_before = before.get("_position") or {}
    if spec_after:
        from gimel.models import OrderPosition

        position = db.get(OrderPosition, int(spec_after.get("id") or 0))
        if position is None:
            raise RevertConflict("Die Position gibt es nicht mehr.")
        _check_fields(position, spec_after.get("after") or {})
    _restore_fields(order, before)
    if spec_after:
        _restore_fields(position, spec_before.get("before") or {})


def _revert_customer(db: Session, change: AgentChange, user: User) -> None:
    row = db.get(User, int(change.entity_id))
    if not row:
        raise RevertConflict("Kunde nicht mehr vorhanden.")
    after = change.after or {}
    if after.get("_created"):
        if db.query(Order).filter(Order.user_id == row.id).count():
            raise RevertConflict("Der Kunde hat bereits Aufträge — bitte deaktivieren statt löschen.")
        for addr in list(row.addresses):
            db.delete(addr)
        db.delete(row)
        return
    _check_fields(row, after)
    _restore_fields(row, change.before or {})


def _revert_product(db: Session, change: AgentChange, user: User) -> None:
    row = db.get(Product, change.entity_id)
    if not row:
        raise RevertConflict("Werkstoff nicht mehr vorhanden.")
    after = change.after or {}
    before = change.before or {}
    if after.get("_created"):
        row.active = False
        return
    _check_fields(row, after)
    if "eur_m2" in before and float(row.eur_m2) == float(after["eur_m2"]):
        db.add(
            PriceHistory(
                product_id=row.id, thk=None,
                old_eur_m2=float(row.eur_m2), new_eur_m2=float(before["eur_m2"]),
                reason="Rücknahme durch Assistent", changed_by=user.email,
            )
        )
    _restore_fields(row, before)


def _revert_work_order(db: Session, change: AgentChange, user: User) -> None:
    wo = db.query(WorkOrder).filter(WorkOrder.no == change.entity_id).first()
    if not wo:
        raise RevertConflict("Innenauftrag nicht mehr vorhanden.")
    before = change.before or {}
    after = change.after or {}
    _check_fields(wo, {k: v for k, v in after.items()
                       if k not in ("plates", "positions")})
    for plate_after in after.get("plates", []):
        plate = db.get(WorkPlate, plate_after["id"])
        if plate is None or plate.status.value != plate_after["status"]:
            raise RevertConflict("Eine Platte wurde inzwischen geändert.")
    if after.get("positions"):
        from gimel.models import OrderPosition

        for pos_after in after["positions"]:
            pos = db.get(OrderPosition, pos_after["id"])
            if pos is None or pos.production_status != pos_after["status"]:
                raise RevertConflict("Eine Bestellposition wurde inzwischen geändert.")
    _restore_fields(wo, {k: v for k, v in before.items()
                         if k in ("status", "machine", "note", "started_at",
                                  "started_by", "done_at", "done_by", "order_done")})
    plate_before = {p["id"]: p["status"] for p in before.get("plates", [])}
    for plate in db.query(WorkPlate).filter(WorkPlate.work_order_id == wo.id).all():
        if plate.id in plate_before:
            plate.status = WorkOrderStatus(plate_before[plate.id])
    if "positions" in before:
        from gimel.models import OrderPosition

        for pos in before["positions"]:
            row = db.get(OrderPosition, pos["id"])
            if row:
                row.production_status = pos["status"]


def _revert_shipment(db: Session, change: AgentChange, user: User) -> None:
    row = db.query(Shipment).filter(Shipment.no == change.entity_id).first()
    if not row:
        raise RevertConflict("Versand nicht mehr vorhanden.")
    after = change.after or {}
    if after.get("_created"):
        if row.status != ShipmentStatus.packing:
            raise RevertConflict("Der Versand ist nicht mehr offen.")
        db.delete(row)
        return
    _check_fields(row, after)
    _restore_fields(row, change.before or {})


def _revert_setting(db: Session, change: AgentChange, user: User) -> None:
    row = db.get(Setting, change.entity_id)
    before = (change.before or {}).get("value", "")
    after = (change.after or {}).get("value", "")
    if row is None:
        if after != "":
            raise RevertConflict("Parameter fehlt.")
        settings_store.set_value(db, change.entity_id, before, user.email)
        return
    if row.value != after:
        raise RevertConflict("Der Parameter wurde inzwischen geändert.")
    row.value = before
    row.updated_by = user.email


def _revert_generic(db: Session, change: AgentChange, model, user: User) -> None:
    raw_after = change.after or {}
    pk = raw_after.get("_pk") or change.entity_id
    row = db.get(model, pk)
    if not row:
        raise RevertConflict("Datensatz nicht mehr vorhanden.")
    if raw_after.get("_created"):
        if model is FactoryHall:
            for floor in db.query(FactoryFloor).filter(FactoryFloor.hall_id == row.id).all():
                if db.query(FactoryStation).filter(FactoryStation.floor_id == floor.id).count() == 0:
                    db.delete(floor)
        db.delete(row)
        return
    after = {k: v for k, v in raw_after.items() if not k.startswith("_")}
    _check_fields(row, after)
    _restore_fields(row, {
        k: v for k, v in (change.before or {}).items() if not k.startswith("_")
    })


def _revert_worklist(db: Session, change: AgentChange, user: User) -> None:
    station_id = int(change.entity_id)
    rows = db.query(StationTask).filter(StationTask.station_id == station_id).all()
    current = {row.id: (row.seq, bool(row.seq_pinned)) for row in rows}
    for expected in change.after or []:
        if current.get(expected["id"]) != (expected["seq"], bool(expected["seq_pinned"])):
            raise RevertConflict("Die Arbeitsreihenfolge wurde inzwischen geändert.")
    before = {row["id"]: row for row in (change.before or [])}
    for row in rows:
        old = before.get(row.id)
        if old is not None:
            row.seq = old["seq"]
            row.seq_pinned = bool(old["seq_pinned"])


def revert(db: Session, change: AgentChange, user: User) -> AgentChange:
    if change.status != "applied":
        raise RevertConflict("Diese Änderung ist bereits zurückgenommen.")
    if not change.reversible:
        raise RevertConflict("Diese Änderung lässt sich nicht zurücknehmen.")
    entity = change.entity
    if entity == "stock":
        _revert_stock(db, change, user)
    elif entity == "order":
        _revert_order(db, change, user)
    elif entity == "customer":
        _revert_customer(db, change, user)
    elif entity == "product":
        _revert_product(db, change, user)
    elif entity == "work_order":
        _revert_work_order(db, change, user)
    elif entity == "shipment":
        _revert_shipment(db, change, user)
    elif entity == "setting":
        _revert_setting(db, change, user)
    elif entity == "worklist":
        _revert_worklist(db, change, user)
    else:
        from gimel.models import (
            BatchPolicy,
            MaterialLot,
            PurchaseOrder,
            Rate,
            ScrapEvent,
            StationDowntime,
            Supplier,
            SupplierMaterial,
            SupplyAlert,
        )

        model = {
            "station": FactoryStation,
            "rate": Rate,
            "batch_policy": BatchPolicy,
            "address": Address,
            "site": FactorySite,
            "hall": FactoryHall,
            "floor": FactoryFloor,
            "station_task": StationTask,
            "twin_view": TwinView,
            "drawing": Drawing,
            "advisory": SecurityAdvisory,
            "support_period": SupportPeriod,
            "supplier": Supplier,
            "supplier_material": SupplierMaterial,
            "purchase_order": PurchaseOrder,
            "material_lot": MaterialLot,
            "scrap_event": ScrapEvent,
            "station_downtime": StationDowntime,
            "supply_alert": SupplyAlert,
        }.get(entity)
        if model is None:
            raise RevertConflict(f"Für {entity} gibt es keine Rücknahme.")
        _revert_generic(db, change, model, user)

    change.status = "reverted"
    change.reverted_at = _now()
    change.reverted_by = user.email
    db.add(
        AuditLog(
            actor=user.email,
            action="agent_revert",
            entity=change.entity,
            entity_id=change.entity_id[:80],
            detail={"change_id": change.id, "tool": change.tool,
                    "summary": change.summary[:200]},
        )
    )
    return change

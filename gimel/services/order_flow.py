"""Freigabe und Zahlung eines Auftrags — eine Stelle für beide Wahrheiten.

``released`` entscheidet, ob der Sammellauf einen Auftrag einsammelt;
``paid`` sagt, ob das Geld da ist. Beide werden an mehreren Stellen geschrieben
(Stripe, manuelle Rechnung, Auftragsbüro, Support). Lagen sie auseinander,
konnte ein bezahlter Auftrag ewig auf die Freigabe warten oder ein unbezahlter
schon geschnitten werden. Diese Datei hält die Reihenfolge und das Protokoll an
einer Stelle; die Routen rufen sie nur noch auf.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, update
from sqlalchemy.orm import Session

from ..models import AuditLog, Order, OrderPosition, ShipmentItem, WorkItem


class FlowError(Exception):
    """Eine Büro-Aktion, die der Stand des Auftrags nicht zulässt.

    ``status`` ist der HTTP-Status, den die Route daraus macht: 409 für „so
    nicht, weil …", 422 für eine unbrauchbare Eingabe.
    """

    def __init__(self, detail: str, status: int = 409):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def _audit(db: Session, order: Order, *, actor: str, action: str,
           detail: Optional[dict] = None) -> None:
    db.add(
        AuditLog(
            actor=actor or "system",
            action=action,
            entity="order",
            entity_id=order.no,
            detail=detail or {},
        )
    )


def set_released(
    db: Session,
    order: Order,
    released: bool,
    *,
    actor: str,
    note: str = "",
    action: str = "order_release",
    detail: Optional[dict] = None,
) -> None:
    """Freigabe setzen oder zurückziehen — ohne den Zahlungsstand anzufassen.

    Ein stornierter Auftrag wird nie freigegeben; das Zurückziehen bleibt
    erlaubt. Die Route bekommt dafür ``FlowError`` (409).
    """
    if released and order.cancelled_at is not None:
        raise FlowError("Der Auftrag ist storniert und kann nicht freigegeben werden.")
    order.released = bool(released)
    order.release_note = (note or "")[:200]
    _audit(
        db,
        order,
        actor=actor,
        action=action,
        detail={"released": order.released, "note": order.release_note,
                **(detail or {})},
    )


def mark_paid(
    db: Session,
    order: Order,
    *,
    actor: str,
    note: str = "",
    paid_at: Optional[datetime] = None,
    method: str = "manual",
    ref: str = "",
    action: str = "order_paid",
    release: bool = True,
    release_note: str = "Freigegeben: Zahlungseingang",
    detail: Optional[dict] = None,
) -> bool:
    """Zahlungseingang buchen und — wenn erlaubt — die Fertigung freigeben.

    Gibt ``False`` zurück, wenn der Auftrag schon bezahlt war; die Route kann
    daraus ihr ``already_paid`` bauen. Ein gesperrter Auftrag (Übergröße) wird
    nie allein durch Geld freigegeben.
    """
    if order.paid:
        return False
    order.paid = True
    order.paid_at = paid_at or datetime.now(timezone.utc)
    order.payment_method = (method or "manual")[:20]
    if ref:
        order.payment_ref = ref[:120]
    # Geld gibt einen stornierten Auftrag nicht wieder frei: die Zahlung wird
    # gebucht (sie ist da und muss zurück), geschnitten wird nicht.
    if release and not order.blocked and order.cancelled_at is None:
        order.released = True
        order.release_note = release_note[:200]
    _audit(
        db,
        order,
        actor=actor,
        action=action,
        detail={"method": order.payment_method, "ref": order.payment_ref,
                "note": (note or "")[:200], **(detail or {})},
    )
    return True


def unmark_paid(
    db: Session,
    order: Order,
    *,
    actor: str,
    note: str = "",
    action: str = "order_unmark_paid",
    detail: Optional[dict] = None,
) -> bool:
    """Zahlung zurücknehmen; eine reine Zahlungsfreigabe fällt mit zurück.

    Eine Freigabe aus anderem Grund (Offenrechnung, Handfreigabe) bleibt
    bestehen — der Auftrag ist dann weiter in der Fertigung, nur eben wieder
    unbezahlt. Nur die Notiz, die diese Datei selbst für den Zahlungseingang
    gesetzt hat, wird zurückgenommen.
    """
    if not order.paid:
        return False
    order.paid = False
    order.paid_at = None
    if order.released and (order.release_note or "").startswith("Freigegeben"):
        order.released = False
        order.release_note = "Freigabe zurückgezogen: Zahlung storniert"
    _audit(
        db,
        order,
        actor=actor,
        action=action,
        detail={"note": (note or "")[:200], "released": order.released,
                **(detail or {})},
    )
    return True


# ---- Anhalten, Fortsetzen, Stornieren, Ändern (Aufgabe 45) -----------------
#
# Alle vier laufen hier durch, damit Reihenfolge, Prüfungen und Protokoll an
# einer Stelle stehen. Jede Aktion erhöht ``rev``; wer ``rev`` mitschickt und
# einen älteren Stand hat, bekommt 409 statt eine fremde Änderung zu
# überschreiben. Keine dieser Aktionen verschickt eine Mail.

def _now() -> datetime:
    return datetime.now(timezone.utc)


def check_rev(order: Order, rev: Optional[int]) -> None:
    if rev is not None and int(rev) != int(order.rev or 0):
        raise FlowError(
            "Der Auftrag wurde inzwischen geändert. Bitte neu laden und erneut versuchen."
        )


def _claim(db: Session, order: Order, rev: Optional[int]) -> None:
    """``rev`` in der Datenbank erhöhen — aber nur, wenn es noch der gelesene Stand ist.

    Das ist der erste Schreibzugriff jeder Aktion und der eigentliche Schutz:
    der Vergleich in ``check_rev`` läuft auf einer geladenen Zeile, zwei
    gleichzeitige Anfragen kämen dort beide durch. Hier gewinnt genau eine
    (wie ``plate_edit.save_layout`` mit ``layout_rev``); die andere bekommt 409
    und schreibt nichts. Ohne mitgeschicktes ``rev`` zählt der Stand, den diese
    Anfrage selbst gelesen hat.
    """
    expected = int(order.rev or 0) if rev is None else int(rev)
    hit = db.execute(
        update(Order)
        .where(Order.id == order.id, func.coalesce(Order.rev, 0) == expected)
        .values(rev=expected + 1)
        .execution_options(synchronize_session=False)
    )
    if hit.rowcount != 1:
        raise FlowError(
            "Der Auftrag wurde inzwischen geändert. Bitte neu laden und erneut versuchen."
        )
    # Die ganze Zeile neu lesen, nicht nur ``rev``: geladen wurde sie vor der
    # Sperre, und ``paid``, ``invoice_no`` oder ``held_at`` können sich seither
    # geändert haben. Jede Prüfung nach dem Beanspruchen sieht so den Stand,
    # gegen den sie schreibt.
    db.refresh(order)


def _reason(text: str, what: str) -> str:
    reason = (text or "").strip()
    if len(reason) < 3:
        raise FlowError(f"{what} braucht einen Grund (mindestens drei Zeichen).", 422)
    return reason[:200]


def is_open(order: Order) -> bool:
    """Weder storniert noch angehalten — der Auftrag darf weiterlaufen."""
    return order.cancelled_at is None and order.held_at is None


def hold(db: Session, order: Order, *, actor: str, reason: str,
         rev: Optional[int] = None) -> None:
    """Auftrag anhalten: der Sammellauf lässt ihn liegen, bis er fortgesetzt wird.

    Freigabe und Zahlung bleiben, wie sie sind — beim Fortsetzen ist der
    Auftrag genau dort, wo er war. Was schon auf einer Platte liegt, bleibt
    dort: Anhalten plant nichts um.
    """
    check_rev(order, rev)
    if order.cancelled_at is not None:
        raise FlowError("Der Auftrag ist storniert.")
    if order.held_at is not None:
        raise FlowError("Der Auftrag ist bereits angehalten.")
    why = _reason(reason, "Anhalten")
    _claim(db, order, rev)
    if order.cancelled_at is not None or order.held_at is not None:
        raise FlowError("Der Auftrag wurde inzwischen storniert oder angehalten.")
    order.hold_reason = why
    order.held_at = _now()
    _audit(db, order, actor=actor, action="order_hold",
           detail={"reason": order.hold_reason, "rev": order.rev})


def resume(db: Session, order: Order, *, actor: str, note: str = "",
           rev: Optional[int] = None) -> None:
    check_rev(order, rev)
    if order.cancelled_at is not None:
        raise FlowError("Der Auftrag ist storniert.")
    if order.held_at is None:
        raise FlowError("Der Auftrag ist nicht angehalten.")
    was = order.hold_reason
    _claim(db, order, rev)
    if order.cancelled_at is not None or order.held_at is None:
        raise FlowError("Der Auftrag wurde inzwischen storniert oder fortgesetzt.")
    order.held_at = None
    order.hold_reason = ""
    _audit(db, order, actor=actor, action="order_resume",
           detail={"was": was, "note": (note or "")[:200], "rev": order.rev})


def cancel_blockers(db: Session, order: Order) -> list[str]:
    """Warum der Auftrag nicht storniert werden kann — leer heißt: er kann.

    Storniert wird nur, solange nichts geplant, gefertigt, versendet, berechnet
    oder bezahlt ist. Jeder dieser Stände hat seinen eigenen Rückweg
    (Zurückrollen, Storno der Rechnung, Zahlung zurücknehmen); ihn hier still
    mitzunehmen hieße, Platten, Belege oder Geld ohne Spur zu verändern.
    """
    why: list[str] = []
    if order.cancelled_at is not None:
        return ["Der Auftrag ist bereits storniert."]
    positions = (
        db.query(OrderPosition.id, OrderPosition.kind, OrderPosition.production_status)
        .filter(OrderPosition.order_id == order.id)
        .all()
    )
    pos_ids = [p.id for p in positions]
    n_batched = sum(1 for p in positions if p.production_status == "batched")
    # Plattenware (``sheet``) steht ab Bestellung auf ``done`` — sie wird nicht
    # gefertigt und hält keine Stornierung auf.
    n_done = sum(1 for p in positions
                 if p.production_status == "done" and p.kind != "sheet")
    in_work = 0
    if pos_ids:
        in_work = (
            db.query(WorkItem.id).filter(WorkItem.position_id.in_(pos_ids)).count()
        )
    if n_batched or in_work:
        why.append(
            "Positionen sind bereits eingeplant — die Planung zuerst zurückrollen."
        )
    if n_done:
        why.append("Positionen sind bereits gefertigt.")
    if db.query(ShipmentItem.id).filter(ShipmentItem.order_id == order.id).first():
        why.append("Zum Auftrag gibt es bereits eine Sendung.")
    if order.invoice_no:
        why.append(
            f"Rechnung {order.invoice_no} ist offen — zuerst die Rechnung stornieren."
        )
    if order.paid:
        why.append(
            "Der Auftrag ist bezahlt — zuerst die Zahlung zurücknehmen oder erstatten."
        )
    return why


def cancel(db: Session, order: Order, *, actor: str, reason: str,
           rev: Optional[int] = None) -> None:
    """Auftrag stornieren. Nichts wird gelöscht; der Auftrag bleibt lesbar."""
    check_rev(order, rev)
    reason = _reason(reason, "Stornieren")
    # Erst die Zeile beanspruchen und neu lesen, dann prüfen: so prüft die
    # Absage gegen den Stand unter der Schreibsperre (eine Zahlung, die eben
    # eingegangen ist, verhindert das Storno). Ein Sammellauf, der seine
    # Kandidaten schon vorher gelesen hat, kann trotzdem noch einplanen — das
    # fängt die Prüfung auf ``batched`` nicht ab. Eine Absage rollt zurück.
    if order.cancelled_at is None:
        _claim(db, order, rev)
    why = cancel_blockers(db, order)
    if why:
        raise FlowError("Stornieren nicht möglich: " + " ".join(why))
    order.cancel_reason = reason
    order.cancelled_at = _now()
    was_released = bool(order.released)
    order.released = False
    order.release_note = "Storniert"
    order.held_at = None
    order.hold_reason = ""
    _audit(db, order, actor=actor, action="order_cancel",
           detail={"reason": order.cancel_reason, "was_released": was_released,
                   "net": order.net, "gross": order.gross, "rev": order.rev})


#: Was das Büro nach dem Anlegen noch ändern darf. Mengen, Maße und Preise
#: gehören nicht dazu: sie stehen mit der Bestellung fest und ändern sich nur
#: über einen neuen Auftrag.
CHANGEABLE = ("due_date", "rush", "customer_ref", "office_note")


def change(db: Session, order: Order, changes: dict, *, actor: str,
           rev: Optional[int] = None) -> dict:
    """Liefertermin, Eilkennzeichen, Kundenreferenz und Büronotiz ändern.

    Gibt zurück, was sich wirklich geändert hat (alt → neu). Ohne Unterschied
    passiert nichts: kein ``rev``, keine Protokollzeile. Die Büronotiz steht
    nie im Protokoll, nur dass sie geändert wurde.
    """
    check_rev(order, rev)
    if order.cancelled_at is not None:
        raise FlowError("Ein stornierter Auftrag wird nicht mehr geändert.")
    diff: dict = {}
    todo: dict = {}
    for key in CHANGEABLE:
        if key not in changes:
            continue
        new = changes[key]
        # Nur der Termin darf leer werden; ein leeres Eilkennzeichen heißt
        # „nicht angegeben", nicht „aus".
        if new is None and key != "due_date":
            continue
        old = getattr(order, key)
        if key == "customer_ref":
            new = (new or "").strip()[:80]
        elif key == "office_note":
            new = (new or "").strip()[:2000]
        elif key == "rush":
            new = bool(new)
        elif key == "due_date" and new is not None and new.tzinfo is None:
            new = new.replace(tzinfo=timezone.utc)
        same = (old or "") == new if key in ("customer_ref", "office_note") else old == new
        if key == "due_date" and old is not None and new is not None:
            o = old if old.tzinfo else old.replace(tzinfo=timezone.utc)
            same = o == new
        if same:
            continue
        todo[key] = new
        if key == "office_note":
            diff[key] = {"changed": True}
        elif key == "due_date":
            diff[key] = {"old": old.isoformat() if old else None,
                         "new": new.isoformat() if new else None}
        else:
            diff[key] = {"old": old, "new": new}
    if diff:
        _claim(db, order, rev)
        for key, new in todo.items():
            setattr(order, key, new)
        _audit(db, order, actor=actor, action="order_change",
               detail={**diff, "rev": order.rev})
    return diff

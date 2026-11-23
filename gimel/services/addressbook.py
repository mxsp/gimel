"""Arbitration over the customer address book.

Exactly one billing and one standard delivery address per customer — two of
either are not a statement but a mistake that surfaces at the checkout, and
none is just as bad. One address may hold both roles at once (the common
"invoice = delivery" case). Both the staff customer router and the customer's
own account router write through here, so the invariant lives in one place.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Address


def ensure_flags(db: Session, user_id: int) -> None:
    """Exactly one ``is_billing`` and one ``is_delivery`` row per customer.

    Keeps the first flagged row, clears later duplicates; if nothing is
    flagged, the first non-billing address becomes the delivery standard
    (otherwise the first address) and the first address becomes billing.
    """
    rows = (
        db.query(Address)
        .filter(Address.user_id == user_id)
        .order_by(Address.id)
        .all()
    )
    if not rows:
        return

    billing = [a for a in rows if a.is_billing]
    for extra in billing[1:]:
        extra.is_billing = False
    if not billing:
        rows[0].is_billing = True

    delivery = [a for a in rows if a.is_delivery]
    for extra in delivery[1:]:
        extra.is_delivery = False
    if not delivery:
        target = next((a for a in rows if not a.is_billing), rows[0])
        target.is_delivery = True


def clear_flag_on_others(db: Session, user_id: int, keep_id: int, flag: str) -> None:
    """Drop ``flag`` (``is_billing``/``is_delivery``) from every other row."""
    for other in db.query(Address).filter(Address.user_id == user_id):
        if other.id != keep_id and getattr(other, flag):
            setattr(other, flag, False)

"""Aufträge anlegen — die Stelle, an der aus einem Warenkorb Fertigung wird."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import String, cast, exists, func, or_
from sqlalchemy.orm import Session

from ..core.nesting import ENGINE_VERSION
from ..db import chunked_in
from ..extensions import price_cart
from ..core.types import CustomLine, Position, SheetLine
from ..models import (
    AuditLog,
    InvoiceDocument,
    LibraryShape,
    Order,
    OrderPosition,
    Shipment,
    ShipmentItem,
    StructuredInvoiceDocument,
    User,
    WorkItem,
    WorkOrder,
)
from . import mailer, settings_store
from .catalog import load_products, load_rates


def _encrypted_hit(needle: str, ship: dict | None, bill: dict | None, manual: dict | None) -> bool:
    values = [(a or {}).get(k) for a in (ship, bill) for k in ("company", "contact", "name")]
    values.append((manual or {}).get("tracking"))
    return any(needle in str(v).casefold() for v in values if v)


def search_filter(db: Session, text: str, office: bool = True):
    """Bedingung für die Auftragssuche: Nummer, Bestellzeichen, Kunde, E-Mail, Innenauftrag,
    Rechnung, Sendung. ``exists`` statt Join: ein Auftrag auf drei Platten bleibt eine Zeile.

    ``office=False`` ist die Halle: nur Auftrag, Innenauftrag und Sendung. Über die Suche
    darf niemand erfragen, was die Liste ihm nicht zeigt (Rolle ``worker``, models.py).

    Adressen und der manuelle Versand liegen verschlüsselt in der Datenbank
    (fieldcrypt), SQL sieht dort nur Chiffrat. Die Liste zeigt aber gerade den
    Firmennamen aus der Adresse, und ein Gastauftrag hat kein Benutzerkonto:
    diese Felder werden deshalb entschlüsselt in Python verglichen.
    """
    needle = text.strip()

    def like(column):
        return column.icontains(needle, autoescape=True)

    in_sql = or_(
        like(Order.no),
        exists().where(
            WorkItem.work_order_id == WorkOrder.id,
            WorkItem.position_id == OrderPosition.id,
            OrderPosition.order_id == Order.id,
            like(WorkOrder.no),
        ),
        exists().where(
            ShipmentItem.order_id == Order.id,
            ShipmentItem.shipment_id == Shipment.id,
            like(Shipment.tracking),
        ),
    )
    if office:
        in_sql = or_(
            in_sql,
            like(Order.customer_ref),
            like(Order.contact_email),
            like(Order.internal_owner),
            like(Order.invoice_no),
            like(Order.invoice_reference),
            Order.user.has(or_(like(User.company), like(User.name), like(User.email))),
            exists().where(InvoiceDocument.order_no == Order.no, like(InvoiceDocument.number)),
            exists().where(
                StructuredInvoiceDocument.order_no == Order.no,
                like(StructuredInvoiceDocument.number),
            ),
        )
    folded = needle.casefold()
    is_sqlite = db.bind is not None and db.bind.dialect.name == "sqlite"
    use_sql_json = is_sqlite and needle.isascii()

    def _is_encrypted_col(col):
        raw = cast(col, String)
        return or_(raw.like('"fe1:%'), raw.like("fe1:%"))

    if use_sql_json:
        # Unverschlüsselte JSON-Felder direkt in SQL prüfen — vermeidet Vollscan bei Millionen Aufträgen.
        json_hits = [
            func.coalesce(func.json_extract(Order.manual_shipment, "$.tracking"), "").icontains(
                needle, autoescape=True
            )
        ]
        if office:
            for col in (Order.ship_address, Order.bill_address):
                for key in ("company", "contact", "name"):
                    json_hits.append(
                        func.coalesce(func.json_extract(col, f"$.{key}"), "").icontains(
                            needle, autoescape=True
                        )
                    )
        in_sql = or_(in_sql, *json_hits)

    # Nur Zeilen in Python entschlüsseln, die wirklich verschlüsselt sind (oder bei Nicht-ASCII / Nicht-SQLite).
    py_cols = [Order.id, Order.manual_shipment]
    if office:
        py_cols.extend([Order.ship_address, Order.bill_address])
    py_q = db.query(*py_cols)
    if use_sql_json:
        enc_cond = _is_encrypted_col(Order.manual_shipment)
        if office:
            enc_cond = or_(
                enc_cond,
                _is_encrypted_col(Order.ship_address),
                _is_encrypted_col(Order.bill_address),
            )
        py_q = py_q.filter(enc_cond)
    else:
        non_empty = Order.manual_shipment.isnot(None)
        if office:
            non_empty = or_(
                non_empty,
                Order.ship_address.isnot(None),
                Order.bill_address.isnot(None),
            )
        py_q = py_q.filter(non_empty)

    in_python: list[int] = []
    for row in py_q.yield_per(1000):
        ship = row.ship_address if office else None
        bill = row.bill_address if office else None
        if _encrypted_hit(folded, ship, bill, row.manual_shipment):
            in_python.append(row.id)
    return or_(in_sql, chunked_in(Order.id, in_python)) if in_python else in_sql


def lines_to_domain(lines) -> list:
    out = []
    for l in lines:
        if l.kind == "sheet":
            fmt = tuple(l.fmt or (0, 0))
            out.append(SheetLine(id=l.id, mat=l.mat, fmt=fmt, q=l.q, thk=l.thk))
        elif l.kind == "custom":
            out.append(
                CustomLine(
                    id=l.id,
                    label=l.label,
                    desc=getattr(l, "desc", ""),
                    external_note=getattr(l, "external_note", "") or "",
                    q=l.q,
                    price_gross=float(getattr(l, "price_gross", 0.0) or 0.0),
                    mat=l.mat,
                    thk=l.thk,
                )
            )
        else:
            out.append(
                Position(
                    id=l.id,
                    od=l.od,
                    di=l.di,
                    q=l.q,
                    mat=l.mat,
                    thk=l.thk,
                    t=l.label,
                    bn=l.bn,
                    bd=l.bd,
                    bc=l.bc,
                    cut_len=l.cut_len,
                    # Die Kontur MUSS mit. Ohne sie rechnet der Kern die
                    # Position als volle Scheibe ihres Umkreises: eine
                    # unsymmetrische Dichtung 279 × 216 mm wurde als Ø 353 mm
                    # abgerechnet, also 0,098 m² statt 0,057 m².
                    #
                    # Das war die Ursache von „Preis weicht vom kassierten
                    # Betrag ab": ``assets/engine.js`` kassiert an der Kasse
                    # über die echte Konturfläche, dieser Weg rechnete die
                    # Scheibe — und die Übernahme sperrte den bezahlten
                    # Auftrag, weil die beiden Kerne sich widersprachen. Genau
                    # die Fehlerklasse, die CLAUDE.md §10 vertrauenszerstörend
                    # nennt, nur mit bereits geflossenem Geld.
                    #
                    # Seit 2.7.0-lite hängt auch die *Lage* daran: ohne shape
                    # fällt footprint() auf das Hüllquadrat zurück.
                    shape=getattr(l, "shape", None),
                    # Formfamilie für die Rüststufe der festen Einrichtung.
                    fam=str(getattr(l, "fam", "") or ""),
                )
            )
    return out


def _apply_freight(pc: dict, freight: float | None) -> dict:
    """Handerfasste Versandkosten (manueller Versand aus dem Auftragsbüro)
    ersetzen die Pauschale. Bewusst nicht im Rechenkern: ``price_cart`` bleibt
    die eine Preiswahrheit für Portal und Büropersonal — nur die Summenzeilen
    werden hier nachgezogen, mit demselben Steuersatz, den der Kern benutzt
    hat. Die Vorschau über ``quote()`` läuft über denselben Pfad, damit
    Vorschau und eingefrorener Auftrag nie auseinanderlaufen."""
    if freight is None:
        return pc
    freight = round(float(freight), 2)
    vr = pc.get("vatRate") or 0.0
    total = pc["goods"] - float(pc.get("discount", 0.0) or 0.0) + pc["cert"] + freight
    pc["freight"] = freight
    pc["total"] = total
    pc["vat"] = total * vr
    pc["gross"] = total * (1 + vr)
    return pc


# Wiederverkäufer-Staffel (2026-09, online resale): Preisgruppe → Rabatt auf die
# Ware (nie auf Zeugnis/Fracht). Der Rabatt kommt aus dem Benutzer (backend-
# vertraut); der Browser schickt nie einen Preisnachlass. Unbekannte Gruppen
# geben 0 — ein Tippfehler darf keinen Rabatt erzeugen.
PRICE_GROUPS: dict[str, float] = {
    "standard": 0.0,
    "haendler": 10.0,
    "oem": 15.0,
    "distributor": 12.0,
}


def discount_for(user) -> float:
    """Rabatt in Prozent für diesen Benutzer: explizit gesetzter Wert schlägt
    die Gruppe, beide gedeckelt auf 0–50. Gast/ohne Benutzer = 0."""
    if user is None:
        return 0.0
    try:
        explicit = float(getattr(user, "discount_pct", 0.0) or 0.0)
    except (TypeError, ValueError):
        explicit = 0.0
    if explicit > 0:
        return max(0.0, min(50.0, explicit))
    group = str(getattr(user, "price_group", "standard") or "standard").lower()
    return max(0.0, min(50.0, PRICE_GROUPS.get(group, 0.0)))


def quote(
    db: Session,
    lines,
    cert: str = "2.2",
    plate: dict[str, int] | None = None,
    vat_rate: float | None = None,
    freight_override: float | None = None,
    discount_pct: float | None = None,
    user=None,
) -> dict:
    """Kalkulation ohne Nebenwirkung — dieselbe Funktion, die auch die
    Bestellung benutzt. Vorschau und Rechnung dürfen nie auseinanderlaufen."""
    products = load_products(db)
    rates = load_rates(db, vat_rate=vat_rate)
    plate = plate or {}
    disc = float(discount_pct) if discount_pct is not None else discount_for(user)
    return _apply_freight(
        price_cart(
            lines_to_domain(lines),
            lambda m: products.get(m),
            rates,
            cert,
            lambda m: plate.get(m),
            discount_pct=disc,
        ),
        freight_override,
    )


def release_on_account(db: Session, order: Order, customer: User) -> None:
    """Offenrechnung: ab Auftrag frei, sofern der Kreditrahmen reicht."""
    order.released = not order.blocked
    if customer.credit_limit > 0:
        open_q = db.query(func.coalesce(func.sum(Order.gross), 0.0)).filter(
            Order.user_id == customer.id,
            Order.paid.is_(False),
            Order.cancelled_at.is_(None),
        )
        if order.id is not None:
            open_q = open_q.filter(Order.id != order.id)
        open_net = float(open_q.scalar() or 0.0)
        if open_net + order.gross > customer.credit_limit:
            order.released = False
            order.release_note = (
                "Kreditrahmen überschritten — Freigabe durch die Geschäftsführung"
            )
    if order.released and not order.release_note:
        order.release_note = "Offenrechnung — ab Auftrag freigegeben"


def promised_date(
    db: Session, *, rush: bool = False, start: datetime | None = None
) -> datetime:
    """Das Zusagedatum: heute plus so viele Werktage, wie eingestellt sind.

    Ohne dieses Datum kann die Freigaberegel nur raten, wie lange sie sammeln
    darf, und Materialoptimierung frisst irgendwann eine Lieferung auf. Ein
    Eilauftrag bekommt den nächsten Werktag.

    Kein echter Feiertagskalender — Samstag und Sonntag fallen aus, mehr weiß
    dieser Prototyp nicht. Die kapazitätsabhängige Zusage ist Phase 3.4.
    """
    days = 1 if rush else max(0, settings_store.get_int(db, "delivery_days", 3))
    d = (start or datetime.now(timezone.utc)).date()
    left = max(1, days)
    while left:
        d += timedelta(days=1)
        if d.weekday() < 5:
            left -= 1
    # Ende des Werktags — eine Zusage auf den Tag, nicht auf die Minute.
    return datetime.combine(d, time(16, 0), tzinfo=timezone.utc)


def _existing_shape_id(db: Session, value) -> int | None:
    """Nur eine Form, die es wirklich gibt, wird zur Herkunft erklärt.

    Der Bestellweg ist auch für Gäste offen; eine Kennung aus dem Browser darf
    deshalb keine Verwendungsliste verfälschen. Stillgelegte Formen bleiben
    gültig — der Auftrag ist älter als die Stilllegung.
    """
    if not value:
        return None
    try:
        shape_id = int(value)
    except (TypeError, ValueError):
        return None
    return shape_id if db.get(LibraryShape, shape_id) else None


def place_order(
    db: Session,
    *,
    lines,
    cert: str,
    ship_address: dict,
    bill_address: dict,
    tax_status: dict,
    customer_ref: str = "",
    anon_id: str = "",
    user: User | None = None,
    plate: dict[str, int] | None = None,
    rush: bool = False,
    #: Ohne ausdrückliche Freigabe geht nichts in die Fertigung. Der frühere
    #: Standard ``True`` ließ den öffentlichen Bestellweg unbezahlt schneiden;
    #: wer freigeben will, sagt es jetzt (Kasse, Offenrechnung, Auftragsbüro).
    released: bool = False,
    release_note: str = "",
    paid: bool = False,
    paid_at: datetime | None = None,
    payment_ref: str = "",
    payment_method: str = "",
    price_check: dict | None = None,
    contact_email: str = "",
    freight_override: float | None = None,
    kind: str = "external",
    internal_owner: str = "",
    commit: bool = True,
    #: Auftragssperre des Kunden: der Auftrag wird angelegt, aber angehalten,
    #: bis das Büro ihn fortsetzt. Das Auftragsbüro schaltet das ab, wenn ein
    #: Admin die Sperre für diesen einen Auftrag ausdrücklich übergangen hat.
    hold_for_customer_block: bool = True,
) -> Order:
    """Bestellung anlegen.

    Der Preis wird hier ein einziges Mal gerechnet und mit dem Auftrag
    eingefroren — samt Engine-Version. Ein späterer Nester-Fortschritt darf ein
    bestätigtes Angebot nicht rückwirkend verändern (CLAUDE.md §8.1).

    ``released`` entscheidet, ob der Sammellauf den Auftrag einsammeln darf.
    Über die Kasse setzt ihn der Zahlungseingang, bei einer verbindlichen
    Bestellung auf Rechnung die Bestellung selbst.

    ``contact_email`` trägt den Empfänger späterer Updates; er läuft nach
    ``mailer.RETENTION_DAYS`` ab (services/mailer.purge_expired_contacts).

    ``commit=False`` lässt die Transaktion offen, für einen Import aus einem Guss.

    ``kind`` und ``internal_owner`` trennen den Kundenauftrag vom internen
    Auftrag. Der interne braucht keinen Kunden und keine Zahlung; der Name des
    verantwortlichen Mitarbeiters steht am Auftrag und auf der Laufkarte.
    """
    pc = quote(
        db,
        lines,
        cert,
        plate,
        vat_rate=tax_status.get("rate"),
        freight_override=freight_override,
        user=user,
    )
    prefix = settings_store.get(db, "order_prefix", "AB-26")
    over_ids = {p.id for p in pc["over"]}

    # Invoice-level currency rounding: tax is based on the payable net cents.
    from decimal import Decimal, ROUND_HALF_UP
    money = lambda value: Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    net_amount = money(pc["total"])
    tax_rate = Decimal(str(pc.get("vatRate", 0.19)))
    vat_amount = money(net_amount * tax_rate)
    pc["total"], pc["vat"], pc["gross"] = float(net_amount), float(vat_amount), float(net_amount + vat_amount)
    from .numbering import next_number

    order = Order(
        no=next_number(db, "order", prefix),
        user_id=user.id if user else None,
        customer_ref=customer_ref,
        anon_id=(anon_id or "")[:64],
        cert=cert,
        kind="internal" if kind == "internal" else "external",
        internal_owner=(internal_owner or "").strip()[:160],
        contact_email=mailer.normalize_contact(contact_email),
        email_retain_until=mailer.retention_for(paid_at),
        ship_address=ship_address,
        bill_address=bill_address,
        tax_status=tax_status,
        net=round(pc["total"], 2),
        vat=round(pc["vat"], 2),
        gross=round(pc["gross"], 2),
        price_breakdown={
            k: round(pc.get(k, 0.0), 4)
            for k in (
                "matC",
                "cutC",
                "sheetC",
                "customC",
                "setup",
                "discountPct",
                "discount",
                "cert",
                "freight",
                "goods",
                "total",
                "vat",
                "gross",
                "leftoverCredit",
                "cutLenM",
                "machineMin",
                "derivedCut",
            )
        },
        engine_version=ENGINE_VERSION,
        stage=0,
        blocked=bool(over_ids),
        stages=[datetime.now(timezone.utc).isoformat()],
        due_date=promised_date(db, rush=rush),
        rush=bool(rush),
        # Eine Übergröße wartet auf einen Menschen — sie geht nie von selbst in
        # die Fertigung, egal wie die Freigabe steht.
        released=bool(released) and not over_ids,
        release_note=release_note[:200],
        paid=bool(paid),
        paid_at=paid_at,
        payment_ref=payment_ref[:120],
        payment_method=payment_method[:20],
        price_check=price_check or {},
    )
    db.add(order)
    db.flush()

    for l in lines:
        e = pc["per"].get(l.id, {})
        # Übergrößen gehen nie in den Sammellauf — sie brauchen einen Menschen.
        # Eine freie Position ebenso: sie hat keine Kontur, die der Nester
        # schachteln könnte, und wird von Hand gefertigt oder zugekauft.
        if l.id in over_ids or l.kind == "custom":
            status = "manual"
        elif l.kind == "sheet":
            status = "done"
        else:
            status = "pending"
        db.add(
            OrderPosition(
                order_id=order.id,
                kind=l.kind,
                label=l.label or l.mat,
                mat=l.mat,
                thk=l.thk,
                qty=l.q,
                od=l.od,
                di=l.di,
                bolt_count=l.bn,
                bolt_circle=l.bc,
                bolt_d=l.bd,
                cut_len=l.cut_len,
                fmt=l.fmt,
                shape=getattr(l, "shape", None),
                shape_id=_existing_shape_id(db, getattr(l, "shape_id", None)),
                # Formfamilie für die Rüststufe — alte Warenkörbe tragen keine,
                # dann entscheidet beim Nachrechnen die Kontur (2.10.0-lite).
                fam=str(getattr(l, "fam", "") or "")[:20],
                note=getattr(l, "desc", "")[:500],
                external_note=(getattr(l, "external_note", "") or "")[:500],
                price_gross=float(getattr(l, "price_gross", 0.0) or 0.0),
                mat_cost=round(e.get("mat", 0.0), 4),
                cut_cost=round(e.get("cut", 0.0), 4),
                production_status=status,
            )
        )

    if hold_for_customer_block and user is not None and getattr(user, "order_block", False):
        # Kein Weg an der Sperre vorbei: auch ein bezahlter Portalauftrag
        # bleibt liegen, bis ein Mensch im Büro ihn fortsetzt.
        # Der Grund der Sperre bleibt in der Kundenkarte: am Auftrag sähe ihn
        # auch die Halle, und er überlebte das Löschen des Kundenkontos.
        order.held_at = datetime.now(timezone.utc)
        order.hold_reason = "Auftragssperre des Kunden"
        db.add(AuditLog(actor="system", action="order_hold", entity="order",
                        entity_id=order.no,
                        detail={"reason": order.hold_reason, "via": "customer_block"}))

    if commit:
        db.commit()
        db.refresh(order)
    else:
        db.flush()
    return order

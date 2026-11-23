"""CSV: Aufträge importieren, Aufträge und Rechnungen exportieren.

**Import.** Jede Zeile ist eine Position. Zeilen mit demselben Kunden und
demselben ``bestellzeichen`` werden ein Auftrag, ohne Bestellzeichen ist jede
Zeile einer. Trennzeichen ``;`` oder ``,``, deutsche Dezimalzahlen, UTF-8 mit
oder ohne BOM. Spalten (englische Namen gehen auch, siehe ``ALIASES``):

    kundennr | email, firma   wer bestellt; unbekannte E-Mail mit Firma legt ihn an
    strasse, plz, ort, land   Liefer- und Rechnungsanschrift; land leer = DE
    werkstoff, dicke, menge   Pflicht
    aussen, innen             Ring in mm; oder breite, hoehe, innen für ein Rechteck
    bezeichnung, bestellzeichen

Die Vorschau rechnet alles und legt nichts an. Der Import läuft in einer
Transaktion: eine fehlerhafte Zeile, und es entsteht gar nichts. Bestätigungsmails
gehen keine hinaus: ein Import ist Nacherfassung, kein Gespräch mit dem Kunden.
Der Preis kommt wie überall aus dem Rechenkern, nie aus der Datei.

**Export.** Semikolon, deutsche Dezimalzahl, BOM: so öffnet Excel es richtig.
Text, der mit ``= + - @``, Tab oder CR beginnt, bekommt ein ``'`` davor, damit
eine Tabellenkalkulation ihn nicht als Formel ausführt.
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import Response
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session, defer, joinedload

from ..db import chunked_in

from ..core.geometry import rect_from_params
from ..models import AuditLog, Order, OrderPosition, Product, Role, User
from ..schemas import QuoteLine
from ..security import hash_password
from . import local_invoices
from .catalog import load_products
from .dimension_limits import load_limits, validate_all
from .orders import place_order, quote, release_on_account

MAX_BYTES = 4 * 1024 * 1024
MAX_ROWS = 5000
TAX = {"rate": 0.19, "type": "domestic"}
COLUMNS = ("kundennr", "email", "firma", "strasse", "plz", "ort", "land", "werkstoff", "dicke",
           "menge", "bezeichnung", "aussen", "innen", "breite", "hoehe", "bestellzeichen")
ALIASES = {
    "kundennummer": "kundennr", "customer_no": "kundennr", "e-mail": "email", "company": "firma",
    "straße": "strasse", "street": "strasse", "zip": "plz", "city": "ort", "country": "land",
    "material": "werkstoff", "thickness": "dicke", "qty": "menge", "label": "bezeichnung",
    "od": "aussen", "di": "innen", "width": "breite", "height": "hoehe", "ref": "bestellzeichen",
    "customer_ref": "bestellzeichen",
}
_FORMULA = ("=", "+", "-", "@", "\t", "\r", "\n")
_THOUSANDS_ONLY = re.compile(r"^\d{1,3}(\.\d{3})+$")


def safe_cell(value) -> str:
    """Text für eine Zelle; Formelzeichen vorn werden entschärft, auch hinter Leerzeichen."""
    text = "" if value is None else str(value)
    return "'" + text if text.lstrip(" ").startswith(_FORMULA) else text


def number_cell(value) -> str:
    return f"{float(value or 0):.2f}".replace(".", ",")


def parse_number(raw: str) -> float:
    """``1,5``, ``1.5``, ``1.234,56`` und ``1,234.56``. ``1.500`` ist mehrdeutig und wird abgelehnt."""
    text = raw.strip().replace(" ", "")
    if _THOUSANDS_ONLY.match(text):
        raise ValueError(f"„{raw}“ ist mehrdeutig (Tausenderpunkt oder Dezimalpunkt?)")
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".") if text.rfind(",") > text.rfind(".") \
            else text.replace(",", "")
    else:
        text = text.replace(",", ".")
    try:
        value = float(text)
    except ValueError:
        raise ValueError(f"„{raw}“ ist keine Zahl") from None
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"„{raw}“ ist keine Zahl")
    return value


@dataclass
class PlannedOrder:
    key: tuple
    ref: str
    email: str
    company: str
    customer: User | None
    address: dict
    rows: list[int] = field(default_factory=list)
    lines: list[QuoteLine] = field(default_factory=list)
    net: float = 0.0
    vat: float = 0.0
    gross: float = 0.0
    no: str = ""


@dataclass
class ImportPlan:
    rows: int = 0
    errors: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    orders: list[PlannedOrder] = field(default_factory=list)
    sha256: str = ""

    def error(self, row: int, column: str, message: str) -> None:
        self.errors.append({"row": row, "column": column, "message": message})

    def out(self, mode: str, created: list[str] | None = None) -> dict:
        return {
            "mode": mode, "ok": not self.errors, "rows": self.rows, "errors": self.errors,
            "warnings": self.warnings, "created": created or [],
            "orders": [{"no": o.no, "ref": o.ref, "customer": o.customer.company or o.customer.name
                        if o.customer else o.company, "email": o.customer.email if o.customer else o.email,
                        "new_customer": o.customer is None, "rows": o.rows, "positions": len(o.lines),
                        "net": o.net, "vat": o.vat, "gross": o.gross} for o in self.orders],
        }


def _read(raw: bytes, plan: ImportPlan) -> list[tuple[int, dict]]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        plan.error(0, "", "Die Datei ist nicht UTF-8-kodiert.")
        return []
    first = text.splitlines()[0] if text.strip() else ""
    delimiter = ";" if first.count(";") >= first.count(",") else ","
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    try:
        header = next(reader, [])
        names = [ALIASES.get(h.strip().lower(), h.strip().lower()) for h in header]
        unknown = [h for h, n in zip(header, names) if n not in COLUMNS]
        if unknown:
            plan.error(1, "", "Unbekannte Spalte: " + ", ".join(unknown))
        for needed in ("werkstoff", "menge"):
            if needed not in names:
                plan.error(1, needed, f"Spalte „{needed}“ fehlt.")
        if plan.errors:
            return []
        rows = []
        seen = 0
        for cells in reader:
            if not any(c.strip() for c in cells):
                continue
            seen += 1  # auch fehlerhafte Zeilen: sonst füllen sie den Speicher mit Meldungen
            if seen > MAX_ROWS:
                plan.error(reader.line_num, "", f"Mehr als {MAX_ROWS} Zeilen.")
                return []
            if len(cells) != len(names):
                plan.error(reader.line_num, "", f"{len(cells)} Felder statt {len(names)}.")
                continue
            rows.append((reader.line_num, {n: c.strip() for n, c in zip(names, cells)}))
        return rows
    except csv.Error as exc:
        plan.error(reader.line_num, "", f"Die Datei ist kein lesbares CSV: {exc}")
        return []


def _customer(db: Session, n: int, row: dict, plan: ImportPlan) -> tuple[bool, User | None]:
    """(gefunden oder anlegbar, Konto). ``None`` als Konto heißt: wird neu angelegt."""
    q = db.query(User).filter(User.role == Role.customer)
    if row.get("kundennr"):
        found = q.filter(User.customer_no == row["kundennr"]).first()
        if not found:
            plan.error(n, "kundennr", f"Kunde {row['kundennr']} ist nicht bekannt.")
        return bool(found), found
    email = row.get("email", "").lower()
    if not email:
        plan.error(n, "kundennr", "Ohne Kundennummer oder E-Mail kein Kunde.")
        return False, None
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        plan.error(n, "email", f"„{email}“ ist keine E-Mail-Adresse.")
        return False, None
    found = q.filter(User.email == email).first()
    if found:
        return True, found
    if db.query(User.id).filter(User.email == email).first():
        plan.error(n, "email", f"{email} gehört zu einem internen Konto.")
        return False, None
    if not row.get("firma"):
        plan.error(n, "firma", "Neuer Kunde: Firma fehlt.")
        return False, None
    return True, None


def _line(n: int, row: dict, products: dict, thicknesses: dict, limits, plan: ImportPlan) -> QuoteLine | None:
    before = len(plan.errors)

    def num(column: str, default: float | None = None) -> float | None:
        if not row.get(column):
            return default
        try:
            value = parse_number(row[column])
        except ValueError as exc:
            plan.error(n, column, str(exc))
            return None
        if value < 0:
            plan.error(n, column, "Darf nicht negativ sein.")
            return None
        return value

    wanted = row.get("werkstoff", "")
    mat = wanted if wanted in products else next(
        (pid for pid, p in products.items() if p.name.casefold() == wanted.casefold()), "")
    if not mat:
        plan.error(n, "werkstoff", f"Werkstoff „{wanted}“ ist nicht bekannt.")
    thk = num("dicke")
    if thk is None and not row.get("dicke"):
        plan.error(n, "dicke", "Dicke fehlt.")
    elif thk and mat and thicknesses.get(mat) and thk not in thicknesses[mat]:
        plan.error(n, "dicke", f"{thk:g} mm gibt es in diesem Werkstoff nicht.")
    qty = num("menge")
    if qty is None and not row.get("menge"):
        plan.error(n, "menge", "Menge fehlt.")
    elif qty is not None and (qty != int(qty) or not 1 <= qty <= 1_000_000):
        plan.error(n, "menge", "Menge muss eine ganze Zahl ab 1 sein.")
    od, di = num("aussen", 0.0), num("innen", 0.0)
    w, h = num("breite", 0.0), num("hoehe", 0.0)
    if len(plan.errors) > before:
        return None
    shape, fam = None, ""
    if w and h:
        shape, fam, od = rect_from_params(w, h, di=di), "rect", (w * w + h * h) ** 0.5
    elif not od:
        plan.error(n, "aussen", "Maß fehlt: aussen, oder breite und hoehe.")
        return None
    if di >= od:
        plan.error(n, "innen", "Innenmaß muss kleiner als das Außenmaß sein.")
        return None
    for message in validate_all(od, di, w or None, h or None, limits, products[mat].min_web):
        plan.error(n, "aussen", message)
    return QuoteLine(id=n, mat=mat, thk=thk, q=int(qty), label=row.get("bezeichnung", "")[:200],
                     od=od, di=di, shape=shape, fam=fam)


def plan_import(db: Session, raw: bytes) -> ImportPlan:
    plan = ImportPlan(sha256=hashlib.sha256(raw).hexdigest())
    rows = _read(raw, plan)
    plan.rows = len(rows)
    products = load_products(db)
    thicknesses = {p.id: [float(t) for t in (p.thicknesses or [])] for p in db.query(Product)}
    limits = load_limits(db)
    groups: dict[tuple, PlannedOrder] = {}
    for n, row in rows:
        known, customer = _customer(db, n, row, plan)
        if row.get("land", "DE").upper() not in ("", "DE"):
            plan.error(n, "land", "Auslandsauftrag: Steuer erfordert Prüfung, bitte im Auftragsbüro erfassen.")
        for column, title in (("strasse", "Straße"), ("ort", "Ort")):
            if not row.get(column):
                plan.error(n, column, f"{title} fehlt.")
        line = _line(n, row, products, thicknesses, limits, plan)
        if not known or line is None:
            continue
        who = customer.id if customer else row["email"].lower()
        ref = row.get("bestellzeichen", "")[:80]
        key = (who, ref) if ref else (who, "", n)
        address = {"company": (customer.company if customer else row["firma"]) or row.get("firma", ""),
                   "street": row.get("strasse", ""), "zip": row.get("plz", ""), "city": row.get("ort", ""),
                   "country": "DE"}
        group = groups.get(key)
        if group is None:
            group = groups[key] = PlannedOrder(key=key, ref=ref, email=row.get("email", "").lower(),
                                               company=row.get("firma", ""), customer=customer, address=address)
        elif group.address != address:
            plan.error(n, "strasse", f"Anschrift weicht von Zeile {group.rows[0]} desselben Auftrags ab.")
        group.rows.append(n)
        group.lines.append(line)
    for group in groups.values():
        pc = quote(db, group.lines, "2.2", vat_rate=TAX["rate"], user=group.customer)
        group.net, group.vat, group.gross = round(pc["total"], 2), round(pc["vat"], 2), round(pc["gross"], 2)
        if pc["over"]:
            plan.warnings.append({"row": group.rows[0], "column": "",
                                  "message": "Übergröße: der Auftrag bleibt gesperrt, bis die Technik ihn prüft."})
    plan.orders = list(groups.values())
    return plan


def commit_import(db: Session, plan: ImportPlan, actor: str, filename: str) -> list[str]:
    """Alles oder nichts: erst der eine Commit am Ende macht die Aufträge sichtbar."""
    new: dict[str, User] = {}
    created: list[str] = []
    try:
        for group in plan.orders:
            customer = group.customer or new.get(group.email)
            if customer is None:
                customer = User(email=group.email, company=group.company, role=Role.customer,
                                password_hash=hash_password(secrets.token_urlsafe(24)))
                db.add(customer)
                db.flush()
                new[group.email] = customer
                db.add(AuditLog(actor=actor, action="desk_customer_create", entity="user",
                                entity_id=str(customer.id),
                                detail={"email": group.email, "company": group.company, "via": "csv_import"}))
            order = place_order(db, lines=group.lines, cert="2.2", ship_address=group.address,
                                bill_address=group.address, tax_status=dict(TAX), customer_ref=group.ref,
                                user=customer, contact_email=customer.email, payment_method="account",
                                commit=False)
            release_on_account(db, order, customer)
            group.no = order.no
            created.append(order.no)
        db.add(AuditLog(actor=actor, action="csv_import", entity="order", entity_id=filename[:80],
                        detail={"orders": created, "rows": plan.rows, "sha256": plan.sha256}))
        db.commit()
    except Exception:
        db.rollback()
        for group in plan.orders:
            group.no = ""
        raise
    return created


def _csv_line(row: list[str]) -> str:
    buf = io.StringIO()
    csv.writer(buf, delimiter=";", lineterminator="\r\n").writerow(row)
    return buf.getvalue()


def _csv_stream_response(headers: list[str], row_iter, filename: str) -> StreamingResponse:
    def _generate():
        yield "\ufeff" + _csv_line(headers)
        for row in row_iter:
            yield _csv_line(row)

    return StreamingResponse(
        _generate(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


def _stamp(value) -> str:
    return value.date().isoformat() if value else ""


def _audit_export(db: Session, actor: str, what: str, count: int) -> None:
    db.add(AuditLog(actor=actor, action="csv_export", entity=what, entity_id=what,
                    detail={"rows": count, "at": datetime.now(timezone.utc).isoformat()}))
    db.commit()


def orders_response(db: Session, actor: str) -> Response:
    total_rows = int(db.query(func.count(Order.id)).scalar() or 0)
    _audit_export(db, actor, "orders", total_rows)

    def _rows():
        last_id = 0
        batch_size = 500
        while True:
            chunk = (
                db.query(Order)
                .options(
                    joinedload(Order.user).load_only(User.id, User.company, User.name, User.customer_no),
                    defer(Order.office_note),
                    defer(Order.manual_shipment),
                    defer(Order.price_breakdown),
                    defer(Order.price_check),
                    defer(Order.tax_status),
                )
                .filter(Order.id > last_id)
                .order_by(Order.id.asc())
                .limit(batch_size)
                .all()
            )
            if not chunk:
                break
            ids = [o.id for o in chunk]
            pos_counts = dict(
                db.query(OrderPosition.order_id, func.count(OrderPosition.id))
                .filter(chunked_in(OrderPosition.order_id, ids))
                .group_by(OrderPosition.order_id)
                .all()
            )
            for o in chunk:
                address = o.bill_address or o.ship_address or {}
                if (o.kind or "external") == "internal":
                    customer = o.internal_owner
                elif o.user:
                    customer = o.user.company or o.user.name
                else:
                    customer = address.get("company", "")
                yield [
                    safe_cell(o.no), _stamp(o.created_at), safe_cell(customer),
                    safe_cell(o.user.customer_no if o.user else ""), safe_cell(o.customer_ref),
                    str(int(pos_counts.get(o.id, 0))), number_cell(o.net), number_cell(o.vat),
                    number_cell(o.gross), "ja" if o.paid else "nein", safe_cell(o.invoice_no),
                    _stamp(o.due_date),
                ]
            last_id = chunk[-1].id
            if len(chunk) < batch_size:
                break

    return _csv_stream_response(
        ["Auftrag", "Datum", "Kunde", "Kundennummer", "Bestellzeichen", "Positionen",
         "Netto", "USt", "Brutto", "Bezahlt", "Rechnung", "Liefertermin"],
        _rows(),
        "Auftraege.csv",
    )


def invoices_response(db: Session, actor: str) -> Response:
    """Lokale Belege samt Storni (Storno negativ), dazu die Stripe-Rechnungen der Aufträge."""
    local_docs = list(reversed(local_invoices.listing(db))) if local_invoices.allowed() else []
    numbers = {d["number"] for d in local_docs}
    extra_q = db.query(func.count(Order.id)).filter(Order.invoice_no != "")
    if numbers:
        extra_q = extra_q.filter(~chunked_in(Order.invoice_no, numbers))
    total_rows = len(local_docs) + int(extra_q.scalar() or 0)
    _audit_export(db, actor, "invoices", total_rows)

    def _rows():
        for d in local_docs:
            sign = -1 if d["kind"] == "storno" else 1
            yield [
                safe_cell(d["number"]), "Storno" if sign < 0 else "Rechnung",
                safe_cell(d["order_no"]), safe_cell(d["refers_to"]),
                d["issue_date"], d["due_date"] or "", safe_cell(d["customer"]),
                number_cell(sign * d["net_cents"] / 100), number_cell(sign * d["vat_cents"] / 100),
                number_cell(sign * d["gross_cents"] / 100), safe_cell(d["status"]),
            ]
        offset = 0
        batch_size = 500
        while True:
            chunk = (
                db.query(Order)
                .options(
                    joinedload(Order.user).load_only(User.id, User.company, User.name),
                    defer(Order.office_note),
                    defer(Order.manual_shipment),
                    defer(Order.price_breakdown),
                    defer(Order.price_check),
                    defer(Order.tax_status),
                )
                .filter(Order.invoice_no != "")
                .order_by(Order.invoiced_at.asc(), Order.id.asc())
                .offset(offset)
                .limit(batch_size)
                .all()
            )
            if not chunk:
                break
            for o in chunk:
                if o.invoice_no in numbers:
                    continue
                address = o.bill_address or o.ship_address or {}
                customer = (o.user.company or o.user.name) if o.user else address.get("company", "")
                yield [
                    safe_cell(o.invoice_no), "Rechnung", safe_cell(o.no), "",
                    _stamp(o.invoiced_at), _stamp(o.invoice_due_at), safe_cell(customer),
                    number_cell(o.net), number_cell(o.vat), number_cell(o.gross),
                    "bezahlt" if o.paid else "offen",
                ]
            offset += len(chunk)
            if len(chunk) < batch_size:
                break

    return _csv_stream_response(
        ["Beleg", "Art", "Auftrag", "Bezug", "Datum", "Fällig", "Kunde", "Netto", "USt",
         "Brutto", "Status"],
        _rows(),
        "Rechnungen.csv",
    )

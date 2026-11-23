"""Wer auf Papier, in der Post und in der API steht.

Gimel hat keine eigene Identität: ohne Anwendung bleibt alles leer, bis ein
Admin es einträgt, und eine Rechnung ohne Verkäufer scheitert laut
(``einvoice.validate``). Eine Anwendung bringt ihre Angaben im Plugin mit
(``extensions.Identity``). Reihenfolge für den Verkäufer: Umgebung
(``<PREFIX>SELLER_*``), dann Plugin, sonst die Tabelle ``settings``.

Die Tabelle wird nur gelesen, wenn das Plugin keine Identität bringt: Alef
fragt die Datenbank hier nie.
"""

from __future__ import annotations

import os
from dataclasses import fields, replace

from sqlalchemy.exc import SQLAlchemyError

from ..config import ENV_PREFIX
from ..extensions import Identity, active

#: Schlüssel im Verkäufer-Dict, Feld in ``Identity``, Name in der Umgebung.
SELLER_FIELDS = (
    ("name", "name", "SELLER_NAME"),
    ("street", "street", "SELLER_STREET"),
    ("zip", "zip", "SELLER_ZIP"),
    ("city", "city", "SELLER_CITY"),
    ("vatId", "vat_id", "SELLER_VATID"),
    ("taxNumber", "tax_number", "SELLER_TAX_NUMBER"),
    ("email", "email", "SELLER_EMAIL"),
    ("partners", "partners", "SELLER_PARTNERS"),
    ("website", "website", "SELLER_WEBSITE"),
    ("country", "country", "SELLER_COUNTRY"),
)
#: Was ein Admin ohne Anwendung pflegt: der Verkäufer und zwei Angaben für Papier.
EDITABLE = tuple(key for key, _, _ in SELLER_FIELDS) + ("manufacturer", "brandMark")
#: Nur für die lokale Rechnung: Register und Geschäftsführung (Pflicht auf Geschäftsbriefen
#: von GmbH, UG, e.K.), Bankverbindung, und ob der Betrieb Kleinunternehmer nach § 19 UStG ist.
INVOICE_FIELDS = ("register", "managers", "iban", "bic", "bank", "smallBusiness")
EDITABLE += INVOICE_FIELDS
#: Präfix der Zeilen in ``settings``. Punkt statt Unterstrich: die Liste der
#: Betriebsparameter blendet sie aus, ein Parameter heißt nie so.
PREFIX = "seller."


def _plugin_identity() -> Identity | None:
    plugin = active()
    return plugin.identity if plugin else None


def editable() -> bool:
    """Bringt die Anwendung die Identität mit, ist hier nichts zu pflegen."""
    return _plugin_identity() is None


def _read_rows(db) -> dict[str, str]:
    from ..models import Setting

    rows = db.query(Setting.key, Setting.value).filter(Setting.key.startswith(PREFIX)).all()
    return {key.removeprefix(PREFIX): value for key, value in rows}


def stored(db=None) -> dict[str, str]:
    """Die gepflegten Angaben. Ohne Sitzung eine eigene, kurze: Mail und Papier
    kommen auch aus Stellen ohne ``db``."""
    if not editable():
        return {}
    if db is not None:
        return _read_rows(db)
    from ..db import SessionLocal

    try:
        with SessionLocal() as own:
            return _read_rows(own)
    except SQLAlchemyError:  # noch keine Tabelle: dann gibt es auch keine Angaben
        return {}


def save(db, values: dict[str, str], actor: str) -> list[str]:
    """Geänderte Angaben schreiben, ohne Commit; gibt die geänderten Schlüssel zurück."""
    from ..models import Setting

    changed = []
    have = stored(db)
    for key, value in values.items():
        if key not in EDITABLE or have.get(key, "") == value:
            continue
        row = db.get(Setting, PREFIX + key)
        if row:
            row.value, row.updated_by = value, actor
        else:
            db.add(Setting(key=PREFIX + key, value=value, updated_by=actor,
                           note="Verkäufer- und Markenangabe, gepflegt unter /api/invoicing/seller."))
        changed.append(key)
    return changed


def env_locked() -> list[str]:
    """Felder, die die Umgebung festlegt: eine Pflege hier bliebe wirkungslos."""
    return [key for key, _, env in SELLER_FIELDS if os.environ.get(ENV_PREFIX + env)]


def invoice_extras(db=None) -> dict:
    """Was nur die lokale Rechnung trägt; unter einer Anwendung immer leer."""
    rows = stored(db)
    return {k: rows[k] for k in INVOICE_FIELDS if rows.get(k)}


def seller(db=None) -> dict:
    base = _plugin_identity()
    rows = {} if base else stored(db)
    info = {}
    for key, attr, env in SELLER_FIELDS:
        fallback = getattr(base, attr) if base else rows.get(key, "")
        info[key] = os.environ.get(ENV_PREFIX + env) or fallback
    info["country"] = info["country"] or "DE"
    info["legalName"] = f"{info['name']} ({info['partners']})" if info["partners"] else info["name"]
    return info


def texts(db=None) -> Identity:
    """Alle Texte aufgelöst: was das Plugin nennt, sonst aus dem Verkäufer abgeleitet."""
    base = _plugin_identity() or Identity()
    rows = {} if _plugin_identity() else stored(db)
    s = seller(db)
    name = s["name"]
    place = f"{s['zip']} {s['city']}".strip()
    maker = base.manufacturer or rows.get("manufacturer", "") or name
    derived = {
        "manufacturer": maker,
        "manufacturer_short": maker,
        "manufacturer_line": maker,
        "brand_mark": rows.get("brandMark", ""),
        "brand_name": name,
        "paper_name": name,
        "product": name or "Gimel",
        "mail_subject": name or "Gimel",
        "signature": name,
        "mail_header": name,
        "mail_footer": " · ".join(p for p in (name, s["street"], place) if p),
        "mail_from_name": name,
        "security_sender": name,
        "security_url": s["website"],
        "security_contact": s["email"],
        "office_label": "Auftragsbüro",
        "invoice_description": "Rechnung",
        "tax_rate_description": "Deutsche Umsatzsteuer",
        "tax_rate_key": "gimel-vat-de-19-exclusive-v1",
    }
    known = {f.name for f in fields(Identity)}
    return replace(base, **{k: getattr(base, k) or v for k, v in derived.items() if k in known})

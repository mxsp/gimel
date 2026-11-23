"""Was die Halle sieht: Datensparsamkeit nach Rolle (Aufgabe 46, Inhaber 2026-11-13).

Die Regel aus ``models.Role``: ``worker`` sieht Aufträge und arbeitet sie ab —
keine Preise, keine Kunden, keine Planung. Bis 2026-11-13 hielt sich nur die
Oberfläche daran; der Server schickte Kundennamen, Anschriften und Beträge mit,
und die Laufkarte an der Maschine druckte sie.

- **Halle (worker):** Auftragsnummer und Bestellzeichen des Kunden (eine
  Kennung, keine Person). Kein Kundenname, keine Anschrift, kein Betrag, keine
  Zahlungsangabe.
- **Versand:** Name und Lieferanschrift bleiben, denn ohne sie verlässt kein
  Paket das Haus — die Versand-Routen und die Packaufgabe nutzen diese Datei
  deshalb nicht.
- **Büro (staff, admin):** alles wie bisher.

Interne Aufträge tragen statt eines Kunden den verantwortlichen Mitarbeiter;
der bleibt sichtbar, er ist ein Kollege und kein Kundendatum.
"""

from __future__ import annotations

import re

from typing import Any, Callable, Optional

from ..models import Role, User

OFFICE_ROLES = (Role.staff, Role.admin)


def is_office(user: Optional[User]) -> bool:
    """Büro oder Halle. Ohne Benutzer gilt die strengere Sicht."""
    return bool(user) and user.role in OFFICE_ROLES


def customer_name(name: Any, office: bool) -> str:
    """Kundenname für die Ausgabe: im Büro der Name, in der Halle nichts."""
    return str(name or "") if office else ""


def address(addr: Any, office: bool) -> dict:
    """Anschrift für die Ausgabe: im Büro vollständig, in der Halle leer."""
    return dict(addr or {}) if office else {}


#: Felder, die eine Person oder Firma nennen oder sie finden lassen.
PERSON_KEYS = frozenset({
    "customer", "customer_name", "customer_email", "contact", "contact_email", "email",
    "email_alternatives", "recipient", "phone",
    "ship_name", "ship_street", "ship_zip", "ship_city", "ship_country",
})
#: Ganze Anschriften.
ADDRESS_KEYS = frozenset({"ship_address", "bill_address", "ship_to", "manual_shipment"})
#: Bürotexte und Anschriftteile: werden leerer Text.
TEXT_KEYS = frozenset({
    "company", "street", "zip", "city", "vat_id", "invoice_no", "invoice_reference",
    "hold_reason", "cancel_reason", "office_note", "release_note",
})
#: Beträge und Zahlungsangaben.
MONEY_KEYS = frozenset({
    "net", "vat", "gross", "price_gross", "price_net", "total_net",
    "amount_cents", "total_cents", "target_cents", "prepaid_cents", "price",
    "credit_limit", "discount_pct",
    "paid", "paid_at", "payment_method", "payment_ref", "price_check",
})

_EMPTY_MONEY: dict[str, Any] = {"paid": False, "paid_at": None, "payment_method": "",
                                "payment_ref": "", "price_check": {}}


def is_pack_task(d: dict) -> bool:
    """Eine Packaufgabe ist Versand: sie braucht den Empfänger."""
    return d.get("kind") == "pack"


def customer_or_ref(name: Any, ref: Any, office: bool) -> str:
    """Wer hinter einem Innenauftrag steht: im Büro der Kunde (sonst sein Bestellzeichen),
    in der Halle nur das Bestellzeichen — eine Kennung, keine Person."""
    return str((name if office else "") or ref or "")


def scrub(value: Any, office: bool, keep: Optional[Callable[[dict], bool]] = None) -> Any:
    """Die Antwort für die Halle: Personen-, Anschrift- und Betragsfelder geleert,
    in jeder Tiefe. Im Büro unverändert. Die Struktur bleibt, damit die Oberfläche
    nicht an einem fehlenden Schlüssel bricht: Text wird "", Beträge 0, Anschriften {}.

    Ausnahme ``internal_owner``: ein Mitarbeiter, kein Kunde — bleibt. Ein Eintrag,
    für den ``keep`` wahr ist (z. B. eine Packaufgabe), bleibt ganz stehen."""
    if office:
        return value
    if isinstance(value, dict):
        if keep is not None and keep(value):
            return value
        # Ein Wörterbuch mit Straße und Firma/Name ist eine Anschrift, wie immer es heißt.
        if "street" in value and ("company" in value or "name" in value):
            return {}
        out: dict = {}
        for k, v in value.items():
            if k in ADDRESS_KEYS:
                out[k] = {}
            elif k in MONEY_KEYS:
                out[k] = _EMPTY_MONEY.get(k, 0.0)
            elif k in TEXT_KEYS:
                out[k] = ""
            elif k in PERSON_KEYS:
                out[k] = "" if not isinstance(v, (list, tuple)) else []
            elif k == "customers":
                out[k] = []
            else:
                out[k] = scrub(v, office, keep)
        return out
    if isinstance(value, (list, tuple)):
        return [scrub(v, office, keep) for v in value]
    return value


def actor_label(actor: Any, office: bool, internal: set[str]) -> str:
    """Wer eine Protokollzeile ausgelöst hat. Die Halle sieht Kollegen und das System,
    aber keinen Kunden: bestellt ein Kunde selbst, steht dort seine E-Mail."""
    text = str(actor or "")
    if office or "@" not in text or text.lower() in internal:
        return text
    return "Kunde"


def internal_emails(db) -> set[str]:
    """E-Mail-Adressen aller Konten, die keine Kunden sind (klein geschrieben)."""
    from ..models import User  # spät: floor_view bleibt ohne Datenbank testbar

    rows = db.query(User.email).filter(User.role != Role.customer).all()
    return {str(e).lower() for (e,) in rows if e}


_HOLD = re.compile(r"angehalten — [^·]*?(?=\s·|$)")


def floor_tasks(value: Any, office: bool) -> Any:
    """Arbeitsvorrat für die Halle: Kunden nur an Packaufgaben, und der Grund eines
    angehaltenen Auftrags (Bürotext seit Aufgabe 45) fällt aus der Notiz."""
    out = scrub(value, office, keep=is_pack_task)
    if office:
        return out

    def strip(v: Any) -> Any:
        if isinstance(v, dict):
            if v.get("kind") != "pack" and isinstance(v.get("note"), str):
                v = {**v, "note": _HOLD.sub("angehalten", v["note"]).strip()}
            return {k: strip(x) for k, x in v.items()}
        if isinstance(v, list):
            return [strip(x) for x in v]
        return v

    return strip(out)

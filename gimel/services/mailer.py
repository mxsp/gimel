"""Postausgang und Kontaktfrist.

Bis 2026-09 war das hier eine Naht ohne Naht: ``send_order_confirmation`` und
``send_order_update`` schrieben eine Protokollzeile und sonst nichts. Der
Transport steht jetzt darunter (``services/smtp_client.py``) — keine
Aufrufstelle hat sich bewegt, was der ganze Sinn der damaligen Übung war.

Die Arbeitsteilung mit dem Portal (server/mailer.mjs) ist ausdrücklich:

* **Hier** entstehen die Nachrichten, die eine echte Auftragsnummer brauchen —
  die Bestätigung bei der Übernahme und die Fertigungsmeldung. Das Portal
  kennt zum Zeitpunkt der Zahlung nur seinen Sitzungsschlüssel.
* **Dort** entstehen die Nachrichten, die Stripe-Wissen brauchen — IBAN und
  Verwendungszweck einer Überweisung, gescheiterte Zahlungen.

In derselben Datei wohnt weiterhin die Kontaktrichtlinie, weil beides dieselbe
Frage trifft: wie lange dürfen wir den Empfänger wissen?

* Klartext-Kontakt am Auftrag läuft nach ``ALPHA_EMAIL_RETENTION_DAYS``
  (Standard: ein Monat) ab und wird vom Aufräumgang gestrichen.
* Die Auftragsverfolgung leidet nicht daran: das Portal prüft Nummer +
  E-Mail gegen einen gesalzenen Hash, der keine Frist kennt.

**Dedupe.** Ein Webhook wird mehrfach zugestellt, ein Sammellauf kann zweimal
über dieselbe Stufe laufen. Jede Nachricht trägt deshalb einen Schlüssel, und
der Schlüssel liegt in ``AuditLog`` — im Arbeitsspeicher überlebt er keinen
Neustart, und ein Neustart ist genau der Moment, in dem Stripe nachliefert.
"""

from __future__ import annotations
from ..config import ENV_PREFIX

import logging
import re
from datetime import datetime, timedelta, timezone
from html import escape

from sqlalchemy.orm import Session

from ..models import AuditLog, Order
from . import identity, smtp_client
from .smtp_client import _env

log = logging.getLogger("alpha.post")

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")

RETENTION_DAYS = max(1, int(_env(ENV_PREFIX + "EMAIL_RETENTION_DAYS", "30")))


def absender() -> str:
    """Fuß jeder Kundennachricht. Steht hier und nicht in fünf Vorlagen."""
    return identity.texts().mail_footer


#: Eine Statusliste für Portal, Verfolgung und Post — gleich halten mit dem
#: Portal der Anwendung (Alef: server/orders.mjs STAGE_LABELS, server/mailer.mjs,
#: assets/bs.js o_status). Versandt/Zugestellt nur aus echten Sendungen.
STAGE_LABELS = ("Bestätigt", "In Fertigung", "Gefertigt")

ANREDE = "Guten Tag,"


def _service_contact() -> str:
    """Wohin Kundenfragen gehen: die Kontaktadresse des Verkäufers."""
    t = identity.texts()
    return (identity.seller().get("email") or t.security_contact or "").strip()


def _questions() -> str:
    mail = _service_contact()
    return (f"Fragen? Antworten Sie auf diese E-Mail oder schreiben Sie an {mail}."
            if mail else "Fragen? Antworten Sie einfach auf diese E-Mail.")


def _planning_sentence() -> str:
    maker = (identity.texts().manufacturer or "").strip()
    seller = (identity.seller().get("name") or "").strip()
    where = f" bei {maker}" if maker and maker != seller else ""
    return f"Wir planen Ihre Positionen jetzt für die Fertigung{where} ein. Sie müssen nichts weiter tun."


def normalize_contact(raw) -> str:
    """Formatgeprüfte Kleinform oder leer. Eine fehlende Mail darf keinen
    Auftrag platzen lassen — sie macht ihn nur unauffindbar für Updates."""
    v = str(raw or "").strip().lower()
    return v if len(v) <= 254 and EMAIL_RE.match(v) else ""


# --------------------------------------------------------------------------
# Dedupe über das Prüfprotokoll
# --------------------------------------------------------------------------
def already_sent(db: Session, key: str) -> bool:
    return db.query(AuditLog.id).filter(
        AuditLog.action == "mail_sent", AuditLog.entity_id == key
    ).first() is not None


def _mark_sent(db: Session, key: str, entity: str, detail: dict) -> None:
    db.add(AuditLog(actor="system", action="mail_sent", entity=entity,
                    entity_id=key, detail=detail))
    try:
        db.commit()
    except Exception:  # noqa: BLE001 — die Post reißt keine Transaktion mit
        log.exception("Dedupe-Vermerk konnte nicht geschrieben werden (%s)", key)
        db.rollback()


# --------------------------------------------------------------------------
# Vorlagen — Broadsheet auf Papier
# --------------------------------------------------------------------------
def _shell(title: str, body_html: str, foot: str = "") -> str:
    """Kein Bild, kein externes Stylesheet: ein Postfach lädt beides ohnehin
    nicht zuverlässig, und die Datenschutzerklärung müsste es erklären."""
    return f"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f3f2f2;
  font-family:'Source Serif 4',Georgia,'Times New Roman',serif;color:#201e1d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:660px;margin:0 auto">
 <tr><td style="border-top:3px solid #201e1d;border-bottom:1px solid #201e1d;padding:8px 0 6px">
   <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b6664">
     {escape(identity.texts().mail_header)}</div></td></tr>
 <tr><td style="padding:20px 0 4px">
   <h1 style="margin:0;font-size:26px;line-height:1.2;font-weight:600">{escape(title)}</h1></td></tr>
 <tr><td style="padding:6px 0 20px;font-size:15px;line-height:1.6">{body_html}</td></tr>
 <tr><td style="border-top:1px solid #d8d5d3;padding:12px 0;font-size:11px;line-height:1.5;color:#6b6664">
   {f'<p style="margin:0 0 6px">{escape(foot)}</p>' if foot else ''}
   <p style="margin:0">{escape(absender())}</p>
   <p style="margin:4px 0 0">{escape(_questions())}</p>
 </td></tr>
</table></body></html>"""


def _eur(v) -> str:
    s = f"{float(v or 0):,.2f}"
    return s.replace(",", " ").replace(".", ",").replace(" ", ".") + " €"


def _num(v, nk: int = 1) -> str:
    return f"{float(v or 0):.{nk}f}".replace(".", ",")


def _position_rows(order: Order) -> str:
    rows = []
    for p in order.positions:
        geo = (f"Ø {_num(p.od)}" + (f" / Ø {_num(p.di)}" if p.di else "")) if p.kind == "gasket" \
            else (f"{_num(p.fmt[0], 0)}×{_num(p.fmt[1], 0)} mm" if p.fmt else "")
        rows.append(
            f'<tr><td style="padding:6px 8px 6px 0;border-bottom:1px solid #e6e3e1">'
            f'{escape(p.label or p.mat)}</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #e6e3e1;color:#6b6664">'
            f'{escape(p.mat)}</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #e6e3e1;color:#6b6664;'
            f'font-variant-numeric:tabular-nums">{_num(p.thk)} mm</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #e6e3e1;color:#6b6664;'
            f'font-variant-numeric:tabular-nums">{escape(geo)}</td>'
            f'<td style="padding:6px 0 6px 8px;border-bottom:1px solid #e6e3e1;text-align:right;'
            f'font-variant-numeric:tabular-nums">{p.qty} Stk.</td></tr>'
        )
    if not rows:
        return ""
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse;font-size:13px;margin:14px 0">'
            '<tr><th colspan="5" style="background:#201e1d;color:#f3f2f2;text-align:left;'
            'padding:5px 8px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;'
            'font-weight:600">Positionen</th></tr>' + "".join(rows) + "</table>")


def _address_block(addr: dict | None, title: str) -> str:
    a = addr or {}
    if not (a.get("street") or a.get("city")):
        return ""
    parts = [a.get("company"), a.get("contact"), a.get("street"),
             " ".join(x for x in (a.get("zip"), a.get("city")) if x), a.get("country")]
    line = "<br>".join(escape(str(p)) for p in parts if p)
    return (f'<div style="margin:10px 0"><div style="font-size:10px;letter-spacing:.14em;'
            f'text-transform:uppercase;color:#6b6664">{escape(title)}</div>'
            f'<div style="font-size:14px;line-height:1.5;margin-top:2px">{line}</div></div>')


def _sums(order: Order) -> str:
    pct = int(round(float((order.tax_status or {}).get("rate") or 0) * 100))
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0;font-size:14px">'
        f'<tr><td style="padding:2px 18px 2px 0;color:#6b6664">Netto</td>'
        f'<td style="text-align:right;font-variant-numeric:tabular-nums">{_eur(order.net)}</td></tr>'
        f'<tr><td style="padding:2px 18px 2px 0;color:#6b6664">Umsatzsteuer ({pct} %)</td>'
        f'<td style="text-align:right;font-variant-numeric:tabular-nums">{_eur(order.vat)}</td></tr>'
        f'<tr><td style="padding:6px 18px 0 0;border-top:2px solid #201e1d;font-weight:600">Gesamt</td>'
        f'<td style="text-align:right;padding-top:6px;border-top:2px solid #201e1d;font-weight:600;'
        f'font-variant-numeric:tabular-nums">{_eur(order.gross)}</td></tr></table>'
    )


def _portal_url() -> str:
    """Basis der Auftragsverfolgung, für den Link in jeder Kundennachricht."""
    return _env(ENV_PREFIX + "PORTAL_URL").rstrip("/")


# --------------------------------------------------------------------------
# Die Nachrichten an den Kunden
# --------------------------------------------------------------------------
def send_order_confirmation(order, db: Session | None = None) -> bool:
    """Auftrag angelegt und bezahlt — die Bestätigung mit der echten Nummer.

    Das ist der Grund, warum diese Nachricht hier entsteht und nicht im
    Portal: dort steht zum Zeitpunkt der Zahlung nur der Sitzungsschlüssel,
    und eine Bestätigung, die eine andere Nummer nennt als die
    Auftragsverfolgung, ist schlimmer als keine.
    """
    to = normalize_contact(order.contact_email)
    key = f"confirm:{order.no}"
    if db is not None and already_sent(db, key):
        log.info("Bestätigung %s bereits gesendet — übersprungen.", order.no)
        return False

    base = _portal_url()
    track = (f'unter <a href="{escape(base)}/#/verfolgung" style="color:#0b7285">'
             f'{escape(base)}/#/verfolgung</a>' if base
             else "in der Auftragsverfolgung des Bestellportals")

    # Kein Satz über eine Mail bei jedem Standwechsel: send_order_update hat hier
    # keinen Aufrufer, und das Portal schickt sein Update nur, wenn jemand den
    # Auftrag abruft. Zugesagt wird nur, was sicher passiert.
    # TODO(lawyer/owner, task 47): ob und wie diese Nachricht den Vertragsschluss
    # bzw. die AGB nennt, entscheidet der Eigentümer — hier keinen Satz erfinden.
    ref = f" (Ihre Referenz: {order.customer_ref})" if order.customer_ref else ""
    body = (
        f'<p style="margin:0 0 12px">{escape(ANREDE)}</p>'
        f'<p style="margin:0 0 12px">vielen Dank für Ihre Bestellung. Ihr Auftrag '
        f'<b>{escape(order.no)}</b> ist bei uns eingegangen{escape(ref)}.</p>'
        f'<p style="margin:0 0 12px">{escape(_planning_sentence())}</p>'
        + _position_rows(order)
        + _sums(order)
        + _address_block(order.ship_address, "Lieferanschrift")
        + _address_block(order.bill_address, "Rechnungsanschrift")
        + f'<p style="margin:16px 0 0;font-size:13px;color:#6b6664">Den Stand verfolgen Sie '
          f'jederzeit mit Auftragsnummer und dieser E-Mail-Adresse {track}.</p>'
    )

    lines = "\n".join(
        f"  · {p.label or p.mat} — {p.mat} {_num(p.thk)} mm · {p.qty} Stk."
        for p in order.positions
    )
    text = (
        f"{ANREDE}\n\n"
        f"vielen Dank für Ihre Bestellung. Ihr Auftrag {order.no} ist bei uns eingegangen{ref}.\n"
        f"{_planning_sentence()}\n\n"
        + (f"Positionen:\n{lines}\n\n" if lines else "")
        + f"Netto  {_eur(order.net)}\nUSt.   {_eur(order.vat)}\nGesamt {_eur(order.gross)}\n\n"
        f"Verfolgung: Auftragsnummer {order.no} + diese E-Mail-Adresse"
        + (f"\n{base}/#/verfolgung\n" if base else "\n")
        + f"\n{_questions()}\n"
        + f"\n{absender()}\n"
    )

    ok = smtp_client.send(
        to=to, subject=f"Ihr Auftrag {order.no} ist eingegangen",
        text=text, html=_shell(f"Auftrag {order.no} eingegangen", body),
        dedupe_key=key,
    )
    if ok and db is not None and to:
        _mark_sent(db, key, "order", {"kind": "confirmation", "order_no": order.no})
    return ok


def send_order_update(order_no: str, contact_email: str, status_text: str, *,
                      db: Session | None = None, stage: int | None = None,
                      work_orders: list[str] | None = None) -> bool:
    """Fertigungsstand geändert — Bestätigt → In Fertigung → Gefertigt.

    Denselben Text sieht der Kunde an der Verfolgung. Eine zweite Formulierung
    wäre eine zweite Wahrheit. Innenauftragsnummern sind Werkstattwörter und
    stehen nicht in der Kundennachricht; ``work_orders`` bleibt nur der
    Aufrufer wegen in der Signatur.
    """
    to = normalize_contact(contact_email)
    key = f"update:{order_no}:{status_text}"
    if db is not None and already_sent(db, key):
        return False

    label = STAGE_LABELS[stage] if stage is not None and 0 <= stage < len(STAGE_LABELS) \
        else status_text
    bar = "".join(
        f'<td style="padding:0 2px"><div style="height:4px;background:'
        f'{"#0b7285" if stage is not None and i <= stage else "#d8d5d3"}"></div>'
        f'<div style="font-size:11px;margin-top:5px;color:'
        f'{"#201e1d" if stage is not None and i <= stage else "#9b9694"}">{escape(s)}</div></td>'
        for i, s in enumerate(STAGE_LABELS)
    )
    body = (
        f'<p style="margin:0 0 12px">{escape(ANREDE)}</p>'
        f'<p style="margin:0 0 14px">Ihr Auftrag <b>{escape(order_no)}</b> hat einen '
        f'neuen Stand: <b>{escape(label)}</b>.</p>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:0 0 8px"><tr>{bar}</tr></table>'
    )
    text = (f"{ANREDE}\n\nIhr Auftrag {order_no} hat einen neuen Stand: {label}.\n\n"
            + f"{_questions()}\n\n"
            + f"{absender()}\n")

    ok = smtp_client.send(to=to, subject=f"Auftrag {order_no}: {label}",
                          text=text, html=_shell(f"Auftrag {order_no}", body),
                          dedupe_key=key)
    if ok and db is not None and to:
        _mark_sent(db, key, "order", {"kind": "update", "order_no": order_no,
                                      "status": status_text})
    return ok


# --------------------------------------------------------------------------
# Kontaktfrist
# --------------------------------------------------------------------------
def purge_expired_contacts(db: Session, now: datetime | None = None) -> int:
    """Klartextkontakte hinter ihrer Frist streichen.

    Der Auftrag bleibt samt aller Fakten stehen; nur das Lesbare am Empfänger
    verschwindet. Wird beim Start und vor jeder Portalübernahme gerufen —
    ein Auftrag, dessen Frist ohne neuen Verkehr verstreicht, stirbt nicht still.
    """
    moment = now or datetime.now(timezone.utc)
    # Auch die Anschriften-JSONs tragen die E-Mail (Gastkasse) — bis
    # 2026-09-30 blieb sie dort nach der Frist stehen. Deshalb nicht nur auf
    # contact_email filtern, sondern jeden Auftrag hinter seiner Frist prüfen.
    rows = (
        db.query(Order)
        .filter(Order.email_retain_until.isnot(None),
                Order.email_retain_until < moment)
        .all()
    )
    rows = [o for o in rows if o.contact_email
            or (o.ship_address or {}).get("email") or (o.bill_address or {}).get("email")]
    for o in rows:
        db.add(AuditLog(actor="system", action="contact_retention_expired",
                        entity="order", entity_id=o.no))
        o.contact_email = ""
        for attr in ("ship_address", "bill_address"):
            addr = dict(getattr(o, attr) or {})
            if addr.pop("email", None) is not None:
                setattr(o, attr, addr)  # neues dict: JSON-Spalte merkt die Änderung
    if rows:
        db.add(AuditLog(actor="system", action="contact_purge_run",
                        entity="order", entity_id=str(len(rows))))
        db.commit()
        log.info("Kontaktfrist abgelaufen: %d Auftrag/Aufträge bereinigt.", len(rows))
    return len(rows)


def retention_for(order_paid_at: datetime | None = None) -> datetime:
    base = order_paid_at or datetime.now(timezone.utc)
    return base + timedelta(days=RETENTION_DAYS)

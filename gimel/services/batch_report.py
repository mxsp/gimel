"""Fertigungsmeldung nach dem Sammellauf — welche Form wie oft, mit Zeichnung.

Der Sammellauf entscheidet, *wann* geschnitten wird (§5.5). Wer an der
Maschine steht, braucht danach eine andere Auskunft als das Panel gibt: nicht
„drei Innenaufträge, sieben Platten“, sondern **welche Form wie oft** aus
diesem Lauf herauskommt, aus welchem Kundenauftrag sie stammt und auf welcher
Platte sie liegt. Genau das ist der Inhalt hier.

Die Aggregation, und warum sie so und nicht anders ist:

* **Eine „Form“ ist eine Geometrie, kein Auftrag.** Bestellen drei Kunden
  dieselbe DN-100-Dichtung in NBR 2 mm, ist das *eine* Form mit dem Bedarf
  aller drei — und genau so wird sie geschnitten. Der Schlüssel ist deshalb
  (Werkstoff, Dicke, Außen-Ø, Innen-Ø, Lochbild, Konturabdruck), nicht die
  Positionsnummer. Wer die Herkunft braucht, findet sie in der Aufschlüsselung
  je Kundenauftrag darunter.
* **Gezählt werden Platzierungen, nicht bestellte Stückzahlen.** Eine Position
  über 20 Stück, von der 14 auf freigegebenen Platten liegen und 6 auf einer
  angebrochenen weitersammeln, erscheint hier mit 14 — das ist die Zahl, die
  heute geschnitten wird. Alles andere wäre eine Anweisung, die zur Platte
  nicht passt.
* **Restflächenteile werden ausgewiesen.** Ein Teil aus der Bohrung eines
  anderen kostet kein Material, liegt aber trotzdem auf der Platte und muss
  entnommen werden. Wer es beim Sortieren übersieht, sucht es später.

Anhänge: ein Archiv mit den Schnittdateien des ganzen Laufs (dieselbe Struktur
wie der Download im Panel, ``services/cutfiles.py``) und zusätzlich jede
Vollplatte einzeln als DXF, damit sie sich aus der Nachricht heraus öffnen
lässt, ohne vorher zu entpacken.
"""

from __future__ import annotations
from ..config import ENV_PREFIX

import hashlib
import json
import logging
from datetime import datetime, timezone
from html import escape

from sqlalchemy.orm import Session

from ..models import NestRun, OrderPosition, WorkItem, WorkOrder
from ..render.dxf import LAYER_HOLE, LAYER_INFO, LAYER_OUTER, LAYER_SHEET, LAYER_TAG
from . import cutfiles, identity, smtp_client
from .smtp_client import _env

log = logging.getLogger("alpha.post")

#: Obergrenze für alle Anhänge zusammen. IONOS nimmt deutlich mehr, aber ein
#: Postfach, das eine 40-MB-Nachricht ablehnt, lehnt sie *still* ab — dann
#: fehlt die Meldung, und niemand weiß warum. Lieber die Einzelplatten weglassen
#: und das im Text sagen.
#:
#: Alle drei Werte gehen durch dieselbe Auflösung wie die SMTP-Zugangsdaten
#: (Umfeld, dann apps/api/.env, dann die .env der Projektwurzel). Das Backend
#: startet über run_api.sh ohne geladene Projekt-.env — läse das hier nur
#: ``os.environ``, wäre der Empfänger im Betrieb still leer und die Meldung
#: bliebe aus, ohne dass jemand einen Fehler sähe.


def max_mb() -> float:
    try:
        return float(_env(ENV_PREFIX + "BATCH_REPORT_MAX_MB", "12"))
    except ValueError:
        return 12.0


def enabled() -> bool:
    return _env(ENV_PREFIX + "BATCH_REPORT", "1").strip() == "1"


def recipients() -> list[str]:
    """Wer die Fertigungsmeldung bekommt. Mehrere Adressen kommagetrennt."""
    return [a.strip() for a in _env(ENV_PREFIX + "OPS_EMAIL").split(",") if a.strip()]


# --------------------------------------------------------------------------
# Die Aggregation: Platzierungen → Formen
# --------------------------------------------------------------------------
def _shape_fingerprint(pos: OrderPosition | None, item: WorkItem) -> str:
    """Ein kurzer Abdruck der Kontur.

    Zwei Konturen sind dieselbe Form, wenn sie dieselbe Zeichnung ergeben —
    also über den kanonisierten Konturbaum, nicht über den Namen der Position.
    Ohne Kontur (Norm- und Ringteile) trägt der Abdruck nichts bei, weil
    Außen-Ø, Innen-Ø und Lochbild die Form dann bereits vollständig bestimmen.
    """
    shape = (pos.shape if pos else None) or item.shape
    if not shape:
        return ""
    blob = json.dumps(shape, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def _form_key(wo: WorkOrder, item: WorkItem, pos: OrderPosition | None) -> tuple:
    return (
        wo.mat, round(float(wo.thk), 3),
        round(float(item.od or 0), 2), round(float(item.di or 0), 2),
        int(pos.bolt_count) if pos else 0,
        round(float(pos.bolt_d), 2) if pos else 0.0,
        round(float(pos.bolt_circle), 2) if pos else 0.0,
        _shape_fingerprint(pos, item),
    )


def collect_forms(db: Session, work_orders: list[WorkOrder]) -> list[dict]:
    """Der Formbedarf des Laufs — eine Zeile je Geometrie, über alle Aufträge.

    Das ist die Antwort auf „wie viel von jeder Form wird gebraucht“, und sie
    ist bewusst über Kundenaufträge hinweg zusammengefasst: die Maschine
    schneidet Formen, nicht Bestellungen.
    """
    forms: dict[tuple, dict] = {}
    for wo in work_orders:
        items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
        pos_ids = [i.position_id for i in items if i.position_id]
        positions = (
            {p.id: p for p in db.query(OrderPosition)
             .filter(OrderPosition.id.in_(pos_ids)).all()}
            if pos_ids else {}
        )
        plate_idx = {p.id: p.idx for p in wo.plates}

        for it in items:
            pos = positions.get(it.position_id) if it.position_id else None
            key = _form_key(wo, it, pos)
            f = forms.setdefault(key, {
                "label": it.label or wo.mat_name or wo.mat,
                "mat": wo.mat,
                "mat_name": wo.mat_name or wo.mat,
                "thk": float(wo.thk),
                "od": float(it.od or 0),
                "di": float(it.di or 0),
                "bolt_count": int(pos.bolt_count) if pos else 0,
                "bolt_d": float(pos.bolt_d) if pos else 0.0,
                "bolt_circle": float(pos.bolt_circle) if pos else 0.0,
                "cut_len": float(pos.cut_len or 0) if pos else 0.0,
                "has_shape": bool((pos.shape if pos else None) or it.shape),
                "qty": 0,
                "n_from_remnant": 0,
                "work_orders": set(),
                "plates": set(),
                "by_order": {},
                "position_ids": set(),
            })
            f["qty"] += 1
            if it.from_remnant:
                f["n_from_remnant"] += 1
            f["work_orders"].add(wo.no)
            if it.plate_id in plate_idx:
                f["plates"].add(f"{wo.no}·P{plate_idx[it.plate_id] + 1}")
            if it.position_id:
                f["position_ids"].add(it.position_id)
            o = f["by_order"].setdefault(it.order_no, {
                "order_no": it.order_no, "customer": it.customer or "",
                "customer_ref": it.customer_ref or "", "qty": 0,
            })
            o["qty"] += 1

    out = []
    for f in forms.values():
        f["work_orders"] = sorted(f["work_orders"])
        f["plates"] = sorted(f["plates"])
        f["position_ids"] = sorted(f["position_ids"])
        f["by_order"] = sorted(f["by_order"].values(), key=lambda o: o["order_no"])
        out.append(f)
    # Größter Bedarf zuerst — das ist die Zeile, die am ehesten schiefgeht.
    return sorted(out, key=lambda f: (-f["qty"], f["mat"], f["thk"], -f["od"]))


# --------------------------------------------------------------------------
# Darstellung
# --------------------------------------------------------------------------
def _num(v, nk: int = 1) -> str:
    return f"{float(v or 0):.{nk}f}".replace(".", ",")


def _geo(f: dict) -> str:
    parts = [f"Ø {_num(f['od'])}"]
    if f["di"]:
        parts.append(f"/ Ø {_num(f['di'])}")
    if f["bolt_count"]:
        parts.append(f"· {f['bolt_count']}× Ø {_num(f['bolt_d'])} auf Ø {_num(f['bolt_circle'])}")
    return " ".join(parts) + " mm"


def _forms_table(forms: list[dict]) -> str:
    head = ("<tr>" + "".join(
        f'<th style="text-align:{al};padding:5px 8px;background:#201e1d;color:#f3f2f2;'
        f'font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">{h}</th>'
        for h, al in [("Form", "left"), ("Werkstoff", "left"), ("Dicke", "right"),
                      ("Maße", "left"), ("Bedarf", "right"), ("davon Restfl.", "right"),
                      ("Platten", "left")]) + "</tr>")
    rows = []
    for f in forms:
        rows.append(
            '<tr>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1">'
            f'<b>{escape(f["label"])}</b>'
            + ("".join(
                f'<div style="font-size:11px;color:#6b6664;margin-top:2px">'
                f'{escape(o["order_no"])} · {escape(o["customer"])}'
                + (f' · {escape(o["customer_ref"])}' if o["customer_ref"] else "")
                + f' — {o["qty"]} Stk.</div>'
                for o in f["by_order"]))
            + '</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;color:#6b6664">'
            f'{escape(f["mat_name"])}</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;text-align:right;'
            f'font-variant-numeric:tabular-nums">{_num(f["thk"])} mm</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;color:#6b6664;'
            f'font-variant-numeric:tabular-nums;white-space:nowrap">{escape(_geo(f))}</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;text-align:right;'
            f'font-weight:600;font-size:16px;font-variant-numeric:tabular-nums">{f["qty"]}</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;text-align:right;'
            f'font-variant-numeric:tabular-nums;color:'
            f'{"#2b7a3d" if f["n_from_remnant"] else "#9b9694"}">{f["n_from_remnant"]}</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;font-size:11px;'
            f'color:#6b6664">{escape(", ".join(f["plates"]))}</td>'
            '</tr>'
        )
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse;font-size:13px;margin:8px 0 20px">'
            + head + "".join(rows) + "</table>")


def _work_order_table(work_orders: list[WorkOrder]) -> str:
    rows = []
    for wo in work_orders:
        formats = ", ".join(f"{int(w)}×{int(h)} ({int(n)}×)" for w, h, n in (wo.formats or [])) or "—"
        rows.append(
            '<tr>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1"><b>{escape(wo.no)}</b>'
            f'<div style="font-size:11px;color:#6b6664;margin-top:2px">'
            f'{escape(wo.release_reason or "—")}</div></td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;color:#6b6664">'
            f'{escape(wo.mat_name or wo.mat)} · {_num(wo.thk)} mm</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;'
            f'font-variant-numeric:tabular-nums">{wo.n_plates} — {escape(formats)}</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;text-align:right;'
            f'font-variant-numeric:tabular-nums">{wo.n_parts}</td>'
            f'<td style="padding:7px 8px;border-bottom:1px solid #e6e3e1;text-align:right;'
            f'font-variant-numeric:tabular-nums">{_num(wo.utilisation * 100, 1)} %</td>'
            '</tr>'
        )
    head = ("<tr>" + "".join(
        f'<th style="text-align:{al};padding:5px 8px;background:#201e1d;color:#f3f2f2;'
        f'font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">{h}</th>'
        for h, al in [("Innenauftrag / Freigabegrund", "left"), ("Werkstoff", "left"),
                      ("Platten", "left"), ("Teile", "right"), ("Belegung", "right")]) + "</tr>")
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse;font-size:13px;margin:8px 0 20px">'
            + head + "".join(rows) + "</table>")


def _figure(value: str, label: str) -> str:
    return (f'<td style="padding:0 18px 0 0;vertical-align:top">'
            f'<div style="font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;'
            f'line-height:1.1">{escape(value)}</div>'
            f'<div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;'
            f'color:#6b6664;margin-top:3px">{escape(label)}</div></td>')


def _html(run: NestRun, work_orders: list[WorkOrder], forms: list[dict],
          saved_pct: float, attach_note: str) -> str:
    total_pieces = sum(f["qty"] for f in forms)
    remnant = sum(f["n_from_remnant"] for f in forms)
    figures = "".join([
        _figure(str(len(forms)), "Formen"),
        _figure(str(total_pieces), "Teile"),
        _figure(str(run.n_plates), "Platten"),
        _figure(str(run.n_work_orders), "Innenaufträge"),
        _figure(f"{_num(run.batch_area_m2, 2)} m²", "Angeschnitten"),
        _figure(f"−{_num(saved_pct, 1)} %", "gegen Einzelschnitt"),
    ])
    texts = identity.texts()
    return f"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f3f2f2;
  font-family:'Source Serif 4',Georgia,'Times New Roman',serif;color:#201e1d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:860px;margin:0 auto">
 <tr><td style="border-top:3px solid #201e1d;border-bottom:1px solid #201e1d;padding:8px 0 6px">
   <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b6664">
     {escape(" · ".join(p for p in (texts.manufacturer_short, "Fertigung · Sammellauf") if p))}</div></td></tr>
 <tr><td style="padding:20px 0 2px">
   <h1 style="margin:0;font-size:28px;line-height:1.15;font-weight:600">Formbedarf {escape(run.no)}</h1>
   <p style="margin:6px 0 0;font-size:13px;color:#6b6664">
     {escape(_stamp(run.finished_at or run.started_at))} · ausgelöst: {escape(run.trigger or "—")}
     · Rechenkern {escape(run.engine_version or "—")}</p></td></tr>
 <tr><td style="padding:18px 0 20px;border-bottom:1px solid #d8d5d3">
   <table role="presentation" cellpadding="0" cellspacing="0"><tr>{figures}</tr></table></td></tr>

 <tr><td style="padding:22px 0 0">
   <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b6664;
     border-bottom:2px solid #201e1d;padding-bottom:4px">Welche Form wie oft</div>
   <p style="margin:10px 0 0;font-size:13px;color:#6b6664">
     Zusammengefasst über alle Kundenaufträge — die Maschine schneidet Formen, nicht
     Bestellungen. Gezählt sind die Teile, die <b>in diesem Lauf</b> auf einer freigegebenen
     Platte liegen; was auf einer angebrochenen Platte weitersammelt, ist nicht dabei.
     {f"Davon {remnant} aus einer Restfläche — kein Materialkosten­anteil, aber trotzdem zu entnehmen." if remnant else ""}</p>
   {_forms_table(forms)}</td></tr>

 <tr><td style="padding:4px 0 0">
   <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b6664;
     border-bottom:2px solid #201e1d;padding-bottom:4px">Innenaufträge dieses Laufs</div>
   {_work_order_table(work_orders)}</td></tr>

 {f'''<tr><td style="padding:0 0 18px">
   <div style="border-left:3px solid #b5651d;padding:8px 12px;background:#faf6f1;font-size:13px">
     <b>Zurückgestellt.</b> {escape(run.note or "")}</div></td></tr>''' if run.note else ""}

 <tr><td style="padding:4px 0 18px;font-size:13px;color:#6b6664;
     border-top:1px solid #d8d5d3;padding-top:14px">
   <b style="color:#201e1d">Anhang.</b> {escape(attach_note)}
   Zu schneiden sind die Ebenen {LAYER_OUTER} und {LAYER_HOLE}; {LAYER_TAG}, {LAYER_SHEET}
   und {LAYER_INFO} sind Orientierung und vor dem Schnitt stillzulegen. Einheit Millimeter,
   Nullpunkt links unten.</td></tr>

 <tr><td style="border-top:1px solid #d8d5d3;padding:12px 0;font-size:11px;line-height:1.5;color:#6b6664">
   <p style="margin:0">Interne Fertigungsmeldung — automatisch nach jedem Sammellauf,
   der mindestens einen Innenauftrag erzeugt hat.</p>
   {f'<p style="margin:4px 0 0">{escape(texts.manufacturer_line)}</p>' if texts.manufacturer_line else ""}
 </td></tr>
</table></body></html>"""


def _stamp(dt: datetime | None) -> str:
    if not dt:
        return "—"
    d = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return d.astimezone().strftime("%d.%m.%Y %H:%M")


def _text(run: NestRun, work_orders: list[WorkOrder], forms: list[dict],
          saved_pct: float, attach_note: str) -> str:
    lines = [
        f"Sammellauf {run.no} — Formbedarf",
        "=" * (24 + len(run.no)),
        "",
        f"{_stamp(run.finished_at or run.started_at)} · ausgelöst: {run.trigger or '—'}"
        f" · Rechenkern {run.engine_version or '—'}",
        "",
        f"{len(forms)} Formen · {sum(f['qty'] for f in forms)} Teile · "
        f"{run.n_plates} Platten · {run.n_work_orders} Innenaufträge",
        f"Angeschnitten {_num(run.batch_area_m2, 2)} m² gegen "
        f"{_num(run.solo_area_m2, 2)} m² bei Einzelschnitt (−{_num(saved_pct, 1)} %)",
        "",
        "WELCHE FORM WIE OFT",
        "-" * 19,
    ]
    for f in forms:
        lines.append(
            f"  {f['qty']:>4} ×  {f['label']} — {f['mat_name']} {_num(f['thk'])} mm · {_geo(f)}"
        )
        if f["n_from_remnant"]:
            lines.append(f"          davon {f['n_from_remnant']} aus einer Restfläche")
        for o in f["by_order"]:
            ref = f" · {o['customer_ref']}" if o["customer_ref"] else ""
            lines.append(f"          {o['order_no']} · {o['customer']}{ref} — {o['qty']} Stk.")
        lines.append(f"          Platten: {', '.join(f['plates']) or '—'}")
        lines.append("")

    lines += ["INNENAUFTRÄGE", "-" * 14]
    for wo in work_orders:
        formats = ", ".join(f"{int(w)}×{int(h)} ({int(n)}×)"
                            for w, h, n in (wo.formats or [])) or "—"
        lines.append(f"  {wo.no}  {wo.mat_name or wo.mat} {_num(wo.thk)} mm · "
                     f"{wo.n_plates} Platten ({formats}) · {wo.n_parts} Teile · "
                     f"Belegung {_num(wo.utilisation * 100)} %")
        lines.append(f"          Freigabe: {wo.release_reason or '—'}")
    if run.note:
        lines += ["", f"Zurückgestellt: {run.note}"]
    lines += ["", f"Anhang: {attach_note}",
              f"Schneiden: {LAYER_OUTER} und {LAYER_HOLE}. {LAYER_TAG}/{LAYER_SHEET}/{LAYER_INFO}",
              "stilllegen. Einheit mm, Nullpunkt links unten.", ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Anhänge
# --------------------------------------------------------------------------
def build_attachments(db: Session, run: NestRun,
                      work_orders: list[WorkOrder]) -> tuple[list, str]:
    """Archiv des Laufs plus die Vollplatten einzeln, soweit das Budget reicht.

    Reihenfolge ist Absicht: das Archiv zuerst, weil es vollständig ist. Die
    Einzelplatten sind Bequemlichkeit — sie fallen weg, wenn es eng wird, und
    der Meldungstext sagt dann, dass sie im Archiv liegen.
    """
    limit_mb = max_mb()
    budget = int(limit_mb * 1024 * 1024)
    attachments = []

    archive = cutfiles.bundle_run(db, work_orders, run.no)
    attachments.append(smtp_client.attachment(f"{run.no}-Schnittdateien.zip", archive))
    budget -= len(archive)

    n_plates = 0
    skipped = 0
    for wo in work_orders:
        for plate in wo.plates:
            if not plate.placements:
                continue
            content = cutfiles.plate_file(wo, plate).encode("utf-8")
            if len(content) > budget:
                skipped += 1
                continue
            attachments.append(smtp_client.attachment(
                f"{wo.no}-Platte-{plate.idx + 1}.dxf", content))
            budget -= len(content)
            n_plates += 1

    note = (f"{run.no}-Schnittdateien.zip enthält alle Innenaufträge dieses Laufs "
            f"(Vollplatte, je Kunde, Einzelteile)")
    if n_plates:
        note += f"; die {n_plates} Vollplatte(n) liegen zusätzlich einzeln bei"
    if skipped:
        note += f"; {skipped} weitere nur im Archiv (Größengrenze {int(limit_mb)} MB)"
    return attachments, note + "."


# --------------------------------------------------------------------------
# Der Versand
# --------------------------------------------------------------------------
def send_run_report(db: Session, run: NestRun, *, background: bool = True) -> bool:
    """Die Fertigungsmeldung zu einem Sammellauf.

    Ein Lauf ohne Innenauftrag erzeugt keine Meldung: er ist eine Information
    für das Panel („nichts war reif“), aber keine Nachricht wert — täglich
    hundert leere Meldungen sind der schnellste Weg, dass die eine volle
    übersehen wird.
    """
    if not enabled():
        return False
    to = recipients()
    if not to:
        log.info("Fertigungsmeldung %s: kein Empfänger (ALPHA_OPS_EMAIL) — übersprungen.",
                 run.no)
        return False

    work_orders = (db.query(WorkOrder)
                     .filter(WorkOrder.run_id == run.id)
                     .order_by(WorkOrder.no)
                     .all())
    if not work_orders:
        return False

    forms = collect_forms(db, work_orders)
    saved_pct = (100.0 * (1 - run.batch_area_m2 / run.solo_area_m2)
                 if run.solo_area_m2 else 0.0)

    try:
        attachments, attach_note = build_attachments(db, run, work_orders)
    except Exception:  # noqa: BLE001 — lieber ohne Zeichnung als ohne Meldung
        log.exception("Schnittdateien für %s konnten nicht gebaut werden", run.no)
        attachments, attach_note = [], ("Die Schnittdateien konnten nicht erzeugt werden — "
                                        "im Fertigungspanel herunterladen.")

    total_pieces = sum(f["qty"] for f in forms)
    subject = (f"Sammellauf {run.no}: {len(forms)} Formen, {total_pieces} Teile, "
               f"{run.n_plates} Platten")

    sent = smtp_client.send(
        to=to, subject=subject,
        text=_text(run, work_orders, forms, saved_pct, attach_note),
        html=_html(run, work_orders, forms, saved_pct, attach_note),
        attachments=attachments,
        dedupe_key=f"batch:{run.no}",
        background=background,
    )
    if sent and attachments:
        cutfiles.mark_issued(db, work_orders)
    return sent

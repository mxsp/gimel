"""Schnittdateien bündeln — die drei Gruppen aus ``render/dxf.py`` als ZIP.

Bis 2026-09 stand das im Router (``routers/production.py``), weil es nur einen
Aufrufer gab: den Download-Knopf im Fertigungspanel. Seit die Fertigungsmeldung
nach dem Sammellauf dieselben Dateien anhängt (``services/batch_report.py``),
gibt es zwei — und zwei Kopien derselben Ordnerstruktur wären genau die Art
Doppelung, an der später eine Seite stillschweigend anders aussieht als die
andere. Das Bündeln lebt deshalb hier, der Router ruft es nur noch auf.

Der Schnittplan (``domain/cutting``, PlotPro) reist als Parameter mit und wird
hier nicht ermittelt: welche Maschine schneidet, hängt an der Station, und das
ist eine Frage der Disposition und keine des Dateibaus. ``cut_plan()`` steht
trotzdem hier, weil sowohl der Router als auch die Meldung sie stellen müssen —
sie wirft ``ValueError``, und der Router macht daraus seine 422.

Geometrie kommt **immer** aus der gespeicherten Belegung, nie aus einer neuen
Schachtelung: sonst zeigt die Datei an der Maschine etwas anderes als die
Zeichnung auf dem Papier, sobald der Nester besser wird.
"""

from __future__ import annotations

import io
import logging
import zipfile
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..core.cutting import CutPlan, plan_cut
from ..models import (FactoryStation, OrderPosition, Product, WorkItem, WorkOrder,
                      WorkPlate)
from ..render.dxf import (LAYER_HOLE, LAYER_INFO, LAYER_OUTER, LAYER_SHEET, LAYER_TAG,
                         part_dxf, plate_dxf)

log = logging.getLogger("alpha.cutfiles")

#: Klartext der Schnittfolgen — für Dateiname, Kopfzeile und LIESMICH.
#: Ohne Umlaute und ohne Pfeile: das LIESMICH liegt in einer ZIP, die auf einem
#: Maschinenrechner mit unbekannter Codepage geöffnet wird.
PLOTPRO_NOTES = {
    "inside_out": "Innen nach aussen",
    "outside_in": "Aussen nach innen",
    "largest_first": "Groesste Teile zuerst",
    "smallest_first": "Kleinste Teile zuerst",
}


# --------------------------------------------------------------------------
# Der Schnittplan eines Innenauftrags
# --------------------------------------------------------------------------
def machine_kind(db: Session, wo: WorkOrder) -> str:
    """Womit dieser Innenauftrag geschnitten wird — aus der zugeordneten Station.

    Leer, solange keine zugeordnet ist. ``plan_cut`` behandelt das als „noch
    unbekannt" und wählt die sichere Folge; das ist der häufige Fall, weil die
    Datei oft vor der Zuordnung geholt wird.
    """
    if not wo.station_id:
        return ""
    st = db.get(FactoryStation, wo.station_id)
    return (st.machine_kind or "") if st else ""


def cut_plan(db: Session, wo: WorkOrder, want: str | None = None) -> CutPlan:
    """Der Schnittplan dieses Innenauftrags (domain/cutting).

    Maschinenart kommt von der zugeordneten Station, die Werkstoffgruppe vom
    Katalogeintrag. Beides steht am Auftrag, bevor jemand herunterlädt — die
    Frage nach der Schnittfolge muss dem Bediener deshalb nicht gestellt
    werden, sie wird ihm beantwortet. Er darf sie überstimmen (``want``).

    Wirft ``ValueError`` bei einer unbekannten Vorgabe; der Router macht daraus
    seine 422, die Fertigungsmeldung fragt gar nicht erst nach einer Vorgabe.
    """
    product = db.get(Product, wo.mat) if wo.mat else None
    return plan_cut(machine_kind(db, wo), (product.cat if product else ""),
                    mat_id=wo.mat or "", want=want)


def plan_suffix(plan: CutPlan) -> str:
    """Was im Dateinamen steht. Wer eine Datei an der Maschine vor sich hat,
    muss ihr ansehen, ob sie geschichtet ist — nicht der Adresszeile, aus der
    sie kam."""
    return f"-PlotPro-{plan.strategy}" if plan.layered else ""


def plan_header_suffix(plan: CutPlan) -> str:
    """Dasselbe für die Kopfzeile in der Zeichnung (Ebene ALPHA_INFO)."""
    if not plan.layered:
        return ""
    return f" · PlotPro {PLOTPRO_NOTES.get(plan.strategy, plan.strategy)}"


def _rev(wo: WorkOrder) -> int:
    """Anwendungen geben auch schlanke Innenaufträge herein; ohne Stand gilt die Lage als unberührt."""
    return getattr(wo, "layout_rev", 0) or 0


def rev_suffix(wo: WorkOrder) -> str:
    """Der Stand der Lage im Dateinamen: eine alte Datei an der Maschine muss man
    an ihrem Namen erkennen, nicht erst am Ergebnis."""
    return f"-Stand-{_rev(wo)}"


def rev_label(wo: WorkOrder) -> str:
    """Dasselbe für Kopfzeile und Zeichnung."""
    return f" · Stand {_rev(wo)}"


def plate_header(wo: WorkOrder, plate: WorkPlate, suffix: str = "") -> str:
    return (
        f"{wo.no} · {wo.mat_name or wo.mat} · {wo.thk:g} mm · "
        f"Platte {plate.idx + 1}/{wo.n_plates}{rev_label(wo)} · "
        f"{plate.fmt[0]:.0f}x{plate.fmt[1]:.0f} mm{suffix}"
    )


def mark_issued(db: Session, work_orders: list[WorkOrder]) -> None:
    """Festhalten, dass Schnittdateien draußen sind; nur der erste Zeitpunkt zählt.

    Eine Marke, keine Bedingung: scheitert das Schreiben (die Datenbank ist gerade
    belegt), bekommt der Bediener seine Datei trotzdem. Kein Eintrag im Prüfprotokoll,
    der Download bleibt ein Lesevorgang. Der Aufrufer darf nichts Offenes in ``db`` haben.
    """
    try:
        ids = [wo.id for wo in work_orders if wo.cut_files_issued_at is None]
        if ids:
            (db.query(WorkOrder).filter(WorkOrder.id.in_(ids), WorkOrder.cut_files_issued_at.is_(None))
               .update({WorkOrder.cut_files_issued_at: datetime.now(timezone.utc)},
                       synchronize_session=False))
            db.commit()
    except Exception:  # noqa: BLE001 — die Datei ist wichtiger als die Marke
        log.exception("Ausgabe der Schnittdateien nicht vermerkt")
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            log.exception("Rollback nach der Ausgabemarke fehlgeschlagen")


# --------------------------------------------------------------------------
# Die einzelnen Dateien
# --------------------------------------------------------------------------
def plate_file(wo: WorkOrder, plate: WorkPlate, *, plan: CutPlan | None = None,
               only_order: str | None = None) -> str:
    """Eine Platte als DXF — vollständig oder auf einen Kundenauftrag gefiltert.

    Der Schnittplan gilt nur für die Vollplatte (Gruppe 1): sie geht an die
    Maschine. Die Je-Kunde-Datei bleibt bewusst klassisch, weil sie auf den
    Sortiertisch geht und dort eine geschichtete Ebenenfolge nur stört.
    """
    if only_order:
        return plate_dxf(plate.fmt, plate.placements, only_order=only_order,
                         header=plate_header(wo, plate, f" · nur {only_order}"),
                         used_h=plate.used_h, turned=bool(plate.turned))
    return plate_dxf(plate.fmt, plate.placements,
                     header=plate_header(wo, plate,
                                         plan_header_suffix(plan) if plan else ""),
                     used_h=plate.used_h,
                     turned=bool(plate.turned),
                     plotpro_strategy=plan.dxf_strategy if plan else None)


def part_file(wo: WorkOrder, item: WorkItem, pos: OrderPosition | None, office: bool = True) -> str:
    """Ein Einzelteil im Nullpunkt — für Nachschnitt, Archiv und Rückgabe."""
    payload = {
        "od": item.od,
        "di": item.di,
        "shape": (pos.shape if pos else None) or item.shape,
        "bn": int(pos.bolt_count) if pos else 0,
        "bd": float(pos.bolt_d) if pos else 0.0,
        "bc": float(pos.bolt_circle) if pos else 0.0,
    }
    # Die Datei liegt an der Maschine: der Kundenname nur, wenn das Büro sie holt.
    who = item.customer if office else ""
    header = (f"{item.label} · {wo.mat_name or wo.mat} · {wo.thk:g} mm · "
              f"{item.order_no}" + (f" · {who}" if who else ""))
    return part_dxf(payload, header=header)


def _positions_of(db: Session, items: list[WorkItem]) -> dict[int, OrderPosition]:
    ids = [i.position_id for i in items if i.position_id]
    if not ids:
        return {}
    return {p.id: p for p in db.query(OrderPosition).filter(OrderPosition.id.in_(ids)).all()}


# --------------------------------------------------------------------------
# Das Bündel
# --------------------------------------------------------------------------
def write_work_order(z: zipfile.ZipFile, db: Session, wo: WorkOrder,
                     plan: CutPlan, prefix: str = "", office: bool = True) -> None:
    """Einen Innenauftrag in ein offenes Archiv schreiben.

    ``prefix`` erlaubt, mehrere Innenaufträge eines Sammellaufs in ein einziges
    Archiv zu legen, ohne dass sich die Ordner überlagern.
    """
    root = f"{prefix}{wo.no}"
    items = db.query(WorkItem).filter(WorkItem.work_order_id == wo.id).all()
    positions = _positions_of(db, items)

    for plate in wo.plates:
        z.writestr(
            f"{root}/1-Vollplatte/Platte-{plate.idx + 1}{rev_suffix(wo)}{plan_suffix(plan)}.dxf",
            plate_file(wo, plate, plan=plan))
        for order_no in sorted({it.get("order_no") for it in (plate.placements or [])
                                if it.get("order_no")}):
            z.writestr(f"{root}/2-Je-Kunde/{order_no}/Platte-{plate.idx + 1}{rev_suffix(wo)}.dxf",
                       plate_file(wo, plate, only_order=order_no))

    seen: set[int] = set()
    for it in items:
        if not it.position_id or it.position_id in seen:
            continue
        seen.add(it.position_id)
        z.writestr(f"{root}/3-Einzelteile/{it.order_no}/Pos-{it.position_id}.dxf",
                   part_file(wo, it, positions.get(it.position_id), office))

    z.writestr(f"{root}/LIESMICH.txt", readme(wo, plan))


def bundle(db: Session, wo: WorkOrder, plan: CutPlan, office: bool = True) -> bytes:
    """Ein Innenauftrag, alle drei Gruppen, ein Archiv."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        write_work_order(z, db, wo, plan, office=office)
    return buf.getvalue()


def bundle_run(db: Session, work_orders: list[WorkOrder], run_no: str) -> bytes:
    """Alle Innenaufträge eines Sammellaufs in einem Archiv.

    Das ist der Anhang der Fertigungsmeldung: ein Lauf, eine Datei, darin je
    Innenauftrag dieselbe Ordnerstruktur, die das Panel einzeln ausgibt. Der
    Schnittplan wird je Innenauftrag automatisch gewählt — die Meldung geht an
    die Arbeitsvorbereitung und nicht an eine Maschine, also gibt es hier
    niemanden, der eine Folge überstimmen könnte.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for wo in work_orders:
            write_work_order(z, db, wo, cut_plan(db, wo))
        z.writestr("LIESMICH.txt", run_readme(work_orders, run_no))
    return buf.getvalue()


# --------------------------------------------------------------------------
# Beilagen
# --------------------------------------------------------------------------
def _ascii(text: str) -> str:
    """Umlaute und Sonderzeichen für das LIESMICH ersetzen."""
    table = {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue",
             "ß": "ss", "→": "->", "—": "-", "·": "-", "„": '"', "“": '"'}
    return "".join(table.get(c, c) for c in text)


def readme(wo: WorkOrder, plan: CutPlan) -> str:
    """Das Blatt, das mit den Schnittdateien in der ZIP liegt.

    Am Ende durch ``_ascii`` — die Datei wird auf einem Maschinenrechner mit
    unbekannter Codepage geöffnet, und ein „Ansaugkraft" mit kaputtem Umlaut
    liest sich wie ein Fehler im Auftrag.
    """
    formats = (
        ", ".join(f"{int(w)}x{int(h)} mm ({int(n)}x)" for w, h, n in (wo.formats or []))
        or "—"
    )
    if plan.layered:
        note = PLOTPRO_NOTES.get(plan.strategy, plan.strategy)
        layers = (
            "Ebenen:  PLOTPRO_01_1_LOCH, PLOTPRO_01_2_KONTUR, PLOTPRO_02_1_LOCH, ...\n"
            "         werden geschnitten, und zwar der Nummer nach — nicht in\n"
            "         Dateireihenfolge und nicht alles auf einmal. Die Ziffer im\n"
            "         Namen haelt die Loecher vor der Aussenkontur, das Kuerzel\n"
            "         sagt innen oder aussen (dafuer, auf welcher Seite die\n"
            "         Schnittfuge ausgeglichen wird), und die laufende Nummer\n"
            "         trennt die Teile voneinander: die Auslage ist NICHT ein\n"
            "         Teil.\n"
            "         Die Nummern laufen ueber die Platte, nicht nach\n"
            "         Teilegroesse: bei 'Innen nach aussen' von der Mitte der\n"
            "         Auslage nach draussen, bei 'Aussen nach innen' vom Rand\n"
            "         her nach innen. Ein Teil in einer Restflaeche kommt\n"
            "         zusammen mit seinem Wirt dran, vor ihm.\n"
            f"         {LAYER_OUTER} und {LAYER_HOLE} sind in dieser Datei leer.\n"
            f"         {LAYER_TAG}, {LAYER_SHEET} und {LAYER_INFO} nicht schneiden —\n"
            "         Marken und Plattenrand sind zur Orientierung da. Vor dem\n"
            "         Schnitt stilllegen.\n\n"
            f"Schnittfolge: {note}\n"
            f"         Grund: {plan.reason}\n\n"
        )
    else:
        layers = (
            f"Ebenen:  {LAYER_OUTER} und {LAYER_HOLE} werden geschnitten.\n"
            f"         {LAYER_TAG}, {LAYER_SHEET} und {LAYER_INFO} nicht — Marken und\n"
            "         Plattenrand sind zur Orientierung da. Vor dem Schnitt\n"
            "         stilllegen.\n\n"
            "Schnittfolge: keine vorgegeben — die Maschine entscheidet.\n"
            f"         Grund: {plan.reason}\n\n"
        )
    if plan.warning:
        layers += f"ACHTUNG: {plan.warning}\n\n"
    return _ascii(
        f"Innenauftrag {wo.no}\n"
        f"{'=' * (14 + len(wo.no))}\n\n"
        f"Werkstoff   {wo.mat_name or wo.mat}\n"
        f"Dicke       {wo.thk:g} mm\n"
        f"Platten     {wo.n_plates} — {formats}\n"
        f"Teile       {wo.n_parts} aus {wo.n_orders} Kundenauftraegen\n"
        f"Rechenkern  {wo.engine_version}\n"
        f"Freigabe    {wo.release_reason or '—'}\n\n"
        "1-Vollplatte   Was die Maschine schneidet: eine Datei je Platte, alle\n"
        "               Kunden zusammen.\n"
        "2-Je-Kunde     Dieselben Platten, aber je Kundenauftrag nur dessen\n"
        "               Teile — an der echten Plattenposition. Zum Sortieren\n"
        "               und Verpacken nach dem Schnitt. Bewusst klassisch: sie\n"
        "               geht auf den Sortiertisch, nicht an die Maschine.\n"
        "3-Einzelteile  Jede Form einzeln im Nullpunkt, fuer Nachschnitt und\n"
        "               Archiv.\n\n"
        + layers
        + "Einheit: Millimeter ($INSUNITS = 4). Nullpunkt ist die linke untere\n"
        "         Ecke der Platte.\n"
    )


def run_readme(work_orders: list[WorkOrder], run_no: str) -> str:
    lines = [
        f"Sammellauf {run_no}",
        "=" * (12 + len(run_no)),
        "",
        "Je Innenauftrag ein Ordner mit den drei Gruppen (Vollplatte, je Kunde,",
        "Einzelteile). Die Gruppen und die Schnittfolge sind im LIESMICH des",
        "jeweiligen Ordners beschrieben.",
        "",
    ]
    for wo in work_orders:
        lines.append(
            f"{wo.no}  {wo.mat_name or wo.mat} {wo.thk:g} mm - "
            f"{wo.n_plates} Platten - {wo.n_parts} Teile - "
            f"{wo.n_orders} Kundenauftraege"
        )
    lines.append("")
    return _ascii("\n".join(lines))
